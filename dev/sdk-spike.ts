// Spike for Manager Mode (plan row 6.2): how does @anthropic-ai/claude-agent-sdk behave when driven from a host?
//
//   node dev/sdk-spike.ts <new|new-write|ask|plan|interrupt|resume|partial>
//
// Real runs, Haiku only, inside a scratch project. Every scenario logs each SDKMessage (type, subtype and a short
// structural summary), every canUseTool call, and a poll of ~/.claude/sessions/<digits>.json for this cwd.
// Full raw messages go to <OUT>/<scenario>.jsonl for later reading. Never opens *.key files, never prints env values.
//
// Env overrides: SPIKE_ROOT (scratch folder holding sdk-proj/ and out/), CLAUDE_BIN (binary path).
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT =
  process.env.SPIKE_ROOT ??
  'path.join(os.tmpdir(), 'middle-management-spike')';
const PROJ = path.join(ROOT, 'sdk-proj');
const OUT = path.join(ROOT, 'out');
const BIN =
  process.env.CLAUDE_BIN ??
  '/path/to/claude';
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const HARD_TIMEOUT_MS = 150_000;

const scenario = process.argv[2] ?? '';
fs.mkdirSync(OUT, { recursive: true });
const rawLog = fs.createWriteStream(path.join(OUT, `${scenario || 'none'}.jsonl`));
const t0 = Date.now();

