import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilePoller } from '../src/host/filePoller.ts';

function harness(opts: { maxBytes?: number } = {}) {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  const state = { mtime: 1, size: 3, text: 'abc', missing: false, statCalls: 0, reads: 0, active: 0, maxActive: 0, gate: undefined as Promise<void> | undefined };
  const seen: (string | undefined)[] = [];
  const poller = new FilePoller(
    {
      stat: async () => {
        state.statCalls++;
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          if (state.gate) await state.gate;
          if (state.missing) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
          return { mtimeMs: state.mtime, size: state.size };
        } finally {
          state.active--;
        }
      },
      readFile: async () => {
        state.reads++;
        return state.text;
      },
      timers: {
        setTimeout: (fn, ms) => {
          const id = nextId++;
          timers.push({ id, fn, ms });
          return id;
        },
        clearTimeout: (h) => {
          const i = timers.findIndex((t) => t.id === h);
          if (i >= 0) timers.splice(i, 1);
        },
      },
    },
    { path: '/f', intervalMs: 5000, onChange: (t) => seen.push(t), ...opts },
  );
  const tick = async () => {
    const t = timers.shift();
    assert.ok(t, 'a timer is pending');
    t.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
  return { poller, timers, state, seen, tick };
}

test('polls only while started, reports first text, then changes only', async () => {
  const h = harness();
  assert.equal(h.timers.length, 0);
  h.poller.start();
  h.poller.start();
  assert.equal(h.timers.length, 1);
  await h.tick();
  assert.deepEqual(h.seen, ['abc']);
  assert.equal(h.timers[0]?.ms, 5000);
  await h.tick();
  assert.deepEqual(h.seen, ['abc']);
  assert.equal(h.state.reads, 1);
  h.state.mtime = 2;
  h.state.text = 'abcd';
  await h.tick();
  assert.deepEqual(h.seen, ['abc', 'abcd']);
  h.state.size = 99; // size alone counts as a change
  await h.tick();
  assert.equal(h.seen.length, 3);
});

test('stop cancels the timer and drops an in-flight read', async () => {
  const h = harness();
  h.poller.start();
  let release!: () => void;
  h.state.gate = new Promise<void>((r) => (release = r));
  const t = h.timers.shift()!;
  t.fn();
  await Promise.resolve();
  h.poller.stop();
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.seen, []);
  assert.equal(h.timers.length, 0);
  h.poller.stop();
  // restart re-checks and reports
  h.state.gate = undefined;
  h.poller.start();
  await h.tick();
  assert.deepEqual(h.seen, ['abc']);
});

test('never overlaps stats or reads even with a slow stat', async () => {
  const h = harness();
  h.poller.start();
  let release!: () => void;
  h.state.gate = new Promise<void>((r) => (release = r));
  const t = h.timers.shift()!;
  t.fn();
  await Promise.resolve();
  assert.equal(h.timers.length, 0, 'next poll is not scheduled until this one finishes');
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.timers.length, 1);
  assert.equal(h.state.maxActive, 1);
});

test('missing file reports undefined once, then the text when it returns', async () => {
  const h = harness();
  h.state.missing = true;
  h.poller.start();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.seen, [undefined]);
  h.state.missing = false;
  await h.tick();
  assert.deepEqual(h.seen, [undefined, 'abc']);
  h.state.missing = true;
  await h.tick();
  assert.deepEqual(h.seen, [undefined, 'abc', undefined]);
});

test('maxBytes skips an oversized file without reading it', async () => {
  const h = harness({ maxBytes: 2 });
  h.poller.start();
  await h.tick();
  await h.tick();
  assert.equal(h.state.reads, 0);
  assert.deepEqual(h.seen, []);
});

test('a throwing onChange does not stop polling', async () => {
  const h = harness();
  const logs: string[] = [];
  const timersRef = h.timers;
  void timersRef;
  const p = new FilePoller(
    {
      stat: async () => ({ mtimeMs: 1, size: 1 }),
      readFile: async () => 'x',
      timers: { setTimeout: (fn, ms) => { h.timers.push({ id: 99, fn, ms }); return 99; }, clearTimeout: () => {} },
      log: (m) => logs.push(m),
    },
    { path: '/f', intervalMs: 10, onChange: () => { throw new Error('boom'); } },
  );
  p.start();
  await h.tick();
  assert.equal(h.timers.length, 1);
  assert.ok(logs.some((l) => l.includes('boom')));
});
