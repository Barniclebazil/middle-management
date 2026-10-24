/**
 * The IT crew: two non-agent side characters, normally off-stage, who visit together every 4 to 6 minutes.
 *
 * - Dez (scruffy, lazy) does the "fixing": he stands at a worker's desk, asks if they have tried turning it off and on
 *   again, switches the monitor off, waits for it to boot, and declares it fixed.
 * - Fenwick (nerdy, anxious) stands behind the chair sneering at what the AI had on screen, and now and then reads
 *   football small talk off a crib card to whoever is idle nearby.
 *
 * Visit: off, then (on stage) walk to a desk, fix, optional small talk, leave, off again. The two are never split:
 * `decide` returns both steps or null. Modelled on `CleanerBrain`: a plain brain with its own seeded rng (so it never
 * disturbs the office's rng) and an injected clock (`t`, local ms, passed to every call). DOM-free. Neither of them
 * is in `Office.chars`, so the roster, the door queue, chats, coffee and seating never see them.
 */
import type { Char } from './characters.ts';
import { charTile } from './characters.ts';
import { findPath } from './path.ts';
import { pairSources, poolSources } from './theme.ts';
import type { LinesHook, PairsHook, StringPoolKey } from './theme.ts';
import type { Goal, Spots } from './targets.ts';
import type { Dir, Pose, SeatDef, Tile } from './types.ts';
import { LiveDeck, facingToward, makeRng, pairKey, pick, randRange } from './types.ts';

/** Dez's display name (single-sourced here for tooltips, and for theming later). */
export const IT_DEZ_NAME = 'Dez';
/** Fenwick's display name (single-sourced here for tooltips, and for theming later). */
export const IT_FENWICK_NAME = 'Fenwick';
/** Dez's character id. */
export const IT_DEZ_ID = '__it_dez__';
/** Fenwick's character id. */
export const IT_FENWICK_ID = '__it_fenwick__';
/** Dez's look id (the art's look). */
export const DEZ_LOOK_ID = 'dez';
/** Fenwick's look id (the art's look). */
export const FENWICK_LOOK_ID = 'fenwick';

/** The time between visits is drawn from this range (ms): at least this long. */
export const ARRIVE_MIN_MS = 4 * 60_000;
/** The time between visits: at most this long (ms). */
export const ARRIVE_MAX_MS = 6 * 60_000;
/** Fenwick waits at the elevator this long after Dez sets off. */
export const FENWICK_LAG_MS = 600;
/** If they have not both reached the desk after this long, the fix is given up silently. */
export const TO_DESK_GIVE_UP_MS = 30_000;
/** How long Dez's "turn it off and on again" line stays up. */
export const FIX_LINE_MS = 3000;
/** How long the monitor stays dark. */
export const OFF_MS = 1500;
/** How long the monitor boots (the art's `BOOT_MS`; a test keeps them equal). */
export const IT_BOOT_MS = 2000;
/** How long Dez's verdict stays up. */
export const VERDICT_MS = 3000;
/** How long Fenwick's sneer stays up. */
export const SNEER_MS = 3200;
/** How long the worker's comeback stays up. */
export const COMEBACK_MS = 2600;
/** The pause between one beat and the next. */
export const BEAT_GAP_MS = 250;
/** Chance the worker answers back after the sneer. */
export const COMEBACK_CHANCE = 0.5;
/** Chance of small talk after the fix. */
export const TALK_CHANCE = 0.6;
/** Chance the small talk is Fenwick's football chat (else Dez's). */
export const FOOTBALL_CHANCE = 0.4;
/** How long the speaker's opening line stays up. */
export const OPENER_MS = 3200;
/** How long the listener's puzzled reply stays up. */
export const REPLY_MS = 2600;
/** How long the speaker's follow-up stays up. */
export const FOLLOW_MS = 3200;
/** If the speaker has not reached the listener after this long, the small talk is dropped. */
export const TALK_REACH_MS = 25_000;
/** The first mutter comes this long after going on stage (min). */
export const MUTTER_FIRST_MIN_MS = 2000;
/** The first mutter comes this long after going on stage (max). */
export const MUTTER_FIRST_MAX_MS = 4000;
/** The gap between mutters (min). */
export const MUTTER_GAP_MIN_MS = 9000;
/** The gap between mutters (max). */
export const MUTTER_GAP_MAX_MS = 14_000;
/** How long a mutter stays up. */
export const MUTTER_MS = 3500;

