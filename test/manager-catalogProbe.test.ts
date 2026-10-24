// The catalog probe (task 5.5), against a scripted fake query: trust gating, no MCP servers for the catalog, unapproved project
// servers never started, status polling with intermediate updates, timeout, single-flight, cache TTL, shutdown, and the
// options every probe must (and must not) carry. No real Claude Code process is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as path from 'node:path';
import {
  CATALOG_CACHE_TTL_MS,
  CATALOG_TIMEOUT_MS,
  MCP_CACHE_TTL_MS,
  MCP_POLL_MAX_MS,
  MCP_POLL_MS,
  PROBE_ENTRYPOINT_TAG,
  createCatalogProbe,
} from '../src/manager/catalogProbe.ts';
import type { CatalogProbeDeps, McpProbeUpdate, ProcessControl } from '../src/manager/catalogProbe.ts';
import type { CappedReadDeps } from '../src/claude/claudeConfig.ts';
import { readMcpConfig } from '../src/claude/mcpConfig.ts';
import type { McpSnapshot, McpTrust } from '../src/claude/mcpConfig.ts';
import type { QueryFn } from '../src/manager/sessionRunner.ts';
import { FakeQuery, FakeTimers, settle } from './manager-fakes.ts';

const HOME = '/home/u';
const CWD = '/work/proj';
const NEUTRAL = '/scratch/neutral';
const YES: McpTrust = { workspaceTrusted: true, claudeTrusted: true };
const NO_WORKSPACE: McpTrust = { workspaceTrusted: false, claudeTrusted: true };
const NO_CLAUDE: McpTrust = { workspaceTrusted: true, claudeTrusted: false };

/** A fake query with the three catalog calls, scripted per instance. */
class ProbeQuery extends FakeQuery {
  commands: unknown = [{ name: 'clear', description: 'Clear', argumentHint: '', builtin: true }, { name: 'my-skill', description: 'Mine', argumentHint: '' }];
  agents: unknown = [{ name: 'Explore', description: 'Looks around', model: 'inherit' }];
  /** Successive `mcpServerStatus()` results; the last one repeats. Unset: every server the probe started reports `connected`. */
  statusScript: unknown[] | undefined;
  statusReads = 0;
  supportedCommands: () => Promise<unknown>;
  supportedAgents: () => Promise<unknown>;
  mcpServerStatus: () => Promise<unknown>;

  constructor(params: ConstructorParameters<typeof FakeQuery>[0]) {
    super(params);
    this.controlResults['initializationResult'] = { pid: 4242, commands: 'SENTINEL_INIT_COMMANDS', account: { email: 'SENTINEL_EMAIL' } };
    this.supportedCommands = async () => {
      this.calls.push({ method: 'supportedCommands', args: [] });
      return this.commands;
    };
    this.supportedAgents = async () => {
      this.calls.push({ method: 'supportedAgents', args: [] });
      return this.agents;
    };
    this.mcpServerStatus = async () => {
      this.calls.push({ method: 'mcpServerStatus', args: [] });
      const script = this.statusScript ?? [Object.keys((this.params.options.mcpServers ?? {}) as object).map((name) => row(name, 'connected'))];
      return script[Math.min(this.statusReads++, script.length - 1)];
    };
  }
}

interface Setup {
  probe: ReturnType<typeof createCatalogProbe>;
  timers: FakeTimers;
  queries: ProbeQuery[];
  logs: string[];
  killed: Array<{ pid: number; signal: string }>;
  alive: { value: boolean };
  /** Configure each new query before the probe talks to it. */
  onQuery: { fn: (q: ProbeQuery, index: number) => void };
  throwOnCall: { value: unknown };
}

