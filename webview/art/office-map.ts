/**
 * The floor plan: tile grid, walkability, desks and seats,
 * points of interest, furniture placements with depth-sort keys, screen and
 * sign anchors, and the pre-rendered background.
 *
 * Coordinates
 * - Tiles are TILE (16) px. Tile (tx, ty) covers pixels [tx*16, tx*16+16).
 * - All `x/y` fields named in pixels are map pixels at scale 1 (the
 *   background canvas is MAP_W*TILE x MAP_H*TILE).
 * - A character standing on tile (tx, ty) has its feet (frame anchor) at
 *   pixel (tx*16 + 8, ty*16 + 16) and sorts by that y.
 *
 * Layout (left to right): elevator lobby + reception, conference room,
 * bullpen (copier, shredder, filing cabinets, easel by the window), the
 * Regional Manager's glass office, the kitchen; below: the open bullpen with
 * desk clusters, the queue line outside the manager's door, and the annex.
 *
 * Everything except `renderBackground` / `getFurniture` (which need the DOM)
 * is plain data computed at import time.
 */
import type { ArchetypeId } from './looks.ts';
import type { Dir, Pose } from './characters.ts';
import { BASE_C, C, OUTLINE } from './palette.ts';
import type { Color } from './raster.ts';
import { ctx2d, darken, lighten, makeCanvas, mix, rect, withAlpha } from './raster.ts';
import { drawPixelText, fitPixelText, measurePixelText } from './font.ts';
import * as F from './furniture.ts';
import type { DeskOwner, LocalRect } from './furniture.ts';

/** Tile size in pixels. */
export const TILE = 16;
/** Map width in tiles. */
export const MAP_W = 46;
/** Map height in tiles. */
export const MAP_H = 17;
/** Map width in pixels. */
export const MAP_PX_W = MAP_W * TILE;
/** Map height in pixels. */
export const MAP_PX_H = MAP_H * TILE;

/** A tile coordinate. */
export interface TilePos { x: number; y: number }
/** A pixel rectangle on the map. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Floor plan. Legend:
 *   W outer wall    B bottom wall    # interior wall    G glass wall
 *   D door          d open doorway
 *   l lobby floor   c bullpen carpet r conference carpet
 *   m manager carpet k kitchen lino  a annex carpet
 */
const PLAN: readonly string[] = [
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wlllllll#rrrrrrr#cccccccccccGmmmmmm#kkkkkkkkkW',
  'Wccccccc#GGGDGGG#cccccccccccGGDGGGG#D########W',
  'Wccccccccccccccccccccccccccccccc#aaaaaaaaaaaaW',
  'Wccccccccccccccccccccccccccccccc#aaaaaaaaaaaaW',
  'WcccccccccccccccccccccccccccccccdaaaaaaaaaaaaW',
  'Wccccccccccccccccccccccccccccccc#aaaaaaaaaaaaW',
  'Wccccccccccccccccccccccccccccccc#aaaaaaaaaaaaW',
  'Wccccccccccccccccccccccccccccccc#aaaaaaaaaaaaW',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
];

/** The plan character at a tile ('W' outside the map). */
export function planAt(tx: number, ty: number): string {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return 'W';
  return PLAN[ty]![tx] ?? 'W';
}

const isWallChar = (ch: string): boolean => ch === 'W' || ch === 'B' || ch === '#' || ch === 'G';

/** Pixel position of a tile's top-left corner. */
export function tileToPx(t: TilePos): { x: number; y: number } {
  return { x: t.x * TILE, y: t.y * TILE };
}

/** Feet pixel (character anchor) for a character standing or sitting on a tile. */
export function tileFeet(t: TilePos): { x: number; y: number } {
  return { x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE };
}

const T = (x: number, y: number): TilePos => ({ x, y });

// ---------------------------------------------------------------------------
// Desks and seats

/**
 * Who a seat belongs to. `reception` is the front desk: the permanent
 * receptionist sits there and no worker is ever assigned to it.
 */
export type SeatOwner = 'manager' | 'reception' | ArchetypeId | 'temp';

/** A place where a character sits facing the camera. */
export interface Seat {
  /** Stable id, e.g. `desk-assistant` or `temp-annex-3`. */
  id: string;
  owner: SeatOwner;
  /** The tile the character occupies (their feet anchor is its bottom-centre). */
  tile: TilePos;
  facing: Dir;
  /** The desk this seat belongs to. */
  deskId: string;
  /** Where a visitor (e.g. the manager) stands to talk to this seat, and which way they face. */
  visit: { tile: TilePos; facing: Dir };
  /** One of the hand-picked best desks (the engine seats the top model tiers here first). */
  best: boolean;
  /** The seat tile is on the annex carpet (the temp annex and the staff desk inside it): ranked last. */
  annex: boolean;
}

/** A desk with a monitor whose screen the engine can tint. */
export interface Desk {
  id: string;
  seatId: string;
  kind: 'staff' | 'manager' | 'reception';
  /** Monitor screen rectangle in map pixels (draw per-activity content here). */
  screen: Rect;
  /** A slightly larger rectangle around the monitor for an optional soft glow. */
  glow: Rect;
}

interface DeskDef {
  id: string;
  owner: SeatOwner;
  props: DeskOwner;
  seat: TilePos;
  kind: 'staff' | 'manager' | 'reception';
  /** Staff desks only: seat on the desk's left tile (monitor on the right). */
  seatLeft: boolean;
  chair: 'teal' | 'exec' | 'orange';
  /** One of the hand-picked best desks. */
  best?: true;
}

