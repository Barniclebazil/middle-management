import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRegistry } from '../src/manager/pending.ts';
import { InputQueue, SessionRunner, UnsupportedControlError, buildRunnerEnv, describeRunnerError, normaliseRateLimit } from '../src/manager/sessionRunner.ts';
import type { ControlMethod, QueryFn, RunnerListener, RunnerState, StartParams } from '../src/manager/sessionRunner.ts';
import { createCostTracker } from '../src/manager/cost.ts';
import type { UsageWindow } from '../src/shared/protocol.ts';
import { FakeQuery, SID, assistantText, fakeSdk, initMsg, rateLimitMsg, resultMsg, settle, statusMsg } from './manager-fakes.ts';

interface Rig {
  runner: SessionRunner;
  registry: PendingRegistry;
  sdk: ReturnType<typeof fakeSdk>;
  log: {
    sessionIds: string[];
    messages: Array<{ type: string }>;
    states: Array<{ state: RunnerState; changed: string[] }>;
    results: Array<{ subtype: string; turnCostUsd: number; totalCostUsd: number }>;
    rateLimits: UsageWindow[][];
    windows: Array<[string, number]>;
    notices: Array<{ kind: string; message: string }>;
    ends: Array<{ reason: string; message?: string }>;
  };
  q: () => FakeQuery;
}

const START: StartParams = { cwd: '/proj', prompt: 'Do the thing', permissionMode: 'default', binaryPath: '/bin/claude' };

function rig(opts: { queryFn?: QueryFn; graceMs?: number; env?: Record<string, string | undefined>; initialCostUsd?: number; omit?: readonly ControlMethod[] } = {}): Rig {
  const sdk = fakeSdk(opts.omit !== undefined ? { omit: opts.omit } : {});
  const registry = new PendingRegistry();
  const log: Rig['log'] = { sessionIds: [], messages: [], states: [], results: [], rateLimits: [], windows: [], notices: [], ends: [] };
  const listener: RunnerListener = {
    onSessionId: (id) => log.sessionIds.push(id),
    onMessage: (m) => log.messages.push({ type: (m as { type: string }).type }),
    onState: (state, changed) => log.states.push({ state, changed: [...changed] }),
    onResult: (r) => log.results.push(r),
    onRateLimit: (w) => log.rateLimits.push(w),
    onContextWindow: (m, w) => log.windows.push([m, w]),
    onNotice: (n) => log.notices.push(n),
    onEnd: (e) => log.ends.push(e),
  };
  const runner = new SessionRunner({
    queryFn: opts.queryFn ?? sdk.queryFn,
    pending: registry,
    listener,
    graceMs: opts.graceMs ?? 20,
    now: () => 1_700_000_000_000,
    env: opts.env ?? { PATH: '/usr/bin', HOME: '/home/me' },
    ...(opts.initialCostUsd !== undefined ? { initialCostUsd: opts.initialCostUsd } : {}),
  });
  return { runner, registry, sdk, log, q: () => sdk.queries[0]! };
}

test('InputQueue hands out queued messages in order and ends cleanly', async () => {
  const q = new InputQueue();
  q.push('one');
  q.push('two');
  const it = q[Symbol.asyncIterator]();
  assert.equal((await it.next()).value?.message.content, 'one');
  const pending = it.next(); // waits
  q.push('two-b');
  assert.equal((await pending).value?.message.content, 'two');
  assert.equal((await it.next()).value?.message.content, 'two-b');
  const waiting = it.next();
  q.end();
  assert.equal((await waiting).done, true);
  assert.equal(q.push('late'), false);
});

