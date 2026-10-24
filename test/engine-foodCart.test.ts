// The food cart: one non-agent vendor who pushes a snack trolley in from the elevator every 15-25 minutes, parks it in the
// bullpen aisle for 90 s and calls out; the boss always goes for junk food (once per arrival) and justifies it aloud, and
// idle agents sometimes wander over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charTile, newChar } from '../webview/engine/characters.ts';
import { collectBubbles } from '../webview/engine/bubbles.ts';
import {
  AGENT_CART_SPOTS, AGENT_LINGER_MAX_MS, AGENT_LINGER_MIN_MS, ARRIVE_MAX_MS, ARRIVE_MIN_MS, BOSS_CART_SPOT, CALL_GAP_MAX_MS, CALL_GAP_MIN_MS, CALL_MS,
  CART_TILES, CartBrain, LEAVE_KEY, PARK_KEY, PARK_MS, PARK_SPOT, VENDOR_ID, VENDOR_LOOK_ID, isAgentCartKey,
} from '../webview/engine/foodCart.ts';
import type { CartCtx, CartDecision } from '../webview/engine/foodCart.ts';
import { BOSS_LINES, BOSS_SNACK_LINES, CART_CALLS } from '../webview/engine/lines.ts';
import { CART_HOLD_MS, CART_KEY, CART_PICK_MS } from '../webview/engine/manager.ts';
import { Office } from '../webview/engine/office.ts';
import { IDLE_WANDER_AFTER_MS, buildSpots } from '../webview/engine/targets.ts';
import { rosterEntries, vendorTooltip } from '../webview/engine/tooltip.ts';
import { FOOD_IDS, feetTile, makeRng, tileFeet } from '../webview/engine/types.ts';
import type { Tile } from '../webview/engine/types.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const ART = new URL('../webview/art/', import.meta.url).href;
const artCart = await import(`${ART}foodCart.ts`);
const artChars = await import(`${ART}characters.ts`);

const world = await loadWorld();
const STEP = 33;
const SEC = 1_000;
const MIN = 60_000;
const spots = buildSpots(world);
const ELEVATOR = tileFeet(spots.elevator.tile, world.tile);

const workers = (n: number) => Array.from({ length: n }, (_, i) => agent(`w${i}`, { activity: 'writing', startedAt: i }));
const longIdle = (id: string) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 60_000 });
const key = (t: Tile): string => `${t.x},${t.y}`;

function step(o: Office, t: number, dt = STEP): number {
  t += dt;
  o.update(t, dt, HOST0 + t);
  return t;
}

/** Runs until `done()` (at most `ms`); returns the time. */
function runUntil(o: Office, t0: number, ms: number, done: () => boolean, dt = STEP): number {
  let t = t0;
  for (let e = 0; e < ms && !done(); e += dt) t = step(o, t, dt);
  return t;
}

// ---------------------------------------------------------------------------
// The brain on its own: a stub vendor who arrives the moment they get a goal.

interface Stub {
  ctx: CartCtx;
  me: ReturnType<typeof newChar>;
  bubbles: { on: boolean };
}

function stub(): Stub {
  const me = newChar(VENDOR_ID, 'vendor', VENDOR_LOOK_ID, null, ELEVATOR.x, ELEVATOR.y, 0);
  const bubbles = { on: true };
  const ctx: CartCtx = { me, spots, get speechBubbles() { return bubbles.on; } };
  return { ctx, me, bubbles };
}

/** Plays a decision into the stub character: the goal is reached at once. */
function apply(s: Stub, d: CartDecision, t: number): void {
  const f = tileFeet(d.goal.tile, world.tile);
  s.me.x = f.x;
  s.me.y = f.y;
  s.me.goal = d.goal;
  s.me.arrived = true;
  s.me.arrivedAt = t;
  s.me.pose = d.goal.pose;
  s.me.dir = d.goal.facing;
}

interface Trace {
  /** Times they came in, started parking (arrived at the spot), turned for the elevator, and went out. */
  entries: number[];
  parkedAt: number[];
  leaveAt: number[];
  exits: number[];
  says: { t: number; text: string; ms: number; parked: boolean }[];
  /** Decisions made while off-stage that were not null. */
  offStageDecisions: number;
}

/** Runs the brain at 100 ms steps from `from` to `until`. */
function drive(b: CartBrain, s: Stub, from: number, until: number, each?: (t: number) => void): Trace {
  const tr: Trace = { entries: [], parkedAt: [], leaveAt: [], exits: [], says: [], offStageDecisions: 0 };
  let wasIn = false;
  let wasParked = false;
  let wasLeaving = false;
  for (let t = from; t < until; t += 100) {
    each?.(t);
    const d = b.decide(s.ctx, t);
    if (d && !b.onStage) tr.offStageDecisions++;
    if (!d) {
      if (wasIn) tr.exits.push(t);
      wasIn = wasParked = wasLeaving = false;
      continue;
    }
    if (!wasIn) { tr.entries.push(t); wasIn = true; }
    if (b.parked && !wasParked) tr.parkedAt.push(t);
    wasParked = b.parked;
    if (d.goal.key === LEAVE_KEY && !wasLeaving) tr.leaveAt.push(t);
    wasLeaving = d.goal.key === LEAVE_KEY;
    if (d.say) tr.says.push({ t, text: d.say.text, ms: d.say.ms, parked: b.parked });
    apply(s, d, t);
  }
  return tr;
}

