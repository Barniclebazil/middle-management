/**
 * Character looks: palettes, body builds, outfits and hand-drawn heads for
 * the Regional Manager, the receptionist, the eight staff archetypes and the temps.
 *
 * The characters are original archetypes that evoke the show's staff through
 * clothes, hair and props. They are not likenesses of any actor.
 *
 * Head grids are 12 wide x 11 tall. Row 10 is the chin; the head is stamped
 * so its chin sits one row above the shoulder line. Keys:
 *   s/S skin + shade, h/H hair + shade, i hair highlight, e eye, m mouth,
 *   k glasses frame, w lens glint, d facial hair, r blush, b hair accessory
 *   (also the headset), z its highlight.
 */
import type { Color, Palette } from './raster.ts';
import type { LookSpec } from '../../src/shared/theme.ts';
import { IT_SUPPORT_ROLE } from '../../src/shared/itSupport.ts';
import { darken, lighten, mix } from './raster.ts';

/** Ids of the eight staff archetypes, in the order sessions receive them. */
export type ArchetypeId = 'assistant' | 'prankster' | 'helpdesk' | 'crossword' | 'cat' | 'chili' | 'knitting' | 'hr';

/** Ids of the temp (subagent) colour variations. */
export type TempLookId = 'temp0' | 'temp1' | 'temp2' | 'temp3' | 'temp4' | 'temp5';

/** Id of a drawable look: a built-in, a staff/temp slot (`staff-0`, `temp-3`) or any registered custom id. */
export type LookId = string;

/** Id of the Regional Manager's look. */
export const MANAGER_LOOK = 'manager';

/** Id of the permanent receptionist's look (she sits at the front desk; never a worker). */
export const RECEPTIONIST_LOOK = 'receptionist';

/** Staff archetypes in hand-out order (1 = first session to start). */
export const ARCHETYPES: readonly ArchetypeId[] = ['assistant', 'prankster', 'helpdesk', 'crossword', 'cat', 'chili', 'knitting', 'hr'];

/** Temp looks; give them out round-robin. */
export const TEMP_LOOKS: readonly TempLookId[] = ['temp0', 'temp1', 'temp2', 'temp3', 'temp4', 'temp5'];

/** All built-in looks: manager, receptionist, the archetypes, then the temps. */
export const ALL_LOOKS: readonly LookId[] = [MANAGER_LOOK, RECEPTIONIST_LOOK, ...ARCHETYPES, ...TEMP_LOOKS];

/** Slot ids for the eight staff desks: `staff-i` inherits `ARCHETYPES[i]` and sits at its desk. */
export const STAFF_SLOT_IDS: readonly string[] = ['staff-0', 'staff-1', 'staff-2', 'staff-3', 'staff-4', 'staff-5', 'staff-6', 'staff-7'];

/** Slot ids for the six temp looks: `temp-j` inherits `temp<j>`; handed out round-robin. */
export const TEMP_SLOT_IDS: readonly string[] = ['temp-0', 'temp-1', 'temp-2', 'temp-3', 'temp-4', 'temp-5'];

/** Body proportions. */
export type Build = 'normal' | 'tall' | 'small' | 'big';

/** Torso drawing styles (front view). */
export type TorsoStyle = 'suit' | 'shirtTie' | 'looseTie' | 'cardigan' | 'buttonCardigan' | 'vest' | 'floral' | 'openCardigan' | 'plain' | 'polo' | 'blouse'
  // NPC-only styles (not offered to themes): the cleaner's tabard, the vendor's bib apron, the IT pair's T-shirt with a
  // chest graphic and short-sleeved shirt with a tie and a pen in the pocket
  | 'tabard' | 'apron' | 'tee' | 'pocketTie';

/** Hand-drawn head set: front (facing down), back (facing up), side (facing left). */
export interface HeadSet {
  front: readonly string[];
  back: readonly string[];
  side: readonly string[];
}

/** Everything needed to draw one look. */
export interface LookDef {
  id: LookId;
  /** Human-readable role, suitable for tooltips. */
  role: string;
  build: Build;
  torso: TorsoStyle;
  /** Skirt instead of trousers. */
  skirt: boolean;
  /** Short sleeves: forearms are bare skin. */
  shortSleeves: boolean;
  /** Belt row shows (shirt tucked in) rather than the jacket hem. */
  belt: boolean;
  /** An ID badge on a lanyard (strap = `accent`, badge = `accent2`). Not in a theme's look spec: a look built on this one keeps it. */
  lanyard?: boolean;
  /** Something carried in the hand while standing and walking (NPC looks only): the cleaner's bucket. */
  carry?: 'bucket';
  /** Slouches (NPC looks only): the head sits a pixel lower, sunk into the shoulders, and pokes forward in the side view. */
  slouch?: boolean;
  /** Trousers worn high (NPC looks only): the belt sits a row up, over the bottom of the shirt. */
  highWaist?: boolean;
  head: HeadSet;
  /** The colour input `pal` was derived from, kept so `buildLook` can override single colours. */
  outfit: Outfit;
  /** Resolved palette for every body/face key. */
  pal: Palette;
}

// ---------------------------------------------------------------------------
// Heads

