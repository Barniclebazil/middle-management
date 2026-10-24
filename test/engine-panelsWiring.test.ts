import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_STALE_MS, PROP_PANEL, buildExtras, createInboxReadStore, createSceneCatalog, isDemoRefusal, panelForProp, panelToRestore, phoneLightsOf, pickHoverProp,
  planNotesOf, propOf, sameExtras, sanitizeSaved, shelfCountOf,
} from '../webview/engine/panelsWiring.ts';
import { DEMO_REFUSAL, demoRefusal } from '../src/host/demoGuard.ts';
import { PROP_IDS, PROP_ROUND } from '../webview/engine/hotspots.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import type { AgentView } from '../webview/engine/targets.ts';
import type { AgentSnapshot, McpServerItem, McpStatus, UsageSnapshot } from '../src/shared/protocol.ts';
import { getUpdate, resetUpdateStore } from '../webview/engine/updateStore.ts';
import { HOST0, agent } from './engine-world.ts';

const NOW = HOST0;
const MIN = 60_000;
const view = (id: string, over: Partial<AgentSnapshot> = {}): AgentView => normalizeAgent(agent(id, over), NOW)!;
const unread = { readAt: () => undefined };
const all = (_: string): boolean => true;
const none = (_: string): boolean => false;

function usage(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    kind: 'plan', source: 'probe', probe: 'ok', asOf: NOW - 2 * MIN,
    windows: [
      { id: 'five_hour', pct: 72, resetsAt: NOW + 95 * MIN, asOf: NOW - 2 * MIN },
      { id: 'seven_day', pct: 41, resetsAt: NOW + 3 * 24 * 60 * MIN, asOf: NOW - 2 * MIN },
    ],
    ...over,
  };
}

// -- props -> panels ---------------------------------------------------------

test('every prop maps to a panel: Round A as before, and each Round B prop to its own tool', () => {
  for (const id of PROP_IDS) assert.ok(PROP_PANEL[id], `${id} should open something`);
  assert.equal(PROP_PANEL.clock, 'usage');
  assert.equal(PROP_PANEL.calendar, 'usage');
  assert.equal(PROP_PANEL.inTray, 'inbox');
  assert.equal(PROP_PANEL.whiteboard, 'plans');
  assert.equal(PROP_PANEL.directoryBoard, 'directory');
  assert.equal(PROP_PANEL.frontDesk, 'frontdesk');
  assert.equal(PROP_PANEL.filingCabinets, 'files');
  assert.equal(PROP_PANEL.bookshelf, 'library');
  assert.equal(PROP_PANEL.phone, 'phone');
  assert.equal(PROP_PANEL.noticeBoard, 'handbook');
  assert.equal(PROP_PANEL.tempAgency, 'agency');
  for (const id of PROP_IDS) if (PROP_ROUND[id] === 'B') assert.ok(['files', 'library', 'phone', 'handbook', 'agency'].includes(PROP_PANEL[id]!), id);
});

test('a prop whose panel is not registered does nothing', () => {
  const has = (p: string): boolean => p !== 'frontdesk' && p !== 'library';
  assert.equal(panelForProp('inTray', has), 'inbox');
  assert.equal(panelForProp('frontDesk', has), null);
  assert.equal(panelForProp('frontDesk', all), 'frontdesk');
  assert.equal(panelForProp('bookshelf', has), null);
  assert.equal(panelForProp('bookshelf', all), 'library');
  assert.equal(panelForProp('filingCabinets', all), 'files');
  assert.equal(panelForProp('clock', none), null);
});

test('propOf narrows ids from the icon bar and the Directory', () => {
  assert.equal(propOf('inTray'), 'inTray');
  assert.equal(propOf(null), null);
  assert.equal(propOf('toaster'), null);
});

test('the pointer wins over the icon-bar hover', () => {
  assert.equal(pickHoverProp('clock', 'inTray'), 'clock');
  assert.equal(pickHoverProp(null, 'inTray'), 'inTray');
  assert.equal(pickHoverProp(null, null), null);
});

// -- scene extras ------------------------------------------------------------

test('plan board columns map to the art names: waiting = pending, sentBack = rejected', () => {
  assert.deepEqual(planNotesOf({ waiting: 3, approved: 2, sentBack: 1 }), { pending: 3, approved: 2, rejected: 1 });
});

test('extras without a usage reading leave the clock and calendar plain', () => {
  const x = buildExtras({ usage: null, agents: [], read: unread, now: NOW });
  assert.equal(x.usage, undefined);
  assert.equal(x.week, undefined);
  assert.deepEqual(x.inTray, { count: 0, urgent: false });
  assert.deepEqual(x.piles, {});
  assert.deepEqual(x.planNotes, { pending: 0, approved: 0, rejected: 0 });
});

