// Spike for the "Office tools" plan (task 1.1): which Agent SDK calls work, and what do they return?
//
//   node dev/options-spike.ts <cost|probe|live|config>
//
//   cost    a + b  Three streaming turns, then a resume turn. Logs every result's total_cost_usd (per turn or running?),
//                  every rate_limit_event, and the transcript's cost-state records.
//   probe   c      No-prompt usage probe: the input queue never yields. Calls usage_EXPERIMENTAL...(skipBehaviors) and
//                  initializationResult(), then closes. Watches ~/.claude/sessions/<pid>.json and the transcript folder.
//   live    d+e+f  setModel / applyFlagSettings({effortLevel}) / setPermissionMode between and during turns, Options.effort
//                  at start, getContextUsage({detail:'summary'}), and the list of methods on the Query object.
//   config  g      Which .claude.json does the CLI use with and without CLAUDE_CONFIG_DIR? (paths and top-level key NAMES only)
//
// Real runs, Haiku only, tiny prompts, `cwd` in a scratch folder (never the project). Never opens *.key files, never prints
// env values or account data (account fields are reduced to key names and a few categorical values).
//
// Env overrides: SPIKE_ROOT (scratch folder, holds out/), CLAUDE_BIN (binary path), SPIKE_ALT_MODEL (second model for the
// `live` scenario's setModel; default claude-haiku-4-5-20251001, see the models list printed by `probe`).
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeBinary, nodeFileExists, nodeIsExecutable } from '../src/manager/claudeBinary.ts';

const ROOT =
  process.env.SPIKE_ROOT ??
  'path.join(os.tmpdir(), 'middle-management-spike', 'options-spike')';
const CWD = ROOT; // sessions run here, never in the project folder
const OUT = path.join(ROOT, 'out');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const ALT_MODEL = process.env.SPIKE_ALT_MODEL ?? 'claude-haiku-4-5-20251001';
const HARD_TIMEOUT_MS = 120_000;

const scenario = process.argv[2] ?? '';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
const rawLog = fs.createWriteStream(path.join(OUT, `${scenario || 'none'}.jsonl`));
const t0 = Date.now();

function log(tag: string, text: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`${s}s [${tag}] ${text}`);
}
function short(v: unknown, n = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = (s ?? '').replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}...(${one.length})` : one;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Binary lookup (same code as the extension: src/manager/claudeBinary.ts) ----------------------------------------
function findBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const exts: string[] = [];
  for (const dir of ['.vscode', '.vscode-oss', '.vscode-server']) {
    const base = path.join(os.homedir(), dir, 'extensions');
    try {
      for (const n of fs.readdirSync(base)) if (n.startsWith('anthropic.claude-code-')) exts.push(path.join(base, n));
    } catch {
      /* no such folder */
    }
  }
  exts.sort().reverse();
  const r = findClaudeBinary({
    claudeCodeExtensionPaths: exts,
    homedir: os.homedir(),
    platform: process.platform,
    PATH: process.env.PATH,
    exists: nodeFileExists,
    isExecutable: nodeIsExecutable,
  });
  if ('error' in r) throw new Error(r.error);
  return r.path;
}
const BIN = findBin();

// --- Input queue (streaming input mode); same shape as src/manager/sessionRunner.ts --------------------------------
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  #ended = false;
  push(text: string): void {
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
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

// --- Env: the host's, minus inherited Claude Code markers, plus the entrypoint tag (see buildRunnerEnv) ---------------
function spikeEnv(entrypoint: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_PID') continue;
    env[k] = v;
  }
  env['CLAUDE_CODE_ENTRYPOINT'] = entrypoint;
  return Object.assign(env, extra);
}

function baseOptions(extra: Partial<Options> = {}): Options {
  return {
    model: 'haiku',
    cwd: CWD,
    pathToClaudeCodeExecutable: BIN,
    settingSources: [], // keep user rules/hooks/plan-mode default out of the spike
    permissionMode: 'default',
    tools: [], // no tools: smaller prompt, cheaper, no permission prompts
    maxBudgetUsd: 0.03,
    maxTurns: 3,
    env: spikeEnv('claude-office-spike'),
    ...extra,
  };
}

// --- Observers --------------------------------------------------------------------------------------------------------
/** Poll ~/.claude/sessions/<digits>.json (never *.key) for files whose cwd is ours; log appear / change / vanish. */
function startSessionsWatcher(cwd: string): { stop: () => void; events: string[] } {
  const seen = new Map<string, string>();
  const events: string[] = [];
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
        const sig = JSON.stringify([j.status, j.sessionId, j.kind, j.entrypoint]);
        if (seen.get(n) !== sig) {
          seen.set(n, sig);
          const line = `${n} status=${String(j.status)} kind=${String(j.kind)} entrypoint=${String(j.entrypoint)} keys=${Object.keys(j).join(',')}`;
          events.push(`appeared/changed ${line}`);
          log('sessions', line);
        }
      } catch {
        /* vanished or half-written */
      }
    }
    for (const n of [...seen.keys()]) {
      if (!names.includes(n)) {
        seen.delete(n);
        events.push(`removed ${n}`);
        log('sessions', `${n} removed`);
      }
    }
  };
  tick();
  const h = setInterval(tick, 150);
  return { stop: () => clearInterval(h), events };
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
function projectDir(): string {
  return path.join(PROJECTS_DIR, encodeProjectDir(CWD));
}
function listTranscripts(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const f of fs.readdirSync(projectDir())) if (f.endsWith('.jsonl')) out[f] = fs.statSync(path.join(projectDir(), f)).size;
  } catch {
    /* no dir */
  }
  return out;
}
function readTranscript(sid: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(path.join(projectDir(), `${sid}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}
/** Every dotted path in `v` whose last key matches `re` (depth-limited), with the value (strings clipped). */
function findKeys(v: unknown, re: RegExp, prefix = '', depth = 0, out: string[] = []): string[] {
  if (depth > 5 || v === null || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (re.test(k) && (val === null || typeof val !== 'object')) out.push(`${p}=${short(val, 60)}`);
    else findKeys(val, re, p, depth + 1, out);
  }
  return out;
}

