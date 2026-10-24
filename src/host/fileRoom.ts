// The file room's host side: which folders the webview may browse, and the only code that reads them for it. The webview
// is untrusted and names things by `rootId` plus a relative path; this module turns that into a real path it has checked,
// and every listing and preview is built from that real path. No `vscode` import. File access goes through an optional
// `FileRoomFs` (the real node fs by default) so tests can interfere between two steps.
//
// Absolute paths stay in here, apart from `FileRoot.projectPath` (which the contract allows). Logging is ids, kinds and
// counts only, never a path, a name or file text.
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Dir, Dirent, Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeHome, isInsideDir } from '../claude/paths.ts';
import { FILE_ROOT_KINDS, LIMITS } from '../shared/protocol.ts';
import type { DirEntry, FileRoot, FileRootKind } from '../shared/protocol.ts';
import { relPath } from '../shared/validate.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Secret files

/** Folder names whose whole contents count as secret (compared case-insensitively). */
export const SECRET_DIRS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.kube', '.docker'];

// Exact basenames (lower case). `.env.example`, `.env.sample` and `.env.template` are the only `.env*` files left out.
const SECRET_NAMES: ReadonlySet<string> = new Set([
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd', '.dockercfg', '.s3cfg', '.boto',
  'credentials', '.credentials.json', '.vault_pass', '.vault-pass', 'vault_pass', 'vault-pass',
]);

const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample', '.env.template']);

// Extensions (lower case, with the dot) that are key or secret material. A public `*.pub` is not in the list.
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.p8', '.pk8', '.ppk', '.kdbx', '.kdb',
  '.keychain', '.keychain-db', '.secret', '.secrets', '.env', '.tfvars', '.tfstate',
]);

/**
 * True when a file's own name looks like a secret file (a basename, not a path; case-insensitive). The list: `.env` and
 * `.env.*` except the `.example`, `.sample` and `.template` variants, `*.env`; `*.pem`, `*.key`, `*.p12`, `*.pfx`,
 * `*.keystore`, `*.jks`, `*.p8`, `*.pk8`, `*.ppk`, `*.kdbx`, `*.kdb`, `*.keychain`, `*.keychain-db`; `id_*` except
 * `*.pub`; `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `.dockercfg`, `.s3cfg`,
 * `.boto`; `credentials`, `credentials*.json`, `.credentials.json`; `secrets.*`, `*.secret`, `*.secrets`; Terraform
 * `*.tfvars`, `*.tfstate` and `*.tfstate.*`; service account and OAuth client files (`service-account*.json`,
 * `serviceaccount*.json`, `client_secret*.json`); Ansible vault password files.
 */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '') return false;
  if (n === '.env' || n.startsWith('.env.')) return !ENV_TEMPLATES.has(n);
  if (n.startsWith('.env')) return true;
  if (SECRET_NAMES.has(n)) return true;
  if (n.startsWith('id_')) return !n.endsWith('.pub');
  if (/^credentials.*\.json$/.test(n) || /^(service-?account|client_secret).*\.json$/.test(n)) return true;
  if (n.startsWith('secrets.')) return true;
  if (/\.tfstate\./.test(n) || /^vault[-_]pass/.test(n)) return true;
  const dot = n.lastIndexOf('.');
  return dot > 0 && SECRET_EXTENSIONS.has(n.slice(dot));
}

/**
 * True when `p` (a `/` or `\` separated path, relative or absolute) is a secret file: its basename passes
 * `isSecretName`, or any folder above it is one of SECRET_DIRS.
 */
export function isSecretPath(p: string): boolean {
  const segs = p.split(/[\\/]/).filter((s) => s !== '');
  const last = segs.pop();
  if (last === undefined) return false;
  for (const s of segs) if (SECRET_DIRS.includes(s.toLowerCase())) return true;
  return isSecretName(last);
}

// ---------------------------------------------------------------------------------------------------------------------
// Types

