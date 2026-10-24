import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeFeed, agentsKey, resolveScope } from '../src/host/officeFeed.ts';
import type { FeedScope, TrackerLike, WatcherLike } from '../src/host/officeFeed.ts';
import type { AgentSnapshot, HostToWebview } from '../src/shared/protocol.ts';
import type { WatchUpdate } from '../src/claude/types.ts';

class FakeTime {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  timersApi = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.t + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown): void => void this.timers.delete(h as number),
  };
  get pending(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
    await new Promise((r) => setImmediate(r));
  }
}

function agent(id: string, activity: AgentSnapshot['activity'] = 'reading'): AgentSnapshot {
  return { id, kind: 'main', title: id, project: 'p', activity, status: 'working', since: 0, startedAt: 0 };
}

function setup(opts: { snapshot?: () => AgentSnapshot[]; pollThrows?: boolean } = {}) {
  const time = new FakeTime();
  const published: Array<{ at: number; agents: AgentSnapshot[] }> = [];
  const logs: string[] = [];
  const scopes: FeedScope[] = [];
  const state = { agents: [agent('a')] as AgentSnapshot[], polls: 0 };
  const feed = new OfficeFeed({
    createWatcher: (scope): WatcherLike => {
      scopes.push(scope);
      return {
        poll: async (): Promise<WatchUpdate> => {
          state.polls++;
          if (opts.pollThrows) throw new Error('boom');
          return { sessions: [], batches: [] } as unknown as WatchUpdate;
        },
      };
    },
    createTracker: (): TrackerLike => ({ apply() {}, snapshot: () => opts.snapshot?.() ?? state.agents }),
    publish: (m: HostToWebview) => {
      if (m.type === 'agents') published.push({ at: time.t, agents: m.agents });
    },
    now: () => time.t,
    timers: time.timersApi,
    log: (m) => logs.push(m),
    demo: { snapshot: (now) => [agent('demo-' + Math.floor(now / 1000))] },
  });
  return { feed, time, published, logs, scopes, state };
}

test('resolveScope', () => {
  assert.equal(resolveScope('all', ['/a']), 'all');
  assert.equal(resolveScope('workspace', []), 'all');
  assert.deepEqual(resolveScope('workspace', ['/a', '/b']), { workspaceDirs: ['/a', '/b'] });
});

test('agentsKey is order independent', () => {
  assert.equal(agentsKey([agent('a'), agent('b')]), agentsKey([agent('b'), agent('a')]));
});

test('nothing runs while hidden; becoming visible publishes immediately', async () => {
  const { feed, time, published, state } = setup();
  await time.advance(5000);
  assert.equal(published.length, 0);
  assert.equal(state.polls, 0);
  feed.setVisible(true);
  assert.equal(published.length, 1);
  await time.advance(2000);
  assert.ok(state.polls >= 3);
  feed.setVisible(false);
  const polls = state.polls;
  await time.advance(5000);
  assert.equal(state.polls, polls);
  assert.equal(time.pending, 0);
});

test('identical snapshots are deduplicated', async () => {
  const { feed, time, published } = setup();
  feed.setVisible(true);
  await time.advance(10_000);
  assert.equal(published.length, 1);
});

test('the model, effort, context, report and plan fields flow through unchanged and each change republishes', async () => {
  const { feed, time, published, state } = setup();
  const rich = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
    ...agent('a'),
    model: 'claude-opus-5-5',
    effort: 'high',
    context: { tokens: 50_000, max: 200_000, pct: 25, approx: true },
    lastReport: { at: 5, text: 'done' },
    plans: [{ id: 'toolu_P1', at: 3, title: 'Plan A', status: 'approved', chars: 10, decidedAt: 4 }],
    ...over,
  });
  state.agents = [rich()];
  feed.setVisible(true);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]!.agents, [rich()]);
  // The same content in a new object: no republish.
  state.agents = [rich()];
  await time.advance(2000);
  assert.equal(published.length, 1);
  // Each field's change is seen, including nested ones.
  const changes: Array<Partial<AgentSnapshot>> = [
    { model: 'claude-sonnet-5-5' },
    { effort: 'max' },
    { context: { tokens: 50_001, max: 200_000, pct: 25, approx: true } },
    { lastReport: { at: 6, text: 'done again' } },
    { plans: [{ id: 'toolu_P1', at: 3, title: 'Plan A', status: 'rejected', chars: 10, decidedAt: 4 }] },
  ];
  for (const [i, c] of changes.entries()) {
    state.agents = [rich(c)];
    await time.advance(1500);
    assert.equal(published.length, 2 + i, `change ${i} republished`);
    assert.deepEqual(published.at(-1)!.agents, [rich(c)]);
  }
});

test('reappearing republishes the current state immediately', async () => {
  const { feed, time, published } = setup();
  feed.setVisible(true);
  feed.setVisible(false);
  feed.setVisible(true);
  assert.equal(published.length, 2);
  await time.advance(1000);
});