const DESK_DEFS: readonly DeskDef[] = [
  { id: 'desk-manager', owner: 'manager', props: 'manager', seat: T(32, 5), kind: 'manager', seatLeft: false, chair: 'exec' },
  { id: 'desk-receptionist', owner: 'reception', props: 'receptionist', seat: T(5, 5), kind: 'reception', seatLeft: false, chair: 'teal' },
  { id: 'desk-assistant', owner: 'assistant', props: 'assistant', seat: T(27, 11), kind: 'staff', seatLeft: false, chair: 'teal', best: true },
  { id: 'desk-prankster', owner: 'prankster', props: 'prankster', seat: T(24, 11), kind: 'staff', seatLeft: true, chair: 'teal', best: true },
  // the IT help desk: middle of the bottom row (blocks (16,14), (15,15), (16,15); visitors stand at (14,14))
  { id: 'desk-helpdesk', owner: 'helpdesk', props: 'helpdesk', seat: T(15, 14), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'desk-crossword', owner: 'crossword', props: 'crossword', seat: T(14, 11), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'desk-knitting', owner: 'knitting', props: 'knitting', seat: T(17, 11), kind: 'staff', seatLeft: false, chair: 'teal', best: true },
  { id: 'desk-cat', owner: 'cat', props: 'cat', seat: T(4, 14), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'desk-chili', owner: 'chili', props: 'chili', seat: T(7, 14), kind: 'staff', seatLeft: false, chair: 'teal' },
  { id: 'desk-hr', owner: 'hr', props: 'hr', seat: T(43, 13), kind: 'staff', seatLeft: true, chair: 'teal' },
  // annex temp desks (preferred for temps, in this order)
  { id: 'temp-annex-1', owner: 'temp', props: 'temp', seat: T(34, 10), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-2', owner: 'temp', props: 'temp', seat: T(37, 10), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-3', owner: 'temp', props: 'temp', seat: T(40, 10), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-4', owner: 'temp', props: 'temp', seat: T(43, 10), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-5', owner: 'temp', props: 'temp', seat: T(34, 13), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-6', owner: 'temp', props: 'temp', seat: T(37, 13), kind: 'staff', seatLeft: true, chair: 'teal' },
  { id: 'temp-annex-7', owner: 'temp', props: 'temp', seat: T(40, 13), kind: 'staff', seatLeft: true, chair: 'teal' },
  // spare bullpen desks (overflow seats for temps)
  { id: 'temp-bullpen-1', owner: 'temp', props: 'spare', seat: T(19, 6), kind: 'staff', seatLeft: true, chair: 'teal', best: true },
  { id: 'temp-bullpen-2', owner: 'temp', props: 'spare', seat: T(22, 6), kind: 'staff', seatLeft: false, chair: 'teal', best: true },
  { id: 'temp-bullpen-3', owner: 'temp', props: 'spare', seat: T(19, 14), kind: 'staff', seatLeft: true, chair: 'teal', best: true },
  { id: 'temp-bullpen-4', owner: 'temp', props: 'spare', seat: T(22, 14), kind: 'staff', seatLeft: false, chair: 'teal', best: true },
  { id: 'temp-bullpen-5', owner: 'temp', props: 'spare', seat: T(11, 14), kind: 'staff', seatLeft: true, chair: 'teal' },
];

function deskScreenLocal(d: DeskDef): LocalRect {
  if (d.kind === 'manager') return F.WIDE_DESK_SCREEN;
  if (d.kind === 'reception') return F.RECEPTION_SCREEN;
  return F.deskScreenRect(d.seatLeft);
}

function deskOriginX(d: DeskDef): number {
  if (d.kind !== 'staff') return (d.seat.x - 1) * TILE;
  return d.seatLeft ? d.seat.x * TILE : (d.seat.x - 1) * TILE;
}

function deskBlocks(d: DeskDef): TilePos[] {
  const { x, y } = d.seat;
  if (d.kind !== 'staff') return [T(x - 1, y), T(x + 1, y), T(x - 1, y + 1), T(x, y + 1), T(x + 1, y + 1)];
  const other = d.seatLeft ? x + 1 : x - 1;
  return [T(other, y), T(x, y + 1), T(other, y + 1)];
}

function visitFor(d: DeskDef): { tile: TilePos; facing: Dir } {
  const { x, y } = d.seat;
  if (d.kind !== 'staff') return { tile: T(x, y + 2), facing: 'up' };
  return d.seatLeft ? { tile: T(x - 1, y), facing: 'right' } : { tile: T(x + 1, y), facing: 'left' };
}

/** All desk seats: 1 manager, the reception desk, 8 staff, then temp seats (annex first, then spare bullpen desks). */
export const seats: readonly Seat[] = DESK_DEFS.map((d) => ({
  id: d.id,
  owner: d.owner,
  tile: d.seat,
  facing: 'down' as Dir,
  deskId: d.id,
  visit: visitFor(d),
  best: d.best === true,
  annex: planAt(d.seat.x, d.seat.y) === 'a',
}));

/** All desks with their monitor screen anchors (keyed by the same id as their seat). */
export const desks: readonly Desk[] = DESK_DEFS.map((d) => {
  const local = deskScreenLocal(d);
  const ox = deskOriginX(d);
  const oy = d.seat.y * TILE + F.DESK_TOP.dy;
  const screen = { x: ox + local.x, y: oy + local.y, w: local.w, h: local.h };
  return { id: d.id, seatId: d.id, kind: d.kind, screen, glow: { x: screen.x - 3, y: screen.y - 3, w: screen.w + 6, h: screen.h + 9 } };
});

/**
 * Where a worker's paper pile stands on a staff desk: bottom-centre in map
 * pixels, on the monitor tile next to the keyboard (mirrored for right seats).
 * Keyed by desk id; the manager and reception desks have none.
 */
export const deskPileAnchors: Readonly<Record<string, { x: number; y: number }>> = Object.fromEntries(
  DESK_DEFS.filter((d) => d.kind === 'staff').map((d) => {
    const ox = deskOriginX(d);
    return [d.id, { x: ox + (d.seatLeft ? 19 : F.DESK_TOP.w - 19), y: d.seat.y * TILE + F.DESK_TOP.dy + 23 }];
  }),
);

/** Seat lookup by owner (first match). */
export function seatFor(owner: SeatOwner): Seat | undefined {
  return seats.find((s) => s.owner === owner);
}

/** Temp seats in preference order (annex first). */
export const tempSeats: readonly Seat[] = seats.filter((s) => s.owner === 'temp');

// ---------------------------------------------------------------------------
// Points of interest

/** A standing (or sitting) spot with the pose to play there. */
export interface Spot { tile: TilePos; facing: Dir; pose: Pose }

const S = (x: number, y: number, facing: Dir, pose: Pose): Spot => ({ tile: T(x, y), facing, pose });

/** Named activity spots. Each tile is walkable and reachable from every seat. */
export const poi = {
  /** In front of the filing cabinet drawers. */
  filingCabinets: [S(21, 4, 'up', 'rummage'), S(22, 4, 'up', 'rummage'), S(23, 4, 'up', 'rummage')] as readonly Spot[],
  /** Drafting easel by the bullpen window. */
  easel: S(26, 4, 'up', 'draw'),
  /** Conference room whiteboard. */
  whiteboard: S(12, 3, 'up', 'whiteboard'),
  /** Waiting at the copier (faces the room, foot tapping). */
  copier: S(17, 4, 'down', 'copierWait'),
  /** Feeding the shredder. */
  shredder: S(19, 4, 'up', 'shred'),
  fridge: S(36, 4, 'up', 'rummage'),
  microwave: S(37, 4, 'up', 'stand'),
  coffee: S(38, 4, 'up', 'stand'),
  /** Two chat spots facing each other across the water cooler. */
  waterCooler: [S(40, 4, 'right', 'talk'), S(42, 4, 'left', 'talk')] as readonly Spot[],
  vendingMachine: S(43, 4, 'up', 'stand'),
  /** Seats at the round kitchen table (seated poses, facing the camera). */
  kitchenTable: [S(39, 5, 'down', 'sitIdle'), S(40, 5, 'down', 'sitIdle')] as readonly Spot[],
  /** The manager's door tile (in the glass wall). */
  managerDoor: T(30, 9),
  /** Queue outside the manager's door, first spot right at the door; all face the door. */
  managerDoorQueue: [S(30, 10, 'up', 'knock'), S(30, 11, 'up', 'stand'), S(30, 12, 'up', 'stand'), S(30, 13, 'up', 'stand'), S(30, 14, 'up', 'stand')] as readonly Spot[],
  /** Just inside the manager's door, where he can wave at whoever is waiting. */
  managerInsideDoor: S(30, 8, 'down', 'wave'),
  /** Temps appear and leave here (in front of the elevator doors). */
  elevator: S(2, 3, 'down', 'stand'),
  /** Visitor spot in front of the reception counter. */
  reception: S(5, 7, 'up', 'stand'),
  /** A good place to stand and point towards reception when delegating. */
  delegate: S(12, 10, 'left', 'point'),
  /**
   * Where the boss sulks while a Fable agent has his office: the right-hand
   * kitchen-table seat (the same tile as `kitchenTable[1]`, so it shares its
   * reservation and wanderers keep off it). In view, out of everyone's way,
   * and the table front hides his legs like a desk.
   */
  sulk: S(40, 5, 'down', 'sitIdle'),
} as const;

// ---------------------------------------------------------------------------
// Wall anchors

/** Company sign plate on the lobby wall (blank; the engine draws the name). */
export const signRect: Rect = { x: 60, y: 15, w: 74, h: 20 };
/** Inner text area of the sign (both lines; 68 px fits "Middle Management" (67 px) at 1x). */
export const signTextRect: Rect = { x: 63, y: 18, w: 68, h: 14 };
/** Where the company line (top) sits when there are two lines. */
export const signCompanyRect: Rect = { x: 63, y: 19, w: 68, h: 5 };
/** Where the branch line (bottom) sits when there are two lines. */
export const signBranchRect: Rect = { x: 63, y: 26, w: 68, h: 5 };
/** Built-in company line colour (brighter). The live one is `C.signText` (a theme's `colors.signText`). */
export const SIGN_TEXT_COLOR = BASE_C.signText;
/** Built-in branch line colour (slightly dimmer). The live one is `C.signBranch`. */
export const SIGN_BRANCH_COLOR = BASE_C.signBranch;
/** Wall clock centre and radius (the engine may draw live hands with `drawClockHands`). */
export const clockAnchor = { x: 370, y: 24, r: 7 } as const;
/** Wall calendar (left of the clock, over the filing cabinets); `drawCalendar` repaints it with the weekly window. */
export const calendarRect: Rect = { x: 343, y: 15, w: F.CALENDAR_W, h: F.CALENDAR_H };
/** Writable area of the conference-room whiteboard. */
export const whiteboardRect: Rect = { x: 172, y: 18, w: 56, h: 18 };
/** Drawable canvas area on the easel (where a drawing in progress can appear). */
export const easelCanvasRect: Rect = { x: 26 * TILE + F.EASEL_CANVAS.x, y: 4 * TILE - 32 + F.EASEL_CANVAS.y, w: F.EASEL_CANVAS.w, h: F.EASEL_CANVAS.h };

/** Top-left of the temp-agency sign on the annex wall (between the bulletin board and the poster). */
const TEMP_AGENCY_POS = { x: 638, y: 9 * TILE - 7 } as const;

const MGR_DESK_ORIGIN = { x: 31 * TILE, y: 5 * TILE + F.WIDE_DESK_TOP.dy } as const;

/** The manager's in-tray: top-left of the 12 x 6 tray on his desk (papers and badge rise above it). */
export const inTrayAnchor = { x: MGR_DESK_ORIGIN.x + F.MGR_IN_TRAY.x, y: MGR_DESK_ORIGIN.y + F.MGR_IN_TRAY.y } as const;
/** Top-left of the desk phone canvas on the manager's desk (`F.PHONE_LIGHTS` are relative to it). */
export const phoneAnchor = { x: MGR_DESK_ORIGIN.x + F.MGR_PHONE.x, y: MGR_DESK_ORIGIN.y + F.MGR_PHONE.y } as const;

/** Every prop the office can outline, point at or (from v0.3/v0.4) click. Same ids as `engine/hotspots.ts`. */
export type PropId =
  | 'clock' | 'calendar' | 'inTray' | 'whiteboard' | 'directoryBoard' | 'frontDesk'
  | 'bookshelf' | 'phone' | 'tempAgency' | 'filingCabinets' | 'noticeBoard';

/** A prop's hit/outline rectangle in map pixels. */
export interface PropAnchor { x: number; y: number; w: number; h: number }

/**
 * Map-pixel rectangles of the office props, tight around what is drawn
 * (the clock includes its usage ring, the in-tray its badge).
 */
export const PROP_ANCHORS: Readonly<Record<PropId, PropAnchor>> = {
  clock: { x: clockAnchor.x - 10, y: clockAnchor.y - 10, w: 21, h: 20 },
  calendar: { x: calendarRect.x, y: calendarRect.y, w: 15, h: 18 },
  inTray: { x: inTrayAnchor.x - 1, y: inTrayAnchor.y - 6, w: 18, h: 13 },
  whiteboard: { x: whiteboardRect.x - 3, y: whiteboardRect.y - 3, w: whiteboardRect.w + 6, h: whiteboardRect.h + 7 },
  directoryBoard: { x: 4 * TILE, y: 4 * TILE - 24, w: 16, h: 24 },
  frontDesk: { x: 64, y: 74, w: 48, h: 38 },
  bookshelf: { x: 25 * TILE, y: 16 * TILE - 36, w: 32, h: 36 },
  phone: { x: phoneAnchor.x, y: phoneAnchor.y, w: F.PHONE_W, h: F.PHONE_H },
  tempAgency: { x: TEMP_AGENCY_POS.x, y: TEMP_AGENCY_POS.y, w: 27, h: 15 },
  filingCabinets: { x: 21 * TILE, y: 4 * TILE - 30, w: 48, h: 30 },
  noticeBoard: { x: 648, y: 16, w: 24, h: 18 },
};

// ---------------------------------------------------------------------------
// Furniture placements (DOM-free until sprites are requested)

/** One drawable static prop. */
export interface FurnitureItem {
  id: string;
  kind: string;
  /** Default sprite. */
  sprite: HTMLCanvasElement;
  /** Top-left pixel position on the map. */
  x: number;
  y: number;
  /**
   * Depth key. Draw furniture and characters together in ascending sortY
   * (characters use their feet y). On ties draw furniture first.
   */
  sortY: number;
  /** Must draw above a character seated at the matching desk (desk fronts, table edges). */
  aboveSeated: boolean;
  /** Alternate sprites (e.g. `open` filing cabinet, `active` copier, `open` door). */
  variants: Readonly<Record<string, HTMLCanvasElement>>;
  /** Desk/seat this item belongs to, if any. */
  deskId?: string;
}

interface Placement {
  id: string;
  kind: string;
  make: () => HTMLCanvasElement;
  x: number;
  y: number;
  sortY: number;
  aboveSeated?: boolean;
  blocks: TilePos[];
  variants?: Record<string, () => HTMLCanvasElement>;
  deskId?: string;
}

const placements: Placement[] = [];
function place(p: Placement): void { placements.push(p); }

/** Places a sprite standing on tile (tx, ty) with its base on the tile's bottom edge, centred over `wTiles` tiles. */
function stand(id: string, kind: string, tx: number, ty: number, w: number, h: number, make: () => HTMLCanvasElement, opts: { wTiles?: number; blocks?: TilePos[]; variants?: Record<string, () => HTMLCanvasElement> } = {}): void {
  const wTiles = opts.wTiles ?? 1;
  const blocks = opts.blocks ?? Array.from({ length: wTiles }, (_, i) => T(tx + i, ty));
  place({ id, kind, make, x: tx * TILE + Math.floor((wTiles * TILE - w) / 2), y: (ty + 1) * TILE - h, sortY: (ty + 1) * TILE, blocks, variants: opts.variants });
}

// desks, chairs
for (const d of DESK_DEFS) {
  const X = d.seat.x * TILE;
  const Y = d.seat.y * TILE;
  const ox = deskOriginX(d);
  const blocks = deskBlocks(d);
  place({ id: `${d.id}-chair`, kind: 'chair', make: () => F.chairSprite(d.chair), x: X, y: d.chair === 'exec' ? Y - 3 : Y + 1, sortY: Y + 14, blocks: [], deskId: d.id });
  if (d.kind === 'manager') {
    place({ id: `${d.id}-top`, kind: 'deskTop', make: () => F.managerDeskTopSprite(), x: ox, y: Y + F.WIDE_DESK_TOP.dy, sortY: Y + 15, blocks, deskId: d.id, variants: { noMug: () => F.managerDeskTopSprite(true) } });
    place({ id: `${d.id}-front`, kind: 'deskFront', make: F.managerDeskFrontSprite, x: ox, y: Y + F.WIDE_DESK_FRONT.dy, sortY: Y + 31, aboveSeated: true, blocks: [], deskId: d.id });
  } else if (d.kind === 'reception') {
    place({ id: `${d.id}-top`, kind: 'deskTop', make: () => F.receptionDeskTopSprite(false), x: ox, y: Y + F.WIDE_DESK_TOP.dy, sortY: Y + 15, blocks, deskId: d.id, variants: { phoneOff: () => F.receptionDeskTopSprite(true) } });
    place({ id: `${d.id}-front`, kind: 'deskFront', make: F.receptionDeskFrontSprite, x: ox, y: Y + F.RECEPTION_FRONT_DY, sortY: Y + 31, aboveSeated: true, blocks: [], deskId: d.id });
  } else {
    const seed = d.seat.x * 31 + d.seat.y;
    place({ id: `${d.id}-top`, kind: 'deskTop', make: () => F.deskTopSprite(d.props, d.seatLeft, seed), x: ox, y: Y + F.DESK_TOP.dy, sortY: Y + 15, blocks, deskId: d.id, variants: { noMug: () => F.deskTopSprite(d.props, d.seatLeft, seed, true) } });
    place({ id: `${d.id}-front`, kind: 'deskFront', make: () => F.deskFrontSprite(d.seatLeft), x: ox, y: Y + F.DESK_FRONT.dy, sortY: Y + 31, aboveSeated: true, blocks: [], deskId: d.id });
  }
}

// lobby
stand('plant-lobby-1', 'plant', 1, 3, 16, 32, () => F.plantSprite(true, 1));
stand('plant-lobby-2', 'plant', 7, 3, 16, 32, () => F.plantSprite(true, 2));
stand('plant-lobby-3', 'plant', 1, 8, 16, 18, () => F.plantSprite(false, 3));

// conference room
place({ id: 'conf-table', kind: 'table', make: F.conferenceTableSprite, x: 10 * TILE, y: 5 * TILE, sortY: 7 * TILE, blocks: [10, 11, 12, 13, 14].flatMap((x) => [T(x, 5), T(x, 6)]) });
for (const x of [10, 11, 13, 14]) {
  place({ id: `conf-chair-n-${x}`, kind: 'chair', make: () => F.chairSprite('teal'), x: x * TILE, y: 4 * TILE + 2, sortY: 5 * TILE - 1, blocks: [T(x, 4)] });
  place({ id: `conf-chair-s-${x}`, kind: 'chair', make: () => F.chairBackSprite('teal'), x: x * TILE, y: 7 * TILE - 2, sortY: 8 * TILE, blocks: [T(x, 7)] });
}
stand('plant-conf-1', 'plant', 15, 3, 16, 32, () => F.plantSprite(true, 4));
stand('plant-conf-2', 'plant', 15, 8, 16, 18, () => F.plantSprite(false, 5));

// bullpen equipment along the window wall
stand('copier', 'copier', 17, 3, 32, 30, () => F.copierSprite(false), { wTiles: 2, variants: { active: () => F.copierSprite(true) } });
stand('shredder', 'shredder', 19, 3, 16, 20, () => F.shredderSprite(false), { variants: { active: () => F.shredderSprite(true) } });
stand('plant-bullpen-1', 'plant', 20, 3, 16, 32, () => F.plantSprite(true, 6));
for (const x of [21, 22, 23]) stand(`filing-${x}`, 'filingCabinet', x, 3, 16, 30, () => F.filingCabinetSprite(false), { variants: { open: () => F.filingCabinetSprite(true) } });
stand('easel', 'easel', 26, 3, 16, 32, F.easelSprite);
stand('plant-bullpen-2', 'plant', 27, 3, 16, 32, () => F.plantSprite(true, 7));
stand('plant-bullpen-3', 'plant', 1, 10, 16, 18, () => F.plantSprite(false, 8));
stand('plant-bullpen-4', 'plant', 31, 15, 16, 32, () => F.plantSprite(true, 9));
stand('filing-front-1', 'filingCabinet', 9, 15, 16, 30, () => F.filingCabinetSprite(false), { variants: { open: () => F.filingCabinetSprite(true) } });

// manager's office
stand('plant-mgr', 'plant', 29, 3, 16, 32, () => F.plantSprite(true, 10));
stand('putter', 'putter', 34, 3, 16, 22, F.putterSprite);
for (const x of [31, 33]) place({ id: `mgr-guest-${x}`, kind: 'chair', make: () => F.chairBackSprite('exec'), x: x * TILE, y: 7 * TILE - 2, sortY: 8 * TILE, blocks: [T(x, 7)] });

// kitchen
stand('fridge', 'fridge', 36, 3, 16, 38, F.fridgeSprite);
stand('counter', 'counter', 37, 3, 48, 28, F.counterSprite, { wTiles: 3 });
stand('water-cooler', 'waterCooler', 41, 3, 16, 30, F.waterCoolerSprite);
stand('vending', 'vendingMachine', 43, 3, 32, 42, F.vendingMachineSprite, { wTiles: 2 });
place({ id: 'kitchen-table-top', kind: 'deskTop', make: F.roundTableTopSprite, x: 39 * TILE, y: 5 * TILE - 6, sortY: 5 * TILE + 15, blocks: [T(39, 6), T(40, 6)] });
place({ id: 'kitchen-table-front', kind: 'deskFront', make: F.roundTableFrontSprite, x: 39 * TILE, y: 5 * TILE + 18, sortY: 5 * TILE + 31, aboveSeated: true, blocks: [] });
for (const x of [39, 40]) {
  place({ id: `kitchen-chair-${x}`, kind: 'chair', make: () => F.chairSprite('orange'), x: x * TILE, y: 5 * TILE + 1, sortY: 5 * TILE + 14, blocks: [] });
  place({ id: `kitchen-chair-s-${x}`, kind: 'chair', make: () => F.chairBackSprite('orange'), x: x * TILE, y: 7 * TILE - 2, sortY: 8 * TILE, blocks: [T(x, 7)] });
}
stand('plant-kitchen', 'plant', 44, 7, 16, 18, () => F.plantSprite(false, 11));

// lobby directory board, right of the elevator (clear of the reception counter)
stand('directory-board', 'directoryBoard', 4, 3, 16, 24, F.directoryBoardSprite);
// bookshelf against the bottom wall of the bullpen, right of the spare desks
stand('bookshelf', 'bookshelf', 25, 15, 32, 36, F.bookshelfSprite, { wTiles: 2 });

// annex
stand('plant-annex', 'plant', 33, 15, 16, 32, () => F.plantSprite(true, 12));
place({ id: 'annex-board', kind: 'poster', make: () => F.posterSprite('board'), x: 38 * TILE + 3, y: 9 * TILE - 7, sortY: 10 * TILE + 0.5, blocks: [] });
place({ id: 'annex-poster', kind: 'poster', make: () => F.posterSprite('teamwork'), x: 42 * TILE - 3, y: 9 * TILE - 7, sortY: 10 * TILE + 0.5, blocks: [] });
place({ id: 'temp-agency', kind: 'poster', make: F.tempAgencySignSprite, x: TEMP_AGENCY_POS.x, y: TEMP_AGENCY_POS.y, sortY: 10 * TILE + 0.5, blocks: [] });

// interior walls, glass and doors (one item per tile so depth sorting is exact)
for (let ty = 0; ty < MAP_H; ty++) {
  for (let tx = 0; tx < MAP_W; tx++) {
    const ch = planAt(tx, ty);
    const below = planAt(tx, ty + 1);
    const horizontalRow = ty === 9;
    if (ch === '#') {
      if (horizontalRow) {
        place({ id: `wall-${tx}-${ty}`, kind: 'wall', make: F.wallHSprite, x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [T(tx, ty)] });
      } else {
        const end = !isWallChar(below) && below !== 'D';
        place({ id: `wall-${tx}-${ty}`, kind: 'wall', make: () => F.wallVSprite(end), x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [T(tx, ty)] });
      }
    } else if (ch === 'G') {
      if (horizontalRow) place({ id: `glass-${tx}-${ty}`, kind: 'glass', make: () => F.glassHSprite(tx % 3 === 0 ? 0.6 : 0.4), x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [T(tx, ty)] });
      else place({ id: `glass-${tx}-${ty}`, kind: 'glass', make: F.glassVSprite, x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [T(tx, ty)] });
    } else if (ch === 'D') {
      const id = `door-${tx}-${ty}`;
      if (tx === poi.managerDoor.x && ty === poi.managerDoor.y) {
        place({ id: 'door-manager', kind: 'door', make: () => F.doorSprite('managerClosed'), x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [], variants: { open: () => F.doorSprite('managerOpen') } });
      } else {
        const kind = planAt(tx, ty - 1) === 'r' ? 'glassOpen' : 'woodOpen';
        place({ id, kind: 'door', make: () => F.doorSprite(kind), x: tx * TILE, y: ty * TILE - F.WALL_RISE, sortY: (ty + 1) * TILE, blocks: [] });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Walkability

/** 1 = walkable, 0 = blocked; index ty * MAP_W + tx. Doors and doorways are walkable. */
export const walkGrid: Uint8Array = (() => {
  const g = new Uint8Array(MAP_W * MAP_H);
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const ch = planAt(tx, ty);
      g[ty * MAP_W + tx] = isWallChar(ch) ? 0 : 1;
    }
  }
  for (const p of placements) for (const b of p.blocks) if (b.x >= 0 && b.y >= 0 && b.x < MAP_W && b.y < MAP_H) g[b.y * MAP_W + b.x] = 0;
  return g;
})();

/** True if a character may stand on (tx, ty). Seat tiles are walkable. */
export function isWalkable(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
  return walkGrid[ty * MAP_W + tx] === 1;
}

// ---------------------------------------------------------------------------
// Furniture (lazily rasterised)

let furnitureCache: FurnitureItem[] | null = null;

/** Drops the rasterised furniture list and background so the next call redraws them from `C` (see `invalidateArtCaches`). */
export function clearMapCaches(): void {
  furnitureCache = null;
  bgCache = null;
}

/** For tests: whether the furniture list and background are cached. */
export function mapCacheState(): { furniture: boolean; background: boolean } {
  return { furniture: furnitureCache !== null, background: bgCache !== null };
}

/** Every static prop with its sprite and depth key, sorted by sortY. Needs the DOM. */
export function getFurniture(): readonly FurnitureItem[] {
  if (furnitureCache) return furnitureCache;
  furnitureCache = placements
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      sprite: p.make(),
      x: p.x,
      y: p.y,
      sortY: p.sortY,
      aboveSeated: p.aboveSeated ?? false,
      variants: Object.fromEntries(Object.entries(p.variants ?? {}).map(([k, f]) => [k, f()])),
      deskId: p.deskId,
    }))
    .sort((a, b) => a.sortY - b.sortY);
  return furnitureCache;
}

