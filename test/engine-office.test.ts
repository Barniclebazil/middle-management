import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVICTION_MS, OWN_LINE_GAP_MS, Office } from '../webview/engine/office.ts';
import { ManagerBrain } from '../webview/engine/manager.ts';
import { bandsOf, rankDesks } from '../webview/engine/deskRank.ts';
import { Reservations, normalizeAgent, queueOrder, IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import { makeRng, tileFeet } from '../webview/engine/types.ts';
import { collectBubbles, layoutBubbles } from '../webview/engine/bubbles.ts';
import type { Sized } from '../webview/engine/bubbles.ts';
import { agentTooltip, formatDuration, rosterEntries } from '../webview/engine/tooltip.ts';
import { BOSS_LINES, BUMP_LINES, CHAT_REPLIES, SMALL_TALK, RECEPTION_ATTENDING_LINE, RECEPTION_GREETINGS, SULK_END_LINES, SULK_LINES, SULK_START_LINES } from '../webview/engine/lines.ts';
import { lineSources, themeState } from '../webview/engine/theme.ts';
import type { LinesHook } from '../webview/engine/theme.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
/** Seats go by model; the test agents have none, which ranks as sonnet: the middle band's best desks, in arrival order. */
const MIDDLE_1 = 'seat:desk-crossword';
const MIDDLE_2 = 'seat:desk-helpdesk';

/** Runs the simulation for `ms` in 33 ms steps (host clock = HOST0 + t). */
function run(o: Office, t0: number, ms: number): number {
  let t = t0;
  for (let e = 0; e < ms; e += 33) {
    t += 33;
    o.update(t, 33, HOST0 + t);
  }
  return t;
}

test('first message places everyone directly at their spot and pose, with no walking', () => {
  const o = new Office(world, { seed: 1 });
  o.applySnapshot([
    agent('a', { activity: 'reading', startedAt: 1 }),
    agent('b', { activity: 'searching', startedAt: 2 }),
    agent('c', { activity: 'needsYou', status: 'waiting', startedAt: 3 }),
    agent('d', { activity: 'idle', status: 'idle', since: HOST0 - 60_000, startedAt: 4 }),
    agent('e', { activity: 'planning', startedAt: 5 }),
    agent('f', { activity: 'thinking', startedAt: 6 }),
    agent('t', { kind: 'temp', parentId: 'a', activity: 'drawing', startedAt: 7 }),
    agent('gone', { kind: 'temp', parentId: 'a', status: 'done', startedAt: 8 }),
  ], 0, HOST0);
  assert.equal(o.chars.size, 7, 'a finished temp is not shown on load');
  for (const c of o.chars.values()) {
    assert.ok(c.arrived, `${c.id} arrived`);
    assert.equal(c.waypoints.length, 0);
    const f = tileFeet(c.goal!.tile);
    assert.deepEqual([c.x, c.y], [f.x, f.y], `${c.id} at its goal`);
    assert.equal(c.pose, c.goal!.pose);
  }
  const a = o.chars.get('a')!;
  assert.equal(a.goal!.key, MIDDLE_1);
  assert.equal(a.pose, 'sitRead');
  assert.equal(o.chars.get('b')!.pose, 'rummage');
  assert.ok(o.chars.get('b')!.goal!.key.startsWith('cab:'));
  assert.equal(o.chars.get('c')!.goal!.key, 'queue:0');
  assert.equal(o.chars.get('c')!.pose, 'knock');
  assert.ok(o.chars.get('d')!.goal!.key.startsWith('idle:'), 'long-idle agent is already wandering');
  assert.equal(o.chars.get('e')!.pose, 'whiteboard');
  assert.equal(o.chars.get('f')!.pose, 'sitThink');
  assert.equal(o.chars.get('t')!.goal!.key, 'easel');
  // Someone is queued, so the manager is at the glass, also placed directly.
  assert.equal(o.manager.goal!.key, 'mgr:door');
  assert.ok(o.manager.arrived);
  assert.ok(o.activeProps().has(o.chars.get('b')!.goal!.prop!));
});

test('later arrivals walk in from the elevator; finished temps walk out and are released', () => {
  const o = new Office(world, { seed: 2 });
  o.applySnapshot([agent('a', { activity: 'writing' })], 0, HOST0);
  o.applySnapshot([agent('a'), agent('t', { kind: 'temp', parentId: 'a', activity: 'reading', startedAt: HOST0 })], 10, HOST0 + 10);
  const t = o.chars.get('t')!;
  const elev = tileFeet(world.poi.elevator.tile);
  assert.deepEqual([t.x, t.y], [elev.x, elev.y]);
  let now = run(o, 10, 100);
  assert.equal(t.arrived, false);
  assert.equal(t.pose, 'walk');
  now = run(o, now, 30_000);
  assert.ok(t.arrived);
  assert.equal(t.goal!.key, MIDDLE_2, 'temps are seated by the same rules as mains');
  assert.equal(t.pose, 'sitRead');
  // Done: walk back to the elevator and vanish.
  o.applySnapshot([agent('a'), agent('t', { kind: 'temp', parentId: 'a', status: 'done', startedAt: HOST0 })], now, HOST0 + now);
  assert.ok(t.leaving);
  now = run(o, now, 30_000);
  assert.equal(o.chars.has('t'), false);
  assert.equal(o.assigner.get('t'), undefined);
  // A vanished main walks out too.
  o.applySnapshot([], now, HOST0 + now);
  assert.ok(o.chars.get('a')!.leaving);
  run(o, now, 40_000);
  assert.equal(o.chars.size, 0);
});

test('spot reservations: no two people share a cabinet; the overflow works at the desk', () => {
  const o = new Office(world, { seed: 3 });
  const ids = ['a', 'b', 'c', 'd'];
  o.applySnapshot(ids.map((id, i) => agent(id, { activity: 'searching', startedAt: i })), 0, HOST0);
  const keys = ids.map((id) => o.chars.get(id)!.goal!.key);
  const cabs = keys.filter((k) => k.startsWith('cab:'));
  assert.equal(cabs.length, 3);
  assert.equal(new Set(cabs).size, 3);
  const desk = ids.find((id) => o.chars.get(id)!.goal!.key.startsWith('seat:'))!;
  assert.equal(o.chars.get(desk)!.pose, 'sitType');
  // Two copier users, one easel artist and a fallback artist at the desk with a drawing screen.
  const o2 = new Office(world, { seed: 3 });
  o2.applySnapshot([
    agent('p', { activity: 'drawing', startedAt: 1 }), agent('q', { activity: 'drawing', startedAt: 2 }),
    agent('r', { activity: 'copier', startedAt: 3 }), agent('s', { activity: 'copier', startedAt: 4 }),
  ], 0, HOST0);
  assert.equal(o2.chars.get('p')!.goal!.key, 'easel');
  assert.equal(o2.chars.get('q')!.goal!.screen, 'drawing');
  assert.deepEqual(o2.deskScreen(o2.chars.get('q')!.seat!.deskId), { mode: 'kind', value: 'drawing' });
  assert.notEqual(o2.chars.get('r')!.goal!.key, o2.chars.get('s')!.goal!.key);
  assert.ok(o2.activeProps().has('copier'));
});

test('Reservations: one holder per key, one key per holder', () => {
  const r = new Reservations();
  assert.ok(r.take('x', 'a'));
  assert.equal(r.take('x', 'b'), false);
  assert.ok(r.isFree('x', 'a'));
  assert.ok(r.take('y', 'a'));
  assert.ok(r.isFree('x', 'b'), 'taking y released x');
  r.release('a');
  assert.ok(r.isFree('y', 'b'));
});

test('door queue orders by waiting time and compacts forward as people leave', () => {
  assert.deepEqual(queueOrder([{ id: 'b', since: 5 }, { id: 'a', since: 9 }, { id: 'c', since: 5 }]), ['b', 'c', 'a']);
  const o = new Office(world, { seed: 4 });
  const q = (id: string, since: number) => agent(id, { activity: 'needsYou', status: 'waiting', since, startedAt: since });
  o.applySnapshot([q('a', HOST0 - 3000), q('b', HOST0 - 2000), q('c', HOST0 - 1000)], 0, HOST0);
  assert.deepEqual(['a', 'b', 'c'].map((id) => o.chars.get(id)!.goal!.key), ['queue:0', 'queue:1', 'queue:2']);
  assert.equal(o.chars.get('b')!.pose, 'stand');
  // 'a' got an answer and goes back to work.
  let now = run(o, 0, 4000);
  o.applySnapshot([agent('a', { activity: 'writing' }), q('b', HOST0 - 2000), q('c', HOST0 - 1000)], now, HOST0 + now);
  now = run(o, now, 6000);
  assert.equal(o.chars.get('a')!.goal!.key, MIDDLE_1);
  assert.equal(o.chars.get('b')!.goal!.key, 'queue:0');
  assert.equal(o.chars.get('c')!.goal!.key, 'queue:1');
  assert.ok(o.chars.get('b')!.arrived);
  assert.equal(o.chars.get('b')!.pose, 'knock');
  assert.deepEqual(o.queueIds, ['b', 'c']);
});

test('away spots are committed to for ~3 s; walkers re-path at once', () => {
  const o = new Office(world, { seed: 5 });
  o.applySnapshot([agent('a', { activity: 'searching' })], 0, HOST0);
  const a = o.chars.get('a')!;
  o.applySnapshot([agent('a', { activity: 'writing' })], 100, HOST0 + 100);
  let now = run(o, 100, 1000);
  assert.ok(a.goal!.key.startsWith('cab:'), 'still at the cabinet within the commit window');
  now = run(o, now, 2500);
  assert.equal(a.goal!.key, MIDDLE_1);
  assert.equal(a.arrived, false);
  // Change of mind mid-walk: straight to the copier, from where they are.
  const before = { x: a.x, y: a.y };
  o.applySnapshot([agent('a', { activity: 'copier' })], now, HOST0 + now);
  run(o, now, 33);
  assert.ok(a.goal!.key.startsWith('copier:'));
  assert.ok(Math.abs(a.x - before.x) + Math.abs(a.y - before.y) < 6, 'continues from the current position');
});

test('idle agents stay seated for 20 s, then wander; two idle agents chat at the water cooler', () => {
  const o = new Office(world, { seed: 6 });
  o.applySnapshot([
    agent('a', { activity: 'idle', status: 'idle', since: HOST0 - 5000, startedAt: 1 }),
    agent('b', { activity: 'idle', status: 'idle', since: HOST0 - 4000, startedAt: 2 }),
  ], 0, HOST0);
  assert.equal(o.chars.get('a')!.pose, 'sitIdle');
  assert.equal(o.chars.get('a')!.goal!.key, MIDDLE_1);
  let now = run(o, 0, IDLE_WANDER_AFTER_MS);
  assert.deepEqual([...o.chatIds()].sort(), ['a', 'b']);
  now = run(o, now, 20_000);
  const keys = ['a', 'b'].map((id) => o.chars.get(id)!.goal!.key).sort();
  assert.deepEqual(keys, ['cooler:0', 'cooler:1']);
  let talked = false;
  for (let i = 0; i < 200 && !talked; i++) {
    now = run(o, now, 33);
    talked = ['a', 'b'].some((id) => o.chars.get(id)!.say !== null);
  }
  assert.ok(talked, 'someone is talking');
  // Work starts again: back to the desk.
  o.applySnapshot([agent('a', { activity: 'writing', startedAt: 1 }), agent('b', { activity: 'idle', status: 'idle', since: HOST0 - 4000, startedAt: 2 })], now, HOST0 + now);
  run(o, now, 20_000);
  assert.equal(o.chars.get('a')!.goal!.key, MIDDLE_1);
  assert.ok(o.chars.get('a')!.arrived);
  assert.deepEqual(o.chatIds(), []);
});

test('a new prompt sends the manager out to that desk and back, through the door', () => {
  const o = new Office(world, { seed: 7 });
  o.bossQuotes = true;
  o.applySnapshot([agent('a', { activity: 'writing', lastPromptAt: HOST0 - 50_000 })], 0, HOST0);
  let now = run(o, 0, 1000);
  assert.equal(o.manager.goal!.key, 'seat:desk-manager', 'prompts seen on the first message are ignored');
  o.applySnapshot([agent('a', { activity: 'writing', lastPromptAt: HOST0 + 900 })], now, HOST0 + now);
  let sawDoorOpen = false;
  let talked = false;
  for (let i = 0; i < 900; i++) {
    now = run(o, now, 33);
    if (o.doorOpen()) sawDoorOpen = true;
    if (o.manager.say) {
      talked = true;
      const seat = o.chars.get('a')!.seat!;
      assert.deepEqual(o.manager.goal!.tile, seat.visit.tile);
      assert.equal(o.manager.pose, 'talk');
      assert.equal(o.manager.dir, seat.visit.facing);
    }
  }
  assert.ok(talked, 'boss-ism said');
  assert.ok(sawDoorOpen, 'door opened on the way');
  assert.equal(o.manager.goal!.key, 'seat:desk-manager');
  assert.ok(o.manager.arrived);
  assert.equal(o.doorOpen(), false);
});

test('pending visits to agents that vanished are dropped', () => {
  const o = new Office(world, { seed: 8 });
  o.applySnapshot([agent('a', { lastPromptAt: HOST0 - 50_000 })], 0, HOST0);
  o.applySnapshot([agent('a', { lastPromptAt: HOST0 + 10 })], 10, HOST0 + 10);
  o.applySnapshot([], 20, HOST0 + 20);
  run(o, 20, 15_000);
  assert.equal(o.brain.visiting, false);
  assert.equal(o.manager.say, null);
});

test('robust to odd input: unknown activities, missing fields, 20 agents', () => {
  const v = normalizeAgent({ id: 'x', activity: 'juggling' }, HOST0)!;
  assert.equal(v.activity, 'writing');
  assert.equal(v.kind, 'main');
  assert.equal(v.since, HOST0);
  assert.equal(v.title, 'Untitled session');
  assert.equal(normalizeAgent({ title: 'no id' }, HOST0), null);
  assert.equal(normalizeAgent(null, HOST0), null);
  const o = new Office(world, { seed: 9 });
  const acts = ['reading', 'searching', 'writing', 'drawing', 'copier', 'planning', 'needsYou', 'shredding', 'idle', 'delegating', 'bogus'];
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, kind: i < 12 ? 'main' : 'temp', parentId: i < 12 ? undefined : 'm0', activity: acts[i % acts.length],
    since: HOST0 - 30_000, startedAt: i,
  }));
  o.applySnapshot([...many, { nonsense: true }, 42], 0, HOST0);
  assert.equal(o.chars.size, 20);
  const now = run(o, 0, 10_000);
  // Every reserved spot has exactly one holder.
  const reserved = [...o.chars.values()].map((c) => c.goal!.reserve).filter((k): k is string => !!k);
  assert.equal(new Set(reserved).size, reserved.length);
  o.applySnapshot(many.map((m) => ({ ...m, activity: 'writing' })), now, HOST0 + now);
  run(o, now, 60_000);
  for (const c of o.chars.values()) assert.ok(c.arrived, `${c.id} not stuck`);
});

