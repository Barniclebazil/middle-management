// The usage probe: asks Claude Code for the current plan usage WITHOUT sending a prompt, so it costs no tokens and writes
// no transcript (docs/sdk-spike.md 14c). A throwaway query whose input queue never yields, with no settings, no MCP
// servers and no tools; it calls `initializationResult()` and the experimental usage method, then always closes.
// A second `usage()` call on one query is a cache hit, so every refresh spawns a fresh probe.
//
// Everything that leaves this module went through the whitelisting parsers of `claudeConfig.ts`; failure reasons are
// fixed short phrases (never SDK text, which could carry paths or account data). No `vscode` import; the SDK function,
// the clock and the timers are injected.
import os from 'node:os';
import type { ModelChoice, UsageExtra, UsageWindow } from '../shared/protocol.ts';
import { parseInitInfo, parseProbeExtra, parseProbePlan, parseProbeUsage } from '../claude/claudeConfig.ts';
import { InputQueue, UnsupportedControlError, buildRunnerEnv, describeRunnerError } from './sessionRunner.ts';
import type { QueryFn, SdkQuery } from './sessionRunner.ts';

/** `CLAUDE_CODE_ENTRYPOINT` of a probe. The session watcher ignores sessions with this entrypoint. */
export const PROBE_ENTRYPOINT_TAG = 'claude-office-probe';

/** The whole probe gives up after this long. */
export const PROBE_TIMEOUT_MS = 20_000;

export interface UsageProbeDeps {
  /** The SDK's `query` (the real one is wired in `index.ts`; tests pass a fake). */
  queryFn: QueryFn;
  /** Path of the Claude Code binary. */
  binaryPath: string;
  /** Environment to derive the child's from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Neutral working folder (default: the OS temp dir), so the probe never touches a project. */
  cwd?: string;
  /** Default `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
  now?: () => number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  /** Receives lengths, states and ids only; never usage values or account data. */
  log?: (msg: string) => void;
}

export type ProbeResult =
  | {
      status: 'ok';
      windows: UsageWindow[];
      extra?: UsageExtra;
      /** Short subscription label ('Max', 'Pro'), when the account has one. */
      plan?: string;
      /** The model list from `initializationResult()` (empty when the build has no such call). */
      models: ModelChoice[];
      /** True when Claude Code reports no rate limits and no subscription: API-key (or third-party) billing. */
      apiKey: boolean;
      /** Epoch ms when the probe finished (`asOf` of its windows). */
      at: number;
      elapsedMs: number;
    }
  /** This Claude Code build has no usage call. */
  | { status: 'unsupported' }
  /** Not signed in. */
  | { status: 'signedOut'; reason: string }
  /** Anything else (timeout, process error). `reason` is a short fixed phrase with no values. */
  | { status: 'failed'; reason: string };

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

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
function failureOf(e: unknown): ProbeResult {
  if (e instanceof UnsupportedControlError) return { status: 'unsupported' };
  if (e instanceof ProbeTimeout) return { status: 'failed', reason: 'timed out' };
  if (e instanceof ProbeEndedEarly) return { status: 'failed', reason: 'Claude Code stopped before answering' };
  const d = describeRunnerError(e);
  if (d.kind === 'auth') return { status: 'signedOut', reason: 'not signed in' };
  if (d.kind === 'binary') return { status: 'failed', reason: 'could not start Claude Code' };
  if (d.kind === 'exit') return { status: 'failed', reason: 'Claude Code exited unexpectedly' };
  const name = e instanceof Error && /^[A-Za-z]{1,30}$/.test(e.name) ? e.name : 'Error';
  return { status: 'failed', reason: `probe error (${name})` };
}

/** Run one probe. Never throws and never rejects; the query is always closed before this resolves. */
export async function runUsageProbe(deps: UsageProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const started = now();
  const input = new InputQueue(); // never pushed to: the probe has no prompt
  const abort = new AbortController();
  const env = buildRunnerEnv(deps.env ?? process.env);
  env['CLAUDE_CODE_ENTRYPOINT'] = PROBE_ENTRYPOINT_TAG;

  let q: SdkQuery;
  try {
    q = deps.queryFn({
      prompt: input,
      options: {
        cwd: deps.cwd ?? os.tmpdir(),
        pathToClaudeCodeExecutable: deps.binaryPath,
        model: 'haiku', // never used: no turn ever runs
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        allowedTools: [],
        persistSession: false,
        permissionMode: 'default',
        abortController: abort,
        env,
        stderr: (s: string) => log(`probe stderr: ${s.length} chars`),
      },
    });
  } catch (e) {
    const r = failureOf(e);
    log(`usage probe: query() threw -> ${r.status}`);
    return r;
  }


  let rejectDead: (e: unknown) => void = () => {};
  // Settles (by rejecting) when the process dies or the time is up; raced against each step.
  const dead = new Promise<never>((_, rej) => {
    rejectDead = rej;
  });
  dead.catch(() => {}); // never an unhandled rejection
  let finished = false;
  const timer = timers.setTimeout(() => rejectDead(new ProbeTimeout()), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  // Drain the (empty) message stream: with no prompt it yields nothing, and ends only when the process dies or on close.
  void (async () => {
    try {
      for await (const _ of q) {
        // A probe never expects a message; ignore it (nothing is sent, so none should come).
      }
      if (!finished) rejectDead(new ProbeEndedEarly());
    } catch (e) {
      if (!finished) rejectDead(e);
    }
  })();

  try {
    let models: ModelChoice[] = [];
    let initPlan: string | undefined;
    if (typeof q.initializationResult === 'function') {
      const init = parseInitInfo(await Promise.race([q.initializationResult(), dead]));
      models = init.models;
      initPlan = init.subscriptionType;
    }
    const usageFn = q[USAGE_METHOD];
    if (typeof usageFn !== 'function') throw new UnsupportedControlError(USAGE_METHOD);
    const raw: unknown = await Promise.race([usageFn.call(q, { skipBehaviors: true }), dead]);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      log('usage probe: unexpected usage result shape');
      return { status: 'failed', reason: 'unexpected usage result' };
    }
    const at = now();
    const windows = parseProbeUsage(raw, at);
    const plan = parseProbePlan(raw) ?? initPlan;
    const extra = parseProbeExtra(raw);
    const apiKey = windows.length === 0 && plan === undefined && (raw as Record<string, unknown>)['rate_limits_available'] === false;
    const result: ProbeResult = { status: 'ok', windows, models, apiKey, at, elapsedMs: at - started };
    if (plan !== undefined) result.plan = plan;
    if (extra !== undefined) result.extra = extra;
    log(`usage probe: ok in ${at - started} ms, ${windows.length} windows, ${models.length} models, plan ${plan === undefined ? 'none' : 'set'}`);
    return result;
  } catch (e) {
    const r = failureOf(e);
    log(`usage probe: ${r.status}${'reason' in r ? ` (${r.reason})` : ''}`);
    return r;
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
  }
}