test('extras carry the ring, the week, the in-tray, piles and plan notes', () => {
  const agents = [
    view('a', { context: { tokens: 140_000, max: 200_000, pct: 70 }, plans: [{ id: 'p1', at: NOW - MIN, title: 'T', status: 'approved', chars: 10, decidedAt: NOW - 30_000 }] }),
    view('b', { context: { tokens: 195_000, max: 200_000, pct: 97 }, activity: 'needsYou', status: 'waiting', pending: { requestId: 'rq', kind: 'plan' },
      plans: [{ id: 'p2', at: NOW - 5 * MIN, title: 'U', status: 'pending', chars: 10 }] }),
    view('c', { context: { tokens: 0, max: 200_000, pct: 0 } }),
    view('d'),
  ];
  const x = buildExtras({ usage: usage(), agents, read: unread, now: NOW });
  assert.deepEqual(x.usage, { pct: 72, level: 'warn', back: null });
  assert.deepEqual(x.week, { pct: 41, level: 'ok' });
  assert.equal(x.inTray.urgent, true);
  assert.ok(x.inTray.count >= 1);
  assert.deepEqual(x.piles, { a: { sheets: 3, warn: false }, b: { sheets: 4, warn: true } });
  assert.deepEqual(x.planNotes, { pending: 1, approved: 1, rejected: 0 });
});

test('a blocked window puts the BACK time on the clock', () => {
  const u = usage({ windows: [{ id: 'five_hour', pct: 100, resetsAt: NOW + 130 * MIN, asOf: NOW - MIN, state: 'blocked' }] });
  const x = buildExtras({ usage: u, agents: [], read: unread, now: NOW });
  assert.equal(x.usage?.level, 'danger');
  assert.match(x.usage?.back ?? '', /\d\d:\d\d/);
  assert.equal(x.week?.pct, null);
});

test('a window whose reset has passed counts as reset (0%, no BACK)', () => {
  const u = usage({ windows: [{ id: 'five_hour', pct: 100, resetsAt: NOW - MIN, asOf: NOW - 10 * MIN, state: 'blocked' }] });
  const x = buildExtras({ usage: u, agents: [], read: unread, now: NOW });
  assert.deepEqual(x.usage, { pct: 0, level: 'ok', back: null });
});

test('marking an item read lowers the in-tray count', () => {
  const a = view('a', { status: 'idle', activity: 'idle', lastReport: { at: NOW - MIN, text: 'Done.' } });
  const before = buildExtras({ usage: null, agents: [a], read: unread, now: NOW });
  assert.equal(before.inTray.count, 1);
  const after = buildExtras({ usage: null, agents: [a], read: { readAt: (k) => (k === `report:a:${NOW - MIN}` ? NOW : undefined) }, now: NOW });
  assert.equal(after.inTray.count, 0);
});

test('sameExtras compares by content', () => {
  const a = buildExtras({ usage: usage(), agents: [], read: unread, now: NOW });
  const b = buildExtras({ usage: usage(), agents: [], read: unread, now: NOW });
  assert.ok(sameExtras(a, b));
  assert.ok(!sameExtras(null, b));
  assert.ok(!sameExtras(a, buildExtras({ usage: usage({ windows: [] }), agents: [], read: unread, now: NOW })));
});

// -- saved state -------------------------------------------------------------

test('sanitizeSaved keeps good fields and drops wrong ones', () => {
  assert.deepEqual(sanitizeSaved(null), {});
  assert.deepEqual(sanitizeSaved('x'), {});
  assert.deepEqual(sanitizeSaved({ drawerW: 480, tipDone: true, panel: 'inbox', inboxRead: { 'report:a:1': 5 }, extra: 1 }),
    { drawerW: 480, tipDone: true, panel: 'inbox', inboxRead: { 'report:a:1': 5 } });
  assert.deepEqual(sanitizeSaved({ drawerW: 'wide', tipDone: 'yes', panel: '<script>', inboxRead: [1, 2] }), {});
  assert.deepEqual(sanitizeSaved({ inboxRead: { a: 1, b: 'x', c: Number.NaN } }), { inboxRead: { a: 1 } });
});

test('sanitizeSaved caps the number of read marks', () => {
  const marks: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) marks[`k${i}`] = i;
  assert.equal(Object.keys(sanitizeSaved({ inboxRead: marks }).inboxRead ?? {}).length, 500);
});

test('the saved panel reopens only if it is registered; the URL parameter wins', () => {
  assert.equal(panelToRestore({ panel: 'plans' }, all), 'plans');
  assert.equal(panelToRestore({ panel: 'frontdesk' }, (p) => p !== 'frontdesk'), null);
  assert.equal(panelToRestore({}, all), null);
  assert.equal(panelToRestore({ panel: 'plans' }, all, 'usage'), 'usage');
  assert.equal(panelToRestore({ panel: 'plans' }, none, 'usage'), null);
});

