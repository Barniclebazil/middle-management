// The Round B request router (task 5.6), against fakes for the editor, git and the SDK probe, a real FileRoom and a real
// (temporary) disk: routing and reqId echo, file safety (outside, non-file, unknown root), the fileId registry, the four
// catalog sections with probe success and failure, trust, MCP updates with the sentinel test, demo refusals, visibility
// and logs. No vscode, no Claude Code process.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRoom } from '../src/host/fileRoom.ts';
import { FileIdRegistry, OFFICE_REQUEST_TYPES, createOfficeRequests } from '../src/host/officeRequests.ts';
import type { CatalogProbeLike, GitDiffResult, OfficeRequests, OfficeRequestsDeps } from '../src/host/officeRequests.ts';
import { routeWebviewMessage } from '../src/host/messageRouter.ts';
import { DEMO_REFUSAL } from '../src/host/demoGuard.ts';
import { createCatalogProbe } from '../src/manager/catalogProbe.ts';
import type { CatalogProbeResult, McpProbeResult, McpProbeUpdate } from '../src/manager/catalogProbe.ts';
import type { QueryFn } from '../src/manager/sessionRunner.ts';
import type { McpTrust } from '../src/claude/mcpConfig.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import type { HostToWebview, McpServerItem, WebviewToHost } from '../src/shared/protocol.ts';
import { FakeQuery } from './manager-fakes.ts';

// ---- fixtures -----------------------------------------------------------------------------------------------------

const made: string[] = [];
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true });
});

const skillText = (name: string, desc: string): string => `---\nname: ${name}\ndescription: ${desc}\n---\nBODY_${name}\n`;

const SENTINELS = ['SENTINEL_CMD', 'SENTINEL_ARG', 'SENTINEL_ENV', 'SENTINEL_URL', 'SENTINEL_HDR', 'SENTINEL_ERR', 'SENTINEL_RAW'];

/** Rows `supportedCommands()` may return, with extra keys that must never be forwarded. */
const SDK_COMMANDS = [
  { name: 'clear', description: 'Clear the conversation', argumentHint: '', builtin: true },
  { name: 'user-skill', description: 'From the SDK', argumentHint: '', extra: 'SENTINEL_RAW' },
];
const SDK_AGENTS = [
  { name: 'Explore', description: 'Looks around', model: 'inherit', extra: 'SENTINEL_RAW' },
  { name: 'helper', description: 'Helps', extra: 'SENTINEL_RAW' },
];

type Posted = HostToWebview;
type OfK<K extends HostToWebview['type']> = Extract<HostToWebview, { type: K }>;

class FakeProbe implements CatalogProbeLike {
  catalogCalls: Array<{ cwd: string; trust: McpTrust; force: boolean | undefined }> = [];
  mcpCalls: Array<{ cwd: string; trust: McpTrust; force: boolean | undefined }> = [];
  catalogResult: () => Promise<CatalogProbeResult> = async () => ({ status: 'ok', commands: SDK_COMMANDS, agents: SDK_AGENTS, projectLoaded: true, at: 0, elapsedMs: 1, cached: false });
  /** Called with the offline-or-live updates the fake probe emits for an MCP request. */
  mcpScript: (onUpdate: (u: McpProbeUpdate) => void) => Promise<void> = async () => {};
  gate: Promise<void> | undefined;

  probeCatalog: CatalogProbeLike['probeCatalog'] = async (cwd, trust, opts) => {
    this.catalogCalls.push({ cwd, trust, force: opts?.force });
    await this.gate;
    return this.catalogResult();
  };

  probeMcpStatus: CatalogProbeLike['probeMcpStatus'] = async (cwd, trust, _snapshot, onUpdate, opts) => {
    this.mcpCalls.push({ cwd, trust, force: opts?.force });
    let last: McpProbeUpdate = { servers: [], truncated: false, settled: true };
    await this.mcpScript((u) => {
      last = u;
      onUpdate?.(u);
    });
    const res: McpProbeResult = { ...last, status: 'ok', at: 0, elapsedMs: 0, cached: false };
    return res;
  };
}

interface Harness {
  base: string;
  home: string;
  ws: string;
  other: string;
  neutral: string;
  posted: Posted[];
  logs: string[];
  opened: string[];
  diffs: string[];
  probe: FakeProbe;
  room: FileRoom;
  requests: OfficeRequests;
  state: { trusted: boolean; demo: boolean; folders: string[]; git: GitDiffResult | 'throw'; openFails: boolean };
  send(msg: WebviewToHost, opts?: { force?: boolean }): Promise<Posted[]>;
  /** The root id of a kind and folder, via `getFileRoots`. */
  rootIdOf(dir: string): Promise<string>;
}

