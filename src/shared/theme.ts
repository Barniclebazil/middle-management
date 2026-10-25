/**
 * Custom staff themes: types and a pure validator for the user's theme JSON file.
 * No vscode, no DOM. `parseTheme` never throws, returns freshly built objects (unknown keys dropped) and reports
 * every problem as a readable message such as "staff[2].look.hair: expected a colour like #a1b2c3".
 */

export const HEAD_STYLES = ['boss', 'assistant', 'prankster', 'receptionist', 'crossword', 'cat', 'chili', 'knitting', 'hr', 'short', 'spiky', 'ponytail', 'curly', 'bob', 'headset'] as const;
export const SKIN_TONES = ['fair', 'rosy', 'warm', 'olive', 'brown', 'deep'] as const;
/** Room colours a theme may override (each '#rrggbb'): walls, floors, chairs and the sign. */
export const ROOM_COLOR_KEYS = ['wall', 'trim', 'ceiling', 'carpet', 'lobbyFloor', 'kitchenFloor', 'conferenceFloor', 'managerFloor', 'annexFloor', 'rug', 'rugBorder', 'deskChairs', 'kitchenChairs', 'managerChair', 'signPlate', 'signText', 'signBranch'] as const;
/** Furniture, window and light colours a theme may override (each '#rrggbb'). */
export const FURNITURE_COLOR_KEYS = ['desks', 'deskPanels', 'wood', 'darkWood', 'metal', 'computers', 'screens', 'plants', 'plantPots', 'glass', 'glassFrames', 'blinds', 'windowFrames', 'sky', 'skyline', 'ceilingLights', 'outside'] as const;
/** Every environment colour a theme may override. */
export const OFFICE_COLOR_KEYS = [...ROOM_COLOR_KEYS, ...FURNITURE_COLOR_KEYS] as const;
export const BUILDS = ['normal', 'tall', 'small', 'big'] as const;
export const OUTFITS = ['suit', 'shirtTie', 'looseTie', 'cardigan', 'buttonCardigan', 'vest', 'floral', 'openCardigan', 'plain', 'polo', 'blouse'] as const;

/** `add` puts a theme's lines in with the built-in ones; `replace` swaps them out (only for the pools the theme fills). */
export const LINE_MODES = ['add', 'replace'] as const;
/** Job titles a theme may rename (the ones shown on tooltips and the roster). */
export const TITLE_KEYS = ['manager', 'receptionist', 'cleaner', 'temp', 'vendor', 'itSupport'] as const;
/** The side characters a theme may rename and restyle. */
export const NPC_KEYS = ['cleaner', 'vendor', 'itFixer', 'itCritic'] as const;
/**
 * Every in-world line pool a theme may fill, lines pools first, then the pairs pools (an opener and a reply).
 * `webview/engine/lines.ts` maps each to its built-in array.
 */
export const LINE_POOL_KEYS = [
  'bossVisit', 'bossSnack', 'bossSnoop', 'bossSulkStart', 'bossSulk', 'bossSulkEnd',
  'deskBumped', 'deskMoveUp', 'chatReplies',
  'receptionPhone', 'receptionGreeting', 'receptionIdle', 'receptionAttending',
  'cleanerMutters', 'cartCalls',
  'itFix', 'itVerdicts', 'itGiveUps', 'itSneers', 'itComebacks', 'itFixerMutters', 'itCriticMutters', 'itTalkReplies',
  'itFixerTalk', 'itCriticTalk', 'bossPlanApproved', 'bossCommandApproved', 'bossEditApproved',
] as const;

export type OfficeColorKey = (typeof OFFICE_COLOR_KEYS)[number];
export type LineMode = (typeof LINE_MODES)[number];
export type TitleKey = (typeof TITLE_KEYS)[number];
export type NpcKey = (typeof NPC_KEYS)[number];
export type LinePoolKey = (typeof LINE_POOL_KEYS)[number];
/** The pools whose entries are pairs (an opener and a reply). */
export type PairPoolKey = 'itFixerTalk' | 'itCriticTalk' | 'bossPlanApproved' | 'bossCommandApproved' | 'bossEditApproved';
/** What a theme holds for one pool: a list of lines, or a list of pairs for the pairs pools. */
export type LinePoolValue<K extends LinePoolKey> = K extends PairPoolKey ? [string, string][] : string[];
export type ThemeLines = { [K in LinePoolKey]?: LinePoolValue<K> };
export type HeadStyle = (typeof HEAD_STYLES)[number];
export type SkinTone = (typeof SKIN_TONES)[number];
export type Build = (typeof BUILDS)[number];
export type Outfit = (typeof OUTFITS)[number];

