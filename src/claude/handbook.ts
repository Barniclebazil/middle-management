/**
 * Round B office handbook: the CLAUDE.md chain, the project's memory and the permission rules. Filesystem only, with an
 * injected `ConfigFs`; no vscode import, no logging.
 *
 * Privacy rules this module keeps:
 *  - instruction files are only `stat`ed (their size), never read;
 *  - memory files and MEMORY.md are not read beyond the head that holds the front matter (`FRONTMATTER_HEAD_BYTES`);
 *  - settings files are read with a 1 MB cap, and only `permissions.allow|ask|deny` leaves `parsePermissionRules`
 *    (never `env`, `hooks`, `apiKeyHelper`, `defaultMode`, `additionalDirectories` or any other key);
 *  - an item names a file only by `fileIdFor(absPath)`; `HandbookFile.display` is the contract's home-shortened path.
 */
import * as path from 'node:path';
import { LIMITS, MEMORY_TYPES, RULE_BEHAVIORS } from '../shared/protocol.ts';
import type { CatalogReply, ConfigScope, HandbookFile, MemoryEntry, MemoryType, PermissionRuleItem, RuleBehavior } from '../shared/protocol.ts';
import { readCappedJson } from './claudeConfig.ts';
import { cleanText, collectMarkdown, fmNested, fmString, listNames, readFrontmatter } from './catalog.ts';
import type { ConfigFs, FileIdFor, StatLite } from './catalog.ts';
import { PROJECT_CLAUDE_DIR, isInsideDir, projectDirName } from './paths.ts';

/** Largest settings file we parse. */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/** How deep below a `rules` folder we look for `.md` files. */
const RULES_DEPTH = 3;