async function harness(over: { noWorkspace?: boolean; visible?: boolean; maxFileIds?: number; claudeJson?: (ws: string) => unknown; probeDeps?: Partial<OfficeRequestsDeps> } = {}): Promise<Harness> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-office-req-')));
  made.push(base);
  const home = path.join(base, 'home');
  const ws = path.join(base, 'ws');
  const other = path.join(base, 'other');
  const neutral = path.join(base, 'neutral');
  const put = async (rel: string, text: string): Promise<void> => {
    const f = path.join(base, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  };
  await fs.mkdir(neutral, { recursive: true });
  await put('home/.claude/skills/user-skill/SKILL.md', skillText('user-skill', 'A user skill'));
  await put('home/.claude/agents/helper.md', '---\nname: helper\ndescription: Helps\ntools: Read\n---\nBODY\n');
  await put('home/.claude/CLAUDE.md', 'user instructions\n');
  await put('home/.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
  await put('ws/CLAUDE.md', 'project instructions\n');
  await put('ws/.claude/skills/ws-skill/SKILL.md', skillText('ws-skill', 'A project skill'));
  await put('ws/src/main.txt', 'hello from main\n');
  await put('ws/.env', 'TOKEN=SENTINEL_RAW\n');
  await put('other/notes.txt', 'other notes\n');
  await put('outside/secret.txt', 'outside text\n');
  await fs.symlink(path.join(base, 'outside'), path.join(ws, 'escape'));
  await fs.symlink(path.join(ws, 'src', 'main.txt'), path.join(ws, 'link.txt'));
  const claudeJson = over.claudeJson?.(ws) ?? {
    mcpServers: {
      userSrv: { command: 'SENTINEL_CMD', args: ['SENTINEL_ARG'], env: { K: 'SENTINEL_ENV' } },
      webSrv: { type: 'http', url: 'https://example.invalid/SENTINEL_URL', headers: { Authorization: 'SENTINEL_HDR' } },
    },
    projects: { [ws]: { hasTrustDialogAccepted: true } },
  };
  await put('home/.claude.json', JSON.stringify(claudeJson));

  const posted: Posted[] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  const diffs: string[] = [];
  const probe = new FakeProbe();
  const state: Harness['state'] = { trusted: true, demo: false, folders: over.noWorkspace === true ? [] : [ws], git: { ok: true }, openFails: false };
  const room = new FileRoom({ homeDir: home, claudeHome: path.join(home, '.claude'), log: (l) => logs.push(l) });
  const requests = createOfficeRequests({
    room,
    post: (m) => posted.push(m),
    workspaceFolders: () => state.folders,
    workspaceTrusted: () => state.trusted,
    statKind: async (p) => {
      try {
        const st = await fs.stat(p);
        return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
      } catch {
        return undefined;
      }
    },
    openInEditor: async (p) => {
      if (state.openFails) throw Object.assign(new Error(`cannot open ${p}`), { code: 'EOPEN' });
      opened.push(p);
    },
    openGitDiff: async (p) => {
      diffs.push(p);
      if (state.git === 'throw') throw new Error(`git broke at ${p}`);
      return state.git;
    },
    probe,
    neutralCwd: () => neutral,
    isDemo: () => state.demo,
    visible: over.visible ?? true,
    home,
    env: {},
    ...(over.maxFileIds === undefined ? {} : { maxFileIds: over.maxFileIds }),
    log: (l) => logs.push(l),
    ...over.probeDeps,
  });
  await requests.refreshRoots();
  posted.length = 0;
  const h: Harness = {
    base, home, ws, other, neutral, posted, logs, opened, diffs, probe, room, requests, state,
    async send(msg, opts) {
      const from = posted.length;
      await requests.handle(msg, opts);
      return posted.slice(from);
    },
    async rootIdOf(dir) {
      const real = await fs.realpath(dir);
      const root = room.getRoots().find((r) => r.projectPath === real);
      assert.ok(root, 'root registered');
      return root.rootId;
    },
  };
  return h;
}

const rid = (() => {
  let n = 0;
  return (): string => `q${++n}`;
})();

/** The first workspace root's id. */
async function wsRoot(h: Harness): Promise<string> {
  return h.rootIdOf(h.ws);
}

async function catalogOf(h: Harness, section: 'skills' | 'agents' | 'handbook' | 'mcp', rootId?: string): Promise<OfK<'catalog'>[]> {
  const reqId = rid();
  const out = await h.send({ type: 'getCatalog', reqId, section, ...(rootId === undefined ? {} : { rootId }) });
  for (const m of out) assert.ok(m.type === 'catalog' && m.reqId === reqId, `reply is a catalog for ${reqId}`);
  return out as OfK<'catalog'>[];
}

function skillNames(c: OfK<'catalog'>): string[] {
  assert.equal(c.section, 'skills');
  return c.section === 'skills' ? [...c.skills.map((s) => s.name), ...c.commands.map((s) => s.name)] : [];
}

// ---- routing and reqId echo ---------------------------------------------------------------------------------------

test('handles() is true for the seven Round B types and nothing else', async () => {
  const h = await harness();
  const seven: WebviewToHost[] = [
    { type: 'getFileRoots', reqId: 'a' },
    { type: 'listDir', reqId: 'a', rootId: 'r1', relPath: '' },
    { type: 'readFile', reqId: 'a', rootId: 'r1', relPath: 'x' },
    { type: 'openFile', rootId: 'r1', relPath: 'x' },
    { type: 'openDiff', rootId: 'r1', relPath: 'x' },
    { type: 'getCatalog', reqId: 'a', section: 'skills' },
    { type: 'openConfigFile', fileId: 'f' },
  ];
  assert.deepEqual(seven.map((m) => m.type), [...OFFICE_REQUEST_TYPES]);
  for (const m of seven) assert.equal(h.requests.handles(m), true, m.type);
  for (const m of [{ type: 'ready' }, { type: 'listProjects' }, { type: 'refreshUsage' }, { type: 'getFrontDesk', reqId: 'a' }] as WebviewToHost[]) assert.equal(h.requests.handles(m), false, m.type);
  // A message that is not ours is ignored without a reply.
  assert.deepEqual(await h.send({ type: 'ready' }), []);
});

test('logs never echo a forged rootId, they say <invalid>', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  for (const bad of ['../r1', '__proto__', 'r999']) {
    await h.send({ type: 'openFile', rootId: bad, relPath: 'src/main.txt' });
    await h.send({ type: 'openDiff', rootId: bad, relPath: 'src/main.txt' });
    await h.send({ type: 'listDir', reqId: 'x1', rootId: bad, relPath: '' });
  }
  await h.send({ type: 'openFile', rootId, relPath: 'src/main.txt' });
  const text = h.logs.join('\n');
  for (const bad of ['../r1', '__proto__', 'r999']) assert.ok(!text.includes(bad), `log must not contain ${bad}`);
  assert.match(text, /openFile root=<invalid> refused/);
  assert.match(text, new RegExp(`openFile root=${rootId} ok`));
});