/** Every field optional; colours are '#rrggbb' (lower case after parsing). */
export interface LookSpec {
  head?: HeadStyle;
  build?: Build;
  outfit?: Outfit;
  skin?: SkinTone;
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

export interface StaffSpec {
  /** Optional: a nameless slot shows no name, like an unthemed one. `{}` is a placeholder that keeps the slot's position. */
  name?: string;
  role?: string;
  look?: LookSpec;
  lines?: string[];
  pin?: { project?: string; title?: string };
}

export interface TempSpec {
  name?: string;
  look?: LookSpec;
}

/** A side character: a name and a look, but no lines of their own (those are pools in `lines`). */
export interface PersonSpec {
  name?: string;
  look?: LookSpec;
}

export interface OfficeTheme {
  /** Names the theme in the Front desk's lists. */
  name?: string;
  description?: string;
  company?: string;
  branch?: string;
  /** `replace`: a pool the theme fills (in `lines`, or `manager.lines`, `receptionist.lines`, `smallTalk`) swaps out the built-in lines. Default `add`. */
  lineMode?: LineMode;
  /** Replacement or extra lines by pool; see `LINE_POOL_INFO` for who says each. */
  lines?: ThemeLines;
  titles?: Partial<Record<TitleKey, string>>;
  manager?: { name?: string; look?: LookSpec; lines?: string[] };
  receptionist?: { name?: string; look?: LookSpec; lines?: string[] };
  cleaner?: PersonSpec;
  vendor?: PersonSpec;
  itFixer?: PersonSpec;
  itCritic?: PersonSpec;
  colors?: Partial<Record<OfficeColorKey, string>>;
  smallTalk?: [string, string][];
  /** Max 8; entry i is staff slot i (`{}` = untouched slot). */
  staff?: StaffSpec[];
  /** Max 6; entry j is temp slot j (`{}` = untouched slot). */
  temps?: TempSpec[];
}

/** `name` also bounds company, branch, the theme's own name and every person's name; `lines` and `pairs` cap one pool. */
export const THEME_LIMITS = { staff: 8, temps: 6, lines: 60, smallTalk: 200, name: 40, description: 160, title: 40, role: 60, line: 80, pin: 200 } as const;

/** Whether a pool holds single lines or (opener, reply) pairs. */
export const LINE_POOL_KIND: Readonly<Record<LinePoolKey, 'lines' | 'pairs'>> = {
  bossVisit: 'lines', bossSnack: 'lines', bossSnoop: 'lines', bossSulkStart: 'lines', bossSulk: 'lines', bossSulkEnd: 'lines',
  deskBumped: 'lines', deskMoveUp: 'lines', chatReplies: 'lines',
  receptionPhone: 'lines', receptionGreeting: 'lines', receptionIdle: 'lines', receptionAttending: 'lines',
  cleanerMutters: 'lines', cartCalls: 'lines',
  itFix: 'lines', itVerdicts: 'lines', itGiveUps: 'lines', itSneers: 'lines', itComebacks: 'lines', itFixerMutters: 'lines', itCriticMutters: 'lines', itTalkReplies: 'lines',
  itFixerTalk: 'pairs', itCriticTalk: 'pairs',
  bossPlanApproved: 'pairs', bossCommandApproved: 'pairs', bossEditApproved: 'pairs',
};

/** Who says each pool and when, in plain English (the guide for Claude is generated from this). */
export const LINE_POOL_INFO: Readonly<Record<LinePoolKey, { who: string; when: string }>> = {
  bossVisit: { who: 'the manager', when: "visiting a worker's desk" },
  bossSnack: { who: 'the manager', when: 'at the food trolley, justifying what he picked' },
  bossSnoop: { who: 'the manager', when: "looking over a working agent's shoulder" },
  bossSulkStart: { who: 'the manager', when: 'as a Fable agent takes over his office' },
  bossSulk: { who: 'the manager', when: 'muttering while he sulks outside his office' },
  bossSulkEnd: { who: 'the manager', when: 'as the spell ends and he gets his office back' },
  deskBumped: { who: 'a worker', when: 'when a better-ranked model takes their desk' },
  deskMoveUp: { who: 'a worker', when: 'when moving to a better desk' },
  chatReplies: { who: 'a worker', when: "answering a colleague's own theme line during water-cooler chat" },
  receptionPhone: { who: 'the receptionist', when: 'when a call comes in at the front desk' },
  receptionGreeting: { who: 'the receptionist', when: 'when a new worker steps out of the elevator' },
  receptionIdle: { who: 'the receptionist', when: 'idle remarks while she works the front desk' },
  receptionAttending: { who: 'the receptionist', when: 'when the Front desk panel is open and she looks up from her work' },
  cleanerMutters: { who: 'the cleaner', when: 'muttering while wiping a vacated desk, emptying bins or doing the kitchen counter' },
  cartCalls: { who: 'the food trolley vendor', when: 'calling out while pushing the trolley and while it is parked' },
  itFix: { who: 'the IT fixer', when: 'the opening line of every fix' },
  itVerdicts: { who: 'the IT fixer', when: "once the worker's monitor has rebooted" },
  itGiveUps: { who: 'the IT fixer', when: 'when the worker gets up and leaves halfway through the fix' },
  itSneers: { who: 'the IT critic', when: 'sneering at what the AI worker has on screen once it comes back' },
  itComebacks: { who: 'the AI worker being fixed', when: 'answering back after its monitor has been rebooted' },
  itFixerMutters: { who: 'the IT fixer', when: 'muttering while walking round the office' },
  itCriticMutters: { who: 'the IT critic', when: 'muttering while walking round the office' },
  itTalkReplies: { who: 'an idle AI worker, the receptionist or the manager', when: 'a puzzled reply to either IT opener in small talk' },
  itFixerTalk: { who: 'the IT fixer, then the listener', when: 'small talk: an awkward opener, then a reply that doubles down' },
  itCriticTalk: { who: 'the IT critic, then the listener', when: 'small talk: fumbled chat read off a crib card, then a reply that doubles down' },
  bossPlanApproved: { who: 'the manager, then the manager again', when: 'after you approve a plan: gushing praise, then admitting he did not read it' },
  bossCommandApproved: { who: 'the manager, then the manager again', when: 'after you approve a shell command: gushing praise, then admitting he did not read it' },
  bossEditApproved: { who: 'the manager, then the manager again', when: 'after you approve a file edit: gushing praise, then admitting he did not read it' },
};

type Obj = Record<string, unknown>;

const COLOUR_KEYS = ['hair', 'hairHighlight', 'eye', 'shirt', 'outer', 'sleeve', 'tie', 'collar', 'accent', 'accent2', 'pants', 'legs', 'shoes', 'glasses', 'facialHair', 'bow', 'beltColor'] as const;
const BOOL_KEYS = ['skirt', 'shortSleeves', 'belt'] as const;
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kind(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v;
}

/** Returns the object when it is a plain object without prototype-polluting own keys; else reports and returns undefined. */
function objAt(v: unknown, path: string, errors: string[]): Obj | undefined {
  if (!isObj(v)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  for (const k of BAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(v, k)) {
      errors.push(`${path}: the key "${k}" is not allowed`);
      return undefined;
    }
  }
  return v;
}

/** A trimmed, non-empty string with no control characters and at most `max` chars; else reports and returns undefined. */
function strAt(v: unknown, max: number, path: string, errors: string[]): string | undefined {
  if (typeof v !== 'string') {
    errors.push(`${path}: expected text, got ${kind(v)}`);
    return undefined;
  }
  const s = v.trim();
  if (s.length === 0) {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  if (CONTROL_RE.test(s)) {
    errors.push(`${path}: must not contain control characters`);
    return undefined;
  }
  if (s.length > max) {
    errors.push(`${path}: too long (max ${max} characters)`);
    return undefined;
  }
  return s;
}

function colourAt(v: unknown, path: string, errors: string[]): string | undefined {
  if (typeof v === 'string' && COLOUR_RE.test(v)) return v.toLowerCase();
  errors.push(`${path}: expected a colour like #a1b2c3`);
  return undefined;
}

function enumAt<T extends string>(v: unknown, allowed: readonly T[], path: string, errors: string[]): T | undefined {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  errors.push(`${path}: expected one of ${allowed.join(', ')}`);
  return undefined;
}

function parseLook(raw: unknown, path: string, errors: string[]): LookSpec | undefined {
  const o = objAt(raw, path, errors);
  if (o === undefined) return undefined;
  const look: LookSpec = {};
  if (o.head !== undefined) {
    const x = enumAt(o.head, HEAD_STYLES, `${path}.head`, errors);
    if (x !== undefined) look.head = x;
  }
  if (o.build !== undefined) {
    const x = enumAt(o.build, BUILDS, `${path}.build`, errors);
    if (x !== undefined) look.build = x;
  }
  if (o.outfit !== undefined) {
    const x = enumAt(o.outfit, OUTFITS, `${path}.outfit`, errors);
    if (x !== undefined) look.outfit = x;
  }
  if (o.skin !== undefined) {
    const x = enumAt(o.skin, SKIN_TONES, `${path}.skin`, errors);
    if (x !== undefined) look.skin = x;
  }
  for (const k of COLOUR_KEYS) {
    if (o[k] === undefined) continue;
    const c = colourAt(o[k], `${path}.${k}`, errors);
    if (c !== undefined) look[k] = c;
  }
  for (const k of BOOL_KEYS) {
    if (o[k] === undefined) continue;
    if (typeof o[k] === 'boolean') look[k] = o[k];
    else errors.push(`${path}.${k}: expected true or false`);
  }
  return look;
}

/** An array of lines; invalid entries are dropped with an error, extras beyond the cap with one error. */
function parseLines(raw: unknown, path: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(`${path}: expected a list of text lines`);
    return undefined;
  }
  const out: string[] = [];
  let extra = 0;
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= THEME_LIMITS.lines) {
      extra = raw.length - i;
      break;
    }
    const s = strAt(raw[i], THEME_LIMITS.line, `${path}[${i}]`, errors);
    if (s !== undefined) out.push(s);
  }
  if (extra > 0) errors.push(`${path}: only the first ${THEME_LIMITS.lines} lines are used; ${extra} dropped`);
  return out;
}

