/**
 * Front desk logic (task 3.9): the pure, DOM-free model behind the Front desk panel. No DOM, no art imports.
 * Things that live in the art registry (a slot's built-in look) are injected by the panel.
 *
 * Contents:
 *   1. the draft and its operations (`draftFrom`, `setField`, `clearField`, `resetLook`, `resetColors`, `toThemeJson`)
 *   2. the slot list (`slotList`)
 *   3. the inherited view (`inheritedLook`, `inheritedText`)
 *   4. the dirty / conflict state machine (`editorStep`, `saveAction`, `saveChoices`, `canClose`, ...)
 *   5. what a save would drop (`dropReport`)
 *   6. the Settings tab view model (`settingsView`, `validateSettingInput`)
 *   7. the contrast check (`contrastRatio`, `signReadability`)
 *   8. draft persistence (`serializeDraft`, `restoreDraft`)
 */
import {
  FRONT_DESK_BOOLEAN_SETTINGS, FRONT_DESK_ENUM_VALUES, FRONT_DESK_SETTINGS, FRONT_DESK_TEXT_SETTINGS, LIMITS,
} from '../../src/shared/protocol.ts';
import type { FrontDeskSetting, FrontDeskSettingKey, FrontDeskSettingValue, FrontDeskSource, FrontDeskState, WebviewToHost } from '../../src/shared/protocol.ts';
import { BUILDS, HEAD_STYLES, LINE_POOL_KEYS, LINE_POOL_KIND, NPC_KEYS, OFFICE_COLOR_KEYS, OUTFITS, SKIN_TONES, THEME_LIMITS, TITLE_KEYS, parseTheme, trimTrailingPlaceholders } from '../../src/shared/theme.ts';
import type { LineMode, LookSpec, OfficeColorKey, OfficeTheme, PersonSpec, StaffSpec, TempSpec } from '../../src/shared/theme.ts';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------------------------------
// Slots and fields

/** Id of an editor slot: `'sign'`, `'manager'`, `'receptionist'`, `'staff-<i>'` (0 to 7) or `'temp-<j>'` (0 to 5). Same ids as the art registry. */
export type SlotId = string;

export type SlotGroup = 'sign' | 'manager' | 'receptionist' | 'staff' | 'temp';

export interface ParsedSlot {
  group: SlotGroup;
  /** Zero-based position within staff or temps; undefined for the other groups. */
  index?: number;
}

/** Splits a slot id; null when it is not a valid slot of this office (staff beyond 8, temps beyond 6, anything else). */
export function parseSlotId(id: string): ParsedSlot | null {
  if (id === 'sign' || id === 'manager' || id === 'receptionist') return { group: id };
  const m = /^(staff|temp)-(0|[1-9]\d?)$/.exec(id);
  if (m === null) return null;
  const index = Number(m[2]);
  const max = m[1] === 'staff' ? THEME_LIMITS.staff : THEME_LIMITS.temps;
  if (index >= max) return null;
  return { group: m[1] as 'staff' | 'temp', index };
}

/** Every slot id in editor order. */
export const SLOT_IDS: readonly SlotId[] = [
  'sign', 'manager', 'receptionist',
  ...Array.from({ length: THEME_LIMITS.staff }, (_, i) => `staff-${i}`),
  ...Array.from({ length: THEME_LIMITS.temps }, (_, j) => `temp-${j}`),
];

export type LookFieldKind = 'enum' | 'colour' | 'boolean';

export interface LookFieldInfo {
  key: keyof LookSpec;
  kind: LookFieldKind;
  /** The allowed values of an enum field. */
  options?: readonly string[];
}

/** Every LookSpec field in the order the look editor shows them. */
export const LOOK_FIELDS: readonly LookFieldInfo[] = [
  { key: 'head', kind: 'enum', options: HEAD_STYLES },
  { key: 'build', kind: 'enum', options: BUILDS },
  { key: 'outfit', kind: 'enum', options: OUTFITS },
  { key: 'skin', kind: 'enum', options: SKIN_TONES },
  ...(['hair', 'hairHighlight', 'eye', 'shirt', 'outer', 'sleeve', 'tie', 'collar', 'accent', 'accent2', 'pants', 'legs', 'shoes', 'glasses', 'facialHair', 'bow', 'beltColor'] as const)
    .map((key): LookFieldInfo => ({ key, kind: 'colour' })),
  ...(['skirt', 'shortSleeves', 'belt'] as const).map((key): LookFieldInfo => ({ key, kind: 'boolean' })),
];

const LOOK_KEYS: ReadonlySet<string> = new Set(LOOK_FIELDS.map((f) => f.key));
const COLOR_KEYS: ReadonlySet<string> = new Set(OFFICE_COLOR_KEYS);
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------------------------------------------------
// 1. The draft

/** The editable copy of the theme. Same shape as `OfficeTheme`; may hold `{}` placeholders and not-yet-valid text until saved. */
export type Draft = OfficeTheme;

/** A value `setField` accepts. `undefined`, `null` and the empty string clear the field. */
export type FieldValue = string | boolean | readonly string[] | readonly (readonly [string, string])[] | { project?: string; title?: string } | null | undefined;

/** A deep copy of a theme (null or undefined = the built-in office = an empty draft). Never shares objects with the input. */
export function draftFrom(theme: OfficeTheme | null | undefined): Draft {
  return theme === null || theme === undefined ? {} : (JSON.parse(JSON.stringify(theme)) as Draft);
}

type FieldTarget =
  | { kind: 'company' }
  | { kind: 'branch' }
  | { kind: 'smallTalk' }
  | { kind: 'color'; key: OfficeColorKey }
  | { kind: 'slot'; slot: ParsedSlot; keys: string[] };

/** Which fields each slot group has. */
const SLOT_FIELDS: Record<'manager' | 'receptionist' | 'staff' | 'temp', readonly string[]> = {
  manager: ['name', 'lines', 'look'],
  receptionist: ['name', 'lines', 'look'],
  staff: ['name', 'role', 'lines', 'pin', 'look'],
  temp: ['name', 'look'],
};

/**
 * Paths: `company`, `branch`, `smallTalk`, `colors.<key>`, and `<slotId>.<field>` with the field `name`, `role`, `lines`,
 * `pin`, `pin.project`, `pin.title` or `look.<LookSpec key>` (only the fields that slot has: temps have no role, lines or
 * pin; the manager and receptionist have no role or pin). Null for anything else.
 */
