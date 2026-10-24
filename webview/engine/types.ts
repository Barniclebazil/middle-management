/**
 * DOM-free types shared by the engine's logic modules.
 *
 * The art modules (`webview/art/*`) use DOM types, and the root tsconfig
 * (used for the Node tests) has no DOM lib, so the logic modules never import
 * from `webview/art`. Instead they mirror the few shapes they need here, and
 * `main.ts` hands the real map data in as a `WorldDef` (the art's objects are
 * structurally compatible).
 */

/** Facing direction (same values as the art's `Dir`). */
export type Dir = 'down' | 'up' | 'left' | 'right';

/** Character poses (same values as the art's `Pose`). */
export type Pose =
  | 'stand' | 'walk'
  | 'sitIdle' | 'sitType' | 'sitRead' | 'sitThink' | 'sitRun' | 'sitPhone'
  | 'mugSip' | 'chairSpin' | 'deskSip'
  | 'rummage' | 'draw' | 'whiteboard' | 'copierWait' | 'knock'
  | 'wave' | 'point' | 'talk' | 'shred'
  | 'wipe' | 'pickFood' | 'pushCart'
  | 'fixPc' | 'scoff' | 'readCard';

/** Food the boss can pick from the cart (same values as the art's `FoodId`). */
export type FoodId = 'carrotCake' | 'doughnut' | 'crisps';
/** Every food id, in cart order (the art's `FOOD_IDS`). */
export const FOOD_IDS: readonly FoodId[] = ['carrotCake', 'doughnut', 'crisps'];

/** Poses drawn with the seated (cut-off torso) frames. */
export const SEATED_POSES: ReadonlySet<Pose> = new Set<Pose>(['sitIdle', 'sitType', 'sitRead', 'sitThink', 'sitRun', 'sitPhone', 'mugSip', 'chairSpin', 'deskSip']);

/** A tile coordinate. */
export interface Tile { readonly x: number; readonly y: number }

/** A standing or sitting spot with the pose to play there. */
export interface SpotDef { readonly tile: Tile; readonly facing: Dir; readonly pose: Pose }

/** A desk seat (mirror of the art's `Seat`). */
export interface SeatDef {
  readonly id: string;
  readonly owner: string;
  readonly tile: Tile;
  readonly facing: Dir;
  readonly deskId: string;
  readonly visit: { readonly tile: Tile; readonly facing: Dir };
  /** One of the hand-picked best desks (ranked first). */
  readonly best?: boolean;
  /** The seat tile is on the annex carpet (ranked last). */
  readonly annex?: boolean;
}

/** Named points of interest (mirror of the art's `poi`). */
export interface PoiDef {
  readonly filingCabinets: readonly SpotDef[];
  readonly easel: SpotDef;
  readonly whiteboard: SpotDef;
  readonly copier: SpotDef;
  readonly shredder: SpotDef;
  readonly fridge: SpotDef;
  readonly microwave: SpotDef;
  readonly coffee: SpotDef;
  readonly waterCooler: readonly SpotDef[];
  readonly vendingMachine: SpotDef;
  readonly kitchenTable: readonly SpotDef[];
  readonly managerDoor: Tile;
  readonly managerDoorQueue: readonly SpotDef[];
  readonly managerInsideDoor: SpotDef;
  readonly elevator: SpotDef;
  readonly reception: SpotDef;
  readonly delegate: SpotDef;
  /** Where the boss sulks while a Fable agent has his office. */
  readonly sulk: SpotDef;
}

/** Everything the logic needs to know about the office map. */
export interface WorldDef {
  /** Map size in tiles. */
  readonly w: number;
  readonly h: number;
  /** Tile size in pixels. */
  readonly tile: number;
  /** 1 = walkable, index y * w + x. */
  readonly grid: Uint8Array;
  /** All seats (the first with owner 'manager' is the manager's). */
  readonly seats: readonly SeatDef[];
  /** Temp seats in preference order (annex first). */
  readonly tempSeats: readonly SeatDef[];
  readonly poi: PoiDef;
  /** Built-in staff archetype ids in hand-out order; the desk of slot i is `desk-<archetypes[i]>`. */
  readonly archetypes: readonly string[];
  /** Built-in temp look ids. */
  readonly tempLooks: readonly string[];
  /** Staff slot ids in hand-out order (`staff-0`..): the look ids staff get; slot i sits at the desk of `archetypes[i]`. */
  readonly staffSlots: readonly string[];
  /** Temp slot ids (`temp-0`..), handed out round-robin as the look ids of temps. */
  readonly tempSlots: readonly string[];
}