function parsePin(raw: unknown, path: string, errors: string[]): StaffSpec['pin'] {
  const o = objAt(raw, path, errors);
  if (o === undefined) return undefined;
  const pin: { project?: string; title?: string } = {};
  if (o.project !== undefined) {
    const s = strAt(o.project, THEME_LIMITS.pin, `${path}.project`, errors);
    if (s !== undefined) pin.project = s;
  }
  if (o.title !== undefined) {
    const s = strAt(o.title, THEME_LIMITS.pin, `${path}.title`, errors);
    if (s !== undefined) pin.title = s;
  }
  if (pin.project === undefined && pin.title === undefined) {
    errors.push(`${path}: needs a project or a title; pin dropped`);
    return undefined;
  }
  return pin;
}

/** Never undefined: an entry that is not usable becomes a `{}` placeholder so later people keep their slots. */
function parseStaff(raw: unknown, path: string, errors: string[]): StaffSpec {
  const o = objAt(raw, path, errors);
  if (o === undefined) return {};
  const s: StaffSpec = {};
  if (o.name !== undefined) {
    const name = strAt(o.name, THEME_LIMITS.name, `${path}.name`, errors);
    if (name === undefined) return {};
    s.name = name;
  }
  if (o.role !== undefined) {
    const r = strAt(o.role, THEME_LIMITS.role, `${path}.role`, errors);
    if (r !== undefined) s.role = r;
  }
  if (o.look !== undefined) {
    const l = parseLook(o.look, `${path}.look`, errors);
    if (l !== undefined) s.look = l;
  }
  if (o.lines !== undefined) {
    const l = parseLines(o.lines, `${path}.lines`, errors);
    if (l !== undefined) s.lines = l;
  }
  if (o.pin !== undefined) {
    const p = parsePin(o.pin, `${path}.pin`, errors);
    if (p !== undefined) s.pin = p;
  }
  return s;
}

