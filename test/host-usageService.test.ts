import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MS, CACHE_POLL_MS, FIRST_PROBE_DELAY_MS, PROBE_INTERVAL_MS, REFRESH_DEBOUNCE_MS, UsageService } from '../src/host/usageService.ts';
import type { UsageChecks, UsageServiceDeps } from '../src/host/usageService.ts';
import type { ProbeResult } from '../src/manager/usageProbe.ts';
import type { UsageSnapshot, UsageWindow } from '../src/shared/protocol.ts';
import { FakeTimers, settle } from './manager-fakes.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const SEC = 1000;

type OkResult = Extract<ProbeResult, { status: 'ok' }>;

function win(id: UsageWindow['id'], pct: number | null, asOf: number, resetsAt?: number, state?: UsageWindow['state']): UsageWindow {
  const w: UsageWindow = { id, pct, asOf };
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  if (state !== undefined) w.state = state;
  return w;
}

function ok(over: Partial<OkResult> = {}, at = T0): OkResult {
  return {
    status: 'ok',
    windows: [win('five_hour', 40, at, at + 3 * 60 * MIN), win('seven_day', 10, at, at + 5 * 24 * 60 * MIN)],
    models: [],
    apiKey: false,
    plan: 'Max',
    at,
    elapsedMs: 1600,
    ...over,
  };
}

function cacheJson(fetchedAtMs: number, five: number, resetsAtMs: number, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    unrelated: { email: 'SENTINEL_EMAIL' },
    cachedUsageUtilization: {
      fetchedAtMs,
      utilization: { five_hour: { utilization: five, resets_at: new Date(resetsAtMs).toISOString() }, ...(extra ? { extra_usage: extra } : {}) },
    },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(opts: { checks?: UsageChecks; apiKeyEnv?: boolean; idleProbe?: UsageServiceDeps['idleProbe'] } = {}) {
  const timers = new FakeTimers();
  const now = () => T0 + timers.now;
  const posts: UsageSnapshot[] = [];
  const logs: string[] = [];
  const file = { text: undefined as string | undefined, mtime: 1, stats: 0, reads: 0 };
  const probe = {
    calls: 0,
    active: 0,
    maxActive: 0,
    results: [] as Array<ProbeResult | Error>,
    gate: undefined as Deferred<void> | undefined,
    fallback: undefined as ProbeResult | undefined,
  };
  const okCalls: OkResult[] = [];
  const svc = new UsageService({
    probe: async () => {
      probe.calls++;
      probe.active++;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      try {
        if (probe.gate) await probe.gate.promise;
        const next = probe.results.shift() ?? probe.fallback ?? ok({}, now());
        if (next instanceof Error) throw next;
        return next;
      } finally {
        probe.active--;
      }
    },
    post: (m) => {
      assert.equal(m.type, 'usage');
      posts.push(m.usage);
    },
    now,
    timers,
    fs: {
      stat: async () => {
        file.stats++;
        if (file.text === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return { mtimeMs: file.mtime, size: file.text.length };
      },
      readFile: async () => {
        file.reads++;
        if (file.text === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return file.text;
      },
    },
    configPath: '/home/u/.claude.json',
    ...(opts.checks !== undefined ? { usageChecks: opts.checks } : {}),
    ...(opts.apiKeyEnv !== undefined ? { apiKeyEnv: () => opts.apiKeyEnv === true } : {}),
    ...(opts.idleProbe !== undefined ? { idleProbe: opts.idleProbe } : {}),
    onProbeOk: (r) => okCalls.push(r),
    log: (m) => logs.push(m),
  });
  const setFile = (text: string | undefined) => {
    file.text = text;
    file.mtime++;
  };
  const last = (): UsageSnapshot => {
    const p = posts[posts.length - 1];
    assert.ok(p, 'something was posted');
    return p;
  };
  return { timers, now, svc, posts, logs, file, probe, okCalls, setFile, last };
}

// --- schedule -------------------------------------------------------------------------------------------------------

test('visible: posts at once, reads the cache at once, probes after 3 s', async () => {
  const h = harness();
  h.setFile(cacheJson(T0 - 2 * MIN, 33, T0 + 2 * 60 * MIN));
  assert.equal(h.timers.pending, 0, 'nothing is scheduled before the office is visible');
  h.svc.setVisible(true);
  assert.equal(h.posts.length, 1);
  assert.deepEqual([h.posts[0]?.kind, h.posts[0]?.source, h.posts[0]?.probe], ['unknown', 'none', 'idle']);
  assert.equal(h.posts[0]?.nextAt, T0 + FIRST_PROBE_DELAY_MS);
  await h.timers.advance(0);
  assert.equal(h.file.reads, 1, 'the cache is read at once');
  assert.deepEqual([h.last().kind, h.last().source, h.last().windows[0]?.pct], ['plan', 'cache', 33]);
  assert.equal(h.probe.calls, 0);
  await h.timers.advance(FIRST_PROBE_DELAY_MS - 1);
  assert.equal(h.probe.calls, 0);
  await h.timers.advance(1);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.last().probe, 'ok');
  assert.equal(h.last().source, 'probe');
  assert.equal(h.okCalls.length, 1);
});

test('visible: a running probe is posted as running', async () => {
  const h = harness();
  h.probe.gate = deferred<void>();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.last().probe, 'running');
  assert.equal(h.last().nextAt, undefined);
  h.probe.gate.resolve();
  await settle();
  assert.equal(h.last().probe, 'ok');
});

test('cadence: every 5 minutes while visible', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.last().nextAt, T0 + FIRST_PROBE_DELAY_MS + PROBE_INTERVAL_MS);
  await h.timers.advance(PROBE_INTERVAL_MS - 1);
  assert.equal(h.probe.calls, 1);
  await h.timers.advance(1);
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 3);
  await h.timers.advance(3 * PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 6);
});

