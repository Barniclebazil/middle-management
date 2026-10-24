/**
 * The Office handbook panel (the notice board): what shapes every worker's behaviour. Three sections:
 *  - Instructions: the CLAUDE.md files (and rules files) in the order Claude Code loads them;
 *  - Memory: the memory index and its entries;
 *  - Rules: permission rules by behaviour (never allowed, asks first, allowed), then by scope.
 * Display logic is in handbookLogic.ts. Files are opened in the editor with `openConfigFile` (an opaque `fileId`; the panel
 * never sees a path it could send back). Long lists start collapsed or cut short, with a button for the rest.
 *
 * It asks the host for the `handbook` section of the catalog (`getCatalog`) every time it is opened and when Refresh is
 * pressed. A reply or error for an older request is ignored. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { HandbookFile, HostToWebview, MemoryEntry, PermissionRuleItem } from '../../src/shared/protocol.ts';
import { button, h, keepFocus } from './dom.ts';
import {
  EMPTY_INSTRUCTIONS, EMPTY_MEMORY, EMPTY_RULES, HANDBOOK_INITIAL, MEMORY_OPEN_MAX, MEMORY_SHOWN, RULES_OPEN_MAX, RULES_SHOWN, handbookCounts, handbookHandle,
  handbookRequested, instructionRows, memoryRows, ruleGroups, rulesSummary, sharedFileId, summaryLine,
} from './handbookLogic.ts';
import type { HandbookState } from './handbookLogic.ts';

export interface HandbookDeps {
  /** The file room root whose project's handbook to show (`getCatalog.rootId`). Leave out for the active workspace folder. */
  rootId?(): string | undefined;
}

// ---------------------------------------------------------------------------
// Styles

