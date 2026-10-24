import test from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { LIMITS } from '../src/shared/protocol.ts';
import type { PendingRequest } from '../src/shared/protocol.ts';
import { PendingRegistry, alwaysLabelFor, buildPendingRequest } from '../src/manager/pending.ts';

const B = { requestId: 'r1', sessionId: 's1', at: 1000 };
type Permission = Extract<PendingRequest, { kind: 'permission' }>;

function perm(toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Permission {
  const r = buildPendingRequest(B, { toolName, input, ...extra });
  assert.equal(r.kind, 'permission');
  return r as Permission;
}
const f = (r: Permission, label: string) => r.fields.find((x) => x.label === label);

const ALWAYS: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo office-ok *' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/proj'], destination: 'session' },
];

// --- cards ---------------------------------------------------------------------------------------------------------

test('Bash card: command as code, description, summary from the description', () => {
  const r = perm('Bash', { command: 'echo office-ok > marker.txt', description: 'Write office-ok to marker.txt' }, { suggestions: ALWAYS, blockedPath: '/proj/marker.txt' });
  assert.equal(r.summary, 'Write office-ok to marker.txt');
  assert.deepEqual(f(r, 'Command'), { label: 'Command', value: 'echo office-ok > marker.txt', code: true });
  assert.equal(f(r, 'Description')?.value, 'Write office-ok to marker.txt');
  assert.equal(f(r, 'Path')?.value, '/proj/marker.txt');
  assert.equal(r.canAlwaysAllow, true);
  assert.equal(r.alwaysLabel, 'Always allow "echo office-ok *"');
  assert.equal(r.toolName, 'Bash');
  assert.equal(r.requestId, 'r1');
  assert.equal(r.sessionId, 's1');
  assert.equal(r.at, 1000);
});

test('Bash without a description summarises the command', () => {
  assert.equal(perm('Bash', { command: 'npm test' }).summary, 'Run npm test');
});

test('Edit card: file, old and new snippets', () => {
  const r = perm('Edit', { file_path: '/p/src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  assert.equal(r.summary, 'Edit app.ts');
  assert.deepEqual(r.fields.map((x) => [x.label, x.value, x.code ?? false]), [
    ['File', '/p/src/app.ts', false],
    ['Old', 'const a = 1;', true],
    ['New', 'const a = 2;', true],
  ]);
});

test('MultiEdit card: shows up to five edits and counts the rest, never more than LIMITS.fields', () => {
  const edits = Array.from({ length: 8 }, (_, i) => ({ old_string: `o${i}`, new_string: `n${i}` }));
  const r = perm('MultiEdit', { file_path: '/p/a.ts', edits });
  assert.equal(r.fields.length, 12);
  assert.ok(r.fields.length <= LIMITS.fields);
  assert.equal(f(r, 'Old 1')?.value, 'o0');
  assert.equal(f(r, 'New 5')?.value, 'n4');
  assert.equal(f(r, 'More')?.value, '3 more edits');
});

test('Write card: file and a truncated content preview', () => {
  const r = perm('Write', { file_path: '/p/big.txt', content: 'x'.repeat(LIMITS.fieldChars + 500) });
  assert.equal(r.summary, 'Write big.txt');
  const c = f(r, 'Content')!;
  assert.equal(c.value.length, LIMITS.fieldChars);
  assert.ok(c.value.endsWith('...'));
  assert.equal(c.code, true);
});

test('WebFetch, WebSearch and NotebookEdit cards', () => {
  const w = perm('WebFetch', { url: 'https://example.com/a?b=1', prompt: 'summarise' });
  assert.equal(w.summary, 'Fetch example.com');
  assert.equal(f(w, 'URL')?.value, 'https://example.com/a?b=1');
  assert.equal(f(w, 'Prompt')?.value, 'summarise');
  const s = perm('WebSearch', { query: 'node test runner' });
  assert.equal(f(s, 'Query')?.value, 'node test runner');
  const n = perm('NotebookEdit', { notebook_path: '/p/n.ipynb', cell_id: 'c1', edit_mode: 'replace', new_source: 'print(1)' });
  assert.equal(n.summary, 'Edit notebook n.ipynb');
  assert.equal(f(n, 'Notebook')?.value, '/p/n.ipynb');
  assert.equal(f(n, 'Cell')?.value, 'c1');
  assert.equal(f(n, 'Source')?.code, true);
});

test('MCP tool card: pretty name and key args', () => {
  const r = perm('mcp__github__create_issue', { title: 'Bug', body: 'Details', labels: ['a', 'b'], draft: false });
  assert.equal(r.summary, 'Use github: create_issue');
  assert.equal(f(r, 'Tool')?.value, 'github: create_issue');
  assert.equal(f(r, 'title')?.value, 'Bug');
  assert.equal(f(r, 'labels')?.value, '["a","b"]');
  assert.equal(f(r, 'draft')?.value, 'false');
});

test('generic fallback: up to LIMITS.fields keys, long strings cut', () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) input['k' + i] = 'v' + i;
  input['k0'] = 'y'.repeat(LIMITS.fieldChars * 2);
  const r = perm('SomeNewTool', input);
  assert.equal(r.summary, 'Use SomeNewTool');
  assert.equal(r.fields.length, LIMITS.fields);
  assert.equal(r.fields[0]!.value.length, LIMITS.fieldChars);
});

