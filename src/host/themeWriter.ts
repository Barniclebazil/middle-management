// Writing the theme file safely: a stable revision, canonical JSON, an atomic write, and the guards that decide whether
// the host may write at all. No `vscode` import and no direct fs use: file access is injected like `ThemeLoaderDeps`.
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { LINE_POOL_KEYS, NPC_KEYS, OFFICE_COLOR_KEYS, TITLE_KEYS, parseTheme, trimTrailingPlaceholders } from '../shared/theme.ts';
import type { LookSpec, OfficeTheme, PersonSpec, StaffSpec } from '../shared/theme.ts';

/** The first 16 hex characters of the sha256 of the raw file text. Identifies the exact bytes a save was based on. */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------------
// Serialising

const LOOK_KEYS: readonly (keyof LookSpec)[] = [
  'head', 'build', 'outfit', 'skin',
  'hair', 'hairHighlight', 'eye', 'shirt', 'outer', 'sleeve', 'tie', 'collar', 'accent', 'accent2', 'pants', 'legs', 'shoes', 'glasses', 'facialHair', 'bow', 'beltColor',
  'skirt', 'shortSleeves', 'belt',
];

function orderedLook(look: LookSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LOOK_KEYS) if (look[k] !== undefined) out[k] = look[k];
  return out;
}

function orderedHost(h: NonNullable<OfficeTheme['manager']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (h.name !== undefined) out.name = h.name;
  if (h.look !== undefined) out.look = orderedLook(h.look);
  if (h.lines !== undefined && h.lines.length > 0) out.lines = [...h.lines];
  return out;
}

function orderedStaff(s: StaffSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.name !== undefined) out.name = s.name;
  if (s.role !== undefined) out.role = s.role;
  if (s.pin !== undefined) {
    const pin: Record<string, unknown> = {};
    if (s.pin.project !== undefined) pin.project = s.pin.project;
    if (s.pin.title !== undefined) pin.title = s.pin.title;
    out.pin = pin;
  }
  if (s.look !== undefined) out.look = orderedLook(s.look);
  if (s.lines !== undefined && s.lines.length > 0) out.lines = [...s.lines];
  return out;
}

/** A temp or a side character: a name and a look. */
function orderedPerson(p: PersonSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.name !== undefined) out.name = p.name;
  if (p.look !== undefined) out.look = orderedLook(p.look);
  return out;
}

export type SerializeResult = { ok: true; text: string; theme: OfficeTheme } | { ok: false; errors: string[] };

/**
 * Canonical text for a theme. The input is untrusted (it may come from the webview): it is run through `parseTheme`
 * first and, if that reports any error, nothing is produced. Only the re-parsed theme is ever written.
 *
 * Output is JSON with 2-space indent and a trailing newline, keys in a fixed order: `$schema` (when `schemaRef` is
 * given), name, description, company, branch, lineMode, titles (in `TITLE_KEYS` order), manager, receptionist, cleaner,
 * vendor, itFixer, itCritic, colors (in `OFFICE_COLOR_KEYS` order), lines (in `LINE_POOL_KEYS` order), smallTalk, staff,
 * temps. A person is name, role, pin, look, lines (a side character or temp: name, look). Every field `parseTheme` knows
 * is written, so a theme made by hand or by Claude survives a save from the Front desk. Trailing `{}` placeholders are
 * trimmed from staff and temps (middle ones are kept, they hold a slot), and empty containers and empty pools are left
 * out, which the app treats the same as absent.
 */
