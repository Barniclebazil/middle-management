/**
 * Builds `media/theme-guide.md`, the theme-writing guide shipped for Claude (the "Teach Claude" skill installs a copy
 * as `guide.md`, and "Copy a prompt" points at it). The prose lives in `dev/theme-guide.template.md`; every table comes
 * from the code (`src/shared/theme.ts`, the built-in lines, the palette, the Front desk's labels and the built-in looks),
 * so the guide cannot drift from what `parseTheme` accepts and what the office draws.
 *
 *   node --experimental-strip-types --no-warnings dev/theme-guide.ts           write media/theme-guide.md
 *   node --experimental-strip-types --no-warnings dev/theme-guide.ts --check   exit 1 if the committed file is stale
 *
 * `buildGuide()` is deterministic (no dates, fixed orders) and throws when the data and the hand-written tables below
 * disagree (a new head style without a description, an example theme that no longer parses, a non-ASCII character).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILDS, FURNITURE_COLOR_KEYS, HEAD_STYLES, LINE_POOL_INFO, LINE_POOL_KEYS, LINE_POOL_KIND, OFFICE_COLOR_KEYS, OUTFITS, ROOM_COLOR_KEYS,
  SKIN_TONES, THEME_LIMITS, TITLE_KEYS, parseTheme,
} from '../src/shared/theme.ts';
import type { HeadStyle, LinePoolKey, LookSpec, OfficeColorKey, Outfit, TitleKey } from '../src/shared/theme.ts';
import { LINE_POOLS, SMALL_TALK } from '../webview/engine/lines.ts';
import { BASE_C, OFFICE_COLOR_SHADES } from '../webview/art/palette.ts';
import { IT_SUPPORT_ROLE, LOOKS, NPC_LOOKS } from '../webview/art/looks.ts';
import { COLOUR_GROUPS } from '../webview/engine/frontDeskStaffView.ts';
import { DEFAULT_STAFF_ROLES, LOOK_FIELDS } from '../webview/engine/frontDeskLogic.ts';
import { bannedIn, oddCaps } from './lineCheck.ts';

const TEMPLATE_PATH = fileURLToPath(new URL('./theme-guide.template.md', import.meta.url));
export const GUIDE_PATH = fileURLToPath(new URL('../media/theme-guide.md', import.meta.url));

const L = THEME_LIMITS;

// ---------------------------------------------------------------------------------------------------------------------
// Hand-written data (checked against the code constants in buildGuide)

/** Suggested counts for a replace-mode pool, so it does not repeat too often. Pools not named get `SUGGESTED_DEFAULT`. */
const SUGGESTED_COUNTS: readonly { count: string; pools: readonly LinePoolKey[] }[] = [
  // Said once per event: one good line is enough, a few give variety.
  { count: '1-3', pools: ['bossSnoop', 'receptionAttending', 'itFix'] },
  // The chatter people hear all day.
  { count: '20-40', pools: ['bossVisit', 'receptionPhone', 'receptionIdle', 'cleanerMutters', 'chatReplies', 'cartCalls'] },
];
const SUGGESTED_DEFAULT = '8-15';
const SMALL_TALK_SUGGESTED = '60-200';

/** The top-level fields, in the order the Front desk saves them. */
const FIELDS: readonly { key: string; what: string; limit: string }[] = [
  { key: 'name', what: 'The theme\'s name in "Your offices"', limit: `${L.name} characters` },
  { key: 'description', what: 'One sentence under the name in "Your offices"', limit: `${L.description} characters` },
  { key: 'company', what: 'Top line of the wall sign in the lobby', limit: `${L.name} characters` },
  { key: 'branch', what: 'Second line of the wall sign', limit: `${L.name} characters` },
  { key: 'lineMode', what: '`"add"` or `"replace"`: what your lines do to the built-in ones (section 3)', limit: '-' },
  { key: 'titles', what: 'Job titles of the manager, receptionist, cleaner, temps, vendor and IT crew (section 6)', limit: `${L.title} characters each` },
  { key: 'manager', what: 'The boss (the user): `{ "name", "look" }` (section 7)', limit: `name ${L.name} characters` },
  { key: 'receptionist', what: 'The receptionist at the front desk: `{ "name", "look" }`', limit: `name ${L.name} characters` },
  { key: 'cleaner', what: 'The cleaner: `{ "name", "look" }`', limit: `name ${L.name} characters` },
  { key: 'vendor', what: 'The food trolley vendor: `{ "name", "look" }`', limit: `name ${L.name} characters` },
  { key: 'itFixer', what: 'The IT fixer: `{ "name", "look" }`', limit: `name ${L.name} characters` },
  { key: 'itCritic', what: 'The IT critic: `{ "name", "look" }`', limit: `name ${L.name} characters` },
  { key: 'colors', what: 'Room and furniture colours, `#rrggbb` (section 9)', limit: `${OFFICE_COLOR_KEYS.length} keys` },
  { key: 'lines', what: 'What people say, by pool (section 4)', limit: `${L.lines} entries per pool, ${L.line} characters per line` },
  { key: 'smallTalk', what: 'Water-cooler `[opener, reply]` pairs (section 5)', limit: `${L.smallTalk} pairs, ${L.line} characters per line` },
  { key: 'staff', what: 'The desk workers: name, role, look and chat openers (section 7)', limit: `${L.staff} entries; role ${L.role} characters` },
  { key: 'temps', what: 'Looks for the temps: name and look (section 7)', limit: `${L.temps} entries` },
];