// -- the read store ----------------------------------------------------------

test('the read store persists a copy after each change and tells subscribers', () => {
  const saved: Record<string, number>[] = [];
  let clock = 1000;
  const store = createInboxReadStore({ old: 1 }, (m) => saved.push(m), () => clock);
  let told = 0;
  const off = store.subscribe(() => { told++; });
  assert.equal(store.readAt('old'), 1);
  store.markRead('k1');
  clock = 2000;
  store.markRead('k2', 1500);
  store.markRead('k2', 1500);
  assert.equal(told, 2, 'a repeat mark with the same time is not a change');
  assert.deepEqual(saved.at(-1), { old: 1, k1: 1000, k2: 1500 });
  store.markUnread('k1');
  store.markUnread('nope');
  assert.equal(told, 3);
  assert.deepEqual(store.all(), { old: 1, k2: 1500 });
  off();
  store.markRead('k3');
  assert.equal(told, 3);
  saved[0]!['mutated'] = 9;
  assert.equal(store.readAt('mutated'), undefined, 'saved copies are detached');
});

test('prune drops marks of items that are gone for longer than the keep window, and only tells when something went', () => {
  const day = 24 * 60 * MIN;
  const a = view('a', { status: 'idle', activity: 'idle', lastReport: { at: NOW - MIN, text: 'Done.' } });
  const liveKey = `report:a:${NOW - MIN}`;
  const store = createInboxReadStore({ [liveKey]: NOW - 5 * day, 'report:gone:1': NOW - 5 * day, 'report:fresh:1': NOW - day }, () => {}, () => NOW);
  let told = 0;
  store.subscribe(() => { told++; });
  store.prune([a], NOW);
  assert.deepEqual(Object.keys(store.all()).sort(), [liveKey, 'report:fresh:1'].sort());
  assert.equal(told, 1);
  store.prune([a], NOW);
  assert.equal(told, 1);
});

// -- Front desk wiring (task 4.7) ------------------------------------------------

