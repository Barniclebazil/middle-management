import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECORDS, SETTLE_MS, MAX_RECORD_AGE_MS, REFUSAL_WAITING, REFUSAL_WORKING, SENT_HOME_KEY, SentHome, parseRecords } from '../src/host/sentHome.ts';
import { OfficeFeed } from '../src/host/officeFeed.ts';
import type { SessionInfo, WatchUpdate } from '../src/claude/types.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

function main(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, sessionId: id, kind: 'main', title: `Task ${id}`, project: 'p', activity: 'idle', status: 'idle', since: T0 - HOUR, startedAt: T0 - 10 * HOUR, control: 'free', ...over };
}
function temp(lead: string, n: number, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id: `${lead}/t${n}`, parentId: lead, sessionId: lead, kind: 'temp', title: `Temp ${n}`, project: 'p', activity: 'reading', status: 'done', since: T0 - HOUR, startedAt: T0 - HOUR, control: 'none', ...over };
}
function session(sessionId: string, mtimeMs = T0 - HOUR): SessionInfo {
  return { sessionId, transcriptPath: `/x/${sessionId}.jsonl`, projectDir: '/x', mtimeMs, subagents: [] };
}

function rig(opts: { stored?: unknown; setting?: unknown; demo?: boolean } = {}) {
  const state = { now: T0, setting: opts.setting ?? 8, demo: opts.demo ?? false, stored: opts.stored as unknown };
  const saved: unknown[] = [];
  const stopped: string[] = [];
  const closedTabs: string[] = [];
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let refreshes = 0;
  let tabs: string[] = [];
  let stopResult = true;
  const sh = new SentHome({
    storage: {
      get: (k) => (k === SENT_HOME_KEY ? state.stored : undefined),
      set: (k, v) => {
        assert.equal(k, SENT_HOME_KEY);
        state.stored = v;
        saved.push(v);
      },
    },
    now: () => state.now,
    readSetting: () => state.setting,
    isDemo: () => state.demo,
    stopIfIdle: (sid) => {
      stopped.push(sid);
      return stopResult;
    },
    closeCaseTab: (id) => void closedTabs.push(id),
    openCaseTabs: () => tabs,
    refresh: () => void refreshes++,
    timers: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => void ((h as { cleared: boolean }).cleared = true),
    },
    log: (m) => void logs.push(m),
  });
  return {
    sh, state, saved, stopped, closedTabs, logs, timers,
    refreshes: () => refreshes,
    setTabs: (t: string[]) => void (tabs = t),
    setStopResult: (b: boolean) => void (stopResult = b),
  };
}

test('an idle worker is sent home and leaves the filtered list with their temps', () => {
  const r = rig();
  const agents = [main('a'), temp('a', 1), temp('a', 2), main('b')];
  const sessions = [session('a'), session('b')];
  assert.equal(r.sh.filter(agents, sessions).length, 4);
  assert.deepEqual(r.sh.sendHome('a'), { ok: true });
  assert.equal(r.refreshes(), 1);
  assert.deepEqual(r.sh.filter(agents, sessions).map((a) => a.id), ['b']);
  assert.deepEqual(r.state.stored, { v: 1, entries: [{ id: 'a', at: T0, mtimeMs: T0 - HOUR }] });
});

test('a temp is sent home through its lead', () => {
  const r = rig();
  const agents = [main('a'), temp('a', 1), main('b')];
  assert.equal(r.sh.filter(agents, [session('a')]).length, 3);
  assert.deepEqual(r.sh.sendHome('a/t1'), { ok: true });
  assert.deepEqual(r.sh.homeSessions(), ['a']);
  assert.deepEqual(r.sh.filter(agents, [session('a')]).map((a) => a.id), ['b']);
});

test('busy workers are refused: working, pending, needs you, waiting, or a working temp', () => {
  const cases: Array<[string, AgentSnapshot[], string]> = [
    ['working', [main('a', { status: 'working', activity: 'writing' })], REFUSAL_WORKING],
    ['working temp', [main('a'), temp('a', 1, { status: 'working' })], REFUSAL_WORKING],
    ['pending', [main('a', { pending: { requestId: 'r', kind: 'permission' } })], REFUSAL_WAITING],
    ['needs you', [main('a', { activity: 'needsYou' })], REFUSAL_WAITING],
    ['waiting', [main('a', { status: 'waiting' })], REFUSAL_WAITING],
  ];
  for (const [name, agents, reason] of cases) {
    const r = rig();
    r.sh.filter(agents, [session('a')]);
    assert.deepEqual(r.sh.sendHome('a'), { ok: false, reason }, name);
    assert.equal(r.sh.homeSessions().length, 0, name);
    assert.equal(r.saved.length, 0, name);
    assert.equal(r.stopped.length, 0, name);
    assert.equal(r.refreshes(), 0, name);
  }
  assert.match(REFUSAL_WORKING, /still working/);
});

