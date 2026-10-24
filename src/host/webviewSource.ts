// Which webview a message came from or goes to (v0.5, docs/manager-mode.md section 18). No `vscode` import.
//
// Every webview the office owns has a source id:
//   - `'view'`            the office `WebviewView` (the bottom panel / sidebar);
//   - `'panel'`           the office in its own editor tab (`claudeOffice.openInEditor`);
//   - `'case:<agentId>'`  a case tab, bound to one worker for its whole life.
// `OfficeView` stamps the source on every inbound message and delivers `postTo(sources, msg)` to exactly those sources.
// Which case messages go to which sources is the manager host's job (it keeps the registry of open cases); this module
// only names the sources and holds the small pure rules around them.
import type { HostToWebview, WebviewToHost } from '../shared/protocol.ts';

/** The id of a webview, per the conventions above. A plain string so the manager host needs no import of this module's types. */
export type WebviewSource = string;

export const VIEW_SOURCE: WebviewSource = 'view';
export const PANEL_SOURCE: WebviewSource = 'panel';
const CASE_PREFIX = 'case:';

/** The source id of the case tab bound to `agentId`. */
export function caseSource(agentId: string): WebviewSource {
  return `${CASE_PREFIX}${agentId}`;
}

/** The worker a case tab source is bound to, or undefined when `source` is not a case tab. */
export function caseAgentOf(source: WebviewSource): string | undefined {
  return source.startsWith(CASE_PREFIX) && source.length > CASE_PREFIX.length ? source.slice(CASE_PREFIX.length) : undefined;
}

/** True for the two office webviews (the sidebar/panel view and the office's own editor tab). */
export function isOfficeSource(source: WebviewSource): boolean {
  return source === VIEW_SOURCE || source === PANEL_SOURCE;
}

/** The sources of the two office webviews, for messages that are office only (`caseTabs`, `projects`, `fileRoots`...). */
export const OFFICE_SOURCES: readonly WebviewSource[] = [VIEW_SOURCE, PANEL_SOURCE];

/**
 * Host-to-webview messages that belong to every webview, office and case tabs alike: the shared state, cached and replayed
 * on `ready`. Everything else posted with `post()` reaches the office views only; case streams and replies use `postTo`.
 */
export const SHARED_STATE_TYPES: ReadonlySet<HostToWebview['type']> = new Set<HostToWebview['type']>(['agents', 'settings', 'usage', 'claudeDefaults']);

/** The message types a case tab may send (the host drops every other type from a tab, section 18 "Boot"). */
const TAB_MAY_SEND: ReadonlySet<WebviewToHost['type']> = new Set<WebviewToHost['type']>([
  'ready',
  'openCase',
  'reply',
  'decide',
  'interrupt',
  'openInClaudeCode',
  'setSessionOptions',
  'getPlan',
  'getTurn',
]);

/** True when a case tab bound to `ownAgentId` may send `msg`: one of the allowed types, and `openCase` only for its own worker. */
export function tabMaySend(msg: WebviewToHost, ownAgentId: string): boolean {
  if (!TAB_MAY_SEND.has(msg.type)) return false;
  return msg.type !== 'openCase' || msg.agentId === ownAgentId;
}

/** Messages only the office views (not case tabs) may send that open or end a case tab. */
export function isCaseTabCommand(msg: WebviewToHost): msg is Extract<WebviewToHost, { type: 'openCaseTab' | 'sendHome' }> {
  return msg.type === 'openCaseTab' || msg.type === 'sendHome';
}

/** Largest number of `reqId` to sender entries kept (a reqId is unique per request, so an old entry is just dead weight). */
const MAX_REPLY_TARGETS = 256;

export interface ReplyRouter {
  /** Remember who sent a request, when it carries a `reqId`. */
  note(msg: WebviewToHost, source: WebviewSource): void;
  /** Deliver `msg`: to the sender of the request when it is a reply (a `reqId` that was noted), else to every office view. */
  post(msg: HostToWebview): void;
}

/**
 * Routes the replies of the Front desk and the Round B requests (file room, catalog), which carry the `reqId` of the request
 * and are produced long after the message arrived, back to the webview that asked, and to nobody else. Pushes with no
 * `reqId` (a theme change, the roots after a folder was added) are not replies: they go through `post` as before.
 */
export function createReplyRouter(deps: { post(msg: HostToWebview): void; postTo?(sources: readonly WebviewSource[], msg: HostToWebview): void }): ReplyRouter {
  const senders = new Map<string, WebviewSource>();
  return {
    note(msg, source) {
      const reqId = 'reqId' in msg && typeof msg.reqId === 'string' ? msg.reqId : undefined;
      if (reqId === undefined) return;
      senders.delete(reqId);
      senders.set(reqId, source);
      if (senders.size > MAX_REPLY_TARGETS) {
        const oldest = senders.keys().next();
        if (!oldest.done) senders.delete(oldest.value);
      }
    },
    post(msg) {
      const reqId = 'reqId' in msg && typeof msg.reqId === 'string' ? msg.reqId : undefined;
      const to = reqId === undefined ? undefined : senders.get(reqId);
      if (to !== undefined && deps.postTo !== undefined) deps.postTo([to], msg);
      else deps.post(msg);
    },
  };
}