test('the cart first comes 15-25 minutes after the start, then every 15-25 minutes after that', () => {
  const firsts: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const b = new CartBrain(makeRng(seed));
    const tr = drive(b, stub(), 0, 4 * 60 * MIN);
    assert.ok(tr.entries.length >= 8, `seed ${seed}: ${tr.entries.length} arrivals in four hours`);
    const first = tr.entries[0]!;
    assert.ok(first >= ARRIVE_MIN_MS && first <= ARRIVE_MAX_MS + 100, `seed ${seed}: first arrival after ${first} ms`);
    firsts.push(first);
    for (let i = 1; i < tr.entries.length; i++) {
      const gap = tr.entries[i]! - tr.entries[i - 1]!;
      assert.ok(gap >= ARRIVE_MIN_MS && gap <= ARRIVE_MAX_MS + 100, `seed ${seed}: ${gap} ms between arrivals`);
    }
  }
  assert.ok(Math.max(...firsts) - Math.min(...firsts) > 3 * MIN, 'the first arrival varies with the seed');
});

test('they walk to the parking spot, stay parked 90 s, push the cart back to the elevator and are gone', () => {
  const b = new CartBrain(makeRng(5));
  const s = stub();
  const goals: string[] = [];
  const tr = drive(b, s, 0, 60 * MIN, () => { if (s.me.goal) goals.push(s.me.goal.key); });
  assert.ok(tr.entries.length >= 2);
  for (let i = 0; i < tr.entries.length - 1; i++) {
    assert.equal(tr.offStageDecisions, 0, 'off-stage means a null decision');
    assert.ok(tr.parkedAt[i]! - tr.entries[i]! <= 200, 'at the spot on the next tick (the stub arrives at once)');
    assert.ok(Math.abs(tr.leaveAt[i]! - tr.parkedAt[i]! - PARK_MS) <= 200, `parked ${tr.leaveAt[i]! - tr.parkedAt[i]!} ms`);
    assert.ok(tr.exits[i]! - tr.leaveAt[i]! <= 300, 'out of sight right after reaching the elevator');
  }
  assert.ok(goals.includes(PARK_KEY) && goals.includes(LEAVE_KEY));
  // The spot they park at and the elevator they leave by.
  const park = new CartBrain(makeRng(5));
  const s1 = stub();
  assert.equal(park.decide(s1.ctx, 0), null);
  const d1 = park.decide(s1.ctx, ARRIVE_MAX_MS + 1)!;
  assert.deepEqual([d1.goal.key, d1.goal.tile, d1.goal.facing, d1.goal.pose], [PARK_KEY, PARK_SPOT.tile, 'right', 'stand']);
  const s2 = stub();
  const b2 = new CartBrain(makeRng(5));
  assert.equal(b2.decide(s2.ctx, 0), null);
  let t = ARRIVE_MAX_MS + 1;
  apply(s2, b2.decide(s2.ctx, t)!, t);
  t += 100;
  apply(s2, b2.decide(s2.ctx, t)!, t);
  assert.ok(b2.parked);
  t += PARK_MS + 100;
  const out = b2.decide(s2.ctx, t)!;
  assert.deepEqual([out.goal.key, out.goal.tile], [LEAVE_KEY, spots.elevator.tile]);
  assert.ok(!b2.parked, 'not parked once they set off');
});

test('summon brings the arrival forward (nothing while they are in); a disabled cart never comes', () => {
  const b = new CartBrain(makeRng(9));
  const s = stub();
  assert.equal(b.decide(s.ctx, 0), null);
  b.summon(1_000);
  const d = b.decide(s.ctx, 1_000);
  assert.ok(d && b.onStage, 'in at once');
  assert.equal(b.arrival, 1);
  b.summon(2_000);
  apply(s, d, 1_000);
  drive(b, s, 1_100, 10 * MIN);
  assert.equal(b.arrival, 1, 'summoning while they are in does not bring a second visit forward');
  // Disabled.
  const off = new CartBrain(makeRng(9), false);
  off.summon(0);
  assert.equal(drive(off, stub(), 0, 3 * 60 * MIN).entries.length, 0);
  assert.ok(!off.onStage && !off.parked);
});

test('they call a line on arrival at the spot, then every 30-45 s while parked, and nothing off-stage', () => {
  const b = new CartBrain(makeRng(11));
  const tr = drive(b, stub(), 0, 3 * 60 * MIN);
  assert.ok(tr.says.length > 15, `${tr.says.length} calls`);
  for (const say of tr.says) {
    assert.ok(say.parked, 'only while parked');
    assert.ok(CART_CALLS.includes(say.text));
    assert.equal(say.ms, CALL_MS);
  }
  for (let i = 0; i < tr.parkedAt.length - 1; i++) {
    const mine = tr.says.filter((x) => x.t >= tr.parkedAt[i]! && x.t < tr.leaveAt[i]!);
    assert.ok(mine.length >= 2 && mine.length <= 3, `${mine.length} calls in 90 s`);
    assert.ok(mine[0]!.t - tr.parkedAt[i]! <= 100, 'the first call is on arrival at the spot');
    for (let j = 1; j < mine.length; j++) {
      const gap = mine[j]!.t - mine[j - 1]!.t;
      assert.ok(gap >= CALL_GAP_MIN_MS && gap <= CALL_GAP_MAX_MS + 100, `${gap} ms between calls`);
    }
  }
});

