import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assigner } from '../webview/engine/assign.ts';
import type { AssignInput } from '../webview/engine/assign.ts';
import { bandFor, bandsOf, deskKind, rankDesks } from '../webview/engine/deskRank.ts';
import type { ModelTier } from '../webview/engine/modelTier.ts';
import { blockTiles } from '../webview/engine/path.ts';
import type { SeatDef } from '../webview/engine/types.ts';
import { loadWorld } from './engine-world.ts';

const w = await loadWorld();
// The same route map and ranking the office builds: every seat tile blocked, distances from the first door-queue spot.
const blocked = [...w.seats.map((s) => s.tile), ...w.poi.kitchenTable.map((s) => s.tile)];
const routeMap = { grid: blockTiles(w.grid, w.w, blocked), w: w.w, h: w.h };
const candidates = w.seats.filter((s) => s.owner !== 'manager' && s.owner !== 'reception');
const ranked = rankDesks(candidates, routeMap, w.poi.managerDoorQueue[0]!.tile);
const bands = bandsOf(ranked);
const mgrSeat = w.seats.find((s) => s.owner === 'manager')!;
const ids = (seats: readonly SeatDef[]): string[] => seats.map((s) => s.id);

function make(): Assigner {
  return new Assigner(w.archetypes, w.tempLooks, ranked, mgrSeat);
}

const main = (id: string, startedAt: number, tier: ModelTier | null = null): AssignInput => ({ id, kind: 'main', startedAt, tier });
const temp = (id: string, startedAt: number, tier: ModelTier | null = null): AssignInput => ({ id, kind: 'temp', startedAt, tier });
const seatOf = (a: Assigner, id: string): string | null => a.get(id)?.seat?.id ?? null;
const bandOfId = (a: Assigner, id: string): number => {
  const s = seatOf(a, id);
  return bands.findIndex((b) => b.some((d) => d.id === s));
};
/** `n` agents of one tier, ids `${prefix}0..`, started at `t0 + i`. */
const many = (prefix: string, n: number, tier: ModelTier | null, t0: number, kind: 'main' | 'temp' = 'main'): AssignInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, kind, startedAt: t0 + i, tier }));

// ---------------------------------------------------------------------------
// Ranking and bands

test('desks are ranked: the seven best first, then the rest of the floor, then the annex; each by the walk from the boss\'s door', () => {
  assert.equal(ranked.length, 20, '8 staff desks, 7 annex desks, 5 spare bullpen desks');
  assert.ok(!ranked.some((s) => s.owner === 'manager' || s.owner === 'reception'));
  assert.equal(ranked[0]!.id, 'desk-assistant', 'the desk right outside the boss\'s door is the best');
  assert.equal(ranked[ranked.length - 1]!.id, 'temp-annex-4');
  // The real order: the best desks, the other floor desks, then every annex desk (hr's included), each by walk from the boss's door.
  assert.deepEqual(ids(ranked), [
    'desk-assistant', 'desk-prankster', 'temp-bullpen-2', 'temp-bullpen-4', 'desk-knitting', 'temp-bullpen-3', 'temp-bullpen-1',
    'desk-crossword', 'desk-helpdesk', 'temp-bullpen-5', 'desk-chili', 'desk-cat',
    'temp-annex-5', 'temp-annex-1', 'temp-annex-6', 'temp-annex-2', 'temp-annex-7', 'temp-annex-3', 'desk-hr', 'temp-annex-4',
  ]);
});

test('desk kinds: 0 the seven hand-picked best desks, 1 the rest of the floor, 2 every desk on the annex carpet (desk-hr too)', () => {
  const BEST = ['desk-assistant', 'desk-prankster', 'desk-knitting', 'temp-bullpen-1', 'temp-bullpen-2', 'temp-bullpen-3', 'temp-bullpen-4'];
  assert.deepEqual(ids(candidates.filter((s) => deskKind(s) === 0)).sort(), [...BEST].sort());
  assert.equal(deskKind(candidates.find((s) => s.id === 'desk-hr')!), 2);
  const annex = candidates.filter((s) => s.id.startsWith('temp-annex-'));
  assert.equal(annex.length, 7);
  for (const s of annex) assert.equal(deskKind(s), 2, s.id);
  assert.equal(candidates.filter((s) => deskKind(s) === 2).length, 8, 'the 7 temp annex desks and desk-hr');
  assert.equal(candidates.filter((s) => deskKind(s) === 1).length, 5);
  // A desk that is both marked best and on annex carpet counts as best.
  assert.equal(deskKind({ ...candidates[0]!, best: true, annex: true }), 0);
});