/** Never undefined: a non-object entry becomes a `{}` placeholder, as for staff. */
function parseTemp(raw: unknown, path: string, errors: string[]): TempSpec {
  const o = objAt(raw, path, errors);
  if (o === undefined) return {};
  const t: TempSpec = {};
  if (o.name !== undefined) {
    const n = strAt(o.name, THEME_LIMITS.name, `${path}.name`, errors);
    if (n !== undefined) t.name = n;
  }
  if (o.look !== undefined) {
    const l = parseLook(o.look, `${path}.look`, errors);
    if (l !== undefined) t.look = l;
  }
  return t;
}

/** Parse the entries of a capped list: keeps the first `max` valid entries (indices in messages are the file's own). */
function parseList<T>(raw: unknown, path: string, max: number, errors: string[], one: (v: unknown, p: string) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(`${path}: expected a list`);
    return undefined;
  }
  const out: T[] = [];
  let extra = 0;
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= max) {
      extra = raw.length - i;
      break;
    }
    const v = one(raw[i], `${path}[${i}]`);
    if (v !== undefined) out.push(v);
  }
  if (extra > 0) errors.push(`${path}: only the first ${max} entries are used; ${extra} dropped`);
  return out;
}

/** An array of (opener, reply) pairs, capped at `max`; invalid pairs are dropped with an error. */
function parsePairs(raw: unknown, path: string, max: number, errors: string[]): [string, string][] | undefined {
  return parseList(raw, path, max, errors, (v, p) => {
    if (!Array.isArray(v) || v.length !== 2) {
      errors.push(`${p}: expected a pair of two text lines`);
      return undefined;
    }
    const a = strAt(v[0], THEME_LIMITS.line, `${p}[0]`, errors);
    const b = strAt(v[1], THEME_LIMITS.line, `${p}[1]`, errors);
    return a === undefined || b === undefined ? undefined : [a, b];
  });
}

