/**
 * Pure parts of the popover menu (`popover.ts`): the keyboard reducer and the
 * placement maths. DOM-free so they can be unit-tested with plain Node.
 */

/** What a key press in the menu does. */
export type MenuAction =
  | { kind: 'focus'; index: number }
  | { kind: 'select'; index: number }
  | { kind: 'close'; returnFocus: boolean }
  | { kind: 'none' };

/**
 * The keyboard reducer. `index` is the focused item (-1 for none). Arrows wrap,
 * Home/End jump, a letter moves to the next item starting with it. Disabled
 * items can be focused (so their reason can be read) but not selected.
 * Tab closes the menu and returns focus to the anchor; the browser then moves
 * focus on from there.
 */
export function menuKey(key: string, index: number, items: readonly { label: string; disabled?: boolean }[]): MenuAction {
  const n = items.length;
  if (key === 'Escape') return { kind: 'close', returnFocus: true };
  if (key === 'Tab') return { kind: 'close', returnFocus: true };
  if (!n) return { kind: 'none' };
  switch (key) {
    case 'ArrowDown': return { kind: 'focus', index: index < 0 ? 0 : (index + 1) % n };
    case 'ArrowUp': return { kind: 'focus', index: index < 0 ? n - 1 : (index - 1 + n) % n };
    case 'Home': case 'PageUp': return { kind: 'focus', index: 0 };
    case 'End': case 'PageDown': return { kind: 'focus', index: n - 1 };
    case 'Enter': case ' ': case 'Spacebar':
      return index >= 0 && index < n && !items[index]!.disabled ? { kind: 'select', index } : { kind: 'none' };
    default: break;
  }
  if (key.length === 1 && /\S/.test(key)) {
    const k = key.toLowerCase();
    for (let step = 1; step <= n; step++) {
      const j = ((index < 0 ? -1 : index) + step + n) % n;
      if (items[j]!.label.trim().toLowerCase().startsWith(k)) return { kind: 'focus', index: j };
    }
  }
  return { kind: 'none' };
}

/** A rectangle in viewport pixels. */
export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Where the popover goes: below the anchor, left-aligned with it, unless it
 * doesn't fit below and fits (or fits better) above. Kept `margin` px inside
 * the viewport; `maxHeight` is set when neither side has room for all of it.
 */
export function placePopover(anchor: Rect, size: { w: number; h: number }, viewport: { w: number; h: number }, gap = 4, margin = 8): { left: number; top: number; side: 'below' | 'above'; maxHeight: number | null } {
  const below = viewport.h - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  let side: 'below' | 'above' = 'below';
  if (size.h > below && (size.h <= above || above > below)) side = 'above';
  const room = Math.max(40, side === 'below' ? below : above);
  const h = Math.min(size.h, room);
  const top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - h;
  const maxLeft = viewport.w - margin - size.w;
  const left = Math.max(margin, Math.min(anchor.left, maxLeft));
  return { left: Math.round(left), top: Math.round(top), side, maxHeight: size.h > room ? Math.floor(room) : null };
}