test('hidden clears every timer: poller, probe timer and reset tick', async () => {
  const h = harness();
  h.setFile(cacheJson(T0, 20, T0 + 60 * MIN));
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS + 100);
  assert.ok(h.timers.pending >= 3, 'poller, probe and reset timers are armed while visible');
  h.svc.setVisible(false);
  assert.equal(h.timers.pending, 0);
  const calls = h.probe.calls;
  const stats = h.file.stats;
  await h.timers.advance(60 * MIN);
  assert.equal(h.probe.calls, calls);
  assert.equal(h.file.stats, stats, 'the cache poller stops too');
  assert.equal(h.timers.pending, 0);
});

test('hidden before the first probe: no timers left and no probe', async () => {
  const h = harness();
  h.svc.setVisible(true);
  h.svc.setVisible(false);
  assert.equal(h.timers.pending, 0);
  await h.timers.advance(10 * MIN);
  assert.equal(h.probe.calls, 0);
});

test('a probe in flight when the office is hidden still lands, and schedules nothing', async () => {
  const h = harness();
  h.probe.gate = deferred<void>();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  h.svc.setVisible(false);
  h.probe.gate.resolve();
  await settle();
  assert.equal(h.svc.snapshot().source, 'probe');
  assert.equal(h.timers.pending, 0);
  await h.timers.advance(30 * MIN);
  assert.equal(h.probe.calls, 1);
});

test('shown again soon after a probe: next probe at the 5-minute mark, not 3 s', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS); // probe at t=3 s
  h.svc.setVisible(false);
  await h.timers.advance(MIN); // t=63 s
  h.svc.setVisible(true);
  assert.equal(h.last().nextAt, T0 + FIRST_PROBE_DELAY_MS + PROBE_INTERVAL_MS);
  await h.timers.advance(5 * SEC);
  assert.equal(h.probe.calls, 1, 'not 3 s after showing');
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 2);
});

test('shown again more than 5 minutes after the last probe: probes after 3 s', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  h.svc.setVisible(false);
  await h.timers.advance(6 * MIN);
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS - 1);
  assert.equal(h.probe.calls, 1);
  await h.timers.advance(1);
  assert.equal(h.probe.calls, 2);
});

// --- single flight, backoff, stops, refresh ---------------------------------------------------------------------------

test('single flight: never two probes at once, even with refresh, hide and show during a probe', async () => {
  const h = harness();
  h.probe.gate = deferred<void>();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.active, 1);
  assert.equal(h.svc.refresh(), 'busy');
  h.svc.setVisible(false);
  h.svc.setVisible(true);
  await h.timers.advance(10 * MIN);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.probe.maxActive, 1);
  h.probe.gate.resolve();
  await settle();
  assert.equal(h.probe.calls, 1);
  // after it ends, the next one is scheduled from its end, and still alone
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 2);
  assert.equal(h.probe.maxActive, 1);
});

