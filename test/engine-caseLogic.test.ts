import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaseHeader, ConversationItem, PendingRequest, QuestionSpec } from '../src/shared/protocol.ts';
import {
  allowDecision, alwaysCaption, answerDecision, answersReady, applyPending, controlBadge, denyDecision, emptyPick, footerMode, formatCost,
  mergeHeader, mergeItems, pendingPlanItemId, permissionTitle, planBadge, planDecision, planItemView, prettyModel, shortPath, statusLine, toggleOther,
  togglePick, toolIcon,
} from '../webview/engine/caseLogic.ts';

const prompt = (id: string, text = id): ConversationItem => ({ kind: 'prompt', id, text });

test('mergeItems upserts by id, appends new ones in order and trims the oldest', () => {
  const a = [prompt('1'), prompt('2')];
  const r = mergeItems(a, [{ kind: 'assistant', id: '3', text: 'Hi', streaming: true }, prompt('1', 'edited')]);
  assert.deepEqual(r.items.map((i) => i.id), ['1', '2', '3']);
  assert.equal((r.items[0] as { text: string }).text, 'edited');
  assert.deepEqual(r.added, ['3']);
  assert.deepEqual(r.replaced, ['1']);
  assert.equal(a.length, 2, 'input not mutated');
  const s = mergeItems(r.items, [{ kind: 'assistant', id: '3', text: 'Hi there' }]);
  assert.deepEqual(s.replaced, ['3']);
  assert.equal(s.items[2]!.kind === 'assistant' && s.items[2]!.streaming, undefined);
  const t = mergeItems(s.items, [prompt('4'), prompt('5')], 3);
  assert.deepEqual(t.items.map((i) => i.id), ['3', '4', '5']);
  assert.deepEqual(t.dropped, ['1', '2']);
});

test('applyPending: undefined keeps, null clears, object replaces', () => {
  const p: PendingRequest = { kind: 'plan', requestId: 'r1', sessionId: 's', at: 1, plan: '# Plan' };
  const q: PendingRequest = { ...p, requestId: 'r2' };
  assert.equal(applyPending(p, undefined), p);
  assert.equal(applyPending(p, null), null);
  assert.equal(applyPending(p, q), q);
  assert.equal(applyPending(null, undefined), null);
});

const header: CaseHeader = { agentId: 'a', title: 'T', project: 'p', activity: 'writing', status: 'working', control: 'office' };

test('mergeHeader merges defined keys only', () => {
  const h = mergeHeader(header, { busy: true, costUsd: 0.5, title: undefined });
  assert.equal(h.busy, true);
  assert.equal(h.costUsd, 0.5);
  assert.equal(h.title, 'T');
  assert.equal(mergeHeader(header, undefined), header);
});

test('footerMode follows control and busy', () => {
  assert.deepEqual(footerMode({ ...header, busy: false }), { kind: 'reply', label: 'Send', hint: null, placeholder: 'Reply to them…', queued: false });
  const busy = footerMode({ ...header, busy: true });
  assert.ok(busy.kind === 'reply' && busy.label === 'Queue' && busy.hint === 'They’ll read it when they finish this step' && busy.queued);
  const free = footerMode({ ...header, control: 'free' });
  assert.ok(free.kind === 'reply' && free.label === 'Continue in office' && free.hint === 'Not running right now. Sending picks the session back up here.');
  assert.deepEqual(footerMode({ ...header, control: 'elsewhere' }), { kind: 'elsewhere', text: 'Open in another window, so it’s read-only here.' });
  assert.deepEqual(footerMode({ ...header, control: 'none' }, 'Audit dependencies', 'p1'), { kind: 'temp', text: 'Temps report to “Audit dependencies”, not to you.', parentId: 'p1' });
  assert.deepEqual(footerMode({ ...header, control: 'none' }), { kind: 'temp', text: 'Temps report to their boss, not to you.', parentId: null });
  assert.equal(footerMode(null).kind, 'temp', 'unknown control is treated as none');
});

test('alwaysCaption says what "Always allow" switches on, without repeating itself', () => {
  assert.equal(alwaysCaption('Always allow "psql -d billing *" in this project'), '“Always allow” means they won’t ask again for "psql -d billing *" in this project.');
  assert.equal(alwaysCaption('Auto-accept file edits this session'), '“Always allow” also turns on: auto-accept file edits this session.');
  assert.equal(alwaysCaption('Always allow'), '“Always allow” means they won’t ask again for requests like this one.');
  assert.equal(alwaysCaption(undefined), '“Always allow” means they won’t ask again for requests like this one.');
  assert.equal(alwaysCaption('  always ALLOW   Read(src/**) '), '“Always allow” means they won’t ask again for Read(src/**).');
});