test('query options: explicit mode, settings sources, partials, binary, env tag, abort controller, canUseTool', () => {
  const r = rig({ env: { PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_PID: '9', CLAUDE_AGENT_SDK_VERSION: '0.0.1' } });
  r.runner.start({ ...START, permissionMode: 'plan', model: 'haiku' });
  const o = r.q().params.options;
  assert.equal(o.cwd, '/proj');
  assert.equal(o.pathToClaudeCodeExecutable, '/bin/claude');
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.permissionMode, 'plan');
  assert.equal(o.model, 'haiku');
  assert.equal(o.includePartialMessages, true);
  assert.equal(typeof o.canUseTool, 'function');
  assert.ok(o.abortController instanceof AbortController);
  assert.equal(o.resume, undefined);
  assert.ok(!('allowDangerouslySkipPermissions' in o));
  assert.notEqual(o.permissionMode, 'bypassPermissions');
  assert.ok(!('maxBudgetUsd' in o) && !('maxTurns' in o));
  const env = o.env as Record<string, string | undefined>;
  assert.equal(env['CLAUDE_CODE_ENTRYPOINT'], 'claude-office');
  assert.equal(env['PATH'], '/usr/bin'); // spread, not replaced
  assert.equal(env['CLAUDE_CODE_USE_BEDROCK'], '1'); // user configuration survives
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION']) assert.ok(!(k in env), k);
});

test('model and resume are omitted unless given; resume is passed through', () => {
  const r = rig();
  r.runner.start({ ...START, resume: SID });
  const o = r.q().params.options;
  assert.ok(!('model' in o));
  assert.equal(o.resume, SID);
});

test('buildRunnerEnv does not mutate its input', () => {
  const base = { A: '1', CLAUDECODE: '1' };
  const out = buildRunnerEnv(base);
  assert.equal(base.CLAUDECODE, '1');
  assert.equal(out['CLAUDECODE'], undefined);
  assert.equal(out['A'], '1');
});

test('the first prompt is the first input message', async () => {
  const r = rig();
  r.runner.start(START);
  await settle();
  assert.deepEqual(r.q().received, ['Do the thing']);
});

test('session id is captured from the first message and reported once; busy, model and mode follow the stream', async () => {
  const r = rig();
  r.runner.start(START);
  assert.equal(r.runner.sessionId, undefined);
  assert.equal(r.runner.busy, true); // prompt sent, no result yet
  r.q().emit(initMsg(SID, { permissionMode: 'default' }), assistantText('Working on it'));
  await settle();
  assert.equal(r.runner.sessionId, SID);
  assert.deepEqual(r.log.sessionIds, [SID]);
  assert.equal(r.runner.model, 'claude-haiku-5-5');
  assert.equal(r.runner.permissionMode, 'default');
  assert.deepEqual(r.log.messages.map((m) => m.type), ['system', 'assistant']);
  assert.equal(r.runner.busy, true);

  r.q().emit(statusMsg('acceptEdits'));
  await settle();
  assert.equal(r.runner.permissionMode, 'acceptEdits');

  r.q().emit(resultMsg(0.0039));
  await settle();
  assert.equal(r.runner.busy, false);
  assert.deepEqual(r.log.sessionIds, [SID]);
  assert.deepEqual(r.log.results, [{ subtype: 'success', isError: false, turnCostUsd: 0.0039, totalCostUsd: 0.0039 }]);
});

test('the model is updated from assistant messages (plan mode may switch it)', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg(), { ...assistantText('plan'), message: { id: 'm', model: 'claude-sonnet-5-5', role: 'assistant', content: [] } });
  await settle();
  assert.equal(r.runner.model, 'claude-sonnet-5-5');
  // A subagent's message does not change it.
  r.q().emit({ ...assistantText('sub'), parent_tool_use_id: 'toolu_x', message: { id: 'm2', model: 'claude-haiku-5-5', role: 'assistant', content: [] } });
  await settle();
  assert.equal(r.runner.model, 'claude-sonnet-5-5');
});

test('cost follows the running total (total_cost_usd is cumulative); turn cost is the delta; queued sends keep busy until the last result', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg());
  await settle();
  assert.equal(r.runner.send('second'), true);
  await settle();
  assert.deepEqual(r.q().received, ['Do the thing', 'second']);
  r.q().emit(resultMsg(0.002, SID, 'success', 'r1'));
  await settle();
  assert.equal(r.runner.busy, true); // 'second' still outstanding
  assert.ok(Math.abs(r.runner.costUsd - 0.002) < 1e-9);
  r.q().emit(resultMsg(0.0053, SID, 'success', 'r2'));
  await settle();
  assert.equal(r.runner.busy, false);
  assert.ok(Math.abs(r.runner.costUsd - 0.0053) < 1e-9);
  assert.ok(Math.abs(r.log.results[0]!.turnCostUsd - 0.002) < 1e-9);
  assert.ok(Math.abs(r.log.results[1]!.turnCostUsd - 0.0033) < 1e-9);
  assert.ok(Math.abs(r.log.results[1]!.totalCostUsd - 0.0053) < 1e-9);
  const costChanges = r.log.states.filter((s) => s.changed.includes('costUsd'));
  assert.equal(costChanges.length, 2);
});

