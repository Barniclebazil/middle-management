// The manager layer's message handler: routes validated WebviewToHost messages, drives office runs through
// SessionRunner, keeps every open case file up to date (one CaseState per worker, shared by all the webviews that show
// it) and emits HostToWebview messages to the right webviews.
// Everything outside this file is injected (see ManagerHostDeps), so it runs and tests under plain Node.
// No `vscode` import.
import * as fs from 'node:fs';
import { EFFORT_LEVELS, LIMITS, PERMISSION_MODES, forAnotherCase } from '../shared/protocol.ts';
import type {
  AgentControl,
  AgentSnapshot,
  CaseHeader,
  ConversationItem,
  EffortLevel,
  HostToWebview,
  PendingRequest,
  PermissionMode,
  SessionOptions,
  UsageWindow,
  WebviewToHost,
} from '../shared/protocol.ts';
import { contextPercent, contextWindowFor } from '../model/contextWindow.ts';
import type { PlanText } from '../model/planIndex.ts';
import type { FindBinaryResult } from './claudeBinary.ts';
import { seedCostFromTranscript } from './conversation.ts';
import { checkResume, controlFor as computeControl } from './control.ts';
import type { ControlAgent } from './control.ts';
import { createCostTracker } from './cost.ts';
import type { CostTracker } from './cost.ts';
import { PendingRegistry, cut } from './pending.ts';
import { listProjects, recentCwdsFrom } from './projects.ts';
import type { ProjectFs } from './projects.ts';
import { SessionRunner } from './sessionRunner.ts';
import type { QueryFn } from './sessionRunner.ts';
import { parseJsonl } from './transcriptReader.ts';

/** Key under which the learned context windows are persisted (VS Code `globalState` in the extension). */
export const CONTEXT_WINDOWS_KEY = 'claudeOffice.contextWindows';

/** The converter state 7.2 provides (`createSdkItemBuilder()`): turns SDK messages into case items. */
export interface SdkItemBuilderLike {
  apply(msg: unknown): ConversationItem[];
  items(): ConversationItem[];
  markInterrupted(): void;
}

export interface CaseRead {
  items: ConversationItem[];
  truncated: boolean;
}

/** Minimal key/value store (the extension adapts `ExtensionContext.globalState`: `get` and `update`). */
export interface HostStorage {
  get(key: string): unknown;
  /** May return a promise; a rejection is logged and ignored. */
  set(key: string, value: unknown): unknown;
}

/** The options `createSdkItemBuilder` takes (task 2.5). Pass the host's shared tracker so a result is never counted twice. */
export interface SdkItemBuilderInit {
  cost?: CostTracker;
  sessionId?: string;
}

export interface HostTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ManagerHostDeps {
  /** Send a message to every webview (the old broadcast). Also the fallback for `postTo` when that is not wired. */
  post: (msg: HostToWebview) => void;
  /**
   * Send a message to the named webviews only: `'view'` (the office view), `'panel'` (the office's own editor tab) and
   * `'case:<agentId>'` (a case tab). When absent every message goes through `post`.
   */
  postTo?: (sources: readonly string[], msg: HostToWebview) => void;
  /** The SDK's `query` (or a fake). */
  queryFn: QueryFn;
  findBinary: () => FindBinaryResult | Promise<FindBinaryResult>;
  /** The transcript-based conversation of an agent (7.2's `readCaseFor`, bound to the transcript locator). */
  readCase: (agent: AgentSnapshot) => Promise<CaseRead>;
  /** 7.2's `createSdkItemBuilder` and `itemsFromSdkMessage`. The host passes the shared cost tracker and the session id (resume). */
  createSdkItemBuilder: (opts?: SdkItemBuilderInit) => SdkItemBuilderLike;
  itemsFromSdkMessage: (msg: unknown, builder: SdkItemBuilderLike) => ConversationItem[];
  /** Session ids held by a running process (control rule 3). Called synchronously, so keep it cheap. */
  listLiveSessionIds: () => Iterable<string>;
  workspaceFolders: () => string[];
  /** Folder dialog; the chosen absolute path, or undefined when cancelled. */
  showOpenDialog: () => Promise<string | undefined>;
  executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
  /** Fallback for openInClaudeCode when the command is missing: open a URI. Returns false when it failed. */
  openUri?: (uri: string) => Promise<boolean | void>;
  /** True when the path exists (file or folder). Used for project rows and `.git` lookups. */
  exists: (p: string) => boolean;
  /** True when the path is a folder. Defaults to `exists`. */
  isDirectory?: (p: string) => boolean;
  /** Read a small text file; undefined when missing. Defaults to node:fs. */
  readFile?: (p: string) => string | undefined;
  /** The model a session last used (tail of its transcript). Used to resume without silently switching models. */
  lastModelFor?: (sessionId: string) => Promise<string | undefined>;
  /**
   * The tail of a session's transcript as JSONL text (about 256 KB is plenty). Used on resume to seed the cost tracker
   * from the newest `cost-state`, so the first live result counts only its own turn.
   */
  readTranscriptTail?: (sessionId: string) => Promise<string | undefined>;
  /** Full text of a plan the host has no live run for (the extension passes `AgentTracker.planText`). */
  planText?: (agentId: string, planId: string) => PlanText | undefined;
  /** Persists the learned context windows under `CONTEXT_WINDOWS_KEY`. Read once at start. */
  storage?: HostStorage;
  /** A run reported rate-limit windows (task 2.8 connects this to the usage service). No-op when absent. */
  onRateLimit?: (windows: UsageWindow[]) => void;
  /** Ask the feed to publish `agents` again now (the model re-reads getOfficeInfo/controlFor). */
  refreshAgents?: () => void;
  log: (msg: string) => void;
  now?: () => number;
  timers?: HostTimers;
  /** Test/tuning knobs. */
  platform?: string;
  env?: Record<string, string | undefined>;
  caseRefreshMs?: number;
  flushMs?: number;
  graceMs?: number;
  startTimeoutMs?: number;
}

export interface OfficeInfo {
  pending?: { requestId: string; kind: 'permission' | 'question' | 'plan' };
  costUsd?: number;
  /** An office run's model (full id once known). */
  model?: string;
  /** The effort the run was started with or last set to (undefined = default). */
  effort?: EffortLevel;
  /** Context use of the run: tokens after its latest assistant message against the model's window. */
  context?: { tokens: number; max: number; pct: number; approx?: boolean };
}