test('backoff: 5, 10, 20, 30, 30 minutes after consecutive failures; a success resets to 5', async () => {
  const h = harness();
  h.probe.fallback = { status: 'failed', reason: 'timed out' };
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.last().probe, 'failed');
  for (const [i, minutes] of [5, 10, 20, 30, 30].entries()) {
    const delay = minutes * MIN;
    assert.equal(h.last().nextAt, h.now() + delay, `delay before probe ${i + 2}`);
    await h.timers.advance(delay - 1);
    assert.equal(h.probe.calls, i + 1, `no probe ${i + 2} early`);
    await h.timers.advance(1);
    assert.equal(h.probe.calls, i + 2);
  }
  h.probe.fallback = undefined;
  h.probe.results = [ok({}, 0)];
  await h.timers.advance(30 * MIN);
  assert.equal(h.probe.calls, 7);
  assert.equal(h.last().probe, 'ok');
  assert.equal(h.last().nextAt, h.now() + PROBE_INTERVAL_MS, 'back to the 5-minute cadence');
  assert.deepEqual(BACKOFF_MS, [5 * MIN, 10 * MIN, 20 * MIN, 30 * MIN]);
});

test('a probe that rejects counts as a failure', async () => {
  const h = harness();
  h.probe.results = [new Error('boom SENTINEL')];
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.last().probe, 'failed');
  assert.equal(h.last().nextAt, h.now() + 5 * MIN);
  assert.ok(!h.logs.join('\n').includes('SENTINEL'));
});

test('unsupported: probing stops for good (until the extension restarts)', async () => {
  const h = harness();
  h.probe.results = [{ status: 'unsupported' }];
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.last().probe, 'unsupported');
  assert.equal(h.last().nextAt, undefined);
  await h.timers.advance(2 * 60 * MIN);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.svc.refresh(), 'unsupported');
  h.svc.setVisible(false);
  h.svc.setVisible(true);
  await h.timers.advance(MIN);
  assert.equal(h.probe.calls, 1);
  assert.equal(h.last().probe, 'unsupported');
});

test('unsupported: the cache and events still feed the snapshot', async () => {
  const h = harness();
  h.probe.results = [{ status: 'unsupported' }];
  h.setFile(cacheJson(T0, 25, T0 + 120 * MIN));
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  h.svc.onRateLimit([win('five_hour', 55, T0 + 4 * SEC, T0 + 120 * MIN)]);
  assert.deepEqual([h.last().probe, h.last().source, h.last().windows[0]?.pct], ['unsupported', 'event', 55]);
});

test('signed out: stops until a manual refresh', async () => {
  const h = harness();
  h.probe.results = [{ status: 'signedOut', reason: 'not signed in' }];
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.last().probe, 'signedOut');
  await h.timers.advance(60 * MIN);
  assert.equal(h.probe.calls, 1);
  h.svc.setVisible(false);
  h.svc.setVisible(true);
  await h.timers.advance(10 * MIN);
  assert.equal(h.probe.calls, 1, 'hiding and showing does not retry');
  assert.equal(h.svc.refresh(), 'started');
  await settle();
  assert.equal(h.probe.calls, 2);
  assert.equal(h.last().probe, 'ok');
  // and it is back on the normal cadence
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 3);
});

test('signed out again after a refresh stays stopped', async () => {
  const h = harness();
  h.probe.fallback = { status: 'signedOut', reason: 'not signed in' };
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.svc.refresh(), 'started');
  await settle();
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(60 * MIN);
  assert.equal(h.probe.calls, 2);
  assert.equal(h.last().probe, 'signedOut');
});

test('refresh is debounced to once every 60 s', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.svc.refresh(), 'started');
  await settle();
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(30 * SEC);
  assert.equal(h.svc.refresh(), 'debounced');
  await h.timers.advance(REFRESH_DEBOUNCE_MS - 30 * SEC - 1);
  assert.equal(h.svc.refresh(), 'debounced');
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(1);
  assert.equal(h.svc.refresh(), 'started');
  await settle();
  assert.equal(h.probe.calls, 3);
});

test('refresh restarts the cadence from the refresh, with one probe timer only', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  await h.timers.advance(2 * MIN);
  h.svc.refresh();
  await settle();
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(PROBE_INTERVAL_MS - 1);
  assert.equal(h.probe.calls, 2);
  await h.timers.advance(1);
  assert.equal(h.probe.calls, 3);
});

test('refresh while hidden does nothing', async () => {
  const h = harness();
  assert.equal(h.svc.refresh(), 'hidden');
  assert.equal(h.probe.calls, 0);
});