test('getFileRoots, listDir and readFile echo the reqId and answer from the file room', async () => {
  const h = await harness();
  const [roots] = await h.send({ type: 'getFileRoots', reqId: 'g1' });
  assert.equal(roots?.type, 'fileRoots');
  assert.equal((roots as OfK<'fileRoots'>).reqId, 'g1');
  const rootId = await wsRoot(h);
  assert.deepEqual((roots as OfK<'fileRoots'>).roots.map((r) => [r.rootId, r.kind]), [[rootId, 'workspace']]);

  const [dir] = await h.send({ type: 'listDir', reqId: 'l1', rootId, relPath: 'src' });
  assert.equal(dir?.type, 'dirListing');
  const listing = dir as OfK<'dirListing'>;
  assert.deepEqual([listing.reqId, listing.rootId, listing.relPath, listing.truncated], ['l1', rootId, 'src', false]);
  assert.deepEqual(listing.entries.map((e) => e.name), ['main.txt']);

  const [file] = await h.send({ type: 'readFile', reqId: 'f1', rootId, relPath: 'src/main.txt' });
  const text = file as OfK<'fileText'>;
  assert.deepEqual([text.type, text.reqId, text.rootId, text.relPath, text.text], ['fileText', 'f1', rootId, 'src/main.txt', 'hello from main\n']);
  assert.equal(text.size, 'hello from main\n'.length);

  // A secret file is not read: the flag comes through.
  const [secret] = await h.send({ type: 'readFile', reqId: 'f2', rootId, relPath: '.env' });
  assert.equal((secret as OfK<'fileText'>).secret, true);
  assert.equal((secret as OfK<'fileText'>).text, undefined);
  assert.ok(!JSON.stringify(secret).includes('SENTINEL_RAW'));
});

test('failures answer error{reqId} with short path-free text', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  const cases: WebviewToHost[] = [
    { type: 'listDir', reqId: 'e1', rootId: 'r999', relPath: '' },
    { type: 'readFile', reqId: 'e2', rootId: 'r999', relPath: 'x' },
    { type: 'listDir', reqId: 'e3', rootId, relPath: 'nope' },
    { type: 'readFile', reqId: 'e4', rootId, relPath: 'src' }, // a folder
    { type: 'listDir', reqId: 'e5', rootId, relPath: 'escape' }, // symlink out of the root
    { type: 'readFile', reqId: 'e6', rootId, relPath: 'escape/secret.txt' },
    { type: 'getCatalog', reqId: 'e7', section: 'skills', rootId: 'r999' },
    { type: 'readFile', reqId: 'e8', rootId, relPath: '../outside/secret.txt' }, // past the validator on purpose
  ];
  for (const msg of cases) {
    const [out, ...rest] = await h.send(msg);
    assert.equal(rest.length, 0);
    assert.equal(out?.type, 'error', msg.type);
    const e = out as OfK<'error'>;
    assert.equal(e.reqId, (msg as { reqId: string }).reqId);
    assert.ok(e.message.length > 0 && e.message.length <= LIMITS.errorChars);
    assert.ok(!e.message.includes(h.base) && !e.message.includes('secret.txt'), e.message);
  }
});

// ---- openFile / openDiff ------------------------------------------------------------------------------------------

test('openFile opens the resolved real path, and a link opens its target', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  assert.deepEqual(await h.send({ type: 'openFile', rootId, relPath: 'src/main.txt' }), []);
  assert.deepEqual(await h.send({ type: 'openFile', rootId, relPath: 'link.txt' }), []);
  const real = path.join(h.ws, 'src', 'main.txt');
  assert.deepEqual(h.opened, [real, real]);
  // A secret file may still be opened: that is the user's own editor.
  await h.send({ type: 'openFile', rootId, relPath: '.env' });
  assert.equal(h.opened[2], path.join(h.ws, '.env'));
});

test('openFile and openDiff refuse an unknown root, an outside path, a bad path, a missing file and a non-file, with an id-less error', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  for (const type of ['openFile', 'openDiff'] as const) {
    for (const [rid2, rel] of [
      ['r999', 'src/main.txt'], // unknown root
      [rootId, 'escape/secret.txt'], // a link leaving the root
      [rootId, '../outside/secret.txt'], // a bad path that got past the validator
      [rootId, '/etc/passwd'],
      [rootId, 'gone.txt'], // missing
      [rootId, 'src'], // a folder
      [rootId, ''], // the root itself
    ] as const) {
      const out = await h.send({ type, rootId: rid2, relPath: rel });
      assert.equal(out.length, 1, `${type} ${rel}`);
      const e = out[0] as OfK<'error'>;
      assert.equal(e.type, 'error');
      assert.deepEqual(Object.keys(e).sort(), ['message', 'type'], 'no ids on a toast');
      assert.ok(!e.message.includes(h.base));
    }
  }
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.diffs, []);
});

test('a non-file that the file room resolves (a FIFO) is refused too', async () => {
  const h = await harness({
    probeDeps: { statKind: async () => 'other' },
  });
  const rootId = await wsRoot(h);
  for (const type of ['openFile', 'openDiff'] as const) {
    const out = await h.send({ type, rootId, relPath: 'src/main.txt' });
    assert.equal((out[0] as OfK<'error'>).message, 'That is not a regular file.');
  }
  assert.deepEqual([h.opened, h.diffs], [[], []]);
});

test('openDiff passes the real path to the git adapter and turns its refusals into friendly errors', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  assert.deepEqual(await h.send({ type: 'openDiff', rootId, relPath: 'link.txt' }), []);
  assert.deepEqual(h.diffs, [path.join(h.ws, 'src', 'main.txt')]);
  const expected: Array<[GitDiffResult | 'throw', RegExp]> = [
    [{ ok: false, reason: 'noGit' }, /Git is not available/],
    [{ ok: false, reason: 'noRepo' }, /not in a git repository/],
    [{ ok: false, reason: 'untracked' }, /not tracked/],
    [{ ok: false, reason: 'failed' }, /Could not open the diff/],
    ['throw', /Could not open the diff/],
  ];
  for (const [git, re] of expected) {
    h.state.git = git;
    const out = await h.send({ type: 'openDiff', rootId, relPath: 'src/main.txt' });
    const e = out[0] as OfK<'error'>;
    assert.equal(e.type, 'error');
    assert.match(e.message, re);
    assert.ok(!('reqId' in e));
    assert.ok(!e.message.includes(h.base));
  }
});