function parsePath(path: string): FieldTarget | null {
  if (path === 'company') return { kind: 'company' };
  if (path === 'branch') return { kind: 'branch' };
  if (path === 'smallTalk') return { kind: 'smallTalk' };
  const dot = path.indexOf('.');
  if (dot < 0) return null;
  const head = path.slice(0, dot);
  const rest = path.slice(dot + 1).split('.');
  if (head === 'colors') {
    return rest.length === 1 && COLOR_KEYS.has(rest[0]!) ? { kind: 'color', key: rest[0] as OfficeColorKey } : null;
  }
  const slot = parseSlotId(head);
  if (slot === null || slot.group === 'sign') return null;
  const field = rest[0]!;
  if (!SLOT_FIELDS[slot.group].includes(field)) return null;
  if (field === 'look') return rest.length === 2 && LOOK_KEYS.has(rest[1]!) ? { kind: 'slot', slot, keys: rest } : null;
  if (field === 'pin') return rest.length === 1 || (rest.length === 2 && (rest[1] === 'project' || rest[1] === 'title')) ? { kind: 'slot', slot, keys: rest } : null;
  return rest.length === 1 ? { kind: 'slot', slot, keys: rest } : null;
}

/** True when `path` names a field `setField` understands (the panel can use it to catch typos in its wiring). */
export function isFieldPath(path: string): boolean {
  return parsePath(path) !== null;
}

/** Sets `keys` inside `obj` (copying along the way); empty look and pin objects are pruned, `undefined` deletes. */
function assoc(obj: Obj, keys: readonly string[], value: unknown): Obj {
  const [k, ...rest] = keys as [string, ...string[]];
  const next: Obj = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete next[k];
    else next[k] = value;
    return next;
  }
  const child = assoc(isObj(obj[k]) ? (obj[k] as Obj) : {}, rest, value);
  if (Object.keys(child).length === 0) delete next[k];
  else next[k] = child;
  return next;
}

