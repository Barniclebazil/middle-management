// The Round B request router (docs/manager-mode.md section 16): the host side of the file room (filing cabinets), the
// library (bookshelf), the phone, the handbook (notice board) and the agency (sign). The messages are `getFileRoots`,
// `listDir`, `readFile`, `openFile`, `openDiff`, `getCatalog` and `openConfigFile`. No `vscode` import: the editor, git,
// the SDK probe and the disk are injected (`officeRequestsAdapters.ts` has the real ones), so all of it runs in Node tests.
//
// The webview is untrusted. It names a folder by `rootId` and a file by `rootId` plus `relPath`, or by `fileId`; this
// module holds the only maps from those ids to real paths. `FileRoom` does the path checks (realpath plus `isInsideDir`);
// `openFile` and `openDiff` add the one it leaves out, that the target is a regular file.
//
// Where the roots come from: the workspace folders, the cwds of the office's agents, and the folders the user browsed to
// in the new-task memo (a few). A request that arrives while roots are being rebuilt waits for that rebuild.
//
// Catalog trust. A project's own settings, skills, commands, agents and MCP servers are loaded by the probe only when VS
// Code trusts the workspace AND Claude Code trusts the folder. `workspaceTrusted` is the editor's answer AND "the folder
// lies inside a workspace folder" (the editor's trust says nothing about other folders); `claudeTrusted` is
// `approval.trustAccepted` read from `.claude.json` for exactly that folder. Both go to the probe as it asked for.
//
// Never leaves this module: `McpSnapshot.hostOnly`, `selectServersToStart` output and raw SDK rows. A catalog reply is
// built from the builders' whitelisted items only.
// Logging: request kinds, `reqId`s, `rootId`/`fileId` values, flags, counts and timings. No path, name, rule text, file text.
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { nodeConfigFs, readAgentsCatalog, readSkillUsage, readSkillsCatalog } from '../claude/catalog.ts';
import type { ConfigFs } from '../claude/catalog.ts';
import { readHandbook } from '../claude/handbook.ts';
import { buildMcpItems, readMcpConfig } from '../claude/mcpConfig.ts';
import type { McpTrust } from '../claude/mcpConfig.ts';
import { claudeConfigJsonPath, claudeHome, isInsideDir } from '../claude/paths.ts';
import { LIMITS } from '../shared/protocol.ts';
import type { CatalogReply, CatalogSection, FileRoot, HostToWebview, ProjectOption, WebviewToHost } from '../shared/protocol.ts';
import type { CatalogProbe } from '../manager/catalogProbe.ts';
import { fileRoomErrorText } from './fileRoom.ts';
import type { FileRoom, RootCandidate } from './fileRoom.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Types

/** The seven message types this module answers. */
export const OFFICE_REQUEST_TYPES = ['getFileRoots', 'listDir', 'readFile', 'openFile', 'openDiff', 'getCatalog', 'openConfigFile'] as const;
export type OfficeRequestType = (typeof OFFICE_REQUEST_TYPES)[number];
export type OfficeRequestMessage = Extract<WebviewToHost, { type: OfficeRequestType }>;

/** What `openGitDiff` reports. `noGit`: the git extension is missing or off; `noRepo`: the folder is not in a repository; `untracked`: the file is not in HEAD. */
export type GitDiffResult = { ok: true } | { ok: false; reason: 'noGit' | 'noRepo' | 'untracked' | 'failed' };

/** The kind of thing at a real path (`stat`, so a link counts as its target), or undefined when it is not there. */
export type PathKind = 'file' | 'dir' | 'other';

/** The two probe calls this module makes (`createCatalogProbe` returns them). */
export type CatalogProbeLike = Pick<CatalogProbe, 'probeCatalog' | 'probeMcpStatus'>;

