/**
 * Which bubbles and labels to show, and where to put them so they don't pile
 * on top of each other. DOM-free: sizes are measured by the caller.
 */
import type { Activity } from '../../src/shared/protocol.ts';
import type { Char } from './characters.ts';
import { isSeated } from './characters.ts';
import { slotName } from './theme.ts';
import type { ThemeState } from './theme.ts';

/** At most this many text bubbles at once; the rest fall back to icons. */
export const MAX_TEXT_BUBBLES = 4;

/** Icon shown for each activity (null: no bubble). */
export const ACTIVITY_ICON: Readonly<Record<Activity, string | null>> = {
  reading: 'page',
  searching: 'folder',
  researching: 'search',
  writing: 'pencil',
  drawing: 'palette',
  running: 'terminal',
  copier: 'terminal',
  planning: 'clipboard',
  delegating: 'clipboard',
  thinking: 'thinking',
  needsYou: 'alert',
  shredding: 'shred',
  idle: null,
};

export interface BubbleReq {
  /** Stable key (per character and type) so placement can be sticky. */
  key: string;
  charId: string;
  type: 'icon' | 'text' | 'label';
  icon?: string;
  text?: string;
  style: 'speech' | 'thought';
  /**
   * Bubbles - above: tail tip; left: right edge and bottom; right: left edge and top.
   * Labels - above: centre x and bottom y; right: left edge and centre y.
   */
  ax: number;
  ay: number;
  side: 'above' | 'left' | 'right';
  /** Fixed items are placed first and never moved. */
  fixed: boolean;
  priority: number;
  /** For text bubbles: the icon to fall back to when over the cap. */
  fallbackIcon?: string;
  /** Sits on top of this character's name label (the anchor is moved up by the label's height). */
  overLabel?: boolean;
  /** Drawn with the highlight colour (the character picked in the roster). */
  highlight?: boolean;
  /** Gently bobs (a knocking worker with an open request the user can answer). */
  pulse?: boolean;
  /** A text bubble showing an activity detail (file, command, query) rather than something said: it wraps to fewer rows. */
  detail?: boolean;
}

export interface BubbleSettings {
  speechBubbles: boolean;
  managerName: string;
  /** A character to call out with a name label (hovered in the roster or the office). */
  highlightId?: string | null;
  /** Theme names by slot: a named person is labelled with their name instead of the session title. */
  theme?: ThemeState;
  /** Extra pixels a look's head rises above the usual height (a tall build). */
  headLift?: (look: string) => number;
}

/** Her label when the theme gives her neither a name nor a title. */
const RECEPTIONIST_LABEL = 'Receptionist';

/** Anchor y for a bubble tail above a character's head. */
export function headAnchorY(c: Char, lift = 0): number {
  return c.y - (isSeated(c) ? 23 : 25) - lift;
}

