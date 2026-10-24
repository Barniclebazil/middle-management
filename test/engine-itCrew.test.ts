// The IT crew brain: two side characters who visit every 4-6 minutes, fix a worker's monitor, sneer, and sometimes
// make small talk. Brain layer only: a stub office where goals are reached after a configurable walk time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charTile, newChar } from '../webview/engine/characters.ts';
import type { Char } from '../webview/engine/characters.ts';
import {
  ARRIVE_MAX_MS, ARRIVE_MIN_MS, BEAT_GAP_MS, COMEBACK_MS, DEZ_LOOK_ID, FENWICK_LAG_MS, FENWICK_LOOK_ID, FIX_LINE_MS, FOLLOW_MS,
  IT_BOOT_MS, IT_DEZ_ID, IT_FENWICK_ID, ItCrewBrain, MUTTER_FIRST_MAX_MS, MUTTER_FIRST_MIN_MS, MUTTER_GAP_MAX_MS, MUTTER_GAP_MIN_MS,
  MUTTER_MS, OFF_MS, OPENER_MS, REPLY_MS, SNEER_MS, TALK_REACH_MS, TO_DESK_GIVE_UP_MS, VERDICT_MS, behindTile,
} from '../webview/engine/itCrew.ts';
import type { ItCtx, ItDecision, ItDesk, ItListener } from '../webview/engine/itCrew.ts';
import {
  IT_COMEBACKS, IT_DEZ_MUTTERS, IT_FENWICK_MUTTERS, IT_FIX_LINE, IT_FOOTBALL_TALK, IT_GIVE_UPS, IT_SMALL_TALK, IT_SMALL_TALK_REPLIES,
  IT_SNEERS, IT_VERDICTS,
} from '../webview/engine/itLines.ts';
import { buildSpots } from '../webview/engine/targets.ts';
import { SEATED_POSES, facingToward, tileFeet } from '../webview/engine/types.ts';
import type { Dir, SeatDef, Tile } from '../webview/engine/types.ts';
import { Office } from '../webview/engine/office.ts';
import { findPath } from '../webview/engine/path.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const MIN = 60_000;
const spots = buildSpots(world);
const ELEVATOR = spots.elevator.tile;
const seatById = (id: string): SeatDef => world.seats.find((s) => s.id === id) ?? world.tempSeats.find((s) => s.id === id)!;
const tk = (t: Tile): string => `${t.x},${t.y}`;

// ---------------------------------------------------------------------------
// A stub office

interface Stub {
  ctx: ItCtx;
  dez: Char;
  fen: Char;
  desks: ItDesk[];
  listeners: ItListener[];
  /** Workers who have left their seat. */
  gone: Set<string>;
  /** Listeners who are no longer free. */
  busy: Set<string>;
  /** Tiles someone else is on (by `x,y`). */
  taken: Set<string>;
  bubbles: { on: boolean };
  /** How long a walk takes, by goal key (default 0: reached on the next tick). */
  walk: { ms: (key: string) => number };
  /** When each character's current goal began. */
  since: Map<string, number>;
}

function stub(): Stub {
  const e = tileFeet(ELEVATOR, world.tile);
  const dez = newChar(IT_DEZ_ID, 'cleaner', DEZ_LOOK_ID, null, e.x, e.y, 0);
  const fen = newChar(IT_FENWICK_ID, 'cleaner', FENWICK_LOOK_ID, null, e.x, e.y, 0);
  const desks: ItDesk[] = [];
  const listeners: ItListener[] = [];
  const gone = new Set<string>();
  const busy = new Set<string>();
  const taken = new Set<string>();
  const bubbles = { on: true };
  const ctx: ItCtx = {
    dez, fenwick: fen, spots,
    get speechBubbles() { return bubbles.on; },
    grid: world.grid, w: world.w, h: world.h,
    desks: () => desks,
    listeners: () => listeners,
    stillAt: (w) => !gone.has(w),
    canListen: (id) => !busy.has(id),
    free: (tile) => !taken.has(tk(tile)),
    spotAt: () => undefined,
  };
  return { ctx, dez, fen, desks, listeners, gone, busy, taken, bubbles, walk: { ms: () => 0 }, since: new Map() };
}

/** Plays a decision into the stub characters: a new goal starts a walk that ends after `walk.ms(key)`. */
function apply(s: Stub, d: ItDecision, t: number): void {
  for (const [c, step] of [[s.dez, d.dez], [s.fen, d.fenwick]] as const) {
    if (c.goal?.key !== step.goal.key) {
      c.arrived = false;
      s.since.set(c.id, t);
    }
    c.goal = step.goal;
    c.pose = step.goal.pose;
    c.dir = step.goal.facing;
  }
}

/** Characters whose walk is over arrive at their goal tile. */
function settle(s: Stub, t: number): void {
  for (const c of [s.dez, s.fen]) {
    if (c.arrived || !c.goal) continue;
    if (t - (s.since.get(c.id) ?? 0) >= s.walk.ms(c.goal.key)) {
      const f = tileFeet(c.goal.tile, world.tile);
      c.x = f.x;
      c.y = f.y;
      c.arrived = true;
      c.arrivedAt = t;
    }
  }
}

interface Say { t: number; who: 'dez' | 'fenwick' | 'reply'; text: string; ms: number; id?: string }

interface Trace {
  ds: { t: number; d: ItDecision | null }[];
  says: Say[];
  /** The screen as it changed: the time it was first seen and its value. */
  screens: { t: number; screen: ItCrewBrain['screen'] }[];
  /** The hold on every tick. */
  holds: { t: number; hold: { id: string; face: Tile; talking: boolean } | null; engaged: readonly string[] }[];
  /** Times they came on stage / went off. */
  entries: number[];
  exits: number[];
}

/** Runs the brain from `from` to `until`; `each` may poke the stub (called before every decide). Checks the pair is never split. */
function drive(b: ItCrewBrain, s: Stub, from: number, until: number, each?: (t: number, tr: Trace) => void, step = 100): Trace {
  const tr: Trace = { ds: [], says: [], screens: [], holds: [], entries: [], exits: [] };
  let was = false;
  for (let t = from; t <= until; t += step) {
    settle(s, t);
    each?.(t, tr);
    const d = b.decide(s.ctx, t);
    if (d) {
      assert.ok(d.dez && d.fenwick, 'always both steps');
      if (!was) tr.entries.push(t);
      apply(s, d, t);
      if (d.dez.say) tr.says.push({ t, who: 'dez', ...d.dez.say });
      if (d.fenwick.say) tr.says.push({ t, who: 'fenwick', ...d.fenwick.say });
      if (d.reply) tr.says.push({ t, who: 'reply', ...d.reply });
    } else if (was) {
      tr.exits.push(t);
      s.dez.goal = null;
      s.fen.goal = null;
    }
    assert.equal(b.onStage, d !== null, 'on stage exactly when there is a decision');
    if (d === null) {
      assert.equal(b.screen, null);
      assert.equal(b.holding, null);
      assert.deepEqual(b.engaged, []);
    }
    was = d !== null;
    tr.ds.push({ t, d });
    const sc = b.screen;
    const last = tr.screens[tr.screens.length - 1]?.screen ?? null;
    if (JSON.stringify(sc) !== JSON.stringify(last)) tr.screens.push({ t, screen: sc });
    const h = b.holding;
    tr.holds.push({ t, hold: h ? { ...h } : null, engaged: [...b.engaged] });
  }
  return tr;
}

const desk = (id: string, state: ItDesk['state'], worker: string | null = state === 'empty' ? null : `w-${id}`): ItDesk => ({ seat: seatById(id), worker, state });
const AROUND: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const lobbyTile = spots.lobby[0]!.spot.tile;
const isMutter = (x: Say): boolean => IT_DEZ_MUTTERS.includes(x.text) || IT_FENWICK_MUTTERS.includes(x.text);
const agentAt = (id: string, tile: Tile): ItListener => ({ id, who: 'agent', tile });

/** A fresh brain, due at t = 0. */
const summoned = (seed: number): ItCrewBrain => {
  const b = new ItCrewBrain(seed);
  b.summon(0);
  return b;
};

// ---------------------------------------------------------------------------

