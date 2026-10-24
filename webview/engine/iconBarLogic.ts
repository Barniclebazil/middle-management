/**
 * The icon bar's pure logic (no DOM, so it is tested in Node and compiles under the root tsconfig): the items, the
 * collapse rule, the roving-tabindex reducer and the badge words.
 */
import type { Round, RoundBPanelId } from './hotspots.ts';

/** Below this width (CSS px) the bar shows only the Directory button. */
export const ICONBAR_COLLAPSE_BELOW = 480;
/** From this width the items also show their text labels (the Round B ones stay icons: their names would not fit). */
export const ICONBAR_LABELS_FROM = 800;

export type IconBarItemId = 'inbox' | 'plans' | 'usage' | 'frontdesk' | 'directory' | 'newTask' | RoundBPanelId;

export interface IconBarItem {
  id: IconBarItemId;
  label: string;
  /** Icon name for the factory. */
  icon: string;
  /** The office prop that is highlighted while the item is hovered or focused (ids as in `hotspots.ts`). */
  prop: string | null;
  /** Toggles a panel (shows `aria-pressed`); `New task` opens the memo instead. */
  panel: boolean;
  /** The release round that adds the item (Round B items appear only when Round B is enabled). */
  round: Round;
  /** Stays an icon when the bar shows labels: there is not room for every name. The name is still its tooltip and accessible name. */
  compact?: true;
  /** Starts a new group: a thin divider and a little space before it. */
  groupStart?: true;
}

/**
 * Every item, in order: Round A (In-tray, Plans, Usage, Front desk, Directory, New task), then the Round B tools as a compact
 * group (File room, Training library, Phone, Office handbook, Temp agency), as in the Directory. Ids match the panel ids and
 * `directoryEntries` (`newTask` opens the memo).
 */
export const ICONBAR_ITEMS: readonly IconBarItem[] = [
  { id: 'inbox', label: 'In-tray', icon: 'inTray', prop: 'inTray', panel: true, round: 'A' },
  { id: 'plans', label: 'Plans', icon: 'plans', prop: 'whiteboard', panel: true, round: 'A' },
  { id: 'usage', label: 'Usage', icon: 'usage', prop: 'clock', panel: true, round: 'A' },
  { id: 'frontdesk', label: 'Front desk', icon: 'bell', prop: 'frontDesk', panel: true, round: 'A' },
  { id: 'directory', label: 'Directory', icon: 'directory', prop: 'directoryBoard', panel: true, round: 'A' },
  { id: 'newTask', label: 'New task', icon: 'newTask', prop: null, panel: false, round: 'A' },
  { id: 'files', label: 'File room', icon: 'files', prop: 'filingCabinets', panel: true, round: 'B', compact: true, groupStart: true },
  { id: 'library', label: 'Training library', icon: 'library', prop: 'bookshelf', panel: true, round: 'B', compact: true },
  { id: 'phone', label: 'Phone', icon: 'phone', prop: 'phone', panel: true, round: 'B', compact: true },
  { id: 'handbook', label: 'Office handbook', icon: 'handbook', prop: 'noticeBoard', panel: true, round: 'B', compact: true },
  { id: 'agency', label: 'Temp agency', icon: 'agency', prop: 'tempAgency', panel: true, round: 'B', compact: true },
];

/** The items for the enabled rounds, in order. */
export function iconBarItems(rounds: ReadonlySet<Round>): IconBarItem[] {
  return ICONBAR_ITEMS.filter((i) => rounds.has(i.round));
}

export type IconBarMode = 'collapsed' | 'icons' | 'labelled';

/** How the bar looks at a given width. */
export function iconBarMode(width: number): IconBarMode {
  if (width < ICONBAR_COLLAPSE_BELOW) return 'collapsed';
  return width >= ICONBAR_LABELS_FROM ? 'labelled' : 'icons';
}

/** The bar's gap to the webview's left and right edges (CSS px). */
export const ICONBAR_EDGE = 8;

/**
 * The room the bar may take in a webview `width` wide: the width less its edge gaps and `reserve`, the space kept free on the
 * right for the floating "+ New task" button (its width plus a gap; 0 when it is hidden). Never below one button.
 */
export function iconBarRoom(width: number, reserve = 0): number {
  return Math.max(40, Math.floor(width - 2 * ICONBAR_EDGE - Math.max(0, reserve)));
}

/**
 * `iconBarMode`, stepped down while the bar does not fit in `iconBarRoom`: the labels go when the labelled bar (`labelledWidth`,
 * its natural one-row width) is too wide, and the bar collapses to the Directory button when even the icons (`iconsWidth`) are.
 * A wider font, a "99+" badge or the floating New task button (just above 800 px, and just above 480 px for the icons) would
 * otherwise run the bar into the button or off the edge. A width of 0 means "not measured": that step keeps the plain rule.
 */
export function fittedBarMode(width: number, labelledWidth: number, iconsWidth: number, reserve = 0): IconBarMode {
  const room = iconBarRoom(width, reserve);
  let m = iconBarMode(width);
  if (m === 'labelled' && labelledWidth > 0 && labelledWidth > room) m = 'icons';
  if (m === 'icons' && iconsWidth > 0 && iconsWidth > room) m = 'collapsed';
  return m;
}

