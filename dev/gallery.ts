/**
 * Dev-only sprite gallery (open dev/sprites.html via file://).
 * Sections can be shown alone with a hash: #scene, #scene1, #live, #props, #state, #icons, #chars, #detail, #helpdesk,
 * #phone, #npc, #palette, #misc, #furniture.
 */
import {
  ALL_LOOKS, ALL_POSES, HEAD_SETS, LOOKS, LOOK_FIELD_USE, POSES, CHAR_W, CHAR_ANCHOR_Y, buildLook, frameAt, getCharacterFrame, registerLook,
  FOOD_IDS, NPC_LOOKS, NPC_LOOK_IDS, foodSprite, lookHasPose,
} from '../webview/art/characters.ts';
import { FOOD_CART_ANCHOR, foodCartPlacement, foodCartSprite } from '../webview/art/foodCart.ts';
import type { CartFacing } from '../webview/art/foodCart.ts';
import { applyOfficeColors } from '../webview/art/palette.ts';
import { invalidateArtCaches } from '../webview/art/caches.ts';
import type { OfficeColorKey } from '../src/shared/theme.ts';
import type { Dir, LookId, Pose } from '../webview/art/characters.ts';
import {
  MAP_PX_H, MAP_PX_W, PROP_ANCHORS, deskPileAnchors, desks, drawClockHands, drawSignText, getFurniture, poi, renderBackground,
  seatFor, seats, tileFeet,
} from '../webview/art/office-map.ts';
import type { FurnitureItem, PropAnchor, PropId, Spot, TilePos } from '../webview/art/office-map.ts';
import {
  BACK_SIGN_SORT_Y, BOOKSHELF_SLOTS, CABINET_DRAWER_STEPS, bookshelfFor, cabinetAjarSprite, drawBackSign, drawCalendar, drawDeskPile,
  drawInTray, drawPhoneLights, drawPlanNotes, drawPropOutline, drawUsageRing,
} from '../webview/art/props.ts';
import type { PhoneLightState, PlanNoteCounts, UsageLevel } from '../webview/art/props.ts';
import { drawIconBubble, drawTextBubble, drawNameLabel, ICON_IDS, getIcon } from '../webview/art/bubbles.ts';
import type { IconId } from '../webview/art/bubbles.ts';
import { BOOT_MS, drawScreen } from '../webview/art/screens.ts';
import type { ScreenKind } from '../webview/art/screens.ts';
import { drawPixelText } from '../webview/art/font.ts';
import * as F from '../webview/art/furniture.ts';

const root = document.getElementById('root')!;
const only = location.hash.slice(1);
const show = (id: string): boolean => !only || only === id;

function section(title: string, note?: string): HTMLDivElement {
  const h = document.createElement('h2');
  h.textContent = title;
  root.appendChild(h);
  if (note) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = note;
    root.appendChild(p);
  }
  const d = document.createElement('div');
  d.className = 'wrap';
  root.appendChild(d);
  return d;
}

function canvas(w: number, h: number, parent: HTMLElement, cssScale = 1): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.style.width = `${w * cssScale}px`;
  c.style.height = `${h * cssScale}px`;
  parent.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

const loops: ((t: number) => void)[] = [];

// ---------------------------------------------------------------------------
// Office scene

interface Actor {
  look: LookId;
  pose: Pose;
  dir: Dir;
  tile: TilePos;
  offset: number;
  screen?: { deskId: string; kind: ScreenKind };
  icon?: IconId;
  thought?: boolean;
  say?: string;
}

const atSeat = (look: LookId, owner: Parameters<typeof seatFor>[0], pose: Pose, kind: ScreenKind, extra: Partial<Actor> = {}): Actor => {
  const s = seatFor(owner)!;
  return { look, pose, dir: 'down', tile: s.tile, offset: Math.random() * 3000, screen: { deskId: s.deskId, kind }, ...extra };
};
const atSeatId = (look: LookId, id: string, pose: Pose, kind: ScreenKind, extra: Partial<Actor> = {}): Actor => {
  const s = seats.find((x) => x.id === id)!;
  return { look, pose, dir: 'down', tile: s.tile, offset: Math.random() * 3000, screen: { deskId: s.deskId, kind }, ...extra };
};
const atSpot = (look: LookId, sp: Spot, extra: Partial<Actor> = {}): Actor => ({ look, pose: sp.pose, dir: sp.facing, tile: sp.tile, offset: Math.random() * 3000, ...extra });

const actors: Actor[] = [
  atSeat('manager', 'manager', 'mugSip', 'browser', { say: "World's best boss!" }),
  atSeat('assistant', 'assistant', 'sitType', 'code', { icon: 'pencil' }),
  atSeat('prankster', 'prankster', 'sitThink', 'code', { icon: 'thinking', thought: true }),
  atSeat('receptionist', 'reception', 'sitPhone', 'document', { say: 'Front desk, how can I help?' }),
  atSeat('helpdesk', 'helpdesk', 'sitType', 'terminal', { icon: 'search' }),
  atSeat('chili', 'chili', 'sitRun', 'terminal', { icon: 'terminal' }),
  atSeat('hr', 'hr', 'sitIdle', 'idle'),
  atSeatId('temp0', 'temp-annex-1', 'sitType', 'code'),
  atSeatId('temp4', 'temp-annex-3', 'sitRun', 'terminal'),
  atSeatId('temp5', 'temp-annex-6', 'sitRead', 'browser', { icon: 'globe' }),
  atSpot('crossword', poi.copier, { icon: 'coffee' }),
  atSpot('cat', poi.waterCooler[0]!, { say: 'Did you see that?' }),
  atSpot('temp3', poi.waterCooler[1]!),
  atSpot('knitting', poi.managerDoorQueue[0]!, { icon: 'alert' }),
  atSpot('temp1', poi.managerDoorQueue[1]!),
  atSpot('temp2', poi.whiteboard, { icon: 'clipboard' }),
  atSpot('temp4', poi.filingCabinets[0]!, { icon: 'search' }),
  atSpot('temp5', poi.easel, { icon: 'palette' }),
  { look: 'temp0', pose: 'walk', dir: 'left', tile: { x: 21, y: 9 }, offset: 0 },
];

/** Office-tool props in a busy state, for the "live props" scene. */
const LIVE = {
  usage: { pct: 91, level: 'danger' as UsageLevel, back: '17:30' },
  week: { pct: 64, level: 'warn' as UsageLevel },
  inTray: { count: 4, urgent: true },
  piles: { 'desk-assistant': [2, false], 'desk-prankster': [4, true], 'desk-chili': [3, false], 'desk-hr': [1, false], 'temp-annex-1': [4, false], 'temp-annex-3': [2, false] } as Record<string, [number, boolean]>,
  planNotes: { pending: 2, approved: 4, rejected: 1 } as PlanNoteCounts,
  phone: ['connected', 'connected', 'failed', 'pending', 'connected', 'needsAuth'] as PhoneLightState[],
  shelf: 12,
};