/** Ids of every furniture placement (DOM-free), e.g. for state lookups like `door-manager` or `filing-21`. */
export const furnitureIds: readonly string[] = placements.map((p) => p.id);

// ---------------------------------------------------------------------------
// Background

function floorKind(tx: number, ty: number): string {
  const ch = planAt(tx, ty);
  if ('lcrmka'.includes(ch)) return ch;
  if (ch === 'D' || ch === 'd' || ch === '#' || ch === 'G') {
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]] as const) {
      const n = planAt(tx + dx, ty + dy);
      if ('lcrmka'.includes(n)) return n;
    }
  }
  return 'c';
}

function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function drawFloorTile(ctx: CanvasRenderingContext2D, tx: number, ty: number, kind: string): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const carpet = (base: Color, alt: Color): void => {
    rect(ctx, x, y, TILE, TILE, (tx + ty) % 2 ? base : mix(base, alt, 0.45));
    for (let i = 0; i < 7; i++) {
      const sx = Math.floor(hash(tx, ty, i) * 16);
      const sy = Math.floor(hash(ty, tx, i + 9) * 16);
      rect(ctx, x + sx, y + sy, 1, 1, hash(tx, ty, i + 40) > 0.5 ? lighten(base, 0.08) : darken(base, 0.08));
    }
    if (tx % 2 === 0) rect(ctx, x, y, 1, TILE, darken(base, 0.06));
    if (ty % 2 === 0) rect(ctx, x, y, TILE, 1, darken(base, 0.06));
  };
  switch (kind) {
    case 'l':
      rect(ctx, x, y, TILE, TILE, (tx + ty) % 2 ? C.lobby : C.lobbyAlt);
      rect(ctx, x, y, TILE, 1, C.lobbyGrout);
      rect(ctx, x, y, 1, TILE, C.lobbyGrout);
      rect(ctx, x + 1, y + 1, 5, 1, lighten(C.lobby, 0.1));
      break;
    case 'k':
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) rect(ctx, x + i * 8, y + j * 8, 8, 8, (i + j) % 2 ? C.kitchen : C.kitchenAlt);
      break;
    case 'r': carpet(C.conf, C.confAlt); break;
    case 'm': carpet(C.mgr, C.mgrAlt); break;
    case 'a': carpet(C.annex, C.annexAlt); break;
    default: carpet(C.carpet, C.carpetAlt); break;
  }
}

