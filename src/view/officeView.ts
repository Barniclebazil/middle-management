import * as vscode from 'vscode';
import type { AgentSnapshot, ClaudeDefaults, FileRoot, FrontDeskTab, HostToWebview, OfficeSettings, UpdateInfo, UsageSnapshot, WebviewToHost } from '../shared/protocol.ts';
import { parseWebviewMessage } from '../shared/validate.ts';
import { rejectedRequestReply } from '../host/messageRouter.ts';
import { besideOfficePanel } from '../host/editorColumn.ts';
import { CaseTabs, caseTabHtml, contentSecurityPolicy } from '../host/caseTabs.ts';
import type { CaseTabHandle, OpenCaseTabResult } from '../host/caseTabs.ts';
import { PANEL_SOURCE, SHARED_STATE_TYPES, VIEW_SOURCE, caseAgentOf, caseSource, tabMaySend } from '../host/webviewSource.ts';
import type { WebviewSource } from '../host/webviewSource.ts';
import { DEFAULT_OFFICE_MODE } from '../shared/officeMode.ts';
import type { OfficeMode } from '../shared/officeMode.ts';

/** What the view needs from the extension: where validated messages go, and a logger. */
export interface OfficeViewHooks {
  /**
   * Receives every VALID message from any webview, with the id of the webview it came from (`'view'`, `'panel'` or
   * `'case:<agentId>'`; see `webviewSource.ts`). Includes `ready` (after the state replay) and the `closeCase` the view
   * sends for a case tab that was closed. Must not throw.
   */
  onMessage(msg: WebviewToHost, source: WebviewSource): void;
  log(msg: string): void;
  /** A case tab was closed. `byUser` is false when the host closed it. Not called while the extension shuts down. */
  onCaseTabClosed?(agentId: string, info: { byUser: boolean }): void;
  /** The current office mode (`claudeOffice.mode`), read each time an office page is built. Absent means manager mode. */
  getMode?(): OfficeMode;
}

const VIEW_TYPE = 'claudeOffice.panel';
const CASE_VIEW_TYPE = 'claudeOffice.case';

export class OfficeView implements vscode.WebviewViewProvider {
  static readonly viewId = 'claudeOffice.office';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private agents: AgentSnapshot[] = [];
  private settings: OfficeSettings | undefined;
  /** The latest plan-usage snapshot and Claude defaults, replayed on `ready` like `settings`. */
  private usage: UsageSnapshot | undefined;
  /** The latest update info, replayed on `ready` to the office views (case tabs do not get it). */
  private update: UpdateInfo | undefined;
  private claudeDefaults: ClaudeDefaults | undefined;
  /** The latest pushed `fileRoots` (one without a `reqId`), replayed on `ready`. Replies to `getFileRoots` are not kept. */
  private fileRoots: FileRoot[] | undefined;

  private readonly extensionUri: vscode.Uri;
  private readonly hooks: OfficeViewHooks;
  /** Webviews that have sent `ready` (their script is listening). */
  private readonly ready = new WeakSet<vscode.Webview>();
  /** `openMemo` / `openFrontDesk` waiting for a webview to become ready (the latest of each kind). */
  private readonly queued = new Map<'openMemo' | 'openFrontDesk', HostToWebview>();
  private readonly visibilityListeners: Array<(anyVisible: boolean) => void> = [];
  /** The case tabs' registry (open, focus, cap, who closed). */
  private readonly caseTabs: CaseTabs;
  /** The panel of each open case tab, by worker id. */
  private readonly casePanels = new Map<string, vscode.WebviewPanel>();
  /** The look the office sent with the `openCaseTab` being handled; the boot of the tab being created carries it. */
  private pendingLook: string | undefined;
  /** The latest `caseTabs` posted, replayed to the office views on `ready`. */
  private caseTabIds: string[] = [];