/** A folder the host proposes as a root. `path` must be absolute; `label` defaults to the folder name. */
export interface RootCandidate {
  kind: FileRootKind;
  path: string;
  label?: string;
}

/** Why a path was refused. `notAllowed` covers the Claude data folder's private files and a folder the OS will not let us read. */
export type ResolveError = 'unknownRoot' | 'badPath' | 'outside' | 'missing' | 'notAllowed';

/** `ResolveError` plus the failures of listing and previewing. `changed` = the file was swapped between the check and the read. */
export type FileRoomError = ResolveError | 'notDir' | 'notFile' | 'changed' | 'failed';

export type Resolved = { ok: true; path: string } | { ok: false; error: ResolveError };

export type ListResult = { ok: true; entries: DirEntry[]; truncated: boolean } | { ok: false; error: FileRoomError };

/** The body of a `fileText` message (everything after `reqId`, `rootId` and `relPath`). */
export interface FilePreview {
  size: number;
  text?: string;
  truncated?: true;
  binary?: true;
  secret?: true;
  tooLarge?: true;
  markdown?: true;
}

export type ReadResult = { ok: true; preview: FilePreview } | { ok: false; error: FileRoomError };

/** The open file the preview reads from (a subset of `fs.promises.FileHandle`). */
export interface FileRoomHandle {
  stat(): Promise<BigIntStats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The fs calls this module makes. Defaults to the real thing; tests wrap it to change the disk between two steps. */
export interface FileRoomFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<Stats>;
  lstat(p: string): Promise<Stats>;
  lstatBig(p: string): Promise<BigIntStats>;
  opendir(p: string): Promise<Dir>;
  open(p: string, flags: number): Promise<FileRoomHandle>;
}

export interface FileRoomDeps {
  fs?: FileRoomFs;
  /** The home folder, for the `~` in `display`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Claude Code's data folder, whose private files are never listed or opened. Defaults to `claudeHome()`. */
  claudeHome?: string;
  log?: (line: string) => void;
}