function drawWindow(ctx: CanvasRenderingContext2D, cx: number, w: number, blinds: number): void {
  const x = Math.round(cx - w / 2);
  const y = 15;
  const h = 24;
  rect(ctx, x - 1, y - 1, w + 2, h + 3, C.windowFrameShade);
  rect(ctx, x, y, w, h, C.windowFrame);
  // outside: grey Pennsylvania sky over a low skyline
  rect(ctx, x + 2, y + 2, w - 4, h - 4, C.sky);
  rect(ctx, x + 2, y + 2, w - 4, 6, C.skyLight);
  for (let i = 0; i < w - 4; i += 3) {
    const bh = 3 + Math.floor(hash(cx, i) * 6);
    rect(ctx, x + 2 + i, y + h - 2 - bh, 3, bh, hash(i, cx) > 0.5 ? C.city : C.cityDark);
  }
  rect(ctx, x + 2, y + h - 3, w - 4, 1, C.skyLow);
  // blinds
  const bh = Math.round((h - 4) * blinds);
  for (let j = 0; j < bh; j++) rect(ctx, x + 2, y + 2 + j, w - 4, 1, j % 2 ? C.blindsShade : C.blinds);
  rect(ctx, x + 2, y + 2 + bh, w - 4, 1, C.wallDark);
  rect(ctx, x + Math.round(w / 2) - 1, y + 2 + bh, 1, 3, C.blindsShade);
  // mullion and sill
  rect(ctx, x + Math.floor(w / 2), y + 2, 1, h - 4, C.windowFrame);
  rect(ctx, x - 2, y + h, w + 4, 2, C.windowFrame);
  rect(ctx, x - 2, y + h + 2, w + 4, 1, C.wallDark);
}