test('resume: initialCostUsd is only the baseline, so it is not added on top of the SDK total', async () => {
  const r = rig({ initialCostUsd: 1 });
  r.runner.start({ ...START, resume: SID });
  assert.equal(r.runner.costUsd, 1); // known before the first result
  r.q().emit(initMsg(), resultMsg(1.0084)); // the CLI restored the total and added this turn
  await settle();
  assert.ok(Math.abs(r.runner.costUsd - 1.0084) < 1e-9);
  assert.ok(Math.abs(r.log.results[0]!.turnCostUsd - 0.0084) < 1e-9);
  assert.ok(Math.abs(r.log.results[0]!.totalCostUsd - 1.0084) < 1e-9);
});

test('resume without any known prior cost counts the first total as one turn (documented fallback)', async () => {
  const r = rig();
  r.runner.start({ ...START, resume: SID });
  r.q().emit(initMsg(), resultMsg(0.5));
  await settle();
  assert.equal(r.runner.costUsd, 0.5);
});

test('a shared cost tracker keeps baselines across runners of the same session', async () => {
  const cost = createCostTracker();
  const sdk = fakeSdk();
  const mk = () => {
    const turns: number[] = [];
    const runner = new SessionRunner({ queryFn: sdk.queryFn, pending: new PendingRegistry(), cost, listener: { onResult: (x) => turns.push(x.turnCostUsd) }, graceMs: 20, env: {} });
    return { runner, turns };
  };
  const a = mk();
  a.runner.start(START);
  sdk.queries[0]!.emit(initMsg(), resultMsg(0.3));
  await settle();
  await a.runner.stop();
  const b = mk();
  b.runner.start({ ...START, resume: SID });
  sdk.queries[1]!.emit(initMsg(), resultMsg(0.35));
  await settle();
  assert.ok(Math.abs(b.turns[0]! - 0.05) < 1e-9);
  assert.ok(Math.abs(cost.sum() - 0.35) < 1e-9);
});

test('an idle runner goes busy again on send, and a non-success result still ends the turn', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg(), resultMsg(0.001));
  await settle();
  assert.equal(r.runner.busy, false);
  r.runner.send('again');
  assert.equal(r.runner.busy, true);
  r.q().emit(resultMsg(0.002, SID, 'error_during_execution', 'r2'));
  await settle();
  assert.equal(r.runner.busy, false);
  assert.equal(r.log.results[1]!.subtype, 'error_during_execution');
});

test('resume knows its session id at once and reports it without waiting for a message', async () => {
  const r = rig();
  r.runner.start({ ...START, resume: SID });
  assert.equal(r.runner.sessionId, SID);
  await settle();
  assert.deepEqual(r.log.sessionIds, [SID]);
});

test('canUseTool registers a pending request for the session and resolves on decide', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg());
  await settle();
  const answer = r.q().ask('Bash', { command: 'echo office-ok > marker.txt', description: 'Write marker' }, { toolUseID: 'toolu_01', suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  await settle();
  const [req] = r.registry.list(SID);
  assert.ok(req);
  assert.equal(req.kind, 'permission');
  assert.equal(req.sessionId, SID);
  assert.equal(req.requestId, `${SID}:toolu_01`);
  r.registry.decide(req.requestId, { kind: 'allow', always: true });
  const res = (await answer) as { behavior: string; updatedPermissions?: unknown[] };
  assert.equal(res.behavior, 'allow');
  assert.equal(res.updatedPermissions?.length, 1);
});

