import type { Activity, AgentControl, AgentSnapshot, AgentStatus, ApprovalKind, EffortLevel, PendingKind } from '../shared/protocol.ts';
import { EFFORT_LEVELS, LIMITS } from '../shared/protocol.ts';
import type { LiveStatus, SessionInfo, SubagentInfo, SubagentMeta, WatchUpdate } from '../claude/types.ts';
import { basename, classifyTool, EDIT_TOOLS, RUN_TOOLS } from './activity.ts';
import type { ToolClass } from './activity.ts';
import { contextPercent, contextWindowFor } from './contextWindow.ts';
import { PlanIndex, rejectionFeedback } from './planIndex.ts';
import type { PlanText } from './planIndex.ts';

/*
 * Activity precedence (first match wins). `now` is the clock for live snapshots; while records are
 * being replayed it is the record's own timestamp and the live status file is ignored.
 *
 *  0.5 Office pending request (Manager Mode): when the `officeInfo` lookup reports an open permission /
 *     question / plan request for a main session, it wins over everything below (and over step 0):
 *     activity needsYou, status waiting, detail "Approve: <tool>" / "Question for you" / "Plan ready".
 *     `since` is when that requestId was first seen by a snapshot and stays stable while it is open.
 *     When the request clears the normal rules resume. Applied at snapshot() time only; the replayed
 *     state is untouched.
 *  0. Stale main session: the pid is not alive (or there is no live file) and the transcript has not
 *     changed for 10 min -> idle.
 *  1. needsYou:
 *       a. live status `waiting` (pid alive)
 *       b. an AskUserQuestion / ExitPlanMode call open for more than 4 s
 *       c. an Edit / MultiEdit / Write / NotebookEdit call open for more than 15 s, unless the live
 *          status is `busy` and was updated within the last 15 s (approval prompt heuristic).
 *     Bash is deliberately not in (c): it legitimately runs long, so only (a) can flag it.
 *     Under 4 s an open AskUserQuestion looks like `thinking`; an ExitPlanMode like `planning`.
 *  2. An open tool call (the newest one) -> classifyTool(). An open Bash/PowerShell older than 20 s
 *     becomes `copier` (the detail is kept). Agent/Task -> delegating.
 *     Lingering tool: when a tool's result arrives, that tool (the most recently started one) keeps
 *     being reported, with `since` = its tool_use time, for LINGER_MS after the result. Results often
 *     land a few ms after the call, so without this the poses would never be seen. The linger ends
 *     early on another tool_use (that one is then open), a prompt, an interrupt, the end of the turn,
 *     or a compaction. After it expires the agent is `thinking`.
 *  3. Compacting: the last real entry is system `compact_boundary`, for at most 60 s -> shredding.
 *  4. Live status `idle` (pid alive), nothing open, and the status is not older than the last entry
 *     -> idle.
 *  4b. A lingering tool (see above) -> its classified activity and detail.
 *  5. Thinking: the last real entry is an api-request, a prompt, a tool_result, or an assistant
 *     thinking / text / tool_use block whose stop_reason is not an end of turn.
 *  6. Idle: assistant text with stop_reason end_turn (or stop_sequence, max_tokens, refusal), system
 *     `turn_duration`, an interrupt, or nothing known.
 *
 * Temp (subagent) lifecycle. A temp is finished by the earliest of these signals:
 *   - meta.finished === true (not used again after a revival, see below)
 *   - a SubagentHandback tool_use in its transcript
 *   - a <task-notification> for it in the parent transcript. Any <status> finishes it (completed,
 *     stopped and killed alike); the status is kept as the finish reason. A notification older than
 *     the temp's newest record is ignored (the agent was resumed after it).
 *   - an end_turn (or similar) assistant text in its own sidechain
 *   - silence: no transcript change for TEMP_STALE_MS (4 min) when nothing is open. While at least
 *     one tool call is open (Claude Code writes nothing to a subagent transcript while a Bash runs)
 *     the silence rule does NOT apply; instead only the longer ceiling TEMP_OPEN_TOOL_STALE_MS
 *     (30 min without any transcript change) ends it, or the parent session's live status being
 *     present with alive === false (the process is gone).
 * A finished temp stays visible as `done` for DONE_VISIBLE_MS, then is removed and remembered in
 * `dropped` (id -> revival threshold), so old subagents do not flash up again while still listed.
 * Revival: if a finished or dropped temp gets new records (a batch whose newest timestamp, or a
 * listed mtime, is later than its threshold = finish event / last record / mtime + REVIVE_SLACK_MS),
 * its finish state is cleared and it is re-created as a working temp. Records at or before the
 * threshold, as for an old subagent seen at startup, never revive it.
 *
 * Per-session facts (they never touch the activity):
 *   - model: `message.model` of the newest assistant record, `<synthetic>` and other `<...>` placeholders skipped.
 *   - effort: the newest assistant record's top-level `effort` (else `perTurnEffort`). Only values in EFFORT_LEVELS
 *     count; anything else is ignored and the previous value stays.
 *   - context: `message.usage` of the newest assistant record that has one (see `contextTokens`); the window comes
 *     from `contextWindowFor` at snapshot time so a window learned later takes effect.
 *   - costUsd: `totalCostUSD` of the newest `cost-state` record (main sessions; it is the session's running total).
 *     An office run's live figure (`officeInfo().costUsd`) overrides it while the lookup reports one. Likewise the
     lookup's `model` and `context` (the live run's own) override the transcript's model and context while reported.
 *   - lastReport (main only): the final assistant text of a turn, committed when the turn ends: an assistant text with
 *     an end stop_reason, or a `turn_duration` record when a text had been seen since the last tool call. Text
 *     followed by a tool call, prompt, tool result or interrupt is mid-turn and never reported.
 *   - lastApproval: the newest tool_result carrying a user-sourced accept `permissionDecision`, for ExitPlanMode (plan),
 *     the run tools (command) or the edit tools (edit). Auto-allowed (`config`) and rejected calls do not count.
 *   - plans: see planIndex.ts.
 * All of them are deterministic functions of the records (and the learned-window map), so the host's change
 * detection (it compares serialised snapshots) posts only when a record or a learned window changed one.
 *
 * `since` only changes when the activity changes. It is the record timestamp that started the
 * activity, or the moment a time threshold was crossed (e.g. tool start + 20 s for the copier),
 * or `now` when the change came from the live status file.
 */

