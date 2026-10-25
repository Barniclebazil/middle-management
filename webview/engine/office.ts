/**
 * The office simulation: turns agent snapshots into characters that walk to
 * the right places and strike the right poses. DOM-free, so it can be tested
 * with plain Node; `scene.ts` draws it.
 *
 * Two clocks:
 * - `t`: local monotonic ms (animation, walking, timers);
 * - `hostNow`: epoch ms on the host's clock, compared with snapshot times
 *   (`since`, `lastPromptAt`).
 */
import { Assigner } from './assign.ts';
import type { AssignInput } from './assign.ts';
import { bandsOf, rankDesks } from './deskRank.ts';
import type { Char } from './characters.ts';
import { charTile, isSeated, newChar, placeAtGoal, routeTo, stepChar } from './characters.ts';
import type { RouteMap } from './characters.ts';
import { CLEANER_ID, CLEANER_LOOK_ID, CleanerBrain } from './cleaner.ts';
import type { CleanerCtx } from './cleaner.ts';
import { DEZ_LOOK_ID, FENWICK_LOOK_ID, IT_DEZ_ID, IT_FENWICK_ID, ItCrewBrain } from './itCrew.ts';
import type { ItCtx, ItDesk, ItListener } from './itCrew.ts';
import { AGENT_CART_SPOTS, BOSS_CART_SPOT, CART_TILES, CartBrain, VENDOR_ID, VENDOR_LOOK_ID, isAgentCartKey } from './foodCart.ts';
import type { CartCtx } from './foodCart.ts';
import { DESK_SIP_CYCLE_MS, SIP_SPEED, effortOrDefault, isSipping, newCoffee, refill, stepCoffee, wantsRefill } from './coffeeLogic.ts';
import { ManagerBrain, VISIT_TALK_MS } from './manager.ts';
import { TIERS, tierOf, tierRank } from './modelTier.ts';
import type { ModelTier } from './modelTier.ts';
import { ReceptionBrain } from './reception.ts';
import type { ReceptionCtx } from './reception.ts';
import type { ManagerCtx, VisitTarget } from './manager.ts';
import { blockTiles } from './path.ts';
import { lineSources, slotInfoOf, smallTalkSources } from './theme.ts';
import type { LinesHook, PairsHook, SlotInfo, ThemeState } from './theme.ts';
import {
  COMMIT_MS, Reservations, buildSpots, chooseWanderSpot, desiredGoal, seatGoal, isWandering, normalizeAgent, queueOrder, wantsQueue,
} from './targets.ts';
import type { AgentView, Goal, Spots } from './targets.ts';
import type { EffortLevel } from '../../src/shared/protocol.ts';
import type { Dir, SeatDef, SpotDef, Tile, WorldDef } from './types.ts';
import { LiveDeck, SEATED_POSES, facingToward, makeRng, pairKey, randRange, tileFeet } from './types.ts';

/** How long a new detail shows as a text bubble. */
export const DETAIL_BUBBLE_MS = 4_000;
/** A new session whose prompt is at most this old gets a welcome visit. */
const NEW_PROMPT_VISIT_MS = 30_000;
/** A command or edit approval earns a joke visit at most this often per agent (plans always do). */
export const APPROVAL_JOKE_COOLDOWN_MS = 3 * 60_000;
/** Idle lingering at a spot. */
const LINGER_MIN_MS = 8_000;
const LINGER_MAX_MS = 20_000;
/** Water-cooler chats. */
const CHAT_MIN_MS = 25_000;
const CHAT_MAX_MS = 45_000;
const CHAT_LINE_MS = 2_600;
const CHAT_GAP_MS = 1_800;
/** A person says one of their own (themed) lines at most this often; the rest of the time the pair comes from the deck. */
export const OWN_LINE_GAP_MS = 40 * 60_000;
/** How long a Fable spell keeps the boss out of his office. */
export const EVICTION_MS = 5 * 60_000;
/** The coffee maker's spot key, and how long a thirsty agent stands there before the mug is full again. */
const COFFEE_KEY = 'idle:coffee';
export const REFILL_PAUSE_MS = 4_000;
/** Poses of an agent doing seated work (the others at the desk are idle ones). */
const WORK_POSES: ReadonlySet<string> = new Set(['sitType', 'sitRead', 'sitThink', 'sitRun']);
/** How long a worker's remark about changing desks shows. */
const MOVE_SAY_MS = 3_000;
/** The chance a worker moving to a better desk says so (bumped workers always grumble). */
const MOVE_UP_SAY_CHANCE = 0.5;

interface ChatState {
  ids: [string, string];
  endsAt: number;
  nextLineAt: number;
  opener: 0 | 1;
  lines: [0 | 1, string][];
}

