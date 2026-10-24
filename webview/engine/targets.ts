/**
 * Activity → where to be and how to stand there.
 *
 * Pure decision logic: the spot catalogue, exclusive reservations, the
 * manager's-door queue order and the idle-wander choice. The office
 * (`office.ts`) owns the state and calls these every tick.
 */
import type { Activity, AgentControl, AgentSnapshot, AgentStatus, EffortLevel, PendingKind, PlanRef, PlanStatus } from '../../src/shared/protocol.ts';
import { ACTIVITIES, AGENT_CONTROLS, EFFORT_LEVELS, LIMITS, PENDING_KINDS } from '../../src/shared/protocol.ts';
import type { Dir, FoodId, Pose, SeatDef, SpotDef, Tile, WorldDef } from './types.ts';
import { pick } from './types.ts';

/** An idle agent stays seated this long before wandering off. */
export const IDLE_WANDER_AFTER_MS = 20_000;
/** A character commits to an away-from-desk spot for at least this long after arriving. */
export const COMMIT_MS = 3_000;

/** Where a character wants to be. */
export interface Goal {
  /** Identity of the place; a change of key means walking somewhere else. */
  key: string;
  tile: Tile;
  facing: Dir;
  pose: Pose;
  /** Away from the character's own desk (the commit rule applies). */
  away: boolean;
  /** Exclusive reservation key held while this is the goal. */
  reserve?: string;
  /** Furniture id switched to its active/open variant while the character is there. */
  prop?: string;
  /** Overrides the owner's desk screen kind (e.g. 'drawing' when the easel is taken). */
  screen?: string;
  /** The food held while the pose is `pickFood`. */
  food?: FoodId;
}

/** A spot with a reservation key and an optional prop. */
export interface NamedSpot { key: string; spot: SpotDef; prop?: string }

/** Every reservable spot, built once from the map. */
export interface Spots {
  cabinets: NamedSpot[];
  easel: NamedSpot;
  whiteboard: NamedSpot;
  copier: NamedSpot[];
  shredder: NamedSpot[];
  /** Solo idle spots (kitchen, vending machine, kitchen table). */
  idle: NamedSpot[];
  /** The two facing water-cooler chat spots. */
  cooler: NamedSpot[];
  /** Door queue, first spot at the door. */
  queue: NamedSpot[];
  /** Standing room for agents without a seat. */
  lobby: NamedSpot[];
  delegate: NamedSpot;
  reception: SpotDef;
  elevator: SpotDef;
  insideDoor: SpotDef;
}

const S = (x: number, y: number, facing: Dir, pose: Pose): SpotDef => ({ tile: { x, y }, facing, pose });

/** Builds the spot catalogue from the map's points of interest. */
export function buildSpots(world: WorldDef): Spots {
  const p = world.poi;
  const copier = p.copier;
  const cx = copier.tile.x;
  const cy = copier.tile.y;
  const walk = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < world.w && y < world.h && world.grid[y * world.w + x] === 1;
  const copierSpots: SpotDef[] = [copier];
  for (const s of [S(cx + 1, cy, 'left', 'copierWait'), S(cx, cy + 1, 'down', 'copierWait'), S(cx + 1, cy + 1, 'left', 'copierWait')]) {
    if (walk(s.tile.x, s.tile.y)) copierSpots.push(s);
  }
  const shred = p.shredder;
  const shredSpots: SpotDef[] = [shred];
  if (walk(shred.tile.x, shred.tile.y + 1)) shredSpots.push(S(shred.tile.x, shred.tile.y + 1, 'up', 'stand'));
  const lobby: NamedSpot[] = [];
  for (let y = p.elevator.tile.y + 4; y <= p.elevator.tile.y + 5 && lobby.length < 10; y++) {
    for (let x = 2; x <= 7; x++) {
      if (x === p.reception.tile.x && y === p.reception.tile.y) continue;
      if (walk(x, y)) lobby.push({ key: `lobby:${x},${y}`, spot: S(x, y, 'up', 'stand') });
    }
  }
  return {
    cabinets: p.filingCabinets.map((s) => ({ key: `cab:${s.tile.x}`, spot: s, prop: `filing-${s.tile.x}` })),
    easel: { key: 'easel', spot: p.easel },
    whiteboard: { key: 'whiteboard', spot: p.whiteboard },
    copier: copierSpots.map((s, i) => ({ key: `copier:${i}`, spot: s, prop: 'copier' })),
    shredder: shredSpots.map((s, i) => ({ key: `shredder:${i}`, spot: s, prop: i === 0 ? 'shredder' : undefined })),
    idle: [
      { key: 'idle:coffee', spot: p.coffee },
      { key: 'idle:fridge', spot: p.fridge },
      { key: 'idle:microwave', spot: p.microwave },
      { key: 'idle:vending', spot: p.vendingMachine },
      ...p.kitchenTable.map((s, i) => ({ key: `idle:table${i}`, spot: s })),
    ],
    cooler: p.waterCooler.map((s, i) => ({ key: `cooler:${i}`, spot: s })),
    queue: p.managerDoorQueue.map((s, i) => ({ key: `queue:${i}`, spot: s })),
    lobby,
    delegate: { key: 'delegate', spot: p.delegate },
    reception: p.reception,
    elevator: p.elevator,
    insideDoor: p.managerInsideDoor,
  };
}