test('three bands: a third each (rounded up), the rest last; band 0 is exactly the seven best desks, the annex is not in it', () => {
  assert.deepEqual(bands.map((b) => b.length), [7, 7, 6]);
  assert.deepEqual(bands.flat(), ranked);
  assert.deepEqual(ids(bands[0]!).sort(), ['desk-assistant', 'desk-knitting', 'desk-prankster', 'temp-bullpen-1', 'temp-bullpen-2', 'temp-bullpen-3', 'temp-bullpen-4']);
  for (const id of ['temp-annex-2', 'temp-annex-4', 'desk-hr']) assert.ok(ids(bands[2]!).includes(id), id);
  assert.deepEqual(bandsOf(ranked.slice(0, 4)).map((b) => b.length), [2, 2, 0]);
  assert.deepEqual(bandsOf([]).map((b) => b.length), [0, 0, 0]);
});

test('home bands: fable and opus 0, sonnet and unknown 1, haiku 2', () => {
  assert.deepEqual([bandFor('fable'), bandFor('opus'), bandFor('sonnet'), bandFor(null), bandFor('haiku')], [0, 0, 1, 1, 2]);
});

test('unreachable desks rank last, by id', () => {
  const grid = new Uint8Array(9).fill(1);
  grid[1] = 0; grid[4] = 0; grid[7] = 0; // a wall down the middle of a 3x3 room
  const seat = (id: string, x: number, y: number): SeatDef => ({ id, owner: 'temp', tile: { x, y }, facing: 'down', deskId: id, visit: { tile: { x, y }, facing: 'down' } });
  const r = rankDesks([seat('z-far', 2, 0), seat('b', 0, 2), seat('a', 2, 2), seat('near', 0, 1)], { grid, w: 3, h: 3 }, { x: 0, y: 0 });
  assert.deepEqual(ids(r), ['near', 'b', 'a', 'z-far']);
});

// ---------------------------------------------------------------------------
// Seats by model

test('each tier sits at the best desk of its home band; temps follow the same rules as mains', () => {
  const a = make();
  const r = a.assign([main('o', 1, 'opus'), main('s', 2, 'sonnet'), main('h', 3, 'haiku'), temp('to', 4, 'opus'), temp('th', 5, 'haiku'), temp('tu', 6)]);
  assert.deepEqual(r.fresh.sort(), ['h', 'o', 's', 'th', 'to', 'tu']);
  assert.deepEqual(r.moved, []);
  assert.equal(seatOf(a, 'o'), 'desk-assistant');
  assert.equal(seatOf(a, 'to'), 'desk-prankster', 'an opus temp sits next to the opus main');
  assert.equal(seatOf(a, 's'), 'desk-crossword');
  assert.equal(seatOf(a, 'tu'), 'desk-helpdesk', 'an unknown model sits with the sonnets');
  assert.equal(seatOf(a, 'h'), 'temp-annex-6');
  assert.equal(seatOf(a, 'th'), 'temp-annex-2');
});

test('fable shares band 0 with opus and never bumps it', () => {
  const a = make();
  a.assign(many('o', 7, 'opus', 0));
  a.assign([...many('o', 7, 'opus', 0), main('f', 100, 'fable')]);
  assert.equal(bandOfId(a, 'f'), 1, 'band 0 is full of opus: fable overflows');
  for (let i = 0; i < 7; i++) assert.equal(bandOfId(a, `o${i}`), 0);
});

test('overflow goes to a worse band first (its best free desk), then a better one (its worst free desk)', () => {
  const a = make();
  a.assign(many('o', 8, 'opus', 0));
  assert.equal(seatOf(a, 'o7'), 'desk-crossword', 'the 8th opus takes the best desk of band 1');
  const b = make();
  b.assign(many('h', 7, 'haiku', 0));
  assert.equal(seatOf(b, 'h6'), 'temp-annex-1', 'the 7th haiku takes the worst desk of band 1');
  // A full worse band sends a sonnet up: the worst free desk of band 0.
  const c = make();
  c.assign(many('h', 6, 'haiku', 0));
  c.assign([...many('h', 6, 'haiku', 0), ...many('s', 8, 'sonnet', 10)]);
  assert.equal(seatOf(c, 's7'), 'temp-bullpen-1');
});