test('permission and plan decisions', () => {
  assert.deepEqual(allowDecision(), { kind: 'allow' });
  assert.deepEqual(allowDecision(true), { kind: 'allow', always: true });
  assert.deepEqual(denyDecision(), { kind: 'deny' });
  assert.deepEqual(denyDecision('   '), { kind: 'deny' });
  assert.deepEqual(denyDecision('  not on prod '), { kind: 'deny', message: 'not on prod' });
  assert.equal((denyDecision('x'.repeat(5000)) as { message: string }).message.length, 2000);
  assert.deepEqual(planDecision(true, 'ignored'), { kind: 'plan', approve: true });
  assert.deepEqual(planDecision(false), { kind: 'plan', approve: false });
  assert.deepEqual(planDecision(false, 'Add tests first'), { kind: 'plan', approve: false, feedback: 'Add tests first' });
});

const single: QuestionSpec = { question: 'Which tone?', header: 'Tone', multiSelect: false, options: [{ label: 'Friendly', description: '' }, { label: 'Formal', description: '' }] };
const multi: QuestionSpec = { question: 'Which pages?', header: 'Pages', multiSelect: true, options: [{ label: 'Auth', description: '' }, { label: 'Errors', description: '' }, { label: 'Limits', description: '' }] };

test('question picks: single replaces, multi toggles in option order, Other behaves', () => {
  let s = togglePick(single, emptyPick(), 'Friendly');
  s = togglePick(single, s, 'Formal');
  assert.deepEqual(s.labels, ['Formal']);
  s = toggleOther(single, s);
  assert.deepEqual([s.labels, s.otherOn], [[], true], 'Other replaces a single choice');
  let m = togglePick(multi, emptyPick(), 'Limits');
  m = togglePick(multi, m, 'Auth');
  assert.deepEqual(m.labels, ['Auth', 'Limits']);
  m = togglePick(multi, m, 'Limits');
  assert.deepEqual(m.labels, ['Auth']);
  m = toggleOther(multi, m);
  assert.deepEqual([m.labels, m.otherOn], [['Auth'], true], 'Other adds to a multi choice');
});

test('answersReady needs every question answered', () => {
  assert.equal(answersReady([single, multi], [togglePick(single, emptyPick(), 'Formal')]), false);
  assert.equal(answersReady([single], [{ labels: [], otherOn: true, otherText: '  ' }]), false);
  assert.equal(answersReady([single], [{ labels: [], otherOn: true, otherText: 'Playful' }]), true);
  assert.equal(answersReady([], []), false);
});

test('answerDecision keys answers by question text and fills other', () => {
  assert.deepEqual(answerDecision([single, multi], [{ labels: ['Formal'], otherOn: false, otherText: 'stale' }, { labels: ['Auth', 'Errors'], otherOn: false, otherText: '' }]), {
    kind: 'answer', answers: { 'Which tone?': 'Formal', 'Which pages?': ['Auth', 'Errors'] },
  });
  assert.deepEqual(answerDecision([single, multi], [{ labels: [], otherOn: true, otherText: ' Playful ' }, { labels: ['Auth'], otherOn: true, otherText: 'Webhooks' }]), {
    kind: 'answer',
    answers: { 'Which tone?': 'Playful', 'Which pages?': ['Auth'] },
    other: { 'Which tone?': 'Playful', 'Which pages?': 'Webhooks' },
  });
});