test('an unknown worker is refused; sending home twice is fine', () => {
  const r = rig();
  r.sh.filter([main('a')], [session('a')]);
  assert.equal(r.sh.sendHome('nope').ok, false);
  assert.equal(r.sh.sendHome('a').ok, true);
  assert.equal(r.sh.sendHome('a').ok, true);
  assert.equal(r.saved.length, 1);
});

test('an office run is stopped if idle; other controls are not touched', () => {
  const r = rig();
  r.sh.filter([main('a', { control: 'office' }), main('b', { control: 'elsewhere' }), main('c', { control: 'free' })], []);
  r.sh.sendHome('a');
  r.sh.sendHome('b');
  r.sh.sendHome('c');
  assert.deepEqual(r.stopped, ['a']);
});

test('a stopIfIdle that declines still records the send home', () => {
  const r = rig();
  r.setStopResult(false);
  r.sh.filter([main('a', { control: 'office' })], []);
  assert.equal(r.sh.sendHome('a').ok, true);
  assert.deepEqual(r.stopped, ['a']);
});

test('the open case tabs of the worker and their temps are closed', () => {
  const r = rig();
  r.setTabs(['a', 'a/t1', 'b']);
  r.sh.filter([main('a'), temp('a', 1), main('b')], []);
  r.sh.sendHome('a');
  assert.deepEqual(r.closedTabs, ['a', 'a/t1']);
});

test('closing a tab: an idle worker goes home, a busy worker stays, a temp tab does not send the lead home', () => {
  const r = rig();
  r.sh.filter([main('a'), main('b', { status: 'working' }), temp('a', 1)], [session('a'), session('b')]);
  r.sh.onTabClosed('b');
  assert.equal(r.sh.homeSessions().length, 0);
  r.sh.onTabClosed('a/t1');
  assert.equal(r.sh.homeSessions().length, 0);
  r.sh.onTabClosed('a');
  assert.deepEqual(r.sh.homeSessions(), ['a']);
  r.sh.onTabClosed('unknown');
  assert.deepEqual(r.sh.homeSessions(), ['a']);
});

test('a newer transcript brings the worker back; within the slop it does not', () => {
  const r = rig();
  const agents = [main('a')];
  const base = T0 + SETTLE_MS + 1000; // a write time after the settle window
  r.sh.filter(agents, [session('a', base)]);
  r.sh.sendHome('a');
  assert.equal(r.sh.filter(agents, [session('a', base)]).length, 0);
  assert.equal(r.sh.filter(agents, [session('a', base + 1500)]).length, 0); // 1.5 s newer: noise
  assert.equal(r.sh.filter(agents, [session('a', base + 2500)]).length, 1); // 2.5 s newer: back
  assert.equal(r.sh.homeSessions().length, 0);
  assert.deepEqual(r.state.stored, { v: 1, entries: [] });
});

test('working, knocking, or a working temp brings the worker back', () => {
  const variants: Array<[string, AgentSnapshot[]]> = [
    ['working', [main('a', { status: 'working' })]],
    ['pending', [main('a', { pending: { requestId: 'r', kind: 'question' } })]],
    ['needs you', [main('a', { activity: 'needsYou' })]],
    ['waiting', [main('a', { status: 'waiting' })]],
    ['temp working', [main('a'), temp('a', 1, { status: 'working' })]],
  ];
  for (const [name, back] of variants) {
    const r = rig();
    r.sh.filter([main('a')], [session('a')]);
    r.sh.sendHome('a');
    assert.equal(r.sh.filter([main('a')], [session('a')]).length, 0, name);
    assert.equal(r.sh.filter(back, [session('a')]).length, back.length, name);
    assert.equal(r.sh.isHome('a'), false, name);
  }
});