function drawScene(ctx: CanvasRenderingContext2D, t: number, live = false): void {
  ctx.drawImage(renderBackground(), 0, 0);
  drawSignText(ctx, 'Middle Management', 'Regional Branch');
  if (live) {
    drawCalendar(ctx, 0, 0, LIVE.week.pct, LIVE.week.level);
    drawUsageRing(ctx, 0, 0, LIVE.usage.pct, LIVE.usage.level);
  }
  drawClockHands(ctx, new Date(2026, 9, 18, 10, 9));
  if (live) drawPlanNotes(ctx, 0, 0, LIVE.planNotes);
  type D = { sortY: number; furniture: boolean; draw: () => void };
  const list: D[] = [];
  for (const f of getFurniture()) {
    let spr = f.sprite;
    if (f.id === 'filing-21' && f.variants.open) spr = f.variants.open;
    if (f.id === 'copier' && f.variants.active) spr = f.variants.active;
    if (f.id === 'desk-receptionist-top' && f.variants.phoneOff) spr = f.variants.phoneOff; // she's on the phone
    if (live && f.id === 'bookshelf') spr = bookshelfFor(LIVE.shelf);
    if (live && f.id === 'filing-22') spr = cabinetAjarSprite(CABINET_DRAWER_STEPS);
    list.push({ sortY: f.sortY, furniture: true, draw: () => ctx.drawImage(spr, f.x, f.y) });
    if (f.kind === 'deskTop' && f.deskId) {
      const d = desks.find((x) => x.id === f.deskId)!;
      const a = actors.find((x) => x.screen?.deskId === f.deskId);
      list.push({ sortY: f.sortY + 0.01, furniture: true, draw: () => {
        drawScreen(ctx, d.screen, a?.screen?.kind ?? 'off', t, 0, 0);
        if (!live) return;
        const pile = LIVE.piles[d.id];
        const at = deskPileAnchors[d.id];
        if (pile && at) drawDeskPile(ctx, at.x, at.y, pile[0], pile[1]);
        if (d.kind === 'manager') {
          drawInTray(ctx, 0, 0, LIVE.inTray.count, LIVE.inTray.urgent, t, 'tray');
          drawPhoneLights(ctx, 0, 0, LIVE.phone, t);
        }
      } });
    }
  }
  if (live) {
    list.push({ sortY: BACK_SIGN_SORT_Y, furniture: true, draw: () => drawBackSign(ctx, 0, 0, `BACK ${LIVE.usage.back}`) });
    list.push({ sortY: 5 * 16 + 31.5, furniture: true, draw: () => drawInTray(ctx, 0, 0, LIVE.inTray.count, LIVE.inTray.urgent, t, 'badge') });
  }
  for (const a of actors) {
    const feet = tileFeet(a.tile);
    let fx = feet.x;
    if (a.pose === 'walk') fx -= ((t / 30) % 64);
    const fr = getCharacterFrame(a.look, a.pose, a.dir, frameAt(a.pose, t + a.offset));
    list.push({ sortY: feet.y, furniture: false, draw: () => ctx.drawImage(fr, Math.round(fx - 8), feet.y - CHAR_ANCHOR_Y) });
  }
  list.sort((p, q) => p.sortY - q.sortY || (p.furniture === q.furniture ? 0 : p.furniture ? -1 : 1));
  for (const d of list) d.draw();
  // bubbles last
  for (const a of actors) {
    const feet = tileFeet(a.tile);
    const top = feet.y - 25 + (POSES[a.pose].seated ? 2 : 0);
    if (a.say) drawTextBubble(ctx, a.say, feet.x, top, { maxW: 70, bounds: { w: MAP_PX_W, h: MAP_PX_H } });
    else if (a.icon) drawIconBubble(ctx, a.icon, feet.x, top, a.thought ? 'thought' : 'speech');
  }
  drawNameLabel(ctx, 'You', tileFeet(seatFor('manager')!.tile).x, tileFeet(seatFor('manager')!.tile).y + 2);
  if (live) drawPropOutline(ctx, 0, 0, PROP_ANCHORS.bookshelf);
}

if (show('scene')) {
  const d = section('Office scene (2x)', 'Seated staff, temps in the annex, filing cabinet, easel, whiteboard, copier, a queue of two at the manager\'s door, two chatting at the water cooler.');
  const ctx = canvas(MAP_PX_W, MAP_PX_H, d, 2);
  loops.push((t) => drawScene(ctx, t));
}
if (show('scene1')) {
  const d = section('Office scene (1x native)');
  const ctx = canvas(MAP_PX_W, MAP_PX_H, d, 1);
  loops.push((t) => drawScene(ctx, t));
}
if (show('live')) {
  const d = section('Office scene with live office-tool props (2x)', 'Usage ring 91% (danger) with the BACK card, calendar week 64% (warn), in-tray 4 urgent, desk piles (prankster 4 + warn), plan notes 2/4/1, phone lines connected/connected/failed/pending + 2 more (needsAuth: blue "+"), bookshelf with 12 items and its hover outline, the middle filing cabinet\'s drawer out (hover).');
  const ctx = canvas(MAP_PX_W, MAP_PX_H, d, 2);
  loops.push((t) => drawScene(ctx, t, true));
}

// ---------------------------------------------------------------------------
// Office-tool props: every state, cropped from the map at 4x