test('throttles to 4 per second with trailing delivery of the latest state', async () => {
  let n = 0;
  const { feed, time, published } = setup({ snapshot: () => [agent('a', n % 2 ? 'reading' : 'writing'), agent('n' + n)] });
  feed.setVisible(true);
  assert.equal(published.length, 1);
  for (let i = 0; i < 5; i++) {
    n++;
    await time.advance(40);
  }
  // 200 ms in: changes happened but gap not yet reached, only the first publish so far.
  assert.equal(published.length, 1);
  await time.advance(1000);
  assert.equal(published.length, 2);
  assert.equal(published[1]!.agents.at(-1)!.id, 'n5');
  assert.ok(published[1]!.at - published[0]!.at >= 250);
  // Never more than 4 per rolling second.
  for (let i = 0; i < 40; i++) {
    n++;
    await time.advance(50);
  }
  for (let i = 0; i < published.length; i++) {
    const inWindow = published.filter((p) => p.at >= published[i]!.at && p.at < published[i]!.at + 1000).length;
    assert.ok(inWindow <= 4);
  }
});

test('poll errors are logged and polling continues', async () => {
  const { feed, time, logs, state } = setup({ pollThrows: true });
  feed.setVisible(true);
  await time.advance(2000);
  assert.ok(logs.some((l) => l.includes('boom')));
  assert.ok(state.polls >= 3);
});

test('scope change rebuilds the watcher', async () => {
  const { feed, time, scopes } = setup();
  feed.setVisible(true);
  await time.advance(600);
  feed.setScope({ workspaceDirs: ['/w'] });
  await time.advance(600);
  assert.deepEqual(scopes, ['all', { workspaceDirs: ['/w'] }]);
  feed.setScope({ workspaceDirs: ['/w'] });
  assert.equal(scopes.length, 2);
});

test('demo mode switches the source without polling', async () => {
  const { feed, time, published, state } = setup();
  feed.setVisible(true);
  await time.advance(1000);
  const polls = state.polls;
  feed.setDemo(true);
  await time.advance(3000);
  assert.equal(state.polls, polls);
  assert.ok(published.some((p) => p.agents[0]!.id.startsWith('demo-')));
  feed.setDemo(false);
  await time.advance(1000);
  assert.equal(published.at(-1)!.agents[0]!.id, 'a');
});

test('publisher exceptions never escape', async () => {
  const time = new FakeTime();
  const logs: string[] = [];
  const feed = new OfficeFeed({
    createWatcher: () => ({ poll: async () => ({ sessions: [], batches: [] }) as unknown as WatchUpdate }),
    createTracker: () => ({ apply() {}, snapshot: () => { throw new Error('snap'); } }),
    publish: () => { throw new Error('pub'); },
    now: () => time.t,
    timers: time.timersApi,
    log: (m) => logs.push(m),
  });
  feed.setVisible(true);
  await time.advance(2000);
  assert.ok(logs.length > 0);
  feed.dispose();
});

test('refreshNow publishes a changed snapshot at once, ignoring the throttle gap', async () => {
  const { feed, time, published, state } = setup();
  feed.setVisible(true);
  await time.advance(100); // first publish happened at t=0; the 250 ms gap is still running
  const n = published.length;
  state.agents = [agent('a', 'needsYou')];
  feed.refreshNow();
  assert.equal(published.length, n + 1);
  assert.equal(published.at(-1)!.agents[0]!.activity, 'needsYou');
  assert.equal(published.at(-1)!.at, time.t);
  feed.refreshNow(); // unchanged: nothing more
  assert.equal(published.length, n + 1);
  feed.dispose();
});

test('refreshNow does nothing while hidden or in demo mode', async () => {
  const { feed, published, state, time } = setup();
  state.agents = [agent('z')];
  feed.refreshNow();
  assert.equal(published.length, 0);
  feed.setVisible(true);
  feed.setDemo(true);
  await time.advance(600);
  const n = published.length;
  feed.refreshNow();
  assert.equal(published.length, n);
  feed.dispose();
});

test('latestSessions follows the watcher', async () => {
  const time = new FakeTime();
  const sess = [{ sessionId: 's1', transcriptPath: '/t/s1.jsonl', projectDir: '/t', mtimeMs: 1, subagents: [] }];
  const feed = new OfficeFeed({
    createWatcher: () => ({ poll: async () => ({ sessions: sess, batches: [] }) as unknown as WatchUpdate }),
    createTracker: () => ({ apply() {}, snapshot: () => [] }),
    publish: () => {},
    now: () => time.t,
    timers: time.timersApi,
    log: () => {},
  });
  assert.deepEqual(feed.latestSessions(), []);
  feed.setVisible(true);
  await time.advance(600);
  assert.equal(feed.latestSessions()[0]!.sessionId, 's1');
  feed.dispose();
});
