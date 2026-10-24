// Theme line pools reach the characters who say them: `lineSources` (add / replace / legacy merging / ASCII folding)
// and, for each brain, that a filled pool in replace mode says only the theme's lines while an unfilled one keeps the
// built-in lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newChar } from '../webview/engine/characters.ts';
import { CLEANER_ID, CLEANER_LOOK_ID, CleanerBrain } from '../webview/engine/cleaner.ts';
import type { CleanerCtx, CleanerDecision } from '../webview/engine/cleaner.ts';
import { CartBrain, VENDOR_ID, VENDOR_LOOK_ID } from '../webview/engine/foodCart.ts';
import type { CartCtx, CartDecision } from '../webview/engine/foodCart.ts';
import { DEZ_LOOK_ID, FENWICK_LOOK_ID, IT_DEZ_ID, IT_FENWICK_ID, ItCrewBrain } from '../webview/engine/itCrew.ts';
import type { ItCtx, ItDecision, ItDesk, ItListener } from '../webview/engine/itCrew.ts';
import {
  BOSS_LINES, BUMP_LINES, CART_CALLS, CLEANER_MUTTERS, LINE_POOLS, RECEPTION_GREETINGS, RECEPTION_IDLE_LINES,
  RECEPTION_PHONE_LINES, SMALL_TALK, SULK_END_LINES, SULK_LINES, SULK_START_LINES,
} from '../webview/engine/lines.ts';
import { ManagerBrain } from '../webview/engine/manager.ts';
import { Office } from '../webview/engine/office.ts';
import { ReceptionBrain } from '../webview/engine/reception.ts';
import type { ReceptionCtx } from '../webview/engine/reception.ts';
import { buildSpots } from '../webview/engine/targets.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import { foldAscii, lineSources, smallTalkSources, themeState } from '../webview/engine/theme.ts';
import type { LinesHook, PairsHook, ThemeState } from '../webview/engine/theme.ts';
import { makeRng, tileFeet } from '../webview/engine/types.ts';
import type { SeatDef } from '../webview/engine/types.ts';
import { LINE_POOL_KEYS } from '../src/shared/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();
const HOUR = 3_600_000;
const spots = buildSpots(world);
const stateOf = (theme: OfficeTheme | undefined): ThemeState => themeState(theme, world.staffSlots, world.tempSlots);
const linesHook = (st: ThemeState | undefined): LinesHook => (key) => lineSources(st, key);
const pairsHook = (st: ThemeState | undefined): PairsHook => (key) => lineSources(st, key);
const has = (xs: readonly string[], x: string): boolean => xs.includes(x);
const any = (xs: readonly string[], pools: readonly (readonly string[])[]): boolean => xs.some((x) => pools.some((p) => has(p, x)));

// ---------------------------------------------------------------------------
// lineSources

test('no theme: the built-in pool alone, and the very same arrays every time', () => {
  for (const key of LINE_POOL_KEYS) {
    const a = lineSources(undefined, key);
    assert.equal(a.length, 1);
    assert.equal(a[0], LINE_POOLS[key], `${key}: the built-in array itself`);
    assert.equal(lineSources(undefined, key), a, `${key}: a stable outer array`);
    assert.equal(lineSources(stateOf(undefined), key)[0], LINE_POOLS[key], `${key}: an empty state says the same`);
  }
  assert.deepEqual(smallTalkSources(undefined), [SMALL_TALK]);
  assert.equal(smallTalkSources(undefined)[0], SMALL_TALK);
});

test('add mode (the default): the built-in lines, then the theme\'s when it has any', () => {
  const st = stateOf({ lines: { cleanerMutters: ['Mine.', 'Also mine.'] } });
  assert.equal(st.lineMode, 'add');
  const s = lineSources(st, 'cleanerMutters');
  assert.equal(s.length, 2);
  assert.equal(s[0], CLEANER_MUTTERS);
  assert.deepEqual(s[1], ['Mine.', 'Also mine.']);
  // A pool the theme leaves empty is just the built-in lines.
  const e = lineSources(st, 'cartCalls');
  assert.equal(e.length, 1);
  assert.equal(e[0], CART_CALLS);
  assert.equal(stateOf({ lineMode: 'add', lines: { cartCalls: [] } }).pools.cartCalls, undefined);
});

