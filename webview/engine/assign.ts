/**
 * Who is who: hands out looks and seats. The two are independent: the look
 * says who someone is, the seat follows their model.
 *
 * Looks:
 * - Main agents, in order of `startedAt` (then id), get the staff slots in
 *   order. A theme can pin a slot to a project and/or session title
 *   (`setPins`): a main takes (1) a free slot whose pin matches it, else (2)
 *   the first free unpinned slot, else (3) the first free pinned slot, else
 *   (4) a temp look. Temps get temp looks round-robin.
 * - A look is stable for the life of an id and freed only by `release(id)`
 *   (called once the character has actually left the office), so a freed
 *   archetype is re-used only after its previous owner is gone.
 *
 * Seats (mains and temps alike):
 * - The desks come ranked best first (`deskRank.ts`) and split into three
 *   bands; a tier's home band is 0 for fable and opus, 1 for sonnet (and an
 *   unknown model), 2 for haiku.
 * - Placing someone: the best free desk in their home band; else bump a
 *   squatter there (someone whose home band is worse: the worst tier, then
 *   the latest to start, then the highest id) and place the bumped one by the
 *   same rules; else overflow to the nearest band with a free desk, worse
 *   bands first (taking a better band's worst free desk, or a worse band's
 *   best one); else no seat. Fable never bumps opus: both are at home in band 0.
 * - `assign` is called with everyone present every snapshot. Anyone outside
 *   their home band moves home as soon as it has a free desk or a squatter to
 *   bump; anyone already home stays put (no shuffling up within a band). A
 *   tier change that changes the home band re-places the agent.
 * - Ids not in the call (people walking out) keep their desk untouched until
 *   `release(id)`.
 * - The eviction override (`setEviction`) seats one agent in the boss's chair,
 *   freeing their desk; once cleared they are placed again by the rules above.
 */
import type { SeatDef } from './types.ts';
import { hasPin, pinMatches } from './theme.ts';
import type { SlotInfo } from './theme.ts';
import { tierRank } from './modelTier.ts';
import type { ModelTier } from './modelTier.ts';
import { BAND_COUNT, bandFor, bandsOf } from './deskRank.ts';

/** A look and a seat for one agent. `seat` is null when every desk is taken. */
export interface Assignment { look: string; seat: SeatDef | null }

/** The minimum an agent needs for assignment. */
export interface AssignInput { id: string; kind: 'main' | 'temp'; startedAt: number; tier: ModelTier | null; project?: string; title?: string }

/** What one `assign` call changed: ids newly assigned, and known ids whose seat changed (bumped, moved home, evicted...). */
export interface AssignResult { fresh: string[]; moved: string[] }

/** Internal record: the assignment plus what seating needs to know. */
interface Entry extends Assignment { id: string; startedAt: number; tier: ModelTier | null; home: number }

/** A bump chain is at most one link per band; this is a safety net, not a limit that is ever reached. */
const MAX_BUMP_DEPTH = BAND_COUNT + 2;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Seating order: best tier first, then earliest start, then id. */
const seatOrder = (a: { tier: ModelTier | null; startedAt: number; id: string }, b: typeof a): number =>
  (tierRank(a.tier) - tierRank(b.tier)) || (a.startedAt - b.startedAt) || byId(a.id, b.id);

export class Assigner {
  private readonly byId = new Map<string, Entry>();
  private tempCursor = 0;
  private readonly archetypes: readonly string[];
  private readonly tempLooks: readonly string[];
  private readonly bands: readonly (readonly SeatDef[])[];
  private readonly bandOfSeat = new Map<string, number>();
  private readonly managerSeat: SeatDef | null;
  private pins = new Map<string, SlotInfo['pin']>();
  /** Who should be in the boss's chair, and who actually is (applied on the next `assign`). */
  private eviction: string | null = null;
  private evictHolder: string | null = null;
  /** Ids in the current `assign` call (only these are ever moved or bumped). */
  private present = new Set<string>();

