// Real end-to-end run of Manager Mode against a live Claude Code session (Haiku, scratch project, a few cents).
//
//   node dev/manager-e2e.ts [--root <scratch dir>] [--budget 0.5] [--round-a | --round-a-only]
//
// --probe-only runs just A6 and A7 (free). --with-plan adds A3, which costs about $0.15 because plan mode switches to Sonnet.
// --round-a runs the Round A scenarios (A1-A7: effort on newTask, mid-run model/effort/mode change, plan items, getTurn,
// cost across turns and a resume, one usage probe, log hygiene) after the Manager Mode ones; --round-a-only skips those.
// Round A runs in <root>/e2e-2.9 against Haiku, with a $0.10 default budget, and removes the ~/.claude/projects folder it
// created (only that one) at the end.
//
// Drives `createManagerHost` with the REAL dependencies (binary lookup, the SDK's query, the real conversation builder,
// readCaseFor, and a real ClaudeWatcher + AgentTracker inside the real OfficeFeed). Messages go through
// `parseWebviewMessage` exactly as the extension does. Only the VS Code adapters are fakes (post, dialog, command).
//
// Rules: permissionMode is 'default' (never bypassPermissions), model 'haiku', real runs stay in <root>/e2e-proj,
// ~/.claude/sessions/*.key is never opened, and no environment values are printed. The run stops if a session reports a
// model that is not Haiku or the summed cost passes the budget.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeWatcher } from '../src/claude/sessions.ts';
import { claudeHome, projectsDir } from '../src/claude/paths.ts';
import { AgentTracker } from '../src/model/agentState.ts';
import { OfficeFeed } from '../src/host/officeFeed.ts';
import { locateTranscript } from '../src/host/transcriptLocator.ts';
import { lastModelInTranscript, readTailText } from '../src/host/lastModel.ts';
import { checkClaudeVersions } from '../src/host/versionCheck.ts';
import { runUsageProbe, PROBE_ENTRYPOINT_TAG } from '../src/manager/usageProbe.ts';
import type { ProbeResult } from '../src/manager/usageProbe.ts';
import { createManagerHost, defaultQueryFn, findClaudeBinary, liveSessionIdsFromDisk, nodeFileExists, nodeIsExecutable } from '../src/manager/index.ts';
import type { ManagerHost, ManagerHostDeps } from '../src/manager/index.ts';
import { createSdkItemBuilder, itemsFromSdkMessage } from '../src/manager/conversation.ts';
import { readCaseFor } from '../src/manager/transcriptReader.ts';
import { parseWebviewMessage } from '../src/shared/validate.ts';
import type { AgentSnapshot, ConversationItem, HostToWebview, PendingRequest, SessionOptions, WebviewToHost } from '../src/shared/protocol.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Options

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const ROOT = opt('--root') ?? 'path.join(os.tmpdir(), 'middle-management-spike')';
const ROUND_A_ONLY = argv.includes('--round-a-only') || argv.includes('--probe-only');
const PROBE_ONLY = argv.includes('--probe-only'); // Round A: only A6 and A7 (no tokens are spent)
const WITH_PLAN = argv.includes('--with-plan'); // Round A: also A3. Plan mode runs on Sonnet even when Haiku is asked for (about $0.15)
let allowNonHaiku = false;
const ROUND_A = PROBE_ONLY || ROUND_A_ONLY || argv.includes('--round-a');
const PROJ = path.join(ROOT, ROUND_A_ONLY ? 'e2e-2.9' : 'e2e-proj');
const PROJ_A = path.join(ROOT, 'e2e-2.9');
const BUDGET = Number(opt('--budget') ?? (ROUND_A_ONLY ? '0.1' : '0.5'));
const MODEL = 'haiku';
const REPO_PROJECT_DIR = path.join(projectsDir(claudeHome()), '-home-user-project');

// A resumed session started through `reply` carries no model (only the memo sets one), so it would use the user's
// default model. Point the default at Haiku for this process; the runner passes process.env on to the child.
process.env['ANTHROPIC_MODEL'] = MODEL;

fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(PROJ_A, { recursive: true });
try {
  fs.rmSync(path.join(PROJ, 'made-by-office.txt'), { force: true });
} catch {
  // ignore
}

// ---------------------------------------------------------------------------------------------------------------------
// Recording

const t0 = Date.now();
const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const out = (line: string): void => console.log(`${stamp()}  ${line}`);
const short = (s: string | undefined, n = 40): string => (s === undefined ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sid8 = (s: string | undefined): string => (s === undefined ? '-' : s.slice(0, 8));

const posted: HostToWebview[] = [];
let latestAgents: AgentSnapshot[] = [];
let stopReason: string | undefined;
let totalCost = 0;
const seenModels = new Set<string>();

function itemLine(i: ConversationItem): string {
  switch (i.kind) {
    case 'prompt': return `prompt(${short(i.text, 28)})`;
    case 'assistant': return `assistant${i.streaming ? '~' : ''}(${i.text.length}ch)`;
    case 'tool': return `tool(${i.name}:${i.state})`;
    case 'thinking': return 'thinking';
    case 'plan': return `plan(${i.status},${i.text.length}ch)`;
    case 'notice': return `notice:${i.notice}${i.costUsd !== undefined ? `($${i.costUsd.toFixed(4)})` : i.notice === 'error' || i.notice === 'info' ? `(${short(i.text, 70)})` : ''}`;
  }
}

/** Everything the host, the feed and the probe logged (checked by A7; none of it may carry values). */
const hostLogs: string[] = [];
let stripOfficeEffort = false; // while set, the tracker sees no office effort, so its snapshots show what the transcript says

function pendingLine(p: PendingRequest | null | undefined): string {
  if (p === undefined) return '';
  if (p === null) return ' pending=cleared';
  return ` pending=${p.kind}${p.kind === 'permission' ? `:${p.toolName}` : ''}`;
}

/** One compact line per posted message. `agents` lines are only printed when a worker of ours changed. */
const lastAgentLine = new Map<string, string>();
function summarize(m: HostToWebview): string | undefined {
  switch (m.type) {
    case 'agents': {
      const lines: string[] = [];
      for (const a of m.agents) {
        if (a.kind !== 'main' || (a.cwd !== PROJ && !watching.has(a.sessionId ?? a.id))) continue;
        const line = `agent ${sid8(a.sessionId)} activity=${a.activity} control=${a.control ?? '-'}${a.pending ? ` pending=${a.pending.kind}` : ''}${a.costUsd !== undefined ? ` cost=$${a.costUsd.toFixed(4)}` : ''}`;
        if (lastAgentLine.get(a.id) !== line) {
          lastAgentLine.set(a.id, line);
          lines.push(`<- ${line}`);
        }
      }
      return lines.length ? lines.join('\n         ') : undefined;
    }
    case 'settings': return '<- settings';
    case 'projects': return `<- projects n=${m.projects.length} default=${path.basename(m.defaultPath ?? '-')} first=${path.basename(m.projects[0]?.path ?? '-')}`;
    case 'caseFile': return `<- caseFile agent=${sid8(m.agentId)} items=${m.items.length} control=${m.header.control} model=${m.header.model ?? '-'} busy=${m.header.busy}${pendingLine(m.pending)} truncated=${m.truncated}`;
    case 'caseAppend': {
      const h = m.header ? ` header{${Object.keys(m.header).map((k) => `${k}=${short(String((m.header as Record<string, unknown>)[k]), 20)}`).join(',')}}` : '';
      return `<- caseAppend agent=${sid8(m.agentId)} [${m.items.map(itemLine).join(', ')}]${pendingLine(m.pending)}${h}`;
    }
    case 'caseClosed': return `<- caseClosed ${sid8(m.agentId)} ${m.reason}`;
    case 'taskStarted': return `<- taskStarted nonce=${m.nonce} session=${sid8(m.sessionId)} agent=${sid8(m.agentId)}`;
    case 'error': return `<- error${m.nonce ? ` nonce=${m.nonce}` : ''}${m.sessionId ? ` session=${sid8(m.sessionId)}` : ''}${m.requestId ? ' requestId' : ''}: ${short(m.message, 110)}`;
    case 'openMemo': return '<- openMemo';
  }
}

const watching = new Set<string>();

/** Guards: stop on a non-Haiku model or a blown budget. */
function guard(m: HostToWebview): void {
  const model =
    m.type === 'caseFile' ? m.header.model : m.type === 'caseAppend' ? m.header?.model : undefined;
  if (model !== undefined) {
    seenModels.add(model);
    if (!allowNonHaiku && !/haiku/i.test(model)) stopReason ??= `a session reported model "${model}" (not Haiku)`;
  }
  if (m.type === 'caseAppend') {
    for (const i of m.items) if (i.kind === 'notice' && i.notice === 'cost' && i.costUsd !== undefined && !countedCost.has(i.id)) {
      countedCost.add(i.id);
      totalCost += i.costUsd;
    }
  }
  if (totalCost > BUDGET) stopReason ??= `cost $${totalCost.toFixed(3)} passed the budget $${BUDGET}`;
}
const countedCost = new Set<string>();

function onPost(m: HostToWebview): void {
  posted.push(m);
  if (m.type === 'agents') latestAgents = m.agents;
  guard(m);
  const line = summarize(m);
  if (line !== undefined) out(line);
  if (stopReason !== undefined && !stopping) {
    stopping = true;
    out(`STOP: ${stopReason}`);
    void emergencyStop();
  }
}
let stopping = false;

async function emergencyStop(): Promise<void> {
  try {
    await cur?.dispose();
  } catch {
    // ignore
  }
  feed.dispose();
  console.log(`removed project folders: ${cleanupCreatedProjects().join(', ') || '(none)'}`);
  console.log(`\nSTOPPED EARLY: ${stopReason}. Total cost so far: $${totalCost.toFixed(4)}`);
  process.exit(3);
}

// ---------------------------------------------------------------------------------------------------------------------
// Real dependencies

function claudeCodeExtensionPaths(): string[] {
  const found: string[] = [];
  for (const d of ['.vscode', '.vscode-oss', '.vscode-insiders']) {
    const root = path.join(os.homedir(), d, 'extensions');
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names.sort().reverse()) if (n.toLowerCase().startsWith('anthropic.claude-code-')) found.push(path.join(root, n));
  }
  return found;
}

