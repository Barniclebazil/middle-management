import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectOption } from '../src/shared/protocol.ts';
import {
  APPROVAL_CHOICES, MODEL_CHOICES, applyPrefill, assignableWorkers, counterText, defaultProject, memoMessage, memoProblem, memoSummary, orderProjects,
} from '../webview/engine/memoLogic.ts';
import type { MemoState, WorkerInfo } from '../webview/engine/memoLogic.ts';

const P = (name: string, source: ProjectOption['source'], over: Partial<ProjectOption> = {}): ProjectOption => ({
  path: `/home/user/Projects/${name}`, name, source, exists: true, ...over,
});
const projects = [P('api', 'recent', { gitBranch: 'dev' }), P('web-app', 'workspace', { gitBranch: 'main' }), P('old', 'recent', { exists: false }), P('picked', 'browsed')];

test('projects: workspace first, then recent, then browsed', () => {
  assert.deepEqual(orderProjects(projects).map((p) => p.name), ['web-app', 'api', 'old', 'picked']);
});

test('default project: the worker’s folder, else the host default, else the first that exists', () => {
  assert.equal(defaultProject(projects, '/home/user/Projects/api', '/home/user/Projects/picked'), '/home/user/Projects/picked');
  assert.equal(defaultProject(projects, '/home/user/Projects/api', '/nowhere'), '/home/user/Projects/api');
  assert.equal(defaultProject(projects, '/home/user/Projects/old', undefined), '/home/user/Projects/web-app', 'missing folders are skipped');
  assert.equal(defaultProject([], undefined, undefined), null);
});

const W = (id: string, over: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id, kind: 'main', title: `Worker ${id}`, status: 'idle', cwd: '/home/user/Projects/web-app', sessionId: `s-${id}`, control: 'free', ...over,
});

test('assignable workers: mains in that folder that are free or office-run', () => {
  const ws = [W('a'), W('b', { control: 'office' }), W('c', { control: 'elsewhere' }), W('d', { kind: 'temp' }), W('e', { cwd: '/other' }), W('f', { status: 'done' }), W('g', { sessionId: undefined })];
  assert.deepEqual(assignableWorkers(ws, '/home/user/Projects/web-app').map((w) => w.id), ['a', 'b']);
  assert.deepEqual(assignableWorkers(ws, null), []);
});

const web = orderProjects(projects)[0]!;
const base: MemoState = { project: web, assignee: { kind: 'new' }, model: '', mode: 'default', prompt: 'Fix the login bug' };

test('memo summary says what will happen', () => {
  assert.equal(memoSummary(base), 'A new hire will start in ~/Projects/web-app on main. They’ll knock at your door when they need an OK. Counts toward your Claude usage.');
  assert.equal(memoSummary({ ...base, model: 'haiku', mode: 'acceptEdits' }), 'A new hire will start in ~/Projects/web-app on main. File edits in the project are auto-approved. Commands, web access and anything outside the project still knock. Model: Haiku. Counts toward your Claude usage.');
  assert.match(memoSummary({ ...base, mode: 'plan' }), /plan first and bring you the plan to sign off/);
  assert.equal(memoSummary({ ...base, project: P('x', 'recent') }), 'A new hire will start in ~/Projects/x. They’ll knock at your door when they need an OK. Counts toward your Claude usage.');
  assert.match(memoSummary({ ...base, assignee: { kind: 'worker', worker: W('a') } }), /^“Worker a” picks this up in their own session, in ~\/Projects\/web-app on main\./);
  assert.match(memoSummary({ ...base, assignee: { kind: 'worker', worker: W('b', { control: 'office', busy: true }) } }), /after their current step/);
  assert.match(memoSummary({ ...base, project: null }), /^Pick a project/);
});

test('memo problems block sending', () => {
  assert.equal(memoProblem(base), null);
  assert.equal(memoProblem({ ...base, project: null }), 'Pick a project folder.');
  assert.equal(memoProblem({ ...base, prompt: '  \n ' }), 'Write the task first.');
  assert.equal(memoProblem({ ...base, project: projects[2]! }), 'That folder no longer exists.');
  assert.equal(memoProblem({ ...base, prompt: 'x'.repeat(20_005) }), 'The task is 5 characters too long.');
});

test('memo message: newTask for new hires and free workers, reply for office-run workers', () => {
  assert.deepEqual(memoMessage(base, 'n1'), {
    type: 'newTask', nonce: 'n1', projectPath: '/home/user/Projects/web-app', prompt: 'Fix the login bug', assignTo: { kind: 'new' }, permissionMode: 'default',
  });
  assert.deepEqual(memoMessage({ ...base, model: 'sonnet', mode: 'plan', assignee: { kind: 'worker', worker: W('a') } }, 'n2'), {
    type: 'newTask', nonce: 'n2', projectPath: '/home/user/Projects/web-app', prompt: 'Fix the login bug', assignTo: { kind: 'existing', sessionId: 's-a' }, permissionMode: 'plan', model: 'sonnet',
  });
  assert.deepEqual(memoMessage({ ...base, assignee: { kind: 'worker', worker: W('b', { control: 'office' }) } }, 'n3'), { type: 'reply', sessionId: 's-b', text: 'Fix the login bug' });
  assert.equal(memoMessage({ ...base, prompt: '' }, 'n4'), null);
});