test('calls never repeat until the whole pool has been dealt, and the speech-bubble setting silences them', () => {
  const b = new CartBrain(makeRng(13));
  const tr = drive(b, stub(), 0, 16 * 60 * MIN);
  const n = new Set(CART_CALLS).size;
  assert.ok(tr.says.length > 2 * n, `${tr.says.length} calls to deal ${n} lines more than once`);
  const texts = tr.says.map((x) => x.text);
  for (let i = 0; i + n <= texts.length; i += n) assert.equal(new Set(texts.slice(i, i + n)).size, n, `round ${i / n} has a repeat`);
  for (let i = 1; i < texts.length; i++) assert.notEqual(texts[i], texts[i - 1], 'never the same line twice running');
  // Bubbles off: no calls, the visit goes on as before.
  const q = stub();
  q.bubbles.on = false;
  const quiet = drive(new CartBrain(makeRng(13)), q, 0, 60 * MIN);
  assert.equal(quiet.says.length, 0);
  assert.ok(quiet.entries.length >= 2);
});

test('agentVisit: only while parked, about 30 % of the time, only a free spot, none when both are taken', () => {
  const b = new CartBrain(makeRng(17));
  const s = stub();
  for (let i = 0; i < 50; i++) assert.equal(b.agentVisit(() => true), null, 'the cart is away');
  b.summon(0);
  let t = 0;
  apply(s, b.decide(s.ctx, t)!, t);
  t += 100;
  apply(s, b.decide(s.ctx, t)!, t);
  assert.ok(b.parked);
  let hits = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const k = b.agentVisit(() => true);
    if (k) { hits++; seen.add(k); }
  }
  assert.ok(hits > 480 && hits < 720, `${hits} of 2000`);
  assert.deepEqual([...seen].sort(), AGENT_CART_SPOTS.map((x) => x.key).sort(), 'both spots get used');
  for (let i = 0; i < 300; i++) assert.notEqual(b.agentVisit((k) => k !== 'cart:0'), 'cart:0');
  for (let i = 0; i < 300; i++) assert.equal(b.agentVisit(() => false), null);
  for (let i = 0; i < 100; i++) {
    const ms = b.agentLingerMs();
    assert.ok(ms >= AGENT_LINGER_MIN_MS && ms <= AGENT_LINGER_MAX_MS);
  }
});

// ---------------------------------------------------------------------------
// The map: the spots

test('the parking spot and the spots by the cart are clear floor, and the parked cart cuts nothing off', () => {
  const o = new Office(world);
  const grid = o.routeMap.grid;
  const walkable = (t: Tile): boolean => grid[t.y * world.w + t.x] === 1;
  const reserved = new Set<string>();
  for (const s of world.seats) { reserved.add(key(s.tile)); reserved.add(key(s.visit.tile)); }
  const p = world.poi;
  for (const t of [p.managerDoor, p.managerInsideDoor.tile, p.elevator.tile, p.reception.tile, p.delegate.tile, ...p.managerDoorQueue.map((x) => x.tile)]) reserved.add(key(t));
  for (const n of [...spots.idle, ...spots.cooler, ...spots.cabinets, ...spots.copier, ...spots.shredder, ...spots.lobby, spots.easel, spots.whiteboard]) reserved.add(key(n.spot.tile));
  reserved.add(key(p.sulk.tile));
  const mine = [PARK_SPOT.tile, BOSS_CART_SPOT.tile, ...CART_TILES, ...AGENT_CART_SPOTS.map((s) => s.spot.tile)];
  assert.equal(new Set(mine.map(key)).size, mine.length, 'no two of them share a tile');
  for (const t of mine) {
    assert.ok(walkable(t), `${key(t)} is walkable floor`);
    assert.ok(!reserved.has(key(t)), `${key(t)} is not a seat, visit tile, door, queue spot or other spot`);
  }
  // The cart sits ahead of the vendor: on the tile next to them (and a little over the one after).
  assert.equal(PARK_SPOT.facing, 'right');
  assert.deepEqual(CART_TILES, [{ x: PARK_SPOT.tile.x + 1, y: PARK_SPOT.tile.y }, { x: PARK_SPOT.tile.x + 2, y: PARK_SPOT.tile.y }]);
  // The cart's sprite covers the tiles in CART_TILES and nothing else on its row (the art's own placement).
  const feet = tileFeet(PARK_SPOT.tile, world.tile);
  const cart = artCart.foodCartPlacement('right', feet.x, feet.y);
  const size = artCart.FOOD_CART_SIZE.right;
  assert.deepEqual([Math.floor(cart.x / 16), Math.floor((cart.x + size.w - 1) / 16)], [PARK_SPOT.tile.x, CART_TILES[1]!.x], 'covers the vendor tile edge, the cart tiles');
  assert.equal(Math.floor((cart.y + size.h - 2) / 16), PARK_SPOT.tile.y, 'its wheels are on the row (bar one pixel of their shadow)');
  // The boss reaches over its far end; the agents stand on the far side, facing it.
  assert.deepEqual([BOSS_CART_SPOT.tile.x, BOSS_CART_SPOT.tile.y, BOSS_CART_SPOT.facing], [CART_TILES[1]!.x + 1, CART_TILES[1]!.y, 'left']);
  for (const a of AGENT_CART_SPOTS) assert.deepEqual([a.spot.tile.y, a.spot.facing, a.spot.pose], [CART_TILES[0]!.y - 1, 'down', 'stand']);
  // Blocking the cart's tiles leaves every other floor tile as reachable from the elevator as it was.
  const reach = (g: Uint8Array): Set<string> => {
    const seen = new Set<string>([key(p.elevator.tile)]);
    const todo = [p.elevator.tile];
    while (todo.length > 0) {
      const t = todo.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = { x: t.x + dx, y: t.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= world.w || n.y >= world.h || g[n.y * world.w + n.x] !== 1 || seen.has(key(n))) continue;
        seen.add(key(n));
        todo.push(n);
      }
    }
    return seen;
  };
  const before = reach(grid);
  const blocked = new Uint8Array(grid);
  for (const t of CART_TILES) blocked[t.y * world.w + t.x] = 0;
  const after = reach(blocked);
  for (const t of CART_TILES) before.delete(key(t));
  assert.deepEqual([...after].sort(), [...before].sort());
  // Nor is any desk's visit tile or any spot lost.
  for (const s of world.seats) assert.ok(after.has(key(s.visit.tile)) || !before.has(key(s.visit.tile)), `${s.id}'s visit tile`);
  for (const t of mine) if (!CART_TILES.some((c) => key(c) === key(t))) assert.ok(after.has(key(t)), `${key(t)} reachable`);
});