test('bubbles: queued agents always show "!" and their name; layout avoids overlaps', () => {
  const o = new Office(world, { seed: 10 });
  o.applySnapshot([
    agent('a', { activity: 'needsYou', status: 'waiting', title: 'Fix the build' }),
    agent('b', { activity: 'writing', detail: 'x.ts' }),
  ], 0, HOST0);
  const reqs = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: false, managerName: 'Boss' }, 0);
  assert.ok(reqs.some((r) => r.charId === 'a' && r.icon === 'alert'));
  assert.ok(reqs.some((r) => r.charId === 'a' && r.type === 'label' && r.text === 'Fix the build'));
  assert.ok(reqs.some((r) => r.type === 'label' && r.text === 'Boss'));
  assert.equal(reqs.some((r) => r.charId === 'b'), false, 'speech bubbles off hides activity bubbles');
  const boxes: Sized[] = [0, 1, 2].map((i) => ({
    key: `k${i}`, charId: `c${i}`, type: 'icon', icon: 'page', style: 'speech', ax: 100 + i * 4, ay: 100, side: 'above', fixed: false, priority: 1, w: 14, h: 14, tail: 3,
  }));
  const placed = layoutBubbles(boxes, { w: 736, h: 272 }, new Map());
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]!;
      const q = placed[j]!;
      const sep = p.x + p.w < q.x || q.x + q.w < p.x || p.y + p.h < q.y || q.y + q.h < p.y;
      assert.ok(sep, `${p.key} overlaps ${q.key}`);
    }
  }
});