test('arrival: nothing before 4 minutes; they come on stage between 4 and 6 minutes after the start', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const b = new ItCrewBrain(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working'));
    const tr = drive(b, s, 0, 7 * MIN, undefined, 1000);
    assert.ok(tr.entries.length >= 1, `seed ${seed}: they came`);
    assert.ok(tr.entries[0]! >= ARRIVE_MIN_MS && tr.entries[0]! <= ARRIVE_MAX_MS + 1000, `seed ${seed}: came at ${tr.entries[0]}`);
    for (const x of tr.ds) if (x.t < ARRIVE_MIN_MS) assert.equal(x.d, null);
  }
});

test('summon brings them in now; it does nothing while they are on stage', () => {
  const b = new ItCrewBrain(1);
  const s = stub();
  s.desks.push(desk('desk-cat', 'working'));
  assert.equal(b.decide(s.ctx, 0), null);
  b.summon(5_000);
  assert.equal(b.onStage, false);
  assert.notEqual(b.decide(s.ctx, 5_000), null);
  assert.equal(b.onStage, true);
  b.summon(6_000);
  const tr = drive(b, s, 5_100, 60_000);
  assert.equal(tr.exits.length, 1, 'one visit, not two');
  assert.equal(tr.entries.length, 1, 'the drive starts mid-visit; there is no second entry');
});

test('with no desks and no listeners they stay off and try again later', () => {
  const b = summoned(2);
  const s = stub();
  assert.equal(drive(b, s, 0, 30 * MIN, undefined, 5_000).entries.length, 0);
  assert.equal(b.onStage, false);
  // As soon as there is something to do, the next try finds it.
  s.desks.push(desk('desk-cat', 'working'));
  const tr = drive(b, s, 30 * MIN, 60 * MIN, undefined, 5_000);
  assert.ok(tr.entries.length >= 1);
  assert.ok(tr.entries[0]! - 30 * MIN <= ARRIVE_MAX_MS + 5_000);
});

test('the pair is never split: every decision has both steps, or there is none', () => {
  for (const seed of [1, 2, 3]) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working'), desk('temp-annex-2', 'empty'));
    s.listeners.push(agentAt('l1', lobbyTile));
    s.walk.ms = () => 1_500;
    // `drive` asserts both steps on every tick and on-stage == non-null.
    const tr = drive(b, s, 0, 40 * MIN, (t) => { if (t % (6 * MIN) === 0) b.summon(t); }, 100);
    assert.ok(tr.entries.length >= 3);
  }
});

test('desk choice: needsYou before working before empty, at random within a tier', () => {
  const pickFor = (seed: number, ds: ItDesk[]): string => {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(...ds);
    const d = b.decide(s.ctx, 0)!;
    assert.ok(d.dez.goal.key.startsWith('it:fix:'));
    return d.dez.goal.key.slice('it:fix:'.length);
  };
  const empty = desk('desk-hr', 'empty');
  const working = desk('desk-chili', 'working');
  const needs = desk('desk-cat', 'needsYou');
  const needs2 = desk('desk-knitting', 'needsYou');
  for (let seed = 1; seed <= 12; seed++) {
    assert.equal(pickFor(seed, [empty, working, needs]), 'desk-cat');
    assert.equal(pickFor(seed, [empty, working]), 'desk-chili');
    assert.equal(pickFor(seed, [empty]), 'desk-hr');
  }
  const seen = new Set<string>();
  for (let seed = 1; seed <= 30; seed++) seen.add(pickFor(seed, [empty, working, needs, needs2]));
  assert.deepEqual([...seen].sort(), ['desk-cat', 'desk-knitting']);
});

test('Dez goes to the visit tile; Fenwick waits at the elevator, then stands behind the chair when he can', () => {
  const b = summoned(3);
  const s = stub();
  const seat = seatById('desk-cat');
  s.desks.push(desk('desk-cat', 'working'));
  const tr = drive(b, s, 0, 5_000);
  const first = tr.ds[0]!.d!;
  assert.equal(first.dez.goal.key, 'it:fix:desk-cat');
  assert.deepEqual(first.dez.goal.tile, seat.visit.tile);
  assert.equal(first.dez.goal.facing, seat.visit.facing);
  assert.equal(first.dez.goal.pose, 'fixPc');
  assert.equal(first.dez.goal.away, true);
  assert.equal(first.fenwick.goal.key, 'it:wait');
  assert.deepEqual(first.fenwick.goal.tile, ELEVATOR);
  const watch = tr.ds.find((x) => x.d?.fenwick.goal.key === 'it:watch:desk-cat')!;
  assert.ok(watch.t >= FENWICK_LAG_MS && watch.t <= FENWICK_LAG_MS + 200, `Fenwick set off at ${watch.t}`);
  const g = watch.d!.fenwick.goal;
  assert.deepEqual(g.tile, behindTile(seat));
  assert.deepEqual(behindTile(seat), { x: seat.tile.x, y: seat.tile.y - 1 });
  assert.equal(g.facing, 'down');
  assert.equal(g.pose, 'stand');
  assert.equal(g.away, true);
  // Dez never leaves fixPc while it lasts.
  for (const x of tr.ds) if (x.d && x.d.dez.goal.key === 'it:fix:desk-cat') assert.equal(x.d.dez.goal.pose, 'fixPc');
});

test('a top-row annex desk has no walkable tile behind it: Fenwick stands beside Dez, facing the seat', () => {
  for (const id of ['temp-annex-1', 'temp-annex-2', 'temp-annex-3', 'temp-annex-4']) {
    const seat = seatById(id);
    assert.equal(world.grid[behindTile(seat).y * world.w + behindTile(seat).x], 0, `${id}: nothing walkable behind`);
    const b = summoned(4);
    const s = stub();
    s.desks.push(desk(id, 'working'));
    const tr = drive(b, s, 0, 3_000);
    const g = tr.ds.find((x) => x.d?.fenwick.goal.key === `it:watch:${id}`)!.d!.fenwick.goal;
    const dx = Math.abs(g.tile.x - seat.visit.tile.x);
    const dy = Math.abs(g.tile.y - seat.visit.tile.y);
    assert.equal(dx + dy, 1, `${id}: a 4-neighbour of Dez`);
    assert.ok(!(g.tile.x === seat.tile.x && g.tile.y === seat.tile.y), 'not on the seat tile');
    assert.equal(world.grid[g.tile.y * world.w + g.tile.x], 1, 'walkable');
    assert.equal(g.facing, facingToward(g.tile, seat.tile));
    assert.equal(g.pose, 'stand');
  }
});

test('a busy visit tile makes them try the next desk; busy everywhere means no fix', () => {
  const b = summoned(5);
  const s = stub();
  s.desks.push(desk('desk-cat', 'needsYou'), desk('desk-hr', 'working'));
  s.taken.add(tk(seatById('desk-cat').visit.tile));
  assert.equal(b.decide(s.ctx, 0)!.dez.goal.key, 'it:fix:desk-hr');
  const b2 = summoned(5);
  const s2 = stub();
  s2.desks.push(desk('desk-cat', 'needsYou'));
  s2.taken.add(tk(seatById('desk-cat').visit.tile));
  const d = b2.decide(s2.ctx, 0)!;
  assert.equal(d.dez.goal.key, 'it:out', 'nothing to fix and nobody to talk to: straight back out');
  // Fenwick's tile behind the chair taken: beside Dez instead.
  const b3 = summoned(5);
  const s3 = stub();
  const seat = seatById('desk-cat');
  s3.desks.push(desk('desk-cat', 'working'));
  s3.taken.add(tk(behindTile(seat)));
  const tr = drive(b3, s3, 0, 3_000);
  const g = tr.ds.find((x) => x.d?.fenwick.goal.key === 'it:watch:desk-cat')!.d!.fenwick.goal;
  assert.notDeepEqual(g.tile, behindTile(seat));
});