/** Who carries each title. */
const TITLE_WHO: Readonly<Record<TitleKey, string>> = {
  manager: 'The manager (the user)',
  receptionist: 'The receptionist',
  cleaner: 'The cleaner',
  temp: 'Every temp',
  vendor: 'The food trolley vendor',
  itSupport: 'Both of the IT crew',
};

/** Where each staff slot's desk is. */
const SLOT_DESKS: readonly string[] = [
  "Right end of the open-plan row, just outside the manager's glass office",
  'Next to slot 1, one desk to the left',
  'The IT help desk, in the middle of the bottom row',
  'Left side of the open-plan row',
  'Bottom-left corner, first desk',
  'Bottom-left corner, second desk',
  'Open-plan row, between slots 4 and 2',
  'The annex on the right, beside the temps',
];

const HEAD_NOTES: Readonly<Record<HeadStyle, string>> = {
  boss: 'Short hair with a side parting',
  assistant: 'Short hair with a full fringe, and glasses',
  prankster: 'Tousled hair with a tuft on top, swept to one side',
  receptionist: 'Long hair falling past the chin on both sides',
  crossword: 'Bald on top, hair at the sides, glasses and a short beard',
  cat: 'Rounded hair with a small bow on top',
  chili: 'Thin, short hair, high forehead and a broad face',
  knitting: 'Full, fluffy hair with a fringe, wide at the sides',
  hr: 'Bald on top, hair at the sides and a full beard',
  short: 'Short, simple haircut',
  spiky: 'Short spiky hair',
  ponytail: 'Hair tied back in a ponytail',
  curly: 'Big curly hair all round the face',
  bob: 'Chin-length bob covering the ears',
  headset: 'Short hair under a headset with a microphone',
};

const OUTFIT_NOTES: Readonly<Record<Outfit, string>> = {
  suit: 'Buttoned jacket over a shirt and tie',
  shirtTie: 'Shirt, collar and tie, no jacket',
  looseTie: 'Jacket over a shirt with a loosened, crooked tie',
  cardigan: 'Cardigan with the shirt showing down the middle',
  buttonCardigan: 'Cardigan buttoned all the way up',
  vest: 'Waistcoat with buttons over a shirt and tie',
  floral: 'Top with an all-over flower pattern (`accent`, `accent2`)',
  openCardigan: 'Open cardigan over a top',
  plain: 'Plain top with a collar band',
  polo: 'Polo shirt with a button placket',
  blouse: 'Plain blouse with a small collar',
};

/** What each look colour and switch sets. */
const LOOK_NOTES: Readonly<Record<keyof LookSpec, string>> = {
  head: '', build: '', outfit: '', skin: '',
  hair: 'Hair',
  hairHighlight: 'Lighter streaks in the hair (worked out from `hair` if left out)',
  eye: 'Eyes',
  shirt: 'Shirt, blouse or top',
  outer: 'Jacket, cardigan or waistcoat',
  sleeve: 'Sleeves (default: the same as `outer`)',
  tie: 'Tie',
  collar: 'Shirt collar',
  accent: 'Pattern of `floral`, buttons on a `vest`',
  accent2: 'Second pattern colour of `floral`',
  pants: 'Trousers, or the skirt',
  legs: 'Bare legs below a skirt',
  shoes: 'Shoes',
  glasses: 'Glasses frames, on heads that have glasses',
  facialHair: 'Beard or moustache, on heads that have one',
  bow: 'Hair bow or clip, or the headset, on heads that have one',
  beltColor: 'Belt (shown when `belt` is true)',
  skirt: 'A skirt instead of trousers',
  shortSleeves: 'Bare forearms',
  belt: 'Shirt tucked in, with a belt',
};

