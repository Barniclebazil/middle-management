import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_COLUMNS, PLAN_COLUMN_TITLES, columnOf, planBoard, planNoteCounts } from '../webview/engine/plansLogic.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import type { AgentView } from '../webview/engine/targets.ts';
import type { AgentSnapshot, PlanRef } from '../src/shared/protocol.ts';
import { HOST0, agent } from './engine-world.ts';

const view = (id: string, over: Partial<AgentSnapshot> = {}): AgentView => normalizeAgent(agent(id, over), HOST0)!;
const plan = (id: string, status: PlanRef['status'], at: number, decidedAt?: number): PlanRef => {
  const p: PlanRef = { id, at, title: `Plan ${id}`, status, chars: 100 };
  if (decidedAt !== undefined) p.decidedAt = decidedAt;
  return p;
};

test('statuses map to columns; superseded is hidden', () => {
  assert.equal(columnOf('pending'), 'waiting');
  assert.equal(columnOf('approved'), 'approved');
  assert.equal(columnOf('rejected'), 'sentBack');
  assert.equal(columnOf('superseded'), null);
  assert.deepEqual(PLAN_COLUMNS, ['waiting', 'approved', 'sentBack']);
  assert.equal(PLAN_COLUMN_TITLES.waiting, 'Waiting for sign-off');
});

test('plans from several agents are grouped, counted and ordered', () => {
  const a = view('a', { title: 'Auth', project: 'web', plans: [plan('a1', 'superseded', 10), plan('a2', 'pending', 500), plan('a0', 'approved', 5, 100)] });
  const b = view('b', { title: 'Docs', plans: [plan('b1', 'pending', 300), plan('b2', 'rejected', 50, 900), plan('b3', 'approved', 60, 800)] });
  const c = view('c', {});
  const board = planBoard([a, b, c]);
  assert.deepEqual(board.waiting.map((x) => x.key), ['b:b1', 'a:a2'], 'longest waiting first');
  assert.deepEqual(board.approved.map((x) => x.key), ['b:b3', 'a:a0'], 'newest decision first');
  assert.deepEqual(board.sentBack.map((x) => x.key), ['b:b2']);
  assert.equal(board.superseded, 1);
  assert.deepEqual(planNoteCounts(board), { waiting: 2, approved: 2, sentBack: 1 });
  const card = board.waiting[1]!;
  assert.deepEqual([card.agentId, card.agentTitle, card.project, card.column, card.at, card.plan.id], ['a', 'Auth', 'web', 'waiting', 500, 'a2']);
  assert.equal(board.approved[0]!.at, 800, 'decided plans sort by decision time');
});

test('an undecided approved plan without decidedAt falls back to its proposal time', () => {
  const board = planBoard([view('a', { plans: [plan('x', 'approved', 42)] })]);
  assert.equal(board.approved[0]!.at, 42);
});

test('blocking marks the newest pending plan of an office run that is blocked on a plan', () => {
  const plans = [plan('p1', 'pending', 100), plan('p2', 'pending', 200)];
  const blocked = view('a', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'r', kind: 'plan' }, plans });
  const other = view('b', { plans: [plan('q', 'pending', 150)] });
  const board = planBoard([blocked, other]);
  assert.deepEqual(board.waiting.map((x) => [x.key, x.blocking]), [['a:p1', false], ['b:q', false], ['a:p2', true]].map(([k, v]) => [k, v]));
});

test('an empty office gives an empty board', () => {
  const board = planBoard([]);
  assert.deepEqual(planNoteCounts(board), { waiting: 0, approved: 0, sentBack: 0 });
  assert.equal(board.superseded, 0);
});
