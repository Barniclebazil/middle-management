// MCP config reader and item builder (task 5.5): the sentinel test (no secret reaches an item, a snapshot dump or a log),
// scope and transport mapping, de-duplication, the approval and trust rules, and the caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { LIMITS, MCP_SCOPES, MCP_SERVER_ITEM_KEYS, MCP_STATUSES, MCP_TRANSPORTS } from '../src/shared/protocol.ts';
import type { McpServerItem } from '../src/shared/protocol.ts';
import {
  HostOnlyMcpConfigs,
  MAX_MCP_NAME_LIST,
  MAX_MCP_SERVERS_PER_SOURCE,
  mcpTransportOf,
  mergeMcpApproval,
  parseCloudConnectorNames,
  parseMcpApprovalPart,
  parseMcpServers,
  parseTrustAccepted,
} from '../src/claude/claudeConfig.ts';
import type { CappedReadDeps } from '../src/claude/claudeConfig.ts';
import {
  bothTrusted,
  buildMcpItems,
  isProjectServerApproved,
  makeMcpItem,
  mcpScopeOf,
  mcpStatusOf,
  parseMcpLiveStatuses,
  readMcpConfig,
  resolveMcpServers,
  selectServersToStart,
} from '../src/claude/mcpConfig.ts';
import type { McpSnapshot, McpTrust } from '../src/claude/mcpConfig.ts';

const HOME = '/home/u';
const CWD = '/work/proj';
const MANAGED = '/etc/mm';
const YES: McpTrust = { workspaceTrusted: true, claudeTrusted: true };

/** An in-memory file system for `readCappedJson`: path -> JSON value (or raw text). */
function memFs(files: Record<string, unknown>): CappedReadDeps {
  const text = (p: string): string | undefined => {
    const v = files[p];
    return v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v);
  };
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    stat: async (p) => {
      const t = text(p);
      if (t === undefined) throw enoent();
      return { size: t.length };
    },
    readFile: async (p) => {
      const t = text(p);
      if (t === undefined) throw enoent();
      return t;
    },
  };
}

const stdio = (cmd: string, extra: Record<string, unknown> = {}) => ({ command: cmd, args: ['--x'], ...extra });
const http = (url: string) => ({ type: 'http', url });

async function read(files: Record<string, unknown>, cwd = CWD): Promise<McpSnapshot> {
  return readMcpConfig({ cwd, env: {}, home: HOME, fs: memFs(files), managedDir: MANAGED });
}

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const MCP_JSON = path.join(CWD, '.mcp.json');
const USER_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PROJECT_SETTINGS = path.join(CWD, '.claude', 'settings.json');
const LOCAL_SETTINGS = path.join(CWD, '.claude', 'settings.local.json');
const MANAGED_MCP = path.join(MANAGED, 'managed-mcp.json');

function byName(items: readonly McpServerItem[]): Record<string, McpServerItem> {
  return Object.fromEntries(items.map((i) => [i.name, i]));
}

// --- the sentinel test --------------------------------------------------------------------------------------------------