test('replace mode: a filled pool is only the theme\'s lines, an empty one keeps the built-in lines', () => {
  const st = stateOf({ lineMode: 'replace', lines: { cleanerMutters: ['Mine.'], itFixerTalk: [['Q?', 'A.']] } });
  assert.equal(st.lineMode, 'replace');
  assert.deepEqual(lineSources(st, 'cleanerMutters'), [['Mine.']]);
  assert.deepEqual(lineSources(st, 'itFixerTalk'), [[['Q?', 'A.']]]);
  assert.equal(lineSources(st, 'cartCalls')[0], CART_CALLS);
  assert.equal(lineSources(st, 'cartCalls').length, 1);
  assert.equal(lineSources(st, 'itCriticTalk').length, 1, 'the unfilled pairs pool keeps the built-in pairs');
  // Small talk follows the mode.
  assert.deepEqual(smallTalkSources(stateOf({ lineMode: 'replace', smallTalk: [['a', 'b']] })), [[['a', 'b']]]);
  assert.deepEqual(smallTalkSources(stateOf({ lineMode: 'replace' })), [SMALL_TALK]);
  assert.deepEqual(smallTalkSources(stateOf({ smallTalk: [['a', 'b']] })), [SMALL_TALK, [['a', 'b']]]);
});

test('the sources are stable per state: the same arrays on every call, new ones for a new state', () => {
  const st = stateOf({ lines: { bossVisit: ['Hi.'] }, smallTalk: [['a', 'b']] });
  for (const key of LINE_POOL_KEYS) {
    const a = lineSources(st, key);
    const b = lineSources(st, key);
    assert.equal(a, b, `${key}: identical outer array`);
    a.forEach((x, i) => assert.equal(x, b[i]));
  }
  assert.equal(smallTalkSources(st), smallTalkSources(st));
  const again = stateOf({ lines: { bossVisit: ['Hi.'] }, smallTalk: [['a', 'b']] });
  assert.notEqual(lineSources(again, 'bossVisit'), lineSources(st, 'bossVisit'));
});

test('legacy lines: manager.lines join bossVisit, receptionist.lines join the three reception pools, after the pool\'s own lines', () => {
  const st = stateOf({
    lines: { bossVisit: ['Own boss.'], receptionPhone: ['Own phone.'] },
    manager: { lines: ['Legacy boss.'] },
    receptionist: { lines: ['Legacy desk.'] },
  });
  assert.deepEqual(st.pools.bossVisit, ['Own boss.', 'Legacy boss.']);
  assert.deepEqual(st.pools.receptionPhone, ['Own phone.', 'Legacy desk.']);
  assert.deepEqual(st.pools.receptionGreeting, ['Legacy desk.']);
  assert.deepEqual(st.pools.receptionIdle, ['Legacy desk.']);
  assert.equal(st.pools.receptionAttending, undefined);
  assert.equal(st.pools.bossSnack, undefined);
  // They count as the theme filling the pool: replace mode says only them.
  const r = stateOf({ lineMode: 'replace', manager: { lines: ['Legacy boss.'] } });
  assert.deepEqual(lineSources(r, 'bossVisit'), [['Legacy boss.']]);
  assert.equal(lineSources(r, 'bossSnack')[0], LINE_POOLS.bossSnack);
});