test('the feed filter hook: sending home republishes without the worker, activity brings them back', async () => {
  const published: AgentSnapshot[][] = [];
  const update: WatchUpdate = { sessions: [session('a', 1000), session('b', 1000)], batches: [] };
  let list: AgentSnapshot[] = [main('a'), main('b')];
  let t = T0;
  const r = rig();
  const feed = new OfficeFeed({
    createWatcher: () => ({ poll: async () => update }),
    createTracker: () => ({ apply: () => undefined, snapshot: () => list }),
    publish: (m) => void (m.type === 'agents' && published.push(m.agents)),
    now: () => t,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    log: () => undefined,
    filterAgents: (a, s) => r.sh.filter(a, s),
  });
  feed.setVisible(true);
  assert.deepEqual(published.at(-1)?.map((a) => a.id), ['a', 'b']);
  assert.equal(r.sh.sendHome('a').ok, true);
  feed.refreshNow();
  assert.deepEqual(published.at(-1)?.map((a) => a.id), ['b']);
  list = [main('a', { status: 'working' }), main('b')];
  t += 1000;
  feed.refreshNow();
  assert.deepEqual(published.at(-1)?.map((a) => a.id), ['a', 'b']);
  feed.dispose();
});

test('auto send home: after N hours idle, not before; never busy; not with a tab open; 0 is off', () => {
  const agents = [
    main('old', { since: T0 - 9 * HOUR }),
    main('fresh', { since: T0 - 7 * HOUR }),
    main('busy', { since: T0 - 20 * HOUR, status: 'working', activity: 'writing' }),
    main('knock', { since: T0 - 20 * HOUR, activity: 'needsYou', status: 'waiting' }),
    main('tab', { since: T0 - 20 * HOUR }),
    main('temps', { since: T0 - 20 * HOUR }),
    temp('temps', 1, { status: 'working' }),
  ];
  const r = rig({ setting: 8 });
  r.setTabs(['tab']);
  r.sh.filter(agents, []);
  assert.equal(r.sh.autoCheck(), 1);
  assert.deepEqual(r.sh.homeSessions(), ['old']);
  assert.equal(r.refreshes(), 1);
  r.state.setting = 0.5; // fractions are allowed: 30 minutes
  assert.equal(r.sh.autoCheck(), 1);
  assert.deepEqual(r.sh.homeSessions().sort(), ['fresh', 'old']);
  r.state.setting = 0;
  r.state.now += 100 * HOUR;
  assert.equal(r.sh.autoCheck(), 0);
  r.state.setting = 'junk'; // invalid falls back to the default of 8 hours
  assert.equal(r.sh.autoCheck(), 0); // the rest are busy, tabbed or already home
  assert.deepEqual(r.sh.homeSessions().sort(), ['fresh', 'old']);
});

test('auto send home uses the transcript mtime when the tracker has no idle time, and clamps huge values', () => {
  const r = rig({ setting: 8 });
  r.sh.filter([main('a', { since: 0 })], [session('a', T0 - 9 * HOUR)]);
  assert.equal(r.sh.autoCheck(), 1);
  const r2 = rig({ setting: 1e9 }); // clamped to 720 hours
  r2.sh.filter([main('a', { since: T0 - 100 * HOUR })], []);
  assert.equal(r2.sh.autoCheck(), 0);
  r2.state.now += 700 * HOUR;
  assert.equal(r2.sh.autoCheck(), 1);
});

test('auto send home goes through the same path: office run stopped, tabs not touched', () => {
  const r = rig();
  r.sh.filter([main('a', { control: 'office', since: T0 - 9 * HOUR })], [session('a')]);
  assert.equal(r.sh.autoCheck(), 1);
  assert.deepEqual(r.stopped, ['a']);
});

test('the timer runs only while visible, once a minute, and stops on dispose', () => {
  const r = rig();
  r.sh.filter([main('a', { since: T0 - 9 * HOUR })], []);
  assert.equal(r.timers.length, 0);
  r.sh.setVisible(true);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]?.ms, 60_000);
  r.timers[0]?.fn();
  assert.deepEqual(r.sh.homeSessions(), ['a']);
  assert.equal(r.timers.length, 2);
  r.sh.setVisible(false);
  assert.equal(r.timers[1]?.cleared, true);
  r.timers[1]?.fn(); // a stale callback does nothing
  assert.equal(r.timers.length, 2);
  r.sh.setVisible(true);
  assert.equal(r.timers.length, 3);
  r.sh.dispose();
  assert.equal(r.timers[2]?.cleared, true);
});