test('words: models, costs, paths, status, badges, icons', () => {
  assert.equal(prettyModel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(prettyModel('claude-sonnet-4-5'), 'Sonnet 4.5');
  assert.equal(prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(prettyModel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(prettyModel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(prettyModel('fable'), 'Fable');
  assert.equal(prettyModel('fable[1m]'), 'Fable (1M)');
  assert.equal(prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(prettyModel('sonnet'), 'Sonnet');
  assert.equal(prettyModel('some-other-model'), 'some-other-model');
  assert.equal(prettyModel(undefined), '');
  assert.equal(formatCost(0.4237), '$0.42');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(undefined), '');
  assert.equal(shortPath('/home/user/Projects/web-app'), '~/Projects/web-app');
  assert.equal(shortPath('/Users/ann/x'), '~/x');
  assert.equal(shortPath('C:\\Users\\bob\\code\\app'), '~\\code\\app');
  assert.equal(shortPath('/srv/app'), '/srv/app');
  assert.equal(statusLine({ ...header, model: 'claude-sonnet-4-5', costUsd: 0.42, permissionMode: 'plan' }), 'Writing · Sonnet 4.5 · Plans first · $0.42 so far');
  assert.equal(statusLine({ ...header, activity: 'needsYou' }), 'Waiting for you');
  assert.equal(controlBadge('office')?.label, 'office-run');
  assert.equal(controlBadge('elsewhere')?.icon, 'lock');
  assert.equal(controlBadge('free'), null);
  assert.equal(controlBadge(undefined), null);
  assert.equal(toolIcon('Read'), 'page');
  assert.equal(toolIcon('Edit'), 'pencil');
  assert.equal(toolIcon('Bash'), 'terminal');
  assert.equal(toolIcon('Grep'), 'folder');
  assert.equal(toolIcon('WebFetch'), 'globe');
  assert.equal(toolIcon('Task'), 'clipboard');
  assert.equal(toolIcon('mcp__github__search_issues'), 'search');
  assert.equal(toolIcon('SomethingNew'), 'terminal');
});

test('permission headline reads as a sentence', () => {
  assert.equal(permissionTitle('Bash', 'Drop the legacy_id column'), 'Wants to drop the legacy_id column');
  assert.equal(permissionTitle('Bash', 'npm test'), 'Wants to run npm test');
  assert.equal(permissionTitle('Edit', 'src/app.ts'), 'Wants to edit src/app.ts');
  assert.equal(permissionTitle('mcp__db__query', 'SELECT 1'), 'Wants to use mcp__db__query: SELECT 1');
  assert.equal(permissionTitle('WebFetch', ''), 'Wants to use WebFetch');
});

test('errorBelongsToCase matches the open session or the shown request, else it is a toast', async () => {
  const { errorBelongsToCase } = await import('../webview/engine/caseLogic.ts');
  assert.equal(errorBelongsToCase({ sessionId: 's1' }, 's1', undefined), true);
  assert.equal(errorBelongsToCase({ requestId: 'r1' }, undefined, 'r1'), true);
  assert.equal(errorBelongsToCase({ sessionId: 's2', requestId: 'r9' }, 's1', 'r1'), false);
  assert.equal(errorBelongsToCase({}, 's1', 'r1'), false);
  assert.equal(errorBelongsToCase({ sessionId: undefined }, undefined, undefined), false);
});

test('plan badges: pending, approved, sent back, superseded', () => {
  assert.deepEqual(['pending', 'approved', 'rejected', 'superseded'].map((st) => [planBadge(st).label, planBadge(st).tone]), [
    ['Waiting for sign-off', 'warn'], ['Approved', 'ok'], ['Sent back', 'err'], ['Superseded', 'dim'],
  ]);
  assert.equal(planBadge('something-new').label, 'Plan');
});

test('plan item view: folding, feedback, the truncated note and the sign-off pointer', () => {
  const long = Array.from({ length: 20 }, (_, i) => `${i + 1}. step`).join('\n');
  assert.equal(planItemView({ text: 'short', status: 'approved' }, false).folded, false);
  assert.equal(planItemView({ text: long, status: 'approved' }, false).folded, true, 'long decided plans start folded');
  assert.equal(planItemView({ text: long, status: 'pending' }, true).folded, false, 'the plan to sign off is never folded');
  assert.equal(planItemView({ text: 'short', status: 'superseded' }, false).folded, true, 'superseded plans start folded');
  const sent = planItemView({ text: 'x', status: 'rejected', feedback: '  keep the API  ', truncated: true, planFilePath: '/home/user/.claude/plans/a.md' }, false);
  assert.equal(sent.feedback, 'keep the API');
  assert.equal(sent.cutNote, 'The plan was too long to show in full. All of it is in ~/.claude/plans/a.md.');
  assert.equal(planItemView({ text: 'x', status: 'approved', truncated: true }, false).cutNote, 'The plan was too long to show in full.');
  assert.equal(planItemView({ text: 'x', status: 'approved', feedback: '   ' }, false).feedback, null);
  assert.equal(planItemView({ text: 'x', status: 'pending' }, true).signOffBelow, true);
  assert.equal(planItemView({ text: 'x', status: 'pending' }, false).signOffBelow, false, 'no card to point at');
  assert.equal(planItemView({ text: 'x', status: 'approved' }, true).signOffBelow, false);
});

test('the pending plan item is the newest pending one', () => {
  const plan = (id: string, status: 'pending' | 'approved' | 'rejected' | 'superseded'): ConversationItem => ({ kind: 'plan', id, text: id, status });
  assert.equal(pendingPlanItemId([plan('a', 'pending'), prompt('p'), plan('b', 'approved')]), 'a');
  assert.equal(pendingPlanItemId([plan('a', 'pending'), plan('b', 'pending')]), 'b');
  assert.equal(pendingPlanItemId([plan('a', 'superseded'), prompt('p')]), null);
});

test('status line can leave the model and approvals to the header chips', () => {
  const h = { activity: 'writing', status: 'working', model: 'claude-sonnet-4-5', costUsd: 0.42, control: 'office', permissionMode: 'plan' } as const;
  assert.equal(statusLine(h, false), 'Writing · $0.42 so far');
  assert.equal(statusLine(h), 'Writing · Sonnet 4.5 · Plans first · $0.42 so far');
});

test('prettyModel reads 1M-context aliases', () => {
  assert.equal(prettyModel('opus[1m]'), 'Opus (1M)');
  assert.equal(prettyModel('sonnet[1m]'), 'Sonnet (1M)');
});