function drawTopWall(ctx: CanvasRenderingContext2D): void {
  const W = MAP_PX_W;
  // drop ceiling with fluorescent panels
  rect(ctx, 0, 0, W, 10, C.ceiling);
  for (let x = 0; x < W; x += 16) rect(ctx, x, 0, 1, 10, C.ceilingGrid);
  rect(ctx, 0, 4, W, 1, C.ceilingShade);
  for (let x = 40; x < W - 20; x += 96) {
    rect(ctx, x - 1, 1, 26, 8, C.lightPanelEdge);
    rect(ctx, x, 2, 24, 6, C.lightPanel);
    rect(ctx, x, 4, 24, 1, '#e3eef6');
  }
  rect(ctx, 0, 10, W, 2, C.ceilingGrid);
  rect(ctx, 0, 12, W, 1, C.wallShade);
  // wall face
  rect(ctx, 0, 13, W, 31, C.wall);
  for (let x = 0; x < W; x += 2) if (hash(x, 3) > 0.7) rect(ctx, x, 13 + Math.floor(hash(x, 5) * 30), 1, 1, C.wallLight);
  rect(ctx, 0, 13, W, 2, C.wallShade);
  rect(ctx, 0, 41, W, 3, C.wallShade);
  rect(ctx, 0, 44, W, 4, C.baseboard);
  rect(ctx, 0, 44, W, 1, C.baseboardLight);
}