test('tooltip text', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(133_000), '2m 13s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
  const v = normalizeAgent(agent('t', { kind: 'temp', parentId: 'p', activity: 'needsYou', detail: 'Approve?', since: HOST0 - 133_000 }), HOST0)!;
  const tip = agentTooltip(v, 'Temp', 'Parent session', HOST0, false);
  assert.equal(tip.title, 'Session t');
  assert.ok(tip.lines.includes('Temp working for Parent session'));
  assert.ok(tip.lines.includes('Waiting for you for 2m 13s'));
  assert.ok(tip.lines.includes('Approve?'));
});

test('the receptionist: in allChars but not in chars or the roster; nobody is assigned to her seat', () => {
  const o = new Office(world, { seed: 12 });
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  o.applySnapshot([...ids.map((id, i) => agent(id, { startedAt: i + 1 })), ...ids.slice(0, 3).map((id) => agent(`t-${id}`, { kind: 'temp', parentId: id, startedAt: 20 }))], 0, HOST0);
  const r = o.receptionist;
  assert.equal(r.id, '__reception__');
  assert.equal(r.kind, 'receptionist');
  assert.equal(r.agent, null);
  assert.equal(r.look, 'receptionist');
  assert.equal(o.chars.has(r.id), false);
  assert.deepEqual(o.allChars().slice(0, 2), [o.manager, r]);
  assert.equal(o.allChars().length, o.chars.size + 2);
  assert.equal(rosterEntries(o, HOST0).length, o.chars.size);
  assert.ok(!rosterEntries(o, HOST0).some((e) => e.id === r.id));
  assert.equal(o.receptionSeat.owner, 'reception');
  assert.deepEqual(r.goal!.tile, o.receptionSeat.tile);
  for (const c of o.chars.values()) {
    assert.notEqual(c.seat?.id, o.receptionSeat.id, `${c.id} is not at the front desk`);
    assert.notEqual(c.seat?.deskId, o.receptionSeat.deskId);
  }
  // Even with every seat taken, the overflow never lands at reception.
  o.applySnapshot(Array.from({ length: 30 }, (_, i) => agent(`x${i}`, { startedAt: 100 + i })), 1_000, HOST0);
  for (const c of o.chars.values()) assert.notEqual(c.seat?.id, o.receptionSeat.id);
});

test('the receptionist never walks, takes calls (receiver off the cradle), greets new main workers, and ignores temps', () => {
  const o = new Office(world, { seed: 13 });
  o.applySnapshot([agent('a')], 0, HOST0);
  const home = { x: o.receptionist.x, y: o.receptionist.y };
  const says: string[] = [];
  let phoneTicks = 0;
  let t = 0;
  const tick = (ms: number): void => {
    t += ms;
    o.update(t, ms, HOST0 + t);
    assert.deepEqual({ x: o.receptionist.x, y: o.receptionist.y }, home, 'she stays at her desk');
    assert.ok(o.receptionist.arrived);
    if (o.receptionOnPhone()) { phoneTicks++; assert.equal(o.receptionist.pose, 'sitPhone'); }
    if (o.receptionist.say) says.push(o.receptionist.say.text);
  };
  for (let i = 0; i < 3_000; i++) tick(100); // 5 minutes
  assert.ok(phoneTicks > 0, 'she took a call');
  assert.ok(o.allChars().includes(o.receptionist));
  // A new temp arrives: no greeting. A new main worker arrives: a greeting.
  says.length = 0;
  o.applySnapshot([agent('a'), agent('tmp', { kind: 'temp', parentId: 'a' })], t, HOST0 + t);
  const ensureOff = (): void => { while (o.receptionOnPhone()) tick(100); };
  ensureOff();
  for (let i = 0; i < 20; i++) tick(100);
  assert.equal(says.filter((s) => RECEPTION_GREETINGS.includes(s)).length, 0, 'temps get no greeting');
  ensureOff();
  o.applySnapshot([agent('a'), agent('tmp', { kind: 'temp', parentId: 'a' }), agent('b')], t, HOST0 + t);
  const got = new Set<string>();
  for (let i = 0; i < 30; i++) { tick(100); if (o.receptionist.say) got.add(o.receptionist.say.text); }
  assert.ok([...got].some((s) => RECEPTION_GREETINGS.includes(s)), `greeted: ${[...got].join('|')}`);
});