test('usageChecks off: never probes, probe state is off, cache and events still work', async () => {
  const h = harness({ checks: 'off' });
  h.setFile(cacheJson(T0, 30, T0 + 120 * MIN));
  h.svc.setVisible(true);
  assert.equal(h.last().probe, 'off');
  assert.equal(h.last().nextAt, undefined);
  await h.timers.advance(2 * 60 * MIN);
  assert.equal(h.probe.calls, 0);
  assert.deepEqual([h.last().probe, h.last().source, h.last().kind], ['off', 'cache', 'plan']);
  h.svc.onRateLimit([win('five_hour', 45, T0 + 2 * 60 * MIN - 1000, T0 + 300 * MIN)]);
  assert.deepEqual([h.last().probe, h.last().source, h.last().windows[0]?.pct], ['off', 'event', 45]);
  assert.equal(h.svc.refresh(), 'off');
  assert.equal(h.probe.calls, 0);
});

test('usageChecks: switching to off clears the probe timer, back to auto probes after 3 s', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.calls, 1);
  h.svc.setUsageChecks('off');
  assert.equal(h.last().probe, 'off');
  await h.timers.advance(30 * MIN);
  assert.equal(h.probe.calls, 1);
  h.svc.setUsageChecks('auto');
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.calls, 2, 'the last probe is stale, so it is due after 3 s');
  assert.equal(h.last().probe, 'ok');
});

// --- merge ----------------------------------------------------------------------------------------------------------

test('merge: the newest reading per window wins, whichever source', async () => {
  const h = harness();
  h.setFile(cacheJson(T0 + 2 * SEC, 70, T0 + 200 * MIN)); // cache is NEWER than the probe will be... see below
  h.probe.results = [ok({ windows: [win('five_hour', 40, T0 + SEC, T0 + 200 * MIN), win('seven_day', 10, T0 + SEC, T0 + 6000 * MIN)] })];
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  const by = (s: UsageSnapshot, id: string) => s.windows.find((w) => w.id === id);
  // five_hour: cache (asOf +2 s) beats the probe reading (asOf +1 s); seven_day only exists in the probe
  assert.equal(by(h.last(), 'five_hour')?.pct, 70);
  assert.equal(by(h.last(), 'seven_day')?.pct, 10);
  assert.equal(h.last().source, 'mixed');
  // a newer event beats both for five_hour
  h.svc.onRateLimit([win('five_hour', 80, T0 + 10 * SEC, T0 + 200 * MIN, 'warning')]);
  assert.deepEqual([by(h.last(), 'five_hour')?.pct, by(h.last(), 'five_hour')?.state], [80, 'warning']);
  // an older event loses
  h.svc.onRateLimit([win('five_hour', 5, T0 + 5 * SEC, T0 + 200 * MIN)]);
  assert.equal(by(h.last(), 'five_hour')?.pct, 80);
  // a newer probe replaces the event, and drops its warning state
  h.probe.results = [ok({ windows: [win('five_hour', 50, T0 + 20 * SEC, T0 + 200 * MIN)] }, T0 + 20 * SEC)];
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.deepEqual([by(h.last(), 'five_hour')?.pct, by(h.last(), 'five_hour')?.state], [50, undefined]);
});

test('merge: source labels', async () => {
  const h = harness({ checks: 'off' });
  assert.equal(h.svc.snapshot().source, 'none');
  h.svc.setVisible(true);
  h.svc.onRateLimit([win('five_hour', 10, T0, T0 + 100 * MIN)]);
  assert.equal(h.svc.snapshot().source, 'event');
  h.setFile(cacheJson(T0 + SEC, 20, T0 + 100 * MIN));
  await h.timers.advance(CACHE_POLL_MS);
  assert.equal(h.svc.snapshot().source, 'cache');
  h.svc.onRateLimit([win('seven_day', 30, T0 + 2 * SEC, T0 + 7000 * MIN)]);
  assert.equal(h.svc.snapshot().source, 'mixed');
  const h2 = harness();
  h2.svc.setVisible(true);
  await h2.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h2.svc.snapshot().source, 'probe');
});

test('merge: a window whose reset has passed counts as reset (0), keeping the reading time in asOf', async () => {
  const h = harness({ checks: 'off' });
  h.svc.setVisible(true);
  h.svc.onRateLimit([win('five_hour', 90, T0 - 4 * 60 * MIN, T0 + 10 * MIN, 'blocked')]);
  assert.deepEqual([h.last().windows[0]?.pct, h.last().windows[0]?.state], [90, 'blocked']);
  // the reset tick fires just after resetsAt, with no new reading and no probe
  await h.timers.advance(10 * MIN - 1);
  assert.equal(h.last().windows[0]?.pct, 90);
  await h.timers.advance(SEC + 1);
  const w = h.last().windows[0];
  assert.equal(w?.pct, 0);
  assert.equal(w?.state, undefined);
  assert.equal(w?.asOf, T0 - 4 * 60 * MIN, 'asOf stays the time of the real reading');
  assert.equal(w?.resetsAt, T0 + 10 * MIN);
  assert.equal(h.last().asOf, T0 - 4 * 60 * MIN);
});