test('ASCII folding: curly quotes, dashes, the ellipsis and Unicode spaces, everywhere a pixel font draws them', () => {
  assert.equal(foldAscii('It’s “fine” – really—truly−ok… yes no'), 'It\'s "fine" - really-truly-ok... yes no');
  assert.equal(foldAscii('‘a‚ „b″ ′'), '\'a\' "b" \'');
  assert.equal(foldAscii('café ok'), 'café ok', 'other characters are left alone');
  const st = stateOf({
    lines: { bossVisit: ['Don’t panic…'], itFixerTalk: [['“Q”?', 'A – b']] },
    smallTalk: [['Hi—you', 'It’s me']],
    manager: { name: 'Pat’s', lines: ['Legacy “one”'] },
    receptionist: { name: 'D’ot' },
    staff: [{ name: 'An’n', lines: ['Own…'] }],
    temps: [{ name: 'T’ess' }],
    titles: { cleaner: 'Tidy–upper' },
    vendor: { name: 'Vee’s' },
  });
  assert.deepEqual(st.pools.bossVisit, ["Don't panic...", 'Legacy "one"']);
  assert.deepEqual(st.pools.itFixerTalk, [['"Q"?', 'A - b']]);
  assert.deepEqual(st.smallTalk, [['Hi-you', "It's me"]]);
  assert.equal(st.managerName, "Pat's");
  assert.equal(st.receptionistName, "D'ot");
  assert.deepEqual(st.staff.get('staff-0')?.lines, ['Own...']);
  assert.equal(st.staff.get('staff-0')?.name, "An'n");
  assert.equal(st.temps.get('temp-0')?.name, "T'ess");
  assert.equal(st.titles.cleaner, 'Tidy-upper');
  assert.deepEqual(st.npcs.vendor, { name: "Vee's" });
});

test('the state carries the line mode, titles and the side characters\' names', () => {
  const st = stateOf({
    lineMode: 'replace',
    titles: { manager: 'Captain', temp: 'Hand' },
    cleaner: { name: 'Mop' }, vendor: { name: 'Cart Person' }, itFixer: { name: 'Fixer' }, itCritic: { name: 'Critic' },
  });
  assert.equal(st.lineMode, 'replace');
  assert.deepEqual(st.titles, { manager: 'Captain', temp: 'Hand' });
  assert.deepEqual(st.npcs, { cleaner: { name: 'Mop' }, vendor: { name: 'Cart Person' }, itFixer: { name: 'Fixer' }, itCritic: { name: 'Critic' } });
  assert.deepEqual(stateOf(undefined).titles, {});
  assert.deepEqual(stateOf({}).npcs, {});
});

// ---------------------------------------------------------------------------
// The manager

const offices = new Office(world, { seed: 28 });
const visitSpot = { tile: { x: 20, y: 11 }, seatVisit: { tile: { x: 20, y: 12 }, facing: 'up' as const } };
const sulkSpot = { tile: { x: 40, y: 5 }, facing: 'down' as const, pose: 'sitIdle' as const };

function visits(st: ThemeState | undefined, n: number): string[] {
  const me = { arrived: true, goal: { key: 'visit:x', tile: visitSpot.seatVisit.tile }, x: 0, y: 0 };
  const ctx = {
    me: me as never, seat: offices.managerSeat, spots: offices.spots, queueLength: 0, rng: makeRng(3), lines: linesHook(st),
    grid: offices.routeMap.grid, w: world.w, h: world.h, sulk: { spot: sulkSpot }, targetOf: () => visitSpot,
  };
  const b = new ManagerBrain();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    b.queueVisit('x');
    const d = b.decide(ctx, i * 10_000);
    if (d.say) out.push(d.say);
    b.decide(ctx, i * 10_000 + 5_000);
  }
  return out;
}

test('manager visit: in replace mode a filled pool never says a built-in line; an unfilled one still does', () => {
  const themed = Array.from({ length: 5 }, (_, i) => `VISIT-${i}`);
  const said = visits(stateOf({ lineMode: 'replace', lines: { bossVisit: themed } }), 300);
  assert.equal(said.length, 300);
  for (const l of said) assert.ok(has(themed, l), `built-in boss line: ${l}`);
  assert.equal(new Set(said).size, themed.length, 'all of them');
  // Only bossSulk is filled: the visits are the built-in ones.
  const other = visits(stateOf({ lineMode: 'replace', lines: { bossSulk: ['x'] } }), 100);
  assert.equal(other.length, 100);
  for (const l of other) assert.ok(has(BOSS_LINES, l), `unexpected: ${l}`);
  // Add mode says both.
  const both = visits(stateOf({ lines: { bossVisit: themed } }), 300);
  assert.ok(both.some((l) => has(themed, l)) && both.some((l) => has(BOSS_LINES, l)));
});

