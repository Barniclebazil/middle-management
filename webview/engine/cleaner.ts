/**
 * The cleaner: one non-agent character who is normally off-stage. They come in from the elevator a while after a
 * desk is vacated (an agent left, or moved or was bumped to another desk), and on a round every 10 to 15 minutes,
 * wipe the queued desks (or the kitchen counter, or the bin by the shredder), muttering to themselves, then go back
 * to the elevator and out of sight. A desk someone has sat down at again before they get there is skipped.
 *
 * Modelled on `ReceptionBrain`: a plain brain with its own seeded rng (so it never disturbs the office's rng) and an
 * injected clock (`t`, local ms, passed to every call). DOM-free. The cleaner is not in `Office.chars`, so the roster,
 * the door queue, the boss's snoop, chats, coffee and seating never see them.
 */
import type { Char } from './characters.ts';
import { charTile } from './characters.ts';
import { poolSources } from './theme.ts';
import type { LinesHook } from './theme.ts';
import type { Goal, Spots } from './targets.ts';
import type { SeatDef, Tile } from './types.ts';
import { LiveDeck, makeRng, pick, randRange } from './types.ts';

/** The cleaner's look id (the art's `CLEANER_LOOK`). */
export const CLEANER_LOOK_ID = 'cleaner';
/** The cleaner's character id. */
export const CLEANER_ID = '__cleaner__';

/** A vacated desk is cleaned: they come in this long after it was queued. */
export const ARRIVE_MIN_MS = 8_000;
export const ARRIVE_MAX_MS = 20_000;
/** Time between the starts of rounds. */
export const PATROL_MIN_MS = 10 * 60_000;
export const PATROL_MAX_MS = 15 * 60_000;
/** How long one wipe lasts. */
export const CLEAN_MIN_MS = 5_500;
export const CLEAN_MAX_MS = 6_500;
/** The first mutter after coming in, then the gap between mutters. */
export const MUTTER_FIRST_MIN_MS = 3_000;
export const MUTTER_FIRST_MAX_MS = 6_000;
export const MUTTER_GAP_MIN_MS = 12_000;
export const MUTTER_GAP_MAX_MS = 20_000;
/** How long a mutter stays up. */
export const MUTTER_MS = 3_500;
/** They wait this long for a taken tile before giving that job up. */
export const WAIT_MAX_MS = 12_000;

/** Goal keys. */
const WAIT_KEY = 'clean:wait';
const EXIT_KEY = 'clean:exit';
/** Spots they wipe besides desks: the kitchen counter (the tiles in front of it, tried in this order) and the bin (by the shredder). */
const COUNTER_KEYS: readonly string[] = ['idle:microwave', 'idle:coffee'];

type Job = { kind: 'desk'; seatId: string } | { kind: 'counter' } | { kind: 'bin' };

const jobKey = (j: Job): string => (j.kind === 'desk' ? `desk:${j.seatId}` : j.kind);

export interface CleanerCtx {
  me: Char;
  spots: Spots;
  /** The desks they look after (every agent desk: not the boss's or reception's). */
  seats: readonly SeatDef[];
  /** True when nobody has the seat, and nobody is still sitting at it. */
  seatEmpty(seat: SeatDef): boolean;
  /** True when nobody else stands on or is heading for `tile`, and `key` (a reservation) is not held by someone else. */
  free(tile: Tile, key?: string): boolean;
  /** False: they mutter nothing at all. */
  speechBubbles: boolean;
  /** The sources of their mutters (the theme's, mixed with or replacing the built-in ones); without it they mutter the built-in lines. */
  lines?: LinesHook;
}

/** Their decision for this tick. */
export interface CleanerDecision {
  goal: Goal;
  /** A line to say now (only on the tick it starts). */
  say?: { text: string; ms: number };
}

/** The job in hand: walking to its tile, then wiping until `until`. */
interface Current { job: Job; goal: Goal; phase: 'walk' | 'work'; until: number }

export class CleanerBrain {
  private readonly rng: () => number;
  private readonly deck = new LiveDeck<string>();
  private in = false;
  private queue: Job[] = [];
  private cur: Current | null = null;
  /** When they come in (null: nobody is waiting for them). */
  private arriveAt: number | null = null;
  private nextPatrolAt = Infinity;
  private nextMutterAt = Infinity;
  /** Since when every queued job has been blocked by someone standing there. */
  private waitSince: number | null = null;

  /** `seed` (or a ready `rng`) makes their behaviour reproducible. */
  constructor(seed: number | (() => number) = 0xc1ea4e) {
    this.rng = typeof seed === 'function' ? seed : makeRng(seed);
  }

  /** True from when they step out of the elevator until they are back at it. */
  get onStage(): boolean {
    return this.in;
  }

