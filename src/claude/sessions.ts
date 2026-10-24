import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInsideDir, projectDirName, projectsDir, sessionsDir } from './paths.ts';
import { JsonlTailer } from './tailer.ts';
import type {
  LiveStatus,
  RecordBatch,
  SessionInfo,
  SubagentInfo,
  SubagentMeta,
  WatchUpdate,
} from './types.ts';

export interface ClaudeWatcherOptions {
  claudeHome: string;
  scope: 'all' | { workspaceDirs: string[] };
  /** A transcript counts as active when written within this many ms. Default 30 minutes. */
  activeWindowMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** Minimum gap between full directory scans. Default 5000 ms. */
  scanIntervalMs?: number;
}

export const DEFAULT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_SCAN_INTERVAL_MS = 5000;

/** The only files in `sessions/` that may be opened. The `<pid>.<hex>.key` files next to them are secrets. */
const LIVE_STATUS_FILE = /^\d+\.json$/;
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;
const HEAD_BYTES = 64 * 1024;

export function isLiveStatusFileName(name: string): boolean {
  return LIVE_STATUS_FILE.test(name);
}

/**
 * `CLAUDE_CODE_ENTRYPOINT` of the usage probe (`PROBE_ENTRYPOINT_TAG` in manager/usageProbe.ts; a test keeps the two equal,
 * because claude/ must not import from manager/). The probe's `<pid>.json` is visible for a second or two and must never
 * show up as a session or a worker, so `parseLiveStatus` drops files that carry it.
 */
export const PROBE_ENTRYPOINT = 'claude-office-probe';

/** `process.kill(pid, 0)`: true if the process exists (EPERM means it exists but belongs to someone else). */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface IndexEntry {
  sessionId: string;
  path: string;
  projectDir: string;
  mtimeMs: number;
}

interface LiveEntry {
  sessionId: string;
  cwd?: string;
  pid: number;
  status: string;
  name?: string;
  statusUpdatedAt?: number;
  alive: boolean;
}

interface LiveCacheItem {
  mtimeMs: number;
  size: number;
  parsed: Omit<LiveEntry, 'alive'> | null;
}

interface SubFile {
  agentId: string;
  path: string;
  metaPath: string;
  mtimeMs: number;
  metaMtimeMs: number;
  meta?: SubagentMeta;
  /** Present while the subagent transcript is being tailed. */
  tailer?: JsonlTailer;
}

interface SessionState {
  sessionId: string;
  transcriptPath: string;
  projectDir: string;
  mtimeMs: number;
  tailer: JsonlTailer;
  cwd?: string;
  subDir: string;
  subFiles: Map<string, SubFile>;
  subDirMtimeMs: number;
  subListedAt: number;
}

export class ClaudeWatcher {
  readonly #home: string;
  readonly #scope: ClaudeWatcherOptions['scope'];
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #isPidAlive: (pid: number) => boolean;
  readonly #scanIntervalMs: number;

  #index = new Map<string, IndexEntry>();
  #lastScanAt = Number.NEGATIVE_INFINITY;
  #tracked = new Map<string, SessionState>();
  #liveCache = new Map<string, LiveCacheItem>();
  #headCwd = new Map<string, string>();
  #headMiss = new Map<string, number>();

  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #errorCount = 0;
  #lastError: unknown;