test('the engine mirrors the art: food ids, the vendor look, the cart spot facing', () => {
  assert.deepEqual([...FOOD_IDS], [...artChars.FOOD_IDS]);
  assert.equal(VENDOR_LOOK_ID, artChars.VENDOR_LOOK);
  assert.ok(isAgentCartKey('cart:0') && isAgentCartKey('cart:1'));
  assert.ok(!isAgentCartKey('cart:boss') && !isAgentCartKey('cart:park') && !isAgentCartKey('idle:coffee') && !isAgentCartKey(null) && !isAgentCartKey(undefined));
});

// ---------------------------------------------------------------------------
// In the office

test('the cart comes by itself 15-25 minutes in; nothing of it before, and the office rng is untouched until then', () => {
  for (const seed of [1, 2, 3]) {
    const a = new Office(world, { seed });
    const b = new Office(world, { seed, foodCart: false });
    const snap = [longIdle('a'), longIdle('b'), ...workers(2)];
    a.applySnapshot(snap, 0, HOST0);
    b.applySnapshot(snap, 0, HOST0);
    let t = 0;
    let first = -1;
    for (; t < ARRIVE_MIN_MS - 1_000; t += 100) {
      a.update(t, 100, HOST0 + t);
      b.update(t, 100, HOST0 + t);
      assert.ok(!a.vendorOnStage && !a.cartParked);
    }
    // The same office, with and without the cart, has done exactly the same so far.
    for (const [id, c] of a.chars) {
      const d = b.chars.get(id)!;
      assert.deepEqual([c.x, c.y, c.goal?.key, c.pose], [d.x, d.y, d.goal?.key, d.pose], `${id} (seed ${seed})`);
    }
    assert.deepEqual([a.manager.x, a.manager.y, a.manager.goal?.key], [b.manager.x, b.manager.y, b.manager.goal?.key]);
    for (; t < ARRIVE_MAX_MS + 2_000 && first < 0; t += 100) {
      a.update(t, 100, HOST0 + t);
      if (a.vendorOnStage) first = t;
    }
    assert.ok(first >= ARRIVE_MIN_MS - 1_000 && first <= ARRIVE_MAX_MS + 200, `seed ${seed}: in at ${first}`);
  }
});

