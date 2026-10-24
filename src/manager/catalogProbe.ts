// The catalog probe: asks Claude Code for the skills, commands and subagent types (`supportedCommands()`,
// `supportedAgents()`) and for the live status of MCP servers (`mcpServerStatus()`) WITHOUT sending a prompt, so it costs no
// tokens and writes no transcript (docs/sdk-spike.md section 15). Same shape as the usage probe: a throwaway query whose
// input never yields, `persistSession: false`, the `claude-office-probe` entrypoint, always closed.
//
// Safety rules (the reason this module is not just the spike):
// - A probe started in a project folder launched that project's `.mcp.json` servers with no approval (spike 15e.7), and
//   would run the project's settings and hooks. So:
//   * Both probes use `strictMcpConfig: true`. The catalog probe passes `mcpServers: {}`: NO MCP server is ever started.
//   * Project settings are loaded (`settingSources: ['user','project','local']`, cwd = the project) only when BOTH
//     VS Code's workspace trust and Claude Code's `hasTrustDialogAccepted` for the folder are true. Otherwise the probe runs
//     in a neutral folder with `settingSources: ['user']`.
//   * Hooks are switched off for the probe (`settings: { disableAllHooks: true }`): a catalog needs none, and a project's
//     SessionStart hook would otherwise run at start-up.
//   * The MCP probe starts only the servers `selectServersToStart` allows: user, local and managed servers, and project
//     `.mcp.json` servers only when both trust flags are true and Claude Code's approval rules pass.
// - `permissionMode` is `default` and never `bypassPermissions`; no tools; no prompt is ever sent.
// - Everything that leaves goes through whitelisting: MCP rows through `parseMcpLiveStatuses` / `buildMcpItems`
//   (name, scope, transport, status, tool count), commands and agents as the SDK's plain lists. Failure reasons are fixed
//   phrases. Logs carry probe numbers, counts and timings only: never names, paths, configs or SDK text.
// No `vscode` import; the SDK function, the clock, the timers and the process table are injected.
import os from 'node:os';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerItem } from '../shared/protocol.ts';
import { bothTrusted, buildMcpItems, parseMcpLiveStatuses, selectServersToStart } from '../claude/mcpConfig.ts';
import type { McpLiveRow, McpSnapshot, McpTrust } from '../claude/mcpConfig.ts';
import { InputQueue, UnsupportedControlError, buildRunnerEnv, describeRunnerError } from './sessionRunner.ts';
import type { QueryFn, SdkQuery } from './sessionRunner.ts';
import { PROBE_ENTRYPOINT_TAG } from './usageProbe.ts';

export { PROBE_ENTRYPOINT_TAG };

/** The two trust answers: `vscode.workspace.isTrusted` and the folder's `hasTrustDialogAccepted` (`McpSnapshot.approval.trustAccepted`). */
export type ProbeTrust = McpTrust;

/** The catalog probe gives up after this long. */
export const CATALOG_TIMEOUT_MS = 15_000;
/** The MCP probe gives up after this long (the polling itself stops at `MCP_POLL_MAX_MS`). */
export const MCP_TIMEOUT_MS = 20_000;
/** A catalog result is reused for this long. */
export const CATALOG_CACHE_TTL_MS = 60_000;
/** An MCP result is reused for this long. */
export const MCP_CACHE_TTL_MS = 30_000;
/** `mcpServerStatus()` is read this often while any server is `pending`. */
export const MCP_POLL_MS = 500;
/** Polling stops after this long; what is still `pending` stays `pending`. */
export const MCP_POLL_MAX_MS = 8_000;

const MAX_LIST = 2000;
/** How long a closed probe process gets to exit before it is killed. */
const REAP_GRACE_MS = 1_000;
const REAP_STEP_MS = 100;

/** Just enough of `process.kill` to check on and stop a child. Tests inject a fake. */
export interface ProcessControl {
  isAlive(pid: number): boolean;
  kill(pid: number, signal: 'SIGKILL'): void;
}

const nodeProcessControl: ProcessControl = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: unknown } | null)?.code === 'EPERM';
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  },
};