/** What each office colour paints, beyond its Front desk label. */
const COLOUR_NOTES: Readonly<Record<OfficeColorKey, string>> = {
  wall: 'Every wall face and wall top',
  trim: 'Skirting boards along the walls',
  ceiling: 'The ceiling strip along the top wall',
  carpet: 'The main open-plan floor under most desks',
  lobbyFloor: 'Lobby tiles by the lift and the front desk',
  kitchenFloor: 'Kitchen tiles',
  conferenceFloor: 'Conference room floor',
  managerFloor: "Manager's office floor",
  annexFloor: 'Annex floor, where the temps sit',
  rug: "Rug in the manager's office",
  rugBorder: "Border of the manager's rug",
  deskChairs: 'Every desk chair',
  kitchenChairs: 'Chairs at the kitchen table',
  managerChair: "The manager's chair",
  signPlate: 'Plate of the wall sign in the lobby',
  signText: 'Company name on the sign (`company`)',
  signBranch: 'Branch name on the sign (`branch`)',
  desks: 'Desk tops',
  deskPanels: 'Side panels of the desks',
  wood: 'Front counter, kitchen counter and other light wood',
  darkWood: "The manager's desk and the conference table",
  metal: 'Filing cabinets, desk drawers and other metal',
  computers: 'Monitor cases and the copier',
  screens: 'Monitor screens when switched off',
  plants: 'Leaves of the pot plants',
  plantPots: 'Plant pots',
  glass: "Glass walls of the manager's office",
  glassFrames: 'Frames of the glass walls',
  blinds: 'Blinds on the windows and the glass walls',
  windowFrames: 'Window frames on the top wall',
  sky: 'Sky through the windows',
  skyline: 'Skyline in front of the sky',
  ceilingLights: 'Ceiling light panels and their glow',
  outside: 'The dark strip around the outside of the building',
};