test('the vendor pushes the cart in with pushCart, parks standing facing right, and the cart follows them', () => {
  const o = new Office(world, { seed: 4 });
  o.applySnapshot(workers(1), 0, HOST0);
  const v = o.vendor;
  assert.ok(!o.vendorOnStage && !o.allChars().includes(v));
  let t = 1_000;
  o.debugSummonCart(t);
  t = step(o, t);
  assert.ok(o.vendorOnStage && o.allChars().includes(v));
  assert.equal(o.allChars().filter((c) => c === v).length, 1);
  assert.equal(v.kind, 'vendor');
  assert.equal(v.look, 'vendor');
  assert.equal(v.agent, null);
  assert.ok(!o.cartParked, 'not parked while it is being pushed in');
  const g0 = new Set(CART_TILES.map(key));
  let moving = 0;
  let prev = { x: v.x, y: v.y };
  while (!o.cartParked && t < 60_000) {
    t = step(o, t);
    if (!v.arrived) {
      moving++;
      assert.equal(v.pose, 'pushCart', 'pushCart on the move');
      // The cart is drawn ahead of them in the way they face: that is the way they just moved.
      const dx = v.x - prev.x;
      const dy = v.y - prev.y;
      if (dx !== 0 || dy !== 0) {
        const ahead = artCart.foodCartPlacement(v.dir, v.x, v.y);
        const anchor = { x: ahead.x + artCart.FOOD_CART_ANCHOR[v.dir].x, y: ahead.y + artCart.FOOD_CART_ANCHOR[v.dir].y };
        assert.ok((anchor.x - v.x) * dx + (anchor.y - v.y) * dy > 0, `cart ahead of the vendor going ${v.dir}`);
        assert.equal(ahead.sortY, v.y + artCart.FOOD_CART_SORT_DY[v.dir]);
      }
    }
    if (!o.cartParked) assert.ok(![...g0].some((k) => o.routeMap.grid[Number(k.split(',')[1]) * world.w + Number(k.split(',')[0])] === 0), 'the cart tiles are free while it is pushed in');
    prev = { x: v.x, y: v.y };
  }
  assert.ok(moving > 60, `walked for ${moving} steps`);
  assert.ok(o.cartParked && v.arrived);
  assert.deepEqual(charTile(v, world.tile), PARK_SPOT.tile);
  assert.equal(v.pose, 'stand');
  assert.equal(v.dir, 'right');
  // While parked its tiles are closed to walkers (routes go round); the vendor's own tile and the boss's spot are not.
  for (const c of CART_TILES) assert.equal(o.routeMap.grid[c.y * world.w + c.x], 0);
  assert.equal(o.routeMap.grid[PARK_SPOT.tile.y * world.w + PARK_SPOT.tile.x], 1);
  assert.equal(o.routeMap.grid[BOSS_CART_SPOT.tile.y * world.w + BOSS_CART_SPOT.tile.x], 1);
  const placed = artCart.foodCartPlacement(v.dir, v.x, v.y);
  assert.deepEqual([placed.x, placed.y], [v.x + 19 - 15, v.y + 1 - 22]);
  // It stays 90 s, then they set off with the cart to the elevator (pushCart again) and are gone, the tiles open again.
  const parkedAt = t;
  t = runUntil(o, t, 2 * MIN, () => !o.cartParked);
  assert.ok(Math.abs(t - parkedAt - PARK_MS) <= 2 * STEP + 100, `parked ${t - parkedAt} ms`);
  let sawPush = false;
  t = runUntil(o, t, 60_000, () => { if (!v.arrived && v.pose === 'pushCart') sawPush = true; return !o.vendorOnStage; });
  assert.ok(sawPush && !o.vendorOnStage && !o.allChars().includes(v));
  assert.equal(v.say, null);
  for (const c of CART_TILES) assert.equal(o.routeMap.grid[c.y * world.w + c.x], 1, 'the tiles are open again');
  assert.equal(o.cartParked, false);
});

test('while parked the vendor calls out (speech bubbles on), and the bubble is theirs; with bubbles off nobody hears them', () => {
  for (const on of [true, false]) {
    const o = new Office(world, { seed: 6 });
    o.speechBubbles = on;
    o.applySnapshot([], 0, HOST0);
    o.debugSummonCart(500);
    const heard: string[] = [];
    let bubbles = 0;
    let t = 500;
    for (; t < 500 + 100 * SEC; t = step(o, t)) {
      const s = o.vendor.say;
      if (s && t < s.until && heard[heard.length - 1] !== s.text) heard.push(s.text);
      if (o.vendorOnStage && collectBubbles([...o.chars.values()], o.manager, [], { speechBubbles: on, managerName: 'You', highlightId: null }, t, o.receptionist, undefined, o.vendor).some((r) => r.key === 'vnd:say')) bubbles++;
    }
    if (on) {
      assert.ok(heard.length >= 2 && heard.every((x) => CART_CALLS.includes(x)), `heard ${heard.length}`);
      assert.ok(bubbles > 0);
    } else {
      assert.equal(heard.length, 0);
      assert.equal(bubbles, 0);
    }
  }
  // Not drawn while off-stage: the bubble collector is only given them while they are in.
  const q = new Office(world);
  assert.ok(!collectBubbles([], q.manager, [], { speechBubbles: true, managerName: 'You', highlightId: null }, 0, q.receptionist, undefined).some((r) => r.key === 'vnd:say'));
  assert.equal(vendorTooltip().title, 'Food cart');
  assert.equal(vendorTooltip().hint, undefined, 'a click does nothing');
});

// ---------------------------------------------------------------------------
// The boss

/** One visit to the cart as seen from outside. */
interface Snack { from: number; to: number; food: string | null; says: { t: number; text: string; until: number }[] }

/** Runs the office for `ms` and writes down every time the boss picks food. */
function watchBoss(o: Office, t0: number, ms: number, each?: (t: number) => void): { snacks: Snack[]; t: number; says: string[] } {
  const snacks: Snack[] = [];
  const says: string[] = [];
  let cur: Snack | null = null;
  let lastSay: unknown = null;
  let t = t0;
  for (let e = 0; e < ms; e += STEP) {
    each?.(t);
    t = step(o, t);
    const m = o.manager;
    const picking = m.arrived && m.pose === 'pickFood' && m.goal?.key === CART_KEY;
    if (picking && !cur) { cur = { from: t, to: t, food: m.goal!.food ?? null, says: [] }; snacks.push(cur); }
    if (cur && picking) cur.to = t;
    if (cur && !picking) cur = null;
    if (m.say && m.say !== lastSay) {
      lastSay = m.say;
      says.push(m.say.text);
      if (cur) cur.says.push({ t, text: m.say.text, until: m.say.until });
    }
  }
  return { snacks, t, says };
}

