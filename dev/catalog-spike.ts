// Catalog spike (Office tools 5.2): what do mcpServerStatus(), supportedCommands(), supportedAgents() and
// initializationResult() return, and when? Prints SHAPES only (key names, value types, counts, lengths).
//
//   node dev/catalog-spike.ts [cwd]          cwd defaults to the scratch project dir (SPIKE_ROOT/catalog-5.2)
//   CLAUDE_BIN=/path/to/claude node dev/catalog-spike.ts "/home/user/project"
//   SPIKE_PLUGIN=/path/to/local/plugin node dev/catalog-spike.ts <cwd>     also load one local plugin (marking test)
//
// No prompt is ever sent (the input queue never yields), so a run costs $0. It does start the user's configured MCP
// servers, as Claude Code normally would; no MCP tool is called. settingSources is user+project+local, and strictMcpConfig /
// mcpServers are NOT set, so the real servers report. Entrypoint tag `claude-office-probe` keeps the office watcher away.
//
// Redaction: string values are printed ONLY for allowlisted fields (server/skill/command/agent names, status, scope, source,
// transport type, model alias). Everything else is shown as `string(len)`. Server config bodies (command, args, env, url,
// headers) are reduced to key names plus the transport `type`. Descriptions are reduced to a length.
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeBinary, nodeFileExists, nodeIsExecutable } from '../src/manager/claudeBinary.ts';
import { InputQueue, buildRunnerEnv } from '../src/manager/sessionRunner.ts';

const ROOT =
  process.env.SPIKE_ROOT ??
  'path.join(os.tmpdir(), 'middle-management-spike', 'catalog-5.2')';
