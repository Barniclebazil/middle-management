// Panel playground: the icon bar and the panel drawer with a mock PanelContext, in a plain browser page (dev/panels.html).
// Build: `npm run build:dev` (dev/panels.ts -> dev/out/panels.js). Serve the repo root and open /dev/panels.html.
// Params: ?panel=<id>   open that panel (inbox | plans | usage | frontdesk | directory | ...)
//         &sub=1        also push a sub-view on top (shows the "← <previous title>" button)
//         &theme=dark|light|hc   VS Code-ish colour variables (default dark)
//         &w=<px>       pretend the webview is that wide (default: the window); the icon bar collapses below 480 px, the drawer overlays below 700 px
//         &rounds=B     include the Round B entries in the Directory
//         &badge=0      no In-tray badge
//         &inbox=empty|urgent   In-tray data: nothing at all, or only the things that block a worker (default: a bit of everything)
//         &usage=ok|warn|danger|blocked|stale|apiKey|signedOut|unsupported|off|none|extra   the usage snapshot (default ok; `extra` = extra usage in GBP)
//         &mock=error|loading   what getTurn/getPlan answer: every call fails, or none is ever answered (default: answers after &delay=<ms>, 500)
//         &now=<epoch ms>       fake clock
//         &sub=report[:<agentId>] | plan[:<agentId>[:<planId>]]   also push that sub-view (report: a1 = fine, a4 = fails to load; plan: a2:p-pend = the plan an office run waits on,
//                               a6 = an external session's plan (read-only), a2:p-ok approved, a2:p-back sent back with notes, a2:p-slow loads after 4 s)
//         &click=<button text>|...   click those buttons after the mock host answered (e.g. &sub=plan&click=Send back…)
//         &truncated=1          the pending plan's text is reported as cut
// Always on: the report of "Write the release notes" fails to load (error state); plan "p-slow" in billing takes 4 s.
// Keys: Escape runs the real order (memo -> drawer -> case), Tab goes into the icon bar, then arrows/Home/End move inside it.
//
// ADDING A PANEL: write a `PanelView<HTMLElement>` (see src/shared/panels.ts), import it here and add one
// `registerPanel(view)` line in the "Register panels" block below. Its icon-bar item and Directory entry open it by id
// (`inbox`, `plans`, `usage`, `frontdesk`, `directory`); other ids can be opened with `?panel=<id>`.
import type { InboxReadStore, PanelView } from '../src/shared/panels.ts';
import type { AgentSnapshot, ClaudeDefaults, HostToWebview, UsageSnapshot, WebviewToHost } from '../src/shared/protocol.ts';
import { ICON_IDS } from '../webview/art/index.ts';
import type { IconId } from '../webview/art/index.ts';
import { createFrontDeskMock } from './panelsFrontDesk.ts';
import { createFileRoomMock, createLibraryMock } from './panelsFiles.ts';
import { createDeskPanels } from './panelsDesk.ts';
import { createDirectoryPanel } from '../webview/engine/directoryPanel.ts';
import { PanelDrawer } from '../webview/engine/drawer.ts';
import type { DrawerContext } from '../webview/engine/drawer.ts';
import { button, h, pixelIcon } from '../webview/engine/dom.ts';
import { directoryEntries } from '../webview/engine/hotspots.ts';
import { badge, deriveInbox } from '../webview/engine/inboxLogic.ts';
import { createInboxPanel, createReportView } from '../webview/engine/inboxPanel.ts';
import { createPlanView, createPlansPanel } from '../webview/engine/plansPanel.ts';
import { createUsagePanel } from '../webview/engine/usagePanel.ts';
import type { Round } from '../webview/engine/hotspots.ts';
import { IconBar } from '../webview/engine/iconBar.ts';
import type { IconBarItemId } from '../webview/engine/iconBar.ts';

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Theme (VS Code-ish colour variables, as dev/harness.ts does)

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'sideBar-background': '#1f1f1f', 'editor-background': '#1f1f1f', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'list-hoverBackground': '#2a2d2e',
    'editorWarning-foreground': '#cca700', 'panel-border': '#2b2b2b', focusBorder: '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff',
    'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
    'badge-background': '#616161', 'badge-foreground': '#f8f8f8', errorForeground: '#f85149', 'list-inactiveSelectionBackground': '#37373d',
    'editorWidget-background': '#202020', 'editorWidget-border': '#454545', 'toolbar-hoverBackground': '#5a5d5e50', 'textLink-foreground': '#4daafc',
  },
  light: {
    'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171', 'list-hoverBackground': '#e8e8e8',
    'editorWarning-foreground': '#bf8803', 'panel-border': '#e5e5e5', focusBorder: '#005fb8', 'button-background': '#005fb8', 'button-foreground': '#ffffff',
    'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc',
    'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b', errorForeground: '#c72e0f', 'list-inactiveSelectionBackground': '#e4e6f1',
    'editorWidget-background': '#f8f8f8', 'editorWidget-border': '#c8c8c8', 'toolbar-hoverBackground': '#b8b8b850', 'textLink-foreground': '#005fb8',
  },
  hc: {
    'sideBar-background': '#000000', 'editor-background': '#000000', foreground: '#ffffff', descriptionForeground: '#ffffff', 'list-hoverBackground': '#1a1a1a',
    'editorWarning-foreground': '#ffff00', 'panel-border': '#6fc3df', focusBorder: '#f38518', contrastBorder: '#6fc3df', contrastActiveBorder: '#f38518',
    'button-background': '#000000', 'button-foreground': '#ffffff', 'button-border': '#6fc3df', 'button-hoverBackground': '#1a1a1a',
    'button-secondaryBackground': '#000000', 'button-secondaryForeground': '#ffffff', 'button-secondaryHoverBackground': '#1a1a1a',
    'badge-background': '#000000', 'badge-foreground': '#ffffff', errorForeground: '#f48771', 'list-inactiveSelectionBackground': '#000000',
    'editorWidget-background': '#0c141f', 'editorWidget-border': '#6fc3df', 'toolbar-hoverBackground': '#ffffff1f', 'textLink-foreground': '#3794ff',
  },
};
const themeName = THEMES[params.get('theme') ?? ''] ? (params.get('theme') as string) : 'dark';
for (const [k, v] of Object.entries(THEMES[themeName]!)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
document.documentElement.style.setProperty('--vscode-font-family', '"Segoe UI", system-ui, -apple-system, sans-serif');
document.body.classList.add(themeName === 'light' ? 'vscode-light' : 'vscode-dark');
if (themeName === 'hc') document.body.classList.add('vscode-high-contrast');
document.body.style.color = 'var(--vscode-foreground)';

// ---------------------------------------------------------------------------
// The frame: a box of the requested width. `contain: layout` makes it the containing block of the fixed-position
// drawer and icon bar, so `&w=` really narrows them.

const widthParam = Number(params.get('w'));
const fixedW = Number.isFinite(widthParam) && widthParam > 0 ? Math.round(widthParam) : 0;
const frame = document.getElementById('frame') as HTMLDivElement;
Object.assign(frame.style, { position: 'relative', height: '100vh', overflow: 'hidden', contain: 'layout paint', width: fixedW ? `${fixedW}px` : '100%' });
const viewW = (): number => fixedW || window.innerWidth;

const STYLE = `
.pg-office { position: absolute; left: 0; top: 0; bottom: 0; background-color: var(--vscode-editor-background); overflow: hidden;
  background-image: linear-gradient(color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 1px, transparent 1px);
  background-size: 24px 24px; }
.pg-prop { position: absolute; display: flex; align-items: center; justify-content: center; padding: 4px 8px; font: 11px/14px var(--vscode-font-family); text-align: center;
  color: var(--vscode-descriptionForeground); border: 1px dashed color-mix(in srgb, var(--vscode-foreground) 35%, transparent); border-radius: 3px; }
.pg-prop.hl { color: var(--vscode-foreground); border: 2px solid #ffb000; background: color-mix(in srgb, #ffb000 22%, transparent); }
.pg-note { position: absolute; left: 8px; bottom: 6px; max-width: 60%; margin: 0; font: 11px/14px var(--vscode-editor-font-family, monospace); white-space: pre-wrap;
  color: var(--vscode-descriptionForeground); pointer-events: none; }
.pg-case, .pg-memo { position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 12px; color: var(--vscode-foreground);
  font: 13px/1.45 var(--vscode-font-family); background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); }
.pg-case { top: 0; right: 0; bottom: 0; width: min(100%, 400px); }
.pg-memo { z-index: 30; left: 50%; top: 90px; width: min(92%, 360px); transform: translateX(-50%); border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
.pg-case[hidden], .pg-memo[hidden] { display: none; }
.pg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pg-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pg-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); border-radius: 4px; }
.pg-item.unread { border-left: 3px solid var(--vscode-focusBorder); }
.pg-dim { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
.pg-h { margin: 0 0 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
.pg-prompt { padding: 8px 10px; border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 4px; }
`;
document.head.appendChild(h('style', { text: STYLE }));

// ---------------------------------------------------------------------------
// Mock data

const NOW = Number(params.get('now')) || Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
function agent(id: string, title: string, project: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, kind: 'main', title, project, activity: 'idle', status: 'idle', since: NOW - 5 * MIN, startedAt: NOW - 60 * MIN, control: 'office', sessionId: `sess-${id}`, ...over };
}