test('an editor failure is a toast without the path', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  h.state.openFails = true;
  const out = await h.send({ type: 'openFile', rootId, relPath: 'src/main.txt' });
  assert.deepEqual(out, [{ type: 'error', message: 'Could not open the file.' }]);
});

// ---- the fileId registry ------------------------------------------------------------------------------------------

test('FileIdRegistry: random ids that are stable per path, never contain the path, evict the oldest and refuse unknown ids', () => {
  const reg = new FileIdRegistry({ max: 3 });
  const a = reg.idFor('/home/u/.claude/skills/a/SKILL.md');
  const b = reg.idFor('/home/u/.claude/skills/b/SKILL.md');
  assert.notEqual(a, b);
  assert.equal(reg.idFor('/home/u/.claude/skills/a/SKILL.md'), a, 'same path, same id');
  for (const id of [a, b]) {
    assert.ok(id.length > 0 && id.length <= LIMITS.idChars);
    assert.ok(!id.includes('skills') && !id.includes('home') && !id.includes('/'), id);
    assert.match(id, /^f[0-9a-f]{32}$/);
  }
  assert.equal(reg.pathFor(a), '/home/u/.claude/skills/a/SKILL.md');
  assert.equal(reg.pathFor('fabc'), undefined);
  assert.equal(reg.pathFor('/home/u/.claude/skills/a/SKILL.md'), undefined, 'a path is not an id');
  // Another registry gives other ids for the same path (they are not derived from it).
  assert.notEqual(new FileIdRegistry().idFor('/home/u/.claude/skills/a/SKILL.md'), a);
  // Eviction: a, b, c, d at max 3 drops the oldest. Seeing `a` again refreshes it, so `b` goes first.
  reg.idFor('/c');
  reg.idFor('/home/u/.claude/skills/a/SKILL.md');
  reg.idFor('/d');
  assert.equal(reg.size, 3);
  assert.equal(reg.pathFor(b), undefined, 'oldest evicted');
  assert.equal(reg.pathFor(a), '/home/u/.claude/skills/a/SKILL.md', 'refreshed entry kept');
  // The cap holds for a large stream and an evicted path gets a new id.
  const big = new FileIdRegistry({ max: 2000 });
  const first = big.idFor('/p/0');
  for (let i = 1; i < 2500; i++) big.idFor(`/p/${i}`);
  assert.equal(big.size, 2000);
  assert.equal(big.pathFor(first), undefined);
  assert.notEqual(big.idFor('/p/0'), first);
});

test('FileIdRegistry: an injected generator that repeats an id cannot give two paths one id', () => {
  const seq = ['x', 'x', 'y'];
  const reg = new FileIdRegistry({ randomId: () => seq.shift() ?? 'z' });
  assert.equal(reg.idFor('/one'), 'x');
  assert.equal(reg.idFor('/two'), 'y');
});

test('openConfigFile opens a registered id only; unknown, stale and replaced ids are toasts', async () => {
  const h = await harness();
  const [c] = await catalogOf(h, 'skills');
  assert.ok(c);
  const body = c as Extract<OfK<'catalog'>, { section: 'skills' }>;
  const user = body.skills.find((s) => s.name === 'user-skill');
  assert.ok(user?.fileId, 'the skill carries a fileId');
  assert.ok(!user.fileId.includes('user-skill') && !user.fileId.includes(h.home));
  assert.deepEqual(await h.send({ type: 'openConfigFile', fileId: user.fileId }), []);
  assert.deepEqual(h.opened, [path.join(h.home, '.claude', 'skills', 'user-skill', 'SKILL.md')]);

  // Unknown ids, including a path and a guessed id, are refused and nothing is opened.
  for (const fileId of ['f0', 'unknown', path.join(h.home, '.claude', 'CLAUDE.md'), '../../etc/passwd']) {
    const out = await h.send({ type: 'openConfigFile', fileId });
    assert.deepEqual(out, [{ type: 'error', message: 'That file is no longer available.' }]);
  }
  assert.equal(h.opened.length, 1);

  // The file vanished: refused. Replaced by a folder: refused.
  const file = path.join(h.home, '.claude', 'skills', 'user-skill', 'SKILL.md');
  await fs.rm(file);
  assert.match(((await h.send({ type: 'openConfigFile', fileId: user.fileId }))[0] as OfK<'error'>).message, /no longer available/);
  await fs.mkdir(file);
  assert.match(((await h.send({ type: 'openConfigFile', fileId: user.fileId }))[0] as OfK<'error'>).message, /not a regular file/);
  assert.equal(h.opened.length, 1);
});

test('the registry cap applies through the router: with room for one id, an older catalog id stops opening', async () => {
  const h = await harness({ maxFileIds: 1 });
  const [c] = await catalogOf(h, 'handbook');
  const body = c as Extract<OfK<'catalog'>, { section: 'handbook' }>;
  const ids = body.instructions.map((i) => i.fileId);
  assert.ok(ids.length >= 2);
  const results: boolean[] = [];
  for (const fileId of ids) {
    const out = await h.send({ type: 'openConfigFile', fileId });
    results.push(out.length === 0);
  }
  assert.equal(results.filter(Boolean).length, 1, 'only the newest id is still registered');
});

// ---- catalog sections ---------------------------------------------------------------------------------------------

test('skills: probe success uses the SDK rows, and the project items come from the scan only when the project was not loaded', async () => {
  const h = await harness();
  const [loaded] = await catalogOf(h, 'skills');
  const names = skillNames(loaded!);
  assert.ok(names.includes('clear') && names.includes('user-skill'));
  assert.ok(!names.includes('ws-skill'), 'the probe saw the project: the SDK list is complete');
  // Passed through: the probe got the workspace folder, and both trust flags.
  assert.deepEqual(h.probe.catalogCalls[0], { cwd: h.ws, trust: { workspaceTrusted: true, claudeTrusted: true }, force: false });

  const base = h.probe.catalogResult;
  h.probe.catalogResult = async () => {
    const r = await base();
    return r.status === 'ok' ? { ...r, projectLoaded: false } : r;
  };
  const [scanned] = await catalogOf(h, 'skills');
  const sc = scanned as Extract<OfK<'catalog'>, { section: 'skills' }>;
  assert.ok(sc.skills.some((s) => s.name === 'ws-skill' && s.source === 'project'), 'projectLoaded=false merges the scanned project items');
});

