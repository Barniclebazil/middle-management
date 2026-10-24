// The plans one agent has proposed (ExitPlanMode tool calls), read from its transcript.
//
// Transcript shapes (Claude Code 2.1.x):
//  - open:     assistant tool_use `ExitPlanMode`, `input: { plan, planFilePath }` (some builds write `input: {}`).
//  - approved: user tool_result for that tool_use id, no `is_error`; the record's `toolUseResult` is
//              `{ plan, isAgent, filePath }`, which fills in the text when the tool_use input had none.
//  - rejected: the tool_result has `is_error: true` (record `permissionDecision.decision` is 'reject', `toolDenialKind`
//              is set). When the user typed a reason, the content reads "... The user provided the following reason
//              for the rejection:  <reason>"; a plain rejection or an aborted permission request has no reason.
//  - superseded: no transcript shape. A new plan opening while an older one is still pending replaces it.
import type { PlanRef, PlanStatus } from '../shared/protocol.ts';
import { LIMITS } from '../shared/protocol.ts';

/** Plans kept per agent (the contract's `LIMITS.plansPerAgent`). */
export const MAX_PLANS = LIMITS.plansPerAgent;
/** Only this many of the newest plans keep their text in memory. */
export const MAX_PLAN_TEXTS = 3;

const REJECT_MARKER = 'reason for the rejection:';

/** What `planText` returns: the stored text of one plan. */
export interface PlanText {
  text: string;
  /** True when the plan was longer than `LIMITS.planChars` and was cut. */
  truncated: boolean;
  status: PlanStatus;
  planFilePath?: string;
  feedback?: string;
}

interface PlanEntry {
  id: string;
  at: number;
  title: string;
  status: PlanStatus;
  chars: number;
  decidedAt?: number;
  /** Absent once the plan is older than the 3 newest. */
  text?: string;
  truncated: boolean;
  planFilePath?: string;
  feedback?: string;
}

/** The first Markdown heading of `text`, else its first non-empty line, with the heading marks removed and capped. */
export function planTitle(text: string): string {
  let first: string | undefined;
  let heading: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    first ??= line;
    if (/^#{1,6}\s/.test(line)) {
      heading = line;
      break;
    }
  }
  const picked = (heading ?? first ?? '').replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
  if (picked === '') return 'Plan';
  if (picked.length <= LIMITS.planTitleChars) return picked;
  return picked.slice(0, LIMITS.planTitleChars - 1).trimEnd() + '…';
}

/** The user's reason from a rejected ExitPlanMode tool_result content, if the content carries one. */
export function rejectionFeedback(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      const t = typeof b === 'object' && b !== null ? (b as Record<string, unknown>)['text'] : undefined;
      if (typeof t === 'string') parts.push(t);
    }
    text = parts.join('\n');
  }
  if (text === undefined) return undefined;
  const at = text.indexOf(REJECT_MARKER);
  if (at < 0) return undefined;
  const reason = text.slice(at + REJECT_MARKER.length).trim();
  return reason === '' ? undefined : reason.slice(0, LIMITS.planChars);
}

export class PlanIndex {
  private plans: PlanEntry[] = [];

  clear(): void {
    this.plans = [];
  }

  has(id: string): boolean {
    return this.plans.some((p) => p.id === id);
  }

  /** Whether `id` is a plan still waiting for a decision. */
  isPending(id: string): boolean {
    return this.plans.some((p) => p.id === id && p.status === 'pending');
  }

  /**
   * An ExitPlanMode tool_use. Opens a pending plan and supersedes any older plan still pending. Seeing the same id
   * again (a re-read of the transcript) only refreshes the text.
   */
  open(id: string, at: number, text: string, planFilePath?: string): void {
    const existing = this.plans.find((p) => p.id === id);
    if (existing !== undefined) {
      if (text !== '') this.setText(existing, text);
      if (planFilePath !== undefined) existing.planFilePath = planFilePath;
      return;
    }
    for (const p of this.plans) {
      if (p.status === 'pending') {
        p.status = 'superseded';
        p.decidedAt = at;
      }
    }
    const entry: PlanEntry = { id, at, title: 'Plan', status: 'pending', chars: 0, truncated: false };
    if (planFilePath !== undefined) entry.planFilePath = planFilePath;
    this.setText(entry, text);
    this.plans.push(entry);
    this.prune();
  }

  /**
   * The tool_result of a plan. Only a pending plan is decided (a superseded one stays superseded). `text` and
   * `planFilePath` come from the result's `toolUseResult` and only fill in what the tool_use did not carry.
   */
  close(id: string, at: number, outcome: 'approved' | 'rejected', extra?: { text?: string; planFilePath?: string; feedback?: string }): void {
    const p = this.plans.find((x) => x.id === id);
    if (p === undefined || p.status !== 'pending') return;
    p.status = outcome;
    p.decidedAt = at;
    if (extra?.text !== undefined && extra.text !== '' && p.chars === 0) this.setText(p, extra.text);
    if (extra?.planFilePath !== undefined && p.planFilePath === undefined) p.planFilePath = extra.planFilePath;
    if (extra?.feedback !== undefined) p.feedback = extra.feedback;
    this.keepNewestTexts();
  }

  /** The snapshot form, oldest first. No text. */
  refs(): PlanRef[] {
    return this.plans.map((p) => {
      const ref: PlanRef = { id: p.id, at: p.at, title: p.title, status: p.status, chars: p.chars };
      if (p.decidedAt !== undefined) ref.decidedAt = p.decidedAt;
      return ref;
    });
  }

  /** The kept text of a plan, or undefined when the plan is unknown or older than the 3 newest (its text was dropped). */
  planText(id: string): PlanText | undefined {
    const p = this.plans.find((x) => x.id === id);
    if (p === undefined || p.text === undefined) return undefined;
    const out: PlanText = { text: p.text, truncated: p.truncated, status: p.status };
    if (p.planFilePath !== undefined) out.planFilePath = p.planFilePath;
    if (p.feedback !== undefined) out.feedback = p.feedback;
    return out;
  }

  private setText(p: PlanEntry, text: string): void {
    p.chars = text.length;
    p.truncated = text.length > LIMITS.planChars;
    p.text = p.truncated ? text.slice(0, LIMITS.planChars) : text;
    p.title = planTitle(text);
  }

  private prune(): void {
    while (this.plans.length > MAX_PLANS) this.plans.shift();
    this.keepNewestTexts();
  }

  private keepNewestTexts(): void {
    for (let i = 0; i < this.plans.length - MAX_PLAN_TEXTS; i++) delete this.plans[i]!.text;
  }
}
