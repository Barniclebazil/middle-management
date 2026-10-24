// Cost tracking for Claude Code sessions. The SDK's `result.total_cost_usd` is a RUNNING session total, not a per-turn
// figure, and it survives a resume (the CLI restores it from the transcript's `cost-state`); see docs/sdk-spike.md
// section 14a. So the cost of one turn is the difference between two consecutive totals of the same session id.
// No `vscode` import.

export interface CostObservation {
  /** Cost of the turn that just ended: this total minus the previous one. Never negative. */
  turnUsd: number;
  /** The session's running total after this result (what the SDK reported). */
  totalUsd: number;
}

export interface CostTracker {
  /**
   * Set the baseline of a session that has history this tracker has not seen (a resume). Use the transcript's last
   * `cost-state.totalCostUSD` or a stored total. Without it the first result of a resumed session would count its whole
   * lifetime cost as one turn. Ignored when the session already has a baseline (what was observed live is more exact),
   * and for values that are not finite and >= 0.
   */
  seed(sessionId: string, totalUsd: number): void;
  /** Record a result's `total_cost_usd` and return the turn delta and the new total. */
  observe(sessionId: string, totalCostUsd: number): CostObservation;
  /** The latest known total of one session, or undefined when nothing was seeded or observed. */
  total(sessionId: string): number | undefined;
  /** Sum of the latest totals of every session. Duplicates and re-emitted results cannot double count. */
  sum(): number;
  /** Drop one session's baseline. */
  forget(sessionId: string): void;
}

function clean(v: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function createCostTracker(): CostTracker {
  const totals = new Map<string, number>();
  return {
    seed(sessionId, totalUsd) {
      const v = clean(totalUsd);
      if (v === undefined || totals.has(sessionId)) return;
      totals.set(sessionId, v);
    },
    observe(sessionId, totalCostUsd) {
      const prev = totals.get(sessionId);
      const v = clean(totalCostUsd);
      // A result without a usable total (missing, NaN, negative) is not a cost event: keep the baseline.
      if (v === undefined) return { turnUsd: 0, totalUsd: prev ?? 0 };
      // No baseline: first sight of this session, so its turn cost is its whole total (a fresh session starts at 0).
      const base = prev ?? 0;
      // A total below the baseline means the SDK's counter was reset (a new process that did not restore the
      // transcript's `cost-state`, or a cleared session). Its new total then counts only what was spent since the
      // reset, so that total IS the turn cost. The baseline moves down so later deltas are measured from the new
      // counter. Never report a negative turn.
      const turnUsd = v >= base ? v - base : v;
      totals.set(sessionId, v);
      return { turnUsd, totalUsd: v };
    },
    total: (sessionId) => totals.get(sessionId),
    sum() {
      let s = 0;
      for (const v of totals.values()) s += v;
      return s;
    },
    forget(sessionId) {
      totals.delete(sessionId);
    },
  };
}
