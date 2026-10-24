/**
 * Clickable office props: which rects can be hit, who wins when several overlap, the tooltip words, and the entries of
 * the Directory panel. Pure (no DOM): the art task owns the anchors and passes them in.
 */
import type { McpStatus } from '../../src/shared/protocol.ts';
import type { TooltipContent } from './tooltip.ts';

/** Every prop that can become a hotspot. */
export const PROP_IDS = [
  'clock', 'calendar', 'inTray', 'whiteboard', 'directoryBoard', 'frontDesk',
  'bookshelf', 'phone', 'tempAgency', 'filingCabinets', 'noticeBoard',
] as const;

export type PropId = (typeof PROP_IDS)[number];

/** The release round a prop becomes clickable in: A = v0.3, B = v0.4 (drawn since v0.3; clickable once `main.ts` enables Round B). */
export type Round = 'A' | 'B';

export const PROP_ROUND: Readonly<Record<PropId, Round>> = {
  clock: 'A', calendar: 'A', inTray: 'A', whiteboard: 'A', directoryBoard: 'A', frontDesk: 'A',
  bookshelf: 'B', phone: 'B', tempAgency: 'B', filingCabinets: 'B', noticeBoard: 'B',
};

/** A map-pixel rectangle. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Map-pixel anchors by prop id (the art's `PROP_ANCHORS`, typed structurally so tests can pass their own). */
export type PropAnchors = Readonly<Partial<Record<PropId, Rect>>>;

export interface Hotspot { id: PropId; rect: Rect; round: Round }

/** What the pointer is over: a character (always wins), a prop, or nothing. */
export type HotspotHit = { kind: 'char'; id: string } | { kind: 'prop'; id: PropId } | null;

export function isPropId(v: unknown): v is PropId {
  return typeof v === 'string' && (PROP_IDS as readonly string[]).includes(v);
}

const validRect = (r: Rect | undefined): r is Rect =>
  !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0;

/** The clickable props for the enabled rounds, in `PROP_IDS` order. Props without a usable anchor are left out. */
export function buildHotspots(anchors: PropAnchors, rounds: ReadonlySet<Round>): Hotspot[] {
  const out: Hotspot[] = [];
  for (const id of PROP_IDS) {
    const round = PROP_ROUND[id];
    const rect = anchors[id];
    if (rounds.has(round) && validRect(rect)) out.push({ id, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, round });
  }
  return out;
}

/**
 * What a click or hover at a map-pixel point hits. `charHit` is the id of the character under the point (from
 * `Office.hitTest`), or null: a character always wins. Among props the smallest rect wins; equal areas go to the one
 * listed first in `PROP_IDS`. Rects include their left and top edge and exclude the right and bottom one.
 */
export function hotspotAt(mapX: number, mapY: number, hotspots: readonly Hotspot[], charHit: string | null): HotspotHit {
  if (charHit !== null) return { kind: 'char', id: charHit };
  let best: Hotspot | null = null;
  let bestArea = Infinity;
  for (const h of hotspots) {
    const r = h.rect;
    if (mapX < r.x || mapX >= r.x + r.w || mapY < r.y || mapY >= r.y + r.h) continue;
    const area = r.w * r.h;
    if (area < bestArea) { best = h; bestArea = area; }
  }
  return best ? { kind: 'prop', id: best.id } : null;
}

const PROP_TIPS: Readonly<Record<PropId, { title: string; lines: string[]; hint?: string }>> = {
  clock: { title: 'Usage clock', lines: ['Your 5-hour usage window'], hint: 'Click to open Usage' },
  calendar: { title: 'Wall calendar', lines: ['Your weekly usage window'], hint: 'Click to open Usage' },
  inTray: { title: 'In-tray', lines: ['Finished reports, plans, questions and approvals'], hint: 'Click to open the In-tray' },
  whiteboard: { title: 'Plans board', lines: ['Plans waiting for sign-off, approved or sent back'], hint: 'Click to open Plans' },
  directoryBoard: { title: 'Building directory', lines: ['Where to find the office tools'], hint: 'Click to open the Directory' },
  frontDesk: { title: 'Front desk', lines: ['Theme, names, colours and settings'], hint: 'Click to open the Front desk' },
  bookshelf: { title: 'Bookshelf', lines: ['The training library: skills and commands'], hint: 'Click to open the Training library' },
  phone: { title: 'Phone', lines: ['The MCP servers your workers can call'], hint: 'Click to open the Phone' },
  tempAgency: { title: 'Temp agency', lines: ['The subagent types you can hire'], hint: 'Click to open the Temp agency' },
  filingCabinets: { title: 'Filing cabinets', lines: ['Browse the files in your projects'], hint: 'Click to open the File room' },
  noticeBoard: { title: 'Notice board', lines: ['The office handbook: CLAUDE.md, memory and permissions'], hint: 'Click to open the Office handbook' },
};

