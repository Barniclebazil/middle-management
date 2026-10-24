/**
 * Small DOM helpers shared by the case file, the memo, the roster and the panels. Text is
 * only ever set with text nodes / `textContent`; nothing here parses HTML.
 */
import { CHAR_HEADROOM, getCharacterFrame, getIcon, getUiIcon, UI_ICON_SIZE } from '../art/index.ts';
import type { IconId } from '../art/index.ts';
import { parseBlocks } from './markdown.ts';
import type { MdInline } from './markdown.ts';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Creates an element. `attrs`: `class`, `text` (textContent) and any other
 * attribute (set with setAttribute; `false`/`null`/`undefined` skip it).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, ...children);
  return el;
}

/** Appends children (strings become text nodes). */
export function append(el: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** A `<button type="button">` with a click handler. */
export function button(label: Child | Child[], cls: string, onClick: (e: MouseEvent) => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, ...attrs }, ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Call before a panel rebuilds `el`'s children; call the function it returns afterwards. When focus was inside `el`, it goes
 * back to the control with the same `data-fk` key, or, when that control is gone (a Try again that turned into a loading
 * line, a card that left the list), to `el` itself (give it `tabindex="-1"` and the `co-focus-park` class), so the keyboard never
 * drops to `<body>`; when that control comes back in a later rebuild, focus moves on to it.
 */
export function keepFocus(el: HTMLElement): () => void {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !el.contains(a)) return () => {};
  // Parked on `el` because the control went away: it still wants that control back when it returns (Try again -> loading -> error).
  const key = a === el ? el.dataset['fkWant'] : a.dataset['fk'];
  const find = (k: string | undefined): HTMLElement | undefined => (k === undefined ? undefined : Array.from(el.querySelectorAll<HTMLElement>('[data-fk]')).find((e) => e.dataset['fk'] === k));
  return () => {
    const now = document.activeElement;
    if (now instanceof HTMLElement && now !== document.body && now.isConnected && now !== a && now !== el) { delete el.dataset['fkWant']; return; }
    if (now === a && a.isConnected && a !== el) return;
    const same = find(key);
    if (same) { delete el.dataset['fkWant']; same.focus({ preventScroll: true }); return; }
    if (key !== undefined) el.dataset['fkWant'] = key;
    el.focus({ preventScroll: true });
  };
}

/** A crisp pixel icon from the office art, shown at `px` CSS pixels. */
export function pixelIcon(id: IconId, px = 20, cls = 'co-px'): HTMLCanvasElement {
  // The 18x18 UI art at whole multiples of its size (crisp); the 8x8 art otherwise.
  const src = (px % UI_ICON_SIZE === 0 ? getUiIcon(id) : undefined) ?? getIcon(id);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.className = cls;
  c.style.width = `${px}px`;
  c.style.height = `${px}px`;
  c.setAttribute('aria-hidden', 'true');
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}

/** Tiny hand-drawn sprites that the office art doesn't have. */
const SPRITES = {
  lock: { rows: ['..kkk..', '.k...k.', '.k...k.', 'kyyyyyk', 'kyYkYyk', 'kyYkYyk', 'kyyyyyk', 'kkkkkkk'], pal: { k: '#3a3340', y: '#f2c94c', Y: '#c99a2a' } },
  memo: { rows: ['kkkkkk.', 'kwwwwkk', 'kwllwwk', 'kwwwwwk', 'kwlllwk', 'kwwwwwk', 'kwllwwk', 'kkkkkkk'], pal: { k: '#3a3340', w: '#fffdf6', l: '#8a93a6' } },
  branch: { rows: ['.k...', 'kgk..', '.k..k', '.k.kgk', '.kk.k.', '.k...', 'kgk..', '.k...'], pal: { k: '#3a3340', g: '#5fb85a' } },
} as const;