  constructor(options: ClaudeWatcherOptions) {
    this.#home = options.claudeHome;
    this.#scope = options.scope;
    this.#windowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    this.#isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.#scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  }

  /** Number of errors swallowed so far (by `poll` internals and by `start`). */
  get errorCount(): number {
    return this.#errorCount;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  /** Runs `poll` repeatedly, `intervalMs` after each poll finishes, so polls never overlap. Errors are counted, not thrown. */
  start(intervalMs: number, onUpdate: (u: WatchUpdate) => void): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async (): Promise<void> => {
      try {
        const update = await this.poll();
        if (!this.#running) return;
        onUpdate(update);
      } catch (e) {
        this.#noteError(e);
      }
      if (this.#running) this.#timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async poll(): Promise<WatchUpdate> {
    const now = this.#now();
    const live = await this.#guard(() => this.#readLive(), new Map<string, LiveEntry>());
    await this.#guard(() => this.#maybeScan(now), undefined);
    await this.#guard(() => this.#refreshTracked(live), undefined);
    await this.#guard(() => this.#addLiveOnly(live), undefined);

    // Decide which sessions are relevant right now.
    const wanted: IndexEntry[] = [];
    for (const entry of this.#index.values()) {
      const l = live.get(entry.sessionId);
      const active = now - entry.mtimeMs <= this.#windowMs || l?.alive === true;
      if (!active) continue;
      if (!(await this.#guard(() => this.#inScope(entry, l), false))) continue;
      wanted.push(entry);
    }
    const wantedIds = new Set(wanted.map((e) => e.sessionId));
    for (const id of [...this.#tracked.keys()]) {
      if (!wantedIds.has(id)) this.#tracked.delete(id);
    }
    for (const entry of wanted) {
      if (this.#tracked.has(entry.sessionId)) continue;
      const subDir = path.join(entry.projectDir, entry.sessionId, 'subagents');
      this.#tracked.set(entry.sessionId, {
        sessionId: entry.sessionId,
        transcriptPath: entry.path,
        projectDir: entry.projectDir,
        mtimeMs: entry.mtimeMs,
        tailer: new JsonlTailer(entry.path),
        cwd: this.#headCwd.get(entry.sessionId),
        subDir,
        subFiles: new Map(),
        subDirMtimeMs: -1,
        subListedAt: Number.NEGATIVE_INFINITY,
      });
    }

    const states = [...this.#tracked.values()];
    const results = await Promise.all(
      states.map((s) => this.#guard(() => this.#updateSession(s, now), { batches: [] as RecordBatch[] })),
    );

    const sessions: SessionInfo[] = [];
    const batches: RecordBatch[] = [];
    states.forEach((s, i) => {
      batches.push(...(results[i]?.batches ?? []));
      const l = live.get(s.sessionId);
      const subagents: SubagentInfo[] = [];
      for (const f of s.subFiles.values()) {
        if (!f.tailer) continue;
        const info: SubagentInfo = { agentId: f.agentId, path: f.path, mtimeMs: f.mtimeMs };
        if (f.meta) info.meta = f.meta;
        subagents.push(info);
      }
      const info: SessionInfo = {
        sessionId: s.sessionId,
        transcriptPath: s.transcriptPath,
        projectDir: s.projectDir,
        mtimeMs: s.mtimeMs,
        subagents,
      };
      const cwd = l?.cwd ?? s.cwd;
      if (cwd !== undefined) info.cwd = cwd;
      if (l) info.live = toLiveStatus(l);
      sessions.push(info);
    });
    return { sessions, batches };
  }

  // --- error handling -----------------------------------------------------------------------

  #noteError(e: unknown): void {
    this.#errorCount++;
    this.#lastError = e;
  }

  async #guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.#noteError(e);
      return fallback;
    }
  }

  // --- live status files --------------------------------------------------------------------

  async #readLive(): Promise<Map<string, LiveEntry>> {
    const dir = sessionsDir(this.#home);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (e) {
      if (isMissing(e)) {
        this.#liveCache.clear();
        return new Map();
      }
      throw e;
    }
    const wanted = names.filter(isLiveStatusFileName);
    const present = new Set(wanted);
    for (const key of [...this.#liveCache.keys()]) {
      if (!present.has(key)) this.#liveCache.delete(key);
    }

    const bySession = new Map<string, LiveEntry>();
    for (const name of wanted) {
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch (e) {
        if (isMissing(e)) continue;
        throw e;
      }
      let item = this.#liveCache.get(name);
      if (!item || item.mtimeMs !== st.mtimeMs || item.size !== st.size) {
        let parsed: LiveCacheItem['parsed'] = null;
        try {
          parsed = parseLiveStatus(await fs.promises.readFile(file, 'utf8'), name);
        } catch (e) {
          if (!isMissing(e)) this.#noteError(e);
        }
        item = { mtimeMs: st.mtimeMs, size: st.size, parsed };
        this.#liveCache.set(name, item);
      }
      if (!item.parsed) continue;
      let alive = false;
      try {
        alive = this.#isPidAlive(item.parsed.pid);
      } catch {
        alive = false;
      }
      const entry: LiveEntry = { ...item.parsed, alive };
      const prev = bySession.get(entry.sessionId);
      if (!prev || preferLive(entry, prev)) bySession.set(entry.sessionId, entry);
    }
    return bySession;
  }

  // --- transcript index ---------------------------------------------------------------------

  async #maybeScan(now: number): Promise<void> {
    if (now - this.#lastScanAt < this.#scanIntervalMs) return;
    this.#lastScanAt = now;
    const fresh = new Map<string, IndexEntry>();
    const root = projectsDir(this.#home);
    let dirs: fs.Dirent[];
    try {
      dirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (e) {
      if (!isMissing(e)) throw e;
      dirs = [];
    }
    await Promise.all(
      dirs
        .filter((d) => d.isDirectory())
        .map(async (d) => {
          const projectDir = path.join(root, d.name);
          let files: fs.Dirent[];
          try {
            files = await fs.promises.readdir(projectDir, { withFileTypes: true });
          } catch (e) {
            if (!isMissing(e)) this.#noteError(e);
            return;
          }
          await Promise.all(
            files
              .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
              .map(async (f) => {
                const file = path.join(projectDir, f.name);
                try {
                  const st = await fs.promises.stat(file);
                  const sessionId = f.name.slice(0, -'.jsonl'.length);
                  const entry: IndexEntry = { sessionId, path: file, projectDir, mtimeMs: st.mtimeMs };
                  const prev = fresh.get(sessionId);
                  if (!prev || prev.mtimeMs < entry.mtimeMs) fresh.set(sessionId, entry);
                } catch (e) {
                  if (!isMissing(e)) this.#noteError(e);
                }
              }),
          );
        }),
    );
    this.#index = fresh;
    for (const id of [...this.#headCwd.keys()]) if (!fresh.has(id)) this.#headCwd.delete(id);
    for (const id of [...this.#headMiss.keys()]) if (!fresh.has(id)) this.#headMiss.delete(id);
  }

  /** Between scans: stat only the transcripts we already follow, so their mtime stays current. */
  async #refreshTracked(live: Map<string, LiveEntry>): Promise<void> {
    void live;
    for (const s of this.#tracked.values()) {
      const entry = this.#index.get(s.sessionId);
      try {
        const st = await fs.promises.stat(s.transcriptPath);
        if (entry) entry.mtimeMs = st.mtimeMs;
      } catch (e) {
        if (!isMissing(e)) throw e;
        this.#index.delete(s.sessionId);
      }
    }
  }

  /** A live session whose transcript the last scan did not see yet: look for it at the path its cwd implies. */
  async #addLiveOnly(live: Map<string, LiveEntry>): Promise<void> {
    for (const l of live.values()) {
      if (!l.alive || this.#index.has(l.sessionId) || l.cwd === undefined) continue;
      const projectDir = path.join(projectsDir(this.#home), projectDirName(l.cwd));
      const file = path.join(projectDir, l.sessionId + '.jsonl');
      try {
        const st = await fs.promises.stat(file);
        this.#index.set(l.sessionId, { sessionId: l.sessionId, path: file, projectDir, mtimeMs: st.mtimeMs });
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
  }

  // --- scope --------------------------------------------------------------------------------

  async #inScope(entry: IndexEntry, live: LiveEntry | undefined): Promise<boolean> {
    if (this.#scope === 'all') return true;
    const dirs = this.#scope.workspaceDirs;
    if (dirs.length === 0) return false;
    const ci = process.platform === 'win32';
    const folder = path.basename(entry.projectDir);
    for (const d of dirs) {
      const encoded = projectDirName(d);
      if (folder === encoded || (ci && folder.toLowerCase() === encoded.toLowerCase())) return true;
    }
    const inside = (cwd: string): boolean => dirs.some((d) => isInsideDir(cwd, d));
    if (live?.cwd !== undefined) return inside(live.cwd);
    const known = this.#tracked.get(entry.sessionId)?.cwd ?? this.#headCwd.get(entry.sessionId);
    if (known !== undefined) return inside(known);
    if (this.#headMiss.get(entry.sessionId) === entry.mtimeMs) return false;
    const found = await readCwdFromHead(entry.path);
    if (found === undefined) {
      this.#headMiss.set(entry.sessionId, entry.mtimeMs);
      return false;
    }
    this.#headCwd.set(entry.sessionId, found);
    return inside(found);
  }

  // --- per-session work ---------------------------------------------------------------------

  async #updateSession(s: SessionState, now: number): Promise<{ batches: RecordBatch[] }> {
    const batches: RecordBatch[] = [];
    const main = await s.tailer.read();
    if (s.tailer.mtimeMs > 0) s.mtimeMs = s.tailer.mtimeMs;
    if (main.reset || main.records.length > 0) {
      batches.push({ sessionId: s.sessionId, reset: main.reset, records: main.records });
      if (s.cwd === undefined) s.cwd = firstCwd(main.records);
    }

    await this.#guard(() => this.#updateSubagentFiles(s, now), undefined);
    const tailed = [...s.subFiles.values()].filter((f) => f.tailer);
    const subResults = await Promise.all(
      tailed.map((f) =>
        this.#guard(async () => {
          const r = await f.tailer!.read();
          if (f.tailer!.mtimeMs > 0) f.mtimeMs = f.tailer!.mtimeMs;
          return r;
        }, null),
      ),
    );
    tailed.forEach((f, i) => {
      const r = subResults[i];
      if (r && (r.reset || r.records.length > 0)) {
        batches.push({ sessionId: s.sessionId, agentId: f.agentId, reset: r.reset, records: r.records });
      }
    });
    return { batches };
  }

  async #updateSubagentFiles(s: SessionState, now: number): Promise<void> {
    let listNow = now - s.subListedAt >= this.#scanIntervalMs;
    if (!listNow) {
      try {
        const st = await fs.promises.stat(s.subDir);
        if (st.mtimeMs !== s.subDirMtimeMs) listNow = true;
      } catch {
        // Handled by the listing below on the next scan.
      }
    }

    if (listNow) {
      s.subListedAt = now;
      let names: string[] = [];
      try {
        const dst = await fs.promises.stat(s.subDir);
        s.subDirMtimeMs = dst.mtimeMs;
        const dirents = await fs.promises.readdir(s.subDir, { withFileTypes: true });
        names = dirents.filter((d) => d.isFile() && SUBAGENT_FILE.test(d.name)).map((d) => d.name);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      const seen = new Set<string>();
      for (const name of names) {
        const agentId = SUBAGENT_FILE.exec(name)?.[1];
        if (agentId === undefined) continue;
        seen.add(agentId);
        if (!s.subFiles.has(agentId)) {
          s.subFiles.set(agentId, {
            agentId,
            path: path.join(s.subDir, name),
            metaPath: path.join(s.subDir, `agent-${agentId}.meta.json`),
            mtimeMs: 0,
            metaMtimeMs: -1,
          });
        }
      }
      for (const id of [...s.subFiles.keys()]) if (!seen.has(id)) s.subFiles.delete(id);
      await Promise.all([...s.subFiles.values()].map((f) => this.#refreshSubFile(f)));
    } else {
      await Promise.all(
        [...s.subFiles.values()].filter((f) => f.tailer).map((f) => this.#refreshSubFile(f)),
      );
    }

    for (const f of s.subFiles.values()) {
      const active = now - f.mtimeMs <= this.#windowMs || f.meta?.finished === false;
      if (active && !f.tailer) f.tailer = new JsonlTailer(f.path);
      else if (!active && f.tailer) f.tailer = undefined;
    }
  }

  async #refreshSubFile(f: SubFile): Promise<void> {
    try {
      const st = await fs.promises.stat(f.path);
      f.mtimeMs = st.mtimeMs;
    } catch (e) {
      if (!isMissing(e)) this.#noteError(e);
      return;
    }
    try {
      const mst = await fs.promises.stat(f.metaPath);
      if (mst.mtimeMs !== f.metaMtimeMs) {
        f.metaMtimeMs = mst.mtimeMs;
        f.meta = parseMeta(await fs.promises.readFile(f.metaPath, 'utf8'));
      }
    } catch (e) {
      if (isMissing(e)) {
        f.meta = undefined;
        f.metaMtimeMs = -1;
      } else {
        this.#noteError(e);
      }
    }
  }
}

// --- helpers ----------------------------------------------------------------------------------

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function toLiveStatus(l: LiveEntry): LiveStatus {
  const out: LiveStatus = { pid: l.pid, alive: l.alive, status: l.status };
  if (l.name !== undefined) out.name = l.name;
  if (l.statusUpdatedAt !== undefined) out.statusUpdatedAt = l.statusUpdatedAt;
  return out;
}

/** When several pid files name the same session: a running one beats a stale one, then the newest update wins. */
function preferLive(a: LiveEntry, b: LiveEntry): boolean {
  if (a.alive !== b.alive) return a.alive;
  return (a.statusUpdatedAt ?? 0) > (b.statusUpdatedAt ?? 0);
}

function parseLiveStatus(text: string, fileName: string): Omit<LiveEntry, 'alive'> | null {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['entrypoint'] === PROBE_ENTRYPOINT) return null; // the usage probe: never a session
  const sessionId = o['sessionId'];
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const filePid = Number.parseInt(fileName, 10);
  const pid = typeof o['pid'] === 'number' && Number.isInteger(o['pid']) ? o['pid'] : filePid;
  const out: Omit<LiveEntry, 'alive'> = {
    sessionId,
    pid,
    status: typeof o['status'] === 'string' ? o['status'] : 'unknown',
  };
  if (typeof o['cwd'] === 'string' && o['cwd'] !== '') out.cwd = o['cwd'];
  if (typeof o['name'] === 'string') out.name = o['name'];
  if (typeof o['statusUpdatedAt'] === 'number') out.statusUpdatedAt = o['statusUpdatedAt'];
  return out;
}

function parseMeta(text: string): SubagentMeta | undefined {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const meta: SubagentMeta = {};
  if (typeof o['agentType'] === 'string') meta.agentType = o['agentType'];
  if (typeof o['description'] === 'string') meta.description = o['description'];
  if (typeof o['toolUseId'] === 'string') meta.toolUseId = o['toolUseId'];
  if (typeof o['finished'] === 'boolean') meta.finished = o['finished'];
  return meta;
}

function firstCwd(records: unknown[]): string | undefined {
  for (const r of records) {
    if (typeof r !== 'object' || r === null) continue;
    const cwd = (r as Record<string, unknown>)['cwd'];
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return undefined;
}

/** Reads the first 64 KB of a transcript and returns the first `cwd` it finds. Never reads more. */
async function readCwdFromHead(file: string): Promise<string | undefined> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const data = buf.subarray(0, bytesRead);
    const lastNl = data.lastIndexOf(0x0a);
    const text = data.toString('utf8', 0, lastNl < 0 ? 0 : lastNl);
    const records: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return firstCwd(records);
  } finally {
    await fh.close();
  }
}
