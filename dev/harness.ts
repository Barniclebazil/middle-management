// Browser stand-in for the VS Code webview host. Loaded before dist/webview.js.
// Params: ?t=<seconds into the demo loop> &speed=<n> &freeze=1 &company=<name> &branch=<name>
//   &empty=1 (no sessions: the empty state) &theme=light|dark|hc (VS Code-ish theme colours; hc = Dark High Contrast)
// View mode (v0.5): &mode=view renders the office as the extension does for claudeOffice.mode = 'view' (harness.html sets
//   <body data-office-mode="view"> before the webview runs): no icon bar, rail, staff list or New task button, the Front desk is the
//   only panel, workers and props do nothing, the extras are usage-only. This mock host answers the Front desk's calls as usual and
//   refuses everything else but ready / refreshUsage / closeCase with viewRefusal (as demoMode does for its set), and the Front desk
//   Settings tab shows "Office mode" as view. Default: manager mode.
// Manager Mode (handled by the webview or this mock host):
//   &case=<agentId> opens that case file   &memo=1 opens the assignment memo (&memo=<agentId>: opened from that worker)
//   &pending=permission|question|plan  forces that request on the open case (or on its usual demo worker)
//   &openMemo=<projectPath> posts openMemo after ready (the `Middle Management: New Task` command)
//   Replies containing "fail" answer with an inline error; a decide whose message contains "fail" answers with a requestId error.
//   &replyError=1 shows the inline reply error on the open case without typing (screenshots)
//   &manager=<name> the manager's name   &scroll=top leaves the case file scrolled up (shows the "new" pill)
//   &slowCase=1 never answers openCase (the case file's loading state)   &demoMode=1 answers like the extension in demo mode
//   &tip=0 hides the first-run tip
// Model / effort / approvals (task 3.4): a `claudeDefaults` message is sent after ready (&defaults=0 skips it, so the labels read
//   plain "Default"). Case headers carry effort, canSetOptions and next. setSessionOptions is answered after 500 ms: an office run
//   applies (then the header follows), a free session defers (header `next`).
//   &chips=office|free|external|old  forces the open case (&case=) to that kind; old = Claude Code too old (the change is refused)
//   &popover=model|effort|approvals[:<itemId>]  opens that chip's menu once the case file is in (and picks that item)
//   &memo=prefill[&prefill=<sessionId>] opens the memo as an In-tray Reply would (default sess-demo-2: prompt, worker, haiku + max effort + plan)
//   &memoPick=<v>,<v>  clicks memo choices by value once the memo is open (e.g. max,sonnet shows the effort clamp note)
//   demo-1's file has plan items in every status (pending too with &pending=plan)
// Office tools (task 4.1): the icon bar, the panel drawer, the clock ring, calendar, in-tray, desk piles and plan notes are live.
//   &panel=inbox|plans|usage|directory|frontdesk  opens that panel once the page is up (handled by the webview; unknown ids are ignored)
//   &usage=ok|warn|danger|blocked|stale|apiKey|signedOut|extra|none  the usage snapshot the mock host sends after ready (default ok; none = no
//     message, so the clock and calendar stay plain). warn = 72% / week 64%, danger = 93% / week 88%, blocked = 100% with a BACK card on the
//     clock, stale = a 47-minute-old reading, apiKey = API-key billing (cost instead of windows), signedOut = probe says not signed in,
//     extra = extra usage in GBP. refreshUsage is answered after 1.5 s with a fresh reading (running first).
//   &hover=prop:<id>  pins a hover on a prop (clock, calendar, inTray, whiteboard, directoryBoard, frontDesk, ...): outline plus tooltip.
//     (&hover=<agentId>|manager pins a worker's hover, as before.)
//   &inbox=empty|urgent  empty: nothing in the in-tray (no reports, no plans, nobody knocking); urgent: a plan, a permission and a question
//     all waiting at once, no reports. Default: a few finished reports, plans in every state, and the usual knocks over the demo loop.
//   &ctx=<pct>  every worker's context use (0-100): grows the desk paper piles (4 sheets from 76%, a red top sheet from 90%).
//   &persist=1  keeps the webview's saved state in sessionStorage, so a reload reopens the same panel and keeps the read marks.
//   getTurn (a report's turn) and getPlan (a plan's full text) are answered after 400 ms; a report or plan whose title contains "fail" answers
//   with an error carrying the reqId. Workers carry model, effort, context, lastReport and plans.
// Round B office tools (v0.4): the filing cabinets, bookshelf, phone, notice board and temp agency open the File room, Training library,
//   Phone, Office handbook and Temp agency (icon bar, Directory and keyboard too); this file answers the seven new messages
//   (getFileRoots, listDir, readFile, openFile, openDiff, getCatalog, openConfigFile) from dev/roundBMock.ts, which reuses the data of the
//   panel playground (dev/panelsFiles.ts, dev/panelsDesk.ts).
//   &panel=files|library|phone|handbook|agency  opens that panel (handled by the webview, like the Round A ids)
//   &phone=ok|mixed|bad|many|connecting|none  the phone lights the office starts with, as if the Phone had been opened already (default none:
//     the phone stays dark until a panel asks). &shelf=<n>  the bookshelf's book count to start with (0 = empty shelves; default: the classic shelf).
//     Both are sent as ordinary catalog replies, so the real scene-state path is exercised.
//   &hover=prop:filingCabinets  pins the cabinet hover (the drawer slides open)
//   the playground's panel params work here too: &fr= &frlag= (file room), &lib= &liblag= (library), &desk= &delay= (phone, handbook, agency);
//     &openfail=1 answers openFile / openDiff / openConfigFile with a toast; &demoMode=1 refuses all seven like the extension in demo mode.
//   window.__harnessPosted lists everything the webview posted (check `refresh: true` on a Refresh press).
// Front desk (task 4.7): the receptionist, the counter and the bell open the real panel; this file plays the extension host for it
//   (dev/frontDeskMock.ts: getFrontDesk, themeAction, setSetting, saveTheme, saveThemeAs answered in the real order settings -> frontDesk
//   -> frontDeskDone, and `settings` (with the theme) re-sent after every change, so the office updates). The mock's names are made up.
//   &panel=frontdesk&tab=theme|settings|staff|colours  opens the Front desk on that tab (webview hooks, like &panel=)
//   &person=<slot>  with tab=staff: opens that person's page (sign, manager, receptionist, staff-0..7, temp-0..5)
//   &fd=builtin|preset|file|conflict|errors|workspace|notObject  what the host reports as the theme source (default builtin; &theme=<url>
//     without &fd= counts as a file). preset serves the real packaged /media/themes/example.theme.json.
//        conflict = the first Save finds the file changed on disk; errors = a file with problems (last good theme in use);
//        workspace = the theme path comes from workspace settings (read-only) and some settings are overridden by the workspace;
//        notObject = the file is not a JSON object (read-only)
//   &set=<path>=<value>,...  draft edits made as soon as the panel is built, e.g. set=colors.wall=#cfe3e0,colors.carpet=#3f5f73
//     (also &autoedit=1|bad); needs the panel to be open (&panel=frontdesk). &persist=1 keeps the saved draft across reloads.
//   &lag=<ms> reply delay (default 350)  &savelag=<ms>  &fail=theme|save|setting  &dialog=cancel  &diskchange=<ms>  (see frontDeskMock.ts)
//   &hover=receptionist  pins the receptionist's hover tooltip   &hover=cleaner  pins the cleaner's (only while they are in)   &empty=1 still shows her (no sessions, only her and the manager)
//   &hover=vendor  pins the food cart vendor's tooltip (only while they are in)   &hover=dez|fenwick  pins the IT pair's tooltip (only while they are in)
//   Scripted checks of the walk-on characters use window.__officeDebug (set by the webview in this harness only):
//     .summonCart()     the food cart comes in now: the vendor pushes it from the elevator to its spot in the bullpen aisle (tile 19,12; the cart
//                       fills 20,12 and a bit of 21,12), calls out, stays parked 90 s, then pushes it back out. The boss goes to pick a snack at (22,12)
//                       once per arrival; idle agents may stand at (20,11) and (21,11). No-op while the cart is in.
//     .summonCleaner()  the cleaner starts a round now (an empty desk, the kitchen counter or the bin). No-op while they are in.
//     .summonItCrew()   Dez and Fenwick (IT support) arrive now for a visit; they leave together. No-op while they are in.
//     .snoopNow()       the boss's snoop is due now; he goes as soon as he is free (a visit, the door, a sulk or the food cart come first).
//     .office.vendorOnStage / .office.cleanerOnStage / .office.itCrewOnStage tell whether they are in; .charCentre(id) finds them for a hover (ids __vendor__, __cleaner__, __it_dez__, __it_fenwick__).
//   window.__harnessFrontDesk is the mock host (diskChange(), state(), theme) for scripted checks.
// Office strip and case tabs (v0.5, task 9.2): a wide, short window (width >= 2 x height, height <= 600, width >= 1000) is laid out
//   as the strip: icon rail, map, staff list. There a worker click posts openCaseTab; this file plays the host: it logs it, keeps
//   the list of open tabs and answers with `caseTabs` (no tab is drawn). A staff row's x posts sendHome: an idle main worker leaves
//   the snapshot (and their temps with them), so the office walks them out; a busy one gets the host's refusal (an error with
//   agentId). &demoMode=1 refuses both, like the extension. `caseTabs` is sent after ready ([] in demo mode).
//   &tabs=<agentId>,...  starts with those workers' tabs open (their rows carry the "In tab" mark)
//   &strip=1  shows the page in a 2000 x 400 frame (the office panel moved to the top of a big window), scaled to fit the browser
//     window; &strip=<w>x<h> picks another size (e.g. 1600x360). Handled in harness.html; the frame loads this page without it.
//   window.__harnessCaseTabs() returns the open tabs, window.__harnessSentHome() the workers sent home.
// Custom staff themes: &theme=<url> (any value other than light|dark; or &themeFile=<url>) fetches that theme JSON, runs it through
//   parseTheme and posts it as settings.theme (e.g. &theme=/media/themes/example.theme.json). Problems are logged to the console.
// Desks by model and the Fable spell (task H3): demo-1 opus, demo-2 sonnet, demo-3 fable (it evicts the boss), demo-4 sonnet, demo-5 haiku,
//   demo-6 no model. &spell=<ms> sets how long a Fable spell lasts (the office's evictionMs; default 5 min), e.g. spell=20000.
//   &fableLate=<ms> keeps demo-3 out of the office until that long after the page opened, so the spell starts on an arrival (the boss's
//   walk-out and his line) instead of quietly on the first snapshot. &fable=0 runs demo-3 on Opus instead (no spell at all).
//   &crowd=<1-12> adds that many extra workers and temps of every tier (opus, sonnet, haiku, none) to see how the floor fills;
//     crowd-6 runs a model id the office does not know (a grey chip in its hover).
// Update notice (the in-office cue and the head office memo): &update=available|hidden|downloading|installed|error|checking|upToDate|idle
//   posts that `update` after ready (default: none, as before a first check). available and installed show the cue (the receptionist's
//   line, the envelope and badge on her counter; a click on her or the badge opens the memo); hidden = put off (About tab only).
//   &updateMemo=1 opens the memo once the office is in (also for error, downloading and checking, which have no cue).
//   &updateLatest=<v> (default 0.6.0)  &updateNotes=0 (no release notes link)  &updateAuto=0 (automatic checks off)
//   updateAction is answered in every mode: install -> downloading -> installed after &updateLag=<ms> (default 2200; &updateFail=1
//   ends in an error), later / skip -> hidden, check -> checking -> available (upToDate with &update=upToDate), reload / notes are logged.
//   &hover=post pins the badge's tooltip.
import { DemoFeed, LOOP_MS } from '../src/demo/demoFeed.ts';
import { demoRefusal } from '../src/host/demoGuard.ts';
import { viewRefusal } from '../src/host/viewGuard.ts';
import { parseTheme } from '../src/shared/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { MockHost } from './frontDeskMock.ts';
import { createRoundBMock } from './roundBMock.ts';
import type {
  AgentControl, AgentSnapshot, CaseHeader, ClaudeDefaults, ConversationItem, EffortLevel, HostToWebview, PendingKind, PendingRequest, PlanRef, PlanStatus,
  ProjectOption, SessionOptions, UpdateAction, UpdateInfo, UsageSnapshot, WebviewToHost,
} from '../src/shared/protocol.ts';

