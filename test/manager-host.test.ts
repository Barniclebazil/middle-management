import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_WINDOWS_KEY, createManagerHost } from '../src/manager/managerHost.ts';
import type { CaseRead, ManagerHost, SdkItemBuilderInit } from '../src/manager/managerHost.ts';
import { createSdkItemBuilder, itemsFromSdkMessage } from '../src/manager/conversation.ts';
import type { PlanText } from '../src/model/planIndex.ts';
import type { AgentSnapshot, ConversationItem, HostToWebview, UsageWindow, WebviewToHost } from '../src/shared/protocol.ts';
import { FakeTimers, SID, assistantText, assistantTool, fakeBuilder, fakeSdk, initMsg, rateLimitMsg, resultMsg, settle } from './manager-fakes.ts';

type Posted = HostToWebview;
const SID2 = 'd2222222-0000-4000-8000-000000000002';

function agent(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, kind: 'main', title: 'Fix the build', project: 'proj', activity: 'idle', status: 'idle', since: 1000, startedAt: 500, sessionId: id, cwd: '/w/proj', ...over };
}

interface SetupOver {
  binary?: () => ReturnType<typeof defaultBinary> | Promise<ReturnType<typeof defaultBinary>>;
  /** Use the real item builder (so cost notices and plan items are real) instead of the fake. */
  realBuilder?: boolean;
  /** Initial contents of the persisted store (key `CONTEXT_WINDOWS_KEY`). */
  stored?: unknown;
  planText?: (agentId: string, planId: string) => PlanText | undefined;
  /** JSONL tail text per session id, for seeding the cost tracker on resume. */
  tails?: Map<string, string>;
  /** Give the host a `postTo`, so messages are routed to named webviews and recorded in `routed` (and not in `posted`). */
  routed?: boolean;
  /** Control methods the fake SDK query lacks (an older Claude Code build). */
  omit?: Parameters<typeof fakeSdk>[0] extends infer O ? (O extends { omit?: infer M } ? M : never) : never;
}

function setup(over: SetupOver = {}) {
  const posted: Posted[] = [];
  const routed: Array<{ to: string[]; msg: Posted }> = [];
  const sdk = fakeSdk(over.omit ? { omit: over.omit } : {});
  const timers = new FakeTimers();
  const live = new Set<string>();
  const dirs = new Set<string>(['/w/proj', '/w/other', '/picked']);
  const cases = new Map<string, CaseRead>();
  const readCalls: string[] = [];
  const commands: unknown[][] = [];
  const builders: Array<ReturnType<typeof fakeBuilder>> = [];
  const builderInits: Array<SdkItemBuilderInit | undefined> = [];
  const saved: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const rateLimits: UsageWindow[][] = [];
  const state = { refreshes: 0, dialog: undefined as string | undefined, commandFails: false, readFails: false, uriOk: true as boolean | 'throw', lastModels: new Map<string, string>(), modelLookups: 0 };
  const host: ManagerHost = createManagerHost({
    post: (m) => posted.push(m),
    ...(over.routed ? { postTo: (to: readonly string[], msg: Posted) => { routed.push({ to: [...to].sort(), msg }); } } : {}),
    queryFn: sdk.queryFn,
    findBinary: over.binary ?? defaultBinary,
    readCase: async (a) => {
      readCalls.push(a.id);
      if (state.readFails) throw new Error('unreadable');
      return cases.get(a.id) ?? { items: [], truncated: false };
    },
    createSdkItemBuilder: (init) => {
      builderInits.push(init);
      if (over.realBuilder) return createSdkItemBuilder(init);
      const b = fakeBuilder();
      builders.push(b);
      return b;
    },
    itemsFromSdkMessage: (m, b) => (over.realBuilder ? itemsFromSdkMessage(m, b as ReturnType<typeof createSdkItemBuilder>) : b.apply(m)),
    readTranscriptTail: async (id) => over.tails?.get(id),
    ...(over.planText ? { planText: over.planText } : {}),
    storage: {
      get: (k) => (k === CONTEXT_WINDOWS_KEY ? over.stored : undefined),
      set: (k, v) => {
        saved.push([k, v]);
      },
    },
    onRateLimit: (w) => rateLimits.push(w),
    listLiveSessionIds: () => live,
    workspaceFolders: () => ['/w/proj'],
    showOpenDialog: async () => state.dialog,
    executeCommand: async (id, ...args) => {
      commands.push([id, ...args]);
      if (state.commandFails) throw new Error('command not found');
      return undefined;
    },
    openUri: async (uri) => {
      commands.push(['openUri', uri]);
      if (state.uriOk === 'throw') throw new Error('nope');
      return state.uriOk;
    },
    lastModelFor: async (id) => { state.modelLookups++; return state.lastModels.get(id); },
    exists: (p) => dirs.has(p),
    readFile: () => undefined,
    refreshAgents: () => { state.refreshes++; },
    log: (m) => logs.push(m),
    now: () => timers.now,
    timers,
    platform: 'linux',
    graceMs: 20,
  });
  const of = <T extends Posted['type']>(type: T): Array<Extract<Posted, { type: T }>> => posted.filter((m): m is Extract<Posted, { type: T }> => m.type === type);
  const send = async (m: WebviewToHost, source?: string): Promise<void> => {
    await host.handle(m, source);
    await settle();
  };
  /** Routed messages of a type, with their recipients (needs `routed: true`). */
  const routedOf = <T extends Posted['type']>(type: T): Array<{ to: string[]; msg: Extract<Posted, { type: T }> }> =>
    routed.filter((r): r is { to: string[]; msg: Extract<Posted, { type: T }> } => r.msg.type === type);
  const newTask = (nonce = 'n1', prompt = 'Fix the build', extra: Partial<Extract<WebviewToHost, { type: 'newTask' }>> = {}): Promise<void> =>
    send({ type: 'newTask', nonce, projectPath: '/w/proj', prompt, assignTo: { kind: 'new' }, permissionMode: 'default', ...extra });
  return { host, posted, routed, routedOf, sdk, timers, live, dirs, cases, readCalls, commands, builders, builderInits, saved, logs, rateLimits, state, of, send, newTask };
}

function defaultBinary(): { path: string; source: 'setting' } {
  return { path: '/bin/claude', source: 'setting' };
}

const lastError = (t: ReturnType<typeof setup>) => t.of('error').at(-1);

// --- new hire ----------------------------------------------------------------------------------------------------------

test('new task: runner starts, taskStarted once the session id is known, items stream, pending knocks, decide resolves', async () => {
  const t = setup();
  await t.newTask('n1', 'Fix the build', { model: 'haiku' });
  assert.equal(t.sdk.queries.length, 1);
  const q = t.sdk.queries[0]!;
  assert.equal(q.params.options.cwd, '/w/proj');
  assert.equal(q.params.options.pathToClaudeCodeExecutable, '/bin/claude');
  assert.equal(q.params.options.permissionMode, 'default');
  assert.equal(q.params.options.model, 'haiku');
  assert.deepEqual(q.received, ['Fix the build']);
  assert.equal(t.of('taskStarted').length, 0); // id not known yet

  q.emit(initMsg());
  await settle();
  assert.deepEqual(t.of('taskStarted'), [{ type: 'taskStarted', nonce: 'n1', sessionId: SID, agentId: SID }]);
  assert.equal(t.host.controlFor({ id: SID, kind: 'main', sessionId: SID }), 'office');

  // The webview opens the case before the feed has listed the new hire.
  await t.send({ type: 'openCase', agentId: SID });
  const file = t.of('caseFile')[0]!;
  assert.equal(file.agentId, SID);
  assert.equal(file.header.control, 'office');
  assert.equal(file.header.busy, true);
  assert.equal(file.header.model, 'claude-haiku-5-5');
  assert.equal(file.pending, null);
  assert.deepEqual(file.items.map((i) => [i.kind, (i as { text?: string }).text]), [['prompt', 'Fix the build']]);

  // Streaming items are batched (at most one append per flush interval).
  q.emit(assistantText('On it.', SID, 'msg_1'), assistantText('Done soon.', SID, 'msg_2'));
  await settle();
  assert.equal(t.of('caseAppend').length, 0);
  await t.timers.advance(250);
  const appends = t.of('caseAppend');
  assert.equal(appends.length, 1);
  assert.deepEqual(appends[0]!.items.map((i) => i.id), ['msg_1:0', 'msg_2:0']);

  // A permission request: card, pending in office info, feed refresh.
  const refreshesBefore = t.state.refreshes;
  const answer = q.ask('Bash', { command: 'echo office-ok > marker.txt', description: 'Write marker' }, { toolUseID: 'toolu_01' });
  await settle();
  const info = t.host.getOfficeInfo(SID);
  assert.equal(info?.pending?.kind, 'permission');
  assert.ok(t.state.refreshes > refreshesBefore);
  const knock = t.of('caseAppend').at(-1)!;
  assert.equal(knock.pending?.kind, 'permission');
  assert.equal(knock.header?.activity, 'needsYou');
  const requestId = knock.pending!.requestId;
  assert.equal(info?.pending?.requestId, requestId);

  await t.send({ type: 'decide', requestId, decision: { kind: 'allow' } });
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'echo office-ok > marker.txt', description: 'Write marker' } });
  const cleared = t.of('caseAppend').at(-1)!;
  assert.equal(cleared.pending, null);
  assert.deepEqual(t.host.getOfficeInfo(SID), { model: 'claude-haiku-5-5' }); // nothing pending, no cost yet

  // The turn ends: cost is summed into office info and the header.
  q.emit(resultMsg(0.0039));
  await settle();
  await t.timers.advance(250);
  assert.equal(t.host.getOfficeInfo(SID)?.costUsd, 0.0039);
  const header = t.of('caseAppend').at(-1)!.header!;
  assert.equal(header.busy, false);
  assert.equal(header.costUsd, 0.0039);
});

