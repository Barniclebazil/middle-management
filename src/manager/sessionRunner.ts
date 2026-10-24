// One Claude Agent SDK `query()` per office-run session, in streaming input mode. The SDK function is injected
// (`queryFn`) so tests use a fake; the real one is wired in `index.ts`. Only types come from the SDK here.
// No `vscode` import.
import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, PermissionMode, SessionOptions, UsageWindow, UsageWindowId } from '../shared/protocol.ts';
import { EFFORT_LEVELS, PERMISSION_MODES, USAGE_WINDOW_IDS } from '../shared/protocol.ts';
import { createCostTracker } from './cost.ts';
import type { CostTracker } from './cost.ts';
import type { PendingRegistry } from './pending.ts';

/** The slice of the SDK's `Query` the runner uses. The real `Query` satisfies it. */
export interface SdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  interrupt(): Promise<unknown>;
  close?(): void;
  // Live controls and probes. Optional and feature-detected: an older Claude Code build may lack them, and a missing
  // method makes the runner throw `UnsupportedControlError`. They need streaming input (the runner always uses it).
  /** `undefined` resets to Claude Code's default model. Takes effect from the next turn. */
  setModel?(model?: string): Promise<unknown>;
  setPermissionMode?(mode: PermissionMode): Promise<unknown>;
  /** `effortLevel: null` resets to the model's default effort. */
  applyFlagSettings?(settings: { effortLevel?: EffortLevel | null }): Promise<unknown>;
  initializationResult?(): Promise<unknown>;
  /** An options object, not a string. `'summary'` is a 7 ms local call. */
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  /** Experimental (the name says so): the data behind `/usage`, including plan rate-limit windows. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
  // The catalog probe's reads (`catalogProbe.ts`): they send no prompt and cost no tokens. Results are `unknown` on purpose:
  // the probe whitelists what it keeps and never forwards a raw row.
  /** Skills and slash commands. */
  supportedCommands?(): Promise<unknown>;
  /** Subagent types. */
  supportedAgents?(): Promise<unknown>;
  /** Live MCP server states. The raw rows may carry error text: only `parseMcpLiveStatuses` may read them. */
  mcpServerStatus?(): Promise<unknown>;
}

/** The control methods of SdkQuery that can be missing. */
export type ControlMethod =
  | 'setModel'
  | 'setPermissionMode'
  | 'applyFlagSettings'
  | 'initializationResult'
  | 'getContextUsage'
  | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
  | 'supportedCommands'
  | 'supportedAgents'
  | 'mcpServerStatus';

/** A control method the running Claude Code build does not have (tell the user to update the Claude Code extension). */
export class UnsupportedControlError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`This Claude Code version does not support ${method}.`);
    this.name = 'UnsupportedControlError';
    this.method = method;
  }
}

/** Same call shape as the SDK's `query`, with the prompt always an async iterable (streaming input). */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SdkQuery;

export const ENTRYPOINT_TAG = 'claude-office';

// ---------------------------------------------------------------------------------------------------------------------
// Input queue

/** An async iterable the SDK pulls user messages from. `push` never blocks; `end` finishes the iteration. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  push(text: string): boolean {
    if (this.#ended) return false;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: msg, done: false });
    } else {
      this.#items.push(msg);
    }
    return true;
  }

  end(): void {
    this.#ended = true;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment

/** Session markers that must not leak from a Claude Code parent into the child (user configuration is kept). */
const MARKER_KEYS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION']);
const MARKER_PATTERN = /^CLAUDE_CODE_(SESSION|SSE_PORT|EXECPATH|ENTRYPOINT|MESSAGING|PARENT|REMOTE_SESSION)/;

/** A full child environment: the host's, minus inherited Claude Code session markers, plus the entrypoint tag. */
export function buildRunnerEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of Object.keys(env)) {
    if (MARKER_KEYS.has(k) || MARKER_PATTERN.test(k)) delete env[k];
  }
  env['CLAUDE_CODE_ENTRYPOINT'] = ENTRYPOINT_TAG;
  return env;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/** A short user-facing line for a failure of the SDK or the child process. */