const params = new URLSearchParams(location.search);
const startOffset = Number(params.get('t') ?? '0') * 1000;
const speed = Number(params.get('speed') ?? '1') || 1;
const frozen = params.get('freeze') === '1';
const company = params.get('company') ?? 'Middle Management';
const branch = params.get('branch') ?? 'Riverside Branch';
const managerName = params.get('manager') ?? 'You';
const empty = params.get('empty') === '1';
const forcedKind = ((): PendingKind | null => {
  const p = params.get('pending');
  return p === 'permission' || p === 'question' || p === 'plan' ? p : null;
})();
const forcedCase = params.get('case');
const inboxMode = params.get('inbox');
const ctxParam = params.get('ctx');
const forcedCtx = ctxParam !== null && ctxParam !== '' && Number.isFinite(Number(ctxParam)) ? Math.max(0, Math.min(100, Number(ctxParam))) : null;
/** A positive number param, or null. */
const msParam = (name: string): number | null => { const v = Number(params.get(name) ?? ''); return Number.isFinite(v) && v > 0 ? v : null; };
/** `&spell=<ms>`: the Fable spell's length; `&fableLate=<ms>`: demo-3 (the Fable worker) arrives this long after the page opened. */
const spellMs = msParam('spell');
const fableLateMs = msParam('fableLate');
const crowdN = Math.min(12, Math.floor(msParam('crowd') ?? 0));

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'panel-background': '#181818', 'sideBar-background': '#1f1f1f', 'editor-background': '#1f1f1f', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
    'list-hoverBackground': '#2a2d2e', 'editorWarning-foreground': '#cca700', 'panel-border': '#2b2b2b', 'focusBorder': '#0078d4',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c', 'input-background': '#313131', 'input-foreground': '#cccccc',
    'input-border': '#3c3c3c', 'textCodeBlock-background': '#2b2b2b', 'textLink-foreground': '#4daafc', 'badge-background': '#616161',
    'badge-foreground': '#f8f8f8', 'errorForeground': '#f85149', 'list-inactiveSelectionBackground': '#37373d',
    'inputValidation-errorBackground': '#5a1d1d', 'inputValidation-errorBorder': '#be1100', 'editorHoverWidget-background': '#202020',
    'editorHoverWidget-border': '#454545', 'editorHoverWidget-foreground': '#cccccc',
  },
  light: {
    'panel-background': '#f8f8f8', 'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171',
    'list-hoverBackground': '#e8e8e8', 'editorWarning-foreground': '#bf8803', 'panel-border': '#e5e5e5', 'focusBorder': '#005fb8',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b',
    'input-border': '#cecece', 'textCodeBlock-background': '#f0f0f0', 'textLink-foreground': '#005fb8', 'badge-background': '#cccccc',
    'badge-foreground': '#3b3b3b', 'errorForeground': '#c72e0f', 'list-inactiveSelectionBackground': '#e4e6f1', 'testing-iconPassed': '#388a34',
    'inputValidation-errorBackground': '#f2dede', 'inputValidation-errorBorder': '#be1100', 'editorHoverWidget-background': '#f8f8f8',
    'editorHoverWidget-border': '#c8c8c8', 'editorHoverWidget-foreground': '#3b3b3b',
  },
  // VS Code's Dark High Contrast: black, white text, #6FC3DF contrast borders and #F38518 active/focus borders.
  hc: {
    'panel-background': '#000000', 'sideBar-background': '#000000', 'editor-background': '#000000', foreground: '#ffffff', descriptionForeground: '#ffffff',
    'list-hoverBackground': '#000000', 'editorWarning-foreground': '#ffd700', 'panel-border': '#6fc3df', focusBorder: '#f38518',
    contrastBorder: '#6fc3df', contrastActiveBorder: '#f38518', 'button-background': '#000000', 'button-foreground': '#ffffff', 'button-border': '#6fc3df',
    'button-hoverBackground': '#000000', 'button-secondaryBackground': '#000000', 'button-secondaryForeground': '#ffffff', 'button-secondaryHoverBackground': '#000000',
    'input-background': '#000000', 'input-foreground': '#ffffff', 'input-border': '#6fc3df', 'textCodeBlock-background': '#000000', 'textLink-foreground': '#21a6ff',
    'badge-background': '#000000', 'badge-foreground': '#ffffff', errorForeground: '#f48771', 'list-inactiveSelectionBackground': '#000000',
    'inputValidation-errorBackground': '#000000', 'inputValidation-errorBorder': '#f48771', 'editorHoverWidget-background': '#0c141f',
    'editorHoverWidget-border': '#6fc3df', 'editorHoverWidget-foreground': '#ffffff', 'editorWidget-background': '#0c141f', 'editorWidget-border': '#6fc3df',
    'toolbar-hoverBackground': '#00000000', 'testing-iconPassed': '#73c991', 'dropdown-background': '#000000', 'dropdown-border': '#6fc3df',
    'checkbox-border': '#6fc3df', 'checkbox-background': '#000000', 'widget-border': '#6fc3df',
  },
};
const themeName = params.get('theme') ?? '';
const theme = THEMES[themeName];
if (theme) for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
// VS Code puts exactly one theme class on <body>: vscode-light, vscode-dark or vscode-high-contrast.
document.body.classList.add(themeName === 'light' ? 'vscode-light' : themeName === 'hc' ? 'vscode-high-contrast' : 'vscode-dark');

const demo = new DemoFeed();
const base = Math.floor(Date.now() / LOOP_MS) * LOOP_MS + (Number.isFinite(startOffset) ? startOffset : 0);
const wallStart = Date.now();
const clock = (): number => (frozen ? base : base + (Date.now() - wallStart) * speed);

const posted: unknown[] = [];
let feeding = false;

function send(msg: HostToWebview): void {
  window.postMessage(msg, '*');
}

// ---------------------------------------------------------------------------
// The demo office, decorated for Manager Mode

