/**
 * The Regional Manager (you): boss idles at the desk, tapping on the glass
 * when someone waits at the door, and desk visits after each prompt.
 *
 * Priority: a pending desk visit, then the door (someone queued), then the food
 * cart (once per arrival, while it is parked), then now and then a snoop (stands
 * behind a working agent and looks over their shoulder), then the desk. Visits
 * run one at a time.
 *
 * While a Fable agent has his office (`setSulking`), the desk and the door are
 * replaced by the sulk spot: he still goes out on desk visits, then goes back
 * to sulk, muttering now and then.
 */
import type { Char } from './characters.ts';
import type { Goal, Spots } from './targets.ts';
import type { Dir, FoodId, Pose, SeatDef, SpotDef, Tile } from './types.ts';
import { FOOD_IDS, LiveDeck, SEATED_POSES, facingToward, feetTile, makeRng, pick, randRange } from './types.ts';
import { findPath } from './path.ts';
import { poolSources } from './theme.ts';
import type { LinesHook } from './theme.ts';

/** How long the manager talks at a desk. */
export const VISIT_TALK_MS = 3_000;
/** While sulking, he mutters a line every this often (randomised between the two). */
export const SULK_LINE_MIN_MS = 20_000;
export const SULK_LINE_MAX_MS = 40_000;
/** Goal key of the sulk spot. */
export const SULK_KEY = 'mgr:sulk';
/** He goes snooping every this often (randomised between the two; the clock only runs while the office is open). */
export const SNOOP_EVERY_MIN_MS = 4 * 60_000;
export const SNOOP_EVERY_MAX_MS = 8 * 60_000;
/** How long he stands behind someone, looking, before he speaks; then how long he holds (the line shows that long). */
export const SNOOP_LOOK_MS = 3_000;
export const SNOOP_HOLD_MS = 2_000;
/** At the food cart he picks his food this long, then says his line and holds it up that long. */
export const CART_PICK_MS = 3_000;
export const CART_HOLD_MS = 2_500;
/** Goal key of his spot at the cart. */
export const CART_KEY = 'cart:boss';

/** Where a visited agent is (or is heading). */
export interface VisitTarget {
  /** The agent's goal tile (or current tile). */
  tile: Tile;
  /** Set when the agent is at (or heading for) its own seat: where to stand to talk to it. */
  seatVisit: { tile: Tile; facing: Dir } | null;
}

export interface ManagerCtx {
  me: Char;
  seat: SeatDef;
  spots: Spots;
  /** Number of agents queued at the door. */
  queueLength: number;
  rng: () => number;
  /** The sources of his lines per pool (the theme's, mixed with or replacing the built-in ones); without it he says the built-in lines. */
  lines?: LinesHook;
  grid: Uint8Array;
  w: number;
  h: number;
  /** Where to find an agent for a visit; null if it has gone. */
  targetOf(id: string): VisitTarget | null;
  /** Where to sulk right now, and the reservation that keeps others off it. */
  sulk: { spot: SpotDef; reserve?: string };
  /** Agents working at their own seat right now (whom he may snoop on). Left out: he never snoops. */
  workers?: () => readonly { id: string; seat: SeatDef }[];
  /** The food cart, present only while it stands parked: which arrival it is (he goes once per arrival) and where he stands to pick. */
  cart?: { arrival: number; spot: SpotDef };
}

/** The manager's decision for this tick. */
export interface ManagerDecision {
  goal: Goal;
  /** A boss-ism to say now (only on the tick the talk starts). */
  say?: string;
  /** How long the `say` shows (default: `VISIT_TALK_MS`). */
  sayMs?: number;
}