test('blockedPath fits within the field cap and is not repeated', () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) input['k' + i] = 'v';
  const r = perm('Odd', input, { blockedPath: '/etc/passwd' });
  assert.equal(r.fields.length, LIMITS.fields);
  assert.equal(r.fields[r.fields.length - 1]!.label, 'Path');
  const dup = perm('Write', { file_path: '/p/a' }, { blockedPath: '/p/a' });
  assert.equal(dup.fields.filter((x) => x.value === '/p/a').length, 1);
});

test('reason comes from decisionReason, then description, then title', () => {
  assert.equal(perm('Bash', { command: 'x' }, { decisionReason: "A variable in this command can't be checked" }).reason, "A variable in this command can't be checked");
  assert.equal(perm('Bash', { command: 'x' }, { description: 'Claude will have read access' }).reason, 'Claude will have read access');
  assert.equal(perm('Bash', { command: 'x' }, { title: 'Claude wants to run x' }).reason, 'Claude wants to run x');
  assert.equal(perm('Bash', { command: 'x' }).reason, undefined);
});

test('canAlwaysAllow follows suggestions; suppressAlwaysAllowRule wins', () => {
  assert.equal(perm('Bash', { command: 'x' }).canAlwaysAllow, false);
  assert.equal(perm('Bash', { command: 'x' }, { suggestions: [] }).canAlwaysAllow, false);
  assert.equal(perm('Bash', { command: 'x' }, { suggestions: null }).canAlwaysAllow, false);
  assert.equal(perm('Bash', { command: 'x' }, { suggestions: ALWAYS }).alwaysLabel, 'Always allow "echo office-ok *"');
  assert.equal(perm('Bash', { command: 'x' }, { suggestions: ALWAYS, suppressAlwaysAllowRule: true }).canAlwaysAllow, false);
  assert.equal(perm('Bash', { command: 'x' }).alwaysLabel, undefined);
});