let queryCalls = 0;
/** Total cost the SDK reported in its result messages, per session (latest wins), and every result seen. */
const sdkTotals = new Map<string, number>();
const sdkResults: Array<{ sid: string; total: number }> = [];
const countingQuery: ManagerHostDeps['queryFn'] = (params) => {
  queryCalls++;
  // No MCP servers from the user's own config: keeps the live turns tiny and cheap.
  const q = defaultQueryFn({ ...params, options: { ...(params.options ?? {}), strictMcpConfig: true, mcpServers: {} } });
  return {
    ...q,
    async *[Symbol.asyncIterator]() {
      for await (const m of q as AsyncIterable<unknown>) {
        const r = m as { type?: string; session_id?: string; total_cost_usd?: number };
        if (r.type === 'result' && typeof r.session_id === 'string' && typeof r.total_cost_usd === 'number') {
          sdkTotals.set(r.session_id, r.total_cost_usd);
          sdkResults.push({ sid: r.session_id, total: r.total_cost_usd });
        }
        yield m as never;
      }
    },
  } as ReturnType<ManagerHostDeps['queryFn']>;
};

const executed: Array<{ id: string; args: unknown[] }> = [];

let cur: ManagerHost | undefined;
let theTracker: AgentTracker | undefined;

const feed: OfficeFeed = new OfficeFeed({
  createWatcher: (scope) => new ClaudeWatcher({ claudeHome: claudeHome(), scope }),
  createTracker: () => {
    theTracker = new AgentTracker({
      officeInfo: (sid) => {
        const info = cur?.getOfficeInfo(sid);
        if (info === undefined || !stripOfficeEffort) return info;
        const { effort: _effort, ...rest } = info;
        return rest;
      },
      controlOf: (a) => cur?.controlFor(a) ?? 'free',
    });
    return theTracker;
  },
  publish: (msg) => {
    onPost(msg);
    if (msg.type === 'agents') cur?.onAgents(msg.agents);
  },
  now: () => Date.now(),
  timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  log: (m) => {
    hostLogs.push(m);
    out(`feed log: ${short(m, 100)}`);
  },
});

function makeHost(): ManagerHost {
  return createManagerHost({
    post: onPost,
    queryFn: countingQuery,
    findBinary: () =>
      findClaudeBinary({
        settingPath: '',
        claudeCodeExtensionPaths: claudeCodeExtensionPaths(),
        homedir: os.homedir(),
        platform: process.platform,
        PATH: process.env['PATH'],
        exists: nodeFileExists,
        isExecutable: nodeIsExecutable,
      }),
    readCase: (agent) => readCaseFor(agent, (a) => locateTranscript(feed.latestSessions(), a)),
    createSdkItemBuilder,
    itemsFromSdkMessage: (msg, builder) => itemsFromSdkMessage(msg, builder as ReturnType<typeof createSdkItemBuilder>),
    // As the extension's adapters do: resume on the model a session last used, and seed the cost baseline from its history.
    lastModelFor: async (sessionId) => {
      const file = locateTranscript(feed.latestSessions(), { id: sessionId, kind: 'main', sessionId });
      return file === undefined ? undefined : lastModelInTranscript(await readTailText(file, 256 * 1024));
    },
    readTranscriptTail: async (sessionId) => {
      const file = locateTranscript(feed.latestSessions(), { id: sessionId, kind: 'main', sessionId });
      return file === undefined ? undefined : readTailText(file, 256 * 1024);
    },
    listLiveSessionIds: () => liveSessionIdsFromDisk(),
    workspaceFolders: () => [PROJ],
    showOpenDialog: async () => undefined,
    executeCommand: async (id, ...args) => {
      executed.push({ id, args });
      return undefined;
    },
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    refreshAgents: () => feed.refreshNow(),
    planText: (agentId, planId) => theTracker?.planText(agentId, planId),
    log: (m) => {
      hostLogs.push(m);
      out(`host log: ${short(m, 110)}`);
    },
  });
}

/** Send a message exactly as the extension would: validate, then hand to the host. */
async function send(raw: WebviewToHost): Promise<void> {
  const msg = parseWebviewMessage(JSON.parse(JSON.stringify(raw)));
  if (!msg) throw new Error(`parseWebviewMessage rejected ${raw.type}`);
  const brief = raw.type === 'newTask' ? ` nonce=${raw.nonce} model=${raw.model} mode=${raw.permissionMode}` : raw.type === 'reply' ? ` "${short(raw.text, 50)}"` : raw.type === 'decide' ? ` ${raw.decision.kind}` : '';
  out(`-> ${raw.type}${brief}`);
  await cur!.handle(msg);
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting helpers

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, pick: () => T | undefined | false, timeoutMs = 90000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pick();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(100);
  }
}

