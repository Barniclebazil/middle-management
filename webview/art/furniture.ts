/**
 * Furniture and prop sprites, drawn in code and cached. Every function here
 * returns a canvas whose size and origin are documented; `office-map.ts`
 * decides where each one goes.
 *
 * Desk sprites are split in two so seated characters layer correctly:
 *   chair (behind) -> desk top (surface, monitor, props) -> seated character
 *   -> desk front (front face, drawn above the character).
 */
import { BASE_C, C, OUTLINE, propPal } from './palette.ts';
import type { Color, Palette } from './raster.ts';
import { PixelGrid, ctx2d, darken, flipCanvas, lighten, makeCanvas, mix, rect, withAlpha } from './raster.ts';
import { drawPixelText, measurePixelText } from './font.ts';

/** Who sits at a desk, which decides its personal props. */
export type DeskOwner = 'manager' | 'assistant' | 'prankster' | 'receptionist' | 'helpdesk' | 'crossword' | 'cat' | 'chili' | 'knitting' | 'hr' | 'temp' | 'spare';

/** Monitor screen rectangle inside a desk-top sprite (sprite-local pixels). */
export interface LocalRect { x: number; y: number; w: number; h: number }

const memo = new Map<string, HTMLCanvasElement>();
/** Memoises a sprite factory by key. */
export function cached(key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = memo.get(key);
  if (!c) { c = make(); memo.set(key, c); }
  return c;
}

/**
 * Drops every memoised sprite (furniture, desks, chairs, and the state-keyed
 * calendar, in-tray, badge and pile sprites) so they redraw from `C`.
 */
export function clearFurnitureCache(): void {
  memo.clear();
}

/** For tests: how many sprites are memoised. */
export function furnitureCacheSize(): number {
  return memo.size;
}

function sprite(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  draw(ctx);
  return c;
}

/** Filled box with a 1px outline, a light top row and a shaded bottom row; corners optionally rounded. */
function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: Color, opts: { light?: Color; dark?: Color; edge?: Color; round?: boolean } = {}): void {
  const edge = opts.edge ?? mix(fill, OUTLINE, 0.7);
  rect(ctx, x, y, w, h, edge);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
  if (opts.light) rect(ctx, x + 1, y + 1, w - 2, 1, opts.light);
  if (opts.dark) rect(ctx, x + 1, y + h - 2, w - 2, 1, opts.dark);
  if (opts.round) {
    ctx.clearRect(x, y, 1, 1);
    ctx.clearRect(x + w - 1, y, 1, 1);
    ctx.clearRect(x, y + h - 1, 1, 1);
    ctx.clearRect(x + w - 1, y + h - 1, 1, 1);
  }
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, c: Color): void {
  rect(ctx, x, y, 1, 1, c);
}

/** Small deterministic PRNG so procedural art is identical on every run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Monitors

/** Size of the monitor sprite. */
export const MONITOR_W = 15;
export const MONITOR_H = 17;
/** Screen rectangle inside the monitor sprite. */
export const MONITOR_SCREEN: LocalRect = { x: 2, y: 2, w: 7, h: 7 };

/** Beige 3/4-view CRT, screen on the left, casing depth to the right. */
function drawCrt(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const o = mix(C.beigeShade, OUTLINE, 0.65);
  // casing depth (behind the bezel)
  rect(ctx, x + 10, y + 1, 3, 11, o);
  rect(ctx, x + 10, y + 2, 2, 9, C.beigeShade);
  rect(ctx, x + 12, y + 2, 2, 9, o);
  rect(ctx, x + 12, y + 3, 1, 7, C.beigeDark);
  rect(ctx, x + 14, y + 4, 1, 5, o);
  rect(ctx, x + 13, y + 4, 1, 5, C.beigeDark);
  // bezel
  box(ctx, x, y, 11, 12, C.beige, { light: C.beigeLight, dark: C.beigeShade, edge: o });
  rect(ctx, x + 1, y + 1, 1, 10, C.beigeLight);
  // screen recess
  rect(ctx, x + 1, y + 1, 9, 9, C.beigeShade);
  rect(ctx, x + 2, y + 2, 7, 7, C.screenOff);
  px(ctx, x + 3, y + 3, C.screenGlass);
  px(ctx, x + 2, y + 2, C.screenGlass);
  // chin + LED
  rect(ctx, x + 1, y + 10, 9, 1, C.beige);
  px(ctx, x + 8, y + 10, '#5fd36a');
  // neck + foot
  rect(ctx, x + 3, y + 12, 5, 2, o);
  rect(ctx, x + 4, y + 12, 3, 2, C.beigeShade);
  box(ctx, x + 1, y + 13, 9, 3, C.beige, { light: C.beigeLight, edge: o });
}

/** Black flat panel for the manager, same screen geometry as the CRT. */
function drawFlatPanel(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const o = OUTLINE;
  rect(ctx, x + 10, y + 1, 2, 10, o);
  rect(ctx, x + 10, y + 2, 1, 8, C.charcoal);
  box(ctx, x, y, 11, 11, C.black, { light: C.charcoal, edge: o });
  rect(ctx, x + 2, y + 2, 7, 7, C.screenOff);
  px(ctx, x + 2, y + 2, C.screenGlass);
  px(ctx, x + 5, y + 9, '#5fd36a');
  rect(ctx, x + 4, y + 11, 3, 3, C.charcoal);
  // BASE_C.execLight is a fixed grey highlight here, so a manager-chair theme colour doesn't leak into monitors.
  box(ctx, x + 2, y + 13, 7, 3, C.charcoal, { light: BASE_C.execLight, edge: o });
}

// ---------------------------------------------------------------------------
// Desk props (prop palette strings, drawn standing on the desk)

const PROPS: Readonly<Record<string, readonly string[]>> = {
  beet: ['..gG..', '.GgdG.', '..pP..', '.pPPp.', 'pppPPp', 'pppppp', '.pppp.', '..pp..'],
  bobblehead: ['.hhh.', 'hssSh', '.sss.', '..9..', '.333.', '.999.'],
  jello: ['YYYYYYY', 'YyyyyyY', 'y99999y', 'y9+999y', 'yyyyyyy', 'yyyyyyy', '2222222'],
  candy: ['.x.X.z.', 'xXzxXzX', '+++++++', '.+++++.', '..+++..'],
  crossword: ['00000000', '03030300', '00300030', '03000303', '00030000', '11111111'],
  catcal: ['.9...9.', '0000000', '0A000A0', '0AAAAA0', '0A3A3A0', '0AAxAA0', '0000000', '0101010', '0000000'],
  chili: ['..9999..', '.cCcccC.', '9cccCcc9', '99999999', '-999999-', '.999999.'],
  candyjar: ['.++.', '+xz+', '+Xx+', '+zX+', '++++'],
  knitting: ['.Q..u.8', 'QQQuuu8', 'QQqqqu.', 'wvwvwvw', 'vwvwvwv', '.vvvvv.'],
  forms: ['.0000.', '011110', '000000', '011100', '000000', '111111'],
  succulent: ['.g.g.', 'gGgGg', '.gdg.', 'MMMMM', '.mMm.'],
  mug: ['2222.', '23322', '22222', '2222.'],
  pencilcup: ['5.6.7', '5.6.7', '99999', '9-9-9', '99999'],
  sticky: ['yyyy', 'yYYy', 'yyyy'],
  photo: ['vvvvv', 'vXGXv', 'vgsgv', 'vvvvv', '..v..'],
  papers: ['000000.', '0111100', '0000000', '1111111'],
  nameplate: ['^^^^^^^^', '~=====~^', '^^^^^^^^'],
  stapler: ['.333.', '33333', '-----'],
  // the IT help desk: a rubber duck (for debugging out loud), a label maker and a spare cable
  duck: ['..YY...', '.Yy3...', 'ccyy..y', '..yyyyy', '..yyyy5', '...555.'],
  labelmaker: ['..00..', '666666', '6zzzz6', '6+-+-6', '6-+-+6', '666666'],
  // coiled grey cable with a plug; D (the desk showing through the loop) is filled in by the caller
  cable: ['..----..', '.-DDDD-.', '-DD--DD8', '.-8888-+'],
};

function prop(ctx: CanvasRenderingContext2D, name: string, x: number, bottomY: number, pal: Palette = propPal()): void {
  const rows = PROPS[name]!;
  // selective outline around the prop
  const g = new PixelGrid(rows[0]!.length + 2, rows.length + 2);
  g.stamp(rows, pal, 1, 1);
  g.outline(OUTLINE, 0.6);
  ctx.drawImage(g.toCanvas(), x - 1, bottomY - rows.length);
}

// ---------------------------------------------------------------------------
// Staff desks

/** Desk-top sprite size and placement relative to the seat tile's top-left (X, Y). */
export const DESK_TOP = { w: 32, h: 24, dy: -6 } as const;
/** Desk-front sprite size and placement relative to the seat tile's top-left. */
export const DESK_FRONT = { w: 32, h: 14, dy: 18 } as const;
/** Monitor position inside a left-seat desk-top sprite. */
const MON_X = 17;
const MON_Y = 0;