const H_BOSS: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hiihhhhh..',
    '.hhhhhhhhhh.',
    '.hhhsssshHh.',
    '..hssssssh..',
    '.sssessesss.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '...hhhhhh...',
    '..hhhiihhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.shhhhhhhhs.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hiihhhh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhh.',
    '..ssssshhhh.',
    '..sesssShhh.',
    '.ssesssShh..',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

const H_ASSISTANT: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '.hhhhHHhhhh.',
    '.hhhhsshhhh.',
    '.hhsssssshh.',
    '.skwekkewks.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.khhhhhhhhk.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hhhhhhh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhh.',
    '..shssshhhh.',
    '..kwkssShhh.',
    '.ssessSShh..',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

const H_PRANKSTER: HeadSet = {
  front: [
    '....hhhh....',
    '..hhhhhhhh..',
    '.hhhiihhhhh.',
    '.hhhhhhhhhhh',
    '.hhhhhhhhssh',
    '..hhhsssssh.',
    '.sssessesss.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '....hhhh....',
    '..hhhhhhhh..',
    '.hhhhiihhhh.',
    'hhhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.shhhhhhhhs.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...hhhhhH...',
    '....sssS....',
  ],
  side: [
    '....hhhh....',
    '..hhhhhhhh..',
    '.hhhiihhhhh.',
    'hhhhhhhhhhh.',
    '..hhhhhhhhh.',
    '..ssssshhhh.',
    '..sesssShhh.',
    '.ssesssShhh.',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

const H_RECEPTIONIST: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hiihhhhhh.',
    '.hhhhhhhhhhh',
    '.hhhhssssshh',
    '.hhsssssssh.',
    'hhssessesshh',
    'hhssessesshh',
    'hhsrssssrshh',
    'hh.ssmmsS.hh',
    'hh..sssS..hh',
  ],
  back: [
    '............',
    '...hhhhhh...',
    '..hhhiihhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    '.hhHhhhhHhh.',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hiihhhh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhhh',
    '..sssshhhhhh',
    '..sesssshhhh',
    '.ssesssshhhh',
    '..srssshhhhh',
    '..smssshhhh.',
    '...sssshhh..',
  ],
};

const H_CROSSWORD: HeadSet = {
  front: [
    '............',
    '............',
    '....ssss....',
    '...ssssss...',
    '..ssssssss..',
    '.hssssssssh.',
    '.hskekkeksh.',
    '.hssessessh.',
    '..ssssssss..',
    '...sddddS...',
    '....sssS....',
  ],
  back: [
    '............',
    '............',
    '....ssss....',
    '...ssssss...',
    '..ssssssss..',
    '.hssssssssh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '............',
    '....sssss...',
    '...sssssss..',
    '..ssssssssh.',
    '..sssssshhh.',
    '..sesssShhh.',
    '.kkkssSShh..',
    '..sssssshh..',
    '..ddsssh....',
    '...ssss.....',
  ],
};

const H_CAT: HeadSet = {
  front: [
    '.....bb.....',
    '....hhhh....',
    '...hhiihh...',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..hsssssssh.',
    '..sseSsess..',
    '..ssessess..',
    '..srssssrs..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '....hhhh....',
    '...hhiihh...',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..hhhHHhhh..',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '.......hh...',
    '......hhhh..',
    '....hhhhihh.',
    '...hhhhhhhh.',
    '..hhhhhhhh..',
    '..sssshhhh..',
    '..sesssShh..',
    '.ssesssShh..',
    '..srssssh...',
    '..smssss....',
    '...ssss.....',
  ],
};

const H_CHILI: HeadSet = {
  front: [
    '............',
    '............',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '.hssssssssh.',
    '.ssssssssss.',
    'ssssessessss',
    'ssssessessss',
    '.srssssssrS.',
    '.sssmmmmssS.',
    '..ssssssSS..',
  ],
  back: [
    '............',
    '............',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    'shhhhhhhhhhs',
    'shhhhhhhhhhs',
    '.ssssssssss.',
    '.sssssssssS.',
    '..ssssssSS..',
  ],
  side: [
    '............',
    '............',
    '....hhhhh...',
    '...hhhhhhh..',
    '..sshhhhhhh.',
    '..sssssshhh.',
    '..sesssSShh.',
    '.ssesssSSss.',
    '..srssssss..',
    '..smsssssS..',
    '...sssssS...',
  ],
};

const H_KNITTING: HeadSet = {
  front: [
    '............',
    '..hhhhhhh...',
    '.hhihhihhhh.',
    'hhhhhhhhhhh.',
    'hhhhsssshhhh',
    'hhhsssssshhh',
    '.hssessessh.',
    '.hssessessh.',
    '..srssssrs..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '..hhhhhhh...',
    '.hhhihhihhh.',
    'hhhhhhhhhhh.',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    '.hhhhhhhhhh.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '...hhhhhhh..',
    '..hhihhihhh.',
    '.hhhhhhhhhhh',
    '..hhhhhhhhhh',
    '..ssssshhhhh',
    '..sesssShhh.',
    '.ssesssShhh.',
    '..srsssshh..',
    '..smssss....',
    '...ssss.....',
  ],
};