/** The items shown in a mode, in order: all of them, or only the Directory when collapsed. */
export function visibleItems(mode: IconBarMode, items: readonly IconBarItem[] = ICONBAR_ITEMS): IconBarItem[] {
  return mode === 'collapsed' ? items.filter((i) => i.id === 'directory') : [...items];
}

/**
 * The index to focus after a key press in a toolbar of `count` buttons, or null when the key is not a navigation key.
 * Left/Right (Up/Down in a `vertical` toolbar, the rail) wrap around; Home and End jump to the ends.
 */
export function rovingNext(index: number, count: number, key: string, vertical = false): number | null {
  if (count <= 0) return null;
  const at = Math.max(0, Math.min(count - 1, index));
  switch (key) {
    case vertical ? 'ArrowDown' : 'ArrowRight': return (at + 1) % count;
    case vertical ? 'ArrowUp' : 'ArrowLeft': return (at - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The rail (v0.5): the same items as a vertical strip down the left edge of a wide, short office view (see `layoutLogic.ts`).

/** The rail's width (CSS px), border included. */
export const RAIL_W = 44;
/** A rail button's size (square, CSS px). */
export const RAIL_BTN = 32;
/** Space between two rail buttons. */
export const RAIL_GAP = 2;
/** Padding above the first and below the last button. */
export const RAIL_PAD = 6;
/** Extra space before a group (the Round B tools), with the divider in it. */
export const RAIL_GROUP_GAP = 8;

/** The height (CSS px) a rail with these items needs. */
export function railHeight(items: readonly IconBarItem[]): number {
  if (items.length === 0) return 2 * RAIL_PAD;
  const groups = items.slice(1).filter((i) => i.groupStart).length;
  return 2 * RAIL_PAD + items.length * RAIL_BTN + (items.length - 1) * RAIL_GAP + groups * RAIL_GROUP_GAP;
}

/**
 * The items a rail `height` px tall shows, in order. When not all of them fit, the last ones go (the Round B tools first,
 * from the end) and the Directory always stays: it lists every tool, so it is where the rest are found (its badge adds
 * up theirs too). The rail never scrolls.
 */
export function railItems(items: readonly IconBarItem[], height: number): IconBarItem[] {
  if (railHeight(items) <= height) return [...items];
  const dir = items.find((i) => i.id === 'directory');
  for (let n = items.length - 1; n >= 1; n--) {
    let pick = items.slice(0, n);
    if (dir && !pick.includes(dir)) pick = [...pick.slice(0, n - 1), dir];
    if (railHeight(pick) <= height) return pick;
  }
  return dir ? [dir] : items.slice(0, 1);
}

/** The items a rail leaves out (shown through the Directory), in order. */
export function railOverflow(items: readonly IconBarItem[], shown: readonly IconBarItem[]): IconBarItem[] {
  return items.filter((i) => !shown.includes(i));
}

/** The Directory's label on a rail that leaves items out: "Directory (more: Office handbook, Temp agency)". */
export function railDirectoryLabel(hidden: readonly IconBarItem[]): string {
  return hidden.length ? `Directory (more: ${hidden.map((i) => i.label).join(', ')})` : 'Directory';
}

/** The id that keeps the tab stop: the current one while it is still visible, else the first visible one (null when none). */
export function resolveRoving(current: string | null, visible: readonly { id: string }[]): string | null {
  if (current && visible.some((i) => i.id === current)) return current;
  return visible[0]?.id ?? null;
}

/** A badge on an item. `urgent` = something needs the manager now (shown in the alert colour). */
export interface IconBarBadge {
  count: number;
  urgent?: boolean;
}

/** The badge a collapsed bar puts on its only button: every item's count added up, urgent when any of them is. Null when there is nothing. */
export function mergeBadges(badges: Iterable<IconBarBadge>): IconBarBadge | null {
  let count = 0;
  let urgent = false;
  for (const b of badges) {
    const n = Number.isFinite(b.count) && b.count > 0 ? Math.floor(b.count) : 0;
    count += n;
    if (n > 0 && b.urgent) urgent = true;
  }
  return count > 0 ? { count, urgent } : null;
}

/** "3", or "99+" for big counts; '' when there is nothing to show. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const n = Math.floor(count);
  return n > 99 ? '99+' : String(n);
}

/**
 * Spoken name (and tooltip) of an item: "In-tray, 3 unread, some need you". The count is the In-tray's unread items, mostly
 * finished reports from idle workers, so it says "unread" as the In-tray panel does (task 10.1: "3 waiting" with three idle
 * workers read as if they were waiting); "some need you" when any unread item blocks a worker.
 */
export function itemLabel(label: string, badge: IconBarBadge | null | undefined): string {
  const t = badge ? badgeText(badge.count) : '';
  return t ? `${label}, ${t} unread${badge?.urgent ? ', some need you' : ''}` : label;
}

/** What `onHover` is told for an item: its prop, or null. */
export function hoverTarget(item: IconBarItem): string | null {
  return item.prop;
}
