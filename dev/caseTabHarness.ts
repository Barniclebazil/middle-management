/**
 * Mock host for a case tab (dev/caseTab.html, which loads this and then dist/case.js). It writes the boot element, provides
 * `acquireVsCodeApi`, answers `ready` with the shared state and `openCase` with a realistic conversation, then streams
 * `caseAppend`s and plays along with replies, decisions, Stop and the option chips.
 *
 * URL parameters:
 *   state=idle|working|permission|plan|question|error|gone|loaderror|lost|free|elsewhere|temp   (default idle)
 *   theme=dark|light|hc        VS Code colours (default dark)
 *   freeze=1                   no timers: a still frame for screenshots (working shows a reply mid-stream)
 *   lag=<ms>                   delay before the host answers openCase (default 150)
 *   look=<id>                  the look in the boot (default staff-3; look= empty leaves it out)
 *   stray=0                    don't send the messages meant for another worker (they must be ignored)
 *
 * The theme colours are a copy of dev/harness.ts's (that file has no exports and runs on import, so it can't be shared).
 * Names are neutral on purpose.
 */
import type {
  AgentSnapshot, CaseHeader, ClaudeDefaults, ConversationItem, HostToWebview, OfficeSettings, PendingRequest, SessionOptions, UsageSnapshot, WebviewToHost,
} from '../src/shared/protocol.ts';
import { CASE_TAB_BOOT_ELEMENT_ID } from '../src/shared/protocol.ts';

const params = new URLSearchParams(location.search);
type State = 'idle' | 'working' | 'permission' | 'plan' | 'question' | 'error' | 'gone' | 'loaderror' | 'lost' | 'free' | 'elsewhere' | 'temp';
const STATES: readonly State[] = ['idle', 'working', 'permission', 'plan', 'question', 'error', 'gone', 'loaderror', 'lost', 'free', 'elsewhere', 'temp'];
const state: State = (STATES as readonly string[]).includes(params.get('state') ?? '') ? params.get('state') as State : 'idle';
const frozen = params.get('freeze') === '1';
const lag = Math.max(0, Number(params.get('lag') ?? '150') || 0);
const stray = params.get('stray') !== '0';

// ---------------------------------------------------------------------------
// Theme (VS Code puts its colours on <html> as --vscode-* and one theme class on <body>)

