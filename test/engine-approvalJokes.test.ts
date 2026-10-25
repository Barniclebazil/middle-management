// Approving a plan, a command or an edit sends the manager to that desk with a two-beat line: praise, then the
// confession that he didn't read it. The brain times the beats; the office decides when a visit is worth it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_JOKE_COOLDOWN_MS, Office } from '../webview/engine/office.ts';
import { APPROVAL_BEAT_MS, ManagerBrain, VISIT_TALK_MS } from '../webview/engine/manager.ts';
import type { ManagerCtx } from '../webview/engine/manager.ts';
import { BOSS_LINES, COMMAND_APPROVED_PAIRS, EDIT_APPROVED_PAIRS, PLAN_APPROVED_PAIRS } from '../webview/engine/lines.ts';
import { makeRng } from '../webview/engine/types.ts';
import type { ApprovalKind } from '../src/shared/protocol.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const POOLS = { plan: PLAN_APPROVED_PAIRS, command: COMMAND_APPROVED_PAIRS, edit: EDIT_APPROVED_PAIRS };
const MIN = 60_000;

// ---------------------------------------------------------------- the brain

const SPOT = { tile: { x: 20, y: 12 }, facing: 'down' as const };

/** A context for visits to 'a' (standing at a fixed spot); `me` is moved by `arrive`. */
function ctx(o: Office): ManagerCtx {
  const sulk = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };
  return {
    me: o.manager, seat: o.managerSeat, spots: o.spots, queueLength: 0, rng: makeRng(2), grid: o.routeMap.grid, w: world.w, h: world.h,
    sulk: { spot: sulk }, targetOf: (id) => (id === 'a' ? { tile: SPOT.tile, seatVisit: SPOT } : null),
  };
}

/** Decides, then lets him arrive at whatever goal he was given (so the next decide starts the talk). */
function arrive(b: ManagerBrain, c: ManagerCtx, t: number) {
  const d = b.decide(c, t);
  c.me.arrived = true;
  c.me.goal = d.goal;
  return d;
}

/** Starts a visit and returns the time the talk began. */
function startTalk(b: ManagerBrain, c: ManagerCtx, t: number) {
  arrive(b, c, t);
  return b.decide(c, t + 100);
}

test('queueVisit: a queued prompt visit upgrades to an approval; everything else is deduped', () => {
  const b = new ManagerBrain();
  b.queueVisit('a');
  b.queueVisit('b', 'edit');
  assert.deepEqual(b.pending, [{ id: 'a', reason: 'prompt' }, { id: 'b', reason: 'edit' }]);
  b.queueVisit('a', 'plan');
  assert.deepEqual(b.pending[0], { id: 'a', reason: 'plan' }, 'upgraded in place, keeping its turn');
  b.queueVisit('a');
  b.queueVisit('b', 'command');
  b.queueVisit('a', 'edit');
  assert.deepEqual(b.pending, [{ id: 'a', reason: 'plan' }, { id: 'b', reason: 'edit' }], 'an approval is never replaced');
  assert.ok(b.isQueued('a') && b.isQueued('b') && !b.isQueued('c'));
  b.drop('a');
  assert.deepEqual(b.pending, [{ id: 'b', reason: 'edit' }]);
});

test('queueVisit: no second visit while one to that agent is under way', () => {
  const o = new Office(world, { seed: 1 });
  const b = new ManagerBrain();
  const c = ctx(o);
  b.queueVisit('a');
  b.decide(c, 0);
  assert.equal(b.visit?.id, 'a');
  b.queueVisit('a', 'plan');
  assert.deepEqual(b.pending, []);
});

