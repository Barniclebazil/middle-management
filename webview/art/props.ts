/**
 * Live office-tool props, drawn per frame on top of the cached background and
 * furniture: the usage ring round the wall clock, the "BACK" plate, the wall
 * calendar's weekly bar, the manager's in-tray and badge, paper piles on
 * desks, plan notes on the whiteboard, the desk phone's line lights, the
 * bookshelf filled to the library's size, the hover drawer of the filing
 * cabinets and the hover outline. Each one is cached by state where that helps.
 *
 * Every function takes (ox, oy) = the map origin on the target context
 * (0, 0 when drawing in map space), like `drawClockHands`.
 */
import { C, OUTLINE } from './palette.ts';
import type { Color } from './raster.ts';
import { ctx2d, makeCanvas, mix, rect, withAlpha } from './raster.ts';
import { drawPixelText, measurePixelText } from './font.ts';
import * as F from './furniture.ts';
import type { UsageLevel } from './furniture.ts';
import { PROP_ANCHORS, calendarRect, clockAnchor, inTrayAnchor, phoneAnchor, whiteboardRect } from './office-map.ts';
import type { PropAnchor } from './office-map.ts';
import type { McpStatus } from '../../src/shared/protocol.ts';

export type { UsageLevel } from './furniture.ts';

/** State of one MCP "line" on the desk phone: the protocol's `McpStatus`. */
export type PhoneLightState = McpStatus;

/** Plan counts pinned on the whiteboard, one column each. */
export interface PlanNoteCounts { pending: number; approved: number; rejected: number }

/** Highlight colour shared with the worker hover outline (`engine/scene.ts`). */
export const PROP_HIGHLIGHT = '#f2c94c';

const ringCache = new Map<string, HTMLCanvasElement>();
const RING_R = 10;

/**
 * A ring round the wall clock showing the 5-hour window: filled clockwise
 * from twelve to `pct` (0-100) in green / amber / red over a faint groove.
 * `unknown` or a null pct draws nothing.
 */
export function drawUsageRing(ctx: CanvasRenderingContext2D, ox: number, oy: number, pct: number | null, level: UsageLevel): void {
  if (pct === null || !Number.isFinite(pct) || level === 'unknown') return;
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const key = `${level}:${p}`;
  let c = ringCache.get(key);
  if (!c) {
    const size = RING_R * 2 + 1;
    c = makeCanvas(size, size);
    const g = ctx2d(c);
    const [main, light, dark] = F.LEVEL_COLORS[level];
    const groove = withAlpha(OUTLINE, 0.16);
    for (let dy = -RING_R; dy <= RING_R; dy++) {
      for (let dx = -RING_R; dx <= RING_R; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= 8.3 || d > 9.85) continue;
        let a = Math.atan2(dx, -dy);
        if (a < 0) a += Math.PI * 2;
        const filled = a / (Math.PI * 2) < p / 100 || (p >= 100);
        let col: Color = groove;
        if (filled) col = d > 9.3 ? dark : (dy < 0 && dx < 0 ? light : main);
        rect(g, dx + RING_R, dy + RING_R, 1, 1, col);
      }
    }
    // a tick at twelve so an empty ring still reads as a gauge
    rect(g, RING_R, 0, 1, 2, dark);
    ringCache.set(key, c);
  }
  ctx.drawImage(c, ox + clockAnchor.x - RING_R, oy + clockAnchor.y - RING_R);
}

/** Where the "BACK" plate hangs: its cord starts just under the clock. Sort it right after the filing cabinets below. */
export const BACK_SIGN_SORT_Y = 4 * 16 + 0.5;

/** The map-px box the "BACK" card covers, cord included (speech bubbles keep clear of it). */
export function backSignBox(text: string): { x: number; y: number; w: number; h: number } {
  const w = measurePixelText(text.toUpperCase()).w + 7;
  const top = clockAnchor.y + clockAnchor.r + 1;
  return { x: Math.round(clockAnchor.x - w / 2), y: top, w, h: clockAnchor.y + 13 + 10 - top };
}

/**
 * A small card hanging on a cord under the wall clock, e.g. "BACK 17:30"
 * (`text` is drawn as given, upper-cased). Draw it after the filing cabinets
 * (sortY `BACK_SIGN_SORT_Y`) so it hangs in front of them.
 */
