// v0.4 prop states: the desk phone's MCP line lights, the bookshelf filled to the library's size and the filing
// cabinets' hover drawer. Drawn pixels are checked with a small fake canvas that keeps a pixel map (integer
// fillRect, drawImage at an offset, putImageData), so a state change can be seen in the output and "no data" can be
// compared with the old look. The art and engine modules use DOM types, so they're imported through computed
// specifiers (see engine-world.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_STATUSES } from '../src/shared/protocol.ts';
import type { McpStatus, OfficeSettings } from '../src/shared/protocol.ts';
import { loadWorld } from './engine-world.ts';

// ---------------------------------------------------------------------------
// Fake pixel canvas

class PxCanvas {
  width = 1;
  height = 1;
  readonly px = new Map<number, string>();
  private readonly ctx = new PxContext(this);
  getContext(): PxContext { return this.ctx; }
  get(x: number, y: number): string | undefined { return this.px.get(y * 4096 + x); }
  /** Every pixel inside a rect, as one comparable string. */
  dump(x0 = 0, y0 = 0, w = this.width, h = this.height): string {
    const out: string[] = [];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(this.get(x, y) ?? '-');
    return out.join(',');
  }
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

class PxContext {
  fillStyle = '#000000';
  imageSmoothingEnabled = true;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  private tx = 0;
  private ty = 0;
  private sx = 1;
  readonly canvas: PxCanvas;
  constructor(canvas: PxCanvas) { this.canvas = canvas; }
  private put(x: number, y: number, c: string | undefined): void {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    if (c === undefined) this.canvas.px.delete(y * 4096 + x); else this.canvas.px.set(y * 4096 + x, c);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const c = String(this.fillStyle).toLowerCase();
    for (let j = Math.round(y); j < Math.round(y + h); j++) for (let i = Math.round(x); i < Math.round(x + w); i++) this.put(i * this.sx + this.tx, j + this.ty, c);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.put(i + this.tx, j + this.ty, undefined);
  }
  drawImage(src: PxCanvas, dx: number, dy: number): void {
    for (const [k, c] of src.px) {
      const x = k % 4096;
      const y = Math.floor(k / 4096);
      this.put((Math.round(dx) + x) * this.sx + this.tx, Math.round(dy) + y + this.ty, c);
    }
  }
  setTransform(): void { this.tx = 0; this.ty = 0; this.sx = 1; }
  translate(x: number, y: number): void { this.tx += x; this.ty += y; }
  scale(sx: number): void { this.sx *= sx; }
  save(): void {}
  restore(): void {}
  createImageData(w: number, h: number): { width: number; data: Uint8ClampedArray } { return { width: w, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img: { width: number; data: Uint8ClampedArray }, x: number, y: number): void {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const p = i / 4;
      this.put(x + (p % img.width), y + Math.floor(p / img.width), `#${hex2(d[i]!)}${hex2(d[i + 1]!)}${hex2(d[i + 2]!)}${d[i + 3] === 255 ? '' : hex2(d[i + 3]!)}`);
    }
  }
}

(globalThis as { document?: unknown }).document = { createElement: () => new PxCanvas() };

const ART = new URL('../webview/art/', import.meta.url).href;
const ENGINE = new URL('../webview/engine/', import.meta.url).href;
const load = async (spec: string): Promise<any> => import(spec);
const props = await load(`${ART}props.ts`);
const F = await load(`${ART}furniture.ts`);
const map = await load(`${ART}office-map.ts`);
const caches = await load(`${ART}caches.ts`);
const { Scene } = await load(`${ENGINE}scene.ts`);
const { Office } = await load(`${ENGINE}office.ts`);

const blank = (w: number, h: number): PxCanvas => { const c = new PxCanvas(); c.width = w; c.height = h; return c; };

/** The phone's pixels after drawing `states` on top of its sprite. */
function phone(states: readonly McpStatus[], t?: number): PxCanvas {
  const a = map.PROP_ANCHORS.phone;
  const c = blank(a.w + 2, a.h + 2);
  const g = c.getContext();
  g.drawImage(F.phoneSprite(), 0, 0);
  props.drawPhoneLights(g, -a.x, -a.y, states, t);
  return c;
}

const light = (c: PxCanvas, i: number): string | undefined => c.get(F.PHONE_LIGHTS[i].x, F.PHONE_LIGHTS[i].y);

// ---------------------------------------------------------------------------
// Phone

test('phone: no data is the phone as drawn; every status has its own look', () => {
  const plain = phone([]).dump();
  assert.equal(phone([]).dump(), blankPhone(), 'empty list = the sprite alone');
  assert.equal(plain, blankPhone());
  const off = light(phone([]), 0);
  const C = props.PHONE_LIGHT_COLORS;
  assert.equal(light(phone(['connected']), 0), C.connected);
  // two pixels tall, so it still reads at the office's usual scale; a disabled line leaves its key as drawn
  const p0 = F.PHONE_LIGHTS[0];
  assert.equal(phone(['connected']).get(p0.x, p0.y - 1), C.connected);
  assert.equal(phone(['disabled']).get(p0.x, p0.y - 1), phone([]).get(p0.x, p0.y - 1));
  assert.equal(light(phone(['failed']), 0), C.failed);
  assert.equal(light(phone(['needsAuth']), 0), C.needsAuth);
  assert.equal(light(phone(['unknown']), 0), C.unknown);
  assert.equal(light(phone(['pending']), 0), C.pending, 'pending without a clock is steady amber');
  assert.equal(light(phone(['disabled']), 0), off, 'disabled stays off');
  // each status that lights does so differently
  const lit = MCP_STATUSES.filter((s) => s !== 'disabled').map((s) => light(phone([s]), 0));
  assert.equal(new Set(lit).size, lit.length);
  // the order is kept, one light per server
  const four = phone(['failed', 'connected', 'needsAuth', 'unknown']);
  assert.deepEqual([0, 1, 2, 3].map((i) => light(four, i)), [C.failed, C.connected, C.needsAuth, C.unknown]);
});

function blankPhone(): string {
  const a = map.PROP_ANCHORS.phone;
  const c = blank(a.w + 2, a.h + 2);
  c.getContext().drawImage(F.phoneSprite(), 0, 0);
  return c.dump();
}

test('phone: pending blinks slowly with the clock', () => {
  const C = props.PHONE_LIGHT_COLORS;
  const seen = new Set<string | undefined>();
  for (let t = 0; t < 3200; t += 100) seen.add(light(phone(['pending'], t), 0));
  assert.deepEqual([...seen].sort(), [C.pending, C.pendingDim].sort());
  // slow: the light holds for at least half a second
  assert.equal(light(phone(['pending'], 0), 0), light(phone(['pending'], 500), 0));
  assert.notEqual(light(phone(['pending'], 0), 0), light(phone(['pending'], 900), 0));
  // other statuses don't blink
  assert.equal(light(phone(['connected'], 0), 0), light(phone(['connected'], 900), 0));
});

test('phone: more servers than lights show a "+" tinted like the most pressing hidden one', () => {
  const C = props.PHONE_LIGHT_COLORS;
  const n = props.PHONE_LINES;
  assert.equal(n, 4);
  const m = F.PHONE_MORE;
  const exact = phone(['connected', 'connected', 'connected', 'connected']);
  const plusAt = (c: PxCanvas): (string | undefined)[] => [c.get(m.x, m.y), c.get(m.x - 1, m.y), c.get(m.x + 1, m.y), c.get(m.x, m.y - 1), c.get(m.x, m.y + 1)];
  assert.notDeepEqual(plusAt(exact), Array(5).fill(C.more), 'four servers: no "+"');
  const more = phone(['connected', 'connected', 'connected', 'connected', 'connected']);
  assert.deepEqual(plusAt(more), Array(5).fill(C.more));
  assert.deepEqual(plusAt(phone(['connected', 'connected', 'connected', 'connected', 'pending', 'failed'])), Array(5).fill(C.failed));
  assert.deepEqual(plusAt(phone(['failed', 'connected', 'connected', 'connected', 'needsAuth', 'disabled'])), Array(5).fill(C.needsAuth));
  assert.deepEqual(plusAt(phone(['connected', 'connected', 'connected', 'connected', 'pending'])), Array(5).fill(C.pending));
  // the first four lights are the same with or without the overflow
  assert.deepEqual([0, 1, 2, 3].map((i) => light(more, i)), [0, 1, 2, 3].map((i) => light(exact, i)));
});

// ---------------------------------------------------------------------------
// Bookshelf

test('bookshelf: no data is the classic full shelf; counts fill it book by book, then stay full', () => {
  const S = props.BOOKSHELF_SLOTS;
  assert.ok(S >= 20 && S <= 40, `capacity ${S}`);
  const classic = props.bookshelfFor(undefined);
  assert.equal(props.bookshelfFor(S), classic, 'a full count is the same sprite as no data');
  assert.equal(props.bookshelfFor(S + 50), classic);
  const dumps = [0, 1, 3, 12, S - 1].map((n) => props.bookshelfFor(n).dump());
  assert.equal(new Set([...dumps, classic.dump()]).size, dumps.length + 1, 'every count draws differently');
  // empty shelves: only wood and the dark cavity inside the shelf rows
  const empty: PxCanvas = props.bookshelfFor(0);
  const cavity = new Set<string>();
  for (let y = 11; y < 17; y++) for (let x = 3; x < 29; x++) cavity.add(empty.get(x, y) ?? '-');
  assert.deepEqual([...cavity], ['#3b2a20']);
  // more books, more book pixels
  const bookPx = (c: PxCanvas): number => { let n = 0; for (let y = 10; y < 33; y++) for (let x = 3; x < 29; x++) if (!['#3b2a20', '#2a1d16'].includes(c.get(x, y) ?? '') && c.get(x, y) !== empty.get(x, y)) n++; return n; };
  const counts = [0, 3, 12, 40].map((n) => bookPx(props.bookshelfFor(n)));
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i]! > counts[i - 1]!, `${counts}`);
});

