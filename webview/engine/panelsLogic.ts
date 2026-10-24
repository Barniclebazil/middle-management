/**
 * Pure helpers for the In-tray, Plans and Usage panels: row models, wording and formatting. No DOM (the panels in
 * `inboxPanel.ts`, `plansPanel.ts` and `usagePanel.ts` only turn these into elements), so the tests import this file.
 */
import type { ConversationItem, ProbeState, UsageExtra, UsageSnapshot, UsageWindowId } from '../../src/shared/protocol.ts';
import type { InboxItem, InboxKind } from './inboxLogic.ts';
import type { PlanCard } from './plansLogic.ts';
import { isStale, probeNote, shortSpan, usageLevel, whenText, effectiveWindow } from './usageLogic.ts';
import type { UsageLevel } from './usageLogic.ts';
import { USAGE_WINDOW_IDS } from '../../src/shared/protocol.ts';

// ---------------------------------------------------------------------------
// Time

/** Compact relative time for list rows: "now", "5m", "2h", "3d" (older than a week: "1w"). */
export function shortAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/** Same as `shortAgo` with "ago" ("5m ago", "just now"). */
export function agoWords(at: number, now: number): string {
  const t = shortAgo(at, now);
  return t === 'now' ? 'just now' : `${t} ago`;
}

// ---------------------------------------------------------------------------
// In-tray

export const INBOX_KIND_LABEL: Readonly<Record<InboxKind, string>> = {
  report: 'Report',
  plan: 'Plan',
  question: 'Question',
  approval: 'Approval',
  attention: 'Needs you',
};

/** What clicking a row does: open the report view, the plan view, or the case file. */
export type InboxAction = 'report' | 'plan' | 'case';

export interface InboxRow {
  key: string;
  kindLabel: string;
  urgent: boolean;
  unread: boolean;
  /** "5m", "2h". */
  time: string;
  /** For the tooltip and screen readers: "Report, unread, 5m ago". */
  describe: string;
  action: InboxAction;
}

/** A plan with no `PlanRef` yet (`planId` missing) cannot be fetched, so it opens the case file, where the plan card is. */
export function inboxAction(item: InboxItem): InboxAction {
  if (item.kind === 'report') return 'report';
  if (item.kind === 'plan' && item.planId) return 'plan';
  return 'case';
}

export function inboxRow(item: InboxItem, now: number): InboxRow {
  const kindLabel = INBOX_KIND_LABEL[item.kind];
  const unread = !item.read;
  const urgent = item.urgency === 'urgent';
  const time = shortAgo(item.at, now);
  const state = urgent ? 'needs you now' : unread ? 'unread' : 'read';
  return { key: item.key, kindLabel, urgent, unread, time, describe: `${kindLabel}, ${state}, ${agoWords(item.at, now)}`, action: inboxAction(item) };
}

/** Header line over the list: "3 unread · 1 needs you", "All read", "" when empty. */
export function inboxSummary(items: readonly InboxItem[]): string {
  if (items.length === 0) return '';
  const unread = items.filter((i) => !i.read).length;
  const urgent = items.filter((i) => i.urgency === 'urgent').length;
  if (unread === 0) return 'All read';
  return urgent > 0 ? `${unread} unread · ${urgent} need${urgent === 1 ? 's' : ''} you` : `${unread} unread`;
}

/** Keys that "Mark all read" marks: unread items a read mark can hide (urgent ones are never hidden by a mark). */
export function markAllKeys(items: readonly InboxItem[]): string[] {
  return items.filter((i) => !i.read && i.urgency !== 'urgent').map((i) => i.key);
}

/** One block of a turn: a single item, or a run of tool steps shown together. */
export type TurnBlock =
  | { kind: 'item'; item: ConversationItem }
  | { kind: 'tools'; items: Extract<ConversationItem, { kind: 'tool' }>[] };

/** Groups consecutive tool steps into one block and drops thinking markers. */
export function turnBlocks(items: readonly ConversationItem[]): TurnBlock[] {
  const out: TurnBlock[] = [];
  for (const it of items) {
    if (it.kind === 'thinking') continue;
    if (it.kind === 'tool') {
      const last = out[out.length - 1];
      if (last && last.kind === 'tools') last.items.push(it);
      else out.push({ kind: 'tools', items: [it] });
    } else out.push({ kind: 'item', item: it });
  }
  return out;
}