test('the receptionist: speech bubbles off silences her; the Front desk makes her look up; desk screen follows her', () => {
  const o = new Office(world, { seed: 14 });
  o.applySnapshot([agent('a')], 0, HOST0);
  o.speechBubbles = false;
  o.setAttending(true);
  o.update(100, 100, HOST0);
  assert.equal(o.receptionist.say, null);
  assert.equal(o.receptionist.pose, 'sitIdle');
  assert.equal(o.deskScreen(o.receptionSeat.deskId).mode, 'idle');
  o.speechBubbles = true;
  o.setAttending(false);
  o.setAttending(true);
  o.update(200, 100, HOST0);
  assert.equal((o.receptionist.say as { text: string } | null)?.text, RECEPTION_ATTENDING_LINE);
  const reqs = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss' }, 250, o.receptionist);
  assert.ok(reqs.some((r) => r.key === 'rec:say' && r.text === RECEPTION_ATTENDING_LINE));
  assert.ok(!reqs.some((r) => r.key === 'rec:label'), 'no name label unless she is highlighted');
  const hl = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss', highlightId: o.receptionist.id, theme: themeState({ receptionist: { name: 'Dot' } }, world.staffSlots, world.tempSlots) }, 250, o.receptionist);
  assert.equal(hl.find((r) => r.key === 'rec:label')?.text, 'Dot');
  const quiet = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: false, managerName: 'Boss' }, 250, o.receptionist);
  assert.ok(!quiet.some((r) => r.key === 'rec:say'));
  // Hit-testing finds her.
  assert.equal(o.hitTest(o.receptionist.x, o.receptionist.y - 10)?.id, o.receptionist.id);
});

// ---------------------------------------------------------------------------
// Seats by model: re-seating, bumps and the Fable spell

const DESKS = world.seats.filter((s) => s.owner !== 'manager' && s.owner !== 'reception');
const BANDS = bandsOf(rankDesks(DESKS, new Office(world).routeMap, world.poi.managerDoorQueue[0]!.tile));
/** Band of a seat id (0 best), or -1 for the boss's chair or no seat. */
const bandOf = (seatId: string | undefined): number => (seatId === undefined ? -1 : BANDS.findIndex((b) => b.some((s) => s.id === seatId)));
const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-6';
const SONNET = 'claude-sonnet-4-5';
const HAIKU = 'claude-haiku-4-5';
const near = (c: { x: number; y: number }, tile: { x: number; y: number }): boolean => {
  const f = tileFeet(tile);
  return Math.abs(c.x - f.x) + Math.abs(c.y - f.y) < 1;
};

/** What a character is saying (read through a function so assertions don't narrow it). */
const sayOf = (c: { say: { text: string } | null }): string | null => c.say?.text ?? null;

/** Runs until `done()` (checked every 33 ms step) or `ms` passes; returns the time. */
function runUntil(o: Office, t0: number, ms: number, done: () => boolean, each?: () => void): number {
  let t = t0;
  for (let e = 0; e < ms && !done(); e += 33) {
    t += 33;
    o.update(t, 33, HOST0 + t);
    each?.();
  }
  return t;
}

