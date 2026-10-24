/**
 * Front desk Staff and Colours view helpers (task 3.11): the DOM-free decisions behind `frontDeskStaff.ts`,
 * `frontDeskColours.ts` and `lookPreview.ts`. No DOM and no art imports (the art's answers, such as `lookFieldUse` and
 * `BASE_C`, are passed in), so it is tested in Node (`test/engine-frontDeskStaff.test.ts`).
 *
 * Contents: the layout rule (list beside the detail, or a list that pushes the detail), list keyboard moves, hex colour
 * parsing, the Colours tab's groups and sign warning, the look editor's field model (labels, groups, what applies to the
 * look), raw draft access for inputs, the lines editor and a small throttle for colour drags.
 */
import { OFFICE_COLOR_KEYS, THEME_LIMITS } from '../../src/shared/theme.ts';
import type { LookSpec, OfficeColorKey, OfficeTheme } from '../../src/shared/theme.ts';
import { contrastRatio, parseSlotId, relativeLuminance, signReadabilityDetail, SIGN_MIN_CONTRAST } from './frontDeskLogic.ts';
import type { Draft, LookFieldKind, LookRow, SlotId } from './frontDeskLogic.ts';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout and keyboard

/** Below this width (the panel's, in CSS px) the Staff tab is a list that pushes the person's page as a sub-view. */
export const STAFF_NARROW_BELOW = 420;

/** `'split'`: the list beside the detail. `'stack'`: the list alone; opening a person pushes their page. */
export type StaffLayout = 'split' | 'stack';

/** The layout for a panel `width`. A width of 0 or less (hidden, not laid out yet) keeps `previous`. */
export function staffLayout(width: number, previous: StaffLayout = 'stack'): StaffLayout {
  if (!Number.isFinite(width) || width <= 0) return previous;
  return width < STAFF_NARROW_BELOW ? 'stack' : 'split';
}