/** Feet pixel (character anchor) for a tile. */
export function tileFeet(t: Tile, size = 16): { x: number; y: number } {
  return { x: t.x * size + size / 2, y: t.y * size + size };
}

/** The tile a feet position stands on. */
export function feetTile(x: number, y: number, size = 16): Tile {
  return { x: Math.floor(x / size), y: Math.floor((y - 1) / size) };
}

/** Stable string key for a tile. */
export function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

/** The direction to face to look from `a` at `b`. */
export function facingToward(a: Tile, b: Tile): Dir {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? 'right' : 'left';
  if (dy !== 0) return dy > 0 ? 'down' : 'up';
  return 'down';
}

/** A tiny seeded PRNG (mulberry32), so behaviour is reproducible in tests. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [a, b). */
export function randRange(rng: () => number, a: number, b: number): number {
  return a + (b - a) * rng();
}

/** Random element of a non-empty array. */
export function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length]!;
}

/** Dedupe key of a `[opener, reply]` pair, for a `Deck` of pairs. */
export function pairKey(p: readonly [string, string]): string {
  return p[0] + '\u0000' + p[1];
}

/**
 * Deals a pool in shuffled rounds (Fisher-Yates with the given seeded rng): every card once before any comes
 * back, and the first card of a new round is never the last one dealt (unless the pool has just one card).
 * Cards with the same `key` count once (the first wins); the key is the string itself unless given.
 * An empty pool has nothing to deal: `next()` throws, so callers guard (the built-in pools are never empty).
 */
export class Deck<T> {
  private readonly cards: T[];
  /** The rest of the current round; dealt from the end. */
  private rest: T[] = [];
  private last: T | undefined = undefined;
  private readonly rng: () => number;

  constructor(rng: () => number, pool: readonly T[], key: (x: T) => string = (x) => String(x)) {
    this.rng = rng;
    const byKey = new Map<string, T>();
    for (const x of pool) if (!byKey.has(key(x))) byKey.set(key(x), x);
    this.cards = [...byKey.values()];
  }

  /** Number of distinct cards. */
  get size(): number {
    return this.cards.length;
  }

  next(): T {
    if (this.rest.length === 0) this.shuffle();
    this.last = this.rest.pop()!;
    return this.last;
  }

  private shuffle(): void {
    const n = this.cards.length;
    if (n === 0) throw new Error('Deck: empty pool');
    const xs = [...this.cards];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    // The next card is the last one: swap it with another, so the seam never repeats.
    if (n > 1 && xs[n - 1] === this.last) [xs[n - 1], xs[0]] = [xs[0]!, xs[n - 1]!];
    this.rest = xs;
  }
}

/**
 * A `Deck` over several source pools mixed together, rebuilt when a source array (by identity, so a new theme
 * object counts) or the rng changes. A source may be undefined or empty; if all are, `next()` throws as `Deck` does.
 */
export class LiveDeck<T> {
  private deck: Deck<T> | null = null;
  private rng: (() => number) | null = null;
  private sources: readonly (readonly T[] | undefined)[] = [];
  private readonly key: (x: T) => string;

  constructor(key: (x: T) => string = (x) => String(x)) {
    this.key = key;
  }

  next(rng: () => number, ...sources: readonly (readonly T[] | undefined)[]): T {
    const same = this.deck && rng === this.rng && sources.length === this.sources.length && sources.every((s, i) => s === this.sources[i]);
    if (!same) {
      this.deck = new Deck(rng, sources.flatMap((s) => s ?? []), this.key);
      this.rng = rng;
      this.sources = sources;
    }
    return this.deck!.next();
  }
}
