// Where one VALIDATED webview message goes (the officeView has already run `parseWebviewMessage`), in this order:
//   - the Front desk's messages (`frontDesk.handles`) go to the Front desk, in demo mode too: they touch settings and the
//     theme file, never a session;
//   - in view mode (`isViewMode`), everything but `VIEW_MODE_ALLOWED` gets the view guard's error (`viewRefusal`), whatever the
//     demo mode says: the office only shows the agents, so nothing below this step runs;
//   - in demo mode, session-acting messages get the demo guard's error (`demoRefusal`); so do the seven Round B file room and
//     catalog requests (the demo office has no real folders or config, and they read the user's disk);
//   - the Round B requests (`officeRequests.handles`) go to `officeRequests`, after the demo guard, with `force` set for a
//     `getCatalog` that carries `refresh: true`;
//   - `refreshUsage` goes to the usage service (the manager host knows nothing about usage);
//   - `updateAction` goes to the update service (allowed in view mode, harmless in demo mode);
//   - `openCaseTab` and `sendHome` (v0.5), from an office webview only, go to the extension's hooks (`openCaseTab`, `sendHome`);
//   - everything else goes to the manager host, with the source.
// Every message arrives with the id of the webview it came from (`webviewSource.ts`): demo refusals go back to that webview
// only, the replies of the Front desk and the Round B requests are routed back to it by `reqId` (`replies`), and the manager
// host gets the source so it can keep its case state per webview. A case tab may send only what `tabMaySend` allows.
// No `vscode` import, so the wiring in `extension.ts` stays testable.
import type { HostToWebview, UpdateAction, WebviewToHost } from '../shared/protocol.ts';
import { LIMITS } from '../shared/protocol.ts';
import { demoRefusal } from './demoGuard.ts';
import { viewRefusal } from './viewGuard.ts';
import { OFFICE_REQUEST_TYPES } from './officeRequests.ts';
import { caseAgentOf, isCaseTabCommand, isOfficeSource, tabMaySend } from './webviewSource.ts';
import type { ReplyRouter, WebviewSource } from './webviewSource.ts';

export interface RouterDeps {
  isDemo: () => boolean;
  /** View mode (`claudeOffice.mode`): when true, the view guard refuses everything but the Front desk and `VIEW_MODE_ALLOWED`. Absent means manager mode. */
  isViewMode?: () => boolean;
  post: (msg: HostToWebview) => void;
  /** Send to exactly these webviews (`OfficeView.postTo`). Without it a demo refusal falls back to `post`. */
  postTo?: (sources: readonly WebviewSource[], msg: HostToWebview) => void;
  /** Remembers who sent a request with a `reqId`, so the Front desk's and the file room's replies reach that webview only. */
  replies?: Pick<ReplyRouter, 'note'>;
  /** `UsageService.refresh()`. */
  refreshUsage: () => void;
  /** `UpdateService.handle`: the webview's `updateAction`. Must never reject. */
  updateAction?: (action: UpdateAction) => Promise<void> | void;
  /** `ManagerHost.handle`. Must never reject. */
  handle: (msg: WebviewToHost, source: WebviewSource) => Promise<void> | void;
  /** `openCaseTab` from an office webview: open the worker's tab or focus it. The sender gets the refusal, if any. */
  openCaseTab?: (agentId: string, source: WebviewSource, look?: string) => void;
  /** `sendHome` from an office webview (task 8.4). */
  sendHome?: (agentId: string, source: WebviewSource) => void;
  /** The Front desk (`createFrontDesk`): `handles` is checked first, before the demo guard. `handle` never rejects. */
  frontDesk?: { handles(msg: WebviewToHost): boolean; handle(msg: WebviewToHost): Promise<void> | void };
  /** The Round B request router (`createOfficeRequests`): file room, catalog and open-in-editor. `handle` never rejects. */
  officeRequests?: { handles(msg: WebviewToHost): boolean; handle(msg: WebviewToHost, opts?: { force?: boolean }): Promise<void> | void };
}

export function routeWebviewMessage(msg: WebviewToHost, source: WebviewSource, deps: RouterDeps): void {
  // A case tab is untrusted too: the view already drops what it may not send; this keeps the router safe on its own. The one
  // exception is the `closeCase` the view itself sends in a closed tab's name, so the manager host forgets that source's case.
  const tabAgent = caseAgentOf(source);
  if (tabAgent !== undefined && msg.type !== 'closeCase' && !tabMaySend(msg, tabAgent)) return;
  if (deps.frontDesk?.handles(msg)) {
    deps.replies?.note(msg, source);
    void deps.frontDesk.handle(msg);
    return;
  }
  if (deps.isViewMode?.()) {
    const refusal = viewRefusal(msg);
    if (refusal) {
      if (deps.postTo) deps.postTo([source], refusal);
      else deps.post(refusal);
      return;
    }
  }
  if (deps.isDemo()) {
    const refusal = demoRefusal(msg);
    if (refusal) {
      if (deps.postTo) deps.postTo([source], refusal);
      else deps.post(refusal);
      return;
    }
  }
  if (isCaseTabCommand(msg)) {
    if (!isOfficeSource(source)) return; // only the office opens a tab or sends a worker home
    if (msg.type === 'openCaseTab') deps.openCaseTab?.(msg.agentId, source, msg.look);
    else deps.sendHome?.(msg.agentId, source);
    return;
  }
  if (deps.officeRequests?.handles(msg)) {
    deps.replies?.note(msg, source);
    // `getCatalog.refresh` (an explicit Refresh or Try again press) skips the host's caches.
    void deps.officeRequests.handle(msg, { force: msg.type === 'getCatalog' && msg.refresh === true });
    return;
  }
  if (msg.type === 'refreshUsage') {
    deps.refreshUsage();
    return;
  }
  if (msg.type === 'updateAction') {
    void deps.updateAction?.(msg.action);
    return;
  }
  void deps.handle(msg, source);
}

/** The reply to a Round B request that `parseWebviewMessage` refused, so the webview's pending request ends instead of spinning. */
const REJECTED_TEXT = 'That request was not understood.';

/**
 * For a refused inbound message: when its `type` is one of the Round B request types and it has a `reqId` that is a valid id
 * (a non-empty string of at most `LIMITS.idChars` without control characters, the validator's own rule for ids), the
 * `error{reqId, message}` to post back. The message is fixed text: nothing of the bad input is echoed. Otherwise undefined.
 */
export function rejectedRequestReply(raw: unknown): HostToWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, reqId } = raw as { type?: unknown; reqId?: unknown };
  if (typeof type !== 'string' || !(OFFICE_REQUEST_TYPES as readonly string[]).includes(type)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (typeof reqId !== 'string' || reqId.length < 1 || reqId.length > LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(reqId)) return undefined;
  return { type: 'error', reqId, message: REJECTED_TEXT };
}