test('sentinel: no command, args, env, headers, url, error or serverInfo reaches an item, a snapshot dump or an inspect', async () => {
  const snap = await read({
    [CLAUDE_JSON]: {
      oauthAccount: { emailAddress: 'SENTINEL_EMAIL', accountUuid: 'SENTINEL_ACCOUNT' },
      mcpServers: {
        userStdio: stdio('SENTINEL_CMD_USER', { args: ['SENTINEL_ARG_USER'], env: { TOKEN: 'SENTINEL_ENV_USER' } }),
        userHttp: { type: 'http', url: 'https://SENTINEL_URL_USER.example/mcp', headers: { Authorization: 'SENTINEL_HEADER_USER' } },
      },
      projects: {
        [CWD]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['projSse'],
          mcpServers: { localOne: stdio('SENTINEL_CMD_LOCAL', { env: { K: 'SENTINEL_ENV_LOCAL' } }) },
        },
      },
      claudeAiMcpEverConnected: ['claude.ai Docs'],
    },
    [MCP_JSON]: { mcpServers: { projSse: { type: 'sse', url: 'https://SENTINEL_URL_PROJECT.example/sse', headers: { 'X-Key': 'SENTINEL_HEADER_PROJECT' } } } },
    [USER_SETTINGS]: { env: { SECRET: 'SENTINEL_SETTINGS_ENV' }, enabledMcpjsonServers: ['projSse'] },
  });
  const live = parseMcpLiveStatuses([
    { name: 'userStdio', status: 'connected', scope: 'user', source: 'dynamic', serverInfo: { name: 'SENTINEL_SERVERINFO', version: 'SENTINEL_VERSION' }, config: { type: 'stdio', command: 'SENTINEL_CMD_LIVE', args: ['SENTINEL_ARG_LIVE'], env: { A: 'SENTINEL_ENV_LIVE' } }, tools: [{ name: 'SENTINEL_TOOL', description: 'SENTINEL_TOOLDESC' }] },
    { name: 'userHttp', status: 'failed', error: 'SENTINEL_ERROR spawn /home/SENTINEL_PATH ENOENT', config: { type: 'http', url: 'https://SENTINEL_URL_LIVE', headers: { A: 'SENTINEL_HEADER_LIVE' } } },
    { name: 'claude.ai Docs', status: 'connected', scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy', url: 'SENTINEL_PROXY_URL', id: 'SENTINEL_CONNECTOR_ID' }, tools: new Array(8).fill({ name: 'SENTINEL_T' }) },
    { name: 'extraLive', status: 'needs-auth', error: 'SENTINEL_ERROR2', config: { type: 'sse', url: 'SENTINEL_URL_EXTRA' } },
  ]);
  const dump = (v: unknown): string => JSON.stringify(v) + inspect(v, { depth: 10 });

  const { servers } = buildMcpItems({ snapshot: snap, trust: YES, live, settled: true });
  assert.ok(servers.length >= 6, 'a non-vacuous list');
  const text = dump(servers) + dump(live) + dump({ entries: snap.entries, approval: snap.approval, cloudNames: snap.cloudNames, hostOnly: snap.hostOnly }) + dump(snap);
  assert.equal(text.includes('SENTINEL'), false, 'a secret value leaked: ' + (/SENTINEL_\w+/.exec(text)?.[0] ?? ''));

  // Not vacuous: the host-only bodies do hold the commands, which is exactly what must never be forwarded.
  assert.equal(JSON.stringify(snap.hostOnly.get('user', 'userStdio')).includes('SENTINEL_CMD_USER'), true);
  assert.equal(JSON.stringify(snap.hostOnly.get('project', 'projSse')).includes('SENTINEL_HEADER_PROJECT'), true);
  assert.equal(String(snap.hostOnly), '[host-only MCP server definitions]');

  // Every item has exactly the contract's keys, no more.
  for (const item of servers) {
    for (const k of Object.keys(item)) assert.ok((MCP_SERVER_ITEM_KEYS as readonly string[]).includes(k), `unexpected key ${k}`);
    assert.ok((MCP_SCOPES as readonly string[]).includes(item.scope));
    assert.ok((MCP_TRANSPORTS as readonly string[]).includes(item.transport));
    assert.ok((MCP_STATUSES as readonly string[]).includes(item.status));
  }
  // The live data did come through, as status and count only.
  const m = byName(servers);
  assert.deepEqual(m['userStdio'], { name: 'userStdio', scope: 'user', transport: 'stdio', status: 'connected', tools: 1 });
  assert.deepEqual(m['userHttp'], { name: 'userHttp', scope: 'user', transport: 'http', status: 'failed' });
  assert.deepEqual(m['claude.ai Docs'], { name: 'claude.ai Docs', scope: 'cloud', transport: 'http', status: 'connected', tools: 8 });
  assert.deepEqual(m['extraLive'], { name: 'extraLive', scope: 'unknown', transport: 'sse', status: 'needsAuth' });
});

test('sentinel: planted values in the managed file and a tampered live row stay out as well', async () => {
  const snap = await read({
    [MANAGED_MCP]: { mcpServers: { corp: { type: 'http', url: 'https://SENTINEL_URL_MANAGED', headers: { A: 'SENTINEL_HEADER_MANAGED' } } } },
    [CLAUDE_JSON]: { mcpServers: { mine: stdio('SENTINEL_CMD_MINE') } },
  });
  const live = parseMcpLiveStatuses([{ name: 'corp', status: 'SENTINEL_STATUS_TEXT', scope: 'SENTINEL_SCOPE', source: 'SENTINEL_SOURCE', config: { type: 'SENTINEL_TYPE' }, tools: 'SENTINEL_NOT_AN_ARRAY' }]);
  const { servers } = buildMcpItems({ snapshot: snap, trust: YES, live, settled: true });
  assert.deepEqual(servers, [{ name: 'corp', scope: 'managed', transport: 'http', status: 'unknown' }]);
  assert.equal(JSON.stringify([servers, live, snap.entries]).includes('SENTINEL'), false);
});

