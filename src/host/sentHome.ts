// Sending workers home (v0.5, docs/manager-mode.md section 18). Pure logic with injected dependencies, so it is testable in Node.
// A sent-home session is hidden from the published `agents` (the office walks the worker out). The tracker keeps tracking it
// upstream, so activity is still seen and brings the worker back. Nothing here touches a transcript.
//
//   watcher -> tracker -> feed.compute -> SentHome.filter (return test, hide) -> office view, case tabs, manager host
import type { SessionInfo } from '../claude/types.ts';
import { LIMITS, sendHomeAfterMs } from '../shared/protocol.ts';
import type { AgentSnapshot } from '../shared/protocol.ts';

/** Key of the record in the extension's global state. */
export const SENT_HOME_KEY = 'claudeOffice.sentHome';
/** At most this many records are kept; the oldest go first. */
export const MAX_RECORDS = 500;
/** Records older than this are dropped. */
export const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A transcript counts as changed only when it is newer than the recorded time by more than this (the stop of a run may touch it). */
export const MTIME_SLOP_MS = 2000;
/**
 * Settle window after a send-home: transcript writes with an mtime up to `at + SETTLE_MS` belong to the send-home. Stopping an office run writes the transcript shortly
 * after the record is made, and the recorded mtime comes from a cached session list that may be many seconds old. A newer
 * transcript inside the window is absorbed into the record instead of bringing the worker back. A busy worker still returns.
 */
export const SETTLE_MS = 15_000;
/** Gap of the auto send-home check. */
export const AUTO_CHECK_MS = 60_000;

export const REFUSAL_WORKING = "They're still working. Stop them first or wait until they're done.";
export const REFUSAL_WAITING = "They're waiting on you. Answer them first or wait until they're done.";
export const REFUSAL_UNKNOWN = 'That worker is not in the office any more.';
export const REFUSAL_DEMO = 'Demo workers cannot be sent home.';

/** What is kept for a sent-home session: when, and the transcript's modified time (epoch ms) at that moment. */
export interface SentHomeRecord {
  at: number;
  mtimeMs: number;
}

export type SendHomeResult = { ok: true } | { ok: false; reason: string };

/** The unfiltered view `sendHome` and the checks work on. `filter()` remembers the latest one; a caller may pass its own. */
export interface SendHomeContext {
  agents: readonly AgentSnapshot[];
  sessions: readonly SessionInfo[];
}

export interface SentHomeDeps {
  /** The extension's global state, narrowed. `set` may return a promise. */
  storage: { get(key: string): unknown; set(key: string, value: unknown): unknown };
  now(): number;
  /** The raw value of `claudeOffice.sendHomeAfter` (hours). Read through `sendHomeAfterMs`. */
  readSetting(): unknown;
  /** True while the demo feed runs: nothing is filtered, recorded or timed. */
  isDemo(): boolean;
  /** Stop an office run only if it is idle (`ManagerHost.stopIfIdle`). */
  stopIfIdle(sessionId: string): boolean;
  /** Close a case tab as a host action (`OfficeView.closeCaseTab`). */
  closeCaseTab(agentId: string): void;
  /** Ids of the open case tabs (`OfficeView.openCaseTabs`). */
  openCaseTabs(): readonly string[];
  /** Publish again now (`OfficeFeed.refreshNow`), so a changed record shows up at once. */
  refresh(): void;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** Session ids, counts and reasons only. */
  log(msg: string): void;
}

/** The session an agent belongs to: a main worker's own, a temp's lead's. */
export function sessionOf(a: AgentSnapshot): string {
  return a.sessionId ?? a.parentId ?? a.id;
}

/** Knocking: wants the user (waiting, a pending request, or the needs-you activity). */
export function isKnocking(a: AgentSnapshot): boolean {
  return a.status === 'waiting' || a.pending !== undefined || a.activity === 'needsYou';
}

/** Busy: working or knocking. Anything else (`idle`, `done`) can go home. */
export function isBusy(a: AgentSnapshot): boolean {
  return a.status === 'working' || isKnocking(a);
}

/**
 * Validate a stored record set. The value comes from global state, so it is untrusted: anything malformed is dropped, ids
 * are bounded, duplicates keep the newest, records past the age limit go, and the newest `MAX_RECORDS` stay.
 */
export function parseRecords(value: unknown, now: number): Map<string, SentHomeRecord> {
  const out = new Map<string, SentHomeRecord>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const { id, at, mtimeMs } = e as { id?: unknown; at?: unknown; mtimeMs?: unknown };
    if (typeof id !== 'string' || id === '' || id.length > LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(id)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) continue;
    if (now - at > MAX_RECORD_AGE_MS) continue;
    const old = out.get(id);
    if (old === undefined || at > old.at) out.set(id, { at, mtimeMs });
  }
  trim(out);
  return out;
}

