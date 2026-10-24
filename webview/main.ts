/**
 * Webview entry point: receives agent snapshots and settings from the host,
 * runs the office simulation at ~30 fps (paused while hidden), draws it at 1x
 * offscreen and blits it scaled onto the visible canvas, draws bubbles and
 * labels on top in screen space, shows a hover tooltip and, when the panel has
 * room to spare, a staff roster beside or below the office.
 *
 * Manager Mode: clicking a worker (or their roster row) opens their case file
 * in a drawer on the right; clicking the manager (you) opens the assignment
 * memo. Drag still pans the camera; only a press-and-release without moving
 * counts as a click.
 *
 * Office tools: the icon bar (top left) and the panel drawer (In-tray, Plans, Usage, Directory, the Front desk, and the Round B
 * tools: File room, Training library, Phone, Office handbook, Temp agency) share the right-hand side with the case file; props in
 * the office (clock, calendar, in-tray, whiteboard, lobby board, filing cabinets, bookshelf, phone, notice board, temp agency)
 * hover and click through to the same panels, and the scene shows live extras (usage ring, in-tray badge, desk piles, plan
 * notes, and from the panels' latest replies the phone lights and the bookshelf). Nothing probes Claude or MCP servers on its
 * own: those two props only change once a panel has asked the host. The pure decisions live in `engine/panelsWiring.ts`, the
 * panel registry and context in `engine/panels.ts`.
 *
 * The office strip (v0.5): a wide, short view (the panel moved to the top of the window; `engine/layoutLogic.ts` has the
 * thresholds) is laid out as three columns with nothing over the art: the icon bar as a vertical rail on the left, the map at
 * full height, the staff list on the right. There, clicking a worker (on the map or in the list) posts `openCaseTab` and the
 * host opens their case in an editor tab; narrower views keep the bar on top and the in-office drawer (`openCase`). The staff
 * list marks the workers whose tab is open (`caseTabs`) and its x sends an idle worker home (`sendHome`). The props that open
 * a panel are keyboard stops too (one Tab stop between the bar and the staff list; arrow keys move between them).
 *
 * View mode (`<body data-office-mode="view">`, read once at boot): the office only shows the workers walking around. No icon bar,
 * rail, staff list, New task button or manager tip is built; the Front desk is the only panel; only the receptionist and the
 * counter click (to the Front desk); the clock and calendar keep their usage tooltip; workers and the manager show tooltips
 * without hints and do nothing; the scene extras are usage-only; nothing is posted but what the Front desk and `ready` need. The
 * rules are pure, in `engine/viewModeLogic.ts`; everything here only applies them.
 *
 * Post from head office (an update, both modes): while `showUpdateCue` holds, an envelope sits on the reception counter with a
 * pulsing envelope badge over it and the receptionist mentions it now and then; a click on her, the badge or the envelope opens
 * the head office memo (the rest of the counter still opens the Front desk, and the memo links to it). `engine/updateCue.ts`
 * and `engine/updateMemoView.ts` do the work, `engine/updateCueLogic.ts` has the decisions.
 */
import type { ClaudeDefaults, HostToWebview, OfficeSettings, UsageSnapshot, WebviewToHost } from '../src/shared/protocol.ts';
import type { FrontDeskCtx, MemoPrefill } from '../src/shared/panels.ts';
import {
  ARCHETYPES, ICON_IDS, MAP_H, MAP_PX_H, MAP_PX_W, MAP_W, PROP_ANCHORS, STAFF_SLOT_IDS, TEMP_LOOKS, TEMP_SLOT_IDS, TILE,
  backSignBox, getLook, poi, seats, signRect, tempSeats, walkGrid, POST_BADGE_RECT,
} from './art/index.ts';
import type { IconId } from './art/index.ts';
import type { WorldDef } from './engine/types.ts';
import { Office } from './engine/office.ts';
import { Scene } from './engine/scene.ts';
import { clampCamera, computeView, defaultCamera, fitsWholeMap, panBy, toMap, zoomAt } from './engine/camera.ts';
import type { CameraState, View } from './engine/camera.ts';
import { agentTooltip, badgeLabel, cleanerTooltip, effortPips, EFFORT_ORDER, managerTooltip, itTooltip, receptionistTooltip, rosterEntries, vendorTooltip } from './engine/tooltip.ts';
import type { TooltipContent } from './engine/tooltip.ts';
import type { Char } from './engine/characters.ts';
import { Overlay } from './engine/overlay.ts';
import type { DeviceRect } from './engine/overlay.ts';
import { ROSTER_BELOW_MIN_H, ROSTER_GAP, ROSTER_SIDE_MAX_W, ROSTER_SIDE_MIN_W, Roster } from './engine/roster.ts';
import { RAIL_W, belowListDetail, canSendHome, caseTabIds, caseTarget, easeToward, framingFocusX, parkedStopRect, propFocusCentre, propStopRect, stripFor, stripLayout, stripListColumns } from './engine/layoutLogic.ts';
import type { Rect } from './engine/layoutLogic.ts';
import type { RosterRect } from './engine/roster.ts';
import { CaseFile } from './engine/caseFile.ts';
import { Memo } from './engine/memo.ts';
import type { WorkerInfo } from './engine/memoLogic.ts';
import { button, h, pixelIcon } from './engine/dom.ts';
import { PanelDrawer } from './engine/drawer.ts';
import type { DrawerContext } from './engine/drawer.ts';
import { IconBar } from './engine/iconBar.ts';
import type { IconBarItemId } from './engine/iconBar.ts';
import { createPanelHost, routePanelMessage } from './engine/panels.ts';
import {
  FRONT_DESK_ID, buildExtras, createHostBus, createInboxReadStore, createSceneCatalog, draftStore, panelChange, panelForProp, panelToRestore, tabStore,
  parseStartEdits, pickHoverProp, propOf, sameExtras, sanitizeSaved,
} from './engine/panelsWiring.ts';
import type { ExtrasData, SavedState } from './engine/panelsWiring.ts';
import { buildHotspots, catalogTipLine, hotspotAt, propTooltip } from './engine/hotspots.ts';
import type { PropId, Round } from './engine/hotspots.ts';
import { calendarTooltip, clockTooltip } from './engine/usageLogic.ts';
import { normalizeAgent } from './engine/targets.ts';
import { defaultEffortFor } from './engine/optionsLogic.ts';
import type { AgentView } from './engine/targets.ts';
import type { SceneExtras } from './engine/scene.ts';
import { injectUiStyles } from './engine/uiStyles.ts';
import { slotInfoOf } from './engine/theme.ts';
import type { ThemeApplyResult } from './engine/themeApply.ts';
import { ThemeApplier } from './engine/themeApply.ts';
import { artPort } from './engine/themeArt.ts';
import { createFrontDeskPanel, registerFrontDeskTab } from './engine/frontDeskPanel.ts';
import { isFrontDeskTab } from './engine/frontDeskView.ts';
import {
  VIEW_EMPTY_NOTE_LINES, VIEW_PANELS, VIEW_TIP_DONE_KEY, viewTipText, bootMode, viewAgentTooltip, viewHotspots, viewManagerTooltip, viewPropTooltip,
  viewSceneExtras,
} from './engine/viewModeLogic.ts';
import type { ViewHotspot } from './engine/viewModeLogic.ts';
// Each registers its tab with the Front desk on import (before the panel is mounted).
import { createStaffTab, openStaffSlot } from './engine/frontDeskStaff.ts';
import './engine/frontDeskColours.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { UpdateCue } from './engine/updateCue.ts';
import { UpdateMemoView } from './engine/updateMemoView.ts';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void; getState?(): unknown; setState?(s: unknown): void };

const FRAME_MS = 1000 / 30;
/** After a pause longer than this, walkers are snapped to where they were going. */
const RESUME_SNAP_MS = 2000;
/** Default horizontal focus in camera mode: between the bullpen and the manager's door. */
const CAMERA_FOCUS_X = 30 * TILE;
/** While the boss sulks (a Fable spell) a narrow view frames his glass office (from its west wall) and the sulk spot (plus the bubble above it). */
const SULK_FRAME = { x0: (poi.managerDoor.x - 2) * TILE, x1: (poi.sulk.tile.x + 3) * TILE };
/** The camera's horizontal focus (map px): `CAMERA_FOCUS_X`, eased towards `SULK_FRAME` while the boss sulks. */
let focusX = CAMERA_FOCUS_X;
let focusAt = 0;
/** A press that moves less than this (CSS px) is a click, not a drag. */
const CLICK_SLOP = 4;
/** Height the icon bar needs above the office (8 px margin + the bar); the office moves down by this much when the window has room to spare, so the bar never hides the sign. */
const BAR_RESERVE = 54;

const vscode = acquireVsCodeApi();
/** View mode (`claudeOffice.mode` = 'view'): the host renders it into the body; the page is rebuilt when the setting changes. */
const viewMode = bootMode(document.body.dataset) === 'view';

const canvas = (document.getElementById('office') as HTMLCanvasElement | null) ?? (() => {
  const c = document.createElement('canvas');
  c.id = 'office';
  document.body.appendChild(c);
  return c;
})();
const screenCtx = canvas.getContext('2d')!;