test('the boss goes to the cart once per arrival, picks a food, says a snack line, holds it up and goes back to his desk', () => {
  const o = new Office(world, { seed: 8 });
  o.applySnapshot(workers(2), 0, HOST0);
  o.debugSummonCart(1_000);
  const { snacks, t, says } = watchBoss(o, 1_000, 100 * SEC);
  assert.equal(snacks.length, 1, 'one visit during one arrival');
  const s = snacks[0]!;
  assert.ok(FOOD_IDS.includes(s.food as never), `food ${s.food}`);
  assert.deepEqual(says, [s.says[0]!.text], 'one line');
  assert.ok(BOSS_SNACK_LINES.includes(s.says[0]!.text) && !BOSS_LINES.includes(s.says[0]!.text));
  assert.ok(s.says[0]!.t - s.from >= CART_PICK_MS - 2 * STEP && s.says[0]!.t - s.from <= CART_PICK_MS + 2 * STEP, `said after ${s.says[0]!.t - s.from} ms`);
  assert.equal(s.says[0]!.until - s.says[0]!.t, CART_HOLD_MS, 'the line shows as long as he holds the food');
  assert.ok(s.to - s.from >= CART_PICK_MS + CART_HOLD_MS - 2 * STEP && s.to - s.from <= CART_PICK_MS + CART_HOLD_MS + 2 * STEP, `picked for ${s.to - s.from} ms`);
  // He stood where he was meant to, facing the cart; and he is back at his desk by the end.
  assert.equal(o.manager.goal!.key, `seat:${o.managerSeat.id}`);
  assert.ok(o.manager.arrived && t > 0);
  assert.ok(!o.brain.atCart);
});

test('he stands at the boss spot facing the cart, and a different food can come up each time', () => {
  const foods = new Set<string>();
  const lines = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const o = new Office(world, { seed });
    o.applySnapshot([], 0, HOST0);
    o.debugSummonCart(500);
    let stood = false;
    const { snacks } = watchBoss(o, 500, 60 * SEC, () => {
      const m = o.manager;
      if (m.pose === 'pickFood' && m.arrived) {
        stood = true;
        assert.deepEqual(feetTile(m.x, m.y), BOSS_CART_SPOT.tile);
        assert.equal(m.dir, BOSS_CART_SPOT.facing);
      }
    });
    assert.ok(stood && snacks.length === 1, `seed ${seed}`);
    foods.add(snacks[0]!.food!);
    for (const sy of snacks[0]!.says) lines.add(sy.text);
  }
  assert.deepEqual([...foods].sort(), [...FOOD_IDS].sort(), 'all three foods turn up');
  assert.ok(lines.size >= 6, `${lines.size} different lines in 12 visits`);
});

test('every arrival gets one visit; with the boss quotes off he says nothing but still helps himself', () => {
  for (const quotes of [true, false]) {
    const o = new Office(world, { seed: 12 });
    o.bossQuotes = quotes;
    o.applySnapshot(workers(1), 0, HOST0);
    let t = 1_000;
    let visits = 0;
    let said = 0;
    for (let round = 0; round < 3; round++) {
      o.debugSummonCart(t);
      const r = watchBoss(o, t, 3 * MIN);
      visits += r.snacks.length;
      said += r.says.filter((x) => BOSS_SNACK_LINES.includes(x)).length;
      t = r.t;
      assert.ok(!o.vendorOnStage, 'the cart has gone again');
    }
    assert.equal(visits, 3, 'three arrivals, three visits');
    assert.equal(said, quotes ? 3 : 0);
  }
});