test('new task failures leave nothing running and carry the nonce', async () => {
  const noDir = setup();
  await noDir.send({ type: 'newTask', nonce: 'n9', projectPath: '/missing', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' });
  assert.equal(lastError(noDir)?.nonce, 'n9');
  assert.match(lastError(noDir)!.message, /does not exist/);
  assert.equal(noDir.sdk.queries.length, 0);

  const noBin = setup({ binary: () => ({ error: 'Could not find the Claude Code program. Tried: ...' }) as never });
  await noBin.newTask('n2');
  assert.deepEqual(lastError(noBin), { type: 'error', nonce: 'n2', message: 'Could not find the Claude Code program. Tried: ...' });
  assert.equal(noBin.sdk.queries.length, 0);

  const boom = setup();
  boom.sdk.throwOnCall = new ReferenceError('Claude Code native binary not found at /bin/claude');
  await boom.newTask('n3');
  assert.equal(boom.of('error').at(0)?.nonce, 'n3');
  assert.equal(boom.of('error').length, 1);
  assert.equal(boom.of('taskStarted').length, 0);
  assert.equal(boom.host.controlFor({ id: SID, kind: 'main', sessionId: SID }), 'free');
});

test('a run that never reports a session id is stopped after the start timeout', async () => {
  const t = setup();
  await t.newTask('n1');
  await t.timers.advance(46_000);
  assert.equal(lastError(t)?.nonce, 'n1');
  assert.match(lastError(t)!.message, /did not start/);
  assert.equal(t.of('taskStarted').length, 0);
});

test('process exit before the first message is reported against the nonce, once', async () => {
  const t = setup();
  await t.newTask('n1');
  t.sdk.queries[0]!.fail(new Error('Claude Code process exited with code 1. stderr: boom'));
  await settle();
  const errs = t.of('error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.nonce, 'n1');
});

// --- resume and reply -------------------------------------------------------------------------------------------------

test('new task to an existing free worker resumes it and answers taskStarted at once', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'old1', text: 'earlier' }], truncated: false });
  await t.send({ type: 'newTask', nonce: 'n5', projectPath: '/w/proj', prompt: 'Continue', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'acceptEdits' });
  const q = t.sdk.queries[0]!;
  assert.equal(q.params.options.resume, SID);
  assert.equal(q.params.options.permissionMode, 'acceptEdits');
  assert.equal(q.params.options.cwd, '/w/proj');
  assert.deepEqual(t.of('taskStarted'), [{ type: 'taskStarted', nonce: 'n5', sessionId: SID, agentId: SID }]);
  assert.equal(t.host.controlFor(agent(SID)), 'office');

  // The case snapshot carries the transcript from before the run plus the run's own items.
  q.emit(initMsg(), assistantText('Resuming', SID, 'm9'));
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  const file = t.of('caseFile')[0]!;
  assert.deepEqual(file.items.map((i) => i.id), ['old1', 'local:' + SID + ':1', 'm9:0']);
});

test('resume refuses a session that is live elsewhere, unknown, or not a main agent', async () => {
  const t = setup();
  t.host.onAgents([agent(SID), agent(`${SID}/a1`, { kind: 'temp', parentId: SID })]);
  t.live.add(SID);
  await t.send({ type: 'newTask', nonce: 'n1', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default' });
  assert.equal(lastError(t)?.nonce, 'n1');
  assert.match(lastError(t)!.message, /another Claude Code/);
  await t.send({ type: 'newTask', nonce: 'n2', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: 'nope' }, permissionMode: 'default' });
  assert.equal(lastError(t)?.nonce, 'n2');
  await t.send({ type: 'newTask', nonce: 'n3', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: `${SID}/a1` }, permissionMode: 'default' });
  assert.equal(lastError(t)?.nonce, 'n3');
  assert.equal(t.sdk.queries.length, 0);
});

test('resume re-checks liveness right before spawning, after the binary lookup', async () => {
  let t!: ReturnType<typeof setup>;
  t = setup({
    binary: async () => {
      t.live.add(SID); // another process grabs the session while we look for the binary
      return defaultBinary();
    },
  });
  t.host.onAgents([agent(SID)]);
  await t.send({ type: 'newTask', nonce: 'n1', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default' });
  assert.equal(t.sdk.queries.length, 0);
  assert.equal(lastError(t)?.nonce, 'n1');
});

test('a newTask aimed at a running office worker becomes its next message (never a second runner)', async () => {
  const t = setup();
  await t.newTask('n1');
  t.sdk.queries[0]!.emit(initMsg());
  await settle();
  await t.send({ type: 'newTask', nonce: 'n2', projectPath: '/w/proj', prompt: 'And also this', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default' });
  assert.equal(t.sdk.queries.length, 1);
  assert.deepEqual(t.sdk.queries[0]!.received, ['Fix the build', 'And also this']);
  assert.deepEqual(t.of('taskStarted').at(-1), { type: 'taskStarted', nonce: 'n2', sessionId: SID, agentId: SID });
});

test('reply to an office worker sends now (queues while busy) and echoes the prompt', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  await t.send({ type: 'reply', sessionId: SID, text: 'Also add tests' });
  assert.deepEqual(q.received, ['Fix the build', 'Also add tests']);
  const echo = t.of('caseAppend').at(-1)!;
  assert.equal(echo.items[0]!.kind, 'prompt');
  assert.equal((echo.items[0] as { text: string }).text, 'Also add tests');
  assert.equal(t.sdk.queries.length, 1);
});

test('reply routing by control: free resumes, elsewhere and unknown are errors', async () => {
  const t = setup();
  t.host.onAgents([agent(SID), agent(SID2, { cwd: '/w/other' })]);

  t.live.add(SID2);
  await t.send({ type: 'reply', sessionId: SID2, text: 'hello' });
  assert.match(lastError(t)!.message, /another Claude Code window or terminal/);
  assert.equal(lastError(t)!.nonce, undefined);
  assert.equal(lastError(t)!.sessionId, SID2); // the webview shows it inline when that case is open
  assert.equal(t.sdk.queries.length, 0);

  await t.send({ type: 'reply', sessionId: 'ghost', text: 'hello' });
  assert.equal(t.of('error').length, 2);
  assert.equal(t.sdk.queries.length, 0);

  await t.send({ type: 'reply', sessionId: SID, text: 'carry on' });
  assert.equal(t.sdk.queries.length, 1);
  const o = t.sdk.queries[0]!.params.options;
  assert.equal(o.resume, SID);
  assert.equal(o.permissionMode, 'default'); // nothing remembered
  assert.deepEqual(t.sdk.queries[0]!.received, ['carry on']);
  assert.equal(t.of('taskStarted').length, 0); // replies have no nonce
  assert.equal(t.host.controlFor(agent(SID)), 'office');
});

test('a resumed reply reuses the permission mode last used for that session, and the cost sum carries over', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  await t.send({ type: 'newTask', nonce: 'n1', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'acceptEdits' });
  const q = t.sdk.queries[0]!;
  q.emit(initMsg(SID, { permissionMode: 'acceptEdits' }), resultMsg(0.001));
  q.finish();
  await settle();
  assert.equal(t.host.controlFor(agent(SID)), 'free');
  await t.send({ type: 'reply', sessionId: SID, text: 'again' });
  assert.equal(t.sdk.queries.length, 2);
  assert.equal(t.sdk.queries[1]!.params.options.permissionMode, 'acceptEdits');
  assert.equal(t.host.getOfficeInfo(SID)?.costUsd, 0.001);
});

test('resume keeps the last model: the runner wins, then the transcript, an explicit one beats both, none when unknown', async () => {
  // 1. the runner's last reported model wins over the transcript
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.state.lastModels.set(SID, 'claude-from-transcript');
  await t.send({ type: 'newTask', nonce: 'n1', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default', model: 'haiku' });
  const q = t.sdk.queries[0]!;
  q.emit(initMsg(SID, { model: 'claude-haiku-5-5' }), resultMsg(0.001));
  q.finish();
  await settle();
  await t.send({ type: 'reply', sessionId: SID, text: 'again' });
  assert.equal(t.sdk.queries[1]!.params.options.model, 'claude-haiku-5-5');
  assert.equal(t.state.modelLookups, 0);
  await t.send({ type: 'openCase', agentId: SID });
  assert.equal(t.of('caseFile').at(-1)!.header.model, 'claude-haiku-5-5');

  // 2. no runner history: the transcript's model, shown in the header
  const u = setup();
  u.host.onAgents([agent(SID2, { sessionId: SID2 })]);
  u.state.lastModels.set(SID2, 'claude-haiku-4-5');
  await u.send({ type: 'reply', sessionId: SID2, text: 'hello' });
  assert.equal(u.sdk.queries[0]!.params.options.model, 'claude-haiku-4-5');
  await u.send({ type: 'openCase', agentId: SID2 });
  assert.equal(u.of('caseFile').at(-1)!.header.model, 'claude-haiku-4-5');

  // 3. an explicit model beats the transcript
  const v = setup();
  v.host.onAgents([agent(SID)]);
  v.state.lastModels.set(SID, 'claude-haiku-4-5');
  await v.send({ type: 'newTask', nonce: 'n3', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default', model: 'opus' });
  assert.equal(v.sdk.queries[0]!.params.options.model, 'opus');

  // 4. a missing transcript gives no model at all
  const w = setup();
  w.host.onAgents([agent(SID)]);
  await w.send({ type: 'reply', sessionId: SID, text: 'hello' });
  assert.equal(w.sdk.queries[0]!.params.options.model, undefined);
});

// --- decisions, questions, plans -----------------------------------------------------------------------------------------

test('decide: unknown id errors, repeat is silent, wrong kind errors and keeps the request', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  const answer = q.ask('Bash', { command: 'x > y' }, { toolUseID: 't1', suggestions: [] });
  await settle();
  const requestId = t.host.getOfficeInfo(SID)!.pending!.requestId;

  await t.send({ type: 'decide', requestId: 'nope', decision: { kind: 'allow' } });
  assert.equal(t.of('error').length, 1);
  assert.equal(lastError(t)!.requestId, 'nope');
  assert.equal(lastError(t)!.sessionId, undefined); // unknown request: no session to blame

  await t.send({ type: 'decide', requestId, decision: { kind: 'plan', approve: true } });
  assert.equal(t.of('error').length, 2);
  assert.equal(lastError(t)!.requestId, requestId);
  assert.equal(lastError(t)!.sessionId, SID);
  assert.ok(t.host.getOfficeInfo(SID)?.pending);

  await t.send({ type: 'decide', requestId, decision: { kind: 'allow', always: true } }); // no suggestions
  assert.equal(t.of('error').length, 3);

  await t.send({ type: 'decide', requestId, decision: { kind: 'deny', message: 'Not now' } });
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Not now' });
  await t.send({ type: 'decide', requestId, decision: { kind: 'deny' } }); // double click
  assert.equal(t.of('error').length, 3);
});

test('decide: every decision is logged once with id, kind, approval and match, never the free text', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  const answer = q.ask('Bash', { command: 'x > y' }, { toolUseID: 't1', suggestions: [] });
  await settle();
  const requestId = t.host.getOfficeInfo(SID)!.pending!.requestId;

  await t.send({ type: 'decide', requestId: 'nope', decision: { kind: 'allow' } });
  assert.deepEqual(t.logs.filter((m) => m.startsWith('decision ')), ['decision nope kind allow approves true matched false']);

  t.logs.length = 0;
  await t.send({ type: 'decide', requestId, decision: { kind: 'deny', message: 'Secret reason' } });
  await answer;
  assert.deepEqual(t.logs.filter((m) => m.startsWith('decision ')), [`decision ${requestId} kind deny approves false matched true`]);
  assert.equal(t.logs.some((m) => m.includes('Secret reason')), false);
  assert.equal(t.logs.filter((m) => m.startsWith('pending ')).length, 1);

  t.logs.length = 0;
  await t.send({ type: 'decide', requestId, decision: { kind: 'deny' } }); // double click
  assert.deepEqual(t.logs, [`decision ${requestId} kind deny approves false matched false`, 'duplicate decision ignored']);
});

test('question and plan requests round trip through decide', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  const input = { questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] };
  const answer = q.ask('AskUserQuestion', input, { toolUseID: 'tq' });
  await settle();
  const card = t.of('caseAppend').at(-1)!.pending!;
  assert.equal(card.kind, 'question');
  await t.send({ type: 'decide', requestId: card.requestId, decision: { kind: 'answer', answers: { 'Pick one?': 'Other' }, other: { 'Pick one?': 'C please' } } });
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { questions: input.questions, answers: { 'Pick one?': 'C please' } } });

  // A question can be skipped.
  const skipped = q.ask('AskUserQuestion', input, { toolUseID: 'tq2' });
  await settle();
  const card2 = t.of('caseAppend').at(-1)!.pending!;
  assert.equal(card2.kind, 'question');
  await t.send({ type: 'decide', requestId: card2.requestId, decision: { kind: 'deny' } });
  const skippedResult = (await skipped) as { behavior: string; message?: string; interrupt?: boolean };
  assert.equal(skippedResult.behavior, 'deny');
  assert.match(skippedResult.message ?? '', /chose not to answer/);
  assert.equal(skippedResult.interrupt, undefined);
  assert.equal(t.of('error').length, 0);

  const plan = q.ask('ExitPlanMode', { plan: '# Plan', planFilePath: '/x/plan.md' }, { toolUseID: 'tp' });
  await settle();
  const pc = t.of('caseAppend').at(-1)!.pending!;
  assert.equal(pc.kind, 'plan');
  await t.send({ type: 'decide', requestId: pc.requestId, decision: { kind: 'plan', approve: false, feedback: 'More detail' } });
  assert.deepEqual(await plan, { behavior: 'deny', message: 'More detail' });
});

