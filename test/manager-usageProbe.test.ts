import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { PROBE_ENTRYPOINT_TAG, PROBE_TIMEOUT_MS, runUsageProbe } from '../src/manager/usageProbe.ts';
import type { UsageProbeDeps } from '../src/manager/usageProbe.ts';
import { UnsupportedControlError } from '../src/manager/sessionRunner.ts';
import type { QueryFn } from '../src/manager/sessionRunner.ts';
import { FakeTimers, fakeSdk, settle } from './manager-fakes.ts';
import type { FakeQuery } from './manager-fakes.ts';

const USAGE = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' as const;

const usageResult = {
  session: { total_cost_usd: 0 },
  subscription_type: 'max',
  rate_limits_available: true,
  behaviors: null,
  rate_limits: {
    five_hour: { utilization: 45, resets_at: '2027-01-15T10:00:00.000000+00:00', limit_dollars: null },
    seven_day: { utilization: 18, resets_at: '2027-01-20T10:00:00+00:00' },
    seven_day_opus: null,
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 250, currency: 'gbp', decimal_places: 2 },
    seven_day_breakdown: { rows: [{ key: 'SENTINEL_ROW', percent: 3 }] },
  },
  email: 'SENTINEL_EMAIL',
};

const initResult = {
  models: [{ value: 'default', displayName: 'Default', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['low', 'high'] }],
  account: { email: 'SENTINEL_EMAIL', organization: 'SENTINEL_ORG', subscriptionType: 'Claude Max' },
  pid: 123,
};

function setup(over: Partial<UsageProbeDeps> = {}) {
  const sdk = fakeSdk();
  const q = (): FakeQuery => {
    assert.equal(sdk.queries.length, 1, 'exactly one query per probe');
    return sdk.queries[0]!;
  };
  const queryFn: QueryFn = (p) => {
    const query = sdk.queryFn(p);
    const fq = sdk.queries[sdk.queries.length - 1]!;
    fq.controlResults['initializationResult'] = initResult;
    fq.controlResults[USAGE] = usageResult;
    return query;
  };
  const logs: string[] = [];
  const deps: UsageProbeDeps = { queryFn, binaryPath: '/bin/claude', env: { PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' }, log: (m) => logs.push(m), ...over };
  return { sdk, q, deps, logs };
}

test('ok: windows, extra with currency, plan and models; no prompt is ever sent; the query is closed', async () => {
  const t = setup({ now: () => 5_000 });
  const r = await runUsageProbe(t.deps);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.deepEqual(r.windows, [
    { id: 'five_hour', pct: 45, resetsAt: Date.parse('2027-01-15T10:00:00Z'), asOf: 5_000 },
    { id: 'seven_day', pct: 18, resetsAt: Date.parse('2027-01-20T10:00:00Z'), asOf: 5_000 },
  ]);
  assert.deepEqual(r.extra, { enabled: true, usedUsd: 2.5, limitUsd: 50, currency: 'GBP' });
  assert.equal(r.plan, 'Max');
  assert.equal(r.apiKey, false);
  assert.deepEqual(r.models, [{ value: 'default', label: 'Default', resolved: 'claude-sonnet-5-5', efforts: ['low', 'high'] }]);
  assert.equal(r.at, 5_000);
  const q = t.q();
  assert.deepEqual(q.received, [], 'no user message was ever sent');
  assert.deepEqual(q.calls.map((c) => c.method), ['initializationResult', USAGE]);
  assert.deepEqual(q.calls[1]?.args, [{ skipBehaviors: true }]);
  await settle();
  assert.equal(q.closed, true);
  assert.ok(q.params.options.abortController?.signal.aborted);
});

test('ok: nothing but whitelisted data leaves (no email, organisation, breakdown rows)', async () => {
  const t = setup();
  const r = await runUsageProbe(t.deps);
  assert.ok(!JSON.stringify(r).includes('SENTINEL'));
  assert.ok(!t.logs.join('\n').includes('SENTINEL'));
  // logs hold counts and states, never the values
  assert.ok(!t.logs.join('\n').includes('45'));
});

test('options: no settings, empty strict MCP, no tools, no persistence, neutral cwd, probe entrypoint', async () => {
  const t = setup();
  await runUsageProbe(t.deps);
  const o = t.q().params.options;
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, []);
  assert.equal(o.persistSession, false);
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.cwd, os.tmpdir());
  assert.equal(o.pathToClaudeCodeExecutable, '/bin/claude');
  assert.equal(o.resume, undefined);
  assert.equal(o.canUseTool, undefined);
  assert.equal(o.env?.['CLAUDE_CODE_ENTRYPOINT'], PROBE_ENTRYPOINT_TAG);
  assert.equal(o.env?.['CLAUDE_CODE_ENTRYPOINT'], 'claude-office-probe');
  assert.equal(o.env?.['CLAUDECODE'], undefined, 'inherited session markers are removed');
  assert.equal(o.env?.['CLAUDE_CODE_SESSION_ID'], undefined);
  assert.equal(o.env?.['PATH'], '/usr/bin');
});

test('options: a given cwd is used', async () => {
  const t = setup({ cwd: '/neutral' });
  await runUsageProbe(t.deps);
  assert.equal(t.q().params.options.cwd, '/neutral');
});

