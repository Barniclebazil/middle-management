/**
 * Character sprites: every look x pose x direction x frame, composed from
 * layered pixel parts (legs, torso, arms, hand-drawn head, held items), given
 * a selective outline and rasterised lazily into cached 16x28 canvases.
 *
 * Coordinates: a frame is CHAR_W x (CHAR_HEADROOM + CHAR_H) pixels: the body
 * is laid out on a CHAR_H grid, with CHAR_HEADROOM spare rows above it for the
 * tall build's head and the walk bob. Its anchor is the feet: pixel
 * (CHAR_ANCHOR_X, CHAR_ANCHOR_Y) = (8, 28), i.e. the bottom-centre.
 * To draw a character whose feet are at map pixel (fx, fy), blit the frame at
 * (fx - 8, fy - 28). For a seated character the "feet" are the bottom-centre
 * of the seat tile (see `office-map.ts` seats).
 */
import { OUTLINE, PROP_PAL, C } from './palette.ts';
import type { Palette } from './raster.ts';
import { PixelGrid } from './raster.ts';
import {
  CLEANER_LOOK, DEZ_LOOK, FENWICK_LOOK, LOOKS, LOOK_COLOUR_FIELDS, MANAGER_LOOK, NPC_LOOKS, STAFF_SLOT_IDS, TEMP_SLOT_IDS, VENDOR_LOOK,
  buildLook, defaultSlotLook,
} from './looks.ts';
import type { Build, LookDef, LookId, TorsoStyle } from './looks.ts';
import type { LookSpec } from '../../src/shared/theme.ts';

export {
  ARCHETYPES, TEMP_LOOKS, ALL_LOOKS, LOOKS, MANAGER_LOOK, RECEPTIONIST_LOOK, STAFF_SLOT_IDS, TEMP_SLOT_IDS, HEAD_SETS, buildLook,
  defaultSlotLook, specOfDef, specOfLook, builtinLookIdOf, builtinSpecOf, LOOK_COLOUR_FIELDS,
  CLEANER_LOOK, VENDOR_LOOK, DEZ_LOOK, FENWICK_LOOK, IT_SUPPORT_ROLE, NPC_LOOKS, NPC_LOOK_IDS,
} from './looks.ts';
export type { ArchetypeId, TempLookId, LookId, LookDef, HeadSet, LookSpecLike } from './looks.ts';

/** Frame width in pixels. */
export const CHAR_W = 16;
/** Height of the body grid in pixels (head top to feet for a normal build). */
export const CHAR_H = 24;
/** Spare rows above the body grid, so a tall head or a walk bob is not cut off. */
export const CHAR_HEADROOM = 4;
/** Anchor (feet) x inside a frame. */
export const CHAR_ANCHOR_X = 8;
/** Anchor (feet) y inside a frame: the bottom edge. */
export const CHAR_ANCHOR_Y = CHAR_HEADROOM + CHAR_H;
/** Recommended walking speed in map pixels per second (about 2.25 tiles/s). */
export const WALK_SPEED_PX_PER_S = 36;

/** Facing direction. `down` faces the camera. */
export type Dir = 'down' | 'up' | 'left' | 'right';
/** All directions. */
export const DIRS: readonly Dir[] = ['down', 'up', 'left', 'right'];

/** Every animation. */
export type Pose =
  | 'stand' | 'walk'
  | 'sitIdle' | 'sitType' | 'sitRead' | 'sitThink' | 'sitRun' | 'sitPhone'
  | 'mugSip' | 'chairSpin' | 'deskSip'
  | 'rummage' | 'draw' | 'whiteboard' | 'copierWait' | 'knock' | 'wave' | 'point' | 'talk' | 'shred'
  | 'wipe' | 'pickFood' | 'pushCart'
  | 'fixPc' | 'scoff' | 'readCard';

/** The IT pair, who alone have art for fixPc, scoff and readCard. */
const IT_LOOKS: readonly LookId[] = [DEZ_LOOK, FENWICK_LOOK];

/** Static facts about a pose. */
export interface PoseInfo {
  /** Number of frames. */
  frames: number;
  /** Recommended duration of each frame in ms (length = frames). */
  durations: readonly number[];
  /** Directions with real art. Others fall back to `dirs[0]`. */
  dirs: readonly Dir[];
  /** Seated at a desk: anchor is the seat tile, draw between desk top and desk front. */
  seated: boolean;
  /** Only the manager has art for this pose (same as `onlyLooks` being `[MANAGER_LOOK]`); kept for callers that ask just that. */
  managerOnly: boolean;
  /** The looks with art for this pose; any other look draws `fallback` instead (see `poseForLook`). Absent: every look. */
  onlyLooks?: readonly LookId[];
  /** What a look outside `onlyLooks` draws: `sitIdle` for seated poses, a standing pose otherwise. */
  fallback?: Pose;
}

/** Frame counts, durations and supported directions per pose. */
export const POSES: Readonly<Record<Pose, PoseInfo>> = {
  stand: { frames: 2, durations: [2600, 140], dirs: ['down', 'up', 'left', 'right'], seated: false, managerOnly: false },
  walk: { frames: 4, durations: [140, 140, 140, 140], dirs: ['down', 'up', 'left', 'right'], seated: false, managerOnly: false },
  sitIdle: { frames: 2, durations: [3000, 140], dirs: ['down'], seated: true, managerOnly: false },
  sitType: { frames: 4, durations: [90, 90, 90, 90], dirs: ['down'], seated: true, managerOnly: false },
  sitRead: { frames: 3, durations: [1500, 1500, 140], dirs: ['down'], seated: true, managerOnly: false },
  sitThink: { frames: 2, durations: [2200, 150], dirs: ['down'], seated: true, managerOnly: false },
  sitRun: { frames: 4, durations: [80, 80, 80, 80], dirs: ['down'], seated: true, managerOnly: false },
  // on the phone: listens (with a blink), then talks for a few mouth flaps
  sitPhone: { frames: 6, durations: [1500, 140, 700, 200, 160, 220], dirs: ['down'], seated: true, managerOnly: false },
  mugSip: { frames: 4, durations: [1400, 350, 1100, 350], dirs: ['down'], seated: true, managerOnly: true, onlyLooks: [MANAGER_LOOK], fallback: 'sitIdle' },
  chairSpin: { frames: 4, durations: [160, 160, 160, 160], dirs: ['down'], seated: true, managerOnly: true, onlyLooks: [MANAGER_LOOK], fallback: 'sitIdle' },
  // any look at its desk: mug on the desk, lifted, sipped (eyes shut), lowered. The engine may play it up to ~1.8x faster
  // by scaling the elapsed time it passes to frameAt.
  deskSip: { frames: 4, durations: [900, 240, 1000, 240], dirs: ['down'], seated: true, managerOnly: false },
  rummage: { frames: 4, durations: [320, 320, 900, 320], dirs: ['up'], seated: false, managerOnly: false },
  draw: { frames: 4, durations: [260, 260, 260, 260], dirs: ['up'], seated: false, managerOnly: false },
  whiteboard: { frames: 4, durations: [220, 220, 220, 220], dirs: ['up'], seated: false, managerOnly: false },
  copierWait: { frames: 4, durations: [300, 300, 300, 300], dirs: ['down', 'left', 'right'], seated: false, managerOnly: false },
  knock: { frames: 4, durations: [500, 110, 110, 110], dirs: ['up'], seated: false, managerOnly: false },
  wave: { frames: 2, durations: [260, 260], dirs: ['down'], seated: false, managerOnly: false },
  point: { frames: 2, durations: [700, 300], dirs: ['left', 'right', 'down'], seated: false, managerOnly: false },
  talk: { frames: 4, durations: [200, 200, 200, 200], dirs: ['down', 'left', 'right'], seated: false, managerOnly: false },
  shred: { frames: 3, durations: [450, 450, 450], dirs: ['up'], seated: false, managerOnly: false },
  // the cleaner beside a desk (left/right: a staff desk's visit tile) or in front of one (up: a temp desk's visit tile):
  // a squirt of spray, then the cloth sweeps out and back
  wipe: { frames: 6, durations: [520, 200, 200, 200, 200, 200], dirs: ['left', 'right', 'down', 'up'], seated: false, managerOnly: false, onlyLooks: [CLEANER_LOOK], fallback: 'stand' },
  // the manager at the food cart: reaches, takes the item (see FoodId), lifts it and holds it up, delighted
  pickFood: { frames: 4, durations: [380, 260, 300, 1200], dirs: ['down', 'left', 'right'], seated: false, managerOnly: true, onlyLooks: [MANAGER_LOOK], fallback: 'stand' },
  // the vendor walking behind the food cart, both hands on its handle (same step timing as walk)
  pushCart: { frames: 4, durations: [140, 140, 140, 140], dirs: ['down', 'up', 'left', 'right'], seated: false, managerOnly: false, onlyLooks: [VENDOR_LOOK], fallback: 'walk' },
  // the IT pair "fixing" a computer from beside its desk: leaning in, one hand tapping at the keyboard
  fixPc: { frames: 4, durations: [260, 140, 260, 140], dirs: ['left', 'right', 'down', 'up'], seated: false, managerOnly: false, onlyLooks: IT_LOOKS, fallback: 'stand' },
  // arms folded, a small disapproving shake of the head
  scoff: { frames: 4, durations: [1100, 170, 170, 170], dirs: ['left', 'right', 'down', 'up'], seated: false, managerOnly: false, onlyLooks: IT_LOOKS, fallback: 'stand' },
  // reading a line off a little white crib card held at the chest, mouth moving as in talk; looks up on the last frame
  readCard: { frames: 4, durations: [220, 200, 220, 360], dirs: ['left', 'right', 'down', 'up'], seated: false, managerOnly: false, onlyLooks: IT_LOOKS, fallback: 'talk' },
};

