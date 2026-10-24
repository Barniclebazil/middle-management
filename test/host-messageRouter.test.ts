import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectedRequestReply, routeWebviewMessage } from '../src/host/messageRouter.ts';
import { DEMO_REFUSAL } from '../src/host/demoGuard.ts';
import { VIEW_REFUSAL } from '../src/host/viewGuard.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { parseWebviewMessage } from '../src/shared/validate.ts';
import type { HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';

function rig(demo: boolean) {
  const posted: HostToWebview[] = [];
  const handled: WebviewToHost[] = [];
  let refreshes = 0;
  const deps = {
    isDemo: () => demo,
    post: (m: HostToWebview) => void posted.push(m),
    refreshUsage: () => void refreshes++,
    handle: async (m: WebviewToHost) => void handled.push(m),
  };
  return { deps, posted, handled, refreshes: () => refreshes };
}

const PLAN: WebviewToHost = { type: 'getPlan', reqId: 'r', agentId: 'a', planId: 'p' };

test('refreshUsage goes to the usage service only, in real and demo mode', () => {
  for (const demo of [false, true]) {
    const r = rig(demo);
    routeWebviewMessage({ type: 'refreshUsage' }, 'view', r.deps);
    assert.equal(r.refreshes(), 1, `demo ${demo}`);
    assert.equal(r.handled.length, 0);
    assert.equal(r.posted.length, 0);
  }
});

test('other messages go to the manager host when not in demo mode', () => {
  const r = rig(false);
  routeWebviewMessage(PLAN, 'view', r.deps);
  routeWebviewMessage({ type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { effort: 'high' } }, 'view', r.deps);
  routeWebviewMessage({ type: 'getTurn', reqId: 'r', agentId: 'a' }, 'view', r.deps);
  assert.deepEqual(r.handled.map((m) => m.type), ['getPlan', 'setSessionOptions', 'getTurn']);
  assert.equal(r.posted.length, 0);
  assert.equal(r.refreshes(), 0);
});

test('in demo mode the session-acting messages are refused and never reach the host', () => {
  const r = rig(true);
  routeWebviewMessage(PLAN, 'view', r.deps);
  routeWebviewMessage({ type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { effort: 'high' } }, 'view', r.deps);
  routeWebviewMessage({ type: 'getTurn', reqId: 'r2', agentId: 'a' }, 'view', r.deps);
  assert.equal(r.handled.length, 0);
  assert.deepEqual(r.posted, [
    { type: 'error', message: DEMO_REFUSAL, reqId: 'r' },
    { type: 'error', message: DEMO_REFUSAL, nonce: 'n', sessionId: 's' },
    { type: 'error', message: DEMO_REFUSAL, reqId: 'r2' },
  ]);
  // Harmless messages still reach the host in demo mode.
  routeWebviewMessage({ type: 'listProjects' }, 'view', r.deps);
  assert.deepEqual(r.handled.map((m) => m.type), ['listProjects']);
});

const FD_TYPES = new Set(['getFrontDesk', 'themeAction', 'setSetting', 'saveTheme', 'saveThemeAs', 'openSettingsUi']);

function fdRig(demo: boolean) {
  const r = rig(demo);
  const fdHandled: WebviewToHost[] = [];
  const frontDesk = { handles: (m: WebviewToHost) => FD_TYPES.has(m.type), handle: async (m: WebviewToHost) => void fdHandled.push(m) };
  return { ...r, fdHandled, deps: { ...r.deps, frontDesk } };
}

const FD_MSGS: WebviewToHost[] = [
  { type: 'getFrontDesk', reqId: 'f1' },
  { type: 'themeAction', reqId: 'f2', action: 'usePreset', presetId: 'example' },
  { type: 'setSetting', reqId: 'f3', key: 'companyName', value: 'Acme' },
  { type: 'saveTheme', reqId: 'f4', rev: '0123456789abcdef', themeJson: '{}' },
  { type: 'saveThemeAs', reqId: 'f5', themeJson: '{}' },
  { type: 'openSettingsUi', key: 'scope', target: 'user' },
];

test('Front desk messages go to the Front desk before the demo guard: in real and in demo mode, never to the host', () => {
  for (const demo of [false, true]) {
    const r = fdRig(demo);
    for (const m of FD_MSGS) routeWebviewMessage(m, 'view', r.deps);
    assert.deepEqual(r.fdHandled.map((m) => m.type), FD_MSGS.map((m) => m.type), `demo ${demo}`);
    assert.equal(r.handled.length, 0);
    assert.equal(r.posted.length, 0);
    assert.equal(r.refreshes(), 0);
  }
});

test('with a Front desk present, other messages still follow the demo guard and the host route', () => {
  const r = fdRig(true);
  routeWebviewMessage(PLAN, 'view', r.deps);
  routeWebviewMessage({ type: 'refreshUsage' }, 'view', r.deps);
  routeWebviewMessage({ type: 'listProjects' }, 'view', r.deps);
  assert.equal(r.fdHandled.length, 0);
  assert.equal(r.posted.length, 1);
  assert.equal(r.posted[0]!.type, 'error');
  assert.equal(r.refreshes(), 1);
  assert.deepEqual(r.handled.map((m) => m.type), ['listProjects']);
});

const OR_TYPES = new Set(['getFileRoots', 'listDir', 'readFile', 'openFile', 'openDiff', 'getCatalog', 'openConfigFile']);

function orRig(demo: boolean) {
  const r = rig(demo);
  const calls: { msg: WebviewToHost; opts: { force?: boolean } | undefined }[] = [];
  const officeRequests = {
    handles: (m: WebviewToHost) => OR_TYPES.has(m.type),
    handle: async (m: WebviewToHost, opts?: { force?: boolean }) => void calls.push({ msg: m, opts }),
  };
  return { ...r, calls, deps: { ...r.deps, officeRequests } };
}

test('Round B requests go to officeRequests, and only a getCatalog with refresh: true is forced', () => {
  const r = orRig(false);
  routeWebviewMessage({ type: 'getCatalog', reqId: 'c1', section: 'skills' }, 'view', r.deps);
  routeWebviewMessage({ type: 'getCatalog', reqId: 'c2', section: 'mcp', refresh: true }, 'view', r.deps);
  routeWebviewMessage({ type: 'getFileRoots', reqId: 'c3' }, 'view', r.deps);
  routeWebviewMessage({ type: 'openConfigFile', fileId: 'f1' }, 'view', r.deps);
  assert.deepEqual(r.calls.map((c) => [c.msg.type, c.opts?.force]), [['getCatalog', false], ['getCatalog', true], ['getFileRoots', false], ['openConfigFile', false]]);
  assert.equal(r.handled.length, 0);
  assert.equal(r.posted.length, 0);
});

test('in demo mode a refreshing getCatalog is refused like any other and never forced', () => {
  const r = orRig(true);
  routeWebviewMessage({ type: 'getCatalog', reqId: 'c9', section: 'mcp', refresh: true }, 'view', r.deps);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.posted, [{ type: 'error', message: DEMO_REFUSAL, reqId: 'c9' }]);
});