// --- scope, transport and status mapping --------------------------------------------------------------------------------

test('transport: type maps to the contract; a command without a type is stdio; a URL without a type is unknown', () => {
  assert.equal(mcpTransportOf('stdio', true), 'stdio');
  assert.equal(mcpTransportOf('http', false), 'http');
  assert.equal(mcpTransportOf('sse', false), 'sse');
  assert.equal(mcpTransportOf('ws', false), 'ws');
  assert.equal(mcpTransportOf('sdk', false), 'sdk');
  assert.equal(mcpTransportOf('streamable-http', false), 'http');
  assert.equal(mcpTransportOf('claudeai-proxy', false), 'http');
  assert.equal(mcpTransportOf('sse-ide', false), 'sse');
  assert.equal(mcpTransportOf('ws-ide', false), 'ws');
  assert.equal(mcpTransportOf(undefined, true), 'stdio');
  assert.equal(mcpTransportOf(undefined, false), 'unknown');
  assert.equal(mcpTransportOf('carrier-pigeon', true), 'unknown');
  assert.equal(mcpTransportOf(7, true), 'unknown');
  assert.equal(mcpTransportOf('unknown', true), 'unknown');
});

test('scope: source wins over scope; claudeai is cloud; enterprise is managed; dynamic, agent, sdk and strangers are unknown', () => {
  assert.equal(mcpScopeOf('user', 'user'), 'user');
  assert.equal(mcpScopeOf('project', undefined), 'project');
  assert.equal(mcpScopeOf(undefined, 'local'), 'local');
  assert.equal(mcpScopeOf('plugin', undefined), 'plugin');
  assert.equal(mcpScopeOf('managed', undefined), 'managed');
  assert.equal(mcpScopeOf('enterprise', undefined), 'managed');
  assert.equal(mcpScopeOf('claudeai', 'claudeai'), 'cloud');
  assert.equal(mcpScopeOf('dynamic', 'user'), 'user', 'an unmapped source falls back to scope');
  assert.equal(mcpScopeOf('dynamic', 'dynamic'), 'unknown');
  assert.equal(mcpScopeOf('agent', undefined), 'unknown');
  assert.equal(mcpScopeOf('sdk', undefined), 'unknown');
  assert.equal(mcpScopeOf('user', 'claudeai'), 'user', 'source is preferred');
  assert.equal(mcpScopeOf(undefined, undefined), 'unknown');
  assert.equal(mcpScopeOf({}, 5), 'unknown');
});

test('status: needs-auth is needsAuth; anything unnamed is unknown, never text', () => {
  assert.equal(mcpStatusOf('connected'), 'connected');
  assert.equal(mcpStatusOf('failed'), 'failed');
  assert.equal(mcpStatusOf('pending'), 'pending');
  assert.equal(mcpStatusOf('disabled'), 'disabled');
  assert.equal(mcpStatusOf('needs-auth'), 'needsAuth');
  assert.equal(mcpStatusOf('weird'), 'unknown');
  assert.equal(mcpStatusOf(undefined), 'unknown');
  assert.equal(mcpStatusOf(3), 'unknown');
});

test('parseMcpLiveStatuses reduces rows: tools is a count, a repeated name keeps the first, bad rows are skipped', () => {
  const rows = parseMcpLiveStatuses([
    { name: 'a', status: 'connected', source: 'user', config: { type: 'stdio' }, tools: [{}, {}, {}] },
    { name: 'a', status: 'failed' },
    { name: 'b\u0000x', status: 'pending', scope: 'claudeai', config: { command: 'c' } },
    null,
    'x',
    { status: 'connected' },
    { name: '   ', status: 'connected' },
    { name: '__proto__', status: 'connected' },
  ]);
  assert.deepEqual(rows, [
    { name: 'a', status: 'connected', scope: 'user', transport: 'stdio', tools: 3 },
    { name: 'b x', status: 'pending', scope: 'cloud', transport: 'stdio' },
  ]);
  assert.deepEqual(parseMcpLiveStatuses('nope'), []);
  assert.deepEqual(parseMcpLiveStatuses(undefined), []);
});