test('skills: a failed probe falls back to the filesystem scan instead of an error', async () => {
  const h = await harness();
  h.probe.catalogResult = async () => ({ status: 'failed', reason: 'timed out' });
  const out = await catalogOf(h, 'skills');
  assert.equal(out.length, 1);
  const names = skillNames(out[0]!);
  assert.ok(names.includes('user-skill') && names.includes('ws-skill'));
  assert.ok(!names.includes('clear'));
  // A probe that throws (it promises not to) is the same.
  h.probe.catalogResult = async () => {
    throw new Error('boom');
  };
  const again = await catalogOf(h, 'skills');
  assert.ok(skillNames(again[0]!).includes('user-skill'));
});

test('agents: probe success and failure', async () => {
  const h = await harness();
  const [ok] = await catalogOf(h, 'agents');
  const agents = (ok as Extract<OfK<'catalog'>, { section: 'agents' }>).agents;
  assert.deepEqual(agents.map((a) => a.name).sort(), ['Explore', 'helper']);
  assert.equal(agents.find((a) => a.name === 'helper')?.source, 'user');
  assert.deepEqual(h.probe.catalogCalls[0]?.trust, { workspaceTrusted: true, claudeTrusted: true });

  h.probe.catalogResult = async () => ({ status: 'failed', reason: 'could not start Claude Code' });
  const [bad] = await catalogOf(h, 'agents');
  assert.deepEqual((bad as Extract<OfK<'catalog'>, { section: 'agents' }>).agents.map((a) => a.name), ['helper']);
});

test('handbook: reads the files, starts no probe, and needs no visible office', async () => {
  const h = await harness({ visible: false });
  const [c] = await catalogOf(h, 'handbook');
  const hb = c as Extract<OfK<'catalog'>, { section: 'handbook' }>;
  assert.equal(hb.instructions.length, 2);
  assert.ok(hb.instructions.every((i) => typeof i.fileId === 'string' && i.fileId !== ''));
  assert.deepEqual(hb.rules.map((r) => [r.behavior, r.rule]), [['allow', 'Bash(ls:*)']]);
  assert.deepEqual([h.probe.catalogCalls.length, h.probe.mcpCalls.length], [0, 0]);
});

test('a rootId picks the project: its folder is the probe cwd', async () => {
  const h = await harness();
  h.requests.setAgentCwds([h.other]);
  await h.requests.refreshRoots();
  const otherId = await h.rootIdOf(h.other);
  await catalogOf(h, 'agents', otherId);
  assert.equal(h.probe.catalogCalls[0]?.cwd, h.other);
});

// ---- trust ---------------------------------------------------------------------------------------------------------

test('trust: workspaceTrusted is false when VS Code does not trust the workspace', async () => {
  const h = await harness();
  h.state.trusted = false;
  await catalogOf(h, 'skills');
  await catalogOf(h, 'mcp');
  assert.deepEqual(h.probe.catalogCalls[0]?.trust, { workspaceTrusted: false, claudeTrusted: true });
  assert.deepEqual(h.probe.mcpCalls[0]?.trust, { workspaceTrusted: false, claudeTrusted: true });
});

test('trust: a root outside the workspace is untrusted even when VS Code trusts the workspace and Claude trusts the folder', async () => {
  const h = await harness({ claudeJson: (ws) => ({ projects: { [ws]: { hasTrustDialogAccepted: true }, [path.join(path.dirname(ws), 'other')]: { hasTrustDialogAccepted: true } } }) });
  h.requests.setAgentCwds([h.other]);
  await h.requests.refreshRoots();
  const otherId = await h.rootIdOf(h.other);
  await catalogOf(h, 'skills', otherId);
  await catalogOf(h, 'mcp', otherId);
  assert.deepEqual(h.probe.catalogCalls[0]?.trust, { workspaceTrusted: false, claudeTrusted: true });
  assert.deepEqual(h.probe.mcpCalls[0]?.trust, { workspaceTrusted: false, claudeTrusted: true });
  // A subfolder of the workspace is inside it.
  await fs.mkdir(path.join(h.ws, 'src', 'deep'));
  await fs.writeFile(path.join(h.home, '.claude.json'), JSON.stringify({ projects: { [path.join(h.ws, 'src')]: { hasTrustDialogAccepted: true } } }));
  h.requests.setAgentCwds([path.join(h.ws, 'src')]);
  await h.requests.refreshRoots();
  await catalogOf(h, 'agents', await h.rootIdOf(path.join(h.ws, 'src')));
  assert.deepEqual(h.probe.catalogCalls[1]?.trust, { workspaceTrusted: true, claudeTrusted: true });
});

test('trust: claudeTrusted is false when Claude Code has not accepted the folder', async () => {
  const h = await harness({ claudeJson: () => ({ projects: {} }) });
  await catalogOf(h, 'skills');
  await catalogOf(h, 'mcp');
  assert.deepEqual(h.probe.catalogCalls[0]?.trust, { workspaceTrusted: true, claudeTrusted: false });
  assert.deepEqual(h.probe.mcpCalls[0]?.trust, { workspaceTrusted: true, claudeTrusted: false });
  // Explicitly false is false too.
  await fs.writeFile(path.join(h.home, '.claude.json'), JSON.stringify({ projects: { [h.ws]: { hasTrustDialogAccepted: 'yes' } } }));
  await catalogOf(h, 'agents');
  assert.equal(h.probe.catalogCalls[1]?.trust.claudeTrusted, false);
});

test('no workspace: the neutral folder is the cwd, with user-only items and both flags false', async () => {
  const h = await harness({ noWorkspace: true });
  const out = await catalogOf(h, 'skills');
  assert.deepEqual(h.probe.catalogCalls[0], { cwd: h.neutral, trust: { workspaceTrusted: false, claudeTrusted: false }, force: false });
  const names = skillNames(out[0]!);
  assert.ok(names.includes('user-skill') && !names.includes('ws-skill'));
  // Even with VS Code saying "trusted", a neutral folder is not a workspace folder.
  await catalogOf(h, 'mcp');
  assert.equal(h.probe.mcpCalls[0]?.trust.workspaceTrusted, false);
});