function setup(over: Partial<CatalogProbeDeps> = {}): Setup {
  const timers = new FakeTimers();
  const queries: ProbeQuery[] = [];
  const logs: string[] = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const alive = { value: false };
  const onQuery = { fn: (_q: ProbeQuery, _i: number): void => {} };
  const throwOnCall = { value: undefined as unknown };
  const queryFn: QueryFn = (p) => {
    if (throwOnCall.value !== undefined) throw throwOnCall.value;
    const q = new ProbeQuery(p);
    onQuery.fn(q, queries.length);
    queries.push(q);
    return q;
  };
  const processes: ProcessControl = {
    isAlive: () => alive.value,
    kill: (pid, signal) => killed.push({ pid, signal }),
  };
  const probe = createCatalogProbe({
    queryFn,
    binaryPath: '/bin/claude',
    env: { PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    neutralCwd: NEUTRAL,
    now: () => timers.now,
    timers,
    log: (m) => logs.push(m),
    processes,
    ...over,
  });
  return { probe, timers, queries, logs, killed, alive, onQuery, throwOnCall };
}

/** An in-memory file system for `readMcpConfig`. */
function memFs(files: Record<string, unknown>): CappedReadDeps {
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const text = (p: string): string => {
    const v = files[p];
    if (v === undefined) throw enoent();
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return { stat: async (p) => ({ size: text(p).length }), readFile: async (p) => text(p) };
}

async function snapshotOf(opts: { approval?: Record<string, unknown>; trusted?: boolean } = {}): Promise<McpSnapshot> {
  return readMcpConfig({
    cwd: CWD,
    env: {},
    home: HOME,
    managedDir: '/etc/mm',
    fs: memFs({
      [path.join(HOME, '.claude.json')]: {
        mcpServers: { userSrv: { command: 'SENTINEL_CMD_USER', args: ['SENTINEL_ARG'], env: { T: 'SENTINEL_ENV' } } },
        projects: { [CWD]: { hasTrustDialogAccepted: opts.trusted ?? true, mcpServers: { localSrv: { type: 'http', url: 'https://SENTINEL_URL_LOCAL', headers: { A: 'SENTINEL_HEADER' } } }, ...(opts.approval ?? {}) } },
        claudeAiMcpEverConnected: ['claude.ai Docs'],
      },
      [path.join(CWD, '.mcp.json')]: { mcpServers: { approvedProj: { command: 'SENTINEL_CMD_APPROVED' }, unapprovedProj: { command: 'SENTINEL_CMD_UNAPPROVED' }, disabledProj: { command: 'SENTINEL_CMD_DISABLED' } } },
    }),
  });
}

const APPROVAL = { enabledMcpjsonServers: ['approvedProj', 'disabledProj'], disabledMcpjsonServers: ['disabledProj'] };

function opts(q: ProbeQuery): Record<string, unknown> {
  return q.params.options as Record<string, unknown>;
}

const row = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, status, scope: 'dynamic', source: 'dynamic', config: { type: 'stdio', command: 'SENTINEL_LIVE_CMD' }, error: status === 'failed' ? 'SENTINEL_ERROR' : undefined, ...extra });

// --- catalog: trust ---------------------------------------------------------------------------------------------------

test('catalog, both trusted: runs in the project with user, project and local settings', async () => {
  const t = setup();
  const r = await t.probe.probeCatalog(CWD, YES);
  assert.equal(r.status, 'ok');
  assert.equal(t.queries.length, 1);
  const o = opts(t.queries[0]!);
  assert.equal(o['cwd'], CWD);
  assert.deepEqual(o['settingSources'], ['user', 'project', 'local']);
  if (r.status !== 'ok') return;
  assert.equal(r.projectLoaded, true);
  assert.equal(r.cached, false);
  assert.deepEqual(r.commands, t.queries[0]!.commands);
  assert.deepEqual(r.agents, t.queries[0]!.agents);
  assert.deepEqual(t.queries[0]!.calls.map((c) => c.method), ['initializationResult', 'supportedCommands', 'supportedAgents']);
});

test('catalog, untrusted (either flag false): neutral folder and user settings only; the project is never the cwd', async () => {
  for (const trust of [NO_WORKSPACE, NO_CLAUDE, { workspaceTrusted: false, claudeTrusted: false }]) {
    const t = setup();
    const r = await t.probe.probeCatalog(CWD, trust);
    assert.equal(r.status, 'ok');
    const o = opts(t.queries[0]!);
    assert.equal(o['cwd'], NEUTRAL);
    assert.deepEqual(o['settingSources'], ['user']);
    if (r.status === 'ok') assert.equal(r.projectLoaded, false);
    assert.equal(JSON.stringify(o).includes(CWD), false, 'the project folder is nowhere in the options');
  }
});

test('catalog: the neutral folder defaults to the home folder', async () => {
  const t = setup({ neutralCwd: undefined });
  await t.probe.probeCatalog(CWD, NO_CLAUDE);
  assert.equal(opts(t.queries[0]!)['cwd'], os.homedir());
});