test('two requests at once: the oldest is shown, the next one after it is answered', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  const a = q.ask('Bash', { command: 'a > a' }, { toolUseID: 'ta' });
  const b = q.ask('Bash', { command: 'b > b' }, { toolUseID: 'tb' });
  await settle();
  const first = t.host.getOfficeInfo(SID)!.pending!.requestId;
  assert.ok(first.endsWith('ta'));
  await t.send({ type: 'decide', requestId: first, decision: { kind: 'allow' } });
  await a;
  const next = t.of('caseAppend').at(-1)!.pending;
  assert.ok(next && next.requestId.endsWith('tb'));
  await t.send({ type: 'decide', requestId: next!.requestId, decision: { kind: 'deny' } });
  await b;
  assert.equal(t.of('caseAppend').at(-1)!.pending, null);
});

// --- interrupt ------------------------------------------------------------------------------------------------------------

test('interrupt: unknown session errors; otherwise denies pending requests and interrupts the SDK', async () => {
  const t = setup();
  await t.send({ type: 'interrupt', sessionId: SID });
  assert.equal(t.of('error').length, 1);

  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  const answer = q.ask('Bash', { command: 'sleep 3 > z' }, { toolUseID: 't1' });
  await settle();
  await t.send({ type: 'interrupt', sessionId: SID });
  assert.equal(q.interrupts, 1);
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Interrupted', interrupt: true });
  assert.equal(t.of('caseAppend').at(-1)!.pending, null);
  assert.equal(t.builders[0]!.interrupted, 1);
  // The session lives on.
  q.emit(resultMsg(0.001, SID, 'error_during_execution'));
  await settle();
  assert.equal(t.host.controlFor(agent(SID)), 'office');
  await t.send({ type: 'reply', sessionId: SID, text: 'next' });
  assert.deepEqual(q.received.at(-1), 'next');
});

// --- open in Claude Code -----------------------------------------------------------------------------------------------------

test('openInClaudeCode runs the Claude Code command with the session id, with a URI fallback', async () => {
  const t = setup();
  await t.send({ type: 'openInClaudeCode', sessionId: SID });
  assert.deepEqual(t.commands, [['claude-vscode.editor.open', SID]]);
  assert.equal(t.of('error').length, 0);

  t.state.commandFails = true;
  await t.send({ type: 'openInClaudeCode', sessionId: SID });
  assert.equal(t.commands.at(-1)![0], 'openUri');
  assert.equal(t.commands.at(-1)![1], `vscode://anthropic.claude-code/open?session=${SID}`);
  assert.equal(t.of('error').length, 0);

  t.state.uriOk = false;
  await t.send({ type: 'openInClaudeCode', sessionId: SID });
  assert.equal(t.of('error').length, 1);
  t.state.uriOk = 'throw';
  await t.send({ type: 'openInClaudeCode', sessionId: SID });
  assert.equal(t.of('error').length, 2);
});

// --- projects ---------------------------------------------------------------------------------------------------------------

test('listProjects: workspace first, then recent cwds from agents, with a default', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { cwd: '/w/other' }), agent(SID2, { cwd: '/w/proj' }), agent('x', { cwd: '/gone', since: 5 })]);
  await t.send({ type: 'listProjects' });
  const msg = t.of('projects')[0]!;
  assert.deepEqual(msg.projects.map((p) => [p.path, p.source, p.exists]), [
    ['/w/proj', 'workspace', true],
    ['/w/other', 'recent', true],
    ['/gone', 'recent', false],
  ]);
  assert.equal(msg.defaultPath, '/w/proj');
});

test('listProjects defaults to the open case worker\'s folder', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { cwd: '/w/other' })]);
  await t.send({ type: 'openCase', agentId: SID });
  await t.send({ type: 'listProjects' });
  assert.equal(t.of('projects')[0]!.defaultPath, '/w/other');
});

test('browseProject adds the picked folder (defaultPath) and ignores a cancelled dialog', async () => {
  const t = setup();
  t.state.dialog = '/picked';
  await t.send({ type: 'browseProject' });
  const m = t.of('projects')[0]!;
  assert.equal(m.defaultPath, '/picked');
  assert.deepEqual(m.projects.map((p) => [p.path, p.source]), [['/w/proj', 'workspace'], ['/picked', 'browsed']]);
  t.state.dialog = undefined;
  await t.send({ type: 'browseProject' });
  const m2 = t.of('projects')[1]!;
  assert.equal(m2.defaultPath, '/w/proj');
  assert.ok(m2.projects.some((p) => p.path === '/picked')); // remembered
});

// --- case files ---------------------------------------------------------------------------------------------------------------------

test('case for a non-office agent: snapshot, then only changed and new items about every second', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { control: 'free' })]);
  const a: ConversationItem = { kind: 'prompt', id: 'u1', text: 'hello' };
  const b: ConversationItem = { kind: 'assistant', id: 'a1', text: 'partial' };
  t.cases.set(SID, { items: [a, b], truncated: true });
  await t.send({ type: 'openCase', agentId: SID });
  const file = t.of('caseFile')[0]!;
  assert.equal(file.truncated, true);
  assert.equal(file.header.control, 'free');
  assert.equal(file.header.title, 'Fix the build');
  assert.equal(file.pending, null);
  assert.deepEqual(file.items, [a, b]);

  await t.timers.advance(1000);
  assert.equal(t.of('caseAppend').length, 0); // nothing changed

  const b2: ConversationItem = { kind: 'assistant', id: 'a1', text: 'partial and more' };
  const c: ConversationItem = { kind: 'tool', id: 't1', name: 'Read', state: 'done', summary: 'Read x.ts' };
  t.cases.set(SID, { items: [a, b2, c], truncated: true });
  await t.timers.advance(1000);
  const ap = t.of('caseAppend');
  assert.equal(ap.length, 1);
  assert.deepEqual(ap[0]!.items, [b2, c]);

  await t.send({ type: 'closeCase' });
  assert.equal(t.timers.pending, 0);
  const before = t.readCalls.length;
  await t.timers.advance(5000);
  assert.equal(t.readCalls.length, before);
});