  /** A desk was vacated at local time `t`: queued (once), and they come in 8 to 20 s later if they are not in already. */
  noteDirty(seatId: string, t: number): void {
    if (this.add({ kind: 'desk', seatId })) this.scheduleArrival(t, randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS));
  }

  /** Starts a round at `t`: their patrol comes due now (a no-op while they are in). */
  summon(t: number): void {
    if (!this.in) this.nextPatrolAt = t;
  }

  /** Their decision for this tick, or null while they are off-stage. */
  decide(ctx: CleanerCtx, t: number): CleanerDecision | null {
    if (this.nextPatrolAt === Infinity) this.nextPatrolAt = t + randRange(this.rng, PATROL_MIN_MS, PATROL_MAX_MS);
    if (t >= this.nextPatrolAt) {
      this.nextPatrolAt = t + randRange(this.rng, PATROL_MIN_MS, PATROL_MAX_MS);
      let added = false;
      for (const j of this.patrolJobs(ctx)) added = this.add(j) || added;
      if (added) this.scheduleArrival(t, 0);
    }

    if (!this.in) {
      if (this.arriveAt === null || t < this.arriveAt) return null;
      this.arriveAt = null;
      this.prune(ctx);
      if (this.queue.length === 0) return null;
      this.in = true;
      this.waitSince = null;
      this.nextMutterAt = t + randRange(this.rng, MUTTER_FIRST_MIN_MS, MUTTER_FIRST_MAX_MS);
    }

    const goal = this.work(ctx, t);
    if (!goal) {
      this.in = false;
      this.cur = null;
      return null;
    }
    let say: CleanerDecision['say'];
    if (t >= this.nextMutterAt) {
      this.nextMutterAt = t + randRange(this.rng, MUTTER_GAP_MIN_MS, MUTTER_GAP_MAX_MS);
      if (ctx.speechBubbles) say = { text: this.deck.next(this.rng, ...poolSources(ctx.lines, 'cleanerMutters')), ms: MUTTER_MS };
    }
    return { goal, ...(say ? { say } : {}) };
  }

  /** The goal for this tick while on stage; null once they are back at the elevator with nothing left to do. */
  private work(ctx: CleanerCtx, t: number): Goal | null {
    const me = ctx.me;
    const cur = this.cur;
    if (cur) {
      if (cur.phase === 'walk') {
        if (cur.job.kind === 'desk' && !this.deskEmpty(ctx, cur.job)) this.cur = null;
        else if (me.arrived && me.goal?.key === cur.goal.key) {
          cur.phase = 'work';
          cur.until = t + randRange(this.rng, CLEAN_MIN_MS, CLEAN_MAX_MS);
        }
      } else if (t >= cur.until) {
        this.cur = null;
      }
    }
    if (this.cur) return this.cur.goal;

    this.prune(ctx);
    for (let i = 0; i < this.queue.length; i++) {
      const goal = this.resolve(ctx, this.queue[i]!);
      if (!goal) continue;
      this.cur = { job: this.queue.splice(i, 1)[0]!, goal, phase: 'walk', until: 0 };
      this.waitSince = null;
      return goal;
    }
    if (this.queue.length > 0) {
      // Everything left is blocked (someone is standing there): wait where they are, and give the first job up after a while.
      this.waitSince ??= t;
      if (t - this.waitSince >= WAIT_MAX_MS) {
        this.queue.shift();
        this.waitSince = null;
      }
      return { key: WAIT_KEY, tile: charTile(me), facing: me.dir, pose: 'stand', away: true };
    }
    if (me.arrived && me.goal?.key === EXIT_KEY) return null;
    return { key: EXIT_KEY, tile: ctx.spots.elevator.tile, facing: 'down', pose: 'stand', away: true };
  }

  /** The goal for a job, or null when its tile is taken for now. */
  private resolve(ctx: CleanerCtx, job: Job): Goal | null {
    if (job.kind === 'desk') {
      const seat = ctx.seats.find((s) => s.id === job.seatId);
      if (!seat || !ctx.free(seat.visit.tile)) return null;
      return { key: `clean:${seat.id}`, tile: seat.visit.tile, facing: seat.visit.facing, pose: 'wipe', away: true };
    }
    const spots = job.kind === 'counter'
      ? COUNTER_KEYS.flatMap((k) => ctx.spots.idle.filter((n) => n.key === k))
      : ctx.spots.shredder.slice(0, 1);
    for (const n of spots) {
      if (ctx.free(n.spot.tile, n.key)) {
        return { key: `clean:${job.kind}`, tile: n.spot.tile, facing: n.spot.facing, pose: 'wipe', away: true, reserve: n.key };
      }
    }
    return null;
  }

  private deskEmpty(ctx: CleanerCtx, job: { seatId: string }): boolean {
    const seat = ctx.seats.find((s) => s.id === job.seatId);
    return !!seat && ctx.seatEmpty(seat);
  }

  /** Drops desks that someone has sat down at again. */
  private prune(ctx: CleanerCtx): void {
    this.queue = this.queue.filter((j) => j.kind !== 'desk' || this.deskEmpty(ctx, j));
  }

  /** Queues a job unless it is already queued or in hand. True when it was new. */
  private add(job: Job): boolean {
    const k = jobKey(job);
    if (this.cur && jobKey(this.cur.job) === k) return false;
    if (this.queue.some((j) => jobKey(j) === k)) return false;
    this.queue.push(job);
    return true;
  }

  /** They come in `delay` ms from `t` (or sooner, if they are already due earlier); nothing when they are in. */
  private scheduleArrival(t: number, delay: number): void {
    if (this.in) return;
    this.arriveAt = this.arriveAt === null ? t + delay : Math.min(this.arriveAt, t + delay);
  }

  /** A round: one or two of the empty desks, the kitchen counter and the bin, picked at random. */
  private patrolJobs(ctx: CleanerCtx): Job[] {
    const jobs: Job[] = [];
    const empty = ctx.seats.filter((s) => ctx.seatEmpty(s));
    const n = this.rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const kinds: Job['kind'][] = empty.length > 0 ? ['desk', 'desk', 'counter', 'bin'] : ['counter', 'bin'];
      const kind = pick(this.rng, kinds);
      const job: Job = kind === 'desk' ? { kind, seatId: pick(this.rng, empty).id } : { kind };
      if (!jobs.some((j) => jobKey(j) === jobKey(job))) jobs.push(job);
    }
    return jobs;
  }
}
