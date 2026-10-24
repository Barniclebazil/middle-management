/**
 * Usage words and levels for the wall clock, the calendar and the Usage panel. Pure (no DOM). Times are epoch ms and
 * clock times use the local time zone.
 */
import type { ProbeState, UsageSnapshot, UsageWindow, UsageWindowId } from '../../src/shared/protocol.ts';

export type UsageLevel = 'ok' | 'warn' | 'danger' | 'unknown';

/** A reading older than this is stale (the probe runs about every 5 minutes while the office is visible). */
export const STALE_MS = 15 * 60_000;

/** Percent used to a level: ok below 60, warn 60 to 84, danger from 85, unknown for null. */
export function usageLevel(pct: number | null): UsageLevel {
  if (pct === null || !Number.isFinite(pct)) return 'unknown';
  if (pct < 60) return 'ok';
  if (pct < 85) return 'warn';
  return 'danger';
}

/** Paper on a desk for a context use: 0 to 4 sheets (one per started quarter), `warn` from 90 percent. */
export function contextPile(pct: number | undefined): { sheets: 0 | 1 | 2 | 3 | 4; warn: boolean } {
  if (pct === undefined || !Number.isFinite(pct) || pct <= 0) return { sheets: 0, warn: false };
  const sheets = Math.min(4, Math.ceil(pct / 25)) as 1 | 2 | 3 | 4;
  return { sheets, warn: pct >= 90 };
}

/** A window as it stands now: one whose reset time has passed counts as reset (0 percent, no state). */
export interface EffectiveWindow {
  id: UsageWindowId;
  pct: number | null;
  resetsAt?: number;
  asOf: number;
  state?: 'warning' | 'blocked';
  /** True when the window's reset time has passed. */
  reset: boolean;
}

export function effectiveWindow(w: UsageWindow, now: number): EffectiveWindow {
  if (w.resetsAt !== undefined && w.resetsAt <= now) return { id: w.id, pct: 0, asOf: w.asOf, reset: true };
  const out: EffectiveWindow = { id: w.id, pct: w.pct, asOf: w.asOf, reset: false };
  if (w.resetsAt !== undefined) out.resetsAt = w.resetsAt;
  if (w.state) out.state = w.state;
  return out;
}

/** The window with this id as it stands now, or undefined when the snapshot has none. */
export function windowOf(snapshot: UsageSnapshot | null, id: UsageWindowId, now: number): EffectiveWindow | undefined {
  const w = snapshot?.windows.find((x) => x.id === id);
  return w ? effectiveWindow(w, now) : undefined;
}

/** True when there is no reading or the newest one is older than STALE_MS. */
export function isStale(snapshot: UsageSnapshot | null, now: number): boolean {
  if (!snapshot || snapshot.asOf === undefined) return true;
  return now - snapshot.asOf > STALE_MS;
}

/** What the art needs to draw the ring (`five_hour`, clock) or the calendar (`seven_day`). */
export interface RingState {
  pct: number | null;
  level: UsageLevel;
  stale: boolean;
  blocked: boolean;
  /** The window has reset since the reading. */
  reset: boolean;
}

export function ringState(snapshot: UsageSnapshot | null, id: UsageWindowId, now: number): RingState {
  const w = windowOf(snapshot, id, now);
  const pct = w ? w.pct : null;
  return { pct, level: usageLevel(pct), stale: isStale(snapshot, now), blocked: !!w && w.state === 'blocked', reset: !!w && w.reset };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** "22:40". */
export function clockText(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const startOfDay = (at: number): number => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** "45m", "2h 10m", "3d 4h", "1h", "2d" (rounded up to the minute, at least 1m; zero parts are dropped). */
export function shortSpan(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 60_000));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  if (h < 24) return total % 60 ? `${h}h ${total % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** A clock time with a day when it is not today: "22:40", "tomorrow 00:30", "Thu 09:00", "3 Nov 09:00". */
export function whenText(at: number, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  const t = clockText(at);
  if (days <= 0) return t;
  if (days === 1) return `tomorrow ${t}`;
  if (days < 7) return `${DAYS[new Date(at).getDay()]} ${t}`;
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${t}`;
}

