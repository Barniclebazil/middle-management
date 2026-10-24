/**
 * The Temp agency panel (the agency sign): the subagent types a worker can call on, searched and grouped by where they come
 * from (built in, this project, yours, plugins). Each shows what it is for, which model it uses and which tools it may use.
 * "Hire for a task" opens the new-task memo with "Use the <name> subagent to " ready to finish; "Open file" opens the type's
 * own file in the editor (`openConfigFile`) when it has one. Display logic is in agencyLogic.ts.
 *
 * It asks the host for the `agents` section of the catalog (`getCatalog`) every time it is opened and when Refresh is
 * pressed. A reply or error for an older request is ignored. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { AgentTypeItem, HostToWebview } from '../../src/shared/protocol.ts';
import {
  AGENCY_INITIAL, TOOLS_INLINE_MAX, agencyCount, agencyHandle, agencyRequested, agentNote, EMPTY_AGENTS, groupAgents, hirePrefill, modelLabel, NO_MATCHES, toolsSummary,
} from './agencyLogic.ts';
import type { AgencyState } from './agencyLogic.ts';
import { button, h, keepFocus, pixelIcon } from './dom.ts';

export interface AgencyDeps {
  /** The file room root whose project's types to list (`getCatalog.rootId`). Leave out for the active workspace folder. */
  rootId?(): string | undefined;
}

// ---------------------------------------------------------------------------
// Styles

const CSS = `
.co-ag { --ag-fg: var(--vscode-foreground, #cccccc); --ag-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --ag-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --ag-focus: var(--vscode-focusBorder, #007fd4); --ag-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
  --ag-err: var(--vscode-errorForeground, #f48771); --ag-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  display: flex; flex-direction: column; gap: 10px; }
.co-ag-top { position: sticky; top: -10px; z-index: 1; margin: -10px -12px 0; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)); border-bottom: 1px solid var(--ag-border); }
.co-ag-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 22px; }
.co-ag-bar .co-btn { flex: none; }
.co-ag-summary { margin: 0; font-size: 12px; color: var(--ag-dim); min-width: 0; overflow-wrap: anywhere; }
.co-ag .co-btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.co-ag-search { display: block; min-height: 28px; }
.co-ag-groups { display: flex; flex-direction: column; gap: 12px; }
.co-ag-group { display: flex; flex-direction: column; gap: 6px; }
.co-ag-gh { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ag-dim); }
.co-ag-gh span:last-child { font-weight: 600; letter-spacing: 0; text-transform: none; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.co-ag-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-ag-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--ag-card); border: 1px solid var(--ag-border); border-radius: 5px; min-width: 0; }
.co-ag-name { font-weight: 600; font-family: var(--ag-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.co-ag-desc { margin: 0; font-size: 12.5px; color: color-mix(in srgb, var(--ag-fg) 85%, var(--ag-dim)); overflow-wrap: anywhere; }
.co-ag-facts { display: flex; flex-direction: column; gap: 2px; margin: 0; font-size: 12px; color: var(--ag-dim); }
.co-ag-fact { display: flex; flex-wrap: wrap; gap: 0 6px; min-width: 0; overflow-wrap: anywhere; }
.co-ag-fact dt { flex: none; }
.co-ag-fact dd { margin: 0; flex: 1 1 0; color: var(--ag-fg); min-width: 0; overflow-wrap: anywhere; }
.co-ag-tools > summary { cursor: pointer; color: var(--ag-fg); border-radius: 2px; }
.co-ag-tools > summary:focus-visible { outline: 2px solid var(--ag-focus); outline-offset: 2px; }
.co-ag-toollist { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 0; padding: 0; list-style: none; }
.co-ag-toollist li { font-family: var(--ag-mono); font-size: 11.5px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--ag-border); color: var(--ag-fg); overflow-wrap: anywhere; }
.co-ag-note { font-size: 11.5px; color: var(--ag-dim); }
.co-ag-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.co-ag-foot { margin: 0; font-size: 11.5px; font-style: italic; color: var(--ag-dim); }
.co-ag-empty { margin: 24px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--ag-dim); overflow-wrap: anywhere; }
.co-ag-empty strong { color: var(--ag-fg); font-size: 13.5px; }
.co-ag-load { display: flex; align-items: center; gap: 8px; color: var(--ag-dim); margin: 8px 0; }
.co-ag-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--ag-fg) 25%, transparent); border-top-color: var(--ag-fg); animation: co-ag-spin 0.8s linear infinite; flex: none; }
@keyframes co-ag-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-ag-spin { animation: none; border-top-style: dotted; } }
.co-ag-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--ag-err) 55%, transparent); background: color-mix(in srgb, var(--ag-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-ag-err strong { color: var(--ag-fg); }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

const SLOW_MS = 10_000;

let reqCounter = 0;
function nextReqId(): string {
  reqCounter += 1;
  return `ag-${reqCounter}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// The panel