/** Collects the bubbles and labels for this frame. */
export function collectBubbles(chars: readonly Char[], manager: Char, queue: readonly string[], s: BubbleSettings, t: number, receptionist?: Char, cleaner?: Char, vendor?: Char, others: readonly Char[] = []): BubbleReq[] {
  const out: BubbleReq[] = [];
  // While the boss stands behind a worker (snooping), that worker's activity bubbles stay down so he can be seen over their shoulder.
  const snooped = manager.arrived && manager.goal?.key.startsWith('snoop:') ? manager.goal.key.slice('snoop:'.length) : null;
  for (const c of chars) {
    if (c.removed || !c.agent) continue;
    const a = c.agent;
    const ay = headAnchorY(c, s.headLift?.(c.look));
    const qi = queue.indexOf(c.id);
    const queued = qi >= 0 && (c.goal?.key.startsWith('queue:') ?? false);
    const hl = s.highlightId === c.id;
    const label = slotName(s.theme, c.look) ?? a.title;
    if (queued) {
      out.push({ key: `${c.id}:label`, charId: c.id, type: 'label', text: label, style: 'speech', ax: c.x + 7, ay: c.y - 15, side: 'right', fixed: true, priority: 100, highlight: hl });
      const side = c.arrived ? 'left' : 'above';
      out.push({
        key: `${c.id}:alert`, charId: c.id, type: 'icon', icon: 'alert', style: 'speech',
        ax: side === 'left' ? c.x - 7 : c.x, ay: side === 'left' ? c.y - 12 : ay, side, fixed: side === 'left', priority: 90,
        pulse: !!a.pending,
      });
      continue;
    }
    if (hl) out.push({ key: `${c.id}:label`, charId: c.id, type: 'label', text: label, style: 'speech', ax: c.x, ay: ay - 1, side: 'above', fixed: true, priority: 100, highlight: true });
    if (!s.speechBubbles || c.leaving || c.id === snooped) continue;
    const icon = ACTIVITY_ICON[a.activity] ?? null;
    if (c.say && t < c.say.until) {
      out.push({ key: `${c.id}:say`, charId: c.id, type: 'text', text: c.say.text, style: 'speech', ax: c.x, ay, side: 'above', fixed: false, priority: 80, overLabel: hl });
    } else if (c.detailText && t < c.detailUntil) {
      const r: BubbleReq = {
        key: `${c.id}:detail`, charId: c.id, type: 'text', text: c.detailText, style: a.activity === 'thinking' ? 'thought' : 'speech',
        ax: c.x, ay, side: 'above', fixed: false, priority: 60 + (c.detailUntil - t) / 1e6, overLabel: hl, detail: true,
      };
      if (icon) { r.icon = icon; r.fallbackIcon = icon; }
      out.push(r);
    } else if (icon && a.status !== 'done' && a.activity !== 'idle') {
      out.push({
        key: `${c.id}:icon`, charId: c.id, type: 'icon', icon, style: a.activity === 'thinking' ? 'thought' : 'speech', ax: c.x, ay, side: 'above', fixed: false, priority: 40, overLabel: hl,
        pulse: icon === 'alert' && !!a.pending,
      });
    } else if (c.arrived && c.goal?.key === 'idle:coffee') {
      out.push({ key: `${c.id}:icon`, charId: c.id, type: 'icon', icon: 'coffee', style: 'thought', ax: c.x, ay, side: 'above', fixed: false, priority: 30, overLabel: hl });
    }
  }
  // Manager: name label always; boss-isms above it, else his mood: the storm cloud while he sulks, shown even with speech bubbles off.
  const may = headAnchorY(manager, s.headLift?.(manager.look));
  out.push({ key: 'mgr:label', charId: manager.id, type: 'label', text: s.managerName, style: 'speech', ax: manager.x, ay: may + 1, side: 'above', fixed: true, priority: 100, highlight: s.highlightId === manager.id });
  if (manager.say && t < manager.say.until) {
    out.push({ key: 'mgr:say', charId: manager.id, type: 'text', text: manager.say.text, style: 'speech', ax: manager.x, ay: may + 1, side: 'above', fixed: false, priority: 95, overLabel: true });
  } else if (manager.moodIcon) {
    out.push({ key: 'mgr:mood', charId: manager.id, type: 'icon', icon: manager.moodIcon, style: 'thought', ax: manager.x, ay: may + 1, side: 'above', fixed: false, priority: 45, overLabel: true });
  }
  // Receptionist: her name label shows only while she is highlighted (hovered); her lines follow the speech-bubble setting.
  if (receptionist) {
    const ray = headAnchorY(receptionist, s.headLift?.(receptionist.look));
    const rhl = s.highlightId === receptionist.id;
    if (rhl) {
      out.push({ key: 'rec:label', charId: receptionist.id, type: 'label', text: s.theme?.receptionistName ?? s.theme?.titles?.receptionist ?? RECEPTIONIST_LABEL, style: 'speech', ax: receptionist.x, ay: ray + 1, side: 'above', fixed: true, priority: 100, highlight: true });
    }
    if (s.speechBubbles && receptionist.say && t < receptionist.say.until) {
      out.push({ key: 'rec:say', charId: receptionist.id, type: 'text', text: receptionist.say.text, style: 'speech', ax: receptionist.x, ay: ray + 1, side: 'above', fixed: false, priority: 85, overLabel: rhl });
    }
  }
  // Cleaner (pass them only while they are in the office): no label, just their mutters, which follow the speech-bubble setting.
  if (cleaner && s.speechBubbles && cleaner.say && t < cleaner.say.until) {
    const cay = headAnchorY(cleaner, s.headLift?.(cleaner.look));
    out.push({ key: 'cln:say', charId: cleaner.id, type: 'text', text: cleaner.say.text, style: 'speech', ax: cleaner.x, ay: cay + 1, side: 'above', fixed: false, priority: 70 });
  }
  // Food cart vendor (pass them only while they are in the office): no label, just their calls, which follow the speech-bubble setting.
  if (vendor && s.speechBubbles && vendor.say && t < vendor.say.until) {
    const vay = headAnchorY(vendor, s.headLift?.(vendor.look));
    out.push({ key: 'vnd:say', charId: vendor.id, type: 'text', text: vendor.say.text, style: 'speech', ax: vendor.x, ay: vay + 1, side: 'above', fixed: false, priority: 70 });
  }
  // Other walk-on characters (the IT pair; pass them only while they are in the office): no label, just their lines, which follow the speech-bubble setting.
  if (s.speechBubbles) {
    for (const c of others) {
      if (!c.say || t >= c.say.until) continue;
      const oay = headAnchorY(c, s.headLift?.(c.look));
      out.push({ key: `${c.id}:say`, charId: c.id, type: 'text', text: c.say.text, style: 'speech', ax: c.x, ay: oay + 1, side: 'above', fixed: false, priority: 72 });
    }
  }
  return capTextBubbles(out);
}