test('rejectedRequestReply: a refused Round B request with a valid reqId gets a generic error, never an echo', () => {
  const bad = '../../etc/passwd';
  for (const type of ['getFileRoots', 'listDir', 'readFile', 'getCatalog'] as const) {
    const reply = rejectedRequestReply({ type, reqId: 'req-7', rootId: 'r1', relPath: bad, section: bad, refresh: bad });
    assert.deepEqual(reply, { type: 'error', reqId: 'req-7', message: reply && reply.type === 'error' ? reply.message : '' });
    assert.ok(reply && reply.type === 'error' && reply.message.length > 0 && !reply.message.includes(bad) && !reply.message.includes('req-7'));
  }
});

test('rejectedRequestReply: no reply for other types, missing or invalid reqIds, or non-objects', () => {
  assert.equal(rejectedRequestReply({ type: 'getPlan', reqId: 'r' }), undefined);
  assert.equal(rejectedRequestReply({ type: 'frobnicate', reqId: 'r' }), undefined);
  assert.equal(rejectedRequestReply({ type: 'listDir' }), undefined);
  for (const reqId of [1, '', 'x'.repeat(LIMITS.idChars + 1), 'a\nb', 'a\u0000b', null, {}]) {
    assert.equal(rejectedRequestReply({ type: 'readFile', reqId }), undefined, JSON.stringify(reqId));
  }
  for (const raw of [null, undefined, 'listDir', 42, []]) assert.equal(rejectedRequestReply(raw), undefined);
});