test('demo mode bypasses everything', () => {
  const r = rig({ demo: true, stored: { v: 1, entries: [{ id: 'a', at: T0, mtimeMs: 1 }] } });
  const agents = [main('a', { since: 0 }), main('b', { since: T0 - 50 * HOUR })];
  assert.equal(r.sh.filter(agents, []), agents); // same list, nothing hidden
  assert.equal(r.sh.sendHome('b').ok, false);
  r.sh.onTabClosed('b');
  assert.equal(r.sh.autoCheck(), 0);
  r.sh.setVisible(true);
  r.timers[0]?.fn();
  assert.equal(r.saved.length, 0);
  assert.equal(r.stopped.length, 0);
  assert.equal(r.sh.homeSessions().length, 1); // the stored record is kept for when the demo ends
  r.state.demo = false;
  assert.deepEqual(r.sh.filter(agents, []).map((a) => a.id), ['b']);
});

test('persistence: a round trip restores the records', () => {
  const r = rig();
  r.sh.filter([main('a'), main('b')], [session('a', 5), session('b', 6)]);
  r.sh.sendHome('a');
  r.sh.sendHome('b');
  const r2 = rig({ stored: JSON.parse(JSON.stringify(r.state.stored)) });
  assert.deepEqual(r2.sh.homeSessions().sort(), ['a', 'b']);
  assert.deepEqual(r2.sh.filter([main('a'), main('b'), main('c')], [session('a', 5)]).map((a) => a.id), ['c']);
});

test('persistence: malformed stored values are dropped', () => {
  const bad: unknown[] = [undefined, null, 5, 'x', [], {}, { entries: 'no' }, { entries: [null, 1, 'a', [], {}] }];
  for (const b of bad) assert.equal(parseRecords(b, T0).size, 0);
  const mixed = parseRecords(
    {
      entries: [
        { id: 'ok', at: T0, mtimeMs: 10 },
        { id: '', at: T0, mtimeMs: 10 },
        { id: 7, at: T0, mtimeMs: 10 },
        { id: 'x'.repeat(201), at: T0, mtimeMs: 10 },
        { id: 'ctl\u0000', at: T0, mtimeMs: 10 },
        { id: 'nan', at: Number.NaN, mtimeMs: 10 },
        { id: 'inf', at: T0, mtimeMs: Infinity },
        { id: 'neg', at: -1, mtimeMs: 10 },
        { id: 'str', at: '1', mtimeMs: 10 },
        { id: 'nomtime', at: T0 },
        { id: 'dup', at: T0 - 5, mtimeMs: 1 },
        { id: 'dup', at: T0 - 1, mtimeMs: 2 },
      ],
    },
    T0,
  );
  assert.deepEqual([...mixed.keys()].sort(), ['dup', 'ok']);
  assert.deepEqual(mixed.get('dup'), { at: T0 - 1, mtimeMs: 2 });
  const r = rig({ stored: { entries: 'garbage' } });
  assert.equal(r.sh.homeSessions().length, 0);
});

test('persistence: records older than 30 days are pruned on load; the cap keeps the newest', () => {
  const old = parseRecords({ entries: [{ id: 'old', at: T0 - MAX_RECORD_AGE_MS - 1, mtimeMs: 1 }, { id: 'edge', at: T0 - MAX_RECORD_AGE_MS, mtimeMs: 1 }] }, T0);
  assert.deepEqual([...old.keys()], ['edge']);
  const entries = Array.from({ length: MAX_RECORDS + 40 }, (_, i) => ({ id: `s${i}`, at: T0 - 1000 + i, mtimeMs: 1 }));
  const capped = parseRecords({ entries }, T0);
  assert.equal(capped.size, MAX_RECORDS);
  assert.equal(capped.has('s0'), false);
  assert.equal(capped.has(`s${MAX_RECORDS + 39}`), true);
});

test('persistence: sending home past the cap evicts the oldest record; a failing store does not break it', () => {
  const entries = Array.from({ length: MAX_RECORDS }, (_, i) => ({ id: `s${i}`, at: T0 - 1000 + i, mtimeMs: 1 }));
  const r = rig({ stored: { entries } });
  r.sh.filter([main('new')], []);
  r.sh.sendHome('new');
  assert.equal(r.sh.homeSessions().length, MAX_RECORDS);
  assert.equal(r.sh.isHome('s0'), false);
  assert.equal(r.sh.isHome('new'), true);

  let calls = 0;
  const sh = new SentHome({
    storage: { get: () => undefined, set: () => { calls++; throw new Error('disk'); } },
    now: () => T0, readSetting: () => 8, isDemo: () => false, stopIfIdle: () => false, closeCaseTab: () => undefined,
    openCaseTabs: () => [], refresh: () => undefined, timers: { setTimeout: () => 0, clearTimeout: () => undefined }, log: () => undefined,
  });
  sh.filter([main('a')], []);
  assert.equal(sh.sendHome('a').ok, true);
  assert.equal(calls, 1);
  assert.equal(sh.isHome('a'), true);
});