/** How long a tool's activity keeps showing after its result arrived. */
export const LINGER_MS = 8_000;
const ASK_AFTER_MS = 4_000;
const APPROVAL_AFTER_MS = 15_000;
const COPIER_AFTER_MS = 20_000;
const COMPACT_FOR_MS = 60_000;
const STALE_MAIN_MS = 10 * 60_000;
const TEMP_STALE_MS = 4 * 60_000;
/** Ceiling for a temp with an open tool call and no transcript change at all. */
export const TEMP_OPEN_TOOL_STALE_MS = 30 * 60_000;
/** New records must be this much later than a finish to count as a resumption (tail records of the final turn do not). */
const REVIVE_SLACK_MS = 5_000;
/** A notification this much older than the newest record belongs to an earlier run of the agent. */
const NOTIFY_SLACK_MS = 1_000;
const DONE_VISIBLE_MS = 10_000;
/** A finish noticed this long after it happened (e.g. at startup) is not worth showing. */
const OLD_FINISH_MS = 2 * 60_000;
const LIVE_IDLE_SLACK_MS = 3_000;
const MAX_OPEN = 64;
const MAX_NOTIFIED = 256;
const MAX_DROPPED = 512;

const ASK_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);
const APPROVAL_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const LONG_RUN_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const END_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

type FinishReason = 'completed' | 'stopped' | 'killed' | 'handback' | 'meta' | 'silence' | 'end_turn' | 'session-gone';

interface Notice { ts: number; status: 'completed' | 'stopped' | 'killed' }

type LastKind = 'none' | 'prompt' | 'toolResult' | 'apiRequest' | 'part' | 'end' | 'turnDone' | 'interrupt' | 'compact';

interface OpenTool { name: string; ts: number; cls: ToolClass }

interface Linger { startTs: number; resultTs: number; cls: ToolClass }

interface AgentState {
  id: string;
  plans: PlanIndex;
  model?: string;
  effort?: EffortLevel;
  /** Prompt size of the newest assistant turn with usage. */
  ctxTokens?: number;
  /** `totalCostUSD` of the newest cost-state record. */
  costState?: number;
  lastReport?: { at: number; text: string; truncated?: boolean };
  /** Assistant text seen since the last tool call or prompt; becomes the report if the turn ends here. */
  turnText?: { at: number; text: string };
  kind: 'main' | 'temp';
  sessionId: string;
  agentId?: string;
  firstSeen: number;
  startedAt?: number;
  aiTitle?: string;
  recordCwd?: string;
  recordBranch?: string;
  open: Map<string, OpenTool>;
  linger?: Linger;
  last: { kind: LastKind; ts: number };
  lastRecordTs: number;
  lastPromptAt?: number;
  lastApproval?: { at: number; kind: ApprovalKind };
  activity: Activity;
  detail?: string;
  since: number;
  settled: boolean;
  // Subagents only.
  meta?: SubagentMeta;
  mtimeMs: number;
  listed: boolean;
  handbackAt?: number;
  endTurnAt?: number;
  finishedAt?: number;
  finishReason?: FinishReason;
  /** Records or a listing mtime later than this revive the finished temp. */
  reviveAfter?: number;
  /** Set once revived: the newest evidence time. Older notifications and meta.finished are ignored. */
  reviveFloor?: number;
}

interface SessionState {
  info?: SessionInfo;
  main: AgentState;
  subs: Map<string, AgentState>;
  /** agentId -> the parent's latest task-notification for it. */
  notified: Map<string, Notice>;
  /** Subagents already shown as done and removed -> revival threshold. Not recreated unless newer records appear. */
  dropped: Map<string, number>;
  /** The office request currently shown for the main agent, for a stable `since`. At most one. */
  pendingSeen?: { requestId: string; since: number };
}

interface Evaluation { activity: Activity; detail?: string; at: number }