test('runs out of desks gracefully: 20 seated, the rest have none; nobody gets the boss\'s or the front desk', () => {
  const a = make();
  const all = [...many('m', 12, null, 0), ...many('t', 18, 'haiku', 100, 'temp')];
  a.assign(all);
  const seated = all.filter((x) => seatOf(a, x.id) !== null);
  assert.equal(seated.length, 20);
  assert.equal(new Set(seated.map((x) => seatOf(a, x.id))).size, 20);
  for (const x of all) {
    assert.notEqual(seatOf(a, x.id), 'desk-receptionist', x.id);
    assert.notEqual(seatOf(a, x.id), 'desk-manager', x.id);
  }
  // A freed desk goes to someone still standing on the next call.
  const stillStanding = all.filter((x) => seatOf(a, x.id) === null);
  const leaver = seated[0]!.id;
  a.release(leaver);
  const r = a.assign(all.filter((x) => x.id !== leaver));
  assert.ok(r.moved.some((id) => stillStanding.some((x) => x.id === id)));
  assert.equal(all.filter((x) => seatOf(a, x.id) !== null).length, 20);
});

test('bumping: an arriving opus takes the desk of a sonnet squatting in band 0; the latest squatter goes first', () => {
  const a = make();
  const base = [...many('h', 6, 'haiku', 0), ...many('s', 7, 'sonnet', 10)];
  a.assign(many('h', 6, 'haiku', 0)); // haiku first, so the extra sonnets can't overflow downwards
  a.assign([...base, main('x1', 100, 'sonnet'), main('x2', 200, 'sonnet')]);
  assert.equal(seatOf(a, 'x1'), 'temp-bullpen-1', 'worst free desk of band 0');
  assert.equal(seatOf(a, 'x2'), 'temp-bullpen-3', 'the next worst');
  // Six opus: five free desks, the sixth bumps the later squatter, who has nowhere to go.
  const r = a.assign([...base, main('x1', 100, 'sonnet'), main('x2', 200, 'sonnet'), ...many('o', 6, 'opus', 300)]);
  assert.deepEqual(r.moved, ['x2']);
  assert.equal(seatOf(a, 'x2'), null);
  assert.equal(seatOf(a, 'x1'), 'temp-bullpen-1');
  assert.equal(seatOf(a, 'o5'), 'temp-bullpen-3');
  // The seventh opus bumps the other one.
  const r2 = a.assign([...base, main('x1', 100, 'sonnet'), main('x2', 200, 'sonnet'), ...many('o', 7, 'opus', 300)]);
  assert.deepEqual(r2.moved, ['x1']);
  assert.equal(seatOf(a, 'o6'), 'temp-bullpen-1');
});

test('a bumped agent is placed again by the same rules', () => {
  const a = make();
  const h = many('h', 7, 'haiku', 0);
  a.assign(h);
  assert.equal(seatOf(a, 'h6'), 'temp-annex-1', 'band 2 is full: the 7th haiku squats the worst desk of band 1');
  // Seven sonnets: six free desks at home, the seventh bumps the haiku, who goes up to band 0 (bands 1 and 2 are full).
  const s7 = many('s', 7, 'sonnet', 100);
  let r = a.assign([...h, ...s7]);
  assert.deepEqual(r.moved, ['h6']);
  assert.equal(seatOf(a, 's6'), 'temp-annex-1');
  assert.equal(seatOf(a, 'h6'), 'temp-bullpen-1');
  // Seven opus: the seventh bumps the haiku again, and now there is no desk left for it.
  r = a.assign([...h, ...s7, ...many('o', 7, 'opus', 200)]);
  assert.deepEqual(r.moved, ['h6']);
  assert.equal(seatOf(a, 'h6'), null);
  assert.equal(seatOf(a, 'o6'), 'temp-bullpen-1');
});