// --- Message handling -------------------------------------------------------------------------------------------------
interface TurnResult {
  cost: number | undefined;
  numTurns: unknown;
  usage: Record<string, unknown> | undefined;
  modelUsage: Record<string, unknown> | undefined;
  text: string;
  sessionId: string | undefined;
}
function resultOf(m: Record<string, unknown>): TurnResult {
  return {
    cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
    numTurns: m.num_turns,
    usage: m.usage as Record<string, unknown> | undefined,
    modelUsage: m.modelUsage as Record<string, unknown> | undefined,
    text: typeof m.result === 'string' ? m.result : '',
    sessionId: typeof m.session_id === 'string' ? m.session_id : undefined,
  };
}
function logResult(label: string, r: TurnResult): void {
  const u = r.usage ?? {};
  const mu = Object.fromEntries(
    Object.entries(r.modelUsage ?? {}).map(([k, v]) => [k, (v as { costUSD?: number }).costUSD]),
  );
  log(
    'result',
    `${label} total_cost_usd=${String(r.cost)} num_turns=${String(r.numTurns)} in=${String(u.input_tokens)} ` +
      `cacheWrite=${String(u.cache_creation_input_tokens)} cacheRead=${String(u.cache_read_input_tokens)} ` +
      `out=${String(u.output_tokens)} modelUsage.costUSD=${JSON.stringify(mu)} text=${short(r.text, 40)}`,
  );
}
function logRateLimit(m: Record<string, unknown>, seen: unknown[]): void {
  seen.push(m.rate_limit_info);
  log('rate_limit_event', `keys=${Object.keys(m).join(',')} info=${short(m.rate_limit_info, 700)}`);
}

// total_cost_usd is a running session total (cumulative, also across resume), so the spend of a run is the sum of deltas.
let totalCost = 0;
const lastCostBySession = new Map<string, number>();
const toCount = (r: TurnResult): void => {
  const key = r.sessionId ?? '';
  totalCost += (r.cost ?? 0) - (lastCostBySession.get(key) ?? 0);
  lastCostBySession.set(key, r.cost ?? 0);
};