/**
 * Screen rectangle inside the desk-top sprite. `seatLeft` = the seat is the
 * desk's left tile (monitor on the right).
 */
export function deskScreenRect(seatLeft: boolean): LocalRect {
  const x = MON_X + MONITOR_SCREEN.x;
  return { x: seatLeft ? x : DESK_TOP.w - x - MONITOR_SCREEN.w, y: MON_Y + MONITOR_SCREEN.y, w: MONITOR_SCREEN.w, h: MONITOR_SCREEN.h };
}

function deskSurface(ctx: CanvasRenderingContext2D, w: number, top: number, wood: { base: Color; light: Color; edge: Color }): void {
  const y0 = top;
  rect(ctx, 0, y0, w, 7, wood.edge);
  rect(ctx, 1, y0 + 1, w - 2, 5, wood.base);
  rect(ctx, 1, y0 + 1, w - 2, 1, mix(wood.base, wood.edge, 0.25));
  rect(ctx, 1, y0 + 5, w - 2, 1, wood.light);
  // veneer grain
  const r = rng(w * 31 + top);
  for (let i = 0; i < w / 5; i++) {
    const gx = 2 + Math.floor(r() * (w - 8));
    const gy = y0 + 2 + Math.floor(r() * 3);
    rect(ctx, gx, gy, 3 + Math.floor(r() * 4), 1, mix(wood.base, wood.edge, 0.18));
  }
}

function keyboard(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const o = mix(C.beigeShade, OUTLINE, 0.6);
  box(ctx, x, y, 10, 4, C.beige, { edge: o });
  for (let i = 0; i < 4; i++) px(ctx, x + 2 + i * 2, y + 1, C.beigeShade);
  rect(ctx, x + 3, y + 2, 4, 1, C.beigeShade);
  // mouse
  box(ctx, x + 11, y + 1, 3, 3, C.beige, { edge: o });
}

function ownerProps(ctx: CanvasRenderingContext2D, owner: DeskOwner, r: () => number, noMug = false): void {
  // Coordinates assume a left seat (monitor on the right, x 17-31).
  const fy = 23; // bottom of the front-right prop slot
  switch (owner) {
    case 'assistant':
      prop(ctx, 'beet', 25, fy);
      prop(ctx, 'bobblehead', 13, 17);
      break;
    case 'prankster':
      prop(ctx, 'jello', 24, fy);
      break;
    case 'helpdesk':
      prop(ctx, 'cable', 18, fy, { ...propPal(), D: C.desk });
      prop(ctx, 'duck', 25, fy);
      prop(ctx, 'labelmaker', 11, 18);
      break;
    case 'crossword':
      prop(ctx, 'crossword', 21, fy);
      if (!noMug) prop(ctx, 'mug', 13, 18);
      break;
    case 'cat':
      prop(ctx, 'catcal', 24, fy - 1);
      prop(ctx, 'pencilcup', 13, 18);
      break;
    case 'chili':
      prop(ctx, 'chili', 23, fy);
      prop(ctx, 'candyjar', 13, 18);
      break;
    case 'knitting':
      prop(ctx, 'knitting', 24, fy);
      prop(ctx, 'photo', 13, 18);
      break;
    case 'hr':
      prop(ctx, 'forms', 24, fy);
      prop(ctx, 'succulent', 13, 18);
      break;
    case 'temp':
      prop(ctx, 'sticky', 26, fy - 1);
      if (r() > 0.5 && !noMug) prop(ctx, 'mug', 13, 18);
      break;
    case 'spare':
      prop(ctx, 'papers', 23, fy);
      prop(ctx, 'pencilcup', 13, 18);
      break;
    default:
      break;
  }
}

/**
 * Desk top: surface, keyboard, monitor and personal props. Drawn at
 * (seatX - (seatLeft ? 0 : 16), seatY + DESK_TOP.dy). Sort it just before
 * the seated character. `noMug` leaves out the desk's mug (if it has one):
 * the `noMug` furniture variant, shown while the worker drinks (`deskSip`
 * draws the mug in the worker's hand).
 */
export function deskTopSprite(owner: DeskOwner, seatLeft: boolean, seed = 1, noMug = false): HTMLCanvasElement {
  return cached(`deskTop:${owner}:${seatLeft}:${seed}:${noMug}`, () => {
    const c = sprite(DESK_TOP.w, DESK_TOP.h, (ctx) => {
      deskSurface(ctx, DESK_TOP.w, 17, { base: C.desk, light: C.deskLight, edge: C.deskEdge });
      keyboard(ctx, 2, 18);
      drawCrt(ctx, MON_X, MON_Y);
      ownerProps(ctx, owner, rng(seed * 7 + 3), noMug);
    });
    return seatLeft ? c : flipCanvas(c);
  });
}

/**
 * Desk front face (drawn above the seated character). Drawn at
 * (seatX - (seatLeft ? 0 : 16), seatY + DESK_FRONT.dy).
 */
export function deskFrontSprite(seatLeft: boolean): HTMLCanvasElement {
  return cached(`deskFront:${seatLeft}`, () => {
    const c = sprite(DESK_FRONT.w, DESK_FRONT.h, (ctx) => {
      const o = mix(C.deskPanelDark, OUTLINE, 0.6);
      // top lip (veneer edge)
      rect(ctx, 0, 0, 32, 3, C.deskEdge);
      rect(ctx, 1, 0, 30, 1, C.desk);
      rect(ctx, 1, 1, 30, 1, mix(C.desk, C.deskEdge, 0.5));
      // knee space (seat side) in shadow, with a small bin
      rect(ctx, 0, 3, 16, 10, o);
      rect(ctx, 2, 3, 13, 9, '#3b3a42');
      rect(ctx, 2, 3, 13, 1, '#2c2b32');
      box(ctx, 9, 7, 5, 5, C.metalDark, { light: C.metal, edge: C.metalDeep });
      rect(ctx, 0, 3, 2, 10, C.deskPanelDark);
      // drawer pedestal (monitor side)
      box(ctx, 15, 2, 17, 11, C.deskPanel, { light: C.deskPanelLight, dark: C.deskPanelDark, edge: o });
      rect(ctx, 16, 6, 15, 1, o);
      rect(ctx, 16, 9, 15, 1, o);
      rect(ctx, 21, 4, 5, 1, C.metalDeep);
      rect(ctx, 21, 7, 5, 1, C.metalDeep);
      rect(ctx, 21, 10, 5, 1, C.metalDeep);
      // floor shadow
      rect(ctx, 0, 13, 32, 1, withAlpha(OUTLINE, 0.35));
    });
    return seatLeft ? c : flipCanvas(c);
  });
}

// ---------------------------------------------------------------------------
// Manager and reception desks (three tiles wide, seat in the middle tile)

/** Wide desk sprites: drawn at (seatX - 16, seatY + dy). */
export const WIDE_DESK_TOP = { w: 48, h: 24, dy: -6 } as const;
export const WIDE_DESK_FRONT = { w: 48, h: 14, dy: 18 } as const;

/** Screen rectangle inside the wide desk-top sprite (monitor on the left tile). */
export const WIDE_DESK_SCREEN: LocalRect = { x: 3 + MONITOR_SCREEN.x, y: MON_Y + MONITOR_SCREEN.y, w: MONITOR_SCREEN.w, h: MONITOR_SCREEN.h };
/** Reception desk screen (monitor on the right tile, a CRT). */
export const RECEPTION_SCREEN: LocalRect = { x: 32 + MONITOR_SCREEN.x - 2, y: MON_Y + MONITOR_SCREEN.y, w: MONITOR_SCREEN.w, h: MONITOR_SCREEN.h };

/** The Regional Manager's dark-wood desk top with flat panel, "World's Best Boss" mug (left out with `noMug`), nameplate and papers. */
export function managerDeskTopSprite(noMug = false): HTMLCanvasElement {
  return cached(`mgrDeskTop:${noMug}`, () => sprite(48, 24, (ctx) => {
    deskSurface(ctx, 48, 17, { base: C.darkWood, light: C.darkWoodLight, edge: C.darkWoodEdge });
    drawFlatPanel(ctx, 3, MON_Y);
    keyboard(ctx, 18, 18);
    // "World's Best Boss" mug: white mug with tiny dark text
    if (!noMug) {
      const g = new PixelGrid(9, 9);
      g.stamp(['22222.', '233322', '232322', '222222', '23332.', '22222.'], propPal(), 1, 2);
      g.outline(OUTLINE, 0.6);
      ctx.drawImage(g.toCanvas(), 39, 9);
    }
    // multi-line desk phone (lights drawn live by props.ts) and the empty in-tray
    ctx.drawImage(phoneSprite(), MGR_PHONE.x, MGR_PHONE.y);
    drawInTrayAt(ctx, MGR_IN_TRAY.x, MGR_IN_TRAY.y, 0, false);
    prop(ctx, 'nameplate', 14, 23);
  }));
}

/** Where the phone canvas sits inside the manager's desk-top sprite (front left, before the monitor). */
export const MGR_PHONE = { x: 0, y: 15 } as const;
/** Top-left of the in-tray inside the manager's desk-top sprite (front right). */
export const MGR_IN_TRAY = { x: 33, y: 17 } as const;