test('moving home: an overflowed agent goes home when a desk there frees; agents at home never shuffle up', () => {
  const a = make();
  a.assign(many('o', 8, 'opus', 0));
  assert.equal(bandOfId(a, 'o7'), 1);
  // o0 leaves (walks out: absent from the call, then released).
  const rest = many('o', 8, 'opus', 0).slice(1);
  assert.deepEqual(a.assign(rest).moved, [], 'still walking out: the desk is not free yet');
  a.release('o0');
  const r = a.assign(rest);
  assert.deepEqual(r.moved, ['o7']);
  assert.equal(seatOf(a, 'o7'), 'desk-assistant');
  // A home agent doesn't move up to a better desk in its band.
  const b = make();
  b.assign([main('p', 1, 'opus'), main('q', 2, 'opus')]);
  assert.equal(seatOf(b, 'q'), 'desk-prankster');
  b.release('p');
  assert.deepEqual(b.assign([main('q', 2, 'opus')]).moved, []);
  assert.equal(seatOf(b, 'q'), 'desk-prankster');
});

test('a tier change that changes the home band re-places the agent; one that doesn\'t, doesn\'t', () => {
  const a = make();
  a.assign([main('u', 1), main('v', 2)]);
  assert.equal(seatOf(a, 'u'), 'desk-crossword');
  // Unknown -> sonnet: same band, no move.
  assert.deepEqual(a.assign([main('u', 1, 'sonnet'), main('v', 2)]).moved, []);
  // Sonnet -> haiku: moves to band 2.
  const r = a.assign([main('u', 1, 'haiku'), main('v', 2)]);
  assert.deepEqual(r.moved, ['u']);
  assert.equal(seatOf(a, 'u'), 'temp-annex-6');
  // Unknown -> opus.
  assert.deepEqual(a.assign([main('u', 1, 'haiku'), main('v', 2, 'opus')]).moved, ['v']);
  assert.equal(seatOf(a, 'v'), 'desk-assistant');
  // Fable -> opus keeps its band-0 desk.
  a.assign([main('u', 1, 'haiku'), main('v', 2, 'fable')]);
  assert.equal(seatOf(a, 'v'), 'desk-assistant');
});

test('absent ids (walking out) keep their desk and are never bumped or moved until released', () => {
  const a = make();
  a.assign(many('h', 6, 'haiku', 0));
  a.assign([...many('h', 6, 'haiku', 0), ...many('s', 7, 'sonnet', 10), main('x', 100, 'sonnet')]);
  assert.equal(seatOf(a, 'x'), 'temp-bullpen-1');
  // x is walking out: the opus that would bump it can't, and overflows (band 1 and 2 are full, so nowhere).
  const present = [...many('h', 6, 'haiku', 0), ...many('s', 7, 'sonnet', 10), ...many('o', 7, 'opus', 200)];
  const r = a.assign(present);
  assert.equal(seatOf(a, 'x'), 'temp-bullpen-1');
  assert.ok(!r.moved.includes('x'));
  assert.equal(seatOf(a, 'o6'), null);
  // Released: the desk frees and the opus without one takes it.
  a.release('x');
  assert.deepEqual(a.assign(present).moved, ['o6']);
  assert.equal(seatOf(a, 'o6'), 'temp-bullpen-1');
  // An absent overflowed agent doesn't move home either.
  const b = make();
  b.assign(many('o', 8, 'opus', 0));
  b.release('o0');
  b.assign(many('o', 8, 'opus', 0).slice(1, 7));
  assert.equal(bandOfId(b, 'o7'), 1, 'absent: frozen');
});

test('eviction: the holder sits in the boss\'s chair and its desk is freed; cleared, it comes back and bumps a squatter', () => {
  const a = make();
  const everyone = [...many('h', 6, 'haiku', 0), ...many('s', 7, 'sonnet', 10), ...many('o', 6, 'opus', 20), main('f', 30, 'fable')];
  a.assign(everyone);
  assert.equal(bandOfId(a, 'f'), 0);
  const fDesk = seatOf(a, 'f');
  a.setEviction('f');
  assert.equal(seatOf(a, 'f'), fDesk, 'takes effect on the next assign');
  let r = a.assign(everyone);
  assert.deepEqual(r.moved, ['f']);
  assert.equal(seatOf(a, 'f'), mgrSeat.id);
  // A sonnet arrives: bands 1 and 2 are full, so it takes the freed band-0 desk.
  const plus = [...everyone, main('late', 40, 'sonnet')];
  a.assign(plus);
  assert.equal(seatOf(a, 'late'), fDesk);
  // Assigning again changes nothing while the eviction holds.
  assert.deepEqual(a.assign(plus).moved, []);
  // Cleared: fable comes home and bumps the squatter, who has nowhere to go.
  a.setEviction(null);
  r = a.assign(plus);
  assert.deepEqual(r.moved.sort(), ['f', 'late']);
  assert.equal(seatOf(a, 'f'), fDesk);
  assert.equal(seatOf(a, 'late'), null);
});