/** Keeps at most MAX_TEXT_BUBBLES text bubbles (highest priority first); the rest become icons or are dropped. */
export function capTextBubbles(reqs: BubbleReq[]): BubbleReq[] {
  const texts = reqs.filter((r) => r.type === 'text').sort((a, b) => b.priority - a.priority);
  const drop = new Set(texts.slice(MAX_TEXT_BUBBLES));
  const out: BubbleReq[] = [];
  for (const r of reqs) {
    if (!drop.has(r)) { out.push(r); continue; }
    if (r.fallbackIcon) out.push({ ...r, type: 'icon', icon: r.fallbackIcon, text: undefined, key: `${r.charId}:icon`, priority: 40 });
  }
  return out;
}

export interface Sized extends BubbleReq {
  w: number;
  h: number;
  tail: number;
  /** Extra lift for `overLabel` bubbles (the label's height plus a gap). */
  labelH?: number;
}
export interface Placed extends Sized { x: number; y: number; /** Pixels the bubble was lifted above its natural spot. */ lift: number }

export interface Box { x: number; y: number; w: number; h: number }

function overlap(a: Box, b: Box, gap: number): number {
  const w = Math.min(a.x + a.w + gap, b.x + b.w + gap) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h + gap, b.y + b.h + gap) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The area bubbles must stay inside (x and y default to 0). */
export interface LayoutBounds { x?: number; y?: number; w: number; h: number }

const DYS = [0, -5, -10, -15, -20, -26];
const DXS = [0, -9, 9, -18, 18];
const CANDIDATES: readonly { dx: number; dy: number }[] = DYS.flatMap((dy) => DXS.map((dx) => ({ dx, dy })))
  .sort((a, b) => (Math.abs(a.dy) + Math.abs(a.dx) * 1.3) - (Math.abs(b.dy) + Math.abs(b.dx) * 1.3));

// Furthest (in bubble px) a bubble may sink towards its speaker's head to clear another; the last resort, after lifting and sliding.
const MAX_SINK = 24;

// Fixed small sinks tried when even that finds no clear spot (the least overlapping offset wins).
const SINKING: readonly { dx: number; dy: number }[] = [5, 10, 15].flatMap((dy) => DXS.map((dx) => ({ dx, dy })))
  .sort((a, b) => (Math.abs(a.dy) + Math.abs(a.dx) * 1.3) - (Math.abs(b.dy) + Math.abs(b.dx) * 1.3));

const steppedCache = new Map<number, readonly { dx: number; dy: number }[]>();
function STEPPED(step: number): readonly { dx: number; dy: number }[] {
  let c = steppedCache.get(step);
  if (!c) {
    c = [...CANDIDATES, ...SINKING].map((o) => ({ dx: o.dx * step, dy: o.dy * step }));
    steppedCache.set(step, c);
  }
  return c;
}

/**
 * Places bubbles: fixed ones where they ask, movable ones at the first
 * nearby offset (lifted up and/or nudged sideways) that doesn't collide with
 * anything placed before. `prev` remembers offsets between frames so
 * bubbles don't jump around; it is updated in place.
 *
 * `step` is the size of one bubble pixel in the units used (1 when laying out
 * in map px; the UI scale when laying out in device px): candidate offsets,
 * gaps and margins are multiplied by it. `obstacles` are boxes (same units) that
 * bubbles should keep clear of, like the "BACK" card under the clock; they are
 * not drawn.
 */