export function drawBackSign(ctx: CanvasRenderingContext2D, ox: number, oy: number, text: string): void {
  const label = text.toUpperCase();
  const box = backSignBox(label);
  const w = box.w;
  const h = 9;
  const cx = ox + clockAnchor.x;
  const x = ox + box.x;
  const y = oy + clockAnchor.y + 13;
  const cordTop = oy + box.y;
  // cord: from the clock's bottom to both top corners
  const cord = mix(C.charcoal, C.wallDark, 0.3);
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) rect(ctx, Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1, cord);
  };
  line(cx, cordTop, x + 3, y);
  line(cx, cordTop, x + w - 4, y);
  rect(ctx, cx, cordTop, 1, 1, C.metalDark);
  // card
  rect(ctx, x + 1, y + h, w - 1, 1, withAlpha(OUTLINE, 0.35));
  rect(ctx, x, y, w, h, C.redDark);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, '#fbf6e8');
  rect(ctx, x + 1, y + 1, w - 2, 1, '#ffffff');
  rect(ctx, x + 3, y, 1, 1, C.metalLight);
  rect(ctx, x + w - 4, y, 1, 1, C.metalLight);
  drawPixelText(ctx, label, x + 4, y + 2, C.redDark);
}

/** Repaints the wall calendar with the weekly window: the current week fills to `pct` (0-100) in the level colour. */
export function drawCalendar(ctx: CanvasRenderingContext2D, ox: number, oy: number, pct: number | null, level: UsageLevel): void {
  ctx.drawImage(F.calendarSprite(pct, level), ox + calendarRect.x, oy + calendarRect.y);
}

/**
 * The manager's in-tray with `count` items (papers stack up; an urgent item
 * shows a red tab) and a count badge (blue, or red and pulsing with `t` when
 * urgent). `part` draws only the tray or only the badge, so the scene can
 * draw the tray under the manager and the badge above the desk front.
 */
export function drawInTray(
  ctx: CanvasRenderingContext2D, ox: number, oy: number, count: number, urgent: boolean, t = 0, part: 'all' | 'tray' | 'badge' = 'all',
): void {
  if (part !== 'badge') F.drawInTrayAt(ctx, ox + inTrayAnchor.x, oy + inTrayAnchor.y, count, urgent);
  if (part !== 'tray') F.drawTrayBadgeAt(ctx, ox + inTrayAnchor.x + 11, oy + inTrayAnchor.y + 2, count, urgent, t);
}

/** The in-tray badge's depth key: just after the manager's desk front. */
export const IN_TRAY_BADGE_SORT_Y = 5 * 16 + 31.5;

/**
 * A pile of paper on a desk whose bottom-centre is at (x, y) in target
 * pixels (see `deskPileAnchors`): 0-4 sheet bundles; `warn` leans it and adds
 * a red flag. Draw it right after that desk's desk top.
 */
export function drawDeskPile(ctx: CanvasRenderingContext2D, x: number, y: number, sheets: number, warn: boolean): void {
  F.drawPileAt(ctx, x, y, sheets, warn);
}

const NOTE_COLORS: Readonly<Record<keyof PlanNoteCounts, readonly [Color, Color]>> = {
  pending: ['#f6dc6e', '#d2b03e'],
  approved: ['#a9dc86', '#6fae55'],
  rejected: ['#f5a6b0', '#cf6f7c'],
};
const NOTES_PER_COLUMN = 6;
const notesCache = new Map<string, HTMLCanvasElement>();

/**
 * The whiteboard as a plans board: three marker columns (waiting "?",
 * approved tick, sent back cross) with up to six sticky notes each; a column
 * with more shows a "+" on its last note.
 */