test('unsupported: the usage method is missing', async () => {
  const sdk = fakeSdk({ omit: [USAGE] });
  const r = await runUsageProbe({ queryFn: sdk.queryFn, binaryPath: '/b', env: {} });
  assert.deepEqual(r, { status: 'unsupported' });
  assert.equal(sdk.queries[0]?.closed, true);
});

test('unsupported: the method throws UnsupportedControlError', async () => {
  const t = setup();
  const orig = t.deps.queryFn;
  t.deps.queryFn = (p) => {
    const q = orig(p);
    t.sdk.queries[0]!.controlErrors[USAGE] = new UnsupportedControlError(USAGE);
    return q;
  };
  assert.deepEqual(await runUsageProbe(t.deps), { status: 'unsupported' });
});

test('API-key account: no rate limits and no subscription is apiKey with no windows', async () => {
  const t = setup();
  const orig = t.deps.queryFn;
  t.deps.queryFn = (p) => {
    const q = orig(p);
    t.sdk.queries[0]!.controlResults[USAGE] = { subscription_type: null, rate_limits_available: false, rate_limits: null };
    t.sdk.queries[0]!.controlResults['initializationResult'] = { models: [], account: { apiKeySource: 'env' } };
    return q;
  };
  const r = await runUsageProbe(t.deps);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.deepEqual(r.windows, []);
    assert.equal(r.plan, undefined);
    assert.equal(r.apiKey, true);
  }
});

test('signed out: an auth error from initializationResult or usage', async () => {
  for (const method of ['initializationResult', USAGE] as const) {
    const t = setup();
    const orig = t.deps.queryFn;
    t.deps.queryFn = (p) => {
      const q = orig(p);
      t.sdk.queries[0]!.controlErrors[method] = new Error('401 Unauthorized: invalid credentials SENTINEL_TOKEN');
      return q;
    };
    const r = await runUsageProbe(t.deps);
    assert.deepEqual(r, { status: 'signedOut', reason: 'not signed in' });
    assert.equal(t.q().closed, true);
    assert.ok(!t.logs.join('\n').includes('SENTINEL'));
  }
});

test('failed: other errors give a fixed phrase, never the SDK text', async () => {
  const t = setup();
  const orig = t.deps.queryFn;
  t.deps.queryFn = (p) => {
    const q = orig(p);
    t.sdk.queries[0]!.controlErrors[USAGE] = new Error('weird SENTINEL_SECRET failure in /home/someone');
    return q;
  };
  const r = await runUsageProbe(t.deps);
  assert.equal(r.status, 'failed');
  assert.ok(!JSON.stringify(r).includes('SENTINEL'));
  assert.ok(!JSON.stringify(r).includes('/home'));
  assert.equal(t.q().closed, true);
});

test('failed: an unexpected usage result shape', async () => {
  const t = setup();
  const orig = t.deps.queryFn;
  t.deps.queryFn = (p) => {
    const q = orig(p);
    t.sdk.queries[0]!.controlResults[USAGE] = 'nope';
    return q;
  };
  const r = await runUsageProbe(t.deps);
  assert.deepEqual(r, { status: 'failed', reason: 'unexpected usage result' });
  assert.equal(t.q().closed, true);
});

test('failed: query() itself throws (missing binary)', async () => {
  const r = await runUsageProbe({
    queryFn: () => {
      throw new Error('spawn /x ENOENT');
    },
    binaryPath: '/x',
    env: {},
  });
  assert.deepEqual(r, { status: 'failed', reason: 'could not start Claude Code' });
});

test('failed: the process dies while the probe waits (error and clean end)', async () => {
  for (const how of ['error', 'end'] as const) {
    const t = setup();
    const orig = t.deps.queryFn;
    t.deps.queryFn = (p) => {
      const q = orig(p);
      t.sdk.queries[0]!.initializationResult = () => new Promise(() => {});
      return q;
    };
    const run = runUsageProbe(t.deps);
    await settle();
    if (how === 'error') t.q().fail(new Error('Claude Code process exited with code 1'));
    else t.q().finish();
    const r = await run;
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') assert.equal(r.reason, how === 'error' ? 'Claude Code exited unexpectedly' : 'Claude Code stopped before answering');
    assert.equal(t.q().closed, true);
  }
});

test('timeout: a hung probe fails after 20 s and the query is closed and aborted', async () => {
  assert.equal(PROBE_TIMEOUT_MS, 20_000);
  const timers = new FakeTimers();
  const t = setup({ timers });
  const orig = t.deps.queryFn;
  t.deps.queryFn = (p) => {
    const q = orig(p);
    t.sdk.queries[0]!.initializationResult = () => new Promise(() => {}); // never answers
    return q;
  };
  let done = false;
  const run = runUsageProbe(t.deps).then((r) => {
    done = true;
    return r;
  });
  await timers.advance(19_999);
  assert.equal(done, false);
  assert.equal(t.q().closed, false);
  await timers.advance(1);
  assert.deepEqual(await run, { status: 'failed', reason: 'timed out' });
  assert.equal(t.q().closed, true);
  assert.ok(t.q().params.options.abortController?.signal.aborted);
  assert.deepEqual(t.q().received, []);
  assert.equal(timers.pending, 0, 'the timeout timer is cleared');
});

test('a quick probe clears its timeout timer', async () => {
  const timers = new FakeTimers();
  const t = setup({ timers });
  const r = await runUsageProbe(t.deps);
  assert.equal(r.status, 'ok');
  assert.equal(timers.pending, 0);
});