export function layoutBubbles(items: readonly Sized[], bounds: LayoutBounds, prev: Map<string, { dx: number; dy: number }>, step = 1, obstacles: readonly Box[] = []): Placed[] {
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  const base = (r: Sized): Box => {
    if (r.type === 'label') {
      if (r.side === 'right') return { x: Math.round(r.ax), y: Math.round(r.ay - r.h / 2), w: r.w, h: r.h };
      return { x: Math.round(r.ax - r.w / 2), y: Math.round(r.ay - r.h), w: r.w, h: r.h };
    }
    if (r.side === 'left') return { x: Math.round(r.ax - r.w), y: Math.round(r.ay - r.h), w: r.w, h: r.h };
    if (r.side === 'right') return { x: Math.round(r.ax), y: Math.round(r.ay), w: r.w, h: r.h };
    const lift = r.overLabel ? r.labelH ?? 0 : 0;
    return { x: Math.round(r.ax - r.w / 2), y: Math.round(r.ay - lift - r.tail - r.h), w: r.w, h: r.h };
  };
  const clamp = (b: Box): Box => ({
    ...b,
    x: Math.max(bx + step, Math.min(bx + bounds.w - b.w - step, b.x)),
    y: Math.max(by + step, Math.min(by + bounds.h - b.h - step, b.y)),
  });
  const placed: Placed[] = [];
  const fixed = items.filter((r) => r.fixed);
  const movable = items.filter((r) => !r.fixed).sort((a, b) => (b.priority - a.priority) || (a.ay - b.ay));
  for (const r of fixed) {
    const b = clamp(base(r));
    placed.push({ ...r, x: b.x, y: b.y, lift: 0 });
  }
  const seen = new Set<string>();
  for (const r of movable) {
    const b0 = base(r);
    const p = prev.get(r.key);
    let best: Box | null = null;
    let bestCost = Infinity;
    let bestOff = { dx: 0, dy: 0 };
    // True once an offset is collision free; otherwise keeps the least overlapping one seen.
    const tryOffsets = (offs: readonly { dx: number; dy: number }[]): boolean => {
      for (const off of offs) {
        const b = clamp({ ...b0, x: b0.x + off.dx, y: b0.y + off.dy });
        let cost = 0;
        for (const q of placed) cost += overlap(b, q, step);
        for (const q of obstacles) cost += overlap(b, q, step);
        if (cost === 0) { best = b; bestOff = off; bestCost = 0; return true; }
        if (cost < bestCost) { bestCost = cost; best = b; bestOff = off; }
      }
      return false;
    };
    // Natural spot first, then last frame's offset (so bubbles don't hop), then the nearby offsets (up and a nudge sideways, then sinking).
    const near = STEPPED(step);
    const lifts = near.length - SINKING.length;
    const cands = p ? [CANDIDATES[0]!, p, ...near.slice(0, lifts)] : near.slice(0, lifts);
    // Under the top wall lifting is blocked, so then slide clear of whatever is in the way: just past each box's left or right edge, nearest first
    // (the overlay draws a dotted leader from the tail to the speaker when the bubble ends up off to one side).
    const slides = (): { dx: number; dy: number }[] => {
      const out: { dx: number; dy: number }[] = [];
      for (const q of [...placed, ...obstacles]) {
        for (const dx of [q.x + q.w + step - b0.x, q.x - step - r.w - b0.x]) for (const dy of DYS) out.push({ dx, dy: dy * step });
      }
      return out.sort((a, b) => (Math.abs(a.dx) - Math.abs(b.dx)) || (Math.abs(a.dy) - Math.abs(b.dy)));
    };
    // Failing that (a view too narrow for two bubbles side by side) sink just clear of what is above, a little over the head, but never far.
    const sinks = (): { dx: number; dy: number }[] => {
      const out: { dx: number; dy: number }[] = [];
      for (const q of [...placed, ...obstacles]) {
        const dy = q.y + q.h + step - b0.y;
        if (dy > 0 && dy <= MAX_SINK * step) for (const dx of DXS) out.push({ dx: dx * step, dy });
      }
      return out.sort((a, b) => (a.dy - b.dy) || (Math.abs(a.dx) - Math.abs(b.dx)));
    };
    if (!tryOffsets(cands) && !tryOffsets(slides()) && !tryOffsets(sinks())) tryOffsets(near.slice(lifts));
    const b = best ?? clamp(b0);
    prev.set(r.key, bestOff);
    seen.add(r.key);
    placed.push({ ...r, x: b.x, y: b.y, lift: Math.max(0, Math.round((b0.y - b.y) / step)) });
  }
  for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k);
  // Draw order: icons, then text, then labels (labels and alerts stay readable on top).
  const rank = (r: Placed): number => (r.type === 'label' ? 3 : r.icon === 'alert' ? 2 : r.type === 'text' ? 1 : 0);
  return placed.sort((a, b) => (rank(a) - rank(b)) || (a.ay - b.ay));
}