export interface OfficeRequestsDeps {
  /** The one `FileRoom` of the extension (built with the same `claudeHome` as everything else). */
  room: Pick<FileRoom, 'setRoots' | 'getRoots' | 'resolve' | 'listDir' | 'readFile'>;
  /** Post to the webview (the office view). */
  post(msg: HostToWebview): void;
  workspaceFolders(): string[];
  /** `vscode.workspace.isTrusted`. */
  workspaceTrusted(): boolean;
  /** `stat` of a REAL path: what it is, or undefined when it is gone or cannot be read. */
  statKind(realPath: string): Promise<PathKind | undefined>;
  /** `showTextDocument` on a real path. */
  openInEditor(realPath: string): Promise<void>;
  /** The editor's diff of a real path against git HEAD, through the built-in git extension (never our own git process). */
  openGitDiff(realPath: string): Promise<GitDiffResult>;
  probe: CatalogProbeLike;
  /** An empty folder the extension owns: the cwd for a catalog with no project. */
  neutralCwd(): string;
  /** True while the office shows demo workers: roots are not pushed then. */
  isDemo?(): boolean;
  /** Visible at the start (default false); `setVisible` changes it. */
  visible?: boolean;
  fs?: ConfigFs;
  home?: string;
  env?: Record<string, string | undefined>;
  realpath?(p: string): Promise<string>;
  /** Source of `fileId`s. Default: `f` plus 32 random hex digits. */
  randomId?(): string;
  /** Registered `fileId`s kept at most (default `MAX_FILE_IDS`). */
  maxFileIds?: number;
  now?(): number;
  log?(line: string): void;
}

export interface OfficeRequestOptions {
  /** A user refresh: the probe skips its cache. (`getCatalog` has no field for it yet; see the report of task 5.6.) */
  force?: boolean;
}

export interface OfficeRequests {
  /** True for the seven Round B request types (the router checks this after the demo guard). */
  handles(msg: WebviewToHost): msg is OfficeRequestMessage;
  /** Answer one request. Never rejects. */
  handle(msg: WebviewToHost, opts?: OfficeRequestOptions): Promise<void>;
  /** The office became visible or hidden. Becoming visible pushes `fileRoots` if the list changed while hidden. */
  setVisible(visible: boolean): void;
  /** The cwds of the office's agents (real sessions only; may contain undefined). A repeat of the same list does nothing. */
  setAgentCwds(cwds: readonly (string | undefined)[]): void;
  /** The `projects` list the host sent: folders with `source: 'browsed'` become `project` roots. */
  setProjects(projects: readonly Pick<ProjectOption, 'path' | 'source' | 'exists'>[]): void;
  /** Rebuild the roots from the workspace folders, agents and projects now. Resolves with the new list. */
  refreshRoots(): Promise<FileRoot[]>;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The fileId registry

/** Registered `fileId`s kept at most. */
export const MAX_FILE_IDS = 2000;
/** Agent cwds and browsed projects offered as roots at most (the file room itself caps the total at `LIMITS.fileRoots`). */
const MAX_AGENT_ROOTS = 40;
const MAX_PROJECT_ROOTS = 10;
/** Catalog replies remembered to answer from while the office is hidden. */
const MAX_CATALOG_CACHE = 16;

/**
 * `fileId` <-> absolute path of a config file the host itself found. Ids are random (not derived from the path, so one
 * cannot be guessed or computed), the same path keeps its id while it stays registered, and the oldest are dropped past
 * the cap. A path seen again counts as new, so what a panel lists most recently stays openable.
 */
export class FileIdRegistry {
  readonly #byPath = new Map<string, string>();
  readonly #byId = new Map<string, string>();
  readonly #max: number;
  readonly #random: () => string;

  constructor(opts: { max?: number; randomId?: () => string } = {}) {
    this.#max = Math.max(1, opts.max ?? MAX_FILE_IDS);
    this.#random = opts.randomId ?? ((): string => 'f' + randomUUID().replace(/-/g, ''));
  }