test('manager visit: within a theme pool nothing repeats until every line has been said', () => {
  const themed = Array.from({ length: 6 }, (_, i) => `VISIT-${i}`);
  const said = visits(stateOf({ lineMode: 'replace', lines: { bossVisit: themed } }), themed.length * 20);
  for (let i = 0; i < said.length; i += themed.length) assert.equal(new Set(said.slice(i, i + themed.length)).size, themed.length, `round at ${i}`);
  said.slice(1).forEach((l, i) => assert.notEqual(l, said[i]));
});

test('manager sulk: start, mutter and end lines come from their own theme pools, and keep the built-in ones when unfilled', () => {
  const st = stateOf({ lineMode: 'replace', lines: { bossSulkStart: ['START-1', 'START-2'], bossSulk: ['MUTTER-1', 'MUTTER-2', 'MUTTER-3'] } });
  const me = { arrived: true, goal: { key: 'mgr:sulk', tile: sulkSpot.tile }, x: 0, y: 0 };
  const ctx = { me: me as never, seat: offices.managerSeat, spots: offices.spots, queueLength: 0, rng: makeRng(9), lines: linesHook(st), grid: offices.routeMap.grid, w: world.w, h: world.h, sulk: { spot: sulkSpot }, targetOf: () => null };
  const b = new ManagerBrain();
  const starts: string[] = [];
  const ends: string[] = [];
  const mutters: string[] = [];
  let t = 0;
  for (let spell = 0; spell < 6; spell++) {
    b.setSulking(true);
    starts.push(b.decide(ctx, (t += 1_000)).say!);
    for (let u = 0; u < 12 * 60; u++) { const d = b.decide(ctx, (t += 1_000)); if (d.say) mutters.push(d.say); }
    b.setSulking(false);
    ends.push(b.decide(ctx, (t += 1_000)).say!);
  }
  for (const l of starts) assert.ok(l.startsWith('START-'), l);
  for (const l of mutters) assert.ok(l.startsWith('MUTTER-'), l);
  assert.ok(mutters.length >= 30);
  for (const l of ends) assert.ok(has(SULK_END_LINES, l), `the unfilled end pool is built-in: ${l}`);
  assert.ok(!any(mutters, [SULK_LINES]) && !any(starts, [SULK_START_LINES]));
});

// ---------------------------------------------------------------------------
// The receptionist

const SEAT: SeatDef = { id: 'desk-receptionist', owner: 'reception', tile: { x: 5, y: 5 }, facing: 'down', deskId: 'desk-receptionist', visit: { tile: { x: 5, y: 7 }, facing: 'up' } };
const recMe = newChar('__reception__', 'receptionist', 'receptionist', SEAT, 88, 96, 0);

function receptionSays(st: ThemeState | undefined, attending = false): { phone: string[]; greet: string[]; idle: string[]; attend: string[] } {
  const ctx: ReceptionCtx = { me: recMe, seat: SEAT, speechBubbles: true, lines: linesHook(st) };
  const b = new ReceptionBrain(8);
  const out = { phone: [] as string[], greet: [] as string[], idle: [] as string[], attend: [] as string[] };
  for (let t = 0; t <= 6 * HOUR; t += 500) {
    if (t % 20_000 === 0) b.noteArrival('main', t);
    if (attending && t % 60_000 === 0) b.setAttending(!b.isAttending());
    const d = b.decide(ctx, t);
    if (!d.say) continue;
    const list = b.isAttending() ? out.attend : d.goal.pose === 'sitPhone' ? out.phone : d.goal.pose === 'sitIdle' ? out.greet : out.idle;
    list.push(d.say.text);
  }
  return out;
}