test('a reserved spot tile is reserved on the goal, and must be free under that key', () => {
  const b = summoned(6);
  const s = stub();
  const seat = seatById('desk-cat');
  s.desks.push(desk('desk-cat', 'working'));
  const keyed: ItCtx = {
    ...s.ctx,
    get speechBubbles() { return true; },
    spotAt: (tile) => (tk(tile) === tk(seat.visit.tile) ? 'idle:test' : undefined),
    free: (tile, key) => !(tk(tile) === tk(seat.visit.tile) && key !== 'idle:test'),
  };
  const d = b.decide(keyed, 0)!;
  assert.equal(d.dez.goal.reserve, 'idle:test');
  assert.equal(d.fenwick.goal.reserve, undefined, 'no reservation off a spot');
  const d2 = summoned(6).decide({ ...keyed, free: (tile, key) => key !== 'idle:test' || tk(tile) !== tk(seat.visit.tile) }, 0)!;
  assert.equal(d2.dez.goal.key, 'it:out', 'the spot is held by someone else');
});

test('the fix beats: line, screen off, boot (with since), then null and the verdict, then the sneer, then the comeback', () => {
  let sawComeback = false;
  let sawNone = false;
  for (let seed = 1; seed <= 30; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    const tr = drive(b, s, 0, 60_000);
    const scripted = tr.says;
    const line = scripted[0]!;
    assert.equal(line.who, 'dez');
    assert.equal(line.text, IT_FIX_LINE);
    assert.equal(line.ms, FIX_LINE_MS);
    assert.ok(line.t >= FENWICK_LAG_MS && line.t <= FENWICK_LAG_MS + 300, `the line starts once both have arrived (${line.t})`);

    const seat = seatById('desk-cat');
    const [off, boot, back] = tr.screens;
    assert.equal(tr.screens.length, 3, `seed ${seed}: screen went off, boot, null`);
    assert.equal(off!.screen!.mode, 'off');
    assert.equal(off!.screen!.deskId, seat.deskId);
    assert.equal(boot!.screen!.mode, 'boot');
    assert.equal(boot!.screen!.deskId, seat.deskId);
    assert.equal(back!.screen, null);
    const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) <= 100, `${a} vs ${b}`);
    near(off!.t, line.t + FIX_LINE_MS + BEAT_GAP_MS);
    near(boot!.t, off!.t + OFF_MS);
    near(back!.t, boot!.t + IT_BOOT_MS);
    assert.ok(boot!.screen!.since <= boot!.t && boot!.t - boot!.screen!.since <= 100, 'since is when the boot began');
    assert.ok(off!.screen!.since <= off!.t && off!.t - off!.screen!.since <= 100);

    const verdict = scripted[1]!;
    assert.equal(verdict.who, 'dez');
    assert.ok(IT_VERDICTS.includes(verdict.text), verdict.text);
    assert.equal(verdict.ms, VERDICT_MS);
    assert.equal(verdict.t, back!.t, 'the verdict comes with the screen back');

    const sneer = scripted[2]!;
    assert.equal(sneer.who, 'fenwick');
    assert.ok(IT_SNEERS.includes(sneer.text), sneer.text);
    assert.equal(sneer.ms, SNEER_MS);
    near(sneer.t, verdict.t + VERDICT_MS + BEAT_GAP_MS);
    // He scoffs while he sneers, and Dez keeps at his monitor.
    const during = tr.ds.filter((x) => x.d && x.t >= sneer.t && x.t < sneer.t + SNEER_MS && x.d.fenwick.goal.key === 'it:watch:desk-cat');
    assert.ok(during.length > 10);
    for (const x of during) assert.equal(x.d!.fenwick.goal.pose, 'scoff');
    const before = tr.ds.find((x) => x.t === verdict.t)!.d!;
    assert.equal(before.fenwick.goal.pose, 'stand');
    for (const x of tr.ds) if (x.d && x.t >= line.t && x.t < sneer.t + SNEER_MS) assert.equal(x.d.dez.goal.pose, 'fixPc');

    const reply = scripted.find((x) => x.who === 'reply');
    if (reply) {
      sawComeback = true;
      assert.equal(reply.id, 'w1');
      assert.ok(IT_COMEBACKS.includes(reply.text), reply.text);
      assert.equal(reply.ms, COMEBACK_MS);
      near(reply.t, sneer.t + SNEER_MS + BEAT_GAP_MS);
      assert.equal(scripted.length, 4, 'nothing after the comeback (no listeners)');
      // Done a beat after the comeback, then out.
      const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!;
      near(out.t, reply.t + COMEBACK_MS + BEAT_GAP_MS);
    } else {
      sawNone = true;
      assert.equal(scripted.length, 3);
    }
  }
  assert.ok(sawComeback && sawNone, 'the comeback happens about half the time');
});

test('an empty desk has nobody to answer back', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-hr', 'empty'));
    const tr = drive(b, s, 0, 60_000);
    assert.ok(!tr.says.some((x) => x.who === 'reply'));
    assert.equal(tr.says.length, 3);
  }
});

test('no overlap: across a long run with several summons, no two IT lines overlap in time', () => {
  for (const seed of [1, 2, 3, 4]) {
    const b = new ItCrewBrain(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'needsYou', 'w1'), desk('desk-hr', 'working', 'w2'), desk('temp-annex-3', 'empty'));
    s.listeners.push(agentAt('l1', lobbyTile));
    s.walk.ms = (key) => (key.startsWith('it:') ? 4_000 : 0);
    const tr = drive(b, s, 0, 3 * 60 * MIN, (t) => { if (t % (7 * MIN) === 0) b.summon(t); }, 100);
    const lines = tr.says.filter((x) => x.who !== 'reply');
    assert.ok(lines.length > 40, `seed ${seed}: ${lines.length} lines`);
    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i]!.t >= lines[i - 1]!.t + lines[i - 1]!.ms, `seed ${seed}: "${lines[i - 1]!.text}" at ${lines[i - 1]!.t} (${lines[i - 1]!.ms} ms) overlaps "${lines[i]!.text}" at ${lines[i]!.t}`);
    }
  }
});

test('give-up: the worker leaving mid-fix clears the screen at once and Dez grumbles', () => {
  for (const when of ['line', 'off', 'boot'] as const) {
    const b = summoned(7);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    let flipped = -1;
    const tr = drive(b, s, 0, 60_000, (t, tr) => {
      if (flipped >= 0) return;
      const line = tr.says.find((x) => x.text === IT_FIX_LINE);
      const ready = when === 'line' ? line !== undefined && t >= line.t + 1_000 : b.screen?.mode === when;
      if (ready) { s.gone.add('w1'); flipped = t; }
    });
    assert.ok(flipped >= 0, `${when}: flipped`);
    const atFlip = tr.screens.filter((x) => x.t >= flipped);
    if (when === 'line') assert.equal(atFlip.length, 0, 'the screen never went off');
    else assert.deepEqual(atFlip.map((x) => [x.t, x.screen]), [[flipped, null]], `${when}: cleared on the very tick`);
    const gu = tr.says.find((x) => IT_GIVE_UPS.includes(x.text))!;
    assert.ok(gu, `${when}: a give-up line`);
    assert.equal(gu.who, 'dez');
    assert.ok(gu.t >= flipped);
    assert.ok(!tr.says.some((x) => IT_VERDICTS.includes(x.text) || IT_SNEERS.includes(x.text) || x.who === 'reply'), `${when}: no verdict, sneer or comeback`);
    // It does not talk over the fix line, and they leave afterwards.
    const line = tr.says.find((x) => x.text === IT_FIX_LINE)!;
    assert.ok(gu.t >= line.t + line.ms);
    assert.equal(tr.exits.length, 1);
    assert.ok(tr.exits[0]! > gu.t + gu.ms);
  }
});

test('the worker leaving before they arrive: the fix is dropped silently', () => {
  const b = summoned(8);
  const s = stub();
  s.desks.push(desk('desk-cat', 'working', 'w1'));
  s.walk.ms = (key) => (key === 'it:fix:desk-cat' ? 5_000 : 0);
  const tr = drive(b, s, 0, 60_000, (t) => { if (t === 2_000) s.gone.add('w1'); });
  assert.equal(tr.says.length, 0);
  assert.equal(tr.screens.length, 0);
  assert.equal(tr.exits.length, 1);
});