test('bookshelf: deterministic per count (no flicker), cached per count, odd input is clamped', () => {
  const a = props.bookshelfFor(7).dump();
  caches.invalidateArtCaches();
  assert.equal(props.bookshelfFor(7).dump(), a, 'same pixels after a redraw');
  assert.equal(props.bookshelfFor(7), props.bookshelfFor(7.9), 'counts are whole');
  assert.equal(props.bookshelfFor(-3), props.bookshelfFor(0));
  assert.equal(props.bookshelfFor(Number.NaN), props.bookshelfFor(0));
  const before = F.furnitureCacheSize();
  props.bookshelfFor(5);
  props.bookshelfFor(6);
  assert.equal(F.furnitureCacheSize(), before + 2, 'one cache entry per count');
  props.bookshelfFor(5);
  assert.equal(F.furnitureCacheSize(), before + 2);
});

test('bookshelf: follows the office colours (cache dropped by invalidateArtCaches)', async () => {
  const palette = await load(`${ART}palette.ts`);
  const before = props.bookshelfFor(9).dump();
  palette.C.wood = '#123456';
  caches.invalidateArtCaches();
  try {
    assert.notEqual(props.bookshelfFor(9).dump(), before);
    assert.ok(props.bookshelfFor(9).dump().includes('#123456'));
  } finally {
    palette.applyOfficeColors(undefined);
    caches.invalidateArtCaches();
  }
  assert.equal(props.bookshelfFor(9).dump(), before);
});

