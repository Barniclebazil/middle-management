/**
 * The Training library panel (the bookshelf): the user's skills and slash commands, searched, grouped by source and shown
 * with how often each skill was used. "Use this" opens the new-task memo with the slash command typed in (`usePrefill`);
 * "Open file" asks the host to open the item's file in the editor (`openConfigFile`). The list comes from one request
 * (`getCatalog`, section `skills`, which carries both lists) with a fresh `reqId`; a reply with any other id is ignored.
 * What to show, in which order and how to word it lives in libraryLogic.ts. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { CommandItem, HostToWebview, SkillItem } from '../../src/shared/protocol.ts';
import { button, h, keepFocus, pixelIcon } from './dom.ts';
import {
  EMPTY_COMMANDS, EMPTY_LIBRARY, EMPTY_SKILLS, NO_MATCHES, groupCommands, groupSkills, groupTotal, libraryCounts, pluginNote, usageLabel, usePrefill,
} from './libraryLogic.ts';
import type { LibraryGroup } from './libraryLogic.ts';

export interface LibraryDeps {
  /** A fresh request id (the playground makes them predictable). The default is `library-<n>-<time>`. */
  newReqId?(): string;
}

const CSS = `
.co-lib { --lb-fg: var(--vscode-foreground, #cccccc); --lb-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --lb-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --lb-err: var(--vscode-errorForeground, #f48771); --lb-focus: var(--vscode-focusBorder, #007fd4);
  --lb-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); --lb-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16));
  --lb-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f));
  --lb-mono: var(--vscode-editor-font-family, ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace);
  --lb-code: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14));
  display: flex; flex-direction: column; gap: 10px; }
.co-lib-top { position: sticky; top: -10px; z-index: 1; margin: -10px -12px 0; padding: 8px 12px 8px; display: flex; flex-direction: column; gap: 6px;
  background: var(--lb-bg); border-bottom: 1px solid var(--lb-border); }
.co-lib-search { width: 100%; min-height: 28px; padding: 4px 8px; font: inherit; color: var(--vscode-input-foreground, var(--lb-fg));
  background: var(--vscode-input-background, rgba(128,128,128,0.12)); border: 1px solid var(--vscode-input-border, var(--lb-border)); border-radius: 3px; }
.co-lib-search:focus { outline: 1px solid var(--lb-focus); outline-offset: -1px; border-color: var(--lb-focus); }
.co-lib-search::placeholder { color: var(--vscode-input-placeholderForeground, var(--lb-dim)); }
.co-lib-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 22px; }
.co-lib-counts { margin: 0; min-width: 0; font-size: 12px; color: var(--lb-dim); }
.co-lib-bar .co-btn { flex: none; }
.co-lib-bar .co-btn[aria-disabled="true"] { opacity: 0.6; cursor: default; }
.co-lib-sec { display: flex; flex-direction: column; gap: 6px; }
.co-lib-sech { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--lb-fg); }
.co-lib-tog { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 4px 2px 0; border: 0; border-radius: 3px; background: transparent; cursor: pointer;
  font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit; text-align: left; }
.co-lib-tog:hover { background: var(--lb-hover); }
.co-lib-tog:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 1px; }
.co-lib-caret { flex: none; width: 10px; font-size: 10px; color: var(--lb-dim); }
.co-lib-count { padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; letter-spacing: 0; background: var(--vscode-badge-background, rgba(128,128,128,0.3));
  color: var(--vscode-badge-foreground, var(--lb-fg)); border: 1px solid var(--vscode-contrastBorder, transparent); }
.co-lib-gh { margin: 4px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--lb-dim); }
.co-lib-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-lib-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--lb-card); border: 1px solid var(--lb-border); border-radius: 5px; min-width: 0; }
.co-lib-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.co-lib-name { font-weight: 600; overflow-wrap: anywhere; }
.co-lib-invoke, .co-lib-arg { font-family: var(--lb-mono); font-size: 11.5px; overflow-wrap: anywhere; }
.co-lib-invoke { padding: 0 5px; border-radius: 3px; background: var(--lb-code); }
.co-lib-arg { color: var(--lb-dim); }
.co-lib-desc { margin: 0; font-size: 12.5px; overflow-wrap: anywhere; }
.co-lib-desc.none { color: var(--lb-dim); font-style: italic; }
.co-lib-meta { display: flex; flex-wrap: wrap; gap: 0 10px; font-size: 11.5px; color: var(--lb-dim); }
.co-lib-meta:empty { display: none; }
.co-lib-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.co-lib-none { margin: 0; padding: 8px 10px; font-size: 12px; color: var(--lb-dim); border: 1px dashed var(--lb-border); border-radius: 5px; }
.co-lib-empty { margin: 22px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--lb-dim); }
.co-lib-empty strong { color: var(--lb-fg); font-size: 13.5px; }
.co-lib-load { display: flex; align-items: center; gap: 8px; color: var(--lb-dim); margin: 8px 0; flex-wrap: wrap; }
.co-lib-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--lb-fg) 25%, transparent); border-top-color: var(--lb-fg); animation: co-lib-spin 0.8s linear infinite; flex: none; }
@keyframes co-lib-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-lib-spin { animation: none; border-top-color: color-mix(in srgb, var(--lb-fg) 25%, transparent); } }
.co-lib-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--lb-err) 55%, transparent); background: color-mix(in srgb, var(--lb-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-lib-err strong { color: var(--lb-fg); }
.co-lib-results { display: flex; flex-direction: column; gap: 10px; }
.co-lib-note { margin: 0; padding: 6px 10px; font-size: 12px; color: var(--lb-dim); border: 1px dashed var(--lb-border); border-radius: 4px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** How long a request may take before the loading line offers "Try again". */
const SLOW_MS = 12_000;
/** `refresh()` (the drawer calls it whenever an agent or the usage changes) asks again only when the list is older than this. */
const STALE_MS = 30_000;

let reqCounter = 0;
function defaultReqId(): string {
  reqCounter += 1;
  return `library-${reqCounter}-${Date.now().toString(36)}`;
}

/** `replaceChildren` that skips nulls. */
function setKids(el: HTMLElement, ...xs: (Node | null | undefined)[]): void {
  el.replaceChildren(...xs.filter((x): x is Node => !!x));
}

interface Catalog {
  skills: SkillItem[];
  commands: CommandItem[];
  truncated: boolean;
  /** Wall-clock ms when it arrived. */
  at: number;
}

type SectionId = 'skills' | 'commands';

/** Builds the Training library panel. Register it under id `library`. */
export function createLibraryPanel(deps: LibraryDeps = {}): PanelView<HTMLElement> {
  const newId = deps.newReqId ?? defaultReqId;
  let ctx: PanelContext<HTMLElement> | null = null;
  let root: HTMLElement | null = null;
  let search: HTMLInputElement | null = null;
  let countsEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let notesEl: HTMLElement | null = null;
  let resultsEl: HTMLElement | null = null;

  // The last list, kept across mounts so reopening shows it at once while a fresh one is asked for.
  let data: Catalog | null = null;
  let loading = false;
  let slow = false;
  let error: string | null = null;
  let reqId = '';
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let query = '';
  const collapsed = new Set<SectionId>();

  /** `force` = an explicit Refresh or Try again press: the host skips its caches. Opening the panel never forces. */
  function request(force = false): void {
    const c = ctx;
    if (!c) return;
    reqId = newId();
    loading = true;
    slow = false;
    error = null;
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { slow = true; renderAll(); }, SLOW_MS);
    c.post(force ? { type: 'getCatalog', reqId, section: 'skills', refresh: true } : { type: 'getCatalog', reqId, section: 'skills' });
    renderAll();
  }

  function useItem(item: SkillItem | CommandItem): void {
    ctx?.openMemo({ prefill: usePrefill(item) });
  }

  function itemCard(item: SkillItem | CommandItem, kind: SectionId, now: number): HTMLElement {
    const c = ctx;
    const skill = kind === 'skills' ? (item as SkillItem) : null;
    const arg = kind === 'commands' ? (item as CommandItem).argumentHint : undefined;
    const meta = [skill ? usageLabel(skill.uses, skill.lastUsedAt, now) : '', pluginNote(item)].filter(Boolean);
    const what = kind === 'skills' ? 'skill' : 'command';
    return h('li', { class: 'co-lib-item' },
      h('div', { class: 'co-lib-title' },
        h('span', { class: 'co-lib-name', text: item.name }),
        item.invoke !== item.name ? h('code', { class: 'co-lib-invoke', text: `/${item.invoke}` }) : null,
        arg ? h('span', { class: 'co-lib-arg', text: arg }) : null),
      item.description ? h('p', { class: 'co-lib-desc', text: item.description }) : h('p', { class: 'co-lib-desc none', text: 'No description.' }),
      h('div', { class: 'co-lib-meta' }, ...meta.map((m) => h('span', { text: m }))),
      h('div', { class: 'co-lib-actions' },
        button('Use this', 'co-btn co-primary co-small', () => useItem(item), { 'aria-label': `Use the ${item.name} ${what}`, title: `Start a task with /${item.invoke}`, 'data-fk': `use:${kind}:${item.invoke}` }),
        item.fileId !== undefined
          ? button('Open file', 'co-btn co-secondary co-small', () => { if (item.fileId !== undefined) c?.post({ type: 'openConfigFile', fileId: item.fileId }); },
            { 'aria-label': `Open the file for the ${item.name} ${what}`, title: 'Open this file in your editor', 'data-fk': `file:${kind}:${item.invoke}` })
          : null));
  }

  function section<T extends SkillItem | CommandItem, S extends string>(id: SectionId, title: string, total: number, groups: LibraryGroup<T, S>[], emptyText: string, searching: boolean, now: number): HTMLElement {
    const shown = groupTotal(groups);
    const open = searching || !collapsed.has(id);
    const count = h('span', { class: 'co-lib-count', text: searching ? `${shown} of ${total}` : String(total) });
    const head = searching
      ? h('h3', { class: 'co-lib-sech' }, h('span', { text: title }), count)
      : h('h3', { class: 'co-lib-sech' }, button([h('span', { class: 'co-lib-caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' }), h('span', { text: title }), count], 'co-lib-tog',
        () => { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); renderResults(); focusToggle(id); }, { 'aria-expanded': open ? 'true' : 'false', 'data-sec': id, 'data-fk': `sec:${id}` }));
    const body: Node[] = [];
    if (open) {
      if (!groups.length) body.push(h('p', { class: 'co-lib-none', text: searching ? NO_MATCHES : emptyText }));
      for (const g of groups) {
        body.push(h('h4', { class: 'co-lib-gh', text: g.title }), h('ul', { class: 'co-lib-list', 'aria-label': `${title}: ${g.title}` }, ...g.items.map((it) => itemCard(it, id, now))));
      }
    }
    return h('section', { class: 'co-lib-sec', 'aria-label': title }, head, ...body);
  }

  function focusToggle(id: SectionId): void {
    resultsEl?.querySelector<HTMLElement>(`[data-sec="${id}"]`)?.focus({ preventScroll: true });
  }

  /** The counts line, the refresh button and the notes above the list. */
  function renderBar(): void {
    if (refreshBtn) {
      refreshBtn.textContent = loading && data ? 'Refreshing…' : 'Refresh';
      refreshBtn.setAttribute('aria-disabled', loading ? 'true' : 'false');
    }
    if (!notesEl) return;
    const notes: HTMLElement[] = [];
    if (error && data) {
      notes.push(h('div', { class: 'co-lib-err', role: 'alert' }, h('span', null, h('strong', { text: 'Couldn’t refresh the library. ' }), error), button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' })));
    }
    if (data?.truncated) notes.push(h('p', { class: 'co-lib-note', text: 'There are more than can be shown here. Only the first ones are listed.' }));
    setKids(notesEl, ...notes);
  }

  function renderResults(): void {
    const c = ctx;
    if (!resultsEl || !countsEl || !c) return;
    // A fresh list (or a refresh) rebuilds the cards: keep the keyboard focus on the same button, or on the list.
    const restore = keepFocus(resultsEl);
    fillResults(c, resultsEl, countsEl);
    restore();
  }

  function fillResults(c: PanelContext<HTMLElement>, resultsEl: HTMLElement, countsEl: HTMLElement): void {
    if (!data) {
      countsEl.textContent = '';
      if (error) setKids(resultsEl, h('div', { class: 'co-lib-err', role: 'alert' }, h('span', null, h('strong', { text: 'Couldn’t load the library. ' }), error), button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' })));
      else {
        setKids(resultsEl, h('div', { class: 'co-lib-load', role: 'status' }, h('span', { class: 'co-lib-spin', 'aria-hidden': 'true' }), h('span', { text: slow ? 'Loading the library… Still waiting…' : 'Loading the library…' }),
          slow ? button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' }) : null));
      }
      return;
    }
    const q = query.trim();
    const sg = groupSkills(data.skills, q);
    const cg = groupCommands(data.commands, q);
    const shownS = groupTotal(sg);
    const shownC = groupTotal(cg);
    countsEl.textContent = libraryCounts(shownS, data.skills.length, shownC, data.commands.length);
    if (q && shownS === 0 && shownC === 0) {
      setKids(resultsEl, h('div', { class: 'co-lib-empty' }, pixelIcon('library', 32), h('strong', { text: 'No matches' }), h('span', { text: NO_MATCHES }),
        button('Clear search', 'co-btn co-secondary co-small', clearSearch)));
      return;
    }
    if (!q && data.skills.length === 0 && data.commands.length === 0) {
      setKids(resultsEl, h('div', { class: 'co-lib-empty', role: 'status' }, pixelIcon('library', 32), h('strong', { text: 'The shelves are empty' }), h('span', { text: EMPTY_LIBRARY })));
      return;
    }
    const now = c.now();
    setKids(resultsEl,
      section('skills', 'Skills', data.skills.length, sg, EMPTY_SKILLS, q !== '', now),
      section('commands', 'Commands', data.commands.length, cg, EMPTY_COMMANDS, q !== '', now));
  }

  function renderAll(): void {
    renderBar();
    renderResults();
  }

  function clearSearch(): void {
    query = '';
    if (search) { search.value = ''; search.focus({ preventScroll: true }); }
    renderResults();
  }

  return {
    id: 'library',
    title: 'Training library',
    icon: 'library',
    mount(body, c) {
      injectCss();
      ctx = c;
      query = '';
      search = h('input', { type: 'search', class: 'co-lib-search', placeholder: 'Search skills and commands', 'aria-label': 'Search skills and commands', autocomplete: 'off', spellcheck: 'false', maxlength: '100' });
      search.addEventListener('input', () => { query = search?.value ?? ''; renderResults(); });
      search.addEventListener('keydown', (e) => {
        // Escape clears a search first; with nothing typed it goes on to close the drawer.
        if (e.key === 'Escape' && search && search.value !== '') { e.preventDefault(); e.stopPropagation(); clearSearch(); }
      });
      countsEl = h('p', { class: 'co-lib-counts', 'aria-live': 'polite' });
      refreshBtn = button('Refresh', 'co-btn co-secondary co-small', () => { if (!loading) request(true); }, { title: 'Read the skills and commands again', 'aria-disabled': 'false' });
      notesEl = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
      resultsEl = h('div', { class: 'co-lib-results co-focus-park', tabindex: '-1' });
      root = h('div', { class: 'co-lib' }, h('div', { class: 'co-lib-top' }, search, h('div', { class: 'co-lib-bar' }, countsEl, refreshBtn)), notesEl, resultsEl);
      body.appendChild(root);
      // Opened again: show the last list at once and read it again in the background.
      request();
    },
    refresh() {
      // Called whenever an agent or the usage changes: ask again only when the list has gone stale. After a failure wait for the
      // user's Try again or Refresh: a retry on every agent update would hit the host's probe again and again.
      if (!ctx || loading || error !== null) return;
      if (data && Date.now() - data.at < STALE_MS) return;
      request();
    },
    handle(msg: HostToWebview) {
      if (msg.type === 'catalog' && msg.reqId === reqId && msg.section === 'skills') {
        if (slowTimer !== null) clearTimeout(slowTimer);
        reqId = '';
        loading = false;
        slow = false;
        error = null;
        data = { skills: msg.skills, commands: msg.commands, truncated: msg.truncated, at: Date.now() };
        renderAll();
      } else if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        reqId = '';
        loading = false;
        slow = false;
        error = msg.message;
        renderAll();
      }
    },
    unmount() {
      if (slowTimer !== null) clearTimeout(slowTimer);
      slowTimer = null;
      // A reply that arrives after this is for nobody; the next mount asks again.
      reqId = '';
      loading = false;
      ctx = null;
      root = null;
      search = null;
      countsEl = null;
      refreshBtn = null;
      notesEl = null;
      resultsEl = null;
    },
  };
}