test('a temp whose model arrives later gets up and walks to a haiku-band desk, without a word', () => {
  const o = new Office(world, { seed: 20 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  const tmp = (model?: string) => agent('t', { kind: 'temp', parentId: 'a', activity: 'writing', startedAt: HOST0, ...(model ? { model } : {}) });
  o.applySnapshot([agent('a', { model: SONNET }), tmp()], 10, HOST0 + 10);
  const t = o.chars.get('t')!;
  let now = runUntil(o, 10, 30_000, () => t.arrived && (t.goal?.key.startsWith('seat:') ?? false));
  assert.equal(bandOf(t.seat?.id), 1, 'an unknown model sits in the middle');
  const before = t.seat!.id;
  o.applySnapshot([agent('a', { model: SONNET }), tmp(HAIKU)], now, HOST0 + now);
  assert.equal(bandOf(t.seat?.id), 2);
  assert.notEqual(t.seat!.id, before);
  now = run(o, now, 66);
  assert.equal(t.goal!.key, `seat:${t.seat!.id}`, 'heads for the new desk');
  assert.equal(t.arrived, false);
  now = runUntil(o, now, 30_000, () => t.arrived);
  assert.ok(near(t, t.seat!.tile), 'sat down at the new desk');
  assert.equal(t.say, null, 'a move of its own (model known) gets no remark');
  assert.equal(o.deskScreen(t.seat!.deskId).mode, 'activity', 'the screen follows the seat');
  assert.equal(o.deskScreen(before).mode, 'off', 'the old desk is dark');
});

test('a worker bumped by a better-ranked model grumbles once and moves desks', () => {
  const o = new Office(world, { seed: 21 });
  const haiku = Array.from({ length: 7 }, (_, i) => agent(`h${i}`, { model: HAIKU, startedAt: HOST0 - 100_000 + i }));
  o.applySnapshot(haiku, 0, HOST0);
  // Six haiku desks: the seventh overflows into the middle band.
  assert.equal(bandOf(o.chars.get('h6')!.seat?.id), 1);
  const sonnets = Array.from({ length: 6 }, (_, i) => agent(`s${i}`, { model: SONNET, startedAt: HOST0 - 50_000 + i }));
  o.applySnapshot([...haiku, ...sonnets], 100, HOST0 + 100);
  let now = run(o, 100, 20_000);
  const h6 = o.chars.get('h6')!;
  assert.equal(bandOf(h6.seat?.id), 1, 'still a free desk for every sonnet: nobody bumped');
  assert.equal(h6.say, null);
  const old = h6.seat!.id;
  // One more sonnet: the middle band is full, so the haiku squatter gives up its desk.
  o.applySnapshot([...haiku, ...sonnets, agent('s6', { model: SONNET, startedAt: HOST0 - 40_000 })], now, HOST0 + now);
  assert.notEqual(h6.seat?.id, old);
  assert.equal(o.assigner.get('s6')!.seat!.id, old, 'the newcomer gets its desk');
  const said = sayOf(h6);
  assert.ok(said !== null && BUMP_LINES.includes(said), `grumbles: ${said}`);
  for (const id of ['h0', 's0', 's5']) assert.equal(o.chars.get(id)!.say, null, `${id} said nothing`);
  now = runUntil(o, now, 30_000, () => h6.arrived && h6.goal!.key === `seat:${h6.seat!.id}`);
  assert.ok(near(h6, h6.seat!.tile), 'walked to the new desk');
  // Once: the next snapshot (nothing changes) says nothing new.
  o.applySnapshot([...haiku, ...sonnets, agent('s6', { model: SONNET, startedAt: HOST0 - 40_000 })], now, HOST0 + now);
  assert.ok([null, said].includes(sayOf(h6)));
});

test('a Fable arrival evicts the boss: he sulks in the kitchen under a storm cloud while it takes his office', () => {
  const o = new Office(world, { seed: 22 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  assert.equal(o.managerSulking, false);
  assert.equal(o.spellHolder, null);
  o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE, activity: 'writing', startedAt: HOST0 })], 10, HOST0 + 10);
  const f = o.chars.get('f')!;
  assert.equal(o.spellHolder, 'f');
  assert.equal(o.managerSulking, true);
  assert.equal(f.seat?.id, o.managerSeat.id, "the Fable agent is given the boss's chair");
  assert.equal(o.spellEndsAt, 10 + EVICTION_MS);
  let said: string | null = null;
  let doorForOthers = false;
  const door = tileFeet(world.poi.managerDoor);
  const m = o.manager;
  const now = runUntil(o, 10, 40_000, () => f.arrived && f.goal?.key === `seat:${o.managerSeat.id}` && m.arrived && m.goal!.key === 'mgr:sulk', () => {
    if (m.say && said === null) said = m.say.text;
    if (o.doorOpen() && Math.abs(m.x - door.x) + Math.abs(m.y - door.y) > 48) doorForOthers = true;
  });
  assert.ok(said !== null && SULK_START_LINES.includes(said), `start line: ${said}`);
  assert.equal(m.goal!.key, 'mgr:sulk');
  assert.deepEqual(m.goal!.tile, world.poi.sulk.tile);
  assert.ok(near(m, world.poi.sulk.tile), 'at the sulk spot');
  assert.equal(o.res.holder(m.goal!.reserve!), m.id, 'the spot is reserved for him');
  assert.ok(doorForOthers, 'the door opened for the Fable agent');
  assert.ok(near(f, o.managerSeat.tile));
  assert.deepEqual(o.deskScreen(o.managerSeat.deskId), { mode: 'activity', value: 'writing' }, "the boss's monitor shows the Fable agent's work");
  assert.equal(o.hitTest(f.x, f.y - 10)?.id, 'f', 'the Fable agent can be hovered in the glass office');
  const t2 = runUntil(o, now, 5_000, () => m.say === null);
  const reqs = collectBubbles([...o.chars.values()], m, o.queueIds, { speechBubbles: true, managerName: 'Boss' }, t2);
  assert.ok(reqs.some((r) => r.key === 'mgr:mood' && r.icon === 'stormcloud'), 'storm cloud over the boss');
  const quiet = collectBubbles([...o.chars.values()], m, o.queueIds, { speechBubbles: false, managerName: 'Boss' }, t2);
  assert.ok(quiet.some((r) => r.key === 'mgr:mood'), 'the storm cloud stays with speech bubbles off');
  // He mutters now and then, and nobody else sits in his spot.
  const lines = new Set<string>();
  runUntil(o, t2, 90_000, () => false, () => { if (m.say) lines.add(m.say.text); });
  assert.ok([...lines].some((l) => SULK_LINES.includes(l)), `mutters: ${[...lines].join('|')}`);
  assert.ok(near(m, world.poi.sulk.tile));
});

test('a prompt during the spell still sends the boss on a desk visit, then back to sulking; no door duty', () => {
  const o = new Office(world, { seed: 23 });
  const a = (over = {}) => agent('a', { model: SONNET, lastPromptAt: HOST0 - 50_000, ...over });
  const f = agent('f', { model: FABLE, startedAt: HOST0 });
  o.applySnapshot([a()], 0, HOST0);
  o.applySnapshot([a(), f], 10, HOST0 + 10);
  const m = o.manager;
  let now = runUntil(o, 10, 30_000, () => m.arrived && m.goal!.key === 'mgr:sulk');
  // Someone queues at the door: he stays put.
  o.applySnapshot([a(), f, agent('q', { model: SONNET, activity: 'needsYou', status: 'waiting' })], now, HOST0 + now);
  now = run(o, now, 3_000);
  assert.equal(m.goal!.key, 'mgr:sulk', 'no door duty while sulking');
  o.applySnapshot([a({ lastPromptAt: HOST0 + now }), f], now, HOST0 + now);
  let talked = false;
  now = runUntil(o, now, 40_000, () => talked && m.arrived && m.goal!.key === 'mgr:sulk', () => {
    if (m.goal!.key === 'visit:a' && m.pose === 'talk') talked = true;
  });
  assert.ok(talked, 'visited the desk');
  assert.equal(m.goal!.key, 'mgr:sulk');
  assert.ok(near(m, world.poi.sulk.tile), 'back at the sulk spot');
  assert.ok(o.managerSulking);
});

test('the spell runs out on a tick (no snapshot): the boss storms back, the Fable agent takes a best-band desk', () => {
  const o = new Office(world, { seed: 24, evictionMs: 30_000 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE, startedAt: HOST0 })], 10, HOST0 + 10);
  const f = o.chars.get('f')!;
  const m = o.manager;
  let now = run(o, 10, 29_000);
  assert.equal(o.spellHolder, 'f');
  const lines: string[] = [];
  now = runUntil(o, now, 40_000, () => m.arrived && m.goal!.key === `seat:${o.managerSeat.id}` && f.arrived && f.goal!.key === `seat:${f.seat?.id}`, () => {
    if (m.say && lines[lines.length - 1] !== m.say.text) lines.push(m.say.text);
  });
  assert.equal(o.spellHolder, null);
  assert.equal(o.managerSulking, false);
  assert.equal(o.spellEndsAt, null);
  assert.ok(lines.some((l) => SULK_END_LINES.includes(l)), `end line: ${lines.join('|')}`);
  assert.ok(near(m, o.managerSeat.tile), 'the boss is back at his desk');
  assert.equal(m.moodIcon, null, 'no more storm cloud');
  assert.equal(bandOf(f.seat?.id), 0, 'the Fable agent sits in the best band');
  assert.ok(near(f, f.seat!.tile));
  assert.deepEqual(o.deskScreen(o.managerSeat.deskId), { mode: 'kind', value: 'browser' });
  // No second spell for the same agent.
  o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE, startedAt: HOST0 })], now, HOST0 + now);
  assert.equal(o.spellHolder, null);
});

