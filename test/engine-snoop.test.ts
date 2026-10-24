// The snooping boss: every 4-8 minutes, when free, he walks to the tile behind an agent who is working at its own seat,
// looks over its shoulder, says his line once and goes back to his desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../webview/engine/office.ts';
import { collectBubbles } from '../webview/engine/bubbles.ts';
import { ManagerBrain, SNOOP_EVERY_MAX_MS, SNOOP_EVERY_MIN_MS, SNOOP_HOLD_MS, SNOOP_LOOK_MS } from '../webview/engine/manager.ts';
import { BOSS_LINES, SNOOP_LINE } from '../webview/engine/lines.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import { feetTile, makeRng } from '../webview/engine/types.ts';
import type { SeatDef, Tile } from '../webview/engine/types.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const STEP = 33;
const MIN = 60_000;
/** The annex desks with a blocked tile behind them. */
const BLOCKED_BEHIND = ['temp-annex-1', 'temp-annex-2', 'temp-annex-3', 'temp-annex-4'];

const workers = (n: number) => Array.from({ length: n }, (_, i) => agent(`w${i}`, { activity: 'writing', startedAt: i }));
const longIdle = (id: string) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 60_000 });

function step(o: Office, t: number): number {
  t += STEP;
  o.update(t, STEP, HOST0 + t);
  return t;
}

/** Runs until `done()` (at most `ms`); returns the time. */
function runUntil(o: Office, t0: number, ms: number, done: () => boolean): number {
  let t = t0;
  for (let e = 0; e < ms && !done(); e += STEP) t = step(o, t);
  return t;
}

/** One snoop as seen from outside. */
interface Seen {
  id: string;
  seat: SeatDef;
  startedAt: number;
  endedAt: number | null;
  arrivedAt: number | null;
  stood: { tile: Tile; dir: string; pose: string } | null;
  sayAt: number | null;
  sayUntil: number | null;
  says: number;
  workingAtStart: boolean;
}

/** Runs the office for `ms` and writes down every snoop. */
function watch(o: Office, t0: number, ms: number): { seen: Seen[]; t: number } {
  const seen: Seen[] = [];
  let cur: Seen | null = null;
  let lastSay: unknown = null;
  let t = t0;
  for (let e = 0; e < ms; e += STEP) {
    t = step(o, t);
    const id = o.brain.snooping;
    const m = o.manager;
    if (id && !cur) {
      const c = o.chars.get(id)!;
      cur = {
        id, seat: c.seat!, startedAt: t, endedAt: null, arrivedAt: null, stood: null, sayAt: null, sayUntil: null, says: 0,
        workingAtStart: c.arrived && c.goal?.key === `seat:${c.seat!.id}` && c.agent!.activity !== 'idle',
      };
      seen.push(cur);
    }
    if (cur && m.arrived && m.goal?.key === `snoop:${cur.id}` && cur.arrivedAt === null) {
      cur.arrivedAt = t;
      cur.stood = { tile: feetTile(m.x, m.y), dir: m.dir, pose: m.pose };
    }
    if (m.say && m.say !== lastSay) {
      lastSay = m.say;
      if (m.say.text === SNOOP_LINE && cur) { cur.says++; cur.sayAt = t; cur.sayUntil = m.say.until; }
    }
    if (!id && cur) { cur.endedAt = t; cur = null; }
  }
  return { seen, t };
}