function drawElevator(ctx: CanvasRenderingContext2D): void {
  const cx = 2 * TILE + 8;
  const x = cx - 15;
  rect(ctx, x, 12, 30, 36, C.metalDark);
  rect(ctx, x + 1, 13, 28, 35, C.metal);
  rect(ctx, x + 3, 16, 24, 32, C.metalDeep);
  rect(ctx, x + 4, 17, 11, 31, C.metalLight);
  rect(ctx, x + 15, 17, 11, 31, C.metalLight);
  rect(ctx, x + 14, 17, 2, 31, C.metalDark);
  rect(ctx, x + 5, 18, 2, 28, '#d9dee3');
  rect(ctx, x + 17, 18, 2, 28, '#d9dee3');
  // floor indicator
  rect(ctx, cx - 5, 13, 10, 3, C.black);
  rect(ctx, cx - 3, 14, 1, 1, '#ffb347');
  rect(ctx, cx - 1, 14, 3, 1, '#ffb347');
  // call buttons
  rect(ctx, x + 32, 26, 3, 6, C.metalDark);
  rect(ctx, x + 33, 27, 1, 1, '#ffd36a');
  rect(ctx, x + 33, 30, 1, 1, '#ffd36a');
}

function drawSignPlate(ctx: CanvasRenderingContext2D): void {
  const r = signRect;
  rect(ctx, r.x + 1, r.y + r.h, r.w, 1, withAlpha(OUTLINE, 0.3));
  rect(ctx, r.x, r.y, r.w, r.h, C.signPlateEdge);
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, C.signPlate);
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, 1, C.signPlateLight);
  rect(ctx, r.x + 2, r.y + r.h - 2, r.w - 4, 1, C.signPlateShade);
  // bolts
  for (const bx of [r.x + 2, r.x + r.w - 3]) rect(ctx, bx, r.y + 2, 1, 1, C.metalLight);
}