test('eviction: an overflowed agent moves into the freed desk at once; changing the holder re-places the previous one', () => {
  const a = make();
  const opus = many('o', 8, 'opus', 0);
  a.assign(opus);
  assert.equal(bandOfId(a, 'o7'), 1);
  a.setEviction('o0');
  const r = a.assign(opus);
  assert.deepEqual(r.moved.sort(), ['o0', 'o7']);
  assert.equal(seatOf(a, 'o0'), mgrSeat.id);
  assert.equal(seatOf(a, 'o7'), 'desk-assistant');
  // A new holder: o1's desk frees, and o0, placed again by the normal rules, takes it.
  a.setEviction('o1');
  const r2 = a.assign(opus);
  assert.deepEqual(r2.moved.sort(), ['o0', 'o1']);
  assert.equal(seatOf(a, 'o1'), mgrSeat.id);
  assert.equal(seatOf(a, 'o0'), 'desk-prankster', 'o1\'s freed desk is the only free one in band 0');
  // Released while evicted: the chair is free again and nothing else moves.
  a.release('o1');
  assert.deepEqual(a.assign(opus.filter((x) => x.id !== 'o1')).moved, []);
});

// ---------------------------------------------------------------------------
// Looks (independent of seats)

test('mains get archetypes in startedAt order, whatever their seat', () => {
  const a = make();
  a.assign([main('c', 300, 'haiku'), main('a', 100), main('b', 200, 'opus'), main('b2', 200)]);
  assert.equal(a.get('a')!.look, 'assistant');
  assert.equal(a.get('b')!.look, 'prankster');
  assert.equal(a.get('b2')!.look, 'helpdesk'); // tie broken by id
  assert.equal(a.get('c')!.look, 'crossword');
  // Seats follow the model, not the look.
  assert.equal(seatOf(a, 'b'), 'desk-assistant');
  assert.equal(seatOf(a, 'a'), 'desk-crossword');
  assert.equal(seatOf(a, 'c'), 'temp-annex-6');
});

test('looks are stable; a freed archetype is reused only after release', () => {
  const a = make();
  a.assign([main('a', 100), main('b', 200)]);
  // A newcomer with an earlier start doesn't steal anything.
  a.assign([main('a', 100), main('b', 200), main('early', 50)]);
  assert.equal(a.get('a')!.look, 'assistant');
  assert.equal(a.get('b')!.look, 'prankster');
  assert.equal(a.get('early')!.look, 'helpdesk');
  // 'a' is still walking out: its look stays taken.
  a.assign([main('b', 200), main('early', 50), main('x', 400)]);
  assert.equal(a.get('x')!.look, 'crossword');
  a.release('a');
  a.assign([main('b', 200), main('early', 50), main('x', 400), main('y', 500)]);
  assert.equal(a.get('y')!.look, 'assistant');
});

test('mains beyond the 8 archetypes and all temps get temp looks round-robin', () => {
  const a = make();
  const mains = Array.from({ length: 9 }, (_, i) => main(`m${i}`, i));
  a.assign(mains);
  assert.deepEqual(mains.slice(0, 8).map((m) => a.get(m.id)!.look), [...w.archetypes]);
  assert.equal(a.get('m8')!.look, w.tempLooks[0]);
  a.assign([...mains, temp('t1', 10), temp('t2', 11)]);
  assert.equal(a.get('t1')!.look, w.tempLooks[1]);
  assert.equal(a.get('t2')!.look, w.tempLooks[2]);
});

// ---------------------------------------------------------------------------
// Pins (custom staff themes)

const pinned = (id: string, startedAt: number, project: string, title = `Session ${id}`): AssignInput => ({ id, kind: 'main', startedAt, tier: null, project, title });