test('logs carry session ids, counts and reasons only', () => {
  const r = rig();
  r.sh.filter([main('a', { title: 'Secret title', cwd: '/home/secret/path' })], [session('a')]);
  r.sh.sendHome('a');
  assert.ok(r.logs.length > 0);
  for (const line of r.logs) assert.doesNotMatch(line, /Secret|secret|\/home/);
});

test('a send home with a stale cached mtime does not bounce when the stop writes the transcript', () => {
  const r = rig();
  const agents = [main('a', { control: 'office' })];
  r.sh.filter(agents, [session('a', T0 - 18_000)]);
  assert.deepEqual(r.sh.sendHome('a'), { ok: true });
  r.state.now = T0 + 300;
  assert.equal(r.sh.filter(agents, [session('a', T0 + 55)]).length, 0);
  assert.deepEqual(r.sh.homeSessions(), ['a']);
  assert.deepEqual(r.state.stored, { v: 1, entries: [{ id: 'a', at: T0, mtimeMs: T0 + 55 }] }); // absorbed and saved
  assert.equal(r.logs.some((l) => l.includes('back at work')), false);
});

test('inside the settle window a busy worker still returns at once', () => {
  const r = rig();
  r.sh.filter([main('a')], [session('a', T0 - 18_000)]);
  r.sh.sendHome('a');
  r.state.now = T0 + 300;
  assert.equal(r.sh.filter([main('a', { status: 'working' })], [session('a', T0 + 55)]).length, 1);
  assert.equal(r.sh.isHome('a'), false);
});

test('after the settle window new activity is measured from the absorbed mtime', () => {
  const r = rig();
  const agents = [main('a')];
  r.sh.filter(agents, [session('a', T0 - 18_000)]);
  r.sh.sendHome('a');
  r.state.now = T0 + 300;
  assert.equal(r.sh.filter(agents, [session('a', T0 + SETTLE_MS - 100)]).length, 0); // absorbed
  assert.equal(r.sh.filter(agents, [session('a', T0 + SETTLE_MS + 1000)]).length, 0); // after the window, within the slop
  assert.equal(r.sh.filter(agents, [session('a', T0 + SETTLE_MS + 1000 + 2500)]).length, 1); // newer than the slop: back
  assert.equal(r.sh.isHome('a'), false);
});

test('a late first refresh does not bounce a write made right after the send home', () => {
  const r = rig();
  const agents = [main('a', { control: 'office' })];
  r.sh.filter(agents, [session('a', T0 - 18_000)]);
  r.sh.sendHome('a');
  r.state.now = T0 + 120_000; // the office was hidden; first refresh 2 minutes later
  assert.equal(r.sh.filter(agents, [session('a', T0 + 55)]).length, 0);
  assert.deepEqual(r.state.stored, { v: 1, entries: [{ id: 'a', at: T0, mtimeMs: T0 + 55 }] });
});

test('a write after the settle window returns the worker even when first seen late', () => {
  const r = rig();
  const agents = [main('a')];
  r.sh.filter(agents, [session('a', T0 - 18_000)]);
  r.sh.sendHome('a');
  r.state.now = T0 + 120_000;
  assert.equal(r.sh.filter(agents, [session('a', T0 + SETTLE_MS + 5000)]).length, 1);
  assert.equal(r.sh.isHome('a'), false);
});

test('an auto send home of an office run does not bounce either', () => {
  const r = rig();
  const agents = [main('a', { control: 'office', since: T0 - 9 * HOUR })];
  r.sh.filter(agents, [session('a', T0 - 18_000)]);
  assert.equal(r.sh.autoCheck(), 1);
  assert.deepEqual(r.stopped, ['a']);
  r.state.now = T0 + 300;
  assert.equal(r.sh.filter(agents, [session('a', T0 + 55)]).length, 0);
  assert.equal(r.sh.isHome('a'), true);
});

test('records loaded from storage older than the window behave as before', () => {
  const at = T0 - 10 * HOUR;
  const base = at + SETTLE_MS + 1000;
  const r = rig({ stored: { v: 1, entries: [{ id: 'a', at, mtimeMs: base }] } });
  const agents = [main('a')];
  assert.equal(r.sh.filter(agents, [session('a', base + 1500)]).length, 0); // within the slop
  assert.equal(r.sh.filter(agents, [session('a', base + 2500)]).length, 1); // beyond: back
});
