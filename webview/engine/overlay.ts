/**
 * Speech bubbles, icon bubbles and name labels, drawn in screen space on top
 * of the scaled office.
 *
 * The office itself is drawn at 1x and scaled up, which at the usual bottom
 * panel size (about 1x) left the 3x5 pixel font far too small to read. So the
 * overlay is laid out and drawn in device pixels instead, at its own integer
 * "UI scale" (`overlayUnits`), from anchors taken from the world. Each bubble
 * is rendered once at 1 bubble-px per px into a small cached canvas and blitted
 * at the UI scale with smoothing off, so it stays crisp at any DPR.
 */
import {
  BUBBLE_STYLE, FONT_LINE_HEIGHT, ICON_SIZE, drawBubble, drawPixelText, fitPixelText, getIcon, getLook, measurePixelText,
} from '../art/index.ts';
import type { IconId } from '../art/index.ts';
import type { OfficeSettings } from '../../src/shared/protocol.ts';
import type { Office } from './office.ts';
import { collectBubbles, layoutBubbles } from './bubbles.ts';
import type { Placed, Sized } from './bubbles.ts';
import { overlayUnits } from './camera.ts';
import type { View } from './camera.ts';

/** Width in pixels text bubbles wrap at. */
export const TEXT_BUBBLE_MAX_W = 84;
/** Most rows a speech bubble (anything a character says) wraps to. */
export const SPEECH_BUBBLE_MAX_LINES = 3;
/** Most rows a detail bubble (file, command, query) wraps to. */
export const DETAIL_BUBBLE_MAX_LINES = 2;
const LABEL_MAX_W = 84;
const LABEL_H = 8;

/** Highlighted name label (the character picked in the roster or hovered). */
const HIGHLIGHT_FILL = '#f2c94c';
const HIGHLIGHT_TEXT = '#2a2230';
const LABEL_FILL = 'rgba(24,18,30,0.82)';
const LABEL_TEXT = '#fff4d8';

/** The sticky note on the empty office floor. */
export const EMPTY_NOTE_LINES: readonly string[] = [
  'No Claude Code sessions running.',
  'Click yourself (or + New task)',
  'to hire someone, or run',
  "'Middle Management: Toggle Demo'",
  'to see the office in action.',
];

/** Splits text into at most `maxLines` lines no wider than `maxW`, breaking long words and adding '..' when cut. */
export function wrapText(text: string, maxW: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const pieces: string[] = [];
  for (const w of words) {
    if (measurePixelText(w).w <= maxW) { pieces.push(w); continue; }
    // Break long tokens (paths, commands) at punctuation or anywhere.
    let cur = '';
    for (const ch of w) {
      if (measurePixelText(cur + ch).w > maxW && cur) { pieces.push(cur); cur = ''; }
      cur += ch;
    }
    if (cur) pieces.push(cur);
  }
  const lines: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const next = cur ? `${cur} ${p}` : p;
    if (!cur || measurePixelText(next).w <= maxW) cur = next;
    else { lines.push(cur); cur = p; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitPixelText(`${kept[maxLines - 1]!} ${lines[maxLines]!}`, maxW - 1);
    if (!kept[maxLines - 1]!.endsWith('..')) kept[maxLines - 1] = fitPixelText(`${kept[maxLines - 1]!}..`, maxW);
    return kept;
  }
  return lines.length ? lines : [''];
}

/** Device-pixel rectangle. */
export interface DeviceRect { x: number; y: number; w: number; h: number }

interface Item extends Sized { u: number }

export class Overlay {
  private readonly prev = new Map<string, { dx: number; dy: number }>();
  private readonly wrapCache = new Map<string, string[]>();
  private readonly sprites = new Map<string, HTMLCanvasElement>();