/** The awkward silence after the follow-up, before they leave. */
const AWKWARD_MS = 1000;

const WAIT_KEY = 'it:wait';
const OUT_KEY = 'it:out';

/** A desk they could fix. */
export interface ItDesk {
  seat: SeatDef;
  /** The agent working there (null: nobody). */
  worker: string | null;
  state: 'needsYou' | 'working' | 'empty';
}

/** Someone who could be talked at. */
export interface ItListener {
  id: string;
  who: 'agent' | 'boss' | 'receptionist';
  tile: Tile;
  /**
   * Where to stand to talk to the boss or the receptionist, best first (side-on spots, then the seat's visit tile as a
   * last resort). The first usable one is taken. Without it (an idle agent) the speaker takes a free neighbouring tile,
   * left or right of them if possible.
   */
  stands?: readonly { tile: Tile; facing: Dir }[];
}

/** What the brain needs to know about the office this tick. */
export interface ItCtx {
  dez: Char;
  fenwick: Char;
  spots: Spots;
  /** False: they say nothing at all (the screen sequence still runs). */
  speechBubbles: boolean;
  /** The route grid (1 = walkable, index `y * w + x`), as the boss's snoop uses it. */
  grid: Uint8Array;
  w: number;
  h: number;
  /** Desks they could fix (the boss's and reception's, and any being snooped or visited, already left out). */
  desks(): readonly ItDesk[];
  /** People they could talk at (idle agents at idle spots, a free receptionist, a free boss). */
  listeners(): readonly ItListener[];
  /** True while the worker is still at that seat (the fix is still valid). */
  stillAt(workerId: string, seatId: string): boolean;
  /** True while the small-talk target is still free (ignoring the IT hold). */
  canListen(id: string): boolean;
  /** True when nobody else stands on or is heading for `tile` (Dez and Fenwick excluded), and `key` is not held by someone else. */
  free(tile: Tile, key?: string): boolean;
  /** The reservation key of a spot at that tile, if any. */
  spotAt(tile: Tile): string | undefined;
  /** The sources of their single-line pools (the theme's, mixed with or replacing the built-in ones); without it they say the built-in lines. */
  lines?: LinesHook;
  /** The same for the small-talk pairs pools (`itFixerTalk`, `itCriticTalk`). */
  pairs?: PairsHook;
}

/** One character's goal this tick, and what they start saying (only on the tick it starts). */
export interface ItStep {
  goal: Goal;
  say?: { text: string; ms: number };
}

/** The pair's decision for this tick. */
export interface ItDecision {
  dez: ItStep;
  fenwick: ItStep;
  /** A line for someone else (the worker or the listener) to say now; a one-tick event. */
  reply?: { id: string; text: string; ms: number };
}

/** The tile behind a seat (one up from it). */
export function behindTile(seat: SeatDef): Tile {
  return { x: seat.tile.x, y: seat.tile.y - 1 };
}

type Phase = 'off' | 'toDesk' | 'fix' | 'toTalk' | 'talk' | 'leave';
type FixEvKind = 'line' | 'verdict' | 'sneer' | 'comeback';

interface FixEv { at: number; kind: FixEvKind }

/** The fix in hand. */
interface Fix {
  seat: SeatDef;
  worker: string | null;
  dezGoal: Goal;
  /** Where Fenwick goes once his lag is over. */
  fenGoal: Goal;
  /** The beats, on absolute times (0 until both have arrived). */
  offAt: number;
  bootAt: number;
  clearAt: number;
  doneAt: number;
  events: FixEv[];
  next: number;
  /** Fenwick scoffs until then. */
  scoffUntil: number;
  /** Set when the worker left mid-fix: Dez's give-up line. */
  giveUp: { sayAt: number; said: boolean } | null;
}