export interface CatalogProbeDeps {
  /** The SDK's `query` (wired in `index.ts`; tests pass a fake). */
  queryFn: QueryFn;
  /** Path of the Claude Code binary. */
  binaryPath: string;
  /** Environment to derive the child's from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** The folder an untrusted probe runs in (default: the home folder). Give an empty scratch folder to be stricter. */
  neutralCwd?: string;
  now?: () => number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  /** Receives probe numbers, counts, states and timings only. */
  log?: (msg: string) => void;
  processes?: ProcessControl;
  catalogTimeoutMs?: number;
  mcpTimeoutMs?: number;
  catalogTtlMs?: number;
  mcpTtlMs?: number;
  pollMs?: number;
  pollMaxMs?: number;
}

export type CatalogProbeResult =
  | {
      status: 'ok';
      /** `supportedCommands()` rows (skills and commands), as the SDK sent them; absent when the build has no such call. */
      commands?: unknown[];
      /** `supportedAgents()` rows; absent when the build has no such call. */
      agents?: unknown[];
      /**
       * True when the project's own settings, skills, commands and agents were loaded (both trust flags true). When false the
       * lists hold user, plugin and built-in items only, so the caller should add the project's items from its folder scan.
       */
      projectLoaded: boolean;
      /** Epoch ms when the probe finished. A cached result keeps its first time. */
      at: number;
      elapsedMs: number;
      cached: boolean;
    }
  /** Anything that went wrong. `reason` is a short fixed phrase with no values. */
  | { status: 'failed'; reason: string };

/** One reading of the phone's list. */
export interface McpProbeUpdate {
  servers: McpServerItem[];
  truncated: boolean;
  /** No server is `pending` any more and every started server has reported. */
  settled: boolean;
}

export type McpProbeResult =
  | (McpProbeUpdate & { status: 'ok'; at: number; elapsedMs: number; cached: boolean })
  /** The probe failed: `servers` is the offline list (statuses `unknown`, `disabled` for blocked project servers). */
  | (McpProbeUpdate & { status: 'failed'; reason: string });

export interface ProbeCallOptions {
  /** Skip the cache (the user asked for a refresh). A running probe is still shared. */
  force?: boolean;
}

export interface CatalogProbe {
  /**
   * Skills, commands and subagent types for `cwd`. No MCP server is started. Single-flight and cached per folder (and per
   * trust mode). Never throws.
   */
  probeCatalog(cwd: string, trust: ProbeTrust, opts?: ProbeCallOptions): Promise<CatalogProbeResult>;
  /**
   * Live MCP status for the servers `snapshot` allows to start (see `selectServersToStart`). Emits each reading to `onUpdate`
   * (the first one as soon as the probe answers, with servers still `pending`), then resolves with the last. Single-flight and
   * cached per folder, trust mode and server set; a second caller joins the running probe and gets its updates too. Never throws.
   */
  probeMcpStatus(cwd: string, trust: ProbeTrust, snapshot: McpSnapshot, onUpdate?: (u: McpProbeUpdate) => void, opts?: ProbeCallOptions): Promise<McpProbeResult>;
  /** Forget cached results (all, or those of one folder plus the untrusted ones). Running probes are not affected. */
  clearCache(cwd?: string): void;
}

class ProbeTimeout extends Error {
  constructor() {
    super('probe timed out');
    this.name = 'ProbeTimeout';
  }
}

class ProbeEndedEarly extends Error {
  constructor() {
    super('probe ended early');
    this.name = 'ProbeEndedEarly';
  }
}

/** A fixed, value-free phrase for a failure. */
function reasonOf(e: unknown): string {
  if (e instanceof UnsupportedControlError) return 'this Claude Code version cannot list that';
  if (e instanceof ProbeTimeout) return 'timed out';
  if (e instanceof ProbeEndedEarly) return 'Claude Code stopped before answering';
  const d = describeRunnerError(e);
  if (d.kind === 'auth') return 'not signed in';
  if (d.kind === 'binary') return 'could not start Claude Code';
  if (d.kind === 'exit') return 'Claude Code exited unexpectedly';
  const name = e instanceof Error && /^[A-Za-z]{1,30}$/.test(e.name) ? e.name : 'Error';
  return `probe error (${name})`;
}