/** Exclusive spot reservations: one holder per key, at most one key per holder. */
export class Reservations {
  private readonly byKey = new Map<string, string>();
  private readonly byHolder = new Map<string, string>();

  /** True if `key` is free or already held by `who`. */
  isFree(key: string, who: string): boolean {
    const h = this.byKey.get(key);
    return h === undefined || h === who;
  }

  holder(key: string): string | undefined {
    return this.byKey.get(key);
  }

  held(who: string): string | undefined {
    return this.byHolder.get(who);
  }

  /** Takes `key` for `who`, dropping whatever `who` held before. Returns false if someone else holds it. */
  take(key: string, who: string): boolean {
    if (!this.isFree(key, who)) return false;
    this.release(who);
    this.byKey.set(key, who);
    this.byHolder.set(who, key);
    return true;
  }

  release(who: string): void {
    const k = this.byHolder.get(who);
    if (k !== undefined) {
      this.byKey.delete(k);
      this.byHolder.delete(who);
    }
  }
}

/** Agent fields the engine relies on, with defaults filled in. */
export interface AgentView {
  id: string;
  parentId?: string;
  kind: 'main' | 'temp';
  title: string;
  project: string;
  activity: Activity;
  detail?: string;
  status: AgentStatus;
  since: number;
  startedAt: number;
  lastPromptAt?: number;
  /** Manager Mode fields (all optional; see AgentSnapshot). */
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  control?: AgentControl;
  pending?: { requestId: string; kind: PendingKind };
  costUsd?: number;
  /** Round A fields (see AgentSnapshot); every one is validated by normalizeAgent. */
  model?: string;
  effort?: EffortLevel;
  context?: NonNullable<AgentSnapshot['context']>;
  lastReport?: NonNullable<AgentSnapshot['lastReport']>;
  plans?: PlanRef[];
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);
const PLAN_STATUS_SET: ReadonlySet<string> = new Set<PlanStatus>(['pending', 'approved', 'rejected', 'superseded']);
const CONTROL_SET: ReadonlySet<string> = new Set(AGENT_CONTROLS);
const PENDING_SET: ReadonlySet<string> = new Set(PENDING_KINDS);

const ACTIVITY_SET: ReadonlySet<string> = new Set(ACTIVITIES);
const STATUS_SET: ReadonlySet<string> = new Set(['working', 'waiting', 'idle', 'done']);

/**
 * Fills in missing or odd fields of a snapshot entry. Unknown activities are
 * treated as writing. Returns null if there is no usable id.
 */
export function normalizeAgent(raw: unknown, hostNow: number): AgentView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'] ? r['id'] : typeof r['id'] === 'number' ? String(r['id']) : null;
  if (id === null) return null;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const parentId = str(r['parentId']);
  const kind = r['kind'] === 'temp' || r['kind'] === 'main' ? r['kind'] : parentId ? 'temp' : 'main';
  const activity = (ACTIVITY_SET.has(String(r['activity'])) ? r['activity'] : 'writing') as Activity;
  const status = (STATUS_SET.has(String(r['status'])) ? r['status'] : activity === 'idle' ? 'idle' : activity === 'needsYou' ? 'waiting' : 'working') as AgentStatus;
  const since = num(r['since']) ?? hostNow;
  const out: AgentView = {
    id,
    kind,
    title: str(r['title'])?.trim() || 'Untitled session',
    project: str(r['project']) ?? '',
    activity,
    status,
    since,
    startedAt: num(r['startedAt']) ?? since,
  };
  if (parentId) out.parentId = parentId;
  const detail = str(r['detail']);
  if (detail && detail.trim()) out.detail = detail.trim();
  const lp = num(r['lastPromptAt']);
  if (lp !== undefined) out.lastPromptAt = lp;
  const sid = str(r['sessionId']);
  if (sid) out.sessionId = sid;
  const cwd = str(r['cwd']);
  if (cwd) out.cwd = cwd;
  const branch = str(r['gitBranch'])?.trim();
  if (branch) out.gitBranch = branch;
  if (CONTROL_SET.has(String(r['control']))) out.control = r['control'] as AgentControl;
  const p = r['pending'];
  if (p && typeof p === 'object') {
    const pr = p as Record<string, unknown>;
    const rid = str(pr['requestId']);
    if (rid && PENDING_SET.has(String(pr['kind']))) out.pending = { requestId: rid, kind: pr['kind'] as PendingKind };
  }
  const cost = num(r['costUsd']);
  if (cost !== undefined && cost >= 0) out.costUsd = cost;
  const model = str(r['model'])?.trim();
  if (model) out.model = model.slice(0, LIMITS.modelChars);
  if (EFFORT_SET.has(String(r['effort']))) out.effort = r['effort'] as EffortLevel;
  const context = normalizeContext(r['context']);
  if (context) out.context = context;
  const report = normalizeReport(r['lastReport']);
  if (report) out.lastReport = report;
  const plans = normalizePlans(r['plans']);
  if (plans) out.plans = plans;
  return out;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Context use: tokens and max must be finite (max above 0); pct is clamped to 0..100 (worked out from the others when bad). */
