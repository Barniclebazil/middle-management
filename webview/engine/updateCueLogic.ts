/**
 * The in-office update notice, the decisions only (no DOM, no canvas): when the receptionist mentions the post from head
 * office, what a click on her or on the envelope badge opens, and which colours the badge and the head office memo take from
 * the active theme's sign (with a fallback to the built-in office whenever a theme colour would be hard to see).
 * `updateCue.ts` and `updateMemoView.ts` apply these; the words themselves come from `updateLogic.ts`.
 */
import type { UpdateInfo } from '../../src/shared/protocol.ts';
import { contrastRatio } from './frontDeskLogic.ts';
import type { TooltipContent } from './tooltip.ts';

// ---------------------------------------------------------------------------------------------------------------------
// 1. When she says it

/** The first line comes a moment after the cue appears (or changes), so it does not land on the same frame as the badge. */
export const CUE_FIRST_SAY_MS = 2_500;
/** Then again every minute and a half while the cue stays on. */
export const CUE_REPEAT_MS = 90_000;
/** When the office comes back into view she mentions it again, unless she did in the last 20 seconds. */
export const CUE_VISIBLE_GAP_MS = 20_000;
/** ...a short beat after it is shown again. */
export const CUE_VISIBLE_DELAY_MS = 1_200;

/** The receptionist's update-line clock. `line` is the line it was last scheduled for (null: no cue). Times are local ms. */
export interface CueClock {
  line: string | null;
  dueAt: number;
  lastSaidAt: number;
}

export const CUE_IDLE: CueClock = { line: null, dueAt: Infinity, lastSaidAt: -Infinity };

/**
 * One frame. `line` is what she would say now (`receptionistUpdateLine`, undefined while there is no cue). `busy` means she
 * cannot speak this frame (on the phone, looking up at the Front desk, already saying something, or speech bubbles are off):
 * a due line then waits for the next free frame instead of being dropped. Returns the next clock and the line to say, if any.
 */
export function cueTick(clock: CueClock, line: string | undefined, now: number, busy: boolean): { clock: CueClock; say: string | null } {
  if (!line) return { clock: clock.line === null ? clock : { ...CUE_IDLE, lastSaidAt: clock.lastSaidAt }, say: null };
  let c = clock;
  // A new cue, or a new line ("Reload to finish!" after the install): say it soon.
  if (c.line !== line) c = { line, dueAt: now + CUE_FIRST_SAY_MS, lastSaidAt: c.lastSaidAt };
  if (now >= c.dueAt && !busy) return { clock: { line, dueAt: now + CUE_REPEAT_MS, lastSaidAt: now }, say: line };
  return { clock: c, say: null };
}

