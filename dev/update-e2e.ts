// Host-side end-to-end run of the built-in update check, against a fake GitHub on 127.0.0.1. Touches nothing of the user's VS Code:
// the install and reload steps are recorded stubs, the files go to a temp folder.
//
//   node dev/update-e2e.ts [--vsix <path to a real .vsix>] [--root <temp folder>]
//   node dev/update-e2e.ts --real     one forced check against the real GitHub releases URL (a single unauthenticated GET), then exit
//
// Scenarios: (1) forced check finds the newer release, install downloads, installs and deletes the file; (2) the server sends the
// wrong number of bytes: error, nothing installed; (3) the feed answers 404: quiet; (4) allowLoopback false: the loopback feed is
// refused without a request. Exits non-zero when one fails.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES_LATEST_URL, parseVersion } from '../src/host/updateCheck.ts';
import { UpdateService } from '../src/host/updateService.ts';
import type { UpdateServiceDeps } from '../src/host/updateService.ts';
import type { HostToWebview, UpdateInfo } from '../src/shared/protocol.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
const current = pkg.version;

/** Builds the service with in-memory storage and recorded stubs. */
function makeService(over: Partial<UpdateServiceDeps> & { dir: string }) {
  const store = new Map<string, unknown>();
  const posted: UpdateInfo[] = [];
  const logs: string[] = [];
  const calls = { install: [] as { path: string; size: number }[], reload: 0, open: [] as string[], deleted: [] as string[] };
  const deps: UpdateServiceDeps = {
    currentVersion: current,
    feedUrl: RELEASES_LATEST_URL,
    allowLoopback: false,
    fetch: (url, init) => fetch(url, init) as ReturnType<UpdateServiceDeps['fetch']>,
    now: Date.now,
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    storage: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    readSetting: () => 'auto',
    post: (m: HostToWebview) => { if (m.type === 'update') posted.push(m.update); },
    log: (l) => { logs.push(l); },
    writeFile: async (name, data) => {
      fs.mkdirSync(over.dir, { recursive: true });
      const p = path.join(over.dir, name);
      fs.writeFileSync(p, data);
      return p;
    },
    deleteFile: async (p) => { calls.deleted.push(p); fs.rmSync(p); },
    install: async (p) => { calls.install.push({ path: p, size: fs.statSync(p).size }); },
    reload: () => { calls.reload++; },
    openExternal: (u) => { calls.open.push(u); },
    ...over,
  };
  const svc = new UpdateService(deps);
  return { svc, store, posted, logs, calls };
}

interface Fake {
  base: string;
  hits: { feed: number; download: number };
  setMode(m: { feed?: 'ok' | '404'; download?: 'ok' | 'short' }): void;
  close(): Promise<void>;
}

