/**
 * The food cart: one non-agent vendor who is normally off-stage. Every 15 to 25 minutes they push the snack trolley in
 * from the elevator to a parking spot in the bullpen aisle, call out what is on it now and then, and after 90 s push it
 * back out and leave. While it is parked the boss walks over for junk food (his trip lives in `ManagerBrain`), and an
 * idle agent choosing where to wander sometimes goes to stand by it for a bit (`agentVisit`).
 *
 * Modelled on `CleanerBrain`: a plain brain with its own seeded rng (so it never disturbs the office's rng) and an
 * injected clock (`t`, local ms, passed to every call). DOM-free. The vendor is not in `Office.chars`, so the roster,
 * the door queue, the boss's snoop, chats, coffee and seating never see them. The cart itself is not a character: the
 * scene draws it ahead of the vendor (`foodCartPlacement` in the art), so it follows them wherever they walk.
 */
import type { Char } from './characters.ts';
import { poolSources } from './theme.ts';
import type { LinesHook } from './theme.ts';
import type { Goal, NamedSpot, Spots } from './targets.ts';
import type { SpotDef, Tile } from './types.ts';
import { LiveDeck, makeRng, pick, randRange } from './types.ts';

/** The vendor's look id (the art's `VENDOR_LOOK`). */
export const VENDOR_LOOK_ID = 'vendor';
/** The vendor's character id. */
export const VENDOR_ID = '__vendor__';

/** Time from the start of one arrival to the start of the next (the first one counts from the start too). */
export const ARRIVE_MIN_MS = 15 * 60_000;
export const ARRIVE_MAX_MS = 25 * 60_000;
/** How long the cart stays parked. */
export const PARK_MS = 90_000;
/** A call on arrival at the parking spot, then the gap between calls while parked: two or three calls a visit, so a
 *  couple of hours of visits never deal the whole `CART_CALLS` deck. */
export const CALL_GAP_MIN_MS = 30_000;
export const CALL_GAP_MAX_MS = 45_000;
/** How long a call stays up. */
export const CALL_MS = 3_500;
/** The chance an idle agent that is choosing where to wander goes to the cart (while it is parked), and how long they stand there. */
export const AGENT_VISIT_CHANCE = 0.3;
export const AGENT_LINGER_MIN_MS = 4_500;
export const AGENT_LINGER_MAX_MS = 5_500;

/** Goal keys. */
export const PARK_KEY = 'cart:park';
export const LEAVE_KEY = 'cart:out';

// The parking spot is in the open pocket of the bullpen aisle (x 19 to 22, y 10 to 13) between the two desk groups on
// the left. The vendor stands at (19, 12) facing right with the cart ahead of them: it fills (20, 12) and spills about
// ten pixels into (21, 12); both are blocked for walkers while it is parked, and rows 10, 11 and 13 stay open around it
// (the layout test checks that nothing becomes unreachable). The boss stands at its far end, the agents on its far side.
/** Where the vendor stands while parked (facing the way the cart points). */
export const PARK_SPOT: SpotDef = { tile: { x: 19, y: 12 }, facing: 'right', pose: 'stand' };
/** The tiles the parked cart sits on. */
export const CART_TILES: readonly Tile[] = [{ x: 20, y: 12 }, { x: 21, y: 12 }];
/** Where the boss stands to pick his food: beside the cart's far end, facing it. */
export const BOSS_CART_SPOT: SpotDef = { tile: { x: 22, y: 12 }, facing: 'left', pose: 'stand' };
/** Where idle agents stand by the cart (reservable, one agent each), on its far side, facing it. */
export const AGENT_CART_SPOTS: readonly NamedSpot[] = [
  { key: 'cart:0', spot: { tile: { x: 20, y: 11 }, facing: 'down', pose: 'stand' } },
  { key: 'cart:1', spot: { tile: { x: 21, y: 11 }, facing: 'down', pose: 'stand' } },
];

/** True for the reservation keys of the agents' spots at the cart. */
export function isAgentCartKey(key: string | null | undefined): boolean {
  return key !== null && key !== undefined && AGENT_CART_SPOTS.some((s) => s.key === key);
}