function asRecord(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function newestTimestamp(records: unknown[]): number {
  let best = 0;
  for (const r of records) {
    const t = parseTs(asRecord(r)?.['timestamp']);
    if (t !== undefined && t > best) best = t;
  }
  return best;
}

function resetRecordState(s: AgentState): void {
  s.open.clear();
  s.linger = undefined;
  s.last = { kind: 'none', ts: 0 };
  s.lastRecordTs = 0;
  s.aiTitle = undefined;
  s.recordCwd = undefined;
  s.recordBranch = undefined;
  s.lastPromptAt = undefined;
  s.lastApproval = undefined;
  s.handbackAt = undefined;
  s.endTurnAt = undefined;
}

/** Forgets everything learned from the records (a rewritten transcript is replayed from the start). */
function resetFacts(s: AgentState): void {
  s.plans.clear();
  s.model = undefined;
  s.effort = undefined;
  s.ctxTokens = undefined;
  s.costState = undefined;
  s.lastReport = undefined;
  s.turnText = undefined;
}

function newState(id: string, kind: 'main' | 'temp', sessionId: string, agentId: string | undefined, now: number): AgentState {
  const s: AgentState = {
    id, kind, sessionId, firstSeen: now, plans: new PlanIndex(),
    open: new Map(), last: { kind: 'none', ts: 0 }, lastRecordTs: 0,
    activity: 'idle', since: now, settled: false, mtimeMs: 0, listed: false,
  };
  if (agentId !== undefined) s.agentId = agentId;
  return s;
}

/** What the manager host knows about a session it runs (the live office run). Every field is optional. */
export interface OfficeRunInfo {
  pending?: { requestId: string; kind: PendingKind };
  costUsd?: number;
  /** The run's model (full id once known). Overrides the transcript's while the lookup reports one. */
  model?: string;
  effort?: EffortLevel;
  /** The run's own context figures (its latest assistant message against its window). Overrides the transcript's. */
  context?: { tokens: number; max: number; pct: number; approx?: boolean };
}
export type OfficeInfoLookup = (sessionId: string) => OfficeRunInfo | undefined;
export type ControlLookup = (agent: { id: string; kind: 'main' | 'temp'; sessionId: string }) => AgentControl;

export class AgentTracker {
  private readonly clock: () => number;
  private readonly sessions = new Map<string, SessionState>();

  private readonly officeInfo?: OfficeInfoLookup;
  private readonly controlOf?: ControlLookup;
  private readonly learnedWindows?: ReadonlyMap<string, number>;

  /**
   * `learnedWindows` is a live map (model id -> context window) that the host fills when an office run reports a
   * window; it is read at every snapshot, so later entries apply to sessions already tracked.
   */
  constructor(opts?: { now?: () => number; officeInfo?: OfficeInfoLookup; controlOf?: ControlLookup; learnedWindows?: ReadonlyMap<string, number> }) {
    this.clock = opts?.now ?? Date.now;
    this.officeInfo = opts?.officeInfo;
    this.controlOf = opts?.controlOf;
    this.learnedWindows = opts?.learnedWindows;
  }

  /**
   * The kept text of a plan of one agent (`agentId` is the snapshot id: the session id, or `<session>/<agent>` for a
   * temp). Undefined when the agent or plan is unknown, or the plan is older than the 3 newest (text dropped).
   */
  planText(agentId: string, planId: string): PlanText | undefined {
    const ses = this.sessions.get(agentId.split('/')[0] ?? '');
    if (ses === undefined) return undefined;
    const s = ses.main.id === agentId ? ses.main : [...ses.subs.values()].find((x) => x.id === agentId);
    return s?.plans.planText(planId);
  }

  /** Feed one watcher poll: new records and the complete set of current sessions. */
  apply(update: WatchUpdate): void {
    const now = this.clock();
    const listed = new Set<string>();
    for (const info of update.sessions) {
      listed.add(info.sessionId);
      this.registerSession(info, now);
    }
    for (const batch of update.batches) {
      try {
        this.applyBatch(batch, now);
      } catch {
        // A malformed batch must never take the tracker down.
      }
    }
    for (const sid of [...this.sessions.keys()]) {
      if (!listed.has(sid)) this.sessions.delete(sid);
    }
    for (const ses of this.sessions.values()) {
      this.reconcileSubs(ses, now);
      this.settle(ses.main, now, true);
      for (const sub of ses.subs.values()) this.settle(sub, now, true);
      this.pruneDone(ses, now);
    }
  }

  /** The agents to draw. `now` defaults to the tracker's clock. */
  snapshot(now: number = this.clock()): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    for (const ses of this.sessions.values()) {
      this.settle(ses.main, now, true);
      out.push(this.toSnapshot(ses, ses.main, now));
      const subs = [...ses.subs.values()].sort((a, b) => (a.startedAt ?? a.firstSeen) - (b.startedAt ?? b.firstSeen));
      for (const sub of subs) {
        this.updateFinish(ses, sub, now);
        if (sub.finishedAt !== undefined && now - sub.finishedAt >= DONE_VISIBLE_MS) continue;
        this.settle(sub, now, true);
        out.push(this.toSnapshot(ses, sub, now));
      }
    }
    return out;
  }

  // ---- registration and reconciliation ----

  private registerSession(info: SessionInfo, now: number): void {
    let ses = this.sessions.get(info.sessionId);
    if (ses === undefined) {
      ses = {
        main: newState(info.sessionId, 'main', info.sessionId, undefined, now),
        subs: new Map(), notified: new Map(), dropped: new Map(),
      };
      this.sessions.set(info.sessionId, ses);
    }
    ses.info = info;
    ses.main.mtimeMs = info.mtimeMs;
    const present = new Set<string>();
    for (const si of info.subagents) {
      present.add(si.agentId);
      const dropAt = ses.dropped.get(si.agentId);
      if (dropAt !== undefined) {
        if (si.mtimeMs <= dropAt) continue;
        ses.dropped.delete(si.agentId);
      }
      const sub = this.ensureSub(ses, si.agentId, now);
      if (dropAt !== undefined) this.revive(sub, si.mtimeMs);
      else if (sub.finishedAt !== undefined && sub.reviveAfter !== undefined && si.mtimeMs > sub.reviveAfter) this.revive(sub, si.mtimeMs);
      this.updateSubInfo(sub, si);
    }
    for (const [aid, sub] of [...ses.subs]) {
      if (sub.listed && !present.has(aid)) ses.subs.delete(aid);
    }
    for (const aid of [...ses.dropped.keys()]) {
      if (!present.has(aid)) ses.dropped.delete(aid);
    }
  }

  private ensureSub(ses: SessionState, agentId: string, now: number): AgentState {
    let sub = ses.subs.get(agentId);
    if (sub === undefined) {
      sub = newState(ses.main.sessionId + '/' + agentId, 'temp', ses.main.sessionId, agentId, now);
      ses.subs.set(agentId, sub);
    }
    return sub;
  }

  private updateSubInfo(sub: AgentState, si: SubagentInfo): void {
    sub.listed = true;
    sub.mtimeMs = si.mtimeMs;
    if (si.meta !== undefined) sub.meta = si.meta;
  }

  private reconcileSubs(ses: SessionState, now: number): void {
    for (const sub of ses.subs.values()) this.updateFinish(ses, sub, now);
  }

  private pruneDone(ses: SessionState, now: number): void {
    for (const [aid, sub] of [...ses.subs]) {
      if (sub.finishedAt !== undefined && now - sub.finishedAt >= DONE_VISIBLE_MS) {
        ses.subs.delete(aid);
        ses.dropped.set(aid, sub.reviveAfter ?? sub.finishedAt);
        if (ses.dropped.size > MAX_DROPPED) ses.dropped.delete(ses.dropped.keys().next().value as string);
      }
    }
  }

  /** Clears the finish state and makes the temp a working one again, because new records appeared at `evidence`. */
  private revive(sub: AgentState, evidence: number): void {
    resetRecordState(sub);
    sub.finishedAt = undefined;
    sub.finishReason = undefined;
    sub.reviveAfter = undefined;
    sub.reviveFloor = Math.max(sub.reviveFloor ?? 0, evidence);
    this.mark(sub, 'prompt', evidence);
    sub.settled = false;
  }

  /** Marks a subagent finished the first time any finish signal is seen. */
  private updateFinish(ses: SessionState, sub: AgentState, now: number): void {
    if (sub.finishedAt !== undefined) return;
    const events: Array<{ t: number; reason: FinishReason }> = [];
    if (sub.handbackAt !== undefined) events.push({ t: sub.handbackAt, reason: 'handback' });
    if (sub.endTurnAt !== undefined) events.push({ t: sub.endTurnAt, reason: 'end_turn' });
    if (sub.meta?.finished === true && sub.reviveFloor === undefined) {
      events.push({ t: sub.mtimeMs > 0 ? sub.mtimeMs : sub.lastRecordTs > 0 ? sub.lastRecordTs : now, reason: 'meta' });
    }
    const notice = sub.agentId === undefined ? undefined : ses.notified.get(sub.agentId);
    if (notice !== undefined && notice.ts >= (sub.reviveFloor ?? 0) && notice.ts + NOTIFY_SLACK_MS >= sub.lastRecordTs) {
      events.push({ t: notice.ts, reason: notice.status });
    }
    const openTool = sub.open.size > 0;
    const live = ses.info?.live;
    if (openTool && live !== undefined && !live.alive) events.push({ t: now, reason: 'session-gone' });
    const lastChange = Math.max(sub.mtimeMs, sub.lastRecordTs);
    const limit = openTool ? TEMP_OPEN_TOOL_STALE_MS : TEMP_STALE_MS;
    if (lastChange > 0 && now - lastChange >= limit) events.push({ t: lastChange + limit, reason: 'silence' });
    if (events.length === 0) return;
    let first = events[0]!;
    for (const e of events) if (e.t < first.t) first = e;
    sub.finishedAt = now - first.t > OLD_FINISH_MS ? first.t : now;
    sub.finishReason = first.reason;
    sub.reviveAfter = Math.max(first.t, sub.lastRecordTs, sub.mtimeMs) + REVIVE_SLACK_MS;
  }

  // ---- records ----

  private applyBatch(batch: { sessionId: string; agentId?: string; reset: boolean; records: unknown[] }, now: number): void {
    const ses = this.sessions.get(batch.sessionId);
    if (ses === undefined) return;
    let s: AgentState;
    if (batch.agentId === undefined) {
      s = ses.main;
      if (batch.reset) {
        resetRecordState(s);
        resetFacts(s);
        ses.notified.clear();
      }
    } else {
      const dropAt = ses.dropped.get(batch.agentId);
      const newest = Array.isArray(batch.records) ? newestTimestamp(batch.records) : 0;
      if (dropAt !== undefined && newest <= dropAt) return;
      s = this.ensureSub(ses, batch.agentId, now);
      if (dropAt !== undefined) {
        ses.dropped.delete(batch.agentId);
        const si = ses.info?.subagents.find((x) => x.agentId === batch.agentId);
        if (si !== undefined) this.updateSubInfo(s, si);
        this.revive(s, newest);
      } else if (s.finishedAt !== undefined && s.reviveAfter !== undefined && newest > s.reviveAfter) {
        this.revive(s, newest);
      }
      if (batch.reset && dropAt === undefined) {
        resetRecordState(s);
        resetFacts(s);
      }
    }
    if (!Array.isArray(batch.records)) return;
    for (const rec of batch.records) {
      try {
        // Let time thresholds that passed since the previous record (linger expiry, copier, approval) take effect first.
        const at = parseTs(asRecord(rec)?.['timestamp']);
        if (at !== undefined && s.settled && at > s.last.ts) this.settle(s, at, false);
        if (this.applyRecord(ses, s, rec)) this.settle(s, s.last.ts, false);
      } catch {
        // Skip records we cannot make sense of.
      }
    }
  }

  /** Updates the agent from one record. Returns true when the record changed what the agent is doing. */
  private applyRecord(ses: SessionState, s: AgentState, rec: unknown): boolean {
    const o = asRecord(rec);
    if (o === undefined) return false;
    const type = o['type'];
    if (typeof type !== 'string') return false;
    const stamp = parseTs(o['timestamp']);
    if (stamp !== undefined) {
      if (s.startedAt === undefined) s.startedAt = stamp;
      if (stamp > s.lastRecordTs) s.lastRecordTs = stamp;
    }
    const ts = stamp ?? (s.lastRecordTs > 0 ? s.lastRecordTs : this.clock());
    const cwd = o['cwd'];
    if (typeof cwd === 'string' && cwd !== '') s.recordCwd = cwd;
    const branch = o['gitBranch'];
    if (typeof branch === 'string' && branch !== '') s.recordBranch = branch;

    switch (type) {
      case 'cost-state': {
        const cost = o['totalCostUSD'];
        if (s.kind === 'main' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) s.costState = cost;
        return false;
      }
      case 'ai-title': {
        const t = o['aiTitle'];
        if (s.kind === 'main' && typeof t === 'string' && t.trim() !== '') s.aiTitle = t.trim();
        return false;
      }
      case 'queue-operation':
        if (s.kind === 'main') this.scanNotifications(ses, o['content'], ts);
        return false;
      case 'api-request':
        this.mark(s, 'apiRequest', ts);
        return true;
      case 'system': {
        const sub = o['subtype'];
        if (sub === 'turn_duration') {
          this.commitReport(s, ts);
          s.open.clear();
          s.linger = undefined;
          this.mark(s, 'turnDone', ts);
          return true;
        }
        if (sub === 'compact_boundary') {
          s.turnText = undefined;
          s.open.clear();
          s.linger = undefined;
          this.mark(s, 'compact', ts);
          return true;
        }
        return false;
      }
      case 'user':
        return this.applyUser(ses, s, o, ts);
      case 'assistant':
        return this.applyAssistant(s, o, ts);
      default:
        return false;
    }
  }

  private mark(s: AgentState, kind: LastKind, ts: number): void {
    s.last = { kind, ts: Math.max(ts, s.last.ts) };
  }

  private scanNotifications(ses: SessionState, content: unknown, ts: number): void {
    if (typeof content !== 'string' || !content.includes('<task-notification>')) return;
    const note = (id: string | undefined, status: string | undefined): void => {
      if (id === undefined) return;
      const old = ses.notified.get(id);
      if (old !== undefined && old.ts >= ts) return;
      ses.notified.set(id, { ts, status: status === 'stopped' || status === 'killed' ? status : 'completed' });
    };
    let blocks = 0;
    for (const b of content.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
      const body = b[1] ?? '';
      blocks++;
      note(/<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body)?.[1], /<status>\s*([^<\s]+)\s*<\/status>/.exec(body)?.[1]?.toLowerCase());
    }
    if (blocks === 0) for (const m of content.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)) note(m[1], undefined);
    while (ses.notified.size > MAX_NOTIFIED) ses.notified.delete(ses.notified.keys().next().value as string);
  }

  private applyUser(ses: SessionState, s: AgentState, o: Record<string, unknown>, ts: number): boolean {
    if (o['isMeta'] === true || o['isCompactSummary'] === true) return false;
    const msg = asRecord(o['message']);
    const content = msg?.['content'];
    const origin = typeof o['turnOrigin'] === 'string' ? (o['turnOrigin'] as string) : undefined;
    const sidechain = o['isSidechain'] === true || s.kind === 'temp';

    const prompt = (human: boolean): boolean => {
      s.turnText = undefined;
      s.open.clear();
      s.linger = undefined;
      this.mark(s, 'prompt', ts);
      if (human && !sidechain) s.lastPromptAt = ts;
      return true;
    };
    const interrupt = (): boolean => {
      s.turnText = undefined;
      s.open.clear();
      s.linger = undefined;
      this.mark(s, 'interrupt', ts);
      return true;
    };

    if (typeof content === 'string') {
      if (content.startsWith('[Request interrupted by user')) return interrupt();
      if (origin === 'task_notification' || content.startsWith('<task-notification>')) {
        this.scanNotifications(ses, content, ts);
        return prompt(false);
      }
      if (origin === 'human') return prompt(true);
      if (origin === undefined) return content.startsWith('<') ? false : prompt(!sidechain);
      return prompt(false);
    }
    if (!Array.isArray(content)) return false;

    let sawResult = false;
    let interrupted = false;
    let sawInput = false;
    for (const b of content) {
      const block = asRecord(b);
      if (block === undefined) continue;
      if (block['type'] === 'tool_result') {
        sawResult = true;
        const id = block['tool_use_id'];
        if (typeof id === 'string') {
          this.noteApproval(s, id, o, ts);
          this.closeTool(s, id, ts);
          this.closePlan(s, id, block, o, ts);
        }
      } else if (block['type'] === 'text') {
        const t = block['text'];
        if (typeof t === 'string' && t.startsWith('[Request interrupted by user')) interrupted = true;
        else sawInput = true;
      } else if (block['type'] === 'image') {
        sawInput = true;
      }
    }
    if (interrupted) return interrupt();
    if (sawResult) {
      s.turnText = undefined;
      this.mark(s, 'toolResult', ts);
      return true;
    }
    if (sawInput && (origin === 'human' || (origin === undefined && sidechain))) return prompt(origin === 'human');
    return false;
  }

  /**
   * A tool_result whose `permissionDecision` is an accept from the user (`source` `user_...`; `config` and the like
   * were auto-allowed) is a hand approval of its plan, command or edit. Must run before closeTool drops the open call.
   */
  private noteApproval(s: AgentState, id: string, rec: Record<string, unknown>, ts: number): void {
    const decision = asRecord(rec['permissionDecision']);
    if (decision?.['decision'] !== 'accept') return;
    const source = decision['source'];
    if (typeof source !== 'string' || !source.startsWith('user_')) return;
    const name = s.open.get(id)?.name;
    if (name === undefined) return;
    const kind: ApprovalKind | undefined = name === 'ExitPlanMode' ? 'plan' : RUN_TOOLS.has(name) ? 'command' : EDIT_TOOLS.has(name) ? 'edit' : undefined;
    if (kind !== undefined) s.lastApproval = { at: ts, kind };
  }

  /**
   * A tool_result for a pending plan decides it. Rejected = `is_error` (or a recorded 'reject' decision); anything
   * else is an approval. The result record's `toolUseResult` supplies the text when the tool_use input had none.
   */
  private closePlan(s: AgentState, id: string, block: Record<string, unknown>, rec: Record<string, unknown>, ts: number): void {
    if (!s.plans.isPending(id)) return;
    const result = asRecord(rec['toolUseResult']);
    const extra: { text?: string; planFilePath?: string; feedback?: string } = {};
    if (typeof result?.['plan'] === 'string') extra.text = result['plan'];
    if (typeof result?.['filePath'] === 'string' && result['filePath'] !== '') extra.planFilePath = result['filePath'];
    const rejected = block['is_error'] === true || asRecord(rec['permissionDecision'])?.['decision'] === 'reject';
    if (rejected) {
      const feedback = rejectionFeedback(block['content']);
      if (feedback !== undefined) extra.feedback = feedback;
    }
    s.plans.close(id, ts, rejected ? 'rejected' : 'approved', extra);
  }

  /** The turn ended: the assistant text seen since the last tool call or prompt becomes the report. Main sessions only. */
  private commitReport(s: AgentState, ts: number): void {
    const pending = s.turnText;
    s.turnText = undefined;
    if (s.kind !== 'main' || pending === undefined) return;
    this.setReport(s, ts, pending.text);
  }

  private setReport(s: AgentState, at: number, raw: string): void {
    let text = raw.trim();
    if (text === '') return;
    let truncated = false;
    if (text.length > LIMITS.reportChars) {
      text = text.slice(0, LIMITS.reportChars);
      // Do not leave half a surrogate pair at the cut.
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
      truncated = true;
    }
    s.lastReport = truncated ? { at, text, truncated: true } : { at, text };
  }

  /** A tool_result arrived: the call is no longer open, but its activity lingers. */
  private closeTool(s: AgentState, id: string, ts: number): void {
    const tool = s.open.get(id);
    if (tool === undefined) return;
    s.open.delete(id);
    if (tool.cls.activity === 'needsYou') {
      s.linger = undefined; // an answered question is not a pose worth keeping
    } else if (s.linger === undefined || tool.ts >= s.linger.startTs) {
      s.linger = { startTs: tool.ts, resultTs: ts, cls: tool.cls };
    }
  }

  private applyAssistant(s: AgentState, o: Record<string, unknown>, ts: number): boolean {
    const msg = asRecord(o['message']);
    const content = msg?.['content'];
    this.readFacts(s, o, msg);
    if (!Array.isArray(content)) return false;
    const stop = msg?.['stop_reason'];
    const ends = typeof stop === 'string' && END_REASONS.has(stop);
    let changed = false;
    let sawTool = false;
    const texts: string[] = [];
    for (const b of content) {
      const block = asRecord(b);
      if (block === undefined) continue;
      switch (block['type']) {
        case 'tool_use': {
          const name = block['name'];
          if (typeof name !== 'string') break;
          sawTool = true;
          if (name === 'ExitPlanMode') {
            const id = block['id'];
            const input = asRecord(block['input']);
            if (typeof id === 'string') {
              const filePath = input?.['planFilePath'];
              s.plans.open(id, ts, typeof input?.['plan'] === 'string' ? input['plan'] : '', typeof filePath === 'string' && filePath !== '' ? filePath : undefined);
            }
          }
          if (name === 'SubagentHandback') {
            if (s.handbackAt === undefined) s.handbackAt = ts;
          } else {
            const id = block['id'];
            if (typeof id === 'string') {
              s.open.set(id, { name, ts, cls: classifyTool(name, block['input']) });
              if (s.open.size > MAX_OPEN) s.open.delete(s.open.keys().next().value as string);
            }
          }
          this.mark(s, 'part', ts);
          changed = true;
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          this.mark(s, 'part', ts);
          changed = true;
          break;
        case 'text':
          if (typeof block['text'] === 'string') texts.push(block['text']);
          if (ends) {
            s.open.clear();
            s.linger = undefined;
            if (s.kind === 'temp' && s.endTurnAt === undefined) s.endTurnAt = ts;
            this.mark(s, 'end', ts);
          } else {
            this.mark(s, 'part', ts);
          }
          changed = true;
          break;
        default:
          break;
      }
    }
    this.trackReport(s, ts, ends, sawTool, texts, msg?.['model']);
    return changed;
  }

  /** model, effort and context tokens from one assistant record. Placeholder (`<synthetic>`) records carry none of them. */
  private readFacts(s: AgentState, o: Record<string, unknown>, msg: Record<string, unknown> | undefined): void {
    const model = msg?.['model'];
    if (typeof model !== 'string' || model === '' || model.startsWith('<')) return;
    s.model = model;
    for (const key of ['effort', 'perTurnEffort']) {
      const e = o[key];
      if (typeof e === 'string' && (EFFORT_LEVELS as readonly string[]).includes(e)) {
        s.effort = e as EffortLevel;
        break;
      }
    }
    const tokens = contextTokens(msg?.['usage']);
    if (tokens !== undefined) s.ctxTokens = tokens;
  }

  /**
   * Keeps `turnText` (the candidate report) in step with one assistant record: a record with a tool call makes earlier
   * text mid-turn; a text record with an end stop_reason ends the turn now; any other text is held until the turn ends.
   */
  private trackReport(s: AgentState, ts: number, ends: boolean, sawTool: boolean, texts: string[], model: unknown): void {
    if (s.kind !== 'main') return;
    if (sawTool) {
      s.turnText = undefined;
      return;
    }
    const text = texts.join('\n\n').trim();
    if (text === '' || (typeof model === 'string' && model.startsWith('<'))) return;
    if (ends) {
      s.turnText = undefined;
      this.setReport(s, ts, text);
    } else {
      s.turnText = { at: ts, text };
    }
  }

  // ---- activity ----

  /** Re-evaluate the activity. `since` moves only when the activity itself changes. */
  private settle(s: AgentState, now: number, realtime: boolean): void {
    const ev = this.evaluate(s, now, realtime);
    if (!s.settled || ev.activity !== s.activity) {
      s.activity = ev.activity;
      s.since = Math.min(ev.at, now);
      s.settled = true;
    }
    s.detail = ev.detail;
  }

  private evaluate(s: AgentState, now: number, realtime: boolean): Evaluation {
    if (s.finishedAt !== undefined) return { activity: 'idle', at: s.finishedAt };

    const live: LiveStatus | undefined = realtime && s.kind === 'main' ? this.sessions.get(s.sessionId)?.info?.live : undefined;
    const liveStatus = live !== undefined && live.alive ? live.status : undefined;

    // 0. Stale main session.
    if (realtime && s.kind === 'main') {
      const lastChange = Math.max(s.mtimeMs, s.lastRecordTs);
      if (liveStatus === undefined && lastChange > 0 && now - lastChange >= STALE_MAIN_MS) {
        return { activity: 'idle', at: lastChange + STALE_MAIN_MS };
      }
    }

    let newest: OpenTool | undefined;
    for (const t of s.open.values()) if (newest === undefined || t.ts >= newest.ts) newest = t;

    // 1. needsYou.
    if (liveStatus === 'waiting') return withDetail('needsYou', newest?.cls.detail, now);
    let askAt: number | undefined;
    let askTool: OpenTool | undefined;
    const busyFresh = live !== undefined && liveStatus === 'busy' && live.statusUpdatedAt !== undefined && now - live.statusUpdatedAt < APPROVAL_AFTER_MS;
    for (const t of s.open.values()) {
      let due: number | undefined;
      if (ASK_TOOLS.has(t.name)) due = t.ts + ASK_AFTER_MS;
      else if (APPROVAL_TOOLS.has(t.name) && !busyFresh) due = t.ts + APPROVAL_AFTER_MS;
      if (due !== undefined && now >= due && (askAt === undefined || due < askAt)) {
        askAt = due;
        askTool = t;
      }
    }
    if (askAt !== undefined) return withDetail('needsYou', askTool?.cls.detail, askAt);

    // 2. Open tool.
    if (newest !== undefined) {
      if (LONG_RUN_TOOLS.has(newest.name) && now - newest.ts >= COPIER_AFTER_MS) {
        return withDetail('copier', newest.cls.detail, newest.ts + COPIER_AFTER_MS);
      }
      if (newest.name === 'AskUserQuestion') return { activity: 'thinking', at: newest.ts };
      return withDetail(newest.cls.activity, newest.cls.detail, newest.ts);
    }

    // 3. Compacting.
    if (s.last.kind === 'compact' && now - s.last.ts <= COMPACT_FOR_MS) return { activity: 'shredding', at: s.last.ts };

    // 4. Live status says idle (and is not older than the last entry).
    if (liveStatus === 'idle' && live !== undefined && (live.statusUpdatedAt === undefined || live.statusUpdatedAt + LIVE_IDLE_SLACK_MS >= s.last.ts)) {
      return { activity: 'idle', at: Math.min(now, Math.max(s.last.ts, live.statusUpdatedAt ?? 0)) };
    }

    // 4b. A tool whose result just came back keeps showing for LINGER_MS.
    let thinkingFrom = s.last.ts;
    if (s.linger !== undefined) {
      const expires = s.linger.resultTs + LINGER_MS;
      if (now < expires) return withDetail(s.linger.cls.activity, s.linger.cls.detail, s.linger.startTs);
      thinkingFrom = Math.max(thinkingFrom, expires);
    }

    // 5 and 6. Last real entry.
    switch (s.last.kind) {
      case 'prompt':
      case 'toolResult':
      case 'apiRequest':
      case 'part':
        return { activity: 'thinking', at: thinkingFrom };
      case 'end':
      case 'turnDone':
      case 'interrupt':
        return { activity: 'idle', at: s.last.ts };
      case 'compact':
        return { activity: liveStatus === 'busy' ? 'thinking' : 'idle', at: s.last.ts + COMPACT_FOR_MS };
      default:
        return { activity: liveStatus === 'busy' ? 'thinking' : 'idle', at: now };
    }
  }

  // ---- output ----

  private toSnapshot(ses: SessionState, s: AgentState, now: number): AgentSnapshot {
    const info = ses.info;
    const cwd = info?.cwd ?? ses.main.recordCwd;
    const project = cwd !== undefined && basename(cwd) !== '' ? basename(cwd) : info !== undefined ? basename(info.projectDir) : '';
    let status: AgentStatus;
    if (s.finishedAt !== undefined) status = 'done';
    else if (s.activity === 'needsYou') status = 'waiting';
    else if (s.activity === 'idle') status = 'idle';
    else status = 'working';

    let title: string;
    if (s.kind === 'temp') {
      title = s.meta?.description?.trim() || s.meta?.agentType?.trim() || 'Temp';
    } else {
      title = s.aiTitle ?? (info?.live?.name?.trim() || undefined) ?? (project !== '' ? project : undefined) ?? (info !== undefined ? basename(info.projectDir) : s.id);
    }

    let activity = s.activity;
    let since = s.since;
    let detail = s.detail;
    let office: ReturnType<OfficeInfoLookup>;
    if (s.kind === 'main') {
      try {
        office = this.officeInfo?.(s.sessionId);
      } catch {
        office = undefined;
      }
      const pending = office?.pending;
      if (pending !== undefined) {
        if (ses.pendingSeen?.requestId !== pending.requestId) ses.pendingSeen = { requestId: pending.requestId, since: now };
        activity = 'needsYou';
        status = 'waiting';
        since = ses.pendingSeen.since;
        detail = pendingDetail(pending.kind, s);
      } else {
        ses.pendingSeen = undefined;
      }
    }

    const snap: AgentSnapshot = {
      id: s.id,
      kind: s.kind,
      sessionId: s.sessionId,
      title,
      project,
      activity,
      status,
      since,
      startedAt: s.startedAt ?? s.firstSeen,
    };
    if (s.kind === 'temp') snap.parentId = s.sessionId;
    if (detail !== undefined && activity !== 'idle') snap.detail = detail;
    if (s.lastPromptAt !== undefined) snap.lastPromptAt = s.lastPromptAt;
    if (s.lastApproval !== undefined) snap.lastApproval = { ...s.lastApproval };
    const agentCwd = s.recordCwd ?? info?.cwd;
    if (agentCwd !== undefined) snap.cwd = agentCwd;
    if (s.recordBranch !== undefined && s.recordBranch !== 'HEAD') snap.gitBranch = s.recordBranch;
    if (this.controlOf !== undefined) {
      try {
        snap.control = this.controlOf({ id: s.id, kind: s.kind, sessionId: s.sessionId });
      } catch {
        snap.control = 'none';
      }
    } else if (s.kind === 'temp') {
      snap.control = 'none';
    }
    if (office?.pending !== undefined) snap.pending = { requestId: office.pending.requestId, kind: office.pending.kind };
    // An office run's live figure wins; otherwise the transcript's latest cost-state.
    const cost = office?.costUsd ?? s.costState;
    if (cost !== undefined) snap.costUsd = cost;
    // An office run's live model and context win while the lookup reports them; otherwise the transcript's.
    const model = office?.model !== undefined && office.model !== '' ? office.model : s.model;
    if (model !== undefined) snap.model = model;
    // An office run's requested effort wins while the lookup reports one; otherwise what the transcript recorded.
    const effort = office?.effort !== undefined && (EFFORT_LEVELS as readonly string[]).includes(office.effort) ? office.effort : s.effort;
    if (effort !== undefined) snap.effort = effort;
    const live = validContext(office?.context);
    if (live !== undefined) {
      snap.context = { ...live };
    } else if (s.ctxTokens !== undefined) {
      const win = contextWindowFor(s.model, this.learnedWindows, s.ctxTokens);
      snap.context = { tokens: s.ctxTokens, max: win.max, pct: contextPercent(s.ctxTokens, win.max) };
      if (win.approx === true) snap.context.approx = true;
    }
    if (s.lastReport !== undefined) snap.lastReport = { ...s.lastReport };
    const plans = s.plans.refs();
    if (plans.length > 0) snap.plans = plans;
    return snap;
  }
}