for (const kind of ['plan', 'command', 'edit'] as const) {
  test(`an approval visit (${kind}) says the praise, then the confession, once each, from its own pool`, () => {
    const o = new Office(world, { seed: 1 });
    const b = new ManagerBrain();
    const c = ctx(o);
    b.queueVisit('a', kind);
    const out = arrive(b, c, 0);
    assert.equal(out.say, undefined, 'nothing said on the way');
    const start = 1_000;
    const first = b.decide(c, start);
    assert.equal(first.say !== undefined, true);
    assert.equal(first.sayMs, APPROVAL_BEAT_MS);
    assert.equal(first.goal.key, 'visit:a');
    const pair = POOLS[kind].find((p) => p[0] === first.say);
    assert.ok(pair, 'the praise is from the pool');
    // Quiet until the second beat starts.
    for (let t = start + 100; t < start + APPROVAL_BEAT_MS; t += 100) {
      const d = b.decide(c, t);
      assert.equal(d.say, undefined, `silent at +${t - start}`);
      assert.equal(d.goal.key, 'visit:a');
    }
    const second = b.decide(c, start + APPROVAL_BEAT_MS);
    assert.equal(second.say, pair[1]);
    assert.equal(second.sayMs, APPROVAL_BEAT_MS);
    // Said once: the rest of the talk is silent, and then he is done.
    for (let t = start + APPROVAL_BEAT_MS + 100; t < start + 2 * APPROVAL_BEAT_MS; t += 100) {
      const d = b.decide(c, t);
      assert.equal(d.say, undefined);
      assert.equal(d.goal.key, 'visit:a', 'still talking');
    }
    const end = b.decide(c, start + 2 * APPROVAL_BEAT_MS);
    assert.equal(end.goal.key, `seat:${o.managerSeat.id}`);
    assert.equal(b.visiting, false);
  });
}

test('approval visits deal from a deck per pool: no pair repeats until the pool has been used', () => {
  const o = new Office(world, { seed: 1 });
  const b = new ManagerBrain();
  const c = ctx(o);
  const seen = new Set<string>();
  let t = 0;
  for (let i = 0; i < POOLS.command.length; i++) {
    b.queueVisit('a', 'command');
    c.me.arrived = false;
    c.me.goal = null;
    const d = startTalk(b, c, (t += 20_000));
    seen.add(d.say!);
    for (let e = 200; e <= 6_000; e += 100) b.decide(c, t + e); // the talk is over
  }
  assert.equal(seen.size, new Set(POOLS.command.map((p) => p[0])).size);
});

test('a prompt visit is unchanged: one boss line, the usual talk time, no sayMs', () => {
  const o = new Office(world, { seed: 1 });
  const b = new ManagerBrain();
  const c = ctx(o);
  b.queueVisit('a');
  arrive(b, c, 0);
  const d = b.decide(c, 1_000);
  assert.ok(BOSS_LINES.includes(d.say as string));
  assert.equal(d.sayMs, undefined);
  for (let t = 1_100; t < 1_000 + VISIT_TALK_MS; t += 100) {
    const x = b.decide(c, t);
    assert.equal(x.say, undefined);
    assert.equal(x.goal.key, 'visit:a');
  }
  assert.equal(b.decide(c, 1_000 + VISIT_TALK_MS).goal.key, `seat:${o.managerSeat.id}`);
});

test('an upgraded visit speaks the approval pair, not a boss line', () => {
  const o = new Office(world, { seed: 1 });
  const b = new ManagerBrain();
  const c = ctx(o);
  b.queueVisit('a');
  b.queueVisit('a', 'edit');
  arrive(b, c, 0);
  const d = b.decide(c, 1_000);
  assert.ok(EDIT_APPROVED_PAIRS.some((p) => p[0] === d.say));
  assert.equal(d.sayMs, APPROVAL_BEAT_MS);
});

// ---------------------------------------------------------------- the office

const approved = (kind: ApprovalKind, at: number) => agent('a', { activity: 'writing', lastApproval: { at, kind } });

/** An office with agent 'a' seen once, whose old approval is ignored. */
function seeded() {
  const o = new Office(world, { seed: 3 });
  o.bossQuotes = true;
  o.applySnapshot([approved('plan', HOST0 - 50_000)], 0, HOST0);
  return o;
}

/** Sends a snapshot at office time `t` (host clock = HOST0 + t) and tells whether a visit to 'a' was queued by it. */
function approve(o: Office, kind: ApprovalKind, t: number): boolean {
  o.brain.drop('a');
  o.applySnapshot([approved(kind, HOST0 + t)], t, HOST0 + t);
  return o.brain.isQueued('a');
}

test('office: a newer approval queues a visit of its kind; the first snapshot and a repeat do not', () => {
  const o = new Office(world, { seed: 3 });
  o.bossQuotes = true;
  o.applySnapshot([approved('edit', HOST0 - 1_000)], 0, HOST0);
  assert.deepEqual(o.brain.pending, [], 'approvals on the first message are ignored');
  o.applySnapshot([approved('edit', HOST0 - 1_000)], 100, HOST0 + 100);
  assert.deepEqual(o.brain.pending, [], 'the same approval is not new');
  o.applySnapshot([approved('command', HOST0 + 500)], 600, HOST0 + 600);
  assert.deepEqual(o.brain.pending, [{ id: 'a', reason: 'command' }]);
  o.applySnapshot([approved('command', HOST0 + 500)], 700, HOST0 + 700);
  assert.equal(o.brain.pending.length, 1);
});

