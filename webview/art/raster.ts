/**
 * Low-level pixel helpers shared by every art module.
 *
 * All art is authored as palette-indexed strings (one character per pixel,
 * `.` or space = transparent) or drawn with integer rectangles, then
 * rasterised once into cached `HTMLCanvasElement`s.
 */

/** A CSS colour string. Art uses `#rrggbb` or `#rrggbbaa`. */
export type Color = string;

/** Maps one-character palette keys to colours. */
export type Palette = Readonly<Record<string, Color>>;

/** Creates a canvas of the given size (uses the DOM canvas for webview compatibility). */
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Returns a 2D context with image smoothing off. */
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` into [r, g, b, a] (0-255). */
export function parseHex(hex: Color): [number, number, number, number] {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** Formats [r, g, b, a] as `#rrggbb` (alpha omitted when opaque). */
export function toHex(r: number, g: number, b: number, a = 255): Color {
  return '#' + hex2(r) + hex2(g) + hex2(b) + (a >= 255 ? '' : hex2(a));
}

/** Linear mix of two colours; t = 0 gives `a`, t = 1 gives `b`. Alpha is taken from `a`. */
export function mix(a: Color, b: Color, t: number): Color {
  const [r1, g1, b1, a1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t, a1);
}

/** Darkens towards a deep plum so shadows stay warm rather than grey. */
export function darken(c: Color, t: number): Color {
  return mix(c, '#1c1220', t);
}

/** Lightens towards white. */
export function lighten(c: Color, t: number): Color {
  return mix(c, '#ffffff', t);
}

/** Replaces the alpha channel of a colour. */
export function withAlpha(c: Color, alpha: number): Color {
  const [r, g, b] = parseHex(c);
  return toHex(r, g, b, alpha * 255);
}

/** Fills one integer rectangle. */
export function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: Color): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/**
 * Draws palette-indexed rows onto a context, one `fillRect` per pixel.
 * Unknown keys draw magenta so mistakes are obvious in the gallery.
 */
export function drawRows(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  pal: Palette,
  x: number,
  y: number,
  flipX = false,
): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const w = row.length;
    for (let i = 0; i < w; i++) {
      const k = row[i]!;
      if (k === '.' || k === ' ') continue;
      const c = pal[k] ?? '#ff00ff';
      ctx.fillStyle = c;
      ctx.fillRect(x + (flipX ? w - 1 - i : i), y + r, 1, 1);
    }
  }
}

/** Width of the widest row. */
export function rowsWidth(rows: readonly string[]): number {
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  return w;
}

/** Rasterises rows into a new canvas sized to fit. */
export function rowsToCanvas(rows: readonly string[], pal: Palette, flipX = false): HTMLCanvasElement {
  const c = makeCanvas(rowsWidth(rows), rows.length);
  drawRows(ctx2d(c), rows, pal, 0, 0, flipX);
  return c;
}

/** Returns a horizontally mirrored copy of a canvas. */
export function flipCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const ctx = ctx2d(c);
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * A small mutable pixel buffer used to compose character frames before
 * rasterising. Pixels hold colour strings or `undefined` (transparent).
 */
export class PixelGrid {
  readonly w: number;
  readonly h: number;
  readonly px: (Color | undefined)[];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Array<Color | undefined>(w * h).fill(undefined);
  }

  get(x: number, y: number): Color | undefined {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return undefined;
    return this.px[y * this.w + x];
  }

  set(x: number, y: number, c: Color | undefined): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c;
  }

  fill(x: number, y: number, w: number, h: number, c: Color): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /**
   * Stamps palette rows at (x, y). `_` clears a pixel. With `contact` > 0,
   * existing pixels that touch the new ones (4-neighbourhood) are darkened by
   * that amount, which separates overlapping body parts without hard lines.
   * `clipTop` skips rows above that absolute y.
   */
  stamp(rows: readonly string[], pal: Palette, x: number, y: number, opts: { flip?: boolean; contact?: number; clipTop?: number; clipBottom?: number } = {}): void {
    const placed: number[] = [];
    const clipTop = opts.clipTop ?? -Infinity;
    const clipBottom = opts.clipBottom ?? Infinity;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const yy = y + r;
      if (yy < clipTop || yy > clipBottom) continue;
      for (let i = 0; i < row.length; i++) {
        const k = row[i]!;
        if (k === '.' || k === ' ') continue;
        const xx = x + (opts.flip ? row.length - 1 - i : i);
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        if (k === '_') { this.set(xx, yy, undefined); continue; }
        this.set(xx, yy, pal[k] ?? '#ff00ff');
        placed.push(yy * this.w + xx);
      }
    }
    const amt = opts.contact ?? 0;
    if (amt > 0 && placed.length) {
      const mine = new Set(placed);
      const done = new Set<number>();
      for (const p of placed) {
        const px = p % this.w;
        const py = (p - px) / this.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const n = ny * this.w + nx;
          if (mine.has(n) || done.has(n)) continue;
          const c = this.px[n];
          if (!c) continue;
          this.px[n] = darken(c, amt);
          done.add(n);
        }
      }
    }
  }

  /**
   * Adds a one-pixel outline around the silhouette (4-neighbourhood). The
   * outline colour is the touching pixel darkened heavily ("selective
   * outline"), which keeps edges crisp but less harsh than pure black.
   */
  outline(base: Color, strength = 0.72): void {
    const src = this.px.slice();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (src[y * this.w + x]) continue;
        let n: Color | undefined;
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
          const c = src[yy * this.w + xx];
          if (c && !c.endsWith('00')) { n = c; break; }
        }
        if (n) this.px[y * this.w + x] = mix(n, base, strength);
      }
    }
  }

  /** Mirrors the grid horizontally in place. */
  flipX(): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < Math.floor(this.w / 2); x++) {
        const a = y * this.w + x;
        const b = y * this.w + (this.w - 1 - x);
        const t = this.px[a];
        this.px[a] = this.px[b];
        this.px[b] = t;
      }
    }
  }

  /** Rasterises into a new canvas via ImageData (fast). */
  toCanvas(): HTMLCanvasElement {
    const c = makeCanvas(this.w, this.h);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(this.w, this.h);
    const cache = new Map<string, [number, number, number, number]>();
    for (let i = 0; i < this.px.length; i++) {
      const col = this.px[i];
      if (!col) continue;
      let rgba = cache.get(col);
      if (!rgba) { rgba = parseHex(col); cache.set(col, rgba); }
      img.data[i * 4] = rgba[0];
      img.data[i * 4 + 1] = rgba[1];
      img.data[i * 4 + 2] = rgba[2];
      img.data[i * 4 + 3] = rgba[3];
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}