test('canUseTool called before the session id is known waits for it', async () => {
  const r = rig();
  r.runner.start(START);
  const answer = r.q().ask('Bash', { command: 'ls > x' }, { toolUseID: 't1' });
  await settle();
  assert.equal(r.registry.size, 0);
  r.q().emit(initMsg());
  await settle();
  assert.equal(r.registry.list(SID).length, 1);
  r.registry.cancelAll();
  await answer;
});

test('interrupt calls the SDK interrupt, cancels pending requests, and the session stays alive', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg());
  await settle();
  const answer = r.q().ask('Bash', { command: 'sleep 3 > x' }, { toolUseID: 't1' });
  await settle();
  assert.equal(r.registry.size, 1);
  await r.runner.interrupt();
  assert.equal(r.q().interrupts, 1);
  assert.equal(r.registry.size, 0);
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Interrupted', interrupt: true });
  // The SDK ends the turn with an error result; the query itself goes on.
  r.q().emit(resultMsg(0.001, SID, 'error_during_execution'));
  await settle();
  assert.equal(r.runner.busy, false);
  assert.equal(r.runner.ended, false);
  assert.equal(r.runner.send('next'), true);
  await settle();
  assert.deepEqual(r.q().received, ['Do the thing', 'next']);
});

test('interrupt on an idle runner with nothing pending does nothing', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg(), resultMsg(0.001));
  await settle();
  await r.runner.interrupt();
  assert.equal(r.q().interrupts, 0);
});

test('stop: cancels pending, ends input, the query finishes and the runner reports stopped', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg());
  await settle();
  const answer = r.q().ask('Bash', { command: 'x > y' }, { toolUseID: 't1' });
  await settle();
  await r.runner.stop();
  assert.equal(r.runner.ended, true);
  assert.equal(r.q().interrupts, 1); // it was busy
  assert.deepEqual(r.log.ends, [{ reason: 'stopped' }]);
  assert.equal(((await answer) as { behavior: string }).behavior, 'deny');
  assert.equal(r.q().closed, false); // no abort needed
  assert.equal(r.runner.send('too late'), false);
  assert.equal(r.runner.busy, false);
});

test('stop aborts and closes the query when it does not end on its own', async () => {
  let stuck: FakeQuery | undefined;
  const queryFn: QueryFn = (params) => {
    stuck = new FakeQuery(params);
    // Ignore the end of input: only close() finishes it.
    (stuck as unknown as { finish: () => void }).finish = () => undefined;
    const realClose = stuck.close.bind(stuck);
    stuck.close = () => {
      stuck!.closed = true;
      (FakeQuery.prototype as unknown as { finish: () => void }).finish.call(stuck);
      void realClose;
    };
    return stuck;
  };
  const r = rig({ queryFn, graceMs: 15 });
  r.runner.start(START);
  stuck!.emit(initMsg());
  await settle();
  await r.runner.stop();
  assert.equal(stuck!.closed, true);
  assert.equal(stuck!.params.options.abortController!.signal.aborted, true);
  assert.equal(r.runner.ended, true);
  assert.equal(r.log.ends.length, 1);
  assert.equal(r.log.ends[0]!.reason, 'stopped');
});

test('a query that finishes by itself reports finished', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg(), resultMsg(0.001));
  r.q().finish();
  await settle();
  assert.deepEqual(r.log.ends, [{ reason: 'finished' }]);
  assert.equal(r.runner.ended, true);
});

test('a missing binary (queryFn throws) becomes a notice and an end', async () => {
  const r = rig({ queryFn: () => { throw new ReferenceError('Claude Code native binary not found at /bin/claude. Please ...'); } });
  r.runner.start(START);
  await settle();
  assert.equal(r.log.notices.length, 1);
  assert.equal(r.log.notices[0]!.kind, 'binary');
  assert.match(r.log.notices[0]!.message, /claudeOffice\.claudePath/);
  assert.equal(r.log.ends.length, 1);
  assert.equal(r.log.ends[0]!.reason, 'error');
  assert.equal(r.runner.ended, true);
});

test('a process exit becomes an exit notice', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg());
  await settle();
  r.q().fail(new Error('Claude Code process exited with code 1. stderr: something broke'));
  await settle();
  assert.equal(r.log.notices[0]!.kind, 'exit');
  assert.match(r.log.notices[0]!.message, /exit code 1/);
  assert.equal(r.log.ends[0]!.reason, 'error');
});