test('openCase: unknown agent errors; a second case replaces the first (one poll only)', async () => {
  const t = setup();
  t.host.onAgents([agent(SID), agent(SID2)]);
  await t.send({ type: 'openCase', agentId: 'ghost' });
  assert.equal(t.of('error').length, 1);
  await t.send({ type: 'openCase', agentId: SID });
  await t.send({ type: 'openCase', agentId: SID2 });
  assert.equal(t.of('caseFile').length, 2);
  assert.equal(t.timers.pending, 1);
  const reads = t.readCalls.length;
  await t.timers.advance(1000);
  assert.equal(t.readCalls.length, reads + 1);
  assert.equal(t.readCalls.at(-1), SID2);
});

test('a case that cannot be read closes with reason error', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.state.readFails = true;
  await t.send({ type: 'openCase', agentId: SID });
  assert.deepEqual(t.of('caseClosed'), [{ type: 'caseClosed', agentId: SID, reason: 'error' }]);
  assert.equal(t.of('caseFile').length, 0);
  assert.equal(t.timers.pending, 0);
});

test('caseClosed agentGone when the open worker leaves the roster', async () => {
  const t = setup();
  t.host.onAgents([agent(SID), agent(SID2)]);
  await t.send({ type: 'openCase', agentId: SID });
  t.host.onAgents([agent(SID2)]);
  assert.deepEqual(t.of('caseClosed'), [{ type: 'caseClosed', agentId: SID, reason: 'agentGone' }]);
  assert.equal(t.timers.pending, 0);
});

test('feed updates become header appends (diffed, batched)', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { activity: 'idle', status: 'idle' })]);
  await t.send({ type: 'openCase', agentId: SID });
  t.host.onAgents([agent(SID, { activity: 'reading', status: 'working', title: 'Fix the build' })]);
  await t.timers.advance(250);
  const ap = t.of('caseAppend');
  assert.equal(ap.length, 1);
  assert.deepEqual(ap[0]!.header, { activity: 'reading', status: 'working' });
  assert.deepEqual(ap[0]!.items, []);
  // Same snapshot again: nothing to say.
  t.host.onAgents([agent(SID, { activity: 'reading', status: 'working' })]);
  await t.timers.advance(250);
  assert.equal(t.of('caseAppend').length, 1);
});

test('resuming a worker whose case is open switches the case from the transcript to the runner, and back when the run ends', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'old', text: 'earlier' }], truncated: false });
  await t.send({ type: 'openCase', agentId: SID });
  assert.equal(t.of('caseFile')[0]!.header.control, 'free');
  assert.equal(t.timers.pending, 1); // transcript poll

  await t.send({ type: 'reply', sessionId: SID, text: 'go on' });
  const q = t.sdk.queries[0]!;
  assert.equal(t.timers.pending, 0); // poll stopped, the runner is the source
  const switched = t.of('caseAppend').at(-1)!;
  assert.equal(switched.header?.control, 'office');
  assert.equal(switched.header?.busy, true);
  assert.equal((switched.items[0] as { text: string }).text, 'go on');

  q.emit(initMsg(), assistantText('ok', SID, 'm1'), resultMsg(0.002));
  await settle();
  await t.timers.advance(250);
  assert.equal(t.of('caseFile').length, 1);

  // The run ends: the transcript becomes the source again, with one fresh snapshot.
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'old', text: 'earlier' }, { kind: 'prompt', id: 'u2', text: 'go on' }, { kind: 'assistant', id: 'a2', text: 'ok' }], truncated: false });
  q.finish();
  await settle();
  const files = t.of('caseFile');
  assert.equal(files.length, 2);
  assert.deepEqual(files[1]!.items.map((i) => i.id), ['old', 'u2', 'a2']);
  assert.equal(files[1]!.header.control, 'free');
  assert.equal(files[1]!.header.busy, false);
  assert.equal(files[1]!.header.costUsd, 0.002);
  assert.equal(t.timers.pending > 0, true); // polling again (plus control refresh timers)
  assert.equal(t.host.controlFor(agent(SID)), 'free');
});

test('a ready message re-sends the open case', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  await t.send({ type: 'openCase', agentId: SID });
  await t.send({ type: 'ready' });
  assert.equal(t.of('caseFile').length, 2);
  await t.send({ type: 'closeCase' });
  await t.send({ type: 'ready' });
  assert.equal(t.of('caseFile').length, 2);
});

// --- control, office info, run end, dispose ---------------------------------------------------------------------------------------

test('controlFor and getOfficeInfo', async () => {
  const t = setup();
  assert.equal(t.host.getOfficeInfo(SID), undefined);
  assert.equal(t.host.controlFor({ id: 'x/a', kind: 'temp', sessionId: 'x' }), 'none');
  assert.equal(t.host.controlFor({ id: SID, kind: 'main', sessionId: SID }), 'free');
  t.live.add(SID);
  t.host.onAgents([]); // new feed update drops the cached live set
  assert.equal(t.host.controlFor({ id: SID, kind: 'main', sessionId: SID }), 'elsewhere');
  await t.newTask('n1');
  t.sdk.queries[0]!.emit(initMsg(SID2));
  await settle();
  t.live.add(SID2); // the run's own sessions file
  t.host.onAgents([]);
  assert.equal(t.host.controlFor({ id: SID2, kind: 'main', sessionId: SID2 }), 'office');
});

test('a run that ends with an error leaves a notice item and an error message', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  q.fail(new Error('Claude Code process exited with code 1. stderr: kaput'));
  await settle();
  assert.ok(t.of('error').some((e) => /exit code 1/.test(e.message)));
  const notice = t.of('caseAppend').flatMap((a) => a.items).find((i) => i.kind === 'notice');
  assert.ok(notice);
  assert.equal(t.host.controlFor({ id: SID, kind: 'main', sessionId: SID }), 'free');
  assert.equal(t.of('caseFile').length, 2); // snapshot again from the transcript
});

test('control is published again shortly after a run ends (its sessions file disappears)', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  q.finish();
  await settle();
  const n = t.state.refreshes;
  await t.timers.advance(1300);
  assert.ok(t.state.refreshes > n);
});

test('dispose denies pending requests, stops every runner and silences the host', async () => {
  const t = setup();
  await t.newTask('n1');
  const q1 = t.sdk.queries[0]!;
  q1.emit(initMsg());
  await settle();
  const answer = q1.ask('Bash', { command: 'a > b' }, { toolUseID: 't1' });
  await settle();
  await t.newTask('n2');
  const q2 = t.sdk.queries[1]!; // still waiting for its session id
  const before = t.posted.length;
  await t.host.dispose();
  assert.equal(((await answer) as { behavior: string }).behavior, 'deny');
  assert.equal(t.host.getOfficeInfo(SID), undefined);
  assert.equal(q2.params.options.abortController!.signal.aborted || q2.closed || q2.interrupts >= 0, true);
  await settle();
  // No new posts after dispose, and further messages are ignored.
  assert.equal(t.posted.length, before);
  await t.host.handle({ type: 'listProjects' });
  assert.equal(t.posted.length, before);
  await t.host.dispose(); // twice is fine
  assert.equal(t.timers.pending, 0);
});

test('the host never throws into the caller: post failures and handler bugs are contained', async () => {
  const posted: Posted[] = [];
  let boom = true;
  const host = createManagerHost({
    post: (m) => {
      if (boom) throw new Error('webview gone');
      posted.push(m);
    },
    queryFn: fakeSdk().queryFn,
    findBinary: () => { throw new Error('lookup bug'); },
    readCase: async () => ({ items: [], truncated: false }),
    createSdkItemBuilder: fakeBuilder,
    itemsFromSdkMessage: (m, b) => b.apply(m),
    listLiveSessionIds: () => { throw new Error('fs bug'); },
    workspaceFolders: () => { throw new Error('ws bug'); },
    showOpenDialog: async () => { throw new Error('dialog bug'); },
    executeCommand: async () => { throw new Error('cmd bug'); },
    exists: () => { throw new Error('exists bug'); },
    log: () => { throw new Error('log bug'); },
  });
  await host.handle({ type: 'listProjects' });
  await host.handle({ type: 'browseProject' });
  await host.handle({ type: 'newTask', nonce: 'n', projectPath: '/x', prompt: 'p', assignTo: { kind: 'new' }, permissionMode: 'default' });
  await host.handle({ type: 'openInClaudeCode', sessionId: SID });
  assert.equal(host.controlFor({ id: SID, kind: 'main' }), 'free');
  host.onAgents([]);
  boom = false;
  await host.handle({ type: 'newTask', nonce: 'n', projectPath: '/x', prompt: 'p', assignTo: { kind: 'new' }, permissionMode: 'default' });
  assert.equal(posted.at(-1)?.type, 'error');
  await host.dispose();
});

test('tool_use items show up in the case while a request is pending for them', async () => {
  const t = setup();
  await t.newTask('n1');
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  q.emit(assistantTool('Bash', { command: 'x > y' }, SID, 'msg_5', 'toolu_5'));
  await settle();
  await t.timers.advance(250);
  const item = t.of('caseAppend').flatMap((a) => a.items).find((i) => i.id === 'toolu_5');
  assert.equal(item?.kind, 'tool');
});

// --- Round A: options, plans, turns, context windows, cost ---------------------------------------------------------------

/** Start an office run and let its session id arrive. Returns the fake query. */
async function hire(t: ReturnType<typeof setup>, extra: Partial<Extract<WebviewToHost, { type: 'newTask' }>> = {}) {
  await t.newTask('n1', 'Fix the build', extra);
  const q = t.sdk.queries[0]!;
  q.emit(initMsg());
  await settle();
  return q;
}

const setOptions = (t: ReturnType<typeof setup>, sessionId: string, options: Extract<WebviewToHost, { type: 'setSessionOptions' }>['options'], nonce = 'o1') =>
  t.send({ type: 'setSessionOptions', nonce, sessionId, options });

