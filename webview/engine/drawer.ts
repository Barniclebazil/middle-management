/**
 * The panel drawer: one `PanelView` at a time (In-tray, Plans, Usage, Directory, Front desk ...) in a drawer on the right
 * that reuses the case file's width, dock side and overlay rule. It keeps a back stack (`push` / `back`, with a
 * "← <previous title>" button in the header), honours `beforeClose()` on close, switch and back (close and switch ask every
 * stacked view, back only the top one), and lets the case file
 * show "← <panel title>" by `suspend()`ing the drawer while a case is open and `resume()`ing it afterwards.
 *
 * The navigation rules live in `PanelStack` and the width rule in `drawerLayout` (`drawerLogic.ts`, pure and tested without a DOM);
 * `PanelDrawer` only mounts views and moves focus. Text is only ever set with text nodes.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { HostToWebview } from '../../src/shared/protocol.ts';
import { DRAWER_DEFAULT_W, PanelStack, clampDrawerWidth, drawerLayout, escapeConsumed } from './drawerLogic.ts';
import type { ReturnTarget } from './drawerLogic.ts';
import { button, h } from './dom.ts';
import { injectUiStyles } from './uiStyles.ts';

export type { ReturnTarget } from './drawerLogic.ts';

/** What `open` needs from the caller: the context minus `push`/`back`, which the drawer supplies. */
export type DrawerContext = Omit<PanelContext<HTMLElement>, 'push' | 'back'>;

export interface DrawerDeps {
  /** The docked width changed (open, close, resize, overlay switch, suspend, resume). */
  layoutChanged(): void;
  /** Initial and persisted drawer width: pass the same value the case file gets, so both drawers match. */
  width?: number;
  saveWidth?(w: number): void;
  /** The shown panel changed (its id, or null when closed or suspended): drives the icon bar's pressed state and saved state. */
  onChange?(currentId: string | null): void;
  /** Icon factory (`pixelIcon`) for the header; no icon when omitted. */
  icon?(name: string): HTMLElement;
  /** Where focus goes when the drawer closes with nothing to return to (opened by a click in the office), instead of <body>. */
  fallbackFocus?(): void;
}