test('he snoops every 4-8 minutes, only on workers at their own seat, standing right behind them', () => {
  // No food cart, no IT crew: their visits (every 15-25 minutes) would delay a due snoop and blur the exact timing checked here.
  const o = new Office(world, { seed: 3, foodCart: false, itCrew: false });
  o.applySnapshot(workers(20), 0, HOST0);
  assert.equal([...o.chars.values()].filter((c) => c.seat).length, 20, 'every desk is taken');
  const { seen } = watch(o, 0, 2 * 60 * MIN);
  if (seen[seen.length - 1]!.endedAt === null) seen.pop(); // the window can end in the middle of a snoop
  assert.ok(seen.length >= 12, `${seen.length} snoops in two hours`);
  assert.ok(new Set(seen.map((s) => s.id)).size >= 6, 'different people');
  for (let i = 0; i < seen.length; i++) {
    const s = seen[i]!;
    assert.ok(s.workingAtStart, `${s.id} was working at its seat`);
    assert.ok(!BLOCKED_BEHIND.includes(s.seat.id), `${s.seat.id} has no room behind it`);
    assert.equal(o.routeMap.grid[(s.seat.tile.y - 1) * world.w + s.seat.tile.x], 1, 'the tile behind is walkable');
    assert.ok(s.arrivedAt !== null && s.stood, `${s.id}: he got there`);
    assert.deepEqual(s.stood.tile, { x: s.seat.tile.x, y: s.seat.tile.y - 1 }, 'directly behind the seat');
    assert.equal(s.stood.dir, 'down');
    assert.equal(s.stood.pose, 'stand');
    assert.equal(s.says, 1, 'one line per snoop');
    // He looks for SNOOP_LOOK_MS, speaks, holds for SNOOP_HOLD_MS, then leaves.
    assert.ok(s.sayAt! - s.arrivedAt >= SNOOP_LOOK_MS && s.sayAt! - s.arrivedAt <= SNOOP_LOOK_MS + 2 * STEP, `looked ${s.sayAt! - s.arrivedAt} ms`);
    assert.equal(s.sayUntil, s.sayAt! + SNOOP_HOLD_MS, 'the line shows for the hold');
    assert.ok(s.endedAt !== null && s.endedAt - s.sayAt! >= SNOOP_HOLD_MS && s.endedAt - s.sayAt! <= SNOOP_HOLD_MS + 2 * STEP);
    if (i > 0) {
      const gap = s.startedAt - seen[i - 1]!.startedAt;
      assert.ok(gap >= SNOOP_EVERY_MIN_MS && gap <= SNOOP_EVERY_MAX_MS + 2 * STEP, `${gap} ms between snoops`);
    }
  }
  assert.ok(seen[0]!.startedAt >= SNOOP_EVERY_MIN_MS && seen[0]!.startedAt <= SNOOP_EVERY_MAX_MS + 2 * STEP, 'the first one too');
});

test('he goes back to his desk afterwards', () => {
  const o = new Office(world, { seed: 4 });
  o.applySnapshot(workers(3), 0, HOST0);
  const { seen, t } = watch(o, 0, 9 * MIN);
  assert.equal(seen.length, 1);
  assert.equal(o.brain.snooping, null);
  const back = runUntil(o, t, 60_000, () => o.manager.arrived && o.manager.goal?.key === `seat:${o.managerSeat.id}`);
  assert.equal(o.manager.goal!.key, `seat:${o.managerSeat.id}`);
  assert.ok(back - t < 60_000);
});

test('idle, waiting and away agents are never snooped on', () => {
  const o = new Office(world, { seed: 5 });
  // The two workers start first, so they take the first desks of the middle band (with a free tile behind them).
  o.applySnapshot([
    agent('w', { activity: 'writing', startedAt: HOST0 - 70_000 }), agent('th', { activity: 'thinking', startedAt: HOST0 - 69_000 }),
    longIdle('idle'), agent('cab', { activity: 'searching' }), agent('plan', { activity: 'planning' }),
    agent('copy', { activity: 'copier' }), agent('del', { activity: 'delegating' }),
  ], 0, HOST0);
  const { seen } = watch(o, 0, 90 * MIN);
  assert.ok(seen.length >= 8);
  for (const s of seen) assert.ok(['w', 'th'].includes(s.id), `snooped on ${s.id}`);
  assert.ok(new Set(seen.map((s) => s.id)).size === 2, 'both workers get their turn');
});

test('with nobody working at a desk he just stays at his', () => {
  const o = new Office(world, { seed: 6 });
  o.applySnapshot([longIdle('a'), longIdle('b')], 0, HOST0);
  const { seen } = watch(o, 0, 60 * MIN);
  assert.equal(seen.length, 0);
});

test('with bossQuotes off he still looks, but says nothing', () => {
  const o = new Office(world, { seed: 7 });
  o.bossQuotes = false;
  o.applySnapshot(workers(4), 0, HOST0);
  let said = 0;
  let snooped = 0;
  let t = 0;
  for (let e = 0; e < 40 * MIN; e += STEP) {
    t = step(o, t);
    if (o.brain.snooping) snooped++;
    if (o.manager.say) said++;
  }
  assert.ok(snooped > 0, 'he did snoop');
  assert.equal(said, 0);
});

/** Runs until he is looking over `id`'s shoulder (arrived at the snoop goal, line not yet said). */
function untilLooking(o: Office, t0: number): number {
  const t = runUntil(o, t0, 12 * MIN, () => o.brain.snooping !== null && o.manager.arrived && o.manager.goal?.key.startsWith('snoop:') === true);
  assert.ok(o.brain.snooping, 'he is snooping');
  return t;
}

