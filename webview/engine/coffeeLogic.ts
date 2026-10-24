/**
 * Effort coffee, the decisions only (no DOM, no canvas): a working agent seated at its desk sips from its mug now and then,
 * and the higher its effort the more often and the faster it sips. The mug holds `MUG_SIPS` sips; sipping goes on at the
 * effort rate while the agent works even when the mug has run dry (`sips` just stays at 0 and means "needs a refill"), so
 * the effort stays visible. Only once the agent is idle does an empty mug send it to the coffee maker to refill (never
 * while working, so the shown activity stays accurate).
 * `office.ts` calls these every frame; all times are local ms.
 */
import type { EffortLevel } from '../../src/shared/protocol.ts';

// ---------------------------------------------------------------------------------------------------------------------
// 1. The numbers

/** Average gap between two sips of seated work, per effort level. */
export const SIP_EVERY_MS: Record<EffortLevel, number> = { low: 90_000, medium: 60_000, high: 35_000, xhigh: 20_000, max: 10_000 };
/** Sip animation speed multiplier, per effort level (1 = the normal pace). */
export const SIP_SPEED: Record<EffortLevel, number> = { low: 1, medium: 1.2, high: 1.4, xhigh: 1.6, max: 1.8 };
/** A full mug. */
export const MUG_SIPS = 6;
/** One full lift-sip-lower cycle at normal speed: the art's `poseCycleMs('deskSip')` (the engine cannot import the art; a test keeps the two equal). */
export const DESK_SIP_CYCLE_MS = 2_380;
/** Each gap is the average give or take this fraction, so the desks do not sip in step. */
export const SIP_JITTER = 0.25;

/** The effort shown when a session has none; the engine may pass a better default of its own. */
export function effortOrDefault(effort: EffortLevel | undefined): EffortLevel {
  return effort ?? 'medium';
}

/** The wait until the next sip: the level's average with up to +-25 % jitter. */
export function nextSipDelay(effort: EffortLevel, rng: () => number): number {
  return SIP_EVERY_MS[effort] * (1 + SIP_JITTER * (rng() * 2 - 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The mug

/** One agent's mug. `sips` is what is left (0 = empty: needs a refill once idle; working agents keep sipping); `sippingUntil` is when the current sip animation ends. */
export interface CoffeeState {
  sips: number;
  nextSipAt: number;
  sippingUntil: number;
}

/** A full mug, the first sip scheduled one jittered gap from `now`. */
export function newCoffee(now: number, effort: EffortLevel, rng: () => number): CoffeeState {
  return { sips: MUG_SIPS, nextSipAt: now + nextSipDelay(effort, rng), sippingUntil: -Infinity };
}

export interface CoffeeContext {
  effort: EffortLevel;
  /** Working AND seated at its desk right now. */
  seatedWorking: boolean;
  rng: () => number;
  /** Length of one sip animation at normal speed. */
  sipMs: number;
}

/**
 * One frame. A sip starts only while seated and working, with `nextSipAt` reached (an empty mug does not stop it): it takes one sip (`sips` stops at 0), runs for
 * `sipMs / SIP_SPEED[effort]` and schedules the next. While the agent is not seated-working the timer is held back: a due
 * `nextSipAt` is pushed to a fresh jittered gap from now, so it is never already due when work resumes: no instant sip and
 * no burst (the first sip after a break comes within one gap, not at once). A sip in progress is left to finish.
 */
export function stepCoffee(state: CoffeeState, now: number, ctx: CoffeeContext): { state: CoffeeState; startedSip: boolean } {
  if (!ctx.seatedWorking) {
    if (now < state.nextSipAt) return { state, startedSip: false };
    return { state: { ...state, nextSipAt: now + nextSipDelay(ctx.effort, ctx.rng) }, startedSip: false };
  }
  if (now < state.nextSipAt || now < state.sippingUntil) return { state, startedSip: false };
  return {
    state: { sips: Math.max(0, state.sips - 1), sippingUntil: now + ctx.sipMs / SIP_SPEED[ctx.effort], nextSipAt: now + nextSipDelay(ctx.effort, ctx.rng) },
    startedSip: true,
  };
}

/** Is the sip animation running at `now`? */
export function isSipping(state: CoffeeState, now: number): boolean {
  return now < state.sippingUntil;
}

/** Time to walk to the coffee maker: only when idle (not working) and the mug is empty. */
export function wantsRefill(state: CoffeeState, idle: boolean): boolean {
  return idle && state.sips <= 0;
}

/** A full mug again; the next sip is a jittered gap away. */
export function refill(_state: CoffeeState, now: number, effort: EffortLevel, rng: () => number): CoffeeState {
  return newCoffee(now, effort, rng);
}

/** Scales an animation clock so higher effort plays the sip faster. */
export function sipFrameElapsed(elapsedMs: number, effort: EffortLevel): number {
  return elapsedMs * SIP_SPEED[effort];
}