test('makeMcpItem builds exactly the contract keys and coerces out-of-range values', () => {
  const item = makeMcpItem('n'.repeat(400), 'bogus' as never, 'carrier' as never, 'broken' as never, 3.5);
  assert.deepEqual(item, { name: 'n'.repeat(LIMITS.nameChars), scope: 'unknown', transport: 'unknown', status: 'unknown' });
  assert.deepEqual(makeMcpItem('x', 'user', 'stdio', 'connected', 4), { name: 'x', scope: 'user', transport: 'stdio', status: 'connected', tools: 4 });
  assert.deepEqual(Object.keys(makeMcpItem('x', 'user', 'stdio', 'connected', 4)).sort(), [...MCP_SERVER_ITEM_KEYS].sort());
  assert.equal('tools' in makeMcpItem('x', 'user', 'stdio', 'connected', -1), false);
  assert.equal(makeMcpItem('x', 'user', 'stdio', 'connected', 10 ** 9).tools, 100_000);
});

// --- reading the sources ------------------------------------------------------------------------------------------------

test('readMcpConfig reads user, local, project and managed servers (names, scopes, transports) in that source order', async () => {
  const snap = await read({
    [MANAGED_MCP]: { mcpServers: { corp: http('https://m.example') } },
    [CLAUDE_JSON]: {
      mcpServers: { uOne: stdio('u1'), uTwo: { type: 'sse', url: 'https://u2.example' } },
      projects: { [CWD]: { mcpServers: { lOne: stdio('l1') } }, '/other': { mcpServers: { notMine: stdio('x') } } },
    },
    [MCP_JSON]: { mcpServers: { pOne: stdio('p1'), pTwo: { type: 'http', url: 'https://p2.example' } } },
  });
  assert.deepEqual(snap.entries, [
    { name: 'corp', scope: 'managed', transport: 'http' },
    { name: 'lOne', scope: 'local', transport: 'stdio' },
    { name: 'pOne', scope: 'project', transport: 'stdio' },
    { name: 'pTwo', scope: 'project', transport: 'http' },
    { name: 'uOne', scope: 'user', transport: 'stdio' },
    { name: 'uTwo', scope: 'user', transport: 'sse' },
  ]);
  assert.equal(snap.managedPresent, true);
  assert.equal(snap.hostOnly.size, 6);
});

test('readMcpConfig: nothing exists, torn JSON, or the wrong shapes all give an empty snapshot, never a throw', async () => {
  for (const files of [{}, { [CLAUDE_JSON]: '{ torn', [MCP_JSON]: '[1,2]' }, { [CLAUDE_JSON]: { mcpServers: 5, projects: [] }, [MCP_JSON]: { mcpServers: 'x' } }, { [CLAUDE_JSON]: 'null' }]) {
    const snap = await read(files);
    assert.deepEqual(snap.entries, []);
    assert.equal(snap.managedPresent, false);
    assert.deepEqual(snap.approval, { enableAll: false, enabled: [], disabled: [], trustAccepted: false });
  }
});

test('readMcpConfig honours CLAUDE_CONFIG_DIR for .claude.json and settings.json (only paths.ts reads it)', async () => {
  const snap = await readMcpConfig({
    cwd: CWD,
    env: { CLAUDE_CONFIG_DIR: '/data/alt' },
    home: HOME,
    managedDir: MANAGED,
    fs: memFs({ [path.join('/data/alt', '.claude.json')]: { mcpServers: { alt: stdio('a') } }, [path.join('/data/alt', 'settings.json')]: { enabledMcpjsonServers: ['x'] }, [CLAUDE_JSON]: { mcpServers: { wrong: stdio('w') } } }),
  });
  assert.deepEqual(snap.entries.map((e) => e.name), ['alt']);
  assert.deepEqual(snap.approval.enabled, ['x']);
});

test('names: control characters, padding, over-long names and __proto__ are skipped; spaces inside are fine; bodies must be objects', () => {
  const sink = new HostOnlyMcpConfigs();
  const raw = JSON.parse(`{"ok name":{"command":"c"},"__proto__":{"command":"c"},"pad ":{"command":"c"},"tab\\tname":{"command":"c"},"${'x'.repeat(LIMITS.nameChars + 1)}":{"command":"c"},"str":"nope","nul":null,"arr":[1],"good":{"type":"http","url":"https://x"}}`);
  const entries = parseMcpServers(raw, 'user', sink);
  assert.deepEqual(entries.map((e) => e.name), ['ok name', 'good']);
  assert.equal(sink.size, 2);
});