const world: WorldDef = {
  w: MAP_W, h: MAP_H, tile: TILE, grid: walkGrid, seats, tempSeats, poi, archetypes: ARCHETYPES, tempLooks: TEMP_LOOKS,
  staffSlots: STAFF_SLOT_IDS, tempSlots: TEMP_SLOT_IDS,
};
const office = new Office(world, { seed: (Date.now() & 0xffff) ^ 0x5eed });
let scene: Scene | null = null;
const overlay = new Overlay();
/** The staff list; not built in view mode. */
const roster: Roster | null = viewMode ? null : new Roster(document.body);
let rosterRect: RosterRect | null = null;
/** Character highlighted from the roster (row hover; `?pick=<id>` pins one for screenshots). */
let rosterHover: string | null = new URLSearchParams(location.search).get('pick');
/** Character under the pointer in the office. */
let officeHover: string | null = null;
if (roster) roster.onHover = (id) => { rosterHover = id; requestFrame(); };
/**
 * Settings and theme: the host's settings message plus the Front desk's unsaved draft layered over its theme. `applier.settings`
 * is what everything reads (the host's settings with the theme's company, branch and manager name on top); `apply()` puts the
 * colours, the look overrides, the names, lines and pins into the art registry and the office. Each settings message carries the
 * whole current state, so a missing `theme` means "no theme".
 */
const applier = new ThemeApplier({ art: artPort, office, staffSlots: STAFF_SLOT_IDS, tempSlots: TEMP_SLOT_IDS });
/** True once the host has sent its first settings message (`FrontDeskCtx.hostSettings` is null before that). */
let settingsSeen = false;

/** After an `apply()`: new office colours rebuild the scene on the next tick, new looks drop the cached faces and portraits. */
function afterApply(r: ThemeApplyResult): void {
  if (r.artReset) scene = null;
  if (r.looksChanged.length > 0) {
    roster?.invalidateFaces();
    drawer.refresh();
  }
  if (r.artReset || r.looksChanged.length > 0 || r.namesChanged) requestFrame(true);
  // An open head office memo follows the theme's sign colours and names (a Front desk preview too).
  if (r.artReset || r.namesChanged) updateMemoView.refresh();
}

// ---------------------------------------------------------------------------
// Manager Mode: case-file drawer and assignment memo

injectUiStyles();
const post = (msg: WebviewToHost): void => vscode.postMessage(msg);
/** A walk-on (the cleaner, the food cart vendor, Dez or Fenwick) by id, only while on stage; they are not in `office.chars`. */
const npcById = (id: string): Char | null => {
  if (id === office.cleaner.id) return office.cleanerOnStage ? office.cleaner : null;
  if (id === office.vendor.id) return office.vendorOnStage ? office.vendor : null;
  if (id === office.dez.id) return office.itCrewOnStage ? office.dez : null;
  if (id === office.fenwick.id) return office.itCrewOnStage ? office.fenwick : null;
  return null;
};
/** True for the walk-ons: not agents, never clickable. */
const isNpc = (c: Char): boolean => c.kind === 'cleaner' || c.kind === 'vendor' || c.kind === 'itSupport';
const lookOf = (id: string): string | null =>
  id === office.manager.id ? 'manager' : id === office.receptionist.id ? 'receptionist' : npcById(id)?.look ?? office.chars.get(id)?.look ?? null;
/** A character by id: the manager, the receptionist and the walk-ons are not in `office.chars`. */
const charById = (id: string): Char | null =>
  id === office.manager.id ? office.manager : id === office.receptionist.id ? office.receptionist : npcById(id) ?? office.chars.get(id) ?? null;
/** Per-webview UI state kept by VS Code across hide/show and reloads: drawer width, the first-run tip, the in-tray read marks and the open panel. */
const savedState: SavedState = ((): SavedState => {
  try {
    return sanitizeSaved(vscode.getState?.());
  } catch {
    return {};
  }
})();
function persist(patch: Partial<SavedState>): void {
  Object.assign(savedState, patch);
  try { vscode.setState?.({ ...savedState }); } catch { /* not persisted */ }
}

function workers(): WorkerInfo[] {
  const out: WorkerInfo[] = [];
  for (const c of office.chars.values()) {
    const a = c.agent;
    if (!a || c.removed) continue;
    const w: WorkerInfo = { id: a.id, kind: a.kind, title: a.title, status: a.status, busy: a.status === 'working' && a.activity !== 'idle' };
    if (a.cwd) w.cwd = a.cwd;
    if (a.sessionId) w.sessionId = a.sessionId;
    if (a.control) w.control = a.control;
    out.push(w);
  }
  return out;
}

// What the host last told us, for the panels, the scene extras and the case/memo option chips.
/** Normalised agents of the newest snapshot (the panels' `agents()`). */
let agentList: AgentView[] = [];
let latestUsage: UsageSnapshot | null = null;
let latestDefaults: ClaudeDefaults | null = null;
// Sessions that report no effort sip coffee at the Claude default for their model.
office.defaultEffort = (model) => defaultEffortFor(latestDefaults, model);

const caseFile = new CaseFile(document.body, {
  post,
  agent: (id) => office.agentById(id),
  lookOf,
  managerName: () => applier.settings.managerName || 'You',
  openMemo: (from) => openMemo(from),
  layoutChanged: () => applyDock(),
  width: savedState.drawerW,
  saveWidth: (w) => persist({ drawerW: w }),
  defaults: () => latestDefaults,
  // Escape order: popover (self-handled) -> memo -> drawer -> case. The case file only takes the key itself when nothing above it would.
  escapeFirst: () => memo.isOpen || drawer.isOpen(),
  // A case opened from a panel hides it; closing the case discards the panel, unless it has unsaved edits (the Front desk): then the
  // panel comes back, showing its "Keep editing / Discard" prompt.
  onClosed: () => { if (!returningToPanel && drawer.isSuspended()) drawer.dismissSuspended(); },
  // Opened from a click in the office: keyboard focus lands on the icon bar instead of being dropped on <body>.
  fallbackFocus: () => { if (!drawer.isOpen() && !memo.isOpen) iconBar?.focus(); },
});
const memo = new Memo(document.body, {
  post,
  settings: () => applier.settings,
  managerTitle: () => applier.state.titles.manager,
  workers,
  lookOf,
  openCase: (id) => openWorker(id),
  defaults: () => latestDefaults,
});
if (roster) {
  roster.onOpen = (id) => openWorker(id);
  roster.onNewTask = () => openMemo(null);
  roster.onSendHome = (id) => { if (canSendHome(office.agentById(id))) post({ type: 'sendHome', agentId: id }); };
  roster.canSendHome = (id) => canSendHome(office.agentById(id));
}

/** True while the webview is a wide, short strip (`isStrip`): rail, map, staff list; workers open in editor tabs. */
let strip = false;
/** Workers whose case is open in an editor tab (the host's `caseTabs`, in the order the tabs were opened). */
let caseTabs: string[] = [];

/**
 * A click on a worker (on the map, their staff row, or a panel's link to them): in a strip, or when their tab is already open,
 * the host opens or focuses their case tab (`openCaseTab`); otherwise their case file opens in the drawer.
 */
function openWorker(id: string): void {
  if (viewMode) return;
  if (caseTarget(strip, caseTabs.includes(id)) === 'tab') {
    // The look the office gave them, so the tab's portrait matches (left out when they have none).
    const look = lookOf(id);
    post(look ? { type: 'openCaseTab', agentId: id, look } : { type: 'openCaseTab', agentId: id });
    // A panel's link to a worker (an In-tray card) steps the drawer aside for the case file; the case opens in a tab instead,
    // so the panel stays where it is.
    if (drawer.isSuspended() && !caseFile.openId) drawer.resume();
    dismissTip();
    return;
  }
  openCase(id);
}

/**
 * Opens a worker's case file; a knocking worker's opens on their request card. While a panel is showing (or already
 * suspended behind a case) the drawer steps aside and the case file offers "← <panel>" to bring it back.
 */
function openCase(id: string): void {
  if (viewMode) return;
  const a = office.agentById(id);
  const target = drawer.suspend();
  caseFile.open(id, {
    focusPending: !!a && (!!a.pending || a.activity === 'needsYou'),
    back: target ? { label: `← ${host.titleOf(rootPanel) ?? target.title}`, onBack: backToPanel } : null,
  });
  roster?.setOpen(caseFile.openId);
  dismissTip();
}

/** True while the case file is closing because the user pressed "← <panel>" (so the drawer comes back instead of closing). */
let returningToPanel = false;
function backToPanel(): void {
  returningToPanel = true;
  try { caseFile.close(); } finally { returningToPanel = false; }
  drawer.resume();
}

/** Opens the assignment memo (and counts as having found it: the first-run tip goes away). */
function openMemo(fromAgentId: string | null, projectPath?: string, prefill?: MemoPrefill): void {
  if (viewMode) return;
  memo.open(fromAgentId, projectPath, prefill);
  dismissTip();
}

// ---------------------------------------------------------------------------
// Office tools: panel drawer, icon bar, in-tray read marks