function listOf(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v.slice(0, MAX_LIST) : undefined;
}

interface Cached<T> {
  at: number;
  value: T;
}

interface Flight<T, L> {
  promise: Promise<T>;
  listeners: Set<L>;
  last?: McpProbeUpdate;
}

/** Create the probe. One instance owns the caches and the single-flight tables. */
export function createCatalogProbe(deps: CatalogProbeDeps): CatalogProbe {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const processes = deps.processes ?? nodeProcessControl;
  const neutralCwd = (): string => deps.neutralCwd ?? os.homedir();
  const catalogTtl = deps.catalogTtlMs ?? CATALOG_CACHE_TTL_MS;
  const mcpTtl = deps.mcpTtlMs ?? MCP_CACHE_TTL_MS;
  let counter = 0;

  const catalogCache = new Map<string, Cached<CatalogProbeResult & { status: 'ok' }>>();
  const catalogFlights = new Map<string, Flight<CatalogProbeResult, never>>();
  const mcpCache = new Map<string, Cached<{ rows: McpLiveRow[]; settled: boolean }>>();
  const mcpFlights = new Map<string, Flight<McpProbeResult, (u: McpProbeUpdate) => void>>();

  function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
    let handle: unknown;
    const promise = new Promise<void>((res) => {
      handle = timers.setTimeout(res, ms);
    });
    return { promise, cancel: () => timers.clearTimeout(handle) };
  }

  /**
   * Run `work` against one throwaway query. Starts it, drains its (empty) stream, races every step against the process dying
   * or the timeout, and always closes it and waits for the child to be gone before resolving. Never rejects.
   */
  async function withQuery<T>(
    id: number,
    kind: string,
    options: Pick<Options, 'cwd' | 'settingSources' | 'mcpServers'>,
    timeoutMs: number,
    work: (q: SdkQuery, race: <V>(p: Promise<V>) => Promise<V>, setPid: (raw: unknown) => void) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const input = new InputQueue(); // never pushed to: the probe has no prompt
    const abort = new AbortController();
    const env = buildRunnerEnv(deps.env ?? process.env);
    env['CLAUDE_CODE_ENTRYPOINT'] = PROBE_ENTRYPOINT_TAG;
    let q: SdkQuery;
    try {
      q = deps.queryFn({
        prompt: input,
        options: {
          ...options,
          pathToClaudeCodeExecutable: deps.binaryPath,
          model: 'haiku', // never used: no turn ever runs
          strictMcpConfig: true,
          tools: [],
          allowedTools: [],
          persistSession: false,
          permissionMode: 'default',
          settings: { disableAllHooks: true },
          abortController: abort,
          env,
          stderr: (s: string) => log(`probe#${id} stderr: ${s.length} chars`),
        },
      });
    } catch (e) {
      log(`${kind} probe#${id}: query() threw`);
      return { ok: false, reason: reasonOf(e) };
    }

    let rejectDead: (e: unknown) => void = () => {};
    const dead = new Promise<never>((_, rej) => {
      rejectDead = rej;
    });
    dead.catch(() => {}); // never an unhandled rejection
    let finished = false;
    let pid: number | undefined;
    const timer = timers.setTimeout(() => rejectDead(new ProbeTimeout()), timeoutMs);
    void (async () => {
      try {
        for await (const _ of q) {
          // A probe never expects a message; ignore it.
        }
        if (!finished) rejectDead(new ProbeEndedEarly());
      } catch (e) {
        if (!finished) rejectDead(e);
      }
    })();
    const race = <V>(p: Promise<V>): Promise<V> => Promise.race([p, dead]);
    const setPid = (raw: unknown): void => {
      const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['pid'] : undefined;
      if (typeof p === 'number' && Number.isInteger(p) && p > 1 && p !== process.pid) pid = p;
    };
    try {
      return { ok: true, value: await work(q, race, setPid) };
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    } finally {
      finished = true;
      timers.clearTimeout(timer);
      try {
        input.end();
      } catch {
        /* already ended */
      }
      try {
        abort.abort();
      } catch {
        /* already aborted */
      }
      try {
        q.close?.();
      } catch {
        /* already closed */
      }
      await reap(id, pid);
    }
  }

  /** After `close()`: wait a moment for the child to exit, then kill it if it did not. */
  async function reap(id: number, pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    try {
      for (let waited = 0; waited < REAP_GRACE_MS; waited += REAP_STEP_MS) {
        if (!processes.isAlive(pid)) return;
        const s = sleep(REAP_STEP_MS);
        await s.promise;
      }
      if (processes.isAlive(pid)) {
        processes.kill(pid, 'SIGKILL');
        log(`probe#${id}: child still running after close, killed`);
      }
    } catch {
      /* best effort */
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Catalog

  function probeCatalog(cwd: string, trust: ProbeTrust, opts: ProbeCallOptions = {}): Promise<CatalogProbeResult> {
    const withProject = bothTrusted(trust);
    // The key holds the folder only when the project is really used, so every untrusted folder shares one result.
    const key = withProject ? `p\u0000${cwd}` : 'n';
    const hit = catalogCache.get(key);
    if (hit !== undefined && opts.force !== true && now() - hit.at < catalogTtl) return Promise.resolve({ ...hit.value, cached: true });
    const running = catalogFlights.get(key);
    if (running !== undefined) return running.promise;

    const id = ++counter;
    const started = now();
    const run = async (): Promise<CatalogProbeResult> => {
      const r = await withQuery(
        id,
        'catalog',
        {
          cwd: withProject ? cwd : neutralCwd(),
          settingSources: withProject ? ['user', 'project', 'local'] : ['user'],
          mcpServers: {}, // with strictMcpConfig: no MCP server starts
        },
        deps.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS,
        async (q, race, setPid) => {
          if (typeof q.initializationResult === 'function') setPid(await race(q.initializationResult()));
          const out: { commands?: unknown[]; agents?: unknown[] } = {};
          let asked = 0;
          if (typeof q.supportedCommands === 'function') {
            asked++;
            const c = listOf(await race(q.supportedCommands()));
            if (c !== undefined) out.commands = c;
          }
          if (typeof q.supportedAgents === 'function') {
            asked++;
            const a = listOf(await race(q.supportedAgents()));
            if (a !== undefined) out.agents = a;
          }
          if (asked === 0) throw new UnsupportedControlError('supportedCommands');
          return out;
        },
      );
      if (!r.ok) {
        log(`catalog probe#${id}: failed (${r.reason})`);
        return { status: 'failed', reason: r.reason };
      }
      const at = now();
      const result: CatalogProbeResult & { status: 'ok' } = { status: 'ok', projectLoaded: withProject, at, elapsedMs: at - started, cached: false };
      if (r.value.commands !== undefined) result.commands = r.value.commands;
      if (r.value.agents !== undefined) result.agents = r.value.agents;
      catalogCache.set(key, { at, value: result });
      log(`catalog probe#${id}: ok in ${at - started} ms, ${r.value.commands?.length ?? 0} commands, ${r.value.agents?.length ?? 0} agents, project ${withProject ? 'loaded' : 'not loaded'}`);
      return result;
    };
    const promise = run().finally(() => {
      catalogFlights.delete(key);
    });
    catalogFlights.set(key, { promise, listeners: new Set() });
    return promise;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // MCP status

  function probeMcpStatus(cwd: string, trust: ProbeTrust, snapshot: McpSnapshot, onUpdate?: (u: McpProbeUpdate) => void, opts: ProbeCallOptions = {}): Promise<McpProbeResult> {
    const withProject = bothTrusted(trust);
    const plan = selectServersToStart(snapshot, trust);
    const build = (rows: readonly McpLiveRow[] | undefined, settled: boolean): McpProbeUpdate => ({ ...buildMcpItems({ snapshot, trust, ...(rows === undefined ? {} : { live: rows }), settled }), settled });
    const emit = (fn: ((u: McpProbeUpdate) => void) | undefined, u: McpProbeUpdate): void => {
      try {
        fn?.(u);
      } catch {
        /* a listener's failure is its own */
      }
    };
    const key = `${withProject ? cwd : 'n'}\u0000${plan.names.join('\u0001')}`;

    const hit = mcpCache.get(key);
    if (hit !== undefined && opts.force !== true && now() - hit.at < mcpTtl) {
      const u = build(hit.value.rows, hit.value.settled);
      emit(onUpdate, u);
      return Promise.resolve({ ...u, status: 'ok', at: hit.at, elapsedMs: 0, cached: true });
    }
    const running = mcpFlights.get(key);
    if (running !== undefined) {
      if (onUpdate !== undefined) {
        running.listeners.add(onUpdate);
        if (running.last !== undefined) emit(onUpdate, running.last);
      }
      return running.promise;
    }

    const id = ++counter;
    const started = now();
    const flight: Flight<McpProbeResult, (u: McpProbeUpdate) => void> = { promise: undefined as unknown as Promise<McpProbeResult>, listeners: new Set() };
    if (onUpdate !== undefined) flight.listeners.add(onUpdate);
    const publish = (u: McpProbeUpdate): void => {
      flight.last = u;
      for (const l of flight.listeners) emit(l, u);
    };
    const pollMs = deps.pollMs ?? MCP_POLL_MS;
    const pollMax = deps.pollMaxMs ?? MCP_POLL_MAX_MS;

    const run = async (): Promise<McpProbeResult> => {
      let lastRows: McpLiveRow[] = [];
      let settled = false;
      let sig = '';
      const r = await withQuery(
        id,
        'mcp',
        {
          cwd: withProject ? cwd : neutralCwd(), // a project server may use a relative command, so the project folder, once trusted
          settingSources: ['user'], // a probe needs none of the project's settings
          mcpServers: plan.servers as NonNullable<Options['mcpServers']>,
        },
        deps.mcpTimeoutMs ?? MCP_TIMEOUT_MS,
        async (q, race, setPid) => {
          if (typeof q.mcpServerStatus !== 'function') throw new UnsupportedControlError('mcpServerStatus');
          if (typeof q.initializationResult === 'function') setPid(await race(q.initializationResult()));
          const polling = now();
          for (;;) {
            lastRows = parseMcpLiveStatuses(await race(q.mcpServerStatus()));
            const reported = new Set(lastRows.map((x) => x.name));
            settled = lastRows.every((x) => x.status !== 'pending') && plan.names.every((n) => reported.has(n));
            const update = build(lastRows, settled);
            const s = JSON.stringify(update);
            if (s !== sig) {
              sig = s;
              publish(update);
            }
            if (settled || now() - polling >= pollMax) return;
            const nap = sleep(pollMs);
            try {
              await race(nap.promise);
            } finally {
              nap.cancel();
            }
          }
        },
      );
      if (!r.ok) {
        log(`mcp probe#${id}: failed (${r.reason})`);
        const u = build(lastRows.length > 0 ? lastRows : undefined, false);
        publish(u);
        return { ...u, status: 'failed', reason: r.reason };
      }
      const at = now();
      const u = build(lastRows, settled);
      mcpCache.set(key, { at, value: { rows: lastRows, settled } });
      log(`mcp probe#${id}: ok in ${at - started} ms, ${plan.names.length} started, ${lastRows.length} rows, ${settled ? 'settled' : 'not settled'}`);
      return { ...u, status: 'ok', at, elapsedMs: at - started, cached: false };
    };
    flight.promise = run().finally(() => {
      mcpFlights.delete(key);
    });
    mcpFlights.set(key, flight);
    return flight.promise;
  }

  function clearCache(cwd?: string): void {
    if (cwd === undefined) {
      catalogCache.clear();
      mcpCache.clear();
      return;
    }
    // The untrusted entries (key 'n') are not tied to a folder, so they go with any folder's refresh.
    for (const k of [...catalogCache.keys()]) if (k === `p\u0000${cwd}` || k === 'n') catalogCache.delete(k);
    for (const k of [...mcpCache.keys()]) if (k.startsWith(`${cwd}\u0000`) || k.startsWith('n\u0000')) mcpCache.delete(k);
  }

  return { probeCatalog, probeMcpStatus, clearCache };
}
