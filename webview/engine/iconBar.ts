/**
 * The icon bar ("building directory"): a toolbar with In-tray, Plans, Usage, Front desk (the bell), Directory and
 * New task, in that order, then (with Round B enabled) the File room, Training library, Phone, Office handbook and Temp
 * agency as a group of icons. Roving tabindex (Tab enters the bar once; Left/Right/Home/End move inside it; Enter or Space
 * press the focused button, which a `<button>` does natively). Each item has a label, an icon, an optional badge
 * (count plus an urgent style) and an `aria-pressed` state for the open panel. Hovering or focusing an item calls
 * `onHover(prop)` so the office can outline that prop. Below 480 px it collapses to a single Directory button. From 800 px the first six show their labels (the Round B
 * group stays icons, so the bar never outgrows the webview). The labels are only shown when the labelled bar really fits, beside
 * the floating "+ New task" button when that shows (`setReserve`; a wider font or a "99+" badge can push it over just above
 * 800 px); otherwise it stays icons. If even that is too wide, the buttons wrap onto a second row rather than running under
 * the button or being cut off.
 *
 * The rail (v0.5, `setRail`): in a wide, short office view (`layoutLogic.ts`) the same buttons stand down the left edge as a
 * vertical toolbar, 44 px wide, full height, icons only, nothing over the map. Up/Down/Home/End move inside it. When the rail is
 * too short for every icon the last ones are left out (the Round B tools, from the end) and the Directory, which lists every
 * tool, says which ones it holds and carries their badges (`railItems`).
 *
 * The rules (collapse, roving index, badge words) are pure and tested without a DOM. Icons come from a factory the
 * caller passes in, so this file imports no art.
 */
import { button, h } from './dom.ts';
import {
  badgeText, fittedBarMode, hoverTarget, iconBarItems, iconBarMode, iconBarRoom, itemLabel, mergeBadges, railDirectoryLabel, railItems, railOverflow,
  resolveRoving, rovingNext, visibleItems,
} from './iconBarLogic.ts';
import type { Round } from './hotspots.ts';
import type { IconBarBadge, IconBarItem, IconBarItemId, IconBarMode } from './iconBarLogic.ts';

export type { IconBarBadge, IconBarItem, IconBarItemId, IconBarMode } from './iconBarLogic.ts';

