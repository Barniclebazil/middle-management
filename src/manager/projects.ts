// Project folders offered on the assignment memo, plus the git branch of each. Pure: file access is injected.
// No `vscode` import.
import * as path from 'node:path';
import { LIMITS } from '../shared/protocol.ts';
import type { AgentSnapshot, ProjectOption } from '../shared/protocol.ts';
import type { SessionInfo } from '../claude/types.ts';

/** Minimal synchronous file access. `readFile` returns undefined when the file is missing or is a directory. */
export interface ProjectFs {
  exists: (p: string) => boolean;
  readFile: (p: string) => string | undefined;
}

/** Windows-style paths (drive letter or UNC) use win32 rules whatever the host platform is. */
function api(p: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') ? path.win32 : path.posix;
}

function isAbsolutePath(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

function safeRead(fs: ProjectFs, p: string): string | undefined {
  try {
    return fs.readFile(p);
  } catch {
    return undefined;
  }
}

function safeExists(fs: ProjectFs, p: string): boolean {
  try {
    return fs.exists(p);
  } catch {
    return false;
  }
}

/** `ref: refs/heads/main` gives `main`; a 40 or 64 digit hex sha (detached HEAD) gives its first 7 characters. */
export function parseGitHead(text: string): string | undefined {
  const t = text.trim();
  const ref = /^ref:\s*(\S.*)$/.exec(t);
  if (ref) {
    const r = ref[1]!.trim();
    if (r.startsWith('refs/heads/')) return r.slice('refs/heads/'.length) || undefined;
    return r.replace(/^refs\//, '') || undefined;
  }
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(t)) return t.slice(0, 7);
  return undefined;
}

/**
 * Current branch of the repository containing `dir`, from `.git/HEAD`. Walks up the parents to find the repo root.
 * `.git` may be a directory, or a file (`gitdir: <path>`) for worktrees and submodules; the path may be relative to
 * the folder holding the file. Never throws.
 */
export function readGitBranch(dir: string, fs: ProjectFs): string | undefined {
  try {
    let d = dir;
    for (let i = 0; i < 64; i++) {
      const p = api(d);
      const dotGit = p.join(d, '.git');
      const head = safeRead(fs, p.join(dotGit, 'HEAD'));
      if (head !== undefined) return parseGitHead(head);
      const file = safeRead(fs, dotGit);
      if (file !== undefined) {
        const m = /^gitdir:\s*(.+)$/m.exec(file);
        if (m) {
          const target = m[1]!.trim();
          const abs = isAbsolutePath(target) ? target : p.resolve(d, target);
          const wtHead = safeRead(fs, api(abs).join(abs, 'HEAD'));
          return wtHead === undefined ? undefined : parseGitHead(wtHead);
        }
        return undefined;
      }
      if (safeExists(fs, dotGit)) return undefined; // a .git we cannot read: stop at this repo root
      const parent = p.dirname(d);
      if (parent === d) return undefined;
      d = parent;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export interface ListProjectsInput extends ProjectFs {
  workspaceFolders: string[];
  /** Most recent first. */
  recentCwds: string[];
  /** Folders the user picked with the folder dialog this session (any order). */
  browsed?: string[];
  /** Test hook; defaults to `process.platform`. */
  platform?: string;
}

function dedupeKey(p: string, platform: string): string {
  let k = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
  return platform === 'win32' || /^[A-Za-z]:/.test(k) ? k.toLowerCase() : k;
}

function usablePath(p: unknown): p is string {
  return typeof p === 'string' && p !== '' && p.length <= LIMITS.pathChars && !p.includes('\0') && isAbsolutePath(p);
}

/**
 * Workspace folders first, then recent cwds, then browsed folders; de-duplicated (case-insensitive on win32), capped at
 * LIMITS.projects. When the cap bites, recent folders are dropped first so a browsed folder is never lost.
 */
export function listProjects(input: ListProjectsInput): ProjectOption[] {
  const platform = input.platform ?? process.platform;
  const seen = new Set<string>();
  const take = (paths: readonly unknown[], source: ProjectOption['source']): ProjectOption[] => {
    const out: ProjectOption[] = [];
    for (const raw of paths) {
      if (!usablePath(raw)) continue;
      const key = dedupeKey(raw, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      let exists = false;
      try {
        exists = input.exists(raw);
      } catch {
        exists = false;
      }
      const name = api(raw).basename(raw) || raw;
      const opt: ProjectOption = { path: raw, name, exists, source };
      if (exists) {
        const branch = readGitBranch(raw, input);
        if (branch !== undefined) opt.gitBranch = branch;
      }
      out.push(opt);
    }
    return out;
  };
  let ws = take(input.workspaceFolders, 'workspace');
  let recent = take(input.recentCwds, 'recent');
  const browsed = take(input.browsed ?? [], 'browsed');
  let over = ws.length + recent.length + browsed.length - LIMITS.projects;
  if (over > 0) {
    const cut = Math.min(over, recent.length);
    recent = recent.slice(0, recent.length - cut);
    over -= cut;
  }
  if (over > 0) ws = ws.slice(0, ws.length - Math.min(over, ws.length));
  return [...ws, ...recent, ...browsed].slice(0, LIMITS.projects);
}

/**
 * Collect working directories, most recently active first, from the agent snapshots and (optionally) the watcher's
 * session list. Duplicates are dropped; temps are skipped (they share their parent's folder).
 */
export function recentCwdsFrom(
  agents: readonly Pick<AgentSnapshot, 'kind' | 'cwd' | 'since' | 'lastPromptAt'>[],
  sessionsInfo?: readonly Pick<SessionInfo, 'cwd' | 'mtimeMs'>[],
): string[] {
  const entries: { cwd: string; t: number }[] = [];
  for (const a of agents) {
    if (a.kind === 'temp' || typeof a.cwd !== 'string' || a.cwd === '') continue;
    entries.push({ cwd: a.cwd, t: Math.max(a.since ?? 0, a.lastPromptAt ?? 0) });
  }
  for (const s of sessionsInfo ?? []) {
    if (typeof s.cwd === 'string' && s.cwd !== '') entries.push({ cwd: s.cwd, t: s.mtimeMs });
  }
  entries.sort((a, b) => b.t - a.t);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const key = dedupeKey(e.cwd, process.platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.cwd);
  }
  return out;
}