/** Every pose name. */
export const ALL_POSES = Object.keys(POSES) as Pose[];

/** Total cycle length of a pose in ms. */
export function poseCycleMs(pose: Pose): number {
  return POSES[pose].durations.reduce((a, b) => a + b, 0);
}

/** The frame index to show `elapsedMs` after a pose started (loops). */
export function frameAt(pose: Pose, elapsedMs: number): number {
  const d = POSES[pose].durations;
  const total = poseCycleMs(pose);
  let t = ((elapsedMs % total) + total) % total;
  for (let i = 0; i < d.length; i++) {
    if (t < d[i]!) return i;
    t -= d[i]!;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Builds

interface BuildInfo { shoulder: number; torsoRows: number; legRows: number; wide: boolean }

const BUILDS: Readonly<Record<Build, BuildInfo>> = {
  normal: { shoulder: 11, torsoRows: 6, legRows: 4, wide: false },
  tall: { shoulder: 9, torsoRows: 7, legRows: 5, wide: false },
  small: { shoulder: 13, torsoRows: 5, legRows: 3, wide: false },
  big: { shoulder: 11, torsoRows: 6, legRows: 4, wide: true },
};

/** Rows added to the shoulder line when seated. */
const SEAT_DROP = 3;
/** First body-grid row (frame row minus CHAR_HEADROOM) hidden by the desk top's far edge when seated. */
export const SEAT_CUT_ROW = 19;

// ---------------------------------------------------------------------------
// Torso templates (6 wide x 6 tall, front view)

const TORSO_FRONT: Readonly<Record<TorsoStyle, readonly string[]>> = {
  suit: ['jcnncj', 'jtnntj', 'jjnnjj', 'jjNNjj', 'jjjujj', 'JJJJJJ'],
  shirtTie: ['tcnnct', 'ttnntt', 'ttnntt', 'ttnNtt', 'ttNNtt', 'TTTTTT'],
  looseTie: ['jcttcj', 'jtnntj', 'jtnntj', 'jttNtj', 'jtttTj', 'JTTTTJ'],
  cardigan: ['jcttcj', 'jttttj', 'jttttj', 'jjttjj', 'jjttjj', 'JJTTJJ'],
  openCardigan: ['jcttcj', 'jttttj', 'jttttj', 'jjttjj', 'jjttjj', 'JJTTJJ'],
  buttonCardigan: ['jccccj', 'jjujjj', 'jjjjjj', 'jjujjj', 'jjjjjj', 'JJJJJJ'],
  vest: ['tcnnct', 'jtnntj', 'jjnnjj', 'jjNNjj', 'jxjjxj', 'JJJJJJ'],
  floral: ['tcxXct', 'txttXt', 'tXtxtt', 'ttxtXt', 'txtttx', 'TTXTTT'],
  plain: ['tccccT', 'tttttt', 'tttttt', 'tttttt', 'tttttT', 'TTTTTT'],
  polo: ['tcttct', 'tttutt', 'tttttt', 'tttttt', 'tttttT', 'TTTTTT'],
  blouse: ['tcttct', 'tttttt', 'tttttt', 'tttttt', 'tttttT', 'TTTTTT'],
  // the cleaner's tabard (j) over a shirt (t) showing at the sides, V-neck (c), a big front pocket (X)
  tabard: ['tjccjt', 'tjjjjt', 'tjjjjt', 'tjXXjt', 'tjXXjt', 'TJJJJT'],
  // the vendor's white bib apron (j) over a shirt (t), neck strap, waist tie (x); the skirt rows carry it on down
  apron: ['tjttjt', 'tjjjjt', 'tjjjjt', 'tjjjjt', 'xxxxxx', 'TjjjjT'],
  // a dark T-shirt (crew neck in the collar colour) with a little pale space-ship on the chest (x)
  tee: ['ttcctt', 'tttxtt', 'ttxxxt', 'ttxtxt', 'tttttT', 'TTTTTT'],
  // a short-sleeved shirt and tie, two pens (x, X) in the breast pocket
  pocketTie: ['tcnnct', 'ttnnxX', 'ttnnTt', 'ttnNtt', 'ttNNtt', 'TTTTTT'],
};

function torsoBack(style: TorsoStyle): readonly string[] {
  if (style === 'floral') return ['txttXt', 'tXtxtt', 'ttxtXt', 'txtttx', 'tXttxt', 'TTXTTT'];
  if (style === 'tabard') return ['tjjjjt', 'tjjjjt', 'tjjjjt', 'txxxxt', 'tjjjjt', 'TJJJJT'];
  if (style === 'apron') return ['tjttjt', 'tjttjt', 'tjttjt', 'tjttjt', 'xxxxxx', 'TTTTTT'];
  return ['jjjjjj', 'jjjjjj', 'jjjjjj', 'jjjjjj', 'jjjjjj', 'JJJJJJ'];
}

function torsoSide(style: TorsoStyle): readonly string[] {
  switch (style) {
    case 'suit':
    case 'vest': return ['cjjjj', 'njjjj', 'njjjj', 'Njjjj', 'jjjjj', 'JJJJJ'];
    case 'shirtTie':
    case 'pocketTie': return ['ctttt', 'ntttt', 'ntttt', 'Ntttt', 'ttttt', 'TTTTT'];
    case 'looseTie': return ['tjjjj', 'njjjj', 'tjjjj', 'tjjjj', 'tjjjj', 'TJJJJ'];
    case 'cardigan':
    case 'openCardigan': return ['tjjjj', 'tjjjj', 'tjjjj', 'tjjjj', 'tjjjj', 'TJJJJ'];
    case 'floral': return ['txtXt', 'tttxt', 'tXttt', 'ttxtX', 'txttt', 'TTXTT'];
    case 'tabard': return ['jcttj', 'jtttj', 'jtttj', 'jxxxj', 'jtttj', 'JTTTJ'];
    case 'apron': return ['jtttt', 'jtttt', 'jtttt', 'jtttt', 'xxxxx', 'jTTTT'];
    default: return ['cjjjj', 'jjjjj', 'jjjjj', 'jjjjj', 'jjjjj', 'JJJJJ'];
  }
}

/** Adjusts a 6-row template to the build's torso height and width. */
function fitTorso(rows: readonly string[], b: BuildInfo, side: boolean): string[] {
  let r = rows.slice();
  if (b.torsoRows === 7) r = [...r.slice(0, 3), r[3]!, ...r.slice(3)];
  else if (b.torsoRows === 5) r = [...r.slice(0, 3), ...r.slice(4)];
  if (b.wide) {
    const idx = side ? [0, 1, 2, 2, 3, 4] : [0, 1, 1, 2, 3, 4, 4, 5];
    r = r.map((row) => idx.map((i) => row[i] ?? '.').join(''));
  }
  return r;
}

// ---------------------------------------------------------------------------
// Legs (authored for 4 leg rows + 2 shoe rows; adapted per build)

const LEGS_FRONT = [
  '.....pppppp.....',
  '.....pp..pp.....',
  '.....pp..pp.....',
  '.....pP..Pp.....',
  '.....ff..ff.....',
  '....fFf..fFf....',
];
const LEGS_FRONT_STEP_L = [
  '.....pppppp.....',
  '.....pp..pp.....',
  '.....pP..pp.....',
  '.....ff..Pp.....',
  '....fFf..ff.....',
  '.........fFf....',
];
const LEGS_FRONT_TAP = [
  '.....pppppp.....',
  '.....pp..pp.....',
  '.....pp..pp.....',
  '.....pP..Pp.....',
  '.....ff..fff....',
  '....fFf..F......',
];
const SKIRT_FRONT = [
  '....pppppppp....',
  '....PpppppPP....',
  '.....gg..gg.....',
  '.....gg..gg.....',
  '.....ff..ff.....',
  '....fFf..fFf....',
];
const SKIRT_FRONT_STEP_L = [
  '....pppppppp....',
  '....PpppppPP....',
  '.....gg..gg.....',
  '.....ff..gg.....',
  '....fFf..ff.....',
  '.........fFf....',
];
const SKIRT_FRONT_TAP = [
  '....pppppppp....',
  '....PpppppPP....',
  '.....gg..gg.....',
  '.....gg..gg.....',
  '.....ff..fff....',
  '....fFf..F......',
];
const LEGS_SIDE = [
  '......pppp......',
  '......pppP......',
  '......pppP......',
  '......pppP......',
  '......fff.......',
  '.....fffF.......',
];
const LEGS_SIDE_A = [
  '......pppp......',
  '.....ppPPP......',
  '....pp...PP.....',
  '....pp....PP....',
  '...fff....FFF...',
  '..fffF..........',
];
const LEGS_SIDE_B = [
  '......pppp......',
  '.....PPppp......',
  '....PP...pp.....',
  '....PP....pp....',
  '...FFF....fff...',
  '..FFFF..........',
];
const LEGS_SIDE_TAP = [
  '......pppp......',
  '......pppP......',
  '......pppP......',
  '......pppP......',
  '.....ffff.......',
  '......ffF.......',
];
const SKIRT_SIDE = [
  '.....ppppp......',
  '.....pppppP.....',
  '......gg........',
  '......gg........',
  '......ff........',
  '.....fffF.......',
];
const SKIRT_SIDE_A = [
  '.....ppppp......',
  '.....pppppP.....',
  '.....g...g......',
  '....gg....g.....',
  '...fff....fF....',
  '..fffF..........',
];
const SKIRT_SIDE_B = [
  '.....ppppp......',
  '.....pppppP.....',
  '.....g...g......',
  '....g.....gg....',
  '...fF.....fff...',
  '..fF............',
];
const SKIRT_SIDE_TAP = [
  '.....ppppp......',
  '.....pppppP.....',
  '......gg........',
  '......gg........',
  '.....fff........',
  '......fF........',
];

type LegKind = 'stand' | 'stepL' | 'stepR' | 'tap' | 'sideA' | 'sideB';

function mirrorRow(row: string): string {
  return row.split('').reverse().join('');
}

function legBlock(look: LookDef, view: View, kind: LegKind): string[] {
  const sk = look.skirt;
  let rows: readonly string[];
  if (view === 'side') {
    rows = kind === 'sideA' ? (sk ? SKIRT_SIDE_A : LEGS_SIDE_A)
      : kind === 'sideB' ? (sk ? SKIRT_SIDE_B : LEGS_SIDE_B)
        : kind === 'tap' ? (sk ? SKIRT_SIDE_TAP : LEGS_SIDE_TAP)
          : (sk ? SKIRT_SIDE : LEGS_SIDE);
  } else {
    if (kind === 'stepL') rows = sk ? SKIRT_FRONT_STEP_L : LEGS_FRONT_STEP_L;
    else if (kind === 'stepR') rows = (sk ? SKIRT_FRONT_STEP_L : LEGS_FRONT_STEP_L).map(mirrorRow);
    else if (kind === 'tap') rows = sk ? SKIRT_FRONT_TAP : LEGS_FRONT_TAP;
    else rows = sk ? SKIRT_FRONT : LEGS_FRONT;
  }
  const b = BUILDS[look.build];
  let r = rows.slice();
  if (b.legRows === 5) r = [r[0]!, r[1]!, ...r.slice(1)];
  else if (b.legRows === 3) r = [r[0]!, ...r.slice(2)];
  if (b.wide && view !== 'side') r = r.map(widenHalves);
  return r;
}

/** Shifts the left half one pixel left and the right half one pixel right (wide builds). */
function widenHalves(row: string): string {
  const out = new Array<string>(16).fill('.');
  for (let x = 0; x < 16; x++) {
    const k = row[x] ?? '.';
    if (k === '.') continue;
    if (x < 8) { if (x - 1 >= 0) out[x - 1] = k; } else if (x + 1 < 16) out[x + 1] = k;
  }
  if ((row[7] ?? '.') !== '.' && (row[8] ?? '.') !== '.') { out[7] = row[7]!; out[8] = row[8]!; }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Arms. Strings are 16 wide. `rel` arms are positioned relative to the
// shoulder row; `abs` arms use absolute frame rows (for seated poses whose
// hands must land on the desk regardless of build).

interface Arms { rows: readonly string[]; y: number; abs: boolean }

function arms(left: readonly string[], right: readonly string[] | null, y: number, abs: boolean): Arms {
  const n = Math.max(left.length, right ? right.length : left.length);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = (left[i] ?? '........').padEnd(8, '.');
    const r = right ? mirrorRow((right[i] ?? '........').padEnd(8, '.')) : '........';
    rows.push(l + r);
  }
  return { rows, y, abs };
}

// Standing, front/back (relative: row 0 = shoulder line)
const A_HANG = ['....a...', '...aa...', '...aA...', '...ll...', '...ll...', '...ss...'];
const A_HANG_UP = ['....a...', '...aa...', '...aA...', '...ll...', '...ss...'];
const A_CROSSED: Arms = { rows: ['....a......a....', '...aa......aa...', '...aA......Aa...', '...alllllllsa...', '...asLLLLLLLa...'], y: 0, abs: false };
const A_WAVE_A = ['.s......', '.l......', '.l......', '.la.....', '..aa....', '...aa...'];
const A_WAVE_B = ['s.......', '.l......', '.l......', '.la.....', '..aa....', '...aa...'];
const A_POINT_F = ['sllaaa..'];
const A_POINT_F2 = ['.sllaa..'];
const A_TALK_UP = ['....a...', '...aa...', '...aA...', '...al...', '....ls..', '........'];
const A_REACH_BACK = ['....a...', '...aa...', '...aa...', '....aa..', '........', '........'];
// relative rows start ABOVE the shoulder for raised arms: y offset is negative.
const A_RAISE_HIGH = ['..s.....', '..l.....', '..l.....', '..la....', '..aa....', '...a....', '...aa...', '...aa...'];
const A_RAISE_MID = ['........', '........', '.s......', '.l......', '.la.....', '..aa....', '...aa...', '...aa...'];
const A_RAISE_WIDE = ['........', '........', '........', '........', 's.......', 'lla.....', '..aa....', '...aa...'];
const A_KNOCK = ['........', '..s.....', '..l.....', '..la....', '..aa....', '...a....', '...aa...', '...aa...'];
const A_KNOCK_HIT = ['........', '........', '...s....', '..ll....', '..aa....', '...a....', '...aa...', '...aa...'];

// Side view (facing left), near arm over the torso.
const S_HANG = ['......aa........', '......aa........', '......aA........', '......ll........', '......ll........', '......ss........'];
const S_SWING_BACK = ['......aa........', '......aa........', '......aa........', '.......ll.......', '........ll......', '.........ss.....'];
const S_SWING_FWD = ['......aa........', '......aa........', '.....aa.........', '....ll..........', '...ll...........', '..ss............'];
const S_CROSS = ['......aa........', '......aa........', '......aa........', '....slll........', '................', '................'];
const S_POINT = ['......aa........', 'sslllaaa........', '................', '................', '................', '................'];
const S_POINT_JAB = ['......aa........', '.sslllaa........', '................', '................', '................', '................'];
const S_TALK = ['......aa........', '......aa........', '......aa........', '.....ll.........', '....ls..........', '................'];

// Seated, absolute rows starting at frame row 12.
const SA = 12;
const L_REST = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...ll...', '....ll..', '.....ll.', '.....ss.'];
const L_TYPE_UP = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...ll...', '....ll..', '.....ss.', '........'];
const L_POUND = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...all..', '....ls..', '....ss..', '........', '........'];
const L_SLAM = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...ll...', '....ll..', '....lss.', '....sss.'];
const L_HOLD = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...ls...', '........', '........', '........'];
const L_MUG_DESK = ['...aa...', '...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...ll...', '....ll..', '.....ls.', '......s.'];
const L_MUG_CHEST = ['...aa...', '...aa...', '...aa...', '...aa...', '...al...', '...lls..', '....ss..', '........', '........', '........'];
const L_MUG_MOUTH = ['...s....', '..ll....', '..laa...', '..aa....', '..a.....'];
// hands behind the head: drawn behind the head, rows start at frame row 6
const L_BEHIND_HEAD = ['.aaa....', 'aaaa....', 'aa.aa...', '.a..aa..', '....aa..', '...aa...'];
// on the phone: the near hand holds the receiver to the ear (relative rows from 6 above the shoulder),
// the elbow tucked in; drawn over the head and the receiver
const L_PHONE = ['........', '........', '.ss.....', '.ss.....', '.ll.....', '.ll.....', '.ll.a...', '.lLaa...', '..Laa...'];
// pushing the food cart: both hands forward on the handle at the waist (front view) / the near arm out ahead (side view)
const A_PUSH_F = ['....a...', '...aa...', '...aA...', '....al..', '.....l..', '.....s..'];
const S_PUSH = ['......aa........', '......aa........', '.....aa.........', '...llla.........', '..ss............', '................'];
// picking food off the cart: reach forward and down, lift to the chest, hold it up by the face
const A_REACH_F = ['....a...', '...aa...', '...aA...', '....al..', '.....l..', '.....ls.'];
const A_FOOD_UP = ['........', '..s.....', '..l.....', '..la....', '...aa...', '...aa...', '...aA...'];
const S_REACH = ['......aa........', '......aa........', '.....aa.........', '....ll..........', '...ll...........', '..ss............'];
const S_LIFT = ['......aa........', '......aa........', '......aa........', '.....ll.........', '....ls..........', '................'];
// held up in front of the face, clear of it: the forearm rises just ahead of the nose (rows from 9 above the shoulder)
const S_FOOD_UP = [
  '..ss............', '..l.............', '..l.............', '..l.............', '..l.............', '..l.............',
  '..la............', '...aa...........', '....aa..........', '.....aaa........', '......aa........', '......aa........',
];
// wiping a desk: spray held out at the chest, then the cloth hand sweeps out and back (side view) or across (front view)
const S_SPRAY = ['......aa........', '......aa........', '....llaa........', '....s...........', '................', '................'];
const S_WIPE_FAR = ['......aa........', '......aa........', '.....aa.........', '....ll..........', '..lll...........', '..ss............'];
const S_WIPE_NEAR = ['......aa........', '......aa........', '......aa........', '.....la.........', '....ll..........', '....ss..........'];
const A_SPRAY_F = ['....a...', '...aa...', '...aA...', '...al...', '....ls..', '........'];
const A_WIPE_OUT = ['....a...', '...aa...', '..aaA...', '..l.....', '.ll.....', '.ss.....'];
const A_WIPE_IN = ['....a...', '...aa...', '...aA...', '....al..', '.....ll.', '......ss'];
// fixing a PC: the hand reaching for the keyboard, down on a key and lifted between taps (side view, and front view
// where the keyboard is in front of him), both hands over the keys beyond his shoulders (back view; rows from 2 above)
const S_TAP_DOWN = ['......aa........', '......aa........', '.....aa.........', '....ll..........', '..lll...........', '..ss............'];
const S_TAP_UP = ['......aa........', '......aa........', '.....aa.........', '...lll..........', '..ss............', '................'];
const A_TAP_DOWN = ['....a...', '...aa...', '...aA...', '....al..', '.....l..', '.....ls.'];
const A_TAP_UP = ['....a...', '...aa...', '...aA...', '....al..', '.....ls.', '........'];
const A_KEYS_DOWN = ['........', '..s.....', '..la....', '...aa...', '...aa...'];
const A_KEYS_UP = ['..s.....', '..l.....', '..la....', '...aa...', '...aa...'];
// reading a crib card held in both hands at the chest (front view), in the near hand (side view)
const A_CARD_F = ['....a...', '...aa...', '...aA...', '...al...', '....ls..', '........'];
const S_CARD = ['......aa........', '......aa........', '......aa........', '.....ll.........', '....ls..........', '................'];
// side-on seated (for chairSpin)
const S_SEAT = ['......aa........', '......aa........', '......aa........', '......aa........', '......aa........', '......al........', '.....ll.........', '....ll..........', '....ss..........'];

// ---------------------------------------------------------------------------
// Held items (prop palette)

const PAPER = ['000000', '011110', '000000', '011100', '000000', '011110', '000000'];
const PAPER_FEED = ['000', '010', '000', '010', '000', '010'];
const MUG = ['2222.', '23322', '22222', '2222.'];
const FOLDER = ['.vvvv', 'vWWWW', 'vW00W', 'vWWWW', 'vvvvv'];
const MARKER = ['6', '9'];
const PENCIL = ['5', '5', '9'];
const ART_PALETTE = ['.www.', 'w7w5w', 'w6wgw', '.www.'];
const SWEAT = ['X', 'X'];
// telephone receiver held to the left ear: earpiece at the top, mouthpiece angled to the chin. A cream office handset with a
// beige edge, so it reads against dark hair as well as fair (a charcoal one vanished into dark hair).
const RECEIVER = ['.n.', 'nBn', 'nBn', '.Bn', '.Bn', '.nB', '..n'];

// the cleaner's green cloth and spray bottle (white trigger head, nozzle facing forward = left), and a puff of mist (drawn
// without an outline, see Item.soft)
const CLOTH = ['zzg', 'gzz'];
const SPRAY = ['922.', '.22.', '.66.', '6XX6', '6XX6', '6666'];
const MIST = ['2.X', '.X.', 'X.2'];
// the cleaner's bucket, carried by its handle (or set down while she wipes): handle, rim with water, blue body
const BUCKET = ['-..-', '6XX6', '6666', '6666', '.66.'];
// the IT pair's crib card: a little white index card (red rule, a line of scribble) so it reads on a pale shirt too;
// narrower from the side
const CARD = ['2222', '7777', '2332', '2222'];
const CARD_SIDE = ['22', '77', '23', '22'];

/** Food the vendor's cart sells (and the manager picks with `pickFood`). */
export type FoodId = 'carrotCake' | 'doughnut' | 'crisps';
/** Every food id, in cart order. */
export const FOOD_IDS: readonly FoodId[] = ['carrotCake', 'doughnut', 'crisps'];
/** What `pickFood` holds when no food is passed to `getCharacterFrame`. */
export const DEFAULT_FOOD: FoodId = 'carrotCake';
/** Food item rows (ITEM_PAL keys), seen from the side as held. */
export const FOOD_ROWS: Readonly<Record<FoodId, readonly string[]>> = {
  // a slice of carrot cake: cream-cheese frosting on top and between two spiced layers, a piped carrot on top
  carrotCake: ['.Az..', '00000', 'ccccC', '00000', 'cccCC'],
  // pink-iced ring doughnut with sprinkles, the hole showing dark
  doughnut: ['.xxx.', 'xz.Xx', 'WxxxW', '.vWv.'],
  // a red packet of crisps with a yellow window and crimped foil ends
  crisps: ['+-+-', '7777', '7557', '7r77', '+-+-'],
};

/** Palette for held items (and the food on the cart): the prop palette plus doughnut-dough and pastry browns. */
export const ITEM_PAL: Palette = { ...PROP_PAL, W: '#e2c27a', v: '#b8974f' };

/** A food item on its own with its outline, (rows + 2) px each way; the cart draws its goodies with these. */
export function foodSprite(id: FoodId): HTMLCanvasElement {
  const rows = FOOD_ROWS[id];
  const g = new PixelGrid(rows[0]!.length + 2, rows.length + 2);
  g.stamp(rows, ITEM_PAL, 1, 1);
  g.outline(OUTLINE, 0.6);
  return g.toCanvas();
}

/** A held prop. `abs` items use absolute frame rows; others are relative to the shoulder line. `soft` items are stamped after the outline (spray mist). */
interface Item { rows: readonly string[]; x: number; y: number; over: boolean; abs: boolean; soft?: boolean }

// ---------------------------------------------------------------------------
// Frame specification and composition

type View = 'front' | 'back' | 'side';
type Face = 'normal' | 'blink' | 'talk';

interface FrameSpec {
  view: View;
  seated: boolean;
  legs: LegKind | null;
  bodyDy: number;
  headDy: number;
  /** Head nudged sideways (before the right-facing mirror): negative = left, i.e. forward in the side view. */
  headDx: number;
  face: Face;
  behind: Arms | null;
  arms: Arms | null;
  armsOverHead: boolean;
  items: Item[];
  chairFront: boolean;
  /** Arms drawn last, over the head and the held items (the hand holding a phone receiver). */
  top: Arms | null;
}

function spec(p: Partial<FrameSpec> & { view: View }): FrameSpec {
  return {
    seated: false, legs: null, bodyDy: 0, headDy: 0, headDx: 0, face: 'normal', behind: null, arms: null,
    armsOverHead: false, items: [], chairFront: false, top: null, ...p,
  };
}

const rel = (l: readonly string[], r: readonly string[] | null = l, y = 0): Arms => arms(l, r, y, false);
const abs = (l: readonly string[], r: readonly string[] | null = l, y = SA): Arms => arms(l, r, y, true);
const side = (rows: readonly string[], y = 0): Arms => ({ rows, y, abs: false });

/** Absolute seated arms whose left and right halves start on different frame rows. */
function absPair(left: readonly string[], ly: number, right: readonly string[], ry: number): Arms {
  const y = Math.min(ly, ry);
  const pad = (rows: readonly string[], n: number): string[] => [...Array.from({ length: n }, () => '........'), ...rows];
  return arms(pad(left, ly - y), pad(right, ry - y), y, true);
}

/** Frame specs for (pose, dir) where dir is a supported art direction ('right' is drawn as mirrored 'left'). */
function frameSpecs(pose: Pose, dir: Dir, look: LookDef, food: FoodId = DEFAULT_FOOD): FrameSpec[] {
  const d: Dir = dir === 'right' ? 'left' : dir;
  const view: View = d === 'down' ? 'front' : d === 'up' ? 'back' : 'side';
  const sit = (p: Partial<FrameSpec>): FrameSpec => spec({ view: 'front', seated: true, ...p });
  // Looks that carry something (the cleaner's bucket) hold it in a hanging hand while standing and walking.
  if (look.carry && (pose === 'stand' || pose === 'walk')) {
    const bucket: Item = { rows: BUCKET, x: view === 'side' ? 5 : 10, y: 6, over: false, abs: false };
    return frameSpecs(pose, dir, { ...look, carry: undefined }).map((f) => ({
      ...f,
      arms: view === 'side' ? side(S_HANG) : rel(f.arms!.rows.map((r) => r.slice(0, 8)), A_HANG),
      items: [...f.items, bucket],
    }));
  }
  switch (pose) {
    case 'stand':
      if (view === 'side') return [spec({ view, legs: 'stand', arms: side(S_HANG) }), spec({ view, legs: 'stand', arms: side(S_HANG), face: 'blink' })];
      return [spec({ view, legs: 'stand', arms: rel(A_HANG) }), spec({ view, legs: 'stand', arms: rel(A_HANG), face: 'blink' })];
    case 'walk':
      if (view === 'side') {
        return [
          spec({ view, legs: 'sideA', arms: side(S_SWING_BACK) }),
          spec({ view, legs: 'stand', arms: side(S_HANG), bodyDy: -1 }),
          spec({ view, legs: 'sideB', arms: side(S_SWING_FWD) }),
          spec({ view, legs: 'stand', arms: side(S_HANG), bodyDy: -1 }),
        ];
      }
      return [
        spec({ view, legs: 'stepL', arms: rel(A_HANG_UP, A_HANG) }),
        spec({ view, legs: 'stand', arms: rel(A_HANG), bodyDy: -1 }),
        spec({ view, legs: 'stepR', arms: rel(A_HANG, A_HANG_UP) }),
        spec({ view, legs: 'stand', arms: rel(A_HANG), bodyDy: -1 }),
      ];
    case 'sitIdle':
      return [sit({ arms: abs(L_REST) }), sit({ arms: abs(L_REST), face: 'blink' })];
    case 'sitType':
      return [
        sit({ arms: abs(L_REST, L_TYPE_UP) }),
        sit({ arms: abs(L_TYPE_UP, L_REST) }),
        sit({ arms: abs(L_REST, L_TYPE_UP), bodyDy: 0 }),
        sit({ arms: abs(L_TYPE_UP, L_TYPE_UP) }),
      ];
    case 'sitRead': {
      const paper = (dy: number): Item => ({ rows: PAPER, x: 5, y: 14 + dy, over: false, abs: true });
      return [
        sit({ arms: abs(L_HOLD), items: [paper(0)], headDy: 1 }),
        sit({ arms: abs(L_HOLD, L_HOLD), items: [paper(-1)], headDy: 1, bodyDy: 0 }),
        sit({ arms: abs(L_HOLD), items: [paper(0)], headDy: 1, face: 'blink' }),
      ];
    }
    case 'sitThink':
      return [
        sit({ behind: rel(L_BEHIND_HEAD, L_BEHIND_HEAD, -6), headDy: -1, bodyDy: -1 }),
        sit({ behind: rel(L_BEHIND_HEAD, L_BEHIND_HEAD, -6), headDy: -1, bodyDy: -1, face: 'blink' }),
      ];
    case 'sitRun': {
      const sweat: Item = { rows: SWEAT, x: 12, y: 4, over: true, abs: true };
      return [
        sit({ arms: abs(L_POUND, L_SLAM), headDy: 1, items: [sweat] }),
        sit({ arms: abs(L_SLAM, L_POUND), headDy: 1 }),
        sit({ arms: abs(L_POUND, L_SLAM), headDy: 1 }),
        sit({ arms: abs(L_SLAM, L_POUND), headDy: 1, items: [{ ...sweat, y: 5 }] }),
      ];
    }
    case 'sitPhone': {
      const receiver: Item = { rows: RECEIVER, x: BUILDS[look.build].wide ? 0 : 1, y: -7, over: true, abs: false };
      const on = (face: Face): FrameSpec => sit({ arms: abs([], L_REST), top: rel(L_PHONE, null, -6), items: [receiver], face });
      return [on('normal'), on('blink'), on('normal'), on('talk'), on('normal'), on('talk')];
    }
    case 'mugSip':
      return [
        sit({ arms: abs(L_REST, L_MUG_DESK), items: [{ rows: MUG, x: 9, y: 18, over: false, abs: true }] }),
        sit({ arms: abs(L_REST, L_MUG_CHEST), items: [{ rows: MUG, x: 8, y: 15, over: false, abs: true }] }),
        sit({ arms: abs(L_REST, L_MUG_MOUTH), items: [{ rows: MUG, x: 5, y: 10, over: true, abs: true }], face: 'blink', armsOverHead: true }),
        sit({ arms: abs(L_REST, L_MUG_CHEST), items: [{ rows: MUG, x: 8, y: 15, over: false, abs: true }] }),
      ];
    case 'deskSip': {
      // Like mugSip, for every build: at the mouth the arm and the mug follow the head, which sits higher on a tall
      // build and lower on a small one.
      const sh = BUILDS[look.build].shoulder + SEAT_DROP;
      const mug = (x: number, y: number, over: boolean): Item => ({ rows: MUG, x, y, over, abs: true });
      return [
        sit({ arms: abs(L_REST, L_MUG_DESK), items: [mug(9, 18, false)] }),
        sit({ arms: abs(L_REST, L_MUG_CHEST), items: [mug(8, 15, false)] }),
        sit({ arms: absPair(L_REST, SA, L_MUG_MOUTH, sh - 2), items: [mug(5, sh - 4, true)], face: 'blink', armsOverHead: true }),
        sit({ arms: abs(L_REST, L_MUG_CHEST), items: [mug(8, 15, false)] }),
      ];
    }
    case 'chairSpin':
      return [
        sit({ arms: abs(L_REST) }),
        spec({ view: 'side', seated: true, arms: side(S_SEAT, 0) }),
        spec({ view: 'back', seated: true, arms: rel(A_HANG), chairFront: true }),
        spec({ view: 'side', seated: true, arms: side(S_SEAT, 0) }),
      ];
    case 'rummage': {
      const folder: Item = { rows: FOLDER, x: 10, y: -8, over: true, abs: false };
      return [
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), headDy: 1 }),
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), headDy: 1, bodyDy: 1 }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', behind: rel(A_REACH_BACK, null), arms: rel(['........'], A_RAISE_MID, -7), items: [folder] }),
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), headDy: 1, bodyDy: 1 }),
      ];
    }
    case 'draw': {
      const pal = (dy: number): Item => ({ rows: ART_PALETTE, x: 1, y: 4 + dy, over: true, abs: false });
      return [
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_MID, -7), items: [pal(0), { rows: PENCIL, x: 13, y: -7, over: true, abs: false }] }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_WIDE, -7), items: [pal(0), { rows: PENCIL, x: 14, y: -5, over: true, abs: false }] }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_MID, -7), items: [pal(0), { rows: PENCIL, x: 13, y: -7, over: true, abs: false }], bodyDy: 0, headDy: 1 }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_HIGH, -7), items: [pal(0), { rows: PENCIL, x: 12, y: -9, over: true, abs: false }] }),
      ];
    }
    case 'whiteboard':
      return [
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_HIGH, -7), items: [{ rows: MARKER, x: 12, y: -8, over: true, abs: false }] }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_MID, -7), items: [{ rows: MARKER, x: 13, y: -6, over: true, abs: false }] }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_RAISE_HIGH, -7), items: [{ rows: MARKER, x: 12, y: -8, over: true, abs: false }], headDy: 0 }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_KNOCK, -7), items: [{ rows: MARKER, x: 12, y: -8, over: true, abs: false }] }),
      ];
    case 'copierWait':
      if (view === 'side') {
        return [
          spec({ view, legs: 'stand', arms: side(S_CROSS) }),
          spec({ view, legs: 'tap', arms: side(S_CROSS) }),
          spec({ view, legs: 'stand', arms: side(S_CROSS) }),
          spec({ view, legs: 'tap', arms: side(S_CROSS), face: 'blink' }),
        ];
      }
      return [
        spec({ view: 'front', legs: 'stand', arms: A_CROSSED }),
        spec({ view: 'front', legs: 'tap', arms: A_CROSSED }),
        spec({ view: 'front', legs: 'stand', arms: A_CROSSED }),
        spec({ view: 'front', legs: 'tap', arms: A_CROSSED, face: 'blink' }),
      ];
    case 'knock':
      return [
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_KNOCK, -7) }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_KNOCK_HIT, -7) }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_KNOCK, -7) }),
        spec({ armsOverHead: true, view: 'back', legs: 'stand', arms: rel(A_HANG, A_KNOCK_HIT, -7) }),
      ];
    case 'wave':
      return [
        spec({ armsOverHead: true, view: 'front', legs: 'stand', arms: rel(A_HANG, A_WAVE_A, -5), face: 'talk' }),
        spec({ armsOverHead: true, view: 'front', legs: 'stand', arms: rel(A_HANG, A_WAVE_B, -5), face: 'talk' }),
      ];
    case 'point':
      if (view === 'side') {
        return [
          spec({ view, legs: 'stand', arms: side(S_POINT, 0), face: 'talk' }),
          spec({ view, legs: 'stand', arms: side(S_POINT_JAB, 0) }),
        ];
      }
      return [
        spec({ view: 'front', legs: 'stand', arms: rel(['....a...', ...A_POINT_F], A_HANG), face: 'talk' }),
        spec({ view: 'front', legs: 'stand', arms: rel(['....a...', ...A_POINT_F2], A_HANG) }),
      ];
    case 'talk':
      if (view === 'side') {
        return [
          spec({ view, legs: 'stand', arms: side(S_HANG) }),
          spec({ view, legs: 'stand', arms: side(S_TALK), face: 'talk' }),
          spec({ view, legs: 'stand', arms: side(S_TALK) }),
          spec({ view, legs: 'stand', arms: side(S_HANG), face: 'talk' }),
        ];
      }
      return [
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG) }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_TALK_UP), face: 'talk' }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_TALK_UP, A_HANG) }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG), face: 'talk' }),
      ];
    case 'pushCart':
      if (view === 'side') {
        return [
          spec({ view, legs: 'sideA', arms: side(S_PUSH) }),
          spec({ view, legs: 'stand', arms: side(S_PUSH), bodyDy: -1 }),
          spec({ view, legs: 'sideB', arms: side(S_PUSH) }),
          spec({ view, legs: 'stand', arms: side(S_PUSH), bodyDy: -1 }),
        ];
      }
      if (view === 'back') {
        return [
          spec({ view, legs: 'stepL', behind: rel(A_REACH_BACK) }),
          spec({ view, legs: 'stand', behind: rel(A_REACH_BACK), bodyDy: -1 }),
          spec({ view, legs: 'stepR', behind: rel(A_REACH_BACK) }),
          spec({ view, legs: 'stand', behind: rel(A_REACH_BACK), bodyDy: -1 }),
        ];
      }
      return [
        spec({ view, legs: 'stepL', arms: rel(A_PUSH_F) }),
        spec({ view, legs: 'stand', arms: rel(A_PUSH_F), bodyDy: -1 }),
        spec({ view, legs: 'stepR', arms: rel(A_PUSH_F) }),
        spec({ view, legs: 'stand', arms: rel(A_PUSH_F), bodyDy: -1 }),
      ];
    case 'pickFood': {
      const rows = FOOD_ROWS[food];
      // `bottom` is the item's bottom row relative to the shoulder line
      const held = (x: number, bottom: number, over = false): Item => ({ rows, x, y: bottom - rows.length + 1, over, abs: false });
      if (view === 'side') {
        return [
          spec({ view, legs: 'stand', arms: side(S_REACH) }),
          spec({ view, legs: 'stand', arms: side(S_REACH), items: [held(0, 5)], headDy: 1 }),
          spec({ view, legs: 'stand', arms: side(S_LIFT), items: [held(3, 3)] }),
          spec({ view, legs: 'stand', arms: side(S_FOOD_UP, -9), items: [held(1, -10, true)], face: 'talk', armsOverHead: true }),
        ];
      }
      return [
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_REACH_F) }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_REACH_F), items: [held(8, 5)], headDy: 1 }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_TALK_UP), items: [held(9, 3)] }),
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_FOOD_UP, -3), items: [held(11, -3, true)], face: 'talk', armsOverHead: true }),
      ];
    }
    case 'wipe': {
      // the bucket (if the look carries one) stands on the floor beside her
      const b = BUILDS[look.build];
      const floor = b.torsoRows + b.legRows + 2;
      const parked = (x: number): Item[] => (look.carry ? [{ rows: BUCKET, x, y: floor - BUCKET.length + 1, over: false, abs: false }] : []);
      if (view === 'side') {
        const cloth = (x: number): Item => ({ rows: CLOTH, x, y: 5, over: false, abs: false });
        const far = spec({ view, legs: 'stand', arms: side(S_WIPE_FAR), items: [...parked(11), cloth(1)], headDy: 1 });
        const near = spec({ view, legs: 'stand', arms: side(S_WIPE_NEAR), items: [...parked(11), cloth(3)] });
        return [
          spec({ view, legs: 'stand', arms: side(S_SPRAY), items: [...parked(11), { rows: SPRAY, x: 3, y: 1, over: false, abs: false }, { rows: MIST, x: 0, y: 0, over: true, abs: false, soft: true }] }),
          far, near, far, near, { ...far, face: 'blink' },
        ];
      }
      if (view === 'back') {
        // reaching over the desk in front of her (it shows above her shoulders in the 3/4 view), like the whiteboard
        const at = (x: number, y: number): Item => ({ rows: CLOTH, x, y, over: false, abs: false });
        const mid = spec({ armsOverHead: true, view, legs: 'stand', arms: rel(A_HANG, A_RAISE_MID, -7), items: [...parked(0), at(13, -5)] });
        return [
          spec({
            armsOverHead: true, view, legs: 'stand', arms: rel(A_HANG, A_RAISE_MID, -7),
            items: [...parked(0), { rows: SPRAY.map(mirrorRow), x: 12, y: -7, over: false, abs: false }, { rows: MIST, x: 12, y: -10, over: true, abs: false, soft: true }],
          }),
          mid,
          spec({ armsOverHead: true, view, legs: 'stand', arms: rel(A_HANG, A_RAISE_WIDE, -7), items: [...parked(0), at(13, -3)] }),
          mid,
          spec({ armsOverHead: true, view, legs: 'stand', arms: rel(A_HANG, A_RAISE_HIGH, -7), items: [...parked(0), at(12, -7)] }),
          mid,
        ];
      }
      const cloth = (x: number): Item => ({ rows: CLOTH, x, y: 5, over: false, abs: false });
      const out = spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_WIPE_OUT), items: [...parked(0), cloth(13)] });
      const inn = spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_WIPE_IN), items: [...parked(0), cloth(8)], headDy: 1 });
      return [
        spec({ view: 'front', legs: 'stand', arms: rel(A_HANG, A_SPRAY_F), items: [...parked(0), { rows: SPRAY.map(mirrorRow), x: 9, y: 2, over: false, abs: false }, { rows: MIST, x: 13, y: 5, over: true, abs: false, soft: true }] }),
        out, inn, out, inn, { ...out, face: 'blink' },
      ];
    }
    case 'fixPc':
      // leaning in (head forward and down) with a hand tapping at the keyboard
      if (view === 'side') {
        const lean = { view, legs: 'stand' as const, headDx: -1, headDy: 1 };
        return [
          spec({ ...lean, arms: side(S_TAP_DOWN) }),
          spec({ ...lean, arms: side(S_TAP_UP) }),
          spec({ ...lean, arms: side(S_TAP_DOWN) }),
          spec({ ...lean, arms: side(S_TAP_UP), face: 'blink' }),
        ];
      }
      if (view === 'back') {
        // the desk is in front of him (it shows above his shoulders in the 3/4 view): the near arm reaches forward out of
        // sight, the other hand taps at the keys just past his shoulder
        const keys = (r: readonly string[]): FrameSpec =>
          spec({ armsOverHead: true, view, legs: 'stand', headDy: 1, behind: rel(A_REACH_BACK, null), arms: rel(['........'], r, -2) });
        return [keys(A_KEYS_DOWN), keys(A_KEYS_UP), keys(A_KEYS_DOWN), keys(A_KEYS_UP)];
      }
      return [
        spec({ view, legs: 'stand', headDy: 1, arms: rel(A_HANG, A_TAP_DOWN) }),
        spec({ view, legs: 'stand', headDy: 1, arms: rel(A_HANG, A_TAP_UP) }),
        spec({ view, legs: 'stand', headDy: 1, arms: rel(A_HANG, A_TAP_DOWN) }),
        spec({ view, legs: 'stand', headDy: 1, arms: rel(A_HANG, A_TAP_UP), face: 'blink' }),
      ];
    case 'scoff': {
      // arms folded; the head shakes, left, right, left
      const folded = (headDx: number, face: Face = 'normal'): FrameSpec => (view === 'side'
        ? spec({ view, legs: 'stand', arms: side(S_CROSS), headDx, face })
        : view === 'back'
          ? spec({ view, legs: 'stand', behind: rel(A_REACH_BACK), headDx, face })
          : spec({ view, legs: 'stand', arms: A_CROSSED, headDx, face }));
      return view === 'side'
        ? [folded(0), folded(1, 'blink'), folded(0), folded(1)]
        : [folded(0), folded(-1, 'blink'), folded(1), folded(-1)];
    }
    case 'readCard': {
      // eyes on the card (head down) while the mouth moves; the last frame looks up to deliver the line
      if (view === 'side') {
        const card: Item = { rows: CARD_SIDE, x: 2, y: 2, over: false, abs: false };
        const read = (face: Face, headDy: number): FrameSpec => spec({ view, legs: 'stand', arms: side(S_CARD), items: [card], face, headDy });
        return [read('normal', 1), read('talk', 1), read('normal', 1), read('talk', 0)];
      }
      if (view === 'back') {
        // the card is in front of him: only his elbows show
        const read = (headDy: number): FrameSpec => spec({ view, legs: 'stand', behind: rel(A_REACH_BACK), headDy });
        return [read(1), read(1), read(1), read(0)];
      }
      const card: Item = { rows: CARD, x: 6, y: 2, over: false, abs: false };
      const read = (face: Face, headDy: number): FrameSpec => spec({ view, legs: 'stand', arms: rel(A_CARD_F), items: [card], face, headDy });
      return [read('normal', 1), read('talk', 1), read('normal', 1), read('talk', 0)];
    }
    case 'shred':
      return [
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), items: [{ rows: PAPER_FEED, x: 12, y: -7, over: true, abs: false }] }),
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), items: [{ rows: PAPER_FEED.slice(0, 4), x: 12, y: -5, over: true, abs: false }] }),
        spec({ view: 'back', legs: 'stand', behind: rel(A_REACH_BACK), items: [{ rows: PAPER_FEED.slice(0, 2), x: 12, y: -3, over: true, abs: false }], bodyDy: 1 }),
      ];
  }
}

