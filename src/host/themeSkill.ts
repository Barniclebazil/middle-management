// The "make a theme with Claude" skill: a small Claude Code personal skill (`<claude home>/skills/middle-management-theme`)
// that teaches Claude how to write a theme file. This module installs, refreshes, reports on and removes it. A marker file
// (`.middle-management.json`) records who owns the folder and the hash of every file we wrote, so we can tell our own
// untouched files from ones the user edited, and never touch a folder that is not ours. No `vscode` import and no direct
// fs use: file access is injected like `ThemeWriterDeps`, and the texts to install come from an injected `sources()`.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ThemeSkillStatus } from '../shared/protocol.ts';
import { shortenHome } from './themeSource.ts';
import { writeAtomic } from './themeWriter.ts';
import type { ThemeWriterDeps } from './themeWriter.ts';

/** The skill's folder name inside `<claude home>/skills`. */
export const SKILL_FOLDER_NAME = 'middle-management-theme';
/** The marker file inside the skill folder. */
export const SKILL_MARKER_NAME = '.middle-management.json';
/** Who owns a skill folder: this extension's id (publisher `local`, name `middle-management`). */
export const SKILL_OWNER = 'local.middle-management';

/** The statuses `ThemeSkill.status` can return (`'unknown'` is only a UI placeholder). */
export type SkillStatus = Exclude<ThemeSkillStatus, 'unknown'>;

export type SkillResult = { ok: true } | { ok: false; message: string };

/** Everything the skill's files are built from. */
export interface SkillInputs {
  /** The extension version, written into SKILL.md. */
  version: string;
  /** The folder the user's themes are saved in, written into SKILL.md. */
  themesDir: string;
  /** `media/skill/SKILL.md`, with `{{THEMES_DIR}}` and `{{VERSION}}` placeholders. */
  template: string;
  /** `media/theme.schema.json`. */
  schema: string;
  /** `media/theme-guide.md`. */
  guide: string;
  /** `media/themes/spaceship.theme.json`. */
  example: string;
}

export type SkillSources = { ok: true; inputs: SkillInputs } | { ok: false; message: string };

export interface SkillFile {
  name: string;
  text: string;
}

/** What `ThemeSkill` needs from the outside world. */
export interface ThemeSkillDeps extends ThemeWriterDeps {
  /** The skill folder, `<claudeHome()>/skills/middle-management-theme`. */
  skillDir: string;
  /** The home folder, only used to show paths as `~/...` in messages. */
  homeDir: string;
  /** The current inputs (see `loadSkillSources`). Called on every `status`, `install` and `refreshIfOurs`. */
  sources(): Promise<SkillSources>;
  /** `mkdir -p`. */
  mkdir(path: string): Promise<void>;
  /** Names in a folder. */
  readdir(path: string): Promise<string[]>;
  /** Like `fs.lstat`: it must NOT follow symlinks. */
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<string>;
  /** Remove an EMPTY folder (it fails when the folder has anything in it). */
  rmdir(path: string): Promise<void>;
  log?(line: string): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers

/** The first 16 hex characters of the sha256 of a file's text. */
export function fileHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function replaceAll(text: string, token: string, value: string): string {
  return text.split(token).join(value);
}

/** The example theme without its top-level `$schema` key, re-serialised. Text that is not a JSON object is returned as is. */
function stripSchemaKey(example: string): string {
  try {
    const raw: unknown = JSON.parse(example.charCodeAt(0) === 0xfeff ? example.slice(1) : example);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return example;
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete rest['$schema'];
    return JSON.stringify(rest, null, 2) + '\n';
  } catch {
    return example;
  }
}

/** The files the skill folder holds, in write order (not including the marker). */
export function skillFiles(input: SkillInputs): SkillFile[] {
  const skill = replaceAll(replaceAll(input.template, '{{THEMES_DIR}}', input.themesDir), '{{VERSION}}', input.version);
  return [
    { name: 'SKILL.md', text: skill },
    { name: 'theme.schema.json', text: input.schema },
    { name: 'guide.md', text: input.guide },
    { name: 'example.theme.json', text: stripSchemaKey(input.example) },
  ];
}

export interface SkillMarker {
  owner: string;
  version: string;
  /** File name -> `fileHash` of the text we wrote. */
  files: Record<string, string>;
}

/** The marker for a set of files. */
export function buildMarker(version: string, files: readonly SkillFile[]): SkillMarker {
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f.name] = fileHash(f.text);
  return { owner: SKILL_OWNER, version, files: hashes };
}

/** The marker's file text. */
export function markerText(marker: SkillMarker): string {
  return JSON.stringify(marker, null, 2) + '\n';
}