test('catalog, no MCP: strictMcpConfig is true and mcpServers is empty, trusted or not', async () => {
  for (const trust of [YES, NO_CLAUDE]) {
    const t = setup();
    await t.probe.probeCatalog(CWD, trust);
    const o = opts(t.queries[0]!);
    assert.equal(o['strictMcpConfig'], true);
    assert.deepEqual(o['mcpServers'], {});
    assert.equal(t.queries[0]!.calls.some((c) => c.method === 'mcpServerStatus'), false, 'the catalog never even asks about MCP');
  }
});

test('catalog: a build without the calls fails with a fixed phrase; one missing call still returns the other list', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    (q as { supportedAgents?: unknown }).supportedAgents = undefined;
  };
  const r = await t.probe.probeCatalog(CWD, YES);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.ok(r.commands);
    assert.equal(r.agents, undefined);
  }
  const t2 = setup();
  t2.onQuery.fn = (q) => {
    (q as { supportedAgents?: unknown }).supportedAgents = undefined;
    (q as { supportedCommands?: unknown }).supportedCommands = undefined;
  };
  assert.deepEqual(await t2.probe.probeCatalog(CWD, YES), { status: 'failed', reason: 'this Claude Code version cannot list that' });
  assert.equal(t2.queries[0]!.closed, true);
});

test('catalog: lists are capped and a non-array result is left out', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.commands = Array.from({ length: 5000 }, (_, i) => ({ name: `c${i}` }));
    q.agents = { not: 'an array' };
  };
  const r = await t.probe.probeCatalog(CWD, YES);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.equal(r.commands?.length, 2000);
    assert.equal(r.agents, undefined);
  }
});

// --- MCP: which servers are started ---------------------------------------------------------------------------------------

test('mcp: strict config with explicit servers; an unapproved or disabled project server is not in mcpServers', async () => {
  const t = setup();
  const snap = await snapshotOf({ approval: APPROVAL });
  const r = await t.probe.probeMcpStatus(CWD, YES, snap);
  assert.equal(r.status, 'ok');
  const o = opts(t.queries[0]!);
  assert.equal(o['strictMcpConfig'], true);
  const started = Object.keys(o['mcpServers'] as object).sort();
  assert.deepEqual(started, ['approvedProj', 'localSrv', 'userSrv']);
  const text = JSON.stringify(o['mcpServers']);
  assert.equal(text.includes('SENTINEL_CMD_UNAPPROVED'), false);
  assert.equal(text.includes('SENTINEL_CMD_DISABLED'), false);
  assert.equal(text.includes('SENTINEL_CMD_APPROVED'), true, 'the approved one is passed (the SDK needs its command)');
  // The result says so: the blocked ones are disabled, not live.
  if (r.status !== 'ok') return;
  const m = Object.fromEntries(r.servers.map((s) => [s.name, s.status]));
  assert.equal(m['unapprovedProj'], 'disabled');
  assert.equal(m['disabledProj'], 'disabled');
});

test('mcp, untrusted: no project server is started even if approved and enable-all is set; user and local servers still are', async () => {
  for (const trust of [NO_WORKSPACE, NO_CLAUDE]) {
    const t = setup();
    const snap = await snapshotOf({ approval: { ...APPROVAL, enableAllProjectMcpServers: true } });
    const r = await t.probe.probeMcpStatus(CWD, trust, snap);
    const o = opts(t.queries[0]!);
    assert.deepEqual(Object.keys(o['mcpServers'] as object).sort(), ['localSrv', 'userSrv']);
    assert.equal(JSON.stringify(o).includes('SENTINEL_CMD_APPROVED'), false);
    assert.equal(o['cwd'], NEUTRAL, 'a project folder is only the cwd once it is trusted');
    assert.deepEqual(o['settingSources'], ['user']);
    if (r.status === 'ok') assert.equal(r.servers.find((s) => s.name === 'approvedProj')?.status, 'disabled');
  }
});

test('mcp, trusted: the project is the cwd (servers may use relative commands) but its settings are not loaded', async () => {
  const t = setup();
  await t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }));
  const o = opts(t.queries[0]!);
  assert.equal(o['cwd'], CWD);
  assert.deepEqual(o['settingSources'], ['user']);
});

// --- MCP: polling -------------------------------------------------------------------------------------------------------