test('the spell ends early when the Fable agent leaves; a later Fable gets a fresh spell', () => {
  const o = new Office(world, { seed: 25 });
  const tf = (status: 'working' | 'done') => agent('f', { kind: 'temp', parentId: 'a', model: FABLE, status, startedAt: HOST0 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  o.applySnapshot([agent('a', { model: SONNET }), tf('working')], 10, HOST0 + 10);
  assert.equal(o.spellHolder, 'f');
  let now = run(o, 10, 15_000);
  o.applySnapshot([agent('a', { model: SONNET }), tf('done')], now, HOST0 + now);
  assert.equal(o.spellHolder, null);
  assert.equal(o.managerSulking, false);
  const m = o.manager;
  now = runUntil(o, now, 40_000, () => !o.chars.has('f') && m.arrived && m.goal!.key === `seat:${o.managerSeat.id}`);
  assert.equal(o.chars.has('f'), false, 'walked out and left');
  assert.ok(near(m, o.managerSeat.tile), 'the boss is back at his desk');
  o.applySnapshot([agent('a', { model: SONNET }), agent('g', { model: FABLE, startedAt: HOST0 + now })], now, HOST0 + now);
  assert.equal(o.spellHolder, 'g');
  assert.equal(o.chars.get('g')!.seat?.id, o.managerSeat.id);
  // A main that simply vanishes ends it too.
  o.applySnapshot([agent('a', { model: SONNET })], now + 100, HOST0 + now + 100);
  assert.equal(o.spellHolder, null);
  assert.equal(o.managerSulking, false);
});

test('a second Fable arriving during a spell gets a best-band desk and no spell later', () => {
  const o = new Office(world, { seed: 26, evictionMs: 20_000 });
  const f = agent('f', { model: FABLE, startedAt: HOST0 });
  const g = agent('g', { model: FABLE, startedAt: HOST0 + 5 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  o.applySnapshot([agent('a', { model: SONNET }), f], 10, HOST0 + 10);
  o.applySnapshot([agent('a', { model: SONNET }), f, g], 20, HOST0 + 20);
  assert.equal(o.spellHolder, 'f');
  assert.equal(bandOf(o.chars.get('g')!.seat?.id), 0);
  let now = run(o, 20, 25_000);
  assert.equal(o.spellHolder, null, 'the spell ran out');
  o.applySnapshot([agent('a', { model: SONNET }), f, g], now, HOST0 + now);
  now = run(o, now, 1_000);
  assert.equal(o.spellHolder, null, 'g never gets one');
  assert.equal(o.managerSulking, false);
  assert.equal(bandOf(o.chars.get('g')!.seat?.id), 0);
  assert.equal(bandOf(o.chars.get('f')!.seat?.id), 0);
});

test('a Fable agent already present on the first message: the spell is already on, the boss placed at the sulk spot in silence', () => {
  const o = new Office(world, { seed: 27 });
  o.applySnapshot([agent('a', { model: OPUS }), agent('f', { model: FABLE })], 0, HOST0);
  assert.equal(o.spellHolder, 'f');
  assert.ok(near(o.manager, world.poi.sulk.tile));
  assert.ok(near(o.chars.get('f')!, o.managerSeat.tile));
  o.update(33, 33, HOST0 + 33);
  assert.equal(o.manager.say, null, 'no start line on load');
  assert.equal(o.manager.moodIcon, 'stormcloud');
});

test('ManagerBrain sulking: sulk spot instead of desk and door, visits first, start and end lines', () => {
  const o = new Office(world, { seed: 28 });
  const b = new ManagerBrain();
  const spot = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };
  const base = { me: o.manager, seat: o.managerSeat, spots: o.spots, queueLength: 2, rng: () => 0.5, grid: o.routeMap.grid, w: world.w, h: world.h, sulk: { spot, reserve: 'idle:table1' } };
  const ctx = { ...base, targetOf: () => null };
  assert.equal(b.decide(ctx, 0).goal.key, 'mgr:door');
  b.setSulking(true);
  assert.equal(b.sulking, true);
  const d = b.decide(ctx, 10);
  assert.equal(d.goal.key, 'mgr:sulk', 'no door duty');
  assert.deepEqual(d.goal.tile, spot.tile);
  assert.equal(d.goal.reserve, 'idle:table1');
  assert.ok(d.say && SULK_START_LINES.includes(d.say));
  assert.equal(b.decide(ctx, 20).say, undefined, 'said once');
  // A visit still comes first.
  const visitCtx = { ...base, targetOf: (id: string) => (id === 'x' ? { tile: { x: 20, y: 12 }, seatVisit: null } : null) };
  b.queueVisit('x');
  assert.equal(b.decide(visitCtx, 30).goal.key, 'visit:x');
  b.drop('x');
  assert.equal(b.decide(ctx, 40).goal.key, 'mgr:sulk');
  b.setSulking(false);
  const e = b.decide(ctx, 50);
  assert.ok(e.say && SULK_END_LINES.includes(e.say));
  assert.equal(e.goal.key, 'mgr:door');
  b.setSulking(true, true);
  assert.equal(b.decide(ctx, 60).say, undefined, 'quiet start');
});

test('someone already at the sulk spot: the boss stands beside it, and sits once it is free', () => {
  const o = new Office(world, { seed: 29 });
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  const key = o.spots.idle.find((s) => s.spot.tile.x === world.poi.sulk.tile.x && s.spot.tile.y === world.poi.sulk.tile.y)!.key;
  assert.ok(o.res.take(key, 'someone'));
  o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE })], 10, HOST0 + 10);
  const m = o.manager;
  let now = runUntil(o, 10, 30_000, () => m.arrived && m.goal?.key === 'mgr:sulk');
  assert.notDeepEqual(m.goal!.tile, world.poi.sulk.tile);
  assert.equal(Math.abs(m.goal!.tile.x - world.poi.sulk.tile.x) + Math.abs(m.goal!.tile.y - world.poi.sulk.tile.y), 1, 'right beside it');
  assert.equal(m.pose, 'stand');
  o.res.release('someone');
  now = runUntil(o, now, 10_000, () => m.arrived && near(m, world.poi.sulk.tile));
  assert.ok(near(m, world.poi.sulk.tile));
  assert.equal(o.res.holder(key), m.id);
});