const HOME = '/home/user/Projects';
interface StaffExtra { control: AgentControl; branch: string; model: string; effort?: EffortLevel; cost?: number; next?: SessionOptions }
const EXTRA: Record<string, StaffExtra> = {
  'demo-1': { control: 'office', branch: 'refactor/auth-refresh', model: 'claude-opus-5-5', effort: 'xhigh', cost: 0.42 },
  'demo-2': { control: 'free', branch: 'main', model: 'claude-sonnet-5-5', effort: 'low', next: { model: 'opus' } },
  'demo-3': { control: 'elsewhere', branch: 'feat/landing-hero', model: params.get('fable') === '0' ? 'claude-opus-5-5' : 'claude-fable-5-1', effort: 'max' },
  'demo-4': { control: 'office', branch: 'migrate-invoices', model: 'claude-sonnet-5-5', effort: 'high', cost: 1.87 },
  'demo-5': { control: 'free', branch: 'chore/deps-audit', model: 'claude-haiku-5-5', effort: 'medium' },
  'demo-6': { control: 'office', branch: 'docs/api-guide', model: '', cost: 0.18 },
};
/** The user's Claude Code defaults and model list, as the host would send them. */
const DEFAULTS: ClaudeDefaults = {
  model: 'opus', effort: 'xhigh', effortByModel: { sonnet: 'high' },
  models: [
    { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-4-5', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001', efforts: [] },
    { value: 'opus[1m]', label: 'Opus (1M)', resolved: 'claude-opus-5-5[1m]', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
};
/** `&chips=`: force the open case's kind. */
const chipsMode = params.get('chips');
/** Options the mock applied (office runs) or stored for the next message (free sessions), per agent. */
const appliedOpts = new Map<string, SessionOptions>();
const nextOpts = new Map<string, SessionOptions>();
/** Which worker usually knocks with which request, and when (seconds into the loop). */
const KNOCKS: { id: string; kind: PendingKind; from: number; to: number }[] = [
  { id: 'demo-1', kind: 'plan', from: 62, to: 92 },
  { id: 'demo-4', kind: 'permission', from: 70, to: 92 },
  { id: 'demo-6', kind: 'question', from: 78, to: 100 },
];

/** `&crowd=<n>`: extra workers and temps of every tier (taken in this order), to see how the desks fill. */
const CROWD: (Pick<AgentSnapshot, 'id' | 'kind' | 'title' | 'activity' | 'model' | 'effort' | 'parentId' | 'detail'> & { project?: string })[] = [
  { id: 'crowd-1', kind: 'main', title: 'Port the search index', activity: 'writing', model: 'claude-opus-5-5', effort: 'high', detail: 'src/index/build.rs' },
  { id: 'crowd-1-t1', kind: 'temp', parentId: 'crowd-1', title: 'Benchmark runner', activity: 'running', model: 'claude-haiku-5-5', detail: 'cargo bench' },
  { id: 'crowd-2', kind: 'main', title: 'Tidy lint warnings', activity: 'reading', model: 'claude-haiku-5-5', effort: 'low', detail: 'eslint.config.js' },
  { id: 'crowd-3', kind: 'main', title: 'Add a dark-mode toggle', activity: 'thinking', model: 'claude-sonnet-5-5', effort: 'medium' },
  { id: 'crowd-3-t1', kind: 'temp', parentId: 'crowd-3', title: 'Colour token survey', activity: 'searching', model: 'claude-sonnet-5-5', detail: '--color-' },
  { id: 'crowd-4', kind: 'main', title: 'Plan the billing rewrite', activity: 'planning', model: 'claude-opus-5-5', effort: 'max' },
  { id: 'crowd-4-t1', kind: 'temp', parentId: 'crowd-4', title: 'Schema explorer', activity: 'reading', model: 'claude-opus-5-5', detail: 'db/schema.sql' },
  { id: 'crowd-5', kind: 'main', title: 'Rename config keys', activity: 'writing', model: 'claude-haiku-5-5', effort: 'medium', detail: 'config/defaults.ts' },
  { id: 'crowd-2-t1', kind: 'temp', parentId: 'crowd-2', title: 'Rule checker', activity: 'searching', model: 'claude-haiku-5-5', detail: 'no-unused-vars' },
  { id: 'crowd-6', kind: 'main', title: 'Triage open issues', activity: 'researching', model: 'gateway/experimental-preview-model-20260101' },
  { id: 'crowd-7', kind: 'main', title: 'Speed up the test suite', activity: 'running', model: 'claude-sonnet-5-5', effort: 'high', detail: 'npm test' },
  { id: 'crowd-7-t1', kind: 'temp', parentId: 'crowd-7', title: 'Slow test finder', activity: 'running', detail: 'npm test -- --reporter=json' },
];

/** Workers sent home with a staff row's x (they leave the snapshot, with their temps). */
const sentHome = new Set<string>();
/** Workers whose case tab is "open", in opening order (`&tabs=` seeds it). */
let caseTabsOpen: string[] = params.get('demoMode') === '1' ? [] : (params.get('tabs') ?? '').split(',').map((x) => x.trim()).filter((x, i, a) => x !== '' && a.indexOf(x) === i).slice(0, 20);
function sendCaseTabs(): void {
  send({ type: 'caseTabs', agentIds: [...caseTabsOpen] });
}

/** Agents hired from the memo in this session. */
interface Hire { snap: AgentSnapshot; model: string; effort?: EffortLevel; busyUntil: number }
const hires: Hire[] = [];
/** Control changes made by the mock (a free worker resumed in the office). */
const controlOverride = new Map<string, AgentControl>();
/** Requests already answered (by requestId). */
const answered = new Set<string>();
/** Per-agent extra cost from replies. */
const extraCost = new Map<string, number>();
/** Agents mid-reply (busy) until this clock time. */
const busyUntil = new Map<string, number>();

function loopIndex(now: number): number {
  return Math.floor(now / LOOP_MS);
}

function pendingFor(id: string, now: number): { requestId: string; kind: PendingKind } | null {
  const t = (((now % LOOP_MS) + LOOP_MS) % LOOP_MS) / 1000;
  let kind: PendingKind | null = null;
  if (inboxMode === 'empty') return null;
  if (inboxMode === 'urgent') kind = KNOCKS.find((k) => k.id === id)?.kind ?? null;
  else if (forcedKind && (forcedCase ? id === forcedCase : KNOCKS.some((k) => k.id === id && k.kind === forcedKind))) kind = forcedKind;
  else for (const k of KNOCKS) if (k.id === id && t >= k.from && t < k.to) kind = k.kind;
  if (!kind) return null;
  const requestId = `${id}:${kind}:${loopIndex(now)}`;
  return answered.has(requestId) ? null : { requestId, kind };
}

function snapshot(): AgentSnapshot[] {
  if (empty) return [];
  const now = clock();
  const out = demo.snapshot(now).map((a) => {
    const x = EXTRA[a.kind === 'temp' && a.parentId ? a.parentId : a.id];
    const b: AgentSnapshot = { ...a, sessionId: `sess-${a.parentId ?? a.id}`, cwd: `${HOME}/${a.project}` };
    if (x) b.gitBranch = x.branch;
    b.control = a.kind === 'temp' ? 'none' : controlOverride.get(a.id) ?? x?.control ?? 'free';
    if (b.control === 'office') b.costUsd = (x?.cost ?? 0) + (extraCost.get(a.id) ?? 0);
    const p = a.kind === 'main' ? pendingFor(a.id, now) : null;
    if (p) {
      b.pending = p;
      b.activity = 'needsYou';
      b.status = 'waiting';
      delete b.detail;
    } else if (a.activity === 'needsYou' && b.control === 'office') {
      // An office-run worker only knocks with a real request; otherwise they're thinking it over.
      b.activity = 'thinking';
      b.status = 'working';
      delete b.detail;
    }
    if ((busyUntil.get(a.id) ?? 0) > Date.now() && !p) {
      b.activity = 'writing';
      b.status = 'working';
      b.detail = 'Replying to your memo';
    }
    if (inboxMode === 'empty' && b.activity === 'needsYou') {
      b.activity = 'thinking';
      b.status = 'working';
      delete b.detail;
    }
    if (a.kind === 'main') decorate(b, now);
    return b;
  }).filter((b) => !sentHome.has(b.id) && !(b.parentId && sentHome.has(b.parentId)))
    .filter((b) => fableLateMs === null || b.id !== 'demo-3' || Date.now() - wallStart >= fableLateMs);
  for (const c of CROWD.slice(0, crowdN)) {
    const b: AgentSnapshot = { ...c, project: c.project ?? 'side-projects', since: base - 40_000, startedAt: base - 600_000 + CROWD.indexOf(c) * 1000, status: 'working' };
    if (c.kind === 'main') { b.sessionId = `sess-${c.id}`; b.control = 'free'; } else b.control = 'none';
    if (!c.model) delete b.model;
    out.push(b);
  }
  for (const h of hires) {
    if (sentHome.has(h.snap.id)) continue;
    const busy = h.busyUntil > Date.now();
    const hired: AgentSnapshot = { ...h.snap, activity: busy ? 'writing' : 'idle', status: busy ? 'working' : 'idle', detail: busy ? 'Getting started' : undefined, costUsd: (extraCost.get(h.snap.id) ?? 0) + 0.03, model: h.model };
    if (h.effort) hired.effort = h.effort;
    if (forcedCtx !== null) hired.context = contextOf(forcedCtx);
    out.push(hired);
  }
  return out;
}

function agentById(id: string): AgentSnapshot | undefined {
  return snapshot().find((a) => a.id === id);
}

// ---------------------------------------------------------------------------
// Office tools: model/effort/context, reports, plans and usage

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Context use by worker when &ctx= is not given: a mix, one of them close to full. */
const DEFAULT_CTX: Record<string, number> = { 'demo-1': 62, 'demo-2': 35, 'demo-3': 81, 'demo-4': 12, 'demo-5': 95, 'demo-6': 48 };
const contextOf = (pct: number): NonNullable<AgentSnapshot['context']> => ({ tokens: Math.round(pct * 2000), max: 200_000, pct });
/** Plan decisions made through the mock (the whiteboard and the Plans panel see them). */
const planDecisions: { agentId: string; planId: string; title: string; at: number; decidedAt: number; status: PlanStatus }[] = [];
/** Finished reports by worker: minutes before the demo loop started (fixed times, so the in-tray keys stay stable). */
const REPORT_AGO: Record<string, number> = { 'demo-2': 9, 'demo-5': 190, 'demo-6': 1500 };

function reportText(a: AgentSnapshot): string {
  const s = scriptFor(a);
  return `## ${a.title}: done\n\n${s.reply}\n\nWhat changed:\n\n- one shared helper instead of copies\n- the failing check is fixed\n- nothing outside \`${s.edit.split('/')[0]}\` was touched\n\n\`\`\`${s.lang}\n${s.code}\n\`\`\`\n\nNot done: I left the follow-up for you to decide.`;
}

/** Adds model, effort, context, lastReport and plans to a main worker's snapshot. */
function decorate(b: AgentSnapshot, now: number): void {
  const x = EXTRA[b.id];
  if (x) {
    b.model = x.model;
    if (x.effort) b.effort = x.effort;
  }
  const pct = forcedCtx ?? DEFAULT_CTX[b.id];
  if (pct !== undefined) b.context = contextOf(pct);
  if (inboxMode === 'empty') return;
  const ago = REPORT_AGO[b.id];
  if (inboxMode !== 'urgent' && ago !== undefined) b.lastReport = { at: base - ago * MIN, text: reportText(b) };
  const plans = plansFor(b, now);
  if (plans.length) b.plans = plans;
}

function plansFor(b: AgentSnapshot, now: number): PlanRef[] {
  const plans: PlanRef[] = [];
  const t0 = base;
  if (b.id === 'demo-1') {
    if (inboxMode !== 'urgent') {
      plans.push(
        { id: 'p-first', at: t0 - 2 * DAY, title: 'First pass at the refresh refactor', status: 'superseded', chars: 900 },
        { id: 'p-rej', at: t0 - 3 * HOUR, decidedAt: t0 - 2 * HOUR, title: 'Rename the admin cookie to match', status: 'rejected', chars: 1_800 },
        { id: 'p-ok', at: t0 - 5 * HOUR, decidedAt: t0 - 4 * HOUR, title: 'Move refresh into one helper', status: 'approved', chars: 1_400 },
      );
    }
    if (b.pending?.kind === 'plan') plans.push({ id: `p-live-${loopIndex(now)}`, at: loopIndex(now) * LOOP_MS, title: 'Refactor plan: one place for session refresh', status: 'pending', chars: PLAN.length });
  }
  if (b.id === 'demo-4' && inboxMode !== 'urgent') plans.push({ id: 'p-idx', at: t0 - 26 * HOUR, decidedAt: t0 - 25 * HOUR, title: 'Add an index on invoices.customer_id', status: 'approved', chars: 1_100 });
  // A session running in Claude Code itself: its plan is read-only here.
  if (b.id === 'demo-3') plans.push({ id: 'p-ext', at: t0 - 70 * MIN, title: 'Restyle the hero and the pricing cards', status: 'pending', chars: 2_600 });
  for (const d of planDecisions) if (d.agentId === b.id) plans.push({ id: d.planId, at: d.at, decidedAt: d.decidedAt, title: d.title, status: d.status, chars: PLAN.length });
  return plans;
}

function makeUsage(kind: string): UsageSnapshot {
  const now = clock();
  const at = kind === 'stale' ? now - 47 * MIN : now - 2 * MIN;
  const base = (over: Partial<UsageSnapshot>): UsageSnapshot => ({ kind: 'plan', plan: 'Max', source: 'probe', probe: 'ok', asOf: at, windows: [], ...over });
  const w = (id: UsageSnapshot['windows'][number]['id'], pct: number | null, resetsInMin: number, over: Partial<UsageSnapshot['windows'][number]> = {}): UsageSnapshot['windows'][number] =>
    ({ id, pct, resetsAt: now + resetsInMin * MIN, asOf: at, ...over });
  switch (kind) {
    case 'warn': return base({ windows: [w('five_hour', 72, 95), w('seven_day', 64, 3 * 24 * 60), w('seven_day_opus', 81, 3 * 24 * 60), w('seven_day_sonnet', 22, 3 * 24 * 60)], nextAt: now + 4 * MIN });
    case 'danger': return base({ windows: [w('five_hour', 93, 38, { state: 'warning' }), w('seven_day', 88, 2 * 24 * 60 + 300), w('seven_day_opus', 97, 2 * 24 * 60 + 300), w('seven_day_sonnet', 40, 2 * 24 * 60 + 300)], nextAt: now + 4 * MIN });
    case 'blocked': return base({ windows: [w('five_hour', 100, 130, { state: 'blocked' }), w('seven_day', 71, 3 * 24 * 60)], nextAt: now + 4 * MIN });
    case 'stale': return base({ probe: 'failed', windows: [w('five_hour', 34, 130), w('seven_day', 61, 3 * 24 * 60)], nextAt: now + 10 * MIN });
    case 'apiKey': { const u = base({ kind: 'apiKey' }); delete u.plan; return u; }
    case 'signedOut': { const u = base({ probe: 'signedOut' }); delete u.asOf; delete u.plan; return u; }
    case 'extra': return base({
      windows: [w('five_hour', 55, 140), w('seven_day', 83, 4 * 24 * 60 + 90), w('seven_day_opus', 46, 4 * 24 * 60 + 90)],
      extra: { enabled: true, usedUsd: 12.3, limitUsd: 50, currency: 'GBP', pct: 24.6 }, nextAt: now + 3 * MIN,
    });
    default: return base({ windows: [w('five_hour', 34, 130), w('seven_day', 41, 3 * 24 * 60), w('seven_day_opus', 12, 3 * 24 * 60), w('seven_day_sonnet', 52, 3 * 24 * 60)], nextAt: now + 4 * MIN });
  }
}
const usageMode = params.get('usage') ?? 'ok';
let usageRefreshing = false;
function sendUsage(): void {
  if (usageMode === 'none') return;
  send({ type: 'usage', usage: makeUsage(usageMode) });
}

// ---------------------------------------------------------------------------
// Fake case files

interface Script { task: string; file: string; search: string; edit: string; cmd: string; reply: string; code: string; lang: string }
const SCRIPTS: Record<string, Script> = {
  'demo-1': {
    task: 'Refactor the auth middleware so session refresh lives in one place. Keep the public API exactly the same.',
    file: 'src/auth/middleware.ts', search: 'verifyToken', edit: 'src/auth/session.ts', cmd: 'npm test -- auth',
    reply: 'Refresh logic was duplicated in **two** places. I moved it into one helper and kept `requireUser()` unchanged.',
    lang: 'ts', code: 'export async function refreshSession(req: Request): Promise<Session> {\n  const token = readToken(req);\n  if (!isExpired(token)) return sessionFrom(token);\n  return rotate(token); // single source of truth\n}',
  },
  'demo-2': {
    task: 'The login e2e test fails about one run in five on CI. Find out why and make it reliable.',
    file: '.github/workflows/ci.yml', search: 'waitForTimeout', edit: 'e2e/login.spec.ts', cmd: 'npx playwright test login --repeat-each=20',
    reply: 'The test raced the redirect: it clicked **Sign in** and immediately checked the URL. I now wait for the dashboard heading instead.',
    lang: 'ts', code: "await page.getByRole('button', { name: 'Sign in' }).click();\nawait expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
  },
  'demo-3': {
    task: 'Design a new hero section for the landing page: bold headline, product illustration, one clear call to action.',
    file: 'src/Hero.tsx', search: 'cta', edit: 'styles/hero.css', cmd: 'npm run dev',
    reply: 'New hero is in. The illustration is an inline SVG so it stays crisp, and the CTA uses the brand **accent** colour.',
    lang: 'css', code: '.hero h1 {\n  font-size: clamp(2.5rem, 6vw, 4.5rem);\n  letter-spacing: -0.02em;\n}',
  },
  'demo-4': {
    task: 'Migrate the invoice schema: add the new invoice table and drop the legacy_id column once data is copied.',
    file: 'db/schema.sql', search: 'legacy_id', edit: 'migrations/0042_add_invoice.sql', cmd: 'psql -f migrations/0042_add_invoice.sql',
    reply: 'Data copied and verified: **12,408** rows match. The last step drops `legacy_id`, which I can’t undo, so I’ll ask first.',
    lang: 'sql', code: 'INSERT INTO invoice (id, customer_id, total_cents)\nSELECT id, customer_id, total_cents FROM invoices_legacy;',
  },
  'demo-5': {
    task: 'Audit our dependencies for known vulnerabilities and anything deprecated. Write up what to upgrade first.',
    file: 'package.json', search: 'deprecated', edit: 'AUDIT.md', cmd: 'npm audit --omit=dev',
    reply: 'Two temps checked the lockfile and the advisories. Only **lodash** needs a priority bump; the rest can wait for the next release.',
    lang: 'bash', code: 'npm install lodash@4.17.21\nnpm audit --omit=dev',
  },
  'demo-6': {
    task: 'Write the API guide for authentication, errors and rate limits, based on openapi.yaml.',
    file: 'openapi.yaml', search: 'rate limit', edit: 'docs/auth.md', cmd: 'npm run docs:build',
    reply: 'The auth page is drafted. Before I write the rest I need to know which **tone** you want.',
    lang: 'md', code: '## Authentication\n\nSend your key in the `Authorization` header:\n\n    Authorization: Bearer <key>',
  },
};

function scriptFor(a: AgentSnapshot): Script {
  const s = SCRIPTS[a.id];
  if (s) return s;
  return {
    task: a.kind === 'temp' ? `Help with: ${a.title}.` : a.title,
    file: 'README.md', search: 'TODO', edit: 'src/index.ts', cmd: 'npm test',
    reply: 'Done. I kept the change **small** and noted anything that needs a follow-up.', lang: 'ts', code: "export const ready = true;",
  };
}

function conversation(a: AgentSnapshot): ConversationItem[] {
  const s = scriptFor(a);
  const now = Date.now();
  const at = (minAgo: number): number => now - minAgo * 60_000;
  const items: ConversationItem[] = [
    { kind: 'prompt', id: `${a.id}:p1`, at: at(42), text: s.task },
    { kind: 'thinking', id: `${a.id}:th1`, at: at(41) },
    { kind: 'assistant', id: `${a.id}:a1`, at: at(41), text: `I’ll start by reading \`${s.file}\` and looking for every use of \`${s.search}\`.` },
    { kind: 'tool', id: `${a.id}:t1`, name: 'Read', state: 'done', summary: `Read ${s.file}`, input: s.file, output: `1  // ${s.file}\n2  import { config } from './config';\n3  \n4  export function setup() {\n5    return config.load();\n6  }` },
    { kind: 'tool', id: `${a.id}:t2`, name: 'Grep', state: 'done', summary: `Searched for "${s.search}"`, input: `pattern: ${s.search}\npath: .`, output: `${s.file}:12\nsrc/routes/api.ts:8\nsrc/routes/admin.ts:31` },
    { kind: 'tool', id: `${a.id}:t3`, name: 'Edit', state: 'done', summary: `Edited ${s.edit}`, input: `file_path: ${s.edit}\n- old line\n+ new line` },
    { kind: 'tool', id: `${a.id}:t4`, name: 'Bash', state: 'error', summary: `Ran ${s.cmd}`, input: s.cmd, output: 'FAIL  1 of 24 checks\n  ✕ handles the edge case (12 ms)\n\n  Expected: 200\n  Received: 401' },
    { kind: 'tool', id: `${a.id}:t5`, name: 'Edit', state: 'denied', summary: 'Edit .env', input: 'file_path: .env', output: 'The user declined this edit.' },
    { kind: 'assistant', id: `${a.id}:a2`, at: at(30), text: `${s.reply}\n\nWhat changed:\n\n- one shared helper instead of copies\n- the failing check is fixed\n- nothing outside \`${s.edit.split('/')[0]}\` was touched\n\n\`\`\`${s.lang}\n${s.code}\n\`\`\`` },
    { kind: 'notice', id: `${a.id}:c1`, notice: 'cost', text: 'This turn: $0.04', costUsd: 0.04 },
    { kind: 'notice', id: `${a.id}:info1`, notice: 'info', text: 'Conversation compacted' },
  ];
  if (a.id === 'demo-2') items.push({ kind: 'notice', id: `${a.id}:int`, notice: 'interrupted', text: 'Interrupted by you' });
  if (a.id === 'demo-1') {
    // Plan items in every status: superseded, sent back (cut short, with notes), approved; pending comes with &pending=plan.
    items.splice(3, 0,
      { kind: 'plan', id: 'toolu_plan_a', at: at(40), status: 'superseded', text: '## First pass\n\n1. Move refresh into the middleware\n2. Delete the route copy\n\nI’ll check the admin routes later.' },
      { kind: 'plan', id: 'toolu_plan_b', at: at(38), status: 'rejected', truncated: true, planFilePath: '/home/user/.claude/plans/refactor-auth-refresh.md',
        feedback: 'Don’t touch the admin cookie yet, and keep requireUser() exactly as it is.',
        text: '## Refactor plan v2\n\n**Goal:** one refresh path for every route.\n\n1. Add `refreshSession()`\n2. Rename the admin cookie to match\n3. Update `requireUser()` to call it' },
      { kind: 'plan', id: 'toolu_plan_c', at: at(36), status: 'approved', text: PLAN });
  }
  if (a.id === 'demo-1' && a.pending?.kind === 'plan') {
    items.push({ kind: 'plan', id: 'toolu_plan_d', at: at(1), status: 'pending', text: PLAN, planFilePath: '/home/user/.claude/plans/refactor-auth-refresh.md' });
    return items;
  }
  if (a.kind === 'main') {
    items.push({ kind: 'prompt', id: `${a.id}:p2`, at: at(12), text: 'Nice work. Can you also add a test for that edge case?' });
    items.push({ kind: 'assistant', id: `${a.id}:a3`, at: at(11), text: 'On it — adding a regression test now.' });
    const busy = a.status === 'working' && a.activity !== 'idle';
    items.push({ kind: 'tool', id: `${a.id}:t6`, name: 'Write', state: 'done', summary: 'Wrote test/edge-case.test.ts', input: "test('handles the edge case', () => { ... })" });
    items.push({ kind: 'tool', id: `${a.id}:t7`, name: 'Bash', state: busy ? 'running' : 'done', summary: busy ? `Running ${s.cmd}` : `Ran ${s.cmd}`, input: s.cmd, output: busy ? undefined : 'PASS  24 of 24 checks' });
  }
  return items;
}

const PERMISSIONS: Record<string, Omit<Extract<PendingRequest, { kind: 'permission' }>, 'requestId' | 'sessionId' | 'at' | 'kind'>> = {
  'demo-4': {
    toolName: 'Bash', summary: 'Drop the legacy_id column from invoices',
    fields: [
      { label: 'Command', value: 'psql -d billing -c "ALTER TABLE invoices DROP COLUMN legacy_id;"', code: true },
      { label: 'Description', value: 'Drop the legacy_id column from invoices' },
    ],
    reason: 'This command changes the database and can’t be undone.', canAlwaysAllow: true, alwaysLabel: 'Always allow "psql -d billing *" in this project',
  },
};
function permissionFor(id: string): Omit<Extract<PendingRequest, { kind: 'permission' }>, 'requestId' | 'sessionId' | 'at' | 'kind'> {
  return PERMISSIONS[id] ?? {
    toolName: 'Edit', summary: 'src/auth/session.ts',
    fields: [
      { label: 'File', value: 'src/auth/session.ts' },
      { label: 'Old', value: 'if (token.exp < now) {\n  return refresh(token);\n}', code: true },
      { label: 'New', value: 'if (isExpired(token, now)) {\n  return rotate(token);\n}', code: true },
    ],
    canAlwaysAllow: true, alwaysLabel: 'Auto-accept file edits this session',
  };
}

const PLAN = `## Refactor plan: one place for session refresh

**Goal:** remove the duplicated refresh logic without changing \`requireUser()\`.

1. Add \`refreshSession()\` to \`src/auth/session.ts\`
2. Call it from the middleware and the \`/token\` route
3. Delete the old copies
4. Add tests for expired, rotated and revoked tokens

### Risks
- Tokens issued before the change still need to work
- The admin routes use a *different* cookie name

\`\`\`ts
export async function refreshSession(req: Request): Promise<Session>
\`\`\`

I won’t touch the database or the public API.`;

function pendingRequest(a: AgentSnapshot): PendingRequest | null {
  const p = a.pending;
  if (!p) return null;
  const common = { requestId: p.requestId, sessionId: a.sessionId ?? `sess-${a.id}`, at: Date.now() - 20_000 };
  if (p.kind === 'permission') return { ...common, kind: 'permission', ...permissionFor(a.id) };
  if (p.kind === 'plan') return { ...common, kind: 'plan', plan: PLAN, planFilePath: '/home/user/.claude/plans/refactor-auth-refresh.md' };
  return {
    ...common, kind: 'question', questions: [
      {
        question: 'Which tone should the API guide use?', header: 'Tone', multiSelect: false, options: [
          { label: 'Friendly', description: 'Conversational, examples first' },
          { label: 'Formal', description: 'Reference style: precise and terse' },
          { label: 'Match docs/auth.md', description: 'Copy the voice of the existing page' },
        ],
      },
      {
        question: 'Which sections should I write next?', header: 'Sections', multiSelect: true, options: [
          { label: 'Errors', description: 'Error codes and retries' },
          { label: 'Rate limits', description: 'Quotas and response headers', preview: 'HTTP/1.1 429 Too Many Requests\nRetry-After: 30' },
          { label: 'Webhooks', description: 'Events and signatures' },
        ],
      },
    ],
  };
}

function header(a: AgentSnapshot): CaseHeader {
  const x = EXTRA[a.kind === 'temp' && a.parentId ? a.parentId : a.id];
  const hire = hires.find((h) => h.snap.id === a.id);
  const hd: CaseHeader = {
    agentId: a.id, title: a.title, project: a.project, activity: a.activity, status: a.status, control: a.control ?? 'none',
    busy: a.control === 'office' && a.status === 'working' && a.activity !== 'idle',
  };
  if (a.sessionId) hd.sessionId = a.sessionId;
  if (a.cwd) hd.cwd = a.cwd;
  if (a.gitBranch) hd.gitBranch = a.gitBranch;
  hd.model = hire?.model ?? x?.model ?? 'claude-sonnet-4-5';
  const effort = hire ? hire.effort : x?.effort;
  if (effort) hd.effort = effort;
  if (a.control === 'office') {
    hd.permissionMode = a.id === 'demo-1' ? 'plan' : 'default';
    if (a.costUsd !== undefined) hd.costUsd = a.costUsd;
  }
  if (forcedCase === a.id && chipsMode) {
    hd.control = chipsMode === 'free' ? 'free' : chipsMode === 'external' ? 'elsewhere' : 'office';
    if (hd.control !== 'office') delete hd.busy;
  }
  hd.canSetOptions = hd.control === 'office' || hd.control === 'free';
  if (hd.control === 'free') hd.next = nextOpts.get(a.id) ?? x?.next ?? {};
  const applied = appliedOpts.get(a.id);
  if (applied) {
    if (applied.model !== undefined) hd.model = applied.model ?? 'claude-opus-5-5';
    if (applied.effort !== undefined) { if (applied.effort) hd.effort = applied.effort; else delete hd.effort; }
    if (applied.permissionMode) hd.permissionMode = applied.permissionMode;
  }
  return hd;
}

// ---------------------------------------------------------------------------
// Mock host behaviour

let openCase: string | null = null;
let lastPendingSent: string | null = null;
let lastBusy: boolean | null = null;
let lastControl: AgentControl | null = null;
let streamTimer = 0;
let seq = 0;

function appendTo(agentId: string, msg: Omit<Extract<HostToWebview, { type: 'caseAppend' }>, 'type' | 'agentId'>): void {
  if (openCase !== agentId) return;
  send({ type: 'caseAppend', agentId, ...msg });
}

function syncOpenCase(): void {
  if (!openCase) return;
  const a = agentById(openCase);
  if (!a) {
    send({ type: 'caseClosed', agentId: openCase, reason: 'agentGone' });
    openCase = null;
    return;
  }
  const pid = a.pending?.requestId ?? null;
  if (pid !== lastPendingSent) {
    lastPendingSent = pid;
    appendTo(a.id, { items: [], pending: pendingRequest(a) });
  }
  const h = header(a);
  if (h.busy !== lastBusy || h.control !== lastControl) {
    lastBusy = h.busy ?? false;
    lastControl = h.control;
    appendTo(a.id, { items: [], header: { busy: h.busy, control: h.control, costUsd: h.costUsd } });
  }
}

/** Streams an answer into the open case: a tool step, then text arriving in chunks, then the turn cost. */
function streamAnswer(agentId: string, text: string, ms = 2000): void {
  clearInterval(streamTimer);
  const id = `${agentId}:s${++seq}`;
  const toolId = `${agentId}:st${seq}`;
  busyUntil.set(agentId, Date.now() + ms + 600);
  appendTo(agentId, { items: [{ kind: 'tool', id: toolId, name: 'Read', state: 'running', summary: 'Reading src/notes.md' }], header: { busy: true } });
  const words = text.split(/(?<=\s)/);
  let i = 0;
  const step = Math.max(1, Math.ceil(words.length / (ms / 120)));
  setTimeout(() => {
    appendTo(agentId, { items: [{ kind: 'tool', id: toolId, name: 'Read', state: 'done', summary: 'Read src/notes.md', input: 'src/notes.md', output: '# Notes\n- keep it simple' }] });
    streamTimer = window.setInterval(() => {
      i = Math.min(words.length, i + step);
      const done = i >= words.length;
      appendTo(agentId, { items: [{ kind: 'assistant', id, text: words.slice(0, i).join(''), streaming: done ? undefined : true }] });
      if (done) {
        clearInterval(streamTimer);
        extraCost.set(agentId, (extraCost.get(agentId) ?? 0) + 0.02);
        busyUntil.delete(agentId);
        const a = agentById(agentId);
        appendTo(agentId, { items: [{ kind: 'notice', id: `${id}:cost`, notice: 'cost', text: 'This turn: $0.02', costUsd: 0.02 }], header: { busy: false, costUsd: a?.costUsd } });
        lastBusy = false;
      }
    }, 120);
  }, 400);
}

const PROJECTS = (): ProjectOption[] => [
  { path: '/home/user/project', name: 'Middle Management', gitBranch: 'feature/new-desks', exists: true, source: 'workspace' },
  ...Object.entries(EXTRA).map(([id, x]): ProjectOption => {
    const proj = demo.snapshot(clock()).find((a) => a.id === id)?.project ?? id;
    return { path: `${HOME}/${proj}`, name: proj, gitBranch: x.branch, exists: true, source: 'recent' };
  }),
  { path: `${HOME}/old-prototype`, name: 'old-prototype', exists: false, source: 'recent' },
  ...(browsed ? [browsed] : []),
];
let browsed: ProjectOption | null = null;

const slowCase = params.get('slowCase') === '1';
const demoMode = params.get('demoMode') === '1';
/** `&mode=view`: refuses everything the extension's view guard does (the Front desk's calls are answered first, as there). */
const viewMode = params.get('mode') === 'view';

/** The Round B requests (file room, catalogs, open in editor), answered from the playground's data. */
const roundB = createRoundBMock(params, send);

/** The Front desk's calls. The real extension answers them before its demo guard, so the mock does too. */
const FRONT_DESK_CALLS = new Set<string>(['getFrontDesk', 'themeAction', 'setSetting', 'saveTheme', 'saveThemeAs', 'openSettingsUi']);
/** The mock Front desk host, created once the theme files are fetched (calls that come earlier wait in `fdQueue`). */
let fd: MockHost | null = null;
const fdQueue: WebviewToHost[] = [];

// ---------------------------------------------------------------------------
// Update notice: `&update=` and the answers to `updateAction` (see the header). The extension's update service plays this part.

const UPDATE_STATES = new Set(['available', 'downloading', 'installed', 'error', 'hidden', 'checking', 'upToDate', 'idle']);
const updateParam = params.get('update');
const UPDATE_CURRENT = '0.5.0';
const UPDATE_LATEST = params.get('updateLatest') ?? '0.6.0';
let updateInfo: UpdateInfo | null = null;
const updateTimers: number[] = [];

/** The update info for a `&update=` state name. */
function updateFor(state: string): UpdateInfo {
  const base: UpdateInfo = { status: 'idle', current: UPDATE_CURRENT, checkedAt: Date.now() - 3 * MIN, auto: params.get('updateAuto') !== '0' };
  const notes = params.get('updateNotes') === '0' ? {} : { notesUrl: `https://github.com/Barniclebazil/middle-management/releases/tag/v${UPDATE_LATEST}` };
  switch (state) {
    case 'available': return { ...base, status: 'available', latest: UPDATE_LATEST, ...notes };
    case 'hidden': return { ...base, status: 'available', latest: UPDATE_LATEST, hidden: true, ...notes };
    case 'downloading': return { ...base, status: 'downloading', latest: UPDATE_LATEST };
    case 'installed': return { ...base, status: 'installed', latest: UPDATE_LATEST };
    case 'error': return { ...base, status: 'error', latest: UPDATE_LATEST, message: 'The download from GitHub failed (HTTP 503). Please try again later.' };
    case 'checking': return { ...base, status: 'checking' };
    case 'upToDate': return { ...base, status: 'upToDate', latest: UPDATE_CURRENT };
    default: return base;
  }
}

function sendUpdate(u: UpdateInfo): void {
  updateInfo = u;
  send({ type: 'update', update: u });
}

/** The webview's `updateAction`: install runs (downloading, then installed after a moment; `&updateFail=1` ends in an error). */
function handleUpdateAction(action: UpdateAction): void {
  console.log('[harness] updateAction', action);
  const cur = updateInfo ?? updateFor('idle');
  const later = (ms: number, f: () => void): void => { updateTimers.push(window.setTimeout(f, ms)); };
  switch (action) {
    case 'install':
      sendUpdate({ ...cur, status: 'downloading', latest: cur.latest ?? UPDATE_LATEST, hidden: false });
      later(Number(params.get('updateLag') ?? '2200') || 2200, () => {
        sendUpdate(params.get('updateFail') === '1'
          ? { ...updateFor('error'), checkedAt: Date.now() }
          : { ...updateFor('installed'), checkedAt: Date.now() });
      });
      return;
    case 'later':
    case 'skip':
      sendUpdate({ ...cur, hidden: true });
      return;
    case 'check':
      sendUpdate({ ...cur, status: 'checking' });
      later(1000, () => sendUpdate({ ...updateFor(updateParam === 'upToDate' ? 'upToDate' : 'available'), checkedAt: Date.now() }));
      return;
    case 'reload':
      console.log('[harness] reload window (not in the harness)');
      return;
    case 'notes':
      console.log('[harness] open release notes', cur.notesUrl);
      return;
  }
}

function handle(msg: WebviewToHost): void {
  if (FRONT_DESK_CALLS.has(msg.type)) {
    if (fd) fd.handle(msg);
    else fdQueue.push(msg);
    return;
  }
  // The extension answers updateAction in every mode (view and demo mode too), before its guards.
  if (msg.type === 'updateAction') { handleUpdateAction(msg.action); return; }
  if (viewMode) {
    const refusal = viewRefusal(msg);
    if (refusal) { setTimeout(() => send(refusal), 80); return; }
  }
  if (demoMode) {
    const refusal = demoRefusal(msg);
    if (refusal) { setTimeout(() => send(refusal), 80); return; }
  }
  if (roundB.handles(msg)) { roundB.handle(msg); return; }
  if (slowCase && msg.type === 'openCase') return;
  switch (msg.type) {
    case 'openCase': {
      const a = agentById(msg.agentId);
      if (!a) { send({ type: 'error', message: 'That worker has left the office.' }); return; }
      openCase = a.id;
      lastPendingSent = a.pending?.requestId ?? null;
      const h = header(a);
      lastBusy = h.busy ?? false;
      lastControl = h.control;
      const hire = hires.find((x) => x.snap.id === a.id);
      const items = hire ? [{ kind: 'prompt', id: `${a.id}:p1`, at: hire.snap.startedAt, text: hire.snap.title } as ConversationItem] : conversation(a);
      setTimeout(() => {
        send({ type: 'caseFile', agentId: a.id, header: h, items, pending: pendingRequest(a), truncated: a.id === 'demo-3' });
        const [pop, pick] = (params.get('popover') ?? '').split(':');
        if (pop) {
          setTimeout(() => {
            document.querySelector<HTMLElement>(`.co-optchip[data-opt="${pop === 'approvals' ? 'permissionMode' : pop}"]`)?.click();
            if (pick) setTimeout(() => document.querySelector<HTMLElement>(`.co-pop-item[data-id="${CSS.escape(pick)}"]`)?.click(), 150);
          }, 250);
        }
        if (params.get('scroll') === 'top') setTimeout(() => {
          const body = document.querySelector('.co-case-body');
          if (body) body.scrollTop = 0;
          appendTo(a.id, { items: [{ kind: 'assistant', id: `${a.id}:late`, text: 'One more thing: the CI cache key was stale, so I bumped it.' }] });
        }, 120);
      }, 60);
      return;
    }
    case 'openCaseTab': {
      // The host would open (or focus) an editor tab with the worker's case; here it is only logged and listed.
      const a = agentById(msg.agentId);
      console.log('[harness] openCaseTab', msg.agentId, a ? (caseTabsOpen.includes(a.id) ? '(focus)' : '(open)') : '(unknown)');
      if (!a) { setTimeout(() => send({ type: 'error', agentId: msg.agentId, message: 'That worker has left the office.' }), 60); return; }
      if (!caseTabsOpen.includes(a.id)) {
        if (caseTabsOpen.length >= 20) { setTimeout(() => send({ type: 'error', agentId: a.id, message: 'Twenty case tabs are open. Close a tab first.' }), 60); return; }
        caseTabsOpen.push(a.id);
        setTimeout(sendCaseTabs, 60);
      }
      return;
    }
    case 'sendHome': {
      const a = agentById(msg.agentId);
      console.log('[harness] sendHome', msg.agentId);
      const refuse = (message: string): void => { setTimeout(() => send({ type: 'error', agentId: msg.agentId, message }), 80); };
      if (!a) { refuse('That worker has left the office.'); return; }
      if (a.kind !== 'main') { refuse('A temp leaves with the person they work for.'); return; }
      const idle = (a.status === 'idle' || a.status === 'done') && !a.pending && a.activity !== 'needsYou';
      if (!idle) { refuse('They are still working. Send them home when they are idle.'); return; }
      sentHome.add(a.id);
      // Their tab (if any) closes with them; the next tick's snapshot no longer lists them, so the office walks them out.
      if (caseTabsOpen.includes(a.id)) { caseTabsOpen = caseTabsOpen.filter((x) => x !== a.id); sendCaseTabs(); }
      send({ type: 'agents', agents: snapshot() });
      return;
    }
    case 'closeCase':
      openCase = null;
      clearInterval(streamTimer);
      return;
    case 'listProjects':
      setTimeout(() => send({ type: 'projects', projects: PROJECTS(), defaultPath: '/home/user/project' }), 80);
      return;
    case 'browseProject':
      setTimeout(() => {
        browsed = { path: `${HOME}/side-quest`, name: 'side-quest', gitBranch: 'main', exists: true, source: 'browsed' };
        send({ type: 'projects', projects: PROJECTS(), defaultPath: browsed.path });
      }, 500);
      return;
    case 'newTask': {
      if (/\bfail\b/i.test(msg.prompt)) {
        setTimeout(() => send({ type: 'error', nonce: msg.nonce, message: 'Couldn’t find the Claude Code binary. Set "claudeOffice.claudePath" or install the Claude Code extension.' }), 600);
        return;
      }
      setTimeout(() => {
        if (msg.assignTo.kind === 'existing') {
          const sid = msg.assignTo.sessionId;
          const a = snapshot().find((x) => x.sessionId === sid && x.kind === 'main');
          if (!a) { send({ type: 'error', nonce: msg.nonce, message: 'That session is busy elsewhere now.' }); return; }
          controlOverride.set(a.id, 'office');
          send({ type: 'taskStarted', nonce: msg.nonce, sessionId: sid, agentId: a.id });
          setTimeout(() => { appendTo(a.id, { items: [{ kind: 'prompt', id: `${a.id}:m${++seq}`, at: Date.now(), text: msg.prompt }], header: { control: 'office' } }); streamAnswer(a.id, 'Picking this up now. I’ll read the latest changes first.'); }, 300);
          return;
        }
        const n = hires.length + 1;
        const id = `hire-${n}`;
        const proj = msg.projectPath.split('/').filter(Boolean).pop() ?? 'project';
        const now = clock();
        const flat = msg.prompt.replace(/\s+/g, ' ').trim();
        const title = (flat.length > 48 ? `${flat.slice(0, 46).replace(/\s+\S*$/, '')}\u2026` : flat) || 'New task';
        hires.push({
          snap: {
            id, kind: 'main', title, project: proj, activity: 'writing', status: 'working', since: now, startedAt: now, lastPromptAt: now,
            sessionId: `sess-${id}`, cwd: msg.projectPath, gitBranch: PROJECTS().find((p) => p.path === msg.projectPath)?.gitBranch ?? 'main', control: 'office',
          },
          model: msg.model ?? 'claude-opus-4-1-20250805',
          ...(msg.effort ? { effort: msg.effort } : {}),
          busyUntil: Date.now() + 6000,
        });
        send({ type: 'agents', agents: snapshot() });
        send({ type: 'taskStarted', nonce: msg.nonce, sessionId: `sess-${id}`, agentId: id });
        setTimeout(() => streamAnswer(id, `Morning! I’m on it: **${title}**. First I’ll get my bearings in \`${proj}\`.`, 2500), 900);
      }, 600);
      return;
    }
    case 'reply': {
      const a = snapshot().find((x) => x.sessionId === msg.sessionId && x.kind === 'main');
      if (!a) { send({ type: 'error', message: 'No such session.' }); return; }
      if (/fail/i.test(msg.text)) { send({ type: 'error', sessionId: msg.sessionId, message: 'Could not reach Claude Code. Try again in a moment.' }); return; }
      if (a.control === 'free') controlOverride.set(a.id, 'office');
      appendTo(a.id, { items: [{ kind: 'prompt', id: `${a.id}:r${++seq}`, at: Date.now(), text: msg.text }], header: { control: 'office' } });
      streamAnswer(a.id, 'Got it. Here’s the plan:\n\n1. Check the current behaviour\n2. Make the change in `src/notes.md`\n3. Run the tests\n\nI’ll report back when it’s green.');
      return;
    }
    case 'decide': {
      const dm = msg.decision.kind === 'deny' ? msg.decision.message : undefined;
      if (dm !== undefined && /fail/i.test(dm)) { send({ type: 'error', requestId: msg.requestId, message: 'That request is no longer waiting.' }); return; }
      answered.add(msg.requestId);
      const agentId = msg.requestId.split(':')[0]!;
      if (msg.decision.kind === 'plan') {
        const live = agentById(agentId)?.plans?.find((p) => p.status === 'pending' && p.id.startsWith('p-live-'));
        if (live) planDecisions.push({ agentId, planId: live.id, title: live.title, at: live.at, decidedAt: clock(), status: msg.decision.approve ? 'approved' : 'rejected' });
      }
      if (msg.decision.kind === 'deny' && dm === undefined && msg.requestId.split(':')[1] === 'question') {
        setTimeout(() => {
          lastPendingSent = null;
          appendTo(agentId, { items: [{ kind: 'assistant', id: `${agentId}:d${++seq}`, text: 'OK, I\u2019ll pick myself.' }], pending: null });
        }, 450);
        return;
      }
      setTimeout(() => {
        const d = msg.decision;
        let item: ConversationItem;
        if (d.kind === 'allow') item = { kind: 'tool', id: `${agentId}:d${++seq}`, name: 'Bash', state: 'done', summary: d.always ? 'Ran it (always allowed from now on)' : 'Ran the approved command', output: 'ALTER TABLE' };
        else if (d.kind === 'deny') item = { kind: 'tool', id: `${agentId}:d${++seq}`, name: 'Bash', state: 'denied', summary: d.message ? `Denied: ${d.message}` : 'Denied by you' };
        else if (d.kind === 'answer') item = { kind: 'assistant', id: `${agentId}:d${++seq}`, text: `Thanks! Going with: ${Object.values(d.answers).flat().join(', ')}${d.other ? ` (${Object.values(d.other).join('; ')})` : ''}.` };
        else item = { kind: 'assistant', id: `${agentId}:d${++seq}`, text: d.approve ? 'Plan approved. Starting step 1 now.' : `Back to the drawing board${d.feedback ? `: “${d.feedback}”` : ''}.` };
        lastPendingSent = null;
        appendTo(agentId, { items: [item], pending: null });
      }, 450);
      return;
    }
    case 'interrupt': {
      clearInterval(streamTimer);
      const a = snapshot().find((x) => x.sessionId === msg.sessionId && x.kind === 'main');
      if (!a) return;
      busyUntil.delete(a.id);
      appendTo(a.id, { items: [{ kind: 'notice', id: `${a.id}:i${++seq}`, notice: 'interrupted', text: 'Interrupted by you' }], header: { busy: false }, pending: null });
      return;
    }
    case 'getTurn': {
      const a = agentById(msg.agentId);
      const reply = (): void => {
        if (!a?.lastReport || /fail/i.test(a.title)) { send({ type: 'error', reqId: msg.reqId, message: 'The transcript for this session could not be found.' }); return; }
        const s = scriptFor(a);
        send({
          type: 'turn', reqId: msg.reqId, agentId: a.id, truncated: false,
          items: [
            { kind: 'prompt', id: `${a.id}:t1`, text: s.task },
            { kind: 'thinking', id: `${a.id}:t2` },
            { kind: 'tool', id: `${a.id}:t3`, name: 'Read', state: 'done', summary: `Read ${s.file}` },
            { kind: 'tool', id: `${a.id}:t4`, name: 'Grep', state: 'done', summary: `Searched for "${s.search}"` },
            { kind: 'tool', id: `${a.id}:t5`, name: 'Edit', state: 'done', summary: `Edited ${s.edit}` },
            { kind: 'tool', id: `${a.id}:t6`, name: 'Bash', state: 'error', summary: `Ran ${s.cmd}`, output: '1 failing' },
            { kind: 'tool', id: `${a.id}:t7`, name: 'Bash', state: 'done', summary: `Ran ${s.cmd}` },
            { kind: 'assistant', id: `${a.id}:t8`, text: a.lastReport.text },
            { kind: 'notice', id: `${a.id}:t9`, notice: 'cost', text: 'This turn: $0.42', costUsd: 0.42 },
          ],
        });
      };
      setTimeout(reply, 400);
      return;
    }
    case 'getPlan': {
      const a = agentById(msg.agentId);
      const plan = a?.plans?.find((p) => p.id === msg.planId);
      setTimeout(() => {
        if (!plan || /fail/i.test(plan.title)) { send({ type: 'error', reqId: msg.reqId, message: 'That plan is no longer in the transcript.' }); return; }
        const out: Extract<HostToWebview, { type: 'planText' }> = {
          type: 'planText', reqId: msg.reqId, agentId: msg.agentId, planId: msg.planId, status: plan.status,
          text: plan.id.startsWith('p-live-') || plan.id === 'p-ext' ? PLAN : `# ${plan.title}\n\nSteps:\n\n1. Look at the code.\n2. Make the change.\n3. Run the tests.`,
        };
        if (plan.status === 'rejected') { out.feedback = 'Keep requireUser() exactly as it is. Leave the admin cookie alone for now.'; out.planFilePath = '/home/user/.claude/plans/refactor-auth-refresh.md'; }
        if (plan.id.startsWith('p-live-')) out.planFilePath = '/home/user/.claude/plans/refactor-auth-refresh.md';
        send(out);
      }, 400);
      return;
    }
    case 'refreshUsage': {
      if (usageMode === 'none' || usageRefreshing) return;
      usageRefreshing = true;
      send({ type: 'usage', usage: { ...makeUsage(usageMode), probe: 'running' } });
      setTimeout(() => {
        usageRefreshing = false;
        const u = makeUsage(usageMode === 'stale' ? 'ok' : usageMode);
        if (u.asOf !== undefined) u.asOf = clock();
        send({ type: 'usage', usage: u });
      }, 1500);
      return;
    }
    case 'openInClaudeCode':
      console.log('[harness] openInClaudeCode', msg.sessionId);
      return;
    case 'setSessionOptions': {
      const a = snapshot().find((x) => x.sessionId === msg.sessionId && x.kind === 'main');
      if (!a) { send({ type: 'error', nonce: msg.nonce, sessionId: msg.sessionId, message: 'That session has gone.' }); return; }
      const h = header(a);
      setTimeout(() => {
        if (chipsMode === 'old' && forcedCase === a.id) {
          send({ type: 'error', nonce: msg.nonce, sessionId: msg.sessionId, message: 'This Claude Code can’t change settings mid-session. Update Claude Code to use this.' });
        } else if (h.control === 'office') {
          appliedOpts.set(a.id, { ...appliedOpts.get(a.id), ...msg.options });
          send({ type: 'sessionOptions', nonce: msg.nonce, sessionId: msg.sessionId, applied: msg.options, deferred: {} });
          setTimeout(() => { const n = header(a); appendTo(a.id, { items: [], header: { model: n.model, effort: n.effort, permissionMode: n.permissionMode } }); }, 1200);
        } else if (h.control === 'free') {
          const next = { ...(nextOpts.get(a.id) ?? EXTRA[a.id]?.next ?? {}), ...msg.options };
          nextOpts.set(a.id, next);
          send({ type: 'sessionOptions', nonce: msg.nonce, sessionId: msg.sessionId, applied: {}, deferred: msg.options });
          appendTo(a.id, { items: [], header: { next } });
        } else {
          send({ type: 'error', nonce: msg.nonce, sessionId: msg.sessionId, message: 'That session is open in Claude Code, so it can’t be changed from here.' });
        }
      }, 500);
      return;
    }
    default:
      return;
  }
}

/** `?theme=<url>` (not light|dark, which pick the VS Code colours) or `?themeFile=<url>`: the theme file to load. */
const themeUrl = params.get('themeFile') ?? (themeName && !THEMES[themeName] ? themeName : null);

/** Fetches and validates the theme file; undefined (after a console warning) when it can't be read. */
async function loadTheme(url: string): Promise<OfficeTheme | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { theme, errors } = parseTheme(JSON.parse(await res.text()) as unknown);
    for (const e of errors) console.warn('[harness] theme:', e);
    return theme;
  } catch (e) {
    console.warn('[harness] could not load the theme', url, e);
    return undefined;
  }
}