  /**
   * Draws every bubble and label onto `ctx` (a device-pixel context with an
   * identity transform). `bounds` is the visible part of the office in device
   * px; everything is kept inside it.
   */
  render(
    ctx: CanvasRenderingContext2D, office: Office, settings: OfficeSettings, t: number, view: View, dpr: number, bounds: DeviceRect, highlightId: string | null,
    /** Map-px boxes bubbles keep clear of (the "BACK" card). */
    avoid: readonly { x: number; y: number; w: number; h: number }[] = [],
  ): void {
    const units = overlayUnits(view.scale, dpr);
    const reqs = collectBubbles([...office.chars.values()], office.manager, office.queueIds, {
      speechBubbles: settings.speechBubbles !== false,
      managerName: settings.managerName || 'You',
      highlightId,
      ...(office.theme ? { theme: office.theme } : {}),
      headLift: (look) => (getLook(look)?.build === 'tall' ? 2 : 0),
    }, t, office.receptionist, office.cleanerOnStage ? office.cleaner : undefined, office.vendorOnStage ? office.vendor : undefined, office.itCrewOnStage ? [office.dez, office.fenwick] : []);
    const toDev = (mx: number, my: number): { x: number; y: number } => ({
      x: Math.round((view.ox + mx * view.scale) * dpr),
      y: Math.round((view.oy + my * view.scale) * dpr),
    });
    // Only people who are (at least partly) on screen get bubbles: in the
    // sidebar camera a bubble clamped into view from someone off screen
    // would point at nobody.
    const charX = new Map<string, number>();
    for (const c of office.allChars()) charX.set(c.id, Math.round((view.ox + c.x * view.scale) * dpr));
    const margin = 4 * units.icon;
    const onScreen = reqs.filter((r) => {
      const x = charX.get(r.charId) ?? Math.round((view.ox + r.ax * view.scale) * dpr);
      return x >= bounds.x - margin && x <= bounds.x + bounds.w + margin;
    });
    const items: Item[] = onScreen.map((r) => {
      const u = r.type === 'icon' ? units.icon : units.text;
      const a = toDev(r.ax, r.ay);
      const base = { ...r, ax: a.x, ay: a.y, u, labelH: (LABEL_H + 1) * units.text };
      if (r.type === 'label') {
        // Labels to the right of someone get only the room up to the edge of
        // the view (instead of being pushed back over the person).
        const room = r.side === 'right' ? Math.floor((bounds.x + bounds.w - a.x) / u) - 5 : Math.floor(bounds.w / u) - 6;
        const text = fitPixelText(r.text ?? '', Math.max(16, Math.min(LABEL_MAX_W, room)));
        return { ...base, text, w: (measurePixelText(text).w + 4) * u, h: LABEL_H * u, tail: 0 };
      }
      if (r.type === 'icon') return { ...base, w: (ICON_SIZE + 4) * u, h: (ICON_SIZE + 4) * u, tail: (r.style === 'thought' ? 5 : 3) * u };
      const iconW = r.icon ? ICON_SIZE + 1 : 0;
      const lines = this.wrap(r.text ?? '', TEXT_BUBBLE_MAX_W - iconW, r.detail ? DETAIL_BUBBLE_MAX_LINES : SPEECH_BUBBLE_MAX_LINES);
      let tw = 0;
      for (const l of lines) tw = Math.max(tw, measurePixelText(l).w);
      const textH = lines.length * FONT_LINE_HEIGHT - 1;
      return { ...base, w: (tw + iconW + 6) * u, h: (Math.max(textH, r.icon ? ICON_SIZE : 0) + 5) * u, tail: (r.style === 'thought' ? 5 : 3) * u };
    });
    const obstacles = avoid.map((b) => {
      const a = toDev(b.x, b.y);
      const z = toDev(b.x + b.w, b.y + b.h);
      return { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
    });
    const placed = layoutBubbles(items, bounds, this.prev, units.text, obstacles) as (Placed & { u: number })[];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // Never draw outside the office (the roster and letterbox stay clean).
    ctx.beginPath();
    ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.clip();
    for (const p of placed) this.drawPlaced(ctx, p, t);
    ctx.restore();
    if (this.sprites.size > 300) this.sprites.clear();
  }

  /** A sticky note on the bullpen floor when nobody is in (drawn at the text UI scale so it can be read). */
  renderEmptyNote(ctx: CanvasRenderingContext2D, view: View, dpr: number, bounds: DeviceRect, lines: readonly string[] = EMPTY_NOTE_LINES): void {
    const u = overlayUnits(view.scale, dpr).text;
    let w = 0;
    for (const l of lines) w = Math.max(w, measurePixelText(l).w);
    w += 10;
    const h = lines.length * FONT_LINE_HEIGHT + 9;
    const img = this.sprite(`empty-note|${lines.join('\n')}`, w + 2, h + 2, (c) => {
      c.fillStyle = 'rgba(30,20,10,0.28)';
      c.fillRect(2, 2, w, h);
      c.fillStyle = '#f4dc6b';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#f9e98f';
      c.fillRect(0, 0, w, 3);
      c.fillStyle = '#d9bd45';
      c.fillRect(w - 5, h - 5, 5, 5);
      c.fillStyle = '#c9a933';
      c.fillRect(w - 5, h - 5, 1, 5);
      c.fillRect(w - 5, h - 5, 5, 1);
      c.fillStyle = '#c23b3b';
      c.fillRect(Math.floor(w / 2) - 1, 1, 3, 2);
      lines.forEach((l, i) => drawPixelText(c, l, 5, 6 + i * FONT_LINE_HEIGHT, '#4a3a1a'));
    });
    // Centred on the open carpet in the middle of the bullpen, clear of desks, kept on screen.
    const cx = Math.round((view.ox + 368 * view.scale) * dpr);
    const cy = Math.round((view.oy + 152 * view.scale) * dpr);
    const dw = img.width * u;
    const dh = img.height * u;
    const x = Math.max(bounds.x + u, Math.min(bounds.x + bounds.w - dw - u, cx - Math.round(dw / 2)));
    const y = Math.max(bounds.y + u, Math.min(bounds.y + bounds.h - dh - u, cy - Math.round(dh / 2)));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, dw, dh);
    ctx.restore();
  }

