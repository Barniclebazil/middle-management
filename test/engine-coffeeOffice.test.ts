// Effort coffee in the office: how often agents sip by effort, that a sip is only ever taken by a seated worker (and
// only changes how it is drawn), the mug leaving the desk during a sip, and the walk to the coffee maker for a refill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office, REFILL_PAUSE_MS } from '../webview/engine/office.ts';
import { DESK_SIP_CYCLE_MS, MUG_SIPS, SIP_EVERY_MS, newCoffee } from '../webview/engine/coffeeLogic.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import type { EffortLevel } from '../src/shared/protocol.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const STEP = 33;
const COFFEE = 'idle:coffee';

/** Runs the simulation for `ms` in 33 ms steps (host clock = HOST0 + t); `each` sees every step. */
function run(o: Office, t0: number, ms: number, each?: (t: number) => void): number {
  let t = t0;
  for (let e = 0; e < ms; e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    each?.(t);
  }
  return t;
}

/** Runs until `done()` (at most `ms`); returns the time. */
function runUntil(o: Office, t0: number, ms: number, done: (t: number) => boolean): number {
  let t = t0;
  for (let e = 0; e < ms && !done(t); e += STEP) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
  }
  return t;
}

const writer = (id: string, effort?: EffortLevel, over = {}) => agent(id, { activity: 'writing', ...(effort ? { effort } : {}), ...over });
const longIdle = (id: string, over = {}) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 60_000, ...over });

test('the deskSip cycle length mirrors the art', async () => {
  const spec: string = new URL('../webview/art/characters.ts', import.meta.url).href;
  const art = await import(spec);
  assert.equal(DESK_SIP_CYCLE_MS, art.poseCycleMs('deskSip'));
});

test('a max-effort worker sips several times as often as a low-effort one, empty mug or not', () => {
  const o = new Office(world, { seed: 11 });
  o.applySnapshot([writer('hi', 'max'), writer('lo', 'low')], 0, HOST0);
  const sips = { hi: 0, lo: 0 };
  const was = { hi: false, lo: false };
  run(o, 0, 20 * 60_000, (t) => {
    for (const id of ['hi', 'lo'] as const) {
      const c = o.chars.get(id)!;
      const now = o.sipOf(c, t) !== null;
      if (now && !was[id]) sips[id]++;
      was[id] = now;
    }
  });
  assert.ok(sips.lo >= 8 && sips.lo <= 18, `low: ${sips.lo} sips in 20 min (about one per ${SIP_EVERY_MS.low / 1000} s)`);
  assert.ok(sips.hi >= 5 * sips.lo, `max ${sips.hi} vs low ${sips.lo}`);
});

test('a sip is purely visual: pose, goal and activity stay; the desk drops its mug meanwhile', () => {
  const o = new Office(world, { seed: 12 });
  o.applySnapshot([writer('a', 'max')], 0, HOST0);
  const a = o.chars.get('a')!;
  const goal = a.goal;
  const desk = a.seat!.deskId;
  let sipping = 0;
  let other = 0;
  run(o, 0, 60_000, (t) => {
    const sip = o.sipOf(a, t);
    const desks = o.sippingDesks(t);
    assert.deepEqual([...desks], sip ? [desk] : [], 'the desk shows no mug exactly while its owner sips');
    if (sip) {
      sipping++;
      assert.equal(a.pose, 'sitType', 'the character keeps its work pose');
      assert.deepEqual(a.goal, goal, 'the goal is the same');
      assert.equal(a.agent!.activity, 'writing');
      assert.equal(sip.effort, 'max');
      assert.ok(sip.elapsedMs >= 0 && sip.elapsedMs <= DESK_SIP_CYCLE_MS, `elapsed ${sip.elapsedMs}`);
    } else other++;
  });
  assert.ok(sipping > 20 && other > 20, 'sips happen and the rest of the time is plain work');
});

