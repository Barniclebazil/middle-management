/**
 * The manager's in-tray: what is waiting for you, worked out from the agent snapshots. Pure (no DOM).
 *
 * Sources, per agent:
 * - `lastReport` of a main session: a finished report ('report').
 * - `plans` with status 'pending': a plan waiting for sign-off ('plan').
 * - `pending` (an office run blocked on `canUseTool`): 'question', 'approval' (permission) or the plan itself.
 * - `activity: 'needsYou'` with no `pending` (a session waiting in another window): 'attention'.
 *
 * Only main sessions file items. A subagent's guessed needsYou (a slow Edit/Write looks like an approval prompt) is
 * noise here, and when a subagent really needs the user, Claude Code asks in the parent session, which files it.
 *
 * Things that block a worker right now (questions, approvals, attention, a plan an office run is blocked on) are
 * urgent and always unread: a read mark never hides them. Reports and idle pending plans can be marked read.
 */
import type { PlanRef } from '../../src/shared/protocol.ts';
import type { AgentView } from './targets.ts';

export type InboxKind = 'report' | 'plan' | 'question' | 'approval' | 'attention';
export type InboxUrgency = 'urgent' | 'normal';

export interface InboxItem {
  /** Stable across snapshots: `report:<agentId>:<at>`, `plan:<agentId>:<planId or requestId>`, `question:<agentId>:<requestId>`, `approval:<agentId>:<requestId>`, `attention:<agentId>:<since>`. */
  key: string;
  kind: InboxKind;
  urgency: InboxUrgency;
  /** Headline: the session title (reports, questions, approvals), or the plan's title. */
  title: string;
  /** One line under the title: the first line of a report, or what the worker wants. */
  detail: string;
  agentId: string;
  /** Epoch ms: when the report finished, the plan was proposed, or the worker began waiting. */
  at: number;
  /** Whether the user has marked it read. Always false for blocking items. */
  read: boolean;
  /** Epoch ms of the read mark. */
  readAt?: number;
  /** For plan items that have a PlanRef: its id (the `getPlan` argument). */
  planId?: string;
  /** For question, approval and blocking plan items: the request id. */
  requestId?: string;
}

/** The part of `InboxReadStore` that deriving needs. */
export interface InboxReadLookup { readAt(key: string): number | undefined }

/** A finished report older than this is no longer listed. */
export const REPORT_MAX_AGE_MS = 7 * 24 * 3600_000;
/** A read mark for an item that is gone is kept this long (an agent can drop out and come back), then pruned. */
export const READ_KEEP_MS = 3 * 24 * 3600_000;

const DETAIL_CHARS = 140;

/** First non-empty line of a report, without markdown heading marks, cut to one short line. */
export function reportPreview(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*_\-]+/, '').trim();
    if (line) return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1).trimEnd()}…` : line;
  }
  return '';
}

const PENDING_DETAIL = { permission: 'Wants your OK', question: 'Has a question', plan: 'Has a plan to sign off' } as const;

/** Everything waiting for the user, urgent first, then newest first. */
export function deriveInbox(agents: readonly AgentView[], read: InboxReadLookup, now: number): InboxItem[] {
  const items: InboxItem[] = [];
  const add = (it: Omit<InboxItem, 'read' | 'readAt'>, blocking: boolean): void => {
    const readAt = blocking ? undefined : read.readAt(it.key);
    const item: InboxItem = { ...it, read: readAt !== undefined };
    if (readAt !== undefined) item.readAt = readAt;
    items.push(item);
  };
  for (const a of agents) {
    if (a.kind !== 'main') continue;
    const gone = a.status === 'done';
    const pending = gone ? undefined : a.pending;
    let planBlocked = pending?.kind === 'plan';
    if (a.lastReport && now - a.lastReport.at <= REPORT_MAX_AGE_MS) {
      add({ key: `report:${a.id}:${a.lastReport.at}`, kind: 'report', urgency: 'normal', title: a.title, detail: reportPreview(a.lastReport.text), agentId: a.id, at: a.lastReport.at }, false);
    }
    const waiting = (a.plans ?? []).filter((p: PlanRef) => p.status === 'pending');
    waiting.sort((x, y) => x.at - y.at);
    for (let i = 0; i < waiting.length; i++) {
      const p = waiting[i]!;
      // An office run blocked on a plan is blocked on the newest pending one.
      const blocking = planBlocked && i === waiting.length - 1;
      const it: Omit<InboxItem, 'read' | 'readAt'> = {
        key: `plan:${a.id}:${p.id}`, kind: 'plan', urgency: blocking ? 'urgent' : 'normal', title: p.title, detail: `${a.title} · waiting for sign-off`,
        agentId: a.id, at: p.at, planId: p.id,
      };
      if (blocking) it.requestId = pending!.requestId;
      add(it, blocking);
      if (blocking) planBlocked = false;
    }
    if (pending) {
      const detail = PENDING_DETAIL[pending.kind];
      if (pending.kind === 'plan') {
        // The plan was not in `plans` (older host or not yet indexed): still show the request.
        if (planBlocked) add({ key: `plan:${a.id}:${pending.requestId}`, kind: 'plan', urgency: 'urgent', title: a.title, detail, agentId: a.id, at: a.since, requestId: pending.requestId }, true);
      } else {
        const kind = pending.kind === 'question' ? 'question' : 'approval';
        add({ key: `${kind}:${a.id}:${pending.requestId}`, kind, urgency: 'urgent', title: a.title, detail: a.detail ?? detail, agentId: a.id, at: a.since, requestId: pending.requestId }, true);
      }
    } else if (!gone && a.activity === 'needsYou') {
      add({ key: `attention:${a.id}:${a.since}`, kind: 'attention', urgency: 'urgent', title: a.title, detail: a.detail ?? 'Waiting for you', agentId: a.id, at: a.since }, true);
    }
  }
  return items.sort((x, y) => (x.urgency === y.urgency ? 0 : x.urgency === 'urgent' ? -1 : 1) || y.at - x.at || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** The in-tray badge: how many items are unread, and whether any unread one is urgent. */
export function badge(items: readonly InboxItem[]): { count: number; urgent: boolean } {
  let count = 0;
  let urgent = false;
  for (const it of items) {
    if (it.read) continue;
    count++;
    if (it.urgency === 'urgent') urgent = true;
  }
  return { count, urgent };
}

/**
 * Drops read marks for items that are gone and were marked more than READ_KEEP_MS ago (marks for current items always
 * stay). Returns a new map; the input is not changed.
 */
export function pruneRead(readMap: Readonly<Record<string, number>>, items: readonly { key: string }[], now: number): Record<string, number> {
  const live = new Set(items.map((i) => i.key));
  const out: Record<string, number> = {};
  for (const [key, at] of Object.entries(readMap)) {
    if (live.has(key) || (Number.isFinite(at) && now - at <= READ_KEEP_MS)) out[key] = at;
  }
  return out;
}