/** Icons by name; an unknown name (a panel from a later round) falls back to a plain page instead of throwing. */
const iconIds = new Set<string>(ICON_IDS);
const icon = (name: string): HTMLElement => pixelIcon((iconIds.has(name) ? name : 'page') as IconId, 20);

const inbox = createInboxReadStore(savedState.inboxRead ?? {}, (marks) => persist({ inboxRead: marks }), () => hostNow());

/** The rounds of office tools that are live: A (v0.3) and B (v0.4: File room, Training library, Phone, Office handbook, Temp agency). */
const ROUNDS: ReadonlySet<Round> = new Set<Round>(['A', 'B']);

/**
 * What the phone and the bookshelf show: the last `mcp` and `skills` catalog replies a panel received (statuses and a count
 * only; the saved state keeps no names). Opening the office asks for nothing, so until a panel has asked, the phone is dark and
 * the shelf is the classic full one.
 */
const sceneCatalog = createSceneCatalog({ ...(savedState.phone ? { phone: savedState.phone } : {}), ...(savedState.shelf !== undefined ? { shelf: savedState.shelf } : {}) }, hostNow());

/** Prop under the pointer / pointed at by an icon-bar button, a Directory row or `?hover=prop:`; outlined in the scene. */
let pointerProp: PropId | null = null;
let barProp: PropId | null = null;
const setBarProp = (prop: PropId | null): void => { barProp = prop; requestFrame(true); };

/** The open root panel (a sub-view on top keeps its parent pressed in the icon bar). */
let rootPanel: string | null = null;
const drawer: PanelDrawer = new PanelDrawer(document.body, {
  layoutChanged: () => applyDock(),
  width: savedState.drawerW,
  saveWidth: (w) => persist({ drawerW: w }),
  icon,
  onChange: (id) => {
    // Hidden behind a case file the panel comes back, so its root stays remembered (and saved).
    const c = panelChange(rootPanel, id, drawer.isSuspended(), (p) => host.has(p));
    rootPanel = c.root;
    iconBar?.setCurrent(c.barCurrent);
    if (c.savedPanel !== 'keep') persist({ panel: c.savedPanel });
    // The receptionist looks up while the Front desk is open (also while a sub-view covers it), and goes back to work otherwise.
    office.setAttending(c.attending);
  },
  fallbackFocus: () => { if (!caseFile.openId && !memo.isOpen) iconBar?.focus(); },
});
/** Listeners behind `FrontDeskCtx.onHost`. */
const hostBus = createHostBus();
const host = createPanelHost({
  drawer,
  post,
  lookOf,
  agents: () => agentList,
  usage: () => latestUsage,
  defaults: () => latestDefaults,
  now: () => hostNow(),
  inbox,
  openCase: (id) => openWorker(id),
  // The memo applies the whole prefill itself (task text, project, assignee, options); see applyPrefill in memoLogic.ts.
  openMemo: (prefill?: MemoPrefill) => openMemo(null, undefined, prefill),
  icon,
  onPropHover: setBarProp,
  rounds: ROUNDS,
  ...(viewMode ? { only: VIEW_PANELS } : {}),
});

// The Front desk. Its draft lives in the saved state (`fdDraft`, capped at 256 KB, dropped when the theme source changes).
const frontDeskView = createFrontDeskPanel({ ...draftStore(savedState, persist), ...tabStore(savedState, persist) });
host.register(frontDeskView, {
  context: (base: DrawerContext): DrawerContext => {
    const ctx: DrawerContext & Omit<FrontDeskCtx<HTMLElement>, keyof DrawerContext | 'push' | 'back'> = {
      ...base,
      hostTheme: () => applier.hostThemeValue ?? null,
      hostSettings: () => (settingsSeen ? applier.hostSettings : null),
      preview: (theme: OfficeTheme | null) => {
        applier.preview(theme);
        afterApply(applier.apply());
      },
      onHost: (listener) => hostBus.subscribe(listener),
    };
    return ctx;
  },
});

/** Opens a registered panel (ids nobody registered are ignored). Steps over an open case file. */
function openPanel(id: string): boolean {
  if (!host.has(id)) return false;
  if (caseFile.openId) caseFile.close();
  const ok = host.open(id);
  if (ok) dismissTip();
  return ok;
}

/** The icon bar (the rail in a strip); not built in view mode. */
const iconBar: IconBar | null = viewMode ? null : new IconBar(document.body, {
  icon,
  onActivate: (id: IconBarItemId) => {
    if (id === 'newTask') { openMemo(null); return; }
    if (drawer.currentId() === id) { drawer.close(); return; }
    openPanel(id);
  },
  onHover: (prop) => setBarProp(propOf(prop)),
}, window.innerWidth, ROUNDS);

/** The props the pointer can find; `action` is false for the ones a click does nothing for (view mode's clock and calendar). */
const hotspots: ViewHotspot[] = viewMode
  ? viewHotspots(buildHotspots(PROP_ANCHORS, ROUNDS))
  : buildHotspots(PROP_ANCHORS, ROUNDS).map((spot) => ({ ...spot, action: true }));
const actionProps = new Set<PropId>(hotspots.filter((spot) => spot.action).map((spot) => spot.id));

/**
 * Keyboard stops over the props that open a panel: invisible buttons laid over the map (the pointer goes straight through them
 * to the canvas). They come right after the icon bar in the Tab order and before the staff list, as one stop: the arrow keys
 * move between them (in reading order), Enter or Space opens the prop's panel, and the focused prop is outlined in the office
 * with its tooltip, as on hover. A prop scrolled out of view by the pan camera (the sidebar) keeps its stop, parked on the
 * nearest edge (`parkedStopRect`); focusing it pans the camera to the prop (task 10.1: in view mode at sidebar width the
 * Front desk, the only stop, starts off screen and used to be unreachable). Tabbing in lands on a stop in view when there is one.
 */
const propStops = h('div', { class: 'co-propstops co-ui', role: 'group', 'aria-label': 'Things in the office' });
if (iconBar) iconBar.el.after(propStops);
else document.body.appendChild(propStops);
/** The prop whose stop has keyboard focus (outlined, with its tooltip). */
let keyProp: PropId | null = null;
let propRoving: PropId | null = null;
const propStopEls = new Map<PropId, HTMLButtonElement>();
for (const spot of hotspots) {
  const id = spot.id;
  const b = button([], 'co-propstop', () => { const panel = propAction(id); if (panel) openPanel(panel); }, { 'data-prop': id, tabindex: '-1' });
  b.addEventListener('focus', () => { keyProp = id; setPropRoving(id); setBarProp(id); if (b.dataset['parked'] === '1') panToProp(id); });
  b.addEventListener('blur', () => { if (keyProp === id) { keyProp = null; setBarProp(null); } });
  b.addEventListener('keydown', (e) => propStopKey(e, id));
  b.hidden = true;
  propStopEls.set(id, b);
  propStops.appendChild(b);
}
const spotRects = new Map<PropId, Rect>(hotspots.map((spot) => [spot.id, spot.rect]));

/**
 * Post from head office (an update is out, or installed and waiting for a reload): the head office memo, and the cue that
 * offers it (the receptionist's line, the envelope and badge on her counter, a click on her or the badge). Both modes.
 */
const updateMemoView = new UpdateMemoView(document.body, {
  post,
  settings: () => applier.settings,
  openFrontDesk: () => { openPanel(FRONT_DESK_ID); },
});
const updateCue = new UpdateCue({ office, memo: updateMemoView, requestFrame: () => requestFrame(true), stopAfter: propStops });
/** True while the pointer is over the post (the badge or the counter envelope). */
let postHover = false;
/** The stops in reading order on the map (top to bottom, then left to right), so it does not change as the camera pans. */
function propStopOrder(): HTMLButtonElement[] {
  const at = (b: HTMLButtonElement): Rect => spotRects.get(b.dataset['prop'] as PropId) ?? { x: 0, y: 0, w: 0, h: 0 };
  return [...propStopEls.values()].filter((b) => !b.hidden).sort((a, b) => (at(a).y - at(b).y) || (at(a).x - at(b).x));
}
/** Pans the camera so a prop scrolled out of view is in the middle (its keyboard stop was focused). */
function panToProp(id: PropId): void {
  const r = spotRects.get(id);
  if (!r || !view.pannable) return;
  camera = clampCamera({ ...camera, ...propFocusCentre(r) }, mapRegion.w, mapRegion.h, MAP_PX_W, MAP_PX_H, dpr);
  updateView();
  requestFrame(true);
}
function setPropRoving(id: PropId | null): void {
  propRoving = id;
  for (const [pid, b] of propStopEls) b.tabIndex = pid === id ? 0 : -1;
}
function propStopKey(e: KeyboardEvent, id: PropId): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const order = propStopOrder();
  const at = order.findIndex((b) => b.dataset['prop'] === id);
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % order.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + order.length) % order.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = order.length - 1;
  if (next < 0 || !order[next]) return;
  e.preventDefault();
  order[next]!.focus();
}
/** Puts each stop over its prop (after every view change); a stop that leaves the view drops out of the Tab order. */
function placePropStops(): void {
  for (const spot of hotspots) {
    const b = propStopEls.get(spot.id);
    if (!b) continue;
    const acts = propAction(spot.id) !== null;
    const inView = acts ? propStopRect(spot.rect, view, mapRegion) : null;
    const r = inView ?? (acts && view.pannable ? parkedStopRect(spot.rect, view, mapRegion) : null);
    if (!r) { if (!b.hidden) b.hidden = true; continue; }
    b.hidden = false;
    b.dataset['parked'] = inView ? '0' : '1';
    b.style.left = `${r.x}px`;
    b.style.top = `${r.y}px`;
    b.style.width = `${r.w}px`;
    b.style.height = `${r.h}px`;
    const tip = propTooltip(spot.id);
    const label = tip.hint ? `${tip.title}: ${tip.hint}` : tip.title;
    if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
  }
  const visible = propStopOrder();
  if (!propRoving || !visible.some((b) => b.dataset['prop'] === propRoving)) {
    const first = visible.find((b) => b.dataset['parked'] !== '1') ?? visible[0];
    setPropRoving((first?.dataset['prop'] as PropId | undefined) ?? null);
  }
  updateCue.place(view, mapRegion);
}