/** The preset the packaged extension ships, served from the repo root (the harness lives in /dev/). */
const PRESET_URL = new URL('../media/themes/example.theme.json', location.href).href;

function startFeeding(): void {
  if (feeding) return;
  feeding = true;
  const begin = (fileTheme?: OfficeTheme, presetTheme?: OfficeTheme): void => {
    // The Front desk's mock host owns the settings and the theme from here on: it re-sends `settings` (with the theme) after each change.
    fd = new MockHost(params, (l) => { console.log('[harness front desk]', l); }, {
      ...(!params.get('fd') && fileTheme ? { scenario: 'file' as const } : {}),
      ...(fileTheme ? { fileTheme } : {}),
      ...(presetTheme ? { presetTheme } : {}),
      settings: { companyName: company, branchName: branch, managerName },
    });
    fd.listen(send);
    (window as unknown as Record<string, unknown>)['__harnessFrontDesk'] = fd;
    send({ type: 'settings', settings: fd.officeSettings() });
    for (const m of fdQueue.splice(0)) fd.handle(m);
    if (params.get('defaults') !== '0') send({ type: 'claudeDefaults', defaults: DEFAULTS });
    sendUsage();
    if (updateParam && UPDATE_STATES.has(updateParam)) {
      sendUpdate(updateFor(updateParam));
      // `&updateMemo=1`: open the head office memo once the office is in (the states without a cue, like error, too).
      if (params.get('updateMemo') === '1') {
        setTimeout(() => (window as unknown as { __officeDebug?: { openUpdateMemo?: () => boolean } }).__officeDebug?.openUpdateMemo?.(), 400);
      }
    }
    for (const m of roundB.preset()) send(m);
    // A real reading is refreshed every few minutes; keep the mock one from going stale while a page stays open.
    if (usageMode !== 'stale') setInterval(sendUsage, 5 * MIN);
    const picks = params.get('memoPick');
    if (picks) {
      // Click memo choices by value once the memo is up (screenshots of the effort pips and the clamp note).
      setTimeout(() => {
        for (const v of picks.split(',')) document.querySelector<HTMLElement>(`.co-memo [data-v="${CSS.escape(v)}"]`)?.click();
      }, 700);
    }
    const tick = (): void => {
      send({ type: 'agents', agents: snapshot() });
      syncOpenCase();
    };
    // `&spell=<ms>`: shorten the Fable spell before the first snapshot (the webview exposes its office to the harness).
    const dbg = (window as unknown as { __officeDebug?: { office?: { evictionMs: number } } }).__officeDebug;
    if (spellMs !== null && dbg?.office) dbg.office.evictionMs = spellMs;
    tick();
    sendCaseTabs();
    setInterval(tick, 250);
  };
  // With a theme file, wait for it so pins apply to the first agents (and for the packaged preset, which `fd=preset` uses).
  void Promise.all([themeUrl ? loadTheme(themeUrl) : Promise.resolve(undefined), loadTheme(PRESET_URL)]).then(([file, preset]) => { begin(file, preset); });
}