test('a knock at the door interrupts a snoop: no line, and he does not go back to it', () => {
  const o = new Office(world, { seed: 8 });
  o.applySnapshot(workers(4), 0, HOST0);
  let t = untilLooking(o, 0);
  const snoopId = o.brain.snooping!;
  o.applySnapshot([...workers(4), agent('k', { activity: 'needsYou', status: 'waiting', since: HOST0 + t })], t, HOST0 + t);
  t = step(o, t);
  assert.equal(o.brain.snooping, null);
  assert.equal(o.manager.goal!.key, 'mgr:door');
  let line = false;
  t = runUntil(o, t, 20_000, () => { if (o.manager.say?.text === SNOOP_LINE) line = true; return false; });
  assert.equal(line, false, 'no line after being interrupted');
  // The knocker is let in (idle now): he goes back to his desk and the snoop is not resumed.
  o.applySnapshot([...workers(4), longIdle('k')], t, HOST0 + t);
  t = runUntil(o, t, 20_000, () => o.manager.arrived && o.manager.goal?.key === `seat:${o.managerSeat.id}`);
  assert.equal(o.manager.goal!.key, `seat:${o.managerSeat.id}`);
  assert.equal(o.brain.snooping, null);
  assert.notEqual(snoopId, null);
});

test('a prompt visit interrupts a snoop', () => {
  const o = new Office(world, { seed: 9 });
  const list = (prompt: number) => workers(4).map((a, i) => (i === 0 ? { ...a, lastPromptAt: prompt } : a));
  o.applySnapshot(list(HOST0 - 3_600_000), 0, HOST0);
  let t = runUntil(o, 0, 12 * MIN, () => o.brain.snooping !== null && o.brain.snooping !== 'w0');
  const target = o.brain.snooping!;
  assert.ok(target && target !== 'w0');
  o.applySnapshot(list(HOST0 + t), t, HOST0 + t);
  t = step(o, t);
  assert.equal(o.brain.snooping, null);
  assert.equal(o.manager.goal!.key, 'visit:w0');
  let line = false;
  t = runUntil(o, t, 40_000, () => { if (o.manager.say?.text === SNOOP_LINE) line = true; return o.manager.arrived && o.manager.goal?.key === `seat:${o.managerSeat.id}`; });
  assert.equal(line, false);
  assert.equal(o.brain.snooping, null, 'not resumed');
});

test('a snoop on someone who leaves is cancelled on the spot', () => {
  const o = new Office(world, { seed: 10 });
  o.applySnapshot(workers(4), 0, HOST0);
  let t = untilLooking(o, 0);
  const gone = o.brain.snooping!;
  o.applySnapshot(workers(4).filter((a) => a.id !== gone), t, HOST0 + t);
  assert.equal(o.brain.snooping, null, 'cancelled by the snapshot itself');
  t = runUntil(o, t, 20_000, () => o.manager.arrived && o.manager.goal?.key === `seat:${o.managerSeat.id}`);
  assert.equal(o.manager.goal!.key, `seat:${o.managerSeat.id}`);
  let line = false;
  runUntil(o, t, 10_000, () => { if (o.manager.say?.text === SNOOP_LINE) line = true; return false; });
  assert.equal(line, false);
});

test('a snoop on someone who stops working is dropped before the line', () => {
  const o = new Office(world, { seed: 11 });
  o.applySnapshot(workers(4), 0, HOST0);
  let t = untilLooking(o, 0);
  const id = o.brain.snooping!;
  o.applySnapshot(workers(4).map((a) => (a.id === id ? { ...a, activity: 'idle' as const, status: 'idle' as const, since: HOST0 + t } : a)), t, HOST0 + t);
  t = step(o, t);
  assert.equal(o.brain.snooping, null);
  assert.notEqual(o.manager.say?.text, SNOOP_LINE);
});

// ---------------------------------------------------------------------------------------------------------------------
// The brain on its own

function brainCtx(o: Office, list: () => { id: string; seat: SeatDef }[], extra: object = {}) {
  const spot = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };
  return {
    me: o.manager, seat: o.managerSeat, spots: o.spots, queueLength: 0, rng: makeRng(2), grid: o.routeMap.grid, w: world.w, h: world.h,
    sulk: { spot }, targetOf: () => null, workers: list, ...extra,
  };
}