const FONT = { 'font-family': 'system-ui, Ubuntu, "Droid Sans", sans-serif', 'font-size': '13px', 'editor-font-family': '"Droid Sans Mono", "DejaVu Sans Mono", monospace' };
const THEMES: Record<string, Record<string, string>> = {
  dark: {
    ...FONT, 'panel-background': '#181818', 'sideBar-background': '#181818', 'editor-background': '#1f1f1f', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
    'list-hoverBackground': '#2a2d2e', 'editorWarning-foreground': '#cca700', 'panel-border': '#2b2b2b', focusBorder: '#0078d4',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c', 'input-background': '#313131', 'input-foreground': '#cccccc',
    'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898', 'textCodeBlock-background': '#2b2b2b', 'textLink-foreground': '#4daafc', 'badge-background': '#616161',
    'badge-foreground': '#f8f8f8', errorForeground: '#f85149', 'inputValidation-errorBackground': '#5a1d1d', 'inputValidation-errorBorder': '#be1100',
    'menu-background': '#1f1f1f', 'menu-border': '#454545', 'menu-selectionBackground': '#0078d4', 'widget-border': '#313131', 'testing-iconPassed': '#73c991',
  },
  light: {
    ...FONT, 'panel-background': '#f8f8f8', 'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171',
    'list-hoverBackground': '#f2f2f2', 'editorWarning-foreground': '#bf8803', 'panel-border': '#e5e5e5', focusBorder: '#005fb8',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b',
    'input-border': '#cecece', 'input-placeholderForeground': '#767676', 'textCodeBlock-background': '#f0f0f0', 'textLink-foreground': '#005fb8', 'badge-background': '#cccccc',
    'badge-foreground': '#3b3b3b', errorForeground: '#c72e0f', 'testing-iconPassed': '#388a34', 'inputValidation-errorBackground': '#f2dede',
    'inputValidation-errorBorder': '#be1100', 'menu-background': '#ffffff', 'menu-border': '#cecece', 'menu-selectionBackground': '#005fb8', 'widget-border': '#e5e5e5',
  },
  hc: {
    ...FONT, 'panel-background': '#000000', 'sideBar-background': '#000000', 'editor-background': '#000000', foreground: '#ffffff', descriptionForeground: '#ffffff',
    'list-hoverBackground': '#000000', 'editorWarning-foreground': '#ffd700', 'panel-border': '#6fc3df', focusBorder: '#f38518',
    contrastBorder: '#6fc3df', contrastActiveBorder: '#f38518', 'button-background': '#000000', 'button-foreground': '#ffffff', 'button-border': '#6fc3df',
    'button-hoverBackground': '#000000', 'button-secondaryBackground': '#000000', 'button-secondaryForeground': '#ffffff', 'button-secondaryHoverBackground': '#000000',
    'input-background': '#000000', 'input-foreground': '#ffffff', 'input-border': '#6fc3df', 'textCodeBlock-background': '#000000', 'textLink-foreground': '#21a6ff',
    'badge-background': '#000000', 'badge-foreground': '#ffffff', errorForeground: '#f48771', 'inputValidation-errorBackground': '#000000',
    'inputValidation-errorBorder': '#f48771', 'editorWidget-background': '#0c141f', 'toolbar-hoverBackground': '#00000000', 'testing-iconPassed': '#73c991',
    'menu-background': '#000000', 'menu-border': '#6fc3df', 'widget-border': '#6fc3df',
  },
};
const themeName = THEMES[params.get('theme') ?? ''] ? params.get('theme')! : 'dark';
for (const [k, v] of Object.entries(THEMES[themeName]!)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
document.body.classList.add(themeName === 'light' ? 'vscode-light' : themeName === 'hc' ? 'vscode-high-contrast' : 'vscode-dark');

// ---------------------------------------------------------------------------
// The workers

const ME = 'w-1';
const OTHER = 'w-2';
const TEMP = 't-1';
const HOME = '/home/dev/projects';
const t0 = Date.now();
const MIN = 60_000;
const at = (minAgo: number): number => t0 - minAgo * MIN;

const own: string = state === 'temp' ? TEMP : ME;
const control = state === 'free' ? 'free' : state === 'elsewhere' ? 'elsewhere' : 'office';

let gone = false;
let busy = state === 'working';
let pending: PendingRequest | null = null;
const opts: SessionOptions = {};
const SID = 'sess-7f3a2c';

function snapshot(): AgentSnapshot[] {
  const knock = pending ? { requestId: pending.requestId, kind: pending.kind } : undefined;
  const me: AgentSnapshot = {
    id: ME, kind: 'main', title: 'Refactor the session refresh in the auth middleware', project: 'billing-api', cwd: `${HOME}/billing-api`,
    gitBranch: 'refactor/session-refresh', sessionId: SID, control, startedAt: at(90), since: at(busy ? 1 : 3),
    activity: knock ? 'needsYou' : busy ? 'running' : 'idle', status: knock ? 'waiting' : busy ? 'working' : 'idle', costUsd: 0.42,
    model: 'claude-opus-4-1-20250805', effort: 'high', context: { tokens: 84_000, max: 200_000, pct: 42 },
  };
  if (knock) me.pending = knock;
  const other: AgentSnapshot = {
    id: OTHER, kind: 'main', title: 'Write the API guide for rate limits', project: 'docs-site', cwd: `${HOME}/docs-site`, sessionId: 'sess-other',
    control: 'office', startedAt: at(120), since: at(2), activity: 'writing', status: 'working',
  };
  const temp: AgentSnapshot = {
    id: TEMP, parentId: ME, kind: 'temp', title: 'Find every caller of verifyToken', project: 'billing-api', cwd: `${HOME}/billing-api`, sessionId: SID,
    startedAt: at(20), since: at(1), activity: 'searching', status: 'working',
  };
  const list = [other];
  if (!gone) list.unshift(me);
  if (state === 'temp') list.push(temp);
  return list;
}

function header(): CaseHeader {
  if (own === TEMP) {
    return { agentId: TEMP, sessionId: SID, title: 'Find every caller of verifyToken', project: 'billing-api', cwd: `${HOME}/billing-api`, activity: 'searching', status: 'working', control: 'none' };
  }
  const h: CaseHeader = {
    agentId: ME, sessionId: SID, title: 'Refactor the session refresh in the auth middleware', project: 'billing-api', cwd: `${HOME}/billing-api`,
    gitBranch: 'refactor/session-refresh', activity: pending ? 'needsYou' : busy ? 'running' : 'idle', status: pending ? 'waiting' : busy ? 'working' : 'idle',
    control, model: opts.model ?? 'claude-opus-4-1-20250805', effort: opts.effort ?? 'high', costUsd: 0.42,
    canSetOptions: control === 'office' || control === 'free',
  };
  if (control === 'office') {
    h.busy = busy;
    h.permissionMode = opts.permissionMode ?? (state === 'plan' ? 'plan' : 'default');
  }
  if (control === 'free') h.next = {};
  return h;
}

// ---------------------------------------------------------------------------
// The conversation

const PLAN = `## Plan: one place for session refresh

**Goal:** remove the duplicated refresh logic without changing \`requireUser()\`.

1. Add \`refreshSession()\` to \`src/auth/session.ts\`
2. Call it from the middleware and the \`/token\` route
3. Delete the two old copies
4. Add tests for expired, rotated and revoked tokens

### Risks
- Tokens issued before the change must keep working
- The admin routes use a *different* cookie name, so they stay as they are

\`\`\`ts
export async function refreshSession(req: Request): Promise<Session>
\`\`\`

I won’t touch the database or the public API.`;

function conversation(): ConversationItem[] {
  if (own === TEMP) {
    return [
      { kind: 'prompt', id: 'tp1', at: at(20), text: 'Find every caller of verifyToken() and say which ones refresh the session themselves.' },
      { kind: 'tool', id: 'tt1', name: 'Grep', state: 'done', summary: 'Searched for "verifyToken("', input: 'pattern: verifyToken\\(\npath: src', output: 'src/auth/middleware.ts:41\nsrc/routes/token.ts:18\nsrc/routes/admin.ts:77' },
      { kind: 'tool', id: 'tt2', name: 'Read', state: 'running', summary: 'Reading src/routes/admin.ts' },
    ];
  }
  const items: ConversationItem[] = [
    { kind: 'prompt', id: 'p1', at: at(42), text: 'The session refresh is copied in the middleware and in the /token route, and they have drifted apart. Put it in one place. Keep requireUser() exactly as it is.' },
    { kind: 'thinking', id: 'th1', at: at(41) },
    { kind: 'assistant', id: 'a1', at: at(41), text: 'I’ll start by reading the middleware and finding every place that refreshes a session.' },
    { kind: 'tool', id: 't1', name: 'Read', state: 'done', summary: 'Read src/auth/middleware.ts', input: 'src/auth/middleware.ts',
      output: '38  export async function requireUser(req: Request) {\n39    const token = readToken(req);\n40    if (token.exp < Date.now()) {\n41      return refresh(token); // copy 1\n42    }\n43    return sessionFrom(token);\n44  }' },
    { kind: 'tool', id: 't2', name: 'Grep', state: 'done', summary: 'Searched for "refresh("', input: 'pattern: refresh\\(\npath: src', output: 'src/auth/middleware.ts:41\nsrc/routes/token.ts:22\nsrc/routes/admin.ts:80' },
    { kind: 'tool', id: 't3', name: 'Read', state: 'done', summary: 'Read src/routes/token.ts', input: 'src/routes/token.ts' },
    { kind: 'assistant', id: 'a2', at: at(39), text: 'Found **two** copies that have drifted: the route one also rotates the refresh token, the middleware one doesn’t. The admin route uses a different cookie, so I’ll leave it alone.' },
    { kind: 'tool', id: 't4', name: 'Edit', state: 'done', summary: 'Edited src/auth/session.ts', input: 'file_path: src/auth/session.ts\n+ export async function refreshSession(req: Request): Promise<Session> {\n+   const token = readToken(req);\n+   if (!isExpired(token)) return sessionFrom(token);\n+   return rotate(token);\n+ }' },
    { kind: 'tool', id: 't5', name: 'Edit', state: 'done', summary: 'Edited src/auth/middleware.ts', input: 'file_path: src/auth/middleware.ts\n- if (token.exp < Date.now()) {\n-   return refresh(token);\n- }\n+ return refreshSession(req);' },
    { kind: 'tool', id: 't6', name: 'Bash', state: 'error', summary: 'Ran npm test -- auth', input: 'npm test -- auth', output: 'FAIL  test/auth.test.ts\n  ✕ keeps tokens issued before the change (14 ms)\n\n  Expected: 200\n  Received: 401' },
    { kind: 'assistant', id: 'a3', at: at(34), text: 'One test fails: old tokens carry `exp` in **seconds**, new ones in milliseconds. I’ll normalise it in `isExpired()`.' },
    { kind: 'tool', id: 't7', name: 'Edit', state: 'done', summary: 'Edited src/auth/token.ts', input: 'file_path: src/auth/token.ts\n- return token.exp < Date.now();\n+ const ms = token.exp < 1e12 ? token.exp * 1000 : token.exp;\n+ return ms < Date.now();' },
    { kind: 'tool', id: 't8', name: 'Bash', state: 'done', summary: 'Ran npm test -- auth', input: 'npm test -- auth', output: 'PASS  test/auth.test.ts (24 tests)' },
    { kind: 'assistant', id: 'a4', at: at(31), text: 'Done. The refresh lives in one helper now and `requireUser()` is unchanged.\n\nWhat changed:\n\n- `refreshSession()` in `src/auth/session.ts`, used by the middleware and the `/token` route\n- `isExpired()` accepts both seconds and milliseconds, so older tokens still work\n- the two old copies are gone\n\n```ts\nexport async function refreshSession(req: Request): Promise<Session> {\n  const token = readToken(req);\n  if (!isExpired(token)) return sessionFrom(token);\n  return rotate(token); // one source of truth\n}\n```' },
    { kind: 'notice', id: 'c1', notice: 'cost', text: 'This turn: $0.31', costUsd: 0.31 },
    { kind: 'prompt', id: 'p2', at: at(12), text: 'Nice. Can you also add a test for a revoked token?' },
  ];
  switch (state) {
    case 'working':
      items.push(
        { kind: 'assistant', id: 'a5', at: at(11), text: 'Adding a regression test for revoked tokens now.' },
        { kind: 'tool', id: 't9', name: 'Write', state: 'done', summary: 'Wrote test/revoked.test.ts', input: "test('rejects a revoked token', async () => { ... })" },
        { kind: 'tool', id: 't10', name: 'Bash', state: 'running', summary: 'Running npm test -- revoked', input: 'npm test -- revoked' },
      );
      if (frozen) items.push({ kind: 'assistant', id: 's-frozen', text: 'The new test passes against the helper. Next I’m checking that the `/token` route returns **401** for a revoked', streaming: true });
      break;
    case 'permission':
      items.push(
        { kind: 'assistant', id: 'a5', at: at(11), text: 'I’ve written the test. To be sure nothing else broke I want to run the whole suite against the test database.' },
        { kind: 'tool', id: 't9', name: 'Write', state: 'done', summary: 'Wrote test/revoked.test.ts', input: "test('rejects a revoked token', async () => { ... })" },
      );
      break;
    case 'plan':
      items.splice(2, 0, { kind: 'plan', id: 'plan-a', at: at(41), status: 'rejected', feedback: 'Don’t touch the admin cookie yet.', text: '## First pass\n\n1. Move refresh into the middleware\n2. Rename the admin cookie to match\n3. Delete the route copy' });
      items.push({ kind: 'plan', id: 'plan-b', at: at(1), status: 'pending', text: PLAN, planFilePath: '/home/dev/.claude/plans/session-refresh.md' });
      break;
    case 'question':
      items.push({ kind: 'assistant', id: 'a5', at: at(11), text: 'Before I write it: revoked tokens can be checked in two places, and they behave differently under load.' });
      break;
    case 'error':
      items.push(
        { kind: 'assistant', id: 'a5', at: at(11), text: 'Adding a regression test for revoked tokens now.' },
        { kind: 'tool', id: 't9', name: 'Bash', state: 'error', summary: 'Ran npm test -- revoked', input: 'npm test -- revoked', output: 'Error: connect ECONNREFUSED 127.0.0.1:5432' },
        { kind: 'notice', id: 'n-err', notice: 'error', text: 'The run stopped: API error (overloaded). Reply to pick it up again.' },
      );
      break;
    default:
      items.push(
        { kind: 'assistant', id: 'a5', at: at(11), text: 'Added `test/revoked.test.ts`. It revokes a token, then checks that both the middleware and `/token` answer **401**. All 25 auth tests pass.' },
        { kind: 'tool', id: 't9', name: 'Bash', state: 'done', summary: 'Ran npm test -- auth', input: 'npm test -- auth', output: 'PASS  test/auth.test.ts (25 tests)' },
        { kind: 'notice', id: 'c2', notice: 'cost', text: 'This turn: $0.11', costUsd: 0.11 },
      );
  }
  return items;
}

function pendingFor(s: State): PendingRequest | null {
  const common = { sessionId: SID, at: Date.now() - 20_000 };
  if (s === 'permission') {
    return {
      ...common, requestId: 'req-perm-1', kind: 'permission', toolName: 'Bash', summary: 'Run the whole test suite against the test database',
      fields: [
        { label: 'Command', value: 'DATABASE_URL=postgres://localhost/billing_test npm test', code: true },
        { label: 'Description', value: 'Run the whole test suite against the test database' },
      ],
      reason: 'This command connects to a database.', canAlwaysAllow: true, alwaysLabel: 'Always allow "npm test *" in this project',
    };
  }
  if (s === 'plan') return { ...common, requestId: 'req-plan-1', kind: 'plan', plan: PLAN, planFilePath: '/home/dev/.claude/plans/session-refresh.md' };
  if (s === 'question') {
    return {
      ...common, requestId: 'req-q-1', kind: 'question', questions: [
        {
          question: 'Where should a revoked token be caught?', header: 'Check', multiSelect: false, options: [
            { label: 'In the middleware', description: 'One check for every route; adds a cache lookup per request' },
            { label: 'In refreshSession()', description: 'Only on refresh; a revoked token works until it expires' },
            { label: 'Both', description: 'Safest, slightly slower' },
          ],
        },
        {
          question: 'Which cases should the test cover?', header: 'Tests', multiSelect: true, options: [
            { label: 'Revoked before expiry', description: 'The plain case' },
            { label: 'Revoked after a refresh', description: 'The rotated token must be rejected too' },
            { label: 'Admin cookie', description: 'Different cookie name', preview: 'Set-Cookie: adm_sess=…; HttpOnly' },
          ],
        },
      ],
    };
  }
  return null;
}

const SETTINGS: OfficeSettings = { companyName: 'Middle Management', branchName: 'Main Office', speechBubbles: true, managerName: 'Sam', bossQuotes: true };
const DEFAULTS: ClaudeDefaults = {
  model: 'opus', effort: 'high', effortByModel: { sonnet: 'high' },
  models: [
    { value: 'opus', label: 'Opus', resolved: 'claude-opus-4-1-20250805', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-4-5', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001', efforts: [] },
  ],
};
const USAGE = { at: Date.now(), plan: 'max', windows: [] } as unknown as UsageSnapshot;

// ---------------------------------------------------------------------------
// The mock host

const posted: WebviewToHost[] = [];
const send = (msg: HostToWebview, ms = 0): void => {
  if (ms > 0) window.setTimeout(() => window.postMessage(msg, '*'), ms);
  else window.postMessage(msg, '*');
};
const later = (fn: () => void, ms: number): void => { if (!frozen) window.setTimeout(fn, ms); };
let seq = 0;
let streamTimer = 0;
let opened = false;

function append(msg: Omit<Extract<HostToWebview, { type: 'caseAppend' }>, 'type' | 'agentId'>): void {
  send({ type: 'caseAppend', agentId: own, ...msg });
}

/** Streams an answer: an optional tool step, then the text in chunks, then the turn cost. */
function stream(text: string, tool?: { name: string; summary: string; done: string; output?: string }): void {
  window.clearInterval(streamTimer);
  const id = `s${++seq}`;
  busy = true;
  send({ type: 'agents', agents: snapshot() });
  append({ items: [], header: { busy: true, activity: 'thinking', status: 'working' } });
  const words = text.split(/(?<=\s)/);
  let i = 0;
  const go = (): void => {
    streamTimer = window.setInterval(() => {
      i = Math.min(words.length, i + 3);
      const done = i >= words.length;
      append({ items: [{ kind: 'assistant', id, text: words.slice(0, i).join(''), streaming: done ? undefined : true }] });
      if (done) {
        window.clearInterval(streamTimer);
        busy = false;
        append({ items: [{ kind: 'notice', id: `${id}:cost`, notice: 'cost', text: 'This turn: $0.03', costUsd: 0.03 }], header: { busy: false, activity: 'idle', status: 'idle' } });
        send({ type: 'agents', agents: snapshot() });
      }
    }, 110);
  };
  if (tool) {
    const tid = `${id}:tool`;
    append({ items: [{ kind: 'tool', id: tid, name: tool.name, state: 'running', summary: tool.summary }] });
    window.setTimeout(() => {
      append({ items: [{ kind: 'tool', id: tid, name: tool.name, state: 'done', summary: tool.done, output: tool.output }] });
      go();
    }, 700);
  } else go();
}

function openCase(): void {
  if (state === 'loaderror') {
    send({ type: 'error', agentId: own, message: 'This worker isn’t in the office any more, so there is no file to show.' }, lag);
    return;
  }
  if (state === 'gone' && opened) return;
  opened = true;
  pending = pendingFor(state);
  send({ type: 'caseFile', agentId: own, header: header(), items: conversation(), pending, truncated: false }, lag);
  send({ type: 'agents', agents: snapshot() }, lag + 1);
  if (stray) {
    // Meant for someone else: the tab must ignore both (no toast, no change).
    send({ type: 'caseAppend', agentId: OTHER, items: [{ kind: 'assistant', id: 'x1', text: 'This belongs to another worker.' }] }, lag + 40);
    send({ type: 'error', agentId: OTHER, message: 'Another worker’s error: you should never see this.' }, lag + 60);
  }
  if (state === 'error') send({ type: 'error', agentId: own, sessionId: SID, message: 'Couldn’t send your last reply: the session stopped. Reply again to pick it back up.' }, lag + 120);
  if (state === 'gone') {
    const leave = (): void => {
      gone = true;
      send({ type: 'agents', agents: snapshot() });
      send({ type: 'caseClosed', agentId: own, reason: 'agentGone' });
    };
    if (frozen) window.setTimeout(leave, lag + 80);
    else window.setTimeout(leave, lag + 1500);
  }
  if (state === 'working' && !frozen) {
    window.setTimeout(() => {
      append({ items: [{ kind: 'tool', id: 't10', name: 'Bash', state: 'done', summary: 'Ran npm test -- revoked', input: 'npm test -- revoked', output: 'PASS  test/revoked.test.ts (3 tests)' }] });
      stream('The new test passes against the helper. I also checked that the `/token` route answers **401** for a revoked token, so both paths are covered.');
    }, lag + 900);
  }
}

function handle(msg: WebviewToHost): void {
  switch (msg.type) {
    case 'ready':
      send({ type: 'agents', agents: snapshot() });
      send({ type: 'settings', settings: SETTINGS });
      send({ type: 'usage', usage: USAGE });
      send({ type: 'claudeDefaults', defaults: DEFAULTS });
      break;
    case 'openCase':
      if (msg.agentId === own) openCase();
      break;
    case 'reply':
      append({ items: [{ kind: 'prompt', id: `r${++seq}`, at: Date.now(), text: msg.text }] });
      later(() => stream('Got it. I’ll take that into account and keep the change small.', { name: 'Read', summary: 'Reading src/auth/session.ts', done: 'Read src/auth/session.ts' }), 300);
      break;
    case 'interrupt':
      window.clearInterval(streamTimer);
      busy = false;
      append({ items: [{ kind: 'notice', id: `int${++seq}`, notice: 'interrupted', text: 'Interrupted by you' }], header: { busy: false, activity: 'idle', status: 'idle' } });
      send({ type: 'agents', agents: snapshot() });
      break;
    case 'decide': {
      const p = pending;
      if (!p || p.requestId !== msg.requestId) { send({ type: 'error', requestId: msg.requestId, sessionId: SID, message: 'That request has already been answered.' }); break; }
      later(() => {
        pending = null;
        append({ items: p.kind === 'plan' ? [{ kind: 'plan', id: 'plan-b', status: msg.decision.kind === 'plan' && msg.decision.approve ? 'approved' : 'rejected', text: PLAN }] : [], pending: null, header: { activity: 'thinking', status: 'working' } });
        send({ type: 'agents', agents: snapshot() });
        const ok = msg.decision.kind !== 'deny';
        stream(ok ? 'Thanks. Carrying on with that.' : 'Understood, I won’t do that. I’ll find another way.',
          p.kind === 'permission' && ok ? { name: 'Bash', summary: 'Running npm test', done: 'Ran npm test', output: 'PASS  212 tests' } : undefined);
      }, 500);
      break;
    }
    case 'setSessionOptions': {
      Object.assign(opts, msg.options);
      const office = control === 'office';
      send({ type: 'sessionOptions', nonce: msg.nonce, sessionId: msg.sessionId, applied: office ? msg.options : {}, deferred: office ? {} : msg.options }, 400);
      window.setTimeout(() => append({ items: [], header: office ? { model: opts.model ?? undefined, effort: opts.effort ?? undefined, permissionMode: opts.permissionMode } : { next: { ...msg.options } } }), 420);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Boot element and the VS Code API

// look=<id> puts that look in the boot, as the office does (default: staff-3, a look the tab's own guess would not pick first).
const bootLook = new URLSearchParams(location.search).get('look') ?? 'staff-3';
const bootEl = document.createElement('script');
bootEl.type = 'application/json';
bootEl.id = CASE_TAB_BOOT_ELEMENT_ID;
bootEl.textContent = state === 'lost' ? '{"mode":"office"}' : JSON.stringify({ mode: 'case', agentId: own, ...(bootLook ? { look: bootLook } : {}) });
document.head.appendChild(bootEl);

(window as unknown as Record<string, unknown>)['acquireVsCodeApi'] = () => ({
  postMessage(msg: WebviewToHost) {
    posted.push(msg);
    if (msg && typeof msg === 'object') handle(msg);
  },
  getState: () => undefined,
  setState: () => undefined,
});
(window as unknown as Record<string, unknown>)['__caseTabPosted'] = posted;