  /** `desks` are the candidate desks ranked best first (`rankDesks`); `managerSeat` is used by the eviction override. */
  constructor(archetypes: readonly string[], tempLooks: readonly string[], desks: readonly SeatDef[], managerSeat: SeatDef | null = null) {
    this.archetypes = archetypes;
    this.tempLooks = tempLooks;
    this.bands = bandsOf(desks);
    this.bands.forEach((band, i) => { for (const s of band) this.bandOfSeat.set(s.id, i); });
    this.managerSeat = managerSeat;
  }

  /** Sets which slots are pinned (slot id -> pin). Only affects agents assigned from now on. */
  setPins(pins: ReadonlyMap<string, SlotInfo['pin']>): void {
    this.pins = new Map(pins);
  }

  /**
   * Puts an agent in the boss's chair (null: nobody). Takes effect on the next `assign`: the new holder's
   * desk is freed, and a previous holder is placed again by the normal rules; both are reported as moved.
   */
  setEviction(id: string | null): void {
    this.eviction = id;
  }

  /** The current assignment for an id, if any. */
  get(id: string): Assignment | undefined {
    const e = this.byId.get(id);
    return e ? { look: e.look, seat: e.seat } : undefined;
  }

  /** Ids that currently hold an assignment. */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * Called with every present agent (new and known) each snapshot. Gives new agents a look (new mains in
   * `startedAt` order before new temps, so the first message hands out archetypes in session order), notes
   * tier changes, applies the eviction override, seats whoever needs a seat (best tier first) and moves
   * overflowed agents home where they now fit.
   */
  assign(agents: readonly AssignInput[]): AssignResult {
    this.present = new Set(agents.map((a) => a.id));
    const before = new Map<string, string | null>();
    for (const e of this.byId.values()) before.set(e.id, e.seat?.id ?? null);

    // (a) Looks for newcomers.
    const fresh = agents.filter((a, i) => !this.byId.has(a.id) && agents.findIndex((b) => b.id === a.id) === i);
    const order = (a: AssignInput, b: AssignInput): number => (a.startedAt - b.startedAt) || byId(a.id, b.id);
    const newMains = fresh.filter((a) => a.kind === 'main').sort(order);
    const newTemps = fresh.filter((a) => a.kind !== 'main').sort(order);
    for (const a of newMains) this.add(a, this.pickSlot(a) ?? this.nextTempLook());
    for (const a of newTemps) this.add(a, this.nextTempLook());

    // (b) Tier changes: a new home band re-places the agent unless it already sits there.
    for (const a of agents) {
      const e = this.byId.get(a.id)!;
      e.startedAt = a.startedAt;
      if (e.tier === a.tier) continue;
      e.tier = a.tier;
      const home = bandFor(a.tier);
      if (home === e.home) continue;
      e.home = home;
      if (e.id !== this.evictHolder && e.seat && this.bandOf(e.seat) !== home) e.seat = null;
    }

    // Eviction override: the previous holder leaves the boss's chair, the new one takes it (present ids only).
    const want = this.eviction !== null && this.present.has(this.eviction) ? this.eviction : null;
    if (this.evictHolder !== want) {
      const prev = this.evictHolder !== null ? this.byId.get(this.evictHolder) : undefined;
      if (prev && this.present.has(prev.id)) prev.seat = null;
      this.evictHolder = null;
      if (want !== null) {
        this.byId.get(want)!.seat = this.managerSeat;
        this.evictHolder = want;
      }
    }

    // (c) Seat everyone present without a seat, best tier first.
    const unseated = [...this.byId.values()].filter((e) => this.present.has(e.id) && e.id !== this.evictHolder && e.seat === null);
    for (const e of unseated.sort(seatOrder)) if (e.seat === null) this.place(e, 0);

    // (d) Rebalance: whoever sits outside their home band moves home if it has a free desk or a squatter.
    // Bumped agents may land outside their home too, so repeat (each pass only ever moves people home).
    for (let pass = 0; pass < MAX_BUMP_DEPTH; pass++) {
      const away = [...this.byId.values()].filter((e) => this.isAway(e)).sort(seatOrder);
      let changed = false;
      for (const e of away) {
        if (!this.isAway(e)) continue;
        const seat = this.homeSeat(e, 0);
        if (seat) { e.seat = seat; changed = true; }
      }
      if (!changed) break;
    }

    const moved: string[] = [];
    for (const [id, was] of before) {
      const e = this.byId.get(id);
      if (e && (e.seat?.id ?? null) !== was) moved.push(id);
    }
    return { fresh: fresh.map((a) => a.id), moved };
  }