test('a sip lasts one cycle at the effort speed', () => {
  const o = new Office(world, { seed: 13 });
  o.applySnapshot([writer('a', 'high')], 0, HOST0);
  const a = o.chars.get('a')!;
  let start = -1;
  let end = -1;
  run(o, 0, 120_000, (t) => {
    const s = o.sipOf(a, t) !== null;
    if (s && start < 0) start = t;
    if (!s && start >= 0 && end < 0) end = t;
  });
  assert.ok(start > 0 && end > start);
  assert.ok(Math.abs(end - start - DESK_SIP_CYCLE_MS / 1.4) <= 2 * STEP, `high sips ${end - start} ms`);
});

test('only seated workers sip: not idle, waiting, away or leaving agents', () => {
  const o = new Office(world, { seed: 14 });
  o.applySnapshot([
    longIdle('idle', { effort: 'max' }),
    agent('wait', { activity: 'needsYou', status: 'waiting', effort: 'max' }),
    agent('cab', { activity: 'searching', effort: 'max' }),
    agent('deleg', { activity: 'delegating', effort: 'max' }),
    writer('work', 'max'),
  ], 0, HOST0);
  let workSips = 0;
  run(o, 0, 10 * 60_000, (t) => {
    for (const c of o.chars.values()) {
      const sip = o.sipOf(c, t);
      if (c.id === 'work') { if (sip) workSips++; continue; }
      assert.equal(sip, null, `${c.id} (${c.goal?.key}) never sips`);
      assert.equal(c.coffee!.sips, MUG_SIPS, `${c.id}'s mug is untouched`);
    }
  });
  assert.ok(workSips > 0, 'the one seated worker does');
});

test('an agent called away mid-sip stops sipping at once', () => {
  const o = new Office(world, { seed: 15 });
  o.applySnapshot([writer('a', 'max')], 0, HOST0);
  const a = o.chars.get('a')!;
  let t = runUntil(o, 0, 60_000, (now) => o.sipOf(a, now) !== null);
  assert.ok(o.sipOf(a, t));
  o.applySnapshot([agent('a', { activity: 'needsYou', status: 'waiting', effort: 'max' })], t, HOST0 + t);
  t = run(o, t, 3_000);
  assert.equal(o.sipOf(a, t), null);
  assert.equal(o.sippingDesks(t).size, 0);
});

test('a worker with no effort sips at the Claude default for its model, else medium', () => {
  const o = new Office(world, { seed: 16 });
  o.applySnapshot([writer('a')], 0, HOST0);
  const a = o.chars.get('a')!;
  const t = runUntil(o, 0, 120_000, (now) => o.sipOf(a, now) !== null);
  assert.equal(o.sipOf(a, t)!.effort, 'medium');
  const seen: (string | undefined)[] = [];
  o.defaultEffort = (m) => { seen.push(m); return 'xhigh'; };
  assert.equal(o.sipOf(a, t)!.effort, 'xhigh');
  assert.ok(seen.length > 0);
  // The agent's own effort wins over the default.
  o.applySnapshot([writer('a', 'low')], t, HOST0 + t);
  assert.equal(o.sipOf(a, t)!.effort, 'low');
});

test('fifteen workers on first load do not sip in step', () => {
  const o = new Office(world, { seed: 17 });
  o.applySnapshot(Array.from({ length: 15 }, (_, i) => writer(`w${i}`, 'high', { startedAt: i })), 0, HOST0);
  const first = new Map<string, number>();
  let atOnce = 0;
  run(o, 0, 60_000, (t) => {
    let n = 0;
    for (const c of o.chars.values()) {
      if (!o.sipOf(c, t)) continue;
      n++;
      if (!first.has(c.id)) first.set(c.id, t);
    }
    atOnce = Math.max(atOnce, n);
  });
  assert.equal(first.size, 15, 'everyone has sipped within 60 s at high effort');
  assert.ok(new Set(first.values()).size >= 10, 'first sips are spread out');
  assert.ok(atOnce <= 5, `at most ${atOnce} sip together`);
  const fresh = new Office(world, { seed: 17 });
  fresh.applySnapshot([writer('a', 'max')], 0, HOST0);
  fresh.fastForward(0);
  assert.equal(fresh.sippingDesks(0).size, 0, 'nobody sips straight after load or a fast-forward');
});