// ---------------------------------------------------------------------------
// Head variants

function headRows(look: LookDef, view: View, face: Face): string[] {
  const src = view === 'front' ? look.head.front : view === 'back' ? look.head.back : look.head.side;
  const rows = src.map((r) => r.split(''));
  if (face === 'blink') {
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y]!.length; x++) {
        if (rows[y]![x] !== 'e') continue;
        const below = rows[y + 1]?.[x];
        rows[y]![x] = below === 'e' ? 's' : 'm';
      }
    }
  } else if (face === 'talk') {
    const mouth: [number, number][] = [];
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y]!.length; x++) if (rows[y]![x] === 'm') mouth.push([x, y]);
    for (const [x, y] of mouth) {
      rows[y]![x] = 'M';
      const b = rows[y + 1]?.[x];
      if (b === 's' || b === 'S' || b === 'd') rows[y + 1]![x] = 'M';
    }
  }
  return rows.map((r) => r.join(''));
}

// ---------------------------------------------------------------------------
// Chairs drawn inside frames (only the spinning manager needs one in front)

// ---------------------------------------------------------------------------
// Lanyard with an ID badge (strap x, badge X), stamped over the torso like a 6-row torso template

const LANYARD_FRONT = ['.x..x.', '.x..x.', '..xx..', '..XX..', '..XX..', '......'];
const LANYARD_BACK = ['..xx..', '......', '......', '......', '......', '......'];
const LANYARD_SIDE = ['.x...', 'x....', 'X....', 'X....', '.....', '.....'];

