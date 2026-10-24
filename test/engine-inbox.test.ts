import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_KEEP_MS, REPORT_MAX_AGE_MS, badge, deriveInbox, pruneRead, reportPreview } from '../webview/engine/inboxLogic.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import type { AgentView } from '../webview/engine/targets.ts';
import { HOST0, agent } from './engine-world.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';

const NOW = 10_000_000;
const view = (id: string, over: Partial<AgentSnapshot> = {}): AgentView => normalizeAgent(agent(id, over), HOST0)!;
const unread = { readAt: () => undefined };
const readSet = (map: Record<string, number>) => ({ readAt: (k: string) => map[k] });

test('a finished report becomes a normal item with a stable key', () => {
  const a = view('a', { status: 'idle', activity: 'idle', title: 'Fix login', lastReport: { at: NOW - 60_000, text: '## Done\n\nFixed the login redirect.\nMore.' } });
  const items = deriveInbox([a], unread, NOW);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    key: `report:a:${NOW - 60_000}`, kind: 'report', urgency: 'normal', title: 'Fix login', detail: 'Done', agentId: 'a', at: NOW - 60_000, read: false,
  });
});

test('report previews take the first real line and stay short', () => {
  assert.equal(reportPreview('\n\n> **All done** here\nsecond'), 'All done** here');
  assert.equal(reportPreview('   '), '');
  const long = reportPreview('x'.repeat(500));
  assert.ok(long.length <= 140 && long.endsWith('…'));
});

test('temps do not file reports; old reports drop out', () => {
  const t = view('t', { kind: 'temp', parentId: 'a', lastReport: { at: NOW - 1000, text: 'done' } });
  const old = view('o', { lastReport: { at: NOW - REPORT_MAX_AGE_MS - 1, text: 'ancient' } });
  const edge = view('e', { lastReport: { at: NOW - REPORT_MAX_AGE_MS, text: 'borderline' } });
  assert.deepEqual(deriveInbox([t, old, edge], unread, NOW).map((i) => i.agentId), ['e']);
});

test('temps never file items, even when they look like they need you', () => {
  const sub = { kind: 'temp' as const, parentId: 'a' };
  const waiting = view('t1', { ...sub, activity: 'needsYou', status: 'waiting', detail: 'Edit main.ts' });
  const plan = view('t2', { ...sub, plans: [{ id: 'p1', title: 'Plan', at: NOW - 1000, status: 'pending', chars: 10 }] });
  const pending = view('t3', { ...sub, activity: 'needsYou', status: 'waiting', pending: { requestId: 'r1', kind: 'permission' } });
  const items = deriveInbox([waiting, plan, pending], unread, NOW);
  assert.deepEqual(items, []);
  assert.deepEqual(badge(items), { count: 0, urgent: false });
});

test('read marks apply to reports and carry readAt', () => {
  const a = view('a', { lastReport: { at: 5000, text: 'ok' } });
  const [it] = deriveInbox([a], readSet({ 'report:a:5000': NOW - 10 }), NOW);
  assert.equal(it!.read, true);
  assert.equal(it!.readAt, NOW - 10);
});

test('questions and approvals are urgent and ignore read marks', () => {
  const q = view('q', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'r1', kind: 'question' } });
  const p = view('p', { activity: 'needsYou', status: 'waiting', detail: 'Run npm test', pending: { requestId: 'r2', kind: 'permission' } });
  const items = deriveInbox([q, p], readSet({ 'question:q:r1': 1, 'approval:p:r2': 1 }), NOW);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const qi = byKey.get('question:q:r1')!;
  assert.equal(qi.kind, 'question');
  assert.equal(qi.urgency, 'urgent');
  assert.equal(qi.read, false);
  assert.equal(qi.requestId, 'r1');
  assert.equal(qi.at, q.since);
  const pi = byKey.get('approval:p:r2')!;
  assert.equal(pi.kind, 'approval');
  assert.equal(pi.detail, 'Run npm test');
  assert.equal(pi.read, false);
});