function parseManager(raw: unknown, errors: string[], key: 'manager' | 'receptionist' = 'manager'): OfficeTheme['manager'] {
  const o = objAt(raw, key, errors);
  if (o === undefined) return undefined;
  const m: NonNullable<OfficeTheme['manager']> = {};
  if (o.name !== undefined) {
    const n = strAt(o.name, THEME_LIMITS.name, `${key}.name`, errors);
    if (n !== undefined) m.name = n;
  }
  if (o.look !== undefined) {
    const l = parseLook(o.look, `${key}.look`, errors);
    if (l !== undefined) m.look = l;
  }
  if (o.lines !== undefined) {
    const l = parseLines(o.lines, `${key}.lines`, errors);
    if (l !== undefined) m.lines = l;
  }
  return m;
}

function parseColors(raw: unknown, errors: string[]): OfficeTheme['colors'] {
  const o = objAt(raw, 'colors', errors);
  if (o === undefined) return undefined;
  const out: Partial<Record<OfficeColorKey, string>> = {};
  for (const k of Object.keys(o)) {
    if (!(OFFICE_COLOR_KEYS as readonly string[]).includes(k)) {
      errors.push(`colors.${k}: unknown colour (expected one of ${OFFICE_COLOR_KEYS.join(', ')})`);
      continue;
    }
    const c = colourAt(o[k], `colors.${k}`, errors);
    if (c !== undefined) out[k as OfficeColorKey] = c;
  }
  return out;
}

/** A side character: a name and a look, no lines. */
function parsePerson(raw: unknown, key: NpcKey, errors: string[]): PersonSpec | undefined {
  const o = objAt(raw, key, errors);
  if (o === undefined) return undefined;
  const p: PersonSpec = {};
  if (o.name !== undefined) {
    const n = strAt(o.name, THEME_LIMITS.name, `${key}.name`, errors);
    if (n !== undefined) p.name = n;
  }
  if (o.look !== undefined) {
    const l = parseLook(o.look, `${key}.look`, errors);
    if (l !== undefined) p.look = l;
  }
  return p;
}

function parseThemeLines(raw: unknown, errors: string[]): ThemeLines | undefined {
  const o = objAt(raw, 'lines', errors);
  if (o === undefined) return undefined;
  const out: Record<string, string[] | [string, string][]> = {};
  for (const k of Object.keys(o)) {
    if (!(LINE_POOL_KEYS as readonly string[]).includes(k)) {
      errors.push(`lines.${k}: unknown line pool (expected one of ${LINE_POOL_KEYS.join(', ')})`);
      continue;
    }
    const pool = k as LinePoolKey;
    const v = LINE_POOL_KIND[pool] === 'pairs' ? parsePairs(o[k], `lines.${k}`, THEME_LIMITS.lines, errors) : parseLines(o[k], `lines.${k}`, errors);
    if (v !== undefined) out[k] = v;
  }
  return out as ThemeLines;
}