/** Draws the background and the furniture under `r`, then `extra`, into a cell scaled 4x. */
function propCell(
  parent: HTMLElement, label: string, r: PropAnchor, extra: (ctx: CanvasRenderingContext2D, ox: number, oy: number, t: number) => void, animate = false,
  swap?: (f: FurnitureItem) => HTMLCanvasElement | undefined,
): void {
  const box = document.createElement('div');
  box.className = 'cell';
  const S = 4;
  const ctx = canvas(r.w, r.h, box, S);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = label;
  box.appendChild(cap);
  parent.appendChild(box);
  const draw = (t: number): void => {
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.drawImage(renderBackground(), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const ox = -r.x;
    const oy = -r.y;
    for (const f of getFurniture()) {
      if (f.x > r.x + r.w || f.y > r.y + r.h || f.x + f.sprite.width < r.x || f.y + f.sprite.height < r.y) continue;
      if (f.sortY > r.y + r.h + 40) continue;
      ctx.drawImage(swap?.(f) ?? f.sprite, f.x + ox, f.y + oy);
    }
    extra(ctx, ox, oy, t);
  };
  if (animate) loops.push(draw); else draw(0);
}

if (show('props')) {
  const A = PROP_ANCHORS;
  const grow = (r: PropAnchor, m: number, dy = 0, extraH = 0): PropAnchor => ({ x: r.x - m, y: r.y - m + dy, w: r.w + 2 * m, h: r.h + 2 * m + extraH });
  const clockR = grow(A.clock, 6, 0, 12);
  const row = (title: string): HTMLElement => {
    const d = section(title);
    d.classList.add('cells');
    return d;
  };
  let d = row('Wall clock: 5-hour usage ring (ok < 60, warn 60-84, danger 85+, unknown = no ring) and the BACK card');
  const levels: [number | null, UsageLevel][] = [[null, 'unknown'], [0, 'ok'], [34, 'ok'], [72, 'warn'], [91, 'danger'], [100, 'danger']];
  for (const [pct, lv] of levels) propCell(d, `${lv} ${pct ?? '-'}%`, clockR, (c, ox, oy) => { drawUsageRing(c, ox, oy, pct, lv); drawClockHands(c, new Date(2026, 9, 18, 10, 9), ox, oy); });
  propCell(d, 'danger 100% + BACK 17:30', grow(clockR, 6, 0, 0), (c, ox, oy) => { drawUsageRing(c, ox, oy, 100, 'danger'); drawClockHands(c, new Date(2026, 9, 18, 10, 9), ox, oy); drawBackSign(c, ox, oy, 'BACK 17:30'); });
  propCell(d, 'BACK 9:05', grow(clockR, 6, 0, 0), (c, ox, oy) => { drawUsageRing(c, ox, oy, 97, 'danger'); drawClockHands(c, new Date(2026, 9, 18, 10, 9), ox, oy); drawBackSign(c, ox, oy, 'BACK 9:05'); });

  d = row('Wall calendar: weekly window');
  for (const [pct, lv] of [[null, 'unknown'], [8, 'ok'], [45, 'ok'], [70, 'warn'], [88, 'danger'], [100, 'danger']] as [number | null, UsageLevel][]) {
    propCell(d, `${lv} ${pct ?? '-'}%`, grow(A.calendar, 3), (c, ox, oy) => drawCalendar(c, ox, oy, pct, lv));
  }

  d = row('Manager\'s in-tray: empty, 1, 4, 12, urgent (badge pulses)');
  const trayR = grow(A.inTray, 6, -2, 2);
  for (const [n, u] of [[0, false], [1, false], [4, false], [12, false], [2, true], [12, true]] as [number, boolean][]) {
    propCell(d, `${n}${u ? ' urgent' : ''}`, trayR, (c, ox, oy, t) => { drawInTray(c, ox, oy, n, u, t); }, true);
  }

  d = row('Desk paper piles: 0-4 sheets, then 3 and 4 with warn (90%+), left and right seats');
  const pileDesk = (id: string): PropAnchor => {
    const s = seats.find((x) => x.id === id)!;
    const left = deskPileAnchors[id]!;
    return { x: Math.min(left.x - 20, s.tile.x * 16 - 16), y: s.tile.y * 16 - 14, w: 52, h: 46 };
  };
  const pileCases: [string, number, boolean][] = [['desk-assistant', 0, false], ['desk-assistant', 1, false], ['desk-assistant', 2, false], ['desk-assistant', 3, false], ['desk-assistant', 4, false], ['desk-assistant', 3, true], ['desk-assistant', 4, true], ['desk-prankster', 4, false], ['desk-prankster', 4, true], ['desk-crossword', 3, false]];
  for (const [id, n, w] of pileCases) {
    const at = deskPileAnchors[id]!;
    propCell(d, `${id.replace('desk-', '')} ${n}${w ? ' warn' : ''}`, pileDesk(id), (c, ox, oy) => drawDeskPile(c, at.x + ox, at.y + oy, n, w));
  }

  d = row('Whiteboard plans board: waiting / approved / sent back');
  const notes: PlanNoteCounts[] = [{ pending: 0, approved: 0, rejected: 0 }, { pending: 1, approved: 2, rejected: 0 }, { pending: 3, approved: 5, rejected: 2 }, { pending: 9, approved: 6, rejected: 12 }];
  for (const n of notes) propCell(d, `${n.pending}/${n.approved}/${n.rejected}`, grow(A.whiteboard, 2), (c, ox, oy) => drawPlanNotes(c, ox, oy, n));

  d = row('New decoration and hover outlines (every PROP_ANCHORS rect)');
  // (the v0.4 phone, bookshelf and cabinet states are in #state)
  const ids = Object.keys(A) as PropId[];
  for (const id of ids) propCell(d, id, grow(A[id], 4), (c, ox, oy) => drawPropOutline(c, ox, oy, A[id]));
}

// ---------------------------------------------------------------------------
// v0.4 prop states: phone lights per MCP server, bookshelf fill, the hover drawer (4x)

if (show('state') || show('props')) {
  const A = PROP_ANCHORS;
  const grow = (r: PropAnchor, m: number): PropAnchor => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  const row = (title: string, note?: string): HTMLElement => {
    const d = section(title, note);
    d.classList.add('cells');
    return d;
  };
  let d = row('Desk phone: one light per MCP server (SceneExtras.phoneLights)', 'connected green, pending amber (blinks slowly), failed red, needsAuth blue, unknown dim, disabled off. Four fit; more show a "+" in the corner, tinted like the most pressing hidden server.');
  const phoneR = grow(A.phone, 6);
  const phoneCases: [string, PhoneLightState[]][] = [
    ['no data', []],
    ['1: connected', ['connected']],
    ['4 mixed', ['connected', 'pending', 'failed', 'needsAuth']],
    ['4: unknown, disabled', ['connected', 'unknown', 'disabled', 'connected']],
    ['9 mixed (+ red)', ['connected', 'connected', 'pending', 'connected', 'connected', 'failed', 'disabled', 'connected', 'unknown']],
    ['6 (+ neutral)', ['connected', 'connected', 'connected', 'needsAuth', 'connected', 'disabled']],
    ['5 (+ amber)', ['failed', 'connected', 'connected', 'connected', 'pending']],
  ];
  for (const [name, st] of phoneCases) propCell(d, name, phoneR, (c, ox, oy, t) => drawPhoneLights(c, ox, oy, st, t), true);
  propCell(d, 'pending, no clock', phoneR, (c, ox, oy) => drawPhoneLights(c, ox, oy, ['pending', 'pending', 'pending', 'pending']));

  d = row(`Bookshelf: skills and commands (SceneExtras.shelfCount), full from ${BOOKSHELF_SLOTS}`);
  const shelfR = grow(A.bookshelf, 3);
  const shelfCases: [string, number | undefined][] = [['no data', undefined], ['0', 0], ['1', 1], ['3', 3], ['7', 7], ['12', 12], ['20', 20], ['40', 40]];
  for (const [name, n] of shelfCases) propCell(d, name, shelfR, () => {}, false, (f) => (f.id === 'bookshelf' ? bookshelfFor(n) : undefined));

  d = row('Filing cabinets: hover drawer (SceneExtras.cabinetHover) slides out 1-3 px; the rummage sprite for comparison');
  const cabR = grow(A.filingCabinets, 3);
  const cabCases: [string, (id: string) => HTMLCanvasElement | undefined][] = [
    ['closed (no hover)', () => undefined],
    ...Array.from({ length: CABINET_DRAWER_STEPS }, (_, i): [string, (id: string) => HTMLCanvasElement | undefined] => [`hover ${i + 1} px`, (id) => (id === 'filing-22' ? cabinetAjarSprite(i + 1) : undefined)]),
    ['hover filing-21', (id) => (id === 'filing-21' ? cabinetAjarSprite(CABINET_DRAWER_STEPS) : undefined)],
    ['rummage (open)', (id) => (id === 'filing-22' ? F.filingCabinetSprite(true) : undefined)],
  ];
  for (const [name, pick] of cabCases) propCell(d, name, cabR, () => {}, false, (f) => pick(f.id));
}

// ---------------------------------------------------------------------------
// Character sheet: every look x pose x direction, animated, 4x

if (show('chars')) {
  const d = section('Characters (4x, animated)', 'Rows: looks (the built-ins, then the cleaner and the vendor). Columns: pose / direction. Poses with onlyLooks are shown for those looks only.');
  const rowLooks = [...ALL_LOOKS, ...NPC_LOOK_IDS];
  const cols: [Pose, Dir][] = [];
  for (const p of ALL_POSES) for (const dir of POSES[p].dirs) cols.push([p, dir]);
  for (const p of ALL_POSES) if (POSES[p].dirs.includes('left') && !POSES[p].dirs.includes('right')) cols.push([p, 'right']);
  const S = 4;
  const cw = CHAR_W * S + 8;
  const ch = CHAR_ANCHOR_Y * S + 8;
  const lw = 120;
  const ctx = canvas(lw + cols.length * cw, 24 + rowLooks.length * ch, d, 1);
  loops.push((t) => {
    ctx.fillStyle = '#2a2a33';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#c9c3b6';
    ctx.font = '10px monospace';
    cols.forEach(([p, dir], i) => ctx.fillText(`${p}`, lw + i * cw + 2, 10));
    cols.forEach(([, dir], i) => ctx.fillText(dir, lw + i * cw + 2, 21));
    rowLooks.forEach((look, r) => {
      const y = 24 + r * ch;
      ctx.fillStyle = r % 2 ? '#3a3a45' : '#34343e';
      ctx.fillRect(0, y, ctx.canvas.width, ch);
      ctx.fillStyle = '#efe6d0';
      ctx.fillText(look, 6, y + 16);
      ctx.fillStyle = '#9a958c';
      ctx.fillText((LOOKS[look]?.role ?? NPC_LOOKS[look]?.role ?? '').slice(0, 18), 6, y + 30);
      cols.forEach(([p, dir], i) => {
        if (!lookHasPose(look, p)) return;
        const fr = getCharacterFrame(look, p, dir, frameAt(p, t + r * 137));
        ctx.drawImage(fr, lw + i * cw + 4, y + 4, CHAR_W * S, CHAR_ANCHOR_Y * S);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Frame-by-frame detail (8x, static) for close inspection

if (show('detail')) {
  const d = section('Frame detail (8x)', 'Manager: mugSip and chairSpin frames; think pose; wave; knock; copier wait.');
  const cells: [LookId, Pose, Dir, number][] = [
    ['manager', 'mugSip', 'down', 0], ['manager', 'mugSip', 'down', 1], ['manager', 'mugSip', 'down', 2],
    ['manager', 'chairSpin', 'down', 0], ['manager', 'chairSpin', 'down', 1], ['manager', 'chairSpin', 'down', 2], ['manager', 'chairSpin', 'down', 3],
    ['crossword', 'sitThink', 'down', 0], ['assistant', 'sitThink', 'down', 0], ['manager', 'wave', 'down', 0],
    ['receptionist', 'knock', 'up', 1], ['chili', 'copierWait', 'down', 1], ['cat', 'talk', 'left', 1], ['temp1', 'stand', 'up', 0],
    ['helpdesk', 'stand', 'down', 0], ['helpdesk', 'stand', 'left', 0], ['helpdesk', 'stand', 'up', 0], ['helpdesk', 'sitType', 'down', 1],
    ['receptionist', 'sitPhone', 'down', 0], ['receptionist', 'sitPhone', 'down', 3], ['helpdesk', 'sitPhone', 'down', 3], ['chili', 'sitPhone', 'down', 0],
  ];
  const S = 8;
  const ctx = canvas(cells.length * (CHAR_W * S + 8), CHAR_ANCHOR_Y * S + 8, d, 0.5);
  ctx.fillStyle = '#7c8696';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  cells.forEach(([look, pose, dir, f], i) => ctx.drawImage(getCharacterFrame(look, pose, dir, f), 4 + i * (CHAR_W * S + 8), 4, CHAR_W * S, CHAR_ANCHOR_Y * S));
}

// ---------------------------------------------------------------------------
// The IT Help Desk: every pose, the headset head on other looks, the new desk

/** A labelled cell with one canvas at `S`x, redrawn every frame by `draw`. */
function cellCanvas(parent: HTMLElement, label: string, w: number, h: number, S: number): CanvasRenderingContext2D {
  const box = document.createElement('div');
  box.className = 'cell';
  const ctx = canvas(w, h, box, S);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = label;
  box.appendChild(cap);
  parent.appendChild(box);
  return ctx;
}

if (show('helpdesk')) {
  let d = section('IT Help Desk (6x, animated)', `Headset, navy polo with a lanyard and ID badge, khakis. Fields that show on this look: ${LOOK_FIELD_USE['helpdesk']!.join(', ')}.`);
  d.classList.add('cells');
  const S = 6;
  const cols: [Pose, Dir][] = [];
  for (const p of ALL_POSES) {
    if (POSES[p].onlyLooks) continue;
    for (const dir of POSES[p].dirs) cols.push([p, dir]);
    if (POSES[p].dirs.includes('left') && !POSES[p].dirs.includes('right')) cols.push([p, 'right']);
  }
  for (const [p, dir] of cols) {
    const ctx = cellCanvas(d, `${p} ${dir}`, CHAR_W + 2, CHAR_ANCHOR_Y + 2, S);
    loops.push((t) => {
      ctx.fillStyle = '#7c8696';
      ctx.fillRect(0, 0, CHAR_W + 2, CHAR_ANCHOR_Y + 2);
      ctx.drawImage(getCharacterFrame('helpdesk', p, dir, frameAt(p, t)), 1, 1);
    });
  }

  d = section('The headset head on other looks (6x)', 'buildLook(..., { head: "headset" }, look): a theme can give anyone the headset; its colour is the look\'s bow colour.');
  d.classList.add('cells');
  const wearers = ['manager', 'receptionist', 'cat', 'chili', 'temp1', 'temp5'];
  for (const id of wearers) {
    const lookId = `__headset_${id}`;
    registerLook(buildLook(lookId, { head: 'headset', ...(id === 'receptionist' ? { bow: '#3a3440' } : {}) }, LOOKS[id]!));
    for (const [p, dir] of [['stand', 'down'], ['stand', 'left'], ['stand', 'up'], ['sitType', 'down']] as [Pose, Dir][]) {
      const ctx = cellCanvas(d, `${id} ${p} ${dir}`, CHAR_W + 2, CHAR_ANCHOR_Y + 2, S);
      loops.push((t) => {
        ctx.fillStyle = '#7c8696';
        ctx.fillRect(0, 0, CHAR_W + 2, CHAR_ANCHOR_Y + 2);
        ctx.drawImage(getCharacterFrame(lookId, p, dir, frameAt(p, t)), 1, 1);
      });
    }
  }
  void HEAD_SETS;

  d = section('The help desk at (15,14) with its seated worker (6x)', 'Rubber duck, label maker and a spare cable; the reception counter with the receptionist on the phone.');
  d.classList.add('cells');
  const deskCell = (label: string, x: number, y: number, w: number, h: number, look: LookId, pose: Pose, seatId: string): void => {
    const ctx = cellCanvas(d, label, w, h, S);
    const seat = seats.find((q) => q.id === seatId)!;
    loops.push((t) => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(renderBackground(), x, y, w, h, 0, 0, w, h);
      const feet = tileFeet(seat.tile);
      const items = getFurniture().filter((f) => f.x < x + w && f.y < y + h && f.x + f.sprite.width > x && f.y + f.sprite.height > y);
      const list: { sortY: number; draw: () => void }[] = items.map((f) => ({ sortY: f.sortY, draw: () => {
        ctx.drawImage(pose === 'sitPhone' && f.deskId === seatId && f.variants.phoneOff ? f.variants.phoneOff : f.sprite, f.x - x, f.y - y);
        if (f.kind === 'deskTop' && f.deskId === seatId) drawScreen(ctx, desks.find((q) => q.id === seatId)!.screen, 'terminal', t, -x, -y);
      } }));
      list.push({ sortY: feet.y + 0.001, draw: () => ctx.drawImage(getCharacterFrame(look, pose, 'down', frameAt(pose, t)), feet.x - 8 - x, feet.y - CHAR_ANCHOR_Y - y) });
      list.sort((a, b) => a.sortY - b.sortY);
      for (const e of list) e.draw();
    });
  };
  deskCell('desk-helpdesk, sitType', 13 * 16, 12 * 16, 5 * 16, 4 * 16, 'helpdesk', 'sitType', 'desk-helpdesk');
  deskCell('desk-helpdesk, sitPhone', 13 * 16, 12 * 16, 5 * 16, 4 * 16, 'helpdesk', 'sitPhone', 'desk-helpdesk');
  deskCell('front desk, receptionist sitPhone', 3 * 16, 3 * 16, 5 * 16, 4 * 16, 'receptionist', 'sitPhone', 'desk-receptionist');
}

// ---------------------------------------------------------------------------
// sitPhone for every look

if (show('phone')) {
  const d = section('sitPhone for every look (5x, animated)', 'Listening, a blink, then talking (open mouth) into the receiver held to the left ear.');
  d.classList.add('cells');
  for (const look of ALL_LOOKS) {
    const ctx = cellCanvas(d, look, CHAR_W + 2, CHAR_ANCHOR_Y + 2, 5);
    loops.push((t) => {
      ctx.fillStyle = '#7c8696';
      ctx.fillRect(0, 0, CHAR_W + 2, CHAR_ANCHOR_Y + 2);
      ctx.drawImage(getCharacterFrame(look, 'sitPhone', 'down', frameAt('sitPhone', t + look.length * 300)), 1, 1);
    });
  }
}

// ---------------------------------------------------------------------------
// Walk-on characters and new poses: the cleaner, the vendor and the food cart, deskSip, pickFood

/** Draws every frame of (look, pose, dir) side by side at 1x into ctx at (x, y), on a backdrop. */
function frameStrip(ctx: CanvasRenderingContext2D, x: number, y: number, look: LookId, pose: Pose, dir: Dir, food?: (typeof FOOD_IDS)[number]): number {
  const n = POSES[pose].frames;
  for (let f = 0; f < n; f++) ctx.drawImage(getCharacterFrame(look, pose, dir, f, food), x + f * (CHAR_W + 2), y);
  return n * (CHAR_W + 2);
}

if (show('npc')) {
  const BG = '#7c8696';
  // 1. line-up at 1x and 3x next to office looks, so the cleaner and the vendor can be judged against them
  let d = section('Line-up (1x and 3x)', 'The cleaner (tabard, headscarf, rubber gloves), the vendor (paper hat, bib apron) and the IT pair, dez (messy hair, stubble, dark tee) and fenwick (side parting, big glasses, shirt and tie), among office looks.');
  const lineup: LookId[] = ['manager', 'assistant', 'cleaner', 'prankster', 'vendor', 'helpdesk', 'dez', 'fenwick', 'temp1', 'temp3', 'receptionist', 'dez', 'fenwick'];
  for (const S of [1, 3]) {
    const ctx = canvas(lineup.length * 18 + 4, CHAR_ANCHOR_Y + 4, d, S);
    ctx.fillStyle = '#5b6170';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    lineup.forEach((look, i) => ctx.drawImage(getCharacterFrame(look, 'stand', i % 3 === 1 ? 'left' : 'down', 0), 2 + i * 18, 2));
  }

  // 2. every frame of the NPC poses, static, 6x
  d = section('Cleaner and vendor: every frame (6x)', 'Rows: look / pose / direction; each strip shows the frames in order.');
  const rows: [LookId, Pose, Dir][] = [
    ['cleaner', 'stand', 'down'], ['cleaner', 'walk', 'down'], ['cleaner', 'walk', 'left'], ['cleaner', 'walk', 'up'],
    ['cleaner', 'wipe', 'left'], ['cleaner', 'wipe', 'right'], ['cleaner', 'wipe', 'down'], ['cleaner', 'wipe', 'up'],
    ['vendor', 'stand', 'down'], ['vendor', 'walk', 'left'], ['vendor', 'pushCart', 'right'], ['vendor', 'pushCart', 'down'], ['vendor', 'pushCart', 'up'],
    ['vendor', 'talk', 'left'],
  ];
  {
    const S = 6;
    const ctx = canvas(6 * (CHAR_W + 2) + 2, rows.length * (CHAR_ANCHOR_Y + 2), d, S);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    rows.forEach(([look, pose, dir], r) => frameStrip(ctx, 1, 1 + r * (CHAR_ANCHOR_Y + 2), look, pose, dir));
  }

  // 2b. the IT pair: stand and walk, then fixPc, scoff and readCard in all four directions, side by side
  d = section('IT support: dez and fenwick, every frame (6x)', 'Left block: dez; right block: fenwick. Rows: stand down/left/up, walk left, then fixPc, scoff and readCard in left, right, down, up. Last row: the assistant asked for the three poses gets stand, stand and talk.');
  {
    const S = 6;
    const itRows: [Pose, Dir][] = [['stand', 'down'], ['stand', 'left'], ['stand', 'up'], ['walk', 'left']];
    for (const p of ['fixPc', 'scoff', 'readCard'] as Pose[]) for (const dir of ['left', 'right', 'down', 'up'] as Dir[]) itRows.push([p, dir]);
    const blockW = 4 * (CHAR_W + 2) + 6;
    const ctx = canvas(2 * blockW + 2, (itRows.length + 1) * (CHAR_ANCHOR_Y + 2), d, S);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    (['dez', 'fenwick'] as LookId[]).forEach((look, b) => {
      itRows.forEach(([pose, dir], r) => frameStrip(ctx, 1 + b * blockW, 1 + r * (CHAR_ANCHOR_Y + 2), look, pose, dir));
    });
    const y = 1 + itRows.length * (CHAR_ANCHOR_Y + 2);
    (['fixPc', 'scoff', 'readCard'] as Pose[]).forEach((p, i) => ctx.drawImage(getCharacterFrame('assistant', p, 'left', 1), 1 + i * (CHAR_W + 2), y));
  }

  // 3. deskSip on real desks for every build (normal, tall, small, big) and an NPC fallback
  d = section('deskSip at a desk, every build (5x)', 'Columns: frames 0-3 (mug on the desk, lifted, sipping, lowered). The desk top here is the noMug variant. Rows: assistant, prankster (tall), cat (small), chili (big), temp1, helpdesk, the cleaner.');
  {
    const S = 5;
    const sipLooks: LookId[] = ['assistant', 'prankster', 'cat', 'chili', 'temp1', 'helpdesk', 'cleaner'];
    const cw = 34;
    const chh = 34;
    const ctx = canvas(4 * cw, sipLooks.length * chh, d, S);
    ctx.fillStyle = '#4a5060';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    sipLooks.forEach((look, r) => {
      for (let f = 0; f < 4; f++) {
        const X = f * cw + 1;
        const Y = r * chh + 12; // seat tile top-left
        ctx.drawImage(F.chairSprite('teal'), X, Y + 1);
        ctx.drawImage(F.deskTopSprite('crossword', true, 1, true), X, Y + F.DESK_TOP.dy);
        ctx.drawImage(getCharacterFrame(look, 'deskSip', 'down', f), X, Y + 16 - CHAR_ANCHOR_Y);
        ctx.drawImage(F.deskFrontSprite(true), X, Y + F.DESK_FRONT.dy);
      }
    });
  }

  // 4. pickFood: the manager with each food, both directions, every frame
  d = section('pickFood: the manager at the cart, every food (6x)', 'Reach, take, lift, hold it up. The engine picks the food: getCharacterFrame(look, "pickFood", dir, frame, food). Last row: the cleaner asked for pickFood gets stand.');
  {
    const S = 6;
    const list: [LookId, Dir, (typeof FOOD_IDS)[number]][] = [];
    for (const food of FOOD_IDS) for (const dir of ['down', 'left', 'right'] as Dir[]) list.push(['manager', dir, food]);
    list.push(['cleaner', 'left', 'doughnut']);
    const ctx = canvas(4 * (CHAR_W + 2) + 2, list.length * (CHAR_ANCHOR_Y + 2), d, S);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    list.forEach(([look, dir, food], r) => frameStrip(ctx, 1, 1 + r * (CHAR_ANCHOR_Y + 2), look, 'pickFood', dir, food));
  }

  // 5. the food cart: sprites alone, then pushed by the vendor in each direction (sorted like the scene does)
  d = section('Food cart (4x): alone, and pushed by the vendor', 'foodCartSprite(facing) with its anchor marked; then foodCartPlacement(facing, feetX, feetY) with the vendor in pushCart, sorted by sortY.');
  {
    const S = 4;
    const facings: CartFacing[] = ['right', 'left', 'down', 'up'];
    const ctx = canvas(facings.length * 44 + 4, 34, d, S);
    ctx.fillStyle = '#b9ab8e';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    facings.forEach((f, i) => {
      const c = foodCartSprite(f);
      const ax = 4 + i * 44 + 16;
      const ay = 30;
      ctx.drawImage(c, ax - FOOD_CART_ANCHOR[f].x, ay - FOOD_CART_ANCHOR[f].y);
      ctx.fillStyle = '#ff2a6a';
      ctx.fillRect(ax, ay, 1, 1);
    });
    const ctx2 = canvas(facings.length * 64, 64, d, S);
    loops.push((t) => {
      ctx2.fillStyle = '#b9ab8e';
      ctx2.fillRect(0, 0, ctx2.canvas.width, ctx2.canvas.height);
      facings.forEach((f, i) => {
        const feetX = i * 64 + (f === 'right' ? 14 : f === 'left' ? 50 : 32);
        const feetY = f === 'down' ? 34 : f === 'up' ? 54 : 46;
        const p = foodCartPlacement(f, feetX, feetY);
        const vendor = { sortY: feetY, draw: () => ctx2.drawImage(getCharacterFrame('vendor', 'pushCart', f, frameAt('pushCart', t)), feetX - 8, feetY - CHAR_ANCHOR_Y) };
        const cart = { sortY: p.sortY, draw: () => ctx2.drawImage(foodCartSprite(f), p.x, p.y) };
        for (const e of [vendor, cart].sort((a, b) => a.sortY - b.sortY)) e.draw();
      });
    });
    // the manager picking from the parked cart (the cart faces right, the manager stands at its long side facing up... and
    // at its end facing left), and the vendor waiting
    const ctx3 = canvas(140, 56, d, S);
    loops.push((t) => {
      ctx3.fillStyle = '#b9ab8e';
      ctx3.fillRect(0, 0, ctx3.canvas.width, ctx3.canvas.height);
      const vx = 20;
      const vy = 44;
      const p = foodCartPlacement('right', vx, vy);
      ctx3.drawImage(getCharacterFrame('vendor', 'talk', 'right', frameAt('talk', t)), vx - 8, vy - CHAR_ANCHOR_Y);
      ctx3.drawImage(foodCartSprite('right'), p.x, p.y);
      ctx3.drawImage(getCharacterFrame('manager', 'pickFood', 'left', frameAt('pickFood', t), 'carrotCake'), vx + 38 - 8, vy - CHAR_ANCHOR_Y);
      const q = foodCartPlacement('down', 100, 20);
      ctx3.drawImage(getCharacterFrame('vendor', 'stand', 'down', 0), 100 - 8, 20 - CHAR_ANCHOR_Y);
      ctx3.drawImage(foodCartSprite('down'), q.x, q.y);
      ctx3.drawImage(getCharacterFrame('manager', 'pickFood', 'down', frameAt('pickFood', t + 700), 'doughnut'), 124 - 8, 52 - CHAR_ANCHOR_Y);
    });
  }

  // 6. food items at 8x
  d = section('Food items (8x)', `FOOD_IDS: ${FOOD_IDS.join(', ')}; foodSprite(id) draws one with its outline.`);
  {
    const ctx = canvas(FOOD_IDS.length * 10 + 2, 10, d, 8);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    FOOD_IDS.forEach((id, i) => ctx.drawImage(foodSprite(id), 1 + i * 10, 1));
  }

  // 6b. in the office: the cleaner wiping at two desks' visit tiles, their workers sipping, the vendor's cart in the bullpen
  d = section('In the office (4x, animated)', 'The cleaner at the visit tiles of the help desk and temp-bullpen-5 (wipe), their workers sipping (deskSip, noMug desk tops), the vendor pushing the cart; dez fixing the crossword desk\'s computer (fixPc at the visit tile), fenwick behind the seat (scoff).');
  {
    const S = 4;
    const x0 = 9 * 16;
    const y0 = 9 * 16;
    const w = 10 * 16;
    const h = 7 * 16;
    const ctx = canvas(w, h, d, S);
    const help = seats.find((q) => q.id === 'desk-helpdesk')!;
    const asst = seatFor('assistant')!;
    const tempBullpen = seats.find((q) => q.id === 'temp-bullpen-5')!;
    const people: { look: LookId; pose: Pose; dir: Dir; tile: TilePos }[] = [
      { look: 'cleaner', pose: 'wipe', dir: help.visit.facing, tile: help.visit.tile },
      { look: 'helpdesk', pose: 'deskSip', dir: 'down', tile: help.tile },
      { look: 'assistant', pose: 'sitType', dir: 'down', tile: asst.tile },
      { look: 'cleaner', pose: 'wipe', dir: asst.visit.facing, tile: asst.visit.tile },
      { look: 'temp2', pose: 'deskSip', dir: 'down', tile: tempBullpen.tile },
      { look: 'cleaner', pose: 'wipe', dir: tempBullpen.visit.facing, tile: tempBullpen.visit.tile },
    ];
    // the IT pair at the crossword desk: dez at its visit tile fixing the computer, fenwick behind the seat, scoffing
    const pc = seats.find((q) => q.id === 'desk-crossword');
    if (pc) {
      people.push({ look: 'crossword', pose: 'sitIdle', dir: 'down', tile: pc.tile });
      people.push({ look: 'dez', pose: 'fixPc', dir: pc.visit.facing, tile: pc.visit.tile });
      people.push({ look: 'fenwick', pose: 'scoff', dir: 'down', tile: { x: pc.tile.x, y: pc.tile.y - 1 } });
    }
    loops.push((t) => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(renderBackground(), x0, y0, w, h, 0, 0, w, h);
      const list: { sortY: number; draw: () => void }[] = getFurniture()
        .filter((f) => f.x < x0 + w && f.y < y0 + h && f.x + f.sprite.width > x0 && f.y + f.sprite.height > y0)
        .map((f) => ({ sortY: f.sortY, draw: () => ctx.drawImage((f.deskId === help.deskId || f.deskId === tempBullpen.deskId) && f.kind === 'deskTop' ? f.variants['noMug'] ?? f.sprite : f.sprite, f.x - x0, f.y - y0) }));
      for (const p of people) {
        const feet = tileFeet(p.tile);
        list.push({ sortY: feet.y + 0.001, draw: () => ctx.drawImage(getCharacterFrame(p.look, p.pose, p.dir, frameAt(p.pose, t)), feet.x - 8 - x0, feet.y - CHAR_ANCHOR_Y - y0) });
      }
      // the vendor walking right along row 12 with the cart
      const vx = Math.round(x0 + 8 + ((t / 1000) * 36) % (w - 40));
      const vy = 12 * 16 + 16;
      const cp = foodCartPlacement('right', vx, vy);
      list.push({ sortY: vy + 0.001, draw: () => ctx.drawImage(getCharacterFrame('vendor', 'pushCart', 'right', frameAt('pushCart', t)), vx - 8 - x0, vy - CHAR_ANCHOR_Y - y0) });
      list.push({ sortY: cp.sortY + 0.001, draw: () => ctx.drawImage(foodCartSprite('right'), cp.x - x0, cp.y - y0) });
      list.sort((a, b) => a.sortY - b.sortY);
      for (const e of list) e.draw();
    });
  }

  // 7. desk tops with and without the mug
  d = section('Desk tops with their mug and the noMug variant (4x)', 'The engine swaps a desk top for item.variants.noMug while its worker plays deskSip (crossword, temps with a mug, the manager).');
  {
    const pairs: HTMLCanvasElement[] = [
      F.deskTopSprite('crossword', true), F.deskTopSprite('crossword', true, 1, true),
      F.managerDeskTopSprite(), F.managerDeskTopSprite(true),
    ];
    const ctx = canvas(pairs.reduce((a, c) => a + c.width + 4, 4), 28, d, 4);
    ctx.fillStyle = '#4a5060';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    let x = 4;
    for (const c of pairs) { ctx.drawImage(c, x, 2); x += c.width + 4; }
  }
}

// ---------------------------------------------------------------------------
// Icons, bubbles, font, screens

if (show('misc')) {
  const d = section('Icons, bubbles, font and screens');
  const ctx = canvas(560, 200, d, 2);
  loops.push((t) => {
    ctx.fillStyle = '#5f6c80';
    ctx.fillRect(0, 0, 560, 200);
    ICON_IDS.forEach((id, i) => {
      ctx.drawImage(getIcon(id), 6 + i * 16, 6);
      drawIconBubble(ctx, id, 13 + i * 20, 42, i % 3 === 1 ? 'thought' : 'speech');
    });
    drawTextBubble(ctx, 'Circle back to me.', 330, 42, { maxW: 80 });
    drawTextBubble(ctx, 'Running tests', 420, 42, { icon: 'terminal' });
    drawTextBubble(ctx, 'Hmm...', 500, 42, { kind: 'thought' });
    drawPixelText(ctx, 'The quick brown fox jumps over the lazy dog 0123456789', 6, 64, '#ffffff');
    drawPixelText(ctx, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz', 6, 74, '#ffffff');
    drawPixelText(ctx, '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', 6, 84, '#ffffff');
    drawPixelText(ctx, 'Middle Management', 6, 96, '#f3ead2', 2, '#141c2a');
    drawNameLabel(ctx, 'Regional Manager (you)', 200, 98);
    const kinds: ScreenKind[] = ['off', 'idle', 'code', 'terminal', 'browser', 'document', 'drawing', 'boot'];
    kinds.forEach((k, i) => {
      ctx.save();
      ctx.translate(6 + i * 40, 120);
      ctx.scale(4, 4);
      // the boot screen loops its BOOT_MS progress bar here, then holds full for half a second
      drawScreen(ctx, { x: 0, y: 0, w: 7, h: 7 }, k, k === 'boot' ? t % (BOOT_MS + 500) : t);
      ctx.restore();
      drawPixelText(ctx, k, 6 + i * 40, 152, '#ffffff');
    });
    // the boot screen's stages, frozen at a few elapsed times
    const stages = [0, 700, 1400, BOOT_MS];
    stages.forEach((ms, i) => {
      const x = 6 + (kinds.length + i) * 40;
      ctx.save();
      ctx.translate(x, 120);
      ctx.scale(4, 4);
      drawScreen(ctx, { x: 0, y: 0, w: 7, h: 7 }, 'boot', ms);
      ctx.restore();
      drawPixelText(ctx, `${ms}ms`, x, 152, '#ffffff');
    });
  });
}

// ---------------------------------------------------------------------------
// UI icons at the sizes the icon bar uses, on dark and light VS Code backgrounds

if (show('icons')) {
  const d = section('8x8 UI icons (icon bar and directory) at 16 / 20 / 40 CSS px, dark and light themes');
  const ui: IconId[] = ['inTray', 'plans', 'usage', 'bell', 'directory', 'newTask', 'files', 'library', 'phone', 'handbook', 'agency'];
  for (const [bg, fg] of [['#1f1f1f', '#cccccc'], ['#f8f8f8', '#3b3b3b']] as const) {
    const strip = document.createElement('div');
    strip.style.cssText = `display:flex;gap:18px;flex-wrap:wrap;padding:12px;background:${bg};color:${fg};margin-bottom:8px;font:11px system-ui`;
    for (const id of ui) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px';
      const icons = document.createElement('div');
      icons.style.cssText = 'display:flex;align-items:end;gap:6px';
      for (const px of [16, 20, 40]) {
        const c = document.createElement('canvas');
        c.width = 10;
        c.height = 10;
        c.style.width = `${px}px`;
        c.style.height = `${px}px`;
        c.getContext('2d')!.drawImage(getIcon(id), 0, 0);
        icons.appendChild(c);
      }
      cell.appendChild(icons);
      const cap = document.createElement('span');
      cap.textContent = id;
      cell.appendChild(cap);
      strip.appendChild(cell);
    }
    d.appendChild(strip);
  }
}

// ---------------------------------------------------------------------------
// Furniture sheet

if (show('furniture')) {
  const d = section('Furniture sprites (3x)');
  const items: [string, HTMLCanvasElement][] = [
    ['help desk top', F.deskTopSprite('helpdesk', true)],
    ['desk top L (assistant)', F.deskTopSprite('assistant', true)], ['desk front L', F.deskFrontSprite(true)],
    ['desk top R (prankster)', F.deskTopSprite('prankster', false)], ['desk front R', F.deskFrontSprite(false)],
    ['crossword', F.deskTopSprite('crossword', true)], ['cat', F.deskTopSprite('cat', true)], ['chili', F.deskTopSprite('chili', true)],
    ['knitting', F.deskTopSprite('knitting', true)], ['hr', F.deskTopSprite('hr', true)], ['temp', F.deskTopSprite('temp', true)],
    ['manager top', F.managerDeskTopSprite()], ['manager front', F.managerDeskFrontSprite()],
    ['reception top', F.receptionDeskTopSprite()], ['reception top, off hook', F.receptionDeskTopSprite(true)], ['reception front', F.receptionDeskFrontSprite()],
    ['chair', F.chairSprite('teal')], ['exec chair', F.chairSprite('exec')], ['kitchen chair', F.chairSprite('orange')], ['chair back', F.chairBackSprite('teal')],
    ['filing', F.filingCabinetSprite(false)], ['filing open', F.filingCabinetSprite(true)], ['copier', F.copierSprite(false)], ['copier active', F.copierSprite(true)],
    ['shredder', F.shredderSprite(false)], ['shredder active', F.shredderSprite(true)], ['cooler', F.waterCoolerSprite()], ['vending', F.vendingMachineSprite()],
    ['fridge', F.fridgeSprite()], ['counter', F.counterSprite()], ['easel', F.easelSprite()], ['plant', F.plantSprite(true, 1)], ['small plant', F.plantSprite(false, 3)],
    ['putter', F.putterSprite()], ['table top', F.roundTableTopSprite()], ['table front', F.roundTableFrontSprite()], ['conf table', F.conferenceTableSprite()],
    ['door closed', F.doorSprite('managerClosed')], ['door open', F.doorSprite('managerOpen')], ['glass', F.glassHSprite(0.4)], ['wall', F.wallHSprite()],
    ['bookshelf', F.bookshelfSprite()], ['directory board', F.directoryBoardSprite()], ['temp agency', F.tempAgencySignSprite()], ['desk phone', F.phoneSprite()],
    ['calendar', F.calendarSprite(null, 'unknown')], ['calendar 64% warn', F.calendarSprite(64, 'warn')],
  ];
  const ctx = canvas(1500, 660, d, 1);
  ctx.fillStyle = '#6a7488';
  ctx.fillRect(0, 0, 1500, 660);
  let x = 6;
  let y = 6;
  let rowH = 0;
  ctx.font = '10px monospace';
  for (const [name, c] of items) {
    const w = c.width * 3;
    const h = c.height * 3;
    if (x + Math.max(w, 90) > 1494) { x = 6; y += rowH + 18; rowH = 0; }
    ctx.drawImage(c, x, y, w, h);
    ctx.fillStyle = '#f0ead8';
    ctx.fillText(name, x, y + h + 11);
    x += Math.max(w, 90) + 10;
    rowH = Math.max(rowH, h);
  }
}

// ---------------------------------------------------------------------------
// Palette demo: the same office under different theme colours (drawn once, then the built-in colours come back)

const PALETTES: [string, Partial<Record<OfficeColorKey, string>> | undefined][] = [
  ['Built-in colours', undefined],
  ['Modern grey: cool walls, red desk chairs, a light sign with dark letters', {
    wall: '#c9ccd1', trim: '#3f4652', ceiling: '#eef0f2', carpet: '#4a5260', lobbyFloor: '#d8d6d0', kitchenFloor: '#e6e2da',
    conferenceFloor: '#3d4a5c', managerFloor: '#5a4e44', annexFloor: '#525866', rug: '#2f4a6b', rugBorder: '#c9b27a',
    deskChairs: '#b8443a', kitchenChairs: '#3a8f6e', managerChair: '#5a1f24', signPlate: '#e9e4d6', signText: '#22283a', signBranch: '#5c6070',
  }],
  ['Night shift: dark floors and walls, violet chairs, a neon sign', {
    wall: '#3a3f4b', trim: '#1c1f26', ceiling: '#4a4e58', carpet: '#23262e', lobbyFloor: '#2e2b2a', kitchenFloor: '#34363a',
    conferenceFloor: '#1f2530', managerFloor: '#2a2420', annexFloor: '#24282f', rug: '#4a1f3a', rugBorder: '#8a6a3a',
    deskChairs: '#6a5acd', kitchenChairs: '#d08a3a', managerChair: '#101014', signPlate: '#0e1116', signText: '#7fe0ff', signBranch: '#5f8a99',
  }],
];

if (show('palette')) {
  for (const [title, colors] of PALETTES) {
    const d = section(`Palette demo: ${title} (2x)`, colors ? Object.entries(colors).map(([k, v]) => `${k} ${v}`).join(' · ') : 'applyOfficeColors(undefined)');
    applyOfficeColors(colors);
    invalidateArtCaches();
    drawScene(canvas(MAP_PX_W, MAP_PX_H, d, 2), 1200, true);
  }
  applyOfficeColors(undefined);
  invalidateArtCaches();
}

// silence unused-type lint for FurnitureItem in some editors
export type { FurnitureItem };

const t0 = performance.now();
function tick(): void {
  const t = performance.now() - t0;
  for (const f of loops) f(t);
  requestAnimationFrame(tick);
}
tick();