const CWD = process.argv[2] ?? path.join(ROOT, 'project');
fs.mkdirSync(CWD, { recursive: true });
const POLL_MS = 500;
const POLL_MAX_MS = 20_000;
const HARD_TIMEOUT_MS = 60_000;
const t0 = Date.now();
const log = (tag: string, text: string): void => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${tag}] ${text}`);

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

// Field names whose string value may be printed as is.
const SHOW = new Set(['name', 'status', 'scope', 'source', 'type', 'model', 'plugin_name', 'subtype']);

/** Type of a value, with strings redacted to their length unless the key is allowlisted. */
function shape(v: unknown, key = '', depth = 0): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'string') return SHOW.has(key) ? JSON.stringify(v) : `string(${v.length})`;
  if (typeof v === 'object') return depth > 0 ? `{${Object.keys(v).join(',')}}` : 'object';
  return typeof v === 'boolean' || typeof v === 'number' ? `${typeof v}` : typeof v;
}

/** One line per item: each key with its (redacted) shape. Nested `config` is reduced to keys + transport type. */
function row(item: unknown): string {
  if (typeof item !== 'object' || item === null) return shape(item);
  const parts: string[] = [];
  for (const [k, val] of Object.entries(item as Record<string, unknown>)) {
    if (k === 'config' && typeof val === 'object' && val !== null) {
      const c = val as Record<string, unknown>;
      parts.push(`config={keys:[${Object.keys(c).join(',')}] type:${typeof c['type'] === 'string' ? JSON.stringify(c['type']) : 'absent'}}`);
    } else if (k === 'tools' && Array.isArray(val)) {
      parts.push(`tools=array(${val.length})`);
    } else if (k === 'serverInfo' && typeof val === 'object' && val !== null) {
      parts.push(`serverInfo={keys:[${Object.keys(val).join(',')}]}`);
    } else if (k === 'error') {
      parts.push(`error=string(${typeof val === 'string' ? val.length : 0})`);
    } else if (k === 'aliases' && Array.isArray(val)) {
      parts.push(`aliases=${JSON.stringify(val.filter((a) => typeof a === 'string' && /^[\w:.-]{1,60}$/.test(a)))}`);
    } else {
      parts.push(`${k}=${shape(val, k)}`);
    }
  }
  return parts.join(' ');
}

function keyUnion(items: unknown[]): string {
  const keys = new Map<string, Set<string>>();
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    for (const [k, v] of Object.entries(it)) {
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      (keys.get(k) ?? keys.set(k, new Set()).get(k)!).add(t);
    }
  }
  return [...keys].map(([k, t]) => `${k}:${[...t].join('|')}`).join('  ');
}

function tally(items: unknown[], key: string): string {
  const m = new Map<string, number>();
  for (const it of items) {
    const v = (it as Record<string, unknown>)[key];
    const s = v === undefined ? '(absent)' : typeof v === 'string' ? v : typeof v;
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return [...m].map(([k, n]) => `${k}=${n}`).join(' ');
}

async function main(): Promise<void> {
  const bin = findBin();
  log('start', `cwd=${CWD === ROOT || CWD.startsWith(ROOT) ? '<scratch>' : CWD} binary=found`);
  const input = new InputQueue(); // never pushed to
  const abort = new AbortController();
  const env = buildRunnerEnv(process.env);
  env['CLAUDE_CODE_ENTRYPOINT'] = 'claude-office-probe';
  const q = query({
    prompt: input,
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: bin,
      model: 'haiku',
      settingSources: ['user', 'project', 'local'],
      persistSession: false,
      ...(process.env.SPIKE_PLUGIN ? { plugins: [{ type: 'local' as const, path: process.env.SPIKE_PLUGIN }] } : {}),
      permissionMode: 'default',
      abortController: abort,
      env,
      stderr: (s: string) => log('stderr', `${s.length} chars`),
    },
  });
  // Drain (yields nothing without a prompt; ends on close).
  void (async () => {
    try {
      for await (const m of q) log('msg', `unexpected message type=${(m as { type?: string }).type}`);
    } catch {
      /* closed */
    }
  })();
  const timer = setTimeout(() => abort.abort(), HARD_TIMEOUT_MS);
  try {
    const rec = q as unknown as Record<string, unknown>;
    log('methods', Object.getOwnPropertyNames(Object.getPrototypeOf(q)).filter((n) => /skill|command|agent|mcp|plugin|init|supported/i.test(n)).join(','));

    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const s = Date.now();
      const r = await fn();
      log(label, `resolved in ${Date.now() - s} ms`);
      return r;
    };

    // 1. initializationResult
    const init = await time('initializationResult', () => q.initializationResult());
    log('init', `keys=[${Object.keys(init).join(',')}]`);
    log('init', `commands=array(${init.commands.length}) agents=array(${init.agents.length}) models=array(${init.models.length}) output_style=${JSON.stringify(init.output_style)} available_output_styles=${init.available_output_styles.length}`);
    log('init', `skills-key-present=${'skills' in init} plugins-key-present=${'plugins' in init} mcp-key-present=${'mcp_servers' in init}`);

    // 2. supportedCommands
    const cmds = await time('supportedCommands', () => q.supportedCommands());
    log('commands', `count=${cmds.length}; keys: ${keyUnion(cmds)}`);
    log('commands', `builtin tally: ${tally(cmds, 'builtin')}`);
    const nonBuiltin = cmds.filter((c) => !c.builtin);
    const colon = nonBuiltin.filter((c) => c.name.includes(':'));
    log('commands', `non-builtin=${nonBuiltin.length} of which name contains ':'=${colon.length}; dup names=${cmds.length - new Set(cmds.map((c) => c.name)).size}`);
    log('commands', `non-builtin names: ${nonBuiltin.map((c) => c.name).join(' ')}`);
    log('commands', `builtin names: ${cmds.filter((c) => c.builtin).map((c) => c.name).join(' ')}`);
    for (const c of nonBuiltin.slice(0, 3)) log('commands', `example: ${row(c)}`);
    log('commands', `commands in init === supportedCommands count: ${init.commands.length === cmds.length}`);

    // 3. supportedAgents
    const agents = await time('supportedAgents', () => q.supportedAgents());
    log('agents', `count=${agents.length}; keys: ${keyUnion(agents)}`);
    for (const a of agents) log('agents', row(a));

    // 4. mcpServerStatus: first read straight away, then poll until nothing is pending
    const first = await time('mcpServerStatus#1', () => q.mcpServerStatus());
    log('mcp', `first read: count=${first.length}; keys: ${keyUnion(first)}`);
    log('mcp', `first read status tally: ${tally(first, 'status')}`);
    let cur = first;
    const start = Date.now();
    let lastSig = '';
    while (Date.now() - start < POLL_MAX_MS) {
      const sig = cur.map((s) => `${s.name}:${s.status}`).join(' ');
      if (sig !== lastSig) log('mcp', `status change -> ${sig}`);
      lastSig = sig;
      if (!cur.some((s) => s.status === 'pending')) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
      cur = await q.mcpServerStatus();
    }
    log('mcp', `settled after ${Date.now() - start} ms (pending left: ${cur.filter((s) => s.status === 'pending').length})`);
    log('mcp', `final status tally: ${tally(cur, 'status')}; scope tally: ${tally(cur, 'scope')}; source tally: ${tally(cur, 'source')}`);
    log('mcp', `config.type tally: ${tally(cur.map((s) => ({ t: (s.config as { type?: string } | undefined)?.type })), 't')}`);
    log('mcp', `dup names=${cur.length - new Set(cur.map((s) => s.name)).size}`);
    for (const s of cur) log('mcp', row(s));
    // Tool counts per server (names of tools are not printed)
    log('mcp', `tool counts: ${cur.map((s) => `${s.name}=${s.tools?.length ?? '-'}`).join(' ')}`);

    // 5. Anything for skills?
    log('skills', `Query has supportedSkills: ${typeof rec['supportedSkills']}; reloadSkills: ${typeof rec['reloadSkills']}`);
  } finally {
    clearTimeout(timer);
    try {
      input.end();
    } catch {
      /* ended */
    }
    try {
      abort.abort();
    } catch {
      /* aborted */
    }
    try {
      q.close();
    } catch {
      /* closed */
    }
    log('done', 'query closed');
  }
}

main().then(
  () => setTimeout(() => process.exit(0), 300),
  (e) => {
    console.error('spike failed:', e instanceof Error ? e.name : 'Error');
    process.exit(1);
  },
);