test('force is passed to the probe only when the caller asks', async () => {
  const h = await harness();
  await catalogOf(h, 'skills');
  await h.send({ type: 'getCatalog', reqId: rid(), section: 'skills' }, { force: true });
  assert.deepEqual(h.probe.catalogCalls.map((c) => c.force), [false, true]);
});

// ---- MCP -----------------------------------------------------------------------------------------------------------

const item = (name: string, status: McpServerItem['status']): McpServerItem => ({ name, scope: 'user', transport: 'stdio', status });

test('mcp: an offline reply first, then every probe update with the same reqId', async () => {
  const h = await harness();
  h.probe.mcpScript = async (emit) => {
    emit({ servers: [item('userSrv', 'pending')], truncated: false, settled: false });
    emit({ servers: [item('userSrv', 'connected')], truncated: false, settled: true });
  };
  const reqId = rid();
  const out = await h.send({ type: 'getCatalog', reqId, section: 'mcp' });
  assert.equal(out.length, 3);
  for (const m of out) {
    assert.equal(m.type, 'catalog');
    assert.equal((m as OfK<'catalog'>).reqId, reqId);
    assert.equal((m as OfK<'catalog'>).section, 'mcp');
    assert.deepEqual(Object.keys(m).sort(), ['reqId', 'section', 'servers', 'truncated', 'type'], 'no settled flag or other field is forwarded');
  }
  const servers = (m: Posted): Array<[string, string]> => (m as Extract<OfK<'catalog'>, { section: 'mcp' }>).servers.map((s) => [s.name, s.status]);
  // First paint: built offline from the files (nothing started): statuses unknown, whatever the config says.
  assert.deepEqual(servers(out[0]!).map((s) => s[0]).sort(), ['userSrv', 'webSrv']);
  assert.ok(servers(out[0]!).every((s) => s[1] === 'unknown'));
  assert.deepEqual(servers(out[1]!), [['userSrv', 'pending']]);
  assert.deepEqual(servers(out[2]!), [['userSrv', 'connected']]);
  assert.equal(h.probe.mcpCalls.length, 1);
});

test('mcp: a repeat request while the probe runs joins it and sees the updates so far', async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  h.probe.mcpScript = async (emit) => {
    emit({ servers: [item('userSrv', 'pending')], truncated: false, settled: false });
    await gate;
    emit({ servers: [item('userSrv', 'connected')], truncated: false, settled: true });
  };
  const first = h.send({ type: 'getCatalog', reqId: 'm1', section: 'mcp' });
  await new Promise((r) => setTimeout(r, 50));
  const second = h.send({ type: 'getCatalog', reqId: 'm2', section: 'mcp' });
  await new Promise((r) => setTimeout(r, 50));
  release();
  await Promise.all([first, second]);
  assert.equal(h.probe.mcpCalls.length, 1, 'one probe for both');
  const forReq = (id: string) => h.posted.filter((m) => m.type === 'catalog' && m.reqId === id) as OfK<'catalog'>[];
  assert.equal(forReq('m1').length, 3);
  const joined = forReq('m2');
  assert.deepEqual((joined[joined.length - 1] as Extract<OfK<'catalog'>, { section: 'mcp' }>).servers.map((s) => s.status), ['connected']);
  assert.ok(joined.length >= 2);
});

test('single-flight: concurrent getCatalog for one section and folder runs one probe and answers every reqId', async () => {
  const h = await harness();
  let release!: () => void;
  h.probe.gate = new Promise<void>((r) => {
    release = r;
  });
  const a = h.send({ type: 'getCatalog', reqId: 's1', section: 'skills' });
  const b = h.send({ type: 'getCatalog', reqId: 's2', section: 'skills' });
  await new Promise((r) => setTimeout(r, 50));
  release();
  await Promise.all([a, b]);
  assert.equal(h.probe.catalogCalls.length, 1);
  assert.deepEqual(h.posted.filter((m) => m.type === 'catalog').map((m) => (m as OfK<'catalog'>).reqId).sort(), ['s1', 's2']);
});

// Fake SDK query for the end-to-end sentinel test: it answers the three catalog calls with rows full of secrets.
class SentinelQuery extends FakeQuery {
  supportedCommands = async (): Promise<unknown> => SDK_COMMANDS;
  supportedAgents = async (): Promise<unknown> => SDK_AGENTS;
  mcpServerStatus = async (): Promise<unknown> => [
    { name: 'userSrv', status: 'connected', error: 'SENTINEL_ERR', serverInfo: { name: 'SENTINEL_RAW', version: '1' }, config: { type: 'stdio', command: 'SENTINEL_CMD', args: ['SENTINEL_ARG'], env: { K: 'SENTINEL_ENV' } }, scope: 'user', tools: [{ name: 't1' }, { name: 't2' }] },
    { name: 'webSrv', status: 'failed', error: 'SENTINEL_ERR at https://example.invalid/SENTINEL_URL', config: { type: 'http', url: 'https://example.invalid/SENTINEL_URL', headers: { Authorization: 'SENTINEL_HDR' } }, scope: 'user' },
  ];
}