/** Keep only the newest `MAX_RECORDS` (by `at`). */
function trim(records: Map<string, SentHomeRecord>): void {
  if (records.size <= MAX_RECORDS) return;
  const newest = [...records.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_RECORDS);
  records.clear();
  for (const [id, r] of newest) records.set(id, r);
}

export class SentHome {
  private readonly deps: SentHomeDeps;
  private readonly records: Map<string, SentHomeRecord>;
  private lastAgents: readonly AgentSnapshot[] = [];
  private lastSessions: readonly SessionInfo[] = [];
  private visible = false;
  private timer: unknown;
  private gen = 0;
  private disposed = false;

  constructor(deps: SentHomeDeps) {
    this.deps = deps;
    let raw: unknown;
    try {
      raw = deps.storage.get(SENT_HOME_KEY);
    } catch {
      raw = undefined;
    }
    this.records = parseRecords(raw, deps.now());
    if (this.records.size > 0) deps.log(`sent home: ${this.records.size} record(s) loaded`);
  }

  /** The sessions currently at home (ids). */
  homeSessions(): string[] {
    return [...this.records.keys()];
  }

  isHome(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /**
   * The feed hook. `agents` is the tracker's complete list; it is remembered, records whose worker is active again are
   * deleted (the worker is then simply listed again), and the sent-home workers and their temps are removed from the result.
   */
  filter(agents: AgentSnapshot[], sessions: readonly SessionInfo[]): AgentSnapshot[] {
    if (this.deps.isDemo() || this.disposed) return agents;
    this.lastAgents = agents;
    this.lastSessions = sessions;
    if (this.records.size === 0) return agents;
    this.returnActive(agents, sessions);
    if (this.records.size === 0) return agents;
    return agents.filter((a) => !this.records.has(sessionOf(a)));
  }

  /**
   * Send the worker home (or, for a temp, their lead). Refused while any of the session's agents is working or knocking.
   * Otherwise: record it, stop an idle office run, close the session's case tabs, publish again.
   */
  sendHome(agentId: string, ctx?: SendHomeContext): SendHomeResult {
    if (this.deps.isDemo()) return { ok: false, reason: REFUSAL_DEMO };
    const agents = ctx?.agents ?? this.lastAgents;
    const sessions = ctx?.sessions ?? this.lastSessions;
    const agent = agents.find((a) => a.id === agentId);
    if (agent === undefined) return { ok: false, reason: REFUSAL_UNKNOWN };
    const sessionId = sessionOf(agent);
    if (this.records.has(sessionId)) return { ok: true }; // already at home
    const members = agents.filter((a) => sessionOf(a) === sessionId);
    const blocker = members.find(isBusy);
    if (blocker !== undefined) {
      this.deps.log(`send home refused for ${sessionId}: ${isKnocking(blocker) ? 'knocking' : 'working'}`);
      return { ok: false, reason: isKnocking(blocker) ? REFUSAL_WAITING : REFUSAL_WORKING };
    }
    this.commit(sessionId, members, sessions, 'manual');
    this.deps.refresh();
    return { ok: true };
  }

  /**
   * The user closed this worker's case tab. An idle main worker goes home; a busy one stays (only the tab closed), and a
   * temp's tab never sends the lead home. Never reports anything: there is no sender to answer.
   */
  onTabClosed(agentId: string): void {
    if (this.deps.isDemo() || this.disposed) return;
    const agent = this.lastAgents.find((a) => a.id === agentId);
    if (agent === undefined || agent.kind !== 'main') return;
    this.sendHome(agentId);
  }

  /** Follow the feed's visibility: the auto send-home timer runs only while the office is visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible || this.disposed) return;
    this.visible = visible;
    this.gen++;
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (visible) this.schedule(this.gen);
  }

  /** The setting changed: apply it now (when visible) instead of at the next tick. */
  settingChanged(): void {
    if (this.visible) this.autoCheck();
  }

  /**
   * Send home every main worker who is idle and has been for at least `sendHomeAfter` hours. Idle-since is the tracker's
   * `since` (when the idle activity began), else the transcript's mtime. Workers with an open case tab are left alone.
   * Returns how many went home.
   */
  autoCheck(ctx?: SendHomeContext): number {
    if (this.deps.isDemo() || this.disposed) return 0;
    const limit = sendHomeAfterMs(this.deps.readSetting());
    if (limit <= 0) return 0;
    const agents = ctx?.agents ?? this.lastAgents;
    const sessions = ctx?.sessions ?? this.lastSessions;
    const now = this.deps.now();
    const tabs = new Set(this.deps.openCaseTabs());
    const mtimes = new Map(sessions.map((s) => [s.sessionId, s.mtimeMs]));
    let sent = 0;
    for (const agent of agents) {
      if (agent.kind !== 'main') continue;
      const sessionId = sessionOf(agent);
      if (this.records.has(sessionId)) continue;
      const members = agents.filter((a) => sessionOf(a) === sessionId);
      if (members.some(isBusy)) continue;
      if (members.some((a) => tabs.has(a.id))) continue;
      const idleSince = Number.isFinite(agent.since) && agent.since > 0 ? agent.since : mtimes.get(sessionId);
      if (idleSince === undefined || idleSince <= 0 || now - idleSince < limit) continue;
      this.commit(sessionId, members, sessions, 'auto');
      sent++;
    }
    if (sent > 0) {
      this.deps.log(`auto send home: ${sent} worker(s)`);
      this.deps.refresh();
    }
    return sent;
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ---- internals ----

  private commit(sessionId: string, members: readonly AgentSnapshot[], sessions: readonly SessionInfo[], how: 'manual' | 'auto'): void {
    const now = this.deps.now();
    const mtimeMs = sessions.find((s) => s.sessionId === sessionId)?.mtimeMs ?? now;
    this.records.set(sessionId, { at: now, mtimeMs });
    trim(this.records);
    this.persist();
    const main = members.find((a) => a.kind === 'main');
    let stopped = false;
    if (main?.control === 'office') {
      try {
        stopped = this.deps.stopIfIdle(sessionId);
      } catch {
        stopped = false;
      }
    }
    const open = new Set(this.deps.openCaseTabs());
    for (const m of members) {
      if (!open.has(m.id)) continue;
      try {
        this.deps.closeCaseTab(m.id);
      } catch {
        // A tab that cannot close must not undo the send home.
      }
    }
    this.deps.log(`sent home (${how}): ${sessionId}, ${members.length} agent(s)${stopped ? ', run stopped' : ''}`);
  }

  /**
   * Delete the records of sessions with new activity: a worker who is working or knocking (always), or a transcript newer
   * than the recorded time by more than the slop. A write whose own mtime is within SETTLE_MS of the send-home (`mtime <=
   * rec.at + SETTLE_MS`) belongs to the send-home (stopping the run, or a cached list older than the send): it is only
   * absorbed (the record's mtime moves up and is saved). This looks at when the write happened, not when we saw it, so a
   * first refresh long after the send-home (the office was hidden) does not bounce the worker. Later writes use the slop
   * rule from the absorbed mtime.
   */
  private returnActive(agents: readonly AgentSnapshot[], sessions: readonly SessionInfo[]): void {
    const mtimes = new Map(sessions.map((s) => [s.sessionId, s.mtimeMs]));
    const busy = new Set<string>();
    for (const a of agents) if (isBusy(a)) busy.add(sessionOf(a));
    const back: string[] = [];
    let absorbed = false;
    for (const [id, rec] of this.records) {
      const mtime = mtimes.get(id);
      if (busy.has(id)) {
        back.push(id);
      } else if (mtime !== undefined && mtime > rec.mtimeMs) {
        if (mtime <= rec.at + SETTLE_MS) {
          rec.mtimeMs = mtime;
          absorbed = true;
        } else if (mtime > rec.mtimeMs + MTIME_SLOP_MS) {
          back.push(id);
        }
      }
    }
    if (back.length === 0) {
      if (absorbed) this.persist();
      return;
    }
    for (const id of back) this.records.delete(id);
    this.persist();
    this.deps.log(`back at work: ${back.length} session(s) (${back.join(', ')})`);
  }

  private persist(): void {
    const entries = [...this.records].map(([id, r]) => ({ id, at: r.at, mtimeMs: r.mtimeMs }));
    try {
      const r = this.deps.storage.set(SENT_HOME_KEY, { v: 1, entries }) as { then?: unknown } | undefined;
      if (r !== undefined && r !== null && typeof r.then === 'function') {
        (r as PromiseLike<unknown>).then(undefined, () => this.deps.log('sent home: saving the record failed'));
      }
    } catch {
      this.deps.log('sent home: saving the record failed');
    }
  }

  private schedule(gen: number): void {
    this.timer = this.deps.timers.setTimeout(() => {
      if (gen !== this.gen) return;
      try {
        this.autoCheck();
      } catch (e) {
        this.deps.log(`auto send home failed (${e instanceof Error ? e.name : 'error'})`);
      }
      if (gen === this.gen) this.schedule(gen);
    }, AUTO_CHECK_MS);
  }
}