// ---------------------------------------------------------------------------
// Filing cabinet drawer

test('cabinet: each drawer step is its own cached sprite, between closed and the rummage sprite', () => {
  const closed = F.filingCabinetSprite(false).dump();
  const open = F.filingCabinetSprite(true).dump();
  const steps = [1, 2, 3].map((k) => props.cabinetAjarSprite(k));
  const all = [closed, ...steps.map((s: PxCanvas) => s.dump()), open];
  assert.equal(new Set(all).size, all.length);
  assert.equal(props.cabinetAjarSprite(2), props.cabinetAjarSprite(2), 'cached');
  assert.equal(props.cabinetAjarSprite(9), props.cabinetAjarSprite(props.CABINET_DRAWER_STEPS), 'clamped');
  assert.equal(props.cabinetAjarSprite(0), props.cabinetAjarSprite(1));
  // only the top drawer changes: the bottom drawer is untouched
  for (const s of steps) assert.equal(s.dump(0, 21, 16, 9), F.filingCabinetSprite(false).dump(0, 21, 16, 9));
});

// ---------------------------------------------------------------------------
// The scene

const SETTINGS: OfficeSettings = { companyName: 'Middle Management', branchName: 'Branch', speechBubbles: true, managerName: 'You', bossQuotes: true };

async function scene(): Promise<{ s: any; office: any }> {
  caches.invalidateArtCaches();
  const office = new Office(await loadWorld());
  return { s: new Scene(), office };
}

const area = (c: PxCanvas, r: { x: number; y: number; w: number; h: number }): string => c.dump(r.x, r.y, r.w, r.h);
const cab = (id: string): { x: number; y: number; w: number; h: number } => {
  const f = map.getFurniture().find((x: { id: string }) => x.id === id);
  return { x: f.x, y: f.y, w: 16, h: 30 };
};

test('scene: no extras, empty extras and the new fields left out all draw the old props', async () => {
  const { s, office } = await scene();
  const A = map.PROP_ANCHORS;
  const shots = (extras: unknown): string[] => {
    s.render(office, SETTINGS, 1000, null, extras);
    return [area(s.canvas, A.phone), area(s.canvas, A.bookshelf), area(s.canvas, A.filingCabinets)];
  };
  const none = shots(undefined);
  assert.deepEqual(shots({}), none);
  assert.deepEqual(shots({ phoneLights: [], cabinetHover: false }), none);
  // the old look: the furniture sprites themselves
  const ref = blank(map.MAP_PX_W, map.MAP_PX_H);
  const shelf = map.getFurniture().find((f: { id: string }) => f.id === 'bookshelf');
  ref.getContext().drawImage(shelf.sprite, shelf.x, shelf.y);
  assert.equal(area(s.canvas, { x: shelf.x + 2, y: shelf.y + 6, w: 28, h: 26 }), area(ref, { x: shelf.x + 2, y: shelf.y + 6, w: 28, h: 26 }));
});