const LOGIN_REPORT = [
  '## Fixed the redirect loop',
  '',
  'The login page bounced between `/login` and `/` when the session cookie had expired. Two causes:',
  '',
  '- the guard in `middleware.ts` read the cookie **before** the refresh call finished',
  '- `redirectTo` was not URL-encoded, so a query string in it was dropped',
  '',
  'Now the guard waits for the refresh and `redirectTo` is encoded. I added a regression test in `login.test.ts` and the whole suite passes (214 tests).',
  '',
  '```ts',
  'const next = encodeURIComponent(location.pathname + location.search);',
  "router.replace(`/login?redirectTo=${next}`);",
  '```',
  '',
  'Not done: the mobile app has the same bug. Say the word and I will look at it.',
].join('\n');

const PLAN_TEXT = [
  '# Split invoices into line items and payments',
  '',
  '## Why',
  'The `invoices` table mixes what was sold with how it was paid, so every report needs a union. Splitting them makes refunds and part payments possible.',
  '',
  '## Steps',
  '1. Add `invoice_lines` and `invoice_payments` with migrations (reversible).',
  '2. Backfill both tables from `invoices` in batches of 5,000.',
  '3. Switch the reports to read the new tables behind a flag.',
  '4. Remove the old columns after one release.',
  '',
  '## Risks',
  '- The backfill locks the table for about 40 s on production-sized data. I will run it in batches off-peak.',
  '- Currency rounding: lines are stored in minor units.',
  '',
  '> Files touched: `db/migrations`, `reports/*`, `billing/invoice.ts`',
].join('\n');