export function drawPlanNotes(ctx: CanvasRenderingContext2D, ox: number, oy: number, counts: PlanNoteCounts): void {
  const clamp = (n: number): number => Math.max(0, Math.min(NOTES_PER_COLUMN + 1, Math.floor(Number.isFinite(n) ? n : 0)));
  const k = { pending: clamp(counts.pending), approved: clamp(counts.approved), rejected: clamp(counts.rejected) };
  const key = `${k.pending}:${k.approved}:${k.rejected}`;
  let c = notesCache.get(key);
  if (!c) {
    const r = whiteboardRect;
    c = makeCanvas(r.w, r.h);
    const g = ctx2d(c);
    const colW = Math.floor((r.w - 2) / 3);
    const marker = '#c9ced6';
    // column rules
    for (let i = 1; i < 3; i++) rect(g, i * colW + 1, 2, 1, r.h - 4, marker);
    const cols: (keyof PlanNoteCounts)[] = ['pending', 'approved', 'rejected'];
    cols.forEach((id, i) => {
      const x0 = i * colW + 1;
      const cx = x0 + Math.floor(colW / 2);
      // header glyph
      if (id === 'pending') drawPixelText(g, '?', cx - 1, 1, '#2f5fb3');
      else if (id === 'approved') for (const [dx, dy] of [[-2, 3], [-1, 4], [0, 5], [1, 4], [2, 3], [3, 2], [4, 1]] as const) rect(g, cx + dx - 1, dy, 1, 1, '#2f8a4a');
      else for (let j = 0; j < 5; j++) { rect(g, cx - 2 + j, 1 + j, 1, 1, '#c23b3b'); rect(g, cx + 2 - j, 1 + j, 1, 1, '#c23b3b'); }
      rect(g, x0 + 2, 7, colW - 4, 1, marker);
      // notes, three to a row
      const n = Math.min(NOTES_PER_COLUMN, k[id]);
      const [face, shade] = NOTE_COLORS[id];
      const startX = x0 + Math.floor((colW - 14) / 2);
      for (let j = 0; j < n; j++) {
        const nx = startX + (j % 3) * 5;
        const ny = 9 + Math.floor(j / 3) * 5;
        rect(g, nx, ny, 4, 3, face);
        rect(g, nx, ny + 3, 4, 1, shade);
        rect(g, nx + 1, ny + 1, 2, 1, mix(face, shade, 0.6));
      }
      if (k[id] > NOTES_PER_COLUMN) {
        // "+" on the last note: there are more than fit
        const nx = startX + 10;
        const ny = 14;
        rect(g, nx, ny, 4, 3, face);
        rect(g, nx + 1, ny, 1, 3, C.ink);
        rect(g, nx, ny + 1, 3, 1, C.ink);
      }
    });
    notesCache.set(key, c);
  }
  ctx.drawImage(c, ox + whiteboardRect.x, oy + whiteboardRect.y);
}

/** Drops the cached usage rings and plan-note boards so they redraw from `C` (see `invalidateArtCaches`). */
export function clearPropCaches(): void {
  ringCache.clear();
  notesCache.clear();
}

/** For tests: how many rings and note boards are cached. */
export function propCacheSize(): number {
  return ringCache.size + notesCache.size;
}

/** How many line lights the desk phone has. More servers than this show a "+" in the phone's corner. */
export const PHONE_LINES = F.PHONE_LIGHTS.length;

/** Line light colours. `pending` blinks between its two; `disabled` is off (the sprite's dark light). */
export const PHONE_LIGHT_COLORS: Readonly<Record<Exclude<McpStatus, 'disabled'>, Color>> & { pendingDim: Color; more: Color } = {
  connected: '#5fe06a',
  pending: '#ffb432',
  pendingDim: '#8a5d1c',
  failed: '#ff5446',
  needsAuth: '#4aa8ff',
  unknown: '#8b867c',
  more: '#ece6d6',
};

/** Which status tints the overflow "+" (the most pressing of the hidden ones). */
const MORE_RANK: readonly McpStatus[] = ['failed', 'needsAuth', 'pending'];

/** Half a slow blink (ms) for `pending` lights. */
const PHONE_BLINK_MS = 800;

function phoneLightColor(s: McpStatus, blinkOn: boolean): Color | null {
  if (s === 'disabled') return null;
  if (s === 'pending') return blinkOn ? PHONE_LIGHT_COLORS.pending : PHONE_LIGHT_COLORS.pendingDim;
  return PHONE_LIGHT_COLORS[s] ?? PHONE_LIGHT_COLORS.unknown;
}

/**
 * Lights the desk phone's line buttons, one per MCP server, in the order
 * given: connected green, pending amber (blinking slowly when `t`, the scene
 * clock in ms, is given), failed red, needs-auth blue, unknown dim, disabled
 * off. Only `PHONE_LINES` fit; with more, a small "+" shows in the phone's
 * bottom-right corner, tinted like the most pressing hidden server (failed,
 * needs auth, pending), else off-white. An empty list leaves the phone as drawn.
 */