/** The office came back into view (the webview was hidden): bring the next line forward unless she spoke very recently. */
export function cueOnVisible(clock: CueClock, now: number): CueClock {
  if (clock.line === null || now - clock.lastSaidAt < CUE_VISIBLE_GAP_MS) return clock;
  return { ...clock, dueAt: Math.min(clock.dueAt, now + CUE_VISIBLE_DELAY_MS) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. What a click opens

/** What is under the pointer, as far as the notice cares. */
export type CueTarget = 'badge' | 'receptionist' | 'counter' | 'other';

/**
 * While the cue is on, the receptionist and the envelope badge hand you the memo; the counter itself still opens the Front
 * desk (and the memo links to it), so the Front desk is never more than one click away. Without the cue the notice takes no
 * clicks at all ('pass': the office does what it always does). Same in manager and view mode.
 */
export function cueClick(cue: boolean, target: CueTarget): 'memo' | 'pass' {
  return cue && (target === 'badge' || target === 'receptionist') ? 'memo' : 'pass';
}

/**
 * What an open head office memo does when new update info arrives: keep showing it (re-rendered: available -> downloading ->
 * installed, or an error), or close because there is nothing left to say (put off with later or skip, already up to date).
 * `hasMemo` is whether `updateMemo` has a memo for the new info.
 */
export function memoAfterUpdate(u: UpdateInfo | undefined, hasMemo: boolean): 'render' | 'close' {
  if (!u || !hasMemo) return 'close';
  if (u.status === 'available' && u.hidden) return 'close';
  return 'render';
}

/** True when map point (x, y) is inside `r` (left/top edges in, right/bottom out, like `hotspotAt`). */
export function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** A screen rectangle (CSS px). */
export interface Box { x: number; y: number; w: number; h: number }

/**
 * Where the "post waiting" pointer goes when the badge is out of view (the narrow sidebar's pan camera starts far from the front
 * desk): pinned to the edge of `region` nearest the badge, `size` big, `margin` in from the edge, level with the badge where
 * it can be. Null while the badge is wholly in view (the badge itself is enough then). `side` is the edge it sits on.
 */
export function peekPlacement(badge: Box, region: Box, size: { w: number; h: number }, margin = 6): { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' } | null {
  const inside = badge.x >= region.x && badge.y >= region.y && badge.x + badge.w <= region.x + region.w && badge.y + badge.h <= region.y + region.h;
  if (inside) return null;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const minX = region.x + margin;
  const maxX = region.x + region.w - size.w - margin;
  const minY = region.y + margin;
  const maxY = region.y + region.h - size.h - margin;
  let side: 'left' | 'right' | 'top' | 'bottom';
  if (badge.x < region.x) side = 'left';
  else if (badge.x + badge.w > region.x + region.w) side = 'right';
  else side = badge.y < region.y ? 'top' : 'bottom';
  const cy = badge.y + badge.h / 2 - size.h / 2;
  const cx = badge.x + badge.w / 2 - size.w / 2;
  const x = side === 'left' ? minX : side === 'right' ? maxX : clamp(cx, minX, Math.max(minX, maxX));
  const y = side === 'top' ? minY : side === 'bottom' ? maxY : clamp(cy, minY, Math.max(minY, maxY));
  return { x: Math.round(x), y: Math.round(y), side };
}

/** The badge's hover text (the same shape as the props' tooltips). */
export function badgeTooltip(installed: boolean): TooltipContent {
  return installed
    ? { title: 'Post from head office', lines: ['The new version is installed'], hint: 'Click to read the memo' }
    : { title: 'Post from head office', lines: ['A new version of the office is out'], hint: 'Click to read the memo' };
}

/** The receptionist's tooltip while the cue is on: her usual title, a line about the post, and what a click does now. */
export function receptionistCueTooltip(base: TooltipContent): TooltipContent {
  return { title: base.title, lines: ['Has post from head office for you'], hint: 'Click to read the memo (the counter opens the Front desk)' };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Theme colours

/** The built-in sign (`palette.ts`), the fallback for every choice below. */
export const DEFAULT_SIGN = { plate: '#2d3d57', text: '#fff4d0' } as const;
/** The envelope's paper in the office art. */
export const ENVELOPE_PAPER = '#fbf6e8';
/** The memo's built-in accent (`--co-letterhead`). */
export const DEFAULT_MEMO_INK = '#23395b';
/** Graphics (the badge) need 3:1 against what they sit on (WCAG 1.4.11); the memo's stamp and band text are text, 4.5:1. */
export const GRAPHIC_MIN = 3;
export const TEXT_MIN = 4.5;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const ok = (a: string, b: string, min: number): boolean => {
  const r = contrastRatio(a, b);
  return Number.isFinite(r) && r >= min;
};

function rgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
/** How colourful a colour is, 0 (grey) to 1 (max - min channel). */
export function chroma(hex: string): number {
  const c = rgb(hex);
  return (Math.max(...c) - Math.min(...c)) / 255;
}

/** The office art's warm near-black (`raster.ts` `darken`): darkening towards it keeps the hue instead of going grey. */
const INK_DARK = '#1c1220';

/**
 * `color` darkened (in small steps towards a warm near-black) until it reaches `min` contrast against `bg`; the colour itself
 * when it already does. Null if even the darkest step fails (a very dark `bg`).
 */
export function inkOn(color: string, bg: string, min: number): string | null {
  if (!isHex(color) || !isHex(bg)) return null;
  for (let i = 0; i <= 20; i++) {
    const c = i === 0 ? color.toLowerCase() : mixHex(color, INK_DARK, i / 20);
    if (ok(c, bg, min)) return c;
  }
  return null;
}

/** The colours of the envelope badge on the Front desk. */
export interface PostColours {
  /** The badge plate behind the envelope. */
  plate: string;
  /** Its bright rim on the pulse (and the envelope's flap lines are the plate). */
  rim: string;
}

/**
 * The badge follows the theme's sign: the plate is the sign plate, the rim the sign lettering, like a tiny copy of the sign.
 * When the envelope would not stand out on the plate (a light plate, such as a yellow one) the lettering colour becomes the
 * plate instead; when neither works (or the theme gave none) it is the built-in navy sign. The rim must stand out from the plate
 * too, else it falls back to the sign plate's partner or the built-in cream.
 */
export function postColours(signPlate?: string, signText?: string): PostColours {
  const cands = [signPlate, signText].filter(isHex);
  const plate = cands.find((c) => ok(ENVELOPE_PAPER, c, GRAPHIC_MIN)) ?? DEFAULT_SIGN.plate;
  const rims = [signText, signPlate, DEFAULT_SIGN.text].filter(isHex).filter((c) => c.toLowerCase() !== plate.toLowerCase());
  const rim = rims.find((c) => ok(c, plate, GRAPHIC_MIN)) ?? DEFAULT_SIGN.text;
  return { plate: plate.toLowerCase(), rim: rim.toLowerCase() };
}

/** The theme accents of the head office memo; applied as CSS variables, null = keep the built-in look. */
export interface MemoAccent {
  /** The band across the top of the paper: the sign plate as it is (decoration). */
  band: string;
  /** A thin stripe under the band: the chosen sign colour as it is (decoration; the same as `band` when the plate was chosen). */
  stripe: string;
  /** The "HEAD OFFICE" stamp and the rule under the letterhead: that colour, darkened as far as it must be to read as text on the paper. */
  ink: string;
}

/** A colour this grey (chroma below this) reads as black or white: a more colourful sign colour makes the better stamp. */
const DULL = 0.12;
/** The lettering is the sign's main colour: it wins over the branch line unless the branch is clearly more colourful. */
const TEXT_BONUS = 1.25;

/**
 * Which theme colour the memo's accents take. The stamp ink is the sign plate unless the plate is nearly grey; then the more
 * colourful of the lettering and the branch line (the lettering favoured). Whichever it is, it is darkened until it reaches 4.5:1
 * on `paper` (the memo's paper colour in the current VS Code theme), so the stamp keeps the theme's hue and still reads. High
 * contrast themes keep the built-in look (null): the memo there is drawn in the theme's own foreground and border colours.
 */
export function memoAccent(sign: { plate?: string; text?: string; branch?: string }, paper: string, highContrast: boolean): MemoAccent | null {
  if (highContrast) return null;
  const bg = isHex(paper) ? paper : '#f7f1e1';
  const plate = isHex(sign.plate) ? sign.plate.toLowerCase() : DEFAULT_SIGN.plate;
  let pick = plate;
  if (chroma(plate) < DULL) {
    const scored = [
      ...(isHex(sign.text) ? [{ c: sign.text, s: chroma(sign.text) * TEXT_BONUS }] : []),
      ...(isHex(sign.branch) ? [{ c: sign.branch, s: chroma(sign.branch) }] : []),
    ].sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (best && chroma(best.c) > chroma(plate)) pick = best.c.toLowerCase();
  }
  const ink = inkOn(pick, bg, TEXT_MIN) ?? inkOn(DEFAULT_MEMO_INK, bg, TEXT_MIN) ?? DEFAULT_MEMO_INK;
  return { band: plate, stripe: pick, ink };
}
