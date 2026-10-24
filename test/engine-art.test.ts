// Office-tool props on the map: PROP_ANCHORS, the tiles kept clear for later desks, and walkability.
// The art modules use DOM types, so they're imported through a computed specifier (see engine-world.ts);
// the map data is DOM-free until sprites are requested.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ART = new URL('../webview/art/', import.meta.url).href;
const mapSpec: string = `${ART}office-map.ts`;
const map = await import(mapSpec);

const PROP_IDS = [
  'clock', 'calendar', 'inTray', 'whiteboard', 'directoryBoard', 'frontDesk',
  'bookshelf', 'phone', 'tempAgency', 'filingCabinets', 'noticeBoard',
];

type R = { x: number; y: number; w: number; h: number };

test('PROP_ANCHORS has exactly the hotspot ids, with sane rects inside the map', () => {
  assert.deepEqual(Object.keys(map.PROP_ANCHORS).sort(), [...PROP_IDS].sort());
  for (const id of PROP_IDS) {
    const r: R = map.PROP_ANCHORS[id];
    assert.ok(r.w > 0 && r.h > 0, id);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= map.MAP_PX_W && r.y + r.h <= map.MAP_PX_H, id);
  }
});

test('frontDesk is the reception counter', () => {
  assert.deepEqual(map.PROP_ANCHORS.frontDesk, { x: 64, y: 74, w: 48, h: 38 });
});

test('no new prop sits on the reception counter', () => {
  const counter: R = { x: 64, y: 74, w: 48, h: 38 };
  const overlaps = (a: R, b: R): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const id of PROP_IDS) {
    if (id === 'frontDesk') continue;
    assert.ok(!overlaps(map.PROP_ANCHORS[id], counter), id);
  }
});

test('the help desk stands at (15,14): seat and visit tile walkable, the rest of the desk blocked', () => {
  const seat = map.seats.find((s: { id: string }) => s.id === 'desk-helpdesk');
  assert.ok(seat);
  assert.equal(seat.owner, 'helpdesk');
  assert.deepEqual(seat.tile, { x: 15, y: 14 });
  assert.deepEqual(seat.visit, { tile: { x: 14, y: 14 }, facing: 'right' });
  assert.ok(map.desks.some((d: { id: string; kind: string }) => d.id === 'desk-helpdesk' && d.kind === 'staff'));
  for (const id of ['desk-helpdesk-chair', 'desk-helpdesk-top', 'desk-helpdesk-front']) assert.ok(map.furnitureIds.includes(id), id);
  assert.ok(map.isWalkable(15, 14), 'seat');
  for (const [x, y] of [[16, 14], [15, 15], [16, 15]]) assert.ok(!map.isWalkable(x, y), `blocked (${x},${y})`);
  for (const [x, y] of [[14, 14], [14, 15], [17, 14], [17, 15], [18, 14], [18, 15]]) assert.ok(map.isWalkable(x, y), `free (${x},${y})`);
});

test('the reception desk belongs to the receptionist, not to any worker', () => {
  const seat = map.seats.find((s: { id: string }) => s.id === 'desk-receptionist');
  assert.equal(seat.owner, 'reception');
  assert.equal(map.seatFor('reception').id, 'desk-receptionist');
  assert.ok(!map.tempSeats.some((s: { id: string }) => s.id === 'desk-receptionist'));
  assert.equal(map.seats.filter((s: { owner: string }) => s.owner !== 'temp' && s.owner !== 'manager' && s.owner !== 'reception').length, 8);
});

test('every seat, visit tile and spot is reachable from the elevator', () => {
  const W: number = map.MAP_W;
  const start = map.poi.elevator.tile;
  const seen = new Set<number>([start.y * W + start.x]);
  const queue = [start];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = t.x + dx!;
      const y = t.y + dy!;
      if (!map.isWalkable(x, y) || seen.has(y * W + x)) continue;
      seen.add(y * W + x);
      queue.push({ x, y });
    }
  }
  const tiles: { x: number; y: number }[] = [];
  for (const s of map.seats) tiles.push(s.tile, s.visit.tile);
  for (const v of Object.values(map.poi)) {
    for (const s of Array.isArray(v) ? v : [v]) tiles.push((s as { tile?: { x: number; y: number } }).tile ?? (s as { x: number; y: number }));
  }
  for (const t of tiles) assert.ok(seen.has(t.y * W + t.x), `(${t.x},${t.y})`);
});

test('every staff desk has a paper-pile anchor on its desk top', () => {
  for (const d of map.desks) {
    const a = map.deskPileAnchors[d.id];
    if (d.kind !== 'staff') { assert.equal(a, undefined, d.id); continue; }
    assert.ok(a, d.id);
    const seat = map.seats.find((s: { id: string }) => s.id === d.id);
    assert.equal(a.y, seat.tile.y * 16 + 17, d.id);
  }
});

test('new decoration is placed as furniture', () => {
  for (const id of ['directory-board', 'bookshelf', 'temp-agency']) assert.ok(map.furnitureIds.includes(id), id);
});