const CSS = `
.co-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-direction: column; min-width: 0; box-sizing: border-box;
  font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; line-height: 1.45; color: var(--vscode-foreground, #cccccc);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f));
  border-left: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)))); }
.co-drawer *, .co-drawer *::before, .co-drawer *::after { box-sizing: border-box; }
.co-drawer.overlay { box-shadow: -8px 0 24px rgba(0,0,0,0.35); }
.co-drawer[hidden] { display: none; }
.co-drawer:focus { outline: none; }
/* Focus moved here by the keyboard (a panel opened with Enter): an inset ring, like a focused VS Code view. */
.co-drawer:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.co-drawer canvas { image-rendering: pixelated; flex: none; }
.co-drawer-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 2; }
.co-drawer-resize:hover, .co-drawer-resize.drag { background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 60%, transparent); }
.co-drawer-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 7px 8px 7px 12px;
  border-bottom: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)) 92%, var(--vscode-foreground, #cccccc) 8%); }
.co-drawer-back { flex: 0 0 auto; min-width: 0; max-width: 46%; display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px 2px 7px; min-height: 24px;
  border-radius: 3px; border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.35)))); cursor: pointer; font: inherit; font-size: 12px; line-height: 18px;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #cccccc)); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); }
.co-drawer-back:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
.co-drawer-back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-drawer-back[hidden] { display: none; }
.co-drawer-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; }
.co-drawer-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-drawer-x { flex: none; margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0;
  border-radius: 4px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 18px; line-height: 1; }
.co-drawer-x:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-drawer-back:focus-visible, .co-drawer-x:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-drawer-body { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 10px 12px 14px; scrollbar-width: thin; }
.co-drawer-fail { margin: 0; color: var(--vscode-errorForeground, #f48771); }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

export class PanelDrawer {
  readonly el: HTMLElement;
  private readonly deps: DrawerDeps;
  private readonly stack = new PanelStack<PanelView<HTMLElement>>();
  /** The view whose content is in the body right now (the stack's top while it is mounted). */
  private mounted: PanelView<HTMLElement> | null = null;
  private baseCtx: DrawerContext | null = null;
  /** Hidden while a case file is open from a panel; the stack and the mounted view are kept. */
  private suspended = false;
  private width: number;
  private overlay = false;
  private viewportW = 1;
  private returnFocus: Element | null = null;

  private readonly backBtn: HTMLButtonElement;
  private readonly backLabel: HTMLSpanElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly body: HTMLDivElement;

  constructor(parent: HTMLElement, deps: DrawerDeps) {
    injectUiStyles();
    injectCss();
    this.deps = deps;
    this.width = clampDrawerWidth(deps.width ?? DRAWER_DEFAULT_W);
    this.el = h('aside', { class: 'co-drawer co-ui', role: 'complementary', 'aria-label': 'Panel', tabindex: '-1' });
    this.el.hidden = true;

    const handle = h('div', { class: 'co-drawer-resize', title: 'Drag to resize', 'aria-hidden': 'true' });
    this.wireResize(handle);

    this.backLabel = h('span');
    this.backBtn = button([h('span', { 'aria-hidden': 'true', text: '←' }), this.backLabel], 'co-drawer-back', () => { this.back(); });
    this.backBtn.hidden = true;
    this.titleEl = h('h2', { class: 'co-drawer-title' });
    const close = button('×', 'co-drawer-x', () => { this.close(); }, { 'aria-label': 'Close panel (Esc)', title: 'Close (Esc)' });
    const head = h('header', { class: 'co-drawer-head' }, this.backBtn, this.titleEl, close);
    this.body = h('div', { class: 'co-drawer-body' });

    this.el.append(handle, head, this.body);
    parent.appendChild(this.el);
  }

  // -- State ----------------------------------------------------------------

  /** True while a panel is showing (not closed, not suspended). */
  isOpen(): boolean {
    return this.stack.size > 0 && !this.suspended;
  }

  /** True while the drawer is hidden behind a case file but will come back with `resume()`. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /** Id of the panel being shown ('inbox', 'directory', ...; a sub-view's own id), or null when closed or suspended. */
  currentId(): string | null {
    return this.isOpen() ? this.stack.top()?.id ?? null : null;
  }

  /** How many views are stacked (1 = just the panel, 2+ = sub-views on top). */
  get depth(): number {
    return this.stack.size;
  }

  /**
   * What the case file should offer to go back to ("← In-tray"): the panel on top of the stack, while the drawer is
   * showing or suspended; null when no panel is open.
   */
  returnTarget(): ReturnTarget | null {
    return this.stack.returnTarget();
  }

  /** Width the office should leave free on the right (0 when closed, suspended or overlaying). */
  get dockWidth(): number {
    return this.isOpen() && !this.overlay ? this.width : 0;
  }

  /** Tells the drawer how wide the whole webview is. */
  setViewport(w: number): void {
    this.viewportW = Math.max(1, w);
    const was = this.overlay;
    this.applyWidth();
    if (this.overlay !== was && this.isOpen()) this.deps.layoutChanged();
  }

  // -- Navigation -----------------------------------------------------------

  /**
   * Shows `view` (replacing whatever panel was open). Returns false when the open view vetoed leaving. Opening the panel
   * that is already showing just brings the drawer back into focus (or back from suspended).
   */
  open(view: PanelView<HTMLElement>, ctx: DrawerContext): boolean {
    const idle = this.stack.size === 0;
    const wasSuspended = this.suspended;
    const r = this.stack.open(view, wasSuspended);
    if (r === 'vetoed') {
      // The vetoing view stays, with the context it was opened with (a remount must not get the refused panel's context).
      this.settleAfterVeto();
      return false;
    }
    this.baseCtx = ctx;
    if (r === 'same') {
      if (wasSuspended) this.resume();
      else this.focusDrawer();
      return true;
    }
    if (idle) this.returnFocus = document.activeElement;
    this.unmountTop();
    this.suspended = false;
    this.el.hidden = false;
    this.applyWidth();
    this.renderHead();
    this.mountTop();
    this.deps.layoutChanged();
    this.deps.onChange?.(this.currentId());
    this.focusDrawer();
    return true;
  }

  /** Shows a sub-view on top of the current panel; `back()` returns here. Does nothing when no panel is open. */
  push(view: PanelView<HTMLElement>): void {
    if (this.stack.size === 0 || !this.baseCtx) return;
    this.stack.push(view);
    this.unmountTop();
    this.renderHead();
    this.mountTop();
    this.deps.onChange?.(this.currentId());
    if (this.isOpen()) this.focusDrawer();
  }

  /** Pops to the previous view, or closes the drawer from the root view. Returns false when the view vetoed. */
  back(): boolean {
    const r = this.stack.back(this.suspended);
    if (r === 'vetoed') return false;
    if (r === 'empty') return true;
    if (r === 'closed') {
      this.finishClose();
      return true;
    }
    this.unmountTop();
    this.renderHead();
    this.mountTop();
    this.deps.onChange?.(this.currentId());
    if (this.isOpen()) this.focusDrawer();
    return true;
  }

  /**
   * Closes the drawer, asking every view in the stack from the top to the root. Returns false when one vetoed (it then asks the
   * user itself); the drawer shows that view, so a sub-view on top of a vetoing root is popped to reveal the root's prompt.
   */
  close(): boolean {
    const r = this.stack.close(this.suspended);
    if (r === 'vetoed') {
      this.settleAfterVeto();
      return false;
    }
    if (r === 'closed') this.finishClose();
    return true;
  }

  /**
   * The case file that was opened from this (suspended) drawer has closed. A plain close discards the drawer, but views ask first
   * like on any close: when one vetoes (unsaved Front desk edits) the drawer comes back showing its prompt instead of dropping
   * the edits. Returns true when the drawer closed.
   */
  dismissSuspended(): boolean {
    if (!this.suspended) return false;
    const r = this.stack.close(false);
    if (r === 'vetoed') {
      this.settleAfterVeto();
      this.resume();
      return false;
    }
    if (r === 'closed') this.finishClose();
    return true;
  }

  /**
   * Hides the drawer but keeps its views mounted, for a case file opened from a panel. Returns the return target
   * ("← In-tray") to show in the case file, or null when no panel was open.
   */
  suspend(): ReturnTarget | null {
    if (this.isOpen()) {
      this.suspended = true;
      this.el.hidden = true;
      this.deps.layoutChanged();
      this.deps.onChange?.(null);
    }
    return this.stack.returnTarget();
  }

  /** Shows a suspended drawer again (the case file's "← In-tray"). Returns false when nothing was suspended. */
  resume(): boolean {
    if (!this.suspended) return false;
    this.suspended = false;
    this.el.hidden = false;
    this.applyWidth();
    this.deps.layoutChanged();
    this.deps.onChange?.(this.currentId());
    this.refresh();
    this.focusDrawer();
    return true;
  }

  /** The drawer step of the Escape order. Returns true when Escape was consumed (the drawer was showing). */
  handleEscape(): boolean {
    // A panel's own prompt (the Front desk's "Keep editing / Discard") answers Escape with its safe choice, wherever focus is.
    const answer = this.isOpen() ? this.body.querySelector<HTMLElement>('[data-escape-default]') : null;
    if (answer && answer.isConnected && !answer.closest('[hidden]')) {
      answer.click();
      return true;
    }
    return escapeConsumed(this.isOpen(), () => this.close());
  }

  // -- Data -----------------------------------------------------------------

  /** Tell the mounted view that agents, usage, defaults or the inbox read marks changed. */
  refresh(): void {
    const v = this.mounted;
    if (!v || typeof v.refresh !== 'function') return;
    try { v.refresh(); } catch (e) { console.error(`panel ${v.id}: refresh failed`, e); }
  }

  /** Routes a host message to the mounted view. Returns true when a view received it. */
  handle(msg: HostToWebview): boolean {
    const v = this.mounted;
    if (!v || typeof v.handle !== 'function') return false;
    try { v.handle(msg); } catch (e) { console.error(`panel ${v.id}: handle failed`, e); }
    return true;
  }

  // -- Internals ------------------------------------------------------------

  private ctxFor(): PanelContext<HTMLElement> {
    const base = this.baseCtx as DrawerContext;
    return {
      ...base,
      push: (v) => this.push(v),
      back: () => { this.back(); },
      // A case opened from a panel hides the drawer (they share the right-hand side); the case file's back button resumes it.
      openCase: (id) => { this.suspend(); base.openCase(id); },
    };
  }

  private mountTop(): void {
    const v = this.stack.top();
    if (!v) return;
    this.body.scrollTop = 0;
    this.mounted = v;
    try {
      v.mount(this.body, this.ctxFor());
    } catch (e) {
      console.error(`panel ${v.id}: mount failed`, e);
      this.body.replaceChildren(h('p', { class: 'co-drawer-fail', role: 'alert', text: `${v.title} could not be opened.` }));
    }
  }

  /** After a veto cut the stack back, shows the view that vetoed (it has to be on screen to ask the user). */
  private settleAfterVeto(): void {
    if (this.stack.top() === this.mounted) return;
    this.unmountTop();
    this.renderHead();
    this.mountTop();
    this.deps.onChange?.(this.currentId());
    // The vetoing view usually focuses its own prompt as it mounts; leave that focus alone.
    if (this.isOpen() && !this.body.contains(document.activeElement)) this.focusDrawer();
  }

  private unmountTop(): void {
    const v = this.mounted;
    if (!v) return;
    this.mounted = null;
    try { v.unmount?.(); } catch (e) { console.error(`panel ${v.id}: unmount failed`, e); }
    this.body.replaceChildren();
  }

  private finishClose(): void {
    this.unmountTop();
    this.suspended = false;
    this.el.hidden = true;
    this.deps.layoutChanged();
    this.deps.onChange?.(null);
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
    // Focus left on <body>, or still on a control inside the now hidden element (the browser only moves it later).
    else if (document.activeElement === null || document.activeElement === document.body || this.el.contains(document.activeElement)) this.deps.fallbackFocus?.();
  }

  private renderHead(): void {
    const v = this.stack.top();
    const prev = this.stack.previous();
    const title = v?.title ?? 'Panel';
    const icon = v && this.deps.icon ? this.deps.icon(v.icon) : null;
    this.titleEl.replaceChildren(...(icon ? [icon] : []), h('span', { text: title }));
    this.el.setAttribute('aria-label', title);
    this.backBtn.hidden = !prev;
    this.backLabel.textContent = prev ? prev.title : '';
    if (prev) this.backBtn.setAttribute('aria-label', `Back to ${prev.title}`);
    else this.backBtn.removeAttribute('aria-label');
  }

  private focusDrawer(): void {
    this.el.focus({ preventScroll: true });
  }

  private applyWidth(): void {
    const l = drawerLayout(this.viewportW, this.width);
    this.overlay = l.overlay;
    if (!l.overlay) this.width = l.width;
    this.el.style.width = `${l.width}px`;
    this.el.classList.toggle('overlay', l.overlay);
  }

  private wireResize(handle: HTMLElement): void {
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (this.overlay || e.button !== 0) return;
      dragging = true;
      handle.classList.add('drag');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.width = clampDrawerWidth(this.viewportW - e.clientX);
      this.applyWidth();
      this.deps.layoutChanged();
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('drag');
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      this.deps.saveWidth?.(this.width);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
