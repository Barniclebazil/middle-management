/**
 * Per-character state and movement: following an A* path with smooth pixel
 * movement, switching between the walk pose and the goal's pose.
 */
import type { CoffeeState } from './coffeeLogic.ts';
import type { AgentView, Goal } from './targets.ts';
import type { Dir, Pose, SeatDef, Tile } from './types.ts';
import { SEATED_POSES, feetTile, tileFeet } from './types.ts';
import { findPath } from './path.ts';

/**
 * Walking speed in map px/s. The art suggests 36 px/s, which makes crossing
 * the 736 px office take 20 s; 70 px/s keeps trips lively without looking
 * frantic (about 3-5 s for a typical trip across the bullpen).
 */
export const WALK_SPEED = 70;
/** Walk-cycle playback rate relative to the art's 140 ms frames (legs keep up with the faster pace). */
export const WALK_ANIM_RATE = 1.5;

export type CharKind = 'manager' | 'receptionist' | 'cleaner' | 'vendor' | 'itSupport' | 'main' | 'temp';

/** Something a character says (chat line or boss-ism). */
export interface Saying { text: string; until: number }

export interface Char {
  id: string;
  kind: CharKind;
  look: string;
  seat: SeatDef | null;
  /** Latest snapshot (null for the manager, the receptionist, the cleaner and the vendor). */
  agent: AgentView | null;
  /** Feet position in map px. */
  x: number;
  y: number;
  /** Remaining pixel waypoints (feet positions). */
  waypoints: { x: number; y: number }[];
  goal: Goal | null;
  arrived: boolean;
  arrivedAt: number;
  pose: Pose;
  dir: Dir;
  /** When the current pose started (local ms), for animation timing. */
  poseStart: number;
  /** Walking out to the elevator; removed on arrival. */
  leaving: boolean;
  removed: boolean;
  /** Idle wandering: chosen spot and when to reconsider it. */
  wanderKey: string | null;
  wanderUntil: number;
  /** Detail text bubble. */
  detailText: string | null;
  detailUntil: number;
  lastDetail: string | undefined;
  say: Saying | null;
  /** An icon that hangs over the head while a mood lasts (the boss's storm cloud while he sulks), or null. */
  moodIcon: string | null;
  /** The agent's mug (null for the manager and the receptionist); see `coffeeLogic.ts`. */
  coffee: CoffeeState | null;
}

export function newChar(id: string, kind: CharKind, look: string, seat: SeatDef | null, x: number, y: number, t: number): Char {
  return {
    id, kind, look, seat, agent: null, x, y, waypoints: [], goal: null, arrived: true, arrivedAt: t,
    pose: 'stand', dir: 'down', poseStart: t, leaving: false, removed: false,
    wanderKey: null, wanderUntil: 0, detailText: null, detailUntil: 0, lastDetail: undefined, say: null, moodIcon: null, coffee: null,
  };
}

/** True when the character is drawn with seated frames. */
export function isSeated(c: Char): boolean {
  return c.arrived && SEATED_POSES.has(c.pose);
}

/** The tile the character's feet are on. */
export function charTile(c: Char, size = 16): Tile {
  return feetTile(c.x, c.y, size);
}

function arrive(c: Char, t: number): void {
  c.arrived = true;
  c.arrivedAt = t;
  c.waypoints = [];
  if (c.goal) {
    c.pose = c.goal.pose;
    c.dir = c.goal.facing;
  }
  c.poseStart = t;
}

/** Puts the character straight onto its goal (no walking). */
export function placeAtGoal(c: Char, goal: Goal, t: number, size = 16): void {
  const f = tileFeet(goal.tile, size);
  c.x = f.x;
  c.y = f.y;
  c.goal = goal;
  arrive(c, t);
}

/** Map data needed for routing. */
export interface RouteMap { grid: Uint8Array; w: number; h: number; tile: number }

/**
 * Sets a new goal and plans a path to it from the current position. If the
 * character is already there it simply arrives; if no path exists it is
 * placed directly (never stuck).
 */
export function routeTo(c: Char, goal: Goal, t: number, map: RouteMap): void {
  c.goal = goal;
  const size = map.tile;
  const target = tileFeet(goal.tile, size);
  if (Math.abs(c.x - target.x) < 0.01 && Math.abs(c.y - target.y) < 0.01) {
    c.x = target.x;
    c.y = target.y;
    arrive(c, t);
    return;
  }
  const start = charTile(c, size);
  const path = findPath(map.grid, map.w, map.h, start, goal.tile);
  if (!path) {
    placeAtGoal(c, goal, t, size);
    return;
  }
  const pts = path.map((p) => tileFeet(p, size));
  // Skip the start tile's centre when we're already between it and the next tile.
  if (pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const sameRow = a.y === b.y && Math.abs(c.y - a.y) < 0.01 && Math.min(a.x, b.x) - 0.01 <= c.x && c.x <= Math.max(a.x, b.x) + 0.01;
    const sameCol = a.x === b.x && Math.abs(c.x - a.x) < 0.01 && Math.min(a.y, b.y) - 0.01 <= c.y && c.y <= Math.max(a.y, b.y) + 0.01;
    if (sameRow || sameCol) pts.shift();
  }
  c.waypoints = pts;
  if (c.arrived || c.pose !== 'walk') {
    c.poseStart = t;
  }
  c.arrived = false;
  c.pose = 'walk';
}

function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  if (Math.abs(dy) > 0) return dy > 0 ? 'down' : 'up';
  return fallback;
}

/** Advances the character along its path. Returns true if it arrived during this step. */
export function stepChar(c: Char, dtMs: number, t: number, speed = WALK_SPEED): boolean {
  if (c.arrived) return false;
  let budget = (speed * dtMs) / 1000;
  while (budget > 0 && c.waypoints.length > 0) {
    const wp = c.waypoints[0]!;
    const dx = wp.x - c.x;
    const dy = wp.y - c.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist > 0) c.dir = dirOf(dx, dy, c.dir);
    if (dist <= budget) {
      c.x = wp.x;
      c.y = wp.y;
      budget -= dist;
      c.waypoints.shift();
    } else {
      // 4-directional paths: move along one axis at a time.
      if (Math.abs(dx) > 0.001) c.x += Math.sign(dx) * Math.min(budget, Math.abs(dx));
      else c.y += Math.sign(dy) * Math.min(budget, Math.abs(dy));
      budget = 0;
    }
  }
  if (c.waypoints.length === 0) {
    arrive(c, t);
    return true;
  }
  return false;
}