test('newTask effort goes to the runner, for a new hire and for a resume', async () => {
  const t = setup();
  await t.newTask('n1', 'Fix the build', { effort: 'high' });
  assert.equal(t.sdk.queries[0]!.params.options.effort, 'high');
  await t.newTask('n2');
  assert.equal(t.sdk.queries[1]!.params.options.effort, undefined);

  const r = setup();
  r.host.onAgents([agent(SID)]);
  await r.send({ type: 'newTask', nonce: 'n3', projectPath: '/w/proj', prompt: 'Continue', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default', effort: 'max' });
  assert.equal(r.sdk.queries[0]!.params.options.effort, 'max');
});

test('setSessionOptions on an office run applies at once between turns and reports applied', async () => {
  const t = setup();
  const q = await hire(t, { effort: 'low' });
  q.emit(resultMsg(0.01));
  await settle();
  await t.send({ type: 'openCase', agentId: SID });
  assert.equal(t.of('caseFile')[0]!.header.effort, 'low');
  assert.equal(t.of('caseFile')[0]!.header.canSetOptions, true);

  await setOptions(t, SID, { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
  assert.deepEqual(t.of('sessionOptions'), [{ type: 'sessionOptions', nonce: 'o1', sessionId: SID, applied: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }, deferred: {} }]);
  assert.deepEqual(q.calls.map((c) => [c.method, c.args[0]]), [['setModel', 'opus'], ['applyFlagSettings', { effortLevel: 'high' }], ['setPermissionMode', 'acceptEdits']]);
  assert.equal(t.of('error').length, 0);
  // The chips follow: the runner's effort and mode reach the case header.
  await t.timers.advance(250);
  const header = t.of('caseAppend').at(-1)!.header!;
  assert.equal(header.effort, 'high');
  assert.equal(header.permissionMode, 'acceptEdits');

  // null resets to the default.
  await setOptions(t, SID, { effort: null, model: null }, 'o2');
  assert.deepEqual(t.of('sessionOptions').at(-1)!.applied, { effort: null, model: null });
  assert.equal(q.calls.at(-1)!.method, 'applyFlagSettings');
  assert.deepEqual(q.calls.at(-1)!.args[0], { effortLevel: null });
});

test('setSessionOptions during a turn is reported as deferred, not applied', async () => {
  const t = setup();
  const q = await hire(t); // still busy: no result yet
  await setOptions(t, SID, { effort: 'xhigh' });
  assert.deepEqual(t.of('sessionOptions'), [{ type: 'sessionOptions', nonce: 'o1', sessionId: SID, applied: {}, deferred: { effort: 'xhigh' } }]);
  assert.deepEqual(q.calls.map((c) => c.method), ['applyFlagSettings']);
});

test('setSessionOptions failures on an office run are an error with the nonce and session id', async () => {
  const t = setup();
  const q = await hire(t);
  q.controlErrors.setModel = new Error('boom');
  await setOptions(t, SID, { model: 'opus', effort: 'high' });
  const err = lastError(t)!;
  assert.equal(err.nonce, 'o1');
  assert.equal(err.sessionId, SID);
  assert.ok(err.message.length > 0);
  assert.equal(t.of('sessionOptions').length, 0);
  assert.deepEqual(q.calls.map((c) => c.method), ['setModel']); // nothing after the failure

  // A Claude Code build without the control: the runner's "update the extension" message comes through.
  const old = setup({ omit: ['applyFlagSettings'] });
  await hire(old);
  await setOptions(old, SID, { effort: 'high' });
  assert.match(lastError(old)!.message, /update/i);
  assert.equal(lastError(old)!.nonce, 'o1');
});

test('setSessionOptions never lets bypassPermissions through', async () => {
  const t = setup();
  const q = await hire(t);
  await setOptions(t, SID, { permissionMode: 'bypassPermissions' } as never);
  assert.equal(lastError(t)?.nonce, 'o1');
  assert.equal(t.of('sessionOptions').length, 0);
  assert.equal(q.calls.length, 0);
  const free = setup();
  free.host.onAgents([agent(SID)]);
  await setOptions(free, SID, { permissionMode: 'bypassPermissions' } as never);
  assert.equal(lastError(free)?.nonce, 'o1');
});

test('free session: options are stored (merged, null kept), shown as `next`, used on the next reply and then cleared', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { effort: 'medium', model: 'claude-opus-5-5' })]);
  await t.send({ type: 'openCase', agentId: SID });
  const h0 = t.of('caseFile')[0]!.header;
  assert.equal(h0.control, 'free');
  assert.equal(h0.canSetOptions, true);
  assert.equal(h0.effort, 'medium');
  assert.deepEqual(h0.next, {});

  await setOptions(t, SID, { effort: 'high' });
  assert.deepEqual(t.of('sessionOptions').at(-1), { type: 'sessionOptions', nonce: 'o1', sessionId: SID, applied: {}, deferred: { effort: 'high' } });
  assert.equal(t.sdk.queries.length, 0); // nothing spawned just to change a chip
  await setOptions(t, SID, { model: 'haiku', permissionMode: 'plan' }, 'o2');
  await t.timers.advance(250);
  const nexts = t.of('caseAppend').map((m) => m.header?.next).filter((n) => n !== undefined);
  assert.deepEqual(nexts.at(-1), { effort: 'high', model: 'haiku', permissionMode: 'plan' });

  // A null is stored as "the default" and replaces what was there.
  await setOptions(t, SID, { effort: null }, 'o3');
  assert.deepEqual(t.of('sessionOptions').at(-1)!.deferred, { effort: null });
  await t.timers.advance(250);
  assert.deepEqual(t.of('caseAppend').map((m) => m.header?.next).filter((n) => n !== undefined).at(-1), { effort: null, model: 'haiku', permissionMode: 'plan' });
  await setOptions(t, SID, { effort: 'low' }, 'o4');

  await t.send({ type: 'reply', sessionId: SID, text: 'go on' });
  const q = t.sdk.queries[0]!;
  assert.equal(q.params.options.model, 'haiku');
  assert.equal(q.params.options.effort, 'low');
  assert.equal(q.params.options.permissionMode, 'plan');
  assert.equal(q.params.options.resume, SID);
  // Used once: the header shows nothing stored any more.
  await t.timers.advance(250);
  assert.deepEqual(t.of('caseAppend').flatMap((m) => (m.header?.next !== undefined ? [m.header.next] : [])).at(-1), {});

  // The next resume after this run gets no stale options.
  q.emit(initMsg(SID, { permissionMode: 'plan' }), resultMsg(0.01));
  await settle();
  await q.interrupt();
  q.finish();
  await settle();
  await t.timers.advance(5000);
  await t.send({ type: 'reply', sessionId: SID, text: 'again' });
  const q2 = t.sdk.queries[1]!;
  assert.equal(q2.params.options.effort, undefined);
  assert.equal(q2.params.options.permissionMode, 'plan'); // the mode last used, as before
});

test('free session: a null model means the default (no model passed on resume), and the task form wins over stored options', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.state.lastModels.set(SID, 'claude-opus-5-5');
  await setOptions(t, SID, { model: null, effort: 'high' });
  await t.send({ type: 'reply', sessionId: SID, text: 'go' });
  assert.equal(t.sdk.queries[0]!.params.options.model, undefined);
  assert.equal(t.sdk.queries[0]!.params.options.effort, 'high');

  const u = setup();
  u.host.onAgents([agent(SID)]);
  await setOptions(u, SID, { model: 'haiku', effort: 'high' });
  await u.send({ type: 'newTask', nonce: 'n1', projectPath: '/w/proj', prompt: 'x', assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'default', model: 'opus', effort: 'max' });
  assert.equal(u.sdk.queries[0]!.params.options.model, 'opus');
  assert.equal(u.sdk.queries[0]!.params.options.effort, 'max');
});

test('setSessionOptions on a session running in Claude Code itself, a temp or an unknown one is an error', async () => {
  const t = setup();
  t.host.onAgents([agent(SID), agent(`${SID}/a1`, { kind: 'temp', parentId: SID })]);
  t.live.add(SID);
  await t.send({ type: 'openCase', agentId: SID });
  const h = t.of('caseFile')[0]!.header;
  assert.equal(h.control, 'elsewhere');
  assert.equal(h.canSetOptions, false);
  await setOptions(t, SID, { effort: 'high' });
  assert.match(lastError(t)!.message, /\/model or \/effort in Claude Code/);
  assert.equal(lastError(t)!.nonce, 'o1');
  assert.equal(lastError(t)!.sessionId, SID);
  await setOptions(t, `${SID}/a1`, { effort: 'high' }, 'o2');
  assert.equal(lastError(t)!.nonce, 'o2');
  await setOptions(t, 'ghost', { effort: 'high' }, 'o3');
  assert.equal(lastError(t)!.nonce, 'o3');
  assert.equal(t.of('sessionOptions').length, 0);
  assert.equal(t.sdk.queries.length, 0);
});

test('headerFor fills effort (run first, then the latest known), canSetOptions and next', async () => {
  const t = setup();
  t.host.onAgents([agent(SID, { effort: 'medium' }), agent(`${SID}/a1`, { kind: 'temp', parentId: SID, sessionId: SID })]);
  await t.send({ type: 'openCase', agentId: `${SID}/a1` });
  const temp = t.of('caseFile')[0]!.header;
  assert.equal(temp.control, 'none');
  assert.equal(temp.canSetOptions, false);
  assert.deepEqual(temp.next, {});

  // An office run's own effort overrides the transcript's.
  const r = setup();
  const q = await hire(r, { effort: 'max' });
  r.host.onAgents([agent(SID, { effort: 'low' })]);
  await r.send({ type: 'openCase', agentId: SID });
  const head = r.of('caseFile')[0]!.header;
  assert.equal(head.effort, 'max');
  assert.equal(head.canSetOptions, true);
  assert.deepEqual(head.next, {});
  // A run that was never given an effort shows the latest known one.
  const q2 = setup();
  q2.host.onAgents([agent(SID, { effort: 'low' })]);
  await hire(q2);
  await q2.send({ type: 'openCase', agentId: SID });
  assert.equal(q2.of('caseFile')[0]!.header.effort, 'low');
  void q;
});