/** Order-free id of two people, for "who chatted last". */
function pairId(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** What a desk monitor should show. */
export interface DeskScreenState {
  /** 'off' (no owner), 'idle' (owner away or idle), or 'activity'. */
  mode: 'off' | 'idle' | 'activity' | 'kind';
  /** For mode 'activity': the activity to map to a screen. For 'kind': the screen kind. */
  value?: string;
  /** For mode 'kind': when (local ms) this screen began, so the scene can run its animation (the boot bar) from 0. */
  since?: number;
}

export interface OfficeOptions {
  seed?: number;
  /** How long a Fable spell lasts in ms (default `EVICTION_MS`; the dev harness shortens it). */
  evictionMs?: number;
  /** False keeps the food cart away for good (tests of other timers that run longer than its first arrival). Default true. */
  foodCart?: boolean;
  /** False keeps the IT crew (Dez and Fenwick) away for good, even when summoned. Default true. */
  itCrew?: boolean;
}

/** A Fable spell: one Fable agent has the boss's office until `until` (local ms). */
interface Spell { id: string; until: number }

export class Office {
  readonly world: WorldDef;
  readonly spots: Spots;
  readonly res = new Reservations();
  readonly assigner: Assigner;
  /** Agent characters by id (the manager and the receptionist are separate: the roster never sees them). */
  readonly chars = new Map<string, Char>();
  readonly manager: Char;
  readonly brain: ManagerBrain;
  readonly managerSeat: SeatDef;
  /** The permanent receptionist at the front desk (`agent` is null; she is not in `chars`). */
  readonly receptionist: Char;
  readonly reception: ReceptionBrain;
  readonly receptionSeat: SeatDef;
  /** The one cleaner (`agent` is null; not in `chars`): only part of the office (`allChars`) while `cleanerOnStage`. */
  readonly cleaner: Char;
  private readonly cleanerBrain: CleanerBrain;
  /** Every desk the cleaner looks after: all but the boss's and reception's. */
  private readonly cleanSeats: readonly SeatDef[];
  private cleanerIn = false;
  /** The food cart's vendor (`agent` is null; not in `chars`): only part of the office (`allChars`) while `vendorOnStage`. The cart is drawn by the scene, ahead of them. */
  readonly vendor: Char;
  private readonly cartBrain: CartBrain;
  private vendorIn = false;
  /** The IT crew (`agent` is null; neither is in `chars`): part of the office (`allChars`) only while `itCrewOnStage`. */
  readonly dez: Char;
  readonly fenwick: Char;
  private readonly itBrain: ItCrewBrain;
  private readonly itEnabled: boolean;
  private itIn = false;
  /** True while the parked cart's tiles are blocked in the route map. */
  private cartBlocked = false;
  readonly routeMap: RouteMap;
  /** Settings that change behaviour. */
  bossQuotes = true;
  /** False silences the receptionist (and, in `collectBubbles`, every bubble). */
  speechBubbles = true;
  /** Names, roles, lines and pins from the theme file (undefined: built-in defaults). */
  theme: ThemeState | undefined = undefined;
  /** How long a Fable spell lasts (ms); a change applies to the next spell. */
  evictionMs: number;
  private rng: () => number;
  /** Effort coffee has its own rng too (so sips never shift the office's random sequence). */
  private readonly coffeeRng: () => number;
  /** The effort a session on a model gets when it reports none (the Claude defaults; set by the view). */
  defaultEffort: ((model: string | undefined) => EffortLevel | undefined) | null = null;
  /** The running Fable spell, if any. */
  private spell: Spell | null = null;
  /** Fable agents that had a spell, or arrived during one: none of them gets one (again). */
  private readonly spellSeen = new Set<string>();
  /** The last snapshot's assignment inputs, to re-assign from a tick when a spell runs out. */
  private lastInputs: AssignInput[] = [];
  /** Desk band (0 best) by seat id, to tell a bump from a move up. */
  private readonly bandOfSeat = new Map<string, number>();
  /** The sulk spot's reservation key (shared with the kitchen-table seat on that tile), and a place to stand if it is taken. */
  private readonly sulkReserve: string;
  private readonly sulkFallback: SpotDef;
  private seenSnapshot = false;
  private readonly lastPrompt = new Map<string, number>();
  /** The newest approval seen per agent, and when each last earned a command or edit joke (office time). */
  private readonly lastApproval = new Map<string, number>();
  private readonly lastApprovalJoke = new Map<string, number>();
  private chat: ChatState | null = null;
  private chatCooldownUntil = 0;
  /** Who chatted last (sorted, joined), so the next chat prefers another pair. */
  private lastChatPair = '';
  /** Decks for what people say: dealt from, so a line comes back only after all the others have been said. */
  private readonly coolerDeck = new LiveDeck<readonly [string, string]>(pairKey);
  private readonly replyDeck = new LiveDeck<string>();
  private readonly bumpDeck = new LiveDeck<string>();
  private readonly moveUpDeck = new LiveDeck<string>();
  /** A person's own lines, by look (their staff slot, so it follows the person, not the agent). */
  private readonly ownDecks = new Map<string, LiveDeck<string>>();
  /** When (local ms) each person last opened a chat with one of their own lines, by look. */
  private readonly ownLineAt = new Map<string, number>();
  private queue: string[] = [];
  private hostNow = 0;

  constructor(world: WorldDef, opts: OfficeOptions = {}) {
    this.world = world;
    const seed = opts.seed ?? 0x0ff1ce;
    this.rng = makeRng(seed);
    this.coffeeRng = makeRng((seed ^ 0xc0ffee) >>> 0);
    this.brain = new ManagerBrain(makeRng((seed ^ 0x5a00b) >>> 0), makeRng((seed ^ 0xca47b) >>> 0));
    this.evictionMs = opts.evictionMs ?? EVICTION_MS;
    this.spots = buildSpots(world);
    const mgrSeat = world.seats.find((s) => s.owner === 'manager');
    if (!mgrSeat) throw new Error('map has no manager seat');
    this.managerSeat = mgrSeat;
    const recSeat = world.seats.find((s) => s.owner === 'reception');
    if (!recSeat) throw new Error('map has no reception seat');
    this.receptionSeat = recSeat;
    // Her own rng, so she never disturbs the office's (and so she is reproducible for a seed).
    this.reception = new ReceptionBrain(makeRng((seed ^ 0x7ece97) >>> 0));
    // The cleaner's too (rng, mutter deck and all), so their comings and goings never shift the office's sequences.
    this.cleanerBrain = new CleanerBrain(makeRng((seed ^ 0xc1ea4e) >>> 0));
    // The vendor's too: arrivals, calls and which idle agents come over all use it, never the office's rng.
    this.cartBrain = new CartBrain(makeRng((seed ^ 0xca47d0) >>> 0), opts.foodCart !== false);
    // The IT crew's too (their visits, desks, small talk and lines), so none of it shifts the office's sequences.
    this.itBrain = new ItCrewBrain(makeRng((seed ^ 0x17de5c) >>> 0));
    this.itEnabled = opts.itCrew !== false;
    // People walk around desks, not over other people's chairs: block every seat
    // tile (and the kitchen-table seats); start and goal tiles are always allowed.
    const blocked = [...world.seats.map((s) => s.tile), ...world.poi.kitchenTable.map((s) => s.tile)];
    this.routeMap = { grid: blockTiles(world.grid, world.w, blocked), w: world.w, h: world.h, tile: world.tile };
    // Looks are handed out by slot (`staff-i`, then temp looks); seats by model, from every desk but the boss's
    // and reception, ranked by the walk from just outside the boss's door (`deskRank.ts`).
    const desks = world.seats.filter((s) => s.owner !== 'manager' && s.owner !== 'reception');
    this.cleanSeats = desks;
    const doorStep = world.poi.managerDoorQueue[0]?.tile ?? world.poi.managerDoor;
    const ranked = rankDesks(desks, this.routeMap, doorStep);
    this.assigner = new Assigner(world.staffSlots, world.tempSlots, ranked, mgrSeat);
    bandsOf(ranked).forEach((band, i) => { for (const s of band) this.bandOfSeat.set(s.id, i); });
    const sulk = world.poi.sulk;
    const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => a.x === b.x && a.y === b.y;
    this.sulkReserve = this.spots.idle.find((n) => same(n.spot.tile, sulk.tile))?.key ?? 'mgr:sulk';
    // Someone already sitting there: he stands next to it (first free floor tile beside it), facing the room.
    const rm = this.routeMap;
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: sulk.tile.x + dx!, y: sulk.tile.y + dy! }))
      .find((p) => p.x >= 0 && p.y >= 0 && p.x < rm.w && p.y < rm.h && rm.grid[p.y * rm.w + p.x] === 1);
    this.sulkFallback = { tile: beside ?? sulk.tile, facing: 'down', pose: 'stand' };
    const f = tileFeet(mgrSeat.tile, world.tile);
    this.manager = newChar('__manager__', 'manager', 'manager', mgrSeat, f.x, f.y, 0);
    placeAtGoal(this.manager, { key: `seat:${mgrSeat.id}`, tile: mgrSeat.tile, facing: 'down', pose: 'sitIdle', away: false }, 0, world.tile);
    const rf = tileFeet(recSeat.tile, world.tile);
    this.receptionist = newChar('__reception__', 'receptionist', 'receptionist', recSeat, rf.x, rf.y, 0);
    placeAtGoal(this.receptionist, { key: `seat:${recSeat.id}`, tile: recSeat.tile, facing: recSeat.facing, pose: 'sitType', away: false, screen: 'document' }, 0, world.tile);
    // Off-stage until the brain brings them in; parked at the elevator meanwhile.
    const ef = tileFeet(this.spots.elevator.tile, world.tile);
    this.cleaner = newChar(CLEANER_ID, 'cleaner', CLEANER_LOOK_ID, null, ef.x, ef.y, 0);
    this.vendor = newChar(VENDOR_ID, 'vendor', VENDOR_LOOK_ID, null, ef.x, ef.y, 0);
    this.dez = newChar(IT_DEZ_ID, 'itSupport', DEZ_LOOK_ID, null, ef.x, ef.y, 0);
    this.fenwick = newChar(IT_FENWICK_ID, 'itSupport', FENWICK_LOOK_ID, null, ef.x, ef.y, 0);
  }

  /** True while the cleaner is in the office (otherwise they are not drawn, hit-tested or listed in `allChars`). */
  get cleanerOnStage(): boolean {
    return this.cleanerIn;
  }

  /** True while the vendor is in the office with their cart (otherwise neither is drawn, hit-tested or listed in `allChars`). */
  get vendorOnStage(): boolean {
    return this.vendorIn;
  }

  /** True while Dez and Fenwick are in the office (otherwise neither is drawn, hit-tested or listed in `allChars`). */
  get itCrewOnStage(): boolean {
    return this.itIn;
  }

  /** The monitor the IT crew are rebooting: whose desk (`deskId`), `off` or `boot`, and since when (local ms); null otherwise. */
  get itScreen(): { deskId: string; mode: 'off' | 'boot'; since: number } | null {
    return this.itBrain.screen;
  }

  /** True while the cart stands parked (the boss and idle agents may go to it). */
  get cartParked(): boolean {
    return this.cartBrain.parked;
  }

  /** Dev harness: the cart comes in now (if it is not in already). */
  debugSummonCart(t: number): void {
    this.cartBrain.summon(t);
  }

  /** Dev harness: the cleaner starts a round now (if they are not in already). */
  debugSummonCleaner(t: number): void {
    this.cleanerBrain.summon(t);
  }

  /** Dev harness: the IT crew's visit is due now (if they are not in already; a no-op when the crew is turned off). */
  debugSummonItCrew(t: number): void {
    if (this.itEnabled) this.itBrain.summon(t);
  }

  /** Dev harness: the boss's snoop timer is due; he goes as soon as he is free. */
  debugSnoopNow(t: number): void {
    this.brain.snoopNow(t);
  }

  /** The Front desk panel opened or closed: she looks up and asks what to change, and takes no calls meanwhile. */
  setAttending(on: boolean): void {
    this.reception.setAttending(on);
  }

  /** True while the receptionist is on the phone (the desk shows the receiver off its cradle). */
  receptionOnPhone(): boolean {
    return this.reception.onPhone();
  }

  /**
   * Applies a theme's names, lines and pins. Seats and looks of people already in the office don't change
   * (pins only decide for agents who arrive later); look overrides live in the art registry, not here.
   */
  setTheme(state: ThemeState | undefined): void {
    this.theme = state;
    const pins = new Map<string, SlotInfo['pin']>();
    if (state) for (const [slot, info] of state.staff) if (info.pin) pins.set(slot, info.pin);
    this.assigner.setPins(pins);
  }

  /** True once the first agents message has been applied. */
  get hasSnapshot(): boolean {
    return this.seenSnapshot;
  }

  /** True while a Fable spell has the boss out of his office (he sulks). */
  get managerSulking(): boolean {
    return this.brain.sulking;
  }

  /** The agent holding the boss's office during a Fable spell, or null. */
  get spellHolder(): string | null {
    return this.spell?.id ?? null;
  }

  /** When the running Fable spell runs out (local ms), or null. */
  get spellEndsAt(): number | null {
    return this.spell?.until ?? null;
  }

  /** Ids queued at the manager's door, first at the door. */
  get queueIds(): readonly string[] {
    return this.queue;
  }

  /** Every character including the manager and the receptionist, and the cleaner, the vendor and the IT crew while they are in. */
  allChars(): Char[] {
    return [
      this.manager, this.receptionist, ...this.chars.values(), ...(this.cleanerIn ? [this.cleaner] : []), ...(this.vendorIn ? [this.vendor] : []),
      ...(this.itIn ? [this.dez, this.fenwick] : []),
    ];
  }

  /** The agent snapshot for an id (for tooltips: e.g. a temp's parent). */
  agentById(id: string): AgentView | null {
    return this.chars.get(id)?.agent ?? null;
  }

  /** Applies an agents message. */
  applySnapshot(raw: readonly unknown[], t: number, hostNow: number): void {
    this.hostNow = hostNow;
    const first = !this.seenSnapshot;
    const agents: AgentView[] = [];
    const ids = new Set<string>();
    for (const r of Array.isArray(raw) ? raw : []) {
      const a = normalizeAgent(r, hostNow);
      if (!a || ids.has(a.id)) continue;
      ids.add(a.id);
      agents.push(a);
    }
    const isDoneTemp = (a: AgentView): boolean => a.kind === 'temp' && a.status === 'done';
    // Everyone present and not leaving, every snapshot: seats follow the model, so known agents can move too.
    const inputs: AssignInput[] = agents.filter((a) => !isDoneTemp(a)).map((a) => ({ ...a, tier: tierOf(a.model) }));
    // Whose own model changed (their move is their own doing: no remark).
    const retiered = new Set<string>();
    for (const a of inputs) {
      const prev = this.chars.get(a.id)?.agent;
      if (prev && tierOf(prev.model) !== a.tier) retiered.add(a.id);
    }
    this.lastInputs = inputs;
    this.updateSpell(inputs, t, first);
    this.applyMoves(this.assigner.assign(inputs).moved, inputs, t, first, retiered);
    const elevator = tileFeet(this.spots.elevator.tile, this.world.tile);
    for (const a of agents) {
      let c = this.chars.get(a.id);
      const isNew = !c;
      if (!c) {
        if (isDoneTemp(a)) continue;
        const asg = this.assigner.get(a.id) ?? { look: this.world.tempSlots[0] ?? 'temp0', seat: null };
        c = newChar(a.id, a.kind, asg.look, asg.seat, elevator.x, elevator.y, t);
        c.dir = 'down';
        this.chars.set(a.id, c);
      }
      // Detail bubble: show a new detail for a few seconds.
      const prev = c.agent;
      if (!first && !isNew && a.detail && a.detail !== c.lastDetail) {
        c.detailText = a.detail;
        c.detailUntil = t + DETAIL_BUBBLE_MS;
      } else if (prev && prev.activity !== a.activity && !a.detail) {
        c.detailText = null;
      }
      if (isNew && !first) this.reception.noteArrival(a.kind, t);
      if (!first && isNew && a.detail) {
        c.detailText = a.detail;
        c.detailUntil = t + DETAIL_BUBBLE_MS;
      }
      c.lastDetail = a.detail;
      c.agent = a;
      c.coffee ??= newCoffee(t, this.effortOf(c), this.coffeeRng);
      c.leaving = isDoneTemp(a);
      if (c.leaving) this.brain.drop(a.id);
      // Prompts send the manager out.
      if (a.lastPromptAt !== undefined) {
        const seen = this.lastPrompt.get(a.id);
        if (!first && !c.leaving) {
          if (seen !== undefined && a.lastPromptAt > seen) this.brain.queueVisit(a.id);
          else if (seen === undefined && isNew && hostNow - a.lastPromptAt <= NEW_PROMPT_VISIT_MS) this.brain.queueVisit(a.id);
        }
        if (seen === undefined || a.lastPromptAt > seen) this.lastPrompt.set(a.id, a.lastPromptAt);
      }
      // Approvals send him too, with a joke (plans always; commands and edits once per cooldown).
      const ap = a.lastApproval;
      if (ap) {
        const seen = this.lastApproval.get(a.id);
        const fresh = seen !== undefined ? ap.at > seen : isNew && hostNow - ap.at <= NEW_PROMPT_VISIT_MS;
        if (!first && !c.leaving && this.bossQuotes && fresh) {
          const last = this.lastApprovalJoke.get(a.id);
          if (ap.kind === 'plan' || last === undefined || t - last >= APPROVAL_JOKE_COOLDOWN_MS) {
            this.brain.queueVisit(a.id, ap.kind);
            if (ap.kind !== 'plan') this.lastApprovalJoke.set(a.id, t);
          }
        }
        if (seen === undefined || ap.at > seen) this.lastApproval.set(a.id, ap.at);
      }
    }
    for (const c of this.chars.values()) {
      if (!ids.has(c.id) && !c.leaving) {
        c.leaving = true;
        this.brain.drop(c.id);
      }
    }
    for (const id of [...this.lastPrompt.keys()]) if (!ids.has(id)) this.lastPrompt.delete(id);
    for (const id of [...this.lastApproval.keys()]) if (!ids.has(id)) this.lastApproval.delete(id);
    for (const id of [...this.lastApprovalJoke.keys()]) if (!ids.has(id)) this.lastApprovalJoke.delete(id);
    if (first) {
      this.seenSnapshot = true;
      this.settle(t);
    }
  }

  /**
   * Starts or ends the Fable spell for this snapshot's agents (before they are assigned, so the eviction
   * applies in the same `assign`). It ends when its time is up, or the holder leaves, drops out or is no
   * longer on a Fable model; it starts for the earliest present Fable agent that has not had one, when
   * none is running. Every Fable agent present during a spell is marked, so it never gets one later.
   */
  private updateSpell(inputs: readonly AssignInput[], t: number, quiet: boolean): void {
    const fable: ModelTier = TIERS[0];
    const s = this.spell;
    if (s) {
      const holder = inputs.find((a) => a.id === s.id);
      if (!holder || holder.tier !== fable || t >= s.until) this.endSpell(quiet);
    }
    if (!this.spell) {
      const next = inputs
        .filter((a) => a.tier === fable && !this.spellSeen.has(a.id))
        .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
      if (next) {
        this.spell = { id: next.id, until: t + this.evictionMs };
        this.assigner.setEviction(next.id);
        this.brain.setSulking(true, quiet);
      }
    }
    if (this.spell) for (const a of inputs) if (a.tier === fable) this.spellSeen.add(a.id);
  }

  /** Ends the spell: the boss gets his office back; the next `assign` re-seats the holder by the usual rules. */
  private endSpell(quiet: boolean): void {
    this.spell = null;
    this.assigner.setEviction(null);
    this.brain.setSulking(false, quiet);
  }

  /**
   * Gives moved agents their new seat (they get up and walk there on the next tick). A worker whose desk
   * went to a better-ranked model grumbles; one moving to a better band may say something pleased. Nothing
   * is said on the first message (`quiet`), by anyone whose own model changed, or about the boss's chair.
   */
  private applyMoves(moved: readonly string[], inputs: readonly AssignInput[], t: number, quiet: boolean, retiered: ReadonlySet<string>): void {
    const was = new Map<string, SeatDef | null>();
    for (const id of moved) {
      const c = this.chars.get(id);
      if (!c) continue;
      was.set(id, c.seat);
      c.seat = this.assigner.get(id)?.seat ?? null;
    }
    // A desk someone has moved away from (and nobody took) wants cleaning.
    for (const from of was.values()) if (from && !this.seatHeld(from.id)) this.noteDesk(from, t);
    if (quiet) return;
    const tier = new Map(inputs.map((a) => [a.id, a.tier]));
    for (const [id, from] of was) {
      const c = this.chars.get(id)!;
      if (!from || c.leaving || !tier.has(id) || retiered.has(id)) continue;
      const fromBand = this.bandOfSeat.get(from.id);
      const to = c.seat;
      // Moves into or out of the boss's chair are the spell's business.
      if (fromBand === undefined || (to && to.id === this.managerSeat.id)) continue;
      // Bumped: a better-ranked model now has the old desk (wherever the overflow puts this one, even a better band).
      const taker = this.assigner.ids().find((o) => o !== id && this.assigner.get(o)?.seat?.id === from.id);
      if (taker !== undefined && tier.has(taker) && tierRank(tier.get(taker)!) < tierRank(tier.get(id)!)) {
        c.say = { text: this.bumpDeck.next(this.rng, ...lineSources(this.theme, 'deskBumped')), until: t + MOVE_SAY_MS };
        continue;
      }
      const toBand = to ? this.bandOfSeat.get(to.id) : undefined;
      if (toBand !== undefined && toBand < fromBand && this.rng() < MOVE_UP_SAY_CHANCE) {
        c.say = { text: this.moveUpDeck.next(this.rng, ...lineSources(this.theme, 'deskMoveUp')), until: t + MOVE_SAY_MS };
      }
    }
  }

  /** Places everyone directly at their current goal (first message, or after a long pause). */
  settle(t: number): void {
    this.updateChat(t);
    this.queue = this.computeQueue();
    for (const c of this.chars.values()) {
      this.ensureWander(c, t);
      const d = this.decideFor(c, t);
      if (d.reserve) this.res.take(d.reserve, c.id);
      else this.res.release(c.id);
      placeAtGoal(c, d, t, this.world.tile);
      this.onArrive(c, t);
    }
    for (const c of [...this.chars.values()]) if (c.leaving) this.remove(c, t);
    const md = this.brain.decide(this.managerCtx(), t);
    if (this.brain.visiting) {
      // Don't teleport onto a visit; just start it from the desk.
      this.applyGoal(this.manager, md.goal, t);
    } else {
      if (md.goal.reserve) this.res.take(md.goal.reserve, this.manager.id);
      placeAtGoal(this.manager, md.goal, t, this.world.tile);
    }
    this.manager.moodIcon = this.brain.sulking ? 'stormcloud' : null;
    placeAtGoal(this.receptionist, this.reception.decide(this.receptionCtx(), t).goal, t, this.world.tile);
  }

  /** Snaps walkers to their goals (used after the view was hidden for a while). */
  fastForward(t: number): void {
    for (const c of this.allChars()) {
      if (!c.arrived && c.goal) {
        placeAtGoal(c, c.goal, t, this.world.tile);
        this.onArrive(c, t);
      }
    }
  }

  /** One simulation step. */
  update(t: number, dtMs: number, hostNow: number): void {
    this.hostNow = hostNow;
    // A spell that runs out ends here, without waiting for a snapshot: re-seat from the last inputs.
    if (this.spell && t >= this.spell.until) {
      this.endSpell(false);
      const inputs = this.lastInputs.filter((a) => { const c = this.chars.get(a.id); return !!c && !c.leaving; });
      this.applyMoves(this.assigner.assign(inputs).moved, inputs, t, false, new Set());
    }
    // The cart first, so that people see it parked (or gone) in the same tick.
    this.stepVendor(t);
    // The IT crew next, so that whoever they hold is held before anyone picks a goal.
    this.stepIt(t);
    this.updateChat(t);
    this.queue = this.computeQueue();
    const list = [...this.chars.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const c of list) {
      this.ensureWander(c, t);
      this.applyGoal(c, this.decideFor(c, t), t);
    }
    const md = this.brain.decide(this.managerCtx(), t);
    if (md.say !== undefined && this.bossQuotes) this.manager.say = { text: md.say, until: t + (md.sayMs ?? VISIT_TALK_MS) };
    this.applyGoal(this.manager, md.goal, t);
    this.manager.moodIcon = this.brain.sulking ? 'stormcloud' : null;
    // Talked at by the IT crew: she keeps sitting, and her calls and remarks wait.
    if (this.itBrain.holding?.id === this.receptionist.id) this.reception.hold(t + 500);
    const rd = this.reception.decide(this.receptionCtx(), t);
    if (rd.say) this.receptionist.say = { text: rd.say.text, until: t + rd.say.ms };
    this.applyGoal(this.receptionist, rd.goal, t);
    this.stepCleaner(t);
    for (const c of this.allChars()) {
      if (stepChar(c, dtMs, t)) this.onArrive(c, t);
    }
    this.stepCoffees(t);
    for (const c of [...this.chars.values()]) if (c.leaving && c.arrived && c.goal?.key === 'exit') this.remove(c, t);
    for (const c of this.allChars()) {
      if (c.say && t >= c.say.until) c.say = null;
      if (c.detailText && t >= c.detailUntil) c.detailText = null;
    }
  }

  // -------------------------------------------------------------------------
  // Queries for drawing

  /**
   * The sip a seated worker is taking at `t`: how far into it (ms of real time) and its effort, which the scene turns into
   * the `deskSip` frame (faster at higher effort). Null when not sipping. Purely visual: goal, tooltip and bubbles are untouched.
   */
  sipOf(c: Char, t: number): { elapsedMs: number; effort: EffortLevel } | null {
    const cof = c.coffee;
    if (!cof || !c.agent || !isSipping(cof, t) || !this.seatedWorking(c)) return null;
    const effort = this.effortOf(c);
    return { elapsedMs: t - (cof.sippingUntil - DESK_SIP_CYCLE_MS / SIP_SPEED[effort]), effort };
  }

  /** Desks whose owner is sipping at `t`: their top is drawn without the mug (the `noMug` variant). */
  sippingDesks(t: number): Set<string> {
    const out = new Set<string>();
    for (const c of this.chars.values()) if (c.seat && this.sipOf(c, t)) out.add(c.seat.deskId);
    return out;
  }

  /** Furniture ids whose active/open variant should show. */
  activeProps(): Set<string> {
    const out = new Set<string>();
    for (const c of this.chars.values()) if (c.arrived && c.goal?.prop) out.add(c.goal.prop);
    if (this.doorOpen()) out.add('door-manager');
    return out;
  }

  /** The manager's door is open while anyone passes through it (the boss, or whoever has his office). */
  doorOpen(): boolean {
    const door = tileFeet(this.world.poi.managerDoor, this.world.tile);
    for (const c of this.allChars()) {
      if (c.removed) continue;
      if (Math.abs(c.x - door.x) < 8 && Math.abs(c.y - door.y) < 13) return true;
      const next = c.waypoints[0];
      if (!c.arrived && next && next.x === door.x && next.y === door.y && Math.abs(c.x - door.x) + Math.abs(c.y - door.y) <= 22) return true;
    }
    return false;
  }

  /** What the monitor on a desk should show. */
  deskScreen(deskId: string): DeskScreenState {
    if (deskId === this.managerSeat.deskId) {
      const m = this.manager;
      if (m.arrived && m.goal?.key === `seat:${this.managerSeat.id}`) return { mode: 'kind', value: 'browser' };
      // During a spell it shows the work of whoever has his chair.
      const st = this.agentScreen(deskId);
      return st.mode === 'off' ? { mode: 'idle' } : st;
    }
    if (deskId === this.receptionSeat.deskId) {
      const r = this.receptionist;
      const typing = r.pose === 'sitType' || r.pose === 'sitRead';
      return r.arrived && r.goal?.screen && typing ? { mode: 'kind', value: r.goal.screen } : { mode: 'idle' };
    }
    // The IT crew rebooting this monitor: dark, then the boot bar (from 0), then the agent's own screen again.
    const it = this.itBrain.screen;
    if (it && it.deskId === deskId) return it.mode === 'off' ? { mode: 'off' } : { mode: 'kind', value: 'boot', since: it.since };
    return this.agentScreen(deskId);
  }

  /** The screen of the agent seated at a desk ('off' when nobody has it). */
  private agentScreen(deskId: string): DeskScreenState {
    for (const c of this.chars.values()) {
      if (c.seat?.deskId !== deskId) continue;
      const atSeat = c.arrived && c.goal?.key === `seat:${c.seat.id}`;
      if (!atSeat || !c.agent || c.leaving) return { mode: 'idle' };
      if (c.goal?.screen) return { mode: 'kind', value: c.goal.screen };
      if (c.agent.activity === 'idle' || c.agent.activity === 'needsYou' || c.agent.status === 'done') return { mode: 'idle' };
      return { mode: 'activity', value: c.agent.activity };
    }
    return { mode: 'off' };
  }

  /** The character under a map-pixel point (topmost wins), or null. */
  hitTest(mx: number, my: number): Char | null {
    const list = this.allChars().sort((a, b) => b.y - a.y);
    for (const c of list) {
      const seated = isSeated(c);
      const top = c.y - (seated ? 22 : 23);
      const bottom = seated ? c.y - 5 : c.y;
      if (mx >= c.x - 6 && mx <= c.x + 6 && my >= top && my <= bottom) return c;
    }
    return null;
  }

  /** Who is chatting at the water cooler right now. */
  chatIds(): readonly string[] {
    return this.chat ? this.chat.ids : [];
  }

  // -------------------------------------------------------------------------
  // Internals

  private computeQueue(): string[] {
    const waiting: { id: string; since: number }[] = [];
    for (const c of this.chars.values()) if (c.agent && !c.leaving && wantsQueue(c.agent)) waiting.push({ id: c.id, since: c.agent.since });
    return queueOrder(waiting);
  }

  /** The effort shown for an agent: its own, else the Claude default for its model, else medium. */
  private effortOf(c: Char): EffortLevel {
    const a = c.agent;
    return a?.effort ?? effortOrDefault(this.defaultEffort?.(a?.model));
  }

  /** True when the agent is at its own seat doing seated work (not idle, waiting, delegating, away or leaving). */
  private seatedWorking(c: Char): boolean {
    const a = c.agent;
    const g = c.goal;
    if (!a || !g || !c.seat || c.leaving || !c.arrived || g.key !== `seat:${c.seat.id}` || !WORK_POSES.has(g.pose)) return false;
    return a.activity !== 'idle' && a.activity !== 'needsYou' && a.activity !== 'delegating' && a.status !== 'done';
  }

  /** Sips from the mug while seated and working, and refills it at the coffee maker once idle and empty. */
  private stepCoffees(t: number): void {
    for (const c of this.chars.values()) {
      const a = c.agent;
      if (!c.coffee || !a) continue;
      const effort = this.effortOf(c);
      const working = this.seatedWorking(c);
      let cof = stepCoffee(c.coffee, t, { effort, seatedWorking: working, rng: this.coffeeRng, sipMs: DESK_SIP_CYCLE_MS }).state;
      // Called away mid-sip: the sip is over.
      if (!working && isSipping(cof, t)) cof = { ...cof, sippingUntil: -Infinity };
      const idle = !c.leaving && isWandering(a, this.hostNow);
      if (wantsRefill(cof, idle) && c.arrived && c.goal?.key === COFFEE_KEY && t >= c.arrivedAt + REFILL_PAUSE_MS) {
        cof = refill(cof, t, effort, this.coffeeRng);
      }
      c.coffee = cof;
    }
  }

  /**
   * Where an idle agent wanders next: the coffee maker if its mug is empty and the spot is free; else, while the food cart is
   * parked, now and then a free spot by it (the cart's own dice, never the office's); else a random free spot.
   */
  private wanderPick(c: Char, avoid?: string | null): string | null {
    if (this.wantsCoffee(c, avoid)) return COFFEE_KEY;
    const cart = isAgentCartKey(avoid) ? null : this.cartBrain.agentVisit((key) => this.res.isFree(key, c.id));
    return cart ?? chooseWanderSpot(this.spots, this.res, c.id, this.rng, avoid);
  }

  /** True when an idle agent has an empty mug and the coffee maker is free (no rng, so asking is free). */
  private wantsCoffee(c: Char, avoid?: string | null): boolean {
    return !!c.coffee && wantsRefill(c.coffee, true) && avoid !== COFFEE_KEY && this.res.isFree(COFFEE_KEY, c.id);
  }

  private chatSlot(id: string): number {
    if (!this.chat) return -1;
    return this.chat.ids.indexOf(id);
  }

  private decideFor(c: Char, t: number): Goal {
    if (!c.agent) return c.goal ?? { key: 'exit', tile: this.spots.elevator.tile, facing: 'down', pose: 'stand', away: true };
    const slot = this.chatSlot(c.id);
    const input = {
      id: c.id, seat: c.seat, agent: c.agent, leaving: c.leaving,
      queueIndex: this.queue.indexOf(c.id), wanderKey: c.wanderKey, chatSlot: slot,
    };
    const ctx = { spots: this.spots, res: this.res, hostNow: this.hostNow, ...(this.cartBrain.parked ? { extraSpots: AGENT_CART_SPOTS } : {}) };
    const d = desiredGoal(input, ctx);
    // Talked at by the IT crew: they keep to their spot, turned to the speaker, mouthing along during their reply.
    const hold = this.itBrain.holding;
    if (hold?.id === c.id && d.key === c.wanderKey && !SEATED_POSES.has(d.pose)) {
      d.facing = facingToward(d.tile, hold.face);
      d.pose = hold.talking ? 'talk' : 'stand';
    }
    if (slot >= 0 && d.key.startsWith('cooler:')) {
      const speaking = c.say !== null && t < c.say.until;
      if (!speaking) d.pose = 'stand';
    }
    // Fable spell: the holder keeps to the boss's desk. Away spots, wandering, chats and the delegating walk
    // all become seated work there; leaving and the door queue (knock/wait) still win.
    if (this.spell?.id === c.id && !c.leaving && !d.key.startsWith('queue:') && !d.key.startsWith('seat:') && d.key !== 'exit') {
      const act = c.agent.activity;
      const pose = act === 'copier' ? 'sitRun' : act === 'idle' || act === 'delegating' || act === 'needsYou' ? 'sitIdle' : 'sitType';
      return seatGoal(input, ctx, pose, act === 'drawing' ? 'drawing' : undefined);
    }
    return d;
  }

  private applyGoal(c: Char, d: Goal, t: number): void {
    const g = c.goal;
    if (g && g.key === d.key && g.tile.x === d.tile.x && g.tile.y === d.tile.y) {
      const poseChanged = g.pose !== d.pose || g.facing !== d.facing;
      c.goal = d;
      if (c.arrived && poseChanged) {
        c.pose = d.pose;
        c.dir = d.facing;
        c.poseStart = t;
      }
      return;
    }
    const queueShuffle = g !== null && g.key.startsWith('queue:') && d.key.startsWith('queue:');
    if (g && g.away && c.arrived && (c.kind === 'main' || c.kind === 'temp') && !c.leaving && !queueShuffle && t < c.arrivedAt + COMMIT_MS) return;
    if (d.reserve) {
      if (!this.res.take(d.reserve, c.id)) return;
    } else {
      this.res.release(c.id);
    }
    routeTo(c, d, t, this.routeMap);
  }

  private onArrive(c: Char, t: number): void {
    if (c.goal?.key.startsWith('idle:')) c.wanderUntil = t + randRange(this.rng, LINGER_MIN_MS, LINGER_MAX_MS);
    else if (c.agent && isAgentCartKey(c.goal?.key)) c.wanderUntil = t + this.cartBrain.agentLingerMs();
  }

  private ensureWander(c: Char, t: number): void {
    const a = c.agent;
    if (!a || c.leaving || this.spell?.id === c.id || !isWandering(a, this.hostNow) || this.chatSlot(c.id) >= 0) {
      c.wanderKey = null;
      return;
    }
    // Held for small talk by the IT crew: no new goal (so no dice, no coffee, no cart) until they let go.
    if (this.itBrain.holding?.id === c.id) return;
    if (c.wanderKey === null || (isAgentCartKey(c.wanderKey) && !this.cartBrain.parked)) {
      c.wanderKey = this.wanderPick(c);
      c.wanderUntil = Infinity;
      return;
    }
    if (c.arrived && c.goal?.key === c.wanderKey && t >= c.wanderUntil) {
      // An empty mug wins over lingering: off to the coffee maker (no dice rolled).
      if (this.wantsCoffee(c, c.wanderKey)) {
        c.wanderKey = COFFEE_KEY;
        c.wanderUntil = Infinity;
      } else if (isAgentCartKey(c.wanderKey) || this.rng() < 0.55) {
        // Done at the cart: carry on (no dice rolled).
        const next = this.wanderPick(c, c.wanderKey);
        c.wanderKey = next;
        c.wanderUntil = Infinity;
      } else {
        c.wanderUntil = t + randRange(this.rng, LINGER_MIN_MS, LINGER_MAX_MS);
      }
    }
  }

  private updateChat(t: number): void {
    const ok = (id: string): boolean => {
      const c = this.chars.get(id);
      return !!c && !!c.agent && !c.leaving && this.spell?.id !== id && isWandering(c.agent, this.hostNow) && this.itBrain.holding?.id !== id;
    };
    if (this.chat) {
      const ch = this.chat;
      if (!ok(ch.ids[0]) || !ok(ch.ids[1]) || t >= ch.endsAt) {
        for (const id of ch.ids) {
          const c = this.chars.get(id);
          if (c) c.say = null;
        }
        this.chat = null;
        this.chatCooldownUntil = t + randRange(this.rng, 8_000, 16_000);
      } else {
        const a = this.chars.get(ch.ids[0])!;
        const b = this.chars.get(ch.ids[1])!;
        const there = (c: Char): boolean => c.arrived && (c.goal?.key.startsWith('cooler:') ?? false);
        if (there(a) && there(b) && t >= ch.nextLineAt) {
          if (ch.lines.length === 0) {
            // No half-said exchange: start one only if its reply finishes before the chat ends.
            if (t + CHAT_LINE_MS + 250 + CHAT_LINE_MS > ch.endsAt) return;
            const [opening, reply] = this.nextExchange(ch.opener === 0 ? a : b, t);
            ch.lines = [[ch.opener, opening], [ch.opener === 0 ? 1 : 0, reply]];
            ch.opener = ch.opener === 0 ? 1 : 0;
          }
          const [who, text] = ch.lines.shift()!;
          const speaker = who === 0 ? a : b;
          const listener = who === 0 ? b : a;
          speaker.say = { text, until: t + CHAT_LINE_MS };
          listener.say = null;
          ch.nextLineAt = t + CHAT_LINE_MS + 250 + (ch.lines.length === 0 ? CHAT_GAP_MS : 0);
        }
      }
      return;
    }
    if (t < this.chatCooldownUntil) return;
    const idle = [...this.chars.values()]
      .filter((c) => ok(c.id))
      .sort((x, y) => (x.agent!.since - y.agent!.since) || (x.id < y.id ? -1 : 1));
    if (idle.length < 2) return;
    const [k0, k1] = [this.spots.cooler[0]?.key, this.spots.cooler[1]?.key];
    if (k0 === undefined || k1 === undefined) return;
    // Every pair who can take the two spots (the one further left takes the left spot).
    const pairs: { left: Char; right: Char }[] = [];
    for (let i = 0; i < idle.length; i++) {
      for (let j = i + 1; j < idle.length; j++) {
        const [p, q] = [idle[i]!, idle[j]!];
        const [left, right] = p.x <= q.x ? [p, q] : [q, p];
        if (this.res.isFree(k0, left.id) && this.res.isFree(k1, right.id)) pairs.push({ left, right });
      }
    }
    // A random pair, another than last time when there is one.
    const fresh = pairs.filter((x) => pairId(x.left.id, x.right.id) !== this.lastChatPair);
    const choice = fresh.length > 0 ? fresh : pairs;
    if (choice.length === 0) return;
    const { left, right } = choice[Math.floor(this.rng() * choice.length)]!;
    this.lastChatPair = pairId(left.id, right.id);
    this.chat = {
      ids: [left.id, right.id],
      endsAt: t + randRange(this.rng, CHAT_MIN_MS, CHAT_MAX_MS),
      nextLineAt: t + 600,
      opener: this.rng() < 0.5 ? 0 : 1,
      lines: [],
    };
    left.wanderKey = null;
    right.wanderKey = null;
  }

  /**
   * The next exchange (opener, reply) when `opener` starts one. Someone with their own lines in the theme says one
   * of them (from their own deck) at most once per `OWN_LINE_GAP_MS`, and the listener answers with a generic reply;
   * otherwise the pair comes from the cooler deck (built-in pairs plus the theme's).
   */
  private nextExchange(opener: Char, t: number): [string, string] {
    const own = slotInfoOf(this.theme, opener.look)?.lines;
    const last = this.ownLineAt.get(opener.look);
    if (own && own.length > 0 && (last === undefined || t - last >= OWN_LINE_GAP_MS)) {
      let deck = this.ownDecks.get(opener.look);
      if (!deck) this.ownDecks.set(opener.look, (deck = new LiveDeck<string>()));
      this.ownLineAt.set(opener.look, t);
      return [deck.next(this.rng, own), this.replyDeck.next(this.rng, ...lineSources(this.theme, 'chatReplies'))];
    }
    const [a, b] = this.coolerDeck.next(this.rng, ...smallTalkSources(this.theme));
    return [a, b];
  }

  /** The theme's sources for the single-line pools, for the brains' contexts (stable per theme, so their decks keep dealing). */
  private readonly linesHook: LinesHook = (key) => lineSources(this.theme, key);
  private readonly pairsHook: PairsHook = (key) => lineSources(this.theme, key);

  private receptionCtx(): ReceptionCtx {
    return {
      me: this.receptionist,
      seat: this.receptionSeat,
      speechBubbles: this.speechBubbles,
      lines: this.linesHook,
    };
  }

  /** Queues a vacated desk for the cleaner (not the boss's chair, not reception). */
  private noteDesk(seat: SeatDef, t: number): void {
    if (seat.owner === 'manager' || seat.owner === 'reception') return;
    this.cleanerBrain.noteDirty(seat.id, t);
  }

  /** True when some agent (leaving ones too, until they are gone) holds the seat. */
  private seatHeld(seatId: string): boolean {
    for (const c of this.chars.values()) if (c.seat?.id === seatId) return true;
    return false;
  }

  /** True when `c` stands on `tile` or is on its way there. */
  private isAt(c: Char, tile: Tile): boolean {
    const f = charTile(c, this.world.tile);
    return (f.x === tile.x && f.y === tile.y) || (!!c.goal && c.goal.tile.x === tile.x && c.goal.tile.y === tile.y);
  }

  /** True when anyone in the office but `except` stands on `tile` or is on their way there. */
  private occupied(tile: Tile, ...except: Char[]): boolean {
    return this.allChars().some((c) => !except.includes(c) && this.isAt(c, tile));
  }

  /** True when nobody holds the seat, and nobody (a worker who has just moved desks) is still sitting at it. */
  private seatEmpty(seat: SeatDef): boolean {
    return !this.seatHeld(seat.id) && ![...this.chars.values()].some((c) => this.isAt(c, seat.tile));
  }

  private cleanerCtx(): CleanerCtx {
    return {
      me: this.cleaner,
      spots: this.spots,
      seats: this.cleanSeats,
      // Empty: nobody holds the seat, and nobody (a worker who has just moved desks) is still sitting at it.
      seatEmpty: (seat) => this.seatEmpty(seat),
      // Free: no reservation of someone else's, and no one else (the boss, the vendor and the IT crew included) standing there or heading there.
      free: (tile, key) => (key === undefined || this.res.isFree(key, this.cleaner.id)) && !this.occupied(tile, this.cleaner),
      speechBubbles: this.speechBubbles,
      lines: this.linesHook,
    };
  }

  /** Runs the cleaner's brain: brings them in from the elevator, walks and mutters, and takes them out again. */
  private stepCleaner(t: number): void {
    const c = this.cleaner;
    const d = this.cleanerBrain.decide(this.cleanerCtx(), t);
    if (!d) {
      if (this.cleanerIn) {
        this.cleanerIn = false;
        this.res.release(c.id);
        c.say = null;
        c.goal = null;
      }
      return;
    }
    if (!this.cleanerIn) {
      this.cleanerIn = true;
      const f = tileFeet(this.spots.elevator.tile, this.world.tile);
      c.x = f.x;
      c.y = f.y;
      c.goal = null;
      c.waypoints = [];
      c.arrived = true;
      c.arrivedAt = t;
      c.pose = 'stand';
      c.dir = 'down';
      c.poseStart = t;
    }
    if (d.say) c.say = { text: d.say.text, until: t + d.say.ms };
    this.applyGoal(c, d.goal, t);
  }

  private cartCtx(): CartCtx {
    return { me: this.vendor, spots: this.spots, speechBubbles: this.speechBubbles, lines: this.linesHook };
  }

  /** Runs the vendor's brain: brings them and the cart in from the elevator, calls out while it is parked, and takes it out again. */
  private stepVendor(t: number): void {
    const c = this.vendor;
    const d = this.cartBrain.decide(this.cartCtx(), t);
    if (!d) {
      if (this.vendorIn) {
        this.vendorIn = false;
        this.res.release(c.id);
        c.say = null;
        c.goal = null;
      }
      this.blockCart(false);
      return;
    }
    if (!this.vendorIn) {
      this.vendorIn = true;
      const f = tileFeet(this.spots.elevator.tile, this.world.tile);
      c.x = f.x;
      c.y = f.y;
      c.goal = null;
      c.waypoints = [];
      c.arrived = true;
      c.arrivedAt = t;
      c.pose = 'stand';
      c.dir = 'down';
      c.poseStart = t;
    }
    if (d.say) c.say = { text: d.say.text, until: t + d.say.ms };
    this.applyGoal(c, d.goal, t);
    // Walking, they push the cart (the art's `pushCart` runs on the walk's timing).
    if (c.pose === 'walk') c.pose = 'pushCart';
    this.blockCart(this.cartBrain.parked);
  }

  /** Blocks (or frees) the tiles the parked cart sits on, so people walk round it. Tiles already planned through are not replanned. */
  private blockCart(on: boolean): void {
    if (on === this.cartBlocked) return;
    this.cartBlocked = on;
    const { w } = this.world;
    for (const tile of CART_TILES) this.routeMap.grid[tile.y * w + tile.x] = on ? 0 : this.world.grid[tile.y * w + tile.x]!;
  }

  /** The reservation key of any spot (the cart's too, while it is parked) standing on `tile`. */
  private spotKeyAt(tile: Tile): string | undefined {
    const s = this.spots;
    const named = [
      ...s.cabinets, s.easel, s.whiteboard, ...s.copier, ...s.shredder, ...s.idle, ...s.cooler, ...s.queue, ...s.lobby, s.delegate,
      ...(this.cartBrain.parked ? AGENT_CART_SPOTS : []),
    ];
    return named.find((n) => n.spot.tile.x === tile.x && n.spot.tile.y === tile.y)?.key;
  }

  /** The agent desks the IT crew could fix: a worker at their own seat (needing you, or working), or an empty desk. */
  private itDesks(): ItDesk[] {
    const out: ItDesk[] = [];
    const visit = this.brain.visit;
    for (const seat of this.cleanSeats) {
      let holder: Char | undefined;
      for (const c of this.chars.values()) if (c.seat?.id === seat.id) { holder = c; break; }
      if (!holder) {
        if (this.seatEmpty(seat)) out.push({ seat, worker: null, state: 'empty' });
        continue;
      }
      const id = holder.id;
      if (holder.leaving || this.spell?.id === id || this.brain.snooping === id || visit?.id === id || this.brain.isQueued(id)) continue;
      if (!(holder.arrived && holder.goal?.key === `seat:${seat.id}`)) continue;
      if (holder.agent?.activity === 'needsYou') out.push({ seat, worker: id, state: 'needsYou' });
      else if (this.seatedWorking(holder)) out.push({ seat, worker: id, state: 'working' });
    }
    return out;
  }

  /**
   * Where the IT crew can stand to talk to whoever sits at a desk, best first: the nearest walkable tile to the left and
   * to the right of it, level with the sitter and then level with the desk front, facing them (side-on, so the sitter
   * stays visible next to the speaker's bubble); the seat's visit tile (in front of the desk, facing up) is the last resort.
   */
  private deskStands(seat: SeatDef): { tile: Tile; facing: Dir }[] {
    const { w, h } = this.world;
    const out: { tile: Tile; facing: Dir }[] = [];
    for (const dy of [0, 1]) {
      for (const side of [-1, 1]) {
        for (let dist = 1; dist <= 3; dist++) {
          const tile = { x: seat.tile.x + side * dist, y: seat.tile.y + dy };
          if (tile.x < 0 || tile.y < 0 || tile.x >= w || tile.y >= h || this.routeMap.grid[tile.y * w + tile.x] !== 1) continue;
          out.push({ tile, facing: side < 0 ? 'right' : 'left' });
          break;
        }
      }
    }
    out.push({ tile: seat.visit.tile, facing: seat.visit.facing });
    return out;
  }

  /** Everyone the IT crew could make small talk at right now (the same tests decide whether they still may). */
  private itListeners(): ItListener[] {
    const out: ItListener[] = [];
    for (const c of this.chars.values()) {
      const a = c.agent;
      if (!a || c.leaving || this.spell?.id === c.id || !isWandering(a, this.hostNow) || this.chatSlot(c.id) >= 0) continue;
      const key = c.goal?.key;
      if (!c.arrived || !key || !key.startsWith('idle:') || isAgentCartKey(key)) continue;
      out.push({ id: c.id, who: 'agent', tile: charTile(c, this.world.tile) });
    }
    if (this.speechBubbles) {
      if (!this.reception.onPhone() && !this.reception.isAttending()) {
        out.push({ id: this.receptionist.id, who: 'receptionist', tile: this.receptionSeat.tile, stands: this.deskStands(this.receptionSeat) });
      }
      const m = this.manager;
      const b = this.brain;
      if (this.bossQuotes && m.arrived && m.goal?.key === `seat:${this.managerSeat.id}` && !b.visiting && b.pending.length === 0 && !b.snooping
        && !b.atCart && !b.sulking && this.queue.length === 0 && !this.cartBrain.parked) {
        out.push({ id: m.id, who: 'boss', tile: this.managerSeat.tile, stands: this.deskStands(this.managerSeat) });
      }
    }
    return out;
  }

  private itCtx(): ItCtx {
    const { dez, fenwick } = this;
    const { w, h } = this.world;
    return {
      dez,
      fenwick,
      spots: this.spots,
      speechBubbles: this.speechBubbles,
      grid: this.routeMap.grid,
      w,
      h,
      desks: () => this.itDesks(),
      listeners: () => this.itListeners(),
      stillAt: (workerId, seatId) => {
        const c = this.chars.get(workerId);
        return !!c && !c.leaving && c.arrived && c.goal?.key === `seat:${seatId}` && c.agent?.activity !== 'delegating'
          && this.brain.visit?.id !== workerId && !this.brain.isQueued(workerId);
      },
      canListen: (id) => this.itListeners().some((l) => l.id === id),
      // Free: walkable, nobody but the pair standing or heading there, and the spot not reserved by someone else.
      free: (tile, key) => {
        if (tile.x < 0 || tile.y < 0 || tile.x >= w || tile.y >= h || this.routeMap.grid[tile.y * w + tile.x] !== 1) return false;
        if (this.occupied(tile, dez, fenwick)) return false;
        const holder = key === undefined ? undefined : this.res.holder(key);
        return holder === undefined || holder === dez.id || holder === fenwick.id;
      },
      spotAt: (tile) => this.spotKeyAt(tile),
      lines: this.linesHook,
      pairs: this.pairsHook,
    };
  }

  /** Runs the IT crew's brain: brings the pair in from the elevator, walks them, plays the fix and the small talk, and takes them out again. */
  private stepIt(t: number): void {
    if (!this.itEnabled) return;
    const pair = [this.dez, this.fenwick];
    const d = this.itBrain.decide(this.itCtx(), t);
    if (!d) {
      if (this.itIn) {
        this.itIn = false;
        for (const c of pair) {
          this.res.release(c.id);
          c.say = null;
          c.goal = null;
        }
      }
      return;
    }
    if (!this.itIn) {
      this.itIn = true;
      const door: Goal = { key: 'it:in', tile: this.spots.elevator.tile, facing: 'down', pose: 'stand', away: true };
      for (const c of pair) placeAtGoal(c, door, t, this.world.tile);
    }
    for (const [c, step] of [[this.dez, d.dez], [this.fenwick, d.fenwick]] as const) {
      if (step.say) c.say = { text: step.say.text, until: t + step.say.ms };
      this.applyGoal(c, step.goal, t);
    }
    if (d.reply) {
      const target = this.chars.get(d.reply.id) ?? (d.reply.id === this.manager.id ? this.manager : d.reply.id === this.receptionist.id ? this.receptionist : undefined);
      if (target) target.say = { text: d.reply.text, until: t + d.reply.ms };
    }
  }

  private managerCtx(): ManagerCtx {
    return {
      me: this.manager,
      seat: this.managerSeat,
      spots: this.spots,
      sulk: this.res.isFree(this.sulkReserve, this.manager.id)
        ? { spot: this.world.poi.sulk, reserve: this.sulkReserve }
        : { spot: this.sulkFallback },
      queueLength: this.queue.length,
      rng: this.rng,
      lines: this.linesHook,
      pairs: this.pairsHook,
      workers: () => {
        const out: { id: string; seat: SeatDef }[] = [];
        const engaged = this.itBrain.engaged;
        for (const c of this.chars.values()) {
          if (c.seat && c.seat.id !== this.managerSeat.id && this.seatedWorking(c) && !engaged.includes(c.id)) out.push({ id: c.id, seat: c.seat });
        }
        return out;
      },
      ...(this.cartBrain.parked ? { cart: { arrival: this.cartBrain.arrival, spot: BOSS_CART_SPOT } } : {}),
      grid: this.routeMap.grid,
      w: this.world.w,
      h: this.world.h,
      targetOf: (id: string): VisitTarget | null => {
        const c = this.chars.get(id);
        if (!c || c.leaving || !c.goal) return null;
        const g = c.goal;
        if (c.seat && g.key === `seat:${c.seat.id}`) return { tile: g.tile, seatVisit: c.seat.visit };
        return { tile: g.tile, seatVisit: null };
      },
    };
  }

  private remove(c: Char, t: number): void {
    c.removed = true;
    this.chars.delete(c.id);
    this.res.release(c.id);
    this.assigner.release(c.id);
    // Their desk is free now: the cleaner will see to it.
    if (c.seat) this.noteDesk(c.seat, t);
    this.brain.drop(c.id);
    // Normally the spell ended when the holder left; never leave the boss's chair promised to someone gone.
    if (this.spell?.id === c.id) this.endSpell(false);
  }
}