/** Picks where to stand to talk to someone at `target`. */
export function visitSpot(ctx: ManagerCtx, target: VisitTarget): { tile: Tile; facing: Dir } {
  if (target.seatVisit) return target.seatVisit;
  const t = target.tile;
  const from = { x: Math.floor(ctx.me.x / 16), y: Math.floor((ctx.me.y - 1) / 16) };
  let best: Tile | null = null;
  let bestD = Infinity;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const n = { x: t.x + dx, y: t.y + dy };
    if (n.x < 0 || n.y < 0 || n.x >= ctx.w || n.y >= ctx.h || ctx.grid[n.y * ctx.w + n.x] !== 1) continue;
    // Prefer the side the manager comes from; slightly prefer standing beside rather than above/below.
    const d = Math.abs(n.x - from.x) + Math.abs(n.y - from.y) + (dy !== 0 ? 0.5 : 0);
    if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) return { tile: t, facing: 'down' };
  return { tile: best, facing: facingToward(best, t) };
}

export class ManagerBrain {
  /** Agent ids waiting for a desk visit, oldest first. */
  pending: string[] = [];
  visit: { id: string; phase: 'out' | 'talk'; until: number; spot?: { tile: Tile; facing: Dir } } | null = null;
  private deskPose: Pose = 'sitIdle';
  private deskUntil = 0;
  private doorStep = 0;
  private doorUntil = 0;
  /** One deck per pool, so no line comes back until the rest have been said. */
  private readonly visitDeck = new LiveDeck<string>();
  private readonly sulkStartDeck = new LiveDeck<string>();
  private readonly sulkDeck = new LiveDeck<string>();
  private readonly sulkEndDeck = new LiveDeck<string>();
  private sulk = false;
  /** A start or end line to say on the next `decide`. */
  private sulkSay: 'start' | 'end' | null = null;
  /** When to mutter next (null: schedule on the next `decide`). */
  private sulkLineAt: number | null = null;
  private sulkPose: Pose = 'sitIdle';
  private sulkPoseUntil = 0;
  /** Snooping has its own rng, so it never disturbs the office's random sequence. */
  private readonly snoopRng: () => number;
  /** When to go snooping next (null: schedule on the next `decide`). */
  private snoopAt: number | null = null;
  /** The snoop in progress: walking to the tile behind `id`, looking, then holding after his line. */
  private snoop: { id: string; tile: Tile; phase: 'out' | 'look' | 'hold'; until: number } | null = null;
  /** The food cart trip has its own rng too (which food, which line). */
  private readonly cartRng: () => number;
  private readonly snackDeck = new LiveDeck<string>();
  private readonly snoopDeck = new LiveDeck<string>();
  /** The trip in progress: walking to his spot, picking his food, then holding it up after his line. */
  private cartTrip: { arrival: number; food: FoodId; phase: 'out' | 'pick' | 'hold'; until: number } | null = null;
  /** The last arrival he has had his snack at. */
  private cartDone = 0;

  constructor(snoopRng: () => number = makeRng(0x5a00b), cartRng: () => number = makeRng(0xca47b)) {
    this.snoopRng = snoopRng;
    this.cartRng = cartRng;
  }

  /** Queues a desk visit (no duplicates). */
  queueVisit(id: string): void {
    if (this.visit?.id === id || this.pending.includes(id)) return;
    this.pending.push(id);
  }

  /** Forgets visits to an agent that has gone. */
  drop(id: string): void {
    this.pending = this.pending.filter((p) => p !== id);
    if (this.visit?.id === id) this.visit = null;
    if (this.snoop?.id === id) this.snoop = null;
  }

  /** True while out of the office on a visit. */
  get visiting(): boolean {
    return this.visit !== null;
  }

  /** The agent he is snooping on (walking over, looking or holding), or null. */
  get snooping(): string | null {
    return this.snoop?.id ?? null;
  }

  /** True while he is on his way to the food cart, picking from it or holding his snack up. */
  get atCart(): boolean {
    return this.cartTrip !== null;
  }

  /** The snoop timer is due: he goes snooping as soon as he is free (and nothing else, like the cart, is on). */
  snoopNow(t: number): void {
    this.snoopAt = t;
  }

  /** True while his office is taken and he sulks. */
  get sulking(): boolean {
    return this.sulk;
  }