test('they give up silently if they have not both reached the desk after 30 s', () => {
  const b = summoned(9);
  const s = stub();
  s.desks.push(desk('desk-cat', 'working', 'w1'));
  s.walk.ms = (key) => (key.startsWith('it:fix') ? 10 * MIN : 0);
  const tr = drive(b, s, 0, 90_000);
  const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!;
  assert.ok(out.t >= TO_DESK_GIVE_UP_MS && out.t <= TO_DESK_GIVE_UP_MS + 200, `gave up at ${out.t}`);
  assert.ok(!tr.says.some((x) => x.text === IT_FIX_LINE));
  assert.equal(tr.screens.length, 0);
});

// ---------------------------------------------------------------------------
// Small talk

/** A visit with only a listener (the small talk is then the whole visit). */
function talkVisit(seed: number, over: (s: Stub) => void = () => {}, walkMs = 2_000): { tr: Trace; s: Stub; b: ItCrewBrain } {
  const b = summoned(seed);
  const s = stub();
  s.listeners.push(agentAt('l1', lobbyTile));
  s.walk.ms = (key) => (key.startsWith('it:talk') ? walkMs : 0);
  over(s);
  const tr = drive(b, s, 0, 120_000);
  return { tr, s, b };
}

const footballOpeners = new Set(IT_FOOTBALL_TALK.map((p) => p[0]));
const smallOpeners = new Set(IT_SMALL_TALK.map((p) => p[0]));

test('small talk: the hold is set as the target is chosen and kept through the beats; talking is true only during the reply', () => {
  const speakers = { dez: 0, fenwick: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const { tr } = talkVisit(seed);
    const opener = tr.says.find((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text))!;
    assert.ok(opener, `seed ${seed}: there was small talk`);
    const first = tr.holds[0]!;
    assert.equal(first.hold?.id, 'l1', 'held at once, while they walk over');
    assert.deepEqual(first.engaged, ['l1']);
    const talkGoal = tr.ds[0]!.d!;
    const speakerStep = opener.who === 'dez' ? talkGoal.dez : talkGoal.fenwick;
    assert.equal(speakerStep.goal.key, 'it:talk:l1');
    assert.deepEqual(first.hold!.face, speakerStep.goal.tile, 'the held person faces the speaker');
    // The speaker faces the listener, from a neighbouring tile.
    assert.equal(Math.abs(speakerStep.goal.tile.x - lobbyTile.x) + Math.abs(speakerStep.goal.tile.y - lobbyTile.y), 1);
    assert.equal(speakerStep.goal.facing, facingToward(speakerStep.goal.tile, lobbyTile));
    // The sidekick stands next to the speaker, facing the listener.
    const sideStep = opener.who === 'dez' ? talkGoal.fenwick : talkGoal.dez;
    assert.equal(sideStep.goal.pose, 'stand');
    assert.equal(sideStep.goal.facing, facingToward(sideStep.goal.tile, lobbyTile));
    assert.ok(!(sideStep.goal.tile.x === lobbyTile.x && sideStep.goal.tile.y === lobbyTile.y));
    assert.ok(!(sideStep.goal.tile.x === speakerStep.goal.tile.x && sideStep.goal.tile.y === speakerStep.goal.tile.y));

    const reply = tr.says.find((x) => x.who === 'reply')!;
    assert.equal(reply.id, 'l1');
    assert.ok(IT_SMALL_TALK_REPLIES.includes(reply.text));
    assert.equal(reply.ms, REPLY_MS);
    const follow = tr.says.find((x) => x.t > reply.t && x.who !== 'reply')!;
    assert.ok(follow, 'the follow-up comes after the reply');
    assert.equal(follow.who, opener.who, 'the same speaker');
    assert.equal(follow.ms, FOLLOW_MS);
    assert.ok(follow.t >= reply.t + REPLY_MS, 'after the reply has finished');
    assert.ok(reply.t >= opener.t + OPENER_MS, 'the reply waits for the opener to finish');
    const pairs = opener.who === 'fenwick' ? IT_FOOTBALL_TALK : IT_SMALL_TALK;
    const pair = pairs.find((p) => p[0] === opener.text)!;
    assert.equal(follow.text, pair[1]);
    speakers[opener.who === 'fenwick' ? 'fenwick' : 'dez']++;
    assert.equal(opener.who === 'fenwick' ? footballOpeners.has(opener.text) : smallOpeners.has(opener.text), true, 'football only from Fenwick, small talk only from Dez');
    assert.equal(opener.who === 'fenwick' ? smallOpeners.has(opener.text) : footballOpeners.has(opener.text), false);

    for (const h of tr.holds) {
      const inReply = h.t >= reply.t && h.t < reply.t + REPLY_MS;
      if (h.hold) assert.equal(h.hold.talking, inReply, `t=${h.t}`);
    }
    assert.ok(tr.holds.some((h) => h.hold?.talking), 'talking was true at some point');
    // Held until the talk ends; free once they leave.
    const lastHeld = [...tr.holds].reverse().find((h) => h.hold)!;
    assert.ok(lastHeld.t >= follow.t + FOLLOW_MS, 'held right to the end');
    const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!;
    assert.ok(out.t >= follow.t + FOLLOW_MS + 900, 'an awkward pause before leaving');
    assert.equal(tr.holds.find((h) => h.t === out.t)!.hold, null);
    assert.deepEqual(tr.holds.find((h) => h.t === out.t)!.engaged, []);
  }
  assert.ok(speakers.dez > 0 && speakers.fenwick > 0, JSON.stringify(speakers));
  assert.ok(speakers.fenwick >= 12 && speakers.fenwick <= 36, `Fenwick spoke ${speakers.fenwick} of 60 times (about 40%)`);
});

test('the speaker poses: Dez talks (but stands when facing up), Fenwick reads from the card', () => {
  const seenPoses = { dez: new Set<string>(), fenwick: new Set<string>() };
  for (let seed = 1; seed <= 30; seed++) {
    const { tr } = talkVisit(seed);
    const opener = tr.says.find((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text))!;
    const mid = tr.ds.find((x) => x.t === opener.t + 500)!.d!;
    const step = opener.who === 'dez' ? mid.dez : mid.fenwick;
    seenPoses[opener.who === 'dez' ? 'dez' : 'fenwick'].add(step.goal.pose);
    assert.equal(step.goal.pose, opener.who === 'fenwick' ? 'readCard' : step.goal.facing === 'up' ? 'stand' : 'talk');
  }
  assert.deepEqual([...seenPoses.fenwick], ['readCard']);
  assert.ok(seenPoses.dez.has('talk'));
  // Facing up (the boss's visit spot, the last resort): Dez stands.
  const boss = seatById('desk-manager');
  let checked = false;
  for (let seed = 1; seed <= 40 && !checked; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.listeners.push({ id: 'boss', who: 'boss', tile: boss.tile, stands: [{ tile: boss.visit.tile, facing: boss.visit.facing }] });
    const tr = drive(b, s, 0, 60_000);
    const opener = tr.says.find((x) => smallOpeners.has(x.text));
    if (!opener) continue;
    const mid = tr.ds.find((x) => x.t === opener.t + 500)!.d!;
    assert.deepEqual(mid.dez.goal.tile, boss.visit.tile, 'on the boss\'s visit tile');
    assert.equal(mid.dez.goal.facing, boss.visit.facing);
    assert.equal(mid.dez.goal.pose, 'stand');
    assert.deepEqual(tr.holds[0]!.hold!.face, boss.visit.tile);
    checked = true;
  }
  assert.ok(checked);
});

test('small talk is on with a 60% chance after a fix, needs a listener, and is skipped without speech bubbles', () => {
  let talks = 0;
  const N = 100;
  for (let seed = 1; seed <= N; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    s.listeners.push(agentAt('l1', lobbyTile));
    const tr = drive(b, s, 0, 120_000);
    if (tr.says.some((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text))) talks++;
  }
  assert.ok(talks >= 40 && talks <= 80, `${talks} of ${N} visits had small talk`);
  // No listeners: never.
  for (let seed = 1; seed <= 20; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    const tr = drive(b, s, 0, 120_000);
    assert.ok(!tr.says.some((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text)));
    assert.ok(tr.holds.every((h) => h.hold === null));
  }
});