/** Run a streaming session where `onTurnDone(i)` decides what to push next (or ends). Resolves with all results. */
async function streamingSession(
  opts: Options,
  prompts: string[],
  hooks: {
    onQuery?: (q: Query) => void;
    onMessage?: (m: Record<string, unknown>, q: Query, turn: number) => void;
    afterTurn?: (turn: number, q: Query, r: TurnResult) => Promise<void>;
  } = {},
): Promise<{ results: TurnResult[]; inits: Array<Record<string, unknown>>; rateLimits: unknown[] }> {
  const input = new InputQueue();
  const q = query({ prompt: input, options: opts });
  hooks.onQuery?.(q);
  const results: TurnResult[] = [];
  const inits: Array<Record<string, unknown>> = [];
  const rateLimits: unknown[] = [];
  let turn = 0;
  input.push(prompts[0] ?? '');
  for await (const msg of q) {
    rawLog.write(JSON.stringify(msg) + '\n');
    const m = msg as Record<string, unknown>;
    if (m.type === 'system' && m.subtype === 'init') {
      inits.push(m);
      log(
        'init',
        `turn=${turn} model=${String(m.model)} permissionMode=${String(m.permissionMode)} effort=${String(m.effort)} ` +
          `keys=${Object.keys(m).join(',')}`.slice(0, 700),
      );
    } else if (m.type === 'rate_limit_event') {
      logRateLimit(m, rateLimits);
    } else if (m.type === 'system' && (m.subtype === 'status' || m.subtype === 'session_state_changed')) {
      log('msg', `system/${String(m.subtype)} status=${String(m.status)} state=${String(m.state)} mode=${String(m.permissionMode)}`);
    }
    hooks.onMessage?.(m, q, turn);
    if (m.type === 'result') {
      const r = resultOf(m);
      toCount(r);
      results.push(r);
      logResult(`turn${turn}`, r);
      if (hooks.afterTurn) await hooks.afterTurn(turn, q, r);
      turn++;
      const next = prompts[turn];
      if (next !== undefined) input.push(next);
      else {
        log('input', 'last result; ending input stream');
        input.end();
      }
    }
  }
  return { results, inits, rateLimits };
}

// --- Scenario: cost + rate_limit_event (a, b) -------------------------------------------------------------------------------
async function scenarioCost(): Promise<void> {
  const before = listTranscripts();
  const { results, rateLimits } = await streamingSession(baseOptions(), [
    'Reply with one word: alpha',
    'Reply with one word: beta',
    'Reply with one word: gamma',
  ]);
  const sid = results[0]?.sessionId;
  log('cost', `session ${sid}; per-result total_cost_usd = ${JSON.stringify(results.map((r) => r.cost))}`);
  const last = results.at(-1)?.cost ?? 0;
  const first = results[0]?.cost ?? 0;
  log('cost', `non-decreasing=${results.every((r, i) => i === 0 || (r.cost ?? 0) >= (results[i - 1]?.cost ?? 0))} first=${first} last=${last} -> total_cost_usd is a running session total; the transcript's cost-state totalCostUSD below should equal the last value`);
  log('rate_limit_event', `count over 3 turns = ${rateLimits.length}`);
  if (!sid) return;
  await sleep(800);
  const costState = (id: string): void => {
    const recs = readTranscript(id).filter((r) => r.type === 'cost-state');
    log('transcript', `${id.slice(0, 8)} cost-state records: ${recs.length}`);
    for (const r of recs) log('transcript', `cost-state ${short(r, 600)}`);
  };
  costState(sid);

  // Resume for one more turn (string prompt, single turn).
  log('resume', `resuming ${sid}`);
  const q = query({
    prompt: 'Reply with one word: delta',
    options: baseOptions({ resume: sid }),
  });
  let resumed: TurnResult | undefined;
  for await (const msg of q) {
    rawLog.write(JSON.stringify(msg) + '\n');
    const m = msg as Record<string, unknown>;
    if (m.type === 'rate_limit_event') logRateLimit(m, rateLimits);
    if (m.type === 'result') {
      resumed = resultOf(m);
      toCount(resumed);
      logResult('resumed', resumed);
    }
  }
  log('resume', `session_id after resume: ${String(resumed?.sessionId)} (same: ${resumed?.sessionId === sid})`);
  await sleep(800);
  if (resumed?.sessionId) costState(resumed.sessionId);
  log('transcripts', `new/changed files: ${JSON.stringify(Object.entries(listTranscripts()).filter(([f, s]) => before[f] !== s).map(([f, s]) => `${f.slice(0, 8)}:${s}`))}`);
  fs.writeFileSync(path.join(OUT, 'cost-session.txt'), sid);
}

