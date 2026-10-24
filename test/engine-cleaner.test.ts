// The cleaner: one non-agent character who comes in from the elevator to wipe vacated desks (and, on a round every 10-15
// minutes, an empty desk or two, the kitchen counter or the bin), mutters to themselves and goes back out of sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charTile, newChar } from '../webview/engine/characters.ts';
import {
  ARRIVE_MAX_MS, ARRIVE_MIN_MS, CLEANER_ID, CLEANER_LOOK_ID, CLEAN_MAX_MS, CLEAN_MIN_MS, CleanerBrain, MUTTER_FIRST_MAX_MS, MUTTER_FIRST_MIN_MS,
  MUTTER_GAP_MAX_MS, MUTTER_GAP_MIN_MS, MUTTER_MS, PATROL_MAX_MS, PATROL_MIN_MS, WAIT_MAX_MS,
} from '../webview/engine/cleaner.ts';
import type { CleanerCtx, CleanerDecision } from '../webview/engine/cleaner.ts';
import { collectBubbles } from '../webview/engine/bubbles.ts';
import { CLEANER_MUTTERS } from '../webview/engine/lines.ts';
import { Office } from '../webview/engine/office.ts';
import { buildSpots } from '../webview/engine/targets.ts';
import { cleanerTooltip, rosterEntries } from '../webview/engine/tooltip.ts';
import { tileFeet } from '../webview/engine/types.ts';
import type { SeatDef, Tile } from '../webview/engine/types.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const STEP = 33;
const SEC = 1_000;
const MIN = 60_000;
const spots = buildSpots(world);
const desks = world.seats.filter((s) => s.owner !== 'manager' && s.owner !== 'reception');
const ELEVATOR = tileFeet(spots.elevator.tile, world.tile);

// ---------------------------------------------------------------------------
// The brain on its own: a stub office where the cleaner arrives the moment they get a goal.

interface Stub {
  ctx: CleanerCtx;
  me: ReturnType<typeof newChar>;
  /** Seats someone has. */
  held: Set<string>;
  /** Tiles someone stands on (by `x,y`). */
  taken: Set<string>;
  bubbles: { on: boolean };
}

function stub(): Stub {
  const me = newChar(CLEANER_ID, 'cleaner', CLEANER_LOOK_ID, null, ELEVATOR.x, ELEVATOR.y, 0);
  const held = new Set<string>();
  const taken = new Set<string>();
  const bubbles = { on: true };
  const ctx: CleanerCtx = {
    me, spots, seats: desks,
    seatEmpty: (s) => !held.has(s.id),
    free: (tile) => !taken.has(`${tile.x},${tile.y}`),
    get speechBubbles() { return bubbles.on; },
  };
  return { ctx, me, held, taken, bubbles };
}

/** Plays a decision into the stub character: the goal is reached at once. */
function apply(s: Stub, d: CleanerDecision, t: number): void {
  const f = tileFeet(d.goal.tile, world.tile);
  s.me.x = f.x;
  s.me.y = f.y;
  s.me.goal = d.goal;
  s.me.arrived = true;
  s.me.arrivedAt = t;
  s.me.pose = d.goal.pose;
  s.me.dir = d.goal.facing;
}

/** What one run of the brain looked like from outside. */
interface Trace {
  /** Every decision: the time and the decision (null while off-stage). */
  ds: { t: number; d: CleanerDecision | null }[];
  /** Times they came in. */
  entries: number[];
  /** Times they went out. */
  exits: number[];
  says: { t: number; text: string }[];
}

/** Runs the brain at 100 ms steps from `from` to `until`; `each` may poke the stub or queue desks (called before every decide). */
function drive(b: CleanerBrain, s: Stub, from: number, until: number, each?: (t: number) => void): Trace {
  const tr: Trace = { ds: [], entries: [], exits: [], says: [] };
  let was = false;
  for (let t = from; t <= until; t += 100) {
    each?.(t);
    const d = b.decide(s.ctx, t);
    if (d) {
      if (!was) tr.entries.push(t);
      apply(s, d, t);
      if (d.say) tr.says.push({ t, text: d.say.text });
    } else if (was) {
      tr.exits.push(t);
      s.me.goal = null;
    }
    was = d !== null;
    tr.ds.push({ t, d });
  }
  return tr;
}

const seatById = (id: string): SeatDef => desks.find((x) => x.id === id)!;