/** The fake GitHub: `/releases/latest` and `/releases/download/<name>`. */
async function startFake(vsix: Buffer, fakeVersion: string): Promise<Fake> {
  const mode = { feed: 'ok', download: 'ok' };
  const hits = { feed: 0, download: 0 };
  const name = `middle-management-${fakeVersion}.vsix`;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/releases/latest') {
      hits.feed++;
      if (mode.feed === '404') { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}'); return; }
      const addr = server.address() as { port: number };
      const body = {
        tag_name: `v${fakeVersion}`,
        draft: false,
        prerelease: false,
        html_url: `https://github.com/Barniclebazil/middle-management/releases/tag/v${fakeVersion}`,
        assets: [{ name, size: vsix.length, browser_download_url: `http://127.0.0.1:${addr.port}/releases/download/${name}` }],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    if (url === `/releases/download/${name}`) {
      hits.download++;
      const body = mode.download === 'short' ? vsix.subarray(0, vsix.length - 1) : vsix;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    setMode(m) { Object.assign(mode, m); },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

let failures = 0;
function report(name: string, problems: string[]): void {
  if (problems.length === 0) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
    for (const p of problems) console.log(`        - ${p}`);
  }
}
const statuses = (posted: UpdateInfo[]): string => posted.map((p) => p.status).join(' > ');

/** One forced check against the real releases URL; prints what came back. */
async function real(): Promise<void> {
  const dir = path.join(os.tmpdir(), 'update-e2e-real');
  const { svc, posted, logs } = makeService({ dir });
  console.log(`GET ${RELEASES_LATEST_URL} (forced check, current ${current})`);
  await svc.check(true);
  const info = svc.info();
  console.log(`status posted: ${statuses(posted) || '(none)'}`);
  console.log(`final info: ${JSON.stringify(info)}`);
  for (const l of logs) console.log(`log: ${l}`);
}

async function main(): Promise<void> {
  if (args.includes('--real')) { await real(); return; }

  const vsixPath = path.resolve(arg('--vsix') ?? path.join(projectRoot, `middle-management-${current}.vsix`));
  if (!fs.existsSync(vsixPath)) throw new Error(`Run "npm run package" first: ${vsixPath} not found.`);
  const vsix = fs.readFileSync(vsixPath);
  const v = parseVersion(current);
  if (!v) throw new Error('package.json version is not a version');
  const fakeVersion = `${v.major}.${v.minor + 1}.0`;
  const root = arg('--root') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'update-e2e-'));
  fs.mkdirSync(root, { recursive: true });
  console.log(`current ${current}, fake release ${fakeVersion}, vsix ${vsix.length} bytes, temp folder ${root}`);

  const fake = await startFake(vsix, fakeVersion);
  const feedUrl = `${fake.base}/releases/latest`;
  try {
    // 1. Happy path.
    {
      const dir = path.join(root, 'ok');
      const { svc, posted, calls, logs } = makeService({ dir, feedUrl, allowLoopback: true });
      const problems: string[] = [];
      await svc.check(true);
      const a = svc.info();
      if (a.status !== 'available') problems.push(`after the forced check status is ${a.status}, expected available`);
      if (a.latest !== fakeVersion) problems.push(`latest is ${a.latest}, expected ${fakeVersion}`);
      if (a.notesUrl !== `https://github.com/Barniclebazil/middle-management/releases/tag/v${fakeVersion}`) problems.push(`notesUrl is ${a.notesUrl}`);
      if (!posted.some((p) => p.status === 'checking')) problems.push('no checking status was posted');
      await svc.handle('install');
      const seq = statuses(posted);
      if (!/downloading > installed$/.test(seq)) problems.push(`status sequence was "${seq}", expected it to end downloading > installed`);
      if (svc.info().status !== 'installed') problems.push(`final status is ${svc.info().status}, expected installed`);
      if (calls.install.length !== 1) problems.push(`install was called ${calls.install.length} times`);
      else {
        const c = calls.install[0]!;
        if (c.size !== vsix.length) problems.push(`install got a file of ${c.size} bytes, expected ${vsix.length}`);
        if (!c.path.startsWith(dir)) problems.push(`install file ${c.path} is outside the updates folder`);
        if (fs.existsSync(c.path)) problems.push('the downloaded file was not deleted afterwards');
      }
      if (calls.deleted.length !== 1) problems.push(`deleteFile was called ${calls.deleted.length} times`);
      await svc.handle('reload');
      if (calls.reload !== 1) problems.push(`reload was called ${calls.reload} times after the reload action`);
      await svc.handle('notes');
      if (calls.open.length !== 1 || !calls.open[0]!.startsWith('https://github.com/Barniclebazil/middle-management/')) problems.push(`notes opened ${JSON.stringify(calls.open)}`);
      if (logs.some((l) => /127\.0\.0\.1|\/tmp|\/home/.test(l))) problems.push(`a log line carries an address or a path: ${logs.find((l) => /127\.0\.0\.1|\/tmp|\/home/.test(l))}`);
      report('1. forced check -> available; install -> downloading -> installed; file deleted; reload; notes', problems);
    }

    // 2. Wrong size.
    {
      fake.setMode({ download: 'short' });
      const dir = path.join(root, 'short');
      const { svc, posted, calls } = makeService({ dir, feedUrl, allowLoopback: true });
      const problems: string[] = [];
      await svc.check(true);
      await svc.handle('install');
      const info = svc.info();
      if (info.status !== 'error') problems.push(`status is ${info.status}, expected error`);
      if (!info.message) problems.push('the error has no message');
      if (calls.install.length !== 0) problems.push('install was called with a wrong-sized file');
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) problems.push(`files left behind: ${fs.readdirSync(dir).join(', ')}`);
      if (!/downloading > error$/.test(statuses(posted))) problems.push(`status sequence was "${statuses(posted)}"`);
      fake.setMode({ download: 'ok' });
      report('2. wrong size -> error, nothing installed, nothing left on disk', problems);
    }

    // 3. Feed 404.
    {
      fake.setMode({ feed: '404' });
      const { svc, posted, calls, logs } = makeService({ dir: path.join(root, 'none'), feedUrl, allowLoopback: true });
      const problems: string[] = [];
      await svc.check(true);
      const info = svc.info();
      if (info.status !== 'idle') problems.push(`status is ${info.status}, expected idle`);
      if (info.status === 'idle' && info.message !== 'No releases have been published yet.') problems.push(`message is ${JSON.stringify(info.message)}`);
      if (posted.some((p) => p.status === 'error' || p.status === 'available')) problems.push(`posted ${statuses(posted)}`);
      await svc.check(false);
      if (logs.filter((l) => l.includes('no release published')).length !== 1) problems.push('the 404 was not logged exactly once');
      if (calls.install.length || calls.reload) problems.push('something was installed or reloaded');
      fake.setMode({ feed: 'ok' });
      report('3. feed 404 -> quiet idle (no error, no notice), logged once', problems);
    }

    // 4. Loopback refused when not in development.
    {
      const before = { ...fake.hits };
      const { svc, calls, logs } = makeService({ dir: path.join(root, 'refused'), feedUrl, allowLoopback: false });
      const problems: string[] = [];
      await svc.check(true);
      await svc.handle('install');
      const info = svc.info();
      if (fake.hits.feed !== before.feed || fake.hits.download !== before.download) problems.push('the server was contacted');
      if (info.status === 'available' || info.latest !== undefined) problems.push(`status ${info.status} with latest ${info.latest}`);
      if (calls.install.length) problems.push('install was called');
      if (!logs.some((l) => l.includes('not trusted'))) problems.push('no "not trusted" log line');
      report('4. allowLoopback false -> loopback feed refused without a request', problems);
    }
  } finally {
    await fake.close();
    if (!arg('--root')) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nAll scenarios passed.' : `\n${failures} scenario(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('update-e2e crashed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