test('rejectedRequestReply: agrees with parseWebviewMessage, a bad listDir is refused and answered', () => {
  const raw = { type: 'listDir', reqId: 'q1', rootId: 'r1', relPath: '../x' };
  assert.equal(parseWebviewMessage(raw), undefined);
  assert.equal(rejectedRequestReply(raw)?.type, 'error');
});

// View mode (`isViewMode`): the view guard sits after the Front desk and before the demo guard.
function viewRig(opts: { demo?: boolean; view?: boolean } = {}) {
  const demo = opts.demo ?? false;
  const view = opts.view ?? true;
  const r = orRig(demo);
  const fdHandled: WebviewToHost[] = [];
  const frontDesk = { handles: (m: WebviewToHost) => FD_TYPES.has(m.type), handle: async (m: WebviewToHost) => void fdHandled.push(m) };
  const sent: { sources: readonly string[]; msg: HostToWebview }[] = [];
  const tabs: string[] = [];
  const home: string[] = [];
  const deps = {
    ...r.deps,
    isViewMode: () => view,
    frontDesk,
    postTo: (sources: readonly string[], msg: HostToWebview) => void sent.push({ sources, msg }),
    openCaseTab: (id: string) => void tabs.push(id),
    sendHome: (id: string) => void home.push(id),
  };
  return { ...r, deps, fdHandled, sent, tabs, home };
}