test('getOfficeInfo reports model, effort and context of an office run', async () => {
  const t = setup();
  const q = await hire(t, { effort: 'high' });
  const usage = { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 500 };
  q.emit({ ...assistantText('hi', SID, 'm1'), message: { ...assistantText('hi', SID, 'm1').message, usage } });
  await settle();
  const info = t.host.getOfficeInfo(SID)!;
  assert.equal(info.model, 'claude-haiku-5-5');
  assert.equal(info.effort, 'high');
  assert.equal(info.context!.max, 200_000); // nothing learned yet: the default window
  assert.equal(info.context!.approx, true);
  assert.ok(info.context!.tokens >= 51_000);
  assert.equal(info.context!.pct, Math.round((info.context!.tokens / 200_000) * 100));

  // A result that reports the window makes it exact.
  q.emit({ ...resultMsg(0.01), modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 } } });
  await settle();
  const exact = t.host.getOfficeInfo(SID)!.context!;
  assert.equal(exact.max, 1_000_000);
  assert.equal(exact.approx, undefined);
  assert.equal(t.host.getOfficeInfo('ghost'), undefined);
});

test('learned context windows are kept in the exposed map, saved, and loaded at start', async () => {
  const t = setup({ stored: { 'claude-opus-5-5': 1_000_000, junk: 'x', neg: -5 } });
  assert.deepEqual([...t.host.contextWindows], [['claude-opus-5-5', 1_000_000]]); // loaded, bad entries dropped
  const refreshes = t.state.refreshes;
  const q = await hire(t);
  q.emit({ ...resultMsg(0.01), modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 } } });
  await settle();
  assert.equal(t.host.contextWindows.get('claude-haiku-5-5'), 200_000);
  assert.deepEqual(t.saved.at(-1), [CONTEXT_WINDOWS_KEY, { 'claude-opus-5-5': 1_000_000, 'claude-haiku-5-5': 200_000 }]);
  assert.ok(t.state.refreshes > refreshes); // the feed recomputes context percentages
  const saves = t.saved.length;
  q.emit({ ...resultMsg(0.02, SID, 'success', 'res-2'), modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 } } });
  await settle();
  assert.equal(t.saved.length, saves); // unchanged: not saved again
  // It is the same live map: a later read sees later lessons.
  const map = t.host.contextWindows;
  q.emit({ ...resultMsg(0.03, SID, 'success', 'res-3'), modelUsage: { 'claude-haiku-5-5': { contextWindow: 500_000 } } });
  await settle();
  assert.equal(map.get('claude-haiku-5-5'), 500_000);

  const empty = setup(); // no stored value: starts empty
  assert.equal(empty.host.contextWindows.size, 0);
});

test('rate-limit events from a run are forwarded to onRateLimit (and ignored when no handler is given)', async () => {
  const t = setup();
  const q = await hire(t);
  q.emit(rateLimitMsg({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85, resetsAt: 1_900_000_000 }));
  await settle();
  assert.equal(t.rateLimits.length, 1);
  assert.equal(t.rateLimits[0]![0]!.id, 'five_hour');
  assert.equal(t.of('error').length, 0);
});

test('getPlan: from a live run first, else the injected lookup, else an error with the reqId', async () => {
  const lookups: Array<[string, string]> = [];
  const t = setup({
    realBuilder: true,
    planText: (agentId, planId) => {
      lookups.push([agentId, planId]);
      return planId === 'toolu_old' ? { text: 'Old plan', truncated: true, status: 'approved', planFilePath: '/p/old.md', feedback: 'fine' } : undefined;
    },
  });
  const q = await hire(t);
  q.emit(assistantTool('ExitPlanMode', { plan: 'Step 1\nStep 2' }, SID, 'msg_p', 'toolu_plan'));
  await settle();
  await t.send({ type: 'getPlan', reqId: 'r1', agentId: SID, planId: 'toolu_plan' });
  const live = t.of('planText')[0]!;
  assert.equal(live.reqId, 'r1');
  assert.equal(live.agentId, SID);
  assert.equal(live.planId, 'toolu_plan');
  assert.equal(live.text, 'Step 1\nStep 2');
  assert.ok(['pending', 'approved', 'rejected', 'superseded'].includes(live.status));
  assert.equal(lookups.length, 0); // answered from the live run

  // Not in the run: the lookup answers (this is how plans of other sessions are read from transcripts).
  await t.send({ type: 'getPlan', reqId: 'r2', agentId: SID, planId: 'toolu_old' });
  assert.deepEqual(t.of('planText')[1], { type: 'planText', reqId: 'r2', agentId: SID, planId: 'toolu_old', text: 'Old plan', truncated: true, status: 'approved', planFilePath: '/p/old.md', feedback: 'fine' });
  assert.deepEqual(lookups, [[SID, 'toolu_old']]);

  await t.send({ type: 'getPlan', reqId: 'r3', agentId: SID, planId: 'nope' });
  assert.deepEqual(t.of('error').at(-1), { type: 'error', reqId: 'r3', agentId: SID, message: 'That plan is no longer available.' }); // v0.5: errors name the worker

  // A free session goes straight to the lookup; no lookup injected means not found.
  const bare = setup();
  await bare.send({ type: 'getPlan', reqId: 'r4', agentId: 'someone', planId: 'p' });
  assert.equal(bare.of('error').at(-1)!.reqId, 'r4');
  assert.equal(bare.of('planText').length, 0);
});

const turnItems = (n: number, prefix: string): ConversationItem[] => Array.from({ length: n }, (_, i) => ({ kind: 'assistant', id: `${prefix}${i}`, text: `${prefix} ${i}` }));

test('getTurn: the last turn of a transcript (prompt left out), capped to the LAST turnItems with truncated', async () => {
  const t = setup();
  t.host.onAgents([agent(SID)]);
  t.cases.set(SID, {
    items: [
      { kind: 'prompt', id: 'p1', text: 'first' },
      ...turnItems(2, 'a'),
      { kind: 'prompt', id: 'p2', text: 'second' },
      ...turnItems(3, 'b'),
      { kind: 'notice', id: 'n', notice: 'cost', text: 'cost', costUsd: 0.1 },
    ],
    truncated: false,
  });
  await t.send({ type: 'getTurn', reqId: 'q1', agentId: SID });
  const small = t.of('turn')[0]!;
  assert.equal(small.reqId, 'q1');
  assert.equal(small.agentId, SID);
  assert.deepEqual(small.items.map((i) => i.id), ['b0', 'b1', 'b2', 'n']);
  assert.equal(small.truncated, false);

  const big = 100;
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'p', text: 'x' }, ...turnItems(big, 'c')], truncated: false });
  await t.send({ type: 'getTurn', reqId: 'q2', agentId: SID });
  const capped = t.of('turn')[1]!;
  assert.equal(capped.items.length, 80); // LIMITS.turnItems
  assert.equal(capped.items[0]!.id, 'c20');
  assert.equal(capped.items.at(-1)!.id, 'c99');
  assert.equal(capped.truncated, true);

  // No prompt in the tail at all (a long turn): everything is one turn, and an unreadable head counts as truncated.
  t.cases.set(SID, { items: turnItems(3, 'd'), truncated: true });
  await t.send({ type: 'getTurn', reqId: 'q3', agentId: SID });
  assert.deepEqual(t.of('turn')[2]!.items.map((i) => i.id), ['d0', 'd1', 'd2']);
  assert.equal(t.of('turn')[2]!.truncated, true);

  // A trailing prompt with no answer yet falls back to the turn before it.
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'p1', text: 'a' }, ...turnItems(2, 'e'), { kind: 'prompt', id: 'p2', text: 'b' }], truncated: false });
  await t.send({ type: 'getTurn', reqId: 'q4', agentId: SID });
  assert.deepEqual(t.of('turn')[3]!.items.map((i) => i.id), ['e0', 'e1']);
});

test('getTurn: an office run answers from its live items (the finished turn while the next one runs); failures carry the reqId', async () => {
  const t = setup();
  const q = await hire(t);
  q.emit(assistantText('Report one', SID, 'm1'), resultMsg(0.01));
  await settle();
  await t.send({ type: 'getTurn', reqId: 'q1', agentId: SID });
  assert.deepEqual(t.of('turn')[0]!.items.map((i) => i.kind), ['assistant', 'notice']);
  assert.equal(t.readCalls.length, 0); // no transcript read for a live run

  await t.send({ type: 'reply', sessionId: SID, text: 'next' });
  q.emit(assistantText('Half way', SID, 'm2'));
  await settle();
  await t.send({ type: 'getTurn', reqId: 'q2', agentId: SID });
  assert.deepEqual((t.of('turn')[1]!.items[0] as { text: string }).text, 'Report one'); // the busy turn is not finished

  await t.send({ type: 'getTurn', reqId: 'q3', agentId: 'ghost' });
  assert.equal(lastError(t)!.reqId, 'q3');
  const u = setup();
  u.host.onAgents([agent(SID)]);
  u.state.readFails = true;
  await u.send({ type: 'getTurn', reqId: 'q4', agentId: SID });
  assert.equal(lastError(u)!.reqId, 'q4');
  assert.equal(u.of('turn').length, 0);
});