/** Hover text for a prop. Every prop says what a click does (the webview drops the hint for a prop whose panel is not registered). */
export function propTooltip(id: PropId): TooltipContent {
  const t = PROP_TIPS[id];
  const tip: TooltipContent = { title: t.title, lines: [...t.lines] };
  if (t.hint) tip.hint = t.hint;
  return tip;
}

/** What the office remembers of the last catalog replies (the phone's line statuses, the bookshelf's count); absent before any. */
export interface PropCatalog {
  lights?: readonly McpStatus[] | undefined;
  shelf?: number | undefined;
}

/**
 * The live line a Round B prop's tooltip adds once a panel has fetched its data, so the phone's lights and the bookshelf's fill
 * can be read: "5 lines · 1 failed · 1 needs sign-in", "12 skills and commands, one book each". Null when there is nothing yet.
 */
export function catalogTipLine(id: PropId, data: PropCatalog): string | null {
  if (id === 'phone' && data.lights) {
    const n = data.lights.length;
    if (!n) return 'No lines set up';
    const count = (s: McpStatus): number => data.lights?.filter((x) => x === s).length ?? 0;
    const parts = [`${n} ${n === 1 ? 'line' : 'lines'}`];
    if (count('failed')) parts.push(`${count('failed')} failed`);
    if (count('needsAuth')) parts.push(`${count('needsAuth')} needs sign-in`);
    if (count('pending')) parts.push(`${count('pending')} connecting`);
    return parts.join(' · ');
  }
  if (id === 'bookshelf' && data.shelf !== undefined && Number.isFinite(data.shelf)) {
    const n = Math.max(0, Math.floor(data.shelf));
    if (n === 0) return 'Empty shelves: no skills or commands yet';
    return `${n} ${n === 1 ? 'skill or command' : 'skills and commands'}, one book each`;
  }
  return null;
}

/** Panel ids the drawer knows in Round A. */
export type PanelId = 'inbox' | 'plans' | 'usage' | 'directory' | 'frontdesk';

/** Panels Round B adds (the file room, the training library, the phone, the office handbook and the temp agency). */
export type RoundBPanelId = 'files' | 'library' | 'phone' | 'handbook' | 'agency';

/** Pixel icon names in the icon registry (Round A first, then Round B). */
export type IconName = 'inTray' | 'plans' | 'usage' | 'bell' | 'directory' | 'newTask' | 'files' | 'library' | 'phone' | 'handbook' | 'agency';

/** One row of the Directory panel (and one button of the icon bar). */
export interface DirectoryEntry {
  /** The panel it opens, or 'newTask' for the memo. */
  panel: PanelId | RoundBPanelId | 'newTask';
  label: string;
  /** The prop that gets highlighted while the entry is hovered, when there is one. */
  prop?: PropId;
  icon: IconName;
  /** One line under the label. */
  hint: string;
}

/** Entries of the Directory panel, in order. Round B entries come last and appear only when Round B is enabled. */
export function directoryEntries(rounds: ReadonlySet<Round>): DirectoryEntry[] {
  const out: DirectoryEntry[] = [
    { panel: 'inbox', label: 'In-tray', prop: 'inTray', icon: 'inTray', hint: 'Finished reports, plans, questions and approvals' },
    { panel: 'plans', label: 'Plans', prop: 'whiteboard', icon: 'plans', hint: 'Plans waiting for sign-off, approved or sent back' },
    { panel: 'usage', label: 'Usage', prop: 'clock', icon: 'usage', hint: 'Your 5-hour and weekly limits' },
    { panel: 'frontdesk', label: 'Front desk', prop: 'frontDesk', icon: 'bell', hint: 'Theme, names, colours and settings' },
    { panel: 'newTask', label: 'New task', icon: 'newTask', hint: 'Hand out a new task' },
  ];
  if (rounds.has('B')) {
    out.push(
      { panel: 'files', label: 'File room', prop: 'filingCabinets', icon: 'files', hint: 'Browse project files' },
      { panel: 'library', label: 'Training library', prop: 'bookshelf', icon: 'library', hint: 'Skills and slash commands' },
      { panel: 'phone', label: 'Phone', prop: 'phone', icon: 'phone', hint: 'MCP servers and their status' },
      { panel: 'handbook', label: 'Office handbook', prop: 'noticeBoard', icon: 'handbook', hint: 'CLAUDE.md, memory and permission rules' },
      { panel: 'agency', label: 'Temp agency', prop: 'tempAgency', icon: 'agency', hint: 'Subagent types you can hire' },
    );
  }
  return out;
}