/** "3 steps" / "1 step" with the number that went wrong: "4 steps, 1 failed". */
export function toolRunSummary(items: readonly { state: string }[]): string {
  const failed = items.filter((i) => i.state === 'error' || i.state === 'denied').length;
  const base = `${items.length} step${items.length === 1 ? '' : 's'}`;
  return failed ? `${base}, ${failed} failed` : base;
}

// ---------------------------------------------------------------------------
// Plans

/** "waiting 2h", "approved 3h ago", "sent back 1d ago". */
export function planAgeText(card: Pick<PlanCard, 'column' | 'at'>, now: number): string {
  switch (card.column) {
    case 'waiting': return `waiting ${shortAgo(card.at, now) === 'now' ? 'just now' : shortAgo(card.at, now)}`;
    case 'approved': return `approved ${agoWords(card.at, now)}`;
    default: return `sent back ${agoWords(card.at, now)}`;
  }
}

/** The line under the plan view's decision area for a plan that cannot be decided here. */
export function planReadOnlyHint(status: string, controlled: boolean): string {
  if (status !== 'pending') return '';
  return controlled ? 'Nobody is waiting on this plan right now.' : 'Decide in Claude Code: this session runs outside the office.';
}

/** "1 superseded plan not shown", '' for none. */
export function supersededText(n: number): string {
  return n > 0 ? `${n} superseded plan${n === 1 ? '' : 's'} hidden` : '';
}

/** "12,400 chars" style size for the plan view footer. */
export function charsText(n: number): string {
  return `${new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(n)))} chars`;
}

// ---------------------------------------------------------------------------
// Usage

export const WINDOW_LABELS: Readonly<Record<UsageWindowId, string>> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
};

export const LEVEL_WORDS: Readonly<Record<UsageLevel, string>> = {
  ok: 'OK',
  warn: 'Getting high',
  danger: 'Near the limit',
  unknown: 'No reading',
};

export interface UsageBarRow {
  id: UsageWindowId;
  label: string;
  /** Fill fraction 0..1. */
  fraction: number;
  /** "34%", or "?" when there is no reading. */
  pctText: string;
  level: UsageLevel;
  /** Level in words, not colour alone: "OK", "Getting high", "Near the limit", "Limit reached", "New window". */
  levelText: string;
  blocked: boolean;
  /** The window reset since the reading. */
  reset: boolean;
  /** "resets 22:40 (in 2h 10m)", or "" when unknown. */
  resetLine: string;
  /** "Back Thu 09:00 (in 2d 3h)" for a blocked window with a known reset, else "". */
  backLine: string;
}

/** One row per window the snapshot has, in the fixed order (5-hour, weekly, Opus, Sonnet). Unknown ids are skipped. */
export function usageBarRows(snapshot: UsageSnapshot | null, now: number): UsageBarRow[] {
  if (!snapshot) return [];
  const rows: UsageBarRow[] = [];
  for (const id of USAGE_WINDOW_IDS) {
    const raw = snapshot.windows.find((w) => w.id === id);
    if (!raw) continue;
    const w = effectiveWindow(raw, now);
    const blocked = w.state === 'blocked';
    const pct = w.pct === null ? null : Math.max(0, Math.min(100, w.pct));
    const level: UsageLevel = blocked ? 'danger' : usageLevel(pct);
    const fraction = blocked ? 1 : pct === null ? 0 : pct / 100;
    let resetLine = '';
    if (w.resetsAt !== undefined && !w.reset && !blocked) resetLine = `resets ${whenText(w.resetsAt, now)} (in ${shortSpan(w.resetsAt - now)})`;
    else if (w.reset) resetLine = 'just reset';
    rows.push({
      id,
      label: WINDOW_LABELS[id],
      fraction,
      pctText: pct === null ? '?' : `${Math.round(pct)}%`,
      level,
      levelText: blocked ? 'Limit reached' : w.reset ? 'New window' : LEVEL_WORDS[level],
      blocked,
      reset: w.reset,
      resetLine,
      backLine: blocked && w.resetsAt !== undefined ? `Back ${whenText(w.resetsAt, now)} (in ${shortSpan(w.resetsAt - now)})` : '',
    });
  }
  return rows;
}