test('receptionist phone: replace mode with a filled pool never says a built-in phone line; greeting and idle stay built-in', () => {
  const phoneLines = ['RING-1', 'RING-2', 'RING-3'];
  const said = receptionSays(stateOf({ lineMode: 'replace', lines: { receptionPhone: phoneLines } }));
  assert.ok(said.phone.length >= 100, `${said.phone.length} calls`);
  for (const l of said.phone) assert.ok(has(phoneLines, l), `built-in phone line: ${l}`);
  for (let i = 0; i + 3 <= said.phone.length; i += 3) assert.equal(new Set(said.phone.slice(i, i + 3)).size, 3, 'a full round before any repeat');
  assert.ok(said.greet.length > 50 && said.greet.every((l) => has(RECEPTION_GREETINGS, l)), 'greetings are built-in');
  assert.ok(said.idle.length > 50 && said.idle.every((l) => has(RECEPTION_IDLE_LINES, l)), 'idle remarks are built-in');
  assert.ok(!any(said.phone, [RECEPTION_PHONE_LINES]));
});

test('receptionist: the "What can I change for you?" line is a pool too (receptionAttending)', () => {
  const said = receptionSays(stateOf({ lineMode: 'replace', lines: { receptionAttending: ['AT-1', 'AT-2'] } }), true);
  assert.ok(said.attend.length >= 10, `${said.attend.length} attending lines`);
  for (const l of said.attend) assert.ok(l.startsWith('AT-'), l);
  assert.deepEqual(receptionSays(undefined, true).attend.length > 0, true);
  for (const l of receptionSays(undefined, true).attend) assert.ok(has(LINE_POOLS.receptionAttending, l));
});

// ---------------------------------------------------------------------------
// The cleaner and the food cart

const desks = world.seats.filter((s) => s.owner !== 'manager' && s.owner !== 'reception');

function cleanerMutters(st: ThemeState | undefined, seed: number): string[] {
  const ELEVATOR = tileFeet(spots.elevator.tile, world.tile);
  const me = newChar(CLEANER_ID, 'cleaner', CLEANER_LOOK_ID, null, ELEVATOR.x, ELEVATOR.y, 0);
  const ctx: CleanerCtx = { me, spots, seats: desks, seatEmpty: () => true, free: () => true, speechBubbles: true, lines: linesHook(st) };
  const b = new CleanerBrain(seed);
  const out: string[] = [];
  let was = false;
  for (let t = 0; t <= 8 * HOUR; t += 100) {
    if (t % (10 * 60_000) === 0) b.noteDirty(desks[0]!.id, t);
    const d: CleanerDecision | null = b.decide(ctx, t);
    if (d) {
      const f = tileFeet(d.goal.tile, world.tile);
      Object.assign(me, { x: f.x, y: f.y, goal: d.goal, arrived: true, arrivedAt: t, pose: d.goal.pose, dir: d.goal.facing });
      if (d.say) out.push(d.say.text);
    } else if (was) me.goal = null;
    was = d !== null;
  }
  return out;
}

test('cleaner: replace mode with a filled pool never mutters a built-in line; an unfilled pool still does', () => {
  const themed = ['MOP-1', 'MOP-2', 'MOP-3', 'MOP-4'];
  const said = cleanerMutters(stateOf({ lineMode: 'replace', lines: { cleanerMutters: themed } }), 5);
  assert.ok(said.length >= 60, `${said.length} mutters`);
  for (const l of said) assert.ok(has(themed, l), `built-in mutter: ${l}`);
  for (let i = 0; i + 4 <= said.length; i += 4) assert.equal(new Set(said.slice(i, i + 4)).size, 4, 'no repeat until the pool is exhausted');
  const other = cleanerMutters(stateOf({ lineMode: 'replace', lines: { cartCalls: ['x'] } }), 5);
  assert.ok(other.length >= 60);
  for (const l of other) assert.ok(has(CLEANER_MUTTERS, l), `unexpected: ${l}`);
  assert.ok(cleanerMutters(stateOf({ lines: { cleanerMutters: themed } }), 5).some((l) => has(CLEANER_MUTTERS, l)), 'add mode keeps the built-in lines');
});