test('an idle agent with an empty mug goes to the coffee maker, refills, and is back at work with a full mug', () => {
  const o = new Office(world, { seed: 18 });
  o.applySnapshot([writer('a', 'low')], 0, HOST0);
  const a = o.chars.get('a')!;
  a.coffee = { ...a.coffee!, sips: 0 };
  const seatKey = a.goal!.key;
  let t = run(o, 0, 30_000);
  assert.equal(a.goal!.key, seatKey, 'working with an empty mug it stays put');
  assert.equal(a.coffee!.sips, 0, 'and the mug stays empty');
  o.applySnapshot([longIdle('a')], t, HOST0 + t);
  t = runUntil(o, t, 90_000, () => a.arrived && a.goal?.key === COFFEE);
  assert.equal(a.goal!.key, COFFEE, 'its first choice is the coffee maker');
  assert.equal(o.res.holder(COFFEE), 'a');
  assert.equal(a.coffee!.sips, 0, 'not refilled on arrival');
  const arrived = a.arrivedAt;
  t = runUntil(o, t, 20_000, () => a.coffee!.sips > 0);
  assert.equal(a.coffee!.sips, MUG_SIPS);
  assert.ok(t - arrived >= REFILL_PAUSE_MS - STEP && t - arrived <= REFILL_PAUSE_MS + 2 * STEP, `refilled after ${t - arrived} ms`);
  // Back to work: seated again, mug full.
  o.applySnapshot([writer('a', 'low')], t, HOST0 + t);
  t = runUntil(o, t, 30_000, () => a.arrived && a.goal?.key === seatKey);
  assert.equal(a.goal!.key, seatKey);
  assert.equal(a.pose, 'sitType');
  assert.equal(a.coffee!.sips, MUG_SIPS);
});

test('a reserved coffee maker is not stacked on: the agent goes elsewhere and gets its coffee once it is free', () => {
  const o = new Office(world, { seed: 19 });
  o.applySnapshot([writer('a', 'low')], 0, HOST0);
  const a = o.chars.get('a')!;
  a.coffee = { ...a.coffee!, sips: 0 };
  assert.ok(o.res.take(COFFEE, 'someone'));
  let t = 0;
  o.applySnapshot([longIdle('a')], t, HOST0 + t);
  t = run(o, t, 60_000, () => {
    assert.notEqual(a.goal?.key, COFFEE);
    assert.equal(o.res.holder(COFFEE), 'someone');
  });
  assert.equal(a.coffee!.sips, 0);
  o.res.release('someone');
  t = runUntil(o, t, 120_000, () => a.arrived && a.goal?.key === COFFEE);
  assert.equal(a.goal!.key, COFFEE);
  t = runUntil(o, t, 20_000, () => a.coffee!.sips > 0);
  assert.equal(a.coffee!.sips, MUG_SIPS);
});

test('a working agent never leaves its desk for coffee, however empty the mug', () => {
  const o = new Office(world, { seed: 20 });
  o.applySnapshot([writer('a', 'max'), writer('b', 'max', { activity: 'thinking' })], 0, HOST0);
  for (const c of o.chars.values()) c.coffee = { ...c.coffee!, sips: 0 };
  run(o, 0, 5 * 60_000, () => {
    for (const c of o.chars.values()) {
      assert.equal(c.goal!.key, `seat:${c.seat!.id}`);
      assert.equal(c.wanderKey, null);
    }
  });
});

test('newCoffee is what a new arrival gets: full, with a jittered first sip', () => {
  const o = new Office(world, { seed: 21 });
  o.applySnapshot([writer('a', 'medium')], 0, HOST0);
  const c = o.chars.get('a')!.coffee!;
  assert.equal(c.sips, MUG_SIPS);
  assert.ok(c.nextSipAt >= newCoffee(0, 'medium', () => 0).nextSipAt && c.nextSipAt <= newCoffee(0, 'medium', () => 1).nextSipAt);
  assert.equal(o.manager.coffee, null);
  assert.equal(o.receptionist.coffee, null);
});