export interface ManagerHost {
  /**
   * Handle one VALIDATED webview message. Never rejects. `source` is the sender (`'view'`, `'panel'` or `'case:<agentId>'`);
   * a missing source counts as `'view'`.
   */
  handle(msg: WebviewToHost, source?: string): Promise<void>;
  /** A webview went away (a case tab closed): it stops viewing its case, which is dropped when nobody else views it. */
  closeSource(source: string): void;
  /**
   * Stop an office run of this session, but only when it is idle: no pending request and no turn running. Returns whether
   * a run was stopped. Never touches a run that is busy or waiting for the user.
   */
  stopIfIdle(sessionId: string): boolean;
  /** The latest agent list from the feed. */
  onAgents(snapshots: readonly AgentSnapshot[]): void;
  /** For the model's `officeInfo` lookup. */
  getOfficeInfo(sessionId: string): OfficeInfo | undefined;
  /** For the model's `controlOf` lookup. */
  controlFor(agent: ControlAgent): AgentControl;
  /**
   * Context windows learned from office runs (model id -> tokens). The same live map the extension passes to
   * `AgentTracker` as `learnedWindows`; the host mutates it.
   */
  readonly contextWindows: ReadonlyMap<string, number>;
  /** Deny every request, stop every runner, close timers. Safe to call twice. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------

const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';
const LIVE_TTL_MS = 500;
const MAX_BROWSED = 10;
const MAX_WINDOWS = 50;
/** The source of a message that names none (old callers, tests). */
const OFFICE_VIEW = 'view';

interface Run {
  runner: SessionRunner;
  sessionId?: string;
  nonce?: string;
  cwd: string;
  builder: SdkItemBuilderLike;
  items: Map<string, ConversationItem>;
  dropped: boolean;
  /** Transcript items from before this run (resumed sessions). */
  base?: CaseRead;
  basePromise?: Promise<void>;
  echoN: number;
  startTimer?: unknown;
  prompt: string;
  startedAt: number;
  /** The webview that started or resumed this run: it gets the run's `taskStarted` and its start errors. */
  source: string;
  /** The runner's latest cost observation (its `onResult`), which the run's item builder reuses (see `costViewFor`). */
  lastCost?: { totalUsd: number; turnUsd: number };
}

interface CaseState {
  agentId: string;
  /** Last known snapshot of the agent (a stand-in for a new hire the feed has not listed, kept after its run ends). */
  agent?: AgentSnapshot;
  sessionId?: string;
  /** Counts the cases opened for this worker, so a stale build can tell it was replaced. */
  epoch: number;
  /** The webviews showing this case (each shows at most one). */
  viewers: Set<string>;
  mode: 'run' | 'transcript';
  ready: boolean;
  seen: boolean;
  /** Transcript mode: item id -> JSON of the item last read (insertion order = item order). */
  known: Map<string, string>;
  /** Transcript mode: the last read was cut. */
  truncated: boolean;
  lastHeader?: CaseHeader;
  queue: { items: Map<string, ConversationItem>; pending: PendingRequest | null | undefined; header: Partial<CaseHeader> };
  flushTimer?: unknown;
  pollTimer?: unknown;
}

function defaultTimers(): HostTimers {
  return {
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      (h as { unref?: () => void }).unref?.();
      return h;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function defaultReadFile(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

export function createManagerHost(deps: ManagerHostDeps): ManagerHost {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? defaultTimers();
  const flushMs = deps.flushMs ?? 250;
  const caseRefreshMs = deps.caseRefreshMs ?? 1000;
  const startTimeoutMs = deps.startTimeoutMs ?? 45000;
  const isDir = deps.isDirectory ?? deps.exists;
  const projectFs: ProjectFs = { exists: deps.exists, readFile: deps.readFile ?? defaultReadFile };

  let disposed = false;
  let agents: AgentSnapshot[] = [];
  const byId = new Map<string, AgentSnapshot>();
  const runs = new Map<string, Run>();
  const starting = new Set<Run>();
  const lastMode = new Map<string, PermissionMode>();
  const costBySession = new Map<string, number>();
  const modelBySession = new Map<string, string>();
  /** Options chosen for a free session's next message (`null` = the default). Used and cleared on the next resume. */
  const nextOptions = new Map<string, SessionOptions>();
  /** One tracker for every runner and item builder, so a result or a resume is never counted twice. */
  const cost: CostTracker = createCostTracker();
  const windows = loadWindows();
  const browsed: string[] = [];
  const loose = new Set<unknown>(); // timer handles for control refreshes
  let liveCache: { at: number; set: Set<string> } | undefined;
  /** Open cases, one per worker, however many webviews show it. */
  const cases = new Map<string, CaseState>();
  /** The worker whose case each webview has open (a webview shows at most one). */
  const sourceCase = new Map<string, string>();
  const caseEpochs = new Map<string, number>();

  // --- small helpers --------------------------------------------------------------------------------------------

  /** Send to the named webviews. Without `postTo` this is the old broadcast: one `post`, whatever the targets. */
  function sendTo(targets: readonly string[], msg: HostToWebview): void {
    if (disposed || targets.length === 0) return;
    try {
      if (deps.postTo) deps.postTo(targets, msg);
      else deps.post(msg);
    } catch (e) {
      log(`post failed: ${e instanceof Error ? e.message.length : 0} chars`);
    }
  }

  /** A stream message of a case: to the webviews that have it open, and to nobody else. */
  function postCase(cs: CaseState, msg: HostToWebview): void {
    sendTo([...cs.viewers], msg);
  }

  function log(msg: string): void {
    try {
      deps.log(msg);
    } catch {
      // ignore
    }
  }

  function loadWindows(): Map<string, number> {
    const out = new Map<string, number>();
    try {
      const raw = deps.storage?.get(CONTEXT_WINDOWS_KEY);
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
          if (out.size >= MAX_WINDOWS) break;
          if (model !== '' && model.length <= 100 && typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(model, Math.floor(v));
        }
      }
    } catch {
      // unreadable storage: start empty
    }
    return out;
  }

  function persistWindows(): void {
    if (!deps.storage) return;
    try {
      const r = deps.storage.set(CONTEXT_WINDOWS_KEY, Object.fromEntries(windows));
      if (typeof (r as { then?: unknown } | undefined)?.then === 'function') (r as Promise<unknown>).then(undefined, () => log('saving context windows failed'));
    } catch {
      log('saving context windows failed');
    }
  }

  /** A run reported the context window of a model. Remember it (in memory and in storage) and let the feed recompute. */
  function learnWindow(model: string, window: number): void {
    if (typeof model !== 'string' || model === '' || model.length > 100 || !Number.isFinite(window) || window <= 0) return;
    const w = Math.floor(window);
    if (windows.get(model) === w) return;
    windows.delete(model);
    windows.set(model, w);
    while (windows.size > MAX_WINDOWS) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    persistWindows();
    refreshAgents();
  }

  /** What an error is about, and where it goes. Without `to` it goes to the webviews that have that worker open (else the office view). */
  interface ErrorCtx {
    sessionId?: string;
    requestId?: string;
    reqId?: string;
    agentId?: string;
    to?: readonly string[];
  }

  /** The worker of a session: the open case's, else the listed one's, else the session id itself (an office worker's id is its session id). */
  function agentIdForSession(sessionId: string): string {
    const cs = caseBySession(sessionId);
    if (cs) return cs.agentId;
    for (const a of agents) if (a.kind === 'main' && (a.sessionId ?? a.id) === sessionId) return a.id;
    return sessionId;
  }

  /** Who should see an unsolicited message about a worker, session or request: the viewers of every case it is not "for another case". */
  function errorTargets(msg: Extract<HostToWebview, { type: 'error' }>): string[] {
    const out = new Set<string>();
    if (msg.agentId !== undefined || msg.sessionId !== undefined || msg.requestId !== undefined) {
      for (const cs of cases.values()) {
        const own: Parameters<typeof forAnotherCase>[1] = { agentId: cs.agentId };
        if (cs.sessionId !== undefined) {
          own.sessionId = cs.sessionId;
          const first = registry.first(cs.sessionId);
          if (first !== undefined) own.requestId = first.requestId;
        }
        if (!forAnotherCase(msg, own)) for (const v of cs.viewers) out.add(v);
      }
    }
    return out.size > 0 ? [...out] : [OFFICE_VIEW];
  }

  function postError(message: string, nonce?: string, ctx: ErrorCtx = {}): void {
    const msg: Extract<HostToWebview, { type: 'error' }> = { type: 'error', message: cut(message, LIMITS.errorChars) };
    if (nonce !== undefined) msg.nonce = nonce;
    if (ctx.sessionId !== undefined) msg.sessionId = ctx.sessionId;
    if (ctx.requestId !== undefined) msg.requestId = ctx.requestId;
    if (ctx.reqId !== undefined) msg.reqId = ctx.reqId;
    const agentId = ctx.agentId ?? (ctx.sessionId !== undefined ? agentIdForSession(ctx.sessionId) : undefined);
    if (agentId !== undefined) msg.agentId = agentId;
    sendTo(ctx.to ?? errorTargets(msg), msg);
  }

  function refreshAgents(): void {
    try {
      deps.refreshAgents?.();
    } catch {
      // ignore
    }
  }

  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log(`${what} failed: ${e instanceof Error ? e.message.length : 0} chars`);
    }
  }

  function liveIds(fresh = false): Set<string> {
    const t = now();
    if (!fresh && liveCache && t - liveCache.at < LIVE_TTL_MS) return liveCache.set;
    let set: Set<string>;
    try {
      set = new Set(deps.listLiveSessionIds());
    } catch {
      set = new Set();
    }
    liveCache = { at: t, set };
    return set;
  }

  function runnerIds(): Set<string> {
    return new Set(runs.keys());
  }

  function controlOf(agent: ControlAgent): AgentControl {
    return computeControl(agent, liveIds(), runnerIds());
  }

  function mainSessionId(agent: AgentSnapshot): string | undefined {
    return agent.kind === 'main' ? agent.sessionId ?? agent.id : undefined;
  }

  /** The agent for an id; a freshly hired office worker that the feed has not listed yet gets a stand-in. */
  function agentFor(id: string): AgentSnapshot | undefined {
    const a = byId.get(id);
    if (a) return a;
    const run = runs.get(id);
    if (!run) return undefined;
    const t = run.startedAt;
    return {
      id,
      kind: 'main',
      title: cut(run.prompt.replace(/\s+/g, ' ').trim(), 80),
      project: baseName(run.cwd),
      activity: 'thinking',
      status: 'working',
      since: t,
      startedAt: t,
      sessionId: id,
      cwd: run.cwd,
      control: 'office',
    };
  }

  // --- registry of pending requests ------------------------------------------------------------------------------

  const registry = new PendingRegistry({
    now,
    onAdded: (req) => guard('pending added', () => onPendingChanged(req.sessionId)),
    onRemoved: (req) => guard('pending removed', () => onPendingChanged(req.sessionId)),
    log,
  });

  function onPendingChanged(sessionId: string): void {
    refreshAgents();
    const cs = caseBySession(sessionId);
    if (!cs || !cs.ready) return;
    pushHeader(cs);
    queueAppend(cs, { pending: registry.first(sessionId) ?? null }, true);
  }

  // --- case file --------------------------------------------------------------------------------------------------

  function headerFor(agent: AgentSnapshot): CaseHeader {
    const sid = mainSessionId(agent);
    const run = sid !== undefined ? runs.get(sid) : undefined;
    const control: AgentControl = agent.kind === 'temp' ? 'none' : controlOf({ id: agent.id, kind: agent.kind, sessionId: agent.sessionId });
    const hasPending = sid !== undefined && registry.first(sid) !== undefined;
    const h: CaseHeader = {
      agentId: agent.id,
      title: agent.title,
      project: agent.project,
      activity: hasPending ? 'needsYou' : agent.activity,
      status: agent.status,
      control,
      busy: run ? run.runner.busy : false,
      canSetOptions: control === 'office' || control === 'free',
      next: sid !== undefined && nextOptions.has(sid) ? { ...nextOptions.get(sid)! } : {},
    };
    if (agent.sessionId !== undefined) h.sessionId = agent.sessionId;
    if (agent.cwd !== undefined) h.cwd = agent.cwd;
    if (agent.gitBranch !== undefined) h.gitBranch = agent.gitBranch;
    if (run) {
      if (run.runner.model !== undefined) h.model = run.runner.model;
      if (run.runner.permissionMode !== undefined) h.permissionMode = run.runner.permissionMode;
      h.costUsd = run.runner.costUsd;
    } else if (sid !== undefined && costBySession.has(sid)) {
      h.costUsd = costBySession.get(sid)!;
    }
    if (h.model === undefined && sid !== undefined && modelBySession.has(sid)) h.model = modelBySession.get(sid)!;
    // An office run's own effort wins while it has one; otherwise the latest the model layer read from the transcript.
    const effort = run?.runner.effort ?? agent.effort;
    if (effort !== undefined) h.effort = effort;
    return h;
  }

  function runSnapshot(run: Run): { items: ConversationItem[]; truncated: boolean } {
    const own = [...run.items.values()];
    const baseItems = (run.base?.items ?? []).filter((i) => !run.items.has(i.id));
    const all = [...baseItems, ...own];
    const over = all.length > LIMITS.caseItems;
    return { items: over ? all.slice(all.length - LIMITS.caseItems) : all, truncated: over || run.dropped || run.base?.truncated === true };
  }

  function upsert(run: Run, items: readonly ConversationItem[]): void {
    for (const item of items) {
      run.items.set(item.id, item);
      if (run.items.size > LIMITS.caseItems) {
        const oldest = run.items.keys().next().value;
        if (oldest !== undefined) run.items.delete(oldest);
        run.dropped = true;
      }
    }
  }

  function caseAgent(cs: CaseState): AgentSnapshot | undefined {
    const a = agentFor(cs.agentId);
    if (a) cs.agent = a;
    return a ?? cs.agent;
  }

  /** The open case of a session (main workers only; a session has one worker). */
  function caseBySession(sessionId: string): CaseState | undefined {
    for (const cs of cases.values()) if (cs.sessionId === sessionId) return cs;
    return undefined;
  }

  /** The open case that follows this run's stream, when it is ready and in run mode. */
  function liveCaseFor(run: Run): CaseState | undefined {
    if (run.sessionId === undefined) return undefined;
    const cs = caseBySession(run.sessionId);
    return cs !== undefined && cs.ready && cs.mode === 'run' ? cs : undefined;
  }

  function clearCaseTimers(cs: CaseState): void {
    if (cs.flushTimer !== undefined) timers.clearTimeout(cs.flushTimer);
    if (cs.pollTimer !== undefined) timers.clearTimeout(cs.pollTimer);
    cs.flushTimer = undefined;
    cs.pollTimer = undefined;
  }

  /** Forget a case: stop its timers, drop its queue and unregister every viewer. Post anything the viewers must hear BEFORE this. */
  function dropCase(cs: CaseState): void {
    clearCaseTimers(cs);
    cs.queue = { items: new Map(), pending: undefined, header: {} };
    if (cases.get(cs.agentId) === cs) cases.delete(cs.agentId);
    for (const v of cs.viewers) if (sourceCase.get(v) === cs.agentId) sourceCase.delete(v);
    cs.viewers.clear();
  }

  /** A webview stops viewing its case; the case is dropped when nobody else views it. */
  function detach(source: string): void {
    const id = sourceCase.get(source);
    if (id === undefined) return;
    sourceCase.delete(source);
    const cs = cases.get(id);
    if (!cs) return;
    cs.viewers.delete(source);
    if (cs.viewers.size === 0) dropCase(cs);
  }

  /** A webview starts viewing a worker's case (and stops viewing the one it had). */
  function attach(cs: CaseState, source: string): void {
    const prev = sourceCase.get(source);
    if (prev !== undefined && prev !== cs.agentId) detach(source);
    sourceCase.set(source, cs.agentId);
    cs.viewers.add(source);
  }

  function queueAppend(cs: CaseState, part: { items?: readonly ConversationItem[]; pending?: PendingRequest | null; header?: Partial<CaseHeader> }, immediate = false): void {
    if (!cs.ready) return;
    for (const item of part.items ?? []) cs.queue.items.set(item.id, item);
    if (part.pending !== undefined) cs.queue.pending = part.pending;
    if (part.header) Object.assign(cs.queue.header, part.header);
    if (immediate) flushCase(cs);
    else if (cs.flushTimer === undefined) cs.flushTimer = timers.setTimeout(() => guard('flush', () => flushCase(cs)), flushMs);
  }

  function flushCase(cs: CaseState): void {
    if (cs.flushTimer !== undefined) timers.clearTimeout(cs.flushTimer);
    cs.flushTimer = undefined;
    const q = cs.queue;
    const hasHeader = Object.keys(q.header).length > 0;
    if (q.items.size === 0 && q.pending === undefined && !hasHeader) return;
    const msg: Extract<HostToWebview, { type: 'caseAppend' }> = { type: 'caseAppend', agentId: cs.agentId, items: [...q.items.values()] };
    if (q.pending !== undefined) msg.pending = q.pending;
    if (hasHeader) msg.header = q.header;
    cs.queue = { items: new Map(), pending: undefined, header: {} };
    postCase(cs, msg);
  }

  /** Recompute the header and queue whatever changed since the last one sent. */
  function pushHeader(cs: CaseState | undefined): void {
    if (!cs || !cs.ready) return;
    const agent = caseAgent(cs);
    if (!agent) return;
    const h = headerFor(agent);
    const prev = cs.lastHeader;
    cs.lastHeader = h;
    if (!prev) return;
    const diff: Record<string, unknown> = {};
    for (const k of Object.keys(h) as (keyof CaseHeader)[]) {
      if (JSON.stringify(h[k]) !== JSON.stringify(prev[k])) diff[k] = h[k];
    }
    if (Object.keys(diff).length > 0) queueAppend(cs, { header: diff as Partial<CaseHeader> });
  }

  /** The current whole case file for some of its viewers (a webview that joins a case that is already open, or reloads). */
  function sendSnapshot(cs: CaseState, targets: readonly string[]): void {
    const agent = caseAgent(cs);
    if (!agent) return;
    const run = cs.mode === 'run' && cs.sessionId !== undefined ? runs.get(cs.sessionId) : undefined;
    let items: ConversationItem[];
    let truncated: boolean;
    if (run) ({ items, truncated } = runSnapshot(run));
    else {
      items = [...cs.known.values()].map((sig) => JSON.parse(sig) as ConversationItem);
      truncated = cs.truncated;
    }
    const pending = cs.sessionId !== undefined ? registry.first(cs.sessionId) ?? null : null;
    sendTo(targets, { type: 'caseFile', agentId: cs.agentId, header: headerFor(agent), items, pending, truncated });
  }

  /**
   * `source` opens the case of a worker. A webview shows one case at a time, so this stops it viewing its previous one.
   * The case state is built once per worker; a webview that joins a case that is already open only gets a snapshot.
   */
  async function openCase(agentId: string, source: string): Promise<void> {
    const existing = cases.get(agentId);
    if (existing) {
      attach(existing, source);
      if (existing.ready) sendSnapshot(existing, [source]); // still building: the build sends to every viewer when done
      return;
    }
    const agent = agentFor(agentId);
    if (!agent) {
      postError('That worker is no longer in the office.', undefined, { agentId, to: [source] });
      return;
    }
    const epoch = (caseEpochs.get(agentId) ?? 0) + 1;
    caseEpochs.set(agentId, epoch);
    const sid = mainSessionId(agent);
    const run = sid !== undefined ? runs.get(sid) : undefined;
    const cs: CaseState = {
      agentId,
      epoch,
      viewers: new Set(),
      mode: run ? 'run' : 'transcript',
      ready: false,
      seen: byId.has(agentId),
      known: new Map(),
      truncated: false,
      queue: { items: new Map(), pending: undefined, header: {} },
    };
    if (sid !== undefined) cs.sessionId = sid;
    cs.agent = agent;
    cases.set(agentId, cs);
    attach(cs, source);
    try {
      let items: ConversationItem[];
      let truncated: boolean;
      if (run) {
        await run.basePromise;
        if (cases.get(agentId) !== cs) return;
        ({ items, truncated } = runSnapshot(run));
      } else {
        const res = await deps.readCase(agent);
        if (cases.get(agentId) !== cs) return;
        items = res.items;
        truncated = res.truncated;
        for (const i of items) cs.known.set(i.id, JSON.stringify(i));
        cs.truncated = truncated;
      }
      const header = headerFor(caseAgent(cs) ?? agent);
      cs.lastHeader = header;
      cs.ready = true;
      postCase(cs, { type: 'caseFile', agentId, header, items, pending: sid !== undefined ? registry.first(sid) ?? null : null, truncated });
      if (cs.mode === 'transcript') scheduleCasePoll(cs);
    } catch (e) {
      log(`openCase failed: ${e instanceof Error ? e.message.length : 0} chars`);
      if (cases.get(agentId) === cs) {
        postCase(cs, { type: 'caseClosed', agentId, reason: 'error' });
        dropCase(cs);
      }
    }
  }

  function scheduleCasePoll(cs: CaseState): void {
    if (disposed) return;
    cs.pollTimer = timers.setTimeout(() => void pollCase(cs), caseRefreshMs);
  }

  async function pollCase(cs: CaseState): Promise<void> {
    cs.pollTimer = undefined;
    if (cases.get(cs.agentId) !== cs || cs.mode !== 'transcript' || disposed) return;
    const agent = caseAgent(cs);
    if (agent) {
      try {
        const res = await deps.readCase(agent);
        if (cases.get(cs.agentId) !== cs || cs.mode !== 'transcript') return;
        const changed: ConversationItem[] = [];
        for (const item of res.items) {
          const sig = JSON.stringify(item);
          if (cs.known.get(item.id) !== sig) {
            cs.known.set(item.id, sig);
            changed.push(item);
          }
        }
        cs.truncated = res.truncated;
        if (changed.length > 0) queueAppend(cs, { items: changed }, true);
      } catch (e) {
        log(`case refresh failed: ${e instanceof Error ? e.message.length : 0} chars`);
      }
    }
    if (cases.get(cs.agentId) === cs && cs.mode === 'transcript') scheduleCasePoll(cs);
  }

  /** A run for an open case's session has just begun: stream from the runner from now on. */
  function switchCaseToRun(run: Run): void {
    const cs = run.sessionId !== undefined ? caseBySession(run.sessionId) : undefined;
    if (!cs || cs.mode === 'run') return;
    cs.mode = 'run';
    if (cs.pollTimer !== undefined) timers.clearTimeout(cs.pollTimer);
    cs.pollTimer = undefined;
    if (!cs.ready) return;
    pushHeader(cs);
    queueAppend(cs, { items: [...run.items.values()] }, true);
  }

  /** The run for an open case's session is over: re-read the transcript (authoritative) and keep following it. */
  async function switchCaseToTranscript(sessionId: string): Promise<void> {
    const cs = caseBySession(sessionId);
    if (!cs || !cs.ready || cs.mode !== 'run') return;
    cs.mode = 'transcript';
    const agent = caseAgent(cs);
    if (!agent) return;
    flushCase(cs);
    try {
      const res = await deps.readCase(agent);
      if (cases.get(cs.agentId) !== cs) return;
      cs.known.clear();
      for (const i of res.items) cs.known.set(i.id, JSON.stringify(i));
      cs.truncated = res.truncated;
      const header = headerFor(agent);
      cs.lastHeader = header;
      postCase(cs, { type: 'caseFile', agentId: cs.agentId, header, items: res.items, pending: registry.first(sessionId) ?? null, truncated: res.truncated });
    } catch (e) {
      log(`final refresh failed: ${e instanceof Error ? e.message.length : 0} chars`);
    }
    if (cases.get(cs.agentId) === cs) scheduleCasePoll(cs);
  }

  // --- runs ---------------------------------------------------------------------------------------------------------

  function echoPrompt(run: Run, text: string): void {
    const id = `local:${run.sessionId ?? 'new'}:${++run.echoN}`;
    const item: ConversationItem = { kind: 'prompt', id, at: now(), text: cut(text, LIMITS.promptChars) };
    upsert(run, [item]);
    const cs = liveCaseFor(run);
    if (cs) queueAppend(cs, { items: [item] }, true);
  }

  /**
   * The tracker a run's item builder gets. It reads and seeds the shared tracker, but a result the RUNNER has just
   * observed is answered from the runner's own observation. Without this the builder would observe the same
   * `total_cost_usd` a second time (the runner always sees a result first) and report a turn cost of 0.
   */
  function costViewFor(run: Run): CostTracker {
    return {
      seed: (sid, usd) => cost.seed(sid, usd),
      observe: (sid, total) => {
        const seen = run.lastCost;
        if (seen !== undefined && seen.totalUsd === total) {
          run.lastCost = undefined;
          return { turnUsd: seen.turnUsd, totalUsd: seen.totalUsd };
        }
        return cost.observe(sid, total);
      },
      total: (sid) => cost.total(sid),
      sum: () => cost.sum(),
      forget: (sid) => cost.forget(sid),
    };
  }

  interface StartRunArgs {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    model?: string;
    effort?: EffortLevel;
    resume?: string;
    nonce?: string;
    agent?: AgentSnapshot;
    binaryPath: string;
    /** The webview that asked for this run. */
    source: string;
  }

  function startRun(a: StartRunArgs): Run {
    const run: Run = {
      runner: undefined as unknown as SessionRunner,
      cwd: a.cwd,
      builder: undefined as unknown as SdkItemBuilderLike,
      items: new Map(),
      dropped: false,
      echoN: 0,
      prompt: a.prompt,
      startedAt: now(),
      source: a.source,
    };
    if (a.nonce !== undefined) run.nonce = a.nonce;
    const view = costViewFor(run);
    run.builder = deps.createSdkItemBuilder(a.resume !== undefined ? { cost: view, sessionId: a.resume } : { cost: view });
    const runnerDeps: ConstructorParameters<typeof SessionRunner>[0] = {
      queryFn: deps.queryFn,
      pending: registry,
      log,
      cost,
      listener: {
        onSessionId: (id) => guard('onSessionId', () => onRunSessionId(run, id)),
        onMessage: (msg) => guard('onMessage', () => onRunMessage(run, msg)),
        onState: (_s, changed) => guard('onState', () => onRunState(run, changed)),
        onNotice: (n) => guard('onNotice', () => onRunNotice(run, n.message)),
        onEnd: (info) => guard('onEnd', () => onRunEnd(run, info)),
        onResult: (r) => {
          run.lastCost = { totalUsd: r.totalCostUsd, turnUsd: r.turnCostUsd };
        },
        onRateLimit: (w) => guard('onRateLimit', () => deps.onRateLimit?.(w)),
        onContextWindow: (model, window) => guard('onContextWindow', () => learnWindow(model, window)),
      },
    };
    if (deps.env !== undefined) runnerDeps.env = deps.env;
    runnerDeps.graceMs = deps.graceMs ?? 1000;
    if (deps.timers !== undefined) runnerDeps.timers = timers;
    if (a.resume !== undefined) {
      const prior = cost.total(a.resume) ?? costBySession.get(a.resume);
      if (prior !== undefined) runnerDeps.initialCostUsd = prior;
    }
    run.runner = new SessionRunner(runnerDeps);
    if (a.resume !== undefined) {
      run.sessionId = a.resume;
      runs.set(a.resume, run);
      lastMode.set(a.resume, a.permissionMode);
      if (a.agent) {
        run.basePromise = deps
          .readCase(a.agent)
          .then((r) => {
            run.base = r;
          })
          .catch(() => undefined);
      }
    } else {
      starting.add(run);
      run.startTimer = timers.setTimeout(() => guard('start timeout', () => onStartTimeout(run)), startTimeoutMs);
    }
    echoPrompt(run, a.prompt);
    const params: Parameters<SessionRunner['start']>[0] = {
      cwd: a.cwd,
      prompt: a.prompt,
      permissionMode: a.permissionMode,
      binaryPath: a.binaryPath,
    };
    if (a.model !== undefined) params.model = a.model;
    if (a.effort !== undefined) params.effort = a.effort;
    if (a.resume !== undefined) params.resume = a.resume;
    run.runner.start(params);
    liveCache = undefined;
    switchCaseToRun(run);
    refreshAgents();
    return run;
  }

  function onStartTimeout(run: Run): void {
    run.startTimer = undefined;
    if (run.sessionId !== undefined || disposed) return;
    if (run.nonce !== undefined) {
      postError('Claude Code did not start in time. Check that you are signed in and try again.', run.nonce, { to: [run.source] });
      delete run.nonce;
    }
    void run.runner.stop();
  }

  function onRunSessionId(run: Run, id: string): void {
    const known = runs.get(id);
    if (known !== undefined && known !== run) {
      postError('That session is already running in the office.', run.nonce, { sessionId: id, to: runTargets(run) });
      delete run.nonce;
      void run.runner.stop();
      return;
    }
    run.sessionId = id;
    runs.set(id, run);
    starting.delete(run);
    if (run.startTimer !== undefined) timers.clearTimeout(run.startTimer);
    run.startTimer = undefined;
    lastMode.set(id, run.runner.permissionMode ?? 'default');
    if (run.nonce !== undefined) {
      sendTo([run.source], { type: 'taskStarted', nonce: run.nonce, sessionId: id, agentId: id });
      delete run.nonce;
    }
    liveCache = undefined;
    switchCaseToRun(run);
    refreshAgents();
  }

  function onRunMessage(run: Run, msg: unknown): void {
    const items = deps.itemsFromSdkMessage(msg, run.builder);
    if (items.length === 0) return;
    upsert(run, items);
    const cs = liveCaseFor(run);
    if (cs) queueAppend(cs, { items });
  }

  function onRunState(run: Run, changed: readonly string[]): void {
    if (run.sessionId !== undefined) {
      if (changed.includes('costUsd')) {
        costBySession.set(run.sessionId, run.runner.costUsd);
        refreshAgents();
      }
      if (changed.includes('model') && run.runner.model !== undefined) modelBySession.set(run.sessionId, run.runner.model);
      if (changed.includes('model') || changed.includes('effort') || changed.includes('contextWindow')) refreshAgents();
      if (changed.includes('permissionMode') && run.runner.permissionMode !== undefined) lastMode.set(run.sessionId, run.runner.permissionMode);
    }
    pushHeader(liveCaseFor(run));
  }

  /** Where a run's own errors go: the webview that asked for it (while its nonce is still open) and the viewers of its case. */
  function runTargets(run: Run): string[] {
    const out = new Set<string>();
    if (run.nonce !== undefined) out.add(run.source);
    const cs = run.sessionId !== undefined ? caseBySession(run.sessionId) : undefined;
    if (cs) for (const v of cs.viewers) out.add(v);
    return out.size > 0 ? [...out] : [OFFICE_VIEW];
  }

  function onRunNotice(run: Run, message: string): void {
    const ctx = run.sessionId !== undefined ? { sessionId: run.sessionId } : {};
    if (run.nonce !== undefined) {
      postError(message, run.nonce, { ...ctx, to: runTargets(run) });
      delete run.nonce;
    } else {
      postError(message, undefined, ctx);
    }
  }

  function onRunEnd(run: Run, info: { reason: 'finished' | 'stopped' | 'error'; message?: string }): void {
    if (run.startTimer !== undefined) timers.clearTimeout(run.startTimer);
    run.startTimer = undefined;
    starting.delete(run);
    const sid = run.sessionId;
    if (sid === undefined) {
      if (run.nonce !== undefined) {
        postError(info.message ?? 'Claude Code stopped before the task started.', run.nonce, { to: [run.source] });
        delete run.nonce;
      }
      refreshAgents();
      return;
    }
    if (runs.get(sid) === run) runs.delete(sid);
    costBySession.set(sid, run.runner.costUsd);
    if (run.runner.model !== undefined) modelBySession.set(sid, run.runner.model);
    registry.cancelSession(sid);
    liveCache = undefined;
    if (info.reason === 'error' && info.message !== undefined) {
      const item: ConversationItem = { kind: 'notice', id: `run-end:${sid}:${run.echoN}:${now()}`, at: now(), notice: 'error', text: cut(info.message, LIMITS.toolPreviewChars) };
      upsert(run, [item]);
      const cs = liveCaseFor(run);
      if (cs) queueAppend(cs, { items: [item] }, true);
    }
    if (disposed) return;
    refreshAgents();
    // The run's process drops its sessions/<pid>.json shortly after it ends: publish again so `control` settles.
    for (const ms of [1200, 3500]) {
      const h = timers.setTimeout(() => {
        loose.delete(h);
        if (disposed) return;
        liveCache = undefined;
        refreshAgents();
        pushHeader(caseBySession(sid));
      }, ms);
      loose.add(h);
    }
    void switchCaseToTranscript(sid).catch(() => undefined);
  }

  // --- message handlers -----------------------------------------------------------------------------------------------

  async function binaryOrError(source: string, nonce?: string, sessionId?: string): Promise<string | undefined> {
    const ctx = sessionId !== undefined ? { sessionId, to: [source] } : { to: [source] };
    let found: FindBinaryResult;
    try {
      found = await deps.findBinary();
    } catch (e) {
      postError(`Could not look for Claude Code: ${e instanceof Error ? e.message : 'unknown error'}`, nonce, ctx);
      return undefined;
    }
    if ('error' in found) {
      postError(found.error, nonce, ctx);
      return undefined;
    }
    return found.path;
  }

  function projectsMessage(defaultPath?: string): HostToWebview {
    const list = listProjects({
      workspaceFolders: safeList(deps.workspaceFolders),
      recentCwds: recentCwdsFrom(agents),
      browsed,
      exists: deps.exists,
      readFile: projectFs.readFile,
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    });
    const msg: Extract<HostToWebview, { type: 'projects' }> = { type: 'projects', projects: list };
    if (defaultPath !== undefined) msg.defaultPath = defaultPath;
    return msg;
  }

  function safeList(fn: () => string[]): string[] {
    try {
      return fn();
    } catch {
      return [];
    }
  }

  /** The folder to preselect: the one of the worker this webview has open, else the first workspace folder. */
  function defaultProject(source: string): string | undefined {
    const open = sourceCase.get(source);
    if (open !== undefined) {
      const cwd = agentFor(open)?.cwd;
      if (cwd !== undefined) return cwd;
    }
    return safeList(deps.workspaceFolders)[0];
  }

  /** The model to resume with: the explicit one, else what this host's runner last reported, else the transcript's. */
  async function resumeModel(sid: string, explicit: string | undefined): Promise<string | undefined> {
    if (explicit !== undefined) {
      log(`resuming ${sid} on ${explicit} (chosen)`);
      return explicit;
    }
    let model = modelBySession.get(sid);
    let from = 'last run';
    if (model === undefined && deps.lastModelFor) {
      try {
        model = await deps.lastModelFor(sid);
      } catch {
        model = undefined;
      }
      from = 'transcript';
    }
    if (model !== undefined) {
      modelBySession.set(sid, model);
      log(`resuming ${sid} on ${model} (${from})`);
    } else {
      log(`resuming ${sid} without a model (none found; Claude Code default applies)`);
    }
    return model;
  }

  /**
   * Seed the shared cost tracker from the transcript, so the first result of a resumed session counts only its own turn.
   * Nothing to do when the tracker already knows the session (a run of this host observed it) or no reader is given.
   */
  async function seedResumeCost(sid: string): Promise<void> {
    if (cost.total(sid) !== undefined || !deps.readTranscriptTail) return;
    try {
      const text = await deps.readTranscriptTail(sid);
      if (text !== undefined && text !== '') seedCostFromTranscript(parseJsonl(text), sid, cost);
    } catch {
      // no baseline: the first result of the resumed session is counted as it comes
    }
  }

  /** The model to resume with: an explicit choice, else the stored next option (`null` = Claude Code's default), else the usual lookup. */
  async function modelToResume(sid: string, explicit: string | undefined, next: SessionOptions | undefined): Promise<string | undefined> {
    if (explicit === undefined && next?.model !== undefined) {
      if (next.model === null) {
        log(`resuming ${sid} on the default model (chosen)`);
        return undefined;
      }
      return resumeModel(sid, next.model);
    }
    return resumeModel(sid, explicit);
  }

  /** A resume used the options stored for it: forget them (unless the user changed them while we were busy) and update the chips. */
  function consumeNext(sid: string, used: SessionOptions | undefined): void {
    if (used === undefined || nextOptions.get(sid) !== used) return;
    nextOptions.delete(sid);
    guard('header', () => pushHeader(caseBySession(sid)));
  }

  async function onNewTask(msg: Extract<WebviewToHost, { type: 'newTask' }>, source: string): Promise<void> {
    const nonce = msg.nonce;
    const to = [source];
    if (msg.assignTo.kind === 'new') {
      if (!isDir(msg.projectPath)) {
        postError(`The folder "${cut(msg.projectPath, 200)}" does not exist.`, nonce, { to });
        return;
      }
      const binaryPath = await binaryOrError(source, nonce);
      if (binaryPath === undefined) return;
      const args: StartRunArgs = { cwd: msg.projectPath, prompt: msg.prompt, permissionMode: msg.permissionMode, nonce, binaryPath, source };
      if (msg.model !== undefined) args.model = msg.model;
      if (msg.effort !== undefined) args.effort = msg.effort;
      startRun(args);
      return;
    }
    const sid = msg.assignTo.sessionId;
    const existing = runs.get(sid);
    if (existing) {
      // Already an office worker: the task is simply its next message.
      if (!existing.runner.send(msg.prompt)) {
        postError('This worker is shutting down. Try again in a moment.', nonce, { sessionId: sid, to });
        return;
      }
      echoPrompt(existing, msg.prompt);
      sendTo(to, { type: 'taskStarted', nonce, sessionId: sid, agentId: sid });
      return;
    }
    const agent = byId.get(sid);
    if (!agent || agent.kind !== 'main') {
      postError('That worker is not in the office any more.', nonce, { sessionId: sid, to });
      return;
    }
    const pre = checkResume(sid, liveIds(true), runnerIds());
    if (!pre.ok) {
      postError(pre.message, nonce, { sessionId: sid, to });
      return;
    }
    const cwd = agent.cwd ?? msg.projectPath;
    if (!isDir(cwd)) {
      postError(`The folder "${cut(cwd, 200)}" does not exist.`, nonce, { sessionId: sid, to });
      return;
    }
    const binaryPath = await binaryOrError(source, nonce, sid);
    if (binaryPath === undefined) return;
    // Synchronous re-check right before spawning (nothing awaited between here and start).
    const post2 = checkResume(sid, liveIds(true), runnerIds());
    if (!post2.ok) {
      postError(post2.message, nonce, { sessionId: sid, to });
      return;
    }
    await seedResumeCost(sid);
    const next = nextOptions.get(sid);
    const model = await modelToResume(sid, msg.model, next);
    const post3 = checkResume(sid, liveIds(true), runnerIds());
    if (!post3.ok) {
      postError(post3.message, nonce, { sessionId: sid, to });
      return;
    }
    // The task form's own choices win over what was stored on the case-file header.
    const effort = msg.effort ?? (next?.effort === null ? undefined : next?.effort);
    const args: StartRunArgs = { cwd, prompt: msg.prompt, permissionMode: msg.permissionMode, resume: sid, nonce, agent, binaryPath, source };
    if (model !== undefined) args.model = model;
    if (effort !== undefined) args.effort = effort;
    startRun(args);
    consumeNext(sid, next);
  }

  async function onReply(msg: Extract<WebviewToHost, { type: 'reply' }>, source: string): Promise<void> {
    const sid = msg.sessionId;
    const to = [source];
    const run = runs.get(sid);
    if (run) {
      if (!run.runner.send(msg.text)) {
        postError('This worker is shutting down. Try again in a moment.', undefined, { sessionId: sid, to });
        return;
      }
      echoPrompt(run, msg.text);
      return;
    }
    const agent = byId.get(sid);
    if (!agent || agent.kind !== 'main') {
      postError('That worker is not in the office any more.', undefined, { sessionId: sid, to });
      return;
    }
    const pre = checkResume(sid, liveIds(true), runnerIds());
    if (!pre.ok) {
      postError(pre.control === 'elsewhere' ? 'This session is open in another Claude Code window or terminal, so the office cannot reply to it. Use "Open in Claude Code".' : pre.message, undefined, { sessionId: sid, to });
      return;
    }
    const cwd = agent.cwd;
    if (cwd === undefined || !isDir(cwd)) {
      postError('The project folder of this session is not available.', undefined, { sessionId: sid, to });
      return;
    }
    const binaryPath = await binaryOrError(source, undefined, sid);
    if (binaryPath === undefined) return;
    const again = runs.get(sid);
    if (again) {
      if (again.runner.send(msg.text)) echoPrompt(again, msg.text);
      return;
    }
    await seedResumeCost(sid);
    const next = nextOptions.get(sid);
    const model = await modelToResume(sid, undefined, next);
    const again2 = runs.get(sid);
    if (again2) {
      if (again2.runner.send(msg.text)) echoPrompt(again2, msg.text);
      return;
    }
    const post2 = checkResume(sid, liveIds(true), runnerIds());
    if (!post2.ok) {
      postError(post2.message, undefined, { sessionId: sid, to });
      return;
    }
    const effort = next?.effort === null ? undefined : next?.effort;
    startRun({
      cwd,
      prompt: msg.text,
      permissionMode: next?.permissionMode ?? lastMode.get(sid) ?? 'default',
      resume: sid,
      agent,
      binaryPath,
      source,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
    consumeNext(sid, next);
  }

  // --- options, plans, turns -----------------------------------------------------------------------------------------

  /** Keep only what a webview may change. `bypassPermissions` cannot get through: it is not a PermissionMode. */
  function cleanOptions(o: SessionOptions): SessionOptions | undefined {
    const out: SessionOptions = {};
    if (o.model !== undefined) {
      if (o.model !== null && (typeof o.model !== 'string' || o.model.trim() === '')) return undefined;
      out.model = o.model;
    }
    if (o.effort !== undefined) {
      if (o.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(o.effort)) return undefined;
      out.effort = o.effort;
    }
    if (o.permissionMode !== undefined) {
      if (!(PERMISSION_MODES as readonly string[]).includes(o.permissionMode)) return undefined;
      out.permissionMode = o.permissionMode;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function onSetOptions(msg: Extract<WebviewToHost, { type: 'setSessionOptions' }>, source: string): Promise<void> {
    const { nonce, sessionId } = msg;
    const ctx = { sessionId, to: [source] };
    const options = cleanOptions(msg.options);
    if (options === undefined) {
      postError('That setting is not allowed.', nonce, ctx);
      return;
    }
    const run = runs.get(sessionId);
    if (run) {
      const res = await run.runner.setOptions(options);
      if (!res.ok) {
        postError(res.message, nonce, ctx);
        pushHeader(liveCaseFor(run));
        return;
      }
      sendTo(ctx.to, {
        type: 'sessionOptions',
        nonce,
        sessionId,
        applied: res.deferredToNextTurn ? {} : res.applied,
        deferred: res.deferredToNextTurn ? res.applied : {},
      });
      refreshAgents();
      pushHeader(liveCaseFor(run));
      return;
    }
    const agent = byId.get(sessionId);
    if (agent && agent.kind === 'main') {
      const control = computeControl({ id: agent.id, kind: agent.kind, sessionId: agent.sessionId }, liveIds(true), runnerIds());
      if (control === 'free') {
        nextOptions.set(sessionId, { ...nextOptions.get(sessionId), ...options });
        sendTo(ctx.to, { type: 'sessionOptions', nonce, sessionId, applied: {}, deferred: options });
        guard('header', () => pushHeader(caseBySession(sessionId)));
        return;
      }
      if (control === 'elsewhere') {
        postError('This session is running in Claude Code itself, so the office cannot change it. Use /model or /effort in Claude Code.', nonce, ctx);
        return;
      }
    }
    postError('That worker is not in the office any more.', nonce, ctx);
  }

  async function onGetPlan(msg: Extract<WebviewToHost, { type: 'getPlan' }>, source: string): Promise<void> {
    const { reqId, agentId, planId } = msg;
    const to = [source];
    const run = runs.get(agentId);
    if (run) {
      await run.basePromise;
      const item = runSnapshot(run).items.find((i) => i.kind === 'plan' && i.id === planId);
      if (item !== undefined && item.kind === 'plan') {
        const out: Extract<HostToWebview, { type: 'planText' }> = { type: 'planText', reqId, agentId, planId, text: item.text, status: item.status };
        if (item.truncated === true) out.truncated = true;
        if (item.planFilePath !== undefined) out.planFilePath = item.planFilePath;
        if (item.feedback !== undefined) out.feedback = item.feedback;
        sendTo(to, out);
        return;
      }
    }
    let found: PlanText | undefined;
    try {
      found = deps.planText?.(agentId, planId);
    } catch {
      found = undefined;
    }
    if (found === undefined) {
      postError('That plan is no longer available.', undefined, { reqId, agentId, to });
      return;
    }
    const out: Extract<HostToWebview, { type: 'planText' }> = { type: 'planText', reqId, agentId, planId, text: found.text, status: found.status };
    if (found.truncated) out.truncated = true;
    if (found.planFilePath !== undefined) out.planFilePath = found.planFilePath;
    if (found.feedback !== undefined) out.feedback = found.feedback;
    sendTo(to, out);
  }

  /**
   * The output of the latest finished turn: the items after the last prompt (the prompt itself is left out). While a
   * run is busy its newest turn is still going, so the one before it is the last finished. Cut to the LAST
   * `LIMITS.turnItems` items (the end of a turn holds its report).
   */
  function lastTurn(all: readonly ConversationItem[], busy: boolean, sourceTruncated: boolean): { items: ConversationItem[]; truncated: boolean } {
    const segments: ConversationItem[][] = [[]];
    for (const item of all) {
      if (item.kind === 'prompt') segments.push([]);
      else segments[segments.length - 1]!.push(item);
    }
    if (busy && segments.length > 1) segments.pop();
    let at = segments.length - 1;
    while (at > 0 && segments[at]!.length === 0) at--;
    const seg = segments[at]!;
    const over = seg.length > LIMITS.turnItems;
    return { items: over ? seg.slice(seg.length - LIMITS.turnItems) : seg, truncated: over || (at === 0 && sourceTruncated) };
  }

  async function onGetTurn(msg: Extract<WebviewToHost, { type: 'getTurn' }>, source: string): Promise<void> {
    const { reqId, agentId } = msg;
    const to = [source];
    const run = runs.get(agentId);
    let result: { items: ConversationItem[]; truncated: boolean };
    if (run) {
      await run.basePromise;
      const snap = runSnapshot(run);
      result = lastTurn(snap.items, run.runner.busy, snap.truncated);
    } else {
      const agent = agentFor(agentId);
      if (!agent) {
        postError('That worker is no longer in the office.', undefined, { reqId, agentId, to });
        return;
      }
      let read: CaseRead;
      try {
        read = await deps.readCase(agent);
      } catch {
        postError('Could not read that worker\'s transcript.', undefined, { reqId, agentId, to });
        return;
      }
      result = lastTurn(read.items, false, read.truncated);
    }
    sendTo(to, { type: 'turn', reqId, agentId, items: result.items, truncated: result.truncated });
  }

  async function onInterrupt(sessionId: string, source: string): Promise<void> {
    const run = runs.get(sessionId);
    if (!run) {
      postError('That worker is not running in the office.', undefined, { sessionId, to: [source] });
      return;
    }
    if (run.runner.busy || registry.list(sessionId).length > 0) run.builder.markInterrupted();
    await run.runner.interrupt();
  }

  async function onOpenInClaudeCode(sessionId: string, source: string): Promise<void> {
    try {
      await deps.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);
      return;
    } catch (e) {
      log(`open command failed: ${e instanceof Error ? e.message.length : 0} chars`);
    }
    if (deps.openUri) {
      try {
        const ok = await deps.openUri(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`);
        if (ok !== false) return;
      } catch {
        // fall through
      }
    }
    postError('Could not open this session in Claude Code. Is the Claude Code extension installed?', undefined, { sessionId, to: [source] });
  }

  async function onBrowse(source: string): Promise<void> {
    let picked: string | undefined;
    try {
      picked = await deps.showOpenDialog();
    } catch (e) {
      postError(`Could not show the folder dialog: ${e instanceof Error ? e.message : 'unknown error'}`, undefined, { to: [source] });
      return;
    }
    if (picked === undefined || picked === '') {
      sendTo([source], projectsMessage(defaultProject(source)));
      return;
    }
    const key = picked.toLowerCase();
    const i = browsed.findIndex((b) => b.toLowerCase() === key);
    if (i >= 0) browsed.splice(i, 1);
    browsed.unshift(picked);
    if (browsed.length > MAX_BROWSED) browsed.length = MAX_BROWSED;
    sendTo([source], projectsMessage(picked));
  }

  function onDecide(msg: Extract<WebviewToHost, { type: 'decide' }>, source: string): void {
    const pending = registry.get(msg.requestId);
    const sessionId = pending?.sessionId;
    const approves = msg.decision.kind === 'plan' ? msg.decision.approve : msg.decision.kind === 'allow';
    log(`decision ${msg.requestId} kind ${msg.decision.kind} approves ${approves} matched ${pending !== undefined}`);
    const out = registry.decide(msg.requestId, msg.decision);
    if (out.ok) return;
    if (out.duplicate) {
      log('duplicate decision ignored');
      return;
    }
    postError(out.message, undefined, sessionId !== undefined ? { sessionId, requestId: msg.requestId, to: [source] } : { requestId: msg.requestId, to: [source] });
  }

  // --- public API ---------------------------------------------------------------------------------------------------

  /** A tab (`case:<agentId>`) is bound to one worker; it may only open that one. */
  function sourceMayOpen(source: string, agentId: string): boolean {
    return !source.startsWith('case:') || source.slice('case:'.length) === agentId;
  }

  async function handle(msg: WebviewToHost, source: string = OFFICE_VIEW): Promise<void> {
    if (disposed) return;
    try {
      switch (msg.type) {
        case 'ready': {
          // A reloaded webview gets its open case again; a case tab has none yet, so it gets its bound worker's.
          const open = sourceCase.get(source) ?? (source.startsWith('case:') ? source.slice('case:'.length) : undefined);
          if (open !== undefined) await openCase(open, source);
          return;
        }
        case 'listProjects':
          sendTo([source], projectsMessage(defaultProject(source)));
          return;
        case 'browseProject':
          await onBrowse(source);
          return;
        case 'openCase':
          if (!sourceMayOpen(source, msg.agentId)) {
            log('openCase from a case tab for another worker dropped');
            return;
          }
          await openCase(msg.agentId, source);
          return;
        case 'closeCase':
          detach(source);
          return;
        case 'newTask':
          await onNewTask(msg, source);
          return;
        case 'reply':
          await onReply(msg, source);
          return;
        case 'decide':
          onDecide(msg, source);
          return;
        case 'interrupt':
          await onInterrupt(msg.sessionId, source);
          return;
        case 'setSessionOptions':
          await onSetOptions(msg, source);
          return;
        case 'getPlan':
          await onGetPlan(msg, source);
          return;
        case 'getTurn':
          await onGetTurn(msg, source);
          return;
        case 'openInClaudeCode':
          await onOpenInClaudeCode(msg.sessionId, source);
          return;
      }
    } catch (e) {
      log(`handle ${msg.type} failed: ${e instanceof Error ? e.message.length : 0} chars`);
      const text = `Something went wrong (${msg.type}). ${e instanceof Error ? e.message : ''}`.trim();
      const to = [source];
      if (msg.type === 'setSessionOptions') postError(text, msg.nonce, { sessionId: msg.sessionId, to });
      else if (msg.type === 'getPlan' || msg.type === 'getTurn') postError(text, undefined, { reqId: msg.reqId, agentId: msg.agentId, to });
      else if (msg.type === 'openCase') postError(text, undefined, { agentId: msg.agentId, to });
      else postError(text, msg.type === 'newTask' ? msg.nonce : undefined, { to });
    }
  }

  function closeSource(source: string): void {
    if (disposed) return;
    detach(source);
  }

  /**
   * Stop an office run, but only an idle one: nothing pending and no turn running. The check and the stop happen with no
   * await in between, so a request cannot slip in; a reply that arrives while the run winds down gets the usual
   * "shutting down" error. The run's end handler does the rest (case back to the transcript, feed refresh).
   */
  function stopIfIdle(sessionId: string): boolean {
    if (disposed) return false;
    const run = runs.get(sessionId);
    if (!run || run.runner.ended || run.runner.busy || registry.list(sessionId).length > 0) return false;
    registry.cancelSession(sessionId);
    void run.runner.stop().catch(() => undefined);
    return true;
  }

  function onAgents(snapshots: readonly AgentSnapshot[]): void {
    if (disposed) return;
    agents = [...snapshots];
    byId.clear();
    for (const a of agents) byId.set(a.id, a);
    liveCache = undefined;
    for (const cs of [...cases.values()]) {
      if (byId.has(cs.agentId)) cs.seen = true;
      else if (cs.seen || !runs.has(cs.agentId)) {
        postCase(cs, { type: 'caseClosed', agentId: cs.agentId, reason: 'agentGone' });
        dropCase(cs);
        continue;
      }
      guard('header', () => pushHeader(cs));
    }
  }

  function getOfficeInfo(sessionId: string): OfficeInfo | undefined {
    const run = runs.get(sessionId);
    const spent = run ? run.runner.costUsd : costBySession.get(sessionId);
    const first = registry.first(sessionId);
    if (!first && !run && (spent === undefined || spent <= 0)) return undefined;
    const info: OfficeInfo = {};
    if (first) info.pending = { requestId: first.requestId, kind: first.kind };
    if (spent !== undefined && spent > 0) info.costUsd = spent;
    if (run) {
      const st = run.runner.state;
      if (st.model !== undefined) info.model = st.model;
      if (st.effort !== undefined) info.effort = st.effort;
      if (st.contextTokens !== undefined) {
        const win = st.contextWindow !== undefined ? { max: st.contextWindow } : contextWindowFor(st.model, windows, st.contextTokens);
        info.context = { tokens: st.contextTokens, max: win.max, pct: contextPercent(st.contextTokens, win.max) };
        if ('approx' in win && win.approx === true) info.context.approx = true;
      }
    }
    return Object.keys(info).length > 0 ? info : undefined;
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    registry.cancelAll();
    disposed = true;
    for (const cs of cases.values()) clearCaseTimers(cs);
    cases.clear();
    sourceCase.clear();
    for (const h of loose) timers.clearTimeout(h);
    loose.clear();
    const all = new Set<Run>([...runs.values(), ...starting]);
    for (const r of all) if (r.startTimer !== undefined) timers.clearTimeout(r.startTimer);
    await Promise.all([...all].map((r) => r.runner.stop().catch(() => undefined)));
    runs.clear();
    starting.clear();
  }

  return {
    handle,
    closeSource,
    stopIfIdle,
    onAgents,
    getOfficeInfo,
    controlFor: (agent) => controlOf(agent),
    contextWindows: windows,
    dispose,
  };
}