/** Builds the Temp agency panel. Register it under id `agency`. */
export function createAgencyPanel(deps: AgencyDeps = {}): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let summaryEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let searchEl: HTMLInputElement | null = null;
  let contentEl: HTMLElement | null = null;
  let state: AgencyState = AGENCY_INITIAL;
  let query = '';
  /** Cards whose tool list is open (`source:name`). */
  const openTools = new Set<string>();
  let reqId = '';
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSlow(): void {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
  }

  /** `force` = an explicit Refresh or Try again press: the host skips its caches. Opening the panel never forces. */
  function request(force = false): void {
    if (!ctx) return;
    reqId = nextReqId();
    state = agencyRequested(state);
    slow = false;
    clearSlow();
    slowTimer = setTimeout(() => { if (state.loading) { slow = true; render(); } }, SLOW_MS);
    const rootId = deps.rootId?.();
    ctx.post({ type: 'getCatalog', reqId, section: 'agents', ...(rootId ? { rootId } : {}), ...(force ? { refresh: true as const } : {}) });
    render();
  }

  function toolsNode(tools: readonly string[] | undefined, key: string): HTMLElement {
    const text = toolsSummary(tools);
    if (!tools || tools.length <= TOOLS_INLINE_MAX) return h('dd', { text });
    const d = h('details', { class: 'co-ag-tools', open: openTools.has(key) }, h('summary', { text, 'data-fk': `tools:${key}` }), h('ul', { class: 'co-ag-toollist' }, ...tools.map((t) => h('li', { text: t }))));
    // A refresh rebuilds the cards: keep the lists that were opened open.
    d.addEventListener('toggle', () => { if (d.open) openTools.add(key); else openTools.delete(key); });
    return h('dd', null, d);
  }

  function card(a: AgentTypeItem, c: PanelContext<HTMLElement>): HTMLElement {
    const note = agentNote(a);
    const key = `${a.source}:${a.name}`;
    return h('li', { class: 'co-ag-card', 'data-name': a.name },
      h('span', { class: 'co-ag-name', text: a.name }),
      a.description ? h('p', { class: 'co-ag-desc', text: a.description }) : null,
      h('dl', { class: 'co-ag-facts' },
        h('div', { class: 'co-ag-fact' }, h('dt', { text: 'Model:' }), h('dd', { text: modelLabel(a.model) })),
        h('div', { class: 'co-ag-fact' }, h('dt', { text: 'Tools:' }), toolsNode(a.tools, key))),
      note ? h('span', { class: 'co-ag-note', text: note }) : null,
      h('div', { class: 'co-ag-actions' },
        button('Hire for a task', 'co-btn co-primary co-small', () => c.openMemo({ prefill: hirePrefill(a) }),
          { 'aria-label': `Hire ${a.name} for a task`, title: 'Start a new task that uses this subagent', 'data-fk': `hire:${key}` }),
        a.fileId
          ? button('Open file', 'co-btn co-secondary co-small', () => { if (a.fileId) c.post({ type: 'openConfigFile', fileId: a.fileId }); },
            { 'aria-label': `Open the file for ${a.name}`, 'data-fk': `file:${key}` })
          : null));
  }

  function render(): void {
    const c = ctx;
    if (!c || !contentEl || !summaryEl || !refreshBtn || !searchEl) return;
    const restore = keepFocus(contentEl);
    const all = state.agents;
    const groups = all ? groupAgents(all, query) : [];
    const shown = groups.reduce((n, g) => n + g.agents.length, 0);
    let summary = '';
    if (all) summary = all.length ? agencyCount(shown, all.length) : 'No types';
    if (summaryEl.textContent !== summary) summaryEl.textContent = summary;
    refreshBtn.textContent = state.loading && all !== null ? 'Refreshing…' : 'Refresh';
    refreshBtn.setAttribute('aria-disabled', String(state.loading));
    refreshBtn.setAttribute('aria-busy', String(state.loading));
    searchEl.disabled = !all || all.length === 0;

    const nodes: Node[] = [];
    if (state.error) {
      nodes.push(h('div', { class: 'co-ag-err', role: 'alert' },
        h('span', null, h('strong', { text: 'Couldn’t read the subagent types. ' }), state.error),
        button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' })));
    }
    if (!all) {
      if (state.loading) {
        nodes.push(h('div', { class: 'co-ag-load', role: 'status' }, h('span', { class: 'co-ag-spin', 'aria-hidden': 'true' }),
          h('span', { text: slow ? 'Still waiting for an answer…' : 'Looking up the types…' })));
        if (slow) nodes.push(button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' }));
      }
    } else if (all.length === 0) {
      if (!state.error) nodes.push(h('div', { class: 'co-ag-empty', role: 'status' }, pixelIcon('agency', 32), h('strong', { text: 'The agency has no one on its books' }), h('span', { text: EMPTY_AGENTS })));
    } else if (groups.length === 0) {
      nodes.push(h('div', { class: 'co-ag-empty', role: 'status' }, pixelIcon('agency', 32), h('strong', { text: 'No matches' }), h('span', { text: NO_MATCHES }),
        button('Clear search', 'co-btn co-secondary co-small', () => { query = ''; if (searchEl) { searchEl.value = ''; searchEl.focus(); } render(); })));
    } else {
      nodes.push(h('div', { class: 'co-ag-groups' }, ...groups.map((g) => h('section', { class: 'co-ag-group', 'aria-label': g.title },
        h('h3', { class: 'co-ag-gh' }, h('span', { text: g.title }), h('span', { text: String(g.agents.length) })),
        h('ul', { class: 'co-ag-list' }, ...g.agents.map((a) => card(a, c)))))));
      if (state.truncated) nodes.push(h('p', { class: 'co-ag-foot', text: 'Only the first types are shown.' }));
    }
    contentEl.replaceChildren(...nodes);
    restore();
  }

  return {
    id: 'agency',
    title: 'Temp agency',
    icon: 'agency',
    mount(body, c) {
      injectCss();
      ctx = c;
      state = AGENCY_INITIAL;
      query = '';
      openTools.clear();
      summaryEl = h('p', { class: 'co-ag-summary', role: 'status' });
      refreshBtn = button('Refresh', 'co-btn co-secondary co-small', () => { if (!state.loading) request(true); }, { title: 'Read the subagent types again' });
      searchEl = h('input', {
        type: 'search', class: 'co-input co-ag-search', placeholder: 'Search types', 'aria-label': 'Search subagent types', autocomplete: 'off', spellcheck: 'false',
      });
      searchEl.addEventListener('input', () => { query = searchEl?.value ?? ''; render(); });
      searchEl.addEventListener('keydown', (e) => {
        // Escape clears a search first; with nothing typed it goes on to close the drawer.
        if (e.key === 'Escape' && searchEl && searchEl.value !== '') {
          searchEl.value = '';
          query = '';
          e.preventDefault();
          e.stopPropagation();
          render();
        }
      });
      contentEl = h('div', { class: 'co-ag-content co-focus-park', tabindex: '-1', style: 'display:flex;flex-direction:column;gap:10px' });
      // Like the Training library: the search and the counts stay at the top while the list scrolls.
      body.appendChild(h('div', { class: 'co-ag' }, h('div', { class: 'co-ag-top' }, searchEl, h('div', { class: 'co-ag-bar' }, summaryEl, refreshBtn)), contentEl));
      request();
    },
    handle(msg: HostToWebview) {
      const next = agencyHandle(state, msg, reqId);
      if (!next) return;
      state = next;
      if (!state.loading) { clearSlow(); slow = false; }
      render();
    },
    unmount() {
      clearSlow();
      reqId = '';
      ctx = null;
      summaryEl = null;
      refreshBtn = null;
      searchEl = null;
      contentEl = null;
    },
  };
}