  /**
   * Starts or ends a sulk (a Fable agent has taken his office). He says so on the next `decide` unless
   * `quiet` (e.g. a spell already running when the view loads).
   */
  setSulking(on: boolean, quiet = false): void {
    if (on === this.sulk) return;
    this.sulk = on;
    this.sulkSay = quiet ? null : on ? 'start' : 'end';
    this.sulkLineAt = null;
  }

  decide(ctx: ManagerCtx, t: number): ManagerDecision {
    const d = this.decideGoal(ctx, t);
    if (d.say !== undefined) return d;
    // A start or end line waits until he has finished talking at someone's desk.
    if (this.sulkSay && this.visit?.phase !== 'talk') {
      const start = this.sulkSay === 'start';
      this.sulkSay = null;
      return { ...d, say: (start ? this.sulkStartDeck : this.sulkEndDeck).next(ctx.rng, ...poolSources(ctx.lines, start ? 'bossSulkStart' : 'bossSulkEnd')) };
    }
    if (!this.sulk) return d;
    if (this.sulkLineAt === null) this.sulkLineAt = t + randRange(ctx.rng, SULK_LINE_MIN_MS, SULK_LINE_MAX_MS);
    // Mutters only while sitting it out at the sulk spot (not on a visit).
    if (t >= this.sulkLineAt && d.goal.key === SULK_KEY && ctx.me.arrived && ctx.me.goal?.key === SULK_KEY) {
      this.sulkLineAt = t + randRange(ctx.rng, SULK_LINE_MIN_MS, SULK_LINE_MAX_MS);
      return { ...d, say: this.sulkDeck.next(ctx.rng, ...poolSources(ctx.lines, 'bossSulk')) };
    }
    return d;
  }

  private decideGoal(ctx: ManagerCtx, t: number): ManagerDecision {
    // The snoop timer runs whatever he is doing; when it is due and he is busy, it waits until he is free.
    if (ctx.workers && this.snoopAt === null) this.snoopAt = t + randRange(this.snoopRng, SNOOP_EVERY_MIN_MS, SNOOP_EVERY_MAX_MS);
    for (let guard = 0; guard < 8; guard++) {
      if (!this.visit) {
        const next = this.pending.shift();
        if (next === undefined) break;
        this.visit = { id: next, phase: 'out', until: 0 };
      }
      const v = this.visit;
      this.snoop = null;
      this.cartTrip = null;
      const target = ctx.targetOf(v.id);
      if (!target) { this.visit = null; continue; }
      // While talking, stay put even if the agent gets up and walks off.
      const spot = v.phase === 'talk' && v.spot ? v.spot : visitSpot(ctx, target);
      const key = `visit:${v.id}`;
      const talkPose: Pose = spot.facing === 'up' ? 'stand' : 'talk';
      if (v.phase === 'out') {
        const there = ctx.me.arrived && ctx.me.goal?.key === key && ctx.me.goal.tile.x === spot.tile.x && ctx.me.goal.tile.y === spot.tile.y;
        if (there) {
          v.phase = 'talk';
          v.until = t + VISIT_TALK_MS;
          v.spot = spot;
          return { goal: this.visitGoal(key, spot, talkPose), say: this.visitDeck.next(ctx.rng, ...poolSources(ctx.lines, 'bossVisit')) };
        }
        return { goal: this.visitGoal(key, spot, 'stand') };
      }
      if (t < v.until) return { goal: this.visitGoal(key, spot, talkPose) };
      this.visit = null;
    }
    // Sulking: no door duty (it isn't his office right now).
    if (this.sulk) { this.snoop = null; this.cartTrip = null; return { goal: this.sulkGoal(ctx, t) }; }
    if (ctx.queueLength > 0) { this.snoop = null; this.cartTrip = null; return { goal: this.doorGoal(ctx, t) }; }
    // A snoop already under way is finished first; one that is merely due waits for the cart.
    const cart = this.snoop ? null : this.cartDecision(ctx, t);
    if (cart) return cart;
    return this.snoopDecision(ctx, t) ?? { goal: this.deskGoal(ctx, t) };
  }