/** Scene extras, rebuilt when the data changes (and every few seconds, because "now" moves resets and stale marks). */
let sceneExtras: SceneExtras = {};
let extrasData: ExtrasData | null = null;
let extrasDirty = true;
let extrasAt = -Infinity;
const EXTRAS_REFRESH_MS = 5000;

function updateExtras(now: number): void {
  if (!extrasDirty && now - extrasAt < EXTRAS_REFRESH_MS) return;
  extrasDirty = false;
  extrasAt = now;
  const next = buildExtras({ usage: latestUsage, agents: agentList, read: inbox, now: hostNow(), phone: sceneCatalog.lights(hostNow()), shelf: sceneCatalog.shelf() });
  if (sameExtras(extrasData, next)) return;
  extrasData = next;
  sceneExtras = { ...(viewMode ? viewSceneExtras(next) : next), hoverProp: sceneExtras.hoverProp ?? null };
  iconBar?.setBadge('inbox', next.inTray.count > 0 ? next.inTray : null);
}
const markExtrasDirty = (): void => { extrasDirty = true; };
inbox.subscribe(() => { markExtrasDirty(); drawer.refresh(); requestFrame(true); });

/** "＋ New task" over the office when the roster (and its button) is hidden. */
const fab: HTMLElement | null = viewMode ? null : button('+ New task', 'co-btn co-secondary co-small co-fab co-ui', () => openMemo(null), { title: 'Hand out a new task (or click yourself in the glass office)' });
if (fab) {
  fab.hidden = true;
  document.body.appendChild(fab);
}

let dockedW = 0;
/** Gives the drawers their room: the office canvas shrinks to the space left of them (only one of the case file and the panel drawer shows at a time). */
/**
 * A drawer or case file that overlays the whole window (a narrow panel) hides the icon bar, the roster and the New task button:
 * make them inert so Tab never lands on something you cannot see. A partial overlay leaves them usable.
 */
function updateInert(): void {
  // Looked up by class: this runs from layout callbacks that can fire while the UI is still being built (and in view mode
  // the bar, the list and the button do not exist, so only the prop stops are left).
  const covers = (sel: string): boolean => {
    const el = document.querySelector<HTMLElement>(sel);
    return !!el && !el.hidden && el.getBoundingClientRect().width >= window.innerWidth - 1;
  };
  const covered = covers('.co-drawer') || covers('.co-case');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.co-iconbar, .co-propstops, .co-roster, .co-fab'))) {
    if (el.inert !== covered) el.inert = covered;
  }
}

function applyDock(): void {
  const w = Math.max(caseFile.dockWidth, drawer.dockWidth);
  roster?.setOpen(caseFile.openId);
  updateInert();
  if (w === dockedW) return;
  dockedW = w;
  // The bar only has the width the office has left (it sits beside a docked drawer, not under it).
  iconBar?.setWidth(window.innerWidth - w);
  canvas.style.width = w ? `calc(100vw - ${w}px)` : '';
  resize();
}

/** Strip or not (from the webview's whole size): the bar stands as the rail, the toast moves clear of it. */
function applyStrip(): void {
  strip = stripFor(window.innerWidth, window.innerHeight, viewMode);
  iconBar?.setRail(strip, window.innerHeight);
  toast.style.left = `${strip ? RAIL_W + 8 : 8}px`;
}

/** Toast for host errors that aren't tied to an open memo. */
const toast = document.createElement('div');
toast.className = 'co-ui';
toast.setAttribute('role', 'alert');
Object.assign(toast.style, {
  position: 'fixed', left: '8px', bottom: '8px', zIndex: '40', maxWidth: 'min(420px, calc(100vw - 16px))', padding: '6px 10px', borderRadius: '4px',
  background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)', color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-foreground, #cccccc))',
  border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)', fontSize: '12.5px', display: 'none', overflowWrap: 'anywhere',
} satisfies Partial<CSSStyleDeclaration>);
document.body.appendChild(toast);
let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.style.display = 'none'; }, 7000);
}

/**
 * First-run tip: a note pinned under the manager saying what clicking does.
 * Shown until dismissed, or until the memo or a case file is first opened. View mode has its own tip (`VIEW_TIP`), dismissed
 * apart from this one (`viewTipDone`), and it goes away when the Front desk is first opened.
 */
const tip = document.createElement('div');
const tipPan = document.createElement('span');
/** The view-mode tip's words; they change while post from head office waits (`viewTipText`). */
const tipLead = document.createTextNode(viewTipText(false));
tip.className = 'co-tip co-ui';
tip.setAttribute('role', 'note');
tip.setAttribute('aria-label', 'Tip');
{
  const text = document.createElement('div');
  text.className = 'co-tip-text';
  tipPan.className = 'co-tip-pan';
  tipPan.textContent = ' Drag to look around.';
  if (viewMode) text.append(tipLead, tipPan);
  else {
    const lead = document.createElement('strong');
    lead.textContent = 'You run this office. ';
    text.append(lead, 'Click yourself to hand out a task. Click a worker to read their case file.', tipPan);
  }
  const ok = button('Got it', 'co-btn co-primary co-small', () => dismissTip(), { title: 'Hide this tip' });
  tip.append(text, ok);
}
tip.hidden = true;
document.body.appendChild(tip);
let tipDone = (viewMode ? savedState[VIEW_TIP_DONE_KEY] === true : savedState.tipDone === true) || new URLSearchParams(location.search).get('tip') === '0';
function dismissTip(): void {
  if (tipDone) return;
  tipDone = true;
  tip.hidden = true;
  persist(viewMode ? { [VIEW_TIP_DONE_KEY]: true } : { tipDone: true });
}
let tipPos = '';
/** Keeps the tip under the manager (screen space), inside the visible office and clear of the drawer. */
function placeTip(): void {
  const show = !tipDone && office.hasSnapshot && office.chars.size > 0 && !memo.isOpen && !caseFile.openId && !drawer.isOpen();
  if (tip.hidden === show) tip.hidden = !show;
  if (!show) return;
  if (viewMode) {
    const want = viewTipText(updateCue.on);
    if (tipLead.data !== want) tipLead.data = want;
  }
  // In the sidebar camera most of the staff are off screen.
  if (tipPan.hidden === view.pannable) tipPan.hidden = !view.pannable;
  const m = office.manager;
  const ax = view.ox + m.x * view.scale;
  const ay = view.oy + (m.y + 6) * view.scale;
  const w = tip.offsetWidth || 260;
  // Inside the map's room (in a strip, clear of the rail and the staff list).
  const left = mapRegion.x + 8;
  const right = mapRegion.x + mapRegion.w - 8;
  const x = Math.round(Math.max(left, Math.min(right - w, ax - w / 2)));
  const y = Math.round(Math.max(8, Math.min(cssH - (tip.offsetHeight || 60) - 8, ay + 8)));
  const arrow = Math.round(Math.max(12, Math.min(w - 12, ax - x)));
  const key = `${x},${y},${arrow}`;
  if (key === tipPos) return;
  tipPos = key;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.style.setProperty('--co-tip-ax', `${arrow}px`);
}

/**
 * Escape, in order: an open popover (it handles its own Escape in the capture phase and marks the event handled) -> the memo ->
 * the panel drawer (consumed even when a panel vetoes closing, so the case file never closes underneath its "unsaved changes"
 * prompt) -> the case file.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (memo.isOpen) memo.close();
  else if (updateMemoView.isOpen) updateMemoView.close();
  else if (drawer.handleEscape()) { /* consumed */ }
  else if (caseFile.openId) caseFile.close();
  else return;
  e.preventDefault();
});

/** Host clock. The dev harness can supply a scripted clock (`__harnessClock`); in VS Code it's Date.now(). */
function hostNow(): number {
  const h = (window as unknown as { __harnessClock?: () => number }).__harnessClock;
  return typeof h === 'function' ? h() : Date.now();
}

// ---------------------------------------------------------------------------
// Sizing, letterbox colour and camera