test('merge: stale cache with a reset time already in the past reads as 0', async () => {
  const h = harness({ checks: 'off' });
  h.setFile(cacheJson(T0 - 600 * MIN, 88, T0 - 100 * MIN));
  h.svc.setVisible(true);
  await h.timers.advance(0);
  assert.deepEqual([h.last().windows[0]?.pct, h.last().windows[0]?.asOf], [0, T0 - 600 * MIN]);
  assert.equal(h.svc.snapshot().windows[0]?.pct, 0);
});

test('merge: an event without a number does not wipe a real reading, but its state and reset time apply', async () => {
  const h = harness({ checks: 'off' });
  h.svc.setVisible(true);
  h.svc.onRateLimit([win('five_hour', 60, T0, T0 + 100 * MIN)]);
  h.svc.onRateLimit([win('five_hour', null, T0 + SEC, T0 + 110 * MIN, 'blocked')]);
  const w = h.last().windows[0];
  assert.deepEqual([w?.pct, w?.state, w?.resetsAt, w?.asOf], [60, 'blocked', T0 + 110 * MIN, T0]);
});

test('merge: windows are capped to the known ids and ordered', async () => {
  const h = harness({ checks: 'off' });
  h.svc.setVisible(true);
  h.svc.onRateLimit([win('seven_day', 1, T0), win('five_hour', 2, T0), { id: 'bogus' as never, pct: 3, asOf: T0 }]);
  assert.deepEqual(h.last().windows.map((w) => w.id), ['five_hour', 'seven_day']);
});

test('extra usage: the newest of cache and probe, with currency', async () => {
  const h = harness();
  h.setFile(cacheJson(T0 - MIN, 30, T0 + 100 * MIN, { is_enabled: true, monthly_limit: 2000, used_credits: 150, decimal_places: 2, currency: 'GBP' }));
  h.probe.results = [ok({ extra: { enabled: true, usedUsd: 3, limitUsd: 20, currency: 'GBP' } })];
  h.svc.setVisible(true);
  await h.timers.advance(0);
  assert.deepEqual(h.last().extra, { enabled: true, usedUsd: 1.5, limitUsd: 20, currency: 'GBP' });
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.deepEqual(h.last().extra, { enabled: true, usedUsd: 3, limitUsd: 20, currency: 'GBP' });
});

// --- kind -----------------------------------------------------------------------------------------------------------

test('kind: plan with a subscription, apiKey from the probe or the env, otherwise unknown', async () => {
  const unknown = harness({ checks: 'off' });
  unknown.svc.setVisible(true);
  assert.equal(unknown.svc.snapshot().kind, 'unknown');

  const envKey = harness({ checks: 'off', apiKeyEnv: true });
  envKey.svc.setVisible(true);
  assert.equal(envKey.svc.snapshot().kind, 'apiKey');
  envKey.svc.onRateLimit([win('five_hour', 1, T0, T0 + MIN)]);
  assert.equal(envKey.svc.snapshot().kind, 'plan', 'plan windows beat the env hint');

  const probeKey = harness();
  probeKey.probe.results = [ok({ windows: [], plan: undefined, apiKey: true })];
  probeKey.svc.setVisible(true);
  await probeKey.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.deepEqual([probeKey.last().kind, probeKey.last().windows.length, probeKey.last().plan, probeKey.last().probe], ['apiKey', 0, undefined, 'ok']);
  assert.equal(probeKey.last().asOf, probeKey.okCalls[0]?.at);

  const plan = harness();
  plan.probe.results = [ok({ windows: [], plan: 'Pro' })];
  plan.svc.setVisible(true);
  await plan.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.deepEqual([plan.last().kind, plan.last().plan], ['plan', 'Pro']);
});

// --- cache poller ---------------------------------------------------------------------------------------------------