test('ManagerBrain: a blocked tile behind a seat rules it out; a free one is used', () => {
  const o = new Office(world, { seed: 12 });
  const seat = (id: string) => world.seats.find((s) => s.id === id)!;
  const blocked = new ManagerBrain(makeRng(1));
  const cb = brainCtx(o, () => [{ id: 'x', seat: seat('temp-annex-1') }]);
  for (let t = 0; t <= 20 * MIN; t += 1_000) {
    const d = blocked.decide(cb, t);
    assert.equal(blocked.snooping, null);
    assert.equal(d.goal.key, `seat:${o.managerSeat.id}`);
  }
  const free = new ManagerBrain(makeRng(1));
  const cf = brainCtx(o, () => [{ id: 'x', seat: seat('desk-cat') }]);
  let started = -1;
  for (let t = 0; t <= 20 * MIN && started < 0; t += 1_000) {
    const d = free.decide(cf, t);
    if (free.snooping) { started = t; assert.equal(d.goal.key, 'snoop:x'); assert.deepEqual(d.goal.tile, { x: 4, y: 13 }); assert.equal(d.goal.facing, 'down'); assert.equal(d.goal.pose, 'stand'); }
  }
  assert.ok(started >= SNOOP_EVERY_MIN_MS && started <= SNOOP_EVERY_MAX_MS + 1_000, `started at ${started}`);
});

test('ManagerBrain: the door and visits come first, sulking and a missing worker list rule snooping out', () => {
  const o = new Office(world, { seed: 13 });
  const cat = world.seats.find((s) => s.id === 'desk-cat')!;
  const list = () => [{ id: 'x', seat: cat }];
  // Door: due, but someone is knocking, so he stays on door duty; once it clears, he goes.
  const b = new ManagerBrain(makeRng(1));
  const knocked = brainCtx(o, list, { queueLength: 1 });
  for (let t = 0; t <= 10 * MIN; t += 1_000) assert.equal(b.decide(knocked, t).goal.key, 'mgr:door');
  assert.equal(b.snooping, null);
  assert.equal(b.decide(brainCtx(o, list), 10 * MIN + 1_000).goal.key, 'snoop:x', 'due as soon as he is free');
  // A queued visit wins over a snoop, and cancels the one under way.
  b.queueVisit('v');
  const visit = brainCtx(o, list, { targetOf: (id: string) => (id === 'v' ? { tile: { x: 20, y: 12 }, seatVisit: null } : null) });
  assert.equal(b.decide(visit, 10 * MIN + 2_000).goal.key, 'visit:v');
  assert.equal(b.snooping, null);
  // Sulking: never.
  const s = new ManagerBrain(makeRng(1));
  s.setSulking(true, true);
  for (let t = 0; t <= 20 * MIN; t += 1_000) assert.equal(s.decide(brainCtx(o, list), t).goal.key, 'mgr:sulk');
  // No worker list (as in older callers): never.
  const n = new ManagerBrain(makeRng(1));
  for (let t = 0; t <= 20 * MIN; t += 1_000) assert.equal(n.decide(brainCtx(o, list, { workers: undefined }), t).goal.key, `seat:${o.managerSeat.id}`);
});

test('ManagerBrain: drop(id) cancels a snoop on that agent only', () => {
  const o = new Office(world, { seed: 14 });
  const cat = world.seats.find((s) => s.id === 'desk-cat')!;
  const b = new ManagerBrain(makeRng(1));
  const c = brainCtx(o, () => [{ id: 'x', seat: cat }]);
  let t = 0;
  while (!b.snooping && t < 20 * MIN) b.decide(c, (t += 1_000));
  assert.equal(b.snooping, 'x');
  b.drop('other');
  assert.equal(b.snooping, 'x');
  b.drop('x');
  assert.equal(b.snooping, null);
});

test('the snooped worker\'s bubbles stay down while he stands behind them, and come back when he leaves', () => {
  const o = new Office(world, { seed: 8 });
  o.applySnapshot(workers(4), 0, HOST0);
  const bubbles = (t: number) => collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: true, managerName: 'You' }, t).filter((r) => r.type !== 'label' && r.charId !== o.manager.id);
  let t = runUntil(o, 0, 12 * MIN, () => o.brain.snooping !== null);
  const id = o.brain.snooping!;
  // While he walks over, everyone still has a bubble.
  assert.ok(bubbles(t).some((r) => r.charId === id), 'bubble while he is on his way');
  t = untilLooking(o, t);
  const during = bubbles(t);
  assert.ok(!during.some((r) => r.charId === id), 'no bubble on the snooped worker');
  assert.equal(new Set(during.map((r) => r.charId)).size, 3, 'the other three keep theirs');
  t = runUntil(o, t, 20_000, () => o.brain.snooping === null && !o.manager.goal?.key.startsWith('snoop:'));
  assert.ok(bubbles(t).some((r) => r.charId === id), 'the bubble is back once he has left');
});