/** The example theme: a small, complete, original office. buildGuide checks that it parses with no errors. */
const EXAMPLE_JSON = `{
  "name": "Lighthouse Crew",
  "description": "Keepers, lamp trimmers and fog signals on a windy headland.",
  "company": "Gullrock Light",
  "branch": "North Headland Station",
  "lineMode": "replace",
  "titles": {
    "manager": "Head Keeper",
    "receptionist": "Signal Clerk",
    "cleaner": "Brass Polisher",
    "temp": "Relief Keeper",
    "vendor": "Chowder Cart",
    "itSupport": "Lamp Engineer"
  },
  "manager": {
    "name": "Agatha Pell",
    "look": { "head": "bob", "outfit": "vest", "build": "tall", "skin": "rosy", "hair": "#c9c4bc", "shirt": "#e8e4da", "outer": "#1f2f45", "tie": "#b8862f", "pants": "#1f2f45" }
  },
  "receptionist": {
    "name": "Hetty Larkspur",
    "look": { "head": "headset", "outfit": "buttonCardigan", "skin": "olive", "hair": "#3b2a22", "outer": "#7c9a8f", "shirt": "#f1ece0" }
  },
  "cleaner": { "name": "Barnaby Salt", "look": { "skin": "deep", "outer": "#2f5f7a" } },
  "vendor": { "name": "Maud Trevose", "look": { "shirt": "#2f6f6a" } },
  "itFixer": { "name": "Sully Cogsworth", "look": { "shirt": "#3e3a32", "pants": "#4a5a6a" } },
  "itCritic": { "name": "Percival Drane", "look": { "shirt": "#e6e2d6", "tie": "#7a2f2f" } },
  "colors": {
    "wall": "#d8d2c4",
    "trim": "#3c4a56",
    "carpet": "#4a5f6e",
    "lobbyFloor": "#a89c84",
    "signPlate": "#1f3442",
    "signText": "#f4e7c1",
    "signBranch": "#9fb8c4",
    "desks": "#c9b48f",
    "darkWood": "#4e3a2a",
    "sky": "#8fa9ba",
    "skyline": "#4d5f6b",
    "ceilingLights": "#fff2c4"
  },
  "lines": {
    "bossVisit": ["Keep that lamp log tidy. The sea is watching.", "Steady hands, steady light!", "Is the fog horn meant to sound sad?"],
    "bossSnoop": ["Mind the wick. Mind everything, really."],
    "receptionPhone": ["Gullrock Light, keepers' desk.", "A ship asking if we're open. We're always open."],
    "receptionGreeting": ["Welcome ashore! Wipe your boots, it's all brine."],
    "receptionIdle": ["Tide's turning. So is my stomach.", "Forty gulls on the rail. I counted."],
    "receptionAttending": ["New course? Tell me where to steer."],
    "cleanerMutters": ["Salt on every surface. Every single one.", "Who tracked seaweed up the spiral stairs?"],
    "cartCalls": ["Hot chowder! Warms you to the bootlaces!", "Kippers, crackers and very strong tea!"],
    "itFix": ["Right. Let's see what the lamp has been up to."],
    "itFixerTalk": [["Foggy out. Good day for cables.", "Every day is a good day for cables."]]
  },
  "smallTalk": [
    ["Did the fog horn go off again?", "Twice. Once for a ship, once for a cow."],
    ["Who keeps moving the logbook?", "The logbook moves itself. It wants to be read."],
    ["Storm coming in tonight.", "Good. The lamp likes an audience."]
  ],
  "staff": [
    {
      "name": "Ida Penhallow",
      "role": "Lamp Trimmer",
      "look": { "head": "ponytail", "outfit": "plain", "skin": "fair", "hair": "#b5652f", "shirt": "#e9e1cf", "pants": "#3a4652" },
      "lines": ["The wick is perfect. Nobody touch the wick."]
    },
    {},
    {
      "name": "Ansel Brickworth",
      "role": "Tide Clerk",
      "look": { "head": "crossword", "outfit": "looseTie", "build": "big", "skin": "brown", "outer": "#5a4a3a", "tie": "#2f6f6a" },
      "lines": ["High water at four. I'm wearing my good boots."]
    }
  ],
  "temps": [{ "name": "Nell Gorran", "look": { "head": "spiky", "outfit": "polo", "shirt": "#c7a23a" } }]
}`;

// ---------------------------------------------------------------------------------------------------------------------
// Built-in samples

/** Longest built-in line shown as a sample. */
const SAMPLE_MAX = 70;
/**
 * Words that keep a built-in line out of the samples: swearing, real names some built-in lines use for colour, and a
 * stock IT catchphrase the guide should not hold up as an example.
 */
const SAMPLE_AVOID = /\b(bastards?|bloody|damn|hell|crap|arse|bugger|sod|vista|arsenal|off and on again)\b/i;

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

function goodSample(s: string): boolean {
  return s.length <= SAMPLE_MAX && isPrintableAscii(s) && !SAMPLE_AVOID.test(s) && !bannedIn(s).length && !oddCaps(s).length && !s.includes('|');
}

/** Up to `n` samples spread evenly over the usable entries, in their built-in order. */
function pickSamples<T>(entries: readonly T[], ok: (e: T) => boolean, n: number): T[] {
  const usable = entries.filter(ok);
  const out: T[] = [];
  for (let i = 0; i < n && i < usable.length; i++) out.push(usable[Math.floor((i * usable.length) / n)]!);
  return out;
}

function showPair([a, b]: readonly [string, string]): string {
  return `[${JSON.stringify(a)}, ${JSON.stringify(b)}]`;
}

function poolSamples(key: LinePoolKey): string {
  const pool: readonly unknown[] = LINE_POOLS[key];
  if (LINE_POOL_KIND[key] === 'pairs') {
    const pairs = pool as readonly (readonly [string, string])[];
    return pickSamples(pairs, ([a, b]) => goodSample(a) && goodSample(b), 2).map(showPair).join('<br>') || '-';
  }
  return pickSamples(pool as readonly string[], goodSample, 3).map((s) => JSON.stringify(s)).join('<br>') || '-';
}

// ---------------------------------------------------------------------------------------------------------------------
// Tables

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

const code = (s: string): string => `\`${s}\``;