// --- Scenario: no-prompt usage probe (c) -------------------------------------------------------------------------------------
function redactAccount(a: Record<string, unknown> | undefined): Record<string, unknown> {
  const keep = new Set(['subscriptionType', 'apiProvider', 'tokenSource', 'apiKeySource']);
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a ?? {})) o[k] = keep.has(k) ? v : '<redacted>';
  return o;
}
async function scenarioProbe(extraEnv: Record<string, string> = {}, tag = 'probe'): Promise<void> {
  const watcher = startSessionsWatcher(CWD);
  const beforeFiles = listTranscripts();
  const input = new InputQueue(); // never pushed to, never ended: the probe has no prompt
  const tStart = Date.now();
  const q = query({
    prompt: input,
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: BIN,
      model: 'haiku',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      persistSession: false,
      permissionMode: 'default',
      env: spikeEnv('claude-office-probe', extraEnv),
      stderr: (s: string) => log('stderr', `${s.length} chars`),
    },
  });
  // Consume the generator in the background; with no prompt it should yield nothing.
  let msgCount = 0;
  const consumer = (async () => {
    try {
      for await (const m of q) {
        msgCount++;
        rawLog.write(JSON.stringify(m) + '\n');
        log('msg', `unexpected message ${(m as { type: string }).type}`);
      }
    } catch (e) {
      log('consumer', `generator threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  log('probe', 'query() created, no message pushed');
  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} timed out after ${ms}ms`)))]);

  try {
    const tInit = Date.now();
    const init = await withTimeout(q.initializationResult(), 30_000, 'initializationResult');
    log('init', `initializationResult() latency ${Date.now() - tInit}ms (${Date.now() - tStart}ms since start)`);
    const i = init as unknown as Record<string, unknown>;
    log('init', `top-level keys: ${Object.keys(i).join(',')}`);
    log('init', `account (redacted): ${short(redactAccount(i.account as Record<string, unknown>))}`);
    log('init', `claude_code_version=${String(i.claude_code_version)} output_style=${String(i.output_style)}`);
    log('init', `commands=${(i.commands as unknown[]).length} agents=${(i.agents as unknown[]).length}`);
    for (const m of init.models) {
      log(
        'models',
        `value=${m.value} resolved=${String(m.resolvedModel)} name=${JSON.stringify(m.displayName)} supportsEffort=${String(m.supportsEffort)} ` +
          `levels=${JSON.stringify(m.supportedEffortLevels)} adaptive=${String(m.supportsAdaptiveThinking)} fast=${String(m.supportsFastMode)} auto=${String(m.supportsAutoMode)} keys=${Object.keys(m).join(',')}`,
      );
    }
    if (tag === 'probe') {
      await sleep(600);
      const tUse = Date.now();
      const usage = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 30_000, 'usage');
      log('usage', `latency ${Date.now() - tUse}ms`);
      const u = usage as unknown as Record<string, unknown>;
      log('usage', `top-level keys: ${Object.keys(u).join(',')}`);
      log('usage', `session=${short(u.session, 500)}`);
      log('usage', `subscription_type=${String(u.subscription_type)} rate_limits_available=${String(u.rate_limits_available)} behaviors=${String(u.behaviors)}`);
      const rl = u.rate_limits as Record<string, unknown> | null;
      log('usage', `rate_limits keys: ${rl ? Object.keys(rl).join(',') : 'null'}`);
      for (const [k, v] of Object.entries(rl ?? {})) log('usage', `rate_limits.${k} = ${short(v, 300)}`);
      const limits = (rl as { limits?: Array<Record<string, unknown>> } | null)?.limits;
      log('usage', `rate_limits.limits[] item keys: ${limits?.[0] ? Object.keys(limits[0]).join(',') : '-'}; kinds=${JSON.stringify(limits?.map((l) => `${String(l.kind)}/${String(l.group)}`))}`);
      // A second call, to see the latency again (is it cached?).
      const tUse2 = Date.now();
      await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      log('usage', `second call latency ${Date.now() - tUse2}ms`);
      totalCost += (u.session as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0;
    }
    await sleep(500);
  } catch (e) {
    log('probe', `ERROR ${e instanceof Error ? e.message : String(e)}`);
  }
  log('probe', `files while running (sessions events so far): ${short(watcher.events, 800)}`);
  const tClose = Date.now();
  q.close();
  await withTimeout(consumer, 10_000, 'consumer after close').catch((e: unknown) => log('probe', String(e)));
  log('probe', `close() -> generator finished in ${Date.now() - tClose}ms; messages yielded: ${msgCount}`);
  await sleep(1200); // let the sessions file vanish
  watcher.stop();
  const afterFiles = listTranscripts();
  const changed = Object.entries(afterFiles).filter(([f, s]) => beforeFiles[f] !== s);
  log('probe', `sessions-file events: ${short(watcher.events, 800)}`);
  log('probe', `transcripts before=${Object.keys(beforeFiles).length} after=${Object.keys(afterFiles).length} new/changed=${JSON.stringify(changed)}`);
}