test('server bodies are cut to the SDK keys: unknown keys (OAuth, helpers) are dropped; non-string values are dropped', () => {
  const sink = new HostOnlyMcpConfigs();
  parseMcpServers({
    a: { command: 'c', args: ['x', 7, 'y'], env: { A: '1', B: 2, __proto__: 'z' }, oauth: { clientId: 'q' }, headersHelper: 'run-me', timeout: 5000.7, alwaysLoad: true, extra: 1 },
    b: { type: 'sse', url: 'https://x', headers: { H: 'v', N: 4 }, command: 'ignored' },
    c: { type: 'sdk' },
    d: { command: '' },
    e: { type: 'http' },
  }, 'user', sink);
  assert.deepEqual(sink.get('user', 'a'), { type: 'stdio', command: 'c', args: ['x', 'y'], env: { A: '1' }, timeout: 5000, alwaysLoad: true });
  assert.deepEqual(sink.get('user', 'b'), { type: 'sse', url: 'https://x', headers: { H: 'v' } });
  assert.equal(sink.get('user', 'c'), undefined, 'an sdk server cannot be started from a file');
  assert.equal(sink.get('user', 'd'), undefined);
  assert.equal(sink.get('user', 'e'), undefined);
  // get() returns a copy
  const copy = sink.get('user', 'a')!;
  (copy['args'] as string[]).push('tampered');
  assert.deepEqual((sink.get('user', 'a') as { args: string[] }).args, ['x', 'y']);
});

// --- approval, trust, de-duplication ------------------------------------------------------------------------------------

test('approval rule: not disabled, and (enable-all or listed as enabled)', () => {
  const a = (over: Partial<{ enableAll: boolean; enabled: string[]; disabled: string[] }>) => ({ enableAll: false, enabled: [], disabled: [], ...over });
  assert.equal(isProjectServerApproved('s', a({})), false, 'nothing says yes');
  assert.equal(isProjectServerApproved('s', a({ enabled: ['s'] })), true);
  assert.equal(isProjectServerApproved('s', a({ enabled: ['other'] })), false);
  assert.equal(isProjectServerApproved('s', a({ enableAll: true })), true);
  assert.equal(isProjectServerApproved('s', a({ enableAll: true, disabled: ['s'] })), false, 'disabled beats enable-all');
  assert.equal(isProjectServerApproved('s', a({ enabled: ['s'], disabled: ['s'] })), false, 'disabled beats enabled');
  assert.equal(isProjectServerApproved('s', a({ enableAll: true, disabled: ['t'] })), true);
});

test('approval facts: lists from .claude.json and all three settings files are united; enableAll takes the highest explicit value', async () => {
  const snap = await read({
    [CLAUDE_JSON]: { projects: { [CWD]: { enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['z'], hasTrustDialogAccepted: true } } },
    [USER_SETTINGS]: { enabledMcpjsonServers: ['b'], enableAllProjectMcpServers: true },
    [PROJECT_SETTINGS]: { enabledMcpjsonServers: ['c', 'a'] },
    [LOCAL_SETTINGS]: { disabledMcpjsonServers: ['y'], enableAllProjectMcpServers: false },
  });
  assert.deepEqual(snap.approval, { enableAll: false, enabled: ['c', 'a', 'b'], disabled: ['y', 'z'], trustAccepted: true });
  // Without the local override the user's true stands.
  const snap2 = await read({ [USER_SETTINGS]: { enableAllProjectMcpServers: true }, [PROJECT_SETTINGS]: {} });
  assert.equal(snap2.approval.enableAll, true);
  // Only a real boolean counts.
  assert.equal(parseMcpApprovalPart({ enableAllProjectMcpServers: 'true' }).enableAll, undefined);
  assert.deepEqual(parseMcpApprovalPart({ enabledMcpjsonServers: 'x', disabledMcpjsonServers: [1, null, 'ok', ''] }), { enabled: [], disabled: ['ok'] });
  assert.deepEqual(mergeMcpApproval([], false), { enableAll: false, enabled: [], disabled: [], trustAccepted: false });
});

test('trust: hasTrustDialogAccepted must be true for exactly this folder; a parent is not enough; slash style is normalised', () => {
  const doc = { projects: { '/work': { hasTrustDialogAccepted: true }, [CWD]: { hasTrustDialogAccepted: false }, 'C:/Users/u/app': { hasTrustDialogAccepted: true }, '/yes/': { hasTrustDialogAccepted: true }, '/str': { hasTrustDialogAccepted: 'true' } } };
  assert.equal(parseTrustAccepted(doc, CWD), false);
  assert.equal(parseTrustAccepted(doc, '/work'), true);
  assert.equal(parseTrustAccepted(doc, '/work/proj/sub'), false);
  assert.equal(parseTrustAccepted(doc, 'c:\\Users\\u\\app'), true);
  assert.equal(parseTrustAccepted(doc, '/yes'), true);
  assert.equal(parseTrustAccepted(doc, '/str'), false);
  assert.equal(parseTrustAccepted(null, CWD), false);
  assert.equal(parseTrustAccepted({ projects: 3 }, CWD), false);
  assert.equal(bothTrusted({ workspaceTrusted: true, claudeTrusted: true }), true);
  assert.equal(bothTrusted({ workspaceTrusted: true, claudeTrusted: false }), false);
  assert.equal(bothTrusted({ workspaceTrusted: false, claudeTrusted: true }), false);
});

