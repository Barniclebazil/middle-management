// The usage service: merges every source of plan-usage numbers (the SDK probe, the `~/.claude.json` cache, rate-limit
// events from office runs) into one `UsageSnapshot`, schedules the probe, and posts the snapshot when it changes.
//
// Schedule (only while the office is visible; hidden = no timers at all):
//   - `setVisible(true)`: start the cache poller (reads `.claude.json` at once, then every 15 s), and probe after 3 s when the
//     last probe is more than 5 min old (otherwise when it falls due), then every 5 min.
//   - one probe at a time; on failure back off 5 -> 10 -> 20 -> 30 min (then stay at 30);
//   - `unsupported` stops probing until the extension restarts; `signedOut` stops until a manual `refresh()`;
//   - a manual `refresh()` is debounced to once every 60 s;
//   - `usageChecks: 'off'` never probes (state `off`); the cache and rate-limit events still feed the snapshot.
//
// No `vscode` import. The clock, timers, file system, probe and post function are all injected. Logs carry states and
// counts only, never usage values or account data.
import { parseJsonText, parseUsageCache, MAX_CLAUDE_JSON_BYTES } from '../claude/claudeConfig.ts';
import type { UsageCacheInfo } from '../claude/claudeConfig.ts';
import type { ProbeResult } from '../manager/usageProbe.ts';
import { LIMITS, USAGE_WINDOW_IDS } from '../shared/protocol.ts';
import type { HostToWebview, ProbeState, UsageExtra, UsageSnapshot, UsageSource, UsageWindow, UsageWindowId } from '../shared/protocol.ts';
import { FilePoller } from './filePoller.ts';

export const FIRST_PROBE_DELAY_MS = 3_000;
export const PROBE_INTERVAL_MS = 5 * 60_000;
/** Delay after the 1st, 2nd, 3rd (and later) consecutive failure. */
export const BACKOFF_MS: readonly number[] = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
export const REFRESH_DEBOUNCE_MS = 60_000;
export const CACHE_POLL_MS = 15_000;
/** Longest delay a timer is given (setTimeout overflows beyond 2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type UsageChecks = 'auto' | 'off';

/** What `refresh()` did. */
export type RefreshOutcome = 'started' | 'debounced' | 'busy' | 'off' | 'unsupported' | 'hidden';

type Reading = 'probe' | 'cache' | 'event';

export interface UsageServiceDeps {
  /** Runs one probe (`runUsageProbe` with its deps bound). Must never reject; a rejection counts as a failure. */
  probe: () => Promise<ProbeResult>;
  /** Sends a `usage` message to the webview. */
  post: (msg: Extract<HostToWebview, { type: 'usage' }>) => void;
  now: () => number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** For the cache poller. */
  fs: { stat(path: string): Promise<{ mtimeMs: number; size: number }>; readFile(path: string): Promise<string> };
  /** `claudeConfigJsonPath()`. */
  configPath: string;
  /** Initial value of the `claudeOffice.usageChecks` setting (default 'auto'). Change it later with `setUsageChecks`. */
  usageChecks?: UsageChecks;
  /** True when the environment points at API-key billing (`ANTHROPIC_API_KEY` set), without ever reading the key. */
  apiKeyEnv?: () => boolean;
  /**
   * Optional: take the answer from an idle office run instead of spawning a probe. It must return a result ONLY when that
   * run's query has never been asked for usage (a repeat `usage()` call on one query is a stale 1 ms cache hit,
   * docs/sdk-spike.md 14c), and `undefined` otherwise, in which case a fresh probe is spawned. Not wired by default.
   */
  idleProbe?: () => Promise<ProbeResult | undefined>;
  /** Called with every successful probe result (for example to feed the model list to the memo). */
  onProbeOk?: (result: Extract<ProbeResult, { status: 'ok' }>) => void;
  log?: (msg: string) => void;
}

interface Stored {
  win: UsageWindow;
  src: Reading;
}

