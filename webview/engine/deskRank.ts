/**
 * Which desks are the best ones: desks ranked by kind first (the hand-picked
 * best desks, then the rest of the floor, then the annex), then by how far
 * they are to walk from the boss's door, and split into three bands (best
 * third, middle third, the rest) that the model tiers are seated in
 * (`assign.ts`). Kind comes first because the annex is right beside the boss's
 * office: on distance alone it would be the best band, and Opus would be
 * seated with the temps.
 *
 * Distance is measured from the first door-queue spot, the tile just outside
 * the boss's door (30,10 on the built-in map): it is an ordinary floor tile, so
 * every path starts in the open office and none cuts through the boss's room.
 * (Measuring from the door tile itself gives the same order, one step longer.)
 */
import { findPath } from './path.ts';
import { tierRank } from './modelTier.ts';
import type { ModelTier } from './modelTier.ts';
import type { SeatDef, Tile } from './types.ts';

/** The grid the distances are walked on: the office's route map (every seat tile blocked; the goal is always allowed). */
export interface RankGrid { readonly grid: Uint8Array; readonly w: number; readonly h: number }

/** Number of bands: 0 = the best desks (fable and opus), 1 = the middle (sonnet, unknown), 2 = the rest (haiku). */
export const BAND_COUNT = 3;

/** A desk's kind, best first: 0 a hand-picked best desk, 1 any other desk, 2 a desk on the annex carpet (best wins if both). */
export function deskKind(s: SeatDef): number {
  if (s.best) return 0;
  return s.annex ? 2 : 1;
}

/**
 * The candidate desks, best first: by kind (`deskKind`), then by walking distance (steps) from `from`, ties by
 * seat id; within a kind, desks that can't be reached at all go last (by id). The caller leaves out the boss's
 * and the reception desk.
 */
export function rankDesks(seats: readonly SeatDef[], map: RankGrid, from: Tile): SeatDef[] {
  const dist = new Map<string, number>();
  for (const s of seats) {
    const p = findPath(map.grid, map.w, map.h, from, s.tile);
    dist.set(s.id, p ? p.length - 1 : Infinity);
  }
  return [...seats].sort((a, b) => {
    const ka = deskKind(a);
    const kb = deskKind(b);
    if (ka !== kb) return ka - kb;
    const da = dist.get(a.id)!;
    const db = dist.get(b.id)!;
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Splits ranked desks into the three bands: the first third (rounded up), the next third (rounded up), the rest. */
export function bandsOf(ranked: readonly SeatDef[]): SeatDef[][] {
  const size = Math.ceil(ranked.length / BAND_COUNT);
  return [ranked.slice(0, size), ranked.slice(size, size * 2), ranked.slice(size * 2)];
}

/** A tier's home band: fable and opus 0, sonnet 1, haiku 2; an unknown model (null) ranks as sonnet, so 1. */
export function bandFor(tier: ModelTier | null): number {
  return Math.min(BAND_COUNT - 1, Math.max(0, tierRank(tier) - 1));
}
