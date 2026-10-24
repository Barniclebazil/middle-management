import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASE_TAB_REFUSALS, CaseTabs, bootJson, caseTabHtml, caseTabTitle, contentSecurityPolicy } from '../src/host/caseTabs.ts';
import type { CaseTabHandle } from '../src/host/caseTabs.ts';
import { routeWebviewMessage } from '../src/host/messageRouter.ts';
import { DEMO_REFUSAL, demoRefusal } from '../src/host/demoGuard.ts';
import { OFFICE_SOURCES, caseAgentOf, caseSource, createReplyRouter, isOfficeSource, tabMaySend } from '../src/host/webviewSource.ts';
import { CASE_TAB_BOOT_ELEMENT_ID, LIMITS } from '../src/shared/protocol.ts';
import type { AgentSnapshot, HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';
import { parseCaseTabBoot, parseWebviewMessage } from '../src/shared/validate.ts';

function agent(id: string, title = `Task ${id}`): AgentSnapshot {
  return { id, kind: 'main', title, project: 'p', activity: 'idle', status: 'idle', since: 0, startedAt: 0 };
}

interface FakeTab extends CaseTabHandle {
  visible: boolean;
  column: number | undefined;
  title: string;
  reveals: number;
  disposed: boolean;
}

function rig(opts: { disposeFiresEvent?: boolean } = {}) {
  const tabs = new Map<string, FakeTab>();
  const announced: string[][] = [];
  const closed: Array<{ agentId: string; byUser: boolean }> = [];
  const created: string[] = [];
  const ref: { ct?: CaseTabs } = {};
  const ct = new CaseTabs({
    create: (agentId, title) => {
      created.push(agentId);
      const tab: FakeTab = {
        visible: true,
        column: 1,
        title,
        reveals: 0,
        disposed: false,
        reveal() {
          tab.reveals++;
        },
        setTitle(t) {
          tab.title = t;
        },
        dispose() {
          tab.disposed = true;
          // Like vscode: the panel's dispose event fires from dispose().
          if (opts.disposeFiresEvent !== false) ref.ct?.disposed(agentId);
        },
      };
      tabs.set(agentId, tab);
      return tab;
    },
    announce: (ids) => void announced.push(ids),
    closed: (agentId, info) => void closed.push({ agentId, byUser: info.byUser }),
  });
  ref.ct = ct;
  return { ct, tabs, announced, closed, created };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tab registry

test('open: an unknown worker is refused, a known one gets a tab titled after their task, and caseTabs is announced', () => {
  const r = rig();
  assert.equal(r.ct.open('a'), 'unknown');
  assert.equal(r.created.length, 0);
  assert.deepEqual(r.announced, []);
  r.ct.setAgents([agent('a', 'Fix the build'), agent('b')]);
  assert.equal(r.ct.open('a'), 'opened');
  assert.equal(r.ct.open('b'), 'opened');
  assert.equal(r.tabs.get('a')?.title, 'Fix the build');
  assert.deepEqual(r.ct.ids(), ['a', 'b']);
  assert.deepEqual(r.announced, [['a'], ['a', 'b']]);
});

test('open: an open worker is focused, never a second tab, and nothing is announced again', () => {
  const r = rig();
  r.ct.setAgents([agent('a')]);
  r.ct.open('a');
  assert.equal(r.ct.open('a'), 'focused');
  assert.equal(r.created.length, 1);
  assert.equal(r.tabs.get('a')?.reveals, 1);
  assert.equal(r.announced.length, 1);
});

test('open: the cap refuses the next tab and closes nothing', () => {
  const r = rig();
  const all = Array.from({ length: LIMITS.caseTabs + 1 }, (_, i) => agent(`w${i}`));
  r.ct.setAgents(all);
  for (let i = 0; i < LIMITS.caseTabs; i++) assert.equal(r.ct.open(`w${i}`), 'opened');
  assert.equal(r.ct.open(`w${LIMITS.caseTabs}`), 'full');
  assert.equal(r.ct.ids().length, LIMITS.caseTabs);
  assert.ok([...r.tabs.values()].every((t) => !t.disposed));
  assert.equal(r.announced.length, LIMITS.caseTabs);
  // An open worker can still be focused when the cap is reached.
  assert.equal(r.ct.open('w0'), 'focused');
  assert.match(CASE_TAB_REFUSALS.full, /Close a tab first/);
});

test('titles follow the agents snapshot; a worker who left keeps the last title', () => {
  const r = rig();
  r.ct.setAgents([agent('a', 'First'), agent('b', 'Other')]);
  r.ct.open('a');
  r.ct.setAgents([agent('a', 'Second'), agent('b', 'Other')]);
  assert.equal(r.tabs.get('a')?.title, 'Second');
  r.ct.setAgents([agent('b', 'Other')]);
  assert.equal(r.tabs.get('a')?.title, 'Second');
  assert.equal(caseTabTitle(undefined), 'Case file');
  assert.equal(caseTabTitle(agent('x', '  a\n b ')), 'a b');
  assert.ok(caseTabTitle(agent('x', 'z'.repeat(200))).length <= 48);
});

test('a tab the user closes: caseTabs is re-sent and the hook says byUser true', () => {
  const r = rig();
  r.ct.setAgents([agent('a'), agent('b')]);
  r.ct.open('a');
  r.ct.open('b');
  r.ct.disposed('a'); // the panel's own dispose event
  assert.deepEqual(r.ct.ids(), ['b']);
  assert.deepEqual(r.announced.at(-1), ['b']);
  assert.deepEqual(r.closed, [{ agentId: 'a', byUser: true }]);
  r.ct.disposed('a'); // a second event for the same tab changes nothing
  assert.equal(r.closed.length, 1);
});

test('a close the host causes passes byUser false, whether or not the dispose event fires during dispose()', () => {
  for (const fires of [true, false]) {
    const r = rig({ disposeFiresEvent: fires });
    r.ct.setAgents([agent('a'), agent('b')]);
    r.ct.open('a');
    r.ct.open('b');
    r.ct.closeByHost('a');
    assert.equal(r.tabs.get('a')?.disposed, true);
    assert.deepEqual(r.closed, [{ agentId: 'a', byUser: false }], `fires ${fires}`);
    assert.deepEqual(r.announced.at(-1), ['b']);
    // A later user close of the other tab is still the user's.
    r.ct.disposed('b');
    assert.deepEqual(r.closed.at(-1), { agentId: 'b', byUser: true });
    r.ct.closeByHost('nobody'); // unknown: nothing happens
    assert.equal(r.closed.length, 2);
  }
});

test('dispose closes every tab and reports nothing, so a shutdown never sends anyone home', () => {
  const r = rig();
  r.ct.setAgents([agent('a'), agent('b')]);
  r.ct.open('a');
  r.ct.open('b');
  const announcedBefore = r.announced.length;
  r.ct.dispose();
  assert.ok([...r.tabs.values()].every((t) => t.disposed));
  assert.deepEqual(r.ct.ids(), []);
  assert.equal(r.announced.length, announcedBefore);
  assert.deepEqual(r.closed, []);
});

test('anyVisible counts case tabs; lastColumn is the column of the newest tab', () => {
  const r = rig();
  r.ct.setAgents([agent('a'), agent('b')]);
  assert.equal(r.ct.anyVisible(), false);
  assert.equal(r.ct.lastColumn(), undefined);
  r.ct.open('a');
  r.ct.open('b');
  r.tabs.get('a')!.visible = false;
  assert.equal(r.ct.anyVisible(), true);
  r.tabs.get('b')!.visible = false;
  assert.equal(r.ct.anyVisible(), false);
  r.tabs.get('a')!.column = 2;
  r.tabs.get('b')!.column = 3;
  assert.equal(r.ct.lastColumn(), 3);
});

// ---------------------------------------------------------------------------------------------------------------------
// Boot HTML

test('boot JSON: < > & and the line separators are escaped, and it parses back to the same boot', () => {
  const agentId = '</script><script>alert(1)</script><!-- & > \u2028\u2029';
  const json = bootJson({ mode: 'case', agentId });
  assert.ok(!/[<>&\u2028\u2029]/.test(json), json);
  assert.deepEqual(JSON.parse(json), { mode: 'case', agentId });
  assert.deepEqual(parseCaseTabBoot(JSON.parse(json)), { mode: 'case', agentId });
});

test('boot with a look: the HTML carries it as JSON the tab can parse, and a hostile look cannot break out', () => {
  const args = { cspSource: 'vscode-webview://abc', nonce: 'N', scriptUri: 'vscode-resource://ext/dist/case.js' };
  const html = caseTabHtml({ ...args, boot: { mode: 'case', agentId: 'w-1', look: 'staff-3' } });
  const m = new RegExp(`<script type="application/json" id="${CASE_TAB_BOOT_ELEMENT_ID}">([^<]*)</script>`).exec(html);
  assert.deepEqual(parseCaseTabBoot(JSON.parse(m![1]!)), { mode: 'case', agentId: 'w-1', look: 'staff-3' });
  const evil = caseTabHtml({ ...args, boot: { mode: 'case', agentId: 'w-1', look: '</script><img src=x>' } });
  assert.equal(evil.match(/<script/g)?.length, 2);
  assert.ok(!evil.includes('<img'));
  const m2 = new RegExp(`id="${CASE_TAB_BOOT_ELEMENT_ID}">([^<]*)</script>`).exec(evil);
  assert.deepEqual(parseCaseTabBoot(JSON.parse(m2![1]!)), { mode: 'case', agentId: 'w-1' }, 'the validator drops the bad look');
  assert.ok(!bootJson({ mode: 'case', agentId: 'w' }).includes('look'), 'no look, no key');
});

test('case tab HTML: the office CSP, one boot element that cannot break out, and dist/case.js by nonce', () => {
  const agentId = 'x</script><img src=x onerror=alert(1)>';
  const html = caseTabHtml({ cspSource: 'vscode-webview://abc', nonce: 'N0nce', scriptUri: 'vscode-resource://ext/dist/case.js', boot: { mode: 'case', agentId } });
  const csp = "default-src 'none'; img-src vscode-webview://abc data:; style-src vscode-webview://abc 'unsafe-inline'; script-src 'nonce-N0nce'";
  assert.equal(contentSecurityPolicy('vscode-webview://abc', 'N0nce'), csp); // the CSP the office has always used, unchanged
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.ok(html.includes('<script nonce="N0nce" src="vscode-resource://ext/dist/case.js"></script>'));
  // Exactly the boot element, the case script and the closing tags: the id cannot add a tag.
  assert.equal(html.match(/<script/g)?.length, 2);
  assert.equal(html.match(/<\/script>/g)?.length, 2);
  assert.ok(!html.includes('<img'));
  const m = new RegExp(`<script type="application/json" id="${CASE_TAB_BOOT_ELEMENT_ID}">([^<]*)</script>`).exec(html);
  assert.ok(m, 'boot element');
  assert.deepEqual(parseCaseTabBoot(JSON.parse(m[1]!)), { mode: 'case', agentId });
  assert.ok(!html.includes('unsafe-eval') && !html.includes('https:'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Sources and routing

test('source ids: view, panel and case:<agentId>', () => {
  assert.equal(caseSource('abc'), 'case:abc');
  assert.equal(caseAgentOf('case:abc'), 'abc');
  assert.equal(caseAgentOf('case:'), undefined);
  assert.equal(caseAgentOf('view'), undefined);
  assert.deepEqual([...OFFICE_SOURCES], ['view', 'panel']);
  assert.ok(isOfficeSource('view') && isOfficeSource('panel') && !isOfficeSource('case:a'));
});

test('a case tab may send only the conversation messages, and openCase only for its own worker', () => {
  const ok: WebviewToHost[] = [
    { type: 'ready' },
    { type: 'openCase', agentId: 'a' },
    { type: 'reply', sessionId: 's', text: 'x' },
    { type: 'decide', requestId: 'r', decision: { kind: 'allow' } },
    { type: 'interrupt', sessionId: 's' },
    { type: 'openInClaudeCode', sessionId: 's' },
    { type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { effort: 'high' } },
    { type: 'getPlan', reqId: 'r', agentId: 'a', planId: 'p' },
    { type: 'getTurn', reqId: 'r', agentId: 'a' },
  ];
  for (const m of ok) assert.equal(tabMaySend(m, 'a'), true, m.type);
  assert.equal(tabMaySend({ type: 'openCase', agentId: 'b' }, 'a'), false);
  const no: WebviewToHost[] = [
    { type: 'openCaseTab', agentId: 'a' },
    { type: 'sendHome', agentId: 'a' },
    { type: 'closeCase' },
    { type: 'listProjects' },
    { type: 'refreshUsage' },
    { type: 'getFileRoots', reqId: 'r' },
    { type: 'getFrontDesk', reqId: 'r' },
    { type: 'newTask', nonce: 'n', projectPath: '/p', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' },
  ];
  for (const m of no) assert.equal(tabMaySend(m, 'a'), false, m.type);
});

function routerRig(demo: boolean) {
  const posted: HostToWebview[] = [];
  const postedTo: Array<{ sources: readonly string[]; msg: HostToWebview }> = [];
  const handled: Array<{ msg: WebviewToHost; source: string }> = [];
  const opened: Array<{ agentId: string; source: string }> = [];
  const sentHome: string[] = [];
  const fdHandled: WebviewToHost[] = [];
  const deps = {
    isDemo: () => demo,
    post: (m: HostToWebview) => void posted.push(m),
    postTo: (sources: readonly string[], msg: HostToWebview) => void postedTo.push({ sources, msg }),
    refreshUsage: () => undefined,
    handle: async (msg: WebviewToHost, source: string) => void handled.push({ msg, source }),
    openCaseTab: (agentId: string, source: string) => void opened.push({ agentId, source }),
    sendHome: (agentId: string) => void sentHome.push(agentId),
    frontDesk: { handles: (m: WebviewToHost) => m.type === 'getFrontDesk', handle: async (m: WebviewToHost) => void fdHandled.push(m) },
  };
  return { deps, posted, postedTo, handled, opened, sentHome, fdHandled };
}

test('routing: the manager host gets the message with its source, including the closeCase sent for a closed tab', () => {
  const r = routerRig(false);
  routeWebviewMessage({ type: 'getTurn', reqId: 'r', agentId: 'a' }, 'case:a', r.deps);
  routeWebviewMessage({ type: 'listProjects' }, 'view', r.deps);
  routeWebviewMessage({ type: 'closeCase' }, 'case:a', r.deps); // OfficeView sends this in the tab's name when it is disposed
  routeWebviewMessage({ type: 'closeCase' }, 'panel', r.deps);
  assert.deepEqual(r.handled.map((h) => [h.msg.type, h.source]), [
    ['getTurn', 'case:a'],
    ['listProjects', 'view'],
    ['closeCase', 'case:a'],
    ['closeCase', 'panel'],
  ]);
});

test('routing: openCaseTab and sendHome go to the hooks, from the office views only', () => {
  const r = routerRig(false);
  routeWebviewMessage({ type: 'openCaseTab', agentId: 'a' }, 'view', r.deps);
  routeWebviewMessage({ type: 'openCaseTab', agentId: 'b' }, 'panel', r.deps);
  routeWebviewMessage({ type: 'openCaseTab', agentId: 'c' }, 'case:c', r.deps);
  routeWebviewMessage({ type: 'sendHome', agentId: 'a' }, 'view', r.deps);
  routeWebviewMessage({ type: 'sendHome', agentId: 'b' }, 'case:b', r.deps);
  assert.deepEqual(r.opened, [
    { agentId: 'a', source: 'view' },
    { agentId: 'b', source: 'panel' },
  ]);
  assert.deepEqual(r.sentHome, ['a']);
  assert.equal(r.handled.length, 0);
});

test('routing: in demo mode both are refused to the sender only, with the agentId, and no hook runs', () => {
  const r = routerRig(true);
  routeWebviewMessage({ type: 'openCaseTab', agentId: 'demo-1' }, 'view', r.deps);
  routeWebviewMessage({ type: 'sendHome', agentId: 'demo-2' }, 'panel', r.deps);
  assert.deepEqual(r.postedTo, [
    { sources: ['view'], msg: { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-1' } },
    { sources: ['panel'], msg: { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-2' } },
  ]);
  assert.equal(r.posted.length, 0);
  assert.equal(r.opened.length + r.sentHome.length + r.handled.length, 0);
});

test('routing: a tab cannot reach the Front desk, the file room or the new-task path', () => {
  const r = routerRig(false);
  routeWebviewMessage({ type: 'getFrontDesk', reqId: 'f' }, 'case:a', r.deps);
  routeWebviewMessage({ type: 'listProjects' }, 'case:a', r.deps);
  routeWebviewMessage({ type: 'getFileRoots', reqId: 'x' }, 'case:a', r.deps);
  assert.equal(r.fdHandled.length + r.handled.length, 0);
});

test('replies: a reqId reply goes to the sender only; a push without one is broadcast', () => {
  const posted: HostToWebview[] = [];
  const postedTo: Array<{ sources: readonly string[]; msg: HostToWebview }> = [];
  const replies = createReplyRouter({ post: (m) => void posted.push(m), postTo: (sources, msg) => void postedTo.push({ sources, msg }) });
  const r = routerRig(false);
  const deps = { ...r.deps, replies };
  routeWebviewMessage({ type: 'getFrontDesk', reqId: 'f1' }, 'panel', deps);
  routeWebviewMessage({ type: 'getFrontDesk', reqId: 'f2' }, 'view', deps);
  replies.post({ type: 'frontDeskDone', reqId: 'f1', ok: true });
  replies.post({ type: 'error', reqId: 'f2', message: 'no' });
  replies.post({ type: 'error', reqId: 'unknown', message: 'x' });
  replies.post({ type: 'error', message: 'toast' });
  assert.deepEqual(postedTo.map((p) => p.sources), [['panel'], ['view']]);
  assert.deepEqual(posted.map((m) => m.type), ['error', 'error']);
});

test('replies: without postTo they fall back to the broadcast', () => {
  const posted: HostToWebview[] = [];
  const replies = createReplyRouter({ post: (m) => void posted.push(m) });
  replies.note({ type: 'getFrontDesk', reqId: 'f1' }, 'view');
  replies.post({ type: 'frontDeskDone', reqId: 'f1', ok: true });
  assert.equal(posted.length, 1);
});

test('replies: the table of senders is bounded', () => {
  const postedTo: string[][] = [];
  const replies = createReplyRouter({ post: () => undefined, postTo: (s) => void postedTo.push([...s]) });
  for (let i = 0; i < 1000; i++) replies.note({ type: 'getFrontDesk', reqId: `r${i}` }, 'view');
  replies.post({ type: 'error', reqId: 'r0', message: 'old' }); // forgotten: broadcast
  replies.post({ type: 'error', reqId: 'r999', message: 'new' });
  assert.equal(postedTo.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Demo guard and validation

test('demo: openCase, openCaseTab and sendHome are refused with the agentId', () => {
  assert.deepEqual(demoRefusal({ type: 'openCase', agentId: 'demo-1' }), { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-1' });
  assert.deepEqual(demoRefusal({ type: 'openCaseTab', agentId: 'demo-1' }), { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-1' });
  assert.deepEqual(demoRefusal({ type: 'sendHome', agentId: 'demo-2' }), { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-2' });
});

test('the validator accepts what the router relays', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'openCaseTab', agentId: 'a', sessionId: 'dropped' }), { type: 'openCaseTab', agentId: 'a' });
  assert.deepEqual(parseWebviewMessage({ type: 'sendHome', agentId: 'a' }), { type: 'sendHome', agentId: 'a' });
});