test('mcp polling: pending first, then settled; every change is emitted; the query is closed afterwards', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.statusScript = [
      [row('userSrv', 'pending')],
      [row('userSrv', 'connected', { tools: [{ name: 'SENTINEL_TOOL' }, {}, {}] }), row('localSrv', 'pending'), row('claude.ai Docs', 'pending', { scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy' } })],
      [row('userSrv', 'connected', { tools: [{}, {}, {}] }), row('localSrv', 'failed'), row('claude.ai Docs', 'connected', { scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy' }, tools: [{}] })],
    ];
  };
  const updates: McpProbeUpdate[] = [];
  const p = t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }), (u) => updates.push(u));
  await settle();
  assert.equal(updates.length, 1, 'the first reading is out at once');
  assert.equal(updates[0]!.settled, false);
  const first = Object.fromEntries(updates[0]!.servers.map((s) => [s.name, s.status]));
  assert.equal(first['userSrv'], 'pending');
  assert.equal(first['localSrv'], 'pending', 'a started server with no row yet is pending');
  assert.equal(first['approvedProj'], 'pending');
  assert.equal(first['unapprovedProj'], 'disabled');
  assert.equal(t.queries[0]!.closed, false, 'still polling');

  await t.timers.advance(MCP_POLL_MS);
  assert.equal(updates.length, 2);
  assert.equal(updates[1]!.settled, false, 'localSrv and approvedProj have not reported or are pending');
  assert.equal(updates[1]!.servers.find((s) => s.name === 'userSrv')?.tools, 3);

  await t.timers.advance(MCP_POLL_MS);
  // The third script row still lacks `approvedProj`: it keeps the list unsettled until it reports or the time is up.
  assert.equal(updates.length, 3);
  assert.equal(updates[2]!.settled, false);
  t.queries[0]!.statusScript!.push([row('userSrv', 'connected', { tools: [{}] }), row('localSrv', 'failed'), row('approvedProj', 'connected'), row('claude.ai Docs', 'connected', { scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy' }, tools: [{}] })]);
  await t.timers.advance(MCP_POLL_MS);
  const r = await p;
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.settled, true);
  const m = Object.fromEntries(r.servers.map((s) => [s.name, s]));
  assert.deepEqual(m['userSrv'], { name: 'userSrv', scope: 'user', transport: 'stdio', status: 'connected', tools: 1 });
  assert.deepEqual(m['localSrv'], { name: 'localSrv', scope: 'local', transport: 'http', status: 'failed' });
  assert.deepEqual(m['approvedProj'], { name: 'approvedProj', scope: 'project', transport: 'stdio', status: 'connected' });
  assert.deepEqual(m['claude.ai Docs'], { name: 'claude.ai Docs', scope: 'cloud', transport: 'http', status: 'connected', tools: 1 });
  assert.equal(m['unapprovedProj']!.status, 'disabled');
  assert.equal(updates.at(-1)!.settled, true);
  assert.equal(t.queries[0]!.closed, true);
  assert.equal(t.timers.pending, 0, 'no timer is left behind');
  assert.equal(t.queries[0]!.calls.filter((c) => c.method === 'mcpServerStatus').length, 4);
  // No update ever carried a secret.
  assert.equal(JSON.stringify(updates).includes('SENTINEL'), false);
});

test('mcp polling stops after the poll window: what is still pending stays pending, and the result is not settled', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.statusScript = [[row('userSrv', 'pending')]];
  };
  const updates: McpProbeUpdate[] = [];
  const p = t.probe.probeMcpStatus(CWD, YES, await snapshotOf(), (u) => updates.push(u));
  await settle();
  await t.timers.advance(MCP_POLL_MAX_MS + MCP_POLL_MS);
  const r = await p;
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.settled, false);
  assert.equal(r.servers.find((s) => s.name === 'userSrv')?.status, 'pending');
  assert.equal(updates.length, 1, 'identical readings are not re-emitted');
  const reads = t.queries[0]!.calls.filter((c) => c.method === 'mcpServerStatus').length;
  assert.ok(reads >= MCP_POLL_MAX_MS / MCP_POLL_MS && reads <= MCP_POLL_MAX_MS / MCP_POLL_MS + 2, `about ${MCP_POLL_MAX_MS / MCP_POLL_MS} reads, got ${reads}`);
  assert.equal(t.queries[0]!.closed, true);
});

test('mcp: with nothing to start and nothing reported the first reading already settles; no more reads follow', async () => {
  const t = setup();
  const snap = await readMcpConfig({ cwd: CWD, env: {}, home: HOME, managedDir: '/etc/mm', fs: memFs({}) });
  const r = await t.probe.probeMcpStatus(CWD, YES, snap);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') assert.deepEqual(r.servers, []);
  assert.equal(t.queries[0]!.calls.filter((c) => c.method === 'mcpServerStatus').length, 1);
});

test('mcp: a build without mcpServerStatus fails, and the result is the offline list', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    (q as { mcpServerStatus?: unknown }).mcpServerStatus = undefined;
  };
  const r = await t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }));
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.reason, 'this Claude Code version cannot list that');
  const m = Object.fromEntries(r.servers.map((s) => [s.name, s.status]));
  assert.equal(m['userSrv'], 'unknown');
  assert.equal(m['unapprovedProj'], 'disabled');
  assert.equal(t.queries[0]!.closed, true);
});