test('office: a new agent counts only if its approval is fresh', () => {
  const stale = new Office(world, { seed: 3 });
  stale.bossQuotes = true;
  stale.applySnapshot([agent('x')], 0, HOST0);
  stale.applySnapshot([agent('x'), approved('plan', HOST0 - 5 * MIN)], 100, HOST0 + 100);
  assert.deepEqual(stale.brain.pending, []);
  const fresh = new Office(world, { seed: 3 });
  fresh.bossQuotes = true;
  fresh.applySnapshot([agent('x')], 0, HOST0);
  fresh.applySnapshot([agent('x'), approved('plan', HOST0 - 5_000)], 100, HOST0 + 100);
  assert.deepEqual(fresh.brain.pending, [{ id: 'a', reason: 'plan' }]);
});

test('office: the approval makes the manager walk to the desk and say both beats', () => {
  const o = seeded();
  o.applySnapshot([approved('command', HOST0 + 900)], 900, HOST0 + 900);
  const said: string[] = [];
  let last: unknown = null;
  for (let t = 900; t < 900 + 40_000; t += 33) {
    o.update(t, 33, HOST0 + t);
    if (o.manager.say && o.manager.say !== last) said.push(o.manager.say.text);
    last = o.manager.say;
  }
  assert.equal(said.length, 2);
  const pair = COMMAND_APPROVED_PAIRS.find((p) => p[0] === said[0]);
  assert.ok(pair);
  assert.equal(said[1], pair[1]);
  assert.equal(o.manager.goal!.key, `seat:${o.managerSeat.id}`);
});

test('office: commands and edits joke at most once per cooldown per agent; plans ignore it', () => {
  const o = seeded();
  assert.equal(approve(o, 'command', 1_000), true);
  assert.equal(approve(o, 'edit', 1_000 + MIN), false, 'within the cooldown, whatever the kind');
  assert.equal(approve(o, 'plan', 1_000 + 2 * MIN), true, 'a plan always counts');
  assert.equal(approve(o, 'command', 1_000 + APPROVAL_JOKE_COOLDOWN_MS - 1), false);
  assert.equal(approve(o, 'edit', 1_000 + APPROVAL_JOKE_COOLDOWN_MS), true, 'after the cooldown');
  assert.equal(approve(o, 'command', 1_000 + APPROVAL_JOKE_COOLDOWN_MS + MIN), false, 'and the cooldown starts again');
});

test('office: the cooldown is per agent, and a plan does not start it', () => {
  const o = seeded();
  assert.equal(approve(o, 'plan', 1_000), true);
  assert.equal(approve(o, 'command', 2_000), true, 'the plan did not use up the cooldown');
  o.applySnapshot([approved('command', HOST0 + 3_000), agent('b', { lastApproval: { at: HOST0 - 50_000, kind: 'edit' } })], 3_000, HOST0 + 3_000);
  o.applySnapshot([approved('command', HOST0 + 3_000), agent('b', { lastApproval: { at: HOST0 + 3_500, kind: 'edit' } })], 3_500, HOST0 + 3_500);
  assert.ok(o.brain.isQueued('b'), 'another agent has its own cooldown');
});

test('office: with the boss quotes off nothing is queued, and the approval is still counted as seen', () => {
  const o = seeded();
  o.bossQuotes = false;
  assert.equal(approve(o, 'plan', 1_000), false);
  assert.equal(approve(o, 'command', 2_000), false);
  o.bossQuotes = true;
  o.applySnapshot([approved('command', HOST0 + 2_000)], 3_000, HOST0 + 3_000);
  assert.equal(o.brain.isQueued('a'), false, 'not replayed when the quotes come back');
  assert.equal(approve(o, 'command', 4_000), true, 'and the cooldown was not used up while off');
});

test('office: no visit for an agent that is leaving; a gone agent is forgotten', () => {
  const o = seeded();
  o.applySnapshot([{ ...approved('plan', HOST0 + 1_000), kind: 'temp', parentId: 'p', status: 'done' }], 1_000, HOST0 + 1_000);
  assert.equal(o.brain.isQueued('a'), false);
  o.applySnapshot([], 2_000, HOST0 + 2_000);
  o.applySnapshot([approved('plan', HOST0 - 10 * MIN)], 3_000, HOST0 + 3_000);
  assert.equal(o.brain.isQueued('a'), false, 'back as a new agent with an old approval: ignored');
});