function drawWhiteboard(ctx: CanvasRenderingContext2D): void {
  const r = whiteboardRect;
  rect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 7, C.metalDark);
  rect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, C.metalLight);
  rect(ctx, r.x, r.y, r.w, r.h, '#fbfbf7');
  rect(ctx, r.x, r.y, r.w, 1, '#ffffff');
  // faint ghost scribbles from old meetings
  rect(ctx, r.x + 4, r.y + 4, 14, 1, '#e3e6ea');
  rect(ctx, r.x + 4, r.y + 7, 10, 1, '#e3e6ea');
  rect(ctx, r.x + 34, r.y + 10, 16, 1, '#ece4e4');
  // tray with markers
  rect(ctx, r.x - 2, r.y + r.h + 2, r.w + 4, 2, C.metal);
  rect(ctx, r.x + 6, r.y + r.h + 1, 4, 1, C.blue);
  rect(ctx, r.x + 12, r.y + r.h + 1, 4, 1, C.red);
  rect(ctx, r.x + 18, r.y + r.h + 1, 4, 1, C.black);
}

function drawClockFace(ctx: CanvasRenderingContext2D): void {
  const { x, y, r } = clockAnchor;
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r - 0.5) rect(ctx, x + dx, y + dy, 1, 1, '#fbf8ee');
      else if (d <= r + 0.7) rect(ctx, x + dx, y + dy, 1, 1, C.charcoal);
    }
  }
  for (let i = 0; i < 12; i += 3) {
    const a = (i / 12) * Math.PI * 2;
    rect(ctx, Math.round(x + Math.sin(a) * (r - 2)), Math.round(y - Math.cos(a) * (r - 2)), 1, 1, C.metalDark);
  }
}

/** Draws clock hands for `date` on the wall clock. (ox, oy) = map origin on the target context. */
export function drawClockHands(ctx: CanvasRenderingContext2D, date: Date, ox = 0, oy = 0): void {
  const { x, y, r } = clockAnchor;
  const h = (date.getHours() % 12) + date.getMinutes() / 60;
  const m = date.getMinutes() + date.getSeconds() / 60;
  const hand = (ang: number, len: number, col: string): void => {
    for (let i = 0; i <= len; i += 0.5) {
      rect(ctx, ox + Math.round(x + Math.sin(ang) * i), oy + Math.round(y - Math.cos(ang) * i), 1, 1, col);
    }
  };
  hand((m / 60) * Math.PI * 2, r - 2, C.charcoal);
  hand((h / 12) * Math.PI * 2, r - 4, C.black);
  rect(ctx, ox + x, oy + y, 1, 1, C.red);
}

/**
 * Draws the company name (top, brighter) and branch (below, dimmer) centred on
 * the sign plate. With an empty or missing branch the company is drawn alone,
 * vertically centred. (ox, oy) = map origin on the target context. Colours
 * come from `C` (`signText`, `signBranch`, `signTextShadow`) unless `color` is given.
 */
export function drawSignText(
  ctx: CanvasRenderingContext2D, company: string, branch = '', ox = 0, oy = 0, color: string = C.signText,
): void {
  const r = signTextRect;
  const line = (text: string, y: number, col: string): void => {
    const t = fitPixelText(text, r.w);
    const m = measurePixelText(t);
    drawPixelText(ctx, t, ox + r.x + Math.floor((r.w - m.w) / 2), oy + y, col, 1, C.signTextShadow);
  };
  if (branch.trim()) {
    line(company, signCompanyRect.y, color);
    line(branch, signBranchRect.y, C.signBranch);
  } else {
    line(company, r.y + Math.floor((r.h - 5) / 2), color);
  }
}