function suggestedCount(key: LinePoolKey): string {
  return SUGGESTED_COUNTS.find((g) => g.pools.includes(key))?.count ?? SUGGESTED_DEFAULT;
}

/** Curly quotes and the like in UI labels, folded to the ASCII the guide promises. */
function asciiFold(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...');
}

function fieldsTable(): string {
  return table(['Field', 'What it holds', 'Limit'], FIELDS.map((f) => [code(f.key), f.what, f.limit]));
}

function poolsTable(): string {
  return table(
    ['Pool', 'Kind', 'Who says it', 'When', 'Built-in', 'Suggested', 'Built-in samples'],
    LINE_POOL_KEYS.map((k) => [code(k), LINE_POOL_KIND[k], LINE_POOL_INFO[k].who, LINE_POOL_INFO[k].when, String(LINE_POOLS[k].length), suggestedCount(k), poolSamples(k)]),
  );
}

function builtinTitles(): Record<TitleKey, string> {
  const role = (look: { role: string } | undefined, what: string): string => {
    if (!look) throw new Error(`theme-guide: no built-in look for ${what}`);
    return look.role;
  };
  return {
    manager: role(LOOKS.manager, 'the manager'),
    receptionist: role(LOOKS.receptionist, 'the receptionist'),
    cleaner: role(NPC_LOOKS.cleaner, 'the cleaner'),
    temp: role(LOOKS.temp0, 'a temp'),
    vendor: role(NPC_LOOKS.vendor, 'the vendor'),
    itSupport: IT_SUPPORT_ROLE,
  };
}

function titlesTable(): string {
  const builtin = builtinTitles();
  return table(['Key', 'Who', 'Built-in title'], TITLE_KEYS.map((k) => [code(k), TITLE_WHO[k], builtin[k]]));
}

function slotsTable(): string {
  return table(['Slot', 'Entry', 'Desk', 'Built-in role'], SLOT_DESKS.map((desk, i) => [String(i + 1), `staff[${i}]`, desk, DEFAULT_STAFF_ROLES[i]!]));
}

function lookTable(kind: 'colour' | 'boolean'): string {
  return table(['Key', 'What it sets'], LOOK_FIELDS.filter((f) => f.kind === kind).map((f) => [code(f.key), LOOK_NOTES[f.key]]));
}