const CSS = `
.co-hb { --hb-fg: var(--vscode-foreground, #cccccc); --hb-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --hb-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --hb-focus: var(--vscode-focusBorder, #007fd4); --hb-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
  --hb-err: var(--vscode-errorForeground, #f48771); --hb-warn: var(--vscode-editorWarning-foreground, #cca700);
  --hb-ok: var(--vscode-testing-iconPassed, var(--hb-ok-fb, #388a34)); --hb-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  display: flex; flex-direction: column; gap: 10px; }
body.vscode-dark .co-hb { --hb-ok-fb: #73c991; }
body.vscode-high-contrast .co-hb { --hb-ok-fb: #89d185; }
.co-hb-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.co-hb-summary { margin: 0; font-size: 12px; color: var(--hb-dim); min-width: 0; overflow-wrap: anywhere; }
.co-hb .co-btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.co-hb-sec { border: 1px solid var(--hb-border); border-radius: 5px; min-width: 0; }
.co-hb-sec > summary { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; list-style: none; font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--hb-dim); }
.co-hb-sec > summary::-webkit-details-marker { display: none; }
.co-hb-sec > summary::before { content: '▸'; font-size: 11px; width: 10px; flex: none; transition: transform 0.12s; }
.co-hb-sec[open] > summary::before { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .co-hb-sec > summary::before { transition: none; } }
.co-hb-sec > summary:focus-visible { outline: 2px solid var(--hb-focus); outline-offset: -2px; }
.co-hb-sec > summary:hover { color: var(--hb-fg); }
.co-hb-count { margin-left: auto; font-weight: 600; letter-spacing: 0; text-transform: none; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.co-hb-secbody { display: flex; flex-direction: column; gap: 8px; padding: 2px 10px 10px; }
.co-hb-blurb { margin: 0; font-size: 12px; color: var(--hb-dim); }
.co-hb-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-hb-item { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px 10px; padding: 7px 9px; background: var(--hb-card); border: 1px solid var(--hb-border); border-radius: 4px; min-width: 0; }
.co-hb-num { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1px solid var(--hb-border); font-size: 11px; line-height: 16px; text-align: center; color: var(--hb-dim); font-variant-numeric: tabular-nums; }
.co-hb-main { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.co-hb-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; min-width: 0; }
.co-hb-label { font-weight: 600; overflow-wrap: anywhere; }
.co-hb-label.mono { font-family: var(--hb-mono); font-size: 12.5px; }
.co-hb-chip { flex: none; display: inline-block; padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; font-weight: 600; letter-spacing: 0.03em;
  border: 1px solid var(--hb-border); color: var(--hb-dim); white-space: nowrap; }
.co-hb-sub { font-size: 11.5px; color: var(--hb-dim); overflow-wrap: anywhere; }
.co-hb-sub.mono { font-family: var(--hb-mono); font-size: 11.5px; overflow-wrap: break-word; }
.co-hb-hook { font-size: 12px; color: color-mix(in srgb, var(--hb-fg) 80%, var(--hb-dim)); overflow-wrap: anywhere; }
.co-hb-item .co-btn { flex: none; }
.co-hb-group { display: flex; flex-direction: column; gap: 6px; padding-left: 8px; border-left: 3px solid var(--hb-border); }
.co-hb-group[data-behavior="deny"] { border-left-color: var(--hb-err); }
.co-hb-group[data-behavior="ask"] { border-left-color: var(--hb-warn); }
.co-hb-group[data-behavior="allow"] { border-left-color: var(--hb-ok); }
.co-hb-gh { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; font-weight: 600; }
.co-hb-gh .co-hb-count { font-weight: 400; color: var(--hb-dim); }
.co-hb-scope { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; font-size: 11.5px; color: var(--hb-dim); }
.co-hb-rules { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.co-hb-rule { display: flex; align-items: flex-start; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; }
.co-hb-rule code, .co-hb code { font-family: var(--hb-mono); font-size: 12px; padding: 1px 5px; border-radius: 3px; background: color-mix(in srgb, var(--hb-fg) 11%, transparent);
  white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.co-hb-more { align-self: flex-start; }
.co-hb li:focus-visible { outline: 2px solid var(--hb-focus); outline-offset: 1px; }
.co-hb-note { margin: 0; font-size: 11.5px; font-style: italic; color: var(--hb-dim); }
.co-hb-none { margin: 2px 0 0; font-size: 12px; color: var(--hb-dim); overflow-wrap: anywhere; }
.co-hb-empty { margin: 24px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--hb-dim); overflow-wrap: anywhere; }
.co-hb-load { display: flex; align-items: center; gap: 8px; color: var(--hb-dim); margin: 8px 0; }
.co-hb-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--hb-fg) 25%, transparent); border-top-color: var(--hb-fg); animation: co-hb-spin 0.8s linear infinite; flex: none; }
@keyframes co-hb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-hb-spin { animation: none; border-top-style: dotted; } }
.co-hb-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--hb-err) 55%, transparent); background: color-mix(in srgb, var(--hb-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-hb-err strong { color: var(--hb-fg); }
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
  return `hb-${reqCounter}-${Date.now().toString(36)}`;
}

/** A path as text nodes with a line-break chance after each slash (so it wraps at folders, not mid-name). */
function pathNodes(path: string): Node[] {
  const out: Node[] = [];
  path.split('/').forEach((part, i, all) => {
    if (part) out.push(document.createTextNode(part));
    if (i < all.length - 1) { out.push(document.createTextNode('/')); out.push(document.createElement('wbr')); }
  });
  return out;
}

type SectionKey = 'instructions' | 'memory' | 'rules';

// ---------------------------------------------------------------------------
// The panel

/** Builds the Office handbook panel. Register it under id `handbook`. */
export function createHandbookPanel(deps: HandbookDeps = {}): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let summaryEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let contentEl: HTMLElement | null = null;
  let state: HandbookState = HANDBOOK_INITIAL;
  let reqId = '';
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sections the user opened or closed by hand; the rest follow the defaults. */
  let toggled = new Map<SectionKey, boolean>();
  let showAll = new Set<SectionKey>();
  /** After the next render, focus this row of a section (the first one "Show all" revealed). */
  let focusRow: { key: SectionKey; index: number } | null = null;

  function clearSlow(): void {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
  }

  /** `force` = an explicit Refresh or Try again press: the host skips its caches. Opening the panel never forces. */
  function request(force = false): void {
    if (!ctx) return;
    reqId = nextReqId();
    state = handbookRequested(state);
    slow = false;
    clearSlow();
    slowTimer = setTimeout(() => { if (state.loading) { slow = true; render(); } }, SLOW_MS);
    const rootId = deps.rootId?.();
    ctx.post({ type: 'getCatalog', reqId, section: 'handbook', ...(rootId ? { rootId } : {}), ...(force ? { refresh: true as const } : {}) });
    render();
  }

  function openFile(fileId: string): void {
    ctx?.post({ type: 'openConfigFile', fileId });
  }

  function openBtn(fileId: string | undefined, what: string, text = 'Open in editor'): HTMLElement | null {
    if (!fileId) return null;
    return button(text, 'co-btn co-secondary co-small', () => openFile(fileId), { 'aria-label': `Open ${what} in editor`, 'data-fk': `open:${fileId}` });
  }

  function section(key: SectionKey, title: string, count: number, openByDefault: boolean, ...kids: (Node | null)[]): HTMLElement {
    const open = toggled.get(key) ?? openByDefault;
    const d = h('details', { class: 'co-hb-sec', 'data-sec': key, open }, h('summary', { 'data-fk': `sec:${key}` },
      h('span', { text: title }), h('span', { class: 'co-hb-count', text: String(count) })),
    h('div', { class: 'co-hb-secbody' }, ...kids));
    d.addEventListener('toggle', () => { if (d.open !== open) toggled.set(key, d.open); });
    return d;
  }

  function moreButton(key: SectionKey, total: number, shown: number, noun: string): HTMLElement | null {
    if (total <= shown && !showAll.has(key)) return null;
    const all = showAll.has(key);
    return button(all ? 'Show fewer' : `Show all ${total} ${noun}`, 'co-btn co-ghost co-small co-hb-more', () => {
      if (all) showAll.delete(key); else showAll.add(key);
      // Expanding: the button moves to the end of a long list, so focus goes to the first row that was hidden.
      focusRow = all ? null : { key, index: shown };
      render();
    }, { 'data-fk': `more:${key}`, 'aria-expanded': String(all) });
  }

  function instructionsSection(files: HandbookFile[]): HTMLElement {
    const rows = instructionRows(files);
    const body: (Node | null)[] = [];
    if (!rows.length) body.push(h('p', { class: 'co-hb-none', text: EMPTY_INSTRUCTIONS }));
    else {
      body.push(h('p', { class: 'co-hb-blurb', text: 'Read from the top down. Later files are more specific.' }));
      body.push(h('ol', { class: 'co-hb-list' }, ...rows.map((r, i) => h('li', { class: 'co-hb-item' },
        h('span', { class: 'co-hb-num', 'aria-hidden': 'true', text: String(i + 1) }),
        h('div', { class: 'co-hb-main' },
          h('div', { class: 'co-hb-line' }, h('span', { class: 'co-hb-label mono', text: r.file.label }), h('span', { class: 'co-hb-chip', text: r.scopeLabel })),
          h('span', { class: 'co-hb-sub mono' }, ...pathNodes(r.file.display)),
          r.size ? h('span', { class: 'co-hb-sub', text: r.size }) : null),
        openBtn(r.file.fileId, r.file.label)))));
    }
    return section('instructions', 'Instructions', rows.length, true, ...body);
  }

  function memorySection(index: HandbookFile | null, entries: MemoryEntry[]): HTMLElement {
    const rows = memoryRows(entries);
    const limit = showAll.has('memory') ? rows.length : MEMORY_SHOWN;
    const body: (Node | null)[] = [];
    if (!rows.length && !index) body.push(h('p', { class: 'co-hb-none', text: EMPTY_MEMORY }));
    else {
      if (index) {
        body.push(h('div', { class: 'co-hb-item' },
          h('div', { class: 'co-hb-main' },
            h('div', { class: 'co-hb-line' }, h('span', { class: 'co-hb-label mono', text: index.label }), h('span', { class: 'co-hb-chip', text: 'Index' })),
            h('span', { class: 'co-hb-sub mono' }, ...pathNodes(index.display))),
          openBtn(index.fileId, index.label)));
      }
      if (!rows.length) body.push(h('p', { class: 'co-hb-none', text: EMPTY_MEMORY }));
      else {
        body.push(h('ul', { class: 'co-hb-list' }, ...rows.slice(0, limit).map((r) => h('li', { class: 'co-hb-item' },
          h('div', { class: 'co-hb-main' },
            h('div', { class: 'co-hb-line' }, h('span', { class: 'co-hb-label', text: r.title }), r.typeLabel ? h('span', { class: 'co-hb-chip', text: r.typeLabel }) : null),
            r.hook ? h('span', { class: 'co-hb-hook', text: r.hook }) : null),
          openBtn(r.entry.fileId, r.title, 'Open')))));
        body.push(moreButton('memory', rows.length, MEMORY_SHOWN, rows.length === 1 ? 'memory' : 'memories'));
      }
    }
    return section('memory', 'Memory', rows.length, rows.length <= MEMORY_OPEN_MAX, ...body);
  }

  function rulesSection(rules: PermissionRuleItem[]): HTMLElement {
    const groups = ruleGroups(rules);
    const counts = handbookCounts([], [], rules);
    const body: (Node | null)[] = [];
    if (!groups.length) body.push(h('p', { class: 'co-hb-none', text: EMPTY_RULES }));
    else {
      body.push(h('p', { class: 'co-hb-blurb', text: rulesSummary(counts) }));
      let budget = showAll.has('rules') ? Infinity : RULES_SHOWN;
      for (const g of groups) {
        if (budget <= 0) break;
        const scopes: Node[] = [];
        for (const sc of g.scopes) {
          if (budget <= 0) break;
          const shown = sc.rules.slice(0, budget);
          budget -= shown.length;
          const shared = sharedFileId(sc.rules);
          scopes.push(h('div', { class: 'co-hb-scopegroup', style: 'display:flex;flex-direction:column;gap:4px' },
            h('div', { class: 'co-hb-scope' }, h('span', { text: sc.title }), shared ? openBtn(shared, `${sc.title.toLowerCase()} settings`) : null),
            h('ul', { class: 'co-hb-rules' }, ...shown.map((r) => h('li', { class: 'co-hb-rule' }, h('code', { text: r.rule }),
              shared ? null : openBtn(r.fileId, `settings file for ${r.rule}`))))));
        }
        body.push(h('section', { class: 'co-hb-group', 'data-behavior': g.behavior, 'aria-label': g.title },
          h('h4', { class: 'co-hb-gh' }, h('span', { text: g.title }), h('span', { class: 'co-hb-count', text: String(g.count) })), ...scopes));
      }
      body.push(moreButton('rules', rules.length, RULES_SHOWN, 'rules'));
    }
    return section('rules', 'Rules', rules.length, rules.length <= RULES_OPEN_MAX, ...body);
  }

  function render(): void {
    if (!contentEl || !summaryEl || !refreshBtn) return;
    // Keep the keyboard focus on the same control through the rebuild (or on the content when that control is gone).
    const active = contentEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['fk'] : undefined;
    const restore = keepFocus(contentEl);
    const data = state.data;
    let summary = '';
    if (data) summary = summaryLine(handbookCounts(data.instructions, data.memory, data.rules));
    if (summaryEl.textContent !== summary) summaryEl.textContent = summary;
    refreshBtn.textContent = state.loading && data !== null ? 'Refreshing…' : 'Refresh';
    refreshBtn.setAttribute('aria-disabled', String(state.loading));
    refreshBtn.setAttribute('aria-busy', String(state.loading));

    const nodes: Node[] = [];
    if (state.error) {
      nodes.push(h('div', { class: 'co-hb-err', role: 'alert' },
        h('span', null, h('strong', { text: 'Couldn’t read the handbook. ' }), state.error),
        button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' })));
    }
    if (!data) {
      if (state.loading) {
        nodes.push(h('div', { class: 'co-hb-load', role: 'status' }, h('span', { class: 'co-hb-spin', 'aria-hidden': 'true' }),
          h('span', { text: slow ? 'Still waiting for an answer…' : 'Opening the handbook…' })));
        if (slow) nodes.push(button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' }));
      }
    } else {
      nodes.push(instructionsSection(data.instructions), memorySection(data.memoryIndex, data.memory), rulesSection(data.rules));
      if (data.truncated) nodes.push(h('p', { class: 'co-hb-note', text: 'The lists were cut short.' }));
    }
    contentEl.replaceChildren(...nodes);
    if (focusRow) {
      const row = contentEl.querySelector(`[data-sec="${focusRow.key}"]`)?.querySelectorAll<HTMLElement>('li')[focusRow.index];
      focusRow = null;
      if (row) { row.tabIndex = -1; row.focus(); return; }
    }
    if (active !== undefined) {
      const el = Array.from(contentEl.querySelectorAll<HTMLElement>('[data-fk]')).find((e) => e.dataset['fk'] === active);
      if (el) { el.focus({ preventScroll: true }); if (active.startsWith('more:')) el.scrollIntoView({ block: 'nearest' }); }
    }
    restore();
  }

  return {
    id: 'handbook',
    title: 'Office handbook',
    icon: 'handbook',
    mount(body, c) {
      injectCss();
      ctx = c;
      state = HANDBOOK_INITIAL;
      toggled = new Map();
      showAll = new Set();
      summaryEl = h('p', { class: 'co-hb-summary', role: 'status' });
      refreshBtn = button('Refresh', 'co-btn co-secondary co-small', () => { if (!state.loading) request(true); }, { title: 'Read the files again' });
      contentEl = h('div', { class: 'co-hb-content co-focus-park', tabindex: '-1', style: 'display:flex;flex-direction:column;gap:10px' });
      body.appendChild(h('div', { class: 'co-hb' }, h('div', { class: 'co-hb-top' }, summaryEl, refreshBtn), contentEl));
      request();
    },
    handle(msg: HostToWebview) {
      const next = handbookHandle(state, msg, reqId);
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
      contentEl = null;
    },
  };
}