function normalizeContext(raw: unknown): AgentView['context'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (!isNum(c['tokens']) || !isNum(c['max']) || c['max'] <= 0) return undefined;
  const tokens = Math.max(0, c['tokens']);
  const max = c['max'];
  const pct = clamp(isNum(c['pct']) ? c['pct'] : (tokens / max) * 100, 0, 100);
  const out: NonNullable<AgentView['context']> = { tokens, max, pct };
  if (c['approx'] === true) out.approx = true;
  return out;
}

/** The latest finished turn's text, capped at LIMITS.reportChars. */
function normalizeReport(raw: unknown): AgentView['lastReport'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (!isNum(c['at']) || typeof c['text'] !== 'string' || c['text'].trim() === '') return undefined;
  const cut = c['text'].length > LIMITS.reportChars;
  const out: NonNullable<AgentView['lastReport']> = { at: c['at'], text: cut ? c['text'].slice(0, LIMITS.reportChars) : c['text'] };
  if (cut || c['truncated'] === true) out.truncated = true;
  return out;
}

/** Recent plans, oldest first, the newest LIMITS.plansPerAgent kept. Entries without an id, time or valid status are dropped. */
function normalizePlans(raw: unknown): PlanRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PlanRef[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const p = e as Record<string, unknown>;
    if (typeof p['id'] !== 'string' || p['id'] === '' || p['id'].length > LIMITS.idChars) continue;
    if (!isNum(p['at']) || !PLAN_STATUS_SET.has(String(p['status']))) continue;
    const title = (typeof p['title'] === 'string' ? p['title'].trim() : '').slice(0, LIMITS.planTitleChars);
    const plan: PlanRef = { id: p['id'], at: p['at'], title: title || 'Untitled plan', status: p['status'] as PlanStatus, chars: isNum(p['chars']) ? Math.max(0, p['chars']) : 0 };
    if (isNum(p['decidedAt'])) plan.decidedAt = p['decidedAt'];
    out.push(plan);
  }
  return out.length > 0 ? out.slice(-LIMITS.plansPerAgent) : undefined;
}

/** True when an agent has been idle long enough to leave its desk. */
export function isWandering(a: AgentView, hostNow: number): boolean {
  const idleLike = a.activity === 'idle' || (a.kind === 'main' && a.status === 'done');
  return idleLike && hostNow >= a.since + IDLE_WANDER_AFTER_MS;
}

/** True when an agent belongs in the queue at the manager's door. */
export function wantsQueue(a: AgentView): boolean {
  return a.activity === 'needsYou' && a.status !== 'done';
}