test('alwaysLabelFor: setMode and the plain default', () => {
  assert.equal(alwaysLabelFor([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'Write'), 'Auto-accept file edits this session');
  assert.equal(alwaysLabelFor([{ type: 'addDirectories', directories: ['/x'], destination: 'session' }], 'Read'), 'Always allow');
  assert.equal(alwaysLabelFor([{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' }], 'Read'), 'Always allow Read');
});

const QS = {
  questions: [
    {
      question: 'Which colour do you pick: Red or Green?',
      header: 'Colour',
      options: [{ label: 'Red', description: 'Pick red' }, { label: 'Green', description: 'Pick green' }],
      multiSelect: false,
    },
    {
      question: 'Which toppings?',
      header: 'Toppings',
      options: [{ label: 'Cheese', description: '' }, { label: 'Ham', description: '' }, { label: 'Olives', description: '' }],
      multiSelect: true,
    },
  ],
};

test('question card from AskUserQuestion', () => {
  const r = buildPendingRequest(B, { toolName: 'AskUserQuestion', input: QS });
  assert.equal(r.kind, 'question');
  const q = (r as Extract<PendingRequest, { kind: 'question' }>).questions;
  assert.equal(q.length, 2);
  assert.equal(q[0]!.question, 'Which colour do you pick: Red or Green?');
  assert.equal(q[0]!.header, 'Colour');
  assert.deepEqual(q[0]!.options.map((o) => o.label), ['Red', 'Green']);
  assert.equal(q[1]!.multiSelect, true);
});

test('question card clamps questions and options; a malformed one falls back to a permission card', () => {
  const many = { questions: Array.from({ length: 12 }, (_, i) => ({ question: 'Q' + i, header: 'h', multiSelect: false, options: Array.from({ length: 20 }, (_, j) => ({ label: 'L' + j, description: '' })) })) };
  const r = buildPendingRequest(B, { toolName: 'AskUserQuestion', input: many }) as Extract<PendingRequest, { kind: 'question' }>;
  assert.equal(r.questions.length, LIMITS.questions);
  assert.equal(r.questions[0]!.options.length, LIMITS.options);
  assert.equal(buildPendingRequest(B, { toolName: 'AskUserQuestion', input: { questions: 'nope' } }).kind, 'permission');
});

test('plan card from ExitPlanMode', () => {
  const r = buildPendingRequest(B, { toolName: 'ExitPlanMode', input: { plan: '# Plan\n- a', planFilePath: '/home/u/.claude/plans/x.md' } });
  assert.deepEqual(r, { ...B, kind: 'plan', plan: '# Plan\n- a', planFilePath: '/home/u/.claude/plans/x.md' });
  const long = buildPendingRequest(B, { toolName: 'ExitPlanMode', input: { plan: 'p'.repeat(LIMITS.planChars + 10) } }) as Extract<PendingRequest, { kind: 'plan' }>;
  assert.equal(long.plan.length, LIMITS.planChars);
  assert.equal(long.planFilePath, undefined);
});

// --- registry and decisions --------------------------------------------------------------------------------------------

test('create gives a unique requestId and an unsettled promise; list is oldest first', async () => {
  const reg = new PendingRegistry({ now: () => 5 });
  const a = reg.create({ sessionId: 's1', toolName: 'Bash', input: { command: 'a' }, toolUseID: 'toolu_a' });
  const b = reg.create({ sessionId: 's1', toolName: 'Bash', input: { command: 'b' }, toolUseID: 'toolu_a' }); // same tool id again
  const c = reg.create({ sessionId: 's2', toolName: 'Bash', input: { command: 'c' } });
  assert.notEqual(a.requestId, b.requestId);
  assert.ok(a.requestId.length <= LIMITS.idChars);
  assert.deepEqual(reg.list('s1').map((r) => r.requestId), [a.requestId, b.requestId]);
  assert.equal(reg.first('s1')?.requestId, a.requestId);
  assert.equal(reg.list('s2').length, 1);
  assert.equal(reg.size, 3);
  let settled = false;
  void c.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
});

test('allow, always-allow and deny map to SDK results', async () => {
  const reg = new PendingRegistry();
  const input = { command: 'echo hi > x' };
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input, suggestions: ALWAYS });
  assert.deepEqual(reg.decide(a.requestId, { kind: 'allow' }).ok, true);
  assert.deepEqual(await a.promise, { behavior: 'allow', updatedInput: input });

  const b = reg.create({ sessionId: 's', toolName: 'Bash', input, suggestions: ALWAYS });
  reg.decide(b.requestId, { kind: 'allow', always: true });
  assert.deepEqual(await b.promise, { behavior: 'allow', updatedInput: input, updatedPermissions: ALWAYS });

  const c = reg.create({ sessionId: 's', toolName: 'Bash', input });
  reg.decide(c.requestId, { kind: 'deny', message: 'No thanks' });
  assert.deepEqual(await c.promise, { behavior: 'deny', message: 'No thanks' });

  const d = reg.create({ sessionId: 's', toolName: 'Bash', input });
  reg.decide(d.requestId, { kind: 'deny' });
  assert.deepEqual(await d.promise, { behavior: 'deny', message: 'The user declined.' });
  assert.equal(reg.size, 0);
});

test('each settled request is logged once: id, how and behaviour, never the text', async () => {
  const logs: string[] = [];
  const reg = new PendingRegistry({ log: (m) => logs.push(m) });
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: { command: 'secret' }, toolUseID: 'toolu_a' });
  reg.decide(a.requestId, { kind: 'deny', message: 'Secret reason' });
  await a.promise;
  assert.deepEqual(logs, [`pending ${a.requestId} settled decided: deny`]);

  const ctl = new AbortController();
  const b = reg.create({ sessionId: 's', toolName: 'Bash', input: {}, signal: ctl.signal, toolUseID: 'toolu_b' });
  logs.length = 0;
  ctl.abort();
  await b.promise;
  assert.deepEqual(logs, [`pending ${b.requestId} settled aborted: deny`]);

  const c = reg.create({ sessionId: 's', toolName: 'Bash', input: {}, toolUseID: 'toolu_c' });
  logs.length = 0;
  reg.cancelAll();
  await c.promise;
  assert.deepEqual(logs, [`pending ${c.requestId} settled cancelled: deny`]);
  assert.equal(logs.some((m) => m.includes('Secret reason')), false);
});

test('always-allow prefers localSettings: user and project destinations are redirected', async () => {
  const reg = new PendingRegistry();
  const sugg: PermissionUpdate[] = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }], behavior: 'allow', destination: 'projectSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: {}, suggestions: sugg });
  reg.decide(a.requestId, { kind: 'allow', always: true });
  const res = (await a.promise) as { updatedPermissions: PermissionUpdate[] };
  assert.deepEqual(res.updatedPermissions.map((u) => u.destination), ['localSettings', 'localSettings', 'session']);
  assert.equal(sugg[0]!.destination, 'projectSettings'); // input untouched
});