async function projectFixture(over: { approval?: Record<string, unknown>; trusted?: boolean; user?: Record<string, unknown>; local?: Record<string, unknown> } = {}): Promise<McpSnapshot> {
  return read({
    [CLAUDE_JSON]: {
      mcpServers: over.user ?? { shared: stdio('user-shared'), mine: stdio('mine') },
      projects: { [CWD]: { hasTrustDialogAccepted: over.trusted ?? true, ...(over.approval ?? {}), mcpServers: over.local ?? {} } },
    },
    [MCP_JSON]: { mcpServers: { okSrv: stdio('ok'), offSrv: stdio('off'), unlisted: stdio('un'), shared: http('https://proj-shared.example') } },
  });
}

test('project servers: only approved ones are shown as servers; unapproved, disabled and unlisted are disabled', async () => {
  const snap = await projectFixture({ approval: { enabledMcpjsonServers: ['okSrv', 'offSrv', 'shared'], disabledMcpjsonServers: ['offSrv'] } });
  const { servers } = buildMcpItems({ snapshot: snap, trust: YES });
  assert.deepEqual(byName(servers)['okSrv'], { name: 'okSrv', scope: 'project', transport: 'stdio', status: 'unknown' });
  assert.equal(byName(servers)['offSrv']?.status, 'disabled');
  assert.equal(byName(servers)['unlisted']?.status, 'disabled');
  assert.equal(byName(servers)['unlisted']?.scope, 'project');
  const start = selectServersToStart(snap, YES);
  assert.deepEqual(start.names.sort(), ['mine', 'okSrv', 'shared']);
  assert.equal(start.servers['offSrv'], undefined);
  assert.equal(start.servers['unlisted'], undefined);
});

test('project servers: enable-all approves every unlisted one, except those on the disabled list', async () => {
  const snap = await projectFixture({ approval: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['offSrv'] } });
  const start = selectServersToStart(snap, YES);
  assert.deepEqual(start.names.sort(), ['mine', 'okSrv', 'shared', 'unlisted'].sort());
  assert.equal(byName(buildMcpItems({ snapshot: snap, trust: YES }).servers)['offSrv']?.status, 'disabled');
});

test('untrusted: either trust flag false means no project server is ever started or live, whatever the approvals say', async () => {
  for (const trust of [{ workspaceTrusted: false, claudeTrusted: true }, { workspaceTrusted: true, claudeTrusted: false }, { workspaceTrusted: false, claudeTrusted: false }]) {
    const snap = await projectFixture({ approval: { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['okSrv'] } });
    const start = selectServersToStart(snap, trust);
    assert.deepEqual(start.names.sort(), ['mine', 'shared'], 'user servers only (the user-scope "shared" wins over the blocked project one)');
    assert.equal(JSON.stringify(start.servers).includes('"ok"'), false);
    const items = byName(buildMcpItems({ snapshot: snap, trust, live: [{ name: 'okSrv', status: 'connected', scope: 'project', transport: 'stdio' }], settled: true }).servers);
    assert.equal(items['okSrv']?.status, 'disabled', 'a live row cannot turn a blocked project server on');
    assert.equal(items['unlisted']?.status, 'disabled');
  }
  // The same facts are different when the folder is trusted in Claude Code but the snapshot says it is not.
  const snap = await projectFixture({ trusted: false, approval: { enableAllProjectMcpServers: true } });
  assert.equal(snap.approval.trustAccepted, false);
});