import {
  FRONT_DESK_ID, createHostBus, draftStore, tabStore, hostRoute, panelChange, parseStartEdits, routePanelMessage,
} from '../webview/engine/panelsWiring.ts';
import type { SavedState } from '../webview/engine/panelsWiring.ts';
import { FrontDeskController } from '../webview/engine/frontDeskController.ts';
import type { ControllerHost } from '../webview/engine/frontDeskController.ts';
import { DRAFT_MAX_BYTES, serializeDraft } from '../webview/engine/frontDeskLogic.ts';
import type { FrontDeskSetting, FrontDeskSource, FrontDeskState, HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';

const fdState = (source: FrontDeskSource): FrontDeskState => ({
  source, presets: [],
  settings: Object.fromEntries(['mode', 'companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks'].map((k) => [k, { value: '', source: 'default', workspaceWins: false } satisfies FrontDeskSetting])) as FrontDeskState['settings'],
});
const fileSource = (over: Partial<FrontDeskSource> = {}): FrontDeskSource => ({ kind: 'file', label: 'office.json', path: '~/office.json', fromWorkspace: false, exists: true, editable: true, rev: 'aaaaaaaaaaaaaaaa', errors: [], usingLastGood: false, ...over });

test('hostRoute: frontDesk and frontDeskDone go to the bus only, turn/planText/Round B replies/reqId errors to the drawer, the rest nowhere', () => {
  const st = fdState(fileSource());
  assert.equal(hostRoute({ type: 'frontDesk', state: st }), 'bus');
  assert.equal(hostRoute({ type: 'frontDeskDone', reqId: 'fd1', ok: true }), 'bus');
  assert.equal(hostRoute({ type: 'turn', reqId: 'r', agentId: 'a', items: [], truncated: false }), 'drawer');
  assert.equal(hostRoute({ type: 'planText', reqId: 'r', agentId: 'a', planId: 'p', status: 'pending', text: '' }), 'drawer');
  assert.equal(hostRoute({ type: 'error', reqId: 'r', message: 'x' }), 'drawer');
  // The Round B replies: nothing reaches the panels unless they are routed here.
  assert.equal(hostRoute({ type: 'catalog', reqId: 'c', section: 'mcp', servers: [], truncated: false }), 'drawer');
  assert.equal(hostRoute({ type: 'catalog', reqId: 'c', section: 'skills', skills: [], commands: [], truncated: false }), 'drawer');
  assert.equal(hostRoute({ type: 'fileRoots', roots: [] }), 'drawer');
  assert.equal(hostRoute({ type: 'fileRoots', reqId: 'f', roots: [] }), 'drawer');
  assert.equal(hostRoute({ type: 'dirListing', reqId: 'd', rootId: 'r1', relPath: '', entries: [], truncated: false }), 'drawer');
  assert.equal(hostRoute({ type: 'fileText', reqId: 't', rootId: 'r1', relPath: 'a.md', size: 1, text: 'x' }), 'drawer');
  assert.equal(hostRoute({ type: 'error', message: 'x' }), null);
  assert.equal(hostRoute({ type: 'settings', settings: { companyName: 'a', branchName: 'b', speechBubbles: true, managerName: 'c', bossQuotes: true } }), null);
  assert.equal(hostRoute({ type: 'openFrontDesk', tab: 'staff' }), null);
  assert.equal(hostRoute({ type: 'update', update: { status: 'upToDate', current: '0.5.0', auto: true } }), 'bus');
});

test('routePanelMessage: update is stored, emitted on the bus once and never sent to the drawer', () => {
  resetUpdateStore();
  const toDrawer: HostToWebview[] = [];
  const toBus: HostToWebview[] = [];
  const drawer = { handle: (m: HostToWebview): boolean => { toDrawer.push(m); return true; } };
  const bus = { emit: (m: HostToWebview): void => { toBus.push(m); } };
  const msg: HostToWebview = { type: 'update', update: { status: 'available', current: '0.5.0', latest: '0.6.0', auto: true } };
  assert.equal(routePanelMessage(drawer, msg, bus), true);
  assert.deepEqual(toBus, [msg]);
  assert.deepEqual(toDrawer, []);
  assert.equal(getUpdate()?.latest, '0.6.0');
  routePanelMessage(drawer, { type: 'update', update: { status: 'upToDate', current: '0.6.0', auto: true } });
  assert.equal(getUpdate()?.status, 'upToDate', 'stored even without a bus');
  resetUpdateStore();
});

test('sanitizeSaved accepts the about tab', () => {
  assert.deepEqual(sanitizeSaved({ fdTab: 'about' }), { fdTab: 'about' });
  assert.deepEqual(sanitizeSaved({ fdTab: 'nope' }), {});
});

test('routePanelMessage: the Front desk messages reach the onHost bus once and never the drawer (the panel has no handle)', () => {
  const toDrawer: HostToWebview[] = [];
  const toBus: HostToWebview[] = [];
  const drawer = { handle: (m: HostToWebview): boolean => { toDrawer.push(m); return true; } };
  const bus = { emit: (m: HostToWebview): void => { toBus.push(m); } };
  const state: HostToWebview = { type: 'frontDesk', state: fdState(fileSource()), reqId: 'fd1' };
  const done: HostToWebview = { type: 'frontDeskDone', reqId: 'fd1', ok: true };
  assert.equal(routePanelMessage(drawer, state, bus), true);
  assert.equal(routePanelMessage(drawer, done, bus), true);
  assert.deepEqual(toBus, [state, done]);
  assert.deepEqual(toDrawer, []);
  const err: HostToWebview = { type: 'error', reqId: 'x', message: 'nope' };
  assert.equal(routePanelMessage(drawer, err, bus), true);
  assert.deepEqual([toDrawer.length, toBus.length], [1, 2], 'a reqId error goes to the drawer only');
  assert.equal(routePanelMessage(drawer, { type: 'error', message: 'plain' }, bus), false);
  assert.equal(routePanelMessage(drawer, state), true, 'without a bus the message is dropped, not sent to the drawer');
  assert.equal(toDrawer.length, 1);
});

test('createHostBus: listeners hear emits in order, unsubscribe works, a throwing listener does not stop the others', () => {
  const bus = createHostBus();
  const seen: string[] = [];
  const offA = bus.subscribe((m) => { seen.push(`a:${m.type}`); });
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((m) => { seen.push(`c:${m.type}`); });
  const quiet = console.error;
  console.error = () => {};
  try { bus.emit({ type: 'frontDeskDone', reqId: 'x', ok: true }); } finally { console.error = quiet; }
  assert.deepEqual(seen, ['a:frontDeskDone', 'c:frontDeskDone']);
  offA();
  assert.equal(bus.size, 2);
  console.error = () => {};
  try { bus.emit({ type: 'frontDeskDone', reqId: 'y', ok: true }); } finally { console.error = quiet; }
  assert.deepEqual(seen, ['a:frontDeskDone', 'c:frontDeskDone', 'c:frontDeskDone']);
});

test('panelChange: the receptionist attends while the Front desk is the root (also under a sub-view), not while hidden or closed', () => {
  const reg = (id: string): boolean => ['inbox', 'plans', 'usage', 'directory', FRONT_DESK_ID].includes(id);
  // open the Front desk
  let c = panelChange(null, FRONT_DESK_ID, false, reg);
  assert.deepEqual(c, { root: FRONT_DESK_ID, barCurrent: FRONT_DESK_ID, savedPanel: FRONT_DESK_ID, attending: true });
  // a sub-view (the person page) on top: not a registered panel, the root stays
  c = panelChange(c.root, 'person-staff-2', false, reg);
  assert.deepEqual(c, { root: FRONT_DESK_ID, barCurrent: FRONT_DESK_ID, savedPanel: FRONT_DESK_ID, attending: true });
  // a case file hides the drawer: she goes back to work, the root and the saved panel are kept
  c = panelChange(c.root, null, true, reg);
  assert.deepEqual(c, { root: FRONT_DESK_ID, barCurrent: null, savedPanel: 'keep', attending: false });
  // the case closes and the drawer comes back
  c = panelChange(c.root, FRONT_DESK_ID, false, reg);
  assert.equal(c.attending, true);
  // another panel replaces it
  c = panelChange(c.root, 'plans', false, reg);
  assert.deepEqual(c, { root: 'plans', barCurrent: 'plans', savedPanel: 'plans', attending: false });
  // closed
  c = panelChange(c.root, null, false, reg);
  assert.deepEqual(c, { root: null, barCurrent: null, savedPanel: undefined, attending: false });
  // the attending flag is switched off before the saved panel is cleared on a close, and on before it is saved on an open: both in one result
  assert.equal(panelChange(FRONT_DESK_ID, null, false, reg).attending, false);
});

test('parseStartEdits: set= pairs, booleans, autoedit shortcuts', () => {
  const p = (q: string): [string, string | boolean][] => parseStartEdits(new URLSearchParams(q));
  assert.deepEqual(p(''), []);
  assert.deepEqual(p('set=colors.wall=%23cfe3e0,staff-2.look.shortSleeves=true,bad,=x'), [['colors.wall', '#cfe3e0'], ['staff-2.look.shortSleeves', true]]);
  assert.deepEqual(p('autoedit=1'), [['company', 'Pennywhistle Paper Co']]);
  assert.deepEqual(p('autoedit=bad&set=company=Acme'), [['colors.wall', 'mauve'], ['company', 'Pennywhistle Paper Co'], ['company', 'Acme']]);
});

// -- the draft in the saved state --------------------------------------------------

test('sanitizeSaved keeps a Front desk draft only when it is text within the 256 KB cap', () => {
  assert.equal(sanitizeSaved({ fdDraft: '{"v":1}' }).fdDraft, '{"v":1}');
  assert.equal(sanitizeSaved({ fdDraft: 42 }).fdDraft, undefined);
  assert.equal(sanitizeSaved({ fdDraft: 'x'.repeat(DRAFT_MAX_BYTES) }).fdDraft?.length, DRAFT_MAX_BYTES);
  assert.equal(sanitizeSaved({ fdDraft: 'x'.repeat(DRAFT_MAX_BYTES + 1) }).fdDraft, undefined);
  // multi-byte text counts in bytes, not characters
  assert.equal(sanitizeSaved({ fdDraft: 'é'.repeat(DRAFT_MAX_BYTES / 2 + 1) }).fdDraft, undefined);
});

test('draftStore: the panel loads and saves under the saved-state key fdDraft; null removes it; over-cap text is refused', () => {
  const saved: SavedState = {};
  const writes: Partial<SavedState>[] = [];
  const store = draftStore(saved, (patch) => { writes.push(patch); Object.assign(saved, patch); });
  assert.equal(store.loadState(), undefined);
  store.saveState('{"v":1,"draft":{}}');
  assert.deepEqual(writes, [{ fdDraft: '{"v":1,"draft":{}}' }]);
  assert.equal(store.loadState(), '{"v":1,"draft":{}}');
  store.saveState('{"v":1,"draft":{}}');
  assert.equal(writes.length, 1, 'an unchanged draft is not written again');
  store.saveState('y'.repeat(DRAFT_MAX_BYTES + 1));
  assert.deepEqual(writes.at(-1), { fdDraft: undefined }, 'too big: dropped, not kept');
  store.saveState('{"v":1}');
  store.saveState(null);
  assert.equal(saved.fdDraft, undefined);
  assert.equal(writes.at(-1)?.fdDraft, undefined);
});

/** A controller wired the way main.ts does it: its draft in a saved-state object through draftStore. */
function deskRig(saved: SavedState, theme: OfficeTheme | null): { c: FrontDeskController; posted: WebviewToHost[]; previews: (OfficeTheme | null)[]; fire(): void } {
  const posted: WebviewToHost[] = [];
  const previews: (OfficeTheme | null)[] = [];
  const timers: (() => void)[] = [];
  const store = draftStore(saved, (patch) => { Object.assign(saved, patch); });
  const host: ControllerHost = {
    hostTheme: () => theme, post: (m) => { posted.push(m); }, preview: (t) => { previews.push(t); },
    loadState: () => store.loadState(), saveState: (t) => { store.saveState(t); },
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; },
  };
  return { c: new FrontDeskController(host), posted, previews, fire: () => { timers.shift()?.(); } };
}