// --- limits -------------------------------------------------------------------------------------------------------------

test('timeout: a probe that never answers fails with a fixed phrase after the hard timeout and is closed', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.initializationResult = () => new Promise(() => {});
  };
  const p = t.probe.probeCatalog(CWD, YES);
  await settle();
  await t.timers.advance(CATALOG_TIMEOUT_MS - 1);
  assert.equal(t.queries[0]!.closed, false);
  await t.timers.advance(1);
  assert.deepEqual(await p, { status: 'failed', reason: 'timed out' });
  assert.equal(t.queries[0]!.closed, true);
  assert.equal(t.timers.pending, 0);
  // A failure is not cached: the next call asks again.
  t.onQuery.fn = () => {};
  const r = await t.probe.probeCatalog(CWD, YES);
  assert.equal(r.status, 'ok');
  assert.equal(t.queries.length, 2);
});

test('timeout (mcp): a hang after some readings keeps what was seen, as a failed probe', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    let n = 0;
    q.mcpServerStatus = async () => (n++ === 0 ? [row('userSrv', 'connected')] : new Promise(() => {}));
  };
  const p = t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }));
  await settle();
  await t.timers.advance(20_000);
  const r = await p;
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') {
    assert.equal(r.reason, 'timed out');
    assert.equal(r.servers.find((s) => s.name === 'userSrv')?.status, 'connected');
  }
  assert.equal(t.queries[0]!.closed, true);
});

test('single-flight: concurrent catalog probes for one folder share one query and one result', async () => {
  const t = setup();
  const a = t.probe.probeCatalog(CWD, YES);
  const b = t.probe.probeCatalog(CWD, YES);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(t.queries.length, 1);
  assert.deepEqual(ra, rb);
  // A different folder is a different probe; two untrusted folders share the neutral one.
  await Promise.all([t.probe.probeCatalog('/other', YES), t.probe.probeCatalog('/a', NO_CLAUDE), t.probe.probeCatalog('/b', NO_WORKSPACE)]);
  assert.equal(t.queries.length, 3);
});

test('single-flight (mcp): a second caller joins the running probe and gets its updates too', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.statusScript = [[row('userSrv', 'pending')], [row('userSrv', 'connected'), row('localSrv', 'connected')]];
  };
  const snap = await snapshotOf();
  const u1: McpProbeUpdate[] = [];
  const u2: McpProbeUpdate[] = [];
  const a = t.probe.probeMcpStatus(CWD, YES, snap, (u) => u1.push(u));
  await settle();
  const b = t.probe.probeMcpStatus(CWD, YES, snap, (u) => u2.push(u));
  assert.equal(u2.length, 1, 'the latecomer gets the latest reading at once');
  await t.timers.advance(MCP_POLL_MS);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(t.queries.length, 1);
  assert.deepEqual(ra, rb);
  assert.equal(u1.length, 2);
  assert.equal(u2.length, 2);
});

test('single-flight: a throwing listener does not break the probe or the other listener', async () => {
  const t = setup();
  const seen: number[] = [];
  const snap = await snapshotOf();
  const a = t.probe.probeMcpStatus(CWD, YES, snap, () => {
    throw new Error('listener bug');
  });
  const b = t.probe.probeMcpStatus(CWD, YES, snap, (u) => seen.push(u.servers.length));
  const [ra] = await Promise.all([a, b]);
  assert.equal(ra.status, 'ok');
  assert.ok(seen.length >= 1);
});