const agents: AgentSnapshot[] = [
  agent('a1', 'Fix the login redirect', 'web-app', {
    model: 'claude-opus-4-5', effort: 'high', context: { tokens: 84_000, max: 200_000, pct: 42 }, costUsd: 1.37,
    lastReport: { at: NOW - 4 * MIN, text: LOGIN_REPORT },
  }),
  agent('a4', 'Write the release notes', 'docs', {
    model: 'claude-sonnet-4-5', costUsd: 0.21, lastReport: { at: NOW - 3 * HOUR, text: '# Release notes for 0.3\n\nDrafted from the merged pull requests. I kept the tone dry.' },
  }),
  agent('a2', 'Refactor invoices', 'billing', {
    activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq-plan', kind: 'plan' }, costUsd: 3.8, model: 'claude-opus-4-5', effort: 'xhigh',
    plans: [
      { id: 'p-old', at: NOW - 2 * DAY, title: 'Move invoices to a queue', status: 'superseded', chars: 900 },
      { id: 'p-ok', at: NOW - 5 * HOUR, decidedAt: NOW - 4 * HOUR, title: 'Add an index on invoices.customer_id', status: 'approved', chars: 1_400 },
      { id: 'p-back', at: NOW - 3 * HOUR, decidedAt: NOW - 2 * HOUR, title: 'Rewrite the invoice PDF renderer', status: 'rejected', chars: 3_200 },
      { id: 'p-slow', at: NOW - 40 * MIN, decidedAt: NOW - 30 * MIN, title: 'Drop the legacy tax table', status: 'approved', chars: 2_100 },
      { id: 'p-pend', at: NOW - 9 * MIN, title: 'Split invoices into line items and payments', status: 'pending', chars: 4_200 },
    ],
  }),
  agent('a3', 'Audit dependencies', 'tools', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq-perm', kind: 'permission' }, detail: 'Run npm audit fix --force', since: NOW - 2 * MIN }),
  agent('a5', 'Chase the flaky checkout test', 'shop', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq-q', kind: 'question' }, detail: 'Retry the test 20 times, or quarantine it?', since: NOW - 15 * MIN }),
  agent('a6', 'Upgrade to React 19', 'web-app', {
    control: 'elsewhere', model: 'claude-opus-4-5',
    plans: [{ id: 'p-ext', at: NOW - 70 * MIN, title: 'Upgrade React and fix the type errors', status: 'pending', chars: 2_600 }],
  }),
  agent('a7', 'Translate the help pages', 'docs', { control: 'elsewhere', activity: 'needsYou', status: 'waiting', since: NOW - 25 * MIN, detail: 'Waiting for you' }),
];
const LOOKS = ['assistant', 'prankster', 'receptionist', 'crossword', 'knitting', 'hr', 'cat', 'chili'];
const lookOf = (id: string): string | null => LOOKS[Math.max(0, agents.findIndex((a) => a.id === id)) % LOOKS.length] ?? null;

/** `?inbox=empty` leaves nothing in the in-tray; `?inbox=urgent` keeps only what blocks a worker. */
const inboxMode = params.get('inbox');
if (inboxMode === 'empty') {
  agents.length = 0;
  agents.push(agent('a1', 'Fix the login redirect', 'web-app'));
} else if (inboxMode === 'urgent') {
  for (let i = agents.length - 1; i >= 0; i--) {
    const a = agents[i]!;
    delete a.lastReport;
    if (a.plans) a.plans = a.plans.filter((pl) => pl.id === 'p-pend');
    if (a.activity !== 'needsYou') agents.splice(i, 1);
  }
}

function makeUsage(kind: string): UsageSnapshot {
  const base = (over: Partial<UsageSnapshot>): UsageSnapshot => ({ kind: 'plan', plan: 'Max', source: 'probe', probe: 'ok', asOf: NOW - 2 * MIN, windows: [], ...over });
  const w = (id: UsageSnapshot['windows'][number]['id'], pct: number | null, resetsInMin: number | undefined, over: Partial<UsageSnapshot['windows'][number]> = {}): UsageSnapshot['windows'][number] =>
    ({ id, pct, ...(resetsInMin !== undefined ? { resetsAt: NOW + resetsInMin * MIN } : {}), asOf: NOW - 2 * MIN, ...over });
  switch (kind) {
    case 'warn': return base({ windows: [w('five_hour', 72, 95), w('seven_day', 64, 3 * 24 * 60), w('seven_day_opus', 81, 3 * 24 * 60), w('seven_day_sonnet', 22, 3 * 24 * 60)], nextAt: NOW + 4 * MIN });
    case 'danger': return base({ windows: [w('five_hour', 93, 38, { state: 'warning' }), w('seven_day', 88, 2 * 24 * 60 + 300), w('seven_day_opus', 97, 2 * 24 * 60 + 300), w('seven_day_sonnet', 40, 2 * 24 * 60 + 300)], nextAt: NOW + 4 * MIN });
    case 'blocked': return base({ windows: [w('five_hour', 100, 130, { state: 'blocked' }), w('seven_day', 71, 3 * 24 * 60)], nextAt: NOW + 4 * MIN });
    case 'stale': return base({ asOf: NOW - 47 * MIN, probe: 'failed', windows: [w('five_hour', 34, 130, { asOf: NOW - 47 * MIN }), w('seven_day', 61, 3 * 24 * 60, { asOf: NOW - 47 * MIN })], nextAt: NOW + 10 * MIN });
    case 'apiKey': { const u = base({ kind: 'apiKey', windows: [] }); delete u.plan; return u; }
    case 'signedOut': { const u = base({ probe: 'signedOut', windows: [] }); delete u.asOf; delete u.plan; return u; }
    case 'unsupported': return base({ probe: 'unsupported', windows: [] });
    case 'off': return base({ probe: 'off', windows: [] });
    case 'extra': return base({
      windows: [w('five_hour', 55, 140), w('seven_day', 83, 4 * 24 * 60 + 90), w('seven_day_opus', 46, 4 * 24 * 60 + 90)],
      extra: { enabled: true, usedUsd: 12.3, limitUsd: 50, currency: 'GBP', pct: 24.6 }, nextAt: NOW + 3 * MIN,
    });
    case 'none': return base({ probe: 'idle', windows: [] });
    default: return base({ windows: [w('five_hour', 34, 130), w('seven_day', 41, 3 * 24 * 60), w('seven_day_opus', 12, 3 * 24 * 60), w('seven_day_sonnet', 52, 3 * 24 * 60)], nextAt: NOW + 4 * MIN });
  }
}
let usage: UsageSnapshot = makeUsage(params.get('usage') ?? 'ok');
const defaults: ClaudeDefaults = { model: 'opus', effort: 'xhigh', effortByModel: {}, models: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] };

/** An in-memory InboxReadStore. */
function memoryInbox(): InboxReadStore {
  const marks: Record<string, number> = {};
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const l of [...listeners]) l(); };
  return {
    readAt: (k) => marks[k],
    markRead: (k, at) => { marks[k] = at ?? NOW; emit(); },
    markUnread: (k) => { delete marks[k]; emit(); },
    all: () => ({ ...marks }),
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
const inbox = memoryInbox();
// The release-notes report is already read; one stale mark for a report that is gone shows pruning.
for (const a of agents) if (a.id === 'a4' && a.lastReport) inbox.markRead(`report:${a.id}:${a.lastReport.at}`, NOW - 2 * HOUR);

// ---------------------------------------------------------------------------
// The mock office, case file and memo

const office = h('div', { class: 'pg-office' });
const PROPS: [string, string, string][] = [
  ['inTray', 'In-tray', 'left:14%;top:30%;width:80px;height:36px'],
  ['whiteboard', 'Whiteboard', 'left:34%;top:14%;width:110px;height:56px'],
  ['clock', 'Clock', 'left:62%;top:14%;width:56px;height:56px'],
  ['frontDesk', 'Front desk', 'left:20%;top:62%;width:120px;height:56px'],
  ['directoryBoard', 'Directory board', 'left:58%;top:58%;width:110px;height:50px'],
];
const propEls = new Map<string, HTMLElement>();
for (const [id, label, pos] of PROPS) {
  const el = h('div', { class: 'pg-prop', style: pos, text: label });
  propEls.set(id, el);
  office.appendChild(el);
}
const note = h('pre', { class: 'pg-note' });
office.appendChild(note);
frame.appendChild(office);

const logLines: string[] = [];
function log(line: string): void {
  logLines.push(line);
  if (logLines.length > 5) logLines.shift();
  note.textContent = logLines.join('\n');
}
log('playground: Tab into the icon bar, arrows to move, Esc closes memo -> drawer -> case');

function setHover(prop: string | null): void {
  for (const [id, el] of propEls) el.classList.toggle('hl', id === prop);
  if (prop) log(`highlight prop: ${prop}`);
}

const caseTitle = h('strong');
const caseBack = button('', 'co-btn co-secondary co-small', () => { closeCase(true); });
const caseEl = h('aside', { class: 'pg-case', role: 'complementary', 'aria-label': 'Case file (mock)', tabindex: '-1' },
  h('div', { class: 'pg-row' }, caseBack, caseTitle, button('×', 'co-btn co-ghost co-small', () => closeCase(false), { 'aria-label': 'Close case file' })),
  h('p', { class: 'pg-dim', text: 'Mock case file. The real one is webview/engine/caseFile.ts; 4.1 passes it the return target.' }));
caseEl.hidden = true;
frame.appendChild(caseEl);
let caseOpen = false;

function openCase(agentId: string): void {
  const a = agents.find((x) => x.id === agentId);
  const target = drawer.returnTarget();
  caseTitle.textContent = a?.title ?? agentId;
  caseBack.hidden = !target;
  caseBack.textContent = target ? `← ${target.title}` : '';
  caseEl.hidden = false;
  caseOpen = true;
  caseEl.focus({ preventScroll: true });
  log(`openCase(${agentId}); drawer suspended=${drawer.isSuspended()}`);
}
/** `back` = the "← In-tray" button: bring the suspended drawer back. Otherwise the drawer is discarded. */
function closeCase(back: boolean): void {
  caseEl.hidden = true;
  caseOpen = false;
  if (back && drawer.resume()) log('case closed: drawer resumed');
  else { drawer.close(); log('case closed'); }
}

const memoText = h('p', { class: 'pg-dim' });
const memoEl = h('div', { class: 'pg-memo', role: 'dialog', 'aria-label': 'New task (mock)', tabindex: '-1' },
  h('strong', { text: 'New task (mock memo)' }), memoText,
  h('div', { class: 'pg-row' }, button('Close', 'co-btn co-secondary co-small', () => closeMemo())));
memoEl.hidden = true;
frame.appendChild(memoEl);
function openMemo(prefill?: unknown): void {
  memoText.textContent = prefill ? `prefill: ${JSON.stringify(prefill)}` : 'Nothing prefilled.';
  memoEl.hidden = false;
  memoEl.focus({ preventScroll: true });
  log('openMemo()');
}
function closeMemo(): void {
  memoEl.hidden = true;
}

// ---------------------------------------------------------------------------
// Icons: the real pixel icons, with existing ones standing in until the art task adds the new ids.

const FALLBACK_ICON: Record<string, IconId> = {
  inTray: 'clipboard', plans: 'palette', usage: 'coffee', bell: 'alert', directory: 'folder', newTask: 'pencil',
  files: 'folder', library: 'page', phone: 'globe', handbook: 'page', agency: 'search',
};
const iconIds = new Set<string>(ICON_IDS);
function icon(name: string): HTMLElement {
  return pixelIcon((iconIds.has(name) ? name : FALLBACK_ICON[name] ?? 'page') as IconId, 20);
}

// ---------------------------------------------------------------------------
// Panels

const registry = new Map<string, PanelView<HTMLElement>>();
/** Makes a panel openable by id: from the icon bar, the Directory and `?panel=<id>`. */
export function registerPanel(view: PanelView<HTMLElement>): void {
  registry.set(view.id, view);
}

/** The mock host: answers getTurn / getPlan / refreshUsage / decide the way the real one would (see &mock= and &delay=). */
const delayMs = Number(params.get('delay')) >= 0 && params.get('delay') !== null ? Number(params.get('delay')) : 500;
const mockMode = params.get('mock');
function reply(msg: HostToWebview, after = delayMs): void {
  setTimeout(() => { drawer.handle(msg); }, after);
}
function post(msg: WebviewToHost): void {
  log(`post ${JSON.stringify(msg).slice(0, 90)}`);
  if (msg.type === 'getTurn') {
    if (mockMode === 'loading') return;
    const a = agents.find((x) => x.id === msg.agentId);
    if (mockMode === 'error' || msg.agentId === 'a4') { reply({ type: 'error', reqId: msg.reqId, message: 'The transcript for this session could not be found.' }); return; }
    reply({
      type: 'turn', reqId: msg.reqId, agentId: msg.agentId, truncated: msg.agentId === 'a2',
      items: [
        { kind: 'prompt', id: 't1', text: 'The login page loops when my session has expired. Please find out why and fix it.' },
        { kind: 'thinking', id: 't2' },
        { kind: 'tool', id: 't3', name: 'Grep', state: 'done', summary: 'Searched for redirectTo' },
        { kind: 'tool', id: 't4', name: 'Read', state: 'done', summary: 'Read middleware.ts' },
        { kind: 'tool', id: 't5', name: 'Edit', state: 'done', summary: 'Edited middleware.ts' },
        { kind: 'tool', id: 't6', name: 'Bash', state: 'error', summary: 'Ran npm test', output: '1 failing' },
        { kind: 'tool', id: 't7', name: 'Bash', state: 'done', summary: 'Ran npm test' },
        { kind: 'assistant', id: 't8', text: a?.lastReport?.text ?? 'Done.' },
        { kind: 'notice', id: 't9', notice: 'cost', text: '', costUsd: 0.42 },
      ],
    });
  } else if (msg.type === 'getPlan') {
    if (mockMode === 'loading') return;
    if (mockMode === 'error') { reply({ type: 'error', reqId: msg.reqId, message: 'The plan could not be read from the transcript.' }); return; }
    const ref = agents.flatMap((x) => (x.plans ?? []).map((pl) => ({ x, pl }))).find((e) => e.x.id === msg.agentId && e.pl.id === msg.planId);
    if (!ref) { reply({ type: 'error', reqId: msg.reqId, message: 'That plan is no longer in the transcript.' }); return; }
    const out: HostToWebview = {
      type: 'planText', reqId: msg.reqId, agentId: msg.agentId, planId: msg.planId, status: ref.pl.status,
      text: ref.pl.id === 'p-pend' ? PLAN_TEXT : `# ${ref.pl.title}\n\nSteps:\n\n1. Look at the code.\n2. Make the change.\n3. Run the tests.`,
    };
    if (ref.pl.id === 'p-back') { out.feedback = 'Keep the old renderer for invoices before 2023. Rewrite only the layout.'; out.planFilePath = '/home/user/.claude/plans/rewrite-pdf-renderer.md'; }
    if (ref.pl.id === 'p-pend') { out.planFilePath = '/home/user/.claude/plans/split-invoices.md'; out.truncated = params.get('truncated') === '1'; }
    reply(out, msg.planId === 'p-slow' ? 4000 : delayMs);
  } else if (msg.type === 'refreshUsage') {
    usage = { ...usage, probe: 'running' };
    drawer.refresh();
    setTimeout(() => {
      const u = makeUsage(params.get('usage') === 'stale' ? 'ok' : (params.get('usage') ?? 'ok'));
      if (u.asOf !== undefined) u.asOf = NOW;
      usage = u;
      drawer.refresh();
    }, 1500);
  } else if (msg.type === 'decide' && msg.decision.kind === 'plan') {
    const a = agents.find((x) => x.pending?.requestId === msg.requestId);
    const pl = a?.plans?.find((x) => x.status === 'pending');
    if (a && pl) {
      pl.status = msg.decision.approve ? 'approved' : 'rejected';
      pl.decidedAt = NOW;
      delete a.pending;
      a.activity = 'writing';
      a.status = 'working';
    }
    setTimeout(() => { updateBadge(); drawer.refresh(); }, 900);
  }
}
const ctx: DrawerContext = {
  post, openCase, openMemo: (o) => openMemo(o?.prefill),
  agents: () => agents, usage: () => usage, defaults: () => defaults, now: () => NOW, inbox,
};

function openPanel(id: string): boolean {
  const view = registry.get(id);
  if (!view) { log(`no panel registered for "${id}"`); return false; }
  return drawer.open(view, ctx);
}

/** A sub-view, to show the back stack. */
function reportView(title: string): PanelView<HTMLElement> {
  return {
    id: 'sub', title, icon: 'page',
    mount(body, c) {
      body.append(h('p', { text: 'A sub-view pushed on top of the panel. The header button goes back.' }),
        h('div', { class: 'pg-row' }, button('Back', 'co-btn co-secondary co-small', () => c.back())));
    },
  };
}

/** Front desk stand-in: has "unsaved changes" and vetoes closing until the user picks Keep editing or Discard. */
function dummyFrontDesk(): PanelView<HTMLElement> {
  let dirty = false;
  let prompt: HTMLElement | null = null;
  return {
    id: 'frontdesk', title: 'Front desk', icon: 'bell',
    mount(body, c) {
      dirty = params.get('dirty') === '1';
      const check = h('input', { type: 'checkbox', id: 'pg-dirty' }) as HTMLInputElement;
      check.checked = dirty;
      check.addEventListener('change', () => { dirty = check.checked; });
      prompt = h('div', { class: 'pg-prompt', role: 'alert' },
        h('p', { text: 'You have unsaved changes.' }),
        h('div', { class: 'pg-row' },
          button('Keep editing', 'co-btn co-primary co-small', () => { if (prompt) prompt.hidden = true; }),
          button('Discard', 'co-btn co-danger co-small', () => { dirty = false; check.checked = false; if (prompt) prompt.hidden = true; c.back(); })));
      prompt.hidden = true;
      body.append(h('p', { class: 'pg-h', text: 'Dummy panel with beforeClose' }),
        h('label', { for: 'pg-dirty' }, check, ' Pretend there are unsaved edits'), h('p', { class: 'pg-dim', text: 'Close, Esc, another panel or Back is vetoed while this is ticked.' }), prompt);
    },
    beforeClose() {
      if (!dirty) return true;
      if (prompt) prompt.hidden = false;
      return false;
    },
    unmount() { prompt = null; },
  };
}

const rounds: ReadonlySet<Round> = new Set<Round>(params.get('rounds') === 'B' ? ['A', 'B'] : ['A']);

// ---------------------------------------------------------------------------
// Register panels (later tasks add their real panels here, replacing the dummies)

registerPanel(createInboxPanel({ lookOf }));
registerPanel(createPlansPanel({ lookOf }));
registerPanel(createUsagePanel());
registerPanel(createFrontDeskMock(params));
registerPanel(createFileRoomMock(params)); // File room (mock host in panelsFiles.ts; ?fr=error|empty|one|hang-roots|hang-dirs|hang-files|push, &fclick=)
registerPanel(createLibraryMock(params)); // Training library (same file; ?lib=empty|few|big|error|hang|slowfail|later, &libq=, &libclick=)
for (const view of createDeskPanels(params)) registerPanel(view); // phone, handbook, agency (mock host in panelsDesk.ts; ?desk=error|loading|slow|empty|small|big|settled)
registerPanel(createDirectoryPanel({
  entries: () => directoryEntries(rounds),
  openPanel: (id) => { openPanel(id); },
  icon,
  onHover: setHover,
}));

// ---------------------------------------------------------------------------
// The bar and the drawer

function applyDock(): void {
  office.style.width = drawer.dockWidth ? `calc(100% - ${drawer.dockWidth}px)` : '100%';
}
const drawer: PanelDrawer = new PanelDrawer(frame, {
  layoutChanged: applyDock,
  width: 400,
  onChange: (id) => bar.setCurrent(id),
  icon,
});
const bar: IconBar = new IconBar(frame, {
  icon,
  onActivate: (id: IconBarItemId) => {
    if (id === 'newTask') openMemo();
    else if (drawer.currentId() === id) drawer.close();
    else openPanel(id);
  },
  onHover: setHover,
}, viewW(), rounds);

function updateBadge(): void {
  const b = badge(deriveInbox(agents, inbox, NOW));
  bar.setBadge('inbox', params.get('badge') === '0' || b.count === 0 ? null : b);
}
updateBadge();
inbox.subscribe(() => { updateBadge(); drawer.refresh(); });

function layout(): void {
  drawer.setViewport(viewW());
  bar.setWidth(viewW());
  applyDock();
}
layout();
window.addEventListener('resize', layout);

// The Escape order: popover (none here) -> memo -> drawer -> case.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!memoEl.hidden) closeMemo();
  else if (drawer.handleEscape()) { /* consumed */ }
  else if (caseOpen) closeCase(false);
  else return;
  e.preventDefault();
});