function cartCalls(st: ThemeState | undefined, seed: number): string[] {
  const ELEVATOR = tileFeet(spots.elevator.tile, world.tile);
  const me = newChar(VENDOR_ID, 'vendor', VENDOR_LOOK_ID, null, ELEVATOR.x, ELEVATOR.y, 0);
  const ctx: CartCtx = { me, spots, speechBubbles: true, lines: linesHook(st) };
  const b = new CartBrain(seed);
  const out: string[] = [];
  for (let t = 0; t <= 24 * HOUR; t += 100) {
    const d: CartDecision | null = b.decide(ctx, t);
    if (!d) continue;
    const f = tileFeet(d.goal.tile, world.tile);
    Object.assign(me, { x: f.x, y: f.y, goal: d.goal, arrived: true, arrivedAt: t, pose: d.goal.pose, dir: d.goal.facing });
    if (d.say) out.push(d.say.text);
  }
  return out;
}

test('food cart: replace mode with a filled pool never calls a built-in line; an unfilled pool still does', () => {
  const themed = ['BUY-1', 'BUY-2', 'BUY-3'];
  const said = cartCalls(stateOf({ lineMode: 'replace', lines: { cartCalls: themed } }), 7);
  assert.ok(said.length >= 60, `${said.length} calls`);
  for (const l of said) assert.ok(has(themed, l), `built-in call: ${l}`);
  for (let i = 0; i + 3 <= said.length; i += 3) assert.equal(new Set(said.slice(i, i + 3)).size, 3, 'no repeat until the pool is exhausted');
  for (const l of cartCalls(stateOf({ lineMode: 'replace', lines: { cleanerMutters: ['x'] } }), 7)) assert.ok(has(CART_CALLS, l), `unexpected: ${l}`);
});

// ---------------------------------------------------------------------------
// The IT crew

const lobbyTile = spots.lobby[0]!.spot.tile;

/** Everything the pair says over many visits (a stub office where goals are reached at once). */
function itSays(st: ThemeState | undefined, seed: number, hours = 8): { dez: string[]; fenwick: string[]; reply: string[] } {
  const e = tileFeet(spots.elevator.tile, world.tile);
  const dez = newChar(IT_DEZ_ID, 'cleaner', DEZ_LOOK_ID, null, e.x, e.y, 0);
  const fen = newChar(IT_FENWICK_ID, 'cleaner', FENWICK_LOOK_ID, null, e.x, e.y, 0);
  const seat = world.seats.find((s) => s.id === 'desk-cat')!;
  const desks: ItDesk[] = [{ seat, worker: 'w0', state: 'working' }];
  const listeners: ItListener[] = [{ id: 'l1', who: 'agent', tile: lobbyTile }];
  const ctx: ItCtx = {
    dez, fenwick: fen, spots, speechBubbles: true, grid: world.grid, w: world.w, h: world.h,
    desks: () => desks, listeners: () => listeners, stillAt: () => true, canListen: () => true, free: () => true, spotAt: () => undefined,
    lines: linesHook(st), pairs: pairsHook(st),
  };
  const b = new ItCrewBrain(seed);
  const out = { dez: [] as string[], fenwick: [] as string[], reply: [] as string[] };
  // Goals are reached after a 7 s walk, so there is time for the walking mutters.
  const since = new Map<string, number>();
  const follow = (c: typeof dez, goal: ItDecision['dez']['goal'], t: number): void => {
    if (c.goal?.key !== goal.key) {
      c.arrived = false;
      since.set(c.id, t);
    }
    c.goal = goal;
    c.pose = goal.pose;
    c.dir = goal.facing;
  };
  const settle = (c: typeof dez, t: number): void => {
    if (c.arrived || !c.goal || t - (since.get(c.id) ?? 0) < 7_000) return;
    const f = tileFeet(c.goal.tile, world.tile);
    Object.assign(c, { x: f.x, y: f.y, arrived: true, arrivedAt: t });
  };
  let was = false;
  for (let t = 0; t <= hours * HOUR; t += 100) {
    if (!b.onStage && t % (10 * 60_000) === 0) b.summon(t);
    settle(dez, t);
    settle(fen, t);
    const d = b.decide(ctx, t);
    if (d) {
      follow(dez, d.dez.goal, t);
      follow(fen, d.fenwick.goal, t);
      if (d.dez.say) out.dez.push(d.dez.say.text);
      if (d.fenwick.say) out.fenwick.push(d.fenwick.say.text);
      if (d.reply) out.reply.push(d.reply.text);
    } else if (was) {
      dez.goal = null;
      fen.goal = null;
    }
    was = d !== null;
  }
  return out;
}