/** Queue order: whoever started waiting first is at the door. */
export function queueOrder(waiting: readonly { id: string; since: number }[]): string[] {
  return [...waiting].sort((a, b) => (a.since - b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((a) => a.id);
}

/** Chooses a free solo idle spot for `who`, avoiding `avoid` if possible. Returns its key or null. */
export function chooseWanderSpot(spots: Spots, res: Reservations, who: string, rng: () => number, avoid?: string | null): string | null {
  const free = spots.idle.filter((s) => res.isFree(s.key, who));
  if (free.length === 0) return null;
  const others = free.filter((s) => s.key !== avoid);
  return pick(rng, others.length > 0 ? others : free).key;
}

/** Inputs for one character's decision. */
export interface DecideInput {
  id: string;
  seat: SeatDef | null;
  agent: AgentView;
  leaving: boolean;
  /** Position in the door queue, or -1. */
  queueIndex: number;
  /** Chosen solo idle spot (when wandering), or null. */
  wanderKey: string | null;
  /** Water-cooler slot (0/1) when in a chat, or -1. */
  chatSlot: number;
}

/** Shared context for decisions. */
export interface DecideCtx {
  spots: Spots;
  res: Reservations;
  hostNow: number;
  /** Solo spots that exist only for now (the food cart's), besides `spots.idle`. */
  extraSpots?: readonly NamedSpot[];
}

const SEAT_POSE: Partial<Record<Activity, Pose>> = {
  reading: 'sitRead',
  searching: 'sitType',
  researching: 'sitType',
  writing: 'sitType',
  drawing: 'sitType',
  running: 'sitRun',
  copier: 'sitRun',
  planning: 'sitType',
  thinking: 'sitThink',
  shredding: 'sitType',
};

function spotGoal(n: NamedSpot, pose?: Pose): Goal {
  const g: Goal = { key: n.key, tile: n.spot.tile, facing: n.spot.facing, pose: pose ?? n.spot.pose, away: true, reserve: n.key };
  if (n.prop) g.prop = n.prop;
  return g;
}

/** The character's own desk (or, without a seat, a free standing spot in the lobby). */
export function seatGoal(d: DecideInput, ctx: DecideCtx, pose: Pose, screen?: string): Goal {
  if (d.seat) {
    const g: Goal = { key: `seat:${d.seat.id}`, tile: d.seat.tile, facing: d.seat.facing, pose, away: false };
    if (screen) g.screen = screen;
    return g;
  }
  const spot = ctx.spots.lobby.find((s) => ctx.res.isFree(s.key, d.id));
  if (spot) return { ...spotGoal(spot, 'stand'), away: false };
  return { key: 'lobby:crowd', tile: ctx.spots.elevator.tile, facing: 'down', pose: 'stand', away: false };
}

function firstFree(list: readonly NamedSpot[], ctx: DecideCtx, who: string): NamedSpot | undefined {
  return list.find((s) => ctx.res.isFree(s.key, who));
}

/** Where a character wants to be right now and in which pose. */
export function desiredGoal(d: DecideInput, ctx: DecideCtx): Goal {
  if (d.leaving) return { key: 'exit', tile: ctx.spots.elevator.tile, facing: 'down', pose: 'stand', away: true };
  const a = d.agent;
  const act: Activity = a.kind === 'main' && a.status === 'done' ? 'idle' : a.activity;
  switch (act) {
    case 'needsYou': {
      const q = d.queueIndex >= 0 ? ctx.spots.queue[d.queueIndex] : undefined;
      if (q) return { key: q.key, tile: q.spot.tile, facing: q.spot.facing, pose: d.queueIndex === 0 ? 'knock' : 'stand', away: true };
      return seatGoal(d, ctx, 'sitIdle');
    }
    case 'searching': {
      const s = firstFree(ctx.spots.cabinets, ctx, d.id);
      return s ? spotGoal(s) : seatGoal(d, ctx, 'sitType');
    }
    case 'drawing':
      return ctx.res.isFree(ctx.spots.easel.key, d.id) ? spotGoal(ctx.spots.easel) : seatGoal(d, ctx, 'sitType', 'drawing');
    case 'copier': {
      const s = firstFree(ctx.spots.copier, ctx, d.id);
      return s ? spotGoal(s) : seatGoal(d, ctx, 'sitRun');
    }
    case 'planning':
      return ctx.res.isFree(ctx.spots.whiteboard.key, d.id) ? spotGoal(ctx.spots.whiteboard) : seatGoal(d, ctx, 'sitType');
    case 'shredding': {
      const s = firstFree(ctx.spots.shredder, ctx, d.id);
      return s ? spotGoal(s) : seatGoal(d, ctx, 'sitType');
    }
    case 'delegating': {
      const rx = ctx.spots.reception.tile.x;
      if (d.seat) {
        const v = d.seat.visit.tile;
        const facing: Dir = v.x > rx ? 'left' : v.x < rx ? 'right' : 'down';
        return { key: `delegate:${d.seat.id}`, tile: v, facing, pose: 'point', away: false };
      }
      return ctx.res.isFree(ctx.spots.delegate.key, d.id) ? spotGoal(ctx.spots.delegate) : seatGoal(d, ctx, 'stand');
    }
    case 'idle': {
      if (!isWandering(a, ctx.hostNow)) return seatGoal(d, ctx, 'sitIdle');
      const cooler = d.chatSlot >= 0 ? ctx.spots.cooler[d.chatSlot] : undefined;
      if (cooler) return spotGoal(cooler);
      const w = d.wanderKey ? [...ctx.spots.idle, ...(ctx.extraSpots ?? [])].find((s) => s.key === d.wanderKey) : undefined;
      if (w && ctx.res.isFree(w.key, d.id)) return spotGoal(w);
      return seatGoal(d, ctx, 'sitIdle');
    }
    default:
      return seatGoal(d, ctx, SEAT_POSE[act] ?? 'sitType');
  }
}