export function describeRunnerError(e: unknown, binaryPath?: string): { kind: 'binary' | 'auth' | 'exit' | 'error'; message: string } {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (/native binary not found|not found at|ENOENT|EACCES|failed to launch|spawn EINVAL/i.test(text)) {
    return {
      kind: 'binary',
      message: `Could not start Claude Code${binaryPath !== undefined ? ` (${binaryPath})` : ''}. Check "claudeOffice.claudePath" or reinstall the Claude Code extension.`,
    };
  }
  if (/\b401\b|unauthori[sz]ed|authenticat|not logged in|please run \/?login|invalid api key|oauth|credential/i.test(text)) {
    return { kind: 'auth', message: 'Claude Code is not signed in. Sign in with the Claude Code extension (or run "claude" in a terminal), then try again.' };
  }
  const exit = /exited with code (\d+)/i.exec(text);
  if (exit) return { kind: 'exit', message: `Claude Code stopped unexpectedly (exit code ${exit[1]}).${text.length > 0 ? ' ' + text.slice(0, 300) : ''}`.trim() };
  return { kind: 'error', message: text.slice(0, 300) || 'Claude Code failed.' };
}

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error']);

// ---------------------------------------------------------------------------------------------------------------------
// Runner

export interface RunnerState {
  /** True from a sent user message until its `result`. */
  busy: boolean;
  /** The session's running cost: the latest result's `total_cost_usd` (a running total that includes earlier runs). */
  costUsd: number;
  model?: string;
  permissionMode?: PermissionMode;
  /**
   * Effort level as the runner knows it: from the start params and later `setOptions`. `system/init` carries no
   * effort (docs/sdk-spike.md 14e), so undefined means "the model's default" or "not set by us".
   */
  effort?: EffortLevel;
  /** Tokens in the context after the latest top-level assistant message (its input, cache and output tokens). */
  contextTokens?: number;
  /** Context window of the current model, once a result has reported it (`modelUsage[model].contextWindow`). */
  contextWindow?: number;
}

/** Outcome of `setOptions`. */
export type SetOptionsResult =
  | {
      ok: true;
      /** What was applied (the keys that were asked for). `null` = reset to default. */
      applied: SessionOptions;
      /** True when a turn is running: the SDK applies the change from the next turn. */
      deferredToNextTurn: boolean;
    }
  | {
      ok: false;
      /** A readable reason. "update the Claude Code extension" when the build lacks the control. */
      message: string;
      /** Parts applied before the failure, when any. */
      applied?: SessionOptions;
    };

export type RunnerNoticeKind = 'binary' | 'auth' | 'exit' | 'error';

export interface RunnerListener {
  /** Fires once the session id is known (immediately for a resume, else from the first SDK message). */
  onSessionId?: (sessionId: string) => void;
  /** Every SDK message, after the runner has updated its own state from it. */
  onMessage?: (msg: SDKMessage) => void;
  /** busy, cost, model or permission mode changed. */
  onState?: (state: RunnerState, changed: readonly (keyof RunnerState)[]) => void;
  /** A turn ended (every `result`, whatever its subtype). */
  onResult?: (info: { subtype: string; isError: boolean; turnCostUsd: number; totalCostUsd: number }) => void;
  /**
   * A `rate_limit_event` arrived (once per Claude Code process start). Windows are normalised to the protocol's
   * `UsageWindow`: `pct` 0..100, `resetsAt` epoch ms, `asOf` the time of arrival. Only known window ids are included.
   */
  onRateLimit?: (windows: UsageWindow[]) => void;
  /** A context window size was learned or changed for a model (from `result.modelUsage`). Lets the host remember it. */
  onContextWindow?: (model: string, contextWindow: number) => void;
  /** Something to tell the user: missing binary, process exit, sign-in problem. */
  onNotice?: (notice: { kind: RunnerNoticeKind; message: string }) => void;
  /** The query is over; the runner is dead. Fires exactly once. */
  onEnd?: (info: { reason: 'finished' | 'stopped' | 'error'; message?: string }) => void;
}

