/**
 * The Plans board (the whiteboard): plans from every agent grouped into columns. Pure (no DOM).
 *
 * Columns: waiting for sign-off (oldest first, so the one that has waited longest is on top), approved and sent back
 * (newest decision first). Superseded plans (replaced before anyone decided) are left out and only counted.
 */
import type { PlanRef, PlanStatus } from '../../src/shared/protocol.ts';
import type { AgentView } from './targets.ts';

export type PlanColumn = 'waiting' | 'approved' | 'sentBack';

/** Column order on the board, left to right. */
export const PLAN_COLUMNS: readonly PlanColumn[] = ['waiting', 'approved', 'sentBack'];

export const PLAN_COLUMN_TITLES: Readonly<Record<PlanColumn, string>> = {
  waiting: 'Waiting for sign-off',
  approved: 'Approved',
  sentBack: 'Sent back',
};

/** The column a status belongs in; null for 'superseded' (hidden). */
export function columnOf(status: PlanStatus): PlanColumn | null {
  switch (status) {
    case 'pending': return 'waiting';
    case 'approved': return 'approved';
    case 'rejected': return 'sentBack';
    default: return null;
  }
}

/** One note on the board. */
export interface PlanCard {
  /** `<agentId>:<planId>`, stable. */
  key: string;
  agentId: string;
  /** Session title and project of the agent that proposed it. */
  agentTitle: string;
  project: string;
  plan: PlanRef;
  column: PlanColumn;
  /** When it was proposed (waiting) or decided (approved, sent back); the sort time. */
  at: number;
  /** An office run is blocked on this plan right now (approving it from the board lets the worker go on). */
  blocking: boolean;
}

export interface PlanBoard {
  waiting: PlanCard[];
  approved: PlanCard[];
  sentBack: PlanCard[];
  /** Superseded plans not shown. */
  superseded: number;
}

/** Groups the plans of every agent into board columns. */
export function planBoard(agents: readonly AgentView[]): PlanBoard {
  const board: PlanBoard = { waiting: [], approved: [], sentBack: [], superseded: 0 };
  for (const a of agents) {
    const plans = a.plans ?? [];
    const pending = plans.filter((p) => p.status === 'pending');
    const newestPending = pending.reduce<PlanRef | undefined>((best, p) => (!best || p.at >= best.at ? p : best), undefined);
    for (const plan of plans) {
      const column = columnOf(plan.status);
      if (!column) { board.superseded++; continue; }
      board[column].push({
        key: `${a.id}:${plan.id}`, agentId: a.id, agentTitle: a.title, project: a.project, plan, column,
        at: column === 'waiting' ? plan.at : plan.decidedAt ?? plan.at,
        blocking: column === 'waiting' && a.pending?.kind === 'plan' && a.status !== 'done' && plan === newestPending,
      });
    }
  }
  const byKey = (x: PlanCard, y: PlanCard): number => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  board.waiting.sort((x, y) => x.at - y.at || byKey(x, y));
  board.approved.sort((x, y) => y.at - x.at || byKey(x, y));
  board.sentBack.sort((x, y) => y.at - x.at || byKey(x, y));
  return board;
}

/** How many notes each column has (the art pins this many notes on the whiteboard and may cap them). */
export function planNoteCounts(board: PlanBoard): Record<PlanColumn, number> {
  return { waiting: board.waiting.length, approved: board.approved.length, sentBack: board.sentBack.length };
}