test('off-stage until a desk is vacated; then they come in 8-20 s later', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const b = new CleanerBrain(seed);
    const s = stub();
    const tr0 = drive(b, s, 0, 120_000);
    assert.equal(tr0.entries.length, 0, 'nobody comes in unasked');
    assert.equal(b.onStage, false);
    b.noteDirty(desks[0]!.id, 120_000);
    const tr = drive(b, s, 120_000, 240_000);
    assert.equal(tr.entries.length, 1);
    const wait = tr.entries[0]! - 120_000;
    assert.ok(wait >= ARRIVE_MIN_MS && wait <= ARRIVE_MAX_MS + 100, `seed ${seed}: came in after ${wait} ms`);
    assert.equal(tr.exits.length, 1, 'and went out again');
  }
});

test('a desk: walk to its visit tile, face the seat, wipe 5.5-6.5 s, then back to the elevator and out', () => {
  const b = new CleanerBrain(3);
  const s = stub();
  const seat = seatById('desk-cat');
  b.noteDirty(seat.id, 0);
  const tr = drive(b, s, 0, 60_000);
  const wipes = tr.ds.filter((x) => x.d?.goal.key === `clean:${seat.id}`);
  assert.ok(wipes.length > 0);
  const g = wipes[0]!.d!.goal;
  assert.deepEqual(g.tile, seat.visit.tile);
  assert.equal(g.facing, seat.visit.facing);
  assert.equal(g.pose, 'wipe');
  assert.equal(g.away, true);
  const ms = wipes[wipes.length - 1]!.t - wipes[0]!.t;
  // The goal is held while walking (instant here) and while wiping.
  assert.ok(ms >= CLEAN_MIN_MS - 100 && ms <= CLEAN_MAX_MS + 200, `wiped for ${ms} ms`);
  const exit = tr.ds.find((x) => x.d?.goal.key === 'clean:exit')!;
  assert.deepEqual(exit.d!.goal.tile, spots.elevator.tile);
  assert.equal(tr.exits.length, 1);
  assert.equal(b.onStage, false);
  assert.ok(tr.exits[0]! > exit.t);
});

test('queued desks are cleaned in turn, once each, by the one cleaner', () => {
  const b = new CleanerBrain(4);
  const s = stub();
  const ids = ['desk-cat', 'desk-hr', 'temp-annex-2', 'desk-cat', 'temp-annex-2'];
  ids.forEach((id, i) => b.noteDirty(id, i * 500));
  const tr = drive(b, s, 3_000, 200_000);
  const order: string[] = [];
  for (const { d } of tr.ds) {
    const k = d?.goal.key;
    if (k?.startsWith('clean:') && k !== 'clean:exit' && k !== 'clean:wait' && order[order.length - 1] !== k) order.push(k);
  }
  assert.deepEqual([...order].sort(), ['clean:desk-cat', 'clean:desk-hr', 'clean:temp-annex-2']);
  assert.equal(tr.entries.length, 1, 'one visit for all of them');
  assert.equal(tr.exits.length, 1);
});

test('a desk someone sat down at again before they got there is skipped', () => {
  const b = new CleanerBrain(5);
  const s = stub();
  b.noteDirty('desk-cat', 0);
  b.noteDirty('desk-hr', 0);
  s.held.add('desk-cat');
  const tr = drive(b, s, 0, 120_000);
  const keys = new Set(tr.ds.map((x) => x.d?.goal.key));
  assert.ok(!keys.has('clean:desk-cat'), 'taken again before they came in');
  assert.ok(keys.has('clean:desk-hr'), 'the other one is done');
  // Taken again while they wipe the first one: the second is skipped.
  const b2 = new CleanerBrain(5);
  const s2 = stub();
  b2.noteDirty('desk-cat', 0);
  b2.noteDirty('desk-hr', 0);
  let first: string | null = null;
  const tr2 = drive(b2, s2, 0, 120_000, () => {
    const k = s2.me.goal?.key;
    if (!first && k?.startsWith('clean:desk-')) {
      first = k.slice('clean:'.length);
      s2.held.add(first === 'desk-cat' ? 'desk-hr' : 'desk-cat');
    }
  });
  const done = [...new Set(tr2.ds.map((x) => x.d?.goal.key).filter((k) => k?.startsWith('clean:desk-')))];
  assert.deepEqual(done, [`clean:${first}`], 'only the first');
  // Everything taken again before they come in: they never come in.
  const b3 = new CleanerBrain(5);
  const s3 = stub();
  b3.noteDirty('desk-cat', 0);
  s3.held.add('desk-cat');
  assert.equal(drive(b3, s3, 0, 60_000).entries.length, 0, 'nothing to do: they stay out');
});