(window as unknown as Record<string, unknown>)['acquireVsCodeApi'] = () => {
  // &persist=1: keep the saved state across reloads of this tab, like VS Code does for a webview.
  const persistState = params.get('persist') === '1';
  let state: unknown;
  if (persistState) {
    try { state = JSON.parse(sessionStorage.getItem('harnessState') ?? 'null'); } catch { state = undefined; }
  }
  return {
    postMessage(msg: WebviewToHost) {
      posted.push(msg);
      if (msg?.type === 'ready') {
        setTimeout(startFeeding, 0);
        if (params.get('replyError') === '1' && forcedCase) {
          const sid = snapshot().find((x) => x.id === forcedCase)?.sessionId;
          if (sid) setTimeout(() => send({ type: 'error', sessionId: sid, message: 'Could not reach Claude Code. Try again in a moment.' }), 900);
        }
        const om = params.get('openMemo');
        if (om !== null) setTimeout(() => send({ type: 'openMemo', ...(om !== '' && om !== '1' ? { projectPath: om } : {}) }), 50);
      }
      else if (msg && typeof msg === 'object') handle(msg);
    },
    getState: () => state,
    setState: (s: unknown) => {
      state = s;
      if (persistState) { try { sessionStorage.setItem('harnessState', JSON.stringify(s)); } catch { /* not persisted */ } }
    },
  };
};
(window as unknown as Record<string, unknown>)['__harnessPosted'] = posted;
(window as unknown as Record<string, unknown>)['__harnessCaseTabs'] = (): string[] => [...caseTabsOpen];
(window as unknown as Record<string, unknown>)['__harnessSentHome'] = (): string[] => [...sentHome];
(window as unknown as Record<string, unknown>)['__harnessClock'] = clock;