test('sentinel: with the real probe, no secret, hostOnly body or raw SDK row reaches any posted message or log', async () => {
  const queries: SentinelQuery[] = [];
  const queryFn: QueryFn = (p) => {
    const q = new SentinelQuery(p);
    queries.push(q);
    return q;
  };
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-office-neutral-')));
  made.push(base);
  const logs: string[] = [];
  const probe = createCatalogProbe({ queryFn, binaryPath: '/bin/claude', env: { PATH: '/usr/bin' }, neutralCwd: base, log: (l) => logs.push(l), pollMs: 5 });
  const h = await harness({ probeDeps: { probe, log: (l) => logs.push(l) } });
  const all: Posted[] = [];
  for (const section of ['mcp', 'skills', 'agents', 'handbook'] as const) all.push(...(await catalogOf(h, section)));
  await h.send({ type: 'getFileRoots', reqId: rid() });
  assert.ok(queries.length >= 2, 'the real probe ran');
  // The mcp replies: names, scope, transport, status, tool count only; the live statuses arrived.
  const mcp = all.filter((m) => m.type === 'catalog' && m.section === 'mcp') as Array<Extract<OfK<'catalog'>, { section: 'mcp' }>>;
  assert.ok(mcp.length >= 2);
  const last = mcp[mcp.length - 1]!;
  assert.deepEqual(last.servers.map((s) => [s.name, s.status, s.tools ?? null]).sort(), [['userSrv', 'connected', 2], ['webSrv', 'failed', null]]);
  for (const s of last.servers) assert.ok(Object.keys(s).every((k) => ['name', 'scope', 'transport', 'status', 'tools'].includes(k)), Object.keys(s).join());
  const dump = JSON.stringify(h.posted) + JSON.stringify(all) + logs.join('\n') + h.logs.join('\n');
  for (const s of SENTINELS) assert.ok(!dump.includes(s), `${s} must not appear`);
  assert.ok(!dump.includes('hostOnly'));
});

// ---- demo mode -----------------------------------------------------------------------------------------------------

test('demo mode: all seven types are refused with the demo error (reqId echoed where there is one), and never reach the router', async () => {
  const seven: Array<[WebviewToHost, string | undefined]> = [
    [{ type: 'getFileRoots', reqId: 'd1' }, 'd1'],
    [{ type: 'listDir', reqId: 'd2', rootId: 'r1', relPath: '' }, 'd2'],
    [{ type: 'readFile', reqId: 'd3', rootId: 'r1', relPath: 'x' }, 'd3'],
    [{ type: 'getCatalog', reqId: 'd4', section: 'mcp' }, 'd4'],
    [{ type: 'openFile', rootId: 'r1', relPath: 'x' }, undefined],
    [{ type: 'openDiff', rootId: 'r1', relPath: 'x' }, undefined],
    [{ type: 'openConfigFile', fileId: 'f1' }, undefined],
  ];
  const posted: Posted[] = [];
  const handled: string[] = [];
  const toManager: string[] = [];
  const deps = (demo: boolean) => ({
    isDemo: () => demo,
    post: (m: Posted) => posted.push(m),
    refreshUsage: () => {},
    handle: (m: WebviewToHost) => {
      toManager.push(m.type);
    },
    officeRequests: {
      handles: (m: WebviewToHost) => (OFFICE_REQUEST_TYPES as readonly string[]).includes(m.type),
      handle: (m: WebviewToHost) => {
        handled.push(m.type);
      },
    },
  });
  for (const [msg] of seven) routeWebviewMessage(msg, 'view', deps(true));
  assert.deepEqual(handled, []);
  assert.deepEqual(toManager, []);
  assert.equal(posted.length, 7);
  seven.forEach(([, reqId], i) => {
    const e = posted[i] as OfK<'error'>;
    assert.equal(e.type, 'error');
    assert.equal(e.message, DEMO_REFUSAL);
    assert.equal(e.reqId, reqId);
  });
  // Outside demo mode they go to the router, not to the manager host.
  for (const [msg] of seven) routeWebviewMessage(msg, 'view', deps(false));
  assert.deepEqual(handled, seven.map(([m]) => m.type));
  assert.deepEqual(toManager, []);
  // Other messages still reach the manager host, in either mode.
  routeWebviewMessage({ type: 'ready' }, 'view', deps(true));
  assert.deepEqual(toManager, ['ready']);
});

// ---- visibility ----------------------------------------------------------------------------------------------------

test('hidden office: no new probe; answers from what was last sent, or with an error the panel can retry', async () => {
  const h = await harness({ visible: false });
  for (const section of ['skills', 'agents', 'mcp'] as const) {
    const out = await h.send({ type: 'getCatalog', reqId: `h-${section}`, section });
    assert.equal(out.length, 1);
    const e = out[0] as OfK<'error'>;
    assert.deepEqual([e.type, e.reqId], ['error', `h-${section}`]);
    assert.match(e.message, /hidden/);
  }
  assert.deepEqual([h.probe.catalogCalls.length, h.probe.mcpCalls.length], [0, 0]);

  // Visible: the probe runs. Hidden again: the cached answer comes back without a new probe.
  h.requests.setVisible(true);
  const live = await catalogOf(h, 'skills');
  assert.equal(h.probe.catalogCalls.length, 1);
  h.requests.setVisible(false);
  const cached = await catalogOf(h, 'skills');
  assert.equal(h.probe.catalogCalls.length, 1);
  const strip = (c: OfK<'catalog'>): unknown => ({ ...c, reqId: undefined });
  assert.deepEqual(strip(cached[0]!), strip(live[0]!));
  // The cache is per section and folder.
  const other = await h.send({ type: 'getCatalog', reqId: rid(), section: 'agents' });
  assert.equal(other[0]?.type, 'error');
  assert.equal(h.probe.catalogCalls.length, 1);
});

test('fileRoots are pushed only while visible; a change made while hidden is pushed when the office shows again', async () => {
  const h = await harness({ visible: false });
  h.requests.setAgentCwds([h.other]);
  await h.requests.refreshRoots();
  assert.deepEqual(h.posted, [], 'hidden: nothing pushed');
  h.requests.setVisible(true);
  assert.equal(h.posted.length, 1);
  const push = h.posted[0]! as OfK<'fileRoots'>;
  assert.equal(push.type, 'fileRoots');
  assert.equal(push.reqId, undefined);
  assert.deepEqual(push.roots.map((r) => r.kind), ['workspace', 'agent']);
  // Visible: a new agent folder is pushed at once; the same list again is not.
  h.requests.setAgentCwds([h.other, path.join(h.ws, 'src')]);
  await h.requests.refreshRoots();
  assert.equal(h.posted.length, 2);
  h.requests.setAgentCwds([h.other, path.join(h.ws, 'src')]);
  await h.requests.refreshRoots();
  assert.equal(h.posted.length, 2);
  // Showing again with nothing new pushes nothing.
  h.requests.setVisible(false);
  h.requests.setVisible(true);
  assert.equal(h.posted.length, 2);
  // In demo mode nothing is pushed either.
  h.state.demo = true;
  h.requests.setAgentCwds([]);
  await h.requests.refreshRoots();
  assert.equal(h.posted.length, 2);
});