  private wrap(text: string, maxW: number, maxLines: number): string[] {
    const key = `${maxW}|${maxLines}|${text}`;
    let lines = this.wrapCache.get(key);
    if (!lines) {
      lines = wrapText(text, maxW, maxLines);
      if (this.wrapCache.size > 400) this.wrapCache.clear();
      this.wrapCache.set(key, lines);
    }
    return lines;
  }

  private drawPlaced(ctx: CanvasRenderingContext2D, p: Placed & { u: number }, t: number): void {
    const u = p.u;
    // A knocking worker's "!" bobs up a pixel now and then (a gentle pulse, not a flash).
    if (p.pulse && Math.floor(t / 450) % 3 === 0) p = { ...p, y: p.y - u };
    const w = Math.round(p.w / u);
    const h = Math.round(p.h / u);
    if (p.type === 'label') {
      const img = this.sprite(`L|${p.highlight ? 1 : 0}|${p.text}`, w, h, (c) => {
        const fillC = p.highlight ? HIGHLIGHT_FILL : LABEL_FILL;
        c.fillStyle = fillC;
        c.fillRect(1, 0, w - 2, h);
        c.fillRect(0, 1, w, h - 2);
        drawPixelText(c, p.text ?? '', 2, 1, p.highlight ? HIGHLIGHT_TEXT : LABEL_TEXT);
      });
      ctx.drawImage(img, p.x, p.y, w * u, h * u);
      return;
    }
    const tailDev = p.side === 'left' ? p.x + p.w - 4 * u : Math.max(p.x + 3 * u, Math.min(p.x + p.w - 4 * u, p.ax));
    const tailRel = Math.round((tailDev - p.x) / u);
    const off = p.ax - tailDev;
    if ((p.lift > 2 || Math.abs(off) > 3 * u) && p.side === 'above') {
      // A thin dotted leader from the tail of a lifted or side-slid bubble down towards the head.
      ctx.fillStyle = BUBBLE_STYLE.border;
      const x = p.x + tailRel * u;
      const y0 = p.y + p.h + p.tail + u;
      const stemU = Math.max(1, Math.round(u / 2));
      const len = Math.max(0, p.ay - u - y0);
      const n = Math.floor(Math.hypot(len, off) / (2 * u));
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0;
        ctx.fillRect(Math.round((x + off * f) / u) * u, Math.round((y0 + len * f) / u) * u, stemU, stemU);
      }
    }
    // The bubble shape is a handful of rectangles: draw it directly in bubble
    // px through an integer transform (crisp, and the tail can follow a
    // walking speaker without re-rendering). Only the text is cached.
    ctx.save();
    ctx.setTransform(u, 0, 0, u, p.x, p.y);
    drawBubble(ctx, 0, 0, w, h, p.style, tailRel);
    if (p.type === 'icon') {
      ctx.drawImage(getIcon((p.icon ?? 'alert') as IconId), 2, 2);
      ctx.restore();
      return;
    }
    const iconW = p.icon ? ICON_SIZE + 1 : 0;
    const lines = this.wrap(p.text ?? '', TEXT_BUBBLE_MAX_W - iconW, p.detail ? DETAIL_BUBBLE_MAX_LINES : SPEECH_BUBBLE_MAX_LINES);
    const textH = lines.length * FONT_LINE_HEIGHT - 1;
    let tx = 3;
    if (p.icon) {
      ctx.drawImage(getIcon(p.icon as IconId), 2, Math.floor((h - ICON_SIZE) / 2));
      tx += iconW;
    }
    const ty = 3 + Math.floor((h - 5 - textH) / 2);
    const tw = w - tx - 2;
    const text = this.sprite(`T|${tw}|${lines.join('\n')}`, tw, textH + 1, (c) => {
      lines.forEach((l, i) => drawPixelText(c, l, 0, i * FONT_LINE_HEIGHT, BUBBLE_STYLE.text));
    });
    ctx.drawImage(text, tx, ty);
    ctx.restore();
  }

  private sprite(key: string, w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    let img = this.sprites.get(key);
    if (!img) {
      img = document.createElement('canvas');
      img.width = Math.max(1, w);
      img.height = Math.max(1, h);
      const c = img.getContext('2d');
      if (c) {
        c.imageSmoothingEnabled = false;
        paint(c);
      }
      this.sprites.set(key, img);
    }
    return img;
  }
}