test('a desk taken while they walk to it is dropped, and the next job is done', () => {
  const b = new CleanerBrain(6);
  const s = stub();
  b.noteDirty('desk-cat', 0);
  b.noteDirty('desk-hr', 0);
  // The stub reaches goals at once, so take the first desk the moment it is chosen but before they "arrive".
  let first: string | null = null;
  const tr = drive(b, s, 0, 120_000, () => {
    const g = s.me.goal;
    if (!first && g && g.key.startsWith('clean:desk')) {
      first = g.key.slice('clean:'.length);
      // They are mid-walk: not yet arrived.
      s.me.arrived = false;
      s.held.add(first);
    }
  });
  const keys = tr.ds.map((x) => x.d?.goal.key);
  assert.ok(first);
  const other = first === 'desk-cat' ? 'desk-hr' : 'desk-cat';
  assert.ok(keys.includes(`clean:${other}`), 'the other desk was cleaned');
  // Wiping never started on the taken one: its goal shows up on one decision only (the one that chose it).
  assert.equal(keys.filter((k) => k === `clean:${first}`).length, 1);
});

test('a tile someone else is on: they wait, take another job meanwhile, and give up after 12 s', () => {
  const b = new CleanerBrain(7);
  const s = stub();
  const v = seatById('desk-cat').visit.tile;
  s.taken.add(`${v.x},${v.y}`);
  b.noteDirty('desk-cat', 0);
  b.noteDirty('desk-hr', 0);
  const tr = drive(b, s, 0, 120_000);
  const keys = tr.ds.map((x) => x.d?.goal.key);
  assert.ok(keys.includes('clean:desk-hr'), 'the free desk is cleaned first');
  assert.ok(!keys.includes('clean:desk-cat'), 'the blocked one is never walked to');
  assert.ok(keys.includes('clean:wait'));
  assert.equal(tr.exits.length, 1, 'and they go home in the end');
  const w = tr.ds.filter((x) => x.d?.goal.key === 'clean:wait');
  assert.ok(w[w.length - 1]!.t - w[0]!.t <= WAIT_MAX_MS + 200, 'waited about 12 s at most');

  // Freed in time: they do it.
  const b2 = new CleanerBrain(7);
  const s2 = stub();
  s2.taken.add(`${v.x},${v.y}`);
  b2.noteDirty('desk-cat', 0);
  // Freed after four seconds of waiting.
  let waitingSince: number | null = null;
  const tr2 = drive(b2, s2, 0, 120_000, (t) => {
    if (s2.me.goal?.key === 'clean:wait') waitingSince ??= t;
    if (waitingSince !== null && t - waitingSince >= 4_000) s2.taken.clear();
  });
  const keys2 = tr2.ds.map((x) => x.d?.goal.key);
  assert.ok(keys2.includes('clean:wait') && keys2.includes('clean:desk-cat'));
});

test('a patrol round: first 10-15 min in, then every 10-15 min; 1-2 jobs among empty desks, the kitchen counter and the bin', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const b = new CleanerBrain(seed);
    const s = stub();
    const tr = drive(b, s, 0, 80 * MIN);
    assert.ok(tr.entries.length >= 5, `seed ${seed}: ${tr.entries.length} rounds in 80 min`);
    assert.ok(tr.entries[0]! >= PATROL_MIN_MS && tr.entries[0]! <= PATROL_MAX_MS + 100, `seed ${seed}: first round at ${tr.entries[0]}`);
    for (let i = 1; i < tr.entries.length; i++) {
      // Rounds start 10-15 min apart (they are in and out within a minute or two).
      const gap = tr.entries[i]! - tr.entries[i - 1]!;
      assert.ok(gap >= PATROL_MIN_MS - 2 * MIN && gap <= PATROL_MAX_MS + 2 * MIN, `seed ${seed}: gap ${gap}`);
    }
    // What they cleaned each time: 1-2 distinct jobs.
    const visits: string[][] = [];
    let cur: string[] | null = null;
    for (const { d } of tr.ds) {
      if (!d) { cur = null; continue; }
      if (!cur) { cur = []; visits.push(cur); }
      const k = d.goal.key;
      if (k.startsWith('clean:') && k !== 'clean:exit' && k !== 'clean:wait' && cur[cur.length - 1] !== k) cur.push(k);
    }
    for (const v of visits) {
      assert.ok(v.length >= 1 && v.length <= 2, `seed ${seed}: ${v.join()}`);
      for (const k of v) assert.ok(k === 'clean:counter' || k === 'clean:bin' || k.startsWith('clean:desk-') || k.startsWith('clean:temp-'), k);
    }
  }
});