test('auth failures become an auth notice, from an exit error or from an assistant message', async () => {
  const r = rig();
  r.runner.start(START);
  r.q().emit(initMsg(), { ...assistantText('Invalid API key'), error: 'authentication_failed' });
  await settle();
  assert.equal(r.log.notices[0]!.kind, 'auth');
  assert.match(r.log.notices[0]!.message, /signed in/);
  r.q().fail(new Error('Claude Code process exited with code 1. stderr: 401 Unauthorized'));
  await settle();
  assert.equal(r.log.notices[1]!.kind, 'auth');
});

test('describeRunnerError classifies', () => {
  assert.equal(describeRunnerError(new Error('spawn ENOENT')).kind, 'binary');
  assert.equal(describeRunnerError(new Error('exited with code 2')).kind, 'exit');
  assert.equal(describeRunnerError('weird').kind, 'error');
  assert.equal(describeRunnerError(undefined).kind, 'error');
});

test('a throwing listener does not break the loop', async () => {
  const sdk = fakeSdk();
  const registry = new PendingRegistry();
  let seen = 0;
  const runner = new SessionRunner({
    queryFn: sdk.queryFn,
    pending: registry,
    listener: { onMessage: () => { seen++; throw new Error('listener bug'); } },
    graceMs: 20,
    env: {},
  });
  runner.start(START);
  sdk.queries[0]!.emit(initMsg(), assistantText('a'), resultMsg(0.001));
  await settle();
  assert.equal(seen, 3);
  assert.equal(runner.busy, false);
});

// --- live controls, effort, context, rate limits ----------------------------------------------------------------------

test('effort reaches Options.effort and the runner state; it is omitted when not given', async () => {
  const r = rig();
  r.runner.start({ ...START, effort: 'xhigh' });
  assert.equal(r.q().params.options.effort, 'xhigh');
  assert.equal(r.runner.effort, 'xhigh');
  assert.equal(r.runner.state.effort, 'xhigh');
  const r2 = rig();
  r2.runner.start(START);
  assert.ok(!('effort' in r2.q().params.options));
  assert.equal(r2.runner.effort, undefined);
});

async function started(opts: Parameters<typeof rig>[0] = {}, start: Partial<StartParams> = {}): Promise<Rig> {
  const r = rig(opts);
  r.runner.start({ ...START, ...start });
  r.q().emit(initMsg());
  await settle();
  return r;
}

test('setOptions applies model, then effort, then mode, and reports not deferred when idle', async () => {
  const r = await started();
  r.q().emit(resultMsg(0.001));
  await settle();
  assert.equal(r.runner.busy, false);
  const res = await r.runner.setOptions({ permissionMode: 'plan', effort: 'high', model: 'opus' }); // key order must not matter
  assert.deepEqual(res, { ok: true, applied: { model: 'opus', effort: 'high', permissionMode: 'plan' }, deferredToNextTurn: false });
  assert.deepEqual(r.q().calls, [
    { method: 'setModel', args: ['opus'] },
    { method: 'applyFlagSettings', args: [{ effortLevel: 'high' }] },
    { method: 'setPermissionMode', args: ['plan'] },
  ]);
  assert.equal(r.runner.effort, 'high');
  assert.equal(r.runner.permissionMode, 'plan');
  assert.ok(r.log.states.some((s) => s.changed.includes('effort')));
});

test('setOptions during a turn sets deferredToNextTurn', async () => {
  const r = await started();
  assert.equal(r.runner.busy, true);
  const res = await r.runner.setOptions({ effort: 'low' });
  assert.deepEqual(res, { ok: true, applied: { effort: 'low' }, deferredToNextTurn: true });
});

test('setOptions with nothing to change is ok and calls nothing', async () => {
  const r = await started();
  assert.deepEqual(await r.runner.setOptions({}), { ok: true, applied: {}, deferredToNextTurn: true });
  assert.equal(r.q().calls.length, 0);
});

