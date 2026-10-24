/**
 * The glue between the office webview and its panels, as pure functions (no DOM, so they are tested in Node and compile
 * under the root tsconfig): which panel a prop opens, what the scene extras are for the current data, the saved-state
 * shape, and the in-tray read store.
 *
 * `main.ts` and `panels.ts` own the DOM side (hit-testing the canvas, mounting the drawer); everything that decides
 * "what" lives here.
 */
import type { InboxReadStore } from '../../src/shared/panels.ts';
import { FRONT_DESK_TABS, MCP_STATUSES } from '../../src/shared/protocol.ts';
import type { FrontDeskTab, HostToWebview, McpStatus, UsageSnapshot } from '../../src/shared/protocol.ts';
import { deriveInbox, badge, pruneRead } from './inboxLogic.ts';
import type { InboxReadLookup } from './inboxLogic.ts';
import { isPropId } from './hotspots.ts';
import type { PropId } from './hotspots.ts';
import { planBoard, planNoteCounts } from './plansLogic.ts';
import type { PlanColumn } from './plansLogic.ts';
import { backAt, contextPile, ringState } from './usageLogic.ts';
import type { UsageLevel } from './usageLogic.ts';
import type { AgentView } from './targets.ts';
import { DRAFT_MAX_BYTES } from './frontDeskLogic.ts';
import { setUpdate } from './updateStore.ts';

// ---------------------------------------------------------------------------
// Props -> panels

/**
 * The panel a click on a prop opens. Every prop has one. The Round B props only take clicks while `main.ts` has Round B
 * enabled (`buildHotspots` leaves them out otherwise), and `panelForProp` still needs the panel to be registered.
 */
export const PROP_PANEL: Readonly<Partial<Record<PropId, string>>> = {
  clock: 'usage',
  calendar: 'usage',
  inTray: 'inbox',
  whiteboard: 'plans',
  directoryBoard: 'directory',
  frontDesk: 'frontdesk',
  filingCabinets: 'files',
  bookshelf: 'library',
  phone: 'phone',
  noticeBoard: 'handbook',
  tempAgency: 'agency',
};

/**
 * What a click on a prop does: the panel id to open, or null when the prop has no panel, or its panel is not
 * registered, so the pointer stays an arrow and the click does nothing.
 */
export function panelForProp(id: PropId, has: (panel: string) => boolean): string | null {
  const panel = PROP_PANEL[id];
  return panel !== undefined && has(panel) ? panel : null;
}

/** Narrows a string from the icon bar or the Directory (`prop`) to a prop id, or null. */
export function propOf(id: string | null | undefined): PropId | null {
  return isPropId(id) ? id : null;
}

/** Which prop is outlined: the one under the pointer wins over the one an icon-bar button or Directory row points at. */
export function pickHoverProp(pointer: PropId | null, bar: PropId | null): PropId | null {
  return pointer ?? bar;
}

// ---------------------------------------------------------------------------
// Scene extras

/** The art's `PlanNoteCounts`: pending / approved / rejected. */
export interface PlanNotes { pending: number; approved: number; rejected: number }

/** Plans-board columns -> the art's names: waiting = pending, sentBack = rejected. */
export function planNotesOf(counts: Readonly<Record<PlanColumn, number>>): PlanNotes {
  return { pending: counts.waiting, approved: counts.approved, rejected: counts.sentBack };
}

/** Everything `Scene.render` is given besides the hover (structurally the same as the scene's `SceneExtras`). */
export interface ExtrasData {
  usage?: { pct: number | null; level: UsageLevel; back: string | null };
  week?: { pct: number | null; level: UsageLevel };
  inTray: { count: number; urgent: boolean };
  piles: Record<string, { sheets: number; warn: boolean }>;
  planNotes: PlanNotes;
  /** The phone's lines, from the last `mcp` catalog a panel received. Absent until one has (the phone draws as before). */
  phoneLights?: McpStatus[];
  /** Skills plus commands, from the last `skills` catalog a panel received. Absent until one has (the classic full shelf). */
  shelfCount?: number;
}

export interface ExtrasInput {
  usage: UsageSnapshot | null;
  agents: readonly AgentView[];
  read: InboxReadLookup;
  now: number;
  /** The phone lights to draw (`SceneCatalog.lights`), or undefined for none. */
  phone?: readonly McpStatus[] | undefined;
  /** The bookshelf's book count (`SceneCatalog.shelf`), or undefined for the classic shelf. */
  shelf?: number | undefined;
}