function coloursTable(): string {
  const label = new Map<string, string>();
  for (const g of COLOUR_GROUPS) for (const [key, name] of g.keys) label.set(key, asciiFold(g.title === name ? name : `${g.title}: ${name}`));
  return table(
    ['Key', 'Front desk label', 'What it paints', 'Built-in'],
    OFFICE_COLOR_KEYS.map((k) => [code(k), label.get(k) ?? '', COLOUR_NOTES[k], code(BASE_C[OFFICE_COLOR_SHADES[k][0]!])]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Consistency checks between the hand-written data and the code

function checkData(): void {
  const problems: string[] = [];
  const missing = (what: string, keys: readonly string[], has: (k: string) => boolean): void => {
    for (const k of keys) if (!has(k)) problems.push(`${what}: nothing written for "${k}"`);
  };
  missing('HEAD_NOTES', HEAD_STYLES, (k) => !!HEAD_NOTES[k as HeadStyle]);
  missing('OUTFIT_NOTES', OUTFITS, (k) => !!OUTFIT_NOTES[k as Outfit]);
  missing('LOOK_NOTES', LOOK_FIELDS.filter((f) => f.kind !== 'enum').map((f) => f.key), (k) => !!LOOK_NOTES[k as keyof LookSpec]);
  missing('COLOUR_NOTES', OFFICE_COLOR_KEYS, (k) => !!COLOUR_NOTES[k as OfficeColorKey]);
  missing('COLOUR_GROUPS', OFFICE_COLOR_KEYS, (k) => COLOUR_GROUPS.some((g) => g.keys.some(([key]) => key === k)));
  missing('TITLE_WHO', TITLE_KEYS, (k) => !!TITLE_WHO[k as TitleKey]);
  if (ROOM_COLOR_KEYS.length + FURNITURE_COLOR_KEYS.length !== OFFICE_COLOR_KEYS.length) problems.push('colour key lists disagree');
  if (SLOT_DESKS.length !== L.staff || DEFAULT_STAFF_ROLES.length !== L.staff) problems.push(`SLOT_DESKS and DEFAULT_STAFF_ROLES need ${L.staff} entries`);
  for (const g of SUGGESTED_COUNTS) for (const k of g.pools) if (!(LINE_POOL_KEYS as readonly string[]).includes(k)) problems.push(`SUGGESTED_COUNTS: unknown pool "${k}"`);
  for (const count of [...SUGGESTED_COUNTS.map((g) => g.count), SUGGESTED_DEFAULT]) {
    if (Number(count.split('-')[1]) > L.lines) problems.push(`suggested count ${count} is over the ${L.lines}-line cap`);
  }
  if (Number(SMALL_TALK_SUGGESTED.split('-')[1]) > L.smallTalk) problems.push(`small talk suggestion ${SMALL_TALK_SUGGESTED} is over the cap`);
  // Every field listed must be one parseTheme keeps, and every key the example uses must be listed.
  const probeValue: Readonly<Record<string, unknown>> = { name: 'x', description: 'x', company: 'x', branch: 'x', lineMode: 'add', smallTalk: [], staff: [], temps: [] };
  const probe = parseTheme(Object.fromEntries(FIELDS.map((f) => [f.key, probeValue[f.key] ?? {}]))).theme;
  for (const f of FIELDS) if (!Object.hasOwn(probe, f.key)) problems.push(`FIELDS: parseTheme drops "${f.key}"`);
  const { theme, errors } = parseTheme(JSON.parse(EXAMPLE_JSON));
  for (const e of errors) problems.push(`example theme: ${e}`);
  for (const k of Object.keys(theme)) if (!FIELDS.some((f) => f.key === k)) problems.push(`FIELDS: "${k}" is missing`);
  if (problems.length) throw new Error(`theme-guide: the guide data is out of step with the code:\n  ${problems.join('\n  ')}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The guide

/** The full text of media/theme-guide.md. Throws if the template or the data is inconsistent. */
export function buildGuide(template: string = readFileSync(TEMPLATE_PATH, 'utf8')): string {
  checkData();
  const values: Record<string, string> = {
    FIELDS_TABLE: fieldsTable(),
    POOLS_TABLE: poolsTable(),
    TITLES_TABLE: titlesTable(),
    SLOTS_TABLE: slotsTable(),
    HEADS_TABLE: table(['Value', 'Looks like'], HEAD_STYLES.map((h) => [code(h), HEAD_NOTES[h]])),
    OUTFITS_TABLE: table(['Value', 'Looks like'], OUTFITS.map((o) => [code(o), OUTFIT_NOTES[o]])),
    BUILDS: BUILDS.map(code).join(', '),
    SKINS: SKIN_TONES.map(code).join(', '),
    LOOK_COLOURS_TABLE: lookTable('colour'),
    LOOK_SWITCHES_TABLE: lookTable('boolean'),
    COLOURS_TABLE: coloursTable(),
    EXAMPLE_JSON,
    SMALL_TALK_COUNT: String(SMALL_TALK.length),
    SMALL_TALK_SUGGESTED,
    LIMIT_LINES: String(L.lines),
    LIMIT_LINE: String(L.line),
    LIMIT_SMALL_TALK: String(L.smallTalk),
    LIMIT_TITLE: String(L.title),
    LIMIT_NAME: String(L.name),
    LIMIT_DESCRIPTION: String(L.description),
    LIMIT_ROLE: String(L.role),
    LIMIT_STAFF: String(L.staff),
    LIMIT_TEMPS: String(L.temps),
  };
  const used = new Set<string>();
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`theme-guide: unknown placeholder {{${name}}} in the template`);
    used.add(name);
    return v;
  });
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`theme-guide: the template never uses ${unused.join(', ')}`);
  const bad = [...new Set([...out].filter((ch) => ch !== '\n' && !isPrintableAscii(ch)))];
  if (bad.length) throw new Error(`theme-guide: non-ASCII characters in the guide: ${bad.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}`);
  return out.endsWith('\n') ? out : `${out}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const guide = buildGuide();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(GUIDE_PATH, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== guide) {
      console.error('media/theme-guide.md is out of date. Run: node --experimental-strip-types --no-warnings dev/theme-guide.ts');
      process.exit(1);
    }
    console.log('media/theme-guide.md is up to date');
  } else {
    writeFileSync(GUIDE_PATH, guide);
    console.log(`wrote media/theme-guide.md (${guide.length} bytes)`);
  }
}
