/**
 * The receptionist: always at the front desk, never walks. She types and reads, takes a phone call every two to four
 * minutes, greets each new main worker who steps out of the elevator (at most once every 8 s, never temps), and
 * looks up with "What can I change for you?" while the Front desk panel is open (calls pause meanwhile).
 *
 * Modelled on `ManagerBrain`: a plain brain with its own seeded rng (so it never disturbs the office's rng) and
 * an injected clock (`t`, local ms, passed to every call). DOM-free.
 */
import type { Char } from './characters.ts';
import type { Goal } from './targets.ts';
import type { Pose, SeatDef } from './types.ts';
import { LiveDeck, makeRng, randRange } from './types.ts';
import { poolSources } from './theme.ts';
import type { LinesHook } from './theme.ts';

/** Time between the starts of phone calls. */
export const CALL_GAP_MIN_MS = 120_000;
export const CALL_GAP_MAX_MS = 240_000;
/** How long a call lasts. */
export const CALL_MIN_MS = 6_000;
export const CALL_MAX_MS = 12_000;
/** At most one greeting in this time. */
export const GREET_GAP_MS = 8_000;
/** How long she looks up for a greeting. */
export const GREET_LOOK_MS = 2_600;
/** How long a line stays up. */
export const SAY_MS = 3_200;
/** Time between idle remarks. */
const IDLE_REMARK_MIN_MS = 120_000;
const IDLE_REMARK_MAX_MS = 240_000;

export interface ReceptionCtx {
  me: Char;
  seat: SeatDef;
  /** False: she says nothing at all. */
  speechBubbles: boolean;
  /** The sources of her lines per pool (the theme's, mixed with or replacing the built-in ones); without it she says the built-in lines. */
  lines?: LinesHook;
}

/** Her decision for this tick. */
export interface ReceptionDecision {
  goal: Goal;
  /** A line to say now (only on the tick it starts). */
  say?: { text: string; ms: number };
}

type Mode = 'work' | 'phone' | 'look';

export class ReceptionBrain {
  private readonly rng: () => number;
  private mode: Mode = 'work';
  private workPose: Pose = 'sitType';
  private workUntil = 0;
  private modeUntil = 0;
  private nextCallAt = Infinity;
  private nextRemarkAt = Infinity;
  private attending = false;
  private attendSay = false;
  private greetPending = false;
  private lastGreetAt = -Infinity;
  /** Held (by the IT crew's small talk) until this local time: she keeps sitting and says nothing. */
  private heldUntil = -Infinity;
  /** One deck each (built-in lines plus the theme's), so nothing repeats until all have been said. */
  private readonly greetDeck = new LiveDeck<string>();
  private readonly phoneDeck = new LiveDeck<string>();
  private readonly idleDeck = new LiveDeck<string>();
  private readonly attendDeck = new LiveDeck<string>();

  /** `seed` (or a ready `rng`) makes her behaviour reproducible. */
  constructor(seed: number | (() => number) = 0x7ece97) {
    this.rng = typeof seed === 'function' ? seed : makeRng(seed);
  }

  /** True while she is on a call (the desk shows the receiver off its cradle). */
  onPhone(): boolean {
    return this.mode === 'phone';
  }

  /** True while the Front desk is open and she is looking up at the user. */
  isAttending(): boolean {
    return this.attending;
  }

  /**
   * Someone is talking at her (the IT crew's small talk): until `until` (local ms) she keeps to her desk and says nothing,
   * and her calls, greetings and idle remarks wait for the hold to end (their timers are pushed back, not dropped). A call
   * already under way is not cut short, and the Front desk (`attending`) still wins. Holds only ever extend.
   */
  hold(until: number): void {
    if (until > this.heldUntil) this.heldUntil = until;
  }

  /**
   * The Front desk opened (`true`) or closed (`false`). Opening makes her look up and say "What can I change for
   * you?" once and cuts any call short; calls pause until it closes.
   */
  setAttending(on: boolean): void {
    if (on === this.attending) return;
    this.attending = on;
    if (on) {
      this.attendSay = true;
      this.greetPending = false;
      if (this.mode === 'phone') this.mode = 'work';
    } else {
      this.attendSay = false;
      this.mode = 'work';
      this.workUntil = 0;
      // A fresh gap after the panel closes, so a call does not ring the moment she sits back down.
      this.nextCallAt = Infinity;
    }
  }

  /**
   * A worker stepped out of the elevator at local time `t`. Main workers (not temps) get a greeting, but at most
   * one every `GREET_GAP_MS`; she is not interrupted on the phone or while the Front desk is open.
   */
  noteArrival(kind: 'main' | 'temp', t: number): void {
    if (kind !== 'main') return;
    if (this.attending || this.mode === 'phone') return;
    if (this.greetPending || t - this.lastGreetAt < GREET_GAP_MS) return;
    this.greetPending = true;
    // Reserve the slot now: the 8 s window runs from the arrival that earned the greeting.
    this.lastGreetAt = t;
  }