const realFs: FileRoomFs = {
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  lstatBig: (p) => fsp.lstat(p, { bigint: true }),
  opendir: (p) => fsp.opendir(p),
  open: async (p, flags) => {
    const h = await fsp.open(p, flags);
    return {
      stat: () => h.stat({ bigint: true }),
      read: (buffer, offset, length, position) => h.read(buffer, offset, length, position),
      close: () => h.close(),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Bytes inspected for the binary check. */
const SNIFF_BYTES = 8192;
/** A sniffed block with more than this share of invalid UTF-8 is binary. */
const BINARY_BAD_SHARE = 0.1;
/** Directory entries read before giving up on sorting the folder (so an enormous folder cannot be pulled into memory). */
const SCAN_CAP = LIMITS.dirEntries * 10;
const MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.mdx'];
// Files and folders inside the Claude data folder that the host never lists or opens, whichever root they are reached from.
const CLAUDE_PRIVATE: readonly string[] = ['session-env', 'paste-cache', 'file-history', 'history.jsonl', '.credentials.json'];

/** A log-safe description of an error: its code or name, never its message (which holds a path). */
function errTag(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return e instanceof Error ? e.name : 'error';
}

function errCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A short, path-free sentence for an error reply. */
export function fileRoomErrorText(e: FileRoomError): string {
  switch (e) {
    case 'unknownRoot': return 'That folder is not available any more.';
    case 'badPath': return 'That path is not valid.';
    case 'outside': return 'That path leaves the folder.';
    case 'missing': return 'That file or folder no longer exists.';
    case 'notAllowed': return 'That file or folder cannot be opened here.';
    case 'notDir': return 'That is not a folder.';
    case 'notFile': return 'That is not a regular file.';
    case 'changed': return 'The file changed while it was being read.';
    default: return 'The file could not be read.';
  }
}

function direntClass(d: Dirent): 'dir' | 'file' | 'link' | 'other' | 'unknown' {
  if (d.isSymbolicLink()) return 'link';
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  if (d.isBlockDevice() || d.isCharacterDevice() || d.isFIFO() || d.isSocket()) return 'other';
  return 'unknown';
}

function statClass(s: Stats): 'dir' | 'file' | 'link' | 'other' {
  if (s.isSymbolicLink()) return 'link';
  if (s.isDirectory()) return 'dir';
  return s.isFile() ? 'file' : 'other';
}

function lowerCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Length of `buf[0..n)` once cut back to a UTF-8 character boundary. `buf[n]` (the byte after the cut) must be readable. */
function utf8Boundary(buf: Uint8Array, n: number): number {
  // A continuation byte (10xxxxxx) after the cut means the cut splits a character: drop it back to its lead byte (at most 3 back).
  if (((buf[n] ?? 0) & 0xc0) !== 0x80) return n;
  let j = n;
  for (let back = 0; back < 3 && j > 0 && ((buf[j] ?? 0) & 0xc0) === 0x80; back++) j--;
  return ((buf[j] ?? 0) & 0xc0) === 0xc0 ? j : n;
}

/** True when the start of `buf` is not text: a NUL byte, or a high share of invalid UTF-8. */
function looksBinary(buf: Uint8Array, complete: boolean): boolean {
  let n = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  // A sniff block cut mid-character would count that character as invalid: end it on a boundary unless it is the whole file.
  if (!complete && n === SNIFF_BYTES && n < buf.length) n = utf8Boundary(buf, n);
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buf.subarray(0, n));
  if (text.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  return bad / text.length > BINARY_BAD_SHARE;
}

interface RootEntry {
  id: string;
  /** Canonical path of the root, from `realpath` when the root was accepted. */
  real: string;
  info: FileRoot;
}

// ---------------------------------------------------------------------------------------------------------------------
// FileRoom

export class FileRoom {
  readonly #fs: FileRoomFs;
  readonly #home: string;
  readonly #claudeHome: string;
  readonly #log: (line: string) => void;
  /** Real path -> id, kept for the life of the instance so a root keeps its id when the list is rebuilt. */
  readonly #ids = new Map<string, string>();
  #nextId = 1;
  #roots = new Map<string, RootEntry>();
  #queue: Promise<unknown> = Promise.resolve();
  #hidden: Promise<string[]> | undefined;

  constructor(deps: FileRoomDeps = {}) {
    this.#fs = deps.fs ?? realFs;
    this.#home = deps.homeDir ?? os.homedir();
    this.#claudeHome = deps.claudeHome ?? claudeHome();
    this.#log = deps.log ?? (() => {});
  }

  // ---- Roots ----------------------------------------------------------------------------------------------------

  /**
   * Replace the allowed roots. Each candidate is resolved with `realpath` and must be an existing folder; candidates that
   * are not absolute, not a folder or not readable are skipped, a repeat of a real path is dropped (the first one wins,
   * so put the preferred kind and label first), and the list is cut at LIMITS.fileRoots. A root keeps its `rootId`
   * whenever its real path comes back. A root left out stops being valid at once. Calls are applied in order.
   */
  setRoots(candidates: readonly RootCandidate[]): Promise<FileRoot[]> {
    const run = this.#queue.then(() => this.#applyRoots(candidates));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The current roots, as last set. */
  getRoots(): FileRoot[] {
    return [...this.#roots.values()].map((r) => ({ ...r.info }));
  }

  async #applyRoots(candidates: readonly RootCandidate[]): Promise<FileRoot[]> {
    const hidden = await this.#hiddenBases();
    const next = new Map<string, RootEntry>();
    const seen = new Set<string>();
    for (const c of candidates) {
      if (next.size >= LIMITS.fileRoots) break;
      if (!(FILE_ROOT_KINDS as readonly string[]).includes(c.kind)) continue;
      if (typeof c.path !== 'string' || c.path === '' || c.path.length > LIMITS.pathChars || !path.isAbsolute(c.path)) continue;
      let real: string;
      try {
        real = await this.#fs.realpath(c.path);
        if (!(await this.#fs.stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(real) || this.#isPrivate(real, hidden)) continue;
      seen.add(real);
      let id = this.#ids.get(real);
      if (id === undefined) {
        id = `r${this.#nextId++}`;
        this.#ids.set(real, id);
      }
      const abs = path.resolve(c.path);
      // eslint-disable-next-line no-control-regex
      const label = (c.label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS.nameChars);
      next.set(id, {
        id,
        real,
        info: {
          rootId: id,
          label: label !== '' ? label : path.basename(abs).slice(0, LIMITS.nameChars) || abs.slice(0, LIMITS.nameChars),
          kind: c.kind,
          display: this.#display(abs),
          projectPath: abs,
        },
      });
    }
    this.#roots = next;
    this.#log(`fileRoom roots=${next.size} of ${candidates.length}`);
    return this.getRoots();
  }

  #display(abs: string): string {
    const shown = this.#home !== '' && isInsideDir(abs, this.#home) ? '~' + abs.slice(this.#home.replace(/[\\/]+$/, '').length) : abs;
    return shown.slice(0, LIMITS.pathChars);
  }

  // ---- Paths ----------------------------------------------------------------------------------------------------

  /** The Claude data folder as written and as `realpath` reports it (cached). */
  #hiddenBases(): Promise<string[]> {
    this.#hidden ??= this.#fs.realpath(this.#claudeHome).then(
      (real) => (real === this.#claudeHome ? [real] : [this.#claudeHome, real]),
      () => [this.#claudeHome],
    );
    return this.#hidden;
  }

  /** True for the private files of the Claude data folder (`.credentials.json`, `sessions/*.key`, `session-env`, ...). */
  #isPrivate(abs: string, bases: readonly string[]): boolean {
    for (const base of bases) {
      if (!isInsideDir(abs, base)) continue;
      const segs = path.relative(base, abs).split(/[\\/]/).filter((s) => s !== '');
      const first = segs[0];
      if (first === undefined) continue;
      if (CLAUDE_PRIVATE.includes(first)) return true;
      if (first === 'sessions' && (segs[segs.length - 1] ?? '').endsWith('.key')) return true;
    }
    return false;
  }

  async #resolveIn(rootId: string, rel: string): Promise<{ ok: true; path: string; root: RootEntry } | { ok: false; error: ResolveError }> {
    const root = typeof rootId === 'string' ? this.#roots.get(rootId) : undefined;
    if (root === undefined) return { ok: false, error: 'unknownRoot' };
    if (relPath(rel) === undefined) return { ok: false, error: 'badPath' };
    const bases = await this.#hiddenBases();
    let real: string;
    try {
      // The root itself must still be where it was when it was accepted.
      if ((await this.#fs.realpath(root.real)) !== root.real) return { ok: false, error: 'missing' };
      real = await this.#fs.realpath(rel === '' ? root.real : path.join(root.real, ...rel.split('/')));
    } catch (e) {
      const c = errCode(e);
      return { ok: false, error: c === 'EACCES' || c === 'EPERM' ? 'notAllowed' : 'missing' };
    }
    if (!isInsideDir(real, root.real)) return { ok: false, error: 'outside' };
    if (this.#isPrivate(real, bases)) return { ok: false, error: 'notAllowed' };
    return { ok: true, path: real, root };
  }

  /**
   * Turn a request's `rootId` and `relPath` into the real path to use for everything after: `relPath` must pass the
   * validator, the root and the joined target are both put through `realpath`, and the target must lie inside the root
   * (the root itself is fine). A symlink anywhere on the way that lands outside the root is `outside`; a dangling link
   * or absent file is `missing`; the Claude data folder's private files are `notAllowed`. It does not check what kind of
   * thing the path is. Callers use the returned path and never join the strings again.
   */
  async resolve(rootId: string, rel: string): Promise<Resolved> {
    const r = await this.#resolveIn(rootId, rel);
    return r.ok ? { ok: true, path: r.path } : r;
  }

  // ---- Listing --------------------------------------------------------------------------------------------------

  /**
   * List a folder: folders first, then the rest, each case-insensitively by name, at most LIMITS.dirEntries (`truncated`
   * when more exist). Symlinks get a file or folder kind only when their real target is inside the root and not private;
   * otherwise they are `other`, and `link` is set only on those that resolve inside. Sockets, FIFOs and devices are `other`.
   * Up to ten times the cap is read and sorted before the cut, but only entries that survive the cut are stat-ed.
   * A symlink counts as a file for that cut, whatever it points at.
   */
  async listDir(rootId: string, rel: string): Promise<ListResult> {
    try {
      const r = await this.#resolveIn(rootId, rel);
      if (!r.ok) return this.#fail('listDir', rootId, r.error);
      if (!(await this.#fs.stat(r.path)).isDirectory()) return this.#fail('listDir', rootId, 'notDir');
      const bases = await this.#hiddenBases();

      const scanned: Dirent[] = [];
      let truncated = false;
      const dir = await this.#fs.opendir(r.path);
      try {
        for (;;) {
          const d = await dir.read();
          if (d === null) break;
          if (scanned.length >= SCAN_CAP) {
            truncated = true;
            break;
          }
          if (!this.#isPrivate(path.join(r.path, d.name), bases)) scanned.push(d);
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
      scanned.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || lowerCompare(a.name, b.name));
      if (scanned.length > LIMITS.dirEntries) {
        truncated = true;
        scanned.length = LIMITS.dirEntries;
      }
      const built = await Promise.all(scanned.map((d) => this.#entry(r.root, r.path, d, bases)));
      const entries = built.filter((e): e is DirEntry => e !== undefined);
      entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || lowerCompare(a.name, b.name));
      this.#log(`listDir root=${this.#rootTag(rootId)} entries=${entries.length}${truncated ? ' truncated' : ''}`);
      return { ok: true, entries, truncated };
    } catch (e) {
      this.#log(`listDir root=${this.#rootTag(rootId)} failed ${errTag(e)}`);
      return { ok: false, error: errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR' ? 'missing' : 'failed' };
    }
  }

  async #entry(root: RootEntry, realDir: string, d: Dirent, bases: readonly string[]): Promise<DirEntry | undefined> {
    const name = d.name;
    const abs = path.join(realDir, name);
    try {
      let cls = direntClass(d);
      if (cls === 'unknown') cls = statClass(await this.#fs.lstat(abs));
      if (cls === 'dir') return { name, kind: 'dir' };
      if (cls === 'other') return { name, kind: 'other' };
      if (cls === 'file') return this.#fileEntry(name, await this.#fs.lstat(abs), isSecretPath(abs));
      // A symlink: its kind is its target's, but only for a target inside the root.
      let target: string;
      try {
        target = await this.#fs.realpath(abs);
      } catch {
        return { name, kind: 'other' };
      }
      if (!isInsideDir(target, root.real) || this.#isPrivate(target, bases)) return { name, kind: 'other' };
      const st = await this.#fs.stat(target);
      if (st.isDirectory()) return { name, kind: 'dir', link: true };
      if (!st.isFile()) return { name, kind: 'other', link: true };
      return { ...this.#fileEntry(name, st, isSecretPath(abs) || isSecretPath(target)), link: true };
    } catch {
      return undefined; // vanished while listing
    }
  }

  #fileEntry(name: string, st: Stats, secret: boolean): DirEntry {
    const e: DirEntry = { name, kind: 'file', size: st.size, mtime: Math.round(st.mtimeMs) };
    if (secret) e.secret = true;
    return e;
  }

  // ---- Preview --------------------------------------------------------------------------------------------------

  /**
   * Preview a file. Only regular files are read (a FIFO or device would block or never end). A secret name gives
   * `secret` and a file over LIMITS.previewMaxFileBytes gives `tooLarge`, both without opening it. Otherwise at most
   * LIMITS.previewBytes are read from the resolved real path, opened with O_NOFOLLOW, and the open file must be the one
   * that was checked (same device and inode, and the path still resolves to itself). A NUL byte or mostly invalid
   * UTF-8 in the first 8 KB gives `binary`. Text is cut on a character boundary (`truncated`).
   */
  async readFile(rootId: string, rel: string): Promise<ReadResult> {
    try {
      const r = await this.#resolveIn(rootId, rel);
      if (!r.ok) return this.#fail('readFile', rootId, r.error);
      const before = await this.#fs.lstatBig(r.path);
      if (!before.isFile()) return this.#fail('readFile', rootId, 'notFile');
      const size = Number(before.size);
      const preview: FilePreview = { size };
      if (isSecretPath(rel) || isSecretPath(r.path)) {
        preview.secret = true;
        this.#log(`readFile root=${this.#rootTag(rootId)} bytes=${size} secret`);
        return { ok: true, preview };
      }
      if (size > LIMITS.previewMaxFileBytes) {
        preview.tooLarge = true;
        this.#log(`readFile root=${this.#rootTag(rootId)} bytes=${size} tooLarge`);
        return { ok: true, preview };
      }

      // O_NONBLOCK so that a file swapped for a FIFO cannot hang the open.
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
      const handle = await this.#fs.open(r.path, flags);
      const buf = Buffer.alloc(LIMITS.previewBytes + 1);
      let got = 0;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return this.#fail('readFile', rootId, 'changed');
        // A folder above the file could have become a symlink since `resolve`: the path must still lead to this file.
        if ((await this.#fs.realpath(r.path)) !== r.path) return this.#fail('readFile', rootId, 'changed');
        while (got < buf.length) {
          const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
      } finally {
        await handle.close().catch(() => undefined);
      }

      const bytes = buf.subarray(0, got);
      const cut = got > LIMITS.previewBytes;
      if (looksBinary(bytes, !cut)) {
        preview.binary = true;
        this.#log(`readFile root=${this.#rootTag(rootId)} bytes=${size} binary`);
        return { ok: true, preview };
      }
      const end = cut ? utf8Boundary(bytes, LIMITS.previewBytes) : got;
      preview.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
      if (cut) preview.truncated = true;
      const base = path.posix.basename(rel).toLowerCase();
      if (MARKDOWN_EXTENSIONS.some((x) => base.endsWith(x))) preview.markdown = true;
      this.#log(`readFile root=${this.#rootTag(rootId)} bytes=${size} read=${end}${cut ? ' truncated' : ''}${preview.markdown ? ' markdown' : ''}`);
      return { ok: true, preview };
    } catch (e) {
      this.#log(`readFile root=${this.#rootTag(rootId)} failed ${errTag(e)}`);
      const c = errCode(e);
      return { ok: false, error: c === 'ENOENT' || c === 'ENOTDIR' || c === 'ELOOP' ? 'missing' : 'failed' };
    }
  }

  /** A `rootId` for a log line: the id when it is a known root, else `<invalid>`. */
  #rootTag(rootId: string): string {
    return typeof rootId === 'string' && this.#roots.has(rootId) ? rootId : '<invalid>';
  }

  #fail(op: string, rootId: string, error: FileRoomError): { ok: false; error: FileRoomError } {
    this.#log(`${op} root=${this.#rootTag(rootId)} refused ${error}`);
    return { ok: false, error };
  }
}
