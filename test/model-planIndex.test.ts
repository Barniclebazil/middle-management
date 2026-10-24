import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLANS, MAX_PLAN_TEXTS, PlanIndex, planTitle, rejectionFeedback } from '../src/model/planIndex.ts';
import { LIMITS } from '../src/shared/protocol.ts';

test('planTitle: first heading, else first line, capped', () => {
  assert.equal(planTitle('# Add the thing\n\nbody'), 'Add the thing');
  assert.equal(planTitle('Intro line\n\n## Real heading\nbody'), 'Real heading');
  assert.equal(planTitle('\n\n  Just a line  \nmore'), 'Just a line');
  assert.equal(planTitle(''), 'Plan');
  const long = planTitle('# ' + 'x'.repeat(500));
  assert.equal(long.length, LIMITS.planTitleChars);
  assert.ok(long.endsWith('…'));
});

test('rejectionFeedback reads the typed reason, and nothing from a plain rejection', () => {
  assert.equal(rejectionFeedback('The user doesn\'t want to proceed. The user provided the following reason for the rejection:  use a map instead'), 'use a map instead');
  assert.equal(rejectionFeedback([{ type: 'text', text: 'x. The user provided the following reason for the rejection:  from blocks' }]), 'from blocks');
  assert.equal(rejectionFeedback('STOP what you are doing and wait for the user to tell you how to proceed.'), undefined);
  assert.equal(rejectionFeedback('Tool permission request failed: AbortError'), undefined);
  assert.equal(rejectionFeedback('... reason for the rejection:   '), undefined);
  assert.equal(rejectionFeedback(42), undefined);
});

test('a plan opens pending with title, chars and no decision', () => {
  const ix = new PlanIndex();
  ix.open('p1', 1000, '# Title\n\nbody', '/plans/p1.md');
  assert.deepEqual(ix.refs(), [{ id: 'p1', at: 1000, title: 'Title', status: 'pending', chars: 13 }]);
  assert.equal(ix.isPending('p1'), true);
  assert.deepEqual(ix.planText('p1'), { text: '# Title\n\nbody', truncated: false, status: 'pending', planFilePath: '/plans/p1.md' });
});

test('approved: closes with decidedAt, and the result fills in a missing text', () => {
  const ix = new PlanIndex();
  ix.open('p1', 1000, '');
  assert.equal(ix.refs()[0]!.chars, 0);
  ix.close('p1', 2000, 'approved', { text: '# From result\nx', planFilePath: '/p.md' });
  assert.deepEqual(ix.refs(), [{ id: 'p1', at: 1000, title: 'From result', status: 'approved', chars: 15, decidedAt: 2000 }]);
  assert.equal(ix.planText('p1')!.planFilePath, '/p.md');
  // Decided plans stay decided.
  ix.close('p1', 3000, 'rejected');
  assert.equal(ix.refs()[0]!.status, 'approved');
});

test('the result text does not replace a text the tool_use carried', () => {
  const ix = new PlanIndex();
  ix.open('p1', 1000, '# Original');
  ix.close('p1', 2000, 'approved', { text: '# Other', planFilePath: '/x.md' });
  assert.equal(ix.planText('p1')!.text, '# Original');
});

test('rejected keeps the feedback internally, not in the ref', () => {
  const ix = new PlanIndex();
  ix.open('p1', 1000, '# A');
  ix.close('p1', 2000, 'rejected', { feedback: 'too big' });
  assert.equal(ix.refs()[0]!.status, 'rejected');
  assert.equal(ix.refs()[0]!.decidedAt, 2000);
  assert.equal(ix.planText('p1')!.feedback, 'too big');
  assert.equal('feedback' in ix.refs()[0]!, false);
  assert.equal('text' in ix.refs()[0]!, false);
});

test('a new plan supersedes an older pending one, but not a decided one', () => {
  const ix = new PlanIndex();
  ix.open('a', 1000, '# A');
  ix.open('b', 2000, '# B');
  ix.close('b', 3000, 'approved');
  ix.open('c', 4000, '# C');
  assert.deepEqual(ix.refs().map((r) => [r.id, r.status]), [['a', 'superseded'], ['b', 'approved'], ['c', 'pending']]);
  assert.equal(ix.refs()[0]!.decidedAt, 2000);
  // A late result for a superseded plan does not reopen the decision.
  ix.close('a', 5000, 'approved');
  assert.equal(ix.refs()[0]!.status, 'superseded');
});

test('re-reading the same tool_use id does not duplicate or reset the plan', () => {
  const ix = new PlanIndex();
  ix.open('a', 1000, '# A');
  ix.close('a', 2000, 'approved');
  ix.open('a', 1000, '# A edited');
  assert.equal(ix.refs().length, 1);
  assert.equal(ix.refs()[0]!.status, 'approved');
  assert.equal(ix.refs()[0]!.title, 'A edited');
});

test('keeps the 5 newest plans and the text of the 3 newest', () => {
  assert.equal(MAX_PLANS, 5);
  assert.equal(MAX_PLAN_TEXTS, 3);
  const ix = new PlanIndex();
  for (let i = 1; i <= 7; i++) {
    ix.open(`p${i}`, i * 1000, `# Plan ${i}`);
    ix.close(`p${i}`, i * 1000 + 1, 'approved');
  }
  assert.deepEqual(ix.refs().map((r) => r.id), ['p3', 'p4', 'p5', 'p6', 'p7']);
  for (const gone of ['p1', 'p2', 'p3', 'p4']) assert.equal(ix.planText(gone), undefined, gone);
  for (const kept of ['p5', 'p6', 'p7']) assert.equal(ix.planText(kept)?.text, `# ${'Plan ' + kept.slice(1)}`, kept);
  // The ref of a plan whose text was dropped stays in the list with its length.
  assert.equal(ix.refs()[0]!.chars, '# Plan 3'.length);
});

test('plan text is cut at LIMITS.planChars while chars keeps the full length', () => {
  const ix = new PlanIndex();
  const big = '# Big\n' + 'y'.repeat(LIMITS.planChars + 500);
  ix.open('p1', 1, big);
  const t = ix.planText('p1')!;
  assert.equal(t.text.length, LIMITS.planChars);
  assert.equal(t.truncated, true);
  assert.equal(ix.refs()[0]!.chars, big.length);
});

test('unknown ids and clear()', () => {
  const ix = new PlanIndex();
  assert.equal(ix.planText('nope'), undefined);
  ix.close('nope', 1, 'approved');
  ix.open('a', 1, '# A');
  ix.clear();
  assert.deepEqual(ix.refs(), []);
  assert.equal(ix.has('a'), false);
});