test('null model and null effort reset to default: setModel(undefined) and applyFlagSettings({effortLevel: null})', async () => {
  const r = await started({}, { effort: 'max' });
  const res = await r.runner.setOptions({ model: null, effort: null });
  assert.deepEqual(res, { ok: true, applied: { model: null, effort: null }, deferredToNextTurn: true });
  assert.deepEqual(r.q().calls, [
    { method: 'setModel', args: [undefined] },
    { method: 'applyFlagSettings', args: [{ effortLevel: null }] },
  ]);
  assert.equal(r.runner.effort, undefined);
});

test('setOptions never passes bypassPermissions or other invalid values, and applies nothing then', async () => {
  const r = await started();
  const bad = await r.runner.setOptions({ model: 'opus', permissionMode: 'bypassPermissions' as never });
  assert.equal(bad.ok, false);
  assert.equal(r.q().calls.length, 0);
  assert.equal((await r.runner.setOptions({ effort: 'ultra' as never })).ok, false);
  assert.equal((await r.runner.setOptions({ model: '  ' })).ok, false);
  assert.equal(r.q().calls.length, 0);
});

test('setOptions on a query without the methods says to update the extension', async () => {
  const r = await started({ omit: ['setModel', 'setPermissionMode', 'applyFlagSettings'] });
  for (const opts of [{ model: 'opus' }, { effort: 'high' as const }, { permissionMode: 'plan' as const }]) {
    const res = await r.runner.setOptions(opts);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.message, /update the Claude Code extension/i);
  }
  assert.equal(r.runner.effort, undefined);
  assert.equal(r.runner.permissionMode, 'default');
});

test('UnsupportedControlError from a wrapper maps to the update message too, and partial progress is reported', async () => {
  const r = await started();
  r.q().controlErrors['applyFlagSettings'] = new UnsupportedControlError('applyFlagSettings');
  const res = await r.runner.setOptions({ model: 'opus', effort: 'high', permissionMode: 'plan' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.message, /update the Claude Code extension/i);
  assert.deepEqual(res.applied, { model: 'opus' });
  assert.deepEqual(r.q().calls.map((c) => c.method), ['setModel', 'applyFlagSettings']); // stops at the first failure
  assert.equal(r.runner.permissionMode, 'default');
});

test('another control error becomes a readable message', async () => {
  const r = await started();
  r.q().controlErrors['setModel'] = new Error('Model\n  not found:   nope');
  const res = await r.runner.setOptions({ model: 'nope' });
  assert.deepEqual(res, { ok: false, message: 'Could not change the model: Model not found: nope' });
});

test('setOptions on a runner that is not running fails clearly', async () => {
  const fresh = rig();
  assert.deepEqual(await fresh.runner.setOptions({ effort: 'low' }), { ok: false, message: 'The session is not running.' });
  const r = await started();
  await r.runner.stop();
  assert.equal((await r.runner.setOptions({ effort: 'low' })).ok, false);
});

test('initializationResult and contextUsage forward; contextUsage asks for the summary and drops gridRows', async () => {
  const r = await started();
  r.q().controlResults['initializationResult'] = { models: [{ value: 'opus' }] };
  r.q().controlResults['getContextUsage'] = { totalTokens: 3247, maxTokens: 1_000_000, percentage: 0, gridRows: [[1, 2, 3]], categories: [] };
  assert.deepEqual(await r.runner.initializationResult(), { models: [{ value: 'opus' }] });
  assert.deepEqual(await r.runner.contextUsage(), { totalTokens: 3247, maxTokens: 1_000_000, percentage: 0, categories: [] });
  assert.deepEqual(r.q().calls.find((c) => c.method === 'getContextUsage')!.args, [{ detail: 'summary' }]);
  const old = await started({ omit: ['initializationResult', 'getContextUsage'] });
  await assert.rejects(old.runner.initializationResult(), UnsupportedControlError);
  await assert.rejects(old.runner.contextUsage(), UnsupportedControlError);
});

test('context tokens come from top-level assistant usage; subagents are ignored', async () => {
  const r = await started();
  const withUsage = (usage: unknown, parent: string | null = null) => ({ ...assistantText('x'), parent_tool_use_id: parent, message: { id: 'm', model: 'claude-haiku-5-5', role: 'assistant', content: [], usage } });
  r.q().emit(withUsage({ input_tokens: 6, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 94 }));
  await settle();
  assert.equal(r.runner.state.contextTokens, 3100);
  r.q().emit(withUsage({ input_tokens: 50_000, output_tokens: 1 }, 'toolu_sub'));
  await settle();
  assert.equal(r.runner.state.contextTokens, 3100);
  assert.ok(r.log.states.some((s) => s.changed.includes('contextTokens')));
});

test('context windows are learned from result.modelUsage, reported once per change, and shown for the current model', async () => {
  const r = await started();
  const res = (cw: number, extra: Record<string, unknown> = {}) => ({
    ...resultMsg(0.001), modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, contextWindow: cw }, 'claude-opus-5-5': { contextWindow: 200_000 }, junk: { contextWindow: 'big' }, ...extra },
  });
  r.q().emit(res(1_000_000));
  await settle();
  assert.deepEqual(r.log.windows, [['claude-haiku-5-5', 1_000_000], ['claude-opus-5-5', 200_000]]);
  assert.equal(r.runner.contextWindows.get('claude-haiku-5-5'), 1_000_000);
  assert.equal(r.runner.state.contextWindow, 1_000_000); // current model is claude-haiku-5-5
  r.runner.send('again');
  r.q().emit(res(1_000_000));
  await settle();
  assert.equal(r.log.windows.length, 2); // unchanged: not repeated
  r.runner.send('third');
  r.q().emit(res(500_000));
  await settle();
  assert.deepEqual(r.log.windows[2], ['claude-haiku-5-5', 500_000]);
});

