/**
 * Monitor screen content. Desk screens are tiny (7x7 px), so each kind is a
 * recognisable pattern rather than real content:
 *   code      dark blue with coloured lines that scroll
 *   terminal  black with green lines and a blinking cursor
 *   browser   white page with a blue top bar
 *   document  white page with grey text lines (reading)
 *   drawing   white canvas with colourful strokes appearing
 *   idle      dark screensaver with a drifting dot
 *   off       dark glass
 *   boot      near-black, tiny centred logo, progress bar filling over BOOT_MS (no glow)
 */
import type { Rect } from './office-map.ts';
import { C } from './palette.ts';

/** What a monitor shows. */
export type ScreenKind = 'off' | 'idle' | 'code' | 'terminal' | 'browser' | 'document' | 'drawing' | 'boot';

/** Length of the 'boot' animation in ms; the engine matches this. */
export const BOOT_MS = 2000;

/** Suggested screen per protocol activity (for the engine's convenience). */
export const SCREEN_FOR_ACTIVITY: Readonly<Record<string, ScreenKind>> = {
  reading: 'document',
  searching: 'idle',
  researching: 'browser',
  writing: 'code',
  drawing: 'drawing',
  running: 'terminal',
  copier: 'terminal',
  planning: 'document',
  delegating: 'code',
  thinking: 'code',
  needsYou: 'idle',
  shredding: 'idle',
  idle: 'idle',
};

function r(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

function lineLen(i: number, w: number): number {
  return 1 + (((i * 2654435761) >>> 0) % Math.max(1, w - 1));
}

/**
 * Draws screen content into `rect` (map pixels, plus optional origin offset)
 * for animation time `tMs`. `glow` additionally tints the surrounding glow
 * rectangle softly.
 */
export function drawScreen(ctx: CanvasRenderingContext2D, rect: Rect, kind: ScreenKind, tMs: number, ox = 0, oy = 0, glow?: Rect): void {
  const x = rect.x + ox;
  const y = rect.y + oy;
  const { w, h } = rect;
  const glowColor: Partial<Record<ScreenKind, string>> = {
    code: 'rgba(110,160,255,0.16)', terminal: 'rgba(90,230,120,0.16)', browser: 'rgba(230,240,255,0.18)',
    document: 'rgba(255,250,235,0.16)', drawing: 'rgba(255,190,120,0.16)',
  };
  // Glow is decided here: only kinds listed in glowColor glow ('boot' and 'off' deliberately absent).
  if (glow && glowColor[kind]) r(ctx, glow.x + ox, glow.y + oy, glow.w, glow.h, glowColor[kind]!);
  switch (kind) {
    case 'off':
      r(ctx, x, y, w, h, C.screenOff);
      r(ctx, x, y, 1, 1, C.screenGlass);
      break;
    case 'idle': {
      r(ctx, x, y, w, h, '#14182a');
      const p = Math.floor(tMs / 400);
      const dx = Math.abs((p % ((w - 1) * 2)) - (w - 1));
      const dy = Math.abs((Math.floor(p * 0.7) % ((h - 1) * 2)) - (h - 1));
      r(ctx, x + dx, y + dy, 1, 1, '#7fb0ff');
      break;
    }
    case 'code': {
      r(ctx, x, y, w, h, '#1d2b4a');
      const scroll = Math.floor(tMs / 260);
      const cols = ['#e8eefc', '#7fc7ff', '#f2d675', '#c792ea', '#9fe0a0'];
      for (let row = 0; row < h; row += 1) {
        if (row % 2 === 1) continue;
        const i = row + scroll;
        const indent = (i % 3 === 0 ? 0 : 1) + (i % 5 === 0 ? 1 : 0);
        r(ctx, x + indent, y + row, Math.min(w - indent, lineLen(i, w)), 1, cols[i % cols.length]!);
      }
      break;
    }
    case 'terminal': {
      r(ctx, x, y, w, h, '#0b0f0b');
      const scroll = Math.floor(tMs / 160);
      for (let row = 0; row < h - 1; row += 2) r(ctx, x, y + row, lineLen(row + scroll, w), 1, '#46d36a');
      if (Math.floor(tMs / 400) % 2 === 0) r(ctx, x + 1, y + h - 1, 2, 1, '#b6ffbf');
      r(ctx, x, y + h - 1, 1, 1, '#46d36a');
      break;
    }
    case 'browser': {
      r(ctx, x, y, w, h, '#f7f8fb');
      r(ctx, x, y, w, 2, '#3f6fb0');
      r(ctx, x + 1, y, 2, 1, '#9cc0ee');
      r(ctx, x + 1, y + 3, Math.max(1, w - 4), 1, '#7a8a9e');
      r(ctx, x + 1, y + 5, w - 2, 1, '#b8c2cf');
      if (h > 6) r(ctx, x + 1, y + 6, 3, 1, '#d8a64a');
      break;
    }
    case 'document': {
      r(ctx, x, y, w, h, '#fbf8ef');
      for (let row = 1; row < h; row += 2) r(ctx, x + 1, y + row, row % 4 === 1 ? w - 2 : w - 3, 1, '#9fa3ab');
      break;
    }
    case 'drawing': {
      r(ctx, x, y, w, h, '#ffffff');
      const cols = ['#e0453a', '#4f8fd8', '#5fb85a', '#f2c94c', '#c792ea'];
      const n = 1 + (Math.floor(tMs / 350) % (w * 2));
      for (let i = 0; i < n; i++) {
        const px = (i * 3 + Math.floor(i / 3)) % w;
        const py = (i * 5 + 1) % h;
        r(ctx, x + px, y + py, 1, 1, cols[i % cols.length]!);
      }
      break;
    }
    case 'boot': {
      r(ctx, x, y, w, h, '#07090c');
      // One-frame blink at the very start.
      if (tMs < 60) r(ctx, x, y, w, h, '#1c222b');
      // Progress bar near the bottom, inset by 1px when wide enough; fills left to right.
      const barY = y + (h >= 5 ? h - 2 : h - 1);
      const barX = w >= 5 ? x + 1 : x;
      const barW = w >= 5 ? w - 2 : w;
      const frac = Math.min(1, Math.max(0, tMs / BOOT_MS));
      r(ctx, barX, barY, barW, 1, '#1a2028');
      r(ctx, barX, barY, Math.floor(barW * frac), 1, '#8fb8d8');
      // Neutral logo (a square with a notch), centred in the area above the bar.
      const s = Math.max(2, Math.round(Math.min(w, h) / 4));
      const area = Math.max(s, barY - y - 1);
      const lx = x + Math.floor((w - s) / 2);
      const ly = y + Math.floor((area - s) / 2);
      r(ctx, lx, ly, s, s, '#c9d3dc');
      r(ctx, lx + s - 1, ly, 1, 1, '#07090c');
      break;
    }
  }
}