/** The folder holding administrator-managed files (`CLAUDE.md`, `managed-settings.json`), per platform, as Claude Code documents it. */
export function managedDirFor(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** Options for the handbook readers. `configDir` is `claudeHome(env, home)`. */
export interface HandbookOptions {
  /** The project folder (the active workspace folder or the root asked for). */
  cwd: string;
  home: string;
  configDir: string;
  fs: ConfigFs;
  fileIdFor: FileIdFor;
  /** Default `process.platform`. Picks the managed folder. */
  platform?: string;
  /** Overrides the managed folder (tests). */
  managedDir?: string;
}

/** What `readHandbook` returns: the `handbook` catalog reply without its `section` tag. */
export type HandbookCatalog = Omit<Extract<CatalogReply, { section: 'handbook' }>, 'section'>;

function managedDir(opts: HandbookOptions): string {
  return opts.managedDir ?? managedDirFor(opts.platform ?? process.platform);
}

/** The path with the home folder shortened to `~` (forward slashes), cut to `LIMITS.pathChars`. For display only. */
export function displayPath(abs: string, home: string): string {
  let out = abs;
  if (home !== '' && abs !== home && isInsideDir(abs, home)) {
    out = '~/' + path.relative(home, abs).split(path.sep).join('/');
  }
  return out.length > LIMITS.pathChars ? out.slice(0, LIMITS.pathChars) : out;
}

function issue(fileIdFor: FileIdFor, file: string): string | undefined {
  try {
    const id = fileIdFor(file);
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

async function tryStat(fs: ConfigFs, p: string): Promise<StatLite | undefined> {
  try {
    return await fs.stat(p);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The CLAUDE.md chain
// ---------------------------------------------------------------------------------------------------------------------

interface Candidate {
  file: string;
  scope: ConfigScope;
  label: string;
}

async function rulesFiles(fs: ConfigFs, dir: string, scope: ConfigScope): Promise<Candidate[]> {
  const found = await collectMarkdown(fs, dir, RULES_DEPTH);
  found.sort((a, b) => (a.segments.join('/') < b.segments.join('/') ? -1 : 1));
  return found.map((f) => ({ file: f.file, scope, label: `rules/${f.segments.join('/')}.md` }));
}

/** Largest `.git` file we read (it holds one `gitdir:` line). */
const GIT_FILE_BYTES = 1024;

/**
 * Folders Claude Code reads project instructions from, outermost first: every ancestor of `cwd` down to `cwd`, NOT stopping
 * at the home folder, and leaving out the filesystem root (as the CLI's loader does, as of 2.1.302). A relative `cwd` gives none.
 */
export function instructionDirs(cwd: string): string[] {
  if (!path.isAbsolute(cwd)) return [];
  const dirs: string[] = [];
  let cur = path.resolve(cwd);
  const root = path.parse(cur).root;
  for (let i = 0; i < 256 && cur !== root; i++) {
    dirs.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/**
 * When `cwd` is inside a git worktree that sits INSIDE its main repository's folder, the two roots. Found by the nearest
 * `.git` entry up from `cwd`: a `.git` FILE reading `gitdir: <main>/.git/worktrees/<name>` (at most `GIT_FILE_BYTES` read,
 * nothing else is opened). Anything else (a plain repo, no repo, a submodule, a worktree outside its main folder) is undefined.
 */
export async function nestedWorktree(fs: ConfigFs, cwd: string): Promise<{ worktreeRoot: string; mainRoot: string } | undefined> {
  const dirs = instructionDirs(cwd).reverse();
  for (const dir of dirs) {
    const gitPath = path.join(dir, '.git');
    const st = await tryStat(fs, gitPath);
    if (st === undefined) continue;
    if (!st.isFile()) return undefined;
    try {
      const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(await fs.readHead(gitPath, GIT_FILE_BYTES));
      const main = m === null ? null : /^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(dir, m[1]!));
      if (main === null) return undefined;
      const mainRoot = main[1]!;
      return dir !== mainRoot && isInsideDir(dir, mainRoot) ? { worktreeRoot: dir, mainRoot } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The instruction files that exist, in the order Claude Code 2.1.302 loads them (later files take precedence over earlier ones):
 *
 *  1. managed policy: `<managed dir>/CLAUDE.md`, then `<managed dir>/.claude/rules/**.md` (Linux `/etc/claude-code`, macOS
 *     `/Library/Application Support/ClaudeCode`, Windows `C:\Program Files\ClaudeCode`). Left out: remote managed memory and
 *     `policySettings.claudeMd` (inline text in managed settings, no file);
 *  2. user: `<config dir>/CLAUDE.md`, then `<config dir>/rules/**.md`;
 *  3. project: for each folder from the OUTERMOST ancestor down to `cwd` (past the home folder, up to but not including the
 *     filesystem root): `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**.md`, then the folder's `CLAUDE.local.md` (scope
 *     `local`). When `cwd` is in a git worktree nested inside its main repository, the main repository's folder (and any
 *     folder between it and the worktree) gives only its `CLAUDE.local.md`.
 *
 * A file reached twice (for example `~/.claude/CLAUDE.md` again as the home folder's `.claude/CLAUDE.md`) is listed once,
 * at its first (user) position. Each item has the file's size from `stat`; the contents are never read. A file with no
 * openable id is left out. At most `LIMITS.handbookFiles` files; `truncated` says more existed. `AGENTS.md` is not listed: the CLI
 * loads it through a builtin plugin whose mode is configurable (default `claude-md-or-agents-md`: a project with no CLAUDE.md of
 * its own gets its AGENTS.md instead), and the exact per-folder rule is not confirmed from the binary.
 */
export async function readInstructionFiles(opts: HandbookOptions): Promise<{ files: HandbookFile[]; truncated: boolean }> {
  const { fs, home, configDir } = opts;
  const cands: Candidate[] = [{ file: path.join(managedDir(opts), 'CLAUDE.md'), scope: 'managed', label: 'CLAUDE.md' }];
  cands.push(...(await rulesFiles(fs, path.join(managedDir(opts), PROJECT_CLAUDE_DIR, 'rules'), 'managed')));
  cands.push({ file: path.join(configDir, 'CLAUDE.md'), scope: 'user', label: 'CLAUDE.md' });
  cands.push(...(await rulesFiles(fs, path.join(configDir, 'rules'), 'user')));
  const wt = await nestedWorktree(fs, opts.cwd);
  for (const dir of instructionDirs(opts.cwd)) {
    if (wt === undefined || !isInsideDir(dir, wt.mainRoot) || isInsideDir(dir, wt.worktreeRoot)) {
      cands.push({ file: path.join(dir, 'CLAUDE.md'), scope: 'project', label: 'CLAUDE.md' });
      cands.push({ file: path.join(dir, PROJECT_CLAUDE_DIR, 'CLAUDE.md'), scope: 'project', label: '.claude/CLAUDE.md' });
      cands.push(...(await rulesFiles(fs, path.join(dir, PROJECT_CLAUDE_DIR, 'rules'), 'project')));
    }
    cands.push({ file: path.join(dir, 'CLAUDE.local.md'), scope: 'local', label: 'CLAUDE.local.md' });
  }
  const files: HandbookFile[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const c of cands) {
    const key = path.resolve(c.file);
    if (seen.has(key)) continue;
    seen.add(key);
    const st = await tryStat(fs, c.file);
    if (!st?.isFile()) continue;
    if (files.length >= LIMITS.handbookFiles) {
      truncated = true;
      break;
    }
    const id = issue(opts.fileIdFor, c.file);
    if (id === undefined) continue;
    files.push({ fileId: id, scope: c.scope, label: cleanText(c.label, LIMITS.nameChars), display: displayPath(c.file, home), bytes: st.size });
  }
  return { files, truncated };
}

// ---------------------------------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------------------------------

function isMemoryType(v: string | undefined): v is MemoryType {
  return v !== undefined && (MEMORY_TYPES as readonly string[]).includes(v);
}

/**
 * The project's memory: `<config dir>/projects/<projectDirName(cwd)>/memory/`. `MEMORY.md` is the index (scope `local`: it is
 * private to this user and project); every other `.md` file there is an entry, sorted by file name, with its title, hook and
 * type from the front matter (`name`, `description`, `metadata.type` or a top-level `type`). Without a `name` the title is
 * the file name. Only the head of each file is read; MEMORY.md itself is not read at all. At most `LIMITS.memoryEntries`.
 */
export async function readMemory(opts: HandbookOptions): Promise<{ index?: HandbookFile; entries: MemoryEntry[]; truncated: boolean }> {
  const { fs, home } = opts;
  const dir = path.join(opts.configDir, 'projects', projectDirName(opts.cwd), 'memory');
  const out: { index?: HandbookFile; entries: MemoryEntry[]; truncated: boolean } = { entries: [], truncated: false };
  const indexFile = path.join(dir, 'MEMORY.md');
  const ist = await tryStat(fs, indexFile);
  if (ist?.isFile()) {
    const id = issue(opts.fileIdFor, indexFile);
    if (id !== undefined) out.index = { fileId: id, scope: 'local', label: 'MEMORY.md', display: displayPath(indexFile, home), bytes: ist.size };
  }
  for (const name of await listNames(fs, dir)) {
    if (!/\.md$/i.test(name) || name.length <= 3 || name.toLowerCase() === 'memory.md') continue;
    const file = path.join(dir, name);
    if (!(await tryStat(fs, file))?.isFile()) continue;
    if (out.entries.length >= LIMITS.memoryEntries) {
      out.truncated = true;
      break;
    }
    const id = issue(opts.fileIdFor, file);
    if (id === undefined) continue;
    const fm = await readFrontmatter(fs, file);
    const entry: MemoryEntry = { fileId: id, file: cleanText(name, LIMITS.nameChars), title: cleanText(fmString(fm, 'name'), LIMITS.nameChars) || cleanText(name.slice(0, -3), LIMITS.nameChars) };
    const hook = cleanText(fmString(fm, 'description'), LIMITS.descriptionChars);
    if (hook !== '') entry.hook = hook;
    const type = fmNested(fm, 'metadata', 'type') ?? fmString(fm, 'type');
    if (isMemoryType(type)) entry.type = type;
    out.entries.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------------------------------------------------

/**
 * From a parsed settings file: ONLY `permissions.allow`, `permissions.ask` and `permissions.deny`, as rule strings (control
 * characters turned into spaces, cut to `LIMITS.ruleChars`, empty and duplicate rules dropped, at most `LIMITS.permissionRules`
 * per list). Every other key, including `env`, `hooks`, `apiKeyHelper`, `defaultMode` and `additionalDirectories`, is ignored.
 * Never throws.
 */
export function parsePermissionRules(raw: unknown): Record<RuleBehavior, string[]> {
  const out: Record<RuleBehavior, string[]> = { allow: [], ask: [], deny: [] };
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    const perms = Object.prototype.hasOwnProperty.call(raw, 'permissions') ? (raw as Record<string, unknown>)['permissions'] : undefined;
    if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return out;
    for (const behavior of RULE_BEHAVIORS) {
      const list = Object.prototype.hasOwnProperty.call(perms, behavior) ? (perms as Record<string, unknown>)[behavior] : undefined;
      if (!Array.isArray(list)) continue;
      const seen = new Set<string>();
      for (const r of list) {
        if (out[behavior].length >= LIMITS.permissionRules) break;
        const rule = cleanText(r, LIMITS.ruleChars);
        if (rule === '' || seen.has(rule)) continue;
        seen.add(rule);
        out[behavior].push(rule);
      }
    }
  } catch {
    /* keep what we have */
  }
  return out;
}

/**
 * The permission rules of the four settings files, in scope order managed, user, project, local: `<managed dir>/managed-settings.json`,
 * `<config dir>/settings.json`, `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` (a path reached twice is
 * read once). Each file is read with a 1 MB cap. The result lists allow, then ask, then deny, each in file order, and each rule
 * carries its file's `fileId`. When more than `LIMITS.permissionRules` exist the budget goes to deny first, then ask, then
 * allow (so a long allow list cannot push a deny rule out of view) and `truncated` is true.
 */
export async function readPermissionRules(opts: HandbookOptions): Promise<{ rules: PermissionRuleItem[]; truncated: boolean }> {
  const files: { file: string; scope: ConfigScope }[] = [
    { file: path.join(managedDir(opts), 'managed-settings.json'), scope: 'managed' },
    { file: path.join(opts.configDir, 'settings.json'), scope: 'user' },
    { file: path.join(opts.cwd, PROJECT_CLAUDE_DIR, 'settings.json'), scope: 'project' },
    { file: path.join(opts.cwd, PROJECT_CLAUDE_DIR, 'settings.local.json'), scope: 'local' },
  ];
  const groups: Record<RuleBehavior, PermissionRuleItem[]> = { allow: [], ask: [], deny: [] };
  const seen = new Set<string>();
  for (const f of files) {
    if (!path.isAbsolute(f.file)) continue;
    const key = path.resolve(f.file);
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = await readCappedJson(f.file, opts.fs, MAX_SETTINGS_BYTES);
    if (!parsed.ok) continue;
    const found = parsePermissionRules(parsed.value);
    if (found.allow.length + found.ask.length + found.deny.length === 0) continue;
    const id = issue(opts.fileIdFor, f.file);
    for (const behavior of RULE_BEHAVIORS) {
      for (const rule of found[behavior]) {
        const item: PermissionRuleItem = { behavior, rule, scope: f.scope };
        if (id !== undefined) item.fileId = id;
        groups[behavior].push(item);
      }
    }
  }
  let budget = LIMITS.permissionRules;
  let truncated = false;
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    if (groups[behavior].length > budget) {
      groups[behavior] = groups[behavior].slice(0, budget);
      truncated = true;
    }
    budget -= groups[behavior].length;
  }
  return { rules: [...groups.allow, ...groups.ask, ...groups.deny], truncated };
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------------------------------------------------

/** The whole `handbook` reply (minus `section`): instruction chain, memory index and entries, permission rules. */
export async function readHandbook(opts: HandbookOptions): Promise<HandbookCatalog> {
  const [instr, memory, rules] = await Promise.all([readInstructionFiles(opts), readMemory(opts), readPermissionRules(opts)]);
  const out: HandbookCatalog = {
    instructions: instr.files,
    memory: memory.entries,
    rules: rules.rules,
    truncated: instr.truncated || memory.truncated || rules.truncated,
  };
  if (memory.index) out.memoryIndex = memory.index;
  return out;
}
