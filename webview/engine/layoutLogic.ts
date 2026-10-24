/**
 * The office strip (v0.5, task 9.2): the pure layout decisions for a wide, short office view, such as the panel moved to the
 * top of the window (about 2000 x 400 px). No DOM, so it is tested in Node and compiles under the root tsconfig.
 *
 * A strip is laid out in three columns, nothing floating over the art:
 *
 *   | rail (44 px) | the map, at full height | staff list (260-340 px; wider when the map leaves width over, task 10.1) |
 *
 * The rail is the icon bar standing on its end (`iconBar.ts`, `railItems`), the staff list is the roster in its `strip` mode
 * (`roster.ts`). A panel (In-tray, Plans, the Front desk...) docks on the right over the staff list, as the drawer does in
 * every layout. In a strip, clicking a worker (on the map or in the list) opens their case in an editor tab (`openCaseTab`);
 * narrower views keep the in-office drawer (`openCase`). See docs/manager-mode.md section 18.
 *
 * When is a view a strip? All three of:
 * - width >= 2 x height (`STRIP_MIN_ASPECT`): a view that is less than twice as wide as it is tall has room above or below the
 *   map, and the classic layout (the bar on top, the roster beside or below) uses it; from 2:1 the spare room is at the sides;
 * - height <= 600 px (`STRIP_MAX_H`): taller views (an editor tab, a big bottom panel) keep the classic layout, and a short
 *   view is where the floating bar hurts (it covers the top of the map and its sign);
 * - width >= 1000 px (`STRIP_MIN_W`): the rail (44) and the narrowest list (260) leave the map about 700 px, so it is still
 *   fitted at about 1x (736 x 272; the 1-device-px snap may crop a few px of wall, as `camera.ts` allows) instead of switching
 *   to the pan camera; it also keeps a drawer docked, not overlaid
 *   (`drawerLogic.ts` overlays it below 700 px).
 * The test uses the whole webview (window.innerWidth/innerHeight), not the room a docked drawer leaves, so opening a panel never
 * flips the layout.
 */
import { RAIL_W } from './iconBarLogic.ts';

/** A strip is at least this many times as wide as it is tall. */
export const STRIP_MIN_ASPECT = 2;
/** ...at most this tall (CSS px)... */
export const STRIP_MAX_H = 600;
/** ...and at least this wide (CSS px). */
export const STRIP_MIN_W = 1000;
/** The staff list's width in a strip: this share of the width, kept between the two limits below. */
export const STRIP_LIST_SHARE = 0.17;
export const STRIP_LIST_MIN_W = 260;
export const STRIP_LIST_MAX_W = 340;

export { RAIL_W };

/** True when a webview `w` x `h` CSS px is laid out as a strip (see the file comment for the thresholds). */
export function isStrip(w: number, h: number): boolean {
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return false;
  return w >= STRIP_MIN_W && h <= STRIP_MAX_H && w >= STRIP_MIN_ASPECT * h;
}

/**
 * True when the webview is laid out as a strip. View mode never is: it has no rail and no staff list, so the whole canvas is the
 * map's room at any size, and the strip's three columns would only waste the width.
 */