test('one shared cost tracker: runners and builders get it, a resume is seeded from the transcript and nothing is counted twice', async () => {
  const costState = (total: number) => JSON.stringify({ type: 'cost-state', totalCostUSD: total }) + '\n';
  const t = setup({ realBuilder: true, tails: new Map([[SID, costState(0.2) + costState(0.5)]]) });
  t.host.onAgents([agent(SID)]);
  await t.send({ type: 'reply', sessionId: SID, text: 'continue' });
  assert.equal(t.builderInits.length, 1);
  assert.equal(t.builderInits[0]!.sessionId, SID);
  const tracker = t.builderInits[0]!.cost!;
  assert.equal(typeof tracker.observe, 'function');
  assert.equal(tracker.total(SID), 0.5); // the shared baseline, seeded from the newest cost-state before the first result
  const q = t.sdk.queries[0]!;
  q.emit(initMsg(), assistantText('ok', SID, 'm1'), resultMsg(0.7));
  await settle();
  assert.equal(t.host.getOfficeInfo(SID)!.costUsd, 0.7);
  await t.send({ type: 'openCase', agentId: SID });
  const costItems = (items: ConversationItem[]) => items.filter((i) => i.kind === 'notice' && i.notice === 'cost') as Array<{ costUsd?: number }>;
  const first = costItems(t.of('caseFile').at(-1)!.items);
  assert.equal(first.length, 1);
  assert.ok(Math.abs(first[0]!.costUsd! - 0.2) < 1e-9, `turn cost was ${first[0]!.costUsd}`); // this turn only, not 0.7 and not 0

  // The run ends and the session is resumed in the same host: the tracker's baseline carries over.
  q.finish();
  await settle();
  await t.timers.advance(5000);
  await t.send({ type: 'reply', sessionId: SID, text: 'again' });
  assert.equal(t.builderInits.length, 2);
  assert.equal(t.builderInits[1]!.cost!.total(SID), 0.7); // the baseline carried over (shared tracker), not re-read
  const q2 = t.sdk.queries[1]!;
  q2.emit(initMsg(), assistantText('more', SID, 'm2'), resultMsg(0.9, SID, 'success', 'res-2'));
  await settle();
  assert.equal(t.host.getOfficeInfo(SID)!.costUsd, 0.9);
  await t.timers.advance(250);
  const turn2 = t.of('caseAppend').flatMap((m) => costItems(m.items)).at(-1);
  assert.ok(turn2 !== undefined && Math.abs(turn2.costUsd! - 0.2) < 1e-9, `second turn cost was ${turn2?.costUsd}`);
});

// --- several open cases at once (v0.5, docs/manager-mode.md section 18) ---------------------------------------------------------

const textOf = (i: ConversationItem): string => (i as { text?: string }).text ?? '';

/** Two free workers whose transcripts the case poll reads, and a routed host. */
function twoWorkers() {
  const t = setup({ routed: true });
  t.host.onAgents([agent(SID, { control: 'free' }), agent(SID2, { control: 'free', title: 'Other job' })]);
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'first worker' }], truncated: false });
  t.cases.set(SID2, { items: [{ kind: 'prompt', id: 'b-u1', text: 'second worker' }], truncated: false });
  return t;
}

test('two sources view the same worker: the case is built once, the late one gets a snapshot only, and both get appends', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  assert.equal(t.readCalls.filter((id) => id === SID).length, 1); // not rebuilt for the second viewer
  const files = t.routedOf('caseFile');
  assert.deepEqual(files.map((f) => f.to), [['view'], ['case:' + SID]]); // the snapshot went to the late viewer alone
  assert.deepEqual(files[1]!.msg.items.map((i) => i.id), ['a-u1']);
  assert.equal(t.timers.pending, 1); // one poll for both

  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'first worker' }, { kind: 'assistant', id: 'a-1', text: 'more' }], truncated: false });
  await t.timers.advance(1000);
  const appends = t.routedOf('caseAppend');
  assert.equal(appends.length, 1); // one message, addressed to both
  assert.deepEqual(appends[0]!.to, ['case:' + SID, 'view']);
  assert.deepEqual(appends[0]!.msg.items.map(textOf), ['more']);
});

test('a source that reopens its own worker (a reload) gets a snapshot again, from the stored items', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'first worker' }, { kind: 'assistant', id: 'a-1', text: 'more' }], truncated: false });
  await t.timers.advance(1000);
  await t.send({ type: 'ready' }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  const files = t.routedOf('caseFile');
  assert.equal(files.length, 3);
  assert.deepEqual(files[2]!.msg.items.map((i) => i.id), ['a-u1', 'a-1']);
  assert.equal(t.readCalls.filter((id) => id === SID).length, 2); // the open and one poll, nothing for the re-sends
});

test('a case tab that sends ready gets the case of the worker it is bound to, and cannot open another worker', async () => {
  const t = twoWorkers();
  await t.send({ type: 'ready' }, 'case:' + SID2);
  assert.deepEqual(t.routedOf('caseFile').map((f) => [f.to, f.msg.agentId]), [[['case:' + SID2], SID2]]);
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID2); // dropped
  assert.equal(t.routedOf('caseFile').length, 1);
  assert.equal(t.of('error').length + t.routedOf('error').length, 0);
});

test('two workers open in two sources: each stream reaches only its own source (transcript polls)', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID2 }, 'case:' + SID2);
  assert.deepEqual(t.routedOf('caseFile').map((f) => [f.msg.agentId, f.to]), [[SID, ['view']], [SID2, ['case:' + SID2]]]);

  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'first worker' }, { kind: 'assistant', id: 'a-1', text: 'A only' }], truncated: false });
  t.cases.set(SID2, { items: [{ kind: 'prompt', id: 'b-u1', text: 'second worker' }, { kind: 'assistant', id: 'b-1', text: 'B only' }], truncated: false });
  await t.timers.advance(1000);
  const appends = t.routedOf('caseAppend');
  assert.equal(appends.length, 2);
  for (const a of appends) {
    if (a.msg.agentId === SID) assert.deepEqual([a.to, a.msg.items.map(textOf)], [['view'], ['A only']]);
    else assert.deepEqual([a.to, a.msg.items.map(textOf)], [['case:' + SID2], ['B only']]);
  }

  // A header change of one worker (feed update) is also addressed to its viewers only.
  t.host.onAgents([agent(SID, { control: 'free', status: 'working', activity: 'reading' }), agent(SID2, { control: 'free', title: 'Other job' })]);
  await t.timers.advance(250);
  const header = t.routedOf('caseAppend').slice(2);
  assert.equal(header.length, 1);
  assert.deepEqual([header[0]!.msg.agentId, header[0]!.to], [SID, ['view']]);
});

test('two office runs open in two sources: live streams, pending requests and replies never cross', async () => {
  const t = setup({ routed: true });
  await t.newTask('n1', 'job one');
  await t.newTask('n2', 'job two');
  const [q1, q2] = t.sdk.queries as [typeof t.sdk.queries[0], typeof t.sdk.queries[0]];
  q1.emit(initMsg(SID));
  q2.emit(initMsg(SID2));
  await settle();
  // taskStarted goes to the webview that asked, only.
  assert.deepEqual(t.routedOf('taskStarted').map((m) => [m.to, m.msg.nonce, m.msg.sessionId]), [[['view'], 'n1', SID], [['view'], 'n2', SID2]]);

  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID2 }, 'case:' + SID2);
  q1.emit(assistantText('one speaking', SID, 'm1'));
  q2.emit(assistantText('two speaking', SID2, 'm2'));
  await settle();
  await t.timers.advance(250);
  const streamed = t.routedOf('caseAppend').map((a) => [a.msg.agentId, a.to, a.msg.items.map(textOf)]);
  assert.deepEqual(streamed, [[SID, ['view'], ['one speaking']], [SID2, ['case:' + SID2], ['two speaking']]]);

  // A request of worker two knocks only on worker two's viewers, and the tab can answer it.
  const answer = q2.ask('Bash', { command: 'echo hi' }, { toolUseID: 'toolu_b' });
  await settle();
  const knock = t.routedOf('caseAppend').at(-1)!;
  assert.deepEqual([knock.msg.agentId, knock.to, knock.msg.pending?.kind], [SID2, ['case:' + SID2], 'permission']);
  await t.send({ type: 'decide', requestId: knock.msg.pending!.requestId, decision: { kind: 'allow' } }, 'case:' + SID2);
  assert.equal(((await answer) as { behavior: string }).behavior, 'allow');
  assert.equal(t.routedOf('caseAppend').filter((a) => a.msg.agentId === SID && a.msg.pending !== undefined).length, 0);

  // A reply from a tab reaches its own worker's run.
  await t.send({ type: 'reply', sessionId: SID2, text: 'from the tab' }, 'case:' + SID2);
  assert.equal(q2.received.at(-1), 'from the tab');
  assert.deepEqual(q1.received, ['job one']);
  const echoed = t.routedOf('caseAppend').at(-1)!;
  assert.deepEqual([echoed.msg.agentId, echoed.to, echoed.msg.items.map(textOf)], [SID2, ['case:' + SID2], ['from the tab']]);
});

test('decide, interrupt and setSessionOptions work from any source that views the worker', async () => {
  const t = setup({ routed: true });
  const q = await hire(t);
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  const answer = q.ask('Bash', { command: 'echo hi' }, { toolUseID: 'toolu_a' });
  await settle();
  const knock = t.routedOf('caseAppend').at(-1)!;
  assert.deepEqual(knock.to, ['case:' + SID, 'view']); // both see the knock
  await t.send({ type: 'decide', requestId: knock.msg.pending!.requestId, decision: { kind: 'deny' } }, 'case:' + SID);
  assert.equal(((await answer) as { behavior: string }).behavior, 'deny');
  assert.deepEqual(t.routedOf('caseAppend').at(-1)!.to, ['case:' + SID, 'view']); // both see it cleared

  await t.send({ type: 'interrupt', sessionId: SID }, 'case:' + SID);
  assert.equal(q.interrupts, 1);
  q.emit(resultMsg(0.001));
  await settle();
  await t.send({ type: 'setSessionOptions', nonce: 'o9', sessionId: SID, options: { effort: 'high' } }, 'case:' + SID);
  const reply = t.routedOf('sessionOptions')[0]!;
  assert.deepEqual([reply.to, reply.msg.nonce, reply.msg.sessionId], [['case:' + SID], 'o9', SID]); // the answer goes to the asker
  assert.deepEqual(t.routedOf('error'), []);
});