test('cache: a catalog result is reused within its TTL, asked again after it, and `force` skips it', async () => {
  const t = setup();
  const first = await t.probe.probeCatalog(CWD, YES);
  t.timers.now += CATALOG_CACHE_TTL_MS - 1;
  const second = await t.probe.probeCatalog(CWD, YES);
  assert.equal(t.queries.length, 1);
  assert.equal(second.status === 'ok' && second.cached, true);
  assert.equal(first.status === 'ok' && second.status === 'ok' && second.at === first.at, true);
  t.timers.now += 1;
  const third = await t.probe.probeCatalog(CWD, YES);
  assert.equal(t.queries.length, 2);
  assert.equal(third.status === 'ok' && third.cached, false);
  await t.probe.probeCatalog(CWD, YES, { force: true });
  assert.equal(t.queries.length, 3);
  // Trust is part of the key: the same folder untrusted is a different result.
  await t.probe.probeCatalog(CWD, NO_CLAUDE);
  assert.equal(t.queries.length, 4);
  t.probe.clearCache();
  await t.probe.probeCatalog(CWD, YES);
  assert.equal(t.queries.length, 5);
});

test('cache (mcp): reused within its TTL (rebuilt against the current snapshot), asked again after it', async () => {
  const t = setup();
  const snap = await snapshotOf();
  const first = await t.probe.probeMcpStatus(CWD, YES, snap);
  assert.equal(first.status, 'ok');
  t.timers.now += MCP_CACHE_TTL_MS - 1;
  const seen: McpProbeUpdate[] = [];
  const second = await t.probe.probeMcpStatus(CWD, YES, snap, (u) => seen.push(u));
  assert.equal(t.queries.length, 1);
  assert.equal(second.status === 'ok' && second.cached, true);
  assert.equal(seen.length, 1, 'a cache hit still emits once');
  assert.deepEqual(second.servers, first.servers);
  t.timers.now += 1;
  await t.probe.probeMcpStatus(CWD, YES, snap);
  assert.equal(t.queries.length, 2);
  // A different set of started servers (the user changed an approval) is not served from the old result.
  const snap2 = await snapshotOf({ approval: { enableAllProjectMcpServers: true } });
  await t.probe.probeMcpStatus(CWD, YES, snap2);
  assert.equal(t.queries.length, 3);
});

// --- shutdown -----------------------------------------------------------------------------------------------------------

test('shutdown: after every probe the query is closed, its input ended, its abort signalled and no timer is left', async () => {
  const t = setup();
  await t.probe.probeCatalog(CWD, YES);
  await t.probe.probeMcpStatus(CWD, YES, await snapshotOf());
  assert.equal(t.queries.length, 2);
  await settle();
  for (const q of t.queries) {
    assert.equal(q.closed, true);
    assert.equal(q.params.options.abortController?.signal.aborted, true);
    assert.deepEqual(q.received, []);
  }
  assert.equal(t.timers.pending, 0);
});

test('shutdown: a stream that dies, a query() that throws, and a rejecting call all end in a fixed phrase with the query closed', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.initializationResult = () => new Promise(() => {});
    setImmediate(() => q.fail(new Error('SENTINEL_STREAM_ERROR /home/SENTINEL_PATH')));
  };
  const r = await t.probe.probeCatalog(CWD, YES);
  assert.equal(r.status, 'failed');
  assert.equal(JSON.stringify(r).includes('SENTINEL'), false);
  assert.equal(t.queries[0]!.closed, true);

  const t2 = setup();
  t2.throwOnCall.value = new Error('SENTINEL_THROWN');
  const r2 = await t2.probe.probeMcpStatus(CWD, YES, await snapshotOf());
  assert.equal(r2.status, 'failed');
  assert.equal(JSON.stringify(r2).includes('SENTINEL'), false);
  assert.equal(t2.logs.join('\n').includes('SENTINEL'), false);

  const t3 = setup();
  t3.onQuery.fn = (q) => {
    q.supportedCommands = async () => {
      throw new Error('SENTINEL_REJECT');
    };
  };
  const r3 = await t3.probe.probeCatalog(CWD, YES);
  assert.deepEqual(r3, { status: 'failed', reason: 'probe error (Error)' });
  assert.equal(t3.queries[0]!.closed, true);
  assert.equal(t3.logs.join('\n').includes('SENTINEL'), false);
});