function openDesk(r: ReturnType<typeof deskRig>, source: FrontDeskSource): void {
  r.c.start();
  const req = r.posted.at(-1) as { reqId: string };
  r.c.receive({ type: 'frontDesk', state: fdState(source), reqId: req.reqId });
  r.c.receive({ type: 'frontDeskDone', reqId: req.reqId, ok: true });
}

test('case detour: unsaved edits survive the drawer being hidden, discarded behind a case file and reopened (same controller), and a reload (saved state)', () => {
  const saved: SavedState = {};
  const r = deskRig(saved, { company: 'Acme' });
  openDesk(r, fileSource());
  r.c.edit('company', 'Pennywhistle');
  assert.equal(r.c.isDirty(), true);
  assert.ok(typeof saved.fdDraft === 'string' && saved.fdDraft.includes('Pennywhistle'), 'the draft is in the saved state under fdDraft');
  // The case file closed and the drawer is dismissed: close asks, the Front desk vetoes and shows its prompt (no silent loss).
  assert.equal(r.c.beforeClose(), false);
  assert.equal(r.c.closePrompt, true);
  // Even if the panel were unmounted and mounted again, the draft is still there.
  r.c.flush();
  r.c.start();
  const req = r.posted.at(-1) as { reqId: string };
  r.c.receive({ type: 'frontDesk', state: fdState(fileSource()), reqId: req.reqId });
  assert.equal(r.c.draft().company, 'Pennywhistle');
  assert.equal(r.c.isDirty(), true);
  // A reload of the webview: a new controller reads the draft back from the saved state (sanitized the way main.ts does).
  const reloaded: SavedState = sanitizeSaved(JSON.parse(JSON.stringify(saved)));
  const r2 = deskRig(reloaded, { company: 'Acme' });
  openDesk(r2, fileSource());
  assert.equal(r2.c.draft().company, 'Pennywhistle');
  assert.equal(r2.c.isDirty(), true);
  r2.fire();
  assert.equal(r2.previews.at(-1)?.company, 'Pennywhistle', 'the restored draft is previewed in the office');
});