/** "resets 22:40 (in 2h 10m)"; "reset" once the time has passed; '' when the time is unknown. */
export function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return '';
  if (resetsAt <= now) return 'reset';
  return `resets ${whenText(resetsAt, now)} (in ${shortSpan(resetsAt - now)})`;
}

/** "just now", "2 min ago", "1h 5m ago", "3d ago". */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Why there is no reading, in plain words. */
export function probeNote(probe: ProbeState): string {
  switch (probe) {
    case 'signedOut': return 'Not signed in to a Claude account';
    case 'unsupported': return 'This Claude Code cannot report usage';
    case 'off': return 'Usage checks are switched off';
    case 'failed': return 'Could not read usage, will retry';
    case 'running': return 'Reading usage…';
    default: return 'Usage not read yet';
  }
}

/**
 * The empty Usage panel's one message. `probe` is the panel's probe note ('' when none). When there is a note it is the
 * message (no second "No usage to show"); the Refresh hint goes with the plain "not read yet" cases.
 */
export function emptyUsageView(probe: string): { title: string; hint?: string } {
  const hint = 'Press Refresh to read it from Claude Code.';
  if (probe === '') return { title: 'No usage reading yet', hint };
  return probe === probeNote('idle') ? { title: probe, hint } : { title: probe };
}

/** "Updated 2 min ago" for the Usage panel; '' when there is no reading. */
export function updatedText(snapshot: UsageSnapshot | null, now: number): string {
  if (!snapshot || snapshot.asOf === undefined) return '';
  return `Updated ${agoText(snapshot.asOf, now)}`;
}

/**
 * The time the "BACK 17:30" plate shows: when the blocked window resets (the latest one when several are blocked).
 * Blocked windows whose reset has passed are ignored when `now` is given. Null when nothing is blocked or the reset
 * time is unknown. With `now`, a time on another day carries the day ("Thu 09:00").
 */
export function backAt(snapshot: UsageSnapshot | null, now?: number): string | null {
  let at: number | undefined;
  for (const w of snapshot?.windows ?? []) {
    if (w.state !== 'blocked' || w.resetsAt === undefined) continue;
    if (now !== undefined && w.resetsAt <= now) continue;
    if (at === undefined || w.resetsAt > at) at = w.resetsAt;
  }
  if (at === undefined) return null;
  return now === undefined ? clockText(at) : whenText(at, now);
}

/** Tooltip line for one window: "34% used · resets 22:40 (in 2h 10m)". */
export function windowTooltip(snapshot: UsageSnapshot | null, id: UsageWindowId, now: number): string {
  if (!snapshot) return 'Usage not read yet';
  if (snapshot.kind === 'apiKey') return 'API-key billing: cost is shown ≈ at API prices';
  const w = windowOf(snapshot, id, now);
  if (!w || w.pct === null) return probeNote(snapshot.probe);
  const parts: string[] = [];
  if (w.state === 'blocked') {
    const back = backAt(snapshot, now);
    parts.push(back ? `Limit reached · back ${back}` : 'Limit reached');
  } else if (w.reset) {
    parts.push('New window · 0% used');
  } else {
    parts.push(`${Math.round(w.pct)}% used`);
    const r = resetText(w.resetsAt, now);
    if (r) parts.push(r);
  }
  if (isStale(snapshot, now) && snapshot.asOf !== undefined) parts.push(`updated ${agoText(snapshot.asOf, now)}`);
  return parts.join(' · ');
}

/** The wall clock's tooltip: the 5-hour window. */
export function clockTooltip(snapshot: UsageSnapshot | null, now: number): string {
  return windowTooltip(snapshot, 'five_hour', now);
}

/** The wall calendar's tooltip: the weekly window. */
export function calendarTooltip(snapshot: UsageSnapshot | null, now: number): string {
  return windowTooltip(snapshot, 'seven_day', now);
}

/** "$1.23", tiny amounts "<$0.01", '' when unknown. */
function usd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v < 0) return '';
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/**
 * Cost wording. API-key users have no windows, so their cost is an estimate and says so: "≈ $1.23 at API prices".
 * Everyone else gets the plain figure.
 */
export function costText(snapshot: UsageSnapshot | null, costUsd: number | undefined): string {
  const t = usd(costUsd);
  if (!t) return '';
  return snapshot?.kind === 'apiKey' ? `≈ ${t} at API prices` : t;
}