test('shutdown: a child that outlives close() is killed after the grace period; one that exits is left alone', async () => {
  const t = setup();
  t.alive.value = true;
  const p = t.probe.probeCatalog(CWD, YES);
  await settle();
  await t.timers.advance(1_500);
  await p;
  assert.deepEqual(t.killed, [{ pid: 4242, signal: 'SIGKILL' }]);
  assert.ok(t.logs.some((l) => /still running after close, killed/.test(l)));

  const t2 = setup();
  t2.alive.value = false;
  await t2.probe.probeCatalog(CWD, YES);
  assert.deepEqual(t2.killed, []);

  // A pid that is not a plain child pid is never signalled.
  const t3 = setup();
  t3.alive.value = true;
  t3.onQuery.fn = (q) => {
    q.controlResults['initializationResult'] = { pid: 1 };
  };
  await t3.probe.probeCatalog(CWD, YES);
  assert.deepEqual(t3.killed, []);
  const t4 = setup();
  t4.alive.value = true;
  t4.onQuery.fn = (q) => {
    q.controlResults['initializationResult'] = { pid: process.pid };
  };
  await t4.probe.probeCatalog(CWD, YES);
  assert.deepEqual(t4.killed, []);
});

// --- options every probe carries --------------------------------------------------------------------------------------

test('options: no prompt, never bypassPermissions, no persistence, no tools, no hooks, the probe entrypoint and a clean env', async () => {
  const t = setup();
  await t.probe.probeCatalog(CWD, YES);
  await t.probe.probeCatalog(CWD, NO_CLAUDE);
  await t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }));
  await t.probe.probeMcpStatus(CWD, NO_WORKSPACE, await snapshotOf({ approval: APPROVAL }));
  assert.equal(t.queries.length, 4);
  for (const q of t.queries) {
    const o = opts(q);
    assert.equal(o['permissionMode'], 'default');
    assert.equal(o['persistSession'], false);
    assert.equal(o['strictMcpConfig'], true);
    assert.equal(o['pathToClaudeCodeExecutable'], '/bin/claude');
    assert.deepEqual(o['tools'], []);
    assert.deepEqual(o['allowedTools'], []);
    assert.deepEqual(o['settings'], { disableAllHooks: true });
    assert.equal('allowDangerouslySkipPermissions' in o, false);
    assert.equal('canUseTool' in o, false);
    assert.equal(JSON.stringify(o).includes('bypassPermissions'), false);
    const env = o['env'] as Record<string, string | undefined>;
    assert.equal(env['CLAUDE_CODE_ENTRYPOINT'], PROBE_ENTRYPOINT_TAG);
    assert.equal(env['CLAUDE_CODE_ENTRYPOINT'], 'claude-office-probe');
    assert.equal(env['CLAUDECODE'], undefined);
    assert.equal(env['CLAUDE_CODE_SESSION_ID'], undefined);
    assert.equal(env['PATH'], '/usr/bin');
    assert.deepEqual(q.received, [], 'no user message was ever sent');
    assert.equal(q.calls.some((c) => ['setModel', 'setPermissionMode', 'applyFlagSettings', 'interrupt'].includes(c.method)), false);
    assert.equal(q.interrupts, 0);
  }
});

// --- logging ------------------------------------------------------------------------------------------------------------

test('logs carry counts, ids and timings only: no names, paths, commands, urls, SDK text or stderr text', async () => {
  const t = setup();
  t.onQuery.fn = (q) => {
    q.statusScript = [[row('userSrv', 'failed'), row('localSrv', 'needs-auth'), row('approvedProj', 'connected')]];
    const stderr = q.params.options.stderr!;
    stderr('SENTINEL_STDERR /home/SENTINEL_PATH token=SENTINEL_TOKEN');
  };
  await t.probe.probeCatalog(CWD, YES);
  await t.probe.probeMcpStatus(CWD, YES, await snapshotOf({ approval: APPROVAL }));
  const log = t.logs.join('\n');
  assert.ok(t.logs.length >= 4);
  for (const bad of ['SENTINEL', 'userSrv', 'localSrv', 'approvedProj', 'claude.ai', CWD, NEUTRAL, 'https://', 'clear', 'Explore']) {
    assert.equal(log.includes(bad), false, `the log mentions ${bad}`);
  }
  assert.match(log, /catalog probe#1: ok in \d+ ms, 2 commands, 1 agents, project loaded/);
  assert.match(log, /mcp probe#2: ok in \d+ ms, 3 started, \d+ rows, /);
  assert.match(log, /probe#1 stderr: \d+ chars/);
});