test('rate_limit_event reaches onRateLimit normalised: percent 0..100, epoch ms', async () => {
  const r = await started();
  r.q().emit(rateLimitMsg({
    status: 'allowed', resetsAt: 1792448400, rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: 0.45, resetsAt: 1792448400 }, seven_day: { utilization: 0.18, resetsAt: 1792872000 }, seven_day_oauth_apps: { utilization: 0.9, resetsAt: 1 } },
  }));
  await settle();
  assert.deepEqual(r.log.rateLimits, [[
    { id: 'five_hour', pct: 45, asOf: 1_700_000_000_000, resetsAt: 1792448400000 },
    { id: 'seven_day', pct: 18, asOf: 1_700_000_000_000, resetsAt: 1792872000000 },
  ]]);
  assert.ok(r.log.messages.some((m) => m.type === 'rate_limit_event')); // still forwarded as a message
});

test('normaliseRateLimit: warning and rejected mark the binding window, the typed fields are the fallback, junk gives nothing', () => {
  const now = 5;
  const uw = { five_hour: { utilization: 0.91, resetsAt: 100 }, seven_day: { utilization: 0.2, resetsAt: 200 } };
  const warn = normaliseRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', unifiedWindows: uw }, now);
  assert.equal(warn.find((w) => w.id === 'five_hour')!.state, 'warning');
  assert.equal(warn.find((w) => w.id === 'seven_day')!.state, undefined);
  const blocked = normaliseRateLimit({ status: 'rejected', rateLimitType: 'seven_day', unifiedWindows: uw }, now);
  assert.equal(blocked.find((w) => w.id === 'seven_day')!.state, 'blocked');
  assert.deepEqual(normaliseRateLimit({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 300 }, now), [{ id: 'seven_day', pct: 50, asOf: 5, resetsAt: 300_000 }]);
  assert.deepEqual(normaliseRateLimit({ status: 'allowed', rateLimitType: 'seven_day' }, now), [{ id: 'seven_day', pct: null, asOf: 5 }]);
  assert.equal(normaliseRateLimit({ unifiedWindows: { five_hour: { utilization: 3 } } }, now)[0]!.pct, 100); // clamped
  assert.equal(normaliseRateLimit({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1_792_448_400_000 } } }, now)[0]!.resetsAt, 1_792_448_400_000); // already ms
  assert.deepEqual(normaliseRateLimit(undefined, now), []);
  assert.deepEqual(normaliseRateLimit({ status: 'allowed', rateLimitType: 'overage' }, now), []);
});