export function drawPhoneLights(ctx: CanvasRenderingContext2D, ox: number, oy: number, states: readonly PhoneLightState[], t?: number): void {
  const blinkOn = t === undefined || Math.floor(t / PHONE_BLINK_MS) % 2 === 0;
  const x0 = ox + phoneAnchor.x;
  const y0 = oy + phoneAnchor.y;
  F.PHONE_LIGHTS.forEach((p, i) => {
    const s = states[i];
    if (!s) return;
    const col = phoneLightColor(s, blinkOn);
    // Two pixels tall (the line key above the light glows too): a single pixel is lost at the office's usual scale.
    if (col) rect(ctx, x0 + p.x, y0 + p.y - 1, 1, 2, col);
  });
  if (states.length <= PHONE_LINES) return;
  const hidden = states.slice(PHONE_LINES);
  const worst = MORE_RANK.find((s) => hidden.includes(s));
  const col = worst ? PHONE_LIGHT_COLORS[worst as Exclude<McpStatus, 'disabled'>] : PHONE_LIGHT_COLORS.more;
  const m = F.PHONE_MORE;
  rect(ctx, x0 + m.x - 1, y0 + m.y, 3, 1, col);
  rect(ctx, x0 + m.x, y0 + m.y - 1, 1, 3, col);
}

/** How many books fill the bookshelf (`drawBookshelf` / `bookshelfFor` with this many or more is the full shelf). */
export const BOOKSHELF_SLOTS = F.BOOKSHELF_SLOTS;

/**
 * The bookshelf sprite for `count` skills and commands: 0 is empty shelves,
 * then one book per item (top shelf first, the last book on a part-filled
 * shelf leaning over), full from `BOOKSHELF_SLOTS`. Seeded, so a count always
 * looks the same; `undefined` is the classic full shelf. Cached per count.
 */
export function bookshelfFor(count?: number): HTMLCanvasElement {
  return F.bookshelfSprite(count);
}

/** Draws the bookshelf for `count` items at its map place (see `bookshelfFor`); the scene swaps the furniture sprite instead. */
export function drawBookshelf(ctx: CanvasRenderingContext2D, ox: number, oy: number, count?: number): void {
  ctx.drawImage(bookshelfFor(count), ox + PROP_ANCHORS.bookshelf.x, oy + PROP_ANCHORS.bookshelf.y);
}

/** Filing cabinets the hover drawer can open in, left to right (the `filingCabinets` prop). */
export const HOVER_CABINET_IDS: readonly string[] = ['filing-21', 'filing-22', 'filing-23'];
/** The cabinet whose drawer opens when the hover doesn't say which: the middle one. */
export const DEFAULT_HOVER_CABINET = 'filing-22';
/** How far a hovered drawer slides out (px), and how long each pixel takes. */
export const CABINET_DRAWER_STEPS = F.CABINET_DRAWER_STEPS;
export const CABINET_DRAWER_MS_PER_PX = 45;

/** A filing cabinet with its top drawer out `step` px (1-3); cached per step. */
export function cabinetAjarSprite(step: number): HTMLCanvasElement {
  return F.filingCabinetAjarSprite(step);
}

/**
 * Hover outline for a prop: a 1px highlight ring just outside `rect` (the
 * worker highlight's colour) with a soft dark halo so it reads on light walls
 * too, and a faint tint inside.
 */
export function drawPropOutline(ctx: CanvasRenderingContext2D, ox: number, oy: number, r: PropAnchor): void {
  const x = Math.round(ox + r.x) - 1;
  const y = Math.round(oy + r.y) - 1;
  const w = Math.round(r.w) + 2;
  const h = Math.round(r.h) + 2;
  const halo = withAlpha(OUTLINE, 0.45);
  // halo (outside the ring)
  rect(ctx, x + 1, y - 1, w - 2, 1, halo);
  rect(ctx, x + 1, y + h, w - 2, 1, halo);
  rect(ctx, x - 1, y + 1, 1, h - 2, halo);
  rect(ctx, x + w, y + 1, 1, h - 2, halo);
  // ring with cut corners
  rect(ctx, x + 1, y, w - 2, 1, PROP_HIGHLIGHT);
  rect(ctx, x + 1, y + h - 1, w - 2, 1, PROP_HIGHLIGHT);
  rect(ctx, x, y + 1, 1, h - 2, PROP_HIGHLIGHT);
  rect(ctx, x + w - 1, y + 1, 1, h - 2, PROP_HIGHLIGHT);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, withAlpha(PROP_HIGHLIGHT, 0.1));
}