// ---- roots ---------------------------------------------------------------------------------------------------------

test('roots: workspace folders, agent cwds and browsed projects, de-duplicated, with filesystem roots and junk skipped', async () => {
  const h = await harness();
  h.requests.setAgentCwds([h.ws, h.other, '/', undefined, 'relative/dir', path.join(h.base, 'missing'), h.other]);
  h.requests.setProjects([
    { path: path.join(h.base, 'outside'), source: 'browsed', exists: true },
    { path: h.other, source: 'browsed', exists: true }, // already an agent root
    { path: path.join(h.base, 'neutral'), source: 'recent', exists: true }, // not browsed
    { path: path.join(h.base, 'home'), source: 'browsed', exists: false },
  ]);
  const roots = await h.requests.refreshRoots();
  assert.deepEqual(roots.map((r) => [r.kind, path.basename(r.projectPath)]), [['workspace', 'ws'], ['agent', 'other'], ['project', 'outside']]);
  assert.deepEqual(h.room.getRoots().map((r) => r.rootId), roots.map((r) => r.rootId));
  // Browsed projects and agent folders are capped.
  const many = await Promise.all(Array.from({ length: 60 }, async (_, i) => {
    const d = path.join(h.base, `many-${i}`);
    await fs.mkdir(d);
    return d;
  }));
  h.requests.setAgentCwds(many);
  h.requests.setProjects(many.map((p) => ({ path: p, source: 'browsed' as const, exists: true })));
  const capped = await h.requests.refreshRoots();
  assert.ok(capped.filter((r) => r.kind === 'agent').length <= 40);
  assert.ok(capped.filter((r) => r.kind === 'project').length <= 10);
});

test('roots follow workspace-folder changes, and a root that was dropped stops working', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  h.state.folders = [];
  await h.requests.refreshRoots();
  const [gone] = await h.send({ type: 'listDir', reqId: 'x1', rootId, relPath: '' });
  assert.equal((gone as OfK<'error'>).type, 'error');
  assert.equal((gone as OfK<'error'>).reqId, 'x1');
  // A getFileRoots after the change lists the new set.
  h.state.folders = [h.other];
  const [roots] = await h.send({ type: 'getFileRoots', reqId: 'x2' });
  assert.deepEqual((roots as OfK<'fileRoots'>).roots.map((r) => r.kind), ['workspace']);
});

// ---- logs ----------------------------------------------------------------------------------------------------------

test('logs carry ids, kinds, counts and timings, and no path, name or text', async () => {
  const h = await harness();
  const rootId = await wsRoot(h);
  h.state.git = { ok: false, reason: 'noRepo' };
  const [sk] = await catalogOf(h, 'skills');
  const user = (sk as Extract<OfK<'catalog'>, { section: 'skills' }>).skills.find((s) => s.name === 'user-skill')!;
  for (const msg of [
    { type: 'getFileRoots', reqId: rid() },
    { type: 'listDir', reqId: rid(), rootId, relPath: 'src' },
    { type: 'readFile', reqId: rid(), rootId, relPath: 'src/main.txt' },
    { type: 'readFile', reqId: rid(), rootId, relPath: '.env' },
    { type: 'openFile', rootId, relPath: 'src/main.txt' },
    { type: 'openFile', rootId, relPath: 'escape/secret.txt' },
    { type: 'openDiff', rootId, relPath: 'src/main.txt' },
    { type: 'openConfigFile', fileId: user.fileId! },
    { type: 'openConfigFile', fileId: 'nope' },
  ] as WebviewToHost[]) await h.send(msg);
  for (const section of ['agents', 'handbook', 'mcp'] as const) await catalogOf(h, section);
  h.state.openFails = true;
  await h.send({ type: 'openFile', rootId, relPath: 'src/main.txt' });
  assert.ok(h.logs.length > 5);
  const text = h.logs.join('\n');
  for (const bad of [h.base, h.home, 'main.txt', 'src/', 'user-skill', 'ws-skill', 'hello from main', 'CLAUDE.md', 'Bash(ls', 'userSrv', 'webSrv', '.env', 'secret.txt', 'SKILL.md', ...SENTINELS]) {
    assert.ok(!text.includes(bad), `log must not contain ${bad}`);
  }
  assert.match(text, /getCatalog req=\S+ section=skills/);
  assert.match(text, /openDiff root=r\d+ refused noRepo/);
});

test('handle never rejects: a file room that throws gives a generic error with the reqId', async () => {
  const h = await harness({
    probeDeps: {
      room: {
        setRoots: async () => [],
        getRoots: () => [],
        resolve: async () => {
          throw new Error('/secret/path exploded');
        },
        listDir: async () => {
          throw new Error('/secret/path exploded');
        },
        readFile: async () => {
          throw new Error('/secret/path exploded');
        },
      },
    },
  });
  for (const msg of [{ type: 'listDir', reqId: 'z1', rootId: 'r1', relPath: '' }, { type: 'readFile', reqId: 'z2', rootId: 'r1', relPath: '' }, { type: 'getCatalog', reqId: 'z3', section: 'skills', rootId: 'r1' }] as WebviewToHost[]) {
    const [out] = await h.send(msg);
    const e = out as OfK<'error'>;
    assert.equal(e.type, 'error');
    assert.equal(e.reqId, (msg as { reqId: string }).reqId);
    assert.ok(!e.message.includes('secret'));
  }
  const [toast] = await h.send({ type: 'openFile', rootId: 'r1', relPath: 'x' });
  assert.deepEqual(Object.keys(toast as object).sort(), ['message', 'type']);
  assert.ok(!h.logs.join('\n').includes('/secret/path'));
});
