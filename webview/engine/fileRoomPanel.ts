/**
 * The File room panel (the filing cabinets): a read-only browser over the folders the host allows. It has three views.
 * The root picker (grouped by kind, `rootGroups`), the folder view (breadcrumbs, an up button and one button per entry,
 * folders first) and the file view, which is pushed onto the drawer stack so the header's back button returns to the folder.
 * Folder navigation stays inside this panel (`listDir`); only a file pushes. Display decisions live in fileRoomLogic.ts.
 *
 * Every request carries a fresh `reqId` and a reply with any other id is ignored. The file view's text is shown with text
 * nodes only (a `pre`, or `renderMarkdown` for markdown). The rows are buttons in one roving-tabindex list: Tab enters it
 * once, arrows move, Right opens a folder and Left goes up.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { DirEntry, FileRoot, HostToWebview } from '../../src/shared/protocol.ts';
import { button, h, pixelIcon, renderMarkdown, sprite } from './dom.ts';
import {
  NO_ROOTS, EMPTY_FOLDER, breadcrumbs, childBelow, childPath, entryChips, entryDetail, entryLabel, formatDate, formatSize, groupEntries, handPrefill,
  isOpenable, parentPath, previewDecision, rootGroups, truncatedNote,
} from './fileRoomLogic.ts';

export interface FileRoomDeps {
  /** A fresh request id (tests and the playground can make them predictable). The default is `files-<n>-<time>`. */
  newReqId?(): string;
}