let cssW = 1;
let cssH = 1;
let dpr = 1;
let camera: CameraState = defaultCamera();
let view: View = { scale: 1, ox: 0, oy: 0, pannable: false };
/** The room the map is fitted into (CSS px, canvas coordinates): the whole canvas, or a strip's middle column. */
let mapRegion: Rect = { x: 0, y: 0, w: 1, h: 1 };
/** The view relative to `mapRegion`, for the camera functions (they assume a viewport at 0,0). */
const localView = (): View => ({ ...view, ox: view.ox - mapRegion.x, oy: view.oy - mapRegion.y });
let letterbox = '#1e1e1e';
let letterboxCheckedAt = -Infinity;

function readLetterbox(): string {
  const cs = getComputedStyle(document.documentElement);
  const bodyCs = getComputedStyle(document.body);
  for (const v of ['--vscode-panel-background', '--vscode-editor-background', '--vscode-sideBar-background']) {
    const val = (cs.getPropertyValue(v) || bodyCs.getPropertyValue(v)).trim();
    if (val) return val;
  }
  return '#1e1e1e';
}

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
  cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  updateView();
  updateInert();
  requestFrame(true);
}

function updateView(): void {
  if (strip) {
    // Three columns: the rail, the map (fitted into the middle, at full height when it is wide enough), the staff list. A docked
    // drawer covers the list. Nothing floats over the map: no bar, no New task pill (the rail and the list header have it).
    // The width the full-height map cannot use goes to the staff list (columns, a detail line), not to letterbox (task 10.1);
    // an empty office too, so the map stays put when the first worker comes in or the last goes home.
    const lay = stripLayout(window.innerWidth, window.innerHeight, dockedW, MAP_PX_W / MAP_PX_H);
    mapRegion = lay.map;
    const v = computeView(Math.max(1, lay.map.w), Math.max(1, lay.map.h), MAP_PX_W, MAP_PX_H, dpr, camera, focusX);
    view = { ...v, ox: v.ox + lay.map.x, oy: v.oy + lay.map.y };
    rosterRect = lay.list && office.hasSnapshot ? { mode: 'strip', ...lay.list, ...stripListColumns(lay.list.w, lay.list.h, office.chars.size) } : null;
    roster?.place(rosterRect);
    if (fab) fab.hidden = true;
    iconBar?.setReserve(0);
    updateCursor();
    placePropStops();
    return;
  }
  mapRegion = { x: 0, y: 0, w: cssW, h: cssH };
  view = computeView(cssW, cssH, MAP_PX_W, MAP_PX_H, dpr, camera, focusX);
  rosterRect = null;
  if (viewMode) {
    // No bar to clear, no staff list: the map has the whole canvas (centred by `computeView`), at any size.
    updateCursor();
    placePropStops();
    return;
  }
  // Spare height goes above the office first (under the icon bar). A panned or zoomed office fills the window: the bar floats over it.
  // A fitted view the 1-device-px snap crops by a few pixels (a 700 px wide office at 1x) counts as fitted too.
  const fitted = fitsWholeMap(cssW, cssH, MAP_PX_W, MAP_PX_H, dpr, camera);
  const heightFits = MAP_PX_H * view.scale <= cssH + 0.5;
  if (!view.pannable || (fitted && heightFits)) view = { ...view, oy: Math.max(view.oy, Math.min(BAR_RESERVE, cssH - MAP_PX_H * view.scale)) };
  // Not when zoomed in or in the sidebar camera; a few pixels of crop
  // (a 250 px panel at 1x, or a 700 px wide one) is fine.
  if ((MAP_PX_W * view.scale <= cssW + 0.5 || fitted) && camera.zoom <= 1 && office.chars.size > 0) {
    // Spare room: a wide, short panel gets the roster beside the office; a
    // tall one (an editor tab) gets it below. The office keeps its scale.
    const mw = MAP_PX_W * view.scale;
    const mh = MAP_PX_H * view.scale;
    const spareW = cssW - mw - ROSTER_GAP - 16;
    const spareH = cssH - mh - ROSTER_GAP - 16;
    if (spareW >= ROSTER_SIDE_MIN_W) {
      const rw = Math.min(ROSTER_SIDE_MAX_W, spareW);
      const left = Math.round((cssW - (mw + ROSTER_GAP + rw)) / 2);
      view = { ...view, ox: left };
      const top = Math.max(view.oy, 6);
      rosterRect = { mode: 'side', x: left + mw + ROSTER_GAP, y: top, w: rw, h: Math.min(view.oy + mh, cssH - 6) - top };
    } else if (spareH >= ROSTER_BELOW_MIN_H) {
      // The roster keeps its minimum height; what is left above the office goes to the icon bar.
      const top = 8 + Math.max(0, Math.min(BAR_RESERVE - 8, spareH - ROSTER_BELOW_MIN_H));
      view = { ...view, oy: top };
      const rw = Math.min(mw, cssW - 16);
      const rh = cssH - (top + mh + ROSTER_GAP) - 8;
      rosterRect = { mode: 'below', x: Math.round((cssW - rw) / 2), y: top + mh + ROSTER_GAP, w: rw, h: rh, detail: belowListDetail(rw, rh, office.chars.size) };
    }
  }
  roster?.place(rosterRect);
  if (fab) {
    fab.hidden = rosterRect !== null || !office.hasSnapshot;
    fab.style.right = `${dockedW + 8}px`;
    // The bar shares the top row with the button: keep its width (plus a gap) free so the two never overlap.
    iconBar?.setReserve(fab.hidden ? 0 : fab.offsetWidth + 8);
  }
  updateCursor();
  placePropStops();
}

let cursorNow = '';
/** Pointer over someone you can click; grab hand where the office pans. */
function updateCursor(): void {
  // In view mode only the receptionist among the characters (and only the Front desk among the props) answers a click; the walk-ons never do.
  const hoverChar = officeHover !== null ? charById(officeHover) : null;
  const clickable = (officeHover !== null && !(hoverChar && isNpc(hoverChar)) && (!viewMode || officeHover === office.receptionist.id)) || (pointerProp !== null && propAction(pointerProp) !== null) || postHover;
  const want = dragging ? 'grabbing' : clickable && mouse ? 'pointer' : view.pannable ? 'grab' : 'default';
  if (want !== cursorNow) {
    cursorNow = want;
    canvas.style.cursor = want;
  }
}

/** Integer-scaled copy of the office, for crisp fractional scales (see blit). */
const upCanvas = document.createElement('canvas');
const upCtx = upCanvas.getContext('2d')!;

/** The office's rectangle on screen, in device px. */
function mapDeviceRect(): DeviceRect {
  const x = Math.round(view.ox * dpr);
  const y = Math.round(view.oy * dpr);
  return { x, y, w: Math.round(MAP_PX_W * view.scale * dpr), h: Math.round(MAP_PX_H * view.scale * dpr) };
}

function blit(): void {
  if (!scene) return;
  screenCtx.setTransform(1, 0, 0, 1, 0, 0);
  screenCtx.fillStyle = letterbox;
  screenCtx.fillRect(0, 0, canvas.width, canvas.height);
  screenCtx.save();
  try {
    clipToRegion();
    drawMap();
  } finally {
    screenCtx.restore();
  }
}

/** In a strip the map (and everything drawn over it) stays inside its column, even when zoomed or panned. */
function clipToRegion(): void {
  if (!strip) return;
  const d = regionDeviceRect();
  screenCtx.beginPath();
  screenCtx.rect(d.x, d.y, d.w, d.h);
  screenCtx.clip();
}

/** `mapRegion` in device px. */
function regionDeviceRect(): DeviceRect {
  const x = Math.round(mapRegion.x * dpr);
  const y = Math.round(mapRegion.y * dpr);
  return { x, y, w: Math.round((mapRegion.x + mapRegion.w) * dpr) - x, h: Math.round((mapRegion.y + mapRegion.h) * dpr) - y };
}

function drawMap(): void {
  if (!scene) return;
  const r = mapDeviceRect();
  const dev = view.scale * dpr;
  const k = Math.ceil(dev - 0.01);
  if (Math.abs(dev - Math.round(dev)) < 0.01 || k <= 1 || dev >= 4) {
    // Whole device pixels per map pixel, shrinking, or so big that 6-vs-7 px
    // unevenness doesn't show (and an upscaled copy would be huge): plain
    // nearest neighbour.
    screenCtx.imageSmoothingEnabled = dev < 1;
    screenCtx.drawImage(scene.canvas, 0, 0, MAP_PX_W, MAP_PX_H, r.x, r.y, r.w, r.h);
    return;
  }
  // Fractional scale: nearest-neighbour straight to 1.6x makes some pixels 1
  // wide and others 2 (wobbly lines, uneven faces). Scale up by the next
  // integer first, then smooth down the last bit ("sharp bilinear"): every
  // map pixel ends up the same size with at most a 1px soft edge.
  if (upCanvas.width !== MAP_PX_W * k || upCanvas.height !== MAP_PX_H * k) {
    upCanvas.width = MAP_PX_W * k;
    upCanvas.height = MAP_PX_H * k;
  }
  upCtx.imageSmoothingEnabled = false;
  upCtx.drawImage(scene.canvas, 0, 0, MAP_PX_W * k, MAP_PX_H * k);
  screenCtx.imageSmoothingEnabled = true;
  screenCtx.imageSmoothingQuality = 'low';
  screenCtx.drawImage(upCanvas, 0, 0, upCanvas.width, upCanvas.height, r.x, r.y, r.w, r.h);
}