export class UsageService {
  readonly #deps: UsageServiceDeps;
  readonly #log: (msg: string) => void;
  readonly #poller: FilePoller;

  #visible = false;
  #checks: UsageChecks;
  #readings = new Map<UsageWindowId, Stored>();
  #extra: UsageExtra | undefined;
  #extraAt = 0;
  #plan: string | undefined;
  #apiKeyProbe = false;
  #probeState: ProbeState = 'idle';
  #inFlight = false;
  #lastProbeAt: number | undefined;
  #lastOkAt: number | undefined;
  #failures = 0;
  #unsupported = false;
  #signedOut = false;
  #lastManualAt: number | undefined;
  #probeTimer: unknown;
  #nextAt: number | undefined;
  #resetTimer: unknown;
  #lastPosted: string | undefined;

  constructor(deps: UsageServiceDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? (() => {});
    this.#checks = deps.usageChecks ?? 'auto';
    this.#poller = new FilePoller(
      { stat: deps.fs.stat, readFile: deps.fs.readFile, timers: deps.timers, log: deps.log },
      { path: deps.configPath, intervalMs: CACHE_POLL_MS, maxBytes: MAX_CLAUDE_JSON_BYTES, onChange: (text) => this.#onCacheText(text) },
    );
  }

  // --- public API -----------------------------------------------------------------------------------------------------