const CSS = `
.co-fr, .co-frv { --fr-fg: var(--vscode-foreground, #cccccc); --fr-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --fr-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --fr-warn: var(--vscode-editorWarning-foreground, #cca700); --fr-warn-text: color-mix(in srgb, var(--fr-warn) 70%, var(--fr-fg));
  --fr-err: var(--vscode-errorForeground, #f48771); --fr-focus: var(--vscode-focusBorder, #007fd4);
  --fr-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); --fr-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16));
  --fr-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f));
  --fr-mono: var(--vscode-editor-font-family, ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace);
  --fr-code: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14)); }
.co-fr { display: flex; flex-direction: column; gap: 10px; }
.co-fr-intro { margin: 0; font-size: 12px; color: var(--fr-dim); }
.co-fr-sec { display: flex; flex-direction: column; gap: 4px; }
.co-fr-h { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fr-dim); }
.co-fr-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.co-fr-row { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 38px; padding: 4px 8px; text-align: left; cursor: pointer; font: inherit; color: var(--fr-fg);
  background: transparent; border: 1px solid transparent; border-radius: 4px; }
.co-fr-row:hover { background: var(--fr-hover); }
.co-fr-row:focus-visible { outline: 2px solid var(--fr-focus); outline-offset: -1px; }
.co-fr-row[aria-disabled="true"] { cursor: default; color: var(--fr-dim); }
.co-fr-row[aria-disabled="true"]:hover { background: transparent; }
.co-fr-row.card { min-height: 48px; padding: 6px 10px; background: var(--fr-card); border-color: var(--fr-border); border-radius: 5px; }
.co-fr-row.card:hover { background: var(--fr-hover); }
.co-fr-ico { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; }
.co-fr-ico canvas { image-rendering: pixelated; }
.co-fr-row[aria-disabled="true"] .co-fr-ico { opacity: 0.5; }
.co-fr-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.co-fr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-fr-row.card .co-fr-name { font-weight: 600; }
.co-fr-meta { font-size: 11.5px; line-height: 16px; color: var(--fr-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-fr-chip { flex: none; padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
  border: 1px solid var(--fr-border); color: var(--fr-dim); white-space: nowrap; }
.co-fr-chip.warn { color: var(--fr-warn-text); border-color: color-mix(in srgb, var(--fr-warn) 60%, transparent); background: color-mix(in srgb, var(--fr-warn) 13%, transparent); }
.co-fr-go { flex: none; color: var(--fr-dim); font-size: 16px; line-height: 1; }
body.vscode-high-contrast .co-fr-row:hover, body.vscode-high-contrast-light .co-fr-row:hover { outline: 1px dashed var(--vscode-contrastActiveBorder, #f38518); outline-offset: -1px; }

.co-fr-nav { position: sticky; top: -10px; z-index: 1; margin: -10px -12px 0; padding: 8px 12px; display: flex; align-items: flex-start; gap: 8px;
  background: var(--fr-bg); border-bottom: 1px solid var(--fr-border); }
.co-fr-up { flex: none; }
.co-fr-crumbs { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; margin: 0; padding: 0; list-style: none; min-height: 22px; }
.co-fr-crumbs li { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
.co-fr-crumbs li + li::before { content: '\\203A'; flex: none; padding: 0 4px; color: var(--fr-dim); }
.co-fr-crumb { max-width: 100%; padding: 0 4px; border: 0; border-radius: 3px; background: transparent; font: inherit; line-height: 22px; color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-fr-crumb:hover { background: var(--fr-hover); text-decoration: underline; text-underline-offset: 2px; }
.co-fr-crumb:focus-visible { outline: 2px solid var(--fr-focus); outline-offset: 0; }
.co-fr-crumb.cur { cursor: default; color: var(--fr-fg); font-weight: 600; overflow-wrap: anywhere; white-space: normal; }
.co-fr-where { margin: 0; font-size: 11.5px; color: var(--fr-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-fr-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.co-fr-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.co-fr-note { margin: 0; padding: 6px 10px; font-size: 12px; color: var(--fr-dim); border: 1px dashed var(--fr-border); border-radius: 4px; }
.co-fr-empty { margin: 22px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--fr-dim); }
.co-fr-empty strong { color: var(--fr-fg); font-size: 13.5px; }
.co-fr-load { display: flex; align-items: center; gap: 8px; color: var(--fr-dim); margin: 8px 0; flex-wrap: wrap; }
.co-fr-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--fr-fg) 25%, transparent); border-top-color: var(--fr-fg); animation: co-fr-spin 0.8s linear infinite; flex: none; }
@keyframes co-fr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-fr-spin { animation: none; border-top-color: color-mix(in srgb, var(--fr-fg) 25%, transparent); } }
.co-fr-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--fr-err) 55%, transparent); background: color-mix(in srgb, var(--fr-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-fr-err strong { color: var(--fr-fg); }

.co-frv { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.co-frv-head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.co-frv-ico { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 4px; background: color-mix(in srgb, var(--fr-fg) 9%, transparent); }
.co-frv-ico canvas { image-rendering: pixelated; }
.co-frv-who { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.co-frv-name { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.co-frv-where { font-size: 12px; color: var(--fr-dim); overflow-wrap: anywhere; }
.co-frv-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--fr-dim); }
.co-frv-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.co-frv-body { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--fr-border); min-width: 0; }
.co-frv-mode { display: inline-flex; align-self: flex-start; border: 1px solid var(--fr-border); border-radius: 4px; overflow: hidden; }
.co-frv-mode button { padding: 2px 10px; min-height: 22px; border: 0; background: transparent; color: var(--fr-fg); font: inherit; font-size: 12px; cursor: pointer; }
.co-frv-mode button + button { border-left: 1px solid var(--fr-border); }
.co-frv-mode button:hover { background: var(--fr-hover); }
.co-frv-mode button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.3)); color: var(--vscode-button-secondaryForeground, var(--fr-fg)); font-weight: 600; }
.co-frv-mode button:focus-visible { outline: 2px solid var(--fr-focus); outline-offset: -2px; }
.co-frv-text { margin: 0; padding: 8px 10px; font-family: var(--fr-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4;
  background: var(--fr-code); border: 1px solid var(--fr-border); border-radius: 4px; min-width: 0; }
.co-frv-md { padding: 8px 12px; border: 1px solid var(--fr-border); border-radius: 4px; overflow-wrap: anywhere; min-width: 0; }
.co-frv-text:focus-visible, .co-frv-md:focus-visible { outline: 2px solid var(--fr-focus); outline-offset: 1px; }
.co-frv-state { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--fr-border); border-radius: 4px; background: var(--fr-card); overflow-wrap: anywhere; }
.co-frv-state p { margin: 0; }
.co-frv-state.secret { border-color: color-mix(in srgb, var(--fr-warn) 55%, transparent); background: color-mix(in srgb, var(--fr-warn) 9%, transparent); }
.co-frv-note { margin: 0; font-size: 12px; color: var(--fr-dim); overflow-wrap: anywhere; }
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

let reqCounter = 0;
function defaultReqId(): string {
  reqCounter += 1;
  return `files-${reqCounter}-${Date.now().toString(36)}`;
}

/** `replaceChildren` that skips nulls. */
function setKids(el: HTMLElement, ...xs: (Node | null | undefined)[]): void {
  el.replaceChildren(...xs.filter((x): x is Node => !!x));
}

function loadingLine(text: string, slow: boolean, retry: () => void): HTMLElement {
  return h('div', { class: 'co-fr-load', role: 'status' }, h('span', { class: 'co-fr-spin', 'aria-hidden': 'true' }), h('span', { text: slow ? `${text} Still waiting…` : text }),
    slow ? button('Try again', 'co-btn co-secondary co-small', retry) : null);
}

function errorBox(title: string, message: string, retry: () => void): HTMLElement {
  return h('div', { class: 'co-fr-err', role: 'alert' }, h('span', null, h('strong', { text: `${title} ` }), message), button('Try again', 'co-btn co-secondary co-small', retry));
}

interface RowOpts {
  /** What a focus plan finds the row by: the entry name, or the root id. */
  key: string;
  name: string;
  /** The accessible name (the visible text is split over several spans). */
  label: string;
  kind: 'root' | DirEntry['kind'];
  icon: Node;
  meta: string;
  chips: string[];
  chevron: boolean;
  disabled: boolean;
  card: boolean;
  onOpen(): void;
}

function rowButton(o: RowOpts): HTMLButtonElement {
  const b = h('button', {
    type: 'button', class: `co-fr-row${o.card ? ' card' : ''}`, 'data-key': o.key, 'data-kind': o.kind, 'aria-label': o.label, title: o.name, tabindex: '-1',
    'aria-disabled': o.disabled ? 'true' : null,
  },
  h('span', { class: 'co-fr-ico', 'aria-hidden': 'true' }, o.icon),
  h('span', { class: 'co-fr-text' }, h('span', { class: 'co-fr-name', text: o.name }), o.meta ? h('span', { class: 'co-fr-meta', text: o.meta }) : null),
  ...o.chips.map((c) => h('span', { class: `co-fr-chip${c === 'Secret' ? ' warn' : ''}`, text: c })),
  o.chevron ? h('span', { class: 'co-fr-go', 'aria-hidden': 'true', text: '›' }) : null);
  b.addEventListener('click', () => { if (!o.disabled) o.onOpen(); });
  return b;
}

type RootsState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type ListState = { kind: 'loading' } | { kind: 'ready'; entries: DirEntry[]; truncated: boolean } | { kind: 'error'; message: string };
interface FocusPlan {
  /** The row (`data-key`) to focus; the first row when it is gone or not given. */
  key?: string;
  /** Keep the scroll position (coming back from a file). */
  keepScroll?: boolean;
}

/** Builds the File room panel. Register it under id `files`. */
export function createFileRoomPanel(deps: FileRoomDeps = {}): PanelView<HTMLElement> {
  const newId = deps.newReqId ?? defaultReqId;
  let ctx: PanelContext<HTMLElement> | null = null;
  let body: HTMLElement | null = null;
  let root: HTMLElement | null = null;

  // Roots, kept across mounts so reopening shows them at once while a fresh list is asked for.
  let roots: FileRoot[] | null = null;
  let rootsState: RootsState = { kind: 'loading' };
  let rootsReq = '';
  // Where the folder view is: null = the root picker.
  let at: { rootId: string; relPath: string } | null = null;
  let listing: ListState = { kind: 'loading' };
  let listReq = '';
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let focusPlan: FocusPlan | null = null;
  // Coming back from a file: keep the place, the scroll position and the row that was opened.
  let returning = false;
  let scrollTop = 0;
  let lastOpened: string | null = null;
  // The row that last had focus, so a redraw (a refresh, a pushed root list) keeps focus where it was.
  let lastFocusKey: string | undefined;

  const rootOf = (id: string): FileRoot | undefined => roots?.find((r) => r.rootId === id);

  function armSlow(): void {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slow = false;
    slowTimer = setTimeout(() => { slow = true; render(); }, SLOW_MS);
  }
  function disarmSlow(): void {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
    slow = false;
  }

  // -- Requests -------------------------------------------------------------

  function requestRoots(): void {
    if (!ctx) return;
    rootsReq = newId();
    if (!roots) rootsState = { kind: 'loading' };
    if (!roots) armSlow();
    ctx.post({ type: 'getFileRoots', reqId: rootsReq });
    render();
  }

  function requestList(): void {
    if (!ctx || !at) return;
    listReq = newId();
    listing = { kind: 'loading' };
    armSlow();
    ctx.post({ type: 'listDir', reqId: listReq, rootId: at.rootId, relPath: at.relPath });
    render();
  }

  // -- Navigation -----------------------------------------------------------

  function openRoot(r: FileRoot): void {
    at = { rootId: r.rootId, relPath: '' };
    focusPlan = {};
    if (body) body.scrollTop = 0;
    requestList();
  }

  function openFolder(relPath: string, focusKey?: string): void {
    if (!at) return;
    at = { rootId: at.rootId, relPath };
    focusPlan = focusKey !== undefined ? { key: focusKey } : {};
    if (body) body.scrollTop = 0;
    requestList();
  }

  /** The picker, with the row of the root you left focused. */
  function openPicker(): void {
    const left = at?.rootId;
    at = null;
    listReq = '';
    disarmSlow();
    focusPlan = left !== undefined ? { key: left } : {};
    if (body) body.scrollTop = 0;
    render();
    if (rootsState.kind === 'error') requestRoots();
  }

  function goUp(): void {
    if (!at) return;
    const up = parentPath(at.relPath);
    if (up === null) { openPicker(); return; }
    openFolder(up, childBelow(up, at.relPath));
  }

  function openFileView(e: DirEntry): void {
    const c = ctx;
    const r = at ? rootOf(at.rootId) : undefined;
    if (!c || !at || !r) return;
    lastOpened = e.name;
    returning = true;
    c.push(createFileView({ root: r, relPath: childPath(at.relPath, e.name), entry: e }, deps, () => {
      // Back (or close) unmounts the file view. Back mounts this panel again within the same call, so the flag is read by then.
      queueMicrotask(() => { returning = false; });
    }));
  }

  // -- Rendering ------------------------------------------------------------

  const rowEls = (): HTMLElement[] => (root ? Array.from(root.querySelectorAll<HTMLElement>('.co-fr-row')) : []);

  function setRoving(target: HTMLElement | undefined): void {
    for (const r of rowEls()) r.tabIndex = r === target ? 0 : -1;
  }

  /** Puts focus where the last navigation said, once there is something to focus; until then on the (hidden) main area. */
  function applyFocus(settled: boolean): void {
    const main = root?.querySelector<HTMLElement>('.co-fr-main');
    const rows = rowEls();
    if (!focusPlan) { if (!rows.some((r) => r.tabIndex === 0)) setRoving(rows[0]); return; }
    if (!settled) { main?.focus({ preventScroll: true }); return; }
    const plan = focusPlan;
    focusPlan = null;
    const target = (plan.key !== undefined ? rows.find((r) => r.dataset['key'] === plan.key) : undefined) ?? rows[0];
    setRoving(target);
    // No rows (an error, an empty folder): its Try again or Check again button when there is one, else the area itself.
    (target ?? main?.querySelector<HTMLElement>('button') ?? main)?.focus({ preventScroll: plan.keepScroll === true });
  }

  function render(): void {
    const c = ctx;
    if (!c || !root) return;
    const focusInside = root.contains(document.activeElement);
    const settled = at === null ? rootsState.kind !== 'loading' || roots !== null : listing.kind !== 'loading';
    if (at === null) renderPicker();
    else renderFolder(c);
    // Whatever had focus was just replaced: keep focus in the panel.
    if (focusInside && !focusPlan) focusPlan = { keepScroll: true, ...(lastFocusKey !== undefined ? { key: lastFocusKey } : {}) };
    applyFocus(settled);
  }

  function renderPicker(): void {
    if (!root) return;
    const intro = h('p', { class: 'co-fr-intro', text: 'Look through your project folders. Nothing here can be changed.' });
    if (!roots) {
      setKids(root, intro, h('div', { class: 'co-fr-main co-focus-park', tabindex: '-1' },
        rootsState.kind === 'error'
          ? errorBox('Couldn’t load the folders.', rootsState.message, requestRoots)
          : loadingLine('Loading the folders…', slow, requestRoots)));
      return;
    }
    const groups = rootGroups(roots);
    if (!groups.length) {
      setKids(root, intro, h('div', { class: 'co-fr-main co-focus-park', tabindex: '-1' },
        h('div', { class: 'co-fr-empty' }, pixelIcon('files', 32), h('strong', { text: 'The file room is empty' }), h('span', { text: NO_ROOTS }),
          button('Check again', 'co-btn co-secondary co-small', requestRoots))));
      return;
    }
    const sections = groups.map((g) => h('section', { class: 'co-fr-sec', 'aria-label': g.title },
      h('h3', { class: 'co-fr-h', text: g.title }),
      h('ul', { class: 'co-fr-list' }, ...g.roots.map((r) => h('li', null, rowButton({
        key: r.rootId, name: r.label, label: `${r.label}, ${r.display}`, kind: 'root', icon: pixelIcon('folder', 20), meta: r.display, chips: [], chevron: true, disabled: false, card: true,
        onOpen: () => openRoot(r),
      }))))));
    const err = rootsState.kind === 'error' ? errorBox('Couldn’t refresh the folders.', rootsState.message, requestRoots) : null;
    setKids(root, intro, err, h('div', { class: 'co-fr-main co-focus-park', tabindex: '-1' }, ...sections));
  }

  function renderFolder(c: PanelContext<HTMLElement>): void {
    if (!root || !at) return;
    const here = at;
    const r = rootOf(here.rootId);
    if (!r) { at = null; renderPicker(); return; }
    const crumbs = breadcrumbs(r.label, here.relPath);
    const atRoot = here.relPath === '';
    const parent = parentPath(here.relPath);
    const upLabel = atRoot ? 'Back to all folders' : `Up to ${parent === '' ? r.label : (parent ?? '').split('/').pop() ?? r.label}`;
    const up = button([h('span', { 'aria-hidden': 'true', text: atRoot ? '←' : '↑' }), atRoot ? 'All folders' : 'Up'], 'co-btn co-ghost co-small co-fr-up', goUp, { 'aria-label': upLabel, title: upLabel });
    const crumbList = h('ol', { class: 'co-fr-crumbs' }, ...crumbs.map((cr, i) => {
      const last = i === crumbs.length - 1;
      return h('li', null, last
        ? h('span', { class: 'co-fr-crumb cur', 'aria-current': 'page', text: cr.label })
        : button(cr.label, 'co-fr-crumb', () => openFolder(cr.relPath, childBelow(cr.relPath, here.relPath)), { 'data-crumb': cr.relPath, title: cr.label }));
    }));
    const nav = h('nav', { class: 'co-fr-nav', 'aria-label': 'Folder path' }, up, crumbList);
    const where = h('p', { class: 'co-fr-where', title: r.display, text: r.display });
    const actions = h('div', { class: 'co-fr-actions' },
      button('Hand this folder to a worker', 'co-btn co-secondary co-small', () => c.openMemo({ prefill: handPrefill(r, here.relPath, true) }),
        { title: 'Start a task that names this folder' }),
      button('Refresh', 'co-btn co-secondary co-small', requestList, { title: 'Read this folder again' }));
    setKids(root, nav, where, actions, h('div', { class: 'co-fr-main co-focus-park', tabindex: '-1' }, ...folderBody(c)));
  }

  function folderBody(c: PanelContext<HTMLElement>): Node[] {
    if (listing.kind === 'loading') return [loadingLine('Opening the folder…', slow, requestList)];
    if (listing.kind === 'error') return [errorBox('Couldn’t open this folder.', listing.message, requestList)];
    if (listing.entries.length === 0) {
      return [h('div', { class: 'co-fr-empty' }, pixelIcon('folder', 32), h('strong', { text: 'Nothing here' }), h('span', { text: EMPTY_FOLDER }))];
    }
    const now = c.now();
    const g = groupEntries(listing.entries);
    const items = [...g.folders, ...g.files, ...g.others].map((e) => {
      const meta = entryDetail(e, now);
      const chips = entryChips(e);
      return h('li', null, rowButton({
        key: e.name, name: e.name, label: entryLabel(e, meta, chips), kind: e.kind,
        icon: pixelIcon(e.kind === 'dir' ? 'folder' : 'page', 20), meta, chips, chevron: e.kind === 'dir', disabled: !isOpenable(e), card: false,
        onOpen: () => { if (e.kind === 'dir') openFolder(childPath(at?.relPath ?? '', e.name)); else openFileView(e); },
      }));
    });
    const note = truncatedNote(listing.entries.length, listing.truncated);
    const out: Node[] = [h('ul', { class: 'co-fr-list' }, ...items)];
    if (note) out.push(h('p', { class: 'co-fr-note', role: 'status', text: note }));
    return out;
  }

  // -- Keyboard -------------------------------------------------------------

  function onKeydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (!t.classList.contains('co-fr-row') || e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = rowEls();
    const i = rows.indexOf(t);
    let next: HTMLElement | undefined;
    switch (e.key) {
      case 'ArrowDown': next = rows[Math.min(rows.length - 1, i + 1)]; break;
      case 'ArrowUp': next = rows[Math.max(0, i - 1)]; break;
      case 'PageDown': next = rows[Math.min(rows.length - 1, i + 10)]; break;
      case 'PageUp': next = rows[Math.max(0, i - 10)]; break;
      case 'Home': next = rows[0]; break;
      case 'End': next = rows[rows.length - 1]; break;
      case 'ArrowRight': if (t.dataset['kind'] === 'dir' || t.dataset['kind'] === 'root') { e.preventDefault(); t.click(); } return;
      case 'ArrowLeft': if (at) { e.preventDefault(); goUp(); } return;
      default: return;
    }
    e.preventDefault();
    if (next) { setRoving(next); next.focus(); }
  }

  function onFocusin(e: FocusEvent): void {
    const t = e.target as HTMLElement;
    if (t.classList.contains('co-fr-row')) { setRoving(t); lastFocusKey = t.dataset['key']; }
  }

  // -- The panel ------------------------------------------------------------

  return {
    id: 'files',
    title: 'File room',
    icon: 'files',
    mount(b, c) {
      injectCss();
      ctx = c;
      body = b;
      root = h('div', { class: 'co-fr' });
      root.addEventListener('keydown', onKeydown);
      root.addEventListener('focusin', onFocusin);
      b.appendChild(root);
      const restoring = returning && (at === null || rootOf(at.rootId) !== undefined);
      if (!restoring) {
        at = null;
        listReq = '';
        lastFocusKey = undefined;
      }
      render();
      if (restoring && at) {
        // The drawer focuses itself right after mount: put focus back on the row that was opened once it has done that.
        const key = lastOpened ?? undefined;
        b.scrollTop = scrollTop;
        if (listing.kind !== 'ready') requestList();
        queueMicrotask(() => {
          if (!root) return;
          focusPlan = { keepScroll: true, ...(key !== undefined ? { key } : {}) };
          applyFocus(listing.kind !== 'loading');
        });
      } else {
        requestRoots();
      }
    },
    handle(msg: HostToWebview) {
      if (msg.type === 'fileRoots') {
        // With a reqId it answers ours; without one it is a push from the host (an agent started, a project was browsed).
        if (msg.reqId !== undefined && msg.reqId !== rootsReq) return;
        roots = msg.roots;
        rootsState = { kind: 'ready' };
        if (msg.reqId !== undefined) rootsReq = '';
        if (at === null) disarmSlow();
        if (at && !rootOf(at.rootId)) { at = null; listReq = ''; disarmSlow(); }
        render();
      } else if (msg.type === 'dirListing') {
        if (msg.reqId !== listReq || !at || msg.rootId !== at.rootId || msg.relPath !== at.relPath) return;
        listReq = '';
        disarmSlow();
        listing = { kind: 'ready', entries: msg.entries, truncated: msg.truncated };
        render();
      } else if (msg.type === 'error' && msg.reqId !== undefined) {
        if (msg.reqId === listReq && at) {
          listReq = '';
          disarmSlow();
          listing = { kind: 'error', message: msg.message };
          render();
        } else if (msg.reqId === rootsReq) {
          rootsReq = '';
          disarmSlow();
          rootsState = { kind: 'error', message: msg.message };
          render();
        }
      }
    },
    unmount() {
      if (body) scrollTop = body.scrollTop;
      disarmSlow();
      root?.removeEventListener('keydown', onKeydown);
      root?.removeEventListener('focusin', onFocusin);
      ctx = null;
      body = null;
      root = null;
      focusPlan = null;
    },
  };
}

// ---------------------------------------------------------------------------
// File view

export interface FileViewArgs {
  root: FileRoot;
  /** The file's path inside the root. */
  relPath: string;
  /** Its listing entry: the name, size and date shown while the text loads, and the Link and Secret markers. */
  entry: DirEntry;
}

type FileReply = Extract<HostToWebview, { type: 'fileText' }>;
type FileState = { kind: 'loading' } | { kind: 'ready'; reply: FileReply } | { kind: 'error'; message: string };

/** The sub-view for one file: asks for the text (`readFile`) and offers Open in editor, Open diff and Hand to a worker. */
function createFileView(args: FileViewArgs, deps: FileRoomDeps, onGone: () => void): PanelView<HTMLElement> {
  const newId = deps.newReqId ?? defaultReqId;
  let ctx: PanelContext<HTMLElement> | null = null;
  let actionsEl: HTMLElement | null = null;
  let contentEl: HTMLElement | null = null;
  let metaEl: HTMLElement | null = null;
  let state: FileState = { kind: 'loading' };
  let reqId = '';
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let rendered = true;

  const { root, relPath, entry } = args;
  const where = [root.label, ...relPath.split('/').slice(0, -1)].join(' / ');

  function request(): void {
    const c = ctx;
    if (!c) return;
    reqId = newId();
    state = { kind: 'loading' };
    slow = false;
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { slow = true; renderContent(); }, SLOW_MS);
    c.post({ type: 'readFile', reqId, rootId: root.rootId, relPath });
    renderActions();
    renderContent();
  }

  function renderMeta(): void {
    if (!metaEl || !ctx) return;
    const size = state.kind === 'ready' ? formatSize(state.reply.size) : formatSize(entry.size);
    const date = formatDate(entry.mtime, ctx.now());
    const text = [size, date].filter(Boolean).join(' · ');
    setKids(metaEl, text ? h('span', { text }) : null, ...entryChips(entry).map((c) => h('span', { class: `co-fr-chip${c === 'Secret' ? ' warn' : ''}`, text: c })));
  }

  function renderActions(): void {
    const c = ctx;
    if (!actionsEl || !c) return;
    const openOnly = state.kind === 'ready' && previewDecision(state.reply).openOnly;
    setKids(actionsEl,
      button('Open in editor', 'co-btn co-primary co-small', () => c.post({ type: 'openFile', rootId: root.rootId, relPath }), { title: 'Open this file in your editor' }),
      openOnly ? null : button('Open diff', 'co-btn co-secondary co-small', () => c.post({ type: 'openDiff', rootId: root.rootId, relPath }), { title: 'Compare this file with the last commit' }),
      openOnly ? null : button('Hand to a worker', 'co-btn co-secondary co-small', () => c.openMemo({ prefill: handPrefill(root, relPath, false) }), { title: 'Start a task that names this file' }));
  }

  function textView(reply: FileReply, mode: 'rendered' | 'plain'): HTMLElement {
    const d = previewDecision(reply);
    const nodes: (Node | null)[] = [];
    if (d.markdown && d.text !== undefined && d.text !== '') {
      const toggle = h('div', { class: 'co-frv-mode', role: 'group', 'aria-label': 'How to show the file' },
        button('Formatted', '', () => { rendered = true; renderContent(); }, { 'aria-pressed': mode === 'rendered' ? 'true' : 'false' }),
        button('Plain text', '', () => { rendered = false; renderContent(); }, { 'aria-pressed': mode === 'plain' ? 'true' : 'false' }));
      nodes.push(toggle);
    }
    if (d.text !== undefined && d.text !== '') {
      if (d.markdown && mode === 'rendered') {
        const md = h('div', { class: 'co-md co-frv-md', tabindex: '0', role: 'region', 'aria-label': 'File text' });
        md.appendChild(renderMarkdown(d.text));
        nodes.push(md);
      } else {
        nodes.push(h('pre', { class: 'co-frv-text', tabindex: '0', role: 'region', 'aria-label': 'File text', text: d.text }));
      }
    }
    if (d.message) nodes.push(h('p', { class: 'co-frv-note', role: d.kind === 'truncated' ? 'status' : null, text: d.message }));
    return h('div', { class: 'co-frv-body' }, ...nodes);
  }

  function renderContent(): void {
    if (!contentEl) return;
    if (state.kind === 'loading') { setKids(contentEl, loadingLine('Reading the file…', slow, request)); return; }
    if (state.kind === 'error') { setKids(contentEl, errorBox('Couldn’t read this file.', state.message, request)); return; }
    const d = previewDecision(state.reply);
    if (d.kind === 'secret' || d.kind === 'tooLarge' || d.kind === 'binary') {
      const icon = d.kind === 'secret' ? sprite('lock', 3) : pixelIcon('page', 24);
      setKids(contentEl, h('div', { class: `co-frv-state ${d.kind}`, role: 'status' }, icon, h('p', { text: d.message })));
      return;
    }
    setKids(contentEl, textView(state.reply, rendered ? 'rendered' : 'plain'));
  }

  return {
    id: 'file',
    title: entry.name,
    icon: 'page',
    mount(b, c) {
      injectCss();
      ctx = c;
      rendered = true;
      state = { kind: 'loading' };
      actionsEl = h('div', { class: 'co-frv-actions' });
      contentEl = h('div');
      metaEl = h('div', { class: 'co-frv-meta' });
      b.appendChild(h('div', { class: 'co-frv' },
        h('div', { class: 'co-frv-head' },
          h('span', { class: 'co-frv-ico', 'aria-hidden': 'true' }, entry.secret ? sprite('lock', 2) : pixelIcon('page', 24)),
          h('div', { class: 'co-frv-who' }, h('h3', { class: 'co-frv-name', text: entry.name }), h('span', { class: 'co-frv-where', title: relPath, text: where }), metaEl)),
        actionsEl, contentEl));
      renderMeta();
      request();
    },
    handle(msg: HostToWebview) {
      if (msg.type === 'fileText' && msg.reqId === reqId && msg.rootId === root.rootId && msg.relPath === relPath) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        reqId = '';
        state = { kind: 'ready', reply: msg };
        renderMeta();
        renderActions();
        renderContent();
      } else if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        reqId = '';
        state = { kind: 'error', message: msg.message };
        renderActions();
        renderContent();
      }
    },
    unmount() {
      if (slowTimer !== null) clearTimeout(slowTimer);
      slowTimer = null;
      reqId = '';
      ctx = null;
      actionsEl = null;
      contentEl = null;
      metaEl = null;
      onGone();
    },
  };
}