  decide(ctx: ReceptionCtx, t: number): ReceptionDecision {
    if (this.nextCallAt === Infinity && !this.attending) this.nextCallAt = t + randRange(this.rng, CALL_GAP_MIN_MS, CALL_GAP_MAX_MS);
    if (this.nextRemarkAt === Infinity) this.nextRemarkAt = t + randRange(this.rng, IDLE_REMARK_MIN_MS, IDLE_REMARK_MAX_MS);
    let say: ReceptionDecision['say'];

    if (this.attending) {
      if (this.mode !== 'look') { this.mode = 'look'; this.modeUntil = Infinity; }
      if (this.attendSay) {
        this.attendSay = false;
        if (ctx.speechBubbles) say = { text: this.line(ctx, this.attendDeck, 'receptionAttending'), ms: SAY_MS };
      }
      return { goal: this.goal(ctx, 'sitIdle', 'idle'), ...(say ? { say } : {}) };
    }
    if (this.mode === 'look' && t >= this.modeUntil) this.mode = 'work';

    if (this.mode === 'phone') {
      if (t < this.modeUntil) return { goal: this.goal(ctx, 'sitPhone', 'idle') };
      this.mode = 'work';
      this.workUntil = 0;
    }
    // Held for small talk: no calls, greetings or remarks until it ends (the timers wait, a pending greeting stays pending).
    if (t < this.heldUntil) {
      if (this.nextCallAt < this.heldUntil) this.nextCallAt = this.heldUntil;
      if (this.nextRemarkAt < this.heldUntil) this.nextRemarkAt = this.heldUntil;
      if (this.mode === 'look') return { goal: this.goal(ctx, 'sitIdle', 'idle') };
      this.advanceWork(t);
      return { goal: this.goal(ctx, this.workPose, this.workPose === 'sitRead' ? 'browser' : 'document') };
    }
    // A greeting pending from an arrival: look up and say hello (never while on the phone: that case drops it).
    if (this.greetPending) {
      this.greetPending = false;
      this.mode = 'look';
      this.modeUntil = t + GREET_LOOK_MS;
      if (ctx.speechBubbles) say = { text: this.line(ctx, this.greetDeck, 'receptionGreeting'), ms: SAY_MS };
      return { goal: this.goal(ctx, 'sitIdle', 'idle'), ...(say ? { say } : {}) };
    }
    if (this.mode === 'look') return { goal: this.goal(ctx, 'sitIdle', 'idle') };

    if (t >= this.nextCallAt) {
      this.mode = 'phone';
      this.modeUntil = t + randRange(this.rng, CALL_MIN_MS, CALL_MAX_MS);
      this.nextCallAt = t + randRange(this.rng, CALL_GAP_MIN_MS, CALL_GAP_MAX_MS);
      if (ctx.speechBubbles) say = { text: this.line(ctx, this.phoneDeck, 'receptionPhone'), ms: SAY_MS };
      return { goal: this.goal(ctx, 'sitPhone', 'idle'), ...(say ? { say } : {}) };
    }
    if (t >= this.nextRemarkAt) {
      this.nextRemarkAt = t + randRange(this.rng, IDLE_REMARK_MIN_MS, IDLE_REMARK_MAX_MS);
      if (ctx.speechBubbles) say = { text: this.line(ctx, this.idleDeck, 'receptionIdle'), ms: SAY_MS };
    }
    this.advanceWork(t);
    return { goal: this.goal(ctx, this.workPose, this.workPose === 'sitRead' ? 'browser' : 'document'), ...(say ? { say } : {}) };
  }

  private advanceWork(t: number): void {
    if (t < this.workUntil) return;
    const reading = this.workPose === 'sitType' ? this.rng() < 0.4 : this.rng() < 0.7;
    this.workPose = reading ? 'sitRead' : 'sitType';
    this.workUntil = t + (reading ? randRange(this.rng, 5_000, 10_000) : randRange(this.rng, 8_000, 16_000));
  }

  /** The next line of `deck` from the pool `key` (the built-in lines and the theme's, or only the theme's), each dealt once before any comes back. */
  private line(ctx: ReceptionCtx, deck: LiveDeck<string>, key: 'receptionPhone' | 'receptionGreeting' | 'receptionIdle' | 'receptionAttending'): string {
    return deck.next(this.rng, ...poolSources(ctx.lines, key));
  }

  private goal(ctx: ReceptionCtx, pose: Pose, screen: string): Goal {
    return { key: `seat:${ctx.seat.id}`, tile: ctx.seat.tile, facing: ctx.seat.facing, pose, away: false, screen };
  }
}