export interface CartCtx {
  me: Char;
  spots: Spots;
  /** False: they call out nothing at all. */
  speechBubbles: boolean;
  /** The sources of their calls (the theme's, mixed with or replacing the built-in ones); without it they call the built-in lines. */
  lines?: LinesHook;
}

/** Their decision for this tick. */
export interface CartDecision {
  goal: Goal;
  /** A line to say now (only on the tick it starts). */
  say?: { text: string; ms: number };
}

export class CartBrain {
  private readonly rng: () => number;
  private readonly deck = new LiveDeck<string>();
  private in = false;
  private phase: 'in' | 'parked' | 'out' = 'in';
  /** When the next arrival starts (null: schedule on the next `decide`). */
  private arriveAt: number | null = null;
  /** Arrivals so far; the boss visits once per arrival. */
  private arrivals = 0;
  private leaveAt = Infinity;
  private nextCallAt = Infinity;

  private readonly enabled: boolean;

  /** `seed` (or a ready `rng`) makes their behaviour reproducible; `enabled` false keeps the cart away for good. */
  constructor(seed: number | (() => number) = 0xca47, enabled = true) {
    this.rng = typeof seed === 'function' ? seed : makeRng(seed);
    this.enabled = enabled;
  }

  /** True from when they step out of the elevator until they are back at it. */
  get onStage(): boolean {
    return this.in;
  }

  /** True while the cart stands at the parking spot (not while it is pushed in or out). */
  get parked(): boolean {
    return this.in && this.phase === 'parked';
  }

  /** The number of this arrival (1 for the first); 0 before any. */
  get arrival(): number {
    return this.arrivals;
  }

  /** Brings the next arrival forward to `t` (a no-op while they are in). */
  summon(t: number): void {
    if (!this.in) this.arriveAt = t;
  }

  /** Their decision for this tick, or null while they are off-stage. */
  decide(ctx: CartCtx, t: number): CartDecision | null {
    if (!this.enabled) return null;
    if (this.arriveAt === null) this.arriveAt = t + randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS);
    if (!this.in) {
      if (t < this.arriveAt) return null;
      this.in = true;
      this.phase = 'in';
      this.arrivals++;
      this.arriveAt = t + randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS);
    }
    const me = ctx.me;
    const park: Goal = { key: PARK_KEY, tile: PARK_SPOT.tile, facing: PARK_SPOT.facing, pose: PARK_SPOT.pose, away: true };
    if (this.phase === 'in') {
      if (!(me.arrived && me.goal?.key === PARK_KEY)) return { goal: park };
      this.phase = 'parked';
      this.leaveAt = t + PARK_MS;
      this.nextCallAt = t;
    }
    if (this.phase === 'parked') {
      if (t >= this.leaveAt) this.phase = 'out';
      else {
        let say: CartDecision['say'];
        if (t >= this.nextCallAt) {
          this.nextCallAt = t + randRange(this.rng, CALL_GAP_MIN_MS, CALL_GAP_MAX_MS);
          if (ctx.speechBubbles) say = { text: this.deck.next(this.rng, ...poolSources(ctx.lines, 'cartCalls')), ms: CALL_MS };
        }
        return { goal: park, ...(say ? { say } : {}) };
      }
    }
    if (me.arrived && me.goal?.key === LEAVE_KEY) {
      this.in = false;
      return null;
    }
    return { goal: { key: LEAVE_KEY, tile: ctx.spots.elevator.tile, facing: 'down', pose: 'stand', away: true } };
  }

  /**
   * An idle agent is choosing where to wander: while the cart is parked there is a `AGENT_VISIT_CHANCE` chance it goes to
   * one of the cart's agent spots that `isFree` accepts. Returns that spot's key, or null (then the usual choice is made).
   * Asking while the cart is away rolls no dice.
   */
  agentVisit(isFree: (key: string) => boolean): string | null {
    if (!this.parked || this.rng() >= AGENT_VISIT_CHANCE) return null;
    const free = AGENT_CART_SPOTS.filter((s) => isFree(s.key));
    return free.length > 0 ? pick(this.rng, free).key : null;
  }

  /** How long an agent stands at the cart before carrying on. */
  agentLingerMs(): number {
    return randRange(this.rng, AGENT_LINGER_MIN_MS, AGENT_LINGER_MAX_MS);
  }
}