/** "£12.34", with the currency given by an ISO 4217 code (USD when absent). An unknown code falls back to "12.34 XYZ". */
export function formatMoney(amount: number, currency: string | undefined): string {
  const code = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

export interface ExtraRow {
  usedText: string;
  limitText: string;
  /** 0..1, or null when it cannot be worked out. */
  fraction: number | null;
  pctText: string;
  level: UsageLevel;
  levelText: string;
}

/** Extra (pay-as-you-go) usage, or null when it is off or absent. */
export function extraRow(extra: UsageExtra | undefined): ExtraRow | null {
  if (!extra || !extra.enabled) return null;
  const used = extra.usedUsd;
  const limit = extra.limitUsd;
  let pct: number | null = typeof extra.pct === 'number' && Number.isFinite(extra.pct) ? extra.pct : null;
  if (pct === null && used !== undefined && limit !== undefined && limit > 0) pct = (used / limit) * 100;
  if (pct !== null) pct = Math.max(0, Math.min(100, pct));
  const level = usageLevel(pct);
  return {
    usedText: used !== undefined && Number.isFinite(used) ? formatMoney(used, extra.currency) : '',
    limitText: limit !== undefined && Number.isFinite(limit) ? formatMoney(limit, extra.currency) : 'no limit set',
    fraction: pct === null ? null : pct / 100,
    pctText: pct === null ? '' : `${Math.round(pct)}%`,
    level,
    levelText: LEVEL_WORDS[level],
  };
}

/** How long a Refresh click is ignored, matching the host's debounce. */
export const REFRESH_COOLDOWN_MS = 60_000;

export interface RefreshButtonState {
  label: string;
  disabled: boolean;
  /** Tooltip. */
  title: string;
}

/** The Refresh button: "Checking…" while a probe runs, disabled for 60 s after a click. */
export function refreshButtonState(probe: ProbeState | undefined, clickedAt: number | null, now: number): RefreshButtonState {
  if (probe === 'running') return { label: 'Checking…', disabled: true, title: 'Reading your usage now' };
  if (clickedAt !== null && now - clickedAt < REFRESH_COOLDOWN_MS) {
    const left = Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - (now - clickedAt)) / 1000));
    return { label: 'Refresh', disabled: true, title: `You can refresh again in ${left} s` };
  }
  return { label: 'Refresh', disabled: false, title: 'Read your usage again' };
}

/** Whether to show the probe note: any state in which there is a reason the reading is missing or not coming. */
export function probeNoteFor(snapshot: UsageSnapshot | null): string {
  if (!snapshot) return 'Usage not read yet';
  switch (snapshot.probe) {
    case 'signedOut': case 'unsupported': case 'off': case 'failed': return probeNote(snapshot.probe);
    case 'idle': return snapshot.windows.length === 0 && snapshot.kind !== 'apiKey' ? probeNote('idle') : '';
    default: return '';
  }
}

/** "Next check in 4m", or "" when none is scheduled. */
export function nextCheckText(snapshot: UsageSnapshot | null, now: number): string {
  const at = snapshot?.nextAt;
  if (at === undefined || !Number.isFinite(at) || at <= now) return '';
  return `Next check in ${shortSpan(at - now)}`;
}

/** The stale note: "This reading is over 15 minutes old.", or "" when fresh or when there is no reading. */
export function staleNote(snapshot: UsageSnapshot | null, now: number): string {
  if (!snapshot || snapshot.asOf === undefined) return '';
  return isStale(snapshot, now) ? 'This reading is more than 15 minutes old.' : '';
}

export interface CostRow {
  agentId: string;
  title: string;
  usd: number;
}

/** Agents with a cost, most expensive first (ties by title), plus the total. */
export function costRows(agents: readonly { id: string; title: string; costUsd?: number }[]): { rows: CostRow[]; total: number } {
  const rows: CostRow[] = [];
  let total = 0;
  for (const a of agents) {
    if (a.costUsd === undefined || !Number.isFinite(a.costUsd) || a.costUsd <= 0) continue;
    rows.push({ agentId: a.id, title: a.title, usd: a.costUsd });
    total += a.costUsd;
  }
  rows.sort((x, y) => y.usd - x.usd || (x.title < y.title ? -1 : x.title > y.title ? 1 : 0));
  return { rows, total };
}