test('the talk is dropped, silently, when the listener stops being free: the hold clears and they leave', () => {
  for (const when of ['walking', 'opener', 'reply'] as const) {
    const b = summoned(5);
    const s = stub();
    s.listeners.push(agentAt('l1', lobbyTile));
    s.walk.ms = (key) => (key.startsWith('it:talk') ? 4_000 : 0);
    let flipped = -1;
    const tr = drive(b, s, 0, 120_000, (t, tr) => {
      if (flipped >= 0) return;
      const opener = tr.says.find((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text));
      const reply = tr.says.find((x) => x.who === 'reply');
      const ready = when === 'walking' ? t >= 1_500 : when === 'opener' ? opener !== undefined && t >= opener.t + 500 : reply !== undefined && t >= reply.t + 500;
      if (ready) { s.busy.add('l1'); flipped = t; }
    });
    assert.ok(flipped >= 0, `${when}: flipped`);
    const row = tr.holds.find((h) => h.t === flipped)!;
    assert.equal(row.hold, null, `${when}: hold cleared on that tick`);
    assert.deepEqual(row.engaged, []);
    assert.ok(tr.holds.filter((h) => h.t >= flipped).every((h) => h.hold === null));
    assert.ok(tr.holds.filter((h) => h.t < flipped).every((h) => h.hold !== null), 'held up to then');
    assert.equal(tr.says.filter((x) => x.t > flipped && !isMutter(x)).length, 0, `${when}: nothing more said`);
    if (when === 'walking') assert.equal(tr.says.filter((x) => !isMutter(x)).length, 0);
    const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!;
    assert.equal(out.t, flipped, 'and they leave');
    assert.equal(tr.exits.length, 1);
    if (when === 'reply') assert.ok(tr.holds.some((h) => h.hold?.talking), 'it had got as far as the reply');
  }
});

test('a speaker who cannot reach the listener within 25 s drops the talk', () => {
  const b = summoned(6);
  const s = stub();
  s.listeners.push(agentAt('l1', lobbyTile));
  s.walk.ms = (key) => (key.startsWith('it:talk') ? 10 * MIN : 0);
  const tr = drive(b, s, 0, 120_000);
  const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!;
  assert.ok(out.t >= TALK_REACH_MS && out.t <= TALK_REACH_MS + 200, `dropped at ${out.t}`);
  assert.equal(tr.says.filter((x) => !isMutter(x)).length, 0, 'only mutters on the way');
  assert.ok(tr.holds.filter((h) => h.t < TALK_REACH_MS).every((h) => h.hold !== null));
  assert.ok(tr.holds.filter((h) => h.t >= out.t).every((h) => h.hold === null));
});

test('listeners who need a spot to stand on use it, and a listener with no free neighbour is passed over', () => {
  // The only listener has no free tile around them: no talk, so straight out.
  const b = summoned(2);
  const s = stub();
  const lt = lobbyTile;
  s.listeners.push(agentAt('l1', lt));
  for (const [dx, dy] of AROUND) s.taken.add(`${lt.x + dx},${lt.y + dy}`);
  assert.equal(b.decide(s.ctx, 0)!.dez.goal.key, 'it:out');
  // A second listener with room is chosen instead.
  const b2 = summoned(2);
  const s2 = stub();
  s2.listeners.push(agentAt('l1', lt), agentAt('l2', spots.lobby[1]!.spot.tile));
  for (const [dx, dy] of AROUND) s2.taken.add(`${lt.x + dx},${lt.y + dy}`);
  const d = b2.decide(s2.ctx, 0)!;
  assert.ok(d.dez.goal.key === 'it:talk:l2' || d.fenwick.goal.key === 'it:talk:l2');
  assert.equal(b2.holding!.id, 'l2');
});

const recSeat = seatById('desk-receptionist');
const bossSeat = seatById('desk-manager');

/** The first small-talk visit for `listener`, from the first seed in 1..60 that has one. */
function firstTalk(listener: ItListener, over: (s: Stub) => void = () => {}): { mid: ItDecision; tr: Trace; speaker: 'dez' | 'fenwick' } {
  for (let seed = 1; seed <= 60; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.listeners.push(listener);
    over(s);
    const tr = drive(b, s, 0, 60_000);
    const opener = tr.says.find((x) => footballOpeners.has(x.text) || smallOpeners.has(x.text));
    if (!opener) continue;
    return { mid: tr.ds.find((x) => x.t === opener.t + 500)!.d!, tr, speaker: opener.who as 'dez' | 'fenwick' };
  }
  throw new Error('no small talk in 60 seeds');
}

test('small talk at the front desk is side-on: the first usable stand is used, in order, with the visit tile as the last resort', () => {
  const left = { tile: { x: recSeat.tile.x - 2, y: recSeat.tile.y }, facing: 'right' as const };
  const right = { tile: { x: recSeat.tile.x + 2, y: recSeat.tile.y }, facing: 'left' as const };
  const visit = { tile: recSeat.visit.tile, facing: recSeat.visit.facing };
  const rec = (stands: ItListener['stands']): ItListener => ({ id: 'rec', who: 'receptionist', tile: recSeat.tile, stands });
  {
    // The first one free: the speaker is there, facing the desk from the side, and not facing up.
    const a = firstTalk(rec([left, right, visit]));
    const sp = a.speaker === 'dez' ? a.mid.dez : a.mid.fenwick;
    assert.deepEqual(sp.goal.tile, left.tile);
    assert.equal(sp.goal.facing, 'right');
    assert.equal(sp.goal.pose, a.speaker === 'fenwick' ? 'readCard' : 'talk', 'Dez talks (not stands) when side-on; Fenwick shows his card');
    // The first one taken: the next.
    const b = firstTalk(rec([left, right, visit]), (s) => s.taken.add(tk(left.tile)));
    const sb = b.speaker === 'dez' ? b.mid.dez : b.mid.fenwick;
    assert.deepEqual(sb.goal.tile, right.tile);
    assert.equal(sb.goal.facing, 'left');
    // Both taken: the visit tile, facing up, as before.
    const c = firstTalk(rec([left, right, visit]), (s) => { s.taken.add(tk(left.tile)); s.taken.add(tk(right.tile)); });
    const sc = c.speaker === 'dez' ? c.mid.dez : c.mid.fenwick;
    assert.deepEqual(sc.goal.tile, visit.tile);
    assert.equal(sc.goal.facing, 'up');
    // The listener is held and faces the speaker whichever stand was used.
    assert.deepEqual(a.tr.holds[0]!.hold!.face, left.tile);
  }
});

test('small talk with an idle agent prefers the tiles to their left and right over above and below', () => {
  const at = { x: 20, y: 9 };
  const seen = { side: 0, vertical: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.listeners.push(agentAt('l1', at));
    const tr = drive(b, s, 0, 60_000);
    const d = tr.ds[0]!.d!;
    const talk = [d.dez, d.fenwick].find((st) => st.goal.key === 'it:talk:l1')!;
    assert.equal(talk.goal.tile.y, at.y, `seed ${seed}: level with the listener`);
    assert.equal(Math.abs(talk.goal.tile.x - at.x), 1);
    assert.equal(talk.goal.facing, talk.goal.tile.x < at.x ? 'right' : 'left');
    seen.side++;
  }
  assert.equal(seen.side, 40);
  // Left and right both taken: above or below, as a last resort.
  const b = summoned(3);
  const s = stub();
  s.listeners.push(agentAt('l1', at));
  s.taken.add(tk({ x: at.x - 1, y: at.y }));
  s.taken.add(tk({ x: at.x + 1, y: at.y }));
  const d = b.decide(s.ctx, 0)!;
  const talk = [d.dez, d.fenwick].find((st) => st.goal.key === 'it:talk:l1')!;
  assert.equal(talk.goal.tile.x, at.x);
  assert.equal(Math.abs(talk.goal.tile.y - at.y), 1);
});