test('patrol only picks desks that are empty, and falls back to the counter or the bin when none is', () => {
  const b = new CleanerBrain(9);
  const s = stub();
  for (const d of desks) s.held.add(d.id);
  const tr = drive(b, s, 0, 120 * MIN);
  const keys = new Set(tr.ds.map((x) => x.d?.goal.key).filter((k) => k && k !== 'clean:exit' && k !== 'clean:wait'));
  assert.ok(keys.size > 0);
  for (const k of keys) assert.ok(k === 'clean:counter' || k === 'clean:bin', `${k}`);
  assert.ok(keys.has('clean:counter') && keys.has('clean:bin'));
});

test('the kitchen counter and the bin: the tiles in front of them, held by reservation (the same keys the workers use)', () => {
  const b = new CleanerBrain(10);
  const s = stub();
  const tr = drive(b, s, 0, 240 * MIN);
  const counter = tr.ds.find((x) => x.d?.goal.key === 'clean:counter')!.d!.goal;
  assert.ok(counter.reserve === 'idle:microwave' || counter.reserve === 'idle:coffee');
  assert.deepEqual(counter.tile, spots.idle.find((n) => n.key === counter.reserve)!.spot.tile);
  assert.equal(counter.pose, 'wipe');
  const bin = tr.ds.find((x) => x.d?.goal.key === 'clean:bin')!.d!.goal;
  assert.equal(bin.reserve, 'shredder:0');
  assert.deepEqual(bin.tile, spots.shredder[0]!.spot.tile);
  assert.equal(bin.pose, 'wipe');
  // A busy microwave: the coffee maker's tile instead.
  const mw = spots.idle.find((n) => n.key === 'idle:microwave')!.spot.tile;
  const b2 = new CleanerBrain(10);
  const s2 = stub();
  s2.taken.add(`${mw.x},${mw.y}`);
  const tr2 = drive(b2, s2, 0, 240 * MIN);
  const c2 = tr2.ds.find((x) => x.d?.goal.key === 'clean:counter')!.d!.goal;
  assert.equal(c2.reserve, 'idle:coffee');
});

test('mutters: the first 3-6 s after coming in, then every 12-20 s; none while off-stage; none with speech bubbles off', () => {
  for (const seed of [1, 2, 3, 4]) {
    const b = new CleanerBrain(seed);
    const s = stub();
    let n = 0;
    const tr = drive(b, s, 0, 3 * 60 * MIN, (t) => {
      // A desk every 20 s keeps them in the office a long time.
      if (t % 20_000 === 0 && t > 0 && t < 30 * MIN) b.noteDirty(desks[n++ % desks.length]!.id, t);
    });
    assert.ok(tr.says.length > 20, `seed ${seed}: ${tr.says.length} mutters`);
    for (const m of tr.says) assert.ok(CLEANER_MUTTERS.includes(m.text), m.text);
    // Off-stage there is no decision, so nothing is said there: every mutter was in a decision made on stage.
    assert.ok(tr.ds.some((x) => x.d === null), 'they were off-stage some of the time');
    const first = tr.says[0]!.t - tr.entries[0]!;
    assert.ok(first >= MUTTER_FIRST_MIN_MS - 100 && first <= MUTTER_FIRST_MAX_MS + 100, `first mutter ${first} ms after coming in`);
    // Within one visit the gaps are 12-20 s.
    for (let i = 1; i < tr.says.length; i++) {
      const gap = tr.says[i]!.t - tr.says[i - 1]!.t;
      const sameVisit = tr.ds.filter((x) => x.t > tr.says[i - 1]!.t && x.t < tr.says[i]!.t).every((x) => x.d !== null);
      if (sameVisit) assert.ok(gap >= MUTTER_GAP_MIN_MS - 100 && gap <= MUTTER_GAP_MAX_MS + 100, `gap ${gap}`);
    }
    for (const m of tr.says) {
      const at = tr.ds.find((x) => x.t === m.t)!;
      assert.equal(at.d!.say!.ms, MUTTER_MS);
    }
  }
  const b = new CleanerBrain(1);
  const s = stub();
  s.bubbles.on = false;
  b.noteDirty(desks[0]!.id, 0);
  b.noteDirty(desks[1]!.id, 0);
  b.noteDirty(desks[2]!.id, 0);
  assert.equal(drive(b, s, 0, 5 * MIN).says.length, 0, 'speech bubbles off: no mutters');
});