const VIEW_REFUSED: WebviewToHost[] = [
  { type: 'openCase', agentId: 'a1' },
  { type: 'openCaseTab', agentId: 'a2' },
  { type: 'sendHome', agentId: 'a3' },
  { type: 'newTask', nonce: 'n1', projectPath: '/p', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' },
  { type: 'getCatalog', reqId: 'c1', section: 'skills' },
  { type: 'listDir', reqId: 'l1', rootId: 'r1', relPath: '' },
  { type: 'decide', requestId: 'q1', decision: { kind: 'allow' } },
  { type: 'listProjects' },
];

test('view mode: Front desk messages still go to the Front desk, in view plus demo too', () => {
  for (const demo of [false, true]) {
    const r = viewRig({ demo });
    for (const m of FD_MSGS) routeWebviewMessage(m, 'panel', r.deps);
    assert.deepEqual(r.fdHandled.map((m) => m.type), FD_MSGS.map((m) => m.type), `demo ${demo}`);
    assert.equal(r.sent.length + r.posted.length + r.handled.length + r.calls.length, 0);
  }
});

test('view mode: ready, refreshUsage and closeCase pass the guard', () => {
  const r = viewRig();
  routeWebviewMessage({ type: 'ready' }, 'view', r.deps);
  routeWebviewMessage({ type: 'refreshUsage' }, 'view', r.deps);
  routeWebviewMessage({ type: 'closeCase' }, 'case:a1', r.deps);
  assert.deepEqual(r.handled.map((m) => m.type), ['ready', 'closeCase']);
  assert.equal(r.refreshes(), 1);
  assert.equal(r.sent.length + r.posted.length, 0);
});

test('view mode: everything else is refused with VIEW_REFUSAL to the sender only and reaches nothing', () => {
  const r = viewRig();
  for (const m of VIEW_REFUSED) routeWebviewMessage(m, 'panel', r.deps);
  assert.equal(r.sent.length, VIEW_REFUSED.length);
  for (const x of r.sent) {
    assert.deepEqual(x.sources, ['panel']);
    assert.equal(x.msg.type === 'error' && x.msg.message, VIEW_REFUSAL);
  }
  assert.deepEqual(r.sent.map((x) => x.msg), [
    { type: 'error', message: VIEW_REFUSAL, agentId: 'a1' },
    { type: 'error', message: VIEW_REFUSAL, agentId: 'a2' },
    { type: 'error', message: VIEW_REFUSAL, agentId: 'a3' },
    { type: 'error', message: VIEW_REFUSAL, nonce: 'n1' },
    { type: 'error', message: VIEW_REFUSAL, reqId: 'c1' },
    { type: 'error', message: VIEW_REFUSAL, reqId: 'l1' },
    { type: 'error', message: VIEW_REFUSAL, requestId: 'q1' },
    { type: 'error', message: VIEW_REFUSAL },
  ]);
  assert.equal(r.posted.length, 0, 'nothing is broadcast');
  assert.equal(r.handled.length, 0);
  assert.equal(r.calls.length, 0);
  assert.equal(r.tabs.length, 0);
  assert.equal(r.home.length, 0);
  assert.equal(r.refreshes(), 0);
});

test('view mode: a refusal falls back to post when there is no postTo', () => {
  const r = viewRig();
  const { postTo: _unused, ...deps } = r.deps;
  routeWebviewMessage({ type: 'sendHome', agentId: 'a3' }, 'view', deps);
  assert.deepEqual(r.posted, [{ type: 'error', message: VIEW_REFUSAL, agentId: 'a3' }]);
  assert.equal(r.home.length, 0);
});

test('view plus demo: the view refusal wins', () => {
  const r = viewRig({ demo: true });
  routeWebviewMessage(PLAN, 'view', r.deps);
  routeWebviewMessage({ type: 'listProjects' }, 'view', r.deps); // demo lets this one through, view does not
  assert.deepEqual(r.sent.map((x) => x.msg), [
    { type: 'error', message: VIEW_REFUSAL, reqId: 'r' },
    { type: 'error', message: VIEW_REFUSAL },
  ]);
  assert.equal(r.handled.length, 0);
  assert.equal(r.posted.length, 0);
});

test('manager mode behaves as before, with or without isViewMode', () => {
  for (const view of [false, undefined]) {
    const r = viewRig({ view: view ?? false });
    const deps = view === undefined ? (({ isViewMode: _v, ...d }) => d)(r.deps) : r.deps;
    for (const m of VIEW_REFUSED) routeWebviewMessage(m, 'panel', deps);
    assert.deepEqual(r.handled.map((m) => m.type), ['openCase', 'newTask', 'decide', 'listProjects']);
    assert.deepEqual(r.calls.map((c) => c.msg.type), ['getCatalog', 'listDir']);
    assert.deepEqual(r.tabs, ['a2']);
    assert.deepEqual(r.home, ['a3']);
    assert.equal(r.sent.length + r.posted.length, 0);
  }
});

test('updateAction goes to the update service only: manager mode, demo mode and view mode', () => {
  for (const [demo, view] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const r = viewRig({ demo, view });
    const actions: string[] = [];
    const deps = { ...r.deps, updateAction: (a: string) => void actions.push(a) };
    routeWebviewMessage({ type: 'updateAction', action: 'check' }, 'view', deps);
    routeWebviewMessage({ type: 'updateAction', action: 'install' }, 'panel', deps);
    assert.deepEqual(actions, ['check', 'install'], `demo ${demo} view ${view}`);
    assert.equal(r.handled.length + r.posted.length + r.sent.length + r.fdHandled.length, 0, `demo ${demo} view ${view}`);
  }
});

test('updateAction from a case tab is dropped, and without an update service it does nothing', () => {
  const r = viewRig({ view: false });
  const actions: string[] = [];
  routeWebviewMessage({ type: 'updateAction', action: 'check' }, 'case:a1', { ...r.deps, updateAction: (a: string) => void actions.push(a) });
  assert.deepEqual(actions, []);
  routeWebviewMessage({ type: 'updateAction', action: 'check' }, 'view', r.deps);
  assert.equal(r.handled.length + r.posted.length, 0);
});