test('the sidekick stands beside or behind the speaker, never between the speaker and the listener', () => {
  const at = { x: 20, y: 9 };
  for (let seed = 1; seed <= 60; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.listeners.push(agentAt('l1', at));
    const d = b.decide(s.ctx, 0)!;
    const talk = [d.dez, d.fenwick].find((st) => st.goal.key === 'it:talk:l1')!;
    const side = [d.dez, d.fenwick].find((st) => st.goal.key === 'it:side:l1')!;
    const sp = talk.goal.tile;
    const dir = Math.sign(at.x - sp.x);
    assert.ok(!(side.goal.tile.y === sp.y && side.goal.tile.x === sp.x + dir), `seed ${seed}: not in front of the speaker`);
    assert.ok(Math.abs(side.goal.tile.x - sp.x) + Math.abs(side.goal.tile.y - sp.y) === 1, 'next to the speaker');
    assert.equal(side.goal.tile.x, sp.x - dir, 'behind the speaker, in line, when that is free');
    assert.equal(side.goal.tile.y, sp.y);
  }
  // Behind is taken: above the speaker, then below.
  const b = summoned(4);
  const s = stub();
  s.listeners.push(agentAt('l1', at));
  const first = b.decide(s.ctx, 0)!;
  const sp = [first.dez, first.fenwick].find((st) => st.goal.key === 'it:talk:l1')!.goal.tile;
  const dir = Math.sign(at.x - sp.x);
  const b2 = summoned(4);
  const s2 = stub();
  s2.listeners.push(agentAt('l1', at));
  s2.taken.add(tk({ x: sp.x - dir, y: sp.y }));
  const d2 = b2.decide(s2.ctx, 0)!;
  const side2 = [d2.dez, d2.fenwick].find((st) => st.goal.key === 'it:side:l1')!;
  assert.deepEqual(side2.goal.tile, { x: sp.x, y: sp.y - 1 }, 'above the speaker (behind them as the viewer sees it)');
});

// ---------------------------------------------------------------------------

test('speech bubbles off: no says and no replies, no talk, but the screen still cycles', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const b = summoned(seed);
    const s = stub();
    s.bubbles.on = false;
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    s.listeners.push(agentAt('l1', lobbyTile));
    s.walk.ms = () => 15_000;
    const tr = drive(b, s, 0, 5 * MIN);
    assert.equal(tr.says.length, 0, `seed ${seed}: silent (no mutters either)`);
    assert.deepEqual(tr.screens.map((x) => x.screen?.mode ?? null), ['off', 'boot', null]);
    assert.ok(tr.holds.every((h) => h.hold === null));
    assert.equal(tr.exits.length, 1, 'and they leave');
    const [off, boot, back] = tr.screens;
    assert.equal(boot!.t - off!.t >= OFF_MS - 100 && boot!.t - off!.t <= OFF_MS + 100, true);
    assert.equal(back!.t - boot!.t >= IT_BOOT_MS - 100 && back!.t - boot!.t <= IT_BOOT_MS + 100, true);
  }
});

test('leave: both go to the elevator facing down, then null; later visits happen again', () => {
  const b = summoned(11);
  const s = stub();
  s.desks.push(desk('desk-cat', 'working', 'w1'));
  s.walk.ms = (key) => (key === 'it:out' ? 3_000 : 0);
  const tr = drive(b, s, 0, 60 * MIN, undefined, 250);
  assert.ok(tr.entries.length >= 2, `${tr.entries.length} visits in an hour`);
  assert.equal(tr.exits.length, tr.entries.length);
  const out = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!.d!;
  for (const st of [out.dez, out.fenwick]) {
    assert.equal(st.goal.key, 'it:out');
    assert.deepEqual(st.goal.tile, ELEVATOR);
    assert.equal(st.goal.facing, 'down');
    assert.equal(st.goal.pose, 'stand');
    assert.equal(st.goal.away, true);
  }
  // Null only once both have arrived (3 s of walking here).
  const outAt = tr.ds.find((x) => x.d?.dez.goal.key === 'it:out')!.t;
  assert.ok(tr.exits[0]! >= outAt + 3_000 && tr.exits[0]! <= outAt + 3_500, `out at ${tr.exits[0]! - outAt} after`);
  // The next visit is 4-6 min after the last one ended.
  const gap = tr.entries[1]! - tr.exits[0]!;
  assert.ok(gap >= ARRIVE_MIN_MS && gap <= ARRIVE_MAX_MS + 500, `gap ${gap}`);
  assert.equal(b.screen, null);
  assert.equal(b.holding, null);
});

test('mutters: the first 2-4 s after going on stage, then every 9-14 s; alternating Dez and Fenwick; only while walking', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'));
    s.walk.ms = (key) => (key.startsWith('it:fix') ? 28_000 : 0);
    const tr = drive(b, s, 0, 40_000);
    const m = tr.says.filter((x) => IT_DEZ_MUTTERS.includes(x.text) || IT_FENWICK_MUTTERS.includes(x.text));
    assert.ok(m.length >= 3, `seed ${seed}: ${m.length} mutters while walking`);
    assert.ok(m[0]!.t >= MUTTER_FIRST_MIN_MS && m[0]!.t <= MUTTER_FIRST_MAX_MS + 100, `first at ${m[0]!.t}`);
    m.forEach((x, i) => {
      assert.equal(x.who, i % 2 === 0 ? 'dez' : 'fenwick');
      assert.ok((x.who === 'dez' ? IT_DEZ_MUTTERS : IT_FENWICK_MUTTERS).includes(x.text), x.text);
      assert.equal(x.ms, MUTTER_MS);
      if (i > 0) {
        const gap = x.t - m[i - 1]!.t;
        assert.ok(gap >= MUTTER_GAP_MIN_MS - 100 && gap <= MUTTER_GAP_MAX_MS + 100, `gap ${gap}`);
      }
    });
  }
  // Instant arrival: the scripted beats leave no room for a mutter during the fix itself.
  const b = summoned(3);
  const s = stub();
  s.desks.push(desk('desk-cat', 'working', 'w1'));
  const tr = drive(b, s, 0, 60_000);
  const mutters = tr.says.filter((x) => IT_DEZ_MUTTERS.includes(x.text) || IT_FENWICK_MUTTERS.includes(x.text));
  const beatsEnd = tr.says.find((x) => IT_SNEERS.includes(x.text))!.t;
  assert.ok(mutters.every((x) => x.t > beatsEnd), 'no mutters inside the beats');
});

test('deterministic for a seed (and different seeds differ)', () => {
  const trace = (seed: number): string => {
    const b = summoned(seed);
    const s = stub();
    s.desks.push(desk('desk-cat', 'working', 'w1'), desk('desk-hr', 'needsYou', 'w2'));
    s.listeners.push(agentAt('l1', lobbyTile));
    const tr = drive(b, s, 0, 5 * MIN);
    return tr.says.map((x) => `${x.t}:${x.who}:${x.text}`).join('|');
  };
  assert.equal(trace(7), trace(7));
  assert.notEqual(trace(7), trace(8));
});

test('constants: the boot time mirrors the art, and the ids and looks are the art\'s', async () => {
  const screens: string = new URL('../webview/art/screens.ts', import.meta.url).href;
  const art = await import(screens);
  assert.equal(IT_BOOT_MS, art.BOOT_MS);
  assert.equal(IT_DEZ_ID, '__it_dez__');
  assert.equal(IT_FENWICK_ID, '__it_fenwick__');
  assert.equal(DEZ_LOOK_ID, 'dez');
  assert.equal(FENWICK_LOOK_ID, 'fenwick');
});

// ---------------------------------------------------------------------------
// The Office around the brain: real chars, the real route grid, the desk screens, holds and the boss's snoop

const STEP = 33;

/** Steps the office from `t0` for `ms`; returns the time. */
function oRun(o: Office, t0: number, ms: number, each?: (t: number) => void): number {
  let t = t0;
  for (let e = 0; e < ms; e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    each?.(t);
  }
  return t;
}

/** Steps until `done()` (checked after every step), at most `ms`; returns the time. */
function oUntil(o: Office, t0: number, ms: number, done: () => boolean, each?: (t: number) => void): number {
  let t = t0;
  for (let e = 0; e < ms && !done(); e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    each?.(t);
  }
  return t;
}

/** An office with `agents` seated at once, no food cart (its trips would only add noise). */
function newOffice(agents: ReturnType<typeof agent>[], over: { seed?: number; itCrew?: boolean } = {}): Office {
  const o = new Office(world, { seed: 1, foodCart: false, ...over });
  o.applySnapshot(agents, 0, HOST0);
  return o;
}