/** First posted message at or after `from` that `pick` accepts. */
function find<T>(from: number, pick: (m: HostToWebview) => T | undefined | false): () => T | undefined {
  return () => {
    for (let i = from; i < posted.length; i++) {
      const v = pick(posted[i]!);
      if (v !== undefined && v !== false) return v;
    }
    return undefined;
  };
}

const agentOf = (sid: string): AgentSnapshot | undefined => latestAgents.find((a) => a.kind === 'main' && (a.sessionId === sid || a.id === sid));

const itemsAfter = (from: number, agentId: string): ConversationItem[] =>
  posted.slice(from).flatMap((m) => (m.type === 'caseAppend' && m.agentId === agentId ? m.items : m.type === 'caseFile' && m.agentId === agentId ? m.items : []));

const assistantTextAfter = (from: number, agentId: string): string =>
  itemsAfter(from, agentId)
    .filter((i): i is Extract<ConversationItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.streaming !== true)
    .map((i) => i.text)
    .join('\n');

/** The final text of an assistant item that is no longer streaming, keyed by id (later versions replace earlier). */
function finalAssistant(from: number, agentId: string, re: RegExp): boolean {
  const byId = new Map<string, ConversationItem>();
  for (const i of itemsAfter(from, agentId)) byId.set(i.id, i);
  return [...byId.values()].some((i) => i.kind === 'assistant' && i.streaming !== true && re.test(i.text));
}

const costNoticeAfter = (from: number, agentId: string): boolean => itemsAfter(from, agentId).some((i) => i.kind === 'notice' && i.notice === 'cost');