test('always without canAlwaysAllow is refused and the request stays pending', () => {
  const reg = new PendingRegistry();
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: {} });
  const out = reg.decide(a.requestId, { kind: 'allow', always: true });
  assert.equal(out.ok, false);
  assert.equal(reg.size, 1);
});

test('kind mismatch is refused and the request stays pending', () => {
  const reg = new PendingRegistry();
  const p = reg.create({ sessionId: 's', toolName: 'Bash', input: {} });
  assert.equal(reg.decide(p.requestId, { kind: 'plan', approve: true }).ok, false);
  assert.equal(reg.decide(p.requestId, { kind: 'answer', answers: { q: 'a' } }).ok, false);
  const q = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  assert.equal(reg.decide(q.requestId, { kind: 'allow' }).ok, false);
  assert.equal(reg.decide(q.requestId, { kind: 'plan', approve: true }).ok, false);
  const pl = reg.create({ sessionId: 's', toolName: 'ExitPlanMode', input: { plan: 'x' } });
  assert.equal(reg.decide(pl.requestId, { kind: 'deny' }).ok, false);
  assert.equal(reg.size, 3);
});

test('a question can be declined with deny', async () => {
  const reg = new PendingRegistry();
  const a = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  assert.equal(reg.decide(a.requestId, { kind: 'deny' }).ok, true);
  const ra = (await a.promise) as { behavior: string; message: string; interrupt?: boolean };
  assert.equal(ra.behavior, 'deny');
  assert.match(ra.message, /not to answer/);
  assert.equal(ra.interrupt, undefined);
  const b = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  reg.decide(b.requestId, { kind: 'deny', message: 'Skip it' });
  assert.deepEqual(await b.promise, { behavior: 'deny', message: 'Skip it' });
  assert.equal(reg.size, 0);
});

test('unknown ids are errors; a repeat of an answered id is flagged as a duplicate', () => {
  const reg = new PendingRegistry();
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: {} });
  const unknown = reg.decide('nope', { kind: 'allow' });
  assert.deepEqual([unknown.ok, !unknown.ok && unknown.duplicate], [false, false]);
  assert.equal(reg.decide(a.requestId, { kind: 'allow' }).ok, true);
  const again = reg.decide(a.requestId, { kind: 'deny' });
  assert.deepEqual([again.ok, !again.ok && again.duplicate], [false, true]);
});

test('plan approve allows with the original input; reject denies with feedback or a default', async () => {
  const reg = new PendingRegistry();
  const input = { plan: '# P', planFilePath: '/x.md' };
  const a = reg.create({ sessionId: 's', toolName: 'ExitPlanMode', input });
  reg.decide(a.requestId, { kind: 'plan', approve: true });
  assert.deepEqual(await a.promise, { behavior: 'allow', updatedInput: input });
  const b = reg.create({ sessionId: 's', toolName: 'ExitPlanMode', input });
  reg.decide(b.requestId, { kind: 'plan', approve: false, feedback: 'Add tests' });
  assert.deepEqual(await b.promise, { behavior: 'deny', message: 'Add tests' });
  const c = reg.create({ sessionId: 's', toolName: 'ExitPlanMode', input });
  reg.decide(c.requestId, { kind: 'plan', approve: false });
  assert.deepEqual(await c.promise, { behavior: 'deny', message: 'Keep planning.' });
});

test('question answers: single, multi (joined), and free-text other replacing or extending', async () => {
  const reg = new PendingRegistry();
  const Q1 = 'Which colour do you pick: Red or Green?';
  const Q2 = 'Which toppings?';

  const a = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  assert.equal(reg.decide(a.requestId, { kind: 'answer', answers: { [Q1]: 'Green', [Q2]: ['Cheese', 'Olives'] } }).ok, true);
  assert.deepEqual(await a.promise, { behavior: 'allow', updatedInput: { questions: QS.questions, answers: { [Q1]: 'Green', [Q2]: 'Cheese, Olives' } } });

  // "other" replaces a single-select answer and extends a multi-select one.
  const b = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  reg.decide(b.requestId, { kind: 'answer', answers: { [Q1]: 'Other', [Q2]: ['Ham'] }, other: { [Q1]: ' Blue, actually ', [Q2]: 'Pineapple' } });
  assert.deepEqual(await b.promise, { behavior: 'allow', updatedInput: { questions: QS.questions, answers: { [Q1]: 'Blue, actually', [Q2]: 'Ham, Pineapple' } } });

  // A multi-select with only free text.
  const c = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  reg.decide(c.requestId, { kind: 'answer', answers: { [Q1]: 'Red', [Q2]: [] }, other: { [Q2]: 'Anchovies' } });
  assert.deepEqual(await c.promise, { behavior: 'allow', updatedInput: { questions: QS.questions, answers: { [Q1]: 'Red', [Q2]: 'Anchovies' } } });
});