test('Discard in the prompt drops the draft from the saved state; a clean panel keeps nothing', () => {
  const saved: SavedState = {};
  const r = deskRig(saved, { company: 'Acme' });
  openDesk(r, fileSource());
  r.c.edit('company', 'Pennywhistle');
  assert.ok(saved.fdDraft);
  r.c.beforeClose();
  assert.equal(r.c.discardForClose(), true);
  assert.equal(saved.fdDraft, undefined);
  assert.equal(r.c.draft().company, 'Acme');
  r.c.edit('company', 'Acme');
  assert.equal(saved.fdDraft, undefined, 'editing back to the host theme leaves nothing saved');
});

test('a saved draft is dropped when the theme source changed (and is cleared from the saved state)', () => {
  const stale = serializeDraft({ company: 'Old' }, 'file||~/other.json', 'aaaaaaaaaaaaaaaa');
  assert.ok(stale);
  const saved: SavedState = { fdDraft: stale };
  const r = deskRig(saved, { company: 'Acme' });
  openDesk(r, fileSource());
  assert.equal(r.c.draft().company, 'Acme');
  assert.equal(r.c.isDirty(), false);
  assert.equal(saved.fdDraft, undefined, 'the stale draft no longer sits in the saved state');
  // The same draft for the same source is restored.
  const same = serializeDraft({ company: 'Old' }, 'file||~/office.json', 'aaaaaaaaaaaaaaaa');
  const saved2: SavedState = { fdDraft: same! };
  const r2 = deskRig(saved2, { company: 'Acme' });
  openDesk(r2, fileSource());
  assert.equal(r2.c.draft().company, 'Old');
  // A source switch while running drops the draft too.
  r2.c.receive({ type: 'frontDesk', state: fdState({ kind: 'builtin', label: 'Built-in office', fromWorkspace: false, exists: true, editable: false, readOnly: 'builtin', errors: [], usingLastGood: false }) });
  assert.equal(saved2.fdDraft, undefined);
});

test('an over-cap draft is never kept: serializeDraft refuses it, so the saved state holds nothing', () => {
  const saved: SavedState = {};
  const r = deskRig(saved, { company: 'Acme' });
  openDesk(r, fileSource());
  r.c.edit('company', 'z'.repeat(60_000));
  r.c.update((d) => ({ ...d, smallTalk: Array.from({ length: 900 }, (_, i) => [`line ${i} ${'x'.repeat(200)}`, `reply ${i} ${'y'.repeat(200)}`] as [string, string]) }));
  assert.equal(saved.fdDraft, undefined);
  assert.equal(r.c.isDirty(), true, 'the edits themselves are not lost, only their persistence');
});