  /** The id for `absPath`, registering it when new. */
  idFor(absPath: string): string {
    let id = this.#byPath.get(absPath);
    if (id !== undefined) {
      this.#byPath.delete(absPath); // re-insert below: most recent last
    } else {
      do {
        id = this.#random();
      } while (this.#byId.has(id) || id === '');
      this.#byId.set(id, absPath);
    }
    this.#byPath.set(absPath, id);
    while (this.#byPath.size > this.#max) {
      const oldest = this.#byPath.keys().next();
      if (oldest.done === true) break;
      const oldId = this.#byPath.get(oldest.value);
      this.#byPath.delete(oldest.value);
      if (oldId !== undefined) this.#byId.delete(oldId);
    }
    return id;
  }

  /** The path registered under `id`, or undefined for an unknown or evicted id. */
  pathFor(id: string): string | undefined {
    return this.#byId.get(id);
  }

  get size(): number {
    return this.#byId.size;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Texts (short, path-free)

const TEXT = {
  generic: 'That request could not be completed.',
  hidden: 'The office is hidden. Open it and try again.',
  catalogFailed: 'Could not read that list.',
  noFile: 'That file is no longer available.',
  openFailed: 'Could not open the file.',
  noGit: 'Git is not available in this editor.',
  noRepo: 'This file is not in a git repository.',
  untracked: 'This file is not tracked by git yet, so there is nothing to compare it with.',
  diffFailed: 'Could not open the diff.',
} as const;

function gitText(reason: 'noGit' | 'noRepo' | 'untracked' | 'failed'): string {
  switch (reason) {
    case 'noGit': return TEXT.noGit;
    case 'noRepo': return TEXT.noRepo;
    case 'untracked': return TEXT.untracked;
    default: return TEXT.diffFailed;
  }
}

/** A log-safe description of an error: its code or name, never its message (which may hold a path). */
function errTag(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,30}$/.test(code)) return code;
  return e instanceof Error && /^[A-Za-z]{1,30}$/.test(e.name) ? e.name : 'error';
}

/** `/`, `C:\\` and the like: never offered as a root (an agent started in `/` must not open the whole disk). */
function isFilesystemRoot(p: string): boolean {
  return path.parse(p).root.replace(/[\\/]+$/, '') === p.replace(/[\\/]+$/, '');
}

/** Keeps the first of each path, drops anything that is not a usable absolute path or is a filesystem root. */
function cleanPaths(list: readonly (string | undefined)[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (typeof p !== 'string' || p === '' || p.length > LIMITS.pathChars || p.includes('\0')) continue;
    if (!/^(\/|[A-Za-z]:[\\/])/.test(p) || isFilesystemRoot(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The router

interface Flight {
  /** Every request waiting on this computation (a repeat while it runs joins it). */
  reqIds: Set<string>;
  /** The latest body sent, so a joiner sees it at once (the MCP list updates). */
  last?: CatalogReply;
  done: Promise<void>;
}

export function createOfficeRequests(deps: OfficeRequestsDeps): OfficeRequests {
  const now = deps.now ?? Date.now;
  const log = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      // Logging must never throw.
    }
  };
  const fs = deps.fs ?? nodeConfigFs;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const realpath = deps.realpath ?? ((p: string): Promise<string> => fsp.realpath(p));
  const configDir = claudeHome(env, home);
  const registry = new FileIdRegistry({ ...(deps.maxFileIds === undefined ? {} : { max: deps.maxFileIds }), ...(deps.randomId === undefined ? {} : { randomId: deps.randomId }) });
  const fileIdFor = (abs: string): string => registry.idFor(abs);

  let visible = deps.visible === true;
  let disposed = false;
  let agentCwds: string[] = [];
  let projectPaths: string[] = [];
  let rootsQueue: Promise<unknown> = Promise.resolve();
  let lastRootsSig: string | undefined;
  let pushPending = false;
  const flights = new Map<string, Flight>();
  const catalogCache = new Map<string, CatalogReply>();

  const post = (msg: HostToWebview): void => {
    if (disposed) return;
    try {
      deps.post(msg);
    } catch {
      log(`post ${msg.type} failed`);
    }
  };
  /** A `rootId` for a log line: the id when it is a known root, else `<invalid>` (never the webview's own text). */
  const rootTag = (rootId: string): string => (deps.room.getRoots().some((r) => r.rootId === rootId) ? rootId : '<invalid>');
  const errorMsg = (message: string, reqId?: string): HostToWebview => ({ type: 'error', ...(reqId === undefined ? {} : { reqId }), message: message.slice(0, LIMITS.errorChars) });

  // ---- Roots ----------------------------------------------------------------------------------------------------

  function candidates(): RootCandidate[] {
    const out: RootCandidate[] = [];
    for (const p of cleanPaths(safeFolders(), LIMITS.fileRoots)) out.push({ kind: 'workspace', path: p });
    for (const p of agentCwds) out.push({ kind: 'agent', path: p });
    for (const p of projectPaths) out.push({ kind: 'project', path: p });
    return out;
  }

  function safeFolders(): string[] {
    try {
      return deps.workspaceFolders();
    } catch {
      return [];
    }
  }

  function pushRoots(roots: FileRoot[]): void {
    if (!visible || deps.isDemo?.() === true) {
      pushPending = true;
      return;
    }
    pushPending = false;
    post({ type: 'fileRoots', roots });
  }

  function refreshRoots(): Promise<FileRoot[]> {
    const run = rootsQueue.then(async () => {
      const roots = await deps.room.setRoots(candidates());
      const sig = JSON.stringify(roots);
      if (sig !== lastRootsSig) {
        lastRootsSig = sig;
        pushRoots(roots);
      }
      return roots;
    });
    rootsQueue = run.catch(() => undefined);
    return run;
  }

  /** Waits for the roots rebuild in progress (the latest one queued), so a request never races a root it just learned about. */
  async function rootsSettled(): Promise<void> {
    await rootsQueue;
  }

  function startRefresh(): void {
    refreshRoots().catch((e: unknown) => log(`roots refresh failed (${errTag(e)})`));
  }

  // ---- Files ----------------------------------------------------------------------------------------------------

  /** `resolve`, then require a regular file. Returns the real path, or the error text. */
  async function resolveRegularFile(rootId: string, rel: string): Promise<{ ok: true; path: string } | { ok: false; text: string; tag: string }> {
    const r = await deps.room.resolve(rootId, rel);
    if (!r.ok) return { ok: false, text: fileRoomErrorText(r.error), tag: r.error };
    const kind = await deps.statKind(r.path);
    if (kind === undefined) return { ok: false, text: fileRoomErrorText('missing'), tag: 'missing' };
    if (kind !== 'file') return { ok: false, text: fileRoomErrorText('notFile'), tag: 'notFile' };
    return { ok: true, path: r.path };
  }

  async function onListDir(msg: Extract<OfficeRequestMessage, { type: 'listDir' }>): Promise<void> {
    await rootsSettled();
    const r = await deps.room.listDir(msg.rootId, msg.relPath);
    if (!r.ok) {
      post(errorMsg(fileRoomErrorText(r.error), msg.reqId));
      return;
    }
    post({ type: 'dirListing', reqId: msg.reqId, rootId: msg.rootId, relPath: msg.relPath, entries: r.entries, truncated: r.truncated });
  }

  async function onReadFile(msg: Extract<OfficeRequestMessage, { type: 'readFile' }>): Promise<void> {
    await rootsSettled();
    const r = await deps.room.readFile(msg.rootId, msg.relPath);
    if (!r.ok) {
      post(errorMsg(fileRoomErrorText(r.error), msg.reqId));
      return;
    }
    const p = r.preview;
    const out: Extract<HostToWebview, { type: 'fileText' }> = { type: 'fileText', reqId: msg.reqId, rootId: msg.rootId, relPath: msg.relPath, size: p.size };
    if (p.text !== undefined) out.text = p.text;
    if (p.truncated === true) out.truncated = true;
    if (p.binary === true) out.binary = true;
    if (p.secret === true) out.secret = true;
    if (p.tooLarge === true) out.tooLarge = true;
    if (p.markdown === true) out.markdown = true;
    post(out);
  }

  async function onOpenFile(msg: Extract<OfficeRequestMessage, { type: 'openFile' }>): Promise<void> {
    await rootsSettled();
    const r = await resolveRegularFile(msg.rootId, msg.relPath);
    if (!r.ok) {
      log(`openFile root=${rootTag(msg.rootId)} refused ${r.tag}`);
      post(errorMsg(r.text));
      return;
    }
    try {
      await deps.openInEditor(r.path);
      log(`openFile root=${rootTag(msg.rootId)} ok`);
    } catch (e) {
      log(`openFile root=${rootTag(msg.rootId)} failed (${errTag(e)})`);
      post(errorMsg(TEXT.openFailed));
    }
  }

  async function onOpenDiff(msg: Extract<OfficeRequestMessage, { type: 'openDiff' }>): Promise<void> {
    await rootsSettled();
    const r = await resolveRegularFile(msg.rootId, msg.relPath);
    if (!r.ok) {
      log(`openDiff root=${rootTag(msg.rootId)} refused ${r.tag}`);
      post(errorMsg(r.text));
      return;
    }
    let res: GitDiffResult;
    try {
      res = await deps.openGitDiff(r.path);
    } catch (e) {
      log(`openDiff root=${rootTag(msg.rootId)} failed (${errTag(e)})`);
      post(errorMsg(TEXT.diffFailed));
      return;
    }
    if (res.ok) {
      log(`openDiff root=${rootTag(msg.rootId)} ok`);
      return;
    }
    log(`openDiff root=${rootTag(msg.rootId)} refused ${res.reason}`);
    post(errorMsg(gitText(res.reason)));
  }

  async function onOpenConfigFile(msg: Extract<OfficeRequestMessage, { type: 'openConfigFile' }>): Promise<void> {
    const file = registry.pathFor(msg.fileId);
    if (file === undefined) {
      log(`openConfigFile id=${msg.fileId} refused unknown`);
      post(errorMsg(TEXT.noFile));
      return;
    }
    const kind = await deps.statKind(file);
    if (kind !== 'file') {
      log(`openConfigFile id=${msg.fileId} refused ${kind === undefined ? 'missing' : 'notFile'}`);
      post(errorMsg(kind === undefined ? TEXT.noFile : fileRoomErrorText('notFile')));
      return;
    }
    try {
      await deps.openInEditor(file);
      log(`openConfigFile id=${msg.fileId} ok`);
    } catch (e) {
      log(`openConfigFile id=${msg.fileId} failed (${errTag(e)})`);
      post(errorMsg(TEXT.openFailed));
    }
  }

  // ---- Catalog --------------------------------------------------------------------------------------------------

  /** The project folder (real path) a catalog is about: the root asked for, else the first workspace folder, else the neutral folder. */
  async function catalogCwd(rootId: string | undefined): Promise<{ ok: true; cwd: string } | { ok: false; text: string }> {
    if (rootId !== undefined) {
      const r = await deps.room.resolve(rootId, '');
      return r.ok ? { ok: true, cwd: r.path } : { ok: false, text: fileRoomErrorText(r.error) };
    }
    const ws = deps.room.getRoots().find((r) => r.kind === 'workspace');
    if (ws !== undefined) {
      const r = await deps.room.resolve(ws.rootId, '');
      if (r.ok) return { ok: true, cwd: r.path };
    }
    return { ok: true, cwd: deps.neutralCwd() };
  }

  /** True when `cwd` (a real path) lies inside one of the workspace folders: the only folders VS Code's trust covers. */
  async function insideWorkspace(cwd: string): Promise<boolean> {
    for (const folder of safeFolders()) {
      let real = folder;
      try {
        real = await realpath(folder);
      } catch {
        // A folder that cannot be resolved is compared as written.
      }
      if (isInsideDir(cwd, real)) return true;
    }
    return false;
  }

  function sendCatalog(reqId: string, body: CatalogReply): void {
    post({ type: 'catalog', reqId, ...body });
  }

  function remember(key: string, body: CatalogReply): void {
    catalogCache.delete(key);
    catalogCache.set(key, body);
    while (catalogCache.size > MAX_CATALOG_CACHE) {
      const oldest = catalogCache.keys().next();
      if (oldest.done === true) break;
      catalogCache.delete(oldest.value);
    }
  }

  async function onGetCatalog(msg: Extract<OfficeRequestMessage, { type: 'getCatalog' }>, force: boolean): Promise<void> {
    await rootsSettled();
    const target = await catalogCwd(msg.rootId);
    if (!target.ok) {
      log(`getCatalog req=${msg.reqId} section=${msg.section} refused`);
      post(errorMsg(target.text, msg.reqId));
      return;
    }
    const cwd = target.cwd;
    const key = `${msg.section}\u0000${cwd}`;
    const running = flights.get(key);
    if (running !== undefined) {
      running.reqIds.add(msg.reqId);
      if (running.last !== undefined) sendCatalog(msg.reqId, running.last);
      return running.done;
    }
    // A hidden office starts no probe: answer from what was last sent, or say so. The handbook reads files only.
    if (!visible && msg.section !== 'handbook') {
      const cached = catalogCache.get(key);
      log(`getCatalog req=${msg.reqId} section=${msg.section} hidden ${cached === undefined ? 'no cache' : 'from cache'}`);
      if (cached !== undefined) sendCatalog(msg.reqId, cached);
      else post(errorMsg(TEXT.hidden, msg.reqId));
      return;
    }
    const flight: Flight = { reqIds: new Set([msg.reqId]), done: Promise.resolve() };
    flight.done = runCatalog(msg, cwd, key, flight, force).finally(() => {
      flights.delete(key);
    });
    flights.set(key, flight);
    return flight.done;
  }

  async function runCatalog(msg: Extract<OfficeRequestMessage, { type: 'getCatalog' }>, cwd: string, key: string, flight: Flight, force: boolean): Promise<void> {
    const started = now();
    const emit = (body: CatalogReply): void => {
      flight.last = body;
      remember(key, body);
      for (const id of flight.reqIds) sendCatalog(id, body);
    };
    const section: CatalogSection = msg.section;
    try {
      if (section === 'handbook') {
        const h = await readHandbook({ cwd, home, configDir, fs, fileIdFor });
        emit({
          section: 'handbook',
          instructions: h.instructions,
          ...(h.memoryIndex === undefined ? {} : { memoryIndex: h.memoryIndex }),
          memory: h.memory,
          rules: h.rules,
          truncated: h.truncated,
        });
        log(`getCatalog req=${msg.reqId} section=handbook files=${h.instructions.length} memory=${h.memory.length} rules=${h.rules.length} ${now() - started} ms`);
        return;
      }

      // Everything else needs both trust answers. Claude's comes from `.claude.json` through the MCP reader (the same
      // read the phone needs); only `approval.trustAccepted` leaves this scope, never `hostOnly`.
      const snapshot = await readMcpConfig({ cwd, env, home, fs });
      const trust: McpTrust = { workspaceTrusted: deps.workspaceTrusted() === true && (await insideWorkspace(cwd)), claudeTrusted: snapshot.approval.trustAccepted === true };
      const trustTag = `ws=${trust.workspaceTrusted ? 1 : 0} claude=${trust.claudeTrusted ? 1 : 0}`;

      if (section === 'mcp') {
        // First paint: the offline list (no server was started). Then each reading of the live probe, same reqId.
        const offline = buildMcpItems({ snapshot, trust });
        emit({ section: 'mcp', servers: offline.servers, truncated: offline.truncated });
        let updates = 0;
        const res = await deps.probe.probeMcpStatus(
          cwd,
          trust,
          snapshot,
          (u) => {
            updates++;
            emit({ section: 'mcp', servers: u.servers, truncated: u.truncated });
          },
          { force },
        );
        log(`getCatalog req=${msg.reqId} section=mcp ${trustTag} probe=${res.status}${res.status === 'failed' ? ` (${res.reason})` : ''} updates=${updates} servers=${res.servers.length} ${now() - started} ms`);
        return;
      }

      const probe = await safeProbeCatalog(cwd, trust, force);
      const sdk = probe.status === 'ok' ? probe : undefined;
      if (section === 'skills') {
        const usage = await readSkillUsage(claudeConfigJsonPath(env, home), fs);
        const cat = await readSkillsCatalog({
          cwd,
          home,
          configDir,
          fs,
          skillUsage: usage,
          fileIdFor,
          ...(sdk?.commands === undefined ? {} : { sdkCommands: sdk.commands }),
          ...(sdk === undefined ? {} : { projectLoaded: sdk.projectLoaded }),
        });
        emit({ section: 'skills', skills: cat.skills, commands: cat.commands, truncated: cat.truncated });
        log(`getCatalog req=${msg.reqId} section=skills ${trustTag} probe=${probe.status}${sdk === undefined ? '' : ` project=${sdk.projectLoaded ? 'loaded' : 'scanned'}`} skills=${cat.skills.length} commands=${cat.commands.length} ${now() - started} ms`);
      } else {
        const cat = await readAgentsCatalog({
          cwd,
          home,
          configDir,
          fs,
          fileIdFor,
          ...(sdk?.agents === undefined ? {} : { sdkAgents: sdk.agents }),
          ...(sdk === undefined ? {} : { projectLoaded: sdk.projectLoaded }),
        });
        emit({ section: 'agents', agents: cat.agents, truncated: cat.truncated });
        log(`getCatalog req=${msg.reqId} section=agents ${trustTag} probe=${probe.status}${sdk === undefined ? '' : ` project=${sdk.projectLoaded ? 'loaded' : 'scanned'}`} agents=${cat.agents.length} ${now() - started} ms`);
      }
    } catch (e) {
      log(`getCatalog req=${msg.reqId} section=${section} failed (${errTag(e)})`);
      for (const id of flight.reqIds) post(errorMsg(TEXT.catalogFailed, id));
    }
  }

  /** The catalog probe, with its failure (or a throw it promised not to make) turned into a `failed` result: the caller falls back to the disk scan. */
  async function safeProbeCatalog(cwd: string, trust: McpTrust, force: boolean): ReturnType<CatalogProbeLike['probeCatalog']> {
    try {
      return await deps.probe.probeCatalog(cwd, trust, { force });
    } catch (e) {
      log(`catalog probe threw (${errTag(e)})`);
      return { status: 'failed', reason: 'probe error' };
    }
  }

  // ---- Entry points ---------------------------------------------------------------------------------------------

  function handles(msg: WebviewToHost): msg is OfficeRequestMessage {
    return (OFFICE_REQUEST_TYPES as readonly string[]).includes(msg.type);
  }

  async function handle(msg: WebviewToHost, opts: OfficeRequestOptions = {}): Promise<void> {
    if (!handles(msg) || disposed) return;
    try {
      switch (msg.type) {
        case 'getFileRoots': {
          const roots = await refreshRoots();
          post({ type: 'fileRoots', roots, reqId: msg.reqId });
          log(`getFileRoots req=${msg.reqId} roots=${roots.length}`);
          return;
        }
        case 'listDir': return await onListDir(msg);
        case 'readFile': return await onReadFile(msg);
        case 'openFile': return await onOpenFile(msg);
        case 'openDiff': return await onOpenDiff(msg);
        case 'getCatalog': return await onGetCatalog(msg, opts.force === true);
        case 'openConfigFile': return await onOpenConfigFile(msg);
      }
    } catch (e) {
      log(`${msg.type} failed (${errTag(e)})`);
      post(errorMsg(TEXT.generic, 'reqId' in msg ? msg.reqId : undefined));
    }
  }

  return {
    handles,
    handle,
    setVisible(v: boolean): void {
      visible = v;
      if (v && pushPending && deps.isDemo?.() !== true) {
        const roots = deps.room.getRoots();
        pushPending = false;
        post({ type: 'fileRoots', roots });
      }
    },
    setAgentCwds(cwds): void {
      const next = cleanPaths(cwds, MAX_AGENT_ROOTS);
      if (next.length === agentCwds.length && next.every((p, i) => p === agentCwds[i])) return;
      agentCwds = next;
      startRefresh();
    },
    setProjects(projects): void {
      const next = cleanPaths(
        projects.filter((p) => p.source === 'browsed' && p.exists).map((p) => p.path),
        MAX_PROJECT_ROOTS,
      );
      if (next.length === projectPaths.length && next.every((p, i) => p === projectPaths[i])) return;
      projectPaths = next;
      startRefresh();
    },
    refreshRoots,
    dispose(): void {
      disposed = true;
      flights.clear();
      catalogCache.clear();
    },
  };
}