test('during a spell the holder works at the boss desk instead of away spots; wandering and chats skip it; it resumes after', () => {
  const o = new Office(world, { seed: 31, evictionMs: 150_000 });
  const mseat = `seat:${o.managerSeat.id}`;
  o.applySnapshot([agent('a', { model: SONNET })], 0, HOST0);
  o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE, activity: 'drawing', startedAt: HOST0 })], 10, HOST0 + 10);
  const f = o.chars.get('f')!;
  assert.equal(o.spellHolder, 'f');
  let now = run(o, 10, 20_000);
  assert.equal(f.goal!.key, mseat, 'drawing: at the boss seat, not the easel');
  assert.equal(f.pose, 'sitType');
  assert.equal(f.goal!.screen, 'drawing');
  // Other away activities stay at the desk too.
  for (const [act, pose] of [['planning', 'sitType'], ['searching', 'sitType'], ['shredding', 'sitType'], ['copier', 'sitRun'], ['delegating', 'sitIdle']] as const) {
    o.applySnapshot([agent('a', { model: SONNET }), agent('f', { model: FABLE, activity: act, startedAt: HOST0 })], now, HOST0 + now);
    now = run(o, now, 6_000);
    assert.equal(f.goal!.key, mseat, act);
    assert.equal(f.pose, pose, act);
  }
  // Long idle: no wandering, no water cooler; sits pleased with itself.
  const idle = (id: string, model: string) => agent(id, { model, activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 60_000, startedAt: HOST0 });
  o.applySnapshot([idle('f', FABLE), idle('a', SONNET), idle('b', SONNET)], now, HOST0 + now);
  now = run(o, now, 40_000);
  assert.equal(f.goal!.key, mseat);
  assert.equal(f.pose, 'sitIdle');
  assert.ok(!f.goal!.key.startsWith('cooler:'), 'not at the water cooler');
  // A pending question still sends it to the door queue, as before.
  o.applySnapshot([agent('f', { model: FABLE, activity: 'needsYou', status: 'waiting', startedAt: HOST0 })], now, HOST0 + now);
  assert.equal(o.spellHolder, 'f');
  now = run(o, now, 500);
  assert.equal(f.goal!.key, 'queue:0', 'knocks at the door as before');
  // After the spell the same activity goes to the easel again.
  o.applySnapshot([agent('f', { model: FABLE, activity: 'drawing', startedAt: HOST0 })], now, HOST0 + now);
  now = run(o, now, 80_000);
  assert.equal(o.spellHolder, null);
  now = run(o, now, 30_000);
  assert.equal(f.goal!.key, 'easel');
});

// ---- Water-cooler talk: decks, own lines, whole exchanges, who talks ----

interface Said { id: string; text: string; t: number }

/** Runs `o` from `t0` for `ms` in 100 ms steps; returns every new speech bubble in order, and each chat as it starts. */
function listen(o: Office, ids: string[], ms: number, t0 = 0, drain = false): { says: Said[]; chats: string[]; end: number } {
  const says: Said[] = [];
  const chats: string[] = [];
  const last = new Map<string, unknown>();
  let was = '';
  let t = t0;
  for (let e = 0; e < ms || (drain && o.chatIds().length > 0); e += 100) {
    t += 100;
    o.update(t, 100, HOST0 + t);
    for (const id of ids) {
      const say = o.chars.get(id)?.say ?? null;
      if (say && say !== last.get(id)) says.push({ id, text: say.text, t });
      last.set(id, say);
    }
    const now = o.chatIds().join('+');
    if (now && now !== was) chats.push(now);
    was = now;
  }
  return { says, chats, end: t };
}

const idleAgent = (id: string, n: number) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });
const TWO_HOURS = 2 * 60 * 60_000;

// The IT pair's replies and small talk would be extra lines among the pairs these tests count, so they stay home (`itCrew: false`).
test('water cooler: every opener is followed by its reply before the chat ends', () => {
  for (const seed of [1, 2, 3]) {
    const o = new Office(world, { seed, itCrew: false });
    o.applySnapshot([idleAgent('a', 1), idleAgent('b', 2)], 0, HOST0);
    // Let a chat in progress run out, so the last exchange has its chance too.
    const { says } = listen(o, ['a', 'b'], 30 * 60_000, 0, true);
    assert.ok(says.length >= 40, `${says.length} lines in 30 minutes`);
    assert.equal(says.length % 2, 0, 'no opener without its reply');
    for (let i = 0; i < says.length; i += 2) {
      const [open, reply] = [says[i]!, says[i + 1]!];
      assert.notEqual(open.id, reply.id, 'the other person replies');
      assert.ok(SMALL_TALK.some(([x, y]) => x === open.text && y === reply.text), `a pair: ${open.text} / ${reply.text}`);
    }
  }
});

test('water cooler: the cooler deals its pairs from a deck, so none repeats within a round', () => {
  const o = new Office(world, { seed: 4, itCrew: false });
  o.applySnapshot([idleAgent('a', 1), idleAgent('b', 2)], 0, HOST0);
  const { says } = listen(o, ['a', 'b'], TWO_HOURS);
  const openers = says.filter((_, i) => i % 2 === 0).map((s) => s.text);
  assert.ok(openers.length > 300, `${openers.length} exchanges`);
  const pool = new Set(SMALL_TALK.map(([x]) => x)).size;
  for (let i = 0; i + pool <= openers.length; i += pool) assert.equal(new Set(openers.slice(i, i + pool)).size, pool, `exchanges ${i}-${i + pool} are one full round`);
  openers.slice(1).forEach((x, i) => assert.notEqual(x, openers[i]));
});

test('water cooler: own lines open a chat at most once per 40 min per person; the reply is a generic one', () => {
  const o = new Office(world, { seed: 5, itCrew: false });
  const own = ['OWN-1', 'OWN-2', 'OWN-3'];
  o.setTheme(themeState({ staff: [{ name: 'Ann', lines: own }, { name: 'Bo' }] }, world.staffSlots, world.tempSlots));
  o.applySnapshot([idleAgent('a', 1), idleAgent('b', 2)], 0, HOST0);
  assert.equal(o.chars.get('a')!.look, 'staff-0');
  const { says } = listen(o, ['a', 'b'], TWO_HOURS);
  const mine = says.filter((s) => own.includes(s.text));
  assert.ok(mine.length >= 2, `${mine.length} own lines in 2 hours`);
  assert.ok(mine.length <= Math.ceil(TWO_HOURS / OWN_LINE_GAP_MS), `at most one per ${OWN_LINE_GAP_MS / 60_000} min`);
  mine.slice(1).forEach((s, i) => assert.ok(s.t - mine[i]!.t >= OWN_LINE_GAP_MS, `own lines ${i} and ${i + 1} are ${(s.t - mine[i]!.t) / 60_000} min apart`));
  assert.equal(new Set(mine.slice(0, 3).map((s) => s.text)).size, Math.min(3, mine.length), 'her own deck: each line once before any comes back');
  for (const s of mine) {
    assert.equal(s.id, 'a');
    const reply = says[says.indexOf(s) + 1]!;
    assert.equal(reply.id, 'b');
    assert.ok(CHAT_REPLIES.includes(reply.text), `reply to an own line is generic: ${reply.text}`);
  }
  // Everything else is a pair from the deck, spoken by either of them.
  const rest = says.filter((s, i) => !own.includes(s.text) && !(i > 0 && own.includes(says[i - 1]!.text)));
  assert.ok(rest.length > 100);
  const lines = new Set(SMALL_TALK.flat());
  for (const s of rest) assert.ok(lines.has(s.text), `a deck line: ${s.text}`);
  assert.ok(rest.some((s) => s.id === 'a' && SMALL_TALK.some(([x]) => x === s.text)), 'Ann also opens with deck pairs');
});