  /** Frees an id's look and seat. */
  release(id: string): void {
    this.byId.delete(id);
    if (this.evictHolder === id) this.evictHolder = null;
  }

  private add(a: AssignInput, look: string): void {
    this.byId.set(a.id, { id: a.id, look, seat: null, startedAt: a.startedAt, tier: a.tier, home: bandFor(a.tier) });
  }

  /** Band index of a desk (undefined for the boss's chair or a desk not in the ranking). */
  private bandOf(seat: SeatDef): number | undefined {
    return this.bandOfSeat.get(seat.id);
  }

  /** Present, seated at a ranked desk, but not in their home band. */
  private isAway(e: Entry): boolean {
    if (!this.present.has(e.id) || e.id === this.evictHolder || !e.seat) return false;
    const band = this.bandOf(e.seat);
    return band !== undefined && band !== e.home;
  }

  /** Seats an agent (whose seat is null) by the rules: home band, else bump, else overflow, else no seat. */
  private place(e: Entry, depth: number): void {
    e.seat = this.homeSeat(e, depth) ?? this.overflowSeat(e.home);
  }

  /**
   * A desk in the agent's home band: the best free one, else the desk of the worst squatter there (whose
   * home band is worse), who is then placed again. Null when neither exists.
   */
  private homeSeat(e: Entry, depth: number): SeatDef | null {
    const band = this.bands[e.home] ?? [];
    const free = band.find((s) => !this.seatTaken(s.id));
    if (free) return free;
    if (depth >= MAX_BUMP_DEPTH) return null;
    const squatters = [...this.byId.values()].filter((o) =>
      o !== e && this.present.has(o.id) && o.id !== this.evictHolder && o.seat && this.bandOf(o.seat) === e.home && o.home > e.home);
    if (squatters.length === 0) return null;
    // Worst first: lowest tier, then latest start, then highest id.
    squatters.sort((a, b) => -seatOrder(a, b));
    const victim = squatters[0]!;
    const seat = victim.seat!;
    victim.seat = null;
    // The bumper takes the desk before the bumped one is placed, so it can't be handed straight back.
    e.seat = seat;
    this.place(victim, depth + 1);
    return seat;
  }

  /** The nearest band with a free desk, worse bands first: a better band's worst free desk, a worse band's best. */
  private overflowSeat(home: number): SeatDef | null {
    const order: number[] = [];
    for (let b = home + 1; b < BAND_COUNT; b++) order.push(b);
    for (let b = home - 1; b >= 0; b--) order.push(b);
    for (const b of order) {
      const free = (this.bands[b] ?? []).filter((s) => !this.seatTaken(s.id));
      if (free.length === 0) continue;
      return b < home ? free[free.length - 1]! : free[0]!;
    }
    return null;
  }

  /** The slot for a main: a free slot pinned to a match, else the first free unpinned one, else the first free pinned one. */
  private pickSlot(a: AssignInput): string | undefined {
    const free = this.archetypes.filter((look) => !this.lookTaken(look));
    return free.find((look) => pinMatches(this.pins.get(look), a))
      ?? free.find((look) => !hasPin(this.pins.get(look)))
      ?? free[0];
  }

  private lookTaken(look: string): boolean {
    for (const a of this.byId.values()) if (a.look === look) return true;
    return false;
  }

  private seatTaken(seatId: string): boolean {
    for (const a of this.byId.values()) if (a.seat?.id === seatId) return true;
    return false;
  }

  private nextTempLook(): string {
    const n = this.tempLooks.length;
    if (n === 0) return 'temp0';
    const look = this.tempLooks[this.tempCursor % n]!;
    this.tempCursor++;
    return look;
  }
}
