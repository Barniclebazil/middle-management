import type { SessionInfo, WatchUpdate } from '../claude/types.ts';
import type { AgentSnapshot, HostToWebview } from '../shared/protocol.ts';

export type FeedScope = 'all' | { workspaceDirs: string[] };

export interface WatcherLike {
  poll(): Promise<WatchUpdate>;
}

export interface TrackerLike {
  apply(update: WatchUpdate): void;
  snapshot(now?: number): AgentSnapshot[];
}

export interface DemoLike {
  snapshot(now: number): AgentSnapshot[];
}

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OfficeFeedDeps {
  createWatcher(scope: FeedScope): WatcherLike;
  createTracker(): TrackerLike;
  publish(msg: HostToWebview): void;
  now(): number;
  timers: FeedTimers;
  log(msg: string): void;
  demo?: DemoLike;
  /**
   * Last step before an `agents` snapshot is compared and published (real sessions only, never the demo): the sent-home
   * filter. It gets the tracker's complete list and the latest watcher sessions and returns the list to publish, so the
   * de-dup key follows the filtered list. It may be stateful (return-on-activity), so it should be cheap.
   */
  filterAgents?(agents: AgentSnapshot[], sessions: readonly SessionInfo[]): AgentSnapshot[];
  /** Gap between polls. Default 500 ms. */
  pollMs?: number;
  /** Gap between time-only snapshots. Default 1000 ms. */
  tickMs?: number;
  /** Minimum gap between published messages. Default 250 ms (4 per second). */
  minPublishGapMs?: number;
}

/** Turn the `claudeOffice.scope` setting and the open folders into a watcher scope. No folders means 'all'. */
export function resolveScope(setting: string | undefined, folderPaths: readonly string[]): FeedScope {
  if (setting === 'workspace' && folderPaths.length > 0) return { workspaceDirs: [...folderPaths] };
  return 'all';
}

/** Stable comparison key: the agents sorted by id, as JSON. */
export function agentsKey(agents: readonly AgentSnapshot[]): string {
  return JSON.stringify([...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/**
 * Polls Claude sessions (or plays the demo) and publishes agent snapshots, but only while visible.
 * Publishes only when the snapshot changed, at most once per `minPublishGapMs`, with a trailing edge.
 */
export class OfficeFeed {
  private readonly deps: OfficeFeedDeps;
  private readonly pollMs: number;
  private readonly tickMs: number;
  private readonly gapMs: number;

  private scope: FeedScope = 'all';
  private demoOn = false;
  private visible = false;
  private watcher: WatcherLike | undefined;
  private tracker: TrackerLike;

  private gen = 0;
  private pollTimer: unknown;
  private tickTimer: unknown;
  private pendingTimer: unknown;
  private lastKey: string | undefined;
  private sessions: readonly SessionInfo[] = [];
  private lastPublishAt = Number.NEGATIVE_INFINITY;

  constructor(deps: OfficeFeedDeps) {
    this.deps = deps;
    this.pollMs = deps.pollMs ?? 500;
    this.tickMs = deps.tickMs ?? 1000;
    this.gapMs = deps.minPublishGapMs ?? 250;
    this.tracker = deps.createTracker();
  }

  isRunning(): boolean {
    return this.visible;
  }

  isDemo(): boolean {
    return this.demoOn;
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.start();
    else this.halt();
  }

  setScope(scope: FeedScope): void {
    if (JSON.stringify(scope) === JSON.stringify(this.scope)) return;
    this.scope = scope;
    this.rebuild();
  }

  setDemo(on: boolean): void {
    if (on === this.demoOn) return;
    this.demoOn = on;
    this.rebuild();
  }

  /** The complete session set from the latest watcher poll (empty before the first poll). For locating transcripts. */
  latestSessions(): readonly SessionInfo[] {
    return this.sessions;
  }

  /**
   * Publish the current snapshot now if it changed, skipping the throttle gap. For callers that know something the
   * model reads through its lookups has changed (a pending request, control, cost). No-op while hidden or in demo.
   */
  refreshNow(): void {
    if (this.demoOn) return;
    this.emit(true);
  }

  dispose(): void {
    this.visible = false;
    this.halt();
  }

  private rebuild(): void {
    this.watcher = undefined;
    this.tracker = this.safe(() => this.deps.createTracker(), 'create tracker') ?? this.tracker;
    if (this.visible) {
      this.halt();
      this.start();
    }
  }

  private safe<T>(fn: () => T, what: string): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.deps.log(`${what} failed: ${errText(e)}`);
      return undefined;
    }
  }

  private start(): void {
    this.gen++;
    this.lastKey = undefined;
    this.lastPublishAt = Number.NEGATIVE_INFINITY;
    const gen = this.gen;
    if (!this.demoOn) {
      this.watcher ??= this.safe(() => this.deps.createWatcher(this.scope), 'create watcher');
      this.pollTimer = this.deps.timers.setTimeout(() => void this.pollOnce(gen), 0);
    }
    this.scheduleTick(gen);
    this.emit();
  }

  private halt(): void {
    this.gen++;
    const t = this.deps.timers;
    if (this.pollTimer !== undefined) t.clearTimeout(this.pollTimer);
    if (this.tickTimer !== undefined) t.clearTimeout(this.tickTimer);
    if (this.pendingTimer !== undefined) t.clearTimeout(this.pendingTimer);
    this.pollTimer = this.tickTimer = this.pendingTimer = undefined;
  }

  private async pollOnce(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    this.pollTimer = undefined;
    try {
      const watcher = this.watcher;
      if (watcher) {
        const update = await watcher.poll();
        if (gen !== this.gen) return;
        this.sessions = update.sessions;
        this.tracker.apply(update);
        this.emit();
      }
    } catch (e) {
      this.deps.log(`poll failed: ${errText(e)}`);
    }
    if (gen === this.gen) this.pollTimer = this.deps.timers.setTimeout(() => void this.pollOnce(gen), this.pollMs);
  }

  private scheduleTick(gen: number): void {
    const ms = this.demoOn ? Math.min(this.tickMs, 500) : this.tickMs;
    this.tickTimer = this.deps.timers.setTimeout(() => {
      if (gen !== this.gen) return;
      this.emit();
      this.scheduleTick(gen);
    }, ms);
  }

  private compute(): AgentSnapshot[] | undefined {
    const now = this.deps.now();
    if (this.demoOn) {
      return this.safe(() => this.deps.demo?.snapshot(now) ?? [], 'demo snapshot');
    }
    const agents = this.safe(() => this.tracker.snapshot(now), 'snapshot');
    const filter = this.deps.filterAgents;
    if (agents === undefined || filter === undefined) return agents;
    return this.safe(() => filter(agents, this.sessions), 'filter agents') ?? agents;
  }

  private emit(force = false): void {
    if (!this.visible) return;
    const agents = this.compute();
    if (!agents) return;
    const key = agentsKey(agents);
    if (key === this.lastKey) return;
    const wait = force ? 0 : this.lastPublishAt + this.gapMs - this.deps.now();
    if (wait <= 0) {
      if (this.pendingTimer !== undefined) {
        this.deps.timers.clearTimeout(this.pendingTimer);
        this.pendingTimer = undefined;
      }
      this.lastKey = key;
      this.lastPublishAt = this.deps.now();
      this.safe(() => this.deps.publish({ type: 'agents', agents }), 'publish');
    } else if (this.pendingTimer === undefined) {
      const gen = this.gen;
      this.pendingTimer = this.deps.timers.setTimeout(() => {
        this.pendingTimer = undefined;
        if (gen === this.gen) this.emit();
      }, wait);
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