  /** The office became visible or hidden. Hidden clears every timer (the poller's, the probe's and the reset tick). */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    if (visible) {
      this.#poller.start();
      this.#scheduleProbe();
      this.#scheduleResetTick();
      this.#emit();
    } else {
      this.#clearTimers();
    }
  }

  /** The `claudeOffice.usageChecks` setting changed. */
  setUsageChecks(mode: UsageChecks): void {
    if (mode === this.#checks) return;
    this.#checks = mode;
    this.#log(`usage: usageChecks ${mode}`);
    this.#clearProbeTimer();
    if (this.#visible) this.#scheduleProbe();
    this.#emit();
  }

  /** A manual refresh (the webview's `refreshUsage`). Debounced to once every 60 s; also re-arms a signed-out probe. */
  refresh(): RefreshOutcome {
    if (!this.#visible) return 'hidden';
    if (this.#checks === 'off') return 'off';
    if (this.#unsupported) return 'unsupported';
    if (this.#inFlight) return 'busy';
    const t = this.#deps.now();
    if (this.#lastManualAt !== undefined && t - this.#lastManualAt < REFRESH_DEBOUNCE_MS) return 'debounced';
    this.#lastManualAt = t;
    this.#signedOut = false;
    this.#clearProbeTimer();
    void this.#runProbe();
    return 'started';
  }

  /** The runner's `onRateLimit(windows)`: windows already in contract units. Works while hidden and with checks off. */
  onRateLimit(windows: UsageWindow[]): void {
    if (this.#apply(windows, 'event')) {
      this.#scheduleResetTick();
      this.#emit();
    }
  }

  /** The current merged snapshot (for replay on `ready`). Built fresh, so passed resets are already applied. */
  snapshot(): UsageSnapshot {
    return this.#build();
  }

  /** Stop everything (same as hiding). */
  dispose(): void {
    this.#visible = false;
    this.#clearTimers();
  }

  // --- merge ----------------------------------------------------------------------------------------------------------

  /** Newest reading per window wins. Returns whether anything changed. */
  #apply(windows: readonly UsageWindow[], src: Reading): boolean {
    let changed = false;
    for (const w of windows) {
      if (!(USAGE_WINDOW_IDS as readonly string[]).includes(w.id)) continue;
      const cur = this.#readings.get(w.id);
      if (cur === undefined) {
        this.#readings.set(w.id, { win: { ...w }, src });
        changed = true;
        continue;
      }
      const newer = w.asOf > cur.win.asOf || (w.asOf === cur.win.asOf && src === cur.src);
      if (!newer) continue;
      if (w.pct === null && cur.win.pct !== null) {
        // A reading with no number (an event without utilization) must not wipe a real one; take only its reset time and state.
        const merged: UsageWindow = { ...cur.win };
        if (w.resetsAt !== undefined) merged.resetsAt = w.resetsAt;
        if (w.state !== undefined) merged.state = w.state;
        if (JSON.stringify(merged) !== JSON.stringify(cur.win)) {
          this.#readings.set(w.id, { win: merged, src: cur.src });
          changed = true;
        }
        continue;
      }
      this.#readings.set(w.id, { win: { ...w }, src });
      changed = true;
    }
    return changed;
  }

  #build(): UsageSnapshot {
    const now = this.#deps.now();
    const windows: UsageWindow[] = [];
    const sources = new Set<Reading>();
    for (const id of USAGE_WINDOW_IDS) {
      const r = this.#readings.get(id);
      if (r === undefined) continue;
      const win: UsageWindow = { ...r.win };
      if (win.resetsAt !== undefined && win.resetsAt <= now) {
        // The window has reset since this reading; the number is 0 until a newer reading arrives. `asOf` stays the
        // reading's own time, which is the note that this 0 is inferred.
        win.pct = 0;
        delete win.state;
      }
      windows.push(win);
      sources.add(r.src);
      if (windows.length >= LIMITS.usageWindows) break;
    }
    const source: UsageSource = sources.size === 0 ? 'none' : sources.size === 1 ? [...sources][0]! : 'mixed';
    const apiKeySignal = this.#apiKeyProbe || (this.#deps.apiKeyEnv?.() ?? false);
    const kind: UsageSnapshot['kind'] = this.#plan !== undefined || windows.length > 0 ? 'plan' : apiKeySignal ? 'apiKey' : 'unknown';
    const snap: UsageSnapshot = { kind, windows, source, probe: this.#checks === 'off' ? 'off' : this.#probeState };
    if (this.#extra !== undefined) snap.extra = { ...this.#extra };
    if (this.#plan !== undefined) snap.plan = this.#plan;
    if (windows.length > 0) snap.asOf = Math.max(...windows.map((w) => w.asOf));
    else if (this.#lastOkAt !== undefined) snap.asOf = this.#lastOkAt;
    if (this.#nextAt !== undefined && this.#visible && this.#checks !== 'off') snap.nextAt = this.#nextAt;
    return snap;
  }

  #emit(): void {
    const snap = this.#build();
    const key = JSON.stringify(snap);
    if (key === this.#lastPosted) return;
    this.#lastPosted = key;
    try {
      this.#deps.post({ type: 'usage', usage: snap });
    } catch (e) {
      this.#log(`usage: post failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  // --- cache ----------------------------------------------------------------------------------------------------------

  #onCacheText(text: string | undefined): void {
    if (text === undefined) return; // no .claude.json (yet)
    const parsed = parseJsonText(text);
    if (!parsed.ok) {
      this.#log(`usage: cache unreadable (${parsed.reason})`);
      return;
    }
    this.#applyCache(parseUsageCache(parsed.value, this.#deps.now()));
  }

  #applyCache(info: UsageCacheInfo): void {
    let changed = this.#apply(info.windows, 'cache');
    if (info.extra !== undefined) {
      const at = info.fetchedAt ?? this.#deps.now();
      if (at >= this.#extraAt) {
        this.#extra = info.extra;
        this.#extraAt = at;
        changed = true;
      }
    }
    this.#log(`usage: cache read, ${info.windows.length} windows`);
    if (changed) this.#scheduleResetTick();
    this.#emit();
  }

  // --- probe scheduling -----------------------------------------------------------------------------------------------

  get #canProbe(): boolean {
    return this.#visible && this.#checks === 'auto' && !this.#unsupported && !this.#signedOut;
  }

  #intervalMs(): number {
    return this.#failures > 0 ? BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length) - 1]! : PROBE_INTERVAL_MS;
  }

  /** Arm the one probe timer: 3 s when the last probe is stale (or none yet), otherwise when the next one is due. */
  #scheduleProbe(): void {
    this.#clearProbeTimer();
    if (!this.#canProbe || this.#inFlight) return; // a running probe schedules the next one when it finishes
    const now = this.#deps.now();
    let delay = FIRST_PROBE_DELAY_MS;
    if (this.#lastProbeAt !== undefined) {
      const due = this.#lastProbeAt + this.#intervalMs();
      if (due > now) delay = Math.max(due - now, 0);
    }
    this.#armProbe(delay);
  }

  #armProbe(delay: number): void {
    this.#nextAt = this.#deps.now() + delay;
    this.#probeTimer = this.#deps.timers.setTimeout(() => {
      this.#probeTimer = undefined;
      this.#nextAt = undefined;
      void this.#runProbe();
    }, delay);
  }

  async #runProbe(): Promise<void> {
    if (this.#inFlight) return; // single flight
    if (!this.#visible || this.#checks !== 'auto' || this.#unsupported) return;
    this.#inFlight = true;
    this.#clearProbeTimer();
    this.#probeState = 'running';
    this.#emit();
    let result: ProbeResult;
    try {
      result = (await this.#deps.idleProbe?.()) ?? (await this.#deps.probe());
    } catch (e) {
      this.#log(`usage: probe rejected (${e instanceof Error ? e.name : 'error'})`);
      result = { status: 'failed', reason: 'probe error' };
    }
    this.#inFlight = false;
    this.#lastProbeAt = this.#deps.now();
    this.#finish(result);
  }

  #finish(result: ProbeResult): void {
    switch (result.status) {
      case 'ok': {
        this.#failures = 0;
        this.#probeState = 'ok';
        this.#lastOkAt = result.at;
        this.#plan = result.plan;
        this.#apiKeyProbe = result.apiKey;
        this.#apply(result.windows, 'probe');
        this.#extra = result.extra;
        this.#extraAt = result.at;
        try {
          this.#deps.onProbeOk?.(result);
        } catch (e) {
          this.#log(`usage: onProbeOk threw (${e instanceof Error ? e.name : 'error'})`);
        }
        break;
      }
      case 'unsupported':
        this.#unsupported = true;
        this.#probeState = 'unsupported';
        break;
      case 'signedOut':
        this.#signedOut = true;
        this.#probeState = 'signedOut';
        break;
      case 'failed':
        this.#failures++;
        this.#probeState = 'failed';
        break;
    }
    this.#log(`usage: probe -> ${result.status}${result.status === 'failed' ? `, failures ${this.#failures}` : ''}`);
    this.#scheduleProbe();
    this.#scheduleResetTick();
    this.#emit();
  }

  // --- reset tick -----------------------------------------------------------------------------------------------------

  /** One timer for the earliest future reset, so a passed reset shows as 0 even with no new reading. Visible only. */
  #scheduleResetTick(): void {
    if (this.#resetTimer !== undefined) this.#deps.timers.clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
    if (!this.#visible) return;
    const now = this.#deps.now();
    let next: number | undefined;
    for (const r of this.#readings.values()) {
      const at = r.win.resetsAt;
      if (at !== undefined && at > now && (next === undefined || at < next)) next = at;
    }
    if (next === undefined) return;
    const delay = Math.min(next - now + 1000, MAX_TIMER_MS);
    this.#resetTimer = this.#deps.timers.setTimeout(() => {
      this.#resetTimer = undefined;
      this.#scheduleResetTick();
      this.#emit();
    }, delay);
  }

  // --- timers ---------------------------------------------------------------------------------------------------------

  #clearProbeTimer(): void {
    if (this.#probeTimer !== undefined) this.#deps.timers.clearTimeout(this.#probeTimer);
    this.#probeTimer = undefined;
    this.#nextAt = undefined;
  }

  #clearTimers(): void {
    this.#poller.stop();
    this.#clearProbeTimer();
    if (this.#resetTimer !== undefined) this.#deps.timers.clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
  }
}
