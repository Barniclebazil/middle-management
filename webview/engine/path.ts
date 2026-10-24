/**
 * A* path finding on the walk grid: 4-directional, unit step cost, with a
 * small penalty for turning so people walk in straight lines and L shapes
 * rather than staircases.
 */
import type { Tile } from './types.ts';

const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;
const TURN_COST = 0.15;

/** Binary min-heap of state indices keyed by f-score. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.items.length; }
  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= k[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      [k[p], k[i]] = [k[i]!, k[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0]!;
    const lastI = a.pop()!;
    const lastK = k.pop()!;
    if (a.length > 0) {
      a[0] = lastI;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l]! < k[m]!) m = l;
        if (r < a.length && k[r]! < k[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        [k[m], k[i]] = [k[i]!, k[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Finds a path from `from` to `to` on `grid` (1 = walkable, index y*w+x).
 * The start and goal tiles are always allowed, even if blocked, so a
 * character standing on a seat can leave it and walk to another seat.
 * Returns the tiles from start to goal inclusive, or null if unreachable.
 */
export function findPath(grid: Uint8Array, w: number, h: number, from: Tile, to: Tile): Tile[] | null {
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  if (!inside(from.x, from.y) || !inside(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];
  const n = w * h;
  // State = tile * 5 + arrival direction (4 = none, for the start).
  const states = n * 5;
  const g = new Float64Array(states).fill(Infinity);
  const parent = new Int32Array(states).fill(-1);
  const closed = new Uint8Array(states);
  const goalIdx = to.y * w + to.x;
  const startIdx = from.y * w + from.x;
  const hFn = (idx: number): number => Math.abs((idx % w) - to.x) + Math.abs(Math.floor(idx / w) - to.y);
  const heap = new Heap();
  const s0 = startIdx * 5 + 4;
  g[s0] = 0;
  heap.push(s0, hFn(startIdx));
  let found = -1;
  while (heap.size > 0) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const idx = Math.floor(s / 5);
    const dir = s % 5;
    if (idx === goalIdx) { found = s; break; }
    const x = idx % w;
    const y = Math.floor(idx / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]!;
      const ny = y + DY[d]!;
      if (!inside(nx, ny)) continue;
      const ni = ny * w + nx;
      if (grid[ni] !== 1 && ni !== goalIdx) continue;
      const ns = ni * 5 + d;
      if (closed[ns]) continue;
      const cost = g[s]! + 1 + (dir !== 4 && dir !== d ? TURN_COST : 0);
      if (cost < g[ns]!) {
        g[ns] = cost;
        parent[ns] = s;
        heap.push(ns, cost + hFn(ni));
      }
    }
  }
  if (found < 0) return null;
  const out: Tile[] = [];
  for (let s = found; s >= 0; s = parent[s]!) {
    const idx = Math.floor(s / 5);
    out.push({ x: idx % w, y: Math.floor(idx / w) });
  }
  out.reverse();
  return out;
}

/** Copy of a walk grid with extra tiles blocked (e.g. every seat tile, so people don't walk over desks). */
export function blockTiles(grid: Uint8Array, w: number, tiles: readonly Tile[]): Uint8Array {
  const g = new Uint8Array(grid);
  for (const t of tiles) g[t.y * w + t.x] = 0;
  return g;
}