/** A marker that is ours and well formed, else undefined. */
function parseMarker(text: string): SkillMarker | undefined {
  try {
    const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const m = raw as Record<string, unknown>;
    if (m['owner'] !== SKILL_OWNER) return undefined;
    const files = m['files'];
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
    const hashes: Record<string, string> = {};
    for (const [name, sha] of Object.entries(files)) {
      if (typeof sha !== 'string') return undefined;
      hashes[name] = sha;
    }
    return { owner: SKILL_OWNER, version: typeof m['version'] === 'string' ? m['version'] : '', files: hashes };
  } catch {
    return undefined;
  }
}

/** A plain file name: no separators and no `..`, so it can only name a file directly inside the skill folder. */
function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function errCode(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the source texts

/**
 * Read the skill's source texts from the extension folder: `media/skill/SKILL.md`, `media/theme.schema.json`,
 * `media/theme-guide.md` and the spaceship preset (the example). Never throws: a file that cannot be read, or an example
 * that is not a JSON object, gives `{ ok: false, message }`.
 */
export async function loadSkillSources(
  extensionPath: string,
  readFile: (path: string) => Promise<string>,
  version: string,
  themesDir: string,
): Promise<SkillSources> {
  const read = async (rel: string[]): Promise<string | { error: string }> => {
    const p = join(extensionPath, ...rel);
    try {
      return await readFile(p);
    } catch (e) {
      return { error: `Could not read ${rel.join('/')} from the extension: ${errText(e)}` };
    }
  };
  const template = await read(['media', 'skill', 'SKILL.md']);
  const schema = await read(['media', 'theme.schema.json']);
  const guide = await read(['media', 'theme-guide.md']);
  const example = await read(['media', 'themes', 'spaceship.theme.json']);
  for (const t of [template, schema, guide, example]) if (typeof t !== 'string') return { ok: false, message: t.error };
  if (typeof template !== 'string' || typeof schema !== 'string' || typeof guide !== 'string' || typeof example !== 'string') {
    return { ok: false, message: 'Could not read the skill files from the extension.' };
  }
  try {
    const raw: unknown = JSON.parse(example.charCodeAt(0) === 0xfeff ? example.slice(1) : example);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not a JSON object');
  } catch (e) {
    return { ok: false, message: `The example theme in the extension is not usable: ${errText(e)}` };
  }
  return { ok: true, inputs: { version, themesDir, template, schema, guide, example } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The installer

/** What the folder on disk looks like, before the current inputs are taken into account. */
type Inspection =
  | { state: 'missing' }
  | { state: 'foreign' }
  | { state: 'ours'; marker: SkillMarker; modified: boolean };

export class ThemeSkill {
  private readonly deps: ThemeSkillDeps;

  constructor(deps: ThemeSkillDeps) {
    this.deps = deps;
  }

  /** The folder as the user sees it (`~/.claude/skills/...`). */
  private shownDir(): string {
    return shortenHome(this.deps.skillDir, this.deps.homeDir);
  }

  private log(line: string): void {
    this.deps.log?.(`themeSkill: ${line}`);
  }

  private async inspect(): Promise<Inspection> {
    const { skillDir } = this.deps;
    let st;
    try {
      st = await this.deps.lstat(skillDir);
    } catch (e) {
      if (errCode(e) === 'ENOENT') return { state: 'missing' };
      throw e;
    }
    // A symlinked folder may point anywhere (a user's own skill, a repo): never ours to write into or delete from.
    if (st.isSymbolicLink() || !st.isDirectory()) return { state: 'foreign' };
    const names = await this.deps.readdir(skillDir);
    if (names.length === 0) return { state: 'missing' };
    if (!names.includes(SKILL_MARKER_NAME)) return { state: 'foreign' };
    const markerPath = join(skillDir, SKILL_MARKER_NAME);
    if (!(await this.deps.lstat(markerPath)).isFile()) return { state: 'foreign' };
    const marker = parseMarker(await this.deps.readFile(markerPath));
    if (marker === undefined) return { state: 'foreign' };
    for (const [name, sha] of Object.entries(marker.files)) {
      if (!isPlainName(name)) return { state: 'ours', marker, modified: true };
      const p = join(skillDir, name);
      try {
        if (!(await this.deps.lstat(p)).isFile()) return { state: 'ours', marker, modified: true };
        if (fileHash(await this.deps.readFile(p)) !== sha) return { state: 'ours', marker, modified: true };
      } catch (e) {
        if (errCode(e) === 'ENOENT') return { state: 'ours', marker, modified: true };
        throw e;
      }
    }
    return { state: 'ours', marker, modified: false };
  }

  private async statusOf(inspection: Inspection): Promise<SkillStatus> {
    if (inspection.state === 'missing') return 'missing';
    if (inspection.state === 'foreign') return 'foreign';
    if (inspection.modified) return 'modified';
    // Without the current inputs there is nothing to compare with: leave the install as it is.
    const sources = await this.deps.sources();
    if (!sources.ok) return 'installed';
    const wanted = buildMarker(sources.inputs.version, skillFiles(sources.inputs));
    return sameHashes(inspection.marker.files, wanted.files) ? 'installed' : 'outdated';
  }

  /** Where the skill stands. Never throws: a folder that cannot be inspected counts as `foreign`, so nothing touches it. */
  async status(): Promise<SkillStatus> {
    try {
      return await this.statusOf(await this.inspect());
    } catch (e) {
      this.log(`could not inspect ${this.deps.skillDir}: ${errText(e)}`);
      return 'foreign';
    }
  }

  /** Write the skill. Refuses a `foreign` folder; a `modified` one is overwritten (the UI asks first). The marker goes last. */
  async install(): Promise<SkillResult> {
    try {
      const inspection = await this.inspect();
      if (inspection.state === 'foreign') return { ok: false, message: this.foreignMessage() };
      const sources = await this.deps.sources();
      if (!sources.ok) return { ok: false, message: sources.message };
      const files = skillFiles(sources.inputs);
      const marker = buildMarker(sources.inputs.version, files);
      // With no marker of ours before this attempt, a failure must not leave half a skill (which would read as `foreign`).
      const fresh = inspection.state === 'missing';
      const written: string[] = [];
      const fail = async (message: string): Promise<SkillResult> => {
        if (fresh) await this.discard(written);
        return { ok: false, message };
      };
      try {
        await this.deps.mkdir(this.deps.skillDir);
      } catch (e) {
        return fail(`Could not create ${this.shownDir()}: ${errText(e)}`);
      }
      for (const f of files) {
        const r = await writeAtomic(join(this.deps.skillDir, f.name), f.text, this.deps);
        if (!r.ok) return fail(`Could not install the skill: ${r.message}`);
        written.push(f.name);
      }
      const r = await writeAtomic(join(this.deps.skillDir, SKILL_MARKER_NAME), markerText(marker), this.deps);
      if (!r.ok) return fail(`Could not install the skill: ${r.message}`);
      // Files an older version listed that this one no longer ships.
      if (inspection.state === 'ours') {
        const stale = Object.keys(inspection.marker.files).filter((n) => !(n in marker.files));
        try {
          await this.deleteOwned(stale);
        } catch (e) {
          this.log(`could not delete stale files: ${errText(e)}`);
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: `Could not install the skill in ${this.shownDir()}: ${errText(e)}` };
    }
  }

  /**
   * Take the skill away: only the files the marker lists, then the marker, then the folder if nothing else is in it.
   * Files the user added stay. Refuses a `foreign` folder; a `missing` one is already done.
   */
  async remove(): Promise<SkillResult> {
    try {
      const inspection = await this.inspect();
      if (inspection.state === 'missing') return { ok: true };
      if (inspection.state === 'foreign') return { ok: false, message: this.foreignMessage() };
      const { skillDir } = this.deps;
      await this.deleteOwned(Object.keys(inspection.marker.files));
      await this.deps.unlink(join(skillDir, SKILL_MARKER_NAME));
      if ((await this.deps.readdir(skillDir)).length === 0) await this.deps.rmdir(skillDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: `Could not remove the skill from ${this.shownDir()}: ${errText(e)}` };
    }
  }

  /** On activation: bring an `outdated` install up to date. Never touches `modified` or `foreign`; never throws. */
  async refreshIfOurs(): Promise<void> {
    try {
      if ((await this.status()) !== 'outdated') return;
      const r = await this.install();
      if (!r.ok) this.log(`refresh failed: ${r.message}`);
    } catch (e) {
      this.log(`refresh failed: ${errText(e)}`);
    }
  }

  /** Delete the named files from the skill folder. Anything that is not a plain name for a regular file is left alone. */
  private async deleteOwned(names: readonly string[]): Promise<void> {
    for (const name of names) {
      // A name from a hand-edited marker could point outside the folder.
      if (!isPlainName(name)) continue;
      const p = join(this.deps.skillDir, name);
      try {
        if ((await this.deps.lstat(p)).isFile()) await this.deps.unlink(p);
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
  }

  /** Undo a failed first install: delete the files this attempt wrote, then the folder if that left it empty. */
  private async discard(written: readonly string[]): Promise<void> {
    try {
      await this.deleteOwned(written);
      if ((await this.deps.readdir(this.deps.skillDir)).length === 0) await this.deps.rmdir(this.deps.skillDir);
    } catch (e) {
      this.log(`could not clean up after a failed install: ${errText(e)}`);
    }
  }

  private foreignMessage(): string {
    return `${this.shownDir()} already exists and was not created by Middle Management, so it was left alone. Move or rename it to continue.`;
  }
}