test('IT crew: replace mode with filled pools says only the theme\'s lines there, and the built-in ones in unfilled pools', () => {
  const verdicts = ['FIXED-1', 'FIXED-2', 'FIXED-3'];
  const mutters = ['GRUMBLE-1', 'GRUMBLE-2'];
  const talk: [string, string][] = [['OPENER-1', 'FOLLOW-1'], ['OPENER-2', 'FOLLOW-2'], ['OPENER-3', 'FOLLOW-3']];
  const st = stateOf({
    lineMode: 'replace',
    lines: { itVerdicts: verdicts, itFixerMutters: mutters, itFix: ['TURN IT OFF'], itFixerTalk: talk },
  });
  const said = itSays(st, 11);
  const dezAll = said.dez;
  assert.ok(dezAll.length > 50, `${dezAll.length} lines from the fixer`);
  const builtIn = (key: keyof typeof LINE_POOLS): readonly string[] => LINE_POOLS[key].flat();
  const replaced = [builtIn('itVerdicts'), builtIn('itFixerMutters'), builtIn('itFix'), builtIn('itFixerTalk')];
  assert.ok(!any(dezAll, replaced), 'no built-in line from a replaced pool');
  assert.ok(any(dezAll, [verdicts]), 'verdicts said');
  assert.ok(any(dezAll, [mutters]), 'mutters said');
  assert.ok(has(dezAll, "TURN IT OFF"), 'fix line said');
  assert.ok(dezAll.some((l) => l.startsWith('OPENER-')) && dezAll.some((l) => l.startsWith('FOLLOW-')), 'the themed pairs are said');
  // The critic's pools are unfilled: still the built-in sneers, mutters and football talk.
  const fen = said.fenwick;
  assert.ok(fen.length > 20);
  for (const l of fen) assert.ok(any([l], [builtIn('itSneers'), builtIn('itCriticMutters'), builtIn('itCriticTalk')]), `unexpected critic line: ${l}`);
  assert.ok(said.reply.length > 0 && said.reply.every((l) => any([l], [builtIn('itComebacks'), builtIn('itTalkReplies')])), 'unfilled reply pools are built-in');
  // No repeat within a themed pool until it is exhausted.
  const verdictsSaid = dezAll.filter((l) => has(verdicts, l));
  assert.ok(verdictsSaid.length >= 9);
  for (let i = 0; i + 3 <= verdictsSaid.length; i += 3) assert.equal(new Set(verdictsSaid.slice(i, i + 3)).size, 3, 'a full round of verdicts first');
});

test('IT crew: with no theme the pool lines are the built-in ones (hand-built contexts keep working)', () => {
  const said = itSays(undefined, 3, 4);
  const all = new Set<string>();
  for (const k of LINE_POOL_KEYS) for (const x of LINE_POOLS[k].flat()) all.add(x);
  for (const l of [...said.dez, ...said.fenwick, ...said.reply]) assert.ok(all.has(l), l);
});

// ---------------------------------------------------------------------------
// The office itself: desk remarks and the water cooler

const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';

function run(o: Office, t0: number, ms: number): number {
  let t = t0;
  for (let e = 0; e < ms; e += 33) {
    t += 33;
    o.update(t, 33, HOST0 + t);
  }
  return t;
}

