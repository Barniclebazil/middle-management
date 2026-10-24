/**
 * Round B catalog builders for the training library (skills and commands) and the temp agency (subagent types).
 *
 * Two kinds of input, joined here:
 *  - the SDK's `supportedCommands()` and `supportedAgents()` lists, which say WHAT exists but carry no source field and,
 *    for agents, no tools (docs/sdk-spike.md section 15);
 *  - a filesystem scan (user, synced, project and installed-plugin skills, commands and agents), which says WHERE each
 *    item lives and gives its front matter. The scan reads only the head of each file and never passes a body on.
 * Usage counters come from `claudeConfig.parseSkillUsage` (the one place that whitelists `~/.claude.json`).
 *
 * The builders are pure; the scanner takes an injected `ConfigFs`. Items never carry an absolute path: a file is
 * named only by the opaque id `fileIdFor(absPath)` returns (task 5.6 supplies the registry). No vscode import, no logging.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { PROJECT_CLAUDE_DIR, isInsideDir } from './paths.ts';
import { parseSkillUsage, readCappedJson } from './claudeConfig.ts';
import type { SkillUsageEntry } from './claudeConfig.ts';
import { LIMITS } from '../shared/protocol.ts';
import type { AgentTypeItem, CommandItem, SkillItem } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------------------------------------------------

/** The part of `fs.Stats` we use. `stat` follows symlinks. */
export interface StatLite {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** Injected filesystem for the catalog and handbook readers. Every method may reject; callers treat that as "absent". */
export interface ConfigFs {
  stat(path: string): Promise<StatLite>;
  /** Entry names only (no types: callers `stat`, which follows symlinks). */
  readdir(path: string): Promise<string[]>;
  /** At most `maxBytes` bytes from the start of the file, decoded as UTF-8. Must not read the rest of the file. */
  readHead(path: string, maxBytes: number): Promise<string>;
  /** The whole file. Only ever called after a size check (see `readCappedJson`). */
  readFile(path: string): Promise<string>;
}

/** The real filesystem. */
export const nodeConfigFs: ConfigFs = {
  stat: (p) => fsp.stat(p),
  readdir: (p) => fsp.readdir(p),
  readHead: async (p, maxBytes) => {
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  },
  readFile: (p) => fsp.readFile(p, 'utf8'),
};

/** Bytes read from the head of a skill, command, agent or memory file. Front matter past this is "huge" and ignored. */
export const FRONTMATTER_HEAD_BYTES = 16 * 1024;

/** Largest plugin manifest or install list we parse. */
const MAX_SMALL_JSON_BYTES = 1024 * 1024;

const MAX_DIR_NAMES = 1000;
const MAX_FILES_PER_ROOT = 500;
const MAX_PLUGINS = 200;
const MAX_WALK_DEPTH = 64;

async function tryStat(fs: ConfigFs, p: string): Promise<StatLite | undefined> {
  try {
    return await fs.stat(p);
  } catch {
    return undefined;
  }
}

/** Sorted entry names of a folder, without dot-files; an unreadable or missing folder is empty. */
export async function listNames(fs: ConfigFs, dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => typeof n === 'string' && n !== '' && !n.startsWith('.'))
      .sort()
      .slice(0, MAX_DIR_NAMES);
  } catch {
    return [];
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Control characters become spaces, runs of white space collapse, then cut to `max` UTF-16 units (with an ellipsis). */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
}

function nonEmpty(s: string): string | undefined {
  return s === '' ? undefined : s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Front matter: a small, safe reader for the YAML subset skills, commands, agents and memory files use
// ---------------------------------------------------------------------------------------------------------------------

/** A parsed value: a string, a list of strings, or one level of `key: value` pairs (for example `metadata`). */
export type FrontmatterValue = string | string[] | Record<string, string>;

/** Top-level keys to values. Empty when the file has no front matter, or it is malformed or not closed within the head. */
export type Frontmatter = Map<string, FrontmatterValue>;

const FM_MAX_VALUE = 2000;
const FM_MAX_LIST = 100;
const FM_MAX_MAP = 20;
const FM_MAX_KEYS = 60;
const FM_MAX_LINES = 400;
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/;

function fmClean(s: string): string {
  return cleanText(s, FM_MAX_VALUE);
}

/** A scalar: a double or single quoted string (with its escapes) or a plain one without a trailing ` # comment`. */
function scalar(raw: string): string {
  const s = raw.trim();
  const q = s.charAt(0);
  if (q === '"') {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length) {
        const n = s.charAt(++i);
        out += n === 'n' || n === 't' ? ' ' : n;
      } else if (c === '"') return out;
      else out += c;
    }
    return out;
  }
  if (q === "'") {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === "'") {
        if (s.charAt(i + 1) === "'") {
          out += "'";
          i++;
        } else return out;
      } else out += c;
    }
    return out;
  }
  const h = s.search(/[ \t]#/);
  return (h >= 0 ? s.slice(0, h) : s).trim();
}