function idleAfter(from: number, agentId: string): boolean {
  let busy: boolean | undefined;
  for (let i = from; i < posted.length; i++) {
    const m = posted[i]!;
    if (m.type === 'caseAppend' && m.agentId === agentId && m.header?.busy !== undefined) busy = m.header.busy;
  }
  return busy === false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios

interface Result { n: number | string; name: string; pass: boolean; notes: string[] }
const results: Result[] = [];
const state: { sid?: string; agentId?: string; fileOk?: boolean } = {};

async function scenario(n: number | string, name: string, fn: (notes: string[]) => Promise<void>): Promise<void> {
  const notes: string[] = [];
  out(`=== Scenario ${n}: ${name}`);
  try {
    await fn(notes);
    results.push({ n, name, pass: true, notes });
    out(`PASS ${n}`);
  } catch (e) {
    notes.push(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ n, name, pass: false, notes });
    out(`FAIL ${n}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function legacyScenarios(): Promise<void> {
  // ---- 1 --------------------------------------------------------------------------------------------------------
  await scenario(1, 'New hire and approval', async (notes) => {
    let from = posted.length;
    await send({ type: 'listProjects' });
    const projects = await waitFor('projects', find(from, (m) => (m.type === 'projects' ? m : undefined)), 10000);
    assert(projects.projects.some((p) => p.path === PROJ && p.exists), 'scratch project missing from the project list');
    notes.push(`projects: ${projects.projects.length}, scratch listed first=${projects.projects[0]?.path === PROJ}`);

    from = posted.length;
    await send({
      type: 'newTask',
      nonce: 'n1',
      projectPath: PROJ,
      prompt: "Create a file called made-by-office.txt containing 'hello from the office' using Bash echo with redirection, then reply DONE.",
      assignTo: { kind: 'new' },
      permissionMode: 'default',
      model: MODEL,
    });
    const started = await waitFor('taskStarted', find(from, (m) => (m.type === 'taskStarted' && m.nonce === 'n1' ? m : undefined)), 60000);
    state.sid = started.sessionId;
    state.agentId = started.agentId;
    watching.add(started.sessionId);
    notes.push(`taskStarted after ${((Date.now() - t0) / 1000).toFixed(1)}s, agentId==sessionId: ${started.agentId === started.sessionId}`);

    // The webview now opens the case.
    from = posted.length;
    await send({ type: 'openCase', agentId: started.agentId });
    await waitFor('caseFile', find(from, (m) => (m.type === 'caseFile' && m.agentId === started.agentId ? m : undefined)), 20000);

    const pendingMsg = await waitFor(
      'permission pending',
      find(from, (m) => {
        if (m.type === 'caseAppend' && m.pending && m.pending.kind === 'permission') return { how: 'caseAppend', p: m.pending };
        if (m.type === 'caseFile' && m.pending && m.pending.kind === 'permission') return { how: 'caseFile', p: m.pending };
        return undefined;
      }),
      90000,
    );
    assert(pendingMsg.p.kind === 'permission' && pendingMsg.p.toolName === 'Bash', `expected a Bash permission, got ${pendingMsg.p.kind}`);
    notes.push(`permission pending arrived via ${pendingMsg.how}: Bash, summary="${short(pendingMsg.p.kind === 'permission' ? pendingMsg.p.summary : '', 60)}", canAlwaysAllow=${pendingMsg.p.kind === 'permission' ? pendingMsg.p.canAlwaysAllow : '-'}`);

    const knock = await waitFor('snapshot needsYou', () => {
      const a = agentOf(started.sessionId);
      return a && a.activity === 'needsYou' && a.pending?.kind === 'permission' && a.control === 'office' ? a : undefined;
    }, 15000);
    notes.push(`tracker snapshot: activity=${knock.activity} control=${knock.control} pending=${knock.pending?.kind}`);

    from = posted.length;
    await send({ type: 'decide', requestId: pendingMsg.p.requestId, decision: { kind: 'allow' } });
    await waitFor('file created', () => {
      try {
        return fs.readFileSync(path.join(PROJ, 'made-by-office.txt'), 'utf8').includes('hello from the office') || undefined;
      } catch {
        return undefined;
      }
    }, 60000);
    state.fileOk = true;
    notes.push('made-by-office.txt exists with the expected text');
    await waitFor('final assistant DONE', () => finalAssistant(from, started.agentId, /DONE/i) || undefined, 90000);
    await waitFor('cost notice', () => costNoticeAfter(from, started.agentId) || undefined, 30000);
    await waitFor('idle', () => idleAfter(from, started.agentId) || undefined, 30000);
    await waitFor('pending cleared in snapshot', () => {
      const a = agentOf(started.sessionId);
      return a && a.pending === undefined && a.activity !== 'needsYou' ? a : undefined;
    }, 15000);
    const a = agentOf(started.sessionId)!;
    notes.push(`final: cost notice seen, snapshot activity=${a.activity}, costUsd=${a.costUsd?.toFixed(4)}`);
  });
  assert(state.sid, 'scenario 1 did not produce a session; stopping');
  const sid = state.sid!;
  const agentId = state.agentId!;

  // ---- 2 --------------------------------------------------------------------------------------------------------
  await scenario(2, 'Question (AskUserQuestion)', async (notes) => {
    const from = posted.length;
    await send({ type: 'reply', sessionId: sid, text: 'Use the AskUserQuestion tool to ask me whether to say Hi or Hello, then say it.' });
    const q = await waitFor('question pending', find(from, (m) => (m.type === 'caseAppend' && m.pending?.kind === 'question' ? m.pending : undefined)), 90000);
    assert(q.kind === 'question', 'not a question');
    const spec = q.questions[0]!;
    const pick = spec.options.find((o) => /hello/i.test(o.label)) ?? spec.options[0]!;
    notes.push(`question "${short(spec.question, 50)}" options=[${spec.options.map((o) => o.label).join(' | ')}] picking "${pick.label}"`);
    await waitFor('snapshot pending question', () => agentOf(sid)?.pending?.kind === 'question' || undefined, 15000);
    const mark = posted.length;
    await send({ type: 'decide', requestId: q.requestId, decision: { kind: 'answer', answers: { [spec.question]: pick.label } } });
    const re = new RegExp(pick.label.replace(/[^A-Za-z0-9 ]/g, '.'), 'i');
    await waitFor('reply mentions the choice', () => finalAssistant(mark, agentId, re) || undefined, 90000);
    await waitFor('idle', () => idleAfter(from, agentId) || undefined, 30000);
    notes.push(`final assistant text mentions "${pick.label}"`);
  });

  // ---- 3 --------------------------------------------------------------------------------------------------------
  await scenario(3, 'Interrupt', async (notes) => {
    const from = posted.length;
    // The redirect makes Claude Code ask first (a plain read-only loop may run without asking on some setups).
    await send({ type: 'reply', sessionId: sid, text: 'Use the Bash tool to run exactly this command and nothing else: for i in $(seq 1 20); do sleep 1; done > loop-done.txt; echo finished-loop' });
    const first = await waitFor(
      'Bash permission or a running Bash tool',
      find(from, (m) => {
        if (m.type === 'caseAppend' && m.pending?.kind === 'permission') return { ask: m.pending };
        if (m.type === 'caseAppend' && m.items.some((i) => i.kind === 'tool' && i.name === 'Bash' && i.state === 'running')) return { ask: undefined };
        return undefined;
      }),
      90000,
    );
    if (first.ask) {
      notes.push('Bash asked for permission; allowed');
      await send({ type: 'decide', requestId: first.ask.requestId, decision: { kind: 'allow' } });
      await waitFor('tool running', () => itemsAfter(from, agentId).some((i) => i.kind === 'tool' && i.name === 'Bash' && i.state === 'running') || undefined, 20000);
    } else {
      notes.push('Bash ran without asking (allowed by the user\'s own rules)');
    }
    await sleep(3000);
    const mark = posted.length;
    const tInt = Date.now();
    await send({ type: 'interrupt', sessionId: sid });
    await waitFor('interrupted notice', () => itemsAfter(mark, agentId).some((i) => i.kind === 'notice' && i.notice === 'interrupted') || undefined, 30000);
    notes.push(`interrupted notice after ${((Date.now() - tInt) / 1000).toFixed(1)}s (the loop would take 20 s)`);
    await waitFor('idle after interrupt', () => idleAfter(mark, agentId) || undefined, 30000);
    assert(!itemsAfter(mark, agentId).some((i) => i.kind === 'notice' && i.notice === 'error'), 'an interrupt must not leave a red error notice');
    assert(!itemsAfter(from, agentId).some((i) => i.kind === 'tool' && /finished-loop/.test(i.output ?? '')), 'the loop ran to the end');
    // The session can still take a reply.
    const mark2 = posted.length;
    await send({ type: 'reply', sessionId: sid, text: 'Reply with just the word PONG.' });
    await waitFor('PONG', () => finalAssistant(mark2, agentId, /PONG/i) || undefined, 90000);
    await waitFor('idle again', () => idleAfter(mark2, agentId) || undefined, 30000);
    notes.push('a reply after the interrupt was answered (PONG)');
  });

  // ---- 4 --------------------------------------------------------------------------------------------------------
  await scenario(4, 'Free resume', async (notes) => {
    const before = latestAgents.filter((a) => a.kind === 'main' && a.cwd === PROJ).length;
    await cur!.dispose(); // stops the runner (interrupt + close) and denies anything pending
    out('host disposed; waiting for control to become free');
    const t = Date.now();
    cur = makeHost(); // a fresh host: the extension would still have its one, but this one has no run
    cur.onAgents(latestAgents);
    const free = await waitFor('control free', () => {
      feed.refreshNow();
      const a = agentOf(sid);
      return a && a.control === 'free' ? a : undefined;
    }, 30000);
    notes.push(`control became free ${((Date.now() - t) / 1000).toFixed(1)}s after the runner stopped (cwd ${free.cwd === PROJ ? 'ok' : free.cwd})`);

    const from = posted.length;
    const calls = queryCalls;
    await send({ type: 'openCase', agentId });
    await waitFor('caseFile (transcript)', find(from, (m) => (m.type === 'caseFile' && m.agentId === agentId ? m : undefined)), 20000);
    await send({ type: 'reply', sessionId: sid, text: 'What file did you create?' });
    assert(queryCalls === calls + 1, 'a runner should have been started for the resume');
    await waitFor('answer names the file', () => finalAssistant(from, agentId, /made-by-office/i) || undefined, 90000);
    await waitFor('idle', () => idleAfter(from, agentId) || undefined, 30000);
    const a = agentOf(sid);
    assert(a && a.control === 'office', `control after resume should be office, was ${a?.control}`);
    const after = latestAgents.filter((x) => x.kind === 'main' && x.cwd === PROJ).length;
    assert(after === before, `a second character appeared (${before} -> ${after})`);
    notes.push(`resumed in the same session (${sid8(sid)}), control=office, characters in the scratch project: ${after}`);
  });

  // ---- 5 --------------------------------------------------------------------------------------------------------
  await scenario(5, 'Case file for a non-office session', async (notes) => {
    const live = liveSessionIdsFromDisk();
    const files = fs
      .readdirSync(REPO_PROJECT_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.slice(0, -'.jsonl'.length), mtime: fs.statSync(path.join(REPO_PROJECT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    assert(files.length > 0, 'no sessions under the repo project folder');
    const newest = files[0]!;
    const target = live.has(newest.id) ? newest : files.find((f) => live.has(f.id));
    assert(target, 'no live session found for this repo');
    notes.push(`newest session ${sid8(newest.id)} is ${live.has(newest.id) ? 'live' : 'not live'}; using ${sid8(target.id)}`);
    watching.add(target.id);
    await waitFor('target in the roster', () => agentOf(target.id) || undefined, 30000);
    const a = agentOf(target.id)!;
    assert(a.control === 'elsewhere', `expected control elsewhere, got ${a.control}`);
    const from = posted.length;
    const calls = queryCalls;
    await send({ type: 'openCase', agentId: a.id });
    const cf = await waitFor('caseFile', find(from, (m) => (m.type === 'caseFile' && m.agentId === a.id ? m : undefined)), 30000);
    assert(cf.items.length > 0, 'caseFile has no items');
    assert(cf.header.control === 'elsewhere', 'header control should be elsewhere');
    notes.push(`caseFile: ${cf.items.length} items, truncated=${cf.truncated}, header.control=${cf.header.control}`);
    const mark = posted.length;
    await send({ type: 'reply', sessionId: target.id, text: 'hello' });
    const err = await waitFor('error for the reply', find(mark, (m) => (m.type === 'error' ? m : undefined)), 10000);
    assert(err.sessionId === target.id, 'error should carry the sessionId');
    assert(queryCalls === calls, 'no runner may be started for an elsewhere session');
    assert(cur!.getOfficeInfo(target.id) === undefined, 'no office info expected');
    notes.push(`reply refused with: "${short(err.message, 90)}"; no runner started (query calls unchanged)`);
    await send({ type: 'closeCase' });
  });

  // ---- 6 --------------------------------------------------------------------------------------------------------
  await scenario(6, 'Open in Claude Code', async (notes) => {
    executed.length = 0;
    await send({ type: 'openInClaudeCode', sessionId: sid });
    assert(executed.length === 1 && executed[0]!.id === 'claude-vscode.editor.open' && executed[0]!.args[0] === sid, `unexpected commands: ${JSON.stringify(executed)}`);
    notes.push(`executeCommand('claude-vscode.editor.open', <sessionId>) called once`);
  });

}

// ---------------------------------------------------------------------------------------------------------------------
// Round A (task 2.9): effort, mid-run options, plan items, getTurn, cost, the usage probe and log hygiene

const SESSIONS_DIR = path.join(claudeHome(), 'sessions');
const PROJECTS = projectsDir(claudeHome());
/** Strings planted in prompts; none of them may ever appear in a log line (A7). */
const PLANTED = ['ZEBRAQUILL1', 'ZEBRAQUILL2', 'ZEBRAQUILL3', 'ZEBRAQUILL4', 'ZEBRAQUILL5', 'ZEBRAQUILL6'];

function transcriptFile(sid: string): string | undefined {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(PROJECTS);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** Real assistant records of a transcript, in order: the model and the top-level `effort` (no content is read out). */
function assistantRecs(sid: string): Array<{ model?: string; effort?: string }> {
  const f = transcriptFile(sid);
  if (f === undefined) return [];
  const recs: Array<{ model?: string; effort?: string }> = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const r = JSON.parse(line) as { type?: string; effort?: unknown; message?: { model?: unknown } };
      if (r.type !== 'assistant') continue;
      const model = typeof r.message?.model === 'string' ? r.message.model : undefined;
      if (model === '<synthetic>') continue;
      const rec: { model?: string; effort?: string } = {};
      if (model !== undefined) rec.model = model;
      if (typeof r.effort === 'string') rec.effort = r.effort;
      recs.push(rec);
    } catch {
      // partial line
    }
  }
  return recs;
}

/** Re-open the case and return the fresh header (what the case-file page shows). */
async function headerNow(agentId: string): Promise<Extract<HostToWebview, { type: 'caseFile' }>['header']> {
  const from = posted.length;
  await send({ type: 'openCase', agentId });
  const cf = await waitFor('caseFile', find(from, (m) => (m.type === 'caseFile' && m.agentId === agentId ? m : undefined)), 20000);
  return cf.header;
}

let reqCounter = 0;
/** One reply and wait for the turn to end (cost notice and idle header). Returns the index to look from. */
async function turn(sid: string, agentId: string, text: string): Promise<number> {
  const from = posted.length;
  await send({ type: 'reply', sessionId: sid, text });
  await waitFor('cost notice', () => costNoticeAfter(from, agentId) || undefined, 90000);
  await waitFor('idle', () => idleAfter(from, agentId) || undefined, 30000);
  return from;
}

/** Cost notices of one agent that arrived live (caseAppend), deduplicated by item id. */
function liveNoticeCosts(agentId: string): number[] {
  const byId = new Map<string, number>();
  for (const m of posted) {
    if (m.type !== 'caseAppend' || m.agentId !== agentId) continue;
    for (const i of m.items) if (i.kind === 'notice' && i.notice === 'cost' && i.costUsd !== undefined) byId.set(i.id, i.costUsd);
  }
  return [...byId.values()];
}

async function sendOptions(sid: string, options: SessionOptions) {
  const nonce = `opt${++reqCounter}`;
  const from = posted.length;
  await send({ type: 'setSessionOptions', nonce, sessionId: sid, options });
  return waitFor(
    'sessionOptions reply',
    find(from, (m) => {
      if (m.type === 'sessionOptions' && m.nonce === nonce) return { ok: true as const, applied: m.applied, deferred: m.deferred };
      if (m.type === 'error' && m.nonce === nonce) return { ok: false as const, message: m.message };
      return undefined;
    }),
    30000,
  );
}

function findBinaryNow() {
  return findClaudeBinary({
    settingPath: '',
    claudeCodeExtensionPaths: claudeCodeExtensionPaths(),
    homedir: os.homedir(),
    platform: process.platform,
    PATH: process.env['PATH'],
    exists: nodeFileExists,
    isExecutable: nodeIsExecutable,
  });
}

/** Same as `probeNow` in src/host/managerAdapters.ts (which imports vscode and so cannot load here). */
async function probeNowLike(log: (m: string) => void): Promise<ProbeResult> {
  const found = findBinaryNow();
  if ('error' in found) return { status: 'failed', reason: 'Claude Code not found' };
  return runUsageProbe({ queryFn: defaultQueryFn, binaryPath: found.path, env: process.env, log });
}

function probeSessionFiles(): Array<{ name: string; sessionId?: string }> {
  const out: Array<{ name: string; sessionId?: string }> = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue; // only <pid>.json; never the .key files
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8')) as { entrypoint?: unknown; sessionId?: unknown };
      if (raw.entrypoint === PROBE_ENTRYPOINT_TAG) out.push(typeof raw.sessionId === 'string' ? { name, sessionId: raw.sessionId } : { name });
    } catch {
      // half-written or vanished
    }
  }
  return out;
}

const A_STATE: { sid?: string; agentId?: string; planSid?: string; planAgentId?: string } = {};
const projectDirsBefore = new Set<string>(fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []);

const roundASessions: string[] = [];

/** Remove the ~/.claude/projects folder(s) this run created for the Round A scratch project, and nothing else. */
function cleanupCreatedProjects(): string[] {
  const removed: string[] = [];
  if (!ROUND_A || !fs.existsSync(PROJECTS)) return removed;
  for (const d of fs.readdirSync(PROJECTS)) {
    if (projectDirsBefore.has(d)) continue; // existed before this run: not ours
    if (!/^-tmp-claude-1000-.*e2e-2-9$/.test(d)) continue;
    const dir = path.join(PROJECTS, d);
    const files = fs.readdirSync(dir);
    // Ours only if every file in it is a transcript of a session this run started.
    if (files.length === 0 || !files.every((f) => roundASessions.some((s) => f === `${s}.jsonl`))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

async function roundA(): Promise<void> {
  out('##### Round A');
  const A = A_STATE;
  const sessionIds = roundASessions;
  const costFromTurns = (agentId: string): number => liveNoticeCosts(agentId).reduce((a, b) => a + b, 0);

  if (!PROBE_ONLY) {
    // ---- A1 -------------------------------------------------------------------------------------------------------
    await scenario('A1', 'Effort on newTask reaches the transcript and the tracker', async (notes) => {
      stripOfficeEffort = true; // the tracker must read the effort from the transcript, not from the office run
      const from = posted.length;
      await send({
        type: 'newTask',
        nonce: 'a1',
        projectPath: PROJ_A,
        prompt: 'Reply with one word, nothing else. ZEBRAQUILL1',
        assignTo: { kind: 'new' },
        permissionMode: 'default',
        model: MODEL,
        effort: 'low',
      });
      const started = await waitFor('taskStarted', find(from, (m) => (m.type === 'taskStarted' && m.nonce === 'a1' ? m : undefined)), 60000);
      A.sid = started.sessionId;
      A.agentId = started.agentId;
      sessionIds.push(started.sessionId);
      watching.add(started.sessionId);
      const h0 = await headerNow(started.agentId);
      notes.push(`header right after hire: effort=${h0.effort ?? '-'} canSetOptions=${h0.canSetOptions}`);
      assert(h0.effort === 'low', `header effort should be low, was ${h0.effort}`);
      await waitFor('cost notice', () => costNoticeAfter(from, started.agentId) || undefined, 90000);
      await waitFor('idle', () => idleAfter(from, started.agentId) || undefined, 30000);
      const recs = assistantRecs(started.sessionId);
      assert(recs.length > 0, 'no assistant records in the transcript');
      notes.push(`transcript assistant records: ${recs.length}, efforts=[${[...new Set(recs.map((r) => r.effort ?? 'none'))].join(',')}], models=[${[...new Set(recs.map((r) => r.model))].join(',')}]`);
      assert(recs.every((r) => r.effort === 'low'), 'every assistant record should carry effort low');
      const snap = await waitFor('tracker effort', () => {
        feed.refreshNow();
        const a = agentOf(started.sessionId);
        return a?.effort === 'low' ? a : undefined;
      }, 20000);
      notes.push(`AgentTracker snapshot (office effort hidden): effort=${snap.effort} model=${snap.model ?? '-'}`);
    });
    assert(A.sid, 'A1 did not produce a session; Round A stops');
    const sid = A.sid!;
    const agentId = A.agentId!;

    // ---- A2 -------------------------------------------------------------------------------------------------------
    await scenario('A2', 'Mid-run effort, model and mode change shows in the next turn', async (notes) => {
      const before = assistantRecs(sid);
      const firstModel = before[before.length - 1]!.model!;
      // effort only
      const r1 = await sendOptions(sid, { effort: 'high' });
      assert(r1.ok, `effort change failed: ${'message' in r1 ? r1.message : ''}`);
      notes.push(`setSessionOptions {effort:high} -> applied=${JSON.stringify(r1.applied)} deferred=${JSON.stringify(r1.deferred)}`);
      assert(r1.applied.effort === 'high' || r1.deferred.effort === 'high', 'effort high is in neither applied nor deferred');
      const h1 = await headerNow(agentId);
      notes.push(`header after the change: effort=${h1.effort ?? '-'}`);
      await turn(sid, agentId, 'Reply with one word, nothing else. ZEBRAQUILL2');
      const after1 = assistantRecs(sid).slice(before.length);
      assert(after1.length > 0, 'no new assistant records after turn 2');
      notes.push(`turn 2 records: efforts=[${[...new Set(after1.map((r) => r.effort ?? 'none'))].join(',')}] models=[${[...new Set(after1.map((r) => r.model))].join(',')}]`);
      assert(after1.every((r) => r.effort === 'high'), 'turn 2 records should carry effort high');
      assert(after1.every((r) => r.model === firstModel), 'the model must not change on an effort-only change');
      await waitFor('tracker effort high', () => { feed.refreshNow(); return agentOf(sid)?.effort === 'high' || undefined; }, 20000);
      notes.push('tracker snapshot effort=high');
      // model + permission mode (+ reset effort, since the older Haiku has no effort levels)
      const r2 = await sendOptions(sid, { model: 'claude-haiku-4-5-20251001', permissionMode: 'acceptEdits', effort: null });
      assert(r2.ok, `model change failed: ${'message' in r2 ? r2.message : ''}`);
      notes.push(`setSessionOptions {model,permissionMode,effort:null} -> applied=${JSON.stringify(r2.applied)} deferred=${JSON.stringify(r2.deferred)}`);
      assert(r2.applied.model !== undefined || r2.deferred.model !== undefined, 'model is in neither applied nor deferred');
      const h2 = await headerNow(agentId);
      notes.push(`header after the change: model=${h2.model ?? '-'} mode=${h2.permissionMode ?? '-'} effort=${h2.effort ?? '-'}`);
      assert(h2.permissionMode === 'acceptEdits', `header permissionMode should be acceptEdits, was ${h2.permissionMode}`);
      const n2 = assistantRecs(sid).length;
      await turn(sid, agentId, 'Reply with one word, nothing else. ZEBRAQUILL3');
      const after2 = assistantRecs(sid).slice(n2);
      assert(after2.length > 0, 'no new assistant records after turn 3');
      notes.push(`turn 3 records: models=[${[...new Set(after2.map((r) => r.model))].join(',')}] efforts=[${[...new Set(after2.map((r) => r.effort ?? 'none'))].join(',')}]`);
      assert(after2.every((r) => /haiku-4-5/.test(r.model ?? '')), 'turn 3 should run on claude-haiku-4-5');
      assert(after2.every((r) => r.model !== firstModel), 'the model should differ from the one before the change');
      const h3 = await headerNow(agentId);
      notes.push(`header after turn 3: model=${h3.model ?? '-'} mode=${h3.permissionMode ?? '-'} effort=${h3.effort ?? '-'}`);
      assert(/haiku-4-5/.test(h3.model ?? ''), `header model should be haiku-4-5, was ${h3.model}`);
      assert(h3.permissionMode === 'acceptEdits', 'header permissionMode should stay acceptEdits');
    });

    // ---- A4 -------------------------------------------------------------------------------------------------------
    await scenario('A4', 'getTurn returns the latest finished turn', async (notes) => {
      const reqId = `t${++reqCounter}`;
      const from = posted.length;
      await send({ type: 'getTurn', reqId, agentId });
      const t = await waitFor('turn reply', find(from, (m) => (m.type === 'turn' && m.reqId === reqId ? m : m.type === 'error' && m.reqId === reqId ? m : undefined)), 20000);
      assert(t.type === 'turn', `getTurn failed: ${t.type === 'error' ? t.message : ''}`);
      notes.push(`turn items: [${t.items.map(itemLine).join(', ')}] truncated=${t.truncated}`);
      assert(t.items.length > 0 && t.items.some((i) => i.kind === 'assistant'), 'the turn should hold an assistant item');
      assert(!t.items.some((i) => i.kind === 'prompt'), 'the prompt must not be part of the turn');
      assert(t.truncated === false, 'a one-word turn is not truncated');
    });

    // ---- A5 -------------------------------------------------------------------------------------------------------
    await scenario('A5', 'Cost: no double count across turns and a resume', async (notes) => {
      const total1 = sdkTotals.get(sid);
      assert(total1 !== undefined && total1 > 0, 'the SDK reported no total');
      const info1 = cur!.getOfficeInfo(sid);
      notes.push(`before resume: SDK total $${total1.toFixed(5)}, office $${info1?.costUsd?.toFixed(5)}, turn notices sum $${costFromTurns(agentId).toFixed(5)} over ${liveNoticeCosts(agentId).length} notices`);
      assert(info1?.costUsd !== undefined && Math.abs(info1.costUsd - total1) < 1e-9, 'office cost differs from the SDK total (3 turns)');
      assert(Math.abs(costFromTurns(agentId) - total1) < 1e-6, 'the turn costs do not add up to the SDK total');
      assert(liveNoticeCosts(agentId).every((c) => c > 0), 'a turn cost notice was zero');
      assert(liveNoticeCosts(agentId).length === 3, `expected 3 turn notices, got ${liveNoticeCosts(agentId).length}`);
      // the case file shows a non-zero turn cost
      const cf = await (async () => {
        const from = posted.length;
        await send({ type: 'openCase', agentId });
        return waitFor('caseFile', find(from, (m) => (m.type === 'caseFile' && m.agentId === agentId ? m : undefined)), 20000);
      })();
      const cn = cf.items.filter((i): i is Extract<ConversationItem, { kind: 'notice' }> => i.kind === 'notice' && i.notice === 'cost');
      assert(cn.length > 0 && cn.every((i) => (i.costUsd ?? 0) > 0), 'the case file has no non-zero cost notice');
      notes.push(`case file cost notices: ${cn.length}, all > 0`);
      // resume in a fresh host
      await cur!.dispose();
      cur = makeHost();
      cur.onAgents(latestAgents);
      await waitFor('control free', () => { feed.refreshNow(); return agentOf(sid)?.control === 'free' || undefined; }, 30000);
      await send({ type: 'openCase', agentId });
      await waitFor('caseFile after dispose', find(posted.length - 1, (m) => (m.type === 'caseFile' && m.agentId === agentId ? m : undefined)), 20000);
      const lastBefore = sdkResults.length;
      await turn(sid, agentId, 'Reply with one word, nothing else. ZEBRAQUILL4');
      const total2 = sdkTotals.get(sid)!;
      assert(sdkResults.length > lastBefore, 'the resume produced no result');
      const info2 = cur!.getOfficeInfo(sid);
      notes.push(`after resume: SDK total $${total2.toFixed(5)} (restored from history: ${total2 > total1}), office $${info2?.costUsd?.toFixed(5)}, turn notices sum $${costFromTurns(agentId).toFixed(5)} over ${liveNoticeCosts(agentId).length} notices`);
      assert(info2?.costUsd !== undefined && Math.abs(info2.costUsd - total2) < 1e-9, 'office cost differs from the SDK total after the resume');
      assert(Math.abs(costFromTurns(agentId) - total2) < 1e-6, 'the turn costs plus the resume turn do not add up to the SDK total (double count?)');
      const snapCost = await waitFor('snapshot cost', () => { feed.refreshNow(); const c = agentOf(sid)?.costUsd; return c !== undefined && Math.abs(c - total2) < 1e-6 ? c : undefined; }, 20000);
      notes.push(`snapshot costUsd $${snapCost.toFixed(5)} equals the SDK total`);
      await cur!.dispose(); // the plan scenario starts its own host
      cur = makeHost();
      cur.onAgents(latestAgents);
    });

  }

  if (WITH_PLAN && !PROBE_ONLY) {
    allowNonHaiku = true;
    // ---- A3 -------------------------------------------------------------------------------------------------------
    await scenario('A3', 'Plan item survives approval', async (notes) => {
      const from = posted.length;
      await send({
        type: 'newTask',
        nonce: 'a3',
        projectPath: PROJ_A,
        prompt: 'Call the ExitPlanMode tool right now with a one-line plan that says "say hi". Use no other tool. After it is approved reply DONE. ZEBRAQUILL5',
        assignTo: { kind: 'new' },
        permissionMode: 'plan',
        model: MODEL,
        effort: 'low',
      });
      const started = await waitFor('taskStarted', find(from, (m) => (m.type === 'taskStarted' && m.nonce === 'a3' ? m : undefined)), 60000);
      A.planSid = started.sessionId;
      A.planAgentId = started.agentId;
      sessionIds.push(started.sessionId);
      watching.add(started.sessionId);
      await send({ type: 'openCase', agentId: started.agentId });
      const mark = posted.length;
      const pend = await waitFor('plan pending', find(from, (m) => {
        if (m.type === 'caseAppend' && m.agentId === started.agentId && m.pending?.kind === 'plan') return m.pending;
        if (m.type === 'caseFile' && m.agentId === started.agentId && m.pending?.kind === 'plan') return m.pending;
        return undefined;
      }), 90000);
      assert(pend.kind === 'plan', 'not a plan request');
      const planItem = await waitFor('plan item (pending)', () => {
        const byId = new Map<string, ConversationItem>();
        for (const i of itemsAfter(from, started.agentId)) byId.set(i.id, i);
        return [...byId.values()].find((i): i is Extract<ConversationItem, { kind: 'plan' }> => i.kind === 'plan');
      }, 30000);
      notes.push(`plan item arrived: status=${planItem.status} chars=${planItem.text.length} id==pending tool id: ${planItem.id !== undefined}`);
      assert(planItem.status === 'pending', `plan item should be pending, was ${planItem.status}`);
      assert(planItem.text.length > 0, 'the plan item has no text');
      await waitFor('snapshot needsYou plan', () => { feed.refreshNow(); return agentOf(started.sessionId)?.pending?.kind === 'plan' || undefined; }, 15000);
      const m2 = posted.length;
      await send({ type: 'decide', requestId: pend.requestId, decision: { kind: 'plan', approve: true } });
      const approved = await waitFor('plan item approved', () => {
        const byId = new Map<string, ConversationItem>();
        for (const i of itemsAfter(m2, started.agentId)) byId.set(i.id, i);
        const it = byId.get(planItem.id);
        return it !== undefined && it.kind === 'plan' && it.status === 'approved' ? it : undefined;
      }, 30000);
      notes.push(`after the decision the item is ${approved.status}`);
      // The worker may carry on after approval; deny any tool permission so no work happens, then wait for the end.
      const settled = Date.now() + 90000;
      let denied = 0;
      for (;;) {
        if (costNoticeAfter(m2, started.agentId) && idleAfter(m2, started.agentId)) break;
        const p = [...posted.slice(m2)].reverse().find((m) => m.type === 'caseAppend' && m.agentId === started.agentId && m.pending !== undefined);
        const open = p?.type === 'caseAppend' ? p.pending : undefined;
        if (open && open.kind === 'permission' && denied < 3) {
          denied++;
          await send({ type: 'decide', requestId: open.requestId, decision: { kind: 'deny', message: 'not needed' } });
        }
        assert(Date.now() < settled, 'the worker did not settle after the plan approval');
        await sleep(250);
      }
      notes.push(`settled after approval (tool permissions denied: ${denied})`);
      // history: still a plan item, now approved, in the live case and in a fresh case read
      const cf1 = await (async () => {
        const f = posted.length;
        await send({ type: 'openCase', agentId: started.agentId });
        return waitFor('caseFile', find(f, (m) => (m.type === 'caseFile' && m.agentId === started.agentId ? m : undefined)), 20000);
      })();
      const inHistory = cf1.items.find((i) => i.kind === 'plan' && i.id === planItem.id);
      assert(inHistory !== undefined && inHistory.kind === 'plan' && inHistory.status === 'approved', `the plan item left the history or lost its status (${inHistory?.kind === 'plan' ? inHistory.status : 'missing'})`);
      notes.push(`case file history still holds the plan item, status=${inHistory.status}`);
      // getPlan (live run)
      const rid = `p${++reqCounter}`;
      const f2 = posted.length;
      await send({ type: 'getPlan', reqId: rid, agentId: started.agentId, planId: planItem.id });
      const pt = await waitFor('planText', find(f2, (m) => (m.type === 'planText' && m.reqId === rid ? m : m.type === 'error' && m.reqId === rid ? m : undefined)), 20000);
      assert(pt.type === 'planText', `getPlan failed: ${pt.type === 'error' ? pt.message : ''}`);
      assert(pt.text === planItem.text && pt.status === 'approved', 'getPlan text or status differs');
      notes.push(`getPlan (live): ${pt.text.length} chars, status=${pt.status}`);
      // getPlan with no live run: the tracker's transcript model answers
      await cur!.dispose();
      cur = makeHost();
      cur.onAgents(latestAgents);
      await waitFor('plan in tracker', () => { feed.refreshNow(); return (agentOf(started.sessionId)?.plans ?? []).some((p) => p.id === planItem.id) || undefined; }, 20000);
      const ref = agentOf(started.sessionId)!.plans!.find((p) => p.id === planItem.id)!;
      notes.push(`tracker plans: status=${ref.status} chars=${ref.chars}`);
      assert(ref.status === 'approved', `tracker plan status should be approved, was ${ref.status}`);
      const rid2 = `p${++reqCounter}`;
      const f3 = posted.length;
      await send({ type: 'getPlan', reqId: rid2, agentId: started.agentId, planId: planItem.id });
      const pt2 = await waitFor('planText (no run)', find(f3, (m) => (m.type === 'planText' && m.reqId === rid2 ? m : m.type === 'error' && m.reqId === rid2 ? m : undefined)), 20000);
      assert(pt2.type === 'planText' && pt2.text.length > 0 && pt2.status === 'approved', 'getPlan without a run did not return the approved plan');
      notes.push(`getPlan (no run): ${pt2.text.length} chars, status=${pt2.status}`);
      void mark;
    });
  }

  // ---- A6 -------------------------------------------------------------------------------------------------------
  await scenario('A6', 'One usage probe: usage back, no session file, no transcript, no agent', async (notes) => {
    const leftover = probeSessionFiles();
    assert(leftover.length === 0, `${leftover.length} probe session file(s) already exist before the probe`);
    const tmpProject = path.join(PROJECTS, '-tmp');
    const listTmp = (): string[] => (fs.existsSync(tmpProject) ? fs.readdirSync(tmpProject).sort() : []);
    const tmpBefore = listTmp();
    await waitFor('the roster', () => latestAgents.length > 0 || undefined, 20000);
    await sleep(1500); // let the first polls settle, so "added during the probe" means just that
    const agentsBefore = new Set(latestAgents.map((a) => a.id));
    const cwdBefore = latestAgents.filter((a) => a.cwd === os.tmpdir()).length;
    const seen = new Map<string, string | undefined>();
    let watchingDir = true;
    const poller = (async () => {
      while (watchingDir) {
        for (const f of probeSessionFiles()) seen.set(f.name, f.sessionId);
        feed.refreshNow();
        await sleep(20);
      }
    })();
    const result = await probeNowLike((m) => {
      hostLogs.push(m);
      out(`probe log: ${short(m, 100)}`);
    });
    await sleep(1500); // let the watcher poll after the process is gone
    feed.refreshNow();
    await sleep(500);
    watchingDir = false;
    await poller;
    assert(result.status === 'ok', `probe status was ${result.status}`);
    notes.push(`probe: status=ok windows=${result.windows.length} models=${result.models.length} apiKey=${result.apiKey} plan=${result.plan !== undefined} elapsed=${result.elapsedMs} ms`);
    assert(result.windows.length > 0, 'the probe returned no windows');
    notes.push(`a probe-tagged <pid>.json was visible during the probe: ${seen.size > 0} (${seen.size} file(s))`);
    const after = probeSessionFiles();
    assert(after.length === 0, `${after.length} probe session file(s) remain after the probe`);
    notes.push('no ~/.claude/sessions file with entrypoint claude-office-probe remains');
    const tmpAfter = listTmp();
    assert(JSON.stringify(tmpBefore) === JSON.stringify(tmpAfter), `the probe folder gained or lost transcripts (${tmpBefore.length} -> ${tmpAfter.length})`);
    for (const psid of seen.values()) if (psid !== undefined) assert(transcriptFile(psid) === undefined, 'a transcript exists for the probe session');
    notes.push(`no transcript: ~/.claude/projects/-tmp unchanged (${tmpAfter.length} entries), none found for the probe session id`);
    const newAgents = latestAgents.filter((a) => !agentsBefore.has(a.id));
    const probeAgents = latestAgents.filter((a) => [...seen.values()].includes(a.sessionId) || (a.cwd === os.tmpdir() && !agentsBefore.has(a.id)));
    assert(probeAgents.length === 0, 'the watcher surfaced the probe as an agent');
    notes.push(`watcher never surfaced it: agents added during the probe window=${newAgents.length} (none from the probe), agents in the temp dir ${cwdBefore} -> ${latestAgents.filter((a) => a.cwd === os.tmpdir()).length}`);
  });

  // ---- A7 -------------------------------------------------------------------------------------------------------
  await scenario('A7', 'Log hygiene', async (notes) => {
    notes.push(`captured ${hostLogs.length} log lines (host, feed, probe)`);
    assert(hostLogs.length > 0, 'nothing was logged (the check would be vacuous)');
    for (const p of PLANTED) assert(!hostLogs.some((l) => l.includes(p)), `a log line contains planted prompt text ${p}`);
    assert(!hostLogs.some((l) => l.includes('@')), 'a log line contains "@" (account email?)');
    assert(!hostLogs.some((l) => /\d\s*%/.test(l)), 'a log line contains a percentage');
    assert(!hostLogs.some((l) => /utiliz|resets?_?at|five_hour|seven_day|\bpct\b/i.test(l)), 'a log line mentions usage window fields');
    notes.push('no planted prompt text, no "@", no percentages, no usage field names in any log line');
  });

  // ---- clean up the project folder this run created ---------------------------------------------------------------
  const removed = cleanupCreatedProjects();
  out(`removed project folders created by this run: ${removed.length ? removed.join(', ') : '(none)'}`);
  results.push({ n: 'cleanup', name: 'Cleanup', pass: true, notes: [`removed: ${removed.join(', ') || '(none)'}`] });
  out(`SDK totals per session: ${[...sdkTotals].map(([k, v]) => `${sid8(k)}=$${v.toFixed(5)}`).join(' ')}`);
}

async function main(): Promise<void> {
  console.log(`Manager Mode end-to-end, scratch project ${PROJ}, budget $${BUDGET}`);
  const bin = findClaudeBinary({
    settingPath: '',
    claudeCodeExtensionPaths: claudeCodeExtensionPaths(),
    homedir: os.homedir(),
    platform: process.platform,
    PATH: process.env['PATH'],
    exists: nodeFileExists,
    isExecutable: nodeIsExecutable,
  });
  assert(!('error' in bin), 'no Claude binary found');
  const ver = checkClaudeVersions({ source: bin.source, binaryPath: bin.path, sdkVersion: '0.3.302', sdkClaudeCodeVersion: '2.1.302', readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } } });
  console.log(`binary source: ${bin.source}; version check: ${ver.lines[0]}`);

  cur = makeHost();
  feed.setScope('all');
  feed.setVisible(true);
  await waitFor('first poll', () => feed.latestSessions().length > 0 || undefined, 20000).catch(() => undefined);

  if (!ROUND_A_ONLY) await legacyScenarios();
  if (ROUND_A) await roundA();

  await cur!.dispose();
  feed.dispose();

  // ---- report ---------------------------------------------------------------------------------------------------
  const finalCost = latestAgents.find((a) => a.sessionId === (state.sid ?? A_STATE.sid))?.costUsd;
  console.log('\n================ RESULTS ================');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}. ${r.name}`);
    for (const n of r.notes) console.log(`        ${n}`);
  }
  console.log(`models seen: ${[...seenModels].join(', ') || '(none reported)'}`);
  console.log(`cost: summed cost notices $${totalCost.toFixed(4)}; snapshot costUsd for the office session $${finalCost?.toFixed(4) ?? 'n/a'}`);
  console.log(`runner starts (query calls): ${queryCalls}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? 'ALL SCENARIOS PASSED' : `${failed} SCENARIO(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('e2e crashed:', e instanceof Error ? e.stack : e);
  try {
    await cur?.dispose();
  } catch {
    // ignore
  }
  feed.dispose();
  console.log(`cost so far $${totalCost.toFixed(4)}`);
  process.exit(1);
});
