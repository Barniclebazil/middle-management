import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgent } from '../webview/engine/targets.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { HOST0, agent } from './engine-world.ts';

const norm = (over: Record<string, unknown>) => normalizeAgent({ ...agent('a'), ...over }, HOST0)!;
const plan = (id: string, over: Record<string, unknown> = {}) => ({ id, at: 1000, title: `Plan ${id}`, status: 'pending', chars: 50, ...over });

test('valid Round A fields are kept', () => {
  const v = norm({
    model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62, approx: true },
    lastReport: { at: 5, text: 'All done', truncated: true }, plans: [plan('p', { decidedAt: 7, status: 'approved' })],
  });
  assert.equal(v.model, 'claude-opus-5-5');
  assert.equal(v.effort, 'xhigh');
  assert.deepEqual(v.context, { tokens: 124_000, max: 200_000, pct: 62, approx: true });
  assert.deepEqual(v.lastReport, { at: 5, text: 'All done', truncated: true });
  assert.deepEqual(v.plans, [{ id: 'p', at: 1000, title: 'Plan p', status: 'approved', chars: 50, decidedAt: 7 }]);
});

test('absent fields stay absent', () => {
  const v = norm({});
  for (const k of ['model', 'effort', 'context', 'lastReport', 'plans']) assert.ok(!(k in v), k);
});

test('model and effort: bad values are dropped', () => {
  assert.ok(!('model' in norm({ model: 42 })));
  assert.ok(!('model' in norm({ model: '   ' })));
  assert.equal(norm({ model: '  opus  ' }).model, 'opus');
  assert.equal(norm({ model: 'x'.repeat(500) }).model!.length, LIMITS.modelChars);
  for (const bad of ['ultra', 'XHIGH', '', 3, null, {}]) assert.ok(!('effort' in norm({ effort: bad })), String(bad));
  for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(norm({ effort: ok }).effort, ok);
});

test('context: numbers must be finite, pct is clamped', () => {
  assert.equal(norm({ context: { tokens: 10, max: 200, pct: 250 } }).context!.pct, 100);
  assert.equal(norm({ context: { tokens: 10, max: 200, pct: -4 } }).context!.pct, 0);
  assert.equal(norm({ context: { tokens: -10, max: 200, pct: 5 } }).context!.tokens, 0);
  assert.equal(norm({ context: { tokens: 50, max: 200, pct: 'lots' } }).context!.pct, 25, 'worked out from tokens and max');
  assert.equal(norm({ context: { tokens: 50, max: 200, pct: Number.NaN } }).context!.pct, 25);
  assert.ok(!('approx' in norm({ context: { tokens: 1, max: 2, pct: 50, approx: 'yes' } }).context!));
  for (const bad of [null, 5, 'x', [], { tokens: Infinity, max: 200, pct: 5 }, { tokens: 5, max: Number.NaN, pct: 5 }, { tokens: 5, max: 0, pct: 5 }, { tokens: 5, max: -9, pct: 5 }, { tokens: '5', max: 200, pct: 5 }, { max: 200, pct: 5 }]) {
    assert.ok(!('context' in norm({ context: bad })), JSON.stringify(bad));
  }
});

test('lastReport: text capped at LIMITS.reportChars, bad ones dropped', () => {
  const long = 'x'.repeat(LIMITS.reportChars + 50);
  const v = norm({ lastReport: { at: 9, text: long } });
  assert.equal(v.lastReport!.text.length, LIMITS.reportChars);
  assert.equal(v.lastReport!.truncated, true);
  const exact = norm({ lastReport: { at: 9, text: 'x'.repeat(LIMITS.reportChars) } });
  assert.ok(!('truncated' in exact.lastReport!));
  for (const bad of [null, 'text', { at: 'now', text: 'x' }, { at: Infinity, text: 'x' }, { at: 1, text: 5 }, { at: 1, text: '  \n ' }, { at: 1 }]) {
    assert.ok(!('lastReport' in norm({ lastReport: bad })), JSON.stringify(bad));
  }
});

test('plans: statuses validated, junk dropped, newest LIMITS.plansPerAgent kept', () => {
  const v = norm({
    plans: [
      plan('ok1'), plan('badstatus', { status: 'done' }), plan('', {}), plan('noat', { at: 'x' }), null, 7,
      plan('notitle', { title: 42, chars: -3 }), plan('longtitle', { title: 'T'.repeat(500) }), plan('bad-chars', { chars: 'many', decidedAt: 'x' }),
    ],
  });
  assert.deepEqual(v.plans!.map((p) => p.id), ['ok1', 'notitle', 'longtitle', 'bad-chars']);
  assert.equal(v.plans![1]!.title, 'Untitled plan');
  assert.equal(v.plans![1]!.chars, 0);
  assert.equal(v.plans![2]!.title.length, LIMITS.planTitleChars);
  assert.deepEqual([v.plans![3]!.chars, 'decidedAt' in v.plans![3]!], [0, false]);
  const many = norm({ plans: Array.from({ length: LIMITS.plansPerAgent + 3 }, (_, i) => plan(`p${i}`)) });
  assert.equal(many.plans!.length, LIMITS.plansPerAgent);
  assert.equal(many.plans![0]!.id, 'p3', 'the oldest are dropped');
  assert.equal(many.plans!.at(-1)!.id, `p${LIMITS.plansPerAgent + 2}`);
  for (const bad of ['plans', 5, {}, [], [null], [plan('x', { status: 'bogus' })]]) assert.ok(!('plans' in norm({ plans: bad })), JSON.stringify(bad));
  for (const s of ['pending', 'approved', 'rejected', 'superseded']) assert.equal(norm({ plans: [plan('s', { status: s })] }).plans![0]!.status, s);
});