/** Normalises what the UI hands in: '' and null clear, hex colours go lower case. Returns `undefined` for a wrong type. */
function fieldValue(keys: readonly string[], value: FieldValue): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const leaf = keys[keys.length - 1]!;
  if (keys[0] === 'look') {
    const info = LOOK_FIELDS.find((f) => f.key === leaf)!;
    if (info.kind === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    return typeof value === 'string' ? { ok: true, value: info.kind === 'colour' && HEX_RE.test(value) ? value.toLowerCase() : value } : { ok: false };
  }
  if (leaf === 'lines') return Array.isArray(value) && value.every((x) => typeof x === 'string') ? { ok: true, value: [...(value as string[])] } : { ok: false };
  if (leaf === 'pin') {
    if (!isObj(value)) return { ok: false };
    const pin: { project?: string; title?: string } = {};
    for (const k of ['project', 'title'] as const) {
      const v = (value as Obj)[k];
      if (typeof v === 'string' && v !== '') pin[k] = v;
      else if (v !== undefined && typeof v !== 'string') return { ok: false };
    }
    return { ok: true, value: Object.keys(pin).length === 0 ? undefined : pin };
  }
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

/**
 * Immutable field update; returns a new draft (the input is never changed). Writing to staff slot `i` or temp slot `j`
 * when earlier slots are missing fills them with `{}` placeholders, so the person keeps their position. A value of
 * `undefined`, `null` or `''` clears the field (same as `clearField`). An unknown path, a slot beyond the limits or a value
 * of the wrong type returns the draft unchanged. Content is not validated here (text may be half typed); `toThemeJson` and
 * `draftErrors` report invalid values.
 */
export function setField(draft: Draft, path: string, value: FieldValue): Draft {
  const target = parsePath(path);
  if (target === null) return draft;
  if (target.kind === 'company' || target.kind === 'branch') {
    const v = fieldValue([target.kind], value);
    if (!v.ok) return draft;
    const next: Draft = { ...draft };
    if (v.value === undefined) delete next[target.kind];
    else next[target.kind] = v.value as string;
    return next;
  }
  if (target.kind === 'smallTalk') {
    if (value === undefined || value === null) {
      const next: Draft = { ...draft };
      delete next.smallTalk;
      return next;
    }
    if (!Array.isArray(value)) return draft;
    const pairs = (value as readonly unknown[]).map((p) => (Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' ? ([p[0], p[1]] as [string, string]) : null));
    if (pairs.some((p) => p === null)) return draft;
    return { ...draft, smallTalk: pairs as [string, string][] };
  }
  if (target.kind === 'color') {
    const v = fieldValue(['color'], value);
    if (!v.ok) return draft;
    const colors: Obj = { ...(draft.colors ?? {}) };
    if (v.value === undefined) delete colors[target.key];
    else colors[target.key] = typeof v.value === 'string' && HEX_RE.test(v.value) ? v.value.toLowerCase() : v.value;
    const next: Draft = { ...draft };
    if (Object.keys(colors).length === 0) delete next.colors;
    else next.colors = colors as Draft['colors'];
    return next;
  }
  const v = fieldValue(target.keys, value);
  if (!v.ok) return draft;
  const { slot, keys } = target;
  const clearing = v.value === undefined;
  if (slot.group === 'manager' || slot.group === 'receptionist') {
    const cur = draft[slot.group];
    if (clearing && cur === undefined) return draft;
    const updated = assoc((cur ?? {}) as Obj, keys, v.value);
    const next: Draft = { ...draft };
    if (Object.keys(updated).length === 0) delete next[slot.group];
    else next[slot.group] = updated as NonNullable<Draft['manager']>;
    return next;
  }
  const listKey = slot.group === 'staff' ? 'staff' : 'temps';
  const list: Obj[] = [...((draft[listKey] ?? []) as Obj[])];
  const index = slot.index!;
  if (index >= list.length) {
    if (clearing) return draft;
    while (list.length < index) list.push({});
    list.push({});
  }
  list[index] = assoc(list[index]!, keys, v.value);
  return { ...draft, [listKey]: list as StaffSpec[] & TempSpec[] };
}

/** Removes one field (the value is inherited again). Same paths as `setField`; leaves `{}` placeholders in place. */
export function clearField(draft: Draft, path: string): Draft {
  return setField(draft, path, undefined);
}

/** "Reset to built-in look": removes the slot's whole `look`. Other fields and the slot's position stay. */
export function resetLook(draft: Draft, slot: SlotId): Draft {
  const p = parseSlotId(slot);
  if (p === null || p.group === 'sign') return draft;
  if (p.group === 'manager' || p.group === 'receptionist') {
    const cur = draft[p.group];
    if (cur === undefined || cur.look === undefined) return draft;
    const { look: _look, ...rest } = cur;
    const next: Draft = { ...draft };
    if (Object.keys(rest).length === 0) delete next[p.group];
    else next[p.group] = rest;
    return next;
  }
  const listKey = p.group === 'staff' ? 'staff' : 'temps';
  const list = draft[listKey] as Obj[] | undefined;
  const entry = list?.[p.index!];
  if (list === undefined || entry === undefined || entry.look === undefined) return draft;
  const { look: _look, ...rest } = entry;
  const copy = [...list];
  copy[p.index!] = rest;
  return { ...draft, [listKey]: copy as StaffSpec[] & TempSpec[] };
}

/** "Reset all" on the Colours tab: removes every colour override. */
export function resetColors(draft: Draft): Draft {
  if (draft.colors === undefined) return draft;
  const next: Draft = { ...draft };
  delete next.colors;
  return next;
}

// ---- Cleaning and output

function trimmed(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function cleanLook(raw: unknown): LookSpec | undefined {
  if (!isObj(raw)) return undefined;
  const out: Obj = {};
  for (const f of LOOK_FIELDS) {
    const v = raw[f.key];
    if (f.kind === 'boolean') {
      if (typeof v === 'boolean') out[f.key] = v;
      continue;
    }
    const t = trimmed(v);
    if (t !== undefined) out[f.key] = f.kind === 'colour' && HEX_RE.test(t) ? t.toLowerCase() : t;
  }
  return Object.keys(out).length === 0 ? undefined : (out as LookSpec);
}

function cleanLines(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(trimmed).filter((s): s is string => s !== undefined);
  return out.length === 0 ? undefined : out;
}

/** A pairs pool (an opener and a reply): both texts trimmed, a pair with both blank dropped. */
function cleanPairs(raw: unknown): [string, string][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((p): [string, string] => [typeof p?.[0] === 'string' ? p[0].trim() : '', typeof p?.[1] === 'string' ? p[1].trim() : ''])
    .filter((p) => p[0] !== '' || p[1] !== '');
  return out.length === 0 ? undefined : out;
}

function cleanPin(raw: unknown): { project?: string; title?: string } | undefined {
  if (!isObj(raw)) return undefined;
  const pin: { project?: string; title?: string } = {};
  const project = trimmed(raw.project);
  const title = trimmed(raw.title);
  if (project !== undefined) pin.project = project;
  if (title !== undefined) pin.title = title;
  return Object.keys(pin).length === 0 ? undefined : pin;
}

function cleanPerson(raw: unknown, fields: readonly string[]): Obj {
  const out: Obj = {};
  if (!isObj(raw)) return out;
  if (fields.includes('name')) {
    const n = trimmed(raw.name);
    if (n !== undefined) out.name = n;
  }
  if (fields.includes('role')) {
    const r = trimmed(raw.role);
    if (r !== undefined) out.role = r;
  }
  if (fields.includes('pin')) {
    const p = cleanPin(raw.pin);
    if (p !== undefined) out.pin = p;
  }
  const look = cleanLook(raw.look);
  if (look !== undefined) out.look = look;
  if (fields.includes('lines')) {
    const l = cleanLines(raw.lines);
    if (l !== undefined) out.lines = l;
  }
  return out;
}

/**
 * The canonical form of a draft, the one that is saved and compared: text trimmed, blank text, blank lines and empty
 * objects and lists removed, colours lower case, trailing `{}` placeholders trimmed (middle ones stay). The result is built
 * fresh; it still may hold invalid values, which `draftErrors` reports.
 */
export function toTheme(draft: Draft | null | undefined): OfficeTheme {
  const out: OfficeTheme = {};
  if (!draft) return out;
  // Key order is the canonical one (see `TOP_KEYS`). The fields the editor has no controls for yet (name, description,
  // lineMode, titles, lines and the four side characters) are carried through, cleaned the same way, so a save keeps them.
  const name = trimmed(draft.name);
  if (name !== undefined) out.name = name;
  const description = trimmed(draft.description);
  if (description !== undefined) out.description = description;
  const company = trimmed(draft.company);
  if (company !== undefined) out.company = company;
  const branch = trimmed(draft.branch);
  if (branch !== undefined) out.branch = branch;
  // A wrong value is kept so that parseTheme reports it, like an unknown colour.
  const lineMode = trimmed(draft.lineMode);
  if (lineMode !== undefined) out.lineMode = lineMode as LineMode;
  if (isObj(draft.titles)) {
    const titles: Obj = {};
    for (const k of TITLE_KEYS) {
      const t = trimmed((draft.titles as Obj)[k]);
      if (t !== undefined) titles[k] = t;
    }
    if (Object.keys(titles).length > 0) out.titles = titles as OfficeTheme['titles'];
  }
  for (const k of ['manager', 'receptionist'] as const) {
    const p = cleanPerson(draft[k], SLOT_FIELDS[k]);
    if (Object.keys(p).length > 0) out[k] = p as NonNullable<OfficeTheme['manager']>;
  }
  for (const k of NPC_KEYS) {
    const p = cleanPerson(draft[k], SLOT_FIELDS.temp);
    if (Object.keys(p).length > 0) out[k] = p as PersonSpec;
  }
  if (isObj(draft.colors)) {
    const colors: Obj = {};
    const src = draft.colors as Obj;
    for (const k of OFFICE_COLOR_KEYS) {
      const t = trimmed(src[k]);
      if (t !== undefined) colors[k] = HEX_RE.test(t) ? t.toLowerCase() : t;
    }
    // Unknown colour names are kept so that parseTheme reports them rather than a save silently dropping them.
    for (const k of Object.keys(src)) {
      if (!COLOR_KEYS.has(k) && typeof src[k] === 'string') colors[k] = src[k];
    }
    if (Object.keys(colors).length > 0) out.colors = colors as OfficeTheme['colors'];
  }
  if (isObj(draft.lines)) {
    const lines: Obj = {};
    for (const k of LINE_POOL_KEYS) {
      const pool = LINE_POOL_KIND[k] === 'pairs' ? cleanPairs((draft.lines as Obj)[k]) : cleanLines((draft.lines as Obj)[k]);
      if (pool !== undefined) lines[k] = pool;
    }
    if (Object.keys(lines).length > 0) out.lines = lines as OfficeTheme['lines'];
  }
  const smallTalk = cleanPairs(draft.smallTalk);
  if (smallTalk !== undefined) out.smallTalk = smallTalk;
  if (Array.isArray(draft.staff)) {
    const staff = trimTrailingPlaceholders(draft.staff.map((s) => cleanPerson(s, SLOT_FIELDS.staff) as StaffSpec));
    if (staff.length > 0) out.staff = staff;
  }
  if (Array.isArray(draft.temps)) {
    const temps = trimTrailingPlaceholders(draft.temps.map((t) => cleanPerson(t, SLOT_FIELDS.temp) as TempSpec));
    if (temps.length > 0) out.temps = temps;
  }
  return out;
}

/** Every problem `parseTheme` finds in the draft (what the host would refuse to save). Empty = valid. */
export function draftErrors(draft: Draft): string[] {
  return parseTheme(JSON.parse(JSON.stringify(toTheme(draft)))).errors;
}

/** The draft as the office should show it while editing: cleaned, with invalid values left out so nothing renders half valid. */
export function previewTheme(draft: Draft): OfficeTheme {
  return parseTheme(JSON.parse(JSON.stringify(toTheme(draft)))).theme;
}

/** True when the draft would save something different from the host's theme (compares canonical forms, so `staff: []` equals no staff). */
export function draftChanged(draft: Draft, hostTheme: OfficeTheme | null | undefined): boolean {
  return JSON.stringify(toTheme(draft)) !== JSON.stringify(toTheme(hostTheme));
}

export type ThemeJsonResult = { ok: true; json: string } | { ok: false; error: string; errors: string[] };

/**
 * The text for `saveTheme` / `saveThemeAs`: the canonical theme as 2-space JSON with a trailing newline. Fails when the
 * draft has invalid values (the host refuses a theme with any error, so the panel must fix them first) or when the text
 * would reach `LIMITS.themeJsonChars` (`maxChars` is for tests; the cap is 512 KiB, which fits a theme that uses every `THEME_LIMITS` maximum (about 263k characters), and the check keeps a hand-built oversized draft from being posted). The host re-parses and re-orders it, so the key order here is only for readability.
 */
export function toThemeJson(draft: Draft, maxChars: number = LIMITS.themeJsonChars): ThemeJsonResult {
  const theme = toTheme(draft);
  const errors = parseTheme(JSON.parse(JSON.stringify(theme))).errors;
  if (errors.length > 0) {
    return { ok: false, error: errors.length === 1 ? errors[0]! : `${errors[0]!} (and ${errors.length - 1} more)`, errors };
  }
  const json = JSON.stringify(theme, null, 2) + '\n';
  if (json.length >= maxChars) {
    return { ok: false, error: `The theme is too big to save (${json.length} of ${maxChars} characters).`, errors: [] };
  }
  return { ok: true, json };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Slot list

/**
 * Built-in wording the panel can override. `role` is the built-in role label of a slot (shown dimmed as "built-in"), `name`
 * the built-in name (empty = no name shown), `desk` the desk's name for a staff slot.
 */
export interface BuiltinText {
  role(slot: SlotId): string;
  name?(slot: SlotId): string;
  desk?(staffIndex: number): string;
}

/** The built-in roles of the eight staff desks, as in the starter theme (`themeStarter.ts`). Staff slot 2 is the IT Help Desk. */
export const DEFAULT_STAFF_ROLES: readonly string[] = [
  'Deputy Vice Associate', 'Salesman', 'IT Help Desk', 'Accountant (crosswords)', 'Accountant (cats)', 'Accountant (chili)', 'Saleswoman (knitting)', 'HR Representative',
];

/** Built-in wording used when the panel injects none: the roles above, "Regional Manager", "Receptionist" and "Temp". */
export const DEFAULT_BUILTIN_TEXT: BuiltinText = {
  role(slot) {
    const p = parseSlotId(slot);
    if (p === null) return '';
    if (p.group === 'sign') return 'Office sign';
    if (p.group === 'manager') return 'Regional Manager';
    if (p.group === 'receptionist') return 'Receptionist';
    if (p.group === 'staff') return DEFAULT_STAFF_ROLES[p.index!] ?? `Staff ${p.index! + 1}`;
    return 'Temp';
  },
  name(slot) {
    return slot === 'manager' ? 'You' : slot === 'receptionist' ? 'Receptionist' : '';
  },
  desk(i) {
    return DEFAULT_STAFF_ROLES[i] ?? `Desk ${i + 1}`;
  },
};

export interface SlotEntry {
  id: SlotId;
  group: SlotGroup;
  index?: number;
  /** The list heading, e.g. "Office sign", "Manager", "Staff 3 · IT Help Desk desk", "Temp 1". */
  label: string;
  /** What to show for the person: the theme's name (for staff, else the theme's role), else the built-in role. */
  name: string;
  /** True when `name` is the theme's own text (so not inherited from built-in). */
  named: boolean;
  /** True when the draft sets anything for this slot. */
  customised: boolean;
  /** True when this slot's canonical content differs from the host's saved theme (an unsaved edit). */
  changed: boolean;
}

/** The part of a canonical theme that belongs to one slot, as JSON text, for comparing and for "customised". */
function slotContent(theme: OfficeTheme, slot: SlotId): Obj | undefined {
  const p = parseSlotId(slot);
  if (p === null) return undefined;
  const t = toTheme(theme) as Obj;
  if (p.group === 'sign') {
    const o: Obj = {};
    if (t.company !== undefined) o.company = t.company;
    if (t.branch !== undefined) o.branch = t.branch;
    return Object.keys(o).length === 0 ? undefined : o;
  }
  if (p.group === 'manager' || p.group === 'receptionist') return t[p.group] as Obj | undefined;
  const list = t[p.group === 'staff' ? 'staff' : 'temps'] as Obj[] | undefined;
  const entry = list?.[p.index!];
  return entry === undefined || Object.keys(entry).length === 0 ? undefined : entry;
}

/** The editor's list in order: Office sign, Manager, Receptionist, Staff 1 to 8, Temps 1 to 6. */
export function slotList(draft: Draft, hostTheme: OfficeTheme | null | undefined, text: BuiltinText = DEFAULT_BUILTIN_TEXT): SlotEntry[] {
  return SLOT_IDS.map((id): SlotEntry => {
    const p = parseSlotId(id)!;
    const content = slotContent(draft, id);
    let label: string;
    let own: string | undefined;
    if (p.group === 'sign') {
      label = 'Office sign';
      own = trimmed(content?.company);
    } else if (p.group === 'manager') {
      label = 'Manager';
      own = trimmed(content?.name);
    } else if (p.group === 'receptionist') {
      label = 'Receptionist';
      own = trimmed(content?.name);
    } else if (p.group === 'staff') {
      const desk = text.desk?.(p.index!) ?? DEFAULT_BUILTIN_TEXT.desk!(p.index!);
      label = `Staff ${p.index! + 1} · ${desk} desk`;
      own = trimmed(content?.name) ?? trimmed(content?.role);
    } else {
      label = `Temp ${p.index! + 1}`;
      own = trimmed(content?.name);
    }
    const entry: SlotEntry = {
      id, group: p.group, label,
      name: own ?? text.role(id),
      named: own !== undefined,
      customised: content !== undefined,
      changed: JSON.stringify(content ?? null) !== JSON.stringify(slotContent(hostTheme ?? {}, id) ?? null),
    };
    if (p.index !== undefined) entry.index = p.index;
    return entry;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Inherited view

export interface LookRow {
  field: keyof LookSpec;
  kind: LookFieldKind;
  options?: readonly string[];
  /** The draft's value, else the built-in's; undefined when neither sets it (e.g. `eye` on most looks). */
  value: string | boolean | undefined;
  /** True when the draft does not set this field, so `value` is the built-in's (show it dimmed, marked "built-in"). */
  inherited: boolean;
}

/** The look of a slot as the editor shows it: every LookSpec field with its value and whether it is inherited. */
export function inheritedLook(slot: SlotId, draft: Draft, builtinSpecOf: (slotId: SlotId) => LookSpec): LookRow[] {
  const p = parseSlotId(slot);
  if (p === null || p.group === 'sign') return [];
  const own = (slotContent(draft, slot)?.look ?? {}) as Obj;
  const builtin = builtinSpecOf(slot) as Obj;
  return LOOK_FIELDS.map((f): LookRow => {
    const mine = own[f.key] as string | boolean | undefined;
    const row: LookRow = {
      field: f.key, kind: f.kind,
      value: mine !== undefined ? mine : (builtin[f.key] as string | boolean | undefined),
      inherited: mine === undefined,
    };
    if (f.options !== undefined) row.options = f.options;
    return row;
  });
}

/** A name or role as the editor shows it: the draft's text, else the built-in's (empty text when there is none). */
export function inheritedText(slot: SlotId, field: 'name' | 'role', draft: Draft, text: BuiltinText = DEFAULT_BUILTIN_TEXT): { value: string; inherited: boolean } {
  const mine = trimmed(slotContent(draft, slot)?.[field]);
  if (mine !== undefined) return { value: mine, inherited: false };
  return { value: field === 'role' ? text.role(slot) : (text.name?.(slot) ?? DEFAULT_BUILTIN_TEXT.name!(slot)), inherited: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Dirty and conflict state machine

export type EditorStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';

/** What the user chose to do with Save: write the file, write a new file, or force over a changed file (`force: true`). */
export type SaveChoice = 'save' | 'saveAs' | 'overwrite';

export interface EditorState {
  status: EditorStatus;
  /** The host revision the draft is based on (`FrontDeskSource.rev`); sent as `saveTheme.rev`. */
  rev?: string;
  /** The newest host revision seen. Differs from `rev` while dirty = the file changed on disk. */
  hostRev?: string;
  /** The user chose "Keep mine": the next save is Overwrite anyway or Save as. */
  keepMine: boolean;
  /** The failure text while status is 'error'. */
  message?: string;
  /** What the running save is (status 'saving'). */
  saving?: SaveChoice;
  /** Where to go back to when a running save is cancelled or fails: 'dirty' or 'error'. */
  before?: 'dirty' | 'error';
  /** The draft was edited while a save was running, so it stays dirty after the save succeeds. */
  editedWhileSaving: boolean;
}

export type EditorEvent =
  /** The draft changed. `matchesHost: true` (the draft is again equal to the host's theme) makes a plain dirty state clean. */
  | { type: 'edit'; matchesHost?: boolean }
  | { type: 'discard' }
  | { type: 'saveRequested'; choice?: SaveChoice }
  /** A `frontDeskDone` that answers the running save (the panel matches the `reqId`). Not for other calls' replies. */
  | { type: 'done'; ok: boolean; message?: string; conflict?: boolean; cancelled?: boolean }
  /** A `frontDesk` push or reply with the source's `rev` (undefined for built-in and preset sources). */
  | { type: 'hostTheme'; rev?: string }
  | { type: 'loadIt' }
  | { type: 'keepMine' }
  /** The theme source changed (another file, the built-in office, a preset, a Save as): the draft is dropped. */
  | { type: 'sourceChanged'; rev?: string }
  | { type: 'dismissError' };

/**
 * What the panel must do besides showing the new state. `'adopt'` = replace the draft with the host's current theme
 * (`draftFrom(ctx.hostTheme())`) and clear the preview.
 */
export type EditorEffect = 'adopt';

export interface EditorStep {
  state: EditorState;
  effect?: EditorEffect;
}

/** The starting state: clean, based on the source's current `rev`. */
export function initialEditorState(rev?: string): EditorState {
  const s: EditorState = { status: 'clean', keepMine: false, editedWhileSaving: false };
  if (rev !== undefined) {
    s.rev = rev;
    s.hostRev = rev;
  }
  return s;
}

function cleanAt(rev: string | undefined): EditorState {
  return initialEditorState(rev);
}

/** The transition function. Pure: returns a new state (and maybe an effect); unexpected events leave the state as it was. */
export function editorStep(state: EditorState, ev: EditorEvent): EditorStep {
  const same: EditorStep = { state };
  switch (ev.type) {
    case 'edit': {
      if (state.status === 'clean') return { state: { ...state, status: 'dirty', keepMine: false } };
      if (state.status === 'dirty') {
        if (ev.matchesHost === true && state.hostRev === state.rev && !state.keepMine) return { state: cleanAt(state.rev) };
        return same;
      }
      if (state.status === 'saving') return { state: { ...state, editedWhileSaving: true } };
      if (state.status === 'error') {
        const { message: _m, ...rest } = state;
        return { state: { ...rest, status: 'dirty' } };
      }
      return same; // conflict: the banner stays until the user chooses
    }
    case 'discard': {
      if (state.status === 'clean' || state.status === 'saving') return same;
      return { state: cleanAt(state.hostRev), effect: 'adopt' };
    }
    case 'saveRequested': {
      if (state.status !== 'dirty' && state.status !== 'error') return same;
      const { message: _m, ...rest } = state;
      const choice: SaveChoice = ev.choice ?? (state.keepMine ? 'overwrite' : 'save');
      return { state: { ...rest, status: 'saving', saving: choice, before: state.status, editedWhileSaving: false } };
    }
    case 'done': {
      if (state.status !== 'saving') return same;
      const { message: _m, saving: _s, before: _b, ...rest } = state;
      if (ev.ok && ev.cancelled === true) return { state: { ...rest, status: 'dirty' } };
      if (ev.ok) {
        if (state.editedWhileSaving) return { state: { ...rest, status: 'dirty', rev: state.hostRev, keepMine: false, editedWhileSaving: false } };
        return { state: cleanAt(state.hostRev) };
      }
      if (ev.conflict === true) return { state: { ...rest, status: 'conflict', keepMine: false } };
      return { state: { ...rest, status: 'error', message: ev.message ?? 'Could not save.' } };
    }
    case 'hostTheme': {
      if (ev.rev === state.hostRev) return same;
      if (state.status === 'clean') return { state: cleanAt(ev.rev), effect: 'adopt' };
      // Dirty, error or conflict: a newer file turns on the "changed on disk" banner and withdraws an earlier Keep mine.
      // While saving, only the revision is noted (the host answers the save itself, with done or a conflict).
      const next: EditorState = { ...state };
      if (ev.rev === undefined) delete next.hostRev;
      else next.hostRev = ev.rev;
      if (state.status !== 'saving') next.keepMine = false;
      return { state: next };
    }
    case 'loadIt': {
      if (state.status === 'clean' || state.status === 'saving') return same;
      return { state: cleanAt(state.hostRev), effect: 'adopt' };
    }
    case 'keepMine': {
      const onBanner = state.status === 'conflict' || (state.status === 'dirty' && state.hostRev !== state.rev);
      if (!onBanner) return same;
      const next: EditorState = { ...state, status: 'dirty', keepMine: true };
      if (state.hostRev === undefined) delete next.rev;
      else next.rev = state.hostRev;
      return { state: next };
    }
    case 'sourceChanged':
      return { state: cleanAt(ev.rev), effect: 'adopt' };
    case 'dismissError': {
      if (state.status !== 'error') return same;
      const { message: _m, ...rest } = state;
      return { state: { ...rest, status: 'dirty' } };
    }
  }
}

/** Just the new state of `editorStep`. */
export function editorReduce(state: EditorState, ev: EditorEvent): EditorState {
  return editorStep(state, ev).state;
}

/** False while there are unsaved edits (dirty, saving, conflict or error): the panel's `beforeClose` then asks "Keep editing / Discard". */
export function canClose(state: EditorState): boolean {
  return state.status === 'clean';
}

export type Banner = 'none' | 'changedOnDisk' | 'conflict' | 'overwrite';

/**
 * Which banner the panel shows: `conflict` (a save found the file changed) and `changedOnDisk` (it changed while you
 * were editing) both offer Load it / Keep mine; `overwrite` (after Keep mine) goes with the Overwrite anyway / Save as
 * buttons.
 */
export function bannerOf(state: EditorState): Banner {
  if (state.status === 'conflict') return 'conflict';
  if (state.status === 'clean') return 'none';
  if (state.status === 'dirty' && state.hostRev !== state.rev) return 'changedOnDisk';
  if (state.keepMine && (state.status === 'dirty' || state.status === 'error')) return 'overwrite';
  return 'none';
}

/** True when the source cannot be saved over: not a file, or the host reports a read-only reason (builtin, preset, workspace, notJson, missing). */
export function isReadOnlySource(source: FrontDeskSource): boolean {
  return source.kind !== 'file' || !source.editable || source.readOnly !== undefined;
}

/** `'saveAs'` on the built-in office, an example office or any read-only source, else `'save'`. */
export function saveAction(_state: EditorState, source: FrontDeskSource): 'save' | 'saveAs' {
  return isReadOnlySource(source) ? 'saveAs' : 'save';
}

/** The save buttons to offer now: after Keep mine on a writable file, Overwrite anyway and Save as; otherwise one button. */
export function saveChoices(state: EditorState, source: FrontDeskSource): SaveChoice[] {
  const action = saveAction(state, source);
  if (action === 'save' && state.keepMine) return ['overwrite', 'saveAs'];
  return [action];
}

/** Button text for a choice: "Save", "Save as…" or "Overwrite anyway". */
export function saveLabel(choice: SaveChoice): string {
  return choice === 'save' ? 'Save' : choice === 'saveAs' ? 'Save as…' : 'Overwrite anyway';
}

/**
 * The message to post for a save choice, or null when it cannot be built (no revision for a file save). `overwrite`
 * sends the newest revision with `force: true`. `themeJson` comes from `toThemeJson`.
 */
export function saveMessage(
  state: EditorState,
  choice: SaveChoice,
  reqId: string,
  themeJson: string,
): Extract<WebviewToHost, { type: 'saveTheme' | 'saveThemeAs' }> | null {
  if (choice === 'saveAs') return { type: 'saveThemeAs', reqId, themeJson };
  const rev = choice === 'overwrite' ? state.hostRev : state.rev;
  if (rev === undefined) return null;
  return choice === 'overwrite' ? { type: 'saveTheme', reqId, rev, themeJson, force: true } : { type: 'saveTheme', reqId, rev, themeJson };
}

/** A stable key for the theme source; a different key means a different theme (the saved draft is dropped). */
export function sourceKey(source: FrontDeskSource): string {
  return `${source.kind}|${source.presetId ?? ''}|${source.kind === 'file' ? (source.path ?? source.label) : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. What a save would drop

/** The canonical top-level key order, the same as `serializeTheme` writes (and every key a theme may hold). */
const TOP_KEYS = [
  '$schema', 'name', 'description', 'company', 'branch', 'lineMode', 'titles', 'manager', 'receptionist',
  ...NPC_KEYS, 'colors', 'lines', 'smallTalk', 'staff', 'temps',
] as const;
const HOST_KEYS = ['name', 'look', 'lines'] as const;
const STAFF_KEYS = ['name', 'role', 'pin', 'look', 'lines'] as const;
const TEMP_KEYS = ['name', 'look'] as const;
const PIN_KEYS = ['project', 'title'] as const;
const LOOK_ORDER: readonly string[] = LOOK_FIELDS.map((f) => f.key);

function unknownKeys(obj: unknown, known: readonly string[], path: string, out: string[]): void {
  if (!isObj(obj)) return;
  for (const k of Object.keys(obj)) if (!known.includes(k)) out.push(`Unknown key "${path === '' ? k : `${path}.${k}`}" will be dropped.`);
}

function walkUnknown(raw: Obj, out: string[]): void {
  unknownKeys(raw, TOP_KEYS, '', out);
  for (const k of ['manager', 'receptionist'] as const) {
    const o = raw[k];
    unknownKeys(o, HOST_KEYS, k, out);
    if (isObj(o)) unknownKeys(o.look, LOOK_ORDER, `${k}.look`, out);
  }
  // The side characters hold the same fields as a temp. Unknown title and pool names are reported by `parseTheme` instead.
  for (const k of NPC_KEYS) {
    const o = raw[k];
    unknownKeys(o, TEMP_KEYS, k, out);
    if (isObj(o)) unknownKeys(o.look, LOOK_ORDER, `${k}.look`, out);
  }
  for (const [k, keys] of [['staff', STAFF_KEYS], ['temps', TEMP_KEYS]] as const) {
    const list = raw[k];
    if (!Array.isArray(list)) continue;
    list.forEach((e, i) => {
      unknownKeys(e, keys, `${k}[${i}]`, out);
      if (isObj(e)) {
        unknownKeys(e.look, LOOK_ORDER, `${k}[${i}].look`, out);
        if (k === 'staff') unknownKeys(e.pin, PIN_KEYS, `${k}[${i}].pin`, out);
      }
    });
  }
}

/** The value at a path like `staff[2].look.hair`, or undefined. */
function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    const m = /^([A-Za-z0-9_$]+)((?:\[\d+\])*)$/.exec(part);
    if (m === null || !isObj(cur)) return undefined;
    cur = cur[m[1]!];
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

function inOrder(keys: readonly string[], order: readonly string[]): boolean {
  let last = -1;
  for (const k of keys) {
    const i = order.indexOf(k);
    if (i < 0) continue;
    if (i < last) return false;
    last = i;
  }
  return true;
}

function keyOrderOk(raw: Obj): boolean {
  if (!inOrder(Object.keys(raw), TOP_KEYS)) return false;
  for (const k of ['manager', 'receptionist'] as const) {
    const o = raw[k];
    if (isObj(o) && (!inOrder(Object.keys(o), HOST_KEYS) || (isObj(o.look) && !inOrder(Object.keys(o.look), LOOK_ORDER)))) return false;
  }
  for (const k of NPC_KEYS) {
    const o = raw[k];
    if (isObj(o) && (!inOrder(Object.keys(o), TEMP_KEYS) || (isObj(o.look) && !inOrder(Object.keys(o.look), LOOK_ORDER)))) return false;
  }
  if (isObj(raw.titles) && !inOrder(Object.keys(raw.titles), TITLE_KEYS)) return false;
  if (isObj(raw.colors) && !inOrder(Object.keys(raw.colors), OFFICE_COLOR_KEYS)) return false;
  if (isObj(raw.lines) && !inOrder(Object.keys(raw.lines), LINE_POOL_KEYS)) return false;
  for (const [k, keys] of [['staff', STAFF_KEYS], ['temps', TEMP_KEYS]] as const) {
    const list = raw[k];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isObj(e)) continue;
      if (!inOrder(Object.keys(e), keys)) return false;
      if (isObj(e.look) && !inOrder(Object.keys(e.look), LOOK_ORDER)) return false;
    }
  }
  return true;
}

/**
 * Readable lines for what saving would lose from the host's current file text (`null` = no file yet, nothing is lost):
 * unknown keys, values `parseTheme` rejects (unless the draft already holds a value there) and the file's own formatting
 * (layout and key order are rewritten in the standard form). `$schema` is kept by the host and never reported. Empty =
 * nothing would be lost. Show it before the first save to an existing file.
 */
export function dropReport(rawHostThemeText: string | null, draft: Draft): string[] {
  if (rawHostThemeText === null) return [];
  const text = rawHostThemeText;
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return ['The file is not valid JSON, so saving replaces it completely.'];
  }
  if (!isObj(raw)) return ['The file is not a JSON object, so saving replaces it completely.'];
  const lines: string[] = [];
  walkUnknown(raw, lines);
  const draftRaw = JSON.parse(JSON.stringify(toTheme(draft))) as unknown;
  for (const err of parseTheme(raw).errors) {
    const m = /^([^:]+): (.*)$/.exec(err);
    // A value the draft now holds is saved, so it is not lost (the draft starts from the parsed theme, so this is for fields fixed since).
    if (m !== null && !/\[\d+\]$/.test(m[1]!) && valueAt(draftRaw, m[1]!) !== undefined && !/unknown colour/.test(m[2]!)) continue;
    lines.push(`Dropped: ${err}`);
  }
  const canonical = JSON.stringify(raw, null, 2) + '\n';
  if (text !== canonical || !keyOrderOk(raw)) lines.push('Formatting: the file will be rewritten with standard indentation and key order.');
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Settings view model

export type SettingControl = 'text' | 'toggle' | 'select';

export interface SettingRow {
  key: FrontDeskSettingKey;
  label: string;
  hint: string;
  control: SettingControl;
  /** Choices of a select. */
  options?: { value: string; label: string }[];
  /** The effective value (what VS Code resolves). For a toggle a boolean, otherwise text. */
  value: FrontDeskSettingValue;
  /** Where the effective value comes from. */
  source: FrontDeskSetting['source'];
  /** Badge text when a workspace setting overrides the user's ("Workspace overrides this"), else undefined. */
  workspaceBadge?: string;
  /** A quiet note when a workspace value exists but the theme's value wins, else undefined. */
  workspaceAlso?: string;
  /** The theme's value for this setting (a name that wins), when the theme sets one. */
  themeValue?: string;
  /** Note text for `themeValue` ("Your theme sets this ..."), else undefined. */
  themeNote?: string;
  /** True when the user has their own value, so "Reset" has something to remove. */
  canReset: boolean;
}

const SETTING_INFO: Record<FrontDeskSettingKey, { label: string; hint: string; options?: { value: string; label: string }[] }> = {
  mode: { label: 'Office mode', hint: 'View mode only shows the agents; the Front desk stays open to you.', options: [{ value: 'manager', label: 'Manager: hand out tasks and use the office tools' }, { value: 'view', label: 'View: just watch' }] },
  companyName: { label: 'Company name', hint: 'Shown on the office sign.' },
  branchName: { label: 'Branch name', hint: 'The second line of the sign. Leave empty for a one-line sign.' },
  managerName: { label: 'Manager name', hint: 'What the manager is called.' },
  speechBubbles: { label: 'Speech bubbles', hint: 'Let people talk in speech bubbles.' },
  bossQuotes: { label: 'Boss quotes', hint: 'Let the manager say motivational things.' },
  scope: { label: 'Sessions shown', hint: 'Which Claude Code sessions appear in the office.', options: [{ value: 'all', label: 'All sessions' }, { value: 'workspace', label: 'This workspace only' }] },
  usageChecks: { label: 'Usage checks', hint: 'Whether the office checks your plan usage now and then.', options: [{ value: 'auto', label: 'Automatic' }, { value: 'off', label: 'Off' }] },
  updateChecks: { label: 'Check for updates', hint: 'Whether the office asks GitHub once a day if a newer version is out.', options: [{ value: 'auto', label: 'Daily' }, { value: 'off', label: 'Off' }] },
};

function controlOf(key: FrontDeskSettingKey): SettingControl {
  if ((FRONT_DESK_TEXT_SETTINGS as readonly string[]).includes(key)) return 'text';
  if ((FRONT_DESK_BOOLEAN_SETTINGS as readonly string[]).includes(key)) return 'toggle';
  return 'select';
}

/** One row per `FRONT_DESK_SETTINGS` key, in that order. */
export function settingsView(state: FrontDeskState): SettingRow[] {
  return FRONT_DESK_SETTINGS.map((key): SettingRow => {
    const s = state.settings[key];
    const info = SETTING_INFO[key];
    const control = controlOf(key);
    const row: SettingRow = {
      key, label: info.label, hint: info.hint, control,
      value: control === 'toggle' ? s.value === true : control === 'text' ? String(s.value) : s.value,
      source: s.source,
      canReset: s.userValue !== undefined,
    };
    if (control === 'select') {
      const allowed = (FRONT_DESK_ENUM_VALUES as Record<string, readonly string[] | undefined>)[key] ?? [];
      row.options = allowed.map((value) => ({ value, label: info.options?.find((o) => o.value === value)?.label ?? value }));
    }
    if (s.themeValue !== undefined) {
      // The theme beats both the user and the workspace value, so it is the only badge that claims the office's value.
      row.themeValue = s.themeValue;
      row.themeNote = `Your theme sets this to “${s.themeValue}”, which wins over this setting.`;
      if (s.workspaceWins) row.workspaceAlso = `The workspace also sets “${String(s.value)}”, but your theme wins.`;
    } else if (s.workspaceWins) {
      row.workspaceBadge = 'Workspace overrides this';
    }
    return row;
  });
}

export type SettingInputResult = { ok: true; value: FrontDeskSettingValue | null } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex
const SETTING_CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/**
 * Checks a raw input the way the host's validator will: text is trimmed (empty is allowed), has no control characters
 * and is at most `LIMITS.settingChars` characters after trimming; toggles take a real boolean; selects take one of their
 * values; `null` means "reset to the default" and is valid for every key. Returns the value to send.
 */
export function validateSettingInput(key: FrontDeskSettingKey, raw: unknown): SettingInputResult {
  if (!(FRONT_DESK_SETTINGS as readonly string[]).includes(key)) return { ok: false, error: 'Unknown setting.' };
  if (raw === null) return { ok: true, value: null };
  const control = controlOf(key);
  if (control === 'text') {
    if (typeof raw !== 'string') return { ok: false, error: 'Enter text.' };
    if (SETTING_CONTROL_RE.test(raw)) return { ok: false, error: 'Remove tabs, line breaks and other control characters.' };
    const t = raw.trim();
    if (t.length > LIMITS.settingChars) return { ok: false, error: `Too long: at most ${LIMITS.settingChars} characters.` };
    return { ok: true, value: t };
  }
  if (control === 'toggle') return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, error: 'Choose on or off.' };
  const allowed = (FRONT_DESK_ENUM_VALUES as Record<string, readonly string[] | undefined>)[key] ?? [];
  return typeof raw === 'string' && allowed.includes(raw) ? { ok: true, value: raw } : { ok: false, error: `Choose one of: ${allowed.join(', ')}.` };
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Contrast check

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of '#rrggbb' (or '#rgb'); NaN for anything else. */
export function relativeLuminance(hex: string): number {
  let h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)?.[1];
  if (h === undefined) return Number.NaN;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio of two colours, 1 (same) to 21 (black on white); NaN when either is not a hex colour. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Below this ratio sign text is called hard to read. The sign is large pixel lettering, so the WCAG "large text" level
 * (3:1) applies rather than the 4.5:1 for body text.
 */
export const SIGN_MIN_CONTRAST = 3;

export interface SignReadability {
  sign: 'ok' | 'low';
  branch: 'ok' | 'low';
  signRatio: number;
  branchRatio: number;
}

type ColorMap = Partial<Record<OfficeColorKey, string>>;

/** Sign text and branch text against the sign plate; keys the theme does not set use `defaults`. A pair with an unusable colour counts as ok. */
export function signReadabilityDetail(colors: ColorMap | undefined, defaults: ColorMap): SignReadability {
  const pick = (k: OfficeColorKey): string => colors?.[k] ?? defaults[k] ?? '';
  const plate = pick('signPlate');
  const signRatio = contrastRatio(pick('signText'), plate);
  const branchRatio = contrastRatio(pick('signBranch'), plate);
  const level = (r: number): 'ok' | 'low' => (Number.isNaN(r) || r >= SIGN_MIN_CONTRAST ? 'ok' : 'low');
  return { sign: level(signRatio), branch: level(branchRatio), signRatio, branchRatio };
}

/** `'low'` when the sign text or the branch text is below `SIGN_MIN_CONTRAST` against the plate, else `'ok'`. */
export function signReadability(colors: ColorMap | undefined, defaults: ColorMap): 'ok' | 'low' {
  const d = signReadabilityDetail(colors, defaults);
  return d.sign === 'low' || d.branch === 'low' ? 'low' : 'ok';
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Draft persistence

/** The saved draft may not exceed this (UTF-8 bytes of the stored text). */
export const DRAFT_MAX_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/**
 * The text to keep in the webview's saved state: the draft with the source it belongs to and the revision it is based on.
 * Null when it would exceed `DRAFT_MAX_BYTES` (the panel then simply does not keep the draft).
 */
export function serializeDraft(draft: Draft, source: string, rev?: string): string | null {
  const text = JSON.stringify({ v: 1, source, rev: rev ?? null, draft });
  return encoder.encode(text).length > DRAFT_MAX_BYTES ? null : text;
}

/**
 * Reads a saved draft back. Null (the draft is dropped) when the text is too big, not ours, or was saved for a different
 * theme source. The draft is run through `parseTheme`, so only valid, well-formed content comes back.
 */
export function restoreDraft(saved: unknown, currentSource: string): { draft: Draft; rev?: string } | null {
  if (typeof saved !== 'string' || encoder.encode(saved).length > DRAFT_MAX_BYTES) return null;
  let o: unknown;
  try {
    o = JSON.parse(saved);
  } catch {
    return null;
  }
  if (!isObj(o) || o.v !== 1 || o.source !== currentSource || !isObj(o.draft)) return null;
  const draft = parseTheme(o.draft).theme;
  return typeof o.rev === 'string' ? { draft, rev: o.rev } : { draft };
}
