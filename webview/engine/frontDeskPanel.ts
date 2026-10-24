/**
 * The Front desk panel shell (task 3.10): a `PanelView` (id `frontdesk`) with a tablist (Theme, Settings, Staff, Colours), a banner
 * for "changed on disk" and conflicts, a sticky "Unsaved changes" footer and the "Keep editing / Discard" prompt that
 * `beforeClose` shows.
 *
 * The shell owns the draft and the editor state (`FrontDeskController`, DOM-free and tested); each tab is a small view built
 * by a factory from the registry below. Task 3.11 fills the Staff and Colours slots with `registerFrontDeskTab`.
 *
 * Wiring (task 4.7): build the drawer context as a `FrontDeskCtx` (it is spread through the drawer to `mount`),
 * keep `hostTheme()` up to date BEFORE calling `onHost` listeners, pass `loadState`/`saveState` from the webview's saved
 * state, and call `view.openTab(tab)` for `openFrontDesk`. The panel listens to host messages through `ctx.onHost`, so
 * do not also forward them to `handle` (it has none).
 */
import type { FrontDeskCtx, PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { FrontDeskTab, HostToWebview } from '../../src/shared/protocol.ts';
import { FRONT_DESK_TABS } from '../../src/shared/protocol.ts';
import { FrontDeskController } from './frontDeskController.ts';
import type { ChangeReason, TabApi } from './frontDeskController.ts';
import { bannerView, closePromptView, footerView, isFrontDeskTab, nextTab, panelDomId, tabDomId, tabLabel } from './frontDeskView.ts';
import { createAboutTab } from './frontDeskAbout.ts';
import { createSettingsTab } from './frontDeskSettings.ts';
import { createThemeTab } from './frontDeskTheme.ts';
import { button, h } from './dom.ts';
import { injectUiStyles } from './uiStyles.ts';

export type { ChangeReason } from './frontDeskController.ts';

// ---------------------------------------------------------------------------------------------------------------------
// The tab registry: what task 3.11 uses

/** What a tab gets: the controller's `TabApi` (draft, `edit`, `update`, `hostState`, ...) plus the panel context. */
export interface FrontDeskTabApi extends TabApi {
  /** The Front desk context (preview, hostTheme, hostSettings, post, push, ...). */
  readonly ctx: FrontDeskCtx<HTMLElement>;
  /** Switch to another tab. */
  openTab(tab: FrontDeskTab): void;
}

/** One tab's content. Built once per mount, kept in the DOM (hidden) while another tab shows. */
export interface FrontDeskTabView {
  /** The content root; the shell puts it inside the tab's `role="tabpanel"` element. */
  el: HTMLElement;
  /**
   * Called when the draft or the host's state changed, and when the tab becomes visible (`'show'`). `'draft'` = an edit
   * (yours included), `'state'` = a new `FrontDeskState`, `'adopt'` = the draft was replaced (Load it, Discard, a source
   * change), `'editor'` = only the footer/banner changed.
   */
  refresh?(reason: ChangeReason | 'show'): void;
  /** Remove timers and listeners. The shell clears the DOM. */
  unmount?(): void;
}

export type FrontDeskTabFactory = (api: FrontDeskTabApi) => FrontDeskTabView;

function placeholderTab(tab: FrontDeskTab): FrontDeskTabFactory {
  return () => ({
    el: h('div', { class: 'co-fd-card' },
      h('h3', { class: 'co-fd-h', text: tabLabel(tab) }),
      h('p', { class: 'co-fd-hint', text: `The ${tabLabel(tab)} editor is not available in this build yet.` })),
  });
}

const factories = new Map<FrontDeskTab, FrontDeskTabFactory>([
  ['theme', createThemeTab],
  ['settings', createSettingsTab],
  ['staff', placeholderTab('staff')],
  ['colours', placeholderTab('colours')],
  ['about', createAboutTab],
]);

/** Fills (or replaces) a tab's factory. Call it before the panel is mounted (module load time is fine). */
export function registerFrontDeskTab(tab: FrontDeskTab, factory: FrontDeskTabFactory): void {
  factories.set(tab, factory);
}

// ---------------------------------------------------------------------------------------------------------------------
// The panel

export interface FrontDeskDeps {
  /** The saved draft text from the webview's saved state (`savedState`), or anything else when there is none. */
  loadState(): unknown;
  /** Keep (text) or drop (null) the draft in the webview's saved state. */
  saveState(text: string | null): void;
  /** The tab to show first (default 'theme'). */
  initialTab?: FrontDeskTab | undefined;
  /** Called whenever the shown tab changes, so the webview can keep it across a re-render. */
  saveTab?(tab: FrontDeskTab): void;
  /** Preview debounce in ms (default 120). */
  previewDelayMs?: number;
  /** Request ids (default `fd1`, `fd2`, ...). */
  nextReqId?(): string;
}

export interface FrontDeskPanelView extends PanelView<HTMLElement> {
  /** Show a tab (for `openFrontDesk{tab}`). Works before the panel is mounted too: the next mount starts there. */
  openTab(tab: FrontDeskTab): void;
}

const STYLE = `
.co-drawer-body.co-fd-body { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.co-fd { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.co-fd *, .co-fd *::before, .co-fd *::after { box-sizing: border-box; }
.co-fd-tabs { flex: none; display: flex; gap: 0; padding: 0 6px; overflow-x: auto; scrollbar-width: none;
  border-bottom: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
.co-fd-tab { flex: 1 1 auto; min-width: 0; padding: 9px 8px 7px; margin: 0; border: 0; border-bottom: 2px solid transparent; border-radius: 0; cursor: pointer;
  font: inherit; font-size: 12.5px; line-height: 18px; white-space: nowrap; color: var(--vscode-descriptionForeground, #9d9d9d); background: transparent; }
.co-fd-tab:hover { color: var(--vscode-foreground, #cccccc); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.14)); }
.co-fd-tab[aria-selected="true"] { color: var(--vscode-foreground, #cccccc); font-weight: 600; border-bottom-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007fd4)); }
.co-fd-tab:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: -2px; }
.co-fd-banners { flex: none; padding: 10px 12px 0; }
.co-fd-banners:empty { display: none; }
.co-fd-banners .co-banner { margin: 0; }
.co-fd-banner-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.co-fd-content { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 12px 12px 16px; scrollbar-width: thin; }
.co-fd-panel[hidden] { display: none; }
.co-fd-loading { margin: 6px 0; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-loaderr { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; color: var(--vscode-errorForeground, #f48771); }
.co-fd-loaderr p { margin: 0; overflow-wrap: anywhere; }

.co-fd-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 5px; min-width: 0;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)))); }
.co-fd-h { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-hint { margin: 0; font-size: 12px; line-height: 1.4; color: var(--vscode-descriptionForeground, #9d9d9d); overflow-wrap: anywhere; }
.co-fd-chip { display: inline-block; flex: none; padding: 0 7px; border-radius: 9px; font-size: 11px; line-height: 17px; white-space: nowrap;
  color: var(--vscode-badge-foreground, #ffffff); background: var(--vscode-badge-background, #616161);
  border: 1px solid var(--vscode-contrastBorder, transparent); }

.co-fd-bottom { flex: none; border-top: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)) 94%, var(--vscode-foreground, #cccccc) 6%); }
.co-fd-bottom:empty { display: none; }
.co-fd-footer { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 10px; }
.co-fd-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.co-fd-footer-title { flex: 1 1 110px; min-width: 0; font-weight: 600; font-size: 12.5px; display: inline-flex; align-items: center; gap: 7px; }
.co-fd-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-footer-btns { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.co-fd-errs { margin: 0; padding-left: 18px; font-size: 12px; color: var(--vscode-errorForeground, #f48771); overflow-wrap: anywhere; }
.co-fd-errs-h { margin: 0; font-size: 12px; color: var(--vscode-errorForeground, #f48771); font-weight: 600; }
.co-fd-fail { margin: 0; font-size: 12px; color: var(--vscode-errorForeground, #f48771); overflow-wrap: anywhere; }
.co-fd-confirm { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 4px; font-size: 12px;
  background: color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 45%, transparent); }
.co-fd-confirm p { margin: 0; }
.co-fd-confirm ul { margin: 0; padding-left: 18px; max-height: 120px; overflow-y: auto; overflow-wrap: anywhere; scrollbar-width: thin; }
.co-fd-prompt { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  background: color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 16%, transparent); }
.co-fd-prompt p { margin: 0; font-weight: 600; font-size: 12.5px; }
.co-fd-prompt-btns { display: flex; flex-wrap: wrap; gap: 6px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** Runs `rebuild` and puts the focus back on the element with the same `data-k` when it was inside `container`. */
function keepFocus(container: HTMLElement, rebuild: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && container.contains(active) ? active.dataset['k'] : undefined;
  rebuild();
  if (key !== undefined) container.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function isFrontDeskCtx(c: PanelContext<HTMLElement>): c is FrontDeskCtx<HTMLElement> {
  const f = c as Partial<FrontDeskCtx<HTMLElement>>;
  return typeof f.hostTheme === 'function' && typeof f.preview === 'function' && typeof f.onHost === 'function';
}

/** Builds the Front desk panel. Register it under id `frontdesk`. */
export function createFrontDeskPanel(deps: FrontDeskDeps): FrontDeskPanelView {
  // The newest context (the drawer builds a new one for each mount; its functions stay the same).
  let ctx: FrontDeskCtx<HTMLElement> | null = null;
  let currentTab: FrontDeskTab = deps.initialTab ?? 'theme';

  const controller = new FrontDeskController({
    hostTheme: () => ctx?.hostTheme() ?? null,
    post: (msg) => { ctx?.post(msg); },
    preview: (theme) => { ctx?.preview(theme); },
    loadState: () => deps.loadState(),
    saveState: (text) => { deps.saveState(text); },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (hnd) => { window.clearTimeout(hnd as number); },
    ...(deps.previewDelayMs !== undefined ? { previewDelayMs: deps.previewDelayMs } : {}),
    ...(deps.nextReqId !== undefined ? { nextReqId: deps.nextReqId } : {}),
  });

  const api: FrontDeskTabApi = {
    get ctx(): FrontDeskCtx<HTMLElement> {
      if (ctx === null) throw new Error('Front desk is not mounted');
      return ctx;
    },
    draft: () => controller.draft(),
    edit: (path, value) => { controller.edit(path, value); },
    update: (fn) => { controller.update(fn); },
    hostState: () => controller.hostState(),
    hostTheme: () => controller.hostTheme(),
    isDirty: () => controller.isDirty(),
    request: (build, onDone) => controller.request(build, onDone),
    openTab: (tab) => { setTab(tab, false); },
  };

  // -- DOM of the current mount ----------------------------------------------------
  let body: HTMLElement | null = null;
  let tabsEl: HTMLElement | null = null;
  let bannerEl: HTMLElement | null = null;
  let contentEl: HTMLElement | null = null;
  let bottomEl: HTMLElement | null = null;
  let loadingEl: HTMLElement | null = null;
  const tabButtons = new Map<FrontDeskTab, HTMLButtonElement>();
  const panels = new Map<FrontDeskTab, HTMLElement>();
  const views = new Map<FrontDeskTab, FrontDeskTabView>();
  let unsubHost: (() => void) | null = null;
  let unsubChange: (() => void) | null = null;
  let promptReturn: HTMLElement | null = null;
  let promptShown = false;

  function setTab(tab: FrontDeskTab, focus: boolean): void {
    currentTab = tab;
    deps.saveTab?.(tab);
    if (!body) return;
    renderTabs();
    if (focus) tabButtons.get(tab)?.focus();
  }

  function renderTabs(): void {
    for (const tab of FRONT_DESK_TABS) {
      const selected = tab === currentTab;
      const btn = tabButtons.get(tab);
      if (btn) {
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
      }
      const panel = panels.get(tab);
      if (panel) panel.hidden = !selected;
    }
    // A tab that is not shown gets its refresh when it becomes visible.
    if (views.size > 0) views.get(currentTab)?.refresh?.('show');
  }

  function buildTabs(): void {
    if (!contentEl || views.size > 0 || controller.state() === null) return;
    for (const tab of FRONT_DESK_TABS) {
      const panel = panels.get(tab);
      if (!panel) continue;
      let view: FrontDeskTabView;
      try {
        const factory = factories.get(tab);
        if (!factory) throw new Error('no factory');
        view = factory(api);
      } catch (e) {
        console.error(`front desk: the ${tab} tab could not be built`, e);
        view = { el: h('p', { class: 'co-fd-fail', role: 'alert', text: `The ${tabLabel(tab)} tab could not be built.` }) };
      }
      views.set(tab, view);
      panel.replaceChildren(view.el);
    }
    loadingEl?.remove();
    loadingEl = null;
    renderTabs();
  }

  function renderLoading(): void {
    if (!contentEl || views.size > 0) return;
    const err = controller.loadError;
    const el = err === null
      ? h('p', { class: 'co-fd-loading', role: 'status', text: 'Loading…' })
      : h('div', { class: 'co-fd-loaderr', role: 'alert' }, h('p', { text: err }), button('Try again', 'co-btn co-secondary co-small', () => { controller.retry(); }));
    if (loadingEl) loadingEl.replaceWith(el);
    else contentEl.prepend(el);
    loadingEl = el;
  }

  function renderBanner(): void {
    if (!bannerEl) return;
    const container = bannerEl;
    keepFocus(container, () => {
      const b = bannerView(controller.editor);
      if (b === null) {
        container.replaceChildren();
        return;
      }
      const box = h('div', { class: 'co-banner', role: 'status' }, h('div', { text: b.text }));
      if (b.offerChoice) {
        box.append(h('div', { class: 'co-fd-banner-actions' },
          button('Load it', 'co-btn co-secondary co-small', () => { controller.loadIt(); }, { 'data-k': 'load' }),
          button('Keep mine', 'co-btn co-secondary co-small', () => { controller.keepMine(); }, { 'data-k': 'keep' })));
      }
      container.replaceChildren(box);
    });
  }

  function renderBottom(): void {
    if (!bottomEl) return;
    const container = bottomEl;
    keepFocus(container, () => {
      const parts: HTMLElement[] = [];
      if (controller.closePrompt) parts.push(buildPrompt());
      const state = controller.state();
      if (state !== null) {
        const f = footerView(controller.editor, state.source, controller.errors(), controller.notice);
        if (f.visible) parts.push(buildFooter(f));
      }
      container.replaceChildren(...parts);
    });
    const nowShown = controller.closePrompt && container.querySelector('.co-fd-prompt') !== null;
    if (nowShown && !promptShown) {
      promptReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      container.querySelector<HTMLElement>('[data-k="keep-editing"]')?.focus({ preventScroll: true });
    }
    promptShown = nowShown;
  }

  function buildPrompt(): HTMLElement {
    const p = closePromptView(controller.editor);
    const row = h('div', { class: 'co-fd-prompt-btns' },
      button('Keep editing', 'co-btn co-primary co-small', () => { closePromptKeep(); }, { 'data-k': 'keep-editing', 'data-escape-default': '' }));
    if (p.canDiscard) row.append(button('Discard', 'co-btn co-danger co-small', () => { closePromptDiscard(); }, { 'data-k': 'discard-close' }));
    const el = h('div', { class: 'co-fd-prompt', role: 'alertdialog', 'aria-label': 'Unsaved changes' }, h('p', { text: p.text }), row);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      closePromptKeep();
    });
    return el;
  }

  function closePromptKeep(): void {
    const back = promptReturn;
    promptReturn = null;
    controller.keepEditing();
    if (back && back.isConnected) back.focus({ preventScroll: true });
    // Let the tab put the user back where they were (the Staff tab reopens a person page that the close attempt popped).
    if (currentTab === 'staff') views.get(currentTab)?.refresh?.('editor');
  }

  function closePromptDiscard(): void {
    if (!controller.discardForClose()) return;
    promptReturn = null;
    ctx?.back();
  }

  function buildFooter(f: ReturnType<typeof footerView>): HTMLElement {
    const el = h('div', { class: 'co-fd-footer', role: 'region', 'aria-label': 'Unsaved changes' });
    if (f.errors.length > 0) {
      el.append(h('p', { class: 'co-fd-errs-h', text: 'Fix these before saving:' }),
        h('ul', { class: 'co-fd-errs' }, ...f.errors.map((e) => h('li', { text: e }))));
    }
    if (f.message !== undefined) {
      el.append(h('p', { class: 'co-fd-fail', role: 'alert', text: f.message }));
      if (controller.editor.status === 'error') el.append(button('Dismiss', 'co-link', () => { controller.dismissError(); }, { 'data-k': 'dismiss' }));
    }
    const confirm = controller.confirming;
    if (confirm !== null) {
      el.append(h('div', { class: 'co-fd-confirm', role: 'alertdialog', 'aria-label': 'Saving rewrites the file' },
        h('p', { text: 'Saving rewrites your theme file. This will change:' }),
        h('ul', null, ...confirm.lines.map((l) => h('li', { text: l }))),
        h('div', { class: 'co-fd-prompt-btns' },
          button('Save anyway', 'co-btn co-primary co-small', () => { controller.confirmSave(); }, { 'data-k': 'confirm-save' }),
          button('Cancel', 'co-btn co-secondary co-small', () => { controller.cancelConfirm(); }, { 'data-k': 'confirm-cancel' }))));
      return el;
    }
    const btns = h('div', { class: 'co-fd-footer-btns' });
    if (f.canDiscard) btns.append(button('Discard', 'co-btn co-secondary co-small', () => { controller.discard(); }, { 'data-k': 'discard' }));
    for (const b of f.buttons) {
      const btn = button(b.label, `co-btn ${b.primary ? 'co-primary' : 'co-secondary'} co-small`, () => { controller.save(b.choice); }, { 'data-k': `save-${b.choice}` });
      btn.disabled = b.disabled;
      btns.append(btn);
    }
    el.append(h('div', { class: 'co-fd-footer-row' },
      h('span', { class: 'co-fd-footer-title', role: 'status' }, h('span', { class: 'co-fd-dot', 'aria-hidden': 'true' }), f.title),
      btns));
    return el;
  }

  function renderChrome(): void {
    renderBanner();
    renderBottom();
  }

  function onChange(reason: ChangeReason): void {
    if (!body) return;
    if (controller.state() !== null && views.size === 0) buildTabs();
    renderLoading();
    renderChrome();
    if (reason !== 'editor') {
      for (const [tab, view] of views) {
        // Hidden tabs are refreshed when shown; the visible one now.
        if (tab === currentTab) view.refresh?.(reason);
      }
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    const next = nextTab(e.key, currentTab);
    if (next === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    setTab(next, true);
  }

  function onHostMessage(msg: HostToWebview): void {
    if (msg.type === 'openFrontDesk') {
      if (isFrontDeskTab(msg.tab)) setTab(msg.tab, false);
      return;
    }
    controller.receive(msg);
  }

  return {
    id: 'frontdesk',
    title: 'Front desk',
    icon: 'bell',

    mount(el, c) {
      injectUiStyles();
      injectCss();
      if (!isFrontDeskCtx(c)) {
        el.append(h('p', { class: 'co-fd-fail', role: 'alert', text: 'The Front desk is not available here.' }));
        return;
      }
      ctx = c;
      body = el;
      el.classList.add('co-fd-body');
      tabsEl = h('div', { class: 'co-fd-tabs', role: 'tablist', 'aria-label': 'Front desk sections' });
      tabsEl.addEventListener('keydown', onKeydown);
      tabButtons.clear();
      panels.clear();
      views.clear();
      contentEl = h('div', { class: 'co-fd-content' });
      for (const tab of FRONT_DESK_TABS) {
        const btn = h('button', { type: 'button', class: 'co-fd-tab', role: 'tab', id: tabDomId(tab), 'aria-controls': panelDomId(tab), 'aria-selected': 'false', tabindex: '-1', text: tabLabel(tab) });
        btn.addEventListener('click', () => { setTab(tab, false); });
        tabButtons.set(tab, btn);
        tabsEl.append(btn);
        const panel = h('div', { class: 'co-fd-panel', role: 'tabpanel', id: panelDomId(tab), 'aria-labelledby': tabDomId(tab) });
        panel.hidden = true;
        panels.set(tab, panel);
        contentEl.append(panel);
      }
      bannerEl = h('div', { class: 'co-fd-banners' });
      bottomEl = h('div', { class: 'co-fd-bottom' });
      el.append(h('div', { class: 'co-fd' }, tabsEl, bannerEl, contentEl, bottomEl));
      promptShown = false;
      renderTabs();
      unsubChange = controller.onChange(onChange);
      unsubHost = c.onHost(onHostMessage);
      controller.start();
      buildTabs();
      renderLoading();
      renderChrome();
    },

    unmount() {
      controller.flush();
      unsubHost?.();
      unsubChange?.();
      unsubHost = null;
      unsubChange = null;
      for (const view of views.values()) {
        try { view.unmount?.(); } catch (e) { console.error('front desk: a tab failed to unmount', e); }
      }
      views.clear();
      body?.classList.remove('co-fd-body');
      body = null;
      tabsEl = null;
      bannerEl = null;
      contentEl = null;
      bottomEl = null;
      loadingEl = null;
      promptShown = false;
      promptReturn = null;
      tabButtons.clear();
      panels.clear();
    },

    beforeClose() {
      return controller.beforeClose();
    },

    openTab(tab) {
      if (isFrontDeskTab(tab)) setTab(tab, false);
    },
  };
}