const H_HR: HeadSet = {
  front: [
    '............',
    '............',
    '...hssssh...',
    '..hhssssshh.',
    '.hhssssssHh.',
    '.hssssssssh.',
    '.sssessesss.',
    '.sssessesss.',
    '..dsssssSd..',
    '...dsmmsd...',
    '....dddd....',
  ],
  back: [
    '............',
    '............',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.shhhhhhhhs.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '............',
    '....sssshh..',
    '...sssshhhh.',
    '..sssshhhhh.',
    '..sssssshhh.',
    '..sesssShhh.',
    '.ssesssShh..',
    '..sdssddhh..',
    '..dmdddd....',
    '...dddd.....',
  ],
};

const H_TEMP_SHORT: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hhhiihhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '..hssssssh..',
    '.sssessesss.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: H_BOSS.back,
  side: [
    '............',
    '....hhhhh...',
    '...hhhiihh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhh.',
    '..sssshhhhh.',
    '..sesssShhh.',
    '.ssesssShh..',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

const H_TEMP_SPIKY: HeadSet = {
  front: [
    '..h.h.hh.h..',
    '..hhhhhhhh..',
    '.hhhiihhhhh.',
    '.hhhhhhhhhh.',
    '.hhshhhhshh.',
    '..hssssssh..',
    '.sssessesss.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '..h.h.hh.h..',
    '..hhhhhhhh..',
    '.hhhhiihhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.shhhhhhhhs.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '...h.h.h....',
    '...hhhhhhh..',
    '..hhhhiihhh.',
    '..hhhhhhhhh.',
    '..shhhhhhhh.',
    '..sssshhhhh.',
    '..sesssShhh.',
    '.ssesssShh..',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

const H_TEMP_PONY: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hhiihhhh..',
    '.hhhhhhhhhh.',
    '.hhhhssshhh.',
    '.hhsssssssh.',
    '.hsseSsesss.',
    '..ssessess..',
    '..srssssrs..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '...hhhhhh...',
    '..hhhiihhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhbbhhhh.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '....hhhh....',
    '....hhhH....',
    '.....hH.....',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hhiihhh..',
    '..hhhhhhhhh.',
    '..shhhhhhhh.',
    '..sssshhhbhh',
    '..sesssShhhh',
    '.ssesssShh.h',
    '..srssssh..h',
    '..smssss....',
    '...ssss.....',
  ],
};

const H_TEMP_CURLY: HeadSet = {
  front: [
    '..hh.hh.hh..',
    '.hhhhhhhhhh.',
    'hhhihhhhihhh',
    'hhhhhhhhhhhh',
    'hhhhssssshhh',
    'hhhsssssshhh',
    'hhssessesshh',
    'hhssessesshh',
    'hhsrssssrshh',
    '.h.ssmmsS.h.',
    '....sssS....',
  ],
  back: [
    '..hh.hh.hh..',
    '.hhhhhhhhhh.',
    'hhhhihhihhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    '.hhhhhhhhhh.',
    '..hh.hh.hh..',
  ],
  side: [
    '...hh.hh.h..',
    '..hhhhhhhhh.',
    '.hhhihhhihhh',
    '.hhhhhhhhhhh',
    '..hhhhhhhhhh',
    '..ssssshhhhh',
    '..sesssShhhh',
    '.ssesssShhhh',
    '..srsssshhhh',
    '..smsssshhh.',
    '...ssss.hh..',
  ],
};

const H_TEMP_BOB: HeadSet = {
  front: [
    '............',
    '...hhhhhh...',
    '..hiihhhhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhsssssshh.',
    '.hsseSsessh.',
    '.hssessessh.',
    '.hsrssssrsh.',
    '.hhssmmsShh.',
    '....sssS....',
  ],
  back: [
    '............',
    '...hhhhhh...',
    '..hhhiihhh..',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hHhhhhhhHh.',
    '....sssS....',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hiihhhh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhh.',
    '..sssshhhhh.',
    '..sesssShhh.',
    '.ssesssShhh.',
    '..srsssshhh.',
    '..smssshhhh.',
    '...ssss.....',
  ],
};

/** Short dark hair under a headset: band over the crown, ear cups (`b`, `z` highlight), mic boom to the mouth. */
const H_HEADSET: HeadSet = {
  front: [
    '...bbbbbb...',
    '..bhhhhhhb..',
    '.bhhhiihhhb.',
    '.bhhhhhhhhb.',
    '.hhhhhhhhhh.',
    'bbhsssssshbb',
    'zbssessessbz',
    'bbssessessbb',
    '.bssssssss..',
    '..bzsmmsS...',
    '....sssS....',
  ],
  back: [
    '...bbbbbb...',
    '..bhhiihhb..',
    '.bhhhhhhhhb.',
    '.bhhhhhhhhb.',
    '.hhhhhhhhhh.',
    'bbhhhhhhhhbb',
    'zbhhhhhhhhbz',
    'bbhhhhhhhhbb',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '....hhhbh...',
    '...hhhibhh..',
    '..hhhhhbhhh.',
    '..hhhhhbhhh.',
    '..ssssbbbhh.',
    '..sessbzbhh.',
    '.ssessbbbh..',
    '..szbbsshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

// ---------------------------------------------------------------------------
// NPC heads (the cleaner and the vendor; not offered to themes)

/** Dark hair up in a bun, held back by a red headband (`b`, `z` the knot): the cleaner. */
const H_HEADBAND: HeadSet = {
  front: [
    '....hhhh....',
    '....hiih....',
    '..hhhhhhhh..',
    '.hhhiihhhhh.',
    '.bbbbbbbbbz.',
    '.hhsssssshh.',
    '.hssessessh.',
    '.hssessessh.',
    '..srssssrs..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '....hhhh....',
    '....hhih....',
    '..hhhhhhhh..',
    '.hhhhhiihhh.',
    '.bbbbbbbbbb.',
    '.hhhhzbhhhh.',
    '.hhhhbbhhhh.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '.......hhh..',
    '......hhihh.',
    '....hhhhhhh.',
    '...hhiihhhh.',
    '..bbbbbbbbb.',
    '..sssssshbz.',
    '..sesssShhb.',
    '.ssesssShh..',
    '..srsssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

/** A white paper hat (`b`, `z` highlight) with a band in the shirt colour (`t`) over short hair: the vendor. */
const H_PAPER_HAT: HeadSet = {
  front: [
    '............',
    '....zzzz....',
    '..bbzbbzbb..',
    '.bbbbbbbbbb.',
    '.tttttttttt.',
    '.hhssssssHh.',
    '.sssessesss.',
    '.sssessesss.',
    '..ssssssss..',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '....zzzz....',
    '..bbbzzbbb..',
    '.bbbbbbbbbb.',
    '.tttttttttt.',
    '.hhhhhhhhhh.',
    '.shhhhhhhhs.',
    '.shhhhhhhhs.',
    '..hhhhhhhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '...zzzzzz...',
    '..bbzbbbbbz.',
    '..bbbbbbbbb.',
    '..ttttttttt.',
    '..sssssshhh.',
    '..sesssShhh.',
    '.ssesssShh..',
    '..sssssshh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

/** Messy, unkempt dark hair (tufts on top, shaggy over the ears) and stubble (`d`) on the jaw and lip: the scruffy IT man. */
const H_SHAGGY: HeadSet = {
  front: [
    '..h.hh..h...',
    '.hhhhhhhhhh.',
    'hhhiihhhhhhh',
    'hhhhhhhhhhhh',
    '.hhhhhhhshhh',
    '.hhsshsssshh',
    '.hsseSsesshh',
    '.hssessessh.',
    '..dssssssd..',
    '...dsmmdS...',
    '....dddd....',
  ],
  back: [
    '..h.hh..h...',
    '.hhhhhhhhhh.',
    'hhhhhiihhhhh',
    'hhhhhhhhhhhh',
    'hhhhhhhhhhhh',
    '.hhhhhhhhhhh',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '..hhHhhHhh..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '....h.hh.h..',
    '...hhhhhhhh.',
    '..hhhiihhhhh',
    '.hhhhhhhhhhh',
    '..hshhhhhhhh',
    '..sssshhhhhh',
    '..sesssShhh.',
    '.ssesssShhh.',
    '..dsssssHh..',
    '..mddsssh...',
    '...dddd.....',
  ],
};

/** Neat hair with a sharp side parting (the skin line, `s`) and big square glasses (`k` frame, `w` glint): the precise IT man. */
const H_PARTED: HeadSet = {
  front: [
    '............',
    '...hhhhhsh..',
    '..hiiiihshh.',
    '.hhhhhhhhshh',
    '.hhhhhhhhhhh',
    '.hhssssssshh',
    '.kkkkkkkkkk.',
    'skwewkkwewks',
    '.kkkkSSkkkk.',
    '...ssmmsS...',
    '....sssS....',
  ],
  back: [
    '............',
    '...hhhhhhh..',
    '..hhhiiihhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.hhhhhhhhhh.',
    '.khhhhhhhhk.',
    '.shhhhhhhhs.',
    '..sHHHHHHs..',
    '...sssssS...',
    '....sssS....',
  ],
  side: [
    '............',
    '....hhhhh...',
    '...hiiihhh..',
    '..hhhhhhhhh.',
    '..hhhhhhhhh.',
    '..ssssshhhh.',
    '.kkkkssshhh.',
    'skwekkkShhh.',
    '.kkkkssShh..',
    '..smssssh...',
    '...ssss.....',
  ],
};

// ---------------------------------------------------------------------------
// Palettes

/** Head sets by the style names a theme file uses. */
export const HEAD_SETS: Readonly<Record<string, HeadSet>> = {
  boss: H_BOSS,
  assistant: H_ASSISTANT,
  prankster: H_PRANKSTER,
  receptionist: H_RECEPTIONIST,
  crossword: H_CROSSWORD,
  cat: H_CAT,
  chili: H_CHILI,
  knitting: H_KNITTING,
  hr: H_HR,
  short: H_TEMP_SHORT,
  spiky: H_TEMP_SPIKY,
  ponytail: H_TEMP_PONY,
  curly: H_TEMP_CURLY,
  bob: H_TEMP_BOB,
  headset: H_HEADSET,
};

const SKIN = {
  fair: ['#f2c9a6', '#d9a07f'],
  rosy: ['#f0c0a2', '#d4927a'],
  warm: ['#e6b08a', '#c98d68'],
  olive: ['#cf9b6c', '#ad7b50'],
  brown: ['#a46c45', '#835232'],
  deep: ['#77492d', '#5c3620'],
} as const;

export interface Outfit {
  skin: readonly [Color, Color];
  hair: Color;
  hairHi?: Color;
  eye?: Color;
  /** Main shirt / top colour. */
  shirt: Color;
  /** Outer layer (jacket, cardigan, vest). Defaults to shirt. */
  outer?: Color;
  /** Sleeve colour. Defaults to outer. */
  sleeve?: Color;
  tie?: Color;
  collar?: Color;
  accent?: Color;
  accent2?: Color;
  pants: Color;
  shoes: Color;
  belt?: Color;
  legs?: Color;
  glasses?: Color;
  facial?: Color;
  bow?: Color;
  /** Rubber gloves: when set, hands and forearms (`s`, `l`, `L` in the arms) are drawn in this colour (keys `y`, `Y`). NPC looks only. */
  gloves?: Color;
}

function palette(o: Outfit, shortSleeves: boolean): Palette {
  const outer = o.outer ?? o.shirt;
  const sleeve = o.sleeve ?? outer;
  const [s, S] = o.skin;
  return {
    s, S,
    r: mix(s, '#e0786c', 0.3),
    h: o.hair,
    H: darken(o.hair, 0.28),
    i: o.hairHi ?? lighten(o.hair, 0.22),
    e: o.eye ?? '#2a1d22',
    m: darken(S, 0.35),
    M: '#5a2228',
    k: o.glasses ?? '#3a3036',
    w: '#b9d3dc',
    d: o.facial ?? darken(o.hair, 0.1),
    b: o.bow ?? darken(o.hair, 0.35),
    z: lighten(o.bow ?? darken(o.hair, 0.35), 0.3),
    t: o.shirt,
    T: darken(o.shirt, 0.18),
    j: outer,
    J: darken(outer, 0.2),
    a: sleeve,
    A: darken(sleeve, 0.18),
    l: shortSleeves ? s : sleeve,
    L: shortSleeves ? S : darken(sleeve, 0.12),
    n: o.tie ?? o.shirt,
    N: darken(o.tie ?? o.shirt, 0.2),
    c: o.collar ?? lighten(o.shirt, 0.25),
    x: o.accent ?? darken(outer, 0.15),
    X: o.accent2 ?? o.accent ?? darken(outer, 0.15),
    u: darken(outer, 0.4),
    p: o.pants,
    P: darken(o.pants, 0.22),
    g: o.legs ?? s,
    f: o.shoes,
    F: darken(o.shoes, 0.25),
    B: o.belt ?? '#3b2c22',
    ...(o.gloves ? { y: o.gloves, Y: darken(o.gloves, 0.22) } : {}),
  };
}

function look(
  id: LookId,
  role: string,
  build: Build,
  torso: TorsoStyle,
  head: HeadSet,
  outfit: Outfit,
  opts: { skirt?: boolean; shortSleeves?: boolean; belt?: boolean; lanyard?: boolean } = {},
): LookDef {
  const shortSleeves = opts.shortSleeves ?? false;
  const def: LookDef = {
    id,
    role,
    build,
    torso,
    head,
    skirt: opts.skirt ?? false,
    shortSleeves,
    belt: opts.belt ?? false,
    outfit,
    pal: palette(outfit, shortSleeves),
  };
  if (opts.lanyard) def.lanyard = true;
  return def;
}

/** All look definitions, keyed by id. */
export const LOOKS: Readonly<Record<string, LookDef>> = {
  manager: look('manager', 'Regional Manager', 'normal', 'suit', H_BOSS, {
    skin: SKIN.fair, hair: '#3a2a24', shirt: '#eeeee8', outer: '#353a4a', tie: '#9a2f3c',
    pants: '#353a4a', shoes: '#1f1c22',
  }),
  assistant: look('assistant', 'Deputy Vice Associate', 'normal', 'shirtTie', H_ASSISTANT, {
    skin: SKIN.rosy, hair: '#6e4b2c', shirt: '#cfa53a', tie: '#5b3b26', collar: '#dcb655',
    pants: '#4d453a', shoes: '#2a221c', glasses: '#4a3a2c',
  }, { shortSleeves: true, belt: true }),
  prankster: look('prankster', 'Salesman', 'tall', 'looseTie', H_PRANKSTER, {
    skin: SKIN.fair, hair: '#7d5232', shirt: '#b3cbe3', outer: '#5c6578', tie: '#2f3654',
    pants: '#474c58', shoes: '#2b2622',
  }),
  receptionist: look('receptionist', 'Receptionist', 'normal', 'openCardigan', H_RECEPTIONIST, {
    skin: SKIN.warm, hair: '#a65334', hairHi: '#c8714a', shirt: '#efe6d3', outer: '#c4899b',
    pants: '#5a5d70', shoes: '#4a2f24', legs: '#d5a585',
  }, { skirt: true }),
  helpdesk: look('helpdesk', 'IT Help Desk', 'normal', 'polo', H_HEADSET, {
    skin: SKIN.olive, hair: '#5b3a26', shirt: '#34587f', collar: '#4d74a0', accent: '#c4453b', accent2: '#eef0ea',
    pants: '#9a8862', shoes: '#3a2c22', bow: '#2c2b31',
  }, { shortSleeves: true, belt: true, lanyard: true }),
  crossword: look('crossword', 'Accountant (crosswords)', 'normal', 'vest', H_CROSSWORD, {
    skin: SKIN.deep, hair: '#8f8a86', facial: '#6f6a66', shirt: '#dfe5ec', outer: '#7c4a3a',
    sleeve: '#dfe5ec', tie: '#3d4f7c', pants: '#45454c', shoes: '#22201f', glasses: '#4a3a2a',
  }, { belt: true }),
  cat: look('cat', 'Accountant (cats)', 'small', 'buttonCardigan', H_CAT, {
    skin: SKIN.fair, hair: '#e3c376', hairHi: '#f4dea0', shirt: '#f4f0e6', outer: '#b6a3cc',
    collar: '#f7f4ec', pants: '#5e4c6b', shoes: '#3a2a30', legs: '#e9cdb4', bow: '#c9a75a',
  }, { skirt: true }),
  chili: look('chili', 'Accountant (chili)', 'big', 'shirtTie', H_CHILI, {
    skin: SKIN.rosy, hair: '#8a6a4c', shirt: '#9fb2d2', tie: '#7a3846', pants: '#8b7b5f',
    shoes: '#3a2c22',
  }, { belt: true }),
  knitting: look('knitting', 'Saleswoman (knitting)', 'normal', 'floral', H_KNITTING, {
    skin: SKIN.fair, hair: '#cbbb98', hairHi: '#e2d6b8', shirt: '#7d9b6c', accent: '#f0c2cf',
    accent2: '#f6e7a6', pants: '#58644f', shoes: '#4a3a2c', legs: '#e0b896',
  }, { skirt: true }),
  hr: look('hr', 'HR Representative', 'normal', 'openCardigan', H_HR, {
    skin: SKIN.fair, hair: '#5e4e42', facial: '#7a6656', shirt: '#cdd8e3', outer: '#c4b08a',
    pants: '#5b5650', shoes: '#33291f',
  }),
  temp0: look('temp0', 'Temp', 'normal', 'polo', H_TEMP_SHORT, {
    skin: SKIN.warm, hair: '#5b3a22', shirt: '#4f8f6a', collar: '#6aa985', pants: '#8f7e60', shoes: '#3a2c22',
  }, { shortSleeves: true, belt: true }),
  temp1: look('temp1', 'Temp', 'normal', 'blouse', H_TEMP_PONY, {
    skin: SKIN.olive, hair: '#231c22', shirt: '#eceae2', pants: '#2f3a5a', shoes: '#1f1c22', legs: '#c28f62',
    bow: '#7a3a52',
  }, { skirt: true }),
  temp2: look('temp2', 'Temp', 'normal', 'shirtTie', H_TEMP_SHORT, {
    skin: SKIN.deep, hair: '#1e1719', shirt: '#93b6da', tie: '#a8432f', pants: '#43464f', shoes: '#1f1c22',
  }, { belt: true }),
  temp3: look('temp3', 'Temp', 'normal', 'plain', H_TEMP_CURLY, {
    skin: SKIN.fair, hair: '#b14f2c', hairHi: '#d06c42', shirt: '#3f8c8d', pants: '#3a3540', shoes: '#2b2226',
  }),
  temp4: look('temp4', 'Temp', 'normal', 'plain', H_TEMP_SPIKY, {
    skin: SKIN.rosy, hair: '#d9b85a', hairHi: '#f0d889', shirt: '#b5653d', pants: '#4a4f5c', shoes: '#2b2622',
  }),
  temp5: look('temp5', 'Temp', 'small', 'blouse', H_TEMP_BOB, {
    skin: SKIN.brown, hair: '#3a2420', shirt: '#7d5ba6', pants: '#4b4b55', shoes: '#22202a', legs: '#8f5b3a',
  }),
};

// ---------------------------------------------------------------------------
// NPC looks: walk-on characters the office draws itself. They live outside `LOOKS` (and `ALL_LOOKS`), so the
// Front desk's Staff tab never offers them and no theme slot inherits them; `characters.ts` registers them.

/** Id of the cleaner's look (tabard, headband and bun, yellow rubber gloves, a bucket). */
export const CLEANER_LOOK = 'cleaner';
/** Id of the food-cart vendor's look (paper hat, white bib apron over a red shirt). */
export const VENDOR_LOOK = 'vendor';

/** Id of the scruffy IT man's look (messy hair, stubble, a dark tee with a little space-ship on it, jeans, trainers; slouches). */
export const DEZ_LOOK = 'dez';
/** Id of the precise IT man's look (side parting, big glasses, short-sleeved shirt and tie, trousers worn high; tall and upright). */
export const FENWICK_LOOK = 'fenwick';
/** The IT pair's job title: single-sourced in `src/shared/itSupport.ts`, re-exported here for the art's callers. */
export { IT_SUPPORT_ROLE };

/** The NPC looks, keyed by id. */
export const NPC_LOOKS: Readonly<Record<string, LookDef>> = {
  cleaner: { ...look(CLEANER_LOOK, 'Cleaner', 'normal', 'tabard', H_HEADBAND, {
    skin: SKIN.fair, hair: '#2a1d1c', shirt: '#d9d3e4', sleeve: '#d9d3e4', outer: '#3d8fd1', collar: '#eeeaf4',
    accent: '#e9f1f7', accent2: '#2e6fa6', pants: '#3a3d52', shoes: '#ecebe4', bow: '#c8423a', gloves: '#f2cf3a',
  }, { shortSleeves: true }), carry: 'bucket' },
  vendor: look(VENDOR_LOOK, 'Food cart', 'big', 'apron', H_PAPER_HAT, {
    skin: SKIN.warm, hair: '#4a3226', shirt: '#c0443a', outer: '#f3efe4', sleeve: '#c0443a',
    accent: '#d8d2c2', pants: '#f3efe4', legs: '#3b3f4c', shoes: '#2a2422', bow: '#f6f3ea',
  }, { skirt: true }),
  dez: { ...look(DEZ_LOOK, IT_SUPPORT_ROLE, 'normal', 'tee', H_SHAGGY, {
    skin: SKIN.warm, hair: '#2a201d', hairHi: '#4a3a33', facial: mix(SKIN.warm[1], '#2a201d', 0.45), shirt: '#34343e', collar: '#4a4a56',
    accent: '#e8dfb8', pants: '#46628c', shoes: '#e2dfd4',
  }, { shortSleeves: true }), slouch: true },
  fenwick: { ...look(FENWICK_LOOK, IT_SUPPORT_ROLE, 'tall', 'pocketTie', H_PARTED, {
    skin: SKIN.fair, hair: '#5e4430', hairHi: '#7d5d42', shirt: '#e4ebe6', collar: '#f6f8f4', tie: '#2c3552',
    accent: '#2f5fb0', accent2: '#c23b3b', pants: '#7a6a4e', shoes: '#2e2019', belt: '#2a2220', glasses: '#5a5464',
  }, { shortSleeves: true, belt: true }), highWaist: true },
};

/** NPC look ids, in a fixed order (for galleries and cache warming). */
export const NPC_LOOK_IDS: readonly LookId[] = [CLEANER_LOOK, VENDOR_LOOK, DEZ_LOOK, FENWICK_LOOK];

// ---------------------------------------------------------------------------
// Custom looks and slots

/** Input to `buildLook`: the same fields as a theme's look spec, typed loosely. The host validates them. */
export interface LookSpecLike {
  head?: string;
  build?: string;
  outfit?: string;
  skin?: string;
  hair?: string;
  hairHighlight?: string;
  eye?: string;
  shirt?: string;
  outer?: string;
  sleeve?: string;
  tie?: string;
  collar?: string;
  accent?: string;
  accent2?: string;
  pants?: string;
  legs?: string;
  shoes?: string;
  glasses?: string;
  facialHair?: string;
  bow?: string;
  beltColor?: string;
  skirt?: boolean;
  shortSleeves?: boolean;
  belt?: boolean;
}

const BUILD_NAMES: readonly string[] = ['normal', 'tall', 'small', 'big'];
const TORSO_NAMES: readonly string[] = ['suit', 'shirtTie', 'looseTie', 'cardigan', 'buttonCardigan', 'vest', 'floral', 'openCardigan', 'plain', 'polo', 'blouse'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Builds a look from a spec, starting from `fallback` (role, build, torso, head, flags and outfit
 * colours) and overriding whatever the spec provides. The palette is re-derived the same way the
 * built-ins are. Unknown head, skin, build and outfit names keep the fallback's value.
 */
export function buildLook(id: string, spec: LookSpecLike, fallback: LookDef): LookDef {
  const o: Outfit = { ...fallback.outfit };
  const colour = <K extends keyof Outfit>(key: K, v: unknown): void => {
    const c = str(v);
    if (c !== undefined) (o as unknown as Record<string, unknown>)[key] = c;
  };
  colour('hair', spec.hair);
  // A new hair colour without its own highlight re-derives the highlight instead of keeping the old one.
  if (str(spec.hair) !== undefined && str(spec.hairHighlight) === undefined) delete o.hairHi;
  colour('hairHi', spec.hairHighlight);
  colour('eye', spec.eye);
  colour('shirt', spec.shirt);
  colour('outer', spec.outer);
  colour('sleeve', spec.sleeve);
  colour('tie', spec.tie);
  colour('collar', spec.collar);
  colour('accent', spec.accent);
  colour('accent2', spec.accent2);
  colour('pants', spec.pants);
  colour('legs', spec.legs);
  colour('shoes', spec.shoes);
  colour('glasses', spec.glasses);
  colour('facial', spec.facialHair);
  colour('bow', spec.bow);
  colour('belt', spec.beltColor);
  if (typeof spec.skin === 'string' && Object.hasOwn(SKIN, spec.skin)) o.skin = SKIN[spec.skin as keyof typeof SKIN];
  const shortSleeves = typeof spec.shortSleeves === 'boolean' ? spec.shortSleeves : fallback.shortSleeves;
  const build = typeof spec.build === 'string' && BUILD_NAMES.includes(spec.build) ? (spec.build as Build) : fallback.build;
  const torso = typeof spec.outfit === 'string' && TORSO_NAMES.includes(spec.outfit) ? (spec.outfit as TorsoStyle) : fallback.torso;
  const head = typeof spec.head === 'string' && Object.hasOwn(HEAD_SETS, spec.head) ? HEAD_SETS[spec.head]! : fallback.head;
  const def: LookDef = {
    id,
    role: fallback.role,
    build,
    torso,
    skirt: typeof spec.skirt === 'boolean' ? spec.skirt : fallback.skirt,
    shortSleeves,
    belt: typeof spec.belt === 'boolean' ? spec.belt : fallback.belt,
    head,
    outfit: o,
    pal: palette(o, shortSleeves),
  };
  if (fallback.lanyard) def.lanyard = true;
  return def;
}

/** The built-in look a slot inherits (`staff-i` -> `ARCHETYPES[i]`, `temp-j` -> `temp<j>`), with `id` set to the slot id. */
export function defaultSlotLook(slotId: string): LookDef {
  const s = STAFF_SLOT_IDS.indexOf(slotId);
  const t = TEMP_SLOT_IDS.indexOf(slotId);
  const base = s >= 0 ? LOOKS[ARCHETYPES[s]!] : t >= 0 ? LOOKS[TEMP_LOOKS[t]!] : undefined;
  if (!base) throw new RangeError(`not a slot id: ${slotId}`);
  return { ...base, id: slotId };
}

// ---------------------------------------------------------------------------
// Look specs of the built-ins (the inverse of buildLook)

/** Outfit colour -> the theme look-spec field that sets it. */
const OUTFIT_SPEC_FIELDS: readonly (readonly [keyof Outfit, keyof LookSpec])[] = [
  ['hair', 'hair'], ['hairHi', 'hairHighlight'], ['eye', 'eye'], ['shirt', 'shirt'], ['outer', 'outer'], ['sleeve', 'sleeve'],
  ['tie', 'tie'], ['collar', 'collar'], ['accent', 'accent'], ['accent2', 'accent2'], ['pants', 'pants'], ['legs', 'legs'],
  ['shoes', 'shoes'], ['glasses', 'glasses'], ['facial', 'facialHair'], ['bow', 'bow'], ['belt', 'beltColor'],
];

/** Every colour field of a look spec, in spec order. */
export const LOOK_COLOUR_FIELDS: readonly (keyof LookSpec)[] = OUTFIT_SPEC_FIELDS.map(([, f]) => f);

/**
 * The look spec that reproduces `def` through `buildLook`: head style, skin
 * tone, build, outfit, every colour the look sets explicitly (derived ones
 * such as an unset `outer` stay out) and the three flags. A head or skin that
 * isn't one of the named ones is left out.
 */
export function specOfDef(def: LookDef): LookSpec {
  const spec: Record<string, unknown> = {};
  const head = Object.keys(HEAD_SETS).find((k) => HEAD_SETS[k] === def.head);
  if (head !== undefined) spec.head = head;
  const skin = (Object.keys(SKIN) as (keyof typeof SKIN)[]).find((k) => SKIN[k][0] === def.outfit.skin[0] && SKIN[k][1] === def.outfit.skin[1]);
  if (skin !== undefined) spec.skin = skin;
  spec.build = def.build;
  spec.outfit = def.torso;
  for (const [key, field] of OUTFIT_SPEC_FIELDS) {
    const v = def.outfit[key];
    if (typeof v === 'string') spec[field] = v;
  }
  spec.skirt = def.skirt;
  spec.shortSleeves = def.shortSleeves;
  spec.belt = def.belt;
  return spec as LookSpec;
}

/** The look spec of a built-in look id (`manager`, `receptionist`, an archetype or `temp0`-`temp5`); `{}` for anything else. */
export function specOfLook(id: string): LookSpec {
  const def = Object.hasOwn(LOOKS, id) ? LOOKS[id] : undefined;
  return def ? specOfDef(def) : {};
}

/**
 * The built-in look a Front-desk slot inherits: `manager` and `receptionist`
 * are themselves, `staff-i` is `ARCHETYPES[i]`, `temp-j` is `temp<j>`.
 * Undefined for anything else (the sign, unknown ids).
 */
export function builtinLookIdOf(slotId: string): string | undefined {
  if (slotId === MANAGER_LOOK || slotId === RECEPTIONIST_LOOK) return slotId;
  const s = STAFF_SLOT_IDS.indexOf(slotId);
  if (s >= 0) return ARCHETYPES[s];
  const t = TEMP_SLOT_IDS.indexOf(slotId);
  if (t >= 0) return TEMP_LOOKS[t];
  return undefined;
}

/** The Staff editor's inherited values for a slot (see `builtinLookIdOf`); `{}` when the slot has no look. */
export function builtinSpecOf(slotId: string): LookSpec {
  const id = builtinLookIdOf(slotId);
  return id === undefined ? {} : specOfLook(id);
}