/** The visible part of the office (device px), for keeping bubbles on screen. */
function visibleDeviceRect(): DeviceRect {
  const r = mapDeviceRect();
  const g = strip ? regionDeviceRect() : { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const x0 = Math.max(g.x, r.x);
  const y0 = Math.max(g.y, r.y);
  const x1 = Math.min(g.x + g.w, r.x + r.w);
  const y1 = Math.min(g.y + g.h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// ---------------------------------------------------------------------------
// Tooltip

const tooltip = document.createElement('div');
tooltip.setAttribute('role', 'tooltip');
Object.assign(tooltip.style, {
  position: 'fixed',
  display: 'none',
  pointerEvents: 'none',
  zIndex: '10',
  maxWidth: '280px',
  padding: '5px 8px',
  borderRadius: '3px',
  background: 'var(--vscode-editorHoverWidget-background, #252526)',
  color: 'var(--vscode-editorHoverWidget-foreground, #cccccc)',
  border: '1px solid var(--vscode-editorHoverWidget-border, #454545)',
  fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
  fontSize: 'var(--vscode-font-size, 13px)',
  lineHeight: '1.4',
  boxShadow: '0 2px 8px rgba(0,0,0,0.36)',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
} satisfies Partial<CSSStyleDeclaration>);
document.body.appendChild(tooltip);

let mouse: { x: number; y: number } | null = null;
/** `?hover=<agentId>|manager|prop:<propId>` pins a hover for screenshots. */
const debugHover = new URLSearchParams(location.search).get('hover');
const debugProp: PropId | null = debugHover?.startsWith('prop:') ? propOf(debugHover.slice(5)) : null;

/**
 * The panel a prop click opens, or null when the prop does nothing (no panel, its panel is not registered yet, or, in view mode,
 * anything but the Front desk).
 */
const propAction = (id: PropId): string | null => (actionProps.has(id) ? panelForProp(id, (p) => host.has(p)) : null);

/**
 * Tooltip for a prop: the clock and calendar show the live usage line, every prop says what a click does only if it does something.
 * In view mode, null for the props that show none.
 */
function propTooltipFor(id: PropId): TooltipContent | null {
  const tip = propTooltip(id);
  if (id === 'clock') tip.lines = [clockTooltip(latestUsage, hostNow())];
  else if (id === 'calendar') tip.lines = [calendarTooltip(latestUsage, hostNow())];
  const live = catalogTipLine(id, { lights: sceneCatalog.lights(hostNow()), shelf: sceneCatalog.shelf() });
  if (live) tip.lines.push(live);
  if (propAction(id) === null) delete tip.hint;
  return viewMode ? viewPropTooltip(id, tip) : tip;
}

function tooltipFor(c: Char): TooltipContent | null {
  if (c.kind === 'manager') {
    // During a Fable spell: who has his office (their theme name, else their task) and for how much longer.
    const holder = office.managerSulking && office.spellHolder ? office.chars.get(office.spellHolder) : undefined;
    const ends = office.spellEndsAt;
    const holderName = holder ? slotInfoOf(office.theme, holder.look)?.name?.trim() : undefined;
    const sulk = holder?.agent && ends !== null
      ? { holder: holderName || holder.agent.title, named: !!holderName, msLeft: ends - performance.now() }
      : undefined;
    const tip = managerTooltip(applier.settings.managerName || 'You', sulk, applier.state.titles.manager);
    return viewMode ? viewManagerTooltip(tip) : tip;
  }
  // While post from head office waits, a click on her opens the memo (her tooltip says so).
  if (c.kind === 'receptionist') return updateCue.receptionistTip(receptionistTooltip(applier.state.receptionistName, applier.state.titles.receptionist));
  if (c.kind === 'cleaner') return cleanerTooltip(applier.state.npcs.cleaner?.name, applier.state.titles.cleaner);
  if (c.kind === 'vendor') return vendorTooltip(applier.state.npcs.vendor?.name, applier.state.titles.vendor);
  if (c.kind === 'itSupport') return itTooltip(c.id, applier.state.npcs[c.id === office.dez.id ? 'itFixer' : 'itCritic']?.name, applier.state.titles.itSupport);
  if (!c.agent) return null;
  const info = slotInfoOf(office.theme, c.look);
  const role = info?.role || (c.kind === 'temp' ? applier.state.titles.temp : undefined) || (getLook(c.look)?.role ?? (c.kind === 'temp' ? 'Temp' : 'Staff'));
  const parent = c.agent.parentId ? office.agentById(c.agent.parentId) : null;
  let waitingTemps = 0;
  for (const o of office.chars.values()) if (!o.removed && o.agent?.kind === 'temp' && o.agent.parentId === c.id && o.agent.status !== 'done') waitingTemps++;
  return (viewMode ? viewAgentTooltip : agentTooltip)(c.agent, role, parent?.title ?? null, hostNow(), c.leaving, waitingTemps, info?.name);
}

/** The tooltip's graphic row: model chip (tier colour), then effort pips and the level word. */
function badgeRow(b: NonNullable<TooltipContent['badge']>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tt-badge-row';
  row.setAttribute('role', 'img');
  row.setAttribute('aria-label', badgeLabel(b));
  if (b.label) {
    const chip = document.createElement('span');
    chip.className = b.tier ? `tt-chip tt-chip-${b.tier}` : 'tt-chip tt-chip-other';
    chip.textContent = b.label;
    row.appendChild(chip);
  }
  if (b.effort) {
    const meter = document.createElement('span');
    meter.className = 'tt-effort';
    const on = effortPips(b.effort);
    for (let i = 0; i < EFFORT_ORDER.length; i++) {
      const pip = document.createElement('span');
      pip.className = i < on ? 'tt-pip tt-pip-on' : 'tt-pip';
      meter.appendChild(pip);
    }
    const word = document.createElement('span');
    word.textContent = b.effort;
    meter.appendChild(word);
    row.appendChild(meter);
  }
  return row;
}

let tooltipKey = '';
function updateTooltip(): void {
  let target: Char | null = null;
  let prop: PropId | null = null;
  /** Over the post from head office (the badge or the counter envelope); `?hover=post` pins it for screenshots. */
  let post = false;
  let px = 0;
  let py = 0;
  if (debugHover === 'post' && updateCue.on) {
    post = true;
    px = view.ox + (POST_BADGE_RECT.x + POST_BADGE_RECT.w / 2) * view.scale;
    py = view.oy + (POST_BADGE_RECT.y + POST_BADGE_RECT.h) * view.scale;
  } else if (debugProp) {
    prop = debugProp;
    const r = PROP_ANCHORS[prop];
    px = view.ox + (r.x + r.w / 2) * view.scale;
    py = view.oy + (r.y + r.h) * view.scale;
  } else if (debugHover) {
    target = debugHover === 'manager' ? office.manager : debugHover === 'receptionist' ? office.receptionist
      : debugHover === 'cleaner' ? npcById(office.cleaner.id)
      : debugHover === 'vendor' ? npcById(office.vendor.id)
      : debugHover === 'dez' ? npcById(office.dez.id)
      : debugHover === 'fenwick' ? npcById(office.fenwick.id) : office.chars.get(debugHover) ?? null;
    if (target) { px = view.ox + target.x * view.scale + 10; py = view.oy + (target.y - 12) * view.scale; }
  } else if (keyProp && !mouse) {
    // A prop's keyboard stop has focus: its tooltip, under the prop.
    prop = keyProp;
    const r = PROP_ANCHORS[prop];
    px = view.ox + (r.x + r.w / 2) * view.scale;
    py = view.oy + (r.y + r.h) * view.scale;
  } else if (mouse && !dragging) {
    const m = toMap(view, mouse.x, mouse.y);
    const hit = hotspotAt(m.x, m.y, hotspots, office.hitTest(m.x, m.y)?.id ?? null);
    if (hit?.kind === 'char') target = charById(hit.id);
    else if (updateCue.hovering(m.x, m.y)) post = true;
    else if (hit?.kind === 'prop') prop = hit.id;
    px = mouse.x;
    py = mouse.y;
  }
  officeHover = target?.id ?? null;
  pointerProp = prop;
  postHover = post;
  updateCursor();
  const content = post ? updateCue.badgeTip() : target ? tooltipFor(target) : prop ? propTooltipFor(prop) : null;
  if (!content) {
    if (tooltip.style.display !== 'none') tooltip.style.display = 'none';
    tooltipKey = '';
    return;
  }
  const key = `${content.title}\n${content.lines.join('\n')}\n${content.hint ?? ''}\n${content.badge ? `${content.badge.tier}|${content.badge.label}|${content.badge.effort ?? ''}` : ''}`;
  if (key !== tooltipKey) {
    tooltipKey = key;
    tooltip.replaceChildren();
    const title = document.createElement('div');
    title.textContent = content.title;
    title.style.fontWeight = '600';
    tooltip.appendChild(title);
    if (content.badge) tooltip.appendChild(badgeRow(content.badge));
    for (const l of content.lines) {
      const d = document.createElement('div');
      d.textContent = l;
      d.style.opacity = '0.9';
      tooltip.appendChild(d);
    }
    if (content.hint) {
      const d = document.createElement('div');
      d.textContent = content.hint;
      Object.assign(d.style, {
        marginTop: '4px', paddingTop: '3px', borderTop: '1px solid var(--vscode-editorHoverWidget-border, #454545)',
        color: 'var(--vscode-textLink-foreground, #3794ff)', fontSize: '12px',
      } satisfies Partial<CSSStyleDeclaration>);
      tooltip.appendChild(d);
    }
  }
  tooltip.style.display = 'block';
  const r = tooltip.getBoundingClientRect();
  let x = px + 14;
  let y = py + 16;
  if (x + r.width > cssW - 4) x = Math.max(4, px - r.width - 14);
  // Not enough room below (a short panel): sit beside the pointer rather than
  // above it, so the tooltip doesn't cover the person's head and name label.
  if (y + r.height > cssH - 4) y = Math.max(4, Math.min(cssH - r.height - 4, py - r.height / 2));
  tooltip.style.left = `${Math.round(x)}px`;
  tooltip.style.top = `${Math.round(y)}px`;
}

// ---------------------------------------------------------------------------
// Input: drag to pan, wheel to zoom, double-click to reset

let dragging = false;
let dragFrom: { x: number; y: number } | null = null;
/** Where the current press started, and whether it has moved far enough to be a drag. */
let pressAt: { x: number; y: number; moved: boolean } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pressAt = { x: e.clientX, y: e.clientY, moved: false };
  if (!view.pannable) return;
  dragging = true;
  dragFrom = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  updateView();
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (pressAt && !pressAt.moved && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) >= CLICK_SLOP) pressAt.moved = true;
  if (dragging && dragFrom) {
    camera = panBy(camera, localView(), mapRegion.w, mapRegion.h, e.clientX - dragFrom.x, e.clientY - dragFrom.y);
    dragFrom = { x: e.clientX, y: e.clientY };
    updateView();
    requestFrame(true);
  }
});
const endDrag = (e: PointerEvent): void => {
  if (!dragging) return;
  dragging = false;
  dragFrom = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  updateView();
};
canvas.addEventListener('pointerup', (e) => {
  const press = pressAt;
  pressAt = null;
  endDrag(e);
  if (!press || press.moved || e.button !== 0) return;
  // A click: whoever is under the pointer (a worker always wins over a prop), else the prop.
  const m = toMap(view, e.clientX, e.clientY);
  const char = office.hitTest(m.x, m.y);
  // Post from head office waiting: the receptionist and the badge hand over the memo (the counter still opens the Front desk).
  if (updateCue.click(updateCue.targetAt(m.x, m.y, char, PROP_ANCHORS.frontDesk))) return;
  const spot = hotspotAt(m.x, m.y, hotspots, char?.id ?? null);
  if (spot?.kind === 'prop') {
    const panel = propAction(spot.id);
    if (panel) openPanel(panel);
    return;
  }
  if (!char) return;
  if (isNpc(char)) return;
  if (char.kind === 'receptionist') openPanel(FRONT_DESK_ID);
  else if (viewMode) return;
  else if (char.kind === 'manager') openMemo(caseFile.openId);
  else if (char.agent) openWorker(char.id);
});
canvas.addEventListener('pointercancel', (e) => { pressAt = null; endDrag(e); });
canvas.addEventListener('pointerleave', () => { mouse = null; updateCursor(); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1));
  camera = clampCamera(zoomAt(camera, localView(), mapRegion.w, mapRegion.h, e.clientX - mapRegion.x, e.clientY - mapRegion.y, factor), mapRegion.w, mapRegion.h, MAP_PX_W, MAP_PX_H, dpr);
  updateView();
  requestFrame(true);
}, { passive: false });
canvas.addEventListener('dblclick', () => {
  camera = defaultCamera();
  updateView();
  requestFrame(true);
});