/**
 * The size of the prompt a turn sent: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 * `output_tokens` is deliberately left out: usage describes the request that was sent, and the reply only enters the
 * window as input of the next request, so adding it would count the same tokens twice on the following turn (and
 * streamed records carry a partial output count). Undefined when the usage has none of the three or they sum to 0
 * (placeholder records).
 */
function contextTokens(usage: unknown): number | undefined {
  const u = asRecord(usage);
  if (u === undefined) return undefined;
  let total = 0;
  let any = false;
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const n = u[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      total += n;
      any = true;
    }
  }
  return any && total > 0 ? total : undefined;
}

/** A lookup's `context`, copied field by field, or undefined when it is not a sane figure (the lookup is not trusted to be well-formed). */
function validContext(c: OfficeRunInfo['context']): { tokens: number; max: number; pct: number; approx?: boolean } | undefined {
  if (c === undefined || c === null) return undefined;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!ok(c.tokens) || !ok(c.max) || c.max === 0 || !ok(c.pct)) return undefined;
  const out: { tokens: number; max: number; pct: number; approx?: boolean } = { tokens: c.tokens, max: c.max, pct: c.pct };
  if (c.approx === true) out.approx = true;
  return out;
}

function withDetail(activity: Activity, detail: string | undefined, at: number): Evaluation {
  return detail === undefined ? { activity, at } : { activity, detail, at };
}

function pendingDetail(kind: PendingKind, s: AgentState): string {
  if (kind === 'question') return 'Question for you';
  if (kind === 'plan') return 'Plan ready';
  let newest: OpenTool | undefined;
  for (const t of s.open.values()) if (newest === undefined || t.ts >= newest.ts) newest = t;
  return newest === undefined ? 'Approve' : `Approve: ${newest.name}`;
}