// --- Scenario: live controls, Options.effort, getContextUsage (d, e, f) ------------------------------------------------------
function transcriptTurns(sid: string): void {
  const recs = readTranscript(sid);
  const asst = recs.filter((r) => r.type === 'assistant');
  for (const [i, r] of asst.entries()) {
    const msg = r.message as Record<string, unknown> | undefined;
    log('transcript', `assistant#${i} message.model=${String(msg?.model)} top-level keys=${Object.keys(r).join(',')} effort-ish: ${JSON.stringify(findKeys(r, /effort/i))}`);
  }
  const other = recs.filter((r) => r.type !== 'assistant' && r.type !== 'user');
  const eff = other.flatMap((r) => findKeys(r, /effort/i).map((x) => `${String(r.type)}:${x}`));
  log('transcript', `non-assistant records mentioning effort: ${JSON.stringify(eff)}; modes: ${JSON.stringify(recs.filter((r) => r.type === 'mode').map((r) => short(r, 120)))}`);
  const userEff = recs.filter((r) => r.type === 'user').flatMap((r) => findKeys(r, /effort/i));
  log('transcript', `user records mentioning effort: ${JSON.stringify(userEff)}`);
}

async function timed<T>(label: string, p: Promise<T>): Promise<T | undefined> {
  const t = Date.now();
  try {
    const v = await p;
    log('control', `${label} -> resolved after ${Date.now() - t}ms${v === undefined ? '' : ` value=${short(v, 120)}`}`);
    return v;
  } catch (e) {
    log('control', `${label} -> REJECTED after ${Date.now() - t}ms: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

async function scenarioLive(): Promise<void> {
  const watcher = startSessionsWatcher(CWD);
  let duringFired = false;
  const { results, inits } = await streamingSession(
    baseOptions({ effort: 'low', maxTurns: 2, maxBudgetUsd: 0.04 }), // (e) Options.effort at start
    [
      'Reply with one word: one', // turn 0: model=haiku, effort=low (Options.effort)
      'Reply with one word: two', // turn 1: after between-turn setModel/effort/mode
      'Count from 1 to 40 separated by single spaces. Output nothing else.', // turn 2: controls fired during this turn
      'Reply with one word: four', // turn 3: shows the effect of the during-turn calls
    ],
    {
      onQuery: (q) => {
        const names = new Set<string>();
        for (let o: object | null = q; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const n of Object.getOwnPropertyNames(o)) if (typeof (q as unknown as Record<string, unknown>)[n] === 'function' && n !== 'constructor') names.add(n);
        }
        log('methods', `Query object methods: ${[...names].sort().join(', ')}`);
      },
      onMessage: (m, q, turn) => {
        // (d, during a turn) fire the three controls right after turn 2 starts, without waiting for them.
        if (turn === 2 && !duringFired && m.type === 'system' && m.subtype === 'init') {
          duringFired = true;
          log('control', 'DURING turn 2: calling setModel / applyFlagSettings / setPermissionMode now');
          void timed('during setModel(haiku)', q.setModel('haiku'));
          void timed("during applyFlagSettings({effortLevel:'medium'})", q.applyFlagSettings({ effortLevel: 'medium' }));
          void timed("during setPermissionMode('acceptEdits')", q.setPermissionMode('acceptEdits'));
        }
      },
      afterTurn: async (turn, q) => {
        await sleep(600); // let the transcript flush
        if (turn === 0) {
          // (f) context usage while idle between turns
          const t = Date.now();
          const cu = await timed("getContextUsage({detail:'summary'})", q.getContextUsage({ detail: 'summary' }));
          if (cu) {
            const c = cu as unknown as Record<string, unknown>;
            log('context', `latency ${Date.now() - t}ms keys=${Object.keys(c).join(',')}`);
            log('context', `totalTokens=${String(c.totalTokens)} maxTokens=${String(c.maxTokens)} rawMaxTokens=${String(c.rawMaxTokens)} percentage=${String(c.percentage)} model=${String(c.model)}`);
            log('context', `categories=${short((c.categories as Array<{ name: string; tokens: number; kind: string }>).map((x) => `${x.name}:${x.tokens}:${x.kind}`), 600)}`);
            log('context', `json size=${JSON.stringify(c).length} chars`);
            for (const k of ['autoCompactThreshold', 'isAutoCompactEnabled', 'apiUsage', 'messageBreakdown']) {
              if (k in c) log('context', `${k}=${short(c[k], 300)}`);
            }
          }
          // (d, between turns): effort + permission mode now, model after turn 1 (so each effect is visible on its own)
          log('control', "BETWEEN turn 0 and 1: applyFlagSettings({effortLevel:'high'}) / setPermissionMode('acceptEdits')");
          await timed("applyFlagSettings({effortLevel:'high'})", q.applyFlagSettings({ effortLevel: 'high' }));
          await timed("setPermissionMode('acceptEdits')", q.setPermissionMode('acceptEdits'));
        }
        if (turn === 1) {
          log('control', `BETWEEN turn 1 and 2: setModel(${ALT_MODEL})`);
          await timed(`setModel(${ALT_MODEL})`, q.setModel(ALT_MODEL));
        }
        if (turn === 2) {
          log('control', 'turn 2 finished; the during-turn calls above show whether they resolved before/after the result');
        }
      },
    },
  );
  const sid = results[0]?.sessionId;
  log('inits', `per-turn init: ${JSON.stringify(inits.map((m) => ({ model: m.model, permissionMode: m.permissionMode, effort: m.effort })))}`);
  if (sid) {
    await sleep(800);
    transcriptTurns(sid);
  }
  await sleep(1200);
  watcher.stop();
}

// --- Scenario: .claude.json location (g) ---------------------------------------------------------------------------------------
function describeFile(label: string, p: string): void {
  try {
    const st = fs.statSync(p);
    let keys = '(not json)';
    try {
      keys = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>).join(',');
    } catch {
      /* ignore */
    }
    log('config', `${label}: ${p} exists size=${st.size} mtime=${st.mtime.toISOString()} top-level keys: ${keys}`);
  } catch {
    log('config', `${label}: ${p} does not exist`);
  }
}
async function scenarioConfig(): Promise<void> {
  describeFile('default ~/.claude.json', path.join(os.homedir(), '.claude.json'));
  describeFile('~/.claude/.claude.json', path.join(CLAUDE_HOME, '.claude.json'));
  const cfg = path.join(ROOT, 'cfgdir');
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.mkdirSync(cfg, { recursive: true });
  const homeStat = (): string => {
    try {
      return String(fs.statSync(path.join(os.homedir(), '.claude.json')).mtimeMs);
    } catch {
      return 'none';
    }
  };
  const mtimeBefore = homeStat();
  log('config', `running a probe with CLAUDE_CONFIG_DIR=<scratch>/cfgdir (empty), no prompt, no cost`);
  await scenarioProbe({ CLAUDE_CONFIG_DIR: cfg }, 'config');
  await sleep(500);
  const walk = (d: string, depth = 0): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && depth < 1 ? [`${e.name}/`, ...walk(path.join(d, e.name), depth + 1).map((x) => `${e.name}/${x}`)] : [e.name]));
  log('config', `files now in cfgdir: ${JSON.stringify(walk(cfg))}`);
  describeFile('cfgdir/.claude.json', path.join(cfg, '.claude.json'));
  describeFile('cfgdir/.claude/.claude.json', path.join(cfg, '.claude', '.claude.json'));
  log('config', `~/.claude.json mtime changed during that run: ${homeStat() !== mtimeBefore} (other Claude sessions on this machine also write it, so this is only a weak signal)`);
}

// --- main ----------------------------------------------------------------------------------------------------------------------
const scenarios: Record<string, () => Promise<void>> = {
  cost: scenarioCost,
  probe: () => scenarioProbe(),
  live: scenarioLive,
  config: scenarioConfig,
};
const run = scenarios[scenario];
if (!run) {
  console.error(`usage: node dev/options-spike.ts <${Object.keys(scenarios).join('|')}>`);
  process.exit(2);
}
log('start', `scenario=${scenario} cwd=${CWD} bin=${BIN} ANTHROPIC_API_KEY set: ${'ANTHROPIC_API_KEY' in process.env}`);
const timer = setTimeout(() => {
  log('timeout', `hard timeout ${HARD_TIMEOUT_MS}ms; exiting`);
  process.exit(3);
}, HARD_TIMEOUT_MS);
try {
  await run();
  log('done', `scenario ${scenario} finished; spend of this run (deltas of the running total_cost_usd) = ${totalCost.toFixed(6)}`);
} catch (e) {
  log('error', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  rawLog.end();
}