// ---------------------------------------------------------------------------
// Main loop

let rafId = 0;
let lastFrame = -Infinity;
let lastSim = -1;
let lastTickAt = -Infinity;

function frame(now: number): void {
  rafId = 0;
  if (document.hidden) return;
  if (now - lastFrame < FRAME_MS - 2) {
    rafId = requestAnimationFrame(frame);
    return;
  }
  lastFrame = now;
  tick(now);
  rafId = requestAnimationFrame(frame);
}

function tick(now: number): void {
  lastTickAt = performance.now();
  if (!scene) scene = new Scene();
  if (lastSim < 0) lastSim = now;
  const gap = now - lastSim;
  if (gap > RESUME_SNAP_MS) office.fastForward(now);
  office.update(now, Math.min(gap, 100), hostNow());
  lastSim = now;
  if (now - letterboxCheckedAt > 2000) {
    letterbox = readLetterbox();
    if (document.body.style.background !== letterbox) document.body.style.background = letterbox;
    letterboxCheckedAt = now;
  }
  // The roster only shows when somebody is in, and a strip list's columns depend on how many: re-layout when that changes.
  if (office.chars.size !== layoutPeople || office.hasSnapshot !== layoutHasSnapshot) {
    layoutPeople = office.chars.size;
    layoutHasSnapshot = office.hasSnapshot;
    updateView();
  }
  // The walk-ons are not clickable, so hovering them does not outline them.
  const highlightChar = officeHover !== null ? charById(officeHover) : null;
  const highlight = rosterHover ?? (highlightChar && isNpc(highlightChar) ? null : officeHover);
  // A narrow view (the pan camera) frames the sulking boss as well as his office; the focus eases there and back.
  {
    const want = office.managerSulking && camera.cx === null ? framingFocusX(mapRegion.w / view.scale, SULK_FRAME, CAMERA_FOCUS_X) : CAMERA_FOCUS_X;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = view.pannable && !reduced ? easeToward(focusX, want, Math.min(now - focusAt, 100), 220) : want;
    focusAt = now;
    if (next !== focusX) { focusX = next; updateView(); }
  }
  updateExtras(now);
  sceneExtras.hoverProp = debugProp ?? pickHoverProp(pointerProp, barProp);
  if (viewMode) {
    // Only the Front desk is outlined (the clock and calendar show a tooltip and no outline); no cabinet hover.
    if (sceneExtras.hoverProp && propAction(sceneExtras.hoverProp) === null) sceneExtras.hoverProp = null;
  } else {
    // The filing cabinets open a drawer while they (or the File room's icon-bar button) are hovered.
    sceneExtras.cabinetHover = sceneExtras.hoverProp === 'filingCabinets';
  }
  // Post from head office: the envelope and badge on the counter, and now and then the receptionist's line.
  sceneExtras.post = updateCue.tick(now);
  scene.render(office, applier.settings, now, highlight, sceneExtras);
  blit();
  const vis = visibleDeviceRect();
  // A name label helps find someone picked in the roster; when hovering them
  // in the office the tooltip already says who it is.
  const backText = sceneExtras.usage?.back;
  screenCtx.save();
  try {
    clipToRegion();
    overlay.render(screenCtx, office, applier.settings, now, view, dpr, vis, rosterHover, backText ? [signRect, backSignBox(`BACK ${backText}`)] : [signRect]);
    if (office.hasSnapshot && office.chars.size === 0) overlay.renderEmptyNote(screenCtx, view, dpr, vis, viewMode ? VIEW_EMPTY_NOTE_LINES : undefined);
  } finally {
    screenCtx.restore();
  }
  updateTooltip();
  if (roster?.visible && now - rosterUpdatedAt > 500) {
    roster.update(rosterEntries(office, hostNow()));
    rosterUpdatedAt = now;
  }
  roster?.setHighlight(officeHover ?? rosterHover);
  placeTip();
}

let rosterUpdatedAt = -Infinity;
let layoutPeople = 0;
let layoutHasSnapshot = false;

/** Ensures the loop is running (and optionally redraws right away). */
function requestFrame(immediate = false): void {
  if (document.hidden) return;
  if (immediate) lastFrame = -Infinity;
  if (!rafId) rafId = requestAnimationFrame(frame);
}

// Watchdog: if requestAnimationFrame stalls while the page is visible (some
// embedders and headless browsers stop issuing frames), keep ticking from a
// timer. When rAF runs normally this only does a cheap time comparison.
setInterval(() => {
  if (document.hidden) return;
  const now = performance.now();
  if (now - lastTickAt > 90) tick(now);
}, 40);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  } else {
    requestFrame(true);
  }
});

const params = new URLSearchParams(location.search);
/** Screenshot hooks (dev harness): `?case=<agentId>` opens a case file, `?memo=1` (or `?memo=<agentId>`) the memo, once the office is in. */
let startupOpen: { kind: 'case' | 'memo'; id: string | null } | null = viewMode ? null : params.get('case')
  ? { kind: 'case', id: params.get('case') }
  : params.get('memo') ? { kind: 'memo', id: params.get('memo') === '1' ? null : params.get('memo') } : null;