const idleAgent = (id: string, n = 1): ReturnType<typeof agent> =>
  agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });

/** The office's private IT brain, for the checks that need `holding` and `engaged`. */
const brainOf = (o: Office): ItCrewBrain => (o as unknown as { itBrain: ItCrewBrain }).itBrain;

const manhattan = (a: Tile, b: Tile): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

test('office: a summoned visit brings both in together, they fix the working agent\'s desk (dark, boot, back to its work) and leave', () => {
  const o = newOffice([agent('a')]);
  let t = oRun(o, 0, 1_000);
  const seat = o.chars.get('a')!.seat!;
  assert.equal(o.itCrewOnStage, false);
  assert.equal(o.itScreen, null);
  assert.ok(!o.allChars().includes(o.dez) && !o.allChars().includes(o.fenwick), 'off-stage they are not part of the office');
  assert.equal(o.dez.kind, 'itSupport');
  assert.equal(o.fenwick.kind, 'itSupport');
  assert.equal(o.dez.look, DEZ_LOOK_ID);
  assert.equal(o.fenwick.look, FENWICK_LOOK_ID);
  assert.equal(o.chars.has(IT_DEZ_ID) || o.chars.has(IT_FENWICK_ID), false, 'never in the roster');
  const before = o.deskScreen(seat.deskId);
  assert.deepEqual(before, { mode: 'activity', value: 'writing' });

  o.debugSummonItCrew(t);
  const labels: string[] = [];
  let wasOn = false;
  let bothTogether = true;
  let dezAtDesk = false;
  let bootSince: number | null = null;
  t = oUntil(o, t, 6 * MIN, () => wasOn && !o.itCrewOnStage, (now) => {
    const on = o.itCrewOnStage;
    wasOn ||= on;
    const inOffice = o.allChars().filter((c) => c === o.dez || c === o.fenwick).length;
    if (inOffice !== (on ? 2 : 0)) bothTogether = false;
    const st = o.deskScreen(seat.deskId);
    const label = st.mode === 'off' ? 'off' : st.mode === 'kind' && st.value === 'boot' ? 'boot' : 'agent';
    if (labels[labels.length - 1] !== label) labels.push(label);
    if (label === 'off' && o.dez.arrived && o.dez.pose === 'fixPc' && charTile(o.dez, world.tile).x === seat.visit.tile.x && charTile(o.dez, world.tile).y === seat.visit.tile.y) dezAtDesk = true;
    if (label === 'boot') {
      assert.equal(typeof st.since, 'number');
      assert.equal(st.since, o.itScreen?.deskId === seat.deskId ? o.itScreen.since : undefined);
      assert.ok(now - st.since! >= 0 && now - st.since! <= IT_BOOT_MS + STEP, `the boot bar runs 0 to ${IT_BOOT_MS} ms: ${now - st.since!}`);
      bootSince ??= st.since!;
    }
  });
  assert.ok(wasOn, 'they came in');
  assert.ok(bothTogether, 'both are in the office together, and both out of it together');
  assert.deepEqual(labels, ['agent', 'off', 'boot', 'agent'], 'the monitor goes dark, boots, then shows the agent again');
  assert.ok(dezAtDesk, 'Dez stood at the desk\'s visit tile with his hands in the PC');
  assert.ok(bootSince !== null);
  assert.equal(o.itCrewOnStage, false, 'and they left');
  assert.ok(!o.allChars().includes(o.dez) && !o.allChars().includes(o.fenwick));
  assert.equal(o.itScreen, null);
  assert.deepEqual(o.deskScreen(seat.deskId), { mode: 'activity', value: 'writing' }, 'the agent\'s own screen is back');
  assert.equal(o.dez.say, null);
  assert.equal(o.fenwick.say, null);
});

test('office: the replies land as speech on the right character, next to the pair', () => {
  const comebacks = new Set<string>(IT_COMEBACKS);
  const replies = new Set<string>(IT_SMALL_TALK_REPLIES);
  let sawComeback = 0;
  const repliedTo = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const o = newOffice([agent('a'), idleAgent('i', 2), idleAgent('j', 3)], { seed });
    let t = oRun(o, 0, 25_000);
    o.debugSummonItCrew(t);
    const last = new Map<string, unknown>();
    t = oRun(o, t, 4 * MIN, () => {
      for (const c of o.allChars()) {
        const say = c.say;
        if (!say || last.get(c.id) === say) continue;
        last.set(c.id, say);
        const pair = [o.dez, o.fenwick];
        const near = Math.min(...pair.map((p) => manhattan(charTile(p, world.tile), charTile(c, world.tile))));
        if (comebacks.has(say.text)) {
          assert.equal(c.id, 'a', `a comeback comes from the worker being fixed, not ${c.id}`);
          assert.ok(near <= 3, `the worker is by the pair (${near} tiles)`);
          sawComeback++;
        }
        if (replies.has(say.text)) {
          assert.ok(c !== o.dez && c !== o.fenwick, 'the listener answers, not the pair');
          assert.ok(c.id === 'i' || c.id === 'j' || c === o.manager || c === o.receptionist, `a listener: ${c.id}`);
          assert.ok(near <= 3, `the listener is by the pair (${near} tiles)`);
          repliedTo.add(c === o.manager ? 'boss' : c === o.receptionist ? 'receptionist' : 'agent');
        }
      }
    });
  }
  assert.ok(sawComeback >= 1, 'at least one worker answered back over 12 visits');
  assert.ok(repliedTo.size >= 2, `small talk reached more than one kind of listener: ${[...repliedTo].join()}`);
});

test('office: a held idle agent keeps its wander goal, is never in a chat, and turns to the speaker', () => {
  let holds = 0;
  for (let seed = 1; seed <= 20; seed++) {
    // Three, so that one is usually out of the water-cooler chat and standing at a spot of their own.
    const o = newOffice([idleAgent('i', 1), idleAgent('j', 2), idleAgent('k', 3)], { seed });
    let t = oRun(o, 0, 25_000);
    o.debugSummonItCrew(t);
    const start = new Map<string, { key: string | null; goal: string | undefined; tile: Tile }>();
    let wasHeld: string | null = null;
    t = oRun(o, t, 3 * MIN, () => {
      const h = brainOf(o).holding;
      const id = h && h.id !== o.manager.id && h.id !== o.receptionist.id ? h.id : null;
      if (id !== wasHeld) { if (wasHeld) start.delete(wasHeld); wasHeld = id; }
      if (!id) return;
      const c = o.chars.get(id)!;
      if (!start.has(id)) { start.set(id, { key: c.wanderKey, goal: c.goal?.key, tile: charTile(c, world.tile) }); holds++; }
      const s = start.get(id)!;
      assert.ok(!o.chatIds().includes(id), 'never in a chat while held');
      assert.equal(c.wanderKey, s.key, 'still the same wander goal');
      assert.equal(c.goal?.key, s.goal, 'and not walking anywhere else');
      assert.deepEqual(charTile(c, world.tile), s.tile, 'standing where they were');
      // (Someone sitting at the kitchen table stays seated; the rest stand, and turn.)
      if (c.arrived && !SEATED_POSES.has(c.goal!.pose)) {
        assert.ok(c.pose === 'stand' || c.pose === 'talk', `pose ${c.pose}`);
        assert.equal(c.dir, facingToward(s.tile, h!.face), 'turned towards the speaker');
      }
    });
  }
  assert.ok(holds >= 3, `an idle agent was held in ${holds} runs of 20`);
});

test('office: the boss never snoops a worker the pair are dealing with, and snoops again afterwards', () => {
  let checked = 0;
  let snoopedAfter = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const o = newOffice([agent('a')], { seed });
    let t = oRun(o, 0, 2_000);
    o.debugSummonItCrew(t);
    let engagedOnce = false;
    let finished = false;
    t = oUntil(o, t, 6 * MIN, () => finished && o.brain.snooping === 'a', (now) => {
      const eng = brainOf(o).engaged.includes('a');
      if (eng) {
        engagedOnce = true;
        o.debugSnoopNow(now);
        assert.notEqual(o.brain.snooping, 'a', 'not while the pair are at that desk');
        checked++;
      } else if (engagedOnce && !o.itCrewOnStage) {
        finished = true;
        o.debugSnoopNow(now);
      }
    });
    assert.ok(engagedOnce, 'the worker was engaged');
    if (o.brain.snooping === 'a') snoopedAfter++;
  }
  assert.ok(checked > 50, `${checked} ticks checked`);
  assert.ok(snoopedAfter >= 1, 'the snoop is not lost, just delayed');
});