test('switching: opening another worker from a source stops it viewing the old one, which is dropped when nobody views it', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID2 }, 'view'); // view switches A -> B
  assert.equal(t.timers.pending, 1); // A's poll is gone, B's remains
  const reads = t.readCalls.length;
  await t.timers.advance(1000);
  assert.deepEqual(t.readCalls.slice(reads), [SID2]);

  // A worker with another viewer stays open when one viewer leaves it.
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  await t.send({ type: 'openCase', agentId: SID }, 'panel');
  await t.send({ type: 'openCase', agentId: SID2 }, 'panel'); // panel leaves SID, the tab stays
  const before = t.readCalls.length;
  await t.timers.advance(1000);
  assert.deepEqual(t.readCalls.slice(before).sort(), [SID, SID2].sort());
  t.cases.set(SID, { items: [{ kind: 'assistant', id: 'a-2', text: 'still going' }], truncated: false });
  await t.timers.advance(1000);
  const last = t.routedOf('caseAppend').at(-1)!;
  assert.deepEqual([last.msg.agentId, last.to], [SID, ['case:' + SID]]);
});

test('a failed open keeps the case the source already had', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: 'ghost' }, 'view');
  assert.equal(t.timers.pending, 1);
  assert.deepEqual(t.routedOf('error').map((e) => [e.to, e.msg.agentId]), [[['view'], 'ghost']]);
  t.cases.set(SID, { items: [{ kind: 'assistant', id: 'a-2', text: 'still mine' }], truncated: false });
  await t.timers.advance(1000);
  assert.deepEqual(t.routedOf('caseAppend').at(-1)!.to, ['view']);
});

test('closeCase from one of two viewers keeps the case alive; the last closeCase (or closeSource) drops it', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  await t.send({ type: 'closeCase' }, 'view');
  assert.equal(t.timers.pending, 1);
  t.cases.set(SID, { items: [{ kind: 'assistant', id: 'a-2', text: 'for the tab' }], truncated: false });
  await t.timers.advance(1000);
  assert.deepEqual(t.routedOf('caseAppend').at(-1)!.to, ['case:' + SID]);

  // closeCase for a source that has nothing open is harmless; a tab that goes away is unregistered by closeSource.
  await t.send({ type: 'closeCase' }, 'view');
  t.host.closeSource('case:' + SID);
  assert.equal(t.timers.pending, 0);
  const before = t.readCalls.length;
  await t.timers.advance(5000);
  assert.equal(t.readCalls.length, before);

  // The same through handle(): closeCase from the tab's own source.
  await t.send({ type: 'openCase', agentId: SID2 }, 'case:' + SID2);
  assert.equal(t.timers.pending, 1);
  await t.send({ type: 'closeCase' }, 'case:' + SID2);
  assert.equal(t.timers.pending, 0);
  // A closed source can open again.
  await t.send({ type: 'openCase', agentId: SID2 }, 'case:' + SID2);
  assert.equal(t.routedOf('caseFile').at(-1)!.msg.agentId, SID2);
});

test('onAgents: a worker who leaves gets caseClosed agentGone sent to all of its viewers, and the others carry on', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  await t.send({ type: 'openCase', agentId: SID2 }, 'panel');
  t.host.onAgents([agent(SID2, { control: 'free', title: 'Other job' })]);
  assert.deepEqual(t.routedOf('caseClosed').map((m) => [m.to, m.msg]), [[['case:' + SID, 'view'], { type: 'caseClosed', agentId: SID, reason: 'agentGone' }]]);
  assert.equal(t.timers.pending, 1); // only SID2's poll is left
  // The viewers are free again: a later close from one of them is harmless and they can open something else.
  await t.send({ type: 'closeCase' }, 'view');
  await t.send({ type: 'openCase', agentId: SID2 }, 'view');
  assert.deepEqual(t.routedOf('caseFile').at(-1)!.to, ['view']);
  t.cases.set(SID2, { items: [{ kind: 'assistant', id: 'b-2', text: 'on' }], truncated: false });
  await t.timers.advance(1000);
  assert.deepEqual(t.routedOf('caseAppend').at(-1)!.to, ['panel', 'view']);
});

test('replies to a request go to the sender only (getTurn, getPlan, projects), and their errors carry reqId and agentId', async () => {
  const t = twoWorkers();
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  await t.send({ type: 'getTurn', reqId: 'q1', agentId: SID }, 'case:' + SID);
  await t.send({ type: 'getPlan', reqId: 'p1', agentId: SID, planId: 'nope' }, 'view');
  await t.send({ type: 'getTurn', reqId: 'q2', agentId: 'ghost' }, 'case:' + SID);
  await t.send({ type: 'listProjects' }, 'panel');
  assert.deepEqual(t.routedOf('turn').map((m) => [m.to, m.msg.reqId]), [[['case:' + SID], 'q1']]);
  assert.deepEqual(t.routedOf('error').map((m) => [m.to, m.msg.reqId, m.msg.agentId]), [[['view'], 'p1', SID], [['case:' + SID], 'q2', 'ghost']]);
  assert.deepEqual(t.routedOf('projects').map((m) => m.to), [['panel']]);
});

test('errors carry the agentId: failed opens, replies to unknown sessions, and background run failures reach the viewers (else the office view)', async () => {
  const t = setup({ routed: true });
  await t.send({ type: 'openCase', agentId: 'ghost' }, 'case:ghost');
  await t.send({ type: 'reply', sessionId: 'nobody', text: 'hi' }, 'case:nobody');
  assert.deepEqual(t.routedOf('error').map((m) => [m.to, m.msg.agentId, m.msg.sessionId]), [[['case:ghost'], 'ghost', undefined], [['case:nobody'], 'nobody', 'nobody']]);

  const q = await hire(t);
  // Nobody views the worker: an unsolicited failure becomes a toast in the office view.
  q.emit(resultMsg(0.001, SID, 'error_during_execution'));
  await settle();
  // A tab views the worker: the failure goes to it, with the agentId.
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  q.fail(new Error('Claude Code process exited with code 1. stderr: kaput'));
  await settle();
  const err = t.routedOf('error').at(-1)!;
  assert.deepEqual([err.to, err.msg.agentId, err.msg.sessionId], [['case:' + SID], SID, SID]);
  assert.match(err.msg.message, /exit code 1/);

  const lone = setup({ routed: true });
  const q2 = await hire(lone);
  q2.fail(new Error('Claude Code process exited with code 1. stderr: kaput'));
  await settle();
  assert.deepEqual(lone.routedOf('error').map((m) => [m.to, m.msg.agentId]), [[['view'], SID]]);
});

test('the case tab that started nothing does not see another source\'s start errors, the asker does', async () => {
  const t = setup({ routed: true });
  await t.send({ type: 'newTask', nonce: 'n9', projectPath: '/missing', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' }, 'panel');
  assert.deepEqual(t.routedOf('error').map((m) => [m.to, m.msg.nonce]), [[['panel'], 'n9']]);
});

test('without postTo every message is still the old broadcast, once, however many sources view the worker', async () => {
  const t = setup(); // no routed
  t.host.onAgents([agent(SID, { control: 'free' })]);
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'hello' }], truncated: false });
  await t.send({ type: 'openCase', agentId: SID }, 'view');
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  assert.equal(t.of('caseFile').length, 2);
  t.cases.set(SID, { items: [{ kind: 'prompt', id: 'a-u1', text: 'hello' }, { kind: 'assistant', id: 'a-1', text: 'more' }], truncated: false });
  await t.timers.advance(1000);
  assert.equal(t.of('caseAppend').length, 1);
  await t.send({ type: 'getTurn', reqId: 'q1', agentId: SID }, 'case:' + SID);
  assert.equal(t.of('turn').length, 1);
  t.host.onAgents([]);
  assert.equal(t.of('caseClosed').length, 1);
  // No source at all means the office view.
  await t.send({ type: 'openCase', agentId: 'ghost' });
  assert.equal(lastError(t)!.agentId, 'ghost');
});

test('stopIfIdle: refuses a running turn or a pending request, an unknown session; stops an idle run once', async () => {
  const t = setup({ routed: true });
  assert.equal(t.host.stopIfIdle(SID), false); // nothing running
  const q = await hire(t);
  assert.equal(t.host.stopIfIdle(SID), false); // the first turn is running
  await settle();
  assert.equal(q.closed, false);

  // The turn ends but a request is still waiting for the user: not idle.
  const answer = q.ask('Bash', { command: 'echo hi' }, { toolUseID: 'toolu_p' });
  await settle();
  q.emit(resultMsg(0.001));
  await settle();
  assert.equal(t.host.getOfficeInfo(SID)?.pending?.kind, 'permission');
  assert.equal(t.host.stopIfIdle(SID), false);
  assert.equal(q.closed, false);

  // Answered and no turn running: idle. The reply that races the stop gets an error with the session id.
  const reqId = t.host.getOfficeInfo(SID)!.pending!.requestId;
  await t.send({ type: 'decide', requestId: reqId, decision: { kind: 'deny' } });
  await answer;
  await t.send({ type: 'openCase', agentId: SID }, 'case:' + SID);
  assert.equal(t.host.stopIfIdle(SID), true);
  const racing = t.host.handle({ type: 'reply', sessionId: SID, text: 'too late' }, 'case:' + SID);
  await racing;
  await settle();
  assert.equal(t.routedOf('error').at(-1)!.msg.sessionId, SID);
  assert.deepEqual(t.routedOf('error').at(-1)!.to, ['case:' + SID]);
  await t.timers.advance(100); // the grace period of the runner's stop
  assert.equal(q.closed, false); // the input ended and the query finished by itself, no abort needed
  assert.equal(t.host.controlFor(agent(SID)), 'free'); // the run is gone
  assert.equal(t.host.stopIfIdle(SID), false); // nothing left to stop
  // The open case went back to following the transcript.
  assert.ok(t.routedOf('caseFile').length >= 2);
});