test('he does not go while a desk visit or the door has him; he comes back while the cart is still there', () => {
  const o = new Office(world, { seed: 14 });
  const prompt = (at: number) => agent('p', { activity: 'writing', lastPromptAt: at });
  o.applySnapshot([prompt(HOST0 - 120_000), agent('k', { activity: 'writing' })], 0, HOST0);
  let t = 1_000;
  o.debugSummonCart(t);
  // Wait until he has set off for the cart, then a prompt arrives: the visit comes first.
  t = runUntil(o, t, 30 * SEC, () => o.manager.goal?.key === CART_KEY);
  assert.equal(o.manager.goal!.key, CART_KEY);
  assert.ok(!o.cartParked || o.brain.atCart);
  o.applySnapshot([prompt(HOST0 + t), agent('k', { activity: 'writing' })], t, HOST0 + t);
  t = step(o, t);
  assert.equal(o.manager.goal!.key, 'visit:p', 'the visit takes over at once');
  assert.ok(!o.brain.atCart);
  // Once the visit is over he goes and has his snack, with the cart still there.
  const keys: string[] = [];
  const r = watchBoss(o, t, 60 * SEC, () => { keys.push(o.manager.goal?.key ?? ''); });
  assert.equal(r.snacks.length, 1, 'once the visit was over he went and had his snack, with the cart still there');
  assert.ok(keys.includes('visit:p') && keys.includes(CART_KEY));
  assert.ok(keys.indexOf('visit:p') < keys.lastIndexOf(CART_KEY), 'the visit came before the snack');

  // The door: a worker waiting there holds him back for as long as they wait.
  const d = new Office(world, { seed: 15 });
  d.applySnapshot([agent('q', { activity: 'needsYou', status: 'waiting' })], 0, HOST0);
  let u = 1_000;
  d.debugSummonCart(u);
  const atDoor: string[] = [];
  u = runUntil(d, u, 40 * SEC, () => false, STEP);
  for (let e = 0; e < 2_000; e += STEP) { u = step(d, u); atDoor.push(d.manager.goal?.key ?? ''); }
  assert.ok(d.cartParked, 'the cart is still parked');
  assert.ok(atDoor.every((k) => k === 'mgr:door'), 'he stayed at the door');
  assert.ok(!d.brain.atCart);
  d.applySnapshot([agent('q', { activity: 'writing' })], u, HOST0 + u);
  const after = watchBoss(d, u, 30 * SEC);
  assert.equal(after.snacks.length, 1, 'with the door clear he went for his snack');
});

test('a sulking boss (a Fable agent has his office) stays where he is', () => {
  const o = new Office(world, { seed: 16 });
  o.applySnapshot([agent('f', { activity: 'writing', model: 'claude-fable-5', startedAt: HOST0 })], 0, HOST0);
  assert.ok(o.managerSulking);
  o.debugSummonCart(1_000);
  const r = watchBoss(o, 1_000, 60 * SEC);
  assert.ok(o.managerSulking && o.cartParked, 'still sulking with the cart parked');
  assert.equal(r.snacks.length, 0, 'no snack while he sulks');
  assert.ok(!o.brain.atCart);
});

test('a due snoop waits: the cart comes first', () => {
  const o = new Office(world, { seed: 18 });
  const asks = (n: number) => [...workers(3), ...(n > 0 ? [agent('q', { activity: 'needsYou', status: 'waiting' })] : [])];
  o.applySnapshot(asks(1), 0, HOST0);
  let t = 1_000;
  o.debugSummonCart(t);
  t = runUntil(o, t, 30 * SEC, () => o.cartParked);
  assert.ok(o.cartParked);
  o.debugSnoopNow(t);
  // He is at the door; both the cart and the snoop are due, and the door lets go.
  for (let i = 0; i < 20; i++) t = step(o, t);
  assert.equal(o.manager.goal!.key, 'mgr:door');
  o.applySnapshot(workers(3), t, HOST0 + t);
  const order: string[] = [];
  runUntil(o, t, 80 * SEC, () => {
    const k = o.manager.goal?.key ?? '';
    const tag = k === CART_KEY ? 'cart' : k.startsWith('snoop:') ? 'snoop' : null;
    if (tag && order[order.length - 1] !== tag) order.push(tag);
    return false;
  });
  assert.deepEqual(order.slice(0, 2), ['cart', 'snoop'], `order ${order.join(', ')}`);
});

test('a snoop already under way is finished; the cart then gets him', () => {
  const o = new Office(world, { seed: 19 });
  o.applySnapshot(workers(3), 0, HOST0);
  let t = 1_000;
  o.debugSnoopNow(t);
  t = runUntil(o, t, 30 * SEC, () => o.brain.snooping !== null);
  assert.ok(o.brain.snooping);
  o.debugSummonCart(t);
  const order: string[] = [];
  runUntil(o, t, 60 * SEC, () => {
    const k = o.manager.goal?.key ?? '';
    const tag = k === CART_KEY ? 'cart' : k.startsWith('snoop:') ? 'snoop' : null;
    if (tag && order[order.length - 1] !== tag) order.push(tag);
    return false;
  });
  assert.deepEqual(order.slice(0, 2), ['snoop', 'cart']);
});

// ---------------------------------------------------------------------------
// Idle agents