const CSS = `
.co-iconbar { position: fixed; top: 8px; left: 8px; z-index: 18; display: flex; align-items: center; gap: 2px; padding: 3px; max-width: calc(100vw - 16px);
  flex-wrap: wrap; box-sizing: border-box; border-radius: 7px; user-select: none;
  font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12px; line-height: 16px; color: var(--vscode-foreground, #cccccc);
  background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526)) 92%, transparent);
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, var(--vscode-widget-border, rgba(128,128,128,0.4))));
  box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.co-iconbar *, .co-iconbar *::before, .co-iconbar *::after { box-sizing: border-box; }
.co-iconbar[hidden] { display: none; }
.co-iconbar canvas { image-rendering: pixelated; flex: none; }
.co-iconbar-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 34px; height: 34px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.co-iconbar-btn[hidden] { display: none; }
.co-iconbar-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); border-color: var(--vscode-contrastActiveBorder, transparent); }
.co-iconbar-btn[aria-pressed="true"] { background: var(--vscode-list-inactiveSelectionBackground, rgba(0,122,204,0.25));
  border-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007fd4)); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #007fd4); }
.co-iconbar-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 0; }
.co-iconbar-btn[data-group-start] { margin-left: 6px; }
.co-iconbar-btn[data-group-start]::before { content: ''; position: absolute; left: -5px; top: 7px; bottom: 7px; width: 1px;
  background: var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.4))); }
.co-iconbar-label { display: none; }
.co-iconbar.labelled .co-iconbar-label { display: inline; }
.co-iconbar.labelled .co-iconbar-btn[data-compact] .co-iconbar-label { display: none; }
.co-iconbar-badge { position: absolute; top: -4px; right: -3px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 16px;
  font-weight: 700; text-align: center; font-variant-numeric: tabular-nums;
  color: var(--vscode-badge-foreground, #ffffff); background: var(--vscode-badge-background, #4d4d4d);
  border: 1px solid var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526)); }
.co-iconbar-badge.urgent { color: var(--vscode-statusBarItem-errorForeground, #ffffff); background: var(--vscode-statusBarItem-errorBackground, #c72e0f); }
.co-iconbar-badge[hidden] { display: none; }
.co-iconbar.labelled .co-iconbar-badge { position: static; margin-left: 1px; }
/* The rail: a full-height vertical toolbar down the left edge of a wide, short view (sizes match RAIL_* in iconBarLogic.ts). */
.co-iconbar.rail { top: 0; left: 0; bottom: 0; width: 44px; max-width: none; flex-direction: column; flex-wrap: nowrap; align-items: center;
  gap: 2px; padding: 6px 0; border-radius: 0; border-width: 0 1px 0 0; box-shadow: none; overflow: hidden;
  border-color: var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35))));
  background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #252526)); }
.co-iconbar.rail .co-iconbar-btn { flex: none; width: 32px; min-width: 32px; height: 32px; padding: 0; }
.co-iconbar.rail .co-iconbar-label { display: none; }
.co-iconbar.rail .co-iconbar-btn[aria-pressed="true"] { box-shadow: inset 2px 0 0 var(--vscode-focusBorder, #007fd4); }
.co-iconbar.rail .co-iconbar-btn[data-group-start] { margin-left: 0; margin-top: 8px; }
.co-iconbar.rail .co-iconbar-btn[data-group-start]::before { left: 5px; right: 5px; top: -5px; bottom: auto; width: auto; height: 1px; }
.co-iconbar.rail .co-iconbar-badge { top: -3px; right: -5px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface IconBarDeps {
  /** Builds an icon by name (`pixelIcon` in the webview). Names: inTray, plans, usage, bell, directory, newTask. */
  icon(name: string): HTMLElement;
  /** An item was pressed (click, Enter or Space). */
  onActivate(id: IconBarItemId): void;
  /** The pointer or keyboard focus entered an item (its prop id, or null for items without a prop) or left the bar (null). */
  onHover?(prop: string | null): void;
}

interface ItemEls { item: IconBarItem; btn: HTMLButtonElement; badge: HTMLSpanElement }

export class IconBar {
  readonly el: HTMLElement;
  private readonly deps: IconBarDeps;
  private readonly items: readonly IconBarItem[];
  private readonly els: ItemEls[] = [];
  private readonly badges = new Map<IconBarItemId, IconBarBadge>();
  private mode: IconBarMode;
  /** The width last given (the office's width, without a docked drawer). */
  private width: number;
  /** Room kept free at the right for the floating New task button (`setReserve`). */
  private reserve = 0;
  private roving: string | null = null;
  private current: IconBarItemId | null = null;
  /** Standing as the rail (`setRail`), and its height. */
  private rail = false;
  private railH = 0;

  /** `rounds`: which rounds' items to show (default Round A only). */
  constructor(parent: HTMLElement, deps: IconBarDeps, width = 1000, rounds: ReadonlySet<Round> = new Set<Round>(['A'])) {
    injectCss();
    this.deps = deps;
    this.items = iconBarItems(rounds);
    this.mode = iconBarMode(width);
    this.width = width;
    this.el = h('div', { class: 'co-iconbar', role: 'toolbar', 'aria-label': 'Office directory', 'aria-orientation': 'horizontal' });
    for (const item of this.items) {
      const badge = h('span', { class: 'co-iconbar-badge', 'aria-hidden': 'true' });
      badge.hidden = true;
      const btn = button([deps.icon(item.icon), h('span', { class: 'co-iconbar-label', text: item.label }), badge], 'co-iconbar-btn', () => deps.onActivate(item.id),
        { title: item.label, 'aria-label': item.label, 'data-item': item.id, ...(item.compact ? { 'data-compact': '1' } : {}), ...(item.groupStart ? { 'data-group-start': '1' } : {}) });
      btn.addEventListener('mouseenter', () => this.hover(item));
      btn.addEventListener('focus', () => { this.setRoving(item.id); this.hover(item); });
      btn.addEventListener('mouseleave', () => this.settle());
      btn.addEventListener('blur', () => deps.onHover?.(null));
      btn.addEventListener('keydown', (e) => this.onKey(e, item));
      this.els.push({ item, btn, badge });
      this.el.appendChild(btn);
    }
    this.el.addEventListener('mouseleave', () => this.settle());
    // First in the page, so it is the first Tab stop (before the roster and the drawer).
    parent.prepend(this.el);
    this.apply();
    this.setWidth(width);
  }

  /** The bar's current look. */
  get currentMode(): IconBarMode {
    return this.mode;
  }

  /** Tells the bar how wide the webview is (collapses below 480 px). */
  setWidth(width: number): void {
    this.width = width;
    if (this.rail) return;
    // Wrap onto a second row rather than run under the New task button or a docked drawer.
    this.el.style.maxWidth = `${iconBarRoom(width, this.reserve)}px`;
    const m = this.fittedMode(width);
    if (m === this.mode) return;
    this.mode = m;
    this.apply();
  }

  /**
   * Stands the bar as the rail down the left edge (`on`, with the webview's `height`), or puts it back on top. In a rail the
   * width and the reserve do not matter; the height decides which items fit (`railItems`).
   */
  setRail(on: boolean, height: number): void {
    const h = Math.max(0, Math.round(height));
    if (on === this.rail && (!on || h === this.railH)) return;
    this.rail = on;
    this.railH = h;
    this.el.classList.toggle('rail', on);
    this.el.setAttribute('aria-orientation', on ? 'vertical' : 'horizontal');
    if (on) {
      this.el.style.maxWidth = '';
      this.apply();
      return;
    }
    // Back on top: the width rules again (and the labels, if they fit).
    this.mode = this.fittedMode(this.width);
    this.el.style.maxWidth = `${iconBarRoom(this.width, this.reserve)}px`;
    this.apply();
  }

  /** True while the bar stands as the rail. */
  get isRail(): boolean {
    return this.rail;
  }

  /** Marks the open panel (`aria-pressed`), or none. Items that open the memo have no pressed state. */
  setCurrent(id: string | null): void {
    this.current = this.items.some((i) => i.id === id && i.panel) ? (id as IconBarItemId) : null;
    for (const { item, btn } of this.els) {
      if (item.panel) btn.setAttribute('aria-pressed', String(item.id === this.current));
    }
  }

  /** Sets or clears (null or a zero count) an item's badge. */
  setBadge(id: IconBarItemId, badge: IconBarBadge | null): void {
    if (badge && badgeText(badge.count)) this.badges.set(id, badge);
    else this.badges.delete(id);
    this.renderBadges();
    // A longer badge ("99+") can tip the labelled bar over the edge.
    this.setWidth(this.width);
  }

  /**
   * Keeps `px` free at the right of the bar's row: the floating "+ New task" button's width plus a gap while it shows (0 when it
   * is hidden). The labels go when they no longer fit beside it.
   */
  setReserve(px: number): void {
    const r = Math.max(0, Math.round(px));
    if (r === this.reserve) return;
    this.reserve = r;
    if (this.rail) return;
    this.setWidth(this.width);
  }

  /** `iconBarMode`, stepped down while the bar does not fit in one row beside the New task button (`fittedBarMode`). */
  private fittedMode(width: number): IconBarMode {
    const m = iconBarMode(width);
    if (m === 'collapsed') return m;
    return fittedBarMode(width, m === 'labelled' ? this.naturalWidth(true) : 0, this.naturalWidth(false), this.reserve);
  }

  /** The bar's natural one-row width with every item, labelled or icons only (0 when it is not laid out, e.g. not in the document yet). */
  private naturalWidth(labelled: boolean): number {
    const el = this.el;
    if (!el.isConnected) return 0;
    const cls = el.className;
    const hidden = this.els.map((e) => e.btn.hidden);
    const wrap = el.style.flexWrap;
    const max = el.style.maxWidth;
    el.classList.toggle('labelled', labelled);
    el.classList.remove('collapsed');
    for (const e of this.els) e.btn.hidden = false;
    el.style.flexWrap = 'nowrap';
    el.style.maxWidth = 'none';
    const w = el.offsetWidth;
    el.className = cls;
    this.els.forEach((e, i) => { e.btn.hidden = hidden[i] ?? false; });
    el.style.flexWrap = wrap;
    el.style.maxWidth = max;
    return w;
  }

  /** Shows each item's badge; a collapsed bar shows the total on its Directory button, since the other items are hidden. */
  private renderBadges(): void {
    // A rail that leaves items out shows their badges on the Directory, which lists them.
    const hidden = this.rail ? railOverflow(this.items, this.visibleItems()) : [];
    for (const e of this.els) {
      const dir = e.item.id === 'directory';
      let b: IconBarBadge | null | undefined = this.badges.get(e.item.id);
      if (dir && !this.rail && this.mode === 'collapsed') b = mergeBadges(this.badges.values());
      else if (dir && hidden.length) b = mergeBadges([b, ...hidden.map((i) => this.badges.get(i.id))].filter((x): x is IconBarBadge => !!x));
      const label = dir && hidden.length ? railDirectoryLabel(hidden) : e.item.label;
      e.badge.hidden = !b;
      e.badge.textContent = b ? badgeText(b.count) : '';
      e.badge.classList.toggle('urgent', !!b?.urgent);
      e.btn.setAttribute('aria-label', itemLabel(label, b));
      if (e.btn.title !== label) e.btn.title = label;
    }
  }

  /** Moves keyboard focus into the bar (the roving item). */
  focus(): void {
    this.els.find((e) => e.item.id === this.roving)?.btn.focus();
  }

  /** The items shown now: by height in a rail, by width on top. */
  private visibleItems(): IconBarItem[] {
    return this.rail ? railItems(this.items, this.railH) : visibleItems(this.mode, this.items);
  }

  private visible(): ItemEls[] {
    const ids = new Set(this.visibleItems().map((i) => i.id));
    return this.els.filter((e) => ids.has(e.item.id));
  }

  private apply(): void {
    this.el.classList.toggle('collapsed', !this.rail && this.mode === 'collapsed');
    this.el.classList.toggle('labelled', !this.rail && this.mode === 'labelled');
    const vis = new Set(this.visible().map((e) => e.item.id));
    for (const e of this.els) e.btn.hidden = !vis.has(e.item.id);
    this.setRoving(resolveRoving(this.roving, this.visible().map((e) => e.item)));
    this.setCurrent(this.current);
    this.renderBadges();
  }

  private setRoving(id: string | null): void {
    this.roving = id;
    for (const e of this.els) e.btn.tabIndex = e.item.id === id ? 0 : -1;
  }

  private hover(item: IconBarItem): void {
    this.deps.onHover?.(hoverTarget(item));
  }

  /** After the pointer leaves: the focused item's prop stays highlighted, otherwise nothing is. */
  private settle(): void {
    const focused = this.els.find((e) => e.btn === document.activeElement);
    this.deps.onHover?.(focused ? hoverTarget(focused.item) : null);
  }

  private onKey(e: KeyboardEvent, item: IconBarItem): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const vis = this.visible();
    const idx = vis.findIndex((x) => x.item.id === item.id);
    const next = rovingNext(idx, vis.length, e.key, this.rail);
    if (next === null) return;
    e.preventDefault();
    const target = vis[next];
    if (!target) return;
    this.setRoving(target.item.id);
    target.btn.focus();
  }
}