export function stripFor(w: number, h: number, viewMode: boolean): boolean {
  return !viewMode && isStrip(w, h);
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface StripLayout {
  /** The icon rail, down the left edge. */
  rail: Rect;
  /** The room the office map is fitted into (the map itself is centred in it by `computeView`). */
  map: Rect;
  /** The staff list on the right; null while a drawer is docked over it. */
  list: Rect | null;
}

/** The staff list's width in a strip `w` px wide. */
export function stripListWidth(w: number): number {
  return Math.max(STRIP_LIST_MIN_W, Math.min(STRIP_LIST_MAX_W, Math.round(w * STRIP_LIST_SHARE)));
}

/**
 * Task 10.1, the leftover width. The map is about 2.7 times as wide as it is tall, so in a very wide strip (2000 x 400) it
 * fills the height long before the width, and its middle column had about 270 px of empty letterbox on each side. That width
 * goes to the staff list instead (the map keeps its full-height size, flush against the rail): the list grows up to
 * `STRIP_LIST_WIDE_MAX_W`, splits into columns of at least `STRIP_COL_MIN_W` (at most `STRIP_COLS_MAX`), and a column that
 * is at least `STRIP_DETAIL_COL_W` wide shows a third line per worker (model, effort, context, cost). Past the cap the rest is
 * left as an even margin round the map. A strip with no spare width (1200 x 500) keeps the plain 17% list.
 */
export const STRIP_LIST_WIDE_MAX_W = 1200;
export const STRIP_COL_MIN_W = 300;
export const STRIP_COLS_MAX = 3;
export const STRIP_DETAIL_COL_W = 360;
/** Heights (CSS px) the column choice plans with: the list header, a plain row (2 lines) and a row with the detail line. */
export const STRIP_HEAD_H = 34;
export const STRIP_ROW_H = 40;
export const STRIP_DETAIL_ROW_H = 58;
/** A strip list column narrower than this leaves the branch out of its rows (it stays in the row's tooltip). */
export const STRIP_BRANCH_COL_W = 320;

/**
 * The list's width in a strip `w` x `h` when the map is `mapAspect` (width / height) and fills the height: the 17% list plus
 * whatever the map cannot use, up to the cap. `mapAspect` 0 (unknown) gives the plain `stripListWidth`.
 */
export function stripListWidthFor(w: number, h: number, mapAspect = 0): number {
  const base = stripListWidth(w);
  if (!(mapAspect > 0) || !(h > 0)) return base;
  const spare = Math.floor(w - RAIL_W - base - Math.ceil(h * mapAspect));
  return spare > 0 ? Math.max(base, Math.min(STRIP_LIST_WIDE_MAX_W, base + spare)) : base;
}

/**
 * How the staff list lays out `count` rows in a list `listW` x `listH` px: as many columns of at least `STRIP_COL_MIN_W` as fit
 * (at most `STRIP_COLS_MAX`); the detail line only when a column is at least `STRIP_DETAIL_COL_W` wide and the taller rows
 * still fit without scrolling (so a crowded office keeps every row in view and drops the detail first); `narrow` when a
 * column is too narrow for the branch.
 */
export function stripListColumns(listW: number, listH: number, count: number): { cols: number; detail: boolean; narrow: boolean } {
  const cols = Math.max(1, Math.min(STRIP_COLS_MAX, Math.floor(listW / STRIP_COL_MIN_W)));
  const colW = listW / cols;
  const rows = Math.ceil(Math.max(0, count) / cols);
  const detail = colW >= STRIP_DETAIL_COL_W && STRIP_HEAD_H + rows * STRIP_DETAIL_ROW_H <= listH;
  return { cols, detail, narrow: colW < STRIP_BRANCH_COL_W };
}

/** Below the office (a tall view, such as the office in an editor tab), the staff list's columns: at least this wide, this far apart. */
export const BELOW_COL_MIN_W = 300;
export const BELOW_COL_GAP = 10;
/** The list header's height below the office. */
export const BELOW_HEAD_H = 24;

/**
 * True when the staff list below the office shows the detail line: a tall view has height to spare under its rows (task 10.1:
 * at 1400 x 900 the list used 90 of its 300 px), so the rows grow by the model, effort, context and cost line when all of
 * them still fit without scrolling in a list `listW` x `listH` px with `count` rows.
 */
export function belowListDetail(listW: number, listH: number, count: number): boolean {
  const cols = Math.max(1, Math.floor((listW + BELOW_COL_GAP) / (BELOW_COL_MIN_W + BELOW_COL_GAP)));
  return count > 0 && BELOW_HEAD_H + Math.ceil(count / cols) * STRIP_DETAIL_ROW_H <= listH;
}

/**
 * The three columns of a strip `w` x `h`. `dockW` is the width of a drawer or case file docked on the right (0 when none):
 * it covers the staff list, so the list is left out. The map keeps the room it had beside the list, so opening or closing a
 * panel never moves the office; only a drawer wider than the list narrows the map's room (to the room up to the drawer).
 * `mapAspect` (the map's width / height) lets the list take the width the map cannot use (`stripListWidthFor`); without it
 * the list is the plain 17%.
 */
export function stripLayout(w: number, h: number, dockW = 0, mapAspect = 0): StripLayout {
  const rail: Rect = { x: 0, y: 0, w: RAIL_W, h };
  const dock = Math.max(0, dockW);
  const lw = stripListWidthFor(w, h, mapAspect);
  const mapW = Math.max(0, w - RAIL_W - lw);
  if (dock > 0) return { rail, map: { x: RAIL_W, y: 0, w: Math.min(mapW, Math.max(0, w - RAIL_W - dock)), h }, list: null };
  return { rail, map: { x: RAIL_W, y: 0, w: mapW, h }, list: { x: w - lw, y: 0, w: lw, h } };
}

/** True when two rectangles overlap by more than `slack` px each way (touching edges do not count). */
export function overlaps(a: Rect, b: Rect, slack = 0.5): boolean {
  return a.x + a.w > b.x + slack && b.x + b.w > a.x + slack && a.y + a.h > b.y + slack && b.y + b.h > a.y + slack;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Where a worker's case opens, and the staff list's x

/**
 * Where clicking a worker (on the map or their staff row) opens their case: an editor tab in a strip, and also in a narrow
 * view when their tab is already open (the click focuses it instead of showing the case twice); else the in-office drawer.
 */
export function caseTarget(strip: boolean, hasTab: boolean): 'tab' | 'drawer' {
  return strip || hasTab ? 'tab' : 'drawer';
}

/** What the send-home rule needs to know about a worker (a subset of `AgentView`). */
export interface SendHomeCandidate {
  kind: string;
  status: string;
  activity: string;
  pending?: unknown;
}

/**
 * True when the staff row offers the x (send home): a main worker who is idle by the host's rule (docs section 18: `status`
 * idle or done, nothing pending, not knocking). Temps leave with their lead. The host checks again and refuses a busy worker.
 */
export function canSendHome(a: SendHomeCandidate | null | undefined): boolean {
  if (!a || a.kind !== 'main') return false;
  if (a.status !== 'idle' && a.status !== 'done') return false;
  return !a.pending && a.activity !== 'needsYou';
}

/** Max case tabs the host reports (`LIMITS.caseTabs`); a longer list is cut. */
export const CASE_TABS_MAX = 20;

/** The ids of a `caseTabs` message, cleaned: strings only, no blanks or repeats, at most `CASE_TABS_MAX`, in order. */
export function caseTabIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== 'string' || id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= CASE_TABS_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Keyboard stops over the map's props

/**
 * The screen rectangle (CSS px) of a focusable stop over a prop whose map rectangle is `anchor`, in a view of `scale` CSS px
 * per map px with the map's top-left at (`ox`, `oy`), or null when less than half of it is inside `clip` (the visible map
 * room): a stop you cannot see is left out of the Tab order.
 */
export function propStopRect(anchor: Rect, view: { scale: number; ox: number; oy: number }, clip: Rect): Rect | null {
  const r: Rect = { x: view.ox + anchor.x * view.scale, y: view.oy + anchor.y * view.scale, w: anchor.w * view.scale, h: anchor.h * view.scale };
  const x0 = Math.max(r.x, clip.x);
  const y0 = Math.max(r.y, clip.y);
  const x1 = Math.min(r.x + r.w, clip.x + clip.w);
  const y1 = Math.min(r.y + r.h, clip.y + clip.h);
  if (x1 <= x0 || y1 <= y0 || r.w <= 0 || r.h <= 0) return null;
  if ((x1 - x0) * (y1 - y0) < 0.5 * r.w * r.h) return null;
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/**
 * Where a stop over a prop that is scrolled out of view (the pan camera: the sidebar, view mode at sidebar width) waits: its
 * screen rectangle slid inside `clip`, on the edge nearest the prop. Such a stop stays in the Tab order (task 10.1: before,
 * it dropped out, and in view mode at 360 px the Front desk, the only stop, could not be reached from the keyboard); focusing
 * it pans the camera to the prop (`propFocusCamera`), which brings the stop back over it.
 */
export function parkedStopRect(anchor: Rect, view: { scale: number; ox: number; oy: number }, clip: Rect): Rect {
  const w = Math.max(1, Math.min(Math.round(anchor.w * view.scale), clip.w));
  const h = Math.max(1, Math.min(Math.round(anchor.h * view.scale), clip.h));
  const x = Math.round(Math.max(clip.x, Math.min(clip.x + clip.w - w, view.ox + anchor.x * view.scale)));
  const y = Math.round(Math.max(clip.y, Math.min(clip.y + clip.h - h, view.oy + anchor.y * view.scale)));
  return { x, y, w, h };
}

/** The camera centre (map px) that brings a prop into view: its middle. The camera clamps it to the map's edges. */
export function propFocusCentre(anchor: Rect): { cx: number; cy: number } {
  return { cx: anchor.x + anchor.w / 2, cy: anchor.y + anchor.h / 2 };
}

/**
 * The map-px column range (inclusive left, exclusive right) a narrow view frames while the boss sulks out of his office
 * (a Fable spell): his glass office and the spot where he sulks. The caller derives both from the map's points of interest.
 */
export interface FrameBox { x0: number; x1: number }

/**
 * The horizontal focus (map px at the middle of the view) for the pan camera while a box must stay in sight. `visibleW` is
 * how much map the view shows (view width / scale). When the default framing already shows the whole box nothing changes;
 * when the view is wide enough the box is centred; when it is not, the box's far (right) end is kept in view, so the sulking
 * boss is on screen and as much of his office as fits comes with him. The caller's `computeView` clamps to the map's edges.
 */
export function framingFocusX(visibleW: number, box: FrameBox, defaultFocusX: number): number {
  const half = visibleW / 2;
  if (defaultFocusX - half <= box.x0 && defaultFocusX + half >= box.x1) return defaultFocusX;
  if (box.x1 - box.x0 <= visibleW) return (box.x0 + box.x1) / 2;
  return box.x1 - half;
}

/** One step of a frame-rate independent ease: `current` moves towards `target` (time constant `tauMs`), snapping when close. */
export function easeToward(current: number, target: number, dtMs: number, tauMs: number, snap = 0.25): number {
  const d = target - current;
  if (Math.abs(d) <= snap) return target;
  return current + d * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}