test('a free slot whose pin matches wins over the order', () => {
  const a = make();
  a.setPins(new Map([['hr', { project: 'api' }], ['cat', { project: 'web' }]]));
  a.assign([pinned('x', 1, 'my-web-app')]);
  assert.equal(a.get('x')!.look, 'cat');
  a.assign([pinned('y', 2, 'API-server')]);
  assert.equal(a.get('y')!.look, 'hr');
  a.assign([pinned('z', 3, 'other')]);
  assert.equal(a.get('z')!.look, 'assistant', 'no match: the first free unpinned slot');
});

test('both pin parts must match; the title is checked case-insensitively', () => {
  const a = make();
  a.setPins(new Map([['chili', { project: 'web', title: 'Fix' }]]));
  a.assign([pinned('p', 1, 'web-app', 'add a button')]);
  assert.notEqual(a.get('p')!.look, 'chili', 'project matches but the title does not');
  a.assign([pinned('q', 2, 'web-app', 'FIX the login')]);
  assert.equal(a.get('q')!.look, 'chili');
});

test('a free unpinned slot is preferred over a pinned slot that does not match', () => {
  const a = make();
  // The first slots are pinned to other projects; the first unpinned one is the third.
  a.setPins(new Map([['assistant', { project: 'api' }], ['prankster', { project: 'db' }]]));
  a.assign([pinned('x', 1, 'web')]);
  assert.equal(a.get('x')!.look, 'helpdesk');
  a.assign([pinned('y', 2, 'web')]);
  assert.equal(a.get('y')!.look, 'crossword');
});

test('pinned slots are used last, in order, before any temp look', () => {
  const a = make();
  const pins = new Map<string, { project: string }>();
  for (const s of ['assistant', 'prankster']) pins.set(s, { project: 'nomatch' });
  a.setPins(pins);
  const mains = Array.from({ length: 9 }, (_, i) => pinned(`m${i}`, i, 'web'));
  a.assign(mains);
  // Unpinned slots first (helpdesk ... hr), then the pinned ones, then a temp.
  assert.deepEqual(mains.slice(0, 8).map((m) => a.get(m.id)!.look), [...w.archetypes.slice(2), 'assistant', 'prankster']);
  assert.equal(a.get('m8')!.look, w.tempLooks[0]);
});

test('a pinned slot that was freed is taken again by a later matching agent', () => {
  const a = make();
  a.setPins(new Map([['prankster', { project: 'web' }]]));
  a.assign([pinned('first', 1, 'web-app')]);
  assert.equal(a.get('first')!.look, 'prankster');
  // While the first is still there, the next matching agent can't have it.
  a.assign([pinned('second', 2, 'web-app')]);
  assert.notEqual(a.get('second')!.look, 'prankster');
  a.release('first');
  a.assign([pinned('third', 3, 'unrelated')]);
  assert.notEqual(a.get('third')!.look, 'prankster', 'a non-matching agent takes an unpinned slot first');
  a.assign([pinned('fourth', 4, 'web-app')]);
  assert.equal(a.get('fourth')!.look, 'prankster');
});

test('without pins, or with pins that name nothing, hand-out is the plain order; temps ignore pins', () => {
  const a = make();
  a.setPins(new Map([['assistant', {}], ['prankster', undefined]]));
  a.assign([pinned('x', 1, 'web'), pinned('y', 2, 'web')]);
  assert.equal(a.get('x')!.look, 'assistant');
  assert.equal(a.get('y')!.look, 'prankster');
  a.setPins(new Map([['helpdesk', { project: 'web' }]]));
  a.assign([{ id: 't', kind: 'temp', startedAt: 3, tier: null, project: 'web' }]);
  assert.equal(a.get('t')!.look, 'temp0');
});

test('the 3rd main session gets the help-desk look; the reception desk is never a candidate', () => {
  assert.equal(w.archetypes[2], 'helpdesk');
  const reception = w.seats.find((s) => s.id === 'desk-receptionist')!;
  assert.equal(reception.owner, 'reception');
  assert.ok(!w.archetypes.includes(reception.owner as string));
  assert.ok(!ranked.some((s) => s.id === 'desk-receptionist'));
  const a = make();
  a.assign(Array.from({ length: 3 }, (_, i) => main(`m${i}`, i)));
  assert.equal(a.get('m2')!.look, 'helpdesk');
});
