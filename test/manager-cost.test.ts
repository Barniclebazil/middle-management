import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostTracker } from '../src/manager/cost.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('cumulative totals become per-turn deltas', () => {
  const t = createCostTracker();
  let r = t.observe('s1', 0.000371);
  near(r.turnUsd, 0.000371);
  near(r.totalUsd, 0.000371);
  r = t.observe('s1', 0.000829);
  near(r.turnUsd, 0.000458);
  near(r.totalUsd, 0.000829);
  r = t.observe('s1', 0.0009);
  near(r.turnUsd, 0.000071);
  near(t.total('s1')!, 0.0009);
});

test('an unchanged total is a zero-cost turn, never negative', () => {
  const t = createCostTracker();
  t.observe('s', 1);
  assert.equal(t.observe('s', 1).turnUsd, 0);
});

test('seeding a resumed session makes its first result a delta, not the lifetime total', () => {
  const t = createCostTracker();
  t.seed('s1', 0.0009);
  const r = t.observe('s1', 0.000984); // the spike's resumed turn
  near(r.turnUsd, 0.000084);
  near(r.totalUsd, 0.000984);
});

test('without a seed the first result of a session is its whole total', () => {
  const t = createCostTracker();
  assert.equal(t.total('s1'), undefined);
  near(t.observe('s1', 2.5).turnUsd, 2.5);
});

test('seed does not overwrite a baseline that was observed live, and ignores bad values', () => {
  const t = createCostTracker();
  t.observe('s', 3);
  t.seed('s', 1);
  assert.equal(t.total('s'), 3);
  t.seed('x', Number.NaN);
  t.seed('x', -1);
  assert.equal(t.total('x'), undefined);
});

test('a total that goes down is a counter reset: it is the turn cost and the new baseline', () => {
  const t = createCostTracker();
  t.observe('s', 5);
  let r = t.observe('s', 0.4);
  near(r.turnUsd, 0.4);
  near(r.totalUsd, 0.4);
  r = t.observe('s', 0.7);
  near(r.turnUsd, 0.3);
});

test('an unusable total keeps the baseline and costs nothing', () => {
  const t = createCostTracker();
  t.observe('s', 2);
  for (const bad of [Number.NaN, -1, Infinity]) {
    const r = t.observe('s', bad);
    assert.equal(r.turnUsd, 0);
    assert.equal(r.totalUsd, 2);
  }
  near(t.observe('s', 2.5).turnUsd, 0.5);
});

test('sessions are tracked independently; sum adds the latest totals; forget drops one', () => {
  const t = createCostTracker();
  t.observe('a', 1);
  t.observe('b', 10);
  t.observe('a', 1.5);
  near(t.observe('b', 12).turnUsd, 2);
  near(t.sum(), 13.5);
  // A re-emitted total does not double count.
  t.observe('a', 1.5);
  near(t.sum(), 13.5);
  t.forget('b');
  near(t.sum(), 1.5);
  assert.equal(t.total('b'), undefined);
});