test('a waiting plan appears once: urgent when an office run is blocked on it, otherwise normal and readable', () => {
  const plans = [
    { id: 'p0', at: 100, title: 'Old', status: 'superseded' as const, chars: 10 },
    { id: 'p1', at: 200, title: 'Refactor auth', status: 'pending' as const, chars: 900 },
    { id: 'p2', at: 50, title: 'Done plan', status: 'approved' as const, chars: 10, decidedAt: 60 },
  ];
  const blocked = view('b', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq', kind: 'plan' }, plans });
  const items = deriveInbox([blocked], readSet({ 'plan:b:p1': 5 }), NOW);
  assert.equal(items.length, 1, 'no duplicate for the request');
  assert.deepEqual([items[0]!.kind, items[0]!.urgency, items[0]!.read, items[0]!.title, items[0]!.planId, items[0]!.requestId], ['plan', 'urgent', false, 'Refactor auth', 'p1', 'rq']);
  const idle = view('i', { status: 'idle', activity: 'idle', plans });
  const [it] = deriveInbox([idle], readSet({ 'plan:i:p1': 5 }), NOW);
  assert.deepEqual([it!.urgency, it!.read, it!.requestId], ['normal', true, undefined]);
});

test('a pending plan request with no PlanRef still shows', () => {
  const a = view('x', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq9', kind: 'plan' } });
  const [it] = deriveInbox([a], unread, NOW);
  assert.deepEqual([it!.key, it!.kind, it!.urgency], ['plan:x:rq9', 'plan', 'urgent']);
});

test('a session waiting in another window is an attention item; gone agents add nothing urgent', () => {
  const e = view('e', { activity: 'needsYou', status: 'waiting', control: 'elsewhere' });
  const [it] = deriveInbox([e], unread, NOW);
  assert.deepEqual([it!.kind, it!.urgency, it!.key], ['attention', 'urgent', `attention:e:${e.since}`]);
  const gone = view('g', { activity: 'needsYou', status: 'done', pending: { requestId: 'r', kind: 'question' } });
  assert.equal(deriveInbox([gone], unread, NOW).length, 0);
});

test('order: urgent first, then newest; ties are stable', () => {
  const agents = [
    view('r1', { lastReport: { at: 1000, text: 'old' } }),
    view('r2', { lastReport: { at: 3000, text: 'new' } }),
    view('q1', { since: 500, activity: 'needsYou', status: 'waiting', pending: { requestId: 'a', kind: 'question' } }),
    view('q2', { since: 900, activity: 'needsYou', status: 'waiting', pending: { requestId: 'b', kind: 'permission' } }),
  ];
  const keys = deriveInbox(agents, unread, NOW).map((i) => i.key);
  assert.deepEqual(keys, ['approval:q2:b', 'question:q1:a', 'report:r2:3000', 'report:r1:1000']);
  assert.deepEqual(deriveInbox([...agents].reverse(), unread, NOW).map((i) => i.key), keys);
});

test('badge counts unread items and flags urgent ones', () => {
  const agents = [
    view('r1', { lastReport: { at: 1000, text: 'a' } }),
    view('r2', { lastReport: { at: 2000, text: 'b' } }),
  ];
  assert.deepEqual(badge(deriveInbox(agents, unread, NOW)), { count: 2, urgent: false });
  assert.deepEqual(badge(deriveInbox(agents, readSet({ 'report:r1:1000': 1 }), NOW)), { count: 1, urgent: false });
  assert.deepEqual(badge(deriveInbox(agents, readSet({ 'report:r1:1000': 1, 'report:r2:2000': 1 }), NOW)), { count: 0, urgent: false });
  const withQ = [...agents, view('q', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'z', kind: 'question' } })];
  assert.deepEqual(badge(deriveInbox(withQ, readSet({ 'report:r1:1000': 1 }), NOW)), { count: 2, urgent: true });
  assert.deepEqual(badge([]), { count: 0, urgent: false });
});

test('pruneRead keeps marks for current items and recent ones, drops old marks of gone items', () => {
  const items = [{ key: 'report:a:1' }];
  const map = {
    'report:a:1': NOW - READ_KEEP_MS * 10, // live: stays however old
    'report:gone:old': NOW - READ_KEEP_MS - 1, // gone and old: dropped
    'report:gone:recent': NOW - READ_KEEP_MS, // gone but within the keep time: stays
    'report:gone:nan': Number.NaN, // junk: dropped
  };
  const copy = { ...map };
  const out = pruneRead(map, items, NOW);
  assert.deepEqual(Object.keys(out).sort(), ['report:a:1', 'report:gone:recent']);
  assert.deepEqual(map, copy, 'the input is not changed');
  assert.deepEqual(pruneRead({}, [], NOW), {});
});