const CHAIR_BACK_FRONT = [
  '...qqqqqqqqqq...',
  '..qQqqqqqqqqQq..',
  '..qqqqqqqqqqqq..',
  '..qqqqqqqqqqqq..',
  '..qqqqqqqqqqqq..',
  '..qqqqqqqqqqqq..',
  '..QqqqqqqqqqqQ..',
  '...QQQQQQQQQQ...',
];

// ---------------------------------------------------------------------------
// Composition

function compose(look: LookDef, s: FrameSpec, flip: boolean): HTMLCanvasElement {
  const b = BUILDS[look.build];
  const g = new PixelGrid(CHAR_W, CHAR_HEADROOM + CHAR_H);
  // Parts are placed in body-grid rows; shift them down into the frame below the headroom.
  const stamp = (rows: readonly string[], p: Palette, x: number, y: number, opts: { contact?: number; clipTop?: number; clipBottom?: number } = {}): void => {
    g.stamp(rows, p, x, y + CHAR_HEADROOM, { ...opts, clipTop: (opts.clipTop ?? -Infinity) + CHAR_HEADROOM, clipBottom: (opts.clipBottom ?? Infinity) + CHAR_HEADROOM });
  };
  const pal = look.pal;
  const shoulder = (s.seated ? b.shoulder + SEAT_DROP : b.shoulder) + s.bodyDy;
  const torsoX = b.wide ? 4 : 5;
  const clip = s.seated ? SEAT_CUT_ROW - 1 : CHAR_H;
  const bodyClip = { clipBottom: clip };

  // legs and hip
  if (!s.seated && s.legs) {
    const hip = b.shoulder + b.torsoRows;
    const block = legBlock(look, s.view, s.legs);
    stamp(block, pal, 0, hip + 1);
  }
  // rubber gloves: hands and forearms in the glove colour
  const gloved = look.outfit.gloves !== undefined;
  const placeArms = (a: Arms, contact: number): void => {
    let rows = a.rows;
    if (gloved) rows = rows.map((r) => r.replace(/[sl]/g, 'y').replace(/L/g, 'Y'));
    if (b.wide && s.view !== 'side') rows = rows.map(widenHalves);
    const y = a.abs ? a.y : shoulder + a.y;
    stamp(rows, pal, 0, y, { contact, clipTop: a.abs ? shoulder : -Infinity });
  };
  if (s.behind) placeArms(s.behind, 0);

  // torso
  const tmpl = s.view === 'front' ? TORSO_FRONT[look.torso] : s.view === 'back' ? torsoBack(look.torso) : torsoSide(look.torso);
  const torso = fitTorso(tmpl, b, s.view === 'side');
  const tx = s.view === 'side' ? (b.wide ? 4 : 5) : torsoX;
  stamp(torso, pal, tx, shoulder, bodyClip);
  if (look.lanyard) {
    const strap = s.view === 'front' ? LANYARD_FRONT : s.view === 'back' ? LANYARD_BACK : LANYARD_SIDE;
    stamp(fitTorso(strap, b, s.view === 'side'), pal, tx, shoulder, bodyClip);
  }
  if (!s.seated) {
    const hipRow = shoulder + torso.length;
    const key = look.skirt ? 'p' : look.belt ? 'B' : 'p';
    const w = torso[0]!.length;
    if (look.highWaist) {
      // trousers pulled up: the belt over the shirt's bottom row, trouser below it
      stamp([key.repeat(w)], pal, tx, hipRow - 1, bodyClip);
      stamp(['p'.repeat(w)], pal, tx, hipRow, bodyClip);
    } else stamp([key.repeat(w)], pal, tx, hipRow, bodyClip);
    if (s.bodyDy < 0) {
      // keep the legs attached when the body bobs up
      stamp([key.repeat(w)], pal, tx, hipRow + 1);
    }
  }

  const itemY = (it: Item): number => (it.abs ? it.y : shoulder + it.y);
  const itemX = (it: Item): number => it.x + (b.wide && it.x > 8 ? 1 : 0);
  for (const it of s.items) if (!it.over) stamp(it.rows, ITEM_PAL, itemX(it), itemY(it), { contact: 0.15 });

  const head = headRows(look, s.view, s.face);
  // a slouching look's head sinks into the shoulders and, side-on, pokes forward
  const headY = shoulder - 11 + s.headDy + (look.slouch ? 1 : 0);
  const headX = 2 + s.headDx + (look.slouch && s.view === 'side' ? -1 : 0);
  if (s.arms && !s.armsOverHead) placeArms(s.arms, 0.22);
  stamp(head, pal, headX, headY, { contact: 0.28 });
  if (s.arms && s.armsOverHead) placeArms(s.arms, 0.22);

  if (s.chairFront) {
    const chairPal: Palette = { q: C.exec, Q: C.execLight };
    stamp(CHAIR_BACK_FRONT, chairPal, 0, shoulder - 1, { contact: 0.2 });
  }
  for (const it of s.items) if (it.over && !it.soft) stamp(it.rows, ITEM_PAL, itemX(it), itemY(it));
  if (s.top) placeArms(s.top, 0.22);

  g.outline(OUTLINE);
  for (const it of s.items) if (it.soft) stamp(it.rows, ITEM_PAL, itemX(it), itemY(it));
  if (flip) g.flipX();
  return g.toCanvas();
}