test('mutters never repeat until the whole pool of 64 has been used', () => {
  assert.equal(new Set(CLEANER_MUTTERS).size, CLEANER_MUTTERS.length);
  for (const seed of [1, 2, 3]) {
    const b = new CleanerBrain(seed);
    const s = stub();
    let n = 0;
    const tr = drive(b, s, 0, 6 * 60 * MIN, (t) => {
      if (t % 15_000 === 0 && t < 120 * MIN) b.noteDirty(desks[n++ % desks.length]!.id, t);
    });
    const texts = tr.says.map((x) => x.text);
    assert.ok(texts.length >= CLEANER_MUTTERS.length * 2, `${texts.length} mutters`);
    const pool = CLEANER_MUTTERS.length;
    for (let r = 0; r + pool <= texts.length; r += pool) {
      assert.equal(new Set(texts.slice(r, r + pool)).size, pool, `seed ${seed}: round ${r / pool} dealt every line once`);
    }
    for (let i = 1; i < texts.length; i++) assert.notEqual(texts[i], texts[i - 1]);
  }
});

test('a normal 2-hour session does not use up the 64 mutters (a round every 10-15 min, a departure every 8 min)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const b = new CleanerBrain(seed);
    const s = stub();
    let n = 0;
    const tr = drive(b, s, 0, 120 * MIN, (t) => {
      if (t % (8 * MIN) === 0 && t > 0) b.noteDirty(desks[n++ % desks.length]!.id, t);
    });
    assert.ok(tr.says.length < CLEANER_MUTTERS.length, `seed ${seed}: ${tr.says.length} mutters in 2 h`);
  }
});

test('deterministic for a seed (and different seeds differ)', () => {
  const trace = (seed: number): string => {
    const b = new CleanerBrain(seed);
    const s = stub();
    b.noteDirty('desk-cat', 1_000);
    const tr = drive(b, s, 0, 40 * MIN);
    return tr.ds.map((x) => `${x.t}:${x.d?.goal.key ?? '-'}:${x.d?.say?.text ?? ''}`).join('|');
  };
  assert.equal(trace(7), trace(7));
  assert.notEqual(trace(7), trace(8));
});

// ---------------------------------------------------------------------------
// In the office

/** Steps the office; `each` sees every step. Returns the time. */
function run(o: Office, t0: number, ms: number, each?: (t: number) => void): number {
  let t = t0;
  for (let e = 0; e < ms; e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    each?.(t);
  }
  return t;
}

/** Steps until `done()` (checked after every step), at most `ms`; returns the time. */
function until(o: Office, t0: number, ms: number, done: () => boolean, each?: (t: number) => void): number {
  let t = t0;
  for (let e = 0; e < ms && !done(); e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    each?.(t);
  }
  return t;
}

const cleaners = (o: Office) => o.allChars().filter((c) => c.kind === 'cleaner');

test('the cleaner is the art look, and off-stage they are not part of the office at all', () => {
  const looks: string = new URL('../webview/art/looks.ts', import.meta.url).href;
  return import(looks).then((m) => {
    assert.equal(CLEANER_LOOK_ID, m.CLEANER_LOOK);
    const o = new Office(world, { seed: 1 });
    o.applySnapshot([agent('a'), agent('b')], 0, HOST0);
    run(o, 0, 5_000);
    assert.equal(o.cleanerOnStage, false);
    assert.equal(cleaners(o).length, 0);
    assert.ok(!o.allChars().includes(o.cleaner));
    assert.equal(o.hitTest(ELEVATOR.x, ELEVATOR.y - 8), null, 'not hit-testable');
    assert.equal(o.chars.has(CLEANER_ID), false);
    assert.equal(o.cleaner.look, 'cleaner');
    assert.equal(o.cleaner.kind, 'cleaner');
  });
});