/**
 * The scene extras for the current data. Without a usage reading the clock and calendar stay plain (no ring, blank week);
 * with one, the clock ring is the 5-hour window (plus the BACK plate while it is blocked) and the calendar the weekly one.
 * Desks without a context reading, or with an empty one, get no pile.
 */
export function buildExtras(input: ExtrasInput): ExtrasData {
  const { usage, agents, read, now, phone, shelf } = input;
  const out: ExtrasData = { inTray: { count: 0, urgent: false }, piles: {}, planNotes: { pending: 0, approved: 0, rejected: 0 } };
  if (usage) {
    const ring = ringState(usage, 'five_hour', now);
    const week = ringState(usage, 'seven_day', now);
    out.usage = { pct: ring.pct, level: ring.level, back: backAt(usage, now) };
    out.week = { pct: week.pct, level: week.level };
  }
  const b = badge(deriveInbox(agents, read, now));
  out.inTray = { count: b.count, urgent: b.urgent };
  for (const a of agents) {
    const pile = contextPile(a.context?.pct);
    if (pile.sheets > 0) out.piles[a.id] = pile;
  }
  out.planNotes = planNotesOf(planNoteCounts(planBoard(agents)));
  if (phone) out.phoneLights = [...phone];
  if (shelf !== undefined) out.shelfCount = shelf;
  return out;
}

/** True when two extras would draw the same (so the caller can keep the old object and skip a repaint). */
export function sameExtras(a: ExtrasData | null, b: ExtrasData): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Scene state from the panels' catalog replies (Round B)

/** Problems first, so the four lights the phone has room for show what needs attention; the "+" covers the rest. */
const LIGHT_RANK: Readonly<Record<McpStatus, number>> = { failed: 0, needsAuth: 1, pending: 2, connected: 3, unknown: 4, disabled: 5 };
/** A `pending` line nobody has updated for this long is drawn as `unknown`: the host settles them within seconds, so the poll must have stopped. */
export const PENDING_STALE_MS = 60_000;

/** The statuses of a server list for `SceneExtras.phoneLights`: problems first (failed, needs sign-in, connecting), then the rest. No names. */
export function phoneLightsOf(servers: readonly { status: McpStatus }[]): McpStatus[] {
  return servers.map((s) => s.status).filter((s) => s in LIGHT_RANK).sort((a, b) => LIGHT_RANK[a] - LIGHT_RANK[b]);
}

/** The bookshelf's book count: skills plus commands. */
export function shelfCountOf(skills: number, commands: number): number {
  return Math.max(0, Math.floor(skills)) + Math.max(0, Math.floor(commands));
}

/** A saved `phone` value as a clean status list (bad entries drop, `pending` becomes `unknown`), or undefined when it is not a list. */
function savedLights(raw: unknown): McpStatus[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpStatus[] = [];
  for (const v of raw.slice(0, MAX_LIGHTS)) {
    if (typeof v === 'string' && (MCP_STATUSES as readonly string[]).includes(v)) out.push(v === 'pending' ? 'unknown' : (v as McpStatus));
  }
  return out;
}

/**
 * What the office remembers of the last catalog replies a panel received, for the props: the phone lights (last `mcp` reply)
 * and the bookshelf's count (last `skills` reply). Nothing here asks the host for anything; opening a panel does, and the
 * webview feeds every host message through `observe`. Only statuses and a number are kept, never a name.
 */
export interface SceneCatalog {
  /** Takes a host message; true when the lights or the shelf changed (the caller then rebuilds the extras and saves `saved()`). */
  observe(msg: HostToWebview, now: number): boolean;
  /** The phone lights to draw (a stale `pending` counts as `unknown`), or undefined before any `mcp` reply. */
  lights(now: number): McpStatus[] | undefined;
  /** The bookshelf's book count, or undefined before any `skills` reply. */
  shelf(): number | undefined;
  /** The part of the saved state this owns: `{}` before any reply. */
  saved(): Pick<SavedState, 'phone' | 'shelf'>;
}