test('office: with itCrew off they never appear, even summoned, over two hours', () => {
  const o = newOffice([agent('a'), agent('b'), idleAgent('i', 3)], { itCrew: false });
  let t = oRun(o, 0, 1_000);
  o.debugSummonItCrew(t);
  let said = 0;
  t = oRun(o, t, 2 * 60 * MIN, () => {
    if (o.itCrewOnStage || o.itScreen || o.allChars().includes(o.dez) || o.allChars().includes(o.fenwick)) throw new Error('the IT crew appeared');
    if (o.dez.say || o.fenwick.say) said++;
  });
  assert.equal(said, 0);
  assert.equal(o.itCrewOnStage, false);
});

test('office: the crew never touches the office\'s own rng: same seed, with and without them, identical until their first arrival', () => {
  for (const seed of [1, 7]) {
    const agents = [agent('a'), agent('b', { activity: 'reading' }), idleAgent('i', 3), idleAgent('j', 4)];
    const on = newOffice(agents, { seed });
    const off = newOffice(agents, { seed, itCrew: false });
    let t = 0;
    let says = 0;
    // Their first visit is at least ARRIVE_MIN_MS after the start.
    for (let e = 0; e < ARRIVE_MIN_MS - 6_000; e += STEP) {
      t += STEP;
      on.update(t, STEP, HOST0 + t);
      off.update(t, STEP, HOST0 + t);
      assert.equal(on.itCrewOnStage, false);
      const a = [...on.allChars()];
      const b = [...off.allChars()];
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        const [p, q] = [a[i]!, b[i]!];
        if (p.x !== q.x || p.y !== q.y || p.pose !== q.pose || p.say?.text !== q.say?.text) {
          assert.fail(`seed ${seed}, t ${t}: ${p.id} differs (${p.x},${p.y},${p.pose},${p.say?.text}) vs (${q.x},${q.y},${q.pose},${q.say?.text})`);
        }
        if (p.say) says++;
      }
    }
    assert.ok(says > 0, 'people did talk');
  }
});

// ---------------------------------------------------------------------------
// The Office: desk choice with a crowd of workers, and where the small talk happens

/** The snapshot activities that make an agent sit and work (reading, writing, running, thinking). */
const WORKING = ['reading', 'writing', 'running', 'thinking', 'searching', 'planning'] as const;

/** Reads the brain's private fix (the desk it is going to). */
const fixOf = (o: Office): { seat: SeatDef; worker: string | null } | null => (brainOf(o) as unknown as { fix: { seat: SeatDef; worker: string | null } | null }).fix;

test('office: with several workers seated at their desks, a summon fixes a worker\'s desk, never an empty one, whatever the seed', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const o = newOffice(ids.map((id, i) => agent(id, { activity: WORKING[(i + seed) % WORKING.length]!, startedAt: i + 1 })), { seed });
    let t = oRun(o, 0, 60_000);
    const seated = ids.filter((id) => o.chars.get(id)!.arrived);
    assert.equal(seated.length, ids.length, `seed ${seed}: all are seated`);
    const eligible = new Set(ids.map((id) => o.chars.get(id)!.seat!.id));
    o.debugSummonItCrew(t);
    let target: { seat: SeatDef; worker: string | null } | null = null;
    t = oUntil(o, t, 3_000, () => false, () => { target ??= fixOf(o); });
    assert.ok(target, `seed ${seed}: they went for a desk`);
    const fix = target as { seat: SeatDef; worker: string | null };
    assert.ok(fix.worker !== null && eligible.has(fix.seat.id), `seed ${seed}: the target ${fix.seat.id} has a worker at it`);
  }
});

test('office: every staff desk with a worker at it can be chosen (the visit tile is free and reachable from the elevator)', () => {
  const o = newOffice(Array.from({ length: 12 }, (_, i) => agent(`w${i}`, { activity: 'writing', startedAt: i + 1 })), { seed: 3 });
  oRun(o, 0, 90_000);
  const desks = (o as unknown as { itDesks(): ItDesk[] }).itDesks();
  const working = desks.filter((d) => d.state === 'working');
  assert.ok(working.length >= 10, `${working.length} working desks offered`);
  const ctx = (o as unknown as { itCtx(): ItCtx }).itCtx();
  for (const d of working) {
    const v = d.seat.visit.tile;
    assert.ok(ctx.free(v, ctx.spotAt(v)), `${d.seat.id}: visit tile free`);
    assert.ok(findPath(ctx.grid, ctx.w, ctx.h, ELEVATOR, v), `${d.seat.id}: reachable`);
  }
});

test('office: the front desk and the boss are talked to side-on, with the visit tile as the last stand', () => {
  const o = newOffice([agent('a')]);
  oRun(o, 0, 10_000);
  const ls = (o as unknown as { itListeners(): ItListener[] }).itListeners();
  for (const [who, seat] of [['receptionist', recSeat], ['boss', bossSeat]] as const) {
    const l = ls.find((x) => x.who === who);
    assert.ok(l?.stands, `${who} can be talked to`);
    const st = l!.stands!;
    assert.deepEqual(st[st.length - 1], { tile: seat.visit.tile, facing: seat.visit.facing }, 'the visit tile is the fallback');
    assert.ok(st.length >= 3, `${who}: side stands first`);
    for (const x of st.slice(0, -1)) {
      assert.ok(x.tile.y === seat.tile.y || x.tile.y === seat.tile.y + 1, 'level with the sitter or the desk front');
      assert.equal(world.grid[x.tile.y * world.w + x.tile.x], 1, 'walkable');
      assert.equal(x.facing, x.tile.x < seat.tile.x ? 'right' : 'left', 'facing the desk');
    }
    assert.ok(st[0]!.tile.y === seat.tile.y && st.slice(0, 2).some((x) => x.tile.x < seat.tile.x) && st.slice(0, 2).some((x) => x.tile.x > seat.tile.x), 'one each side, level, first');
  }
});

test('office: small talk with the receptionist is side-on: the speaker beside her, facing across, not on the visit tile', () => {
  let seen = 0;
  for (let seed = 1; seed <= 30 && seen < 6; seed++) {
    const o = newOffice([], { seed });
    let t = oRun(o, 0, 5_000);
    o.debugSummonItCrew(t);
    let talker: { tile: Tile; dir: Dir } | null = null;
    let sidekick: Char | null = null;
    let onVisit = false;
    t = oUntil(o, t, 3 * MIN, () => o.itCrewOnStage === false && t > 10_000, () => {
      const g = [o.dez, o.fenwick].find((c) => c.goal?.key === `it:talk:${o.receptionist.id}`);
      const there = g !== undefined && g.arrived && manhattan(charTile(g, world.tile), g.goal!.tile) === 0;
      if (there) { talker ??= { tile: charTile(g, world.tile), dir: g.dir }; sidekick ??= g === o.dez ? o.fenwick : o.dez; }
      if (there && manhattan(charTile(g, world.tile), recSeat.visit.tile) === 0) onVisit = true;
    });
    if (!talker) continue;
    seen++;
    const tk0 = talker as { tile: Tile; dir: Dir };
    const tt = tk0.tile;
    assert.equal(tt.y >= recSeat.tile.y && tt.y <= recSeat.tile.y + 1, true, `seed ${seed}: level with her: ${tk(tt)}`);
    assert.ok(Math.abs(tt.x - recSeat.tile.x) >= 2 && Math.abs(tt.x - recSeat.tile.x) <= 3, 'beside her, clear of the desk');
    assert.ok(tk0.dir === 'left' || tk0.dir === 'right', `facing across: ${tk0.dir}`);
    assert.equal(onVisit, false, 'not on the visit tile');
    assert.ok(sidekick, 'the sidekick is there too');
  }
  assert.ok(seen >= 3, `${seen} receptionist talks seen`);
});
