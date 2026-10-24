import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoFeed, LOOP_MS, TEMP_LINGER_MS } from '../src/demo/demoFeed.ts';
import { ACTIVITIES } from '../src/shared/protocol.ts';

const demo = new DemoFeed();
const BASE = Math.floor(1_800_000_000_000 / LOOP_MS) * LOOP_MS;
const at = (s: number) => demo.snapshot(BASE + s * 1000);

test('every Activity appears within one loop', () => {
  const seen = new Set<string>();
  for (let s = 0; s < 120; s += 0.5) for (const a of at(s)) seen.add(a.activity);
  for (const act of ACTIVITIES) assert.ok(seen.has(act), `missing ${act}`);
});

test('six staff, temps reference existing mains', () => {
  for (let s = 0; s < 120; s += 1) {
    const agents = at(s);
    const mains = agents.filter((a) => a.kind === 'main');
    assert.equal(mains.length, 6);
    for (const t of agents.filter((a) => a.kind === 'temp')) {
      assert.ok(t.parentId && mains.some((m) => m.id === t.parentId), `orphan temp ${t.id}`);
    }
  }
});

test('temps appear, finish as done, and vanish 10 s later', () => {
  const temps = (s: number) => at(s).filter((a) => a.kind === 'temp');
  assert.equal(temps(10).length, 0);
  assert.equal(temps(30).length, 2);
  assert.ok(temps(30).every((t) => t.status === 'working'));
  const t1 = (s: number) => temps(s).find((t) => t.id === 'demo-5-t1');
  assert.equal(t1(47)?.status, 'done');
  assert.equal(t1(46 + TEMP_LINGER_MS / 1000 - 0.5)?.status, 'done');
  assert.equal(t1(46 + TEMP_LINGER_MS / 1000 + 0.5), undefined);
  assert.equal(temps(100).length, 0);
});

test('ids and startedAt stay stable; output is deterministic and loops', () => {
  const first = new Map(at(0).map((a) => [a.id, a.startedAt]));
  for (let s = 1; s < 120; s++) {
    for (const a of at(s)) if (a.kind === 'main') assert.equal(a.startedAt, first.get(a.id));
  }
  assert.deepEqual(at(33), at(33));
  const next = demo.snapshot(BASE + LOOP_MS + 33_000).map((a) => a.id);
  assert.deepEqual(next, at(33).map((a) => a.id));
});

test('at least two agents need the manager at the same time', () => {
  assert.ok(at(85).filter((a) => a.activity === 'needsYou').length >= 2);
});

test('two staff are idle for over 20 s at the same moment', () => {
  const idle = at(85).filter((a) => a.activity === 'idle');
  assert.ok(idle.length >= 2);
  assert.ok(idle.every((a) => 85_000 + BASE - a.since > 20_000));
});

test('lastPromptAt moves at different times and never exceeds now', () => {
  const changes = new Set<string>();
  let prev = at(0);
  for (let s = 1; s < 120; s++) {
    const cur = at(s);
    cur.forEach((a, i) => {
      assert.ok((a.lastPromptAt ?? 0) <= BASE + s * 1000);
      if (a.kind === 'main' && a.lastPromptAt !== prev[i]?.lastPromptAt && prev[i]?.id === a.id) changes.add(`${a.id}@${s}`);
    });
    prev = cur;
  }
  assert.ok(changes.size >= 5);
});

test('drawing, planning, copier and shredding stretches exist', () => {
  assert.ok(at(45).some((a) => a.activity === 'drawing'));
  assert.ok(at(10).some((a) => a.activity === 'planning'));
  assert.ok(at(40).some((a) => a.activity === 'copier'));
  assert.ok(at(95).some((a) => a.activity === 'shredding'));
});