test('scene: phoneLights, shelfCount and cabinetHover change what is drawn', async () => {
  const { s, office } = await scene();
  const A = map.PROP_ANCHORS;
  s.render(office, SETTINGS, 1000, null, {});
  const base = { phone: area(s.canvas, A.phone), shelf: area(s.canvas, A.bookshelf), cab: area(s.canvas, A.filingCabinets) };

  s.render(office, SETTINGS, 1016, null, { phoneLights: ['connected', 'failed', 'needsAuth', 'pending', 'connected'] });
  assert.notEqual(area(s.canvas, A.phone), base.phone);
  const at = map.phoneAnchor;
  assert.equal(s.canvas.get(at.x + F.PHONE_LIGHTS[1].x, at.y + F.PHONE_LIGHTS[1].y), props.PHONE_LIGHT_COLORS.failed);

  s.render(office, SETTINGS, 1032, null, { shelfCount: 3 });
  assert.notEqual(area(s.canvas, A.bookshelf), base.shelf);
  const three = area(s.canvas, A.bookshelf);
  s.render(office, SETTINGS, 1048, null, { shelfCount: 3 });
  assert.equal(area(s.canvas, A.bookshelf), three, 'same count, same shelf');
  s.render(office, SETTINGS, 1064, null, { shelfCount: 0 });
  assert.notEqual(area(s.canvas, A.bookshelf), three);
  s.render(office, SETTINGS, 1080, null, { shelfCount: 1000 });
  assert.equal(area(s.canvas, A.bookshelf), base.shelf, 'a full shelf is the classic one');
});

test('scene: the hover drawer slides out over a few frames, and back', async () => {
  const { s, office } = await scene();
  const mid = cab('filing-22');
  const frame = (t: number, hover: string | boolean | undefined): string => { s.render(office, SETTINGS, t, null, { cabinetHover: hover }); return area(s.canvas, mid); };
  const closed = frame(0, false);
  const closedLeft = area(s.canvas, cab('filing-21'));
  frame(10, true); // the hover starts
  const states = new Set<string>();
  let t = 10;
  for (; t <= 10 + props.CABINET_DRAWER_MS_PER_PX * (props.CABINET_DRAWER_STEPS + 1); t += 16) states.add(frame(t, true));
  const full = frame(t + 500, true);
  assert.notEqual(full, closed);
  assert.ok(states.size >= props.CABINET_DRAWER_STEPS, `${states.size} distinct frames while sliding`);
  // fully out = the last ajar step
  const ref = blank(map.MAP_PX_W, map.MAP_PX_H);
  ref.getContext().drawImage(props.cabinetAjarSprite(props.CABINET_DRAWER_STEPS), mid.x, mid.y);
  const inner = { x: mid.x + 1, y: mid.y + 4, w: 14, h: 8 };
  assert.equal(area(s.canvas, inner), area(ref, inner));
  // other cabinets stay shut
  assert.equal(area(s.canvas, cab('filing-21')), closedLeft);
  // un-hovered: it slides shut again
  frame(t + 1000, false);
  assert.equal(frame(t + 2000, false), closed);
});

test('scene: cabinetHover can name the cabinet; any other truthy value opens the middle one', async () => {
  const { s, office } = await scene();
  const run = (hover: string | boolean): [string, string] => {
    s.render(office, SETTINGS, 0, null, { cabinetHover: false });
    s.render(office, SETTINGS, 1, null, { cabinetHover: hover });
    s.render(office, SETTINGS, 1000, null, { cabinetHover: hover });
    return [area(s.canvas, cab('filing-21')), area(s.canvas, cab('filing-22'))];
  };
  s.render(office, SETTINGS, 0, null, {});
  const shut = [area(s.canvas, cab('filing-21')), area(s.canvas, cab('filing-22'))];
  const left = run('filing-21');
  assert.notEqual(left[0], shut[0]);
  assert.equal(left[1], shut[1]);
  for (const h of [true, 'filingCabinets', 'filing-22']) {
    const r = run(h);
    s.render(office, SETTINGS, 5000, null, { cabinetHover: false });
    s.render(office, SETTINGS, 9000, null, { cabinetHover: false });
    assert.equal(r[0], shut[0], String(h));
    assert.notEqual(r[1], shut[1], String(h));
  }
});