// ---------------------------------------------------------------------------
// Public API

const cache = new Map<string, HTMLCanvasElement[]>();

// ---------------------------------------------------------------------------
// Look registry

const registry = new Map<string, LookDef>();

/** Registers (or replaces) a look by its `id` and drops any frames cached for that id. */
export function registerLook(def: LookDef): void {
  registry.set(def.id, def);
  invalidateLook(def.id);
}

/** The registered look for an id, if any. */
export function getLook(id: string): LookDef | undefined {
  return registry.get(id);
}

/** Drops every cached frame (e.g. after the office colours change: the spinning manager's chair is in his frames). */
export function clearCharacterCache(): void {
  cache.clear();
}

/** For tests: how many (look, pose, direction) frame sets are cached. */
export function characterCacheSize(): number {
  return cache.size;
}

/** Drops the cached frames of one look so the next request re-renders it. */
export function invalidateLook(id: string): void {
  const prefix = `${id}|`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

for (const def of Object.values(LOOKS)) registerLook(def);
for (const def of Object.values(NPC_LOOKS)) registerLook(def);
for (const id of [...STAFF_SLOT_IDS, ...TEMP_SLOT_IDS]) registerLook(defaultSlotLook(id));

/** Look used when an id was never registered. */
const UNKNOWN_LOOK = 'temp0';

/** Resolves a requested direction to one the pose has art for. */
export function resolveDir(pose: Pose, dir: Dir): Dir {
  const dirs = POSES[pose].dirs;
  if (dirs.includes(dir)) return dir;
  if (dir === 'right' && dirs.includes('left')) return 'right';
  if (dir === 'left' && dirs.includes('right')) return 'left';
  return dirs[0]!;
}

/** Whether `look` has art for `pose` (every look does, except for poses with `onlyLooks`). */
export function lookHasPose(look: LookId, pose: Pose): boolean {
  const only = POSES[pose].onlyLooks;
  return !only || only.includes(look);
}

/** The pose `look` is actually drawn in: `pose` itself, or its `fallback` when the look has no art for it. */
export function poseForLook(look: LookId, pose: Pose): Pose {
  return lookHasPose(look, pose) ? pose : POSES[pose].fallback ?? 'stand';
}

/**
 * Returns the cached 16x28 canvas for one frame. `frame` wraps around the
 * pose's frame count; unsupported directions fall back (see `resolveDir`);
 * a look outside a pose's `onlyLooks` draws its `fallback` (`poseForLook`).
 * The `chairSpin` pose ignores `dir` and spins through down, left, up, right
 * by itself. `food` is the item `pickFood` holds (other poses ignore it).
 */
export function getCharacterFrame(look: LookId, pose: Pose, dir: Dir, frame: number, food: FoodId = DEFAULT_FOOD): HTMLCanvasElement {
  pose = poseForLook(look, pose);
  const d = resolveDir(pose, dir);
  const key = pose === 'pickFood' ? `${look}|${pose}|${d}|${food}` : `${look}|${pose}|${d}`;
  let frames = cache.get(key);
  if (!frames) {
    const def = registry.get(look) ?? registry.get(UNKNOWN_LOOK)!;
    const specs = frameSpecs(pose, d, def, food);
    frames = specs.map((s, i) => {
      // chairSpin: frame 3 is the right-facing side view
      const flip = pose === 'chairSpin' ? i === 3 : d === 'right';
      return compose(def, s, flip);
    });
    cache.set(key, frames);
  }
  const n = frames.length;
  return frames[((frame % n) + n) % n]!;
}

/** Pre-renders every frame of every registered look (call once at startup to avoid hitches). */
export function warmCharacterCache(): void {
  for (const look of registry.keys()) {
    for (const pose of ALL_POSES) {
      if (!lookHasPose(look, pose)) continue;
      for (const food of pose === 'pickFood' ? FOOD_IDS : [DEFAULT_FOOD]) {
        for (const d of POSES[pose].dirs) getCharacterFrame(look, pose, d, 0, food);
        if (POSES[pose].dirs.includes('left')) getCharacterFrame(look, pose, 'right', 0, food);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Which look-spec fields show on a look

/** Palette keys a look draws in any pose (head views and faces, torso views, lanyard, hip, legs, arms). */
function drawnKeys(def: LookDef): Set<string> {
  const keys = new Set<string>(['a', 'A', 'l', 'L', 's', 'm', 'M', 'p', 'P', 'f', 'F']);
  const add = (rows: readonly string[]): void => { for (const r of rows) for (const k of r) if (k !== '.' && k !== ' ' && k !== '_') keys.add(k); };
  add(def.head.front); add(def.head.back); add(def.head.side);
  add(TORSO_FRONT[def.torso]); add(torsoBack(def.torso)); add(torsoSide(def.torso));
  if (def.lanyard) { add(LANYARD_FRONT); add(LANYARD_BACK); add(LANYARD_SIDE); }
  if (def.skirt) keys.add('g');
  else if (def.belt) keys.add('B');
  return keys;
}

/**
 * The look-spec fields that change how `def` looks: head, build, outfit,
 * skin, skirt and shortSleeves always; `belt` only without a skirt; each
 * colour only if a pixel drawn with it changes (e.g. `tie` only on outfits
 * with a tie, `legs` only with a skirt, `glasses` only on heads with glasses,
 * `outer` also where it is the sleeve colour). For an edited look, pass
 * `buildLook(id, draftSpec, builtIn)`.
 */
export function lookFieldUse(def: LookDef): (keyof LookSpec)[] {
  const keys = drawnKeys(def);
  const used: (keyof LookSpec)[] = ['head', 'build', 'outfit', 'skin'];
  for (const field of LOOK_COLOUR_FIELDS) {
    // two probes, in case the look already uses one of them
    const changes = ['#010203', '#fefdfc'].some((probe) => {
      const probed = buildLook(def.id, { [field]: probe }, def);
      for (const k of keys) if (probed.pal[k] !== def.pal[k]) return true;
      return false;
    });
    if (changes) used.push(field);
  }
  used.push('skirt', 'shortSleeves');
  if (!def.skirt) used.push('belt');
  return used;
}

/** `lookFieldUse` of every built-in look, by look id. */
export const LOOK_FIELD_USE: Readonly<Record<string, readonly (keyof LookSpec)[]>> = Object.fromEntries(
  Object.values(LOOKS).map((def) => [def.id, lookFieldUse(def)]),
);