/** A haiku squatter is bumped by the eighth model of a better rank; returns what they grumbled. */
function bumpLine(st: ThemeState | undefined, seed: number): string | null {
  const o = new Office(world, { seed });
  o.setTheme(st);
  const haiku = Array.from({ length: 7 }, (_, i) => agent(`h${i}`, { model: HAIKU, startedAt: HOST0 - 100_000 + i }));
  o.applySnapshot(haiku, 0, HOST0);
  const sonnets = Array.from({ length: 6 }, (_, i) => agent(`s${i}`, { model: SONNET, startedAt: HOST0 - 50_000 + i }));
  o.applySnapshot([...haiku, ...sonnets], 100, HOST0 + 100);
  const now = run(o, 100, 20_000);
  o.applySnapshot([...haiku, ...sonnets, agent('s6', { model: SONNET, startedAt: HOST0 - 40_000 })], now, HOST0 + now);
  return o.chars.get('h6')!.say?.text ?? null;
}

test('desk bumps: replace mode with a filled pool never grumbles a built-in line; an unfilled pool still does', () => {
  const themed = ['OUT-1', 'OUT-2', 'OUT-3'];
  const filled = stateOf({ lineMode: 'replace', lines: { deskBumped: themed } });
  const unfilled = stateOf({ lineMode: 'replace', lines: { deskMoveUp: ['UP-1'] } });
  for (let seed = 1; seed <= 25; seed++) {
    const said = bumpLine(filled, seed);
    assert.ok(said !== null && has(themed, said), `seed ${seed}: ${said}`);
    const kept = bumpLine(unfilled, seed);
    assert.ok(kept !== null && has(BUMP_LINES, kept), `seed ${seed}: ${kept}`);
  }
});

const idle = (id: string, n: number) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });

function coolerSays(st: ThemeState | undefined, ms: number): Set<string> {
  const o = new Office(world, { seed: 6, itCrew: false });
  o.setTheme(st);
  o.applySnapshot([idle('a', 1), idle('b', 2)], 0, HOST0);
  const seen = new Set<string>();
  let now = 0;
  for (let i = 0; i < ms / 33; i++) {
    now = run(o, now, 33);
    for (const id of ['a', 'b']) {
      const s = o.chars.get(id)?.say?.text;
      if (s) seen.add(s);
    }
  }
  return seen;
}

test('water cooler: replace mode with themed pairs never says a built-in pair; an empty list keeps the built-in ones', () => {
  const themed = Array.from({ length: 30 }, (_, i) => [`COOLER-OPENER-${i}`, `COOLER-REPLY-${i}`] as [string, string]);
  const said = coolerSays(stateOf({ lineMode: 'replace', smallTalk: themed }), 40 * 60_000);
  assert.ok(said.size >= 10, `${said.size} different lines`);
  const builtIn = new Set(SMALL_TALK.flat());
  for (const l of said) assert.ok(l.startsWith('COOLER-') && !builtIn.has(l), `unexpected line ${l}`);
  const kept = coolerSays(stateOf({ lineMode: 'replace' }), 60_000);
  assert.ok(kept.size > 0);
  for (const l of kept) assert.ok(builtIn.has(l), `unexpected line ${l}`);
});

test('the office uses a replaced chat-reply pool for the answer to a person\'s own line', () => {
  const o = new Office(world, { seed: 6, itCrew: false });
  o.setTheme(stateOf({ lineMode: 'replace', lines: { chatReplies: ['REPLY-1', 'REPLY-2'] }, staff: [{ name: 'Ann', lines: ['LINE-ANN'] }] }));
  o.applySnapshot([idle('a', 1), idle('b', 2)], 0, HOST0);
  const seen = new Set<string>();
  let now = 0;
  for (let i = 0; i < (40 * 60_000) / 33; i++) {
    now = run(o, now, 33);
    for (const id of ['a', 'b']) {
      const s = o.chars.get(id)?.say?.text;
      if (s) seen.add(s);
    }
  }
  assert.ok(seen.has('LINE-ANN'), "Ann's own line opens a chat");
  assert.ok(seen.has('REPLY-1') || seen.has('REPLY-2'), 'answered from the themed pool');
});