export function serializeTheme(input: unknown, schemaRef?: string): SerializeResult {
  const { theme, errors } = parseTheme(input);
  if (errors.length > 0) return { ok: false, errors };
  const out: Record<string, unknown> = {};
  if (schemaRef !== undefined && schemaRef !== '') out['$schema'] = schemaRef;
  if (theme.name !== undefined) out.name = theme.name;
  if (theme.description !== undefined) out.description = theme.description;
  if (theme.company !== undefined) out.company = theme.company;
  if (theme.branch !== undefined) out.branch = theme.branch;
  if (theme.lineMode !== undefined) out.lineMode = theme.lineMode;
  if (theme.titles !== undefined) {
    const t: Record<string, string> = {};
    for (const k of TITLE_KEYS) {
      const v = theme.titles[k];
      if (v !== undefined) t[k] = v;
    }
    if (Object.keys(t).length > 0) out.titles = t;
  }
  for (const k of ['manager', 'receptionist'] as const) {
    const h = theme[k];
    if (h === undefined) continue;
    const o = orderedHost(h);
    if (Object.keys(o).length > 0) out[k] = o;
  }
  for (const k of NPC_KEYS) {
    const p = theme[k];
    if (p === undefined) continue;
    const o = orderedPerson(p);
    if (Object.keys(o).length > 0) out[k] = o;
  }
  if (theme.colors !== undefined) {
    const c: Record<string, string> = {};
    for (const k of OFFICE_COLOR_KEYS) {
      const v = theme.colors[k];
      if (v !== undefined) c[k] = v;
    }
    if (Object.keys(c).length > 0) out.colors = c;
  }
  if (theme.lines !== undefined) {
    const l: Record<string, unknown> = {};
    for (const k of LINE_POOL_KEYS) {
      const pool = theme.lines[k];
      if (pool === undefined || pool.length === 0) continue;
      l[k] = pool.map((x) => (typeof x === 'string' ? x : [x[0], x[1]]));
    }
    if (Object.keys(l).length > 0) out.lines = l;
  }
  if (theme.smallTalk !== undefined && theme.smallTalk.length > 0) out.smallTalk = theme.smallTalk.map(([a, b]) => [a, b]);
  if (theme.staff !== undefined) {
    const staff = trimTrailingPlaceholders(theme.staff);
    if (staff.length > 0) out.staff = staff.map(orderedStaff);
  }
  if (theme.temps !== undefined) {
    const temps = trimTrailingPlaceholders(theme.temps);
    if (temps.length > 0) out.temps = temps.map(orderedPerson);
  }
  return { ok: true, text: JSON.stringify(out, null, 2) + '\n', theme };
}

