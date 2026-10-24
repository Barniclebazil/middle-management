import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPath, blockTiles } from '../webview/engine/path.ts';
import { Office } from '../webview/engine/office.ts';
import type { Tile } from '../webview/engine/types.ts';
import { loadWorld } from './engine-world.ts';

function grid(rows: string[]): { g: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const g = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { g[y * w + x] = ch === '#' ? 0 : 1; }));
  return { g, w, h };
}

function isContiguous(path: Tile[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const d = Math.abs(path[i]!.x - path[i - 1]!.x) + Math.abs(path[i]!.y - path[i - 1]!.y);
    if (d !== 1) return false;
  }
  return true;
}

test('A* finds a shortest 4-directional path around walls', () => {
  const { g, w, h } = grid([
    '.....',
    '.###.',
    '...#.',
    '.#...',
  ]);
  const p = findPath(g, w, h, { x: 0, y: 0 }, { x: 2, y: 2 })!;
  assert.ok(p);
  assert.deepEqual(p[0], { x: 0, y: 0 });
  assert.deepEqual(p[p.length - 1], { x: 2, y: 2 });
  assert.equal(p.length, 5); // 4 steps
  assert.ok(isContiguous(p));
  for (const t of p) assert.equal(g[t.y * w + t.x], 1);
});

test('A* returns null when unreachable and a single tile when already there', () => {
  const { g, w, h } = grid([
    '..#..',
    '..#..',
  ]);
  assert.equal(findPath(g, w, h, { x: 0, y: 0 }, { x: 4, y: 1 }), null);
  assert.deepEqual(findPath(g, w, h, { x: 1, y: 1 }, { x: 1, y: 1 }), [{ x: 1, y: 1 }]);
  assert.equal(findPath(g, w, h, { x: 0, y: 0 }, { x: 9, y: 9 }), null);
});

test('A* may start on and end on blocked tiles (seats), but never passes through them', () => {
  const base = grid(['.....', '.....', '.....']);
  const g = blockTiles(base.g, base.w, [{ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 1 }]);
  const p = findPath(g, base.w, base.h, { x: 0, y: 0 }, { x: 4, y: 2 })!;
  assert.ok(p && isContiguous(p));
  for (const t of p.slice(1, -1)) assert.equal(g[t.y * base.w + t.x], 1, `passes blocked ${t.x},${t.y}`);
});

test('A* prefers straight runs over staircases', () => {
  const { g, w, h } = grid(['......', '......', '......', '......']);
  const p = findPath(g, w, h, { x: 0, y: 0 }, { x: 5, y: 3 })!;
  let turns = 0;
  for (let i = 2; i < p.length; i++) {
    const a = [p[i - 1]!.x - p[i - 2]!.x, p[i - 1]!.y - p[i - 2]!.y];
    const b = [p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y];
    if (a[0] !== b[0] || a[1] !== b[1]) turns++;
  }
  assert.equal(turns, 1);
});

test('on the real map every seat, visit tile and spot is reachable from the elevator without crossing other seats', async () => {
  const world = await loadWorld();
  const office = new Office(world);
  const { grid: g, w, h } = office.routeMap;
  const from = world.poi.elevator.tile;
  const targets: Tile[] = [
    ...world.seats.map((s) => s.tile), ...world.seats.map((s) => s.visit.tile),
    ...world.poi.filingCabinets.map((s) => s.tile), world.poi.easel.tile, world.poi.whiteboard.tile, world.poi.copier.tile,
    world.poi.shredder.tile, world.poi.fridge.tile, world.poi.microwave.tile, world.poi.coffee.tile, world.poi.vendingMachine.tile,
    ...world.poi.waterCooler.map((s) => s.tile), ...world.poi.kitchenTable.map((s) => s.tile),
    ...world.poi.managerDoorQueue.map((s) => s.tile), world.poi.managerInsideDoor.tile, world.poi.managerDoor,
  ];
  for (const t of targets) {
    const p = findPath(g, w, h, from, t);
    assert.ok(p, `unreachable ${t.x},${t.y}`);
  }
  // The manager's only way out is the door.
  const mgr = world.seats.find((s) => s.owner === 'manager')!;
  const p = findPath(g, w, h, mgr.tile, world.seats.find((s) => s.owner === 'assistant')!.visit.tile)!;
  assert.ok(p.some((t) => t.x === world.poi.managerDoor.x && t.y === world.poi.managerDoor.y));
});

test("on the real map the boss's sulk spot is reachable from the elevator and from every seat, outside his office", async () => {
  const world = await loadWorld();
  const office = new Office(world);
  const { grid: g, w, h } = office.routeMap;
  const sulk = world.poi.sulk.tile;
  assert.ok(findPath(g, w, h, world.poi.elevator.tile, sulk), 'from the elevator');
  for (const s of world.seats) assert.ok(findPath(g, w, h, s.tile, sulk), `from ${s.id}`);
  // He walks out through his door to get there.
  const mgr = world.seats.find((s) => s.owner === 'manager')!;
  const p = findPath(g, w, h, mgr.tile, sulk)!;
  assert.ok(p.some((t) => t.x === world.poi.managerDoor.x && t.y === world.poi.managerDoor.y));
  assert.ok(world.seats.every((s) => s.tile.x !== sulk.x || s.tile.y !== sulk.y), 'not on a desk seat');
});