  /** The tile behind a seat (one up from it) if he can stand and walk there, else null. */
  private behindTile(ctx: ManagerCtx, seat: SeatDef): Tile | null {
    const b = { x: seat.tile.x, y: seat.tile.y - 1 };
    if (b.x < 0 || b.y < 0 || b.x >= ctx.w || b.y >= ctx.h || ctx.grid[b.y * ctx.w + b.x] !== 1) return null;
    return findPath(ctx.grid, ctx.w, ctx.h, feetTile(ctx.me.x, ctx.me.y), b) ? b : null;
  }

  /**
   * The food cart: while it stands parked and he has not had his snack this arrival, he walks to his spot beside it,
   * picks a random food for `CART_PICK_MS`, says one of his justifications, holds the food up for `CART_HOLD_MS` and goes
   * back to the desk. Null when he is not going. The caller has already ruled out visits, sulking and the door; a trip
   * they cut short does not count, so he comes back while the cart is still there.
   */
  private cartDecision(ctx: ManagerCtx, t: number): ManagerDecision | null {
    const cart = ctx.cart;
    if (!cart) { this.cartTrip = null; return null; }
    if (!this.cartTrip) {
      if (cart.arrival === this.cartDone) return null;
      this.cartTrip = { arrival: cart.arrival, food: pick(this.cartRng, FOOD_IDS), phase: 'out', until: 0 };
    }
    const trip = this.cartTrip;
    const spot = cart.spot;
    const g = ctx.me.goal;
    const stand: Goal = { key: CART_KEY, tile: spot.tile, facing: spot.facing, pose: 'stand', away: true };
    if (trip.phase === 'out') {
      if (!(ctx.me.arrived && g?.key === CART_KEY && g.tile.x === spot.tile.x && g.tile.y === spot.tile.y)) return { goal: stand };
      trip.phase = 'pick';
      trip.until = t + CART_PICK_MS;
    }
    const goal: Goal = { ...stand, pose: 'pickFood', food: trip.food };
    if (trip.phase === 'pick') {
      if (t < trip.until) return { goal };
      trip.phase = 'hold';
      trip.until = t + CART_HOLD_MS;
      this.cartDone = trip.arrival;
      return { goal, say: this.snackDeck.next(this.cartRng, ...poolSources(ctx.lines, 'bossSnack')), sayMs: CART_HOLD_MS };
    }
    if (t < trip.until) return { goal };
    this.cartTrip = null;
    return null;
  }

  /**
   * The snoop: when the timer is due and he is free, he picks a random agent working at its own seat (with a free
   * tile behind it), stands there facing the screen for `SNOOP_LOOK_MS`, says a snoop line (`bossSnoop`), holds `SNOOP_HOLD_MS`,
   * and goes back to the desk. Null when he is not snooping. The caller has already ruled out visits, sulking and the door.
   */
  private snoopDecision(ctx: ManagerCtx, t: number): ManagerDecision | null {
    if (!ctx.workers) { this.snoop = null; return null; }
    if (!this.snoop) {
      if (this.snoopAt === null || t < this.snoopAt) return null;
      this.snoopAt = t + randRange(this.snoopRng, SNOOP_EVERY_MIN_MS, SNOOP_EVERY_MAX_MS);
      const options: { id: string; tile: Tile }[] = [];
      for (const w of ctx.workers()) {
        const tile = this.behindTile(ctx, w.seat);
        if (tile) options.push({ id: w.id, tile });
      }
      if (options.length === 0) return null;
      const o = pick(this.snoopRng, options);
      this.snoop = { id: o.id, tile: o.tile, phase: 'out', until: 0 };
    }
    const s = this.snoop;
    // Whoever it was has stopped working or gone: he drops it (once he has spoken he just finishes).
    if (s.phase !== 'hold' && !ctx.workers().some((w) => w.id === s.id)) { this.snoop = null; return null; }
    const key = `snoop:${s.id}`;
    const goal: Goal = { key, tile: s.tile, facing: 'down', pose: 'stand', away: true };
    const g = ctx.me.goal;
    if (s.phase === 'out') {
      if (!(ctx.me.arrived && g?.key === key && g.tile.x === s.tile.x && g.tile.y === s.tile.y)) return { goal };
      s.phase = 'look';
      s.until = t + SNOOP_LOOK_MS;
    }
    if (s.phase === 'look') {
      if (t < s.until) return { goal };
      s.phase = 'hold';
      s.until = t + SNOOP_HOLD_MS;
      return { goal, say: this.snoopDeck.next(this.snoopRng, ...poolSources(ctx.lines, 'bossSnoop')), sayMs: SNOOP_HOLD_MS };
    }
    if (t < s.until) return { goal };
    this.snoop = null;
    return null;
  }