/** Splits on commas that are not inside quotes, brackets or parentheses (`Bash(git add:*, git commit:*), Read`). */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const c of s) {
    if (quote !== '') {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function newRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function pairsToRecord(items: string[]): Record<string, string> {
  const rec = newRecord();
  let n = 0;
  for (const item of items) {
    if (n >= FM_MAX_MAP) break;
    const m = KEY_RE.exec(item.trim());
    if (!m || m[1] === '__proto__') continue;
    rec[m[1]!] = fmClean(scalar(m[2] ?? ''));
    n++;
  }
  return rec;
}

function dedent(lines: string[]): string[] {
  const body = lines.filter((l) => l.trim() !== '');
  const indent = body.reduce((min, l) => Math.min(min, /^[ \t]*/.exec(l)![0].length), Infinity);
  return lines.map((l) => (Number.isFinite(indent) ? l.slice(Math.min(indent, l.length)) : l).trimEnd());
}

function fmValue(rest: string, child: string[]): FrontmatterValue {
  const content = child.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (/^[>|][+-]?\d*[ \t]*(#.*)?$/.test(rest)) {
    const lines = dedent(child);
    return fmClean(rest.startsWith('>') ? lines.filter((l) => l !== '').join(' ') : lines.join(' '));
  }
  if (rest === '') {
    if (content.length === 0) return '';
    const first = content[0]!.trim();
    if (/^-(\s|$)/.test(first)) {
      const items: string[] = [];
      for (const l of content) {
        const t = l.trim();
        if (!/^-(\s|$)/.test(t)) continue;
        const v = fmClean(scalar(t.slice(1)));
        if (v !== '') items.push(v);
        if (items.length >= FM_MAX_LIST) break;
      }
      return items;
    }
    const indent = /^[ \t]*/.exec(content[0]!)![0].length;
    return pairsToRecord(content.filter((l) => /^[ \t]*/.exec(l)![0].length === indent));
  }
  if (rest.startsWith('[')) {
    const close = rest.lastIndexOf(']');
    if (close > 0) return splitTopLevel(rest.slice(1, close)).slice(0, FM_MAX_LIST).map((x) => fmClean(scalar(x))).filter((x) => x !== '');
    return ''; // an unclosed list is malformed: no value, rather than a name that starts with `[`
  }
  if (rest.startsWith('{')) {
    const close = rest.lastIndexOf('}');
    if (close > 0) return pairsToRecord(splitTopLevel(rest.slice(1, close)).map((x) => x.replace(/^([^:]+):[ \t]*/, '$1: ')));
    return '';
  }
  const text = [rest, ...content.map((l) => l.trim())].join(' ');
  return fmClean(scalar(text));
}

/**
 * Parses the front matter of `head` (the first bytes of a file). The block must open with `---` on the first line and be
 * closed by `---` or `...` within `head`; otherwise (missing, malformed, or longer than the head) the result is empty.
 * Handles CRLF, a BOM, quoted and plain scalars, block scalars (`>-`, `|`), inline and block lists, and one level of nested
 * pairs. Returns only the front matter's own keys: the text after the closing marker is never looked at, so a body cannot
 * leak. Values are cleaned of control characters and cut to 2000 units. Never throws.
 */
export function parseFrontmatter(head: string): Frontmatter {
  const out: Frontmatter = new Map();
  try {
    const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
    const lines = text.split(/\r\n|\n|\r/, FM_MAX_LINES);
    if (lines.length < 2 || lines[0]!.trimEnd() !== '---') return out;
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i]!.trimEnd();
      if (t === '---' || t === '...') {
        end = i;
        break;
      }
    }
    if (end < 0) return out;
    const block = lines.slice(1, end);
    let i = 0;
    while (i < block.length && out.size < FM_MAX_KEYS) {
      const m = KEY_RE.exec(block[i++]!);
      if (!m) continue;
      const key = m[1]!;
      const rest = (m[2] ?? '').trim();
      const child: string[] = [];
      while (i < block.length) {
        const l = block[i]!;
        if (l.trim() === '' || /^[ \t]/.test(l) || (rest === '' && /^-(\s|$)/.test(l))) {
          child.push(l);
          i++;
        } else break;
      }
      if (key === '__proto__' || out.has(key)) continue;
      out.set(key, fmValue(rest, child));
    }
  } catch {
    /* an odd file gives whatever was parsed so far */
  }
  return out;
}

/** The front matter of a file, reading only its first `FRONTMATTER_HEAD_BYTES` bytes. Unreadable gives an empty map. */
export async function readFrontmatter(fs: ConfigFs, file: string): Promise<Frontmatter> {
  try {
    return parseFrontmatter(await fs.readHead(file, FRONTMATTER_HEAD_BYTES));
  } catch {
    return new Map();
  }
}

/** A key's value when it is a non-empty string. */
export function fmString(fm: Frontmatter, key: string): string | undefined {
  const v = fm.get(key);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** A key of a nested pair set, for example `metadata.type`. */
export function fmNested(fm: Frontmatter, key: string, sub: string): string | undefined {
  const v = fm.get(key);
  if (v === undefined || typeof v === 'string' || Array.isArray(v)) return undefined;
  const s = Object.prototype.hasOwnProperty.call(v, sub) ? v[sub] : undefined;
  return typeof s === 'string' && s !== '' ? s : undefined;
}

/** A key's value as a list: a real list, or a string split at top-level commas. */
export function fmList(fm: Frontmatter, key: string): string[] | undefined {
  const v = fm.get(key);
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return splitTopLevel(v).map((x) => scalar(x)).filter((x) => x !== '');
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Where project config lives
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Folders Claude Code looks in for project config, nearest first: `cwd`, then each parent, stopping after `home` when
 * `cwd` is inside it, or at the filesystem root otherwise. A relative `cwd` gives an empty list.
 */
export function ancestorDirs(cwd: string, home: string): string[] {
  if (!path.isAbsolute(cwd)) return [];
  const stopAtHome = home !== '' && path.isAbsolute(home) && isInsideDir(cwd, home);
  const dirs: string[] = [];
  let cur = path.resolve(cwd);
  const homeResolved = stopAtHome ? path.resolve(home) : '';
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    dirs.push(cur);
    if (stopAtHome && cur === homeResolved) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/**
 * The `.claude` folders of the project dirs, nearest first. A folder equal to the user's config dir is user scope, not
 * project scope (cwd at or above the home dir would otherwise list `~/.claude` twice), so it is left out.
 */
export function projectClaudeDirs(cwd: string, home: string, configDir: string): string[] {
  const user = path.resolve(configDir);
  return ancestorDirs(cwd, home)
    .map((d) => path.join(d, PROJECT_CLAUDE_DIR))
    .filter((d) => path.resolve(d) !== user);
}

// ---------------------------------------------------------------------------------------------------------------------
// Installed plugins (layout from memory of Claude Code, unverified on this machine: be defensive)
// ---------------------------------------------------------------------------------------------------------------------

/** An installed plugin: the name its items are prefixed with, and its folder. */
export interface PluginRoot {
  name: string;
  root: string;
}

const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function pluginName(fs: ConfigFs, root: string, fallback: string): Promise<string | undefined> {
  const manifest = await readCappedJson(path.join(root, '.claude-plugin', 'plugin.json'), fs, MAX_SMALL_JSON_BYTES);
  if (manifest.ok && isObj(manifest.value)) {
    const n = own(manifest.value, 'name');
    if (typeof n === 'string' && PLUGIN_NAME_RE.test(n)) return n;
  }
  return PLUGIN_NAME_RE.test(fallback) ? fallback : undefined;
}

/**
 * Installed plugins from `<configDir>/plugins/installed_plugins.json` (`{ plugins: { "<plugin>@<marketplace>": [{ installPath }] } }`,
 * or the older flat form), falling back to `<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/` (newest version by
 * name) when that file gives nothing. The plugin's name is its manifest's `name`, else the key's part before `@`.
 * Marketplace catalogue copies (`plugins/marketplaces/`) are not installs and are never scanned.
 */
export async function findInstalledPlugins(fs: ConfigFs, configDir: string): Promise<PluginRoot[]> {
  const pluginsDir = path.join(configDir, 'plugins');
  const candidates: { key: string; root: string }[] = [];
  const installed = await readCappedJson(path.join(pluginsDir, 'installed_plugins.json'), fs, MAX_SMALL_JSON_BYTES);
  if (installed.ok && isObj(installed.value)) {
    const inner = own(installed.value, 'plugins');
    const map = isObj(inner) ? inner : installed.value;
    for (const key of Object.keys(map).slice(0, MAX_PLUGINS)) {
      const v = map[key];
      for (const e of Array.isArray(v) ? v.slice(0, 20) : [v]) {
        if (!isObj(e)) continue;
        const p = own(e, 'installPath');
        if (typeof p === 'string' && p !== '') candidates.push({ key, root: path.resolve(pluginsDir, p) });
      }
    }
  }
  if (candidates.length === 0) {
    const cache = path.join(pluginsDir, 'cache');
    for (const mkt of await listNames(fs, cache)) {
      for (const plugin of await listNames(fs, path.join(cache, mkt))) {
        const versions = await listNames(fs, path.join(cache, mkt, plugin));
        const newest = versions[versions.length - 1];
        if (newest !== undefined) candidates.push({ key: plugin, root: path.join(cache, mkt, plugin, newest) });
        if (candidates.length >= MAX_PLUGINS) break;
      }
    }
  }
  const out: PluginRoot[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (out.length >= MAX_PLUGINS) break;
    if (seen.has(c.root)) continue;
    seen.add(c.root);
    if (!(await tryStat(fs, c.root))?.isDirectory()) continue;
    const name = await pluginName(fs, c.root, c.key.split('@')[0] ?? '');
    if (name !== undefined) out.push({ name, root: c.root });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------------------------------------------------

/** Options shared by the scanners and readers. `configDir` is `claudeHome(env, home)`. */
export interface ScanOptions {
  cwd: string;
  home: string;
  configDir: string;
  fs: ConfigFs;
}

/** Where a scanned skill or command lives. */
export type ScannedSource = 'user' | 'synced' | 'project' | 'plugin';

/** One skill or command found on disk. `file` is absolute and never leaves this module's callers (it only feeds `fileIdFor`). */
export interface ScannedItem {
  kind: 'skill' | 'command';
  source: ScannedSource;
  plugin?: string;
  /** The name without a plugin prefix. */
  name: string;
  /** Every name the SDK could list it under: `plugin:name` for a plugin item, else the name (and a folder name that differs). */
  keys: string[];
  file: string;
  description?: string;
  argumentHint?: string;
}

/** Result of `scanSkillsAndCommands`. */
export interface CatalogScan {
  items: ScannedItem[];
}

export interface MdFile {
  segments: string[];
  file: string;
}

/** `.md` files below `dir` (a folder's own files first, then sub-folders), with their path segments. Bounded in depth and count. */
export async function collectMarkdown(fs: ConfigFs, dir: string, maxDepth: number, segments: string[] = [], out: MdFile[] = []): Promise<MdFile[]> {
  for (const name of await listNames(fs, dir)) {
    if (out.length >= MAX_FILES_PER_ROOT) return out;
    const p = path.join(dir, name);
    const st = await tryStat(fs, p);
    if (!st) continue;
    if (st.isFile() && /\.md$/i.test(name) && name.length > 3) out.push({ segments: [...segments, name.slice(0, -3)], file: p });
  }
  if (segments.length < maxDepth) {
    for (const name of await listNames(fs, dir)) {
      if (out.length >= MAX_FILES_PER_ROOT) return out;
      const p = path.join(dir, name);
      if ((await tryStat(fs, p))?.isDirectory()) await collectMarkdown(fs, p, maxDepth, [...segments, name], out);
    }
  }
  return out;
}

function itemName(raw: string | undefined, fallback: string): string {
  return nonEmpty(cleanText(raw, LIMITS.nameChars)) ?? cleanText(fallback, LIMITS.nameChars);
}

async function scanSkillFolders(fs: ConfigFs, dir: string, source: ScannedSource, plugin: string | undefined, out: ScannedItem[], skip?: string): Promise<void> {
  for (const folder of await listNames(fs, dir)) {
    if (folder === skip) continue;
    const file = path.join(dir, folder, 'SKILL.md');
    if (!(await tryStat(fs, file))?.isFile()) continue;
    const fm = await readFrontmatter(fs, file);
    const name = itemName(fmString(fm, 'name'), folder);
    const names = name === folder ? [name] : [name, folder];
    const item: ScannedItem = { kind: 'skill', source, name, keys: names.map((n) => (plugin ? `${plugin}:${n}` : n)), file };
    if (plugin) item.plugin = plugin;
    const desc = fmString(fm, 'description');
    if (desc) item.description = cleanText(desc, LIMITS.descriptionChars);
    const hint = fmString(fm, 'argument-hint');
    if (hint) item.argumentHint = cleanText(hint, LIMITS.nameChars);
    out.push(item);
  }
}

async function scanCommandFiles(fs: ConfigFs, dir: string, source: ScannedSource, plugin: string | undefined, out: ScannedItem[]): Promise<void> {
  for (const f of await collectMarkdown(fs, dir, 2)) {
    const fm = await readFrontmatter(fs, f.file);
    const name = cleanText(f.segments.join(':'), LIMITS.nameChars);
    if (name === '') continue;
    const item: ScannedItem = { kind: 'command', source, name, keys: [plugin ? `${plugin}:${name}` : name], file: f.file };
    if (plugin) item.plugin = plugin;
    const desc = fmString(fm, 'description');
    if (desc) item.description = cleanText(desc, LIMITS.descriptionChars);
    const hint = fmString(fm, 'argument-hint');
    if (hint) item.argumentHint = cleanText(hint, LIMITS.nameChars);
    out.push(item);
  }
}

/**
 * Scans, in this order: user skills (`<config>/skills/*`), synced skills (`<config>/skills/synced/<bucket>/*`), user commands
 * (`<config>/commands`), then each project dir from `cwd` up to home (`.claude/skills`, `.claude/commands`), then installed
 * plugins (`skills/`, `commands/`). Reads only each file's head. Missing folders are empty.
 */
export async function scanSkillsAndCommands(opts: ScanOptions): Promise<CatalogScan> {
  const { fs, configDir } = opts;
  const items: ScannedItem[] = [];
  const skills = path.join(configDir, 'skills');
  await scanSkillFolders(fs, skills, 'user', undefined, items, 'synced');
  for (const bucket of await listNames(fs, path.join(skills, 'synced'))) {
    await scanSkillFolders(fs, path.join(skills, 'synced', bucket), 'synced', undefined, items);
  }
  await scanCommandFiles(fs, path.join(configDir, 'commands'), 'user', undefined, items);
  for (const dir of projectClaudeDirs(opts.cwd, opts.home, configDir)) {
    await scanSkillFolders(fs, path.join(dir, 'skills'), 'project', undefined, items);
    await scanCommandFiles(fs, path.join(dir, 'commands'), 'project', undefined, items);
  }
  for (const p of await findInstalledPlugins(fs, configDir)) {
    await scanSkillFolders(fs, path.join(p.root, 'skills'), 'plugin', p.name, items);
    await scanCommandFiles(fs, path.join(p.root, 'commands'), 'plugin', p.name, items);
  }
  return { items };
}

/** One subagent type found on disk. */
export interface ScannedAgent {
  source: 'user' | 'project' | 'plugin';
  plugin?: string;
  /** The `subagent_type`: front matter `name`, else the file name; `plugin:name` for a plugin's. */
  name: string;
  file: string;
  description?: string;
  model?: string;
  /** Absent when the front matter has no `tools` (or says `*`): all tools. */
  tools?: string[];
}

/** Result of `scanAgents`. */
export interface AgentScan {
  agents: ScannedAgent[];
}

async function scanAgentFiles(fs: ConfigFs, dir: string, source: ScannedAgent['source'], plugin: string | undefined, out: ScannedAgent[]): Promise<void> {
  for (const f of await collectMarkdown(fs, dir, 2)) {
    const fm = await readFrontmatter(fs, f.file);
    const stem = f.segments[f.segments.length - 1] ?? '';
    const bare = itemName(fmString(fm, 'name'), stem);
    if (bare === '') continue;
    const agent: ScannedAgent = { source, name: plugin ? `${plugin}:${bare}` : bare, file: f.file };
    if (plugin) agent.plugin = plugin;
    const desc = fmString(fm, 'description');
    if (desc) agent.description = cleanText(desc, LIMITS.descriptionChars);
    const model = fmString(fm, 'model');
    if (model) agent.model = cleanText(model, LIMITS.nameChars);
    const tools = toolList(fmList(fm, 'tools'));
    if (tools) agent.tools = tools;
    out.push(agent);
  }
}

/** Cleans a tool list: dedupes, cuts names and count. `undefined` (or a `*`, or nothing left) means all tools. */
function toolList(raw: string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out: string[] = [];
  for (const t of raw) {
    const name = cleanText(t, LIMITS.toolNameChars);
    if (name === '') continue;
    if (name === '*') return undefined;
    if (!out.includes(name)) out.push(name);
    if (out.length >= LIMITS.toolsPerAgent) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Scans user (`<config>/agents`), project (`<dir>/.claude/agents` up to home) and installed-plugin (`agents/`) agent files. */
export async function scanAgents(opts: ScanOptions): Promise<AgentScan> {
  const { fs, configDir } = opts;
  const agents: ScannedAgent[] = [];
  await scanAgentFiles(fs, path.join(configDir, 'agents'), 'user', undefined, agents);
  for (const dir of projectClaudeDirs(opts.cwd, opts.home, configDir)) await scanAgentFiles(fs, path.join(dir, 'agents'), 'project', undefined, agents);
  for (const p of await findInstalledPlugins(fs, configDir)) await scanAgentFiles(fs, path.join(p.root, 'agents'), 'plugin', p.name, agents);
  return { agents };
}

// ---------------------------------------------------------------------------------------------------------------------
// Builders (pure)
// ---------------------------------------------------------------------------------------------------------------------

/** Supplies the opaque id for a config file (task 5.6's registry). May throw or return '' to say "cannot be opened". */
export type FileIdFor = (absPath: string) => string;

function fileId(fileIdFor: FileIdFor, file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try {
    const id = fileIdFor(file);
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

function byName<T extends { name: string }>(a: T, b: T): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

interface SdkRow {
  name: string;
  description: string;
  argumentHint?: string;
  builtin: boolean;
  aliases: string[];
  model?: string;
}

/** Reads SDK rows defensively: drops non-objects, nameless rows, `__internal` names and duplicates (a `builtin` row wins). */
function sdkRows(raw: unknown): SdkRow[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const rows = new Map<string, SdkRow>();
  for (const r of raw) {
    if (!isObj(r)) continue;
    const name = cleanText(typeof r['name'] === 'string' ? r['name'].replace(/^\//, '') : '', LIMITS.nameChars);
    if (name === '' || name.startsWith('__')) continue;
    const row: SdkRow = { name, description: cleanText(r['description'], LIMITS.descriptionChars), builtin: r['builtin'] === true, aliases: [] };
    const hint = nonEmpty(cleanText(r['argumentHint'], LIMITS.nameChars));
    if (hint) row.argumentHint = hint;
    const model = nonEmpty(cleanText(r['model'], LIMITS.nameChars));
    if (model) row.model = model;
    if (Array.isArray(r['aliases'])) {
      for (const a of r['aliases'].slice(0, 10)) {
        const alias = cleanText(a, LIMITS.nameChars);
        if (alias !== '') row.aliases.push(alias);
      }
    }
    const prev = rows.get(name);
    if (prev === undefined || (row.builtin && !prev.builtin)) rows.set(name, row);
  }
  return [...rows.values()];
}

const SOURCE_PRIORITY: Record<ScannedSource, number> = { user: 0, project: 1, synced: 2, plugin: 3 };

/** Input of `buildSkillsCatalog`. */
export interface SkillsCatalogInput {
  /** The SDK's `supportedCommands()`, or `undefined` (or empty) when it is not available: the scan alone is then used. */
  sdkCommands?: unknown;
  scan: CatalogScan;
  /** From `parseSkillUsage`. */
  usage: ReadonlyMap<string, SkillUsageEntry>;
  fileIdFor: FileIdFor;
  /** False when the SDK probe ran without project settings (untrusted folder): scanned project items are then merged in. Default true. */
  projectLoaded?: boolean;
}

/** Output of `buildSkillsCatalog`: sorted by name, cut at `LIMITS.catalogSkills` and `LIMITS.catalogCommands`. */
export interface SkillsCatalog {
  skills: SkillItem[];
  commands: CommandItem[];
  /** True when either list was cut. */
  truncated: boolean;
}

interface Draft {
  kind: 'skill' | 'command';
  source: ScannedSource | 'builtin';
  plugin?: string;
  name: string;
  invoke: string;
  description: string;
  argumentHint?: string;
  file?: string;
  usageKeys: string[];
}

function bareOf(name: string): string {
  const i = name.lastIndexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

function findScanned(index: Map<string, ScannedItem[]>, row: SdkRow): ScannedItem | undefined {
  const names = [row.name, ...row.aliases];
  const best = (list: ScannedItem[] | undefined): ScannedItem | undefined =>
    list?.slice().sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1))[0];
  for (const n of names) {
    const hit = best(index.get(n));
    if (hit) return hit;
  }
  // A synced claude.ai skill can carry a `bundle:name` form in its name or alias while living in a folder named `name`.
  for (const n of names) {
    if (!n.includes(':')) continue;
    const hit = best(index.get(bareOf(n))?.filter((i) => i.source === 'synced'));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Joins the SDK list, the filesystem scan and the usage counters into the library's two lists.
 *
 * - With an SDK list, it decides the SET (it is what the user can type, cwd-aware); the scan only classifies. A `builtin`
 *   row is a built-in command; every other row is matched to a scanned item by its name, then its aliases, to get its source,
 *   kind (skill or command), plugin, front-matter description and `fileId`. An unmatched `x:y` row is a plugin skill of
 *   plugin `x`; any other unmatched row is a user skill with no file (nothing on disk explains it).
 * - Without one (missing or empty), the scan alone is the set.
 * - Built-in rows go to `commands` with source `builtin` even when they are bundled skills (`dataviz`, `claude-api`):
 *   the SDK does not tell the two apart, and `SkillSource` has no `builtin` value. Their `skillUsage` rows are therefore not shown.
 * - Usage joins on the bare name (also the full `plugin:name` and aliases) and only for skills; a skill with no row has no
 *   `uses`, and rows for names that are not listed are ignored.
 */
export function buildSkillsCatalog(input: SkillsCatalogInput): SkillsCatalog {
  const drafts: Draft[] = [];
  const rows = sdkRows(input.sdkCommands);
  if (rows) {
    const index = new Map<string, ScannedItem[]>();
    for (const item of input.scan.items) {
      for (const k of item.keys) index.set(k, [...(index.get(k) ?? []), item]);
    }
    for (const row of rows) {
      if (row.builtin) {
        drafts.push({ kind: 'command', source: 'builtin', name: row.name, invoke: row.name, description: row.description, ...(row.argumentHint ? { argumentHint: row.argumentHint } : {}), usageKeys: [] });
        continue;
      }
      const hit = findScanned(index, row);
      const colon = row.name.indexOf(':');
      const source: ScannedSource = hit ? hit.source : colon > 0 ? 'plugin' : 'user';
      const plugin = hit?.plugin ?? (source === 'plugin' && colon > 0 ? row.name.slice(0, colon) : undefined);
      const hint = row.argumentHint ?? hit?.argumentHint;
      const d: Draft = {
        kind: hit ? hit.kind : 'skill',
        source,
        name: source === 'plugin' && plugin && row.name.startsWith(plugin + ':') ? row.name.slice(plugin.length + 1) : row.name,
        invoke: row.name,
        description: row.description !== '' ? row.description : (hit?.description ?? ''),
        usageKeys: [row.name, bareOf(row.name), ...row.aliases, ...row.aliases.map(bareOf)],
      };
      if (plugin) d.plugin = plugin;
      if (hint) d.argumentHint = hint;
      if (hit) d.file = hit.file;
      drafts.push(d);
    }
    if (input.projectLoaded === false) {
      // The probe could not see the project's own items; listing them from the scan is read-only. An SDK row wins any name clash.
      const listed = new Set(rows.flatMap((r) => [r.name, ...r.aliases]));
      for (const item of input.scan.items) {
        if (item.source !== 'project' || item.keys.some((k) => listed.has(k))) continue;
        const invoke = item.keys[0] ?? item.name;
        const d: Draft = { kind: item.kind, source: 'project', name: item.name, invoke, description: item.description ?? '', file: item.file, usageKeys: [invoke, item.name] };
        if (item.argumentHint) d.argumentHint = item.argumentHint;
        drafts.push(d);
      }
    }
  } else {
    for (const item of input.scan.items) {
      const invoke = item.keys[0] ?? item.name;
      const d: Draft = { kind: item.kind, source: item.source, name: item.name, invoke, description: item.description ?? '', file: item.file, usageKeys: [invoke, item.name] };
      if (item.plugin) d.plugin = item.plugin;
      if (item.argumentHint) d.argumentHint = item.argumentHint;
      drafts.push(d);
    }
  }

  const seen = new Set<string>();
  const skillDrafts: Draft[] = [];
  const commandDrafts: Draft[] = [];
  for (const d of drafts) {
    const key = `${d.kind}:${d.invoke}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (d.kind === 'skill' ? skillDrafts : commandDrafts).push(d);
  }
  skillDrafts.sort(byName);
  commandDrafts.sort(byName);
  const truncated = skillDrafts.length > LIMITS.catalogSkills || commandDrafts.length > LIMITS.catalogCommands;

  const skills: SkillItem[] = skillDrafts.slice(0, LIMITS.catalogSkills).map((d) => {
    const item: SkillItem = { name: d.name, invoke: d.invoke, description: d.description, source: d.source as SkillItem['source'] };
    if (d.plugin) item.plugin = d.plugin;
    const id = fileId(input.fileIdFor, d.file);
    if (id) item.fileId = id;
    for (const k of d.usageKeys) {
      const u = input.usage.get(k);
      if (u) {
        item.uses = u.uses;
        if (u.lastUsedAt !== undefined) item.lastUsedAt = u.lastUsedAt;
        break;
      }
    }
    return item;
  });
  const commands: CommandItem[] = commandDrafts.slice(0, LIMITS.catalogCommands).map((d) => {
    const item: CommandItem = { name: d.name, invoke: d.invoke, description: d.description, source: d.source as CommandItem['source'] };
    if (d.plugin) item.plugin = d.plugin;
    if (d.argumentHint) item.argumentHint = d.argumentHint;
    const id = fileId(input.fileIdFor, d.file);
    if (id) item.fileId = id;
    return item;
  });
  return { skills, commands, truncated };
}

/** Input of `buildAgentsCatalog`. */
export interface AgentsCatalogInput {
  /** The SDK's `supportedAgents()`, or `undefined` (or empty) when it is not available: the scan alone is then used. */
  sdkAgents?: unknown;
  scan: AgentScan;
  fileIdFor: FileIdFor;
  /** False when the SDK probe ran without project settings (untrusted folder): scanned project agents are then merged in. Default true. */
  projectLoaded?: boolean;
}

/** Output of `buildAgentsCatalog`: sorted by name, cut at `LIMITS.agentTypes`. */
export interface AgentsCatalog {
  agents: AgentTypeItem[];
  truncated: boolean;
}

/**
 * Joins `supportedAgents()` (name, description, model) with the agent files' front matter (`tools`, and `model` when the SDK
 * has none). A row matching no file and carrying no `plugin:` prefix is a built-in type (`Explore`, `Plan`, ...). A missing or
 * empty `tools` means all tools (the field is left absent). Without an SDK list the scanned files alone are the set.
 */
export function buildAgentsCatalog(input: AgentsCatalogInput): AgentsCatalog {
  const byKey = new Map<string, ScannedAgent>();
  for (const a of input.scan.agents) if (!byKey.has(a.name)) byKey.set(a.name, a);
  const drafts: { item: AgentTypeItem; file?: string }[] = [];
  const rows = sdkRows(input.sdkAgents);
  const seen = new Set<string>();
  const make = (name: string, desc: string, model: string | undefined, hit: ScannedAgent | undefined, colon: number): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const plugin = hit?.plugin ?? (!hit && colon > 0 ? name.slice(0, colon) : undefined);
    const source: AgentTypeItem['source'] = hit ? hit.source : colon > 0 ? 'plugin' : 'builtin';
    const item: AgentTypeItem = { name, description: desc !== '' ? desc : (hit?.description ?? ''), source };
    if (plugin) item.plugin = plugin;
    const m = model ?? hit?.model;
    if (m) item.model = m;
    if (hit?.tools) item.tools = hit.tools.slice();
    drafts.push(hit ? { item, file: hit.file } : { item });
  };
  if (rows) {
    for (const r of rows) make(r.name, r.description, r.model, byKey.get(r.name), r.name.indexOf(':'));
    if (input.projectLoaded === false) {
      for (const a of input.scan.agents) if (a.source === 'project') make(a.name, a.description ?? '', undefined, a, -1);
    }
  } else {
    for (const a of input.scan.agents) make(a.name, a.description ?? '', undefined, a, a.plugin ? a.plugin.length : -1);
  }
  drafts.sort((a, b) => byName(a.item, b.item));
  const truncated = drafts.length > LIMITS.agentTypes;
  const agents = drafts.slice(0, LIMITS.agentTypes).map((d) => {
    const id = fileId(input.fileIdFor, d.file);
    if (id) d.item.fileId = id;
    return d.item;
  });
  return { agents, truncated };
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers (scan plus build)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `skillUsage` from the `.claude.json` at `claudeJsonPath`, through `readCappedJson` (32 MB cap) and `parseSkillUsage`
 * (the whitelist). The file is rewritten often by running sessions, so an unparsable read is retried once. Never throws;
 * anything unusable is an empty map.
 */
export async function readSkillUsage(claudeJsonPath: string, fs: ConfigFs): Promise<Map<string, SkillUsageEntry>> {
  let r = await readCappedJson(claudeJsonPath, fs);
  if (!r.ok && r.reason === 'invalid') r = await readCappedJson(claudeJsonPath, fs);
  return r.ok ? parseSkillUsage(r.value) : new Map();
}

/** Scans the disk and builds the library's skills and commands. `sdkCommands` is `supportedCommands()` when it is available. */
export async function readSkillsCatalog(opts: ScanOptions & { sdkCommands?: unknown; skillUsage: ReadonlyMap<string, SkillUsageEntry>; fileIdFor: FileIdFor; projectLoaded?: boolean }): Promise<SkillsCatalog> {
  const scan = await scanSkillsAndCommands(opts);
  return buildSkillsCatalog({ sdkCommands: opts.sdkCommands, scan, usage: opts.skillUsage, fileIdFor: opts.fileIdFor, projectLoaded: opts.projectLoaded });
}

/** Scans the disk and builds the agency's subagent types. `sdkAgents` is `supportedAgents()` when it is available. */
export async function readAgentsCatalog(opts: ScanOptions & { sdkAgents?: unknown; fileIdFor: FileIdFor; projectLoaded?: boolean }): Promise<AgentsCatalog> {
  const scan = await scanAgents(opts);
  return buildAgentsCatalog({ sdkAgents: opts.sdkAgents, scan, fileIdFor: opts.fileIdFor, projectLoaded: opts.projectLoaded });
}