test('an agent leaves: within 8-20 s the cleaner steps out of the elevator, wipes that desk for about 6 s, and leaves', () => {
  const o = new Office(world, { seed: 1 });
  o.applySnapshot([agent('a', { startedAt: 1 }), agent('b', { startedAt: 2 }), agent('c', { startedAt: 3 })], 0, HOST0);
  let t = run(o, 0, 5_000);
  const seat = o.chars.get('c')!.seat!;
  assert.ok(seat);
  o.applySnapshot([agent('a', { startedAt: 1 }), agent('b', { startedAt: 2 })], t, HOST0 + t);
  assert.ok(o.chars.get('c')!.leaving);
  t = until(o, t, 60_000, () => !o.chars.has('c'), () => assert.equal(o.cleanerOnStage, false, 'not before the desk is free'));
  assert.ok(!o.chars.has('c'));
  const gone = t;

  t = until(o, t, 25_000, () => o.cleanerOnStage);
  assert.ok(o.cleanerOnStage);
  const waited = t - gone;
  assert.ok(waited >= ARRIVE_MIN_MS - STEP && waited <= ARRIVE_MAX_MS + 2 * STEP, `came in after ${waited} ms`);
  assert.ok(o.allChars().includes(o.cleaner));
  assert.equal(cleaners(o).length, 1);
  const c = o.cleaner;
  assert.ok(Math.abs(c.x - ELEVATOR.x) < 6 && Math.abs(c.y - ELEVATOR.y) < 6, 'steps out of the elevator');
  assert.equal(c.removed, false);
  assert.ok(o.hitTest(c.x, c.y - 8) === c, 'hit-testable now');

  // Walks to the desk's visit tile, faces the seat and wipes.
  t = until(o, t, 60_000, () => c.arrived && c.pose === 'wipe', () => assert.ok(cleaners(o).length <= 1));
  assert.equal(c.pose, 'wipe');
  assert.deepEqual(charTile(c, world.tile), seat.visit.tile);
  assert.equal(c.dir, seat.visit.facing);
  assert.equal(c.goal!.key, `clean:${seat.id}`);
  const wipeStart = t;
  t = until(o, t, 12_000, () => c.pose !== 'wipe');
  const wiped = t - wipeStart;
  assert.ok(wiped >= CLEAN_MIN_MS - 3 * STEP && wiped <= CLEAN_MAX_MS + 3 * STEP, `wiped for ${wiped} ms`);

  // Back to the elevator and out of sight.
  assert.equal(c.goal!.key, 'clean:exit');
  t = until(o, t, 120_000, () => !o.cleanerOnStage);
  assert.equal(o.cleanerOnStage, false);
  assert.equal(cleaners(o).length, 0);
  assert.ok(Math.abs(c.x - ELEVATOR.x) < 2 && Math.abs(c.y - ELEVATOR.y) < 2, 'out at the elevator');
  assert.equal(o.hitTest(c.x, c.y - 8), null);
  assert.equal(o.res.held(c.id), undefined, 'holds no reservation off-stage');
});

test('several leave at once: one cleaner does all their desks in turn', () => {
  const o = new Office(world, { seed: 2 });
  const stay = [agent('a', { startedAt: 1 }), agent('b', { startedAt: 2 })];
  const go = [agent('x', { startedAt: 3 }), agent('y', { startedAt: 4 }), agent('z', { startedAt: 5 })];
  o.applySnapshot([...stay, ...go], 0, HOST0);
  let t = run(o, 0, 3_000);
  const seats = go.map((g) => o.chars.get(g.id)!.seat!.id);
  assert.equal(new Set(seats).size, 3);
  o.applySnapshot(stay, t, HOST0 + t);
  const wiped: string[] = [];
  let maxAtOnce = 0;
  let entries = 0;
  let was = false;
  const c = o.cleaner;
  t = run(o, t, 4 * MIN, () => {
    const on = o.cleanerOnStage;
    maxAtOnce = Math.max(maxAtOnce, cleaners(o).length);
    if (on && !was) entries++;
    was = on;
    const k = c.goal?.key;
    if (on && c.arrived && c.pose === 'wipe' && k && wiped[wiped.length - 1] !== k) wiped.push(k);
  });
  assert.deepEqual([...wiped].sort(), seats.map((id) => `clean:${id}`).sort(), 'every desk once');
  assert.equal(maxAtOnce, 1, 'never more than one cleaner');
  assert.ok(entries >= 1 && entries <= 2, `${entries} visits`);
  assert.equal(o.cleanerOnStage, false, 'and out again');
});

test('a desk someone sits at again before the cleaner gets there is skipped, and they stay out', () => {
  const o = new Office(world, { seed: 3 });
  o.applySnapshot([agent('b')], 0, HOST0);
  let t = run(o, 0, 3_000);
  const seat = o.chars.get('b')!.seat!;
  o.applySnapshot([], t, HOST0 + t);
  t = until(o, t, 60_000, () => !o.chars.has('b'));
  assert.ok(!o.chars.has('b'));
  // A new arrival takes the free desk at once.
  o.applySnapshot([agent('n', { startedAt: HOST0 })], t, HOST0 + t);
  assert.equal(o.chars.get('n')!.seat!.id, seat.id, 'the new worker has the same desk');
  let seen = false;
  run(o, t, 2 * MIN, () => { if (o.cleanerOnStage) seen = true; });
  assert.equal(seen, false, 'nothing left to clean');
});

