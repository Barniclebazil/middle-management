/**
 * An accessible `role="menu"` popover anchored to a button: roving focus with
 * the arrow keys, Home/End and first-letter jumps, Enter or Space selects,
 * Escape closes it and returns focus to the anchor, a click outside closes it,
 * and it flips above the anchor to stay in the viewport. One popover is open
 * at a time.
 *
 * Escape order: while a popover is open it catches Escape first (a capturing
 * window listener), so the memo, drawer and case only see Escape once it is
 * closed. Other code can ask with `isPopoverOpen()` and close it with
 * `closePopover()`.
 *
 * The keyboard reducer and the placement maths live in `popoverLogic.ts`
 * (DOM-free, tested). Text is set with text nodes only.
 */

import { menuKey, placePopover } from './popoverLogic.ts';

export { menuKey, placePopover } from './popoverLogic.ts';
export type { MenuAction, Rect } from './popoverLogic.ts';

// ---------------------------------------------------------------------------
// The component

/** One menu entry. */
export interface PopoverItem {
  id: string;
  label: string;
  /** A second, dimmer line. */
  detail?: string;
  /** Ticked (menuitemradio). */
  checked?: boolean;
  /** Shown greyed out; can be focused but not chosen. */
  disabled?: boolean;
  /** Draws a small 5-bar effort meter with this many bars filled (0..5). */
  meter?: number;
}

export interface PopoverSpec {
  /** The button it hangs from; gets aria-haspopup / aria-expanded and focus back on close. */
  anchor: HTMLElement;
  /** Accessible name, also shown as a small heading. */
  label: string;
  items: readonly PopoverItem[];
  /** A line at the bottom, e.g. "Applies to their next message." */
  note?: string;
  onSelect(id: string): void;
  onClose?(): void;
}

interface Open {
  spec: PopoverSpec;
  el: HTMLDivElement;
  buttons: HTMLButtonElement[];
  cleanup: () => void;
}

let current: Open | null = null;
let seq = 0;

/** True while a popover is open. */
export function isPopoverOpen(): boolean {
  return current !== null;
}

/** The anchor of the open popover, if any. */
export function popoverAnchor(): HTMLElement | null {
  return current?.spec.anchor ?? null;
}

/** Closes the open popover. Returns false when none was open. */
export function closePopover(returnFocus = true): boolean {
  const c = current;
  if (!c) return false;
  current = null;
  c.cleanup();
  c.el.remove();
  c.spec.anchor.setAttribute('aria-expanded', 'false');
  if (returnFocus && c.spec.anchor.isConnected) c.spec.anchor.focus({ preventScroll: true });
  c.spec.onClose?.();
  return true;
}

/** Opens `spec` (closing any other first), or closes it when it is already open on the same anchor. */
export function togglePopover(spec: PopoverSpec): void {
  if (current && current.spec.anchor === spec.anchor) { closePopover(true); return; }
  openPopover(spec);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function meter(filled: number): HTMLSpanElement {
  const m = el('span', 'co-meter');
  m.setAttribute('aria-hidden', 'true');
  for (let i = 1; i <= 5; i++) {
    const b = el('i', i <= filled ? 'on' : '');
    b.style.height = `${3 + i * 2}px`;
    m.appendChild(b);
  }
  return m;
}

/** Opens a menu under (or over) `spec.anchor` and focuses the ticked item. */
export function openPopover(spec: PopoverSpec): void {
  closePopover(false);
  const menu = el('div', 'co-pop co-ui');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', spec.label);
  menu.tabIndex = -1;
  const head = el('div', 'co-pop-title', spec.label);
  head.setAttribute('aria-hidden', 'true');
  menu.appendChild(head);
  const buttons: HTMLButtonElement[] = [];
  spec.items.forEach((it, i) => {
    const b = el('button', `co-pop-item${it.checked ? ' checked' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.dataset['id'] = it.id;
    b.setAttribute('aria-checked', String(it.checked === true));
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    b.tabIndex = -1;
    const tick = el('span', 'co-pop-tick', it.checked ? '✓' : '');
    tick.setAttribute('aria-hidden', 'true');
    const text = el('span', 'co-pop-text');
    const label = el('span', 'co-pop-label', it.label);
    text.appendChild(label);
    if (it.detail) text.appendChild(el('span', 'co-pop-detail', it.detail));
    b.append(tick, text);
    if (it.meter !== undefined) b.appendChild(meter(it.meter));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (it.disabled) return;
      choose(i);
    });
    b.addEventListener('mousemove', () => { if (document.activeElement !== b) focusAt(i); });
    buttons.push(b);
    menu.appendChild(b);
  });
  if (spec.note) {
    const note = el('div', 'co-pop-note', spec.note);
    note.id = `co-pop-note-${++seq}`;
    note.setAttribute('aria-hidden', 'true');
    menu.setAttribute('aria-describedby', note.id);
    menu.appendChild(note);
  }

  const focusAt = (i: number): void => {
    buttons.forEach((b, j) => { b.tabIndex = j === i ? 0 : -1; });
    buttons[i]?.focus({ preventScroll: false });
  };
  const choose = (i: number): void => {
    const it = spec.items[i];
    if (!it || it.disabled) return;
    closePopover(true);
    spec.onSelect(it.id);
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return; // handled by the capturing listener
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const a = menuKey(e.key, idx, spec.items);
    if (a.kind === 'none') return;
    if (a.kind === 'close') { closePopover(a.returnFocus); return; } // Tab: no preventDefault, focus moves on from the anchor
    e.preventDefault();
    e.stopPropagation();
    if (a.kind === 'focus') focusAt(a.index);
    else choose(a.index);
  });

  const onKeyCapture = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closePopover(true);
  };
  const onDown = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || spec.anchor.contains(t))) return;
    closePopover(false);
  };
  const onResize = (): void => place();
  // The anchor can move when something scrolls (a streaming conversation, say): follow it.
  const onScroll = (e: Event): void => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    place();
  };
  window.addEventListener('keydown', onKeyCapture, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);

  const place = (): void => {
    menu.style.maxHeight = '';
    const a = spec.anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const p = placePopover(a, { w: menu.offsetWidth, h: menu.offsetHeight }, { w: vw, h: vh });
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
    if (p.maxHeight !== null) menu.style.maxHeight = `${p.maxHeight}px`;
    menu.dataset['side'] = p.side;
  };

  document.body.appendChild(menu);
  spec.anchor.setAttribute('aria-haspopup', 'menu');
  spec.anchor.setAttribute('aria-expanded', 'true');
  current = {
    spec, el: menu, buttons,
    cleanup: () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    },
  };
  place();
  const start = spec.items.findIndex((it) => it.checked && !it.disabled);
  focusAt(start >= 0 ? start : Math.max(0, spec.items.findIndex((it) => !it.disabled)));
}