// -- Round B: scene state from the panels' replies ----------------------------

const srv = (status: McpStatus, name = 'x'): McpServerItem => ({ name, scope: 'user', transport: 'stdio', status });
const mcpMsg = (...statuses: McpStatus[]): HostToWebview => ({ type: 'catalog', reqId: 'm1', section: 'mcp', servers: statuses.map((s, i) => srv(s, `server-${i}`)), truncated: false });
const skillsMsg = (skills: number, commands: number): HostToWebview => ({
  type: 'catalog', reqId: 's1', section: 'skills', truncated: false,
  skills: Array.from({ length: skills }, (_, i) => ({ name: `s${i}`, invoke: `s${i}`, description: '', source: 'user' as const })),
  commands: Array.from({ length: commands }, (_, i) => ({ name: `c${i}`, invoke: `c${i}`, description: '', source: 'builtin' as const })),
});

test('phone lights: the statuses only, problems first, nothing for an unknown value', () => {
  assert.deepEqual(phoneLightsOf([srv('connected'), srv('disabled'), srv('failed'), srv('unknown'), srv('needsAuth'), srv('pending'), srv('connected')]),
    ['failed', 'needsAuth', 'pending', 'connected', 'connected', 'unknown', 'disabled']);
  assert.deepEqual(phoneLightsOf([]), []);
  assert.deepEqual(phoneLightsOf([{ status: 'bogus' as McpStatus }, srv('connected')]), ['connected']);
  assert.deepEqual(Object.keys(phoneLightsOf([srv('connected', 'secret-name')])), ['0']);
});

test('shelf count is skills plus commands', () => {
  assert.equal(shelfCountOf(12, 5), 17);
  assert.equal(shelfCountOf(0, 0), 0);
  assert.equal(shelfCountOf(-3, 2.9), 2);
});

test('the scene catalog starts empty: no phone lights and the classic shelf', () => {
  const c = createSceneCatalog();
  assert.equal(c.lights(NOW), undefined);
  assert.equal(c.shelf(), undefined);
  assert.deepEqual(c.saved(), {});
  const e = buildExtras({ usage: null, agents: [], read: unread, now: NOW, phone: c.lights(NOW), shelf: c.shelf() });
  assert.equal('phoneLights' in e, false);
  assert.equal('shelfCount' in e, false);
});

test('the last mcp reply sets the lights and the last skills reply sets the shelf; other messages change nothing', () => {
  const c = createSceneCatalog();
  assert.equal(c.observe(mcpMsg('pending', 'connected', 'failed'), NOW), true);
  assert.deepEqual(c.lights(NOW), ['failed', 'pending', 'connected']);
  // The same section answers again under one reqId: each answer replaces the last.
  assert.equal(c.observe(mcpMsg('connected', 'connected', 'failed'), NOW + 1500), true);
  assert.deepEqual(c.lights(NOW + 1500), ['failed', 'connected', 'connected']);
  assert.equal(c.observe(mcpMsg('connected', 'connected', 'failed'), NOW + 3000), false, 'an identical answer is not a change');
  assert.equal(c.observe(skillsMsg(12, 7), NOW), true);
  assert.equal(c.shelf(), 19);
  assert.equal(c.observe(skillsMsg(12, 7), NOW), false);
  assert.equal(c.observe(skillsMsg(0, 0), NOW), true);
  assert.equal(c.shelf(), 0, 'an empty library is an empty shelf, not the classic one');
  for (const m of [
    { type: 'catalog', reqId: 'a', section: 'agents', agents: [], truncated: false },
    { type: 'catalog', reqId: 'h', section: 'handbook', instructions: [], memory: [], rules: [], truncated: false },
    { type: 'error', reqId: 'm1', message: 'nope' },
    { type: 'fileRoots', roots: [] },
    { type: 'usage', usage: usage() },
  ] as HostToWebview[]) assert.equal(c.observe(m, NOW), false, m.type);
  assert.deepEqual(c.lights(NOW + 3000), ['failed', 'connected', 'connected'], 'an error leaves the last lights alone');
});

test('a line still connecting a minute later is drawn as unknown, and goes back when the answer comes', () => {
  const c = createSceneCatalog();
  c.observe(mcpMsg('pending', 'connected'), NOW);
  assert.deepEqual(c.lights(NOW + PENDING_STALE_MS), ['pending', 'connected']);
  assert.deepEqual(c.lights(NOW + PENDING_STALE_MS + 1), ['unknown', 'connected']);
  c.observe(mcpMsg('connected', 'connected'), NOW + 70_000);
  assert.deepEqual(c.lights(NOW + 71_000), ['connected', 'connected']);
});