test('counter appears only near the limit', () => {
  assert.equal(counterText(100), '');
  assert.equal(counterText(16_000), '16,000 / 20,000');
  assert.equal(counterText(20_001), '20,001 / 20,000');
});

test('memo message carries the chosen effort (Default leaves it out)', () => {
  const m = memoMessage({ ...base, model: 'sonnet', effort: 'high' }, 'n5');
  assert.equal(m?.type, 'newTask');
  assert.equal((m as { effort?: string }).effort, 'high');
  assert.equal((m as { model?: string }).model, 'sonnet');
  assert.equal('effort' in (memoMessage({ ...base, effort: null }, 'n6') ?? {}), false);
  assert.equal('effort' in (memoMessage(base, 'n7') ?? {}), false);
  // An office-run worker keeps their settings: the memo is a plain reply.
  assert.deepEqual(memoMessage({ ...base, effort: 'max', assignee: { kind: 'worker', worker: W('b', { control: 'office' }) } }, 'n8'), { type: 'reply', sessionId: 's-b', text: 'Fix the login bug' });
});

test('memo summary mentions a chosen effort', () => {
  assert.match(memoSummary({ ...base, model: 'sonnet', effort: 'high' }), / Model: Sonnet\. Effort: High\. Counts/);
  assert.match(memoSummary({ ...base, effort: 'xhigh' }), /They’ll knock at your door when they need an OK\. Effort: XHigh\. Counts/);
});

test('model and approval choices are still exported from memoLogic', () => {
  assert.deepEqual(MODEL_CHOICES.map((m) => m.value), ['', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(APPROVAL_CHOICES.map((c) => c.label), ['Knock at my door', 'Auto-accept file edits', 'Plan first']);
  // The case header chip says the same as the memo (task 10.1).
  assert.deepEqual(APPROVAL_CHOICES.map((c) => c.short), APPROVAL_CHOICES.map((c) => c.label));
});

// ---- applyPrefill ----
const DEFS = { model: 'opus', effortByModel: {}, models: [
  { value: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
] } as unknown as import('../src/shared/protocol.ts').ClaudeDefaults;
const WEB = '/home/user/Projects/web-app';
const prefillBase: MemoState = { project: web, assignee: { kind: 'new' }, model: '', mode: 'default', prompt: '' };

test('applyPrefill: an empty prefill changes nothing', () => {
  const r = applyPrefill(prefillBase, {}, [W('a')], projects, DEFS);
  assert.deepEqual(r.state, prefillBase);
  assert.equal(r.note, '');
  assert.deepEqual(applyPrefill(prefillBase, undefined, [], projects, null).state, prefillBase);
});

test('applyPrefill: a free worker is preselected, with their project', () => {
  const r = applyPrefill({ ...prefillBase, project: orderProjects(projects)[1]! }, { sessionId: 's-a' }, [W('a')], projects, DEFS);
  assert.equal(r.state.project?.path, WEB);
  assert.equal(r.state.assignee.kind, 'worker');
  assert.equal(r.state.assignee.kind === 'worker' && r.state.assignee.worker.id, 'a');
  assert.equal(r.note, '');
});

test('applyPrefill: a worker who cannot take it falls back to a new hire with a note', () => {
  const r = applyPrefill(prefillBase, { sessionId: 's-a' }, [W('a', { control: 'elsewhere', title: 'Dana' })], projects, DEFS);
  assert.deepEqual(r.state.assignee, { kind: 'new' });
  assert.equal(r.note, 'Dana is busy, so this goes to a new hire.');
  assert.match(applyPrefill(prefillBase, { sessionId: 'gone' }, [], projects, DEFS).note, /not available/);
});

test('applyPrefill: a different project than the worker’s means a new hire there', () => {
  const r = applyPrefill(prefillBase, { sessionId: 's-a', projectPath: '/home/user/Projects/api' }, [W('a')], projects, DEFS);
  assert.equal(r.state.project?.name, 'api');
  assert.deepEqual(r.state.assignee, { kind: 'new' });
  assert.match(r.note, /new hire/);
  // A missing folder is ignored.
  assert.equal(applyPrefill(prefillBase, { projectPath: '/home/user/Projects/old' }, [], projects, DEFS).state.project, web);
});

test('applyPrefill: the prompt is kept as given, and a draft survives when none is given', () => {
  assert.equal(applyPrefill(prefillBase, { prompt: '/review ' }, [], projects, DEFS).state.prompt, '/review ');
  assert.equal(applyPrefill({ ...prefillBase, prompt: 'draft' }, { projectPath: WEB }, [], projects, DEFS).state.prompt, 'draft');
});

test('applyPrefill: options are applied and effort is clamped like a manual choice', () => {
  const r = applyPrefill(prefillBase, { options: { model: 'sonnet', effort: 'max', permissionMode: 'plan' } }, [], projects, DEFS);
  assert.equal(r.state.model, 'sonnet');
  assert.equal(r.state.effort, 'high');
  assert.equal(r.state.mode, 'plan');
  assert.match(r.effortNote, /Sonnet doesn’t offer/);
  const h = applyPrefill(prefillBase, { options: { model: 'haiku', effort: 'high' } }, [], projects, DEFS);
  assert.equal(h.state.effort, null);
  const ok = applyPrefill(prefillBase, { options: { model: 'opus', effort: 'max' } }, [], projects, DEFS);
  assert.equal(ok.state.effort, 'max');
  assert.equal(ok.effortNote, '');
});