/** A tiny pixel sprite (lock, memo, branch) at an integer CSS scale. */
export function sprite(name: keyof typeof SPRITES, scale = 2): HTMLCanvasElement {
  const s = SPRITES[name];
  const w = Math.max(...s.rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = s.rows.length;
  c.className = 'co-px';
  c.style.width = `${w * scale}px`;
  c.style.height = `${s.rows.length * scale}px`;
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d');
  if (ctx) {
    s.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const col = (s.pal as Record<string, string>)[row[x]!];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  }
  return c;
}

/** Size of the portrait crop from a 16x24 standing frame: head and shoulders. */
export const FACE_W = 14;
export const FACE_H = 14;

/** Paints a head-and-shoulders portrait of `look` into a FACE_W x FACE_H canvas. */
export function paintPortrait(face: HTMLCanvasElement, look: string): void {
  const ctx = face.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  const img = getCharacterFrame(look, 'stand', 'down', 0);
  // The frame is 16 wide; take the middle 14 columns, from the top of the body grid.
  ctx.drawImage(img, 1, CHAR_HEADROOM, FACE_W, FACE_H, 0, 0, FACE_W, FACE_H);
}

/** A portrait canvas shown at `px` CSS pixels. */
export function portrait(look: string | null, px: number, cls = 'co-face'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = FACE_W;
  c.height = FACE_H;
  c.className = cls;
  c.style.width = `${px}px`;
  c.style.height = `${px}px`;
  c.setAttribute('aria-hidden', 'true');
  if (look) paintPortrait(c, look);
  return c;
}

/** "⎇ main" chip (nothing when the branch is unknown). */
export function branchChip(branch: string | undefined, cls = 'co-chip co-branch'): HTMLSpanElement | null {
  if (!branch) return null;
  return h('span', { class: cls, title: `Git branch: ${branch}` }, h('span', { class: 'co-branch-glyph', 'aria-hidden': 'true', text: '⎇' }), ` ${branch}`);
}

function inline(spans: readonly MdInline[]): Node[] {
  const out: Node[] = [];
  for (const sp of spans) {
    if (sp.t === 'text') {
      // Keep single newlines as line breaks.
      const parts = sp.s.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) out.push(document.createElement('br'));
        if (p) out.push(document.createTextNode(p));
      });
    } else if (sp.t === 'code') out.push(h('code', { text: sp.s }));
    else if (sp.t === 'bold') out.push(h('strong', { text: sp.s }));
    else out.push(h('em', { text: sp.s }));
  }
  return out;
}

/** Renders markdown-lite into a fragment (text nodes only). */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of parseBlocks(text)) {
    switch (b.kind) {
      case 'para': frag.appendChild(h('p', null, ...inline(b.spans))); break;
      case 'heading': frag.appendChild(h(b.level <= 2 ? 'h3' : 'h4', null, ...inline(b.spans))); break;
      case 'quote': frag.appendChild(h('blockquote', null, ...inline(b.spans))); break;
      case 'rule': frag.appendChild(h('hr')); break;
      case 'code': {
        const pre = h('pre', { class: b.lang === 'table' ? 'co-md-table' : null }, h('code', { text: b.text }));
        if (b.lang && b.lang !== 'table') pre.setAttribute('data-lang', b.lang);
        frag.appendChild(pre);
        break;
      }
      case 'list': {
        // Nesting is shown with indentation classes (simple and robust for partial text).
        const list = h(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: b.start } : null);
        for (const it of b.items) list.appendChild(h('li', { class: it.depth ? `co-d${it.depth}` : null }, ...inline(it.spans)));
        frag.appendChild(list);
        break;
      }
    }
  }
  return frag;
}

/** Ctrl+Enter (Cmd+Enter on macOS). */
export function isSendKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
}

/** "Ctrl+Enter" or "⌘Enter" for hints. */
export function sendKeyLabel(): string {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return mac ? '⌘Enter' : 'Ctrl+Enter';
}

/** Grows a textarea with its content between `minRows` and `maxRows`. */
export function autoGrow(ta: HTMLTextAreaElement, maxPx = 180): void {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(maxPx, ta.scrollHeight + 2)}px`;
}