export function createSceneCatalog(initial: Pick<SavedState, 'phone' | 'shelf'> = {}, now = 0): SceneCatalog {
  let phone: McpStatus[] | undefined = initial.phone ? [...initial.phone] : undefined;
  let phoneAt = now;
  let shelf: number | undefined = initial.shelf;
  return {
    observe(msg, at) {
      if (msg.type !== 'catalog') return false;
      if (msg.section === 'mcp' && Array.isArray(msg.servers)) {
        const next = phoneLightsOf(msg.servers);
        const same = phone !== undefined && next.length === phone.length && next.every((v, i) => v === phone![i]);
        phone = next;
        phoneAt = at;
        return !same;
      }
      if (msg.section === 'skills' && Array.isArray(msg.skills) && Array.isArray(msg.commands)) {
        const next = shelfCountOf(msg.skills.length, msg.commands.length);
        const same = next === shelf;
        shelf = next;
        return !same;
      }
      return false;
    },
    lights: (at) => (phone && at - phoneAt > PENDING_STALE_MS ? phone.map((s) => (s === 'pending' ? 'unknown' : s)) : phone),
    shelf: () => shelf,
    saved() {
      const out: Pick<SavedState, 'phone' | 'shelf'> = {};
      if (phone) out.phone = phone.map((s) => (s === 'pending' ? 'unknown' : s));
      if (shelf !== undefined) out.shelf = shelf;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// The demo office

/**
 * True for the error the host's demo guard answers the Round B requests with ("Demo workers can't take orders. Turn off demo
 * mode ..."). The webview has no demo flag, so this is how it finds out; a test pins it to `DEMO_REFUSAL`.
 */
export function isDemoRefusal(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith('Demo workers can');
}

// ---------------------------------------------------------------------------
// Saved state

/** Per-webview state VS Code keeps across hide/show and reloads. */
export interface SavedState {
  /** Drawer width shared by the case file and the panel drawer. */
  drawerW?: number;
  tipDone?: boolean;
  /** The view-mode tip was dismissed (apart from `tipDone`, so each mode shows its own tip once). */
  viewTipDone?: boolean;
  /** In-tray read marks: item key -> epoch ms. */
  inboxRead?: Record<string, number>;
  /** The root panel that was open ('inbox', 'plans', ...), reopened after a reload. */
  panel?: string;
  /** The Front desk's unsaved draft (`serializeDraft` text, at most `DRAFT_MAX_BYTES`), restored by the panel when it belongs to the same theme source. */
  fdDraft?: string;
  /** The Front desk tab that was open, so a re-render (an office-mode switch) reopens the same one. */
  fdTab?: FrontDeskTab;
  /**
   * The phone lights last seen, as bare statuses (never a server name) so the phone and shelf survive a hide/show of the view. A
   * `pending` status is saved as `unknown`: nothing would settle it. Replaced by the next MCP reply.
   */
  phone?: McpStatus[];
  /** The bookshelf's last book count (skills plus commands), a plain number. */
  shelf?: number;
}

const MAX_READ_MARKS = 500;
/** More than any real library (the host cuts skills and commands at 300 each). */
const MAX_SHELF = 1000;
/** The host sends at most 100 servers; a saved list longer than that is not ours. */
const MAX_LIGHTS = 100;
const utf8 = new TextEncoder();

/** True when a saved draft is within the cap (the controller's own `serializeDraft` already refuses bigger ones). */
function fitsDraft(text: string): boolean {
  return text.length <= DRAFT_MAX_BYTES && utf8.encode(text).length <= DRAFT_MAX_BYTES;
}

/** Reads whatever `getState()` returned into a clean `SavedState`: wrong types are dropped, never thrown on. */
export function sanitizeSaved(raw: unknown): SavedState {
  const out: SavedState = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r['drawerW'] === 'number' && Number.isFinite(r['drawerW'])) out.drawerW = r['drawerW'];
  if (r['tipDone'] === true) out.tipDone = true;
  if (r['viewTipDone'] === true) out.viewTipDone = true;
  if (typeof r['panel'] === 'string' && /^[a-z][A-Za-z0-9_-]{0,31}$/.test(r['panel'])) out.panel = r['panel'];
  if (typeof r['fdDraft'] === 'string' && fitsDraft(r['fdDraft'])) out.fdDraft = r['fdDraft'];
  const tab = r['fdTab'];
  if (typeof tab === 'string' && (FRONT_DESK_TABS as readonly string[]).includes(tab)) out.fdTab = tab as FrontDeskTab;
  const phone = savedLights(r['phone']);
  if (phone) out.phone = phone;
  const shelf = r['shelf'];
  if (typeof shelf === 'number' && Number.isInteger(shelf) && shelf >= 0 && shelf <= MAX_SHELF) out.shelf = shelf;
  const marks = r['inboxRead'];
  if (marks && typeof marks === 'object' && !Array.isArray(marks)) {
    const read: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(marks as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || k.length > 200) continue;
      read[k] = v;
      if (++n >= MAX_READ_MARKS) break;
    }
    out.inboxRead = read;
  }
  return out;
}

/** The panel to reopen after a reload: the saved one, if it is registered. A `?panel=` URL parameter (the harness) wins. */
export function panelToRestore(saved: SavedState, has: (panel: string) => boolean, forced?: string | null): string | null {
  const id = forced || saved.panel;
  return id && has(id) ? id : null;
}

// ---------------------------------------------------------------------------
// In-tray read store

/** The read store the webview keeps: the panels' interface plus pruning against the items that exist. */
export interface ManagedReadStore extends InboxReadStore {
  /**
   * Drops marks for items that are gone and were marked more than the keep window ago (`pruneRead`). Call it after each
   * agents snapshot, not on load: before the first snapshot nothing is "live" yet. Listeners are told only when a mark went.
   */
  prune(agents: readonly AgentView[], now: number): void;
}

/**
 * An `InboxReadStore` over a plain map. `save` is called with a copy after every change (the webview passes
 * `persist({ inboxRead })`); `subscribe` listeners run after `save`.
 */
export function createInboxReadStore(initial: Readonly<Record<string, number>>, save: (marks: Record<string, number>) => void, now: () => number): ManagedReadStore {
  let marks: Record<string, number> = { ...initial };
  const listeners = new Set<() => void>();
  const changed = (): void => {
    save({ ...marks });
    for (const l of [...listeners]) {
      try { l(); } catch (e) { console.error('inbox listener failed', e); }
    }
  };
  return {
    readAt: (key) => marks[key],
    markRead(key, at) {
      const t = at ?? now();
      if (marks[key] === t) return;
      marks[key] = t;
      changed();
    },
    markUnread(key) {
      if (!(key in marks)) return;
      delete marks[key];
      changed();
    },
    all: () => ({ ...marks }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prune(agents, at) {
      const kept = pruneRead(marks, deriveInbox(agents, { readAt: (k) => marks[k] }, at), at);
      if (Object.keys(kept).length === Object.keys(marks).length) return;
      marks = kept;
      changed();
    },
  };
}

// ---------------------------------------------------------------------------
// The Front desk (task 4.7)

/** Id of the Front desk panel (the icon bar's bell, the Directory row and the `frontDesk` prop all use it). */
export const FRONT_DESK_ID = 'frontdesk';

/** What the Front desk panel keeps of its draft: the saved-state key is `fdDraft`; the panel writes `serializeDraft` text or null. */
export interface DraftStore {
  loadState(): unknown;
  saveState(text: string | null): void;
}

/**
 * Maps the panel's `loadState`/`saveState` onto the webview's saved state. Text over the cap is dropped rather than kept (the
 * controller already refuses to serialise one, this is the second lock), and null removes the key.
 */
export function draftStore(saved: Pick<SavedState, 'fdDraft'>, persist: (patch: Partial<SavedState>) => void): DraftStore {
  return {
    loadState: () => saved.fdDraft,
    saveState(text) {
      const keep = text !== null && fitsDraft(text) ? text : undefined;
      if (keep === saved.fdDraft) return;
      persist({ fdDraft: keep });
    },
  };
}

/** The listeners behind `FrontDeskCtx.onHost`: a failing listener never stops the others. */
export interface HostBus {
  subscribe(listener: (msg: HostToWebview) => void): () => void;
  emit(msg: HostToWebview): void;
  readonly size: number;
}

export function createHostBus(): HostBus {
  const listeners = new Set<(msg: HostToWebview) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(msg) {
      for (const l of [...listeners]) {
        try { l(msg); } catch (e) { console.error('host listener failed', e); }
      }
    },
    get size() { return listeners.size; },
  };
}

/**
 * Where a host message goes besides `main.ts`'s own handling:
 *  - `frontDesk` and `frontDeskDone` -> the bus only (the Front desk panel has no `handle`, so sending them to the drawer too
 *    would process them twice);
 *  - `update` -> the bus (the Front desk About tab listens there); `routePanelMessage` also keeps it in `updateStore` first, so a
 *    tab that opens later still has it. `main.ts` must pass `update` to `routePanelMessage(drawer, msg, hostBus)` and may also use it itself;
 *  - `turn`, `planText`, the Round B replies (`catalog`, `fileRoots`, `dirListing`, `fileText`) and an `error` that carries a
 *    `reqId` -> the drawer's mounted panel (a reply for a panel that is not showing is dropped: opening a panel asks again);
 *  - anything else -> null (an `error` without a `reqId` is a toast).
 * `settings` is not listed: `main.ts` applies it first (so `hostTheme()` is current), then emits it on the bus itself.
 */
export function hostRoute(msg: HostToWebview): 'bus' | 'drawer' | null {
  if (msg.type === 'frontDesk' || msg.type === 'frontDeskDone' || msg.type === 'update') return 'bus';
  if (msg.type === 'turn' || msg.type === 'planText') return 'drawer';
  if (msg.type === 'catalog' || msg.type === 'fileRoots' || msg.type === 'dirListing' || msg.type === 'fileText') return 'drawer';
  if (msg.type === 'error' && typeof msg.reqId === 'string') return 'drawer';
  return null;
}

/**
 * Routes a host message to the panels (see `hostRoute`): `turn`, `planText`, the Round B replies and any `error` that carries a `reqId`
 * go to the drawer's mounted panel; `frontDesk` and `frontDeskDone` go to the bus (the Front desk's `onHost` listeners) and never to the drawer.
 * Returns true when the message was one of those (so the caller does not also toast it).
 */
export function routePanelMessage(drawer: { handle(msg: HostToWebview): unknown }, msg: HostToWebview, bus?: Pick<HostBus, 'emit'>): boolean {
  const route = hostRoute(msg);
  if (route === 'bus') {
    if (msg.type === 'update') setUpdate(msg.update);
    bus?.emit(msg);
    return true;
  }
  if (route === 'drawer') {
    drawer.handle(msg);
    return true;
  }
  return false;
}

/** What the webview does when the drawer's shown panel changes. */
export interface PanelChange {
  /** The root panel after the change (a sub-view keeps its parent; a suspended drawer keeps its root). */
  root: string | null;
  /** Which icon-bar button is pressed. */
  barCurrent: string | null;
  /** What saved state keeps as the open panel: an id, undefined (clear it) or 'keep' (hidden behind a case file, so it comes back). */
  savedPanel: string | undefined | 'keep';
  /** The receptionist looks up while the Front desk is the shown (or sub-view-covered) root. False while hidden or closed. */
  attending: boolean;
}

/**
 * The drawer's `onChange(id)` as a pure function. `id` is the shown view (a sub-view's own id, or null when closed or
 * suspended), `suspended` whether a case file is hiding the drawer, `registered` whether an id is a panel (not a sub-view).
 */
export function panelChange(root: string | null, id: string | null, suspended: boolean, registered: (id: string) => boolean): PanelChange {
  if (id === null) {
    return suspended
      ? { root, barCurrent: null, savedPanel: 'keep', attending: false }
      : { root: null, barCurrent: null, savedPanel: undefined, attending: false };
  }
  const next = registered(id) ? id : root;
  return { root: next, barCurrent: next, savedPanel: next ?? undefined, attending: next === FRONT_DESK_ID };
}

/**
 * The dev harness's `?set=<path>=<value>,...` and `?autoedit=1|bad` edits for the Front desk draft, as [path, value] pairs
 * (values `true`/`false` become booleans). Values with commas are not supported.
 */
export function parseStartEdits(params: URLSearchParams): [string, string | boolean][] {
  const out: [string, string | boolean][] = [];
  const auto = params.get('autoedit');
  if (auto === 'bad') out.push(['colors.wall', 'mauve']);
  if (auto !== null) out.push(['company', 'Pennywhistle Paper Co']);
  for (const part of (params.get('set') ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const v = part.slice(eq + 1);
    out.push([part.slice(0, eq).trim(), v === 'true' ? true : v === 'false' ? false : v]);
  }
  return out;
}

/** What the Front desk panel keeps of its tab: the saved-state key is `fdTab`. Only a known tab is kept; an unchanged one is not written again. */
export function tabStore(saved: Pick<SavedState, 'fdTab'>, persist: (patch: Partial<SavedState>) => void): { initialTab: FrontDeskTab | undefined; saveTab(tab: FrontDeskTab): void } {
  return {
    initialTab: saved.fdTab,
    saveTab(tab) {
      if (tab === saved.fdTab || !(FRONT_DESK_TABS as readonly string[]).includes(tab)) return;
      persist({ fdTab: tab });
    },
  };
}