  private visitGoal(key: string, spot: { tile: Tile; facing: Dir }, pose: Pose): Goal {
    return { key, tile: spot.tile, facing: spot.facing, pose, away: true };
  }

  /** Sits it out at the sulk spot: mostly still, with the odd grumpy sip from the mug he took with him. */
  private sulkGoal(ctx: ManagerCtx, t: number): Goal {
    const { spot, reserve } = ctx.sulk;
    const g = ctx.me.goal;
    const there = ctx.me.arrived && g?.key === SULK_KEY && g.tile.x === spot.tile.x && g.tile.y === spot.tile.y;
    if (!there || !SEATED_POSES.has(spot.pose)) {
      this.sulkPose = spot.pose;
      this.sulkPoseUntil = t + randRange(ctx.rng, 5000, 10000);
    } else if (t >= this.sulkPoseUntil) {
      const sip = this.sulkPose !== 'mugSip' && ctx.rng() < 0.3;
      this.sulkPose = sip ? 'mugSip' : spot.pose;
      this.sulkPoseUntil = t + (sip ? 3200 : randRange(ctx.rng, 6000, 12000));
    }
    const goal: Goal = { key: SULK_KEY, tile: spot.tile, facing: spot.facing, pose: this.sulkPose, away: true };
    if (reserve) goal.reserve = reserve;
    return goal;
  }

  private doorGoal(ctx: ManagerCtx, t: number): Goal {
    const steps: readonly [Pose, number][] = [['wave', 1500], ['stand', 2200], ['talk', 1600], ['stand', 1800]];
    if (t >= this.doorUntil) {
      this.doorStep = (this.doorStep + 1) % steps.length;
      this.doorUntil = t + steps[this.doorStep]![1];
    }
    const d = ctx.spots.insideDoor;
    return { key: 'mgr:door', tile: d.tile, facing: 'down', pose: steps[this.doorStep]![0], away: true };
  }

  private deskGoal(ctx: ManagerCtx, t: number): Goal {
    const atDesk = ctx.me.arrived && ctx.me.goal?.key === `seat:${ctx.seat.id}`;
    if (!atDesk) {
      this.deskPose = 'sitIdle';
      this.deskUntil = t + randRange(ctx.rng, 3000, 6000);
    } else if (t >= this.deskUntil) {
      const r = ctx.rng();
      if (this.deskPose !== 'sitIdle' || r < 0.45) {
        this.deskPose = 'sitIdle';
        this.deskUntil = t + randRange(ctx.rng, 4000, 9000);
      } else if (r < 0.88) {
        this.deskPose = 'mugSip';
        this.deskUntil = t + 3200 * (ctx.rng() < 0.5 ? 1 : 2);
      } else {
        this.deskPose = 'chairSpin';
        this.deskUntil = t + 640 * (ctx.rng() < 0.5 ? 2 : 3);
      }
    }
    return { key: `seat:${ctx.seat.id}`, tile: ctx.seat.tile, facing: 'down', pose: this.deskPose, away: false };
  }
}