/** Where an arrow, Home, End, PageUp or PageDown key moves the focus in a list of `count` rows; null for other keys. No wrap. */
export function listMove(key: string, index: number, count: number, page = 5): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(index, 0), last);
  switch (key) {
    case 'ArrowDown': return Math.min(at + 1, last);
    case 'ArrowUp': return Math.max(at - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    case 'PageDown': return Math.min(at + page, last);
    case 'PageUp': return Math.max(at - page, 0);
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hex colours

const HEX6 = /^#[0-9a-f]{6}$/i;

/** True for a `#rrggbb` colour (either case). */
export function isHexColour(v: unknown): v is string {
  return typeof v === 'string' && HEX6.test(v);
}

export type HexInput = { kind: 'empty' } | { kind: 'ok'; hex: string } | { kind: 'invalid' };

/**
 * Reads what someone typed into a hex field: blank is `empty` (= use the built-in colour); `#abc`, `abc`, `#AABBCC` and
 * `aabbcc` (spaces around are fine) become `#aabbcc`; anything else is `invalid`.
 */
export function parseHex(text: string): HexInput {
  const t = text.trim();
  if (t === '') return { kind: 'empty' };
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (m === null) return { kind: 'invalid' };
  let digits = m[1]!.toLowerCase();
  if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
  return { kind: 'ok', hex: `#${digits}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Colours tab

export interface ColourGroupSpec {
  id: string;
  title: string;
  hint?: string;
  keys: readonly (readonly [OfficeColorKey, string])[];
}

/** The office colours in the Colours tab's groups and order, with their labels. */
export const COLOUR_GROUPS: readonly ColourGroupSpec[] = [
  { id: 'walls', title: 'Walls and ceiling', keys: [['wall', 'Walls'], ['trim', 'Skirting and trim'], ['ceiling', 'Ceiling']] },
  {
    id: 'floors', title: 'Floors',
    keys: [['carpet', 'Open-plan carpet'], ['lobbyFloor', 'Lobby'], ['kitchenFloor', 'Kitchen'], ['conferenceFloor', 'Conference room'], ['managerFloor', 'Manager’s office'], ['annexFloor', 'Annex']],
  },
  { id: 'rug', title: 'Rug', keys: [['rug', 'Rug'], ['rugBorder', 'Border']] },
  { id: 'chairs', title: 'Chairs', keys: [['deskChairs', 'Desk chairs'], ['kitchenChairs', 'Kitchen chairs'], ['managerChair', 'Manager’s chair']] },
  { id: 'sign', title: 'Sign', hint: 'The sign above the lobby. Keep the lettering well apart from the plate.', keys: [['signPlate', 'Plate'], ['signText', 'Company name'], ['signBranch', 'Branch name']] },
  {
    id: 'furniture', title: 'Furniture',
    keys: [['desks', 'Desks'], ['deskPanels', 'Desk panels'], ['wood', 'Cupboards and counters'], ['darkWood', 'Dark wood'], ['metal', 'Metal'], ['computers', 'Computers and copier'], ['screens', 'Switched-off screens']],
  },
  { id: 'plants', title: 'Plants', keys: [['plants', 'Leaves'], ['plantPots', 'Pots']] },
  {
    id: 'windows', title: 'Windows and glass',
    keys: [['glass', 'Glass walls'], ['glassFrames', 'Glass frames'], ['blinds', 'Blinds'], ['windowFrames', 'Window frames'], ['sky', 'Sky'], ['skyline', 'Skyline']],
  },
  { id: 'lights', title: 'Lights and outside', keys: [['ceilingLights', 'Ceiling lights'], ['outside', 'Outside the building']] },
];

export interface ColourRowModel {
  key: OfficeColorKey;
  label: string;
  /** The colour the office shows: the draft's valid value, else the built-in. */
  value: string;
  /** The built-in colour (from `BASE_C`). */
  builtin: string;
  /** True when the draft does not set this colour (show it dimmed, marked "built-in"). */
  inherited: boolean;
  /** The draft's own text when it is not a usable colour (the office ignores it); undefined otherwise. */
  invalid?: string;
}

export interface ColourGroupModel {
  id: string;
  title: string;
  hint?: string;
  rows: ColourRowModel[];
  /** How many rows the draft sets. */
  customised: number;
}

/** The Colours tab's rows for the draft's `colors`; `defaults` holds the built-in colour of every key. */
export function colourGroups(colors: Partial<Record<OfficeColorKey, string>> | undefined, defaults: Readonly<Record<OfficeColorKey, string>>): ColourGroupModel[] {
  return COLOUR_GROUPS.map((g): ColourGroupModel => {
    const rows = g.keys.map(([key, label]): ColourRowModel => {
      const own = colors?.[key];
      const builtin = defaults[key];
      const row: ColourRowModel = { key, label, builtin, value: builtin, inherited: own === undefined };
      if (own !== undefined) {
        if (isHexColour(own)) row.value = own.toLowerCase();
        else row.invalid = String(own);
      }
      return row;
    });
    const out: ColourGroupModel = { id: g.id, title: g.title, rows, customised: rows.filter((r) => !r.inherited).length };
    if (g.hint !== undefined) out.hint = g.hint;
    return out;
  });
}

/** The colours the office would use (draft value when valid, else built-in), for the sign preview and contrast. */
export function effectiveColours(colors: Partial<Record<OfficeColorKey, string>> | undefined, defaults: Readonly<Record<OfficeColorKey, string>>): Record<OfficeColorKey, string> {
  const out = {} as Record<OfficeColorKey, string>;
  for (const k of OFFICE_COLOR_KEYS) {
    const own = colors?.[k];
    out[k] = isHexColour(own) ? own.toLowerCase() : defaults[k];
  }
  return out;
}

export interface SignWarning {
  /** Which lettering is too faint: the company name, the branch name or both. */
  keys: OfficeColorKey[];
  /** The worst ratio, rounded to one decimal place, e.g. "1.8". */
  ratio: string;
  /** "lighter" or "darker": the text direction that can reach the most contrast against this plate. */
  direction: 'lighter' | 'darker';
  title: string;
  detail: string;
}

/** The Colours tab's contrast warning; null when both lines of the sign are readable (`signReadability` is 'ok'). */
export function signWarning(colors: Partial<Record<OfficeColorKey, string>> | undefined, defaults: Readonly<Record<OfficeColorKey, string>>): SignWarning | null {
  const eff = effectiveColours(colors, defaults);
  const d = signReadabilityDetail(eff, defaults);
  const keys: OfficeColorKey[] = [];
  if (d.sign === 'low') keys.push('signText');
  if (d.branch === 'low') keys.push('signBranch');
  if (keys.length === 0) return null;
  const worst = Math.min(...[d.sign === 'low' ? d.signRatio : Infinity, d.branch === 'low' ? d.branchRatio : Infinity]);
  const plate = relativeLuminance(eff.signPlate);
  // Best contrast reachable with pure white or pure black text on this plate.
  const vsWhite = (1 + 0.05) / (plate + 0.05);
  const vsBlack = (plate + 0.05) / 0.05;
  const direction = vsWhite >= vsBlack ? 'lighter' : 'darker';
  const what = keys.length === 2 ? 'The company and branch names are' : keys[0] === 'signText' ? 'The company name is' : 'The branch name is';
  const ratio = (Math.floor(worst * 10) / 10).toFixed(1);
  return {
    keys, ratio, direction,
    title: 'The sign is hard to read',
    detail: `${what} too close to the plate colour (contrast ${ratio}:1; aim for ${SIGN_MIN_CONTRAST}:1 or more). Try a ${direction} text colour${direction === 'lighter' ? ' or a darker plate' : ' or a lighter plate'}.`,
  };
}

/**
 * The warning's one-click fix: for each faint line, the first of a few text colours (the built-in one first) that reads
 * comfortably (4.5:1) on the current plate, else the strongest. Null when the sign is fine.
 */
export function signFix(colors: Partial<Record<OfficeColorKey, string>> | undefined, defaults: Readonly<Record<OfficeColorKey, string>>): Partial<Record<OfficeColorKey, string>> | null {
  const w = signWarning(colors, defaults);
  if (w === null) return null;
  const plate = effectiveColours(colors, defaults).signPlate;
  const out: Partial<Record<OfficeColorKey, string>> = {};
  for (const k of w.keys) {
    const candidates = w.direction === 'lighter' ? [defaults[k], defaults.signText, '#ffffff'] : ['#1d1520', '#000000'];
    out[k] = candidates.find((c) => contrastRatio(c, plate) >= 4.5) ?? candidates[candidates.length - 1]!;
  }
  return out;
}

/** Contrast of two colours as "4.6:1" text (for a tooltip); "" when either is not a colour. */
export function ratioText(a: string, b: string): string {
  const r = contrastRatio(a, b);
  return Number.isNaN(r) ? '' : `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Slots and raw draft access

export interface SlotFeatures {
  sign: boolean;
  name: boolean;
  role: boolean;
  pin: boolean;
  lines: boolean;
  look: boolean;
}

/** Which parts a slot's page has: the sign has company and branch; temps only name and look; the manager and receptionist no role or pin. */
export function slotFeatures(slot: SlotId): SlotFeatures {
  const p = parseSlotId(slot);
  const none: SlotFeatures = { sign: false, name: false, role: false, pin: false, lines: false, look: false };
  if (p === null) return none;
  if (p.group === 'sign') return { ...none, sign: true };
  if (p.group === 'temp') return { ...none, name: true, look: true };
  if (p.group === 'staff') return { sign: false, name: true, role: true, pin: true, lines: true, look: true };
  return { ...none, name: true, lines: true, look: true };
}

/** The slot's own object in the draft as it is (not cleaned); undefined when the draft has none. */
export function rawSlot(draft: Draft, slot: SlotId): Obj | undefined {
  const p = parseSlotId(slot);
  if (p === null || p.group === 'sign') return undefined;
  if (p.group === 'manager' || p.group === 'receptionist') {
    const v = (draft as Obj)[p.group];
    return isObj(v) ? v : undefined;
  }
  const list = (draft as Obj)[p.group === 'staff' ? 'staff' : 'temps'];
  if (!Array.isArray(list)) return undefined;
  const v: unknown = list[p.index!];
  return isObj(v) ? v : undefined;
}

/** A text field as typed (for an input's value): '' when unset. `field` may be `name`, `role`, `pin.project` or `pin.title`. */
export function rawText(draft: Draft, slot: SlotId, field: string): string {
  let v: unknown = rawSlot(draft, slot);
  for (const k of field.split('.')) v = isObj(v) ? v[k] : undefined;
  return typeof v === 'string' ? v : '';
}

/** The slot's own lines as typed (blank ones included); [] when it has none. */
export function rawLines(draft: Draft, slot: SlotId): string[] {
  const v = rawSlot(draft, slot)?.lines;
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : [];
}

/** A slot's look in a theme (e.g. `previewTheme(draft)`); undefined when the theme gives it none. */
export function slotLookOf(theme: OfficeTheme | null | undefined, slot: SlotId): LookSpec | undefined {
  const p = parseSlotId(slot);
  if (!theme || p === null || p.group === 'sign') return undefined;
  if (p.group === 'manager' || p.group === 'receptionist') return theme[p.group]?.look;
  const list = p.group === 'staff' ? theme.staff : theme.temps;
  return list?.[p.index!]?.look;
}

/** True when the draft has a look of its own for the slot (so "Reset to built-in look" has something to do). */
export function hasOwnLook(draft: Draft, slot: SlotId): boolean {
  const look = rawSlot(draft, slot)?.look;
  return isObj(look) && Object.keys(look).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The look editor

export const LOOK_FIELD_LABELS: Readonly<Record<keyof LookSpec, string>> = {
  head: 'Head', build: 'Build', outfit: 'Outfit', skin: 'Skin',
  hair: 'Hair', hairHighlight: 'Hair highlight', eye: 'Eyes', shirt: 'Shirt or top', outer: 'Jacket or cardigan', sleeve: 'Sleeves',
  tie: 'Tie', collar: 'Collar', accent: 'Accent', accent2: 'Second accent', pants: 'Trousers or skirt', legs: 'Legs', shoes: 'Shoes',
  glasses: 'Glasses', facialHair: 'Beard', bow: 'Bow, clip or headset', beltColor: 'Belt',
  skirt: 'Skirt', shortSleeves: 'Short sleeves', belt: 'Belt (shirt tucked in)',
};

/** Friendly names for the enum values, in the theme's own order. */
export const LOOK_OPTION_LABELS: Readonly<Record<'head' | 'build' | 'outfit' | 'skin', Readonly<Record<string, string>>>> = {
  head: {
    boss: 'Side parting', assistant: 'Fringe and glasses', prankster: 'Tousled', receptionist: 'Long', crossword: 'Bald, glasses, beard',
    cat: 'Round with a bow', chili: 'Thin', knitting: 'Fluffy', hr: 'Bald with a beard', short: 'Short', spiky: 'Spiky',
    ponytail: 'Ponytail', curly: 'Curly', bob: 'Bob', headset: 'Headset',
  },
  build: { normal: 'Normal', tall: 'Tall', small: 'Small', big: 'Big' },
  outfit: {
    suit: 'Suit', shirtTie: 'Shirt and tie', looseTie: 'Loose tie', cardigan: 'Cardigan', buttonCardigan: 'Buttoned cardigan',
    vest: 'Waistcoat', floral: 'Floral top', openCardigan: 'Open cardigan', plain: 'Plain top', polo: 'Polo shirt', blouse: 'Blouse',
  },
  skin: { fair: 'Fair', rosy: 'Rosy', warm: 'Warm', olive: 'Olive', brown: 'Brown', deep: 'Deep' },
};

/** The friendly name of an enum value (the value itself when there is none). */
export function optionLabel(field: keyof LookSpec, value: string): string {
  const t = (LOOK_OPTION_LABELS as Readonly<Record<string, Readonly<Record<string, string>>>>)[field];
  return t?.[value] ?? value;
}

/** Hints shown under a colour row when it helps to know what the colour paints. */
export const LOOK_FIELD_HINTS: Partial<Readonly<Record<keyof LookSpec, string>>> = {
  accent: 'Floral pattern, waistcoat buttons, lanyard',
  accent2: 'Second pattern colour, ID badge',
  legs: 'Bare legs below a skirt',
  bow: 'Hair bow or clip, or a headset band',
  sleeve: 'Same as the jacket unless set',
};

/** The colour fields in three groups, so a long list scans well. */
export const LOOK_COLOUR_GROUPS: readonly { id: string; title: string; fields: readonly (keyof LookSpec)[] }[] = [
  { id: 'face', title: 'Hair and face', fields: ['hair', 'hairHighlight', 'eye', 'glasses', 'facialHair', 'bow'] },
  { id: 'top', title: 'Clothes', fields: ['shirt', 'outer', 'sleeve', 'collar', 'tie', 'accent', 'accent2', 'beltColor'] },
  { id: 'legs', title: 'Legs and shoes', fields: ['pants', 'legs', 'shoes'] },
];

/**
 * The palette letter each colour field paints (`looks.ts` `palette()`), so an unset field can show the colour the look
 * works out by itself (e.g. `outer` = the shirt, `sleeve` = the jacket).
 */
export const LOOK_FIELD_PAL_KEY: Partial<Readonly<Record<keyof LookSpec, string>>> = {
  hair: 'h', hairHighlight: 'i', eye: 'e', shirt: 't', outer: 'j', sleeve: 'a', tie: 'n', collar: 'c', accent: 'x', accent2: 'X',
  pants: 'p', legs: 'g', shoes: 'f', glasses: 'k', facialHair: 'd', bow: 'b', beltColor: 'B',
};

export interface LookFieldModel {
  field: keyof LookSpec;
  kind: LookFieldKind;
  label: string;
  options?: readonly string[];
  /** The draft's or the built-in's value (undefined when neither sets it). */
  value: string | boolean | undefined;
  /** The hex a colour row shows: own (valid), else what the look paints (the built-in value or one it works out). */
  shown?: string;
  /** Where the shown value comes from. */
  source: 'own' | 'builtin' | 'auto';
  /** True when the draft does not set it. */
  inherited: boolean;
  /** False when changing it would not change this look's pixels (`lookFieldUse`). */
  used: boolean;
  /** The draft's own value is not usable (not a `#rrggbb` colour, not one of the options). */
  invalid: boolean;
}

/**
 * The look editor's rows: `rows` from `inheritedLook`, `used` from `lookFieldUse(buildLook(...))`, `effective(field)` the
 * colour the built look paints for a field (its palette entry), used when neither the draft nor the built-in sets it.
 */
export function lookFieldModels(rows: readonly LookRow[], used: readonly string[], effective: (field: keyof LookSpec) => string | undefined): LookFieldModel[] {
  const usedSet = new Set(used);
  return rows.map((r): LookFieldModel => {
    const m: LookFieldModel = {
      field: r.field, kind: r.kind, label: LOOK_FIELD_LABELS[r.field], value: r.value,
      source: r.inherited ? (r.value === undefined ? 'auto' : 'builtin') : 'own',
      inherited: r.inherited,
      used: r.kind === 'enum' || usedSet.has(r.field),
      invalid: false,
    };
    if (r.options !== undefined) m.options = r.options;
    if (!r.inherited) {
      if (r.kind === 'colour') m.invalid = !isHexColour(r.value);
      else if (r.kind === 'enum') m.invalid = !(r.options ?? []).includes(String(r.value));
      else m.invalid = typeof r.value !== 'boolean';
    }
    if (r.kind === 'colour') {
      if (!r.inherited && isHexColour(r.value)) {
        m.shown = r.value.toLowerCase();
      } else {
        // What the look really paints: the built-in value, or one worked out from other colours (an unset jacket takes
        // the shirt's colour; a new hair colour gets its own highlight). Only an exact built-in match is "built-in".
        const eff = effective(r.field)?.toLowerCase();
        const builtin = r.inherited && isHexColour(r.value) ? r.value.toLowerCase() : undefined;
        m.shown = eff ?? builtin;
        if (m.shown === undefined) delete m.shown;
        if (r.inherited) m.source = builtin !== undefined && (eff === undefined || eff === builtin) ? 'builtin' : 'auto';
      }
    }
    return m;
  });
}

export interface LookSections {
  /** head, build, outfit, skin. */
  shape: LookFieldModel[];
  /** The colours that show on this look, in `LOOK_COLOUR_GROUPS` (empty groups left out). */
  colours: { id: string; title: string; rows: LookFieldModel[] }[];
  /** The on/off options that show on this look. */
  options: LookFieldModel[];
  /** Fields that don't change this look right now (behind "More"). */
  more: LookFieldModel[];
}

/** Splits the editor's rows into the sections it shows; fields that don't apply go to `more`. */
export function lookSections(models: readonly LookFieldModel[]): LookSections {
  const by = new Map(models.map((m) => [m.field, m]));
  const shape = models.filter((m) => m.kind === 'enum');
  const colours = LOOK_COLOUR_GROUPS.map((g) => ({ id: g.id, title: g.title, rows: g.fields.map((f) => by.get(f)).filter((m): m is LookFieldModel => m !== undefined && m.used) }))
    .filter((g) => g.rows.length > 0);
  const options = models.filter((m) => m.kind === 'boolean' && m.used);
  const more = models.filter((m) => m.kind !== 'enum' && !m.used);
  return { shape, colours, options, more };
}

/** A key that changes only when the editor's layout must be rebuilt (which rows show where), not when a value changes. */
export function lookLayoutKey(s: LookSections): string {
  return [s.shape.map((m) => m.field).join(','), s.colours.map((g) => `${g.id}:${g.rows.map((m) => m.field).join(',')}`).join(';'), s.options.map((m) => m.field).join(','), s.more.map((m) => m.field).join(',')].join('|');
}

// ---------------------------------------------------------------------------------------------------------------------
// The lines editor

export type LinesOp =
  | { op: 'set'; index: number; text: string }
  | { op: 'add' }
  | { op: 'remove'; index: number }
  /** A paste with line breaks: `text` is the field's whole new text; each line becomes a line of speech from `index` on. */
  | { op: 'paste'; index: number; text: string };

export interface LinesResult {
  lines: string[];
  /** The line to focus afterwards; null = the "Add a line" button. */
  focus: number | null;
}

/** Edits a slot's lines. At most `max` lines of at most `maxLen` characters; blank lines are kept while typing (a save drops them). */
export function editLines(lines: readonly string[], op: LinesOp, max: number = THEME_LIMITS.lines, maxLen: number = THEME_LIMITS.line): LinesResult {
  const out = lines.slice(0, max).map((l) => l.slice(0, maxLen));
  switch (op.op) {
    case 'set': {
      if (op.index < 0 || op.index >= out.length) return { lines: out, focus: null };
      out[op.index] = op.text.slice(0, maxLen);
      return { lines: out, focus: op.index };
    }
    case 'add': {
      if (out.length >= max) return { lines: out, focus: out.length - 1 };
      out.push('');
      return { lines: out, focus: out.length - 1 };
    }
    case 'remove': {
      if (op.index < 0 || op.index >= out.length) return { lines: out, focus: null };
      out.splice(op.index, 1);
      return { lines: out, focus: out.length === 0 ? null : Math.min(op.index, out.length - 1) };
    }
    case 'paste': {
      if (op.index < 0 || op.index >= out.length) return { lines: out, focus: null };
      const pieces = op.text.split(/\r\n|\r|\n/).map((s) => s.trim().slice(0, maxLen));
      const first = pieces.shift() ?? '';
      const rest = pieces.filter((s) => s !== '');
      out[op.index] = first;
      const room = Math.max(0, max - out.length);
      const added = rest.slice(0, room);
      out.splice(op.index + 1, 0, ...added);
      return { lines: out, focus: op.index + added.length };
    }
    default:
      return { lines: out, focus: null };
  }
}

/** "3 of 60 lines" style counter text. */
export function linesCount(n: number, max: number = THEME_LIMITS.lines): string {
  return n === 0 ? 'No lines of their own' : `${n} of ${max} line${max === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Colour drags

export interface ThrottleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export interface Throttle<T> {
  /** A new value: sent at once when the last send was at least `ms` ago, else once that time is up (the newest value wins). */
  push(value: T): void;
  /** Sends a waiting value now (e.g. the picker's `change` at the end of a drag). */
  flush(): void;
  /** Drops a waiting value. */
  cancel(): void;
}

/**
 * Leading and trailing throttle: a colour picker fires `input` on every mouse move; this sends at most one edit per `ms`,
 * always ending with the last value. Use an interval a little longer than the shell's preview debounce (120 ms), so the
 * office preview still updates during a drag.
 */
export function throttle<T>(send: (value: T) => void, ms: number, timers: ThrottleTimers): Throttle<T> {
  let last = -Infinity;
  let waiting: { value: T } | null = null;
  let handle: unknown = null;
  const fire = (): void => {
    handle = null;
    if (waiting === null) return;
    const v = waiting.value;
    waiting = null;
    last = timers.now();
    send(v);
  };
  return {
    push(value) {
      waiting = { value };
      const since = timers.now() - last;
      if (since >= ms && handle === null) {
        fire();
        return;
      }
      if (handle === null) handle = timers.set(fire, Math.max(0, ms - since));
    },
    flush() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      fire();
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      waiting = null;
    },
  };
}