test('idle agents sometimes go over to the cart, stand facing it about 5 s, then carry on; working agents never do', () => {
  let visits = 0;
  const lingers: number[] = [];
  const spotsUsed = new Set<string>();
  for (let seed = 1; seed <= 10; seed++) {
    const o = new Office(world, { seed });
    o.applySnapshot([longIdle('i1'), longIdle('i2'), longIdle('i3'), ...workers(2)], 0, HOST0);
    o.debugSummonCart(1_000);
    const was = new Map<string, number>();
    let t = 1_000;
    for (let e = 0; e < 100 * SEC; e += STEP) {
      t = step(o, t);
      const holders = new Map<string, string>();
      for (const c of o.chars.values()) {
        const k = c.goal?.key ?? '';
        if (isAgentCartKey(k)) {
          assert.ok(c.id.startsWith('i'), `${c.id} is not idle but went to the cart`);
          assert.ok(o.cartParked, 'nobody is at the cart once it has gone');
          assert.ok(!holders.has(k), `${k} is held by two agents at once`);
          holders.set(k, c.id);
          assert.equal(o.res.holder(k), c.id, 'the spot is reserved by whoever is going there');
          if (c.arrived) {
            const spot = AGENT_CART_SPOTS.find((s) => s.key === k)!.spot;
            assert.deepEqual([charTile(c, world.tile), c.dir, c.pose], [spot.tile, spot.facing, spot.pose]);
            if (!was.has(c.id)) { was.set(c.id, t); visits++; spotsUsed.add(k); }
          }
        } else if (was.has(c.id)) {
          // A chat at the cooler or the cart leaving cuts the stay short; any other stay lasts about 5 s.
          if (o.cartParked && !o.chatIds().includes(c.id)) lingers.push(t - was.get(c.id)!);
          was.delete(c.id);
        }
        if (c.id.startsWith('w')) assert.ok(!isAgentCartKey(k) && !isAgentCartKey(c.wanderKey), 'working agents are never pulled');
      }
    }
    // Once the cart has gone nobody is left standing by it.
    t = runUntil(o, t, 60 * SEC, () => !o.vendorOnStage);
    for (const c of o.chars.values()) assert.ok(!isAgentCartKey(c.goal?.key), `${c.id} still by the cart`);
  }
  assert.ok(visits >= 3, `${visits} visits over ten arrivals`);
  assert.ok(lingers.length >= 3);
  for (const ms of lingers) assert.ok(ms >= AGENT_LINGER_MIN_MS - STEP && ms <= AGENT_LINGER_MAX_MS + 3 * STEP, `stood ${ms} ms`);
  assert.ok(spotsUsed.size >= 1);
});

// ---------------------------------------------------------------------------
// The vendor is nobody's colleague

test('the vendor is never in the door queue, the roster, the snoop, seating or a chat', () => {
  const o = new Office(world, { seed: 21 });
  o.applySnapshot([...workers(3), longIdle('i1'), longIdle('i2'), agent('q', { activity: 'needsYou', status: 'waiting' })], 0, HOST0);
  o.debugSummonCart(1_000);
  let t = 1_000;
  let inFor = 0;
  let hitWhileParked = 0;
  for (let e = 0; e < 110 * SEC; e += STEP) {
    t = step(o, t);
    if (o.vendorOnStage) inFor++;
    assert.ok(!o.queueIds.includes(VENDOR_ID));
    assert.ok(!o.chars.has(VENDOR_ID));
    assert.ok(!o.chatIds().includes(VENDOR_ID));
    assert.notEqual(o.brain.snooping, VENDOR_ID);
    assert.equal(o.assigner.get(VENDOR_ID), undefined, 'no desk or look from the assigner');
    assert.equal(o.vendor.seat, null);
    assert.equal(o.vendor.wanderKey, null);
    assert.ok(!rosterEntries(o, HOST0 + t).some((r) => r.id === VENDOR_ID));
    const hit = o.hitTest(o.vendor.x, o.vendor.y - 8)?.id === VENDOR_ID;
    if (!o.vendorOnStage) assert.ok(!hit, 'not hit-testable off-stage');
    else if (o.cartParked && o.vendor.arrived && hit) hitWhileParked++;
  }
  assert.ok(inFor > 90 * SEC / STEP, 'they were in for the whole stay');
  assert.ok(hitWhileParked > 0, 'hovering them works while they are parked');
});

// ---------------------------------------------------------------------------
// Debug hooks

test('the debug hooks: summon the cart, summon the cleaner, make the snoop due', () => {
  const o = new Office(world, { seed: 22 });
  o.applySnapshot(workers(4), 0, HOST0);
  assert.ok(!o.vendorOnStage && !o.cleanerOnStage);
  let t = 1_000;
  o.debugSummonCart(t);
  o.debugSummonCleaner(t);
  o.debugSnoopNow(t);
  for (let i = 0; i < 3; i++) t = step(o, t);
  assert.ok(o.vendorOnStage, 'the cart is in at once');
  assert.ok(o.cleanerOnStage, 'the cleaner starts a round at once');
  // The snoop (the first thing the free boss does: the cart is still on its way) happens within seconds, not minutes.
  const r = watchBoss(o, t, 2 * MIN);
  assert.ok(o.brain.snooping !== undefined);
  assert.equal(r.snacks.length, 1, 'and he still goes to the cart once it is parked');
  // Calling them again while they are in changes nothing, and the cart comes round again when summoned after leaving.
  const t2 = runUntil(o, t + 2 * MIN, 5 * MIN, () => !o.vendorOnStage && !o.cleanerOnStage);
  assert.ok(!o.vendorOnStage && !o.cleanerOnStage);
  o.debugSummonCart(t2);
  step(o, t2);
  assert.ok(o.vendorOnStage);
});

test('the snoop timer made due by the debug hook starts a snoop now, not in 4-8 minutes', () => {
  const o = new Office(world, { seed: 23, foodCart: false });
  o.applySnapshot(workers(3), 0, HOST0);
  let t = 1_000;
  for (let i = 0; i < 5; i++) t = step(o, t);
  assert.equal(o.brain.snooping, null);
  o.debugSnoopNow(t);
  t = runUntil(o, t, 5_000, () => o.brain.snooping !== null);
  assert.ok(o.brain.snooping, 'he is on his way within a second or two');
});