test('de-duplication: local beats project beats user; the unapproved project server gives way to the user one; managed is exclusive', async () => {
  const snap = await projectFixture({
    approval: { enabledMcpjsonServers: ['shared', 'okSrv'] },
    user: { shared: stdio('user-shared'), dup: stdio('user-dup'), onlyUser: stdio('u') },
    local: { dup: http('https://local-dup.example') },
  });
  const r = resolveMcpServers(snap, YES).map((x) => `${x.entry.scope}:${x.entry.name}:${x.allowed ? 'on' : 'blocked'}`);
  assert.deepEqual(r, ['local:dup:on', 'project:okSrv:on', 'project:shared:on', 'user:onlyUser:on', 'project:offSrv:blocked', 'project:unlisted:blocked']);
  // The same project server, not approved: the user one stands in and the project one is not listed twice.
  const snap2 = await projectFixture({ user: { shared: stdio('user-shared') } });
  const r2 = resolveMcpServers(snap2, YES).map((x) => `${x.entry.scope}:${x.entry.name}:${x.allowed ? 'on' : 'blocked'}`);
  assert.ok(r2.includes('user:shared:on'));
  assert.equal(r2.filter((x) => x.endsWith(':shared:blocked') || x.startsWith('project:shared')).length, 0);
  // Every name once.
  const names = buildMcpItems({ snapshot: snap, trust: YES }).servers.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);

  const managed = await read({
    [MANAGED_MCP]: { mcpServers: { corp: http('https://corp.example'), shared: stdio('managed-shared') } },
    [CLAUDE_JSON]: { mcpServers: { shared: stdio('u'), mine: stdio('m') } },
    [MCP_JSON]: { mcpServers: { projOnly: stdio('p') } },
  });
  assert.deepEqual(resolveMcpServers(managed, YES).map((x) => `${x.entry.scope}:${x.entry.name}`), ['managed:corp', 'managed:shared']);
  assert.deepEqual(selectServersToStart(managed, YES).names, ['corp', 'shared']);
  // An empty managed file locks everything.
  const locked = await read({ [MANAGED_MCP]: { mcpServers: {} }, [CLAUDE_JSON]: { mcpServers: { mine: stdio('m') } } });
  assert.deepEqual(buildMcpItems({ snapshot: locked, trust: YES }).servers, []);
});

// --- status building ----------------------------------------------------------------------------------------------------

test('offline: allowed servers are unknown, blocked project servers disabled, cloud names unknown; unstartable ones are unknown even with a live list', async () => {
  const snap = await read({
    [CLAUDE_JSON]: { mcpServers: { u: stdio('c'), odd: { type: 'sdk' }, urlOnly: { url: 'https://x' } }, claudeAiMcpEverConnected: ['claude.ai One', 'u'] },
    [MCP_JSON]: { mcpServers: { p: stdio('c') } },
  });
  const offline = buildMcpItems({ snapshot: snap, trust: YES });
  assert.deepEqual(offline.servers, [
    { name: 'u', scope: 'user', transport: 'stdio', status: 'unknown' },
    { name: 'odd', scope: 'user', transport: 'sdk', status: 'unknown' },
    { name: 'urlOnly', scope: 'user', transport: 'unknown', status: 'unknown' },
    { name: 'p', scope: 'project', transport: 'stdio', status: 'disabled' },
    { name: 'claude.ai One', scope: 'cloud', transport: 'http', status: 'unknown' },
  ]);
  assert.equal(offline.truncated, false);
});

test('live: pending while the list is unsettled and a started server has no row; unknown once settled; rows overlay status and tool count', async () => {
  const snap = await read({ [CLAUDE_JSON]: { mcpServers: { a: stdio('c'), b: stdio('c') } } });
  const first = buildMcpItems({ snapshot: snap, trust: YES, live: [], settled: false });
  assert.deepEqual(first.servers.map((s) => s.status), ['pending', 'pending']);
  const mid = buildMcpItems({ snapshot: snap, trust: YES, live: [{ name: 'a', status: 'connected', scope: 'unknown', transport: 'stdio', tools: 12 }], settled: false });
  assert.deepEqual(mid.servers, [
    { name: 'a', scope: 'user', transport: 'stdio', status: 'connected', tools: 12 },
    { name: 'b', scope: 'user', transport: 'stdio', status: 'pending' },
  ]);
  const done = buildMcpItems({ snapshot: snap, trust: YES, live: [{ name: 'a', status: 'failed', scope: 'unknown', transport: 'unknown' }], settled: true });
  assert.deepEqual(done.servers.map((s) => s.status), ['failed', 'unknown']);
});