function drawWallDecor(ctx: CanvasRenderingContext2D): void {
  drawElevator(ctx);
  drawSignPlate(ctx);
  drawWhiteboard(ctx);
  // bullpen windows
  for (const cx of [290, 326, 398, 434]) drawWindow(ctx, cx, 26, 0.35 + hash(cx, 1) * 0.3);
  drawClockFace(ctx);
  ctx.drawImage(F.calendarSprite(null, 'unknown'), calendarRect.x, calendarRect.y);
  // conference room: small framed photo of the branch softball team
  rect(ctx, 236, 18, 14, 11, C.darkWood);
  rect(ctx, 237, 19, 12, 9, '#7aa7c7');
  rect(ctx, 237, 24, 12, 4, '#6a9a54');
  for (let i = 0; i < 4; i++) rect(ctx, 238 + i * 3, 22, 2, 3, ['#e8c9a0', '#c48f62', '#e8c9a0', '#8a5a3a'][i]!);
  // manager's office: window, framed diploma, trophy shelf
  drawWindow(ctx, 494, 28, 0.55);
  rect(ctx, 520, 15, 14, 11, C.goldDark);
  rect(ctx, 521, 16, 12, 9, '#f4efe0');
  rect(ctx, 523, 18, 8, 1, C.metalDark);
  rect(ctx, 523, 20, 6, 1, C.paperLine);
  rect(ctx, 526, 23, 2, 1, C.red);
  rect(ctx, 516, 33, 40, 2, C.darkWood);
  rect(ctx, 516, 33, 40, 1, C.darkWoodLight);
  for (const [tx, th] of [[520, 6], [532, 8], [545, 5]] as const) {
    rect(ctx, tx, 33 - th, 5, th - 2, C.gold);
    rect(ctx, tx + 1, 33 - th, 1, th - 3, C.goldLight);
    rect(ctx, tx + 1, 31, 3, 2, C.darkWoodEdge);
    rect(ctx, tx - 1, 33 - th, 1, 2, C.gold);
    rect(ctx, tx + 5, 33 - th, 1, 2, C.gold);
  }
  // kitchen: upper cabinets and a notice board
  rect(ctx, 590, 13, 52, 17, C.woodEdge);
  for (const x of [591, 608, 625]) {
    rect(ctx, x, 14, 16, 15, C.wood);
    rect(ctx, x + 1, 15, 14, 13, C.woodLight);
    rect(ctx, x + 2, 16, 12, 11, C.wood);
    rect(ctx, x + 12, 24, 1, 3, C.metalLight);
  }
  rect(ctx, 590, 30, 52, 1, withAlpha(OUTLINE, 0.25));
  rect(ctx, 648, 16, 24, 18, C.woodEdge);
  rect(ctx, 649, 17, 22, 16, '#b88a58');
  rect(ctx, 651, 19, 7, 8, C.paper);
  rect(ctx, 652, 21, 5, 1, C.paperLine);
  rect(ctx, 652, 23, 4, 1, C.paperLine);
  rect(ctx, 660, 18, 8, 6, '#f2e58a');
  rect(ctx, 661, 26, 8, 6, '#f6c8d2');
  rect(ctx, 654, 19, 1, 1, C.red);
  rect(ctx, 663, 18, 1, 1, C.blue);
}

function drawOuterWalls(ctx: CanvasRenderingContext2D): void {
  const H = MAP_PX_H;
  const W = MAP_PX_W;
  // side walls: outside + cap strip
  for (const left of [true, false]) {
    const x0 = left ? 0 : W - TILE;
    rect(ctx, x0, 0, TILE, H, C.outside);
    const capX = left ? x0 + TILE - 6 : x0;
    rect(ctx, capX, 0, 6, H - 10, C.wallCap);
    rect(ctx, capX + 1, 0, 4, H - 10, C.wallCapLight);
    rect(ctx, left ? capX : capX + 5, 0, 1, H - 10, mix(C.wallCap, OUTLINE, 0.3));
  }
  // bottom wall: cap strip and outside
  rect(ctx, 0, H - TILE, W, TILE, C.outside);
  rect(ctx, 0, H - TILE, W, 6, C.wallCap);
  rect(ctx, 0, H - TILE + 1, W, 3, C.wallCapLight);
  rect(ctx, 0, H - TILE + 5, W, 1, mix(C.wallCap, OUTLINE, 0.4));
  // re-cover the top wall's sides so the face reads continuous
  rect(ctx, 0, 0, TILE - 6, 48, C.outside);
  rect(ctx, W - TILE + 6, 0, TILE - 6, 48, C.outside);
}

let bgCache: HTMLCanvasElement | null = null;

/**
 * Renders (once) and returns the static background: floors, the top wall with
 * ceiling, windows, elevator, blank sign plate, clock face (no hands),
 * whiteboard, kitchen cabinets and trophies, and the outer walls. Interior
 * walls, glass and doors are furniture items so they depth-sort.
 */
export function renderBackground(): HTMLCanvasElement {
  if (bgCache) return bgCache;
  const c = makeCanvas(MAP_PX_W, MAP_PX_H);
  const ctx = ctx2d(c);
  for (let ty = 3; ty < MAP_H - 1; ty++) for (let tx = 1; tx < MAP_W - 1; tx++) drawFloorTile(ctx, tx, ty, floorKind(tx, ty));
  // manager's rug
  rect(ctx, 30 * TILE + 2, 4 * TILE + 4, 5 * TILE - 4, 4 * TILE - 6, C.rugBorder);
  rect(ctx, 30 * TILE + 4, 4 * TILE + 6, 5 * TILE - 8, 4 * TILE - 10, C.rug);
  rect(ctx, 30 * TILE + 6, 4 * TILE + 8, 5 * TILE - 12, 4 * TILE - 14, mix(C.rug, C.rugBorder, 0.25));
  rect(ctx, 30 * TILE + 8, 4 * TILE + 10, 5 * TILE - 16, 4 * TILE - 18, C.rug);
  // kitchen mat by the counter
  rect(ctx, 37 * TILE + 4, 4 * TILE + 3, 40, 9, '#6b5a7a');
  rect(ctx, 37 * TILE + 5, 4 * TILE + 4, 38, 7, '#7d6b8c');
  // threshold strips in doorways
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    const ch = planAt(tx, ty);
    if (ch === 'D') rect(ctx, tx * TILE + 1, ty * TILE + 13, 14, 3, C.metal);
    if (ch === 'd') rect(ctx, tx * TILE + 13, ty * TILE + 1, 3, 14, C.metal);
  }
  drawTopWall(ctx);
  drawWallDecor(ctx);
  // shadow cast by the top wall onto the floor
  for (let i = 0; i < 4; i++) rect(ctx, 0, 48 + i, MAP_PX_W, 1, withAlpha(OUTLINE, 0.22 - i * 0.05));
  drawOuterWalls(ctx);
  bgCache = c;
  return c;
}
