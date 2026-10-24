/**
 * A tiny proportional bitmap font for speech bubbles, the wall sign and name
 * labels. Capitals and digits are 3x5 (M, W, N wider); lowercase has a
 * 4-pixel x-height with 1-pixel descenders. Glyph cells are 6 rows tall
 * (row 5 is the descender row) and there is 1 pixel between glyphs.
 *
 * Covers printable ASCII 32-126. Anything else draws as `?`.
 */

/** Height of one text line in pixels at scale 1, including descenders. */
export const FONT_LINE_HEIGHT = 7;
/** Height of capital letters at scale 1. */
export const FONT_CAP_HEIGHT = 5;
/** Pixels between glyphs at scale 1. */
export const FONT_SPACING = 1;

type Glyph = readonly string[];

const G: Record<string, Glyph> = {
  ' ': ['..'],
  '!': ['#', '#', '#', '.', '#'],
  '"': ['#.#', '#.#'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  $: ['.##', '##.', '.#.', '.##', '##.'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  "'": ['#', '#'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '*': ['...', '#.#', '.#.', '#.#'],
  '+': ['...', '.#.', '###', '.#.'],
  ',': ['..', '..', '..', '..', '.#', '#.'],
  '-': ['...', '...', '###'],
  '.': ['.', '.', '.', '.', '#'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  ':': ['.', '#', '.', '#'],
  ';': ['..', '.#', '..', '.#', '#.'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '=': ['...', '###', '...', '###'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '@': ['.##.', '#..#', '#.##', '#...', '.##.'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '[': ['##', '#.', '#.', '#.', '##'],
  '\\': ['#..', '#..', '.#.', '..#', '..#'],
  ']': ['##', '.#', '.#', '.#', '##'],
  '^': ['.#.', '#.#'],
  _: ['...', '...', '...', '...', '...', '###'],
  '`': ['#.', '.#'],
  a: ['...', '.##', '#.#', '#.#', '.##'],
  b: ['#..', '#..', '##.', '#.#', '##.'],
  c: ['..', '.#', '#.', '#.', '.#'],
  d: ['..#', '..#', '.##', '#.#', '.##'],
  e: ['...', '.#.', '###', '#..', '.##'],
  f: ['.#', '#.', '##', '#.', '#.'],
  g: ['...', '.##', '#.#', '.##', '..#', '##.'],
  h: ['#..', '#..', '##.', '#.#', '#.#'],
  i: ['#', '.', '#', '#', '#'],
  j: ['.#', '..', '.#', '.#', '.#', '#.'],
  k: ['#..', '#..', '#.#', '##.', '#.#'],
  l: ['#', '#', '#', '#', '#'],
  m: ['.....', '####.', '#.#.#', '#.#.#', '#.#.#'],
  n: ['...', '##.', '#.#', '#.#', '#.#'],
  o: ['...', '.#.', '#.#', '#.#', '.#.'],
  p: ['...', '##.', '#.#', '##.', '#..', '#..'],
  q: ['...', '.##', '#.#', '.##', '..#', '..#'],
  r: ['..', '#.', '##', '#.', '#.'],
  s: ['..', '.#', '#.', '.#', '#.'],
  t: ['#.', '##', '#.', '#.', '.#'],
  u: ['...', '#.#', '#.#', '#.#', '.##'],
  v: ['...', '#.#', '#.#', '#.#', '.#.'],
  w: ['.....', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['...', '#.#', '.#.', '.#.', '#.#'],
  y: ['...', '#.#', '#.#', '.##', '..#', '##.'],
  z: ['...', '###', '.#.', '#..', '###'],
  '{': ['.##', '.#.', '#..', '.#.', '.##'],
  '|': ['#', '#', '#', '#', '#'],
  '}': ['##.', '.#.', '..#', '.#.', '##.'],
  '~': ['....', '....', '.#.#', '#.#.'],
};

function glyph(ch: string): Glyph {
  return G[ch] ?? G['?']!;
}

function glyphWidth(g: Glyph): number {
  let w = 0;
  for (const r of g) w = Math.max(w, r.length);
  return w;
}

/** Size of `text` in pixels at the given integer scale (single line; `\n` starts a new line). */
export function measurePixelText(text: string, scale = 1): { w: number; h: number } {
  const lines = text.split('\n');
  let w = 0;
  for (const line of lines) {
    let lw = 0;
    let n = 0;
    for (const ch of line) {
      lw += glyphWidth(glyph(ch));
      n++;
    }
    if (n > 1) lw += (n - 1) * FONT_SPACING;
    w = Math.max(w, lw);
  }
  const h = lines.length * FONT_LINE_HEIGHT - (FONT_LINE_HEIGHT - 6);
  return { w: w * scale, h: h * scale };
}

/**
 * Draws `text` with its top-left at (x, y) in `color`. `scale` must be a
 * positive integer for crisp output. Returns the drawn width in pixels.
 * Pass a `shadow` colour to get a 1-scaled-pixel drop shadow (down-right).
 */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
  shadow?: string,
): number {
  const s = Math.max(1, Math.round(scale));
  x = Math.round(x);
  y = Math.round(y);
  let maxW = 0;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    let cx = x;
    const cy = y + li * FONT_LINE_HEIGHT * s;
    for (const ch of lines[li]!) {
      const g = glyph(ch);
      const gw = glyphWidth(g);
      for (const pass of shadow ? [0, 1] : [1]) {
        ctx.fillStyle = pass === 0 ? shadow! : color;
        const off = pass === 0 ? s : 0;
        for (let r = 0; r < g.length; r++) {
          const row = g[r]!;
          for (let i = 0; i < row.length; i++) {
            if (row[i] === '#') ctx.fillRect(cx + i * s + off, cy + r * s + off, s, s);
          }
        }
      }
      cx += (gw + FONT_SPACING) * s;
    }
    maxW = Math.max(maxW, cx - x - FONT_SPACING * s);
  }
  return Math.max(0, maxW);
}

/**
 * Shortens `text` with a trailing `..` so it fits in `maxW` pixels at `scale`.
 */
export function fitPixelText(text: string, maxW: number, scale = 1): string {
  if (measurePixelText(text, scale).w <= maxW) return text;
  let t = text;
  while (t.length > 0 && measurePixelText(t + '..', scale).w > maxW) t = t.slice(0, -1);
  return t + '..';
}
