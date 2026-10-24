// The case tabs: one editor tab per open worker (v0.5, docs/manager-mode.md section 18), and the HTML they load.
// No `vscode` import: `OfficeView` creates the real `WebviewPanel`s and hands this controller a small handle for each, so the
// registry (open, focus, cap, close, who closed it) is testable on its own.
import { CASE_TAB_BOOT_ELEMENT_ID, LIMITS } from '../shared/protocol.ts';
import type { AgentSnapshot, CaseTabBoot } from '../shared/protocol.ts';

/** What the controller needs from one tab. `OfficeView` wraps a `WebviewPanel` in this. */
export interface CaseTabHandle {
  readonly visible: boolean;
  /** The editor column the tab is in (undefined when it is gone). */
  readonly column: number | undefined;
  reveal(): void;
  setTitle(title: string): void;
  /** Disposes the tab. The owner reports it back with `CaseTabs.disposed` (the event may fire during this call or later). */
  dispose(): void;
}

export interface CaseTabsDeps {
  /** Create the tab for a worker. The owner wires the panel's dispose event to `CaseTabs.disposed(agentId)`. */
  create(agentId: string, title: string): CaseTabHandle;
  /** The set of open tabs changed: `caseTabs{agentIds}` goes to the office views and is cached. */
  announce(agentIds: string[]): void;
  /** A tab went away. `byUser` is false when the host closed it (`closeByHost`) and was never reported when the extension is disposing. */
  closed(agentId: string, info: { byUser: boolean }): void;
}

export type OpenCaseTabResult = 'opened' | 'focused' | 'unknown' | 'full';

/** Text of the error that goes back to the sender of an `openCaseTab` that could not be honoured (it always carries the `agentId`). */
export const CASE_TAB_REFUSALS: Readonly<Record<'unknown' | 'full', string>> = {
  unknown: 'That worker is not in the office any more.',
  full: 'Too many case tabs are open. Close a tab first.',
};

/** The tab title for a worker: their title, trimmed and shortened, else a plain fallback. */
export function caseTabTitle(agent: Pick<AgentSnapshot, 'title'> | undefined): string {
  const t = (agent?.title ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return 'Case file';
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

export class CaseTabs {
  private readonly deps: CaseTabsDeps;
  /** Open tabs in the order they were opened. */
  private readonly tabs = new Map<string, CaseTabHandle>();
  /** Tabs the host is closing itself (so their dispose is not the user's). */
  private readonly hostClosing = new Set<string>();
  private agents: readonly AgentSnapshot[] = [];
  private disposing = false;

  constructor(deps: CaseTabsDeps) {
    this.deps = deps;
  }

  /** Worker ids with an open tab, in the order the tabs were opened. */
  ids(): string[] {
    return [...this.tabs.keys()];
  }

  has(agentId: string): boolean {
    return this.tabs.has(agentId);
  }

  /** True when any open tab is visible. */
  anyVisible(): boolean {
    for (const t of this.tabs.values()) if (t.visible) return true;
    return false;
  }

  /** The column of the most recently opened tab that is still open, so the next one opens in the same group. */
  lastColumn(): number | undefined {
    let col: number | undefined;
    for (const t of this.tabs.values()) col = t.column ?? col;
    return col;
  }

  /**
   * Open the worker's tab, or focus it when it is open. Unknown worker: `'unknown'`. `LIMITS.caseTabs` tabs open already:
   * `'full'` (nothing is closed for the user). A new tab announces the new set.
   */
  open(agentId: string): OpenCaseTabResult {
    const existing = this.tabs.get(agentId);
    if (existing !== undefined) {
      existing.reveal();
      return 'focused';
    }
    const agent = this.agents.find((a) => a.id === agentId);
    if (agent === undefined) return 'unknown';
    if (this.tabs.size >= LIMITS.caseTabs) return 'full';
    this.tabs.set(agentId, this.deps.create(agentId, caseTabTitle(agent)));
    this.deps.announce(this.ids());
    return 'opened';
  }

  /** The latest `agents` snapshot: keeps the tab titles in step. */
  setAgents(agents: readonly AgentSnapshot[]): void {
    this.agents = agents;
    for (const [id, tab] of this.tabs) {
      const agent = agents.find((a) => a.id === id);
      if (agent !== undefined) tab.setTitle(caseTabTitle(agent)); // a worker who left keeps the last title
    }
  }

  /** The panel for `agentId` was disposed (by the user, by `closeByHost`, or while the extension shuts down). Safe to call twice. */
  disposed(agentId: string): void {
    if (!this.tabs.delete(agentId)) return;
    const byUser = !this.hostClosing.delete(agentId);
    if (this.disposing) return;
    this.deps.announce(this.ids());
    this.deps.closed(agentId, { byUser });
  }

  /** Close one tab because of something the host did (the worker was sent home with the x). Reports `byUser: false`. */
  closeByHost(agentId: string): void {
    const tab = this.tabs.get(agentId);
    if (tab === undefined) return;
    this.hostClosing.add(agentId);
    try {
      tab.dispose();
    } finally {
      this.disposed(agentId); // in case the panel's dispose event did not fire during dispose()
    }
  }

  /** Close every tab, for the extension shutting down. Nothing is announced or reported. */
  dispose(): void {
    this.disposing = true;
    const all = [...this.tabs.values()];
    this.tabs.clear();
    this.hostClosing.clear();
    for (const t of all) {
      try {
        t.dispose();
      } catch {
        // A panel that is already gone must not stop the others closing.
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML

/** The CSP of every office webview, tab or not: no remote content, scripts only by nonce. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
}

/**
 * The boot data as JSON that is safe inside a `<script type="application/json">` element: `<` (so no `</script>` or `<!--`),
 * `>` and `&` become unicode escapes, as do the two line separators that old parsers treat as newlines. `JSON.parse` of the
 * text gives the same object back.
 */
export function bootJson(boot: CaseTabBoot): string {
  return JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The page of a case tab: the office CSP, the boot element for the worker, and `dist/case.js`. */
export function caseTabHtml(opts: { cspSource: string; nonce: string; scriptUri: string; boot: CaseTabBoot }): string {
  const csp = contentSecurityPolicy(opts.cspSource, opts.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Case file</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1b1b1f; }
</style>
</head>
<body>
<script type="application/json" id="${CASE_TAB_BOOT_ELEMENT_ID}">${bootJson(opts.boot)}</script>
<script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}