  constructor(extensionUri: vscode.Uri, hooks: OfficeViewHooks) {
    this.extensionUri = extensionUri;
    this.hooks = hooks;
    this.caseTabs = new CaseTabs({
      create: (agentId, title) => this.createCasePanel(agentId, title),
      announce: (agentIds) => this.post({ type: 'caseTabs', agentIds }),
      closed: (agentId, info) => this.caseTabClosed(agentId, info),
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.setup(webviewView.webview, VIEW_SOURCE);
    webviewView.onDidChangeVisibility(() => {
      // A hidden view may drop its page (retainContextWhenHidden is off): it must say `ready` again.
      if (!webviewView.visible) this.ready.delete(webviewView.webview);
      this.notifyVisibility();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
      this.notifyVisibility();
    });
    this.notifyVisibility();
  }

  /** True when the side/panel view, the office's editor tab or any case tab is currently visible. */
  anyVisible(): boolean {
    return this.view?.visible === true || this.panel?.visible === true || this.caseTabs.anyVisible();
  }

  /** The column of the office's editor tab while it is visible, else undefined (the office is the sidebar view, or hidden). */
  panelColumn(): number | undefined {
    return this.panel?.visible === true ? this.panel.viewColumn : undefined;
  }

  /** True when the bottom-panel view (not the editor tab) is currently visible. */
  viewVisible(): boolean {
    return this.view?.visible === true;
  }

  /** Called whenever `anyVisible()` may have changed. Returns a disposer. */
  onDidChangeVisibility(listener: (anyVisible: boolean) => void): { dispose(): void } {
    this.visibilityListeners.push(listener);
    return {
      dispose: () => {
        const i = this.visibilityListeners.indexOf(listener);
        if (i >= 0) this.visibilityListeners.splice(i, 1);
      },
    };
  }

  private notifyVisibility(): void {
    const v = this.anyVisible();
    for (const l of [...this.visibilityListeners]) {
      try {
        l(v);
      } catch {
        // A listener must never break the view.
      }
    }
  }

  /** Open the office in an editor tab, or reveal it if already open. */
  openPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Middle Management', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: this.roots(),
    });
    this.panel = panel;
    this.setup(panel.webview, PANEL_SOURCE);
    panel.onDidChangeViewState(() => {
      if (!panel.visible) this.ready.delete(panel.webview);
      this.notifyVisibility();
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      this.notifyVisibility();
    });
    this.notifyVisibility();
  }

  /**
   * Open the new-task memo in the visible office, revealing the office first when it is hidden. The message is held
   * until a webview reports `ready`, so it is never lost on a freshly created view.
   */
  showMemo(projectPath?: string): void {
    this.showOrQueue(projectPath !== undefined ? { type: 'openMemo', projectPath } : { type: 'openMemo' });
  }

  /** Open the Front desk panel (optionally on a tab), revealing the office first when it is hidden. Queued like `showMemo`. */
  showFrontDesk(tab?: FrontDeskTab): void {
    this.showOrQueue(tab !== undefined ? { type: 'openFrontDesk', tab } : { type: 'openFrontDesk' });
  }

  private showOrQueue(msg: Extract<HostToWebview, { type: 'openMemo' | 'openFrontDesk' }>): void {
    const view = this.view && this.view.visible && this.ready.has(this.view.webview) ? this.view : undefined;
    const panel = this.panel && this.panel.visible && this.ready.has(this.panel.webview) ? this.panel : undefined;
    if (view || panel) {
      void (view ?? panel)!.webview.postMessage(msg);
      return;
    }
    this.queued.set(msg.type, msg);
    if (this.anyVisible()) return; // visible but not ready yet: `ready` will flush it
    vscode.commands.executeCommand(`${OfficeView.viewId}.focus`).then(undefined, () => {
      if (!this.anyVisible()) this.openPanel();
    });
  }

  /**
   * Broadcast shared state, remembering the latest for replay (agents, settings, usage, Claude defaults, `caseTabs` and pushed
   * file roots only). `agents`, `settings`, `usage` and `claudeDefaults` go to the office views AND every case tab; anything
   * else goes to the office views only. Case streams and replies are not broadcast: the manager host sends them with `postTo`.
   */
  post(msg: HostToWebview): void {
    if (msg.type === 'agents') {
      this.agents = msg.agents;
      this.caseTabs.setAgents(msg.agents);
    } else if (msg.type === 'settings') this.settings = msg.settings;
    else if (msg.type === 'usage') this.usage = msg.usage;
    else if (msg.type === 'update') this.update = msg.update;
    else if (msg.type === 'claudeDefaults') this.claudeDefaults = msg.defaults;
    else if (msg.type === 'fileRoots' && msg.reqId === undefined) this.fileRoots = msg.roots;
    else if (msg.type === 'caseTabs') this.caseTabIds = msg.agentIds;
    void this.view?.webview.postMessage(msg);
    void this.panel?.webview.postMessage(msg);
    if (SHARED_STATE_TYPES.has(msg.type)) for (const p of this.casePanels.values()) void p.webview.postMessage(msg);
  }

  /** Send a message to exactly the named webviews (`'view'`, `'panel'`, `'case:<agentId>'`); unknown or closed ones are skipped. Nothing is cached. */
  postTo(sources: readonly WebviewSource[], msg: HostToWebview): void {
    for (const source of new Set(sources)) {
      const webview = this.webviewOf(source);
      if (webview !== undefined) void webview.postMessage(msg);
    }
  }

  private webviewOf(source: WebviewSource): vscode.Webview | undefined {
    if (source === VIEW_SOURCE) return this.view?.webview;
    if (source === PANEL_SOURCE) return this.panel?.webview;
    const agentId = caseAgentOf(source);
    return agentId === undefined ? undefined : this.casePanels.get(agentId)?.webview;
  }

  /** Worker ids with an open case tab, in the order the tabs were opened. */
  openCaseTabs(): string[] {
    return this.caseTabs.ids();
  }

  /**
   * Open the worker's case tab, or reveal it when it is open. Returns what happened: `'unknown'` (not in the latest `agents`)
   * and `'full'` (`LIMITS.caseTabs` tabs open) are refusals (`CASE_TAB_REFUSALS` has the words for the `error{agentId}`).
   */
  openCaseTab(agentId: string, look?: string): OpenCaseTabResult {
    this.pendingLook = look; // read by `caseHtml` while the tab is created, then cleared
    let result: OpenCaseTabResult;
    try {
      result = this.caseTabs.open(agentId);
    } finally {
      this.pendingLook = undefined;
    }
    if (result === 'opened') this.notifyVisibility();
    // Already open: the boot cannot change, so tell the tab (it ignores the message when the look is the one it has).
    else if (result === 'focused' && look !== undefined) void this.casePanels.get(agentId)?.webview.postMessage({ type: 'caseLook', agentId, look });
    return result;
  }

  /** Close a worker's tab because of something the host did (not the user): `onCaseTabClosed` gets `byUser: false`. */
  closeCaseTab(agentId: string): void {
    this.caseTabs.closeByHost(agentId);
  }

  /** Close every case tab as a host action (for example when demo mode starts). */
  closeAllCaseTabs(): void {
    for (const id of this.caseTabs.ids()) this.caseTabs.closeByHost(id);
  }

  /**
   * Build the office pages again, for a change of mode: the bottom-panel view and the editor-tab office when open, not the case
   * tabs. Each page then sends `ready` and gets the usual replay (`replay` is tied to the webview, not to its html, so it runs
   * again). Until then the webview is not ready, so a queued `openMemo` or `openFrontDesk` waits for the new page.
   */
  reloadAll(): void {
    for (const webview of [this.view?.webview, this.panel?.webview]) {
      if (webview === undefined) continue;
      this.ready.delete(webview);
      webview.html = this.html(webview); // a fresh nonce each time, so the host really reloads the page
    }
  }

  dispose(): void {
    this.caseTabs.dispose(); // closes every tab; nothing is reported, so no one is sent home by a shutdown
    this.casePanels.clear();
    this.panel?.dispose();
    this.panel = undefined;
    this.view = undefined;
    this.visibilityListeners.length = 0;
  }

  private createCasePanel(agentId: string, title: string): CaseTabHandle {
    // The group of the most recent case tab, else beside the office when it is an editor tab, else the active group.
    const column = this.caseTabs.lastColumn() ?? besideOfficePanel(this.panelColumn(), vscode.ViewColumn.Beside) ?? vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(CASE_VIEW_TYPE, title, column, {
      enableScripts: true,
      retainContextWhenHidden: false, // the host replays the case on `ready`
      localResourceRoots: this.roots(),
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.casePanels.set(agentId, panel);
    this.setup(panel.webview, caseSource(agentId), agentId);
    panel.onDidChangeViewState(() => {
      if (!panel.visible) this.ready.delete(panel.webview);
      this.notifyVisibility();
    });
    panel.onDidDispose(() => {
      if (this.casePanels.get(agentId) === panel) this.casePanels.delete(agentId);
      this.caseTabs.disposed(agentId);
      this.notifyVisibility();
    });
    return {
      get visible() {
        return panel.visible;
      },
      get column() {
        return panel.viewColumn;
      },
      reveal: () => panel.reveal(),
      setTitle: (t) => {
        if (panel.title !== t) panel.title = t;
      },
      dispose: () => panel.dispose(),
    };
  }

  /** A case tab went away: tell the manager host that source closed its case, then the extension's hook. */
  private caseTabClosed(agentId: string, info: { byUser: boolean }): void {
    try {
      this.hooks.onMessage({ type: 'closeCase' }, caseSource(agentId));
    } catch (e) {
      this.hooks.log(`closing the case of a tab failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      this.hooks.onCaseTabClosed?.(agentId, info);
    } catch (e) {
      this.hooks.log(`closing a case tab failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private roots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')];
  }

  /** `ownAgentId` is set for a case tab: the worker it is bound to. */
  private setup(webview: vscode.Webview, source: WebviewSource, ownAgentId?: string): void {
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    webview.html = ownAgentId === undefined ? this.html(webview) : this.caseHtml(webview, ownAgentId);
    webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (msg === undefined) {
        const t = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
        this.hooks.log(`dropped an invalid webview message (type: ${typeof t === 'string' ? t.slice(0, 40) : typeof t})`);
        // A Round B request with a usable `reqId` gets an error back, so its spinner ends.
        const reply = rejectedRequestReply(raw);
        if (reply !== undefined) void webview.postMessage(reply);
        return;
      }
      if (ownAgentId !== undefined && !tabMaySend(msg, ownAgentId)) {
        this.hooks.log(`dropped a ${msg.type} message from a case tab`);
        return;
      }
      if (msg.type === 'ready') {
        this.ready.add(webview);
        this.replay(webview, ownAgentId === undefined);
        if (ownAgentId === undefined) {
          const waiting = [...this.queued.values()];
          this.queued.clear();
          for (const m of waiting) void webview.postMessage(m);
        }
      }
      try {
        this.hooks.onMessage(msg, source);
      } catch (e) {
        this.hooks.log(`handling ${msg.type} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** The cached shared state, to one webview. A case tab gets only the four shared kinds; the office views also get `fileRoots` and `caseTabs`. */
  private replay(webview: vscode.Webview, office: boolean): void {
    if (this.settings) void webview.postMessage({ type: 'settings', settings: this.settings } satisfies HostToWebview);
    if (this.claudeDefaults) void webview.postMessage({ type: 'claudeDefaults', defaults: this.claudeDefaults } satisfies HostToWebview);
    if (this.usage) void webview.postMessage({ type: 'usage', usage: this.usage } satisfies HostToWebview);
    if (office && this.update) void webview.postMessage({ type: 'update', update: this.update } satisfies HostToWebview);
    if (office && this.fileRoots) void webview.postMessage({ type: 'fileRoots', roots: this.fileRoots } satisfies HostToWebview);
    if (office) void webview.postMessage({ type: 'caseTabs', agentIds: this.caseTabIds } satisfies HostToWebview);
    void webview.postMessage({ type: 'agents', agents: this.agents } satisfies HostToWebview);
  }

  private caseHtml(webview: vscode.Webview, agentId: string): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'case.js')).toString();
    return caseTabHtml({ cspSource: webview.cspSource, nonce: makeNonce(), scriptUri, boot: this.pendingLook === undefined ? { mode: 'case', agentId } : { mode: 'case', agentId, look: this.pendingLook } });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const csp = contentSecurityPolicy(webview.cspSource, nonce);
    const mode = this.hooks.getMode?.() ?? DEFAULT_OFFICE_MODE;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Middle Management</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1b1b1f; }
  canvas#office { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body data-office-mode="${mode}">
<canvas id="office"></canvas>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
