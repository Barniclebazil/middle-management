/**
 * View mode (`claudeOffice.mode` = 'view'): the office only shows the workers walking around, and the Front desk is the one
 * thing you can open. Pure helpers (no DOM) that `main.ts` calls at boot, so the rules sit in one place and under test.
 */
import { parseOfficeMode } from '../../src/shared/officeMode.ts';
import type { OfficeMode } from '../../src/shared/officeMode.ts';
import type { AgentView } from './targets.ts';
import type { Hotspot, PropId } from './hotspots.ts';
import type { UsageLevel } from './usageLogic.ts';
import type { TooltipContent } from './tooltip.ts';
import { PENDING_WORDS, agentTooltip } from './tooltip.ts';
import { FRONT_DESK_ID } from './panelsWiring.ts';

/** The mode the host rendered into `<body data-office-mode>`; anything unknown (or no dataset) is manager mode. */
export function bootMode(dataset: { officeMode?: string | undefined } | undefined): OfficeMode {
  return parseOfficeMode(dataset?.officeMode);
}

/** The only panel registered in view mode. */
export const VIEW_PANELS: readonly string[] = [FRONT_DESK_ID];

/** Props a click does something for in view mode. */
export const VIEW_CLICKABLE_PROPS: readonly PropId[] = ['frontDesk'];

/** Props that show a tooltip in view mode (the usage clock and calendar read only). */
export const VIEW_TOOLTIP_PROPS: readonly PropId[] = ['frontDesk', 'clock', 'calendar'];

/** A hotspot that survives in view mode; `action` says whether a click does anything (cursor, outline, hint). */
export interface ViewHotspot extends Hotspot { action: boolean }

/** The hotspots left in view mode, in their original order: the Front desk (with an action), the clock and calendar (without). */
export function viewHotspots(hotspots: readonly Hotspot[]): ViewHotspot[] {
  return hotspots
    .filter((h) => VIEW_TOOLTIP_PROPS.includes(h.id))
    .map((h) => ({ ...h, action: VIEW_CLICKABLE_PROPS.includes(h.id) }));
}

/** Replaces the knocking line in view mode: you cannot answer here. */
export const VIEW_KNOCK_OFFICE = 'Switch to manager mode to answer';
export const VIEW_KNOCK_ELSEWHERE = 'Waiting for you in their Claude Code window';

/**
 * `agentTooltip` for view mode: the same facts (name, activity, model, context), but no "Click to…" hint, no "Open in another
 * window" line, and the knocking line says where to answer instead.
 */
export function viewAgentTooltip(a: AgentView, role: string, parentTitle: string | null, hostNow: number, leaving: boolean, waitingTemps = 0, name?: string): TooltipContent {
  const tip = agentTooltip(a, role, parentTitle, hostNow, leaving, waitingTemps, name);
  const knock = a.pending && !leaving ? `Knocking: ${PENDING_WORDS[a.pending.kind]}` : null;
  const lines: string[] = [];
  for (const line of tip.lines) {
    if (line === 'Open in another window (read-only here)') continue;
    lines.push(knock !== null && line === knock ? (a.control === 'office' ? VIEW_KNOCK_OFFICE : VIEW_KNOCK_ELSEWHERE) : line);
  }
  return tip.badge ? { title: tip.title, lines, badge: tip.badge } : { title: tip.title, lines };
}

/** The manager's tooltip in view mode: no hint (a click does nothing). */
export function viewManagerTooltip(tip: TooltipContent): TooltipContent {
  return { title: tip.title, lines: [...tip.lines] };
}

/**
 * A prop's tooltip in view mode, or null when the prop shows none. Pass the tooltip `main.ts` already built (with the live
 * usage line); only the Front desk keeps its "Click to open" hint.
 */
export function viewPropTooltip(id: PropId, tip: TooltipContent): TooltipContent | null {
  if (!VIEW_TOOLTIP_PROPS.includes(id)) return null;
  const out: TooltipContent = { title: tip.title, lines: [...tip.lines] };
  if (VIEW_CLICKABLE_PROPS.includes(id) && tip.hint) out.hint = tip.hint;
  return out;
}

/**
 * The usage fields of the scene's extras, typed structurally so this module never imports `scene.ts` (and with it the canvas art).
 * Any `SceneExtras` or `ExtrasData` fits `ViewExtrasInput`, and a `ViewExtras` fits `SceneExtras`.
 */
export interface ViewExtras {
  usage?: { pct: number | null; level: UsageLevel };
  week?: { pct: number | null; level: UsageLevel };
}
export interface ViewExtrasInput {
  usage?: { pct: number | null; level: UsageLevel; back?: string | null | undefined } | undefined;
  week?: { pct: number | null; level: UsageLevel } | undefined;
}

/** Scene extras in view mode: only the clock's usage ring and the calendar's week fill (no BACK plate, piles, tray, notes, lights, shelf or cabinet). */
export function viewSceneExtras(extras: ViewExtrasInput): ViewExtras {
  const out: ViewExtras = {};
  if (extras.usage) out.usage = { pct: extras.usage.pct, level: extras.usage.level };
  if (extras.week) out.week = extras.week;
  return out;
}

/** First-run tip in view mode. */
export const VIEW_TIP = "Just watching. Hover a worker to see what they're doing. Click the receptionist to change how the office looks.";

/** The same tip while post from head office waits: the receptionist then hands over the memo, and the counter opens the Front desk. */
export const VIEW_TIP_WITH_POST =
  "Just watching. Hover a worker to see what they're doing. Click the receptionist to read the post from head office, or the front desk counter to change how the office looks.";

/** The first-run tip text for view mode; `post` is true while the update cue is on. */
export function viewTipText(post: boolean): string {
  return post ? VIEW_TIP_WITH_POST : VIEW_TIP;
}

/** Sticky-note lines for an empty office in view mode (the last two are the demo hint of `EMPTY_NOTE_LINES`). */
export const VIEW_EMPTY_NOTE_LINES: readonly string[] = [
  'No Claude Code sessions yet.',
  "Start one and they'll walk in.",
  'Or run',
  "'Middle Management: Toggle Demo'",
  'to see the office in action.',
];

/** The same note as one sentence. */
export const VIEW_EMPTY_NOTE = "No Claude Code sessions yet. Start one and they'll walk in. Or run 'Middle Management: Toggle Demo' to see the office in action.";

/** Saved-state key for "the view-mode tip was dismissed" (apart from the manager tip's `tipDone`, so switching mode shows the right tip). */
export const VIEW_TIP_DONE_KEY = 'viewTipDone';