export interface RunnerDeps {
  queryFn: QueryFn;
  pending: PendingRegistry;
  listener?: RunnerListener;
  log?: (msg: string) => void;
  /** Environment to derive the child's from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Time allowed for a clean exit after stop(), before aborting (default 3000 ms). */
  graceMs?: number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  /**
   * Cost already accrued by earlier runs of the same session. Only a baseline for the tracker (the CLI restores the
   * total itself on a resume, so this is not added to anything); without it the first result after a resume counts as
   * one big turn. Also the value of `costUsd` until the first result.
   */
  initialCostUsd?: number;
  /** Share a tracker between runners (and, later, the conversation) so baselines survive a runner's end. */
  cost?: CostTracker;
  /** Clock for `asOf` of rate-limit windows (default `Date.now`). */
  now?: () => number;
}

export interface StartParams {
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  model?: string;
  /** Passed to `Options.effort`. Also remembered as the session's effort. */
  effort?: EffortLevel;
  resume?: string;
  binaryPath: string;
}

function isMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export class SessionRunner {
  readonly #deps: RunnerDeps;
  readonly #input = new InputQueue();
  readonly #abort = new AbortController();
  readonly #graceMs: number;
  readonly #timers: NonNullable<RunnerDeps['timers']>;
  readonly #log: (msg: string) => void;

  #query: SdkQuery | undefined;
  #started = false;
  #ended = false;
  #stopping = false;
  #sessionId: string | undefined;
  #sidNotified = false;
  #sidResolve: ((id: string) => void) | undefined;
  readonly #sidReady: Promise<string>;
  #outstanding = 0;
  readonly #cost: CostTracker;
  #costUsd: number;
  #effort: EffortLevel | undefined;
  #contextTokens: number | undefined;
  readonly #contextWindows = new Map<string, number>();
  #model: string | undefined;
  #permissionMode: PermissionMode | undefined;
  #binaryPath: string | undefined;
  #done: Promise<void> = Promise.resolve();

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
    this.#graceMs = deps.graceMs ?? 3000;
    this.#timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.#log = deps.log ?? (() => {});
    this.#cost = deps.cost ?? createCostTracker();
    this.#costUsd = deps.initialCostUsd ?? 0;
    this.#sidReady = new Promise<string>((res) => {
      this.#sidResolve = res;
    });
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }
  get busy(): boolean {
    return this.#outstanding > 0 && !this.#ended;
  }
  get costUsd(): number {
    return this.#costUsd;
  }
  get model(): string | undefined {
    return this.#model;
  }
  get effort(): EffortLevel | undefined {
    return this.#effort;
  }
  /** Context windows learned so far, by model id. */
  get contextWindows(): ReadonlyMap<string, number> {
    return this.#contextWindows;
  }
  get permissionMode(): PermissionMode | undefined {
    return this.#permissionMode;
  }
  get ended(): boolean {
    return this.#ended;
  }
  get state(): RunnerState {
    const s: RunnerState = { busy: this.busy, costUsd: this.#costUsd };
    if (this.#model !== undefined) s.model = this.#model;
    if (this.#permissionMode !== undefined) s.permissionMode = this.#permissionMode;
    if (this.#effort !== undefined) s.effort = this.#effort;
    if (this.#contextTokens !== undefined) s.contextTokens = this.#contextTokens;
    const win = this.#model !== undefined ? this.#contextWindows.get(this.#model) : undefined;
    if (win !== undefined) s.contextWindow = win;
    return s;
  }

  /** Spawn the SDK query and begin consuming it. Never throws: failures arrive through the listener. */
  start(p: StartParams): void {
    if (this.#started) return;
    this.#started = true;
    this.#binaryPath = p.binaryPath;
    this.#permissionMode = p.permissionMode;
    if (p.model !== undefined) this.#model = p.model;
    if (p.effort !== undefined) this.#effort = p.effort;
    if (p.resume !== undefined) {
      this.#sessionId = p.resume;
      if (this.#deps.initialCostUsd !== undefined) this.#cost.seed(p.resume, this.#deps.initialCostUsd);
      this.#sidResolve?.(p.resume);
      queueMicrotask(() => this.#notifySession());
    }
    const options: Options = {
      cwd: p.cwd,
      pathToClaudeCodeExecutable: p.binaryPath,
      settingSources: ['user', 'project', 'local'],
      permissionMode: p.permissionMode, // always explicit; never bypassPermissions
      includePartialMessages: true,
      canUseTool: this.#canUseTool,
      abortController: this.#abort,
      env: buildRunnerEnv(this.#deps.env ?? process.env),
      stderr: (s: string) => this.#log(`claude stderr: ${s.length} chars`),
    };
    if (p.model !== undefined) options.model = p.model;
    if (p.effort !== undefined) options.effort = p.effort;
    if (p.resume !== undefined) options.resume = p.resume;

    this.#input.push(p.prompt);
    this.#outstanding = 1;
    let q: SdkQuery;
    try {
      q = this.#deps.queryFn({ prompt: this.#input, options });
    } catch (e) {
      this.#done = Promise.resolve();
      this.#finish('error', e);
      return;
    }
    this.#query = q;
    this.#done = this.#consume(q);
  }

  /** Queue a user message. The SDK runs it after the current turn. False when the run is over. */
  send(text: string): boolean {
    if (this.#ended || this.#stopping || !this.#started) return false;
    if (!this.#input.push(text)) return false;
    const before = this.state;
    this.#outstanding++;
    this.#emitState(before);
    return true;
  }

  /** End the current turn (not the session) and deny every open request of this session. */
  async interrupt(): Promise<void> {
    if (this.#ended || !this.#started) return;
    const had = this.#sessionId !== undefined ? this.#deps.pending.cancelSession(this.#sessionId).length > 0 : false;
    if (!this.busy && !had) return;
    try {
      await this.#query?.interrupt();
    } catch (e) {
      this.#log(`interrupt failed: ${e instanceof Error ? e.message.length : 0} chars`);
    }
  }

  /** Interrupt, end the input, and abort after the grace period. Resolves once the query has finished (or given up). */
  async stop(): Promise<void> {
    if (!this.#started || this.#ended) return;
    this.#stopping = true;
    if (this.#sessionId !== undefined) this.#deps.pending.cancelSession(this.#sessionId);
    const q = this.#query;
    if (q && this.busy) {
      try {
        await this.#race(Promise.resolve(q.interrupt()).catch(() => undefined), this.#graceMs, undefined);
      } catch {
        // ignore
      }
    }
    this.#input.end();
    if (await this.#race(this.#done.then(() => true), this.#graceMs, false)) return;
    this.#abort.abort();
    try {
      q?.close?.();
    } catch {
      // ignore
    }
    await this.#race(this.#done, this.#graceMs, undefined);
    if (!this.#ended) this.#finish('stopped');
  }

  /**
   * Change model, effort and permission mode of the running session, in that order. Each is applied by the SDK from
   * the next turn (also when called during one), so `deferredToNextTurn` tells the UI to say "applies next turn".
   * `null` model or effort resets to the default (`setModel(undefined)`, `applyFlagSettings({effortLevel: null})`).
   * `bypassPermissions` is refused (and is not in PermissionMode anyway). Nothing is applied when an argument is invalid.
   */
  async setOptions(opts: SessionOptions): Promise<SetOptionsResult> {
    if (this.#ended || this.#stopping || !this.#started || !this.#query) return { ok: false, message: 'The session is not running.' };
    if (opts.permissionMode !== undefined && !isMode(opts.permissionMode)) return { ok: false, message: 'That approvals mode is not allowed.' };
    if (opts.model !== undefined && opts.model !== null && (typeof opts.model !== 'string' || opts.model.trim() === '')) return { ok: false, message: 'That model name is not valid.' };
    if (opts.effort !== undefined && opts.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(opts.effort)) return { ok: false, message: 'That effort level is not valid.' };
    const deferred = this.busy;
    const applied: SessionOptions = {};
    const fail = (e: unknown, what: string): SetOptionsResult => {
      const r: SetOptionsResult = { ok: false, message: describeControlError(e, what) };
      if (Object.keys(applied).length > 0) r.applied = applied;
      return r;
    };
    if (opts.model !== undefined) {
      try {
        await this.#control('setModel', opts.model === null ? undefined : opts.model);
      } catch (e) {
        return fail(e, 'the model');
      }
      applied.model = opts.model;
    }
    if (opts.effort !== undefined) {
      try {
        await this.#control('applyFlagSettings', { effortLevel: opts.effort });
      } catch (e) {
        return fail(e, 'the effort');
      }
      applied.effort = opts.effort;
      const before = this.state;
      this.#effort = opts.effort === null ? undefined : opts.effort;
      this.#emitState(before);
    }
    if (opts.permissionMode !== undefined) {
      try {
        await this.#control('setPermissionMode', opts.permissionMode);
      } catch (e) {
        return fail(e, 'the approvals mode');
      }
      applied.permissionMode = opts.permissionMode;
      const before = this.state;
      this.#permissionMode = opts.permissionMode;
      this.#emitState(before);
    }
    return { ok: true, applied, deferredToNextTurn: deferred };
  }

  /** The SDK's init response (models, account, commands...), or throws `UnsupportedControlError`. Contains the account email: do not log it. */
  initializationResult(): Promise<unknown> {
    return this.#control('initializationResult');
  }

  /** Context usage in summary form, without the big `gridRows` picture grid. Throws `UnsupportedControlError` on older builds. */
  async contextUsage(): Promise<Record<string, unknown>> {
    const r = rec(await this.#control('getContextUsage', { detail: 'summary' })) ?? {};
    const { gridRows: _drop, ...rest } = r;
    return rest;
  }

  /** Call a feature-detected control method on the live query (with `this` bound), or throw `UnsupportedControlError`. */
  #control(name: 'setModel', model: string | undefined): Promise<unknown>;
  #control(name: 'setPermissionMode', mode: PermissionMode): Promise<unknown>;
  #control(name: 'applyFlagSettings', settings: { effortLevel: EffortLevel | null }): Promise<unknown>;
  #control(name: 'initializationResult'): Promise<unknown>;
  #control(name: 'getContextUsage', opts: { detail: 'summary' | 'full' }): Promise<unknown>;
  async #control(name: ControlMethod, arg?: unknown): Promise<unknown> {
    const q = this.#query;
    const fn = q?.[name] as ((a?: unknown) => Promise<unknown>) | undefined;
    if (!q || typeof fn !== 'function') throw new UnsupportedControlError(name);
    return fn.call(q, arg);
  }

  // --- internals ---------------------------------------------------------------------------------------------------

  readonly #canUseTool: CanUseTool = async (toolName, input, opts) => {
    const sessionId = this.#sessionId ?? (await this.#sidReady);
    if (sessionId === '' || this.#ended) return { behavior: 'deny', message: 'The session has ended.', interrupt: true };
    const args: Parameters<PendingRegistry['create']>[0] = { sessionId, toolName, input, toolUseID: opts.toolUseID, signal: opts.signal };
    if (opts.suggestions !== undefined) args.suggestions = opts.suggestions;
    if (opts.blockedPath !== undefined) args.blockedPath = opts.blockedPath;
    if (opts.decisionReason !== undefined) args.decisionReason = opts.decisionReason;
    if (opts.title !== undefined) args.title = opts.title;
    if (opts.description !== undefined) args.description = opts.description;
    if (opts.suppressAlwaysAllowRule !== undefined) args.suppressAlwaysAllowRule = opts.suppressAlwaysAllowRule;
    return this.#deps.pending.create(args).promise;
  };

  #race<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
    return new Promise((resolve) => {
      const h = this.#timers.setTimeout(() => resolve(fallback), ms);
      p.then(
        (v) => {
          this.#timers.clearTimeout(h);
          resolve(v);
        },
        () => {
          this.#timers.clearTimeout(h);
          resolve(fallback);
        },
      );
    });
  }

  #notifySession(): void {
    if (this.#sidNotified || this.#sessionId === undefined) return;
    this.#sidNotified = true;
    this.#fire(() => this.#deps.listener?.onSessionId?.(this.#sessionId!));
  }

  async #consume(q: SdkQuery): Promise<void> {
    let failure: unknown;
    try {
      for await (const msg of q) {
        if (this.#ended) break;
        this.#track(msg);
        this.#fire(() => this.#deps.listener?.onMessage?.(msg));
      }
    } catch (e) {
      failure = e;
    }
    if (failure !== undefined && !this.#stopping) this.#finish('error', failure);
    else this.#finish(this.#stopping ? 'stopped' : 'finished');
  }

  #track(msg: SDKMessage): void {
    const m = rec(msg);
    if (!m) return;
    const before = this.state;
    const sid = m['session_id'];
    if (typeof sid === 'string' && sid !== '' && sid !== this.#sessionId) {
      this.#sessionId = sid;
      this.#sidResolve?.(sid);
      this.#sidNotified = false;
      this.#notifySession();
    } else if (typeof sid === 'string' && sid !== '') {
      this.#notifySession();
    }
    const type = m['type'];
    if (type === 'system') {
      if (m['subtype'] === 'init') {
        if (typeof m['model'] === 'string' && m['model'] !== '') this.#model = m['model'];
        if (isMode(m['permissionMode'])) this.#permissionMode = m['permissionMode'];
      } else if (m['subtype'] === 'status' && isMode(m['permissionMode'])) {
        this.#permissionMode = m['permissionMode'];
      }
    } else if (type === 'assistant') {
      const top = m['parent_tool_use_id'] === null || m['parent_tool_use_id'] === undefined;
      const model = rec(m['message'])?.['model'];
      if (top && typeof model === 'string' && model !== '' && model !== '<synthetic>') this.#model = model;
      if (top) {
        // The context after this response: what it read (input, cached) plus what it wrote. Subagents have their own context.
        const tokens = contextTokensOf(rec(m['message'])?.['usage']);
        if (tokens !== undefined) this.#contextTokens = tokens;
      }
      const err = m['error'];
      if (typeof err === 'string' && AUTH_ERRORS.has(err)) {
        this.#fire(() => this.#deps.listener?.onNotice?.({ kind: 'auth', message: authMessage(err) }));
      }
    } else if (type === 'rate_limit_event') {
      const windows = normaliseRateLimit(m['rate_limit_info'], (this.#deps.now ?? Date.now)());
      if (windows.length > 0) this.#fire(() => this.#deps.listener?.onRateLimit?.(windows));
      return;
    } else if (type === 'result') {
      // `total_cost_usd` is the session's running total, so the turn cost is the delta from the previous total.
      const key = this.#sessionId ?? '';
      if (this.#deps.initialCostUsd !== undefined) this.#cost.seed(key, this.#deps.initialCostUsd); // no-op after the first
      const { turnUsd, totalUsd } = this.#cost.observe(key, typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : Number.NaN);
      this.#costUsd = totalUsd;
      this.#learnContextWindows(m['modelUsage']);
      this.#outstanding = Math.max(0, this.#outstanding - 1);
      this.#emitState(before);
      this.#fire(() =>
        this.#deps.listener?.onResult?.({
          subtype: typeof m['subtype'] === 'string' ? m['subtype'] : 'unknown',
          isError: m['is_error'] === true,
          turnCostUsd: turnUsd,
          totalCostUsd: totalUsd,
        }),
      );
      return;
    }
    this.#emitState(before);
  }

  #learnContextWindows(modelUsage: unknown): void {
    const mu = rec(modelUsage);
    if (!mu) return;
    for (const [model, usage] of Object.entries(mu)) {
      const w = rec(usage)?.['contextWindow'];
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue;
      if (this.#contextWindows.get(model) === w) continue;
      this.#contextWindows.set(model, w);
      this.#fire(() => this.#deps.listener?.onContextWindow?.(model, w));
    }
  }

  #emitState(before: RunnerState): void {
    const after = this.state;
    const changed: (keyof RunnerState)[] = [];
    for (const k of ['busy', 'costUsd', 'model', 'permissionMode', 'effort', 'contextTokens', 'contextWindow'] as const) {
      if (before[k] !== after[k]) changed.push(k);
    }
    if (changed.length > 0) this.#fire(() => this.#deps.listener?.onState?.(after, changed));
  }

  #finish(reason: 'finished' | 'stopped' | 'error', error?: unknown): void {
    if (this.#ended) return;
    const before = this.state;
    this.#ended = true;
    this.#input.end();
    if (this.#sessionId !== undefined) this.#deps.pending.cancelSession(this.#sessionId);
    this.#sidResolve?.(this.#sessionId ?? '');
    let message: string | undefined;
    if (reason === 'error') {
      const d = describeRunnerError(error, this.#binaryPath);
      message = d.message;
      this.#fire(() => this.#deps.listener?.onNotice?.({ kind: d.kind, message: d.message }));
    }
    this.#emitState(before);
    const info: { reason: 'finished' | 'stopped' | 'error'; message?: string } = { reason };
    if (message !== undefined) info.message = message;
    this.#fire(() => this.#deps.listener?.onEnd?.(info));
  }

  #fire(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.#log(`listener error: ${e instanceof Error ? e.message.length : 0} chars`);
    }
  }
}

function describeControlError(e: unknown, what: string): string {
  if (e instanceof UnsupportedControlError) return `This Claude Code build cannot change ${what} on a running session. Please update the Claude Code extension.`;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  return text !== '' ? `Could not change ${what}: ${text}` : `Could not change ${what}.`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Context size after one API response, from its `usage`. Undefined when there is no usable usage. */
function contextTokensOf(usage: unknown): number | undefined {
  const u = rec(usage);
  if (!u) return undefined;
  const total = num(u['input_tokens']) + num(u['cache_creation_input_tokens']) + num(u['cache_read_input_tokens']) + num(u['output_tokens']);
  return total > 0 ? total : undefined;
}

/**
 * `rate_limit_event.rate_limit_info` to protocol windows. The numbers live in `unifiedWindows` (not in the SDK types):
 * utilization is 0..1 and `resetsAt` is epoch SECONDS (docs/sdk-spike.md 14b). The typed top-level fields are the
 * fallback when `unifiedWindows` is absent. `status` allowed_warning/rejected marks the binding `rateLimitType` window.
 */
export function normaliseRateLimit(info: unknown, now: number): UsageWindow[] {
  const i = rec(info);
  if (!i) return [];
  const ids = USAGE_WINDOW_IDS as readonly string[];
  const raw: Array<{ id: UsageWindowId; utilization: unknown; resetsAt: unknown }> = [];
  const uw = rec(i['unifiedWindows']);
  if (uw) {
    for (const [id, w] of Object.entries(uw)) {
      const r = rec(w);
      if (r && ids.includes(id)) raw.push({ id: id as UsageWindowId, utilization: r['utilization'], resetsAt: r['resetsAt'] });
    }
  }
  const bindingId = typeof i['rateLimitType'] === 'string' && ids.includes(i['rateLimitType']) ? (i['rateLimitType'] as UsageWindowId) : undefined;
  if (raw.length === 0 && bindingId !== undefined) raw.push({ id: bindingId, utilization: i['utilization'], resetsAt: i['resetsAt'] });
  const state = i['status'] === 'rejected' ? 'blocked' : i['status'] === 'allowed_warning' ? 'warning' : undefined;
  const out: UsageWindow[] = [];
  for (const r of raw) {
    const w: UsageWindow = { id: r.id, pct: null, asOf: now };
    if (typeof r.utilization === 'number' && Number.isFinite(r.utilization)) w.pct = Math.min(100, Math.max(0, Math.round(r.utilization * 10000) / 100));
    if (typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) && r.resetsAt > 0) {
      // Seconds, but accept a value that is already ms (anything beyond year 5138 as seconds).
      w.resetsAt = r.resetsAt < 1e11 ? Math.round(r.resetsAt * 1000) : Math.round(r.resetsAt);
    }
    if (state !== undefined && r.id === bindingId) w.state = state;
    out.push(w);
  }
  return out;
}

function authMessage(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'Claude Code is not signed in. Sign in with the Claude Code extension (or run "claude" in a terminal), then try again.';
    case 'billing_error':
      return 'Claude reported a billing problem for this account.';
    case 'account_on_hold':
      return 'This Claude account is on hold.';
    case 'oauth_org_not_allowed':
      return 'This organisation is not allowed to use this sign-in.';
    case 'verification_required':
      return 'Claude needs you to verify your account before continuing.';
    default:
      return 'Claude Code could not authenticate. Check your sign-in.';
  }
}