function log(tag: string, text: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  console.log(`${s}s [${tag}] ${text}`);
}
function short(v: unknown, n = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = (s ?? '').replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}...(${one.length})` : one;
}

// --- Input queue for streaming input mode -----------------------------------------------------------------------
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  #ended = false;
  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: msg, done: false });
    } else {
      this.#items.push(msg);
    }
  }
  end(): void {
    this.#ended = true;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

// --- Message summaries -------------------------------------------------------------------------------------------
type Block = { type?: string; name?: string; text?: string; id?: string; input?: Record<string, unknown> };
function blocksOf(msg: SDKMessage): Block[] {
  const m = msg as { message?: { content?: unknown } };
  const c = m.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}
function summarize(msg: SDKMessage): string {
  const m = msg as Record<string, unknown>;
  const parts: string[] = [`keys=${Object.keys(m).join(',')}`];
  if (m.session_id) parts.push(`sid=${String(m.session_id).slice(0, 8)}`);
  if (m.parent_tool_use_id) parts.push(`parent=${String(m.parent_tool_use_id).slice(0, 12)}`);
  const blocks = blocksOf(msg);
  if (blocks.length) {
    parts.push(
      'blocks=[' +
        blocks
          .map((b) =>
            b.type === 'tool_use'
              ? `tool_use:${b.name}(${Object.keys(b.input ?? {}).join(',')})`
              : b.type === 'text'
                ? `text:"${short(b.text ?? '', 70)}"`
                : String(b.type),
          )
          .join(' | ') +
        ']',
    );
  } else if (typeof (m.message as { content?: unknown } | undefined)?.content === 'string') {
    parts.push(`content:"${short((m.message as { content: string }).content, 70)}"`);
  }
  if (m.type === 'system') {
    const extra: Record<string, unknown> = {};
    for (const k of ['permissionMode', 'model', 'tools', 'status', 'mcp_servers', 'slash_commands', 'cwd', 'output_style']) {
      if (k in m) extra[k] = Array.isArray(m[k]) ? `array(${(m[k] as unknown[]).length})` : m[k];
    }
    parts.push(short(extra, 200));
  }
  if (m.type === 'result') {
    const usage = m.usage as Record<string, unknown> | undefined;
    parts.push(
      short(
        {
          is_error: m.is_error,
          stop_reason: m.stop_reason,
          num_turns: m.num_turns,
          total_cost_usd: m.total_cost_usd,
          duration_ms: m.duration_ms,
          usageKeys: usage ? Object.keys(usage).join(',') : undefined,
          permission_denials: Array.isArray(m.permission_denials) ? (m.permission_denials as unknown[]).length : undefined,
          result: m.result,
        },
        360,
      ),
    );
  }
  return parts.join(' ');
}

// --- ~/.claude/sessions observer (only <digits>.json, never *.key) ------------------------------------------------
function startSessionsWatcher(cwd: string): () => void {
  const seen = new Map<string, string>();
  const tick = (): void => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(SESSIONS_DIR).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8')) as Record<string, unknown>;
        if (j.cwd !== cwd) continue;
        const view = {
          file: n,
          kind: j.kind,
          entrypoint: j.entrypoint,
          status: j.status,
          sessionId: j.sessionId,
          version: j.version,
          keys: Object.keys(j).join(','),
        };
        const sig = JSON.stringify([view.status, view.sessionId, view.kind, view.entrypoint]);
        if (seen.get(n) !== sig) {
          seen.set(n, sig);
          log('sessions', short(view, 400));
        }
      } catch {
        /* file vanished or half-written */
      }
    }
    for (const n of [...seen.keys()]) {
      if (!names.includes(n)) {
        seen.delete(n);
        log('sessions', `${n} removed`);
      }
    }
  };
  tick();
  const h = setInterval(tick, 400);
  return () => clearInterval(h);
}

// --- Transcript inspection ---------------------------------------------------------------------------------------
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
function transcriptReport(cwd: string, sid: string | undefined): void {
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    log('transcript', `no project dir ${dir}`);
    return;
  }
  log('transcript', `dir=${dir} files=${files.length}`);
  for (const f of files) {
    if (sid && f !== `${sid}.jsonl`) continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    const types = new Map<string, number>();
    const entry = new Set<string>();
    const versions = new Set<string>();
    const sids = new Set<string>();
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as Record<string, unknown>;
        const key = `${r.type}${r.subtype ? `/${r.subtype}` : ''}`;
        types.set(key, (types.get(key) ?? 0) + 1);
        if (typeof r.entrypoint === 'string') entry.add(r.entrypoint);
        if (typeof r.version === 'string') versions.add(r.version);
        if (typeof r.sessionId === 'string') sids.add(r.sessionId);
      } catch {
        /* skip */
      }
    }
    log(
      'transcript',
      short(
        {
          file: f,
          lines: lines.length,
          entrypoints: [...entry],
          versions: [...versions],
          sessionIds: [...sids].map((s) => s.slice(0, 8)),
          recordTypes: Object.fromEntries(types),
        },
        500,
      ),
    );
  }
}

// --- Shared options + driver ---------------------------------------------------------------------------------------
function sanitizedEnv(): Record<string, string | undefined> {
  // The spike itself runs inside a Claude Code session, so drop that session's markers. The real extension host would
  // not have them. (Names only are matched; values are never printed.)
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_PID') continue;
    env[k] = v;
  }
  return env;
}

function baseOptions(extra: Partial<Options> = {}): Options {
  return {
    model: 'haiku',
    cwd: PROJ,
    pathToClaudeCodeExecutable: BIN,
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'default',
    maxBudgetUsd: 0.2,
    maxTurns: 8,
    env: sanitizedEnv(),
    ...extra,
  };
}

interface RunState {
  sessionId?: string;
  cost?: number;
  finalText?: string;
  resultCount: number;
  toolsAsked: string[];
}

/** Consume a query, logging every message. `onMessage` can react (e.g. end the input queue on a result). */
async function drain(q: Query, state: RunState, onMessage?: (m: SDKMessage) => void): Promise<void> {
  for await (const msg of q) {
    rawLog.write(JSON.stringify(msg) + '\n');
    const m = msg as Record<string, unknown>;
    log('msg', `${m.type}${m.subtype ? `/${m.subtype}` : ''} ${summarize(msg)}`);
    if (typeof m.session_id === 'string') state.sessionId ??= m.session_id;
    if (m.type === 'result') {
      state.resultCount++;
      state.cost = (state.cost ?? 0) + (typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0);
      state.finalText = typeof m.result === 'string' ? m.result : state.finalText;
    }
    onMessage?.(msg);
  }
  log('end', 'query generator finished');
}

function makeCanUseTool(
  state: RunState,
  decide: (toolName: string, input: Record<string, unknown>) => PermissionResult | Promise<PermissionResult>,
): CanUseTool {
  return async (toolName, input, opts) => {
    state.toolsAsked.push(toolName);
    const optKeys = Object.keys(opts).join(',');
    log(
      'canUseTool',
      `tool=${toolName} inputKeys=[${Object.keys(input).join(',')}] toolUseID=${opts.toolUseID} optKeys=[${optKeys}] ` +
        `suggestions=${short(opts.suggestions ?? null, 300)} blockedPath=${opts.blockedPath ?? '-'} ` +
        `decisionReason=${short(opts.decisionReason ?? '-', 100)} title=${short(opts.title ?? '-', 100)}`,
    );
    rawLog.write(JSON.stringify({ canUseTool: { toolName, input, toolUseID: opts.toolUseID, suggestions: opts.suggestions } }) + '\n');
    const res = await decide(toolName, input);
    log('canUseTool', `-> ${short(res, 240)}`);
    return res;
  };
}

const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: 'allow', updatedInput: input });

/** Keep the input stream open for a moment after a result, so the sessions-file watcher can see the idle state. */
function endLater(input: InputQueue, ms = 1800): void {
  log('input', `result seen; ending input stream in ${ms}ms (session is idle but the query is still open)`);
  setTimeout(() => input.end(), ms);
}

// --- Scenarios -------------------------------------------------------------------------------------------------------
/**
 * Scenario a. `strict` swaps the read-only commands (echo, ls: auto-allowed by Claude Code's read-only whitelist, so
 * canUseTool is never asked) for ones that write files, which do reach canUseTool.
 */
async function scenarioNew(strict: boolean): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const input = new InputQueue();
  let bashCount = 0;
  const q = query({
    prompt: input,
    options: baseOptions({
      canUseTool: makeCanUseTool(state, (tool, inp) => {
        if (tool === 'Bash') {
          bashCount++;
          if (bashCount === 1) return allow(inp);
          return { behavior: 'deny', message: 'Spike: the user declined this command. Do not retry it; just reply DONE.' };
        }
        return allow(inp);
      }),
    }),
  });
  input.push(
    strict
      ? 'Read notes.txt, then run `echo office-ok > marker.txt` with Bash, then run `ls -la > listing.txt` with Bash, then reply DONE.'
      : 'Read notes.txt, then run `echo office-ok` with Bash, then run `ls -la` with Bash, then reply DONE.',
  );
  await drain(q, state, (m) => {
    if (m.type === 'result') endLater(input);
  });
  if (state.sessionId) fs.writeFileSync(path.join(OUT, 'session-a.txt'), state.sessionId);
  return state;
}

async function scenarioAsk(): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const input = new InputQueue();
  const q = query({
    prompt: input,
    options: baseOptions({
      canUseTool: makeCanUseTool(state, (tool, inp) => {
        if (tool === 'AskUserQuestion') {
          log('ask', `FULL INPUT ${JSON.stringify(inp)}`);
          const questions = (inp.questions ?? []) as Array<{ question: string; options: Array<{ label: string }> }>;
          const answers: Record<string, string> = {};
          for (const qu of questions) {
            const green = qu.options.find((o) => /green/i.test(o.label));
            answers[qu.question] = green?.label ?? 'Green';
          }
          return { behavior: 'allow', updatedInput: { questions: inp.questions, answers } };
        }
        return allow(inp);
      }),
    }),
  });
  input.push('Use the AskUserQuestion tool to ask me to pick a colour from Red or Green, then tell me which I picked.');
  await drain(q, state, (m) => {
    if (m.type === 'result') endLater(input);
  });
  log('ask', `final reply mentions Green: ${/green/i.test(state.finalText ?? '')}`);
  return state;
}

async function scenarioPlan(): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const input = new InputQueue();
  const target = path.join(PROJ, 'hello.txt');
  fs.rmSync(target, { force: true });
  const q = query({
    prompt: input,
    options: baseOptions({
      permissionMode: 'plan',
      canUseTool: makeCanUseTool(state, (tool, inp) => {
        if (tool === 'ExitPlanMode') {
          log('plan', `FULL INPUT ${short(inp, 1500)}`);
          return allow(inp);
        }
        return allow(inp);
      }),
    }),
  });
  input.push('Plan how you would add a file hello.txt containing hi. Then call ExitPlanMode.');
  await drain(q, state, (m) => {
    if (m.type === 'result') endLater(input);
  });
  log('plan', `hello.txt exists after run: ${fs.existsSync(target)}`);
  fs.rmSync(target, { force: true });
  return state;
}

async function scenarioInterrupt(): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const input = new InputQueue();
  let interrupted = false;
  let sentFollowUp = false;
  const q: Query = query({
    prompt: input,
    options: baseOptions({ canUseTool: makeCanUseTool(state, (_tool, inp) => allow(inp)) }),
  });
  // Claude Code refuses a bare `sleep 30` (it never reaches canUseTool), so run a loop instead. The interrupt timer starts
  // when the assistant's Bash tool_use is first seen on the stream (the command may be auto-allowed, so canUseTool is not
  // a reliable trigger).
  input.push(
    'Run this exact command with the Bash tool and wait for it: `for i in $(seq 1 30); do echo tick $i; sleep 1; done`. Then reply DONE.',
  );
  await drain(q, state, (m) => {
    if (!interrupted && m.type === 'assistant' && blocksOf(m).some((b) => b.type === 'tool_use' && b.name === 'Bash')) {
      interrupted = true;
      setTimeout(() => {
        log('interrupt', 'calling q.interrupt()');
        void q.interrupt().then(
          () => log('interrupt', 'interrupt() promise resolved'),
          (e) => log('interrupt', `interrupt() rejected: ${String(e)}`),
        );
      }, 3000);
    }
    if (m.type === 'result') {
      if (!sentFollowUp) {
        sentFollowUp = true;
        log('interrupt', 'first result received; pushing a follow-up message on the same input stream');
        input.push('Just reply with the single word READY.');
      } else {
        endLater(input);
      }
    }
  });
  return state;
}

async function scenarioResume(): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const sidFile = path.join(OUT, 'session-a.txt');
  if (!fs.existsSync(sidFile)) throw new Error('Run scenario "new" or "new-write" first (needs out/session-a.txt).');
  const prev = fs.readFileSync(sidFile, 'utf8').trim();
  log('resume', `resuming ${prev}`);
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(PROJ));
  const before = new Set(fs.readdirSync(dir));
  const q = query({
    prompt: 'What did you echo earlier? Answer in one short sentence.',
    options: baseOptions({
      resume: prev,
      canUseTool: makeCanUseTool(state, (_t, inp) => allow(inp)),
    }),
  });
  await drain(q, state);
  const after = fs.readdirSync(dir);
  log('resume', `new files in project dir: ${JSON.stringify(after.filter((f) => !before.has(f)))}`);
  log('resume', `session_id in resumed run: ${state.sessionId} (same as original: ${state.sessionId === prev})`);
  log('resume', `final text mentions office-ok: ${/office-ok/i.test(state.finalText ?? '')}`);
  transcriptReport(PROJ, prev);
  if (state.sessionId && state.sessionId !== prev) transcriptReport(PROJ, state.sessionId);
  return state;
}

async function scenarioPartial(): Promise<RunState> {
  const state: RunState = { resultCount: 0, toolsAsked: [] };
  const eventShapes = new Map<string, number>();
  let live = '';
  const q = query({
    prompt: 'Write a two-line poem about a tiny office. No tools.',
    options: baseOptions({ includePartialMessages: true, canUseTool: makeCanUseTool(state, (_t, inp) => allow(inp)) }),
  });
  let sampleCount = 0;
  await drain(q, state, (m) => {
    if (m.type !== 'stream_event') return;
    const ev = (m as unknown as { event: { type: string; index?: number; delta?: { type: string; text?: string }; content_block?: { type: string } } }).event;
    const shape = `${ev.type}${ev.delta ? `/${ev.delta.type}` : ''}${ev.content_block ? `/${ev.content_block.type}` : ''}`;
    eventShapes.set(shape, (eventShapes.get(shape) ?? 0) + 1);
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') live += ev.delta.text ?? '';
    if (sampleCount < 4) {
      sampleCount++;
      log('partial', `SAMPLE ${short(m, 400)}`);
    }
  });
  log('partial', `event shapes: ${JSON.stringify(Object.fromEntries(eventShapes))}`);
  log('partial', `live text built from deltas: ${JSON.stringify(live)}`);
  log('partial', `equals final result: ${live.trim() === (state.finalText ?? '').trim()}`);
  return state;
}

// --- main ------------------------------------------------------------------------------------------------------------
const scenarios: Record<string, () => Promise<RunState>> = {
  new: () => scenarioNew(false),
  'new-write': () => scenarioNew(true),
  ask: scenarioAsk,
  plan: scenarioPlan,
  interrupt: scenarioInterrupt,
  resume: scenarioResume,
  partial: scenarioPartial,
};

const run = scenarios[scenario];
if (!run) {
  console.error(`usage: node dev/sdk-spike.ts <${Object.keys(scenarios).join('|')}>`);
  process.exit(2);
}
log('start', `scenario=${scenario} cwd=${PROJ} bin=${BIN} ANTHROPIC_API_KEY set: ${'ANTHROPIC_API_KEY' in process.env}`);
const stopSessions = startSessionsWatcher(PROJ);
const timer = setTimeout(() => {
  log('timeout', `hard timeout ${HARD_TIMEOUT_MS}ms; exiting`);
  process.exit(3);
}, HARD_TIMEOUT_MS);
try {
  const state = await run();
  log('done', short({ sessionId: state.sessionId, results: state.resultCount, total_cost_usd: state.cost, toolsAsked: state.toolsAsked }, 400));
  if (scenario !== 'resume') transcriptReport(PROJ, state.sessionId);
  // Give the sessions watcher a moment to see the file disappear.
  await new Promise((r) => setTimeout(r, 1200));
} catch (e) {
  log('error', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  stopSessions();
  rawLog.end();
}