/** Host messages view mode drops: the host sends none of them there, so this only guards against a stray or late one. */
const VIEW_DROPPED: ReadonlySet<string> = new Set([
  'openMemo', 'projects', 'taskStarted', 'caseFile', 'caseAppend', 'caseClosed', 'caseTabs', 'turn', 'planText', 'catalog', 'fileRoots', 'dirListing', 'fileText',
]);

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (viewMode && VIEW_DROPPED.has(msg.type)) return;
  if (msg.type === 'agents') {
    const raw = Array.isArray(msg.agents) ? msg.agents : [];
    office.applySnapshot(raw, performance.now(), hostNow());
    agentList = raw.map((a) => normalizeAgent(a, hostNow())).filter((a): a is AgentView => a !== null);
    inbox.prune(agentList, hostNow());
    markExtrasDirty();
    rosterUpdatedAt = -Infinity;
    requestFrame();
    caseFile.refresh();
    memo.refresh();
    drawer.refresh();
    if (startupOpen) {
      const s = startupOpen;
      startupOpen = null;
      if (s.kind === 'case' && s.id) openWorker(s.id);
      else if (s.id === 'prefill') {
        // Dev harness: `?memo=prefill&prefill=<sessionId>` opens the memo as a panel's Reply would (a prompt, a worker and options).
        openMemo(null, undefined, { sessionId: params.get('prefill') || 'sess-demo-2', prompt: 'Thanks. Please also add a test for the empty case.', options: { model: 'haiku', effort: 'max', permissionMode: 'plan' } });
      } else openMemo(s.id);
    }
  } else if (msg.type === 'settings' && msg.settings) {
    applier.setHost(msg.settings);
    settingsSeen = true;
    afterApply(applier.apply());
    // The Front desk reads `hostTheme()` / `hostSettings()`, so they are current before it hears about the message.
    hostBus.emit(msg);
    rosterUpdatedAt = -Infinity;
    caseFile.refresh();
    memo.refresh();
    requestFrame(true);
  } else if (msg.type === 'projects' || msg.type === 'taskStarted') {
    memo.handle(msg);
  } else if (msg.type === 'openMemo') {
    openMemo(null, typeof msg.projectPath === 'string' && msg.projectPath ? msg.projectPath : undefined);
  } else if (msg.type === 'error') {
    // An error with a reqId answers a getTurn/getPlan (or a Front desk call): the mounted panel shows it, never a toast.
    if (routePanelMessage(drawer, msg, hostBus)) return;
    if (!memo.handle(msg) && !caseFile.showError(msg)) showToast(String(msg.message ?? 'Something went wrong.'));
  } else if (msg.type === 'caseFile' || msg.type === 'caseAppend' || msg.type === 'caseClosed') {
    caseFile.handle(msg);
  } else if (msg.type === 'claudeDefaults' || msg.type === 'sessionOptions') {
    // Model/effort defaults for the memo and the case chips; replies to the case chips (task 3.4).
    if (msg.type === 'claudeDefaults') latestDefaults = msg.defaults && typeof msg.defaults === 'object' ? msg.defaults : null;
    memo.handle(msg);
    caseFile.handle(msg);
    if (msg.type === 'claudeDefaults') drawer.refresh();
  } else if (msg.type === 'usage') {
    latestUsage = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
    markExtrasDirty();
    requestFrame();
    drawer.refresh();
  } else if (msg.type === 'turn' || msg.type === 'planText') {
    routePanelMessage(drawer, msg);
  } else if (msg.type === 'catalog' || msg.type === 'fileRoots' || msg.type === 'dirListing' || msg.type === 'fileText') {
    // The Round B replies. The phone and the bookshelf take the latest `mcp` and `skills` catalog (an MCP request is answered
    // several times under one reqId, and the lights follow each answer); the mounted panel gets the message itself.
    if (sceneCatalog.observe(msg, hostNow())) {
      persist(sceneCatalog.saved());
      markExtrasDirty();
      requestFrame();
    }
    routePanelMessage(drawer, msg);
  } else if (msg.type === 'frontDesk' || msg.type === 'frontDeskDone') {
    // The Front desk listens through the bus only: it has no `handle`, and the drawer must not see these as well.
    routePanelMessage(drawer, msg, hostBus);
  } else if (msg.type === 'update') {
    // Update info (both modes): `routePanelMessage` keeps it in the update store (the in-office cue, the head office memo) and
    // passes it to the Front desk's About tab on the bus.
    routePanelMessage(drawer, msg, hostBus);
  } else if (msg.type === 'caseTabs') {
    // The workers with an open case tab (office view only; replayed on ready): their staff rows are marked, a click focuses the tab.
    caseTabs = caseTabIds(msg.agentIds);
    roster?.setTabs(caseTabs);
  } else if (msg.type === 'openFrontDesk') {
    // `openFrontDesk{tab?}`: the Front desk (a case file steps aside), then the tab asked for.
    if (openPanel(FRONT_DESK_ID) && isFrontDeskTab(msg.tab)) frontDeskView.openTab(msg.tab);
  }
});
window.addEventListener('resize', layoutAll);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(canvas);

/** Tells every part that cares how wide the webview is. */
function layoutAll(): void {
  applyStrip();
  caseFile.setViewport(window.innerWidth);
  drawer.setViewport(window.innerWidth);
  iconBar?.setWidth(window.innerWidth - dockedW);
  resize();
}

layoutAll();
// Dev harness only (it defines `__harnessClock`): lets scripted checks read the office, the theme applier, the scene extras and prop positions.
if (typeof (window as unknown as { __harnessClock?: unknown }).__harnessClock === 'function') {
  (window as unknown as Record<string, unknown>)['__officeDebug'] = {
    office, applier,
    /** The scene extras last drawn (phone lights, shelf count, cabinet hover...). */
    extras: () => sceneExtras,
    /** Screen position (CSS px) of a prop's centre, for scripted clicks and hovers. */
    propCentre: (id: PropId) => {
      const r = PROP_ANCHORS[id];
      return { x: view.ox + (r.x + r.w / 2) * view.scale, y: view.oy + (r.y + r.h / 2) * view.scale };
    },
    /** Screen position (CSS px) of a character's body, for scripted clicks. */
    charCentre: (id: string) => {
      const c = charById(id);
      return c ? { x: view.ox + c.x * view.scale, y: view.oy + (c.y - 8) * view.scale } : null;
    },
    /** The map's rectangle on screen (CSS px), the room it is fitted into, and whether the view is a strip. */
    layout: () => ({ map: { x: view.ox, y: view.oy, w: MAP_PX_W * view.scale, h: MAP_PX_H * view.scale }, region: { ...mapRegion }, strip, caseTabs: [...caseTabs] }),
    /** Opens the head office memo for the current update info (false when there is nothing to say). */
    openUpdateMemo: () => updateMemoView.open(),
    /** The food cart comes in now (the vendor pushes it to its spot; the boss and idle agents may go over). No-op while it is in. */
    summonCart: () => office.debugSummonCart(performance.now()),
    /** The cleaner starts a round now (an empty desk, the kitchen counter or the bin). No-op while they are in. */
    summonCleaner: () => office.debugSummonCleaner(performance.now()),
    /** The IT pair (Dez and Fenwick) arrive now for a visit. No-op while they are in. */
    summonItCrew: () => office.debugSummonItCrew(performance.now()),
    /** The boss's snoop is due now: he goes as soon as he is free (not while a visit, the door or the food cart has him). */
    snoopNow: () => office.debugSnoopNow(performance.now()),
    /** Screen position (CSS px) of the head office post badge's centre. */
    postCentre: () => ({ x: view.ox + (POST_BADGE_RECT.x + POST_BADGE_RECT.w / 2) * view.scale, y: view.oy + (POST_BADGE_RECT.y + POST_BADGE_RECT.h / 2) * view.scale }),
  };
}
// Dev harness hooks for the Front desk: `?tab=` picks the first tab, `?person=<slot>` opens that person on the Staff tab, and
// `?set=<path>=<value>,...` / `?autoedit=` make draft edits as soon as the panel is built (see `parseStartEdits`).
{
  const tab = params.get('tab');
  if (isFrontDeskTab(tab)) frontDeskView.openTab(tab);
  const edits = parseStartEdits(params);
  if (edits.length > 0) {
    let done = false;
    registerFrontDeskTab('staff', (api) => {
      if (!done) {
        done = true;
        queueMicrotask(() => { for (const [path, value] of edits) api.edit(path, value); });
      }
      return createStaffTab(api);
    });
  }
}
// Reopen the panel that was open before a reload (a `?panel=<id>` URL parameter, used by the dev harness, wins).
{
  const restore = panelToRestore(savedState, (id) => host.has(id), params.get('panel'));
  if (restore) openPanel(restore);
  const person = params.get('person');
  // A little later, once the drawer has its final width (the Staff tab picks its layout from it).
  if (person && restore === FRONT_DESK_ID) window.setTimeout(() => { openStaffSlot(person); }, 800);
}
vscode.postMessage({ type: 'ready' });