test('what is saved is only statuses and a number, never a server name, and a pending line is saved as unknown', () => {
  const c = createSceneCatalog();
  c.observe(mcpMsg('pending', 'connected', 'needsAuth'), NOW);
  c.observe(skillsMsg(3, 4), NOW);
  const saved = c.saved();
  assert.deepEqual(saved, { phone: ['needsAuth', 'unknown', 'connected'], shelf: 7 });
  assert.equal(JSON.stringify(saved).includes('server-'), false);
  // ... and it survives a reload through the sanitiser.
  const back = createSceneCatalog(sanitizeSaved(JSON.parse(JSON.stringify(saved))), NOW);
  assert.deepEqual(back.lights(NOW), ['needsAuth', 'unknown', 'connected']);
  assert.equal(back.shelf(), 7);
});

test('sanitizeSaved keeps good phone statuses and a shelf count, and drops anything else', () => {
  assert.deepEqual(sanitizeSaved({ phone: ['connected', 'failed'], shelf: 12 }), { phone: ['connected', 'failed'], shelf: 12 });
  assert.deepEqual(sanitizeSaved({ phone: ['connected', 'pending', 'rm -rf', 5, null, 'disabled'] }), { phone: ['connected', 'unknown', 'disabled'] });
  assert.deepEqual(sanitizeSaved({ phone: [] }), { phone: [] });
  assert.deepEqual(sanitizeSaved({ phone: 'connected', shelf: 'twelve' }), {});
  assert.deepEqual(sanitizeSaved({ shelf: -1 }), {});
  assert.deepEqual(sanitizeSaved({ shelf: 2.5 }), {});
  assert.deepEqual(sanitizeSaved({ shelf: Number.NaN }), {});
  assert.deepEqual(sanitizeSaved({ shelf: 100_000 }), {});
  assert.equal(sanitizeSaved({ phone: Array.from({ length: 500 }, () => 'connected') }).phone?.length, 100);
});

test('buildExtras carries the phone lights and the shelf count, and sameExtras sees them change', () => {
  const base = { usage: null, agents: [], read: unread, now: NOW };
  const a = buildExtras({ ...base, phone: ['failed', 'connected'], shelf: 12 });
  assert.deepEqual(a.phoneLights, ['failed', 'connected']);
  assert.equal(a.shelfCount, 12);
  assert.equal(sameExtras(a, buildExtras({ ...base, phone: ['failed', 'connected'], shelf: 12 })), true);
  assert.equal(sameExtras(a, buildExtras({ ...base, phone: ['failed', 'failed'], shelf: 12 })), false);
  assert.equal(sameExtras(a, buildExtras({ ...base, phone: ['failed', 'connected'], shelf: 13 })), false);
  assert.equal(buildExtras({ ...base, shelf: 0 }).shelfCount, 0);
  assert.deepEqual(buildExtras({ ...base, phone: [] }).phoneLights, []);
});

test('the demo refusal is recognised, and ordinary errors are not', () => {
  assert.equal(isDemoRefusal(DEMO_REFUSAL), true);
  for (const m of [
    demoRefusal({ type: 'getCatalog', reqId: 'x', section: 'mcp' }),
    demoRefusal({ type: 'getFileRoots', reqId: 'x' }),
    demoRefusal({ type: 'listDir', reqId: 'x', rootId: 'r1', relPath: '' }),
    demoRefusal({ type: 'readFile', reqId: 'x', rootId: 'r1', relPath: 'a' }),
  ]) assert.equal(m?.type === 'error' && isDemoRefusal(m.message), true);
  for (const m of ['The folders could not be listed.', '', 'demo', 'Demo', undefined, 5, null]) assert.equal(isDemoRefusal(m), false, String(m));
});

test('tabStore: the Front desk tab survives a re-render through the saved state (fdTab)', () => {
  const saved: SavedState = {};
  const writes: Partial<SavedState>[] = [];
  const persist = (patch: Partial<SavedState>): void => { writes.push(patch); Object.assign(saved, patch); };
  assert.equal(tabStore(saved, persist).initialTab, undefined);
  tabStore(saved, persist).saveTab('settings');
  tabStore(saved, persist).saveTab('settings');
  assert.deepEqual(writes, [{ fdTab: 'settings' }], 'an unchanged tab is not written again');
  assert.equal(tabStore(sanitizeSaved(JSON.parse(JSON.stringify(saved))), persist).initialTab, 'settings');
  assert.equal(sanitizeSaved({ fdTab: 'bogus' }).fdTab, undefined);
});