test('water cooler: the own-line gap follows the person (their slot), not the agent', () => {
  const o = new Office(world, { seed: 5 });
  o.setTheme(themeState({ staff: [{ name: 'Ann', lines: ['OWN-1', 'OWN-2'], pin: { project: 'reports' } }] }, world.staffSlots, world.tempSlots));
  const reports = (id: string) => ({ ...idleAgent(id, 1), project: 'reports' });
  o.applySnapshot([reports('a'), idleAgent('b', 2)], 0, HOST0);
  assert.equal(o.chars.get('a')!.look, 'staff-0');
  const first = listen(o, ['a', 'b', 'c'], 10 * 60_000);
  assert.ok(first.says.some((s) => s.text.startsWith('OWN-')), 'Ann has spoken her own line already');
  // The agent in Ann's slot goes and another session takes the slot within the 40 minutes: still no own line.
  o.applySnapshot([idleAgent('b', 2)], first.end, HOST0 + first.end);
  const gone = listen(o, ['b'], 60_000, first.end);
  assert.equal(o.chars.has('a'), false, 'the first agent has left');
  o.applySnapshot([reports('c'), idleAgent('b', 2)], gone.end, HOST0 + gone.end);
  assert.equal(o.chars.get('c')?.look, 'staff-0');
  const next = listen(o, ['b', 'c'], 25 * 60_000, gone.end);
  assert.ok(!next.says.some((s) => s.text.startsWith('OWN-')), 'the slot is still on its 40 min gap');
});

test('water cooler: with three idle agents, more than one pair gets to chat, and not the same two every time', () => {
  for (const seed of [1, 2]) {
    const o = new Office(world, { seed, itCrew: false });
    o.applySnapshot([idleAgent('a', 1), idleAgent('b', 2), idleAgent('c', 3)], 0, HOST0);
    const { chats } = listen(o, ['a', 'b', 'c'], 60 * 60_000);
    const pairs = new Set(chats);
    assert.ok(chats.length >= 30, `${chats.length} chats`);
    assert.ok(pairs.size >= 2, `pairs: ${[...pairs].join(' ')}`);
    const repeats = chats.filter((c, i) => i > 0 && c === chats[i - 1]).length;
    assert.ok(repeats <= chats.length / 4, `${repeats} of ${chats.length} chats had the same two as the one before`);
  }
});

test('the manager: boss lines are dealt from a deck over the built-in and themed lines', () => {
  const o = new Office(world, { seed: 28 });
  const themed = ['THEMED-1', 'THEMED-2', 'THEMED-3'];
  const spot = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };
  const visit = { tile: { x: 20, y: 11 }, seatVisit: { tile: { x: 20, y: 12 }, facing: 'up' as const } };
  const me = { arrived: true, goal: { key: 'visit:x', tile: visit.seatVisit.tile }, x: 0, y: 0 };
  /** The manager's `lines` hook for a theme whose manager has these lines. */
  const linesOf = (bossLines?: string[]): LinesHook => {
    const st = bossLines ? themeState({ manager: { lines: bossLines } }, world.staffSlots, world.tempSlots) : undefined;
    return (key) => lineSources(st, key);
  };
  const ctxOf = (bossLines?: string[]) => ({
    me: me as never, seat: o.managerSeat, spots: o.spots, queueLength: 0, rng: makeRng(3), lines: linesOf(bossLines),
    grid: o.routeMap.grid, w: world.w, h: world.h, sulk: { spot }, targetOf: () => visit,
  });
  const visits = (b: ManagerBrain, c: ReturnType<typeof ctxOf>, n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      b.queueVisit('x');
      const d = b.decide(c, i * 10_000);
      if (d.say) out.push(d.say);
      b.decide(c, i * 10_000 + 5_000);
    }
    return out;
  };
  const pool = new Set([...BOSS_LINES, ...themed]).size;
  const c = ctxOf(themed);
  const said = visits(new ManagerBrain(), c, pool * 3);
  assert.equal(said.length, pool * 3);
  for (let i = 0; i < said.length; i += pool) assert.equal(new Set(said.slice(i, i + pool)).size, pool, 'one full round per pool-ful of visits');
  assert.ok(said.some((l) => themed.includes(l)) && said.some((l) => BOSS_LINES.includes(l)), 'both themed and built-in lines');
  for (const l of said) assert.ok(themed.includes(l) || BOSS_LINES.includes(l), l);
  // Changing the theme's lines rebuilds the deck at once.
  const b = new ManagerBrain();
  visits(b, c, 3);
  assert.deepEqual(new Set(visits(b, ctxOf(['ONLY'].concat(BOSS_LINES)), BOSS_LINES.length + 1)).has('ONLY'), true);
});

test('the manager: sulk start, mutter and end lines are dealt from decks too', () => {
  const o = new Office(world, { seed: 28 });
  const spot = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };
  const me = { arrived: true, goal: { key: 'mgr:sulk', tile: spot.tile }, x: 0, y: 0 };
  const ctx = { me: me as never, seat: o.managerSeat, spots: o.spots, queueLength: 0, rng: makeRng(9), grid: o.routeMap.grid, w: world.w, h: world.h, sulk: { spot }, targetOf: () => null };
  const b = new ManagerBrain();
  const starts: string[] = [];
  const ends: string[] = [];
  const mutters: string[] = [];
  let t = 0;
  for (let spell = 0; spell < SULK_START_LINES.length + 1; spell++) {
    b.setSulking(true);
    const s = b.decide(ctx, (t += 1_000));
    starts.push(s.say!);
    // Mutter for a while (one every 20-40 s), then the spell ends.
    for (let u = 0; u < 12 * 60; u++) { const d = b.decide(ctx, (t += 1_000)); if (d.say) mutters.push(d.say); }
    b.setSulking(false);
    ends.push(b.decide(ctx, (t += 1_000)).say!);
  }
  const rounds: [string[], readonly string[]][] = [[starts, SULK_START_LINES], [ends, SULK_END_LINES], [mutters, SULK_LINES]];
  for (const [got, pool] of rounds) {
    assert.ok(got.length >= pool.length, `${got.length} lines for ${pool.length}`);
    for (const l of got) assert.ok(pool.includes(l), l);
    for (let i = 0; i + pool.length <= got.length; i += pool.length) assert.equal(new Set(got.slice(i, i + pool.length)).size, pool.length, 'a full round, no repeats');
    got.slice(1).forEach((l, i) => assert.notEqual(l, got[i]));
  }
});