test('live rows the files did not define are added by their mapped scope; a shadowed file name is never re-added from a live row', async () => {
  const snap = await read({
    [CLAUDE_JSON]: { mcpServers: { a: stdio('c') }, claudeAiMcpEverConnected: ['claude.ai Docs', 'claude.ai Other'] },
    [MCP_JSON]: { mcpServers: { blockedProj: stdio('c') } },
  });
  const live = parseMcpLiveStatuses([
    { name: 'claude.ai Docs', status: 'connected', scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy' }, tools: [{}, {}] },
    { name: 'blockedProj', status: 'connected', scope: 'project', source: 'project', config: { type: 'stdio', command: 'x' } },
    { name: 'plug', status: 'pending', source: 'plugin', config: { type: 'stdio', command: 'x' } },
  ]);
  const m = byName(buildMcpItems({ snapshot: snap, trust: { workspaceTrusted: true, claudeTrusted: false }, live, settled: true }).servers);
  assert.deepEqual(m['claude.ai Docs'], { name: 'claude.ai Docs', scope: 'cloud', transport: 'http', status: 'connected', tools: 2 });
  assert.deepEqual(m['claude.ai Other'], { name: 'claude.ai Other', scope: 'cloud', transport: 'http', status: 'unknown' });
  assert.deepEqual(m['plug'], { name: 'plug', scope: 'plugin', transport: 'stdio', status: 'pending' });
  assert.equal(m['blockedProj']?.status, 'disabled');
});

// --- caps ---------------------------------------------------------------------------------------------------------------

test('caps: servers per source, the item list, approval lists, connector names and live rows are all limited', async () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < MAX_MCP_SERVERS_PER_SOURCE + 50; i++) many[`s${i}`] = stdio('c');
  const snap = await read({
    [CLAUDE_JSON]: { mcpServers: many, claudeAiMcpEverConnected: Array.from({ length: 800 }, (_, i) => `conn${i}`) },
    [MCP_JSON]: { mcpServers: many },
    [USER_SETTINGS]: { enabledMcpjsonServers: Array.from({ length: MAX_MCP_NAME_LIST + 100 }, (_, i) => `e${i}`) },
  });
  assert.equal(snap.entries.filter((e) => e.scope === 'user').length, MAX_MCP_SERVERS_PER_SOURCE);
  assert.equal(snap.entries.filter((e) => e.scope === 'project').length, MAX_MCP_SERVERS_PER_SOURCE);
  assert.equal(snap.approval.enabled.length, MAX_MCP_NAME_LIST);
  assert.equal(snap.cloudNames.length, LIMITS.mcpServers);
  const r = buildMcpItems({ snapshot: snap, trust: YES });
  assert.equal(r.servers.length, LIMITS.mcpServers);
  assert.equal(r.truncated, true);
  const few = buildMcpItems({ snapshot: await read({ [CLAUDE_JSON]: { mcpServers: { a: stdio('c') } } }), trust: YES });
  assert.equal(few.truncated, false);
  // Live rows are capped too.
  const live = parseMcpLiveStatuses(Array.from({ length: 1000 }, (_, i) => ({ name: `r${i}`, status: 'connected' })));
  assert.equal(live.length, LIMITS.mcpServers * 2);
  assert.equal(buildMcpItems({ snapshot: snap, trust: YES, live, settled: true }).servers.length, LIMITS.mcpServers);
  assert.deepEqual(parseCloudConnectorNames({ claudeAiMcpEverConnected: ['a', 'a', 3, '', 'b'] }), ['a', 'b']);
});

test('only the approved servers go to the SDK, as whitelisted definitions (a copy: changing it does not change the store)', async () => {
  const snap = await projectFixture({ approval: { enabledMcpjsonServers: ['okSrv'] } });
  const a = selectServersToStart(snap, YES);
  assert.deepEqual(a.names.sort(), ['mine', 'okSrv', 'shared']);
  assert.deepEqual(a.servers['okSrv'], { type: 'stdio', command: 'ok', args: ['--x'] });
  a.servers['okSrv']!['command'] = 'tampered';
  assert.equal(selectServersToStart(snap, YES).servers['okSrv']!['command'], 'ok');
});

test('PROJECT_CLAUDE_DIR lives in paths.ts as a plain project-relative folder name, and the catalog readers use it', async () => {
  const paths = await import('../src/claude/paths.ts');
  assert.equal(paths.PROJECT_CLAUDE_DIR, '.claude');
  assert.equal(path.isAbsolute(paths.PROJECT_CLAUDE_DIR), false);
  const catalog = await import('../src/claude/catalog.ts');
  assert.equal('PROJECT_CLAUDE_DIR' in catalog, false, 'catalog.ts no longer defines its own copy');
  // Resolved first, so the folders carry the same drive on Windows as the `.claude` they are compared with.
  const proj = path.resolve('/work/proj');
  assert.equal(catalog.projectClaudeDirs(proj, path.resolve('/home/u'), path.resolve('/home/u/.claude'))[0], path.join(proj, '.claude'));
});