function parseTitles(raw: unknown, errors: string[]): OfficeTheme['titles'] {
  const o = objAt(raw, 'titles', errors);
  if (o === undefined) return undefined;
  const out: Partial<Record<TitleKey, string>> = {};
  for (const k of Object.keys(o)) {
    if (!(TITLE_KEYS as readonly string[]).includes(k)) {
      errors.push(`titles.${k}: unknown title (expected one of ${TITLE_KEYS.join(', ')})`);
      continue;
    }
    const s = strAt(o[k], THEME_LIMITS.title, `titles.${k}`, errors);
    if (s !== undefined) out[k as TitleKey] = s;
  }
  return out;
}

/** For an editor: drops trailing `{}` placeholders (untouched slots) from a staff or temp list. */
export function trimTrailingPlaceholders<T extends object>(list: readonly T[]): T[] {
  let n = list.length;
  while (n > 0 && Object.keys(list[n - 1]!).length === 0) n--;
  return list.slice(0, n);
}

/**
 * Validate an untrusted theme file. Never throws. Drops invalid fields and entries (each reported in `errors`) and
 * returns a freshly built theme with unknown keys removed. Non-object input gives an empty theme plus one error.
 */
export function parseTheme(raw: unknown): { theme: OfficeTheme; errors: string[] } {
  const errors: string[] = [];
  try {
    if (!isObj(raw)) return { theme: {}, errors: ['theme: expected a JSON object'] };
    const o = objAt(raw, 'theme', errors);
    if (o === undefined) return { theme: {}, errors };
    const theme: OfficeTheme = {};
    if (o.name !== undefined) {
      const s = strAt(o.name, THEME_LIMITS.name, 'name', errors);
      if (s !== undefined) theme.name = s;
    }
    if (o.description !== undefined) {
      const s = strAt(o.description, THEME_LIMITS.description, 'description', errors);
      if (s !== undefined) theme.description = s;
    }
    if (o.company !== undefined) {
      const s = strAt(o.company, THEME_LIMITS.name, 'company', errors);
      if (s !== undefined) theme.company = s;
    }
    if (o.branch !== undefined) {
      const s = strAt(o.branch, THEME_LIMITS.name, 'branch', errors);
      if (s !== undefined) theme.branch = s;
    }
    if (o.lineMode !== undefined) {
      const m = enumAt(o.lineMode, LINE_MODES, 'lineMode', errors);
      if (m !== undefined) theme.lineMode = m;
    }
    if (o.manager !== undefined) {
      const m = parseManager(o.manager, errors);
      if (m !== undefined) theme.manager = m;
    }
    if (o.receptionist !== undefined) {
      const m = parseManager(o.receptionist, errors, 'receptionist');
      if (m !== undefined) theme.receptionist = m;
    }
    for (const k of NPC_KEYS) {
      if (o[k] === undefined) continue;
      const p = parsePerson(o[k], k, errors);
      if (p !== undefined) theme[k] = p;
    }
    if (o.titles !== undefined) {
      const t = parseTitles(o.titles, errors);
      if (t !== undefined) theme.titles = t;
    }
    if (o.lines !== undefined) {
      const l = parseThemeLines(o.lines, errors);
      if (l !== undefined) theme.lines = l;
    }
    if (o.colors !== undefined) {
      const c = parseColors(o.colors, errors);
      if (c !== undefined) theme.colors = c;
    }
    if (o.smallTalk !== undefined) {
      const t = parsePairs(o.smallTalk, 'smallTalk', THEME_LIMITS.smallTalk, errors);
      if (t !== undefined) theme.smallTalk = t;
    }
    if (o.staff !== undefined) {
      const s = parseList(o.staff, 'staff', THEME_LIMITS.staff, errors, (v, p) => parseStaff(v, p, errors));
      if (s !== undefined) theme.staff = s;
    }
    if (o.temps !== undefined) {
      const t = parseList(o.temps, 'temps', THEME_LIMITS.temps, errors, (v, p) => parseTemp(v, p, errors));
      if (t !== undefined) theme.temps = t;
    }
    return { theme, errors };
  } catch {
    return { theme: {}, errors: [...errors, 'theme: could not be read'] };
  }
}