test('a desk vacated by a move to a better one is cleaned too', () => {
  const o = new Office(world, { seed: 4 });
  const SONNET = 'claude-sonnet-4-5';
  const OPUS = 'claude-opus-4-6';
  o.applySnapshot([agent('a', { model: SONNET }), agent('b', { model: SONNET })], 0, HOST0);
  let t = run(o, 0, 3_000);
  const old = o.chars.get('a')!.seat!;
  o.applySnapshot([agent('a', { model: OPUS }), agent('b', { model: SONNET })], t, HOST0 + t);
  const now = o.chars.get('a')!.seat!;
  assert.notEqual(now.id, old.id, 'a moved desks');
  assert.ok(![...o.chars.values()].some((c) => c.id !== 'a' && c.seat?.id === old.id), 'and nobody took the old one');
  const keys = new Set<string>();
  t = run(o, t, 60_000, () => { if (o.cleanerOnStage && o.cleaner.goal) keys.add(o.cleaner.goal.key); });
  assert.ok(keys.has(`clean:${old.id}`), [...keys].join());
});

test('a round with no departures: the cleaner comes in 10-15 min after the start and does 1-2 jobs, then leaves', () => {
  for (const seed of [1, 2]) {
    const o = new Office(world, { seed });
    o.applySnapshot([agent('a'), agent('b')], 0, HOST0);
    const jobs: string[] = [];
    let first: number | null = null;
    let t = 0;
    let wasIn = false;
    let out: number | null = null;
    t = run(o, 0, 16 * MIN, (now) => {
      const on = o.cleanerOnStage;
      if (on && first === null) first = now;
      if (!on && wasIn && out === null) out = now;
      wasIn = on;
      const k = o.cleaner.goal?.key;
      if (on && k?.startsWith('clean:') && k !== 'clean:exit' && k !== 'clean:wait' && jobs[jobs.length - 1] !== k) jobs.push(k);
    });
    assert.ok(first !== null && first >= PATROL_MIN_MS && first <= PATROL_MAX_MS + 1_000, `seed ${seed}: in at ${first}`);
    assert.ok(jobs.length >= 1 && jobs.length <= 2, `seed ${seed}: ${jobs.join()}`);
    assert.ok(out !== null, 'and out again');
    assert.equal(cleaners(o).length, 0);
    void t;
  }
});

test('mutters show as a speech bubble above the cleaner, only with speech bubbles on', () => {
  const tryIt = (bubbles: boolean): { says: string[]; bubbled: string[]; offStage: number } => {
    const o = new Office(world, { seed: 5 });
    o.speechBubbles = bubbles;
    o.applySnapshot([agent('a'), agent('x')], 0, HOST0);
    let t = run(o, 0, 3_000);
    o.applySnapshot([agent('a')], t, HOST0 + t);
    const says: string[] = [];
    const bubbled: string[] = [];
    let offStage = 0;
    run(o, t, 2 * MIN, (now) => {
      const c = o.cleaner;
      if (!o.cleanerOnStage) { if (c.say) offStage++; return; }
      if (c.say && says[says.length - 1] !== c.say.text) says.push(c.say.text);
      const reqs = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: bubbles, managerName: 'You' }, now, o.receptionist, o.cleaner);
      for (const r of reqs) if (r.charId === c.id) bubbled.push(r.text ?? '');
    });
    return { says, bubbled, offStage };
  };
  const on = tryIt(true);
  assert.ok(on.says.length >= 1, 'at least one mutter during a visit');
  for (const m of on.says) assert.ok(CLEANER_MUTTERS.includes(m), m);
  assert.ok(on.bubbled.length > 0 && on.bubbled.every((x) => on.says.includes(x)));
  assert.equal(on.offStage, 0, 'nothing said off-stage');
  const off = tryIt(false);
  assert.equal(off.says.length, 0);
  assert.equal(off.bubbled.length, 0);
  // Even a say that is set is hidden when the setting is off (and the bubble has no name label).
  const o = new Office(world, { seed: 5 });
  o.cleaner.say = { text: 'Crumbs. Always crumbs.', until: 1e9 };
  const mk = (speechBubbles: boolean) => collectBubbles([], o.manager, [], { speechBubbles, managerName: 'You', highlightId: o.cleaner.id }, 0, o.receptionist, o.cleaner);
  assert.ok(mk(true).some((r) => r.charId === o.cleaner.id && r.type === 'text'));
  assert.ok(!mk(true).some((r) => r.charId === o.cleaner.id && r.type === 'label'), 'no name label');
  assert.ok(!mk(false).some((r) => r.charId === o.cleaner.id));
  assert.ok(!collectBubbles([], o.manager, [], { speechBubbles: true, managerName: 'You' }, 0, o.receptionist).some((r) => r.charId === o.cleaner.id), 'not passed in: no bubble');
});