/** Front of the manager's desk: solid dark-wood modesty panel. */
export function managerDeskFrontSprite(): HTMLCanvasElement {
  return cached('mgrDeskFront', () => sprite(48, 14, (ctx) => {
    const o = mix(C.darkWoodEdge, OUTLINE, 0.5);
    rect(ctx, 0, 0, 48, 13, o);
    rect(ctx, 1, 0, 46, 1, C.darkWoodLight);
    rect(ctx, 1, 1, 46, 2, C.darkWoodEdge);
    rect(ctx, 1, 3, 46, 9, C.darkWood);
    for (const x of [3, 18, 33]) {
      rect(ctx, x, 4, 12, 7, C.darkWoodLight);
      rect(ctx, x + 1, 5, 10, 5, C.darkWood);
    }
    rect(ctx, 1, 11, 46, 1, C.darkWoodEdge);
    rect(ctx, 0, 13, 48, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Reception counter top: CRT on the right, phone, sign-in sheet. `offHook`: the receiver is lifted (someone is on the phone). */
export function receptionDeskTopSprite(offHook = false): HTMLCanvasElement {
  return cached(`recDeskTop:${offHook}`, () => sprite(48, 24, (ctx) => {
    deskSurface(ctx, 48, 17, { base: C.desk, light: C.deskLight, edge: C.deskEdge });
    keyboard(ctx, 18, 18);
    drawCrt(ctx, 30, MON_Y);
    // phone
    const g = new PixelGrid(10, 7);
    g.stamp(offHook ? ['......', '9-..-9', '999999', '9+9+99'] : ['.9999.', '9-99-9', '999999', '9+9+99'], propPal(), 1, 1);
    g.outline(OUTLINE, 0.6);
    ctx.drawImage(g.toCanvas(), 3, 15);
  }));
}

/** Reception counter front: raised wood transaction ledge with a candy dish. Hides the receptionist's hands, as a real counter would. */
export function receptionDeskFrontSprite(): HTMLCanvasElement {
  return cached('recDeskFront', () => sprite(48, 20, (ctx) => {
    const o = mix(C.woodEdge, OUTLINE, 0.5);
    // ledge (top of the raised front)
    box(ctx, 0, 0, 48, 5, C.woodLight, { light: lighten(C.woodLight, 0.2), edge: o });
    // panelled front
    rect(ctx, 1, 5, 46, 14, o);
    rect(ctx, 2, 5, 44, 13, C.wood);
    for (const x of [3, 18, 33]) {
      rect(ctx, x, 7, 12, 9, C.woodDark);
      rect(ctx, x + 1, 8, 10, 7, C.wood);
      rect(ctx, x + 1, 8, 10, 1, C.woodLight);
    }
    rect(ctx, 0, 19, 48, 1, withAlpha(OUTLINE, 0.35));
    prop(ctx, 'candy', 6, 1);
    prop(ctx, 'papers', 36, 1);
  }));
}
/** The reception front is taller: it starts 6px higher than a normal desk front. */
export const RECEPTION_FRONT_DY = 12;

// ---------------------------------------------------------------------------
// Chairs

/** Office chair seen from the front (empty). Drawn at (seatX, seatY + 1). Sort just before the desk top. */
export function chairSprite(kind: 'teal' | 'exec' | 'orange'): HTMLCanvasElement {
  return cached(`chair:${kind}`, () => {
    const pal = kind === 'teal' ? [C.teal, C.tealLight, C.tealDark] : kind === 'exec' ? [C.exec, C.execLight, C.execDark] : [C.orange, C.orangeLight, C.orangeDark];
    const [base, light, dark] = pal as [Color, Color, Color];
    if (kind === 'exec') {
      return sprite(16, 20, (ctx) => {
        box(ctx, 1, 0, 14, 15, base, { light, dark, round: true });
        rect(ctx, 2, 1, 12, 1, light);
        for (const [x, y] of [[4, 4], [8, 4], [11, 4], [6, 8], [10, 8]] as const) px(ctx, x, y, dark);
        box(ctx, 0, 12, 16, 6, dark, { light: base, round: true });
      });
    }
    return sprite(16, 16, (ctx) => {
      box(ctx, 2, 0, 12, 11, base, { light, dark, round: true });
      rect(ctx, 3, 2, 10, 1, light);
      box(ctx, 1, 9, 14, 5, dark, { light: base, round: true });
    });
  });
}

/** Chair seen from behind (someone would sit facing up/away). Drawn at the tile's top-left. */
export function chairBackSprite(kind: 'teal' | 'orange' | 'exec'): HTMLCanvasElement {
  return cached(`chairBack:${kind}`, () => {
    const [base, light, dark] = (kind === 'teal' ? [C.teal, C.tealLight, C.tealDark] : kind === 'exec' ? [C.exec, C.execLight, C.execDark] : [C.orange, C.orangeLight, C.orangeDark]) as [Color, Color, Color];
    return sprite(16, 18, (ctx) => {
      box(ctx, 2, 1, 12, 5, light, { light: lighten(light, 0.2), round: true });
      box(ctx, 2, 4, 12, 10, dark, { light: base, round: true });
      rect(ctx, 7, 14, 2, 2, C.metalDeep);
      rect(ctx, 3, 15, 10, 2, C.metalDark);
      rect(ctx, 2, 16, 12, 1, C.metalDeep);
    });
  });
}

// ---------------------------------------------------------------------------
// Kitchen table and conference table

/** Round kitchen table top (2 tiles). Drawn at (leftSeatX, seatY - 6), like a desk top. */
export function roundTableTopSprite(): HTMLCanvasElement {
  return cached('roundTop', () => sprite(32, 24, (ctx) => {
    const o = mix(C.offWhite, OUTLINE, 0.6);
    rect(ctx, 3, 16, 26, 8, o);
    rect(ctx, 1, 17, 30, 6, o);
    rect(ctx, 4, 17, 24, 6, C.offWhite);
    rect(ctx, 2, 18, 28, 4, C.offWhite);
    rect(ctx, 4, 17, 24, 1, C.white);
    // napkin holder and a donut box
    prop(ctx, 'mug', 23, 21);
    const g = new PixelGrid(12, 6);
    g.stamp(['wwwwwwwww', 'w7x7x7w2w', 'wwwwwwwww'], { ...propPal(), w: '#e8c9a0' }, 1, 1);
    g.outline(OUTLINE, 0.6);
    ctx.drawImage(g.toCanvas(), 9, 16);
  }));
}

/** Round table pedestal and edge, drawn above seated characters at (leftSeatX, seatY + 18). */
export function roundTableFrontSprite(): HTMLCanvasElement {
  return cached('roundFront', () => sprite(32, 14, (ctx) => {
    const o = mix(C.offWhite, OUTLINE, 0.6);
    rect(ctx, 3, 0, 26, 3, o);
    rect(ctx, 4, 0, 24, 2, darken(C.offWhite, 0.15));
    rect(ctx, 14, 3, 4, 8, o);
    rect(ctx, 15, 3, 2, 8, C.metal);
    rect(ctx, 8, 11, 16, 2, o);
    rect(ctx, 9, 11, 14, 1, C.metalDark);
    rect(ctx, 6, 13, 20, 1, withAlpha(OUTLINE, 0.3));
  }));
}

/** Long conference table seen from above, 5 x 2 tiles. Drawn at its top-left tile. */
export function conferenceTableSprite(): HTMLCanvasElement {
  return cached('confTable', () => sprite(80, 32, (ctx) => {
    const o = mix(C.darkWoodEdge, OUTLINE, 0.4);
    rect(ctx, 1, 2, 78, 22, o);
    rect(ctx, 2, 3, 76, 20, C.darkWood);
    rect(ctx, 2, 3, 76, 1, C.darkWoodLight);
    rect(ctx, 3, 5, 74, 1, mix(C.darkWood, C.darkWoodLight, 0.4));
    rect(ctx, 1, 24, 78, 4, o);
    rect(ctx, 2, 24, 76, 3, C.darkWoodEdge);
    rect(ctx, 2, 24, 76, 1, mix(C.darkWoodEdge, C.darkWoodLight, 0.4));
    for (const x of [4, 72]) { rect(ctx, x, 28, 4, 3, o); rect(ctx, x + 1, 28, 2, 2, C.darkWoodEdge); }
    rect(ctx, 0, 31, 80, 1, withAlpha(OUTLINE, 0.3));
    // speakerphone + papers + mugs
    const g = new PixelGrid(12, 7);
    g.stamp(['..9999..', '.9-99-9.', '99999999', '9+9+9+99'], propPal(), 2, 1);
    g.outline(OUTLINE, 0.6);
    ctx.drawImage(g.toCanvas(), 34, 9);
    prop(ctx, 'papers', 10, 20);
    prop(ctx, 'papers', 60, 14);
    prop(ctx, 'mug', 22, 13);
    prop(ctx, 'mug', 52, 21);
  }));
}

// ---------------------------------------------------------------------------
// Office equipment

/** Grey filing cabinet, 3 drawers, 16 x 30. Drawn so its base sits on the tile bottom. */
export function filingCabinetSprite(open: boolean): HTMLCanvasElement {
  return cached(`filing:${open}`, () => sprite(16, 30, (ctx) => {
    const o = mix(C.metalDark, OUTLINE, 0.6);
    box(ctx, 1, 0, 14, 4, C.metalLight, { edge: o });
    box(ctx, 1, 3, 14, 26, C.metal, { dark: C.metalDark, edge: o });
    for (let i = 0; i < 3; i++) {
      const y = 4 + i * 8;
      rect(ctx, 2, y + 7, 12, 1, o);
      rect(ctx, 2, y, 12, 1, C.metalLight);
      rect(ctx, 6, y + 3, 4, 1, C.metalDeep);
      rect(ctx, 6, y + 2, 4, 1, C.metalLight);
      rect(ctx, 7, y + 1, 2, 1, C.paper);
    }
    rect(ctx, 1, 29, 14, 1, withAlpha(OUTLINE, 0.35));
    if (open) {
      // top drawer pulled out towards the viewer, folders showing
      box(ctx, 0, 6, 16, 10, C.metal, { light: C.metalLight, dark: C.metalDark, edge: o });
      rect(ctx, 1, 7, 14, 3, '#3c3f47');
      for (let i = 0; i < 5; i++) rect(ctx, 2 + i * 3, 6 + (i % 2), 2, 3, i % 2 ? '#e2c27a' : '#c8a75a');
      rect(ctx, 6, 12, 4, 1, C.metalDeep);
    }
  }));
}

/** How far (px) the hover drawer slides out at most; `filingCabinetAjarSprite` takes 1 to this. */
export const CABINET_DRAWER_STEPS = 3;

/**
 * The filing cabinet with its top drawer pulled out `step` px (1 to
 * `CABINET_DRAWER_STEPS`): a dark slot with folder tabs opens above the
 * drawer front, which moves down and (from 2 px) a little wider, nearer the
 * viewer. Less than the `open` rummage sprite; used while the cabinets are
 * hovered. 16 x 30, like `filingCabinetSprite`.
 */
export function filingCabinetAjarSprite(step: number): HTMLCanvasElement {
  const k = Math.max(1, Math.min(CABINET_DRAWER_STEPS, Math.round(Number.isFinite(step) ? step : 1)));
  return cached(`filing:ajar:${k}`, () => sprite(16, 30, (ctx) => {
    ctx.drawImage(filingCabinetSprite(false), 0, 0);
    const o = mix(C.metalDark, OUTLINE, 0.6);
    // the slot behind the drawer front, folder tabs peeking out
    rect(ctx, 2, 4, 12, k + 1, '#3c3f47');
    rect(ctx, 2, 4, 12, 1, '#2c2e35');
    for (let i = 0; i < 4; i++) rect(ctx, 3 + i * 3, 4 + k - (i % 2 ? 0 : 1), 2, 1, i % 2 ? '#e2c27a' : '#c8a75a');
    // drawer front, nearer the viewer
    const wide = k >= 2 ? 1 : 0;
    const fy = 4 + k;
    rect(ctx, 1 - wide, fy + 8, 14 + wide * 2, 1, withAlpha(OUTLINE, 0.4));
    box(ctx, 1 - wide, fy, 14 + wide * 2, 8, C.metal, { light: C.metalLight, dark: C.metalDark, edge: o });
    rect(ctx, 6, fy + 3, 4, 1, C.metalDeep);
    rect(ctx, 6, fy + 2, 4, 1, C.metalLight);
    rect(ctx, 7, fy + 1, 2, 1, C.paper);
  }));
}

/** Big office copier, 2 tiles wide, 32 x 30. `active` lights the scan bar and shows a sheet coming out. */
export function copierSprite(active: boolean): HTMLCanvasElement {
  return cached(`copier:${active}`, () => sprite(32, 30, (ctx) => {
    const o = mix(C.beigeDark, OUTLINE, 0.6);
    // body
    box(ctx, 1, 8, 30, 21, C.offWhite, { light: C.white, dark: C.beigeShade, edge: o });
    // lid + document feeder
    box(ctx, 2, 4, 24, 6, C.beigeShade, { light: C.beige, edge: o });
    box(ctx, 5, 0, 16, 5, C.beige, { light: C.beigeLight, edge: o });
    rect(ctx, 7, 1, 12, 1, C.paper);
    // control panel
    box(ctx, 21, 6, 10, 5, C.charcoal, { light: BASE_C.execLight, edge: OUTLINE });
    rect(ctx, 22, 7, 4, 2, active ? '#8fe0a0' : '#5d7b66');
    px(ctx, 28, 8, active ? '#5fd36a' : '#3e6b47');
    px(ctx, 28, 9, '#d9a64a');
    // trays
    for (const y of [15, 21]) {
      rect(ctx, 3, y, 26, 5, o);
      rect(ctx, 4, y, 24, 4, C.beige);
      rect(ctx, 4, y, 24, 1, C.beigeLight);
      rect(ctx, 13, y + 2, 6, 1, C.beigeDark);
    }
    rect(ctx, 1, 29, 30, 1, withAlpha(OUTLINE, 0.35));
    // output tray (left)
    rect(ctx, 0, 11, 3, 2, C.beigeDark);
    if (active) {
      rect(ctx, 3, 9, 22, 1, '#bff4ff');
      rect(ctx, 0, 9, 5, 2, C.paper);
      px(ctx, 1, 9, C.paperLine);
    }
  }));
}

/** Shredder bin, 16 x 20. `active` shows paper strips in the slot. */
export function shredderSprite(active: boolean): HTMLCanvasElement {
  return cached(`shredder:${active}`, () => sprite(16, 20, (ctx) => {
    box(ctx, 2, 7, 12, 12, C.charcoal, { light: BASE_C.execLight, dark: C.black, edge: OUTLINE });
    rect(ctx, 4, 10, 8, 6, '#2f2c35');
    for (let i = 0; i < 4; i++) rect(ctx, 5 + i * 2, 11, 1, 4, active ? C.paper : '#45414c');
    box(ctx, 1, 3, 14, 6, C.black, { light: C.charcoal, edge: OUTLINE });
    rect(ctx, 3, 5, 10, 1, '#0e0c10');
    px(ctx, 12, 4, active ? '#5fd36a' : '#a33');
    if (active) for (let i = 0; i < 4; i++) rect(ctx, 4 + i * 2, 0 + (i % 2), 1, 5, C.paper);
    rect(ctx, 2, 19, 12, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Water cooler with a blue bottle, 16 x 30. */
export function waterCoolerSprite(): HTMLCanvasElement {
  return cached('cooler', () => sprite(16, 30, (ctx) => {
    const o = mix(C.metalDark, OUTLINE, 0.6);
    box(ctx, 3, 12, 10, 17, C.white, { light: '#ffffff', dark: C.offWhite, edge: o });
    rect(ctx, 5, 15, 6, 4, '#6f7c86');
    px(ctx, 6, 15, '#d9534a');
    px(ctx, 9, 15, '#4a7fd9');
    rect(ctx, 5, 20, 6, 1, C.metalDark);
    // bottle
    box(ctx, 4, 2, 8, 11, '#8fc6ec', { light: '#c6e6fa', dark: '#5c9cc8', edge: '#2f5f86', round: true });
    rect(ctx, 6, 0, 4, 3, '#2f5f86');
    rect(ctx, 7, 0, 2, 2, '#5c9cc8');
    rect(ctx, 5, 4, 1, 6, '#e3f4ff');
    // cup dispenser
    rect(ctx, 13, 14, 2, 6, o);
    rect(ctx, 13, 15, 1, 4, C.paper);
    rect(ctx, 3, 29, 10, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Snack vending machine, 32 x 42. */
export function vendingMachineSprite(): HTMLCanvasElement {
  return cached('vending', () => sprite(32, 42, (ctx) => {
    const body = '#9e3a35';
    box(ctx, 1, 0, 30, 41, body, { light: '#c25048', dark: '#6e2622', edge: OUTLINE });
    // glass window with snacks
    rect(ctx, 3, 3, 19, 30, '#1f2328');
    rect(ctx, 4, 4, 17, 28, '#38424c');
    const r = rng(42);
    const snack = ['#e2b93b', '#d8645a', '#4c9a4f', '#3f6fb0', '#f0f0e8', '#c9773b', '#8a3f6e'];
    for (let row = 0; row < 5; row++) {
      const y = 5 + row * 5;
      rect(ctx, 4, y + 4, 17, 1, '#7a8794');
      for (let i = 0; i < 4; i++) {
        const c = snack[Math.floor(r() * snack.length)]!;
        rect(ctx, 5 + i * 4, y, 3, 4, c);
        px(ctx, 5 + i * 4, y, lighten(c, 0.35));
      }
    }
    rect(ctx, 5, 5, 1, 24, withAlpha('#ffffff', 0.25));
    // right panel
    rect(ctx, 23, 4, 6, 10, '#2a2426');
    for (let i = 0; i < 6; i++) px(ctx, 24 + (i % 2) * 3, 5 + Math.floor(i / 2) * 3, '#d9d4c8');
    rect(ctx, 24, 16, 4, 2, '#d9d4c8');
    rect(ctx, 25, 16, 2, 1, OUTLINE);
    // delivery slot
    rect(ctx, 4, 35, 18, 4, '#1d1a1c');
    rect(ctx, 4, 35, 18, 1, '#6e2622');
    rect(ctx, 1, 41, 30, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Almond fridge, 16 x 38, with magnets and a child's drawing. */
export function fridgeSprite(): HTMLCanvasElement {
  return cached('fridge', () => sprite(16, 38, (ctx) => {
    const o = mix(C.beigeDark, OUTLINE, 0.6);
    box(ctx, 0, 0, 16, 37, '#e7e1cf', { light: '#f6f1e2', dark: '#c9c1aa', edge: o });
    rect(ctx, 1, 11, 14, 1, o);
    rect(ctx, 2, 3, 1, 6, '#b9b19a');
    rect(ctx, 2, 14, 1, 10, '#b9b19a');
    box(ctx, 6, 16, 7, 8, C.paper, { edge: '#c9c1aa' });
    px(ctx, 8, 18, C.red);
    px(ctx, 10, 19, C.blue);
    rect(ctx, 8, 21, 3, 1, C.green);
    px(ctx, 9, 15, C.red);
    px(ctx, 5, 5, C.blue);
    px(ctx, 11, 6, C.yellow);
    px(ctx, 8, 28, C.green);
    rect(ctx, 0, 37, 16, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Kitchen counter with microwave, coffee maker and sink, 48 x 28 (3 tiles). Base on the tile bottom. */
export function counterSprite(): HTMLCanvasElement {
  return cached('counter', () => sprite(48, 28, (ctx) => {
    const o = mix(C.woodEdge, OUTLINE, 0.5);
    // cabinets
    rect(ctx, 0, 13, 48, 15, o);
    rect(ctx, 1, 13, 46, 13, C.wood);
    for (const x of [2, 18, 34]) {
      rect(ctx, x, 15, 13, 9, C.woodDark);
      rect(ctx, x + 1, 16, 11, 7, C.wood);
      rect(ctx, x + 1, 16, 11, 1, C.woodLight);
      rect(ctx, x + 10, 18, 1, 3, C.metalLight);
    }
    rect(ctx, 1, 26, 46, 1, '#3a2a1e');
    // counter top (laminate)
    box(ctx, 0, 10, 48, 4, '#cfcabb', { light: '#e6e2d6', edge: o });
    // microwave
    box(ctx, 2, 1, 15, 10, C.offWhite, { light: C.white, dark: C.beigeShade, edge: OUTLINE });
    rect(ctx, 3, 3, 9, 6, '#2b2a30');
    rect(ctx, 4, 4, 3, 1, '#4a4952');
    rect(ctx, 13, 3, 3, 1, '#7bd389');
    for (let i = 0; i < 3; i++) rect(ctx, 13, 5 + i * 2, 3, 1, C.metalDark);
    // coffee maker
    box(ctx, 20, 0, 9, 11, C.black, { light: C.charcoal, edge: OUTLINE });
    rect(ctx, 22, 5, 5, 5, '#2b3b3e');
    rect(ctx, 22, 7, 5, 3, '#6b4226');
    px(ctx, 27, 2, '#e04a3a');
    // sink + faucet
    rect(ctx, 33, 11, 12, 2, C.metalDark);
    rect(ctx, 34, 11, 10, 1, C.metalDeep);
    rect(ctx, 38, 5, 2, 6, C.metal);
    rect(ctx, 38, 5, 4, 1, C.metalLight);
    px(ctx, 41, 6, C.metal);
    // dish soap
    rect(ctx, 44, 7, 2, 4, '#5fb36a');
    rect(ctx, 0, 27, 48, 1, withAlpha(OUTLINE, 0.35));
  }));
}

/** Wooden drafting easel with a canvas facing the viewer, 16 x 32. */
export function easelSprite(): HTMLCanvasElement {
  return cached('easel', () => sprite(16, 32, (ctx) => {
    const w = C.woodDark;
    const o = C.woodEdge;
    // back leg
    rect(ctx, 7, 0, 2, 30, o);
    // splayed front legs
    for (let y = 0; y < 31; y++) {
      const off = Math.floor(y / 5);
      px(ctx, 6 - off, y, w);
      px(ctx, 9 + off, y, w);
    }
    // canvas
    box(ctx, 1, 3, 14, 15, C.paper, { light: '#ffffff', dark: '#ded9cc', edge: C.woodEdge });
    // a hopeful sketch
    rect(ctx, 3, 12, 10, 3, '#9fd38a');
    rect(ctx, 9, 6, 3, 3, C.yellow);
    px(ctx, 4, 7, C.blueLight);
    px(ctx, 5, 6, C.blueLight);
    px(ctx, 6, 7, C.blueLight);
    rect(ctx, 5, 10, 1, 2, C.woodDark);
    rect(ctx, 4, 9, 3, 1, C.leaf);
    // ledge
    rect(ctx, 0, 18, 16, 2, w);
    rect(ctx, 0, 18, 16, 1, C.wood);
    px(ctx, 12, 17, C.red);
    px(ctx, 13, 17, C.blue);
    rect(ctx, 2, 31, 12, 1, withAlpha(OUTLINE, 0.3));
  }));
}
/** The drawable canvas area inside the easel sprite. */
export const EASEL_CANVAS: LocalRect = { x: 2, y: 4, w: 12, h: 13 };

/** Procedural potted plant. `tall` = floor ficus (16 x 32), otherwise a small pot (16 x 18). */
export function plantSprite(tall: boolean, seed = 1): HTMLCanvasElement {
  return cached(`plant:${tall}:${seed}`, () => {
    const W = 16;
    const H = tall ? 32 : 18;
    const g = new PixelGrid(W, H);
    const r = rng(seed * 977 + (tall ? 5 : 9));
    const potTop = tall ? 23 : 11;
    // leaves: a dark core mass, then many small lit leaves on top
    const blobs = tall ? 9 : 4;
    const centres: [number, number, number][] = [];
    for (let i = 0; i < blobs; i++) {
      const cx = 4 + r() * 8;
      const cy = 3 + r() * (potTop - (tall ? 7 : 5));
      const rad = tall ? 2.6 + r() * 1.6 : 2 + r() * 1.2;
      centres.push([cx, cy, rad]);
      for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
        for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy <= rad * rad) g.set(x, y, C.leafDark);
        }
      }
    }
    if (tall) for (let y = potTop - 7; y < potTop; y++) g.set(7 + (y % 3 === 0 ? 1 : 0), y, C.woodDark);
    const leaves = tall ? 34 : 12;
    for (let i = 0; i < leaves; i++) {
      const [cx, cy, rad] = centres[Math.floor(r() * centres.length)]!;
      const a = r() * Math.PI * 2;
      const d = r() * rad;
      const lx = Math.round(cx + Math.cos(a) * d);
      const ly = Math.round(cy + Math.sin(a) * d);
      const lit = lx + ly < 12 + r() * 8;
      const base = lit ? C.leaf : mix(C.leaf, C.leafDark, 0.5);
      const horiz = r() > 0.5;
      g.set(lx, ly, base);
      g.set(lx + (horiz ? 1 : 0), ly + (horiz ? 0 : 1), base);
      if (lit) g.set(lx, ly, C.leafLight);
    }
    // pot
    const pw = tall ? 10 : 8;
    const px0 = (W - pw) / 2;
    g.fill(px0 - 1, potTop, pw + 2, 2, C.potLight);
    g.fill(px0, potTop + 2, pw, H - potTop - 3, C.pot);
    g.fill(px0 + pw - 2, potTop + 2, 2, H - potTop - 3, C.potDark);
    g.fill(px0, potTop, pw, 1, C.soil);
    g.outline(OUTLINE, 0.65);
    const c = g.toCanvas();
    const ctx = ctx2d(c);
    rect(ctx, px0, H - 1, pw, 1, withAlpha(OUTLINE, 0.3));
    return c;
  });
}

/** Golf putter leaning on the wall plus a tipped-over mug used as a hole. 16 x 22. */
export function putterSprite(): HTMLCanvasElement {
  return cached('putter', () => sprite(16, 22, (ctx) => {
    for (let y = 0; y < 18; y++) px(ctx, 9 - Math.floor(y / 6), y, C.metalLight);
    rect(ctx, 9, 0, 2, 2, C.black);
    rect(ctx, 4, 17, 5, 2, C.metalDark);
    rect(ctx, 4, 17, 5, 1, C.metalLight);
    px(ctx, 12, 19, C.white);
    rect(ctx, 0, 21, 12, 1, withAlpha(OUTLINE, 0.25));
  }));
}

/** Small bulletin board / poster on an interior wall face, 22 x 14. */
export function posterSprite(kind: 'board' | 'teamwork'): HTMLCanvasElement {
  return cached(`poster:${kind}`, () => sprite(22, 14, (ctx) => {
    if (kind === 'board') {
      box(ctx, 0, 0, 22, 14, '#b88a58', { light: '#cfa06a', edge: C.woodEdge });
      rect(ctx, 2, 2, 6, 5, C.paper);
      rect(ctx, 9, 3, 5, 6, '#f2e58a');
      rect(ctx, 15, 2, 5, 4, '#bfe0ee');
      rect(ctx, 3, 8, 5, 4, '#f6c8d2');
      rect(ctx, 14, 8, 6, 4, C.paper);
      px(ctx, 4, 2, C.red);
      px(ctx, 11, 3, C.blue);
      px(ctx, 17, 2, C.red);
    } else {
      box(ctx, 0, 0, 22, 14, C.black, { edge: OUTLINE });
      rect(ctx, 2, 2, 18, 7, '#3c5a7a');
      rect(ctx, 2, 6, 18, 3, '#e8ecf0');
      rect(ctx, 6, 4, 4, 3, '#e8ecf0');
      rect(ctx, 11, 3, 6, 4, '#d2d8de');
      rect(ctx, 5, 11, 12, 1, '#d8d4c8');
    }
  }));
}

// ---------------------------------------------------------------------------
// Interior walls (sorted so characters pass behind and in front correctly)

/** Height a wall rises above its own tile row. */
export const WALL_RISE = 12;

/** Solid interior wall segment for a horizontal wall tile: 16 x 28, drawn at (x, tileY - 12). */
export function wallHSprite(): HTMLCanvasElement {
  return cached('wallH', () => sprite(16, 28, (ctx) => {
    rect(ctx, 0, 0, 16, 4, C.wallCap);
    rect(ctx, 0, 0, 16, 1, C.wallCapLight);
    rect(ctx, 0, 4, 16, 20, C.wall);
    rect(ctx, 0, 4, 16, 1, C.wallShade);
    rect(ctx, 0, 22, 16, 2, C.wallShade);
    rect(ctx, 0, 24, 16, 3, C.baseboard);
    rect(ctx, 0, 24, 16, 1, C.baseboardLight);
    rect(ctx, 0, 27, 16, 1, withAlpha(OUTLINE, 0.3));
  }));
}

/** Vertical interior wall tile (cap strip). With `end`, includes the wall's end face below. 16 x (16 or 28). */
export function wallVSprite(end: boolean): HTMLCanvasElement {
  return cached(`wallV:${end}`, () => sprite(16, end ? 28 : 16, (ctx) => {
    rect(ctx, 5, 0, 6, 16, C.wallCap);
    rect(ctx, 6, 0, 4, 16, C.wallCapLight);
    rect(ctx, 5, 0, 1, 16, mix(C.wallCap, OUTLINE, 0.3));
    rect(ctx, 10, 0, 1, 16, mix(C.wallCap, OUTLINE, 0.3));
    if (end) {
      rect(ctx, 5, 16, 6, 9, C.wall);
      rect(ctx, 5, 16, 6, 1, C.wallShade);
      rect(ctx, 5, 25, 6, 3, C.baseboard);
    }
  }));
}

/** Glass partition tile for a horizontal wall, with blinds half down. 16 x 28, drawn at (x, tileY - 12). */
export function glassHSprite(blindsDown = 0.45): HTMLCanvasElement {
  return cached(`glassH:${blindsDown}`, () => sprite(16, 28, (ctx) => {
    const frame = C.glassFrame;
    rect(ctx, 0, 0, 16, 3, frame);
    rect(ctx, 0, 0, 16, 1, C.glassFrameLight);
    rect(ctx, 0, 3, 16, 21, withAlpha(C.glass, 0.32));
    const blind = Math.round(21 * blindsDown);
    for (let y = 3; y < 3 + blind; y++) rect(ctx, 0, y, 16, 1, y % 2 ? withAlpha(C.blinds, 0.92) : withAlpha(C.blindsShade, 0.92));
    rect(ctx, 0, 3 + blind, 16, 1, withAlpha(C.blindsShade, 0.95));
    // reflections
    for (let i = 0; i < 4; i++) px(ctx, 3 + i, 3 + blind + 9 - i, withAlpha('#ffffff', 0.45));
    for (let i = 0; i < 3; i++) px(ctx, 10 + i, 3 + blind + 6 - i, withAlpha('#ffffff', 0.35));
    rect(ctx, 0, 3, 1, 21, frame);
    rect(ctx, 0, 24, 16, 3, frame);
    rect(ctx, 0, 24, 16, 1, C.glassFrameLight);
    rect(ctx, 0, 27, 16, 1, withAlpha(OUTLINE, 0.25));
  }));
}

/** Glass partition tile for a vertical wall (seen from above as a thin pane). 16 x 16. */
export function glassVSprite(): HTMLCanvasElement {
  return cached('glassV', () => sprite(16, 16, (ctx) => {
    rect(ctx, 6, 0, 4, 16, withAlpha(C.glass, 0.55));
    rect(ctx, 6, 0, 1, 16, C.glassFrame);
    rect(ctx, 9, 0, 1, 16, C.glassFrame);
    rect(ctx, 7, 0, 1, 16, withAlpha('#ffffff', 0.5));
  }));
}

/** Door in a horizontal wall: 16 x 28 at (x, tileY - 12). */
export function doorSprite(kind: 'managerClosed' | 'managerOpen' | 'glassOpen' | 'woodOpen'): HTMLCanvasElement {
  return cached(`door:${kind}`, () => sprite(16, 28, (ctx) => {
    const glass = kind === 'glassOpen';
    const post = glass ? C.glassFrame : C.darkWood;
    const postLight = glass ? C.glassFrameLight : C.darkWoodLight;
    rect(ctx, 0, 0, 16, 3, post);
    rect(ctx, 0, 0, 16, 1, postLight);
    rect(ctx, 0, 0, 2, 27, post);
    rect(ctx, 14, 0, 2, 27, post);
    rect(ctx, 1, 0, 1, 27, postLight);
    if (kind === 'managerClosed') {
      rect(ctx, 2, 3, 12, 24, '#8d5e38');
      rect(ctx, 2, 3, 12, 1, '#a8744a');
      // window with blinds
      rect(ctx, 4, 5, 8, 8, C.darkWoodEdge);
      for (let y = 6; y < 12; y++) rect(ctx, 5, y, 6, 1, y % 2 ? C.blinds : C.blindsShade);
      // brass nameplate and knob
      rect(ctx, 5, 15, 6, 2, C.gold);
      rect(ctx, 6, 15, 4, 1, C.goldLight);
      rect(ctx, 11, 19, 2, 2, C.gold);
      rect(ctx, 3, 23, 10, 1, '#6f4a2c');
    } else if (kind === 'managerOpen') {
      // door swung inward: a thin leaf against the left post
      rect(ctx, 2, -1, 3, 20, '#8d5e38');
      rect(ctx, 2, -1, 1, 20, '#a8744a');
      rect(ctx, 2, 26, 12, 1, withAlpha(OUTLINE, 0.3));
    } else {
      rect(ctx, 2, 26, 12, 1, withAlpha(OUTLINE, 0.25));
    }
  }));
}


// ---------------------------------------------------------------------------
// Office-tool props (v0.3): bookshelf, lobby directory, temp-agency sign,
// wall calendar, the manager's in-tray and desk phone. The dynamic parts
// (calendar week bar, tray papers and badge, phone lights) have their own
// low-level helpers here; `props.ts` anchors them on the map.

/** Usage level shared by the wall clock ring and the calendar. */
export type UsageLevel = 'ok' | 'warn' | 'danger' | 'unknown';

/** Colours for each usage level: main, light, dark. `unknown` is a neutral grey. */
export const LEVEL_COLORS: Readonly<Record<UsageLevel, readonly [Color, Color, Color]>> = {
  ok: ['#4fa94f', '#7cc479', '#2f7a36'],
  warn: ['#e09a2c', '#f2c25a', '#a8681a'],
  danger: ['#d23f35', '#ef6a5e', '#8e231c'],
  unknown: ['#9a958c', '#b9b4aa', '#6e6a62'],
};

const BOOK_COLORS: readonly Color[] = ['#b8433a', '#3f6fb0', '#4c9a4f', '#e2b93b', '#8a3f6e', '#2f7b83', '#e2ded2', '#c9773b', '#225960', '#7f2a26', '#6b97d2'];

/** One book (or the flat stack) on the bookshelf, in shelf-local pixels. */
interface ShelfBook { shelf: number; x: number; y: number; w: number; h: number; c: Color; binder: boolean; flat: boolean }

const SHELF_TOP = 5; // rows above the carcass for the things on top
/** Shelf cavities: [top, height]. */
const SHELF_CAVITIES: readonly (readonly [number, number])[] = [[SHELF_TOP + 5, 7], [SHELF_TOP + 14, 7], [SHELF_TOP + 23, 4]];

/**
 * Every book the bookshelf can hold, in fill order (top shelf left to right,
 * the middle shelf and its flat stack, then the bottom shelf). Seeded, so the
 * same count always shows the same books; the full set is the classic shelf.
 */
const SHELF_BOOKS: readonly ShelfBook[] = (() => {
  const out: ShelfBook[] = [];
  const r = rng(4711);
  SHELF_CAVITIES.forEach(([top, h], ci) => {
    let x = 3;
    // the middle shelf ends in a small stack of books lying flat
    const end = ci === 1 ? 21 : 29;
    while (x < end) {
      const binder = r() > 0.6;
      const w = binder ? 3 : 2;
      if (x + w > end) break;
      const bh = Math.max(3, h - 1 - Math.floor(r() * (binder ? 1 : 3)));
      const c = BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]!;
      out.push({ shelf: ci, x, y: top + h - bh, w, h: bh, c, binder, flat: false });
      x += w + (r() > 0.85 ? 1 : 0);
    }
    if (ci === 1) {
      for (let k = 0; k < 2; k++) {
        out.push({ shelf: ci, x: 22 + k, y: top + h - 2 - k * 2, w: 7 - k * 2, h: 2, c: BOOK_COLORS[(k * 5 + 2) % BOOK_COLORS.length]!, binder: false, flat: true });
      }
    }
  });
  return out;
})();

/** How many books fill the bookshelf; `bookshelfSprite(n)` with n at or above this is the full shelf. */
export const BOOKSHELF_SLOTS = SHELF_BOOKS.length;

function drawShelfBook(ctx: CanvasRenderingContext2D, b: ShelfBook, lean: boolean): void {
  if (b.flat) {
    rect(ctx, b.x, b.y, b.w, b.h, b.c);
    rect(ctx, b.x, b.y, b.w, 1, lighten(b.c, 0.22));
    return;
  }
  if (lean) {
    // the last book on a part-filled shelf leans back on its neighbour: top against it, foot slid out to the right
    const bottom = b.y + b.h;
    for (let y = b.y + 1; y < bottom; y++) {
      const dx = Math.round(((y - b.y - 1) * 2) / Math.max(1, b.h - 2));
      rect(ctx, b.x + dx, y, b.w, 1, b.c);
      rect(ctx, b.x + dx, y, 1, 1, lighten(b.c, 0.25));
      rect(ctx, b.x + dx + b.w - 1, y, 1, 1, darken(b.c, 0.18));
    }
    return;
  }
  rect(ctx, b.x, b.y, b.w, b.h, b.c);
  rect(ctx, b.x, b.y, 1, b.h, lighten(b.c, 0.25));
  rect(ctx, b.x + b.w - 1, b.y, 1, b.h, darken(b.c, 0.18));
  if (b.binder && b.h >= 5) rect(ctx, b.x + 1, b.y + 2, 1, 2, C.paper);
  else if (b.h >= 5) rect(ctx, b.x, b.y + 1, b.w, 1, darken(b.c, 0.3));
}

/**
 * Two-tile wooden bookshelf facing the room, binders and books on three
 * shelves, a small plant on top. 32 x 36. `count` (skills and commands in the
 * training library) shows that many books, filling the top shelf first: 0 is
 * empty shelves, `BOOKSHELF_SLOTS` or more is full. Leave it out for the
 * classic full shelf (the same pixels as a full count).
 */
export function bookshelfSprite(count?: number): HTMLCanvasElement {
  const n = count === undefined ? BOOKSHELF_SLOTS : Math.max(0, Math.min(BOOKSHELF_SLOTS, Math.floor(Number.isFinite(count) ? count : 0)));
  return cached(n >= BOOKSHELF_SLOTS ? 'bookshelf' : `bookshelf:${n}`, () => sprite(32, 36, (ctx) => {
    const T = SHELF_TOP;
    const o = mix(C.woodEdge, OUTLINE, 0.5);
    // carcass
    rect(ctx, 0, T, 32, 30, o);
    rect(ctx, 1, T + 1, 30, 3, C.woodLight);
    rect(ctx, 1, T + 1, 30, 1, lighten(C.woodLight, 0.18));
    rect(ctx, 1, T + 4, 30, 25, C.wood);
    rect(ctx, 1, T + 4, 1, 25, C.woodLight);
    rect(ctx, 30, T + 4, 1, 25, C.woodDark);
    // plinth
    rect(ctx, 1, T + 27, 30, 2, C.woodDark);
    rect(ctx, 0, T + 30, 32, 1, withAlpha(OUTLINE, 0.35));
    SHELF_CAVITIES.forEach(([top, h], ci) => {
      rect(ctx, 3, top, 26, h, '#3b2a20');
      rect(ctx, 3, top, 26, 1, '#2a1d16');
      // shelf board below the cavity (lit top edge, dark front)
      if (ci < 2) {
        rect(ctx, 2, top + h, 28, 1, C.woodLight);
        rect(ctx, 2, top + h + 1, 28, 1, C.woodDark);
      }
    });
    const shown = SHELF_BOOKS.slice(0, n);
    // flat stacks first, so standing books never sit under them (as in the classic shelf)
    for (const b of shown) if (b.flat) drawShelfBook(ctx, b, false);
    shown.forEach((b, i) => {
      if (b.flat) return;
      const next = SHELF_BOOKS[i + 1];
      // lean the last book of a shelf that isn't full yet (and has room for it)
      const lean = i === n - 1 && b.h >= 5 && next !== undefined && next.shelf === b.shelf && !next.flat && i > 0 && SHELF_BOOKS[i - 1]!.shelf === b.shelf;
      drawShelfBook(ctx, b, lean);
    });
    // on top: a lying binder and a small succulent
    rect(ctx, 4, T - 2, 9, 3, mix(C.blue, OUTLINE, 0.5));
    rect(ctx, 5, T - 2, 7, 2, C.blue);
    rect(ctx, 5, T - 2, 7, 1, C.blueLight);
    prop(ctx, 'succulent', 22, T + 1);
  }));
}

/** Freestanding lobby directory: black felt letter board on a chrome post. 16 x 24 (base on the tile bottom). */
export function directoryBoardSprite(): HTMLCanvasElement {
  return cached('directoryBoard', () => sprite(16, 24, (ctx) => {
    const mo = mix(C.metalDark, OUTLINE, 0.5);
    // post and foot
    rect(ctx, 6, 14, 4, 7, mo);
    rect(ctx, 7, 14, 2, 7, C.metal);
    rect(ctx, 7, 14, 1, 7, C.metalLight);
    box(ctx, 3, 20, 10, 3, C.metal, { light: C.metalLight, edge: mo });
    rect(ctx, 3, 23, 10, 1, withAlpha(OUTLINE, 0.3));
    // board in a dark wood frame
    box(ctx, 0, 0, 16, 15, C.darkWood, { light: C.darkWoodLight, edge: C.darkWoodEdge });
    rect(ctx, 2, 2, 12, 11, '#1d1a21');
    rect(ctx, 2, 2, 12, 1, '#0f0d12');
    // header bar in brass
    rect(ctx, 3, 3, 10, 1, C.gold);
    // white letter rows: names on the left, suite numbers on the right
    const r = rng(77);
    for (const y of [5, 7, 9, 11]) {
      const n = 4 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) if (r() > 0.18 || i === 0) px(ctx, 3 + i, y, '#e8e4da');
      px(ctx, 12, y, '#e8e4da');
      if (r() > 0.4) px(ctx, 11, y, '#e8e4da');
    }
    // glass glint
    px(ctx, 13, 3, withAlpha('#ffffff', 0.5));
  }));
}

/** Temp-agency sign for the annex wall (pinned to BASE_C.orange*: a kitchen-chair theme colour must not recolour it): orange plate with "TEMPS" over three little staff. 27 x 15. */
export function tempAgencySignSprite(): HTMLCanvasElement {
  return cached('tempAgency', () => sprite(27, 15, (ctx) => {
    const o = mix(BASE_C.orangeDark, OUTLINE, 0.5);
    rect(ctx, 1, 14, 26, 1, withAlpha(OUTLINE, 0.3));
    box(ctx, 0, 0, 27, 14, BASE_C.orange, { light: BASE_C.orangeLight, edge: o });
    // lettering
    const text = 'TEMPS';
    const w = measurePixelText(text).w;
    drawPixelText(ctx, text, Math.floor((27 - w) / 2), 2, '#fff4d8', 1, BASE_C.orangeDark);
    // cream panel with three smiling temps
    rect(ctx, 2, 8, 23, 4, '#f4ead2');
    rect(ctx, 2, 11, 23, 1, '#e2d5b6');
    const shirts = [C.blue, C.green, C.redLight];
    [6, 13, 20].forEach((x, i) => {
      rect(ctx, x, 8, 2, 2, '#e8b48f');
      rect(ctx, x - 1, 10, 4, 2, shirts[i]!);
    });
    px(ctx, 2, 1, BASE_C.orangeLight);
  }));
}

/** Size of the wall calendar sprite (including its rings and drop shadow). */
export const CALENDAR_W = 16;
export const CALENDAR_H = 19;

/**
 * Wall calendar: red header on binder rings, a month of day dots, and the
 * current week as a bar filled to `pct` (0-100) in the level colour. With
 * `pct` null or level `unknown` the week row stays blank. Cached by state.
 */
export function calendarSprite(pct: number | null, level: UsageLevel): HTMLCanvasElement {
  const known = pct !== null && Number.isFinite(pct) && level !== 'unknown';
  const fill = known ? Math.round(Math.max(0, Math.min(100, pct as number)) / 100 * 13) : -1;
  return cached(`calendar:${known ? level : 'none'}:${fill}`, () => sprite(CALENDAR_W, CALENDAR_H, (ctx) => {
    const edge = mix(C.paperLine, OUTLINE, 0.35);
    // drop shadow on the wall
    rect(ctx, 1, 3, 15, 16, withAlpha(OUTLINE, 0.22));
    // page
    rect(ctx, 0, 2, 15, 16, edge);
    rect(ctx, 1, 7, 13, 10, C.paper);
    // header
    rect(ctx, 0, 2, 15, 6, C.redDark);
    rect(ctx, 1, 3, 13, 4, C.red);
    rect(ctx, 1, 3, 13, 1, C.redLight);
    rect(ctx, 4, 5, 7, 1, '#f6d9d4');
    // binder rings
    for (const x of [3, 11]) {
      rect(ctx, x, 0, 1, 4, C.metalDark);
      px(ctx, x, 0, C.metalLight);
    }
    // day dots: five weeks, weekends in red
    for (let w = 0; w < 5; w++) {
      for (let d = 0; d < 7; d++) {
        px(ctx, 1 + d * 2, 8 + w * 2, d >= 5 ? C.redLight : C.paperLine);
      }
    }
    if (fill >= 0) {
      // this week: a bar of seven day cells, filled to pct
      const [main, light, dark] = LEVEL_COLORS[level];
      rect(ctx, 1, 11, 13, 3, '#ddd6c6');
      if (fill > 0) {
        rect(ctx, 1, 11, fill, 3, main);
        rect(ctx, 1, 11, fill, 1, light);
        rect(ctx, 1, 13, fill, 1, dark);
      }
      for (let d = 1; d < 7; d++) px(ctx, d * 2, 12, withAlpha(C.paper, 0.55));
    }
    // dog-eared corner
    px(ctx, 13, 16, C.offWhite);
    px(ctx, 14, 16, edge);
  }));
}

/** In-tray footprint (the tray itself) in pixels; papers and the badge rise above it. */
export const IN_TRAY = { w: 12, h: 6 } as const;

/**
 * Draws the manager's letter tray with its top-left at (x, y): papers stack
 * up with `count` (none, 1-2, 3-5, 6+), an urgent item gets a red tab.
 * The badge is separate (`drawTrayBadgeAt`).
 */
export function drawInTrayAt(ctx: CanvasRenderingContext2D, x: number, y: number, count: number, urgent: boolean): void {
  const n = Math.max(0, Math.floor(count));
  const layers = n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : 3;
  ctx.drawImage(inTraySprite(layers, urgent && n > 0), x - 1, y - 6);
}

function inTraySprite(layers: number, urgent: boolean): HTMLCanvasElement {
  return cached(`inTray:${layers}:${urgent}`, () => {
    // canvas covers 14 x 13: 1px margin around the 12 x 6 tray, 6 rows above it for papers
    const g = new PixelGrid(14, 13);
    const ox = 1;
    const oy = 6;
    // wire tray: floor and back rail
    g.fill(ox, oy, 12, 3, C.metalDeep);
    g.fill(ox, oy, 12, 1, C.metal);
    g.fill(ox, oy + 1, 1, 2, C.metal);
    g.fill(ox + 11, oy + 1, 1, 2, C.metalDark);
    // papers
    for (let k = 0; k < layers; k++) {
      const py = oy + 1 - k * 2;
      const sx = ox + 1 + (k % 2);
      g.fill(sx, py, 9, 1, C.paper);
      g.fill(sx, py + 1, 9, 1, k === 0 ? C.offWhite : C.paperLine);
      if (k === layers - 1) {
        g.set(sx + 2, py, C.paperLine);
        g.set(sx + 3, py, C.paperLine);
        g.set(sx + 4, py, C.paperLine);
        g.set(sx + 6, py, C.paperLine);
      }
    }
    if (urgent) {
      const top = oy + 1 - (layers - 1) * 2;
      g.fill(ox + 9, top - 3, 2, 3, C.red);
      g.set(ox + 9, top - 3, C.redLight);
    }
    // front rail with an "IN" label
    g.fill(ox, oy + 3, 12, 3, C.metalDark);
    g.fill(ox, oy + 3, 12, 1, C.metalLight);
    g.fill(ox + 1, oy + 4, 10, 1, C.metal);
    g.fill(ox + 4, oy + 4, 4, 1, C.paper);
    g.outline(OUTLINE, 0.65);
    return g.toCanvas();
  });
}

/**
 * A round notification badge centred at (cx, cy) with the count ("9+" above
 * nine). Urgent badges are red and pulse with `t` (ms); others are blue.
 */
export function drawTrayBadgeAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, count: number, urgent: boolean, t = 0): void {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return;
  const label = n > 9 ? '9+' : String(n);
  const pulse = urgent && Math.floor(t / 600) % 2 === 1;
  const fill = urgent ? (pulse ? '#ef5a4c' : '#d6382e') : '#3f78c8';
  ctx.drawImage(badgeSprite(label.length > 1, fill), Math.round(cx) - (label.length > 1 ? 5 : 4), Math.round(cy) - 4);
  const w = measurePixelText(label).w;
  drawPixelText(ctx, label, Math.round(cx) - Math.floor(w / 2), Math.round(cy) - 2, '#ffffff');
}

function badgeSprite(wide: boolean, fill: Color): HTMLCanvasElement {
  return cached(`badge:${wide}:${fill}`, () => {
    const rows = wide
      ? ['..xxxxx..', '.xxxxxxx.', 'xxxxxxxxx', 'xxxxxxxxx', 'xxxxxxxxx', '.xxxxxxx.', '..xxxxx..']
      : ['..xxx..', '.xxxxx.', 'xxxxxxx', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..'];
    const g = new PixelGrid(rows[0]!.length + 2, rows.length + 2);
    g.stamp(rows, { x: fill }, 1, 1);
    g.set(3, 2, lighten(fill, 0.3));
    g.outline(OUTLINE, 0.75);
    return g.toCanvas();
  });
}

/** Desk phone canvas size and where its line lights sit inside it (canvas-local). */
export const PHONE_W = 13;
export const PHONE_H = 9;
export const PHONE_LIGHTS: readonly { x: number; y: number }[] = [{ x: 2, y: 7 }, { x: 4, y: 7 }, { x: 6, y: 7 }, { x: 8, y: 7 }];
/** Centre of the small "+" that says there are more servers than lights (canvas-local, bottom-right corner). */
export const PHONE_MORE = { x: 11, y: 7 } as const;

/** A multi-line desk phone: handset on the cradle, keypad, LCD, four line lights (off). 13 x 9 with its outline. */
export function phoneSprite(): HTMLCanvasElement {
  return cached('phone', () => {
    const rows = [
      '.kk...kk...',
      '.kkkkkkk...',
      '99999999999',
      '9hhhhhhhhh9',
      '9+9+9+9ggg9',
      '9+9+9+99999',
      '9l9l9l9l999',
    ];
    const g = new PixelGrid(PHONE_W, PHONE_H);
    g.stamp(rows, { k: C.black, '9': C.charcoal, h: BASE_C.execLight, '+': C.metalLight, g: '#8fbf7a', l: '#4d4954' }, 1, 1);
    g.set(2, 2, BASE_C.execLight);
    g.outline(OUTLINE, 0.6);
    return g.toCanvas();
  });
}

/** Desk paper pile canvas: 0-4 sheet bundles, `warn` adds a red tab and a lean. Bottom-centre anchored by `drawPileAt`. */
function pileSprite(sheets: number, warn: boolean): HTMLCanvasElement {
  return cached(`pile:${sheets}:${warn}`, () => {
    const W = 11;
    const H = 14;
    const g = new PixelGrid(W, H);
    const shift = warn ? [0, 1, 1, 2] : [0, 1, 0, -1];
    for (let k = 0; k < sheets; k++) {
      const y = H - 2 - k * 2 - 1;
      const x = 2 + shift[k]!;
      g.fill(x, y, 7, 1, C.paper);
      g.fill(x, y + 1, 7, 1, k % 2 ? C.offWhite : C.paperLine);
    }
    if (sheets > 0) {
      const top = H - 2 - (sheets - 1) * 2 - 1;
      const x = 2 + shift[sheets - 1]!;
      g.set(x + 1, top, C.paperLine);
      g.set(x + 2, top, C.paperLine);
      g.set(x + 4, top, C.paperLine);
      if (warn) {
        g.fill(x + 5, top - 3, 1, 3, C.red);
        g.fill(x + 6, top - 3, 1, 2, C.red);
        g.set(x + 5, top - 3, C.redLight);
        g.set(x + 1, top, C.red);
        g.set(x + 2, top, C.red);
      }
    }
    g.outline(OUTLINE, 0.6);
    return g.toCanvas();
  });
}

/** Draws a desk paper pile whose bottom-centre is at (cx, bottomY). 0 sheets draws nothing. */
export function drawPileAt(ctx: CanvasRenderingContext2D, cx: number, bottomY: number, sheets: number, warn: boolean): void {
  const n = Math.max(0, Math.min(4, Math.floor(sheets)));
  if (n === 0) return;
  ctx.drawImage(pileSprite(n, warn), Math.round(cx) - 5, Math.round(bottomY) - 13);
}