test('cache poller: every 15 s while visible, only reports changes, ignores a bad file', async () => {
  const h = harness({ checks: 'off' });
  h.setFile(cacheJson(T0, 30, T0 + 100 * MIN));
  h.svc.setVisible(true);
  await h.timers.advance(0);
  const posted = h.posts.length;
  await h.timers.advance(CACHE_POLL_MS * 3);
  assert.equal(h.file.reads, 1, 'unchanged file is not re-read');
  assert.equal(h.posts.length, posted);
  h.setFile(cacheJson(T0 + 20 * SEC, 31, T0 + 100 * MIN));
  await h.timers.advance(CACHE_POLL_MS - 1);
  assert.equal(h.last().windows[0]?.pct, 30);
  await h.timers.advance(1);
  assert.equal(h.last().windows[0]?.pct, 31);
  h.setFile('{not json');
  await h.timers.advance(CACHE_POLL_MS);
  assert.equal(h.last().windows[0]?.pct, 31);
  assert.ok(h.logs.some((l) => l.includes('cache unreadable')));
  h.setFile(undefined);
  await h.timers.advance(CACHE_POLL_MS);
  assert.equal(h.last().windows[0]?.pct, 31, 'a missing file keeps the last reading');
});

test('cache: only whitelisted data is kept (no account data in snapshots or logs)', async () => {
  const h = harness({ checks: 'off' });
  h.setFile(cacheJson(T0, 30, T0 + 100 * MIN));
  h.svc.setVisible(true);
  await h.timers.advance(0);
  assert.ok(!JSON.stringify(h.posts).includes('SENTINEL'));
  assert.ok(!h.logs.join('\n').includes('SENTINEL'));
});

// --- posting and replay ---------------------------------------------------------------------------------------------

test('posts only when the merged snapshot changes; snapshot() is the replay value', async () => {
  const h = harness({ checks: 'off' });
  h.svc.setVisible(true);
  h.svc.onRateLimit([win('five_hour', 10, T0, T0 + 100 * MIN)]);
  const n = h.posts.length;
  h.svc.onRateLimit([win('five_hour', 10, T0, T0 + 100 * MIN)]); // identical
  assert.equal(h.posts.length, n);
  assert.deepEqual(h.svc.snapshot(), h.last());
  h.svc.onRateLimit([win('five_hour', 11, T0 + SEC, T0 + 100 * MIN)]);
  assert.equal(h.posts.length, n + 1);
  assert.deepEqual(h.svc.snapshot(), h.last());
  // replay value is available before anything was posted, and after hiding
  const fresh = harness();
  assert.deepEqual([fresh.svc.snapshot().kind, fresh.svc.snapshot().source, fresh.svc.snapshot().probe], ['unknown', 'none', 'idle']);
  h.svc.setVisible(false);
  assert.equal(h.svc.snapshot().windows[0]?.pct, 11);
});

test('events are merged and posted even while the office is hidden', async () => {
  const h = harness();
  h.svc.onRateLimit([win('five_hour', 12, T0, T0 + 100 * MIN)]);
  assert.equal(h.last().windows[0]?.pct, 12);
  assert.equal(h.timers.pending, 0, 'no timers while hidden');
});

test('a post that throws does not break the service', async () => {
  const h = harness({ checks: 'off' });
  const svc = new UsageService({
    probe: async () => ok(),
    post: () => {
      throw new Error('webview gone');
    },
    now: h.now,
    timers: h.timers,
    fs: { stat: async () => ({ mtimeMs: 1, size: 1 }), readFile: async () => '{}' },
    configPath: '/x',
    usageChecks: 'off',
  });
  svc.setVisible(true);
  svc.onRateLimit([win('five_hour', 1, T0)]);
  assert.equal(svc.snapshot().windows.length, 1);
  svc.dispose();
});

// --- idle-run hook ----------------------------------------------------------------------------------------------------

test('idle-run hook: used when it answers, a fresh probe when it does not', async () => {
  let answers: Array<ProbeResult | undefined> = [ok({ plan: 'Idle' }, T0 + 3 * SEC), undefined];
  const h = harness({ idleProbe: async () => answers.shift() });
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS);
  assert.equal(h.probe.calls, 0, 'no process spawned');
  assert.equal(h.last().plan, 'Idle');
  await h.timers.advance(PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 1, 'the hook declined, so a fresh probe ran');
  assert.equal(h.last().plan, 'Max');
  answers = [];
});

test('without the hook a fresh probe always runs', async () => {
  const h = harness();
  h.svc.setVisible(true);
  await h.timers.advance(FIRST_PROBE_DELAY_MS + 2 * PROBE_INTERVAL_MS);
  assert.equal(h.probe.calls, 3);
});