test('the cleaner is not in the door queue, the roster, the boss\'s snoop or the seating, and a visit changes nobody else', () => {
  const o = new Office(world, { seed: 6 });
  const staff = [agent('a', { startedAt: 1 }), agent('b', { startedAt: 2 }), agent('q', { startedAt: 3, activity: 'needsYou', status: 'waiting' }), agent('x', { startedAt: 4 })];
  o.applySnapshot(staff, 0, HOST0);
  let t = run(o, 0, 3_000);
  const seatsBefore = new Map(['a', 'b', 'q'].map((id) => [id, o.chars.get(id)!.seat!.id]));
  o.applySnapshot(staff.filter((a) => a.id !== 'x'), t, HOST0 + t);
  let visits = 0;
  t = run(o, t, 3 * MIN, () => {
    if (o.cleanerOnStage) visits++;
    assert.ok(!o.queueIds.includes(o.cleaner.id), 'never in the door queue');
    assert.ok(!o.chars.has(CLEANER_ID), 'never an agent');
    assert.equal(o.assigner.get(CLEANER_ID), undefined, 'never seated by the assigner');
    assert.ok(!o.assigner.ids().includes(CLEANER_ID));
    assert.ok(!rosterEntries(o, HOST0 + t).some((r) => r.id === CLEANER_ID), 'not on the roster');
    for (const [id, seat] of seatsBefore) assert.equal(o.chars.get(id)!.seat!.id, seat, `${id} keeps their desk`);
    assert.deepEqual(o.queueIds, ['q']);
    assert.equal(o.res.holder(o.cleaner.goal?.reserve ?? 'none') === undefined || o.cleanerOnStage, true);
  });
  assert.ok(visits > 0, 'the cleaner came in');
  assert.ok(!o.brain.visiting || o.brain.visit?.id !== CLEANER_ID);
  assert.ok(!o.brain.pending.includes(CLEANER_ID));
});

test('the cleaner never stands on a tile the boss or a worker is on or heading for', () => {
  const o = new Office(world, { seed: 7 });
  o.applySnapshot([agent('a'), agent('x')], 0, HOST0);
  let t = run(o, 0, 2_000);
  o.applySnapshot([agent('a')], t, HOST0 + t);
  const c = o.cleaner;
  let wiping = 0;
  run(o, t, 3 * MIN, () => {
    if (!o.cleanerOnStage || !c.arrived || c.pose !== 'wipe') return;
    wiping++;
    const here = charTile(c, world.tile);
    for (const other of [o.manager, o.receptionist, ...o.chars.values()]) {
      const f = charTile(other, world.tile);
      assert.ok(f.x !== here.x || f.y !== here.y, `${other.id} is on the cleaner's tile`);
    }
  });
  assert.ok(wiping > 0);
});

test('the kitchen counter and the bin held by someone else\'s reservation are left alone', () => {
  const o = new Office(world, { seed: 8 });
  o.applySnapshot([agent('a')], 0, HOST0);
  o.res.take('idle:microwave', 'p1');
  o.res.take('idle:coffee', 'p2');
  o.res.take('shredder:0', 'p3');
  const keys = new Set<string>();
  run(o, 0, 16 * MIN, () => { if (o.cleanerOnStage && o.cleaner.goal) keys.add(o.cleaner.goal.key); });
  assert.ok(keys.size > 0, 'the round happened');
  assert.ok(!keys.has('clean:counter') && !keys.has('clean:bin'), [...keys].join());
  assert.equal(o.res.holder('idle:microwave'), 'p1');
  assert.equal(o.res.holder('shredder:0'), 'p3');
});

test('at the counter and the bin the cleaner holds the workers\' reservation keys while they wipe', () => {
  let seen = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const o = new Office(world, { seed });
    o.applySnapshot([agent('a')], 0, HOST0);
    run(o, 0, 16 * MIN, () => {
      const k = o.cleaner.goal?.key;
      if (!o.cleanerOnStage || !o.cleaner.arrived || (k !== 'clean:counter' && k !== 'clean:bin')) return;
      seen++;
      assert.equal(o.res.holder(o.cleaner.goal!.reserve!), o.cleaner.id);
      assert.equal(o.cleaner.pose, 'wipe');
      assert.equal(o.cleaner.dir, 'up');
    });
  }
  assert.ok(seen > 0, 'at least one round went to the counter or the bin');
});

test('tooltip: "Cleaner", nothing to click', () => {
  const tip = cleanerTooltip();
  assert.equal(tip.title, 'Cleaner');
  assert.equal(tip.hint, undefined);
  assert.ok(tip.lines.length > 0);
});