const first = params.get('panel');
if (first) {
  openPanel(first);
  const sub = params.get('sub') ?? '';
  const [subKind, subAgent, subPlan] = sub.split(':');
  if (sub === '1') drawer.push(reportView('Report'));
  else if (subKind === 'report') {
    const it = deriveInbox(agents, inbox, NOW).find((i) => i.kind === 'report' && (!subAgent || i.agentId === subAgent));
    if (it) drawer.push(createReportView(it, { lookOf }));
  } else if (subKind === 'plan') {
    const id = subAgent ?? 'a2';
    const planId = subPlan ?? (id === 'a6' ? 'p-ext' : 'p-pend');
    const title = agents.find((x) => x.id === id)?.plans?.find((x) => x.id === planId)?.title ?? 'Plan';
    drawer.push(createPlanView({ agentId: id, planId, title }, { lookOf }));
  }
}

// &click=<button text>[|<button text>...]: after the mock host has answered, click the buttons whose text matches, one every 700 ms
// (for screenshots of states that need a click, e.g. `&sub=plan&click=Send back…` shows the feedback box).
const clicks = (params.get('click') ?? '').split('|').filter(Boolean);
clicks.forEach((label, i) => {
  setTimeout(() => {
    const el = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').trim() === label);
    el?.click();
  }, 1200 + i * 700);
});