/** The small talk in hand. */
interface Talk {
  listener: ItListener;
  speaker: 'dez' | 'fenwick';
  pair: readonly [string, string];
  speakPose: Pose;
  speakGoal: Goal;
  sideGoal: Goal;
  startedAt: number;
  /** Set once the speaker has arrived (the beats start then). */
  openAt: number | null;
  replyAt: number;
  followAt: number;
  followEnd: number;
  doneAt: number;
  /** The next beat: 0 opener, 1 reply, 2 follow-up, 3 none. */
  next: 0 | 1 | 2 | 3;
}

/** What a phase hands to `build`. */
interface StepOut {
  dezGoal: Goal;
  fenGoal: Goal;
  dezSay?: ItStep['say'];
  fenSay?: ItStep['say'];
  reply?: ItDecision['reply'];
  /** A mutter may be added this tick (they are only walking). */
  mutter: boolean;
}

const DIRS4: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
/** The tiles beside someone, to their left and right; talking side-on keeps them visible next to the bubble. */
const DIRS_SIDE: readonly (readonly [number, number])[] = [[1, 0], [-1, 0]];
/** The tiles above and below someone: the speaker would stand over them (or hide them), so only if nothing else is free. */
const DIRS_VERT: readonly (readonly [number, number])[] = [[0, -1], [0, 1]];

const same = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y;

export class ItCrewBrain {
  private readonly rng: () => number;
  /** One deck per pool, so no line comes back until the rest have been said. */
  private readonly fixLines = new LiveDeck<string>();
  private readonly verdicts = new LiveDeck<string>();
  private readonly giveUps = new LiveDeck<string>();
  private readonly sneers = new LiveDeck<string>();
  private readonly comebacks = new LiveDeck<string>();
  private readonly dezMutters = new LiveDeck<string>();
  private readonly fenMutters = new LiveDeck<string>();
  private readonly smallTalk = new LiveDeck<readonly [string, string]>((p) => pairKey([p[0], p[1]]));
  private readonly football = new LiveDeck<readonly [string, string]>((p) => pairKey([p[0], p[1]]));
  private readonly replies = new LiveDeck<string>();

  private phase: Phase = 'off';
  /** When the next visit starts (null: not scheduled yet). */
  private nextAt: number | null = null;
  private stageAt = 0;
  private fix: Fix | null = null;
  private talk: Talk | null = null;
  private scr: { deskId: string; mode: 'off' | 'boot'; since: number } | null = null;
  private hold: { id: string; face: Tile; talking: boolean } | null = null;
  private eng: string[] = [];
  /** No line (anyone's) starts before this. */
  private quietUntil = 0;
  private nextMutterAt = Infinity;
  private mutterDez = true;

  /** `seed` (or a ready `rng`) makes their behaviour reproducible. */
  constructor(seed: number | (() => number) = 0x17de5c) {
    this.rng = typeof seed === 'function' ? seed : makeRng(seed);
  }

  /** True from when they step out of the elevator until they are back at it. */
  get onStage(): boolean {
    return this.phase !== 'off';
  }

  /** The monitor being rebooted: whose desk, which mode and since when (null: nothing special). */
  get screen(): { deskId: string; mode: 'off' | 'boot'; since: number } | null {
    return this.scr;
  }

  /** The person held for small talk: `face` is the tile to face (the speaker's), `talking` while they say their reply. */
  get holding(): { id: string; face: Tile; talking: boolean } | null {
    return this.hold;
  }

  /** The ids of the people the pair is dealing with right now: the fix worker and the small-talk target. */
  get engaged(): readonly string[] {
    return this.eng;
  }

  /** The next visit is due now (a no-op while they are on stage). */
  summon(t: number): void {
    if (this.phase === 'off') this.nextAt = t;
  }