/** The `$schema` string of an existing theme file's text (so a save can keep it), or undefined. Never throws. */
export function existingSchemaRef(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const s = (raw as Record<string, unknown>)['$schema'];
      if (typeof s === 'string' && s.trim() !== '') return s;
    }
  } catch {
    // not JSON: no schema to keep
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Atomic write

export interface ThemeWriterDeps {
  realpath(path: string): Promise<string>;
  /** Must fail with `code: 'EEXIST'` when the file already exists (the real thing is `writeFile(p, data, { flag: 'wx' })`). */
  writeFileExclusive(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Random hex for the temp file name. Defaults to 12 hex characters from `crypto.randomBytes`. */
  randomHex?(): string;
}

export type WriteResult = { ok: true; path: string } | { ok: false; message: string };

function errCode(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Replace `path` with `text` without ever leaving a half-written file. The target is `realpath`ed first, so a symlinked
 * theme updates the file it points at and the link stays a link. When the target does not exist the parent folder is
 * `realpath`ed instead. The text goes to a temp file in the same folder (flag `wx`, random suffix) which is then renamed
 * over the target; the temp file is removed on any failure. Never throws.
 */
export async function writeAtomic(path: string, text: string, deps: ThemeWriterDeps): Promise<WriteResult> {
  let target: string;
  try {
    try {
      target = await deps.realpath(path);
    } catch (e) {
      if (errCode(e) !== 'ENOENT' && errCode(e) !== 'ENOTDIR') throw e;
      target = join(await deps.realpath(dirname(path)), basename(path));
    }
  } catch (e) {
    return { ok: false, message: `could not resolve ${path}: ${errText(e)}` };
  }
  const dir = dirname(target);
  const base = basename(target);
  let temp: string | undefined;
  for (let attempt = 0; attempt < 3 && temp === undefined; attempt++) {
    const suffix = deps.randomHex !== undefined ? deps.randomHex() : randomBytes(6).toString('hex');
    const candidate = join(dir, `.${base}.${suffix}.tmp`);
    try {
      await deps.writeFileExclusive(candidate, text);
      temp = candidate;
    } catch (e) {
      // EEXIST means the name was taken by someone else's file: it is not ours to delete, so try another name.
      if (errCode(e) === 'EEXIST' && attempt < 2) continue;
      if (errCode(e) !== 'EEXIST') await deps.unlink(candidate).catch(() => undefined);
      return { ok: false, message: `could not write ${target}: ${errText(e)}` };
    }
  }
  if (temp === undefined) return { ok: false, message: `could not write ${target}: no free temporary name` };
  try {
    await deps.rename(temp, target);
  } catch (e) {
    await deps.unlink(temp).catch(() => undefined);
    return { ok: false, message: `could not replace ${target}: ${errText(e)}` };
  }
  return { ok: true, path: target };
}

// ---------------------------------------------------------------------------------------------------------------------
// Write guards

export type GuardReason = 'notFile' | 'notJson' | 'notObject' | 'workspace' | 'invalid' | 'missing' | 'conflict';

export interface WriteGuardInput {
  /** From `resolveThemeSource`. */
  sourceKind: 'builtin' | 'preset' | 'file';
  /** The resolved file path (display or real; only the extension is looked at). */
  path: string;
  /** The last load produced a JSON object (`ThemeLoadResult.jsonObject`). */
  lastLoadWasObject: boolean;
  /** The `themeFile` value in force comes from workspace settings (a cloned repo could aim a save anywhere). */
  fromWorkspace: boolean;
  /** The theme about to be written (untrusted); it must parse with zero errors. */
  content: unknown;
  /** The revision the editor was based on (`ThemeLoadResult.rev` at load time). */
  rev: string | undefined;
  /** `revisionOf` a fresh read of the file right now, or undefined when the file does not exist (or cannot be read). */
  currentRev: string | undefined;
  /** Save anyway over a changed or missing file. Never overrides any other guard. */
  force?: boolean;
}

export type GuardResult = { ok: true } | { ok: false; reason: GuardReason; message: string };

function refuse(reason: GuardReason, message: string): GuardResult {
  return { ok: false, reason, message };
}

/**
 * Decides whether the host may write the theme file. The host writes only when ALL of these hold, checked in this order:
 * `notFile` the source is a file (not the built-in office or a preset); `notJson` the path ends in `.json`
 * (case-insensitive); `workspace` the setting is not workspace-scoped; `notObject` the last load was a JSON object;
 * `invalid` `parseTheme` reports no errors for the content; then the revision: `rev` must equal `currentRev`, else
 * `conflict`; a file that is gone is `missing`. `force` overrides only `conflict` and `missing`, never the others.
 */
export function checkWriteGuards(input: WriteGuardInput): GuardResult {
  if (input.sourceKind !== 'file') {
    return refuse('notFile', input.sourceKind === 'preset' ? 'The example office is read-only. Make a copy of it to edit.' : 'The built-in office has no file to save to. Create a theme file first.');
  }
  if (!/\.json$/i.test(input.path)) return refuse('notJson', 'Only .json files can be saved to. Choose a theme file that ends in .json.');
  if (input.fromWorkspace) {
    return refuse('workspace', 'The theme file is set by this workspace, so saving to it is blocked. Set the Theme File setting in your user settings to edit it.');
  }
  if (!input.lastLoadWasObject) return refuse('notObject', 'The file is not a JSON object, so it will not be overwritten. Open it and fix it, or choose another file.');
  const { errors } = parseTheme(input.content);
  if (errors.length > 0) return refuse('invalid', `The theme has ${errors.length} problem(s), so it was not saved: ${errors[0]}`);
  if (input.currentRev === undefined) {
    if (input.force === true) return { ok: true };
    return refuse('missing', 'The theme file has been deleted or moved since it was loaded. Save again to create it anew.');
  }
  if (input.force !== true && input.rev !== input.currentRev) {
    return refuse('conflict', 'The theme file changed on disk since it was loaded. Reload it, or save anyway to overwrite it.');
  }
  return { ok: true };
}