test('question answers that do not match the request leave it pending', () => {
  const reg = new PendingRegistry();
  const Q1 = 'Which colour do you pick: Red or Green?';
  const Q2 = 'Which toppings?';
  const a = reg.create({ sessionId: 's', toolName: 'AskUserQuestion', input: QS });
  const bad: Array<Parameters<PendingRegistry['decide']>[1]> = [
    { kind: 'answer', answers: { 'Some other question': 'x', [Q1]: 'Red', [Q2]: ['Ham'] } },
    { kind: 'answer', answers: { [Q1]: 'Purple', [Q2]: ['Ham'] } }, // not an option, no other
    { kind: 'answer', answers: { [Q1]: 'Red', [Q2]: ['Cheese', 'Caviar'] } }, // one label bad
    { kind: 'answer', answers: { [Q1]: 'Red' } }, // second question unanswered
    { kind: 'answer', answers: { [Q1]: ['Red', 'Green'], [Q2]: ['Ham'] } }, // two labels for a single-select
    { kind: 'answer', answers: { [Q1]: 'Red', [Q2]: [] } }, // nothing chosen for the multi
    { kind: 'answer', answers: { [Q1]: 'Red', [Q2]: ['Ham'] }, other: { 'Unknown?': 'x' } },
  ];
  for (const d of bad) assert.equal(reg.decide(a.requestId, d).ok, false, JSON.stringify(d));
  assert.equal(reg.size, 1);
});

test('cancelSession denies with interrupt, only for that session; cancelAll does the rest', async () => {
  const removed: string[] = [];
  const reg = new PendingRegistry({ onRemoved: (r, how) => removed.push(`${r.requestId}:${how}`) });
  const a = reg.create({ sessionId: 's1', toolName: 'Bash', input: {}, toolUseID: 'a' });
  const b = reg.create({ sessionId: 's1', toolName: 'Bash', input: {}, toolUseID: 'b' });
  const c = reg.create({ sessionId: 's2', toolName: 'Bash', input: {}, toolUseID: 'c' });
  const cancelled = reg.cancelSession('s1');
  assert.equal(cancelled.length, 2);
  assert.deepEqual(await a.promise, { behavior: 'deny', message: 'Interrupted', interrupt: true });
  assert.deepEqual(await b.promise, { behavior: 'deny', message: 'Interrupted', interrupt: true });
  assert.equal(reg.size, 1);
  assert.equal(reg.cancelAll().length, 1);
  assert.deepEqual(await c.promise, { behavior: 'deny', message: 'Interrupted', interrupt: true });
  assert.equal(removed.length, 3);
  assert.ok(removed.every((x) => x.endsWith(':cancelled')));
});

test('an abort signal denies its request; an already-aborted signal resolves at once', async () => {
  const added: string[] = [];
  const removed: string[] = [];
  const reg = new PendingRegistry({ onAdded: (r) => added.push(r.requestId), onRemoved: (r, how) => removed.push(how) });
  const ac = new AbortController();
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: {}, signal: ac.signal });
  ac.abort();
  assert.equal(((await a.promise) as { behavior: string }).behavior, 'deny');
  assert.deepEqual(removed, ['aborted']);
  assert.equal(reg.size, 0);
  const done = new AbortController();
  done.abort();
  const b = reg.create({ sessionId: 's', toolName: 'Bash', input: {}, signal: done.signal });
  assert.equal(((await b.promise) as { behavior: string }).behavior, 'deny');
  assert.equal(reg.size, 0);
  assert.equal(added.length, 1);
});

test('a throwing hook does not strand the promise', async () => {
  const reg = new PendingRegistry({ onAdded: () => { throw new Error('x'); }, onRemoved: () => { throw new Error('y'); } });
  const a = reg.create({ sessionId: 's', toolName: 'Bash', input: {} });
  assert.equal(reg.decide(a.requestId, { kind: 'allow' }).ok, true);
  assert.equal(((await a.promise) as { behavior: string }).behavior, 'allow');
});