  /** Both their steps for this tick, or null while both are off-stage. */
  decide(ctx: ItCtx, t: number): ItDecision | null {
    if (this.phase === 'off') {
      this.nextAt ??= t + randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS);
      if (t < this.nextAt) return null;
      if (ctx.desks().length === 0 && ctx.listeners().length === 0) {
        this.nextAt = t + randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS);
        return null;
      }
      this.goOnStage(ctx, t);
    }
    // A phase that finishes hands over to the next one within the same tick.
    for (let guard = 0; guard < 8; guard++) {
      let out: StepOut | null;
      switch (this.phase) {
        case 'toDesk': out = this.walkToDesk(ctx, t); break;
        case 'fix': out = this.fixing(ctx, t); break;
        case 'toTalk':
        case 'talk': out = this.talking(ctx, t); break;
        case 'leave': out = this.leaving(ctx, t); break;
        default: return null;
      }
      if (out) return this.build(ctx, t, out);
    }
    return null;
  }

  // ---- phases ----

  private goOnStage(ctx: ItCtx, t: number): void {
    this.stageAt = t;
    this.quietUntil = 0;
    this.nextMutterAt = t + randRange(this.rng, MUTTER_FIRST_MIN_MS, MUTTER_FIRST_MAX_MS);
    this.fix = this.planFix(ctx);
    if (this.fix) {
      this.phase = 'toDesk';
      this.eng = this.fix.worker ? [this.fix.worker] : [];
    } else {
      // Nothing to fix: the small talk is the whole visit.
      this.afterFix(ctx, t, true);
    }
  }

  /** Dez walks to the desk at once; Fenwick waits at the elevator a moment, then follows. */
  private walkToDesk(ctx: ItCtx, t: number): StepOut | null {
    const fix = this.fix;
    if (!fix) { this.afterFix(ctx, t, false); return null; }
    // The worker has already gone: nothing to fix.
    if (fix.worker && !ctx.stillAt(fix.worker, fix.seat.id)) { this.afterFix(ctx, t, false); return null; }
    const lagging = t - this.stageAt < FENWICK_LAG_MS;
    const fenGoal = lagging ? this.plain(WAIT_KEY, ctx.spots.elevator.tile) : fix.fenGoal;
    const dezThere = ctx.dez.arrived && ctx.dez.goal?.key === fix.dezGoal.key;
    const fenThere = !lagging && ctx.fenwick.arrived && ctx.fenwick.goal?.key === fix.fenGoal.key;
    if (dezThere && fenThere) {
      this.beginBeats(ctx, t, fix);
      return null;
    }
    if (t - this.stageAt >= TO_DESK_GIVE_UP_MS) { this.afterFix(ctx, t, false); return null; }
    return { dezGoal: fix.dezGoal, fenGoal, mutter: true };
  }

  /** Both are at the desk: works out the beats, on absolute times from now. */
  private beginBeats(ctx: ItCtx, t: number, fix: Fix): void {
    const t0 = Math.max(t, this.quietUntil);
    fix.offAt = t0 + FIX_LINE_MS + BEAT_GAP_MS;
    fix.bootAt = fix.offAt + OFF_MS;
    fix.clearAt = fix.bootAt + IT_BOOT_MS;
    fix.events = [];
    if (ctx.speechBubbles) {
      const sneerAt = fix.clearAt + VERDICT_MS + BEAT_GAP_MS;
      fix.events.push({ at: t0, kind: 'line' }, { at: fix.clearAt, kind: 'verdict' }, { at: sneerAt, kind: 'sneer' });
      fix.doneAt = sneerAt + SNEER_MS + BEAT_GAP_MS;
      if (fix.worker && this.rng() < COMEBACK_CHANCE) {
        const at = sneerAt + SNEER_MS + BEAT_GAP_MS;
        fix.events.push({ at, kind: 'comeback' });
        fix.doneAt = at + COMEBACK_MS + BEAT_GAP_MS;
      }
    } else {
      fix.doneAt = fix.clearAt + BEAT_GAP_MS;
    }
    fix.next = 0;
    this.phase = 'fix';
  }

  private fixing(ctx: ItCtx, t: number): StepOut | null {
    const fix = this.fix!;
    const out: StepOut = { dezGoal: fix.dezGoal, fenGoal: fix.fenGoal, mutter: false };

    // The worker left before the verdict: the screen goes back to normal at once, Dez grumbles, and they move on.
    if (!fix.giveUp && fix.worker && t < fix.clearAt && !ctx.stillAt(fix.worker, fix.seat.id)) {
      this.scr = null;
      fix.events = [];
      fix.next = 0;
      const sayAt = Math.max(t, this.quietUntil);
      fix.giveUp = { sayAt, said: !ctx.speechBubbles };
      fix.doneAt = ctx.speechBubbles ? sayAt + VERDICT_MS + BEAT_GAP_MS : t;
    }
    if (fix.giveUp) {
      const g = fix.giveUp;
      if (!g.said && t >= g.sayAt) {
        g.said = true;
        out.dezSay = this.line(this.say(ctx, this.giveUps, 'itGiveUps'), VERDICT_MS, t);
      }
    } else {
      // The screen sequence runs on its own clock, even with speech bubbles off.
      if (t >= fix.clearAt) this.scr = null;
      else if (t >= fix.bootAt) this.scr = { deskId: fix.seat.deskId, mode: 'boot', since: fix.bootAt };
      else if (t >= fix.offAt) this.scr = { deskId: fix.seat.deskId, mode: 'off', since: fix.offAt };
      else this.scr = null;
      // The lines, in order; each waits for the one before to finish.
      const ev = fix.events[fix.next];
      if (ev && t >= ev.at && (ev.kind === 'comeback' || t >= this.quietUntil)) {
        fix.next++;
        if (ev.kind === 'line') out.dezSay = this.line(this.say(ctx, this.fixLines, 'itFix'), FIX_LINE_MS, t);
        else if (ev.kind === 'verdict') out.dezSay = this.line(this.say(ctx, this.verdicts, 'itVerdicts'), VERDICT_MS, t);
        else if (ev.kind === 'sneer') {
          out.fenSay = this.line(this.say(ctx, this.sneers, 'itSneers'), SNEER_MS, t);
          fix.scoffUntil = t + SNEER_MS;
        } else if (fix.worker && ctx.stillAt(fix.worker, fix.seat.id)) {
          out.reply = { id: fix.worker, text: this.say(ctx, this.comebacks, 'itComebacks'), ms: COMEBACK_MS };
        }
      }
    }
    if (t < fix.scoffUntil) out.fenGoal = { ...fix.fenGoal, pose: 'scoff' };

    if (fix.next >= fix.events.length && t >= fix.doneAt && (!fix.giveUp || fix.giveUp.said)) {
      this.afterFix(ctx, t, false);
      // This tick's lines still go out; the goals are the next phase's.
      const rest = this.phase === 'toTalk' ? this.talking(ctx, t) : this.phase === 'leave' ? this.leaving(ctx, t) : null;
      if (!rest) return out;
      return { ...rest, dezSay: out.dezSay, fenSay: out.fenSay, ...(out.reply ? { reply: out.reply } : {}) };
    }
    return out;
  }

  /** After the fix (or without one): small talk, if it is on; else leave. `force`: nothing else to do, so talk if anyone is about. */
  private afterFix(ctx: ItCtx, t: number, force: boolean): void {
    this.fix = null;
    this.scr = null;
    this.eng = [];
    this.talk = this.planTalk(ctx, t, force);
    if (this.talk) {
      this.phase = 'toTalk';
      this.hold = { id: this.talk.listener.id, face: this.talk.speakGoal.tile, talking: false };
      this.eng = [this.talk.listener.id];
    } else {
      this.phase = 'leave';
    }
  }

  private talking(ctx: ItCtx, t: number): StepOut | null {
    const talk = this.talk;
    if (!talk) { this.phase = 'leave'; return null; }
    // The listener has gone off, or the speaker cannot get there: drop it, silently, and leave.
    if (!ctx.canListen(talk.listener.id) || (talk.openAt === null && t - talk.startedAt >= TALK_REACH_MS)) {
      this.endTalk();
      return null;
    }
    const speaker = talk.speaker === 'dez' ? ctx.dez : ctx.fenwick;
    const mk = (pose: Pose, mutter: boolean): StepOut => {
      const g: Goal = { ...talk.speakGoal, pose };
      return talk.speaker === 'dez'
        ? { dezGoal: g, fenGoal: talk.sideGoal, mutter }
        : { dezGoal: talk.sideGoal, fenGoal: g, mutter };
    };
    if (talk.openAt === null) {
      if (!(speaker.arrived && speaker.goal?.key === talk.speakGoal.key)) return mk('stand', true);
      const a = Math.max(t, this.quietUntil);
      talk.openAt = a;
      talk.replyAt = a + OPENER_MS + BEAT_GAP_MS;
      talk.followAt = talk.replyAt + REPLY_MS + BEAT_GAP_MS;
      talk.followEnd = talk.followAt + FOLLOW_MS;
      talk.doneAt = talk.followEnd + AWKWARD_MS;
      this.phase = 'talk';
    }
    const o = mk(t >= talk.openAt && t < talk.followEnd ? talk.speakPose : 'stand', false);
    const speak = (text: string, ms: number): void => {
      const s = this.line(text, ms, t);
      if (talk.speaker === 'dez') o.dezSay = s; else o.fenSay = s;
    };
    if (ctx.speechBubbles) {
      if (talk.next === 0 && t >= talk.openAt && t >= this.quietUntil) {
        talk.next = 1;
        speak(talk.pair[0], OPENER_MS);
      } else if (talk.next === 1 && t >= talk.replyAt) {
        talk.next = 2;
        o.reply = { id: talk.listener.id, text: this.say(ctx, this.replies, 'itTalkReplies'), ms: REPLY_MS };
      } else if (talk.next === 2 && t >= talk.followAt && t >= this.quietUntil) {
        talk.next = 3;
        speak(talk.pair[1], FOLLOW_MS);
      }
    } else {
      // Speech bubbles turned off mid-talk: the lines are skipped.
      if (talk.next === 0 && t >= talk.openAt) talk.next = 1;
      if (talk.next === 1 && t >= talk.replyAt) talk.next = 2;
      if (talk.next === 2 && t >= talk.followAt) talk.next = 3;
    }
    if (this.hold) this.hold.talking = ctx.speechBubbles && t >= talk.replyAt && t < talk.replyAt + REPLY_MS;
    if (t >= talk.doneAt) {
      this.endTalk();
      const rest = this.leaving(ctx, t);
      return rest ? { ...rest, ...(o.dezSay ? { dezSay: o.dezSay } : {}), ...(o.fenSay ? { fenSay: o.fenSay } : {}), ...(o.reply ? { reply: o.reply } : {}) } : null;
    }
    return o;
  }

  /** The small talk is over, or dropped: let go of the listener and leave. */
  private endTalk(): void {
    this.talk = null;
    this.hold = null;
    this.eng = [];
    this.phase = 'leave';
  }

  /** Both go back to the elevator; once there, they are off-stage and the next visit is scheduled. */
  private leaving(ctx: ItCtx, t: number): StepOut | null {
    this.hold = null;
    this.eng = [];
    this.scr = null;
    const e = ctx.spots.elevator.tile;
    const gone = (c: Char): boolean => c.arrived && c.goal?.key === OUT_KEY;
    if (this.phase === 'leave' && gone(ctx.dez) && gone(ctx.fenwick)) {
      this.phase = 'off';
      this.fix = null;
      this.talk = null;
      this.nextMutterAt = Infinity;
      this.nextAt = t + randRange(this.rng, ARRIVE_MIN_MS, ARRIVE_MAX_MS);
      return null;
    }
    this.phase = 'leave';
    return { dezGoal: this.plain(OUT_KEY, e), fenGoal: this.plain(OUT_KEY, e), mutter: true };
  }

  // ---- planning ----

  /** Picks a desk: needsYou, then working, then empty; Dez's tile free, and Fenwick a place to stand. */
  private planFix(ctx: ItCtx): Fix | null {
    const desks = ctx.desks();
    const dezAt = charTile(ctx.dez);
    const fenAt = charTile(ctx.fenwick);
    for (const state of ['needsYou', 'working', 'empty'] as const) {
      const tier = desks.filter((d) => d.state === state);
      while (tier.length > 0) {
        const d = tier.splice(Math.floor(this.rng() * tier.length) % tier.length, 1)[0]!;
        const visit = d.seat.visit;
        if (!ctx.free(visit.tile, ctx.spotAt(visit.tile))) continue;
        if (!findPath(ctx.grid, ctx.w, ctx.h, dezAt, visit.tile)) continue;
        const fenGoal = this.watchGoal(ctx, d.seat, visit.tile, fenAt);
        if (!fenGoal) continue;
        return {
          seat: d.seat, worker: d.worker, dezGoal: this.goal(`it:fix:${d.seat.id}`, visit.tile, visit.facing, 'fixPc', ctx), fenGoal,
          offAt: 0, bootAt: 0, clearAt: 0, doneAt: 0, events: [], next: 0, scoffUntil: 0, giveUp: null,
        };
      }
    }
    return null;
  }

  /** Fenwick's place for a desk: behind the chair if he can stand and walk there, else beside Dez, facing the seat. */
  private watchGoal(ctx: ItCtx, seat: SeatDef, dezTile: Tile, from: Tile): Goal | null {
    const key = `it:watch:${seat.id}`;
    const back = behindTile(seat);
    if (!same(back, dezTile) && this.usable(ctx, back, from)) return this.goal(key, back, 'down', 'stand', ctx);
    const options = this.neighbours(ctx, dezTile, from, [seat.tile]);
    if (options.length === 0) return null;
    const tile = pick(this.rng, options);
    return this.goal(key, tile, facingToward(tile, seat.tile), 'stand', ctx);
  }

  /** Walkable, free (honouring a reservation) and reachable from `from`. */
  private usable(ctx: ItCtx, tile: Tile, from: Tile): boolean {
    if (tile.x < 0 || tile.y < 0 || tile.x >= ctx.w || tile.y >= ctx.h || ctx.grid[tile.y * ctx.w + tile.x] !== 1) return false;
    if (!ctx.free(tile, ctx.spotAt(tile))) return false;
    return findPath(ctx.grid, ctx.w, ctx.h, from, tile) !== null;
  }

  /** The usable neighbours of `of` along `dirs`, leaving out the tiles in `not`. */
  private neighbours(ctx: ItCtx, of: Tile, from: Tile, not: readonly Tile[], dirs: readonly (readonly [number, number])[] = DIRS4): Tile[] {
    const out: Tile[] = [];
    for (const [dx, dy] of dirs) {
      const n = { x: of.x + dx, y: of.y + dy };
      if (not.some((x) => same(x, n))) continue;
      if (this.usable(ctx, n, from)) out.push(n);
    }
    return out;
  }

  /** The small talk: a random listener, a speaker, where each stands. Null when it is not on. */
  private planTalk(ctx: ItCtx, t: number, force: boolean): Talk | null {
    if (!ctx.speechBubbles) return null;
    const pool = [...ctx.listeners()];
    if (pool.length === 0) return null;
    if (!force && this.rng() >= TALK_CHANCE) return null;
    const fenwickSpeaks = this.rng() < FOOTBALL_CHANCE;
    const speaker = fenwickSpeaks ? ctx.fenwick : ctx.dez;
    const sidekick = fenwickSpeaks ? ctx.dez : ctx.fenwick;
    while (pool.length > 0) {
      const l = pool.splice(Math.floor(this.rng() * pool.length) % pool.length, 1)[0]!;
      let tile: Tile | undefined;
      let facing: Dir | undefined;
      if (l.stands) {
        const at = l.stands.find((st) => this.usable(ctx, st.tile, charTile(speaker)));
        if (!at) continue;
        tile = at.tile;
        facing = at.facing;
      } else {
        // Side-on if at all possible (left or right of them), else above or below.
        let options = this.neighbours(ctx, l.tile, charTile(speaker), [l.tile], DIRS_SIDE);
        if (options.length === 0) options = this.neighbours(ctx, l.tile, charTile(speaker), [l.tile], DIRS_VERT);
        if (options.length === 0) continue;
        tile = pick(this.rng, options);
        facing = facingToward(tile, l.tile);
      }
      const sideTile = this.sidekickTile(ctx, tile, l.tile, charTile(sidekick));
      return {
        listener: l,
        speaker: fenwickSpeaks ? 'fenwick' : 'dez',
        pair: fenwickSpeaks
          ? this.football.next(this.rng, ...pairSources(ctx.pairs, 'itCriticTalk'))
          : this.smallTalk.next(this.rng, ...pairSources(ctx.pairs, 'itFixerTalk')),
        speakPose: fenwickSpeaks ? 'readCard' : facing === 'up' ? 'stand' : 'talk',
        speakGoal: this.goal(`it:talk:${l.id}`, tile, facing, 'stand', ctx),
        sideGoal: this.goal(`it:side:${l.id}`, sideTile, facingToward(sideTile, l.tile), 'stand', ctx),
        startedAt: t, openAt: null, replyAt: 0, followAt: 0, followEnd: 0, doneAt: 0, next: 0,
      };
    }
    return null;
  }

  /**
   * Where the sidekick stands: beside or behind the speaker, not between the speaker and the listener (so neither the
   * speaker nor the card is hidden). Behind first, then above, then below; the tile in front only as a last resort, and
   * where they already are if nothing is free.
   */
  private sidekickTile(ctx: ItCtx, speaker: Tile, listener: Tile, from: Tile): Tile {
    const dx = listener.x - speaker.x;
    const dy = listener.y - speaker.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sx = horizontal ? Math.sign(dx) : 0;
    const sy = horizontal ? 0 : Math.sign(dy);
    const at = (ox: number, oy: number): Tile => ({ x: speaker.x + ox, y: speaker.y + oy });
    const ranks: Tile[][] = horizontal
      ? [[at(-sx, 0)], [at(0, -1)], [at(0, 1)], [at(sx, 0)]]
      : [[at(0, -sy)], [at(-1, 0), at(1, 0)], [at(0, sy)]];
    for (const rank of ranks) {
      const options = rank.filter((n) => !same(n, listener) && !same(n, speaker) && this.usable(ctx, n, from));
      if (options.length > 0) return pick(this.rng, options);
    }
    return from;
  }

  // ---- helpers ----

  /** A goal on a tile, reserving the spot if the tile is one. */
  private goal(key: string, tile: Tile, facing: Dir, pose: Pose, ctx: ItCtx): Goal {
    const g: Goal = { key, tile, facing, pose, away: true };
    const r = ctx.spotAt(tile);
    if (r !== undefined) g.reserve = r;
    return g;
  }

  /** A goal at the elevator (no reservation). */
  private plain(key: string, tile: Tile): Goal {
    return { key, tile, facing: 'down', pose: 'stand', away: true };
  }

  /** The next line of `deck` from the pool `key` (the built-in lines and the theme's, or only the theme's). */
  private say(ctx: ItCtx, deck: LiveDeck<string>, key: StringPoolKey): string {
    return deck.next(this.rng, ...poolSources(ctx.lines, key));
  }

  /** A line that starts at `t`; nobody speaks again before it ends. */
  private line(text: string, ms: number, t: number): { text: string; ms: number } {
    this.quietUntil = t + ms;
    return { text, ms };
  }

  /** Puts the tick's pieces together, adding a mutter when the pair are only walking. */
  private build(ctx: ItCtx, t: number, o: StepOut): ItDecision {
    const dez: ItStep = { goal: o.dezGoal };
    const fenwick: ItStep = { goal: o.fenGoal };
    // A mutter that fell due during the scripted beats waits a while after them instead of firing the moment they end.
    if (!o.mutter) this.nextMutterAt = Math.max(this.nextMutterAt, t + MUTTER_GAP_MIN_MS);
    if (o.dezSay) dez.say = o.dezSay;
    if (o.fenSay) fenwick.say = o.fenSay;
    if (o.mutter && ctx.speechBubbles && !dez.say && !fenwick.say && t >= this.nextMutterAt && t >= this.quietUntil) {
      this.nextMutterAt = t + randRange(this.rng, MUTTER_GAP_MIN_MS, MUTTER_GAP_MAX_MS);
      if (this.mutterDez) dez.say = this.line(this.say(ctx, this.dezMutters, 'itFixerMutters'), MUTTER_MS, t);
      else fenwick.say = this.line(this.say(ctx, this.fenMutters, 'itCriticMutters'), MUTTER_MS, t);
      this.mutterDez = !this.mutterDez;
    }
    return { dez, fenwick, ...(o.reply ? { reply: o.reply } : {}) };
  }
}
