import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VSIX_BYTES, RECHECK_TICK_MS, UpdateService } from '../src/host/updateService.ts';
import type { UpdateResponse, UpdateServiceDeps } from '../src/host/updateService.ts';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  LATER_MS,
  RELEASES_LATEST_URL,
  UPDATE_ERROR_DOWNLOAD,
  UPDATE_ERROR_INSTALL,
  UPDATE_ERROR_OFFLINE,
  UPDATE_ERROR_SIZE,
  UPDATE_NONE_PUBLISHED,
  UPDATE_RATE_LIMITED,
  UPDATE_STATE_KEY,
  isAllowedDownloadUrl,
  isAllowedFeedUrl,
  isLoopbackUrl,
  readUpdateState,
} from '../src/host/updateCheck.ts';
import type { UpdateChecks } from '../src/host/updateCheck.ts';
import type { HostToWebview, UpdateInfo } from '../src/shared/protocol.ts';
import { FakeTimers, settle } from './manager-fakes.ts';

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const REPO = 'https://github.com/Barniclebazil/middle-management';
const SIZE = 6;

function releaseJson(version = '0.6.0', over: { size?: number; url?: string } = {}): unknown {
  return {
    tag_name: `v${version}`,
    html_url: `${REPO}/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `middle-management-${version}.vsix`,
        size: over.size ?? SIZE,
        browser_download_url: over.url ?? `${REPO}/releases/download/v${version}/middle-management-${version}.vsix`,
      },
    ],
  };
}

function json(status: number, body?: unknown, url = RELEASES_LATEST_URL): UpdateResponse {
  return { ok: status >= 200 && status < 300, status, url, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

function bin(bytes: number, url: string, status = 200): UpdateResponse {
  return { ok: status >= 200 && status < 300, status, url, json: async () => ({}), arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DOWNLOAD_OK = `${REPO}/releases/download/v0.6.0/middle-management-0.6.0.vsix`;

interface Rig {
  svc: UpdateService;
  timers: FakeTimers;
  storage: Map<string, unknown>;
  posts: UpdateInfo[];
  logs: string[];
  events: string[];
  fetched: { url: string; headers: Record<string, string>; signal: AbortSignal }[];
  feedCalls: () => number;
  files: Map<string, Uint8Array>;
  reloads: () => number;
  opened: string[];
  /** What the feed answers; change it between calls. */
  feed: { next: () => Promise<UpdateResponse> };
  download: { next: () => Promise<UpdateResponse> };
  hooks: { install: () => Promise<void>; deleteFile: () => Promise<void>; writeFile: () => Promise<void>; open: (() => void) | undefined };
  setting: { value: UpdateChecks };
  last(): UpdateInfo;
  /** Another service on the same storage and clock (a second window). */
  second(): Rig;
}

function rig(opts: { current?: string; feedUrl?: string; allowLoopback?: boolean; setting?: UpdateChecks; storage?: Map<string, unknown>; timers?: FakeTimers; feedBody?: unknown } = {}): Rig {
  const timers = opts.timers ?? new FakeTimers();
  const storage = opts.storage ?? new Map<string, unknown>();
  const posts: UpdateInfo[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const fetched: Rig['fetched'] = [];
  const files = new Map<string, Uint8Array>();
  let reloads = 0;
  const opened: string[] = [];
  const feedUrl = opts.feedUrl ?? RELEASES_LATEST_URL;
  const feed = { next: async (): Promise<UpdateResponse> => json(200, opts.feedBody ?? releaseJson(), feedUrl) };
  const download = { next: async (): Promise<UpdateResponse> => bin(SIZE, DOWNLOAD_OK) };
  const hooks = {
    install: async (): Promise<void> => {},
    deleteFile: async (): Promise<void> => {},
    writeFile: async (): Promise<void> => {},
    open: undefined as (() => void) | undefined,
  };
  const setting = { value: opts.setting ?? ('auto' as UpdateChecks) };
  const deps: UpdateServiceDeps = {
    currentVersion: opts.current ?? '0.5.0',
    feedUrl,
    allowLoopback: opts.allowLoopback ?? false,
    fetch: async (url, init) => {
      fetched.push({ url, headers: init.headers, signal: init.signal });
      return url === feedUrl ? feed.next() : download.next();
    },
    now: () => T0 + timers.now,
    timers,
    storage: { get: (k) => storage.get(k), set: (k, v) => void storage.set(k, v) },
    readSetting: () => setting.value,
    post: (msg: HostToWebview) => {
      if (msg.type !== 'update') return;
      posts.push(msg.update);
      events.push(`post:${msg.update.status}`);
    },
    log: (line) => void logs.push(line),
    writeFile: async (name, data) => {
      await hooks.writeFile();
      events.push('write');
      files.set(name, data);
      return `/gs/updates/${name}`;
    },
    deleteFile: async (path) => {
      events.push('delete');
      await hooks.deleteFile();
      files.delete(path.split('/').pop()!);
    },
    install: async () => {
      events.push('install');
      await hooks.install();
    },
    reload: () => void reloads++,
    openExternal: (url) => {
      if (hooks.open) hooks.open();
      opened.push(url);
    },
  };
  const svc = new UpdateService(deps);
  const r: Rig = {
    svc,
    timers,
    storage,
    posts,
    logs,
    events,
    fetched,
    feedCalls: () => fetched.filter((f) => f.url === feedUrl).length,
    files,
    reloads: () => reloads,
    opened,
    feed,
    download,
    hooks,
    setting,
    last: () => posts[posts.length - 1]!,
    second: () => rig({ ...opts, storage, timers }),
  };
  return r;
}

/** A rig whose first check already found 0.6.0 (current 0.5.0). */
async function available(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(opts);
  await r.svc.check(true);
  assert.equal(r.svc.info().status, 'available');
  r.posts.length = 0;
  r.events.length = 0;
  return r;
}

test('start posts the current info; the first check runs after the delay', async () => {
  const r = rig();
  r.svc.start();
  assert.equal(r.posts.length, 1);
  assert.deepEqual(r.last(), { status: 'idle', current: '0.5.0', auto: true });
  await r.timers.advance(FIRST_CHECK_DELAY_MS - 1);
  assert.equal(r.feedCalls(), 0);
  await r.timers.advance(1);
  assert.equal(r.feedCalls(), 1);
  assert.equal(r.last().status, 'available');
  assert.equal(r.last().latest, '0.6.0');
  assert.equal(r.last().checkedAt, T0 + FIRST_CHECK_DELAY_MS);
  assert.equal(r.last().hidden, false);
  r.svc.dispose();
});

test('the request carries the headers and a timeout signal', async () => {
  const r = rig();
  await r.svc.check(false);
  const f = r.fetched[0]!;
  assert.equal(f.url, RELEASES_LATEST_URL);
  assert.equal(f.headers['Accept'], 'application/vnd.github+json');
  assert.equal(f.headers['User-Agent'], 'middle-management/0.5.0');
  assert.ok(f.signal instanceof AbortSignal);
});

test('an automatic check is silent until it has a result', async () => {
  const r = rig();
  const gate = deferred<UpdateResponse>();
  r.feed.next = () => gate.promise;
  r.svc.start();
  r.posts.length = 0;
  await r.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(r.posts.length, 0);
  gate.resolve(json(200, releaseJson()));
  await settle();
  assert.deepEqual(r.posts.map((p) => p.status), ['available']);
  r.svc.dispose();
});

test('no second check within 24 hours; one after', async () => {
  const r = rig();
  r.svc.start();
  await r.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(r.feedCalls(), 1);
  await r.timers.advance(CHECK_INTERVAL_MS - HOUR);
  assert.equal(r.feedCalls(), 1);
  await r.timers.advance(HOUR);
  assert.equal(r.feedCalls(), 1, 'still a few seconds short of a full day');
  await r.timers.advance(RECHECK_TICK_MS);
  assert.equal(r.feedCalls(), 2);
  r.svc.dispose();
});

test('a start with a recent stored check does not check, and a later tick does when due', async () => {
  const storage = new Map<string, unknown>([[UPDATE_STATE_KEY, { v: 1, lastChecked: T0 - 2 * HOUR }]]);
  const r = rig({ storage });
  r.svc.start();
  assert.equal(r.last().status, 'upToDate');
  assert.equal(r.timers.pending, 1, 'only the hourly tick is armed');
  await r.timers.advance(FIRST_CHECK_DELAY_MS + HOUR);
  assert.equal(r.feedCalls(), 0);
  await r.timers.advance(22 * HOUR);
  assert.equal(r.feedCalls(), 1);
  r.svc.dispose();
});

test('a second window on the same storage does not check again', async () => {
  const a = rig();
  const b = a.second();
  a.svc.start();
  b.svc.start();
  await a.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(a.feedCalls(), 1);
  assert.equal(b.feedCalls(), 0);
  await a.timers.advance(3 * HOUR);
  assert.equal(b.feedCalls(), 0);
  // The other window still shows what was found.
  assert.equal(b.svc.info().status, 'available');
  a.svc.dispose();
  b.svc.dispose();
});

test('a forced check ignores the limit and clears Skip and Later', async () => {
  const r = await available();
  await r.svc.handle('skip');
  assert.equal(r.svc.info().hidden, true);
  await r.svc.handle('later');
  r.posts.length = 0;
  await r.svc.handle('check');
  assert.equal(r.feedCalls(), 2, 'checked again right away');
  assert.deepEqual(r.posts.map((p) => p.status), ['checking', 'available']);
  assert.equal(r.last().hidden, false);
  const state = readUpdateState(r.storage.get(UPDATE_STATE_KEY));
  assert.equal(state.skipped, undefined);
  assert.equal(state.laterUntil, undefined);
});

test('one request at a time', async () => {
  const r = rig();
  const gate = deferred<UpdateResponse>();
  r.feed.next = () => gate.promise;
  const a = r.svc.check(false);
  const b = r.svc.check(false);
  await settle();
  assert.equal(r.feedCalls(), 1);
  gate.resolve(json(200, releaseJson()));
  await Promise.all([a, b]);
  assert.equal(r.feedCalls(), 1);
});

test('a user request during an automatic check takes it over and shows its result', async () => {
  const r = rig();
  const gate = deferred<UpdateResponse>();
  r.feed.next = () => gate.promise;
  const auto = r.svc.check(false);
  await settle();
  await r.svc.handle('check');
  assert.equal(r.last().status, 'checking');
  gate.reject(new TypeError('offline'));
  await auto;
  assert.equal(r.last().status, 'error');
  assert.equal(r.last().message, UPDATE_ERROR_OFFLINE);
});

test('available, up to date, and a current version above the stored one', async () => {
  const newer = rig({ current: '0.5.0' });
  await newer.svc.check(false);
  assert.equal(newer.svc.info().status, 'available');
  assert.equal(newer.svc.info().notesUrl, `${REPO}/releases/tag/v0.6.0`);

  const same = rig({ current: '0.6.0' });
  await same.svc.check(false);
  assert.equal(same.svc.info().status, 'upToDate');
  assert.equal(same.svc.info().hidden, undefined);

  // The stored release is older than the running version (the user updated by hand): never "available".
  const storage = newer.storage;
  const ahead = rig({ current: '0.7.0', storage });
  assert.equal(ahead.svc.info().status, 'upToDate');
  assert.equal(ahead.svc.info().latest, '0.6.0');
  await ahead.svc.install();
  assert.equal(ahead.fetched.length, 0, 'nothing to install');
});

test('a 200 that cannot be read counts as up to date and logs the reason', async () => {
  const r = rig({ feedBody: { tag_name: 'v0.6.0', html_url: 'https://evil.example/', assets: [] } });
  await r.svc.check(false);
  assert.equal(r.svc.info().status, 'upToDate');
  assert.ok(r.logs.some((l) => l.includes('release not usable')));
  assert.notEqual(readUpdateState(r.storage.get(UPDATE_STATE_KEY)).lastChecked, undefined);
});

test('404 is quiet, shows the note, and is logged once per service', async () => {
  const r = rig();
  r.feed.next = async () => json(404);
  r.svc.start();
  r.posts.length = 0;
  await r.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(r.last().status, 'idle');
  assert.equal(r.last().message, UPDATE_NONE_PUBLISHED);
  await r.svc.check(true);
  await r.timers.advance(CHECK_INTERVAL_MS + HOUR);
  assert.ok(r.feedCalls() >= 3);
  assert.equal(r.logs.filter((l) => l.includes('no release published')).length, 1);
  assert.ok(r.posts.every((p) => p.status !== 'error'));
  assert.notEqual(r.last().checkedAt, undefined);
  r.svc.dispose();
});

test('403 and 429: quiet when automatic (and backs off a day), an error when forced', async () => {
  for (const status of [403, 429]) {
    const r = rig();
    r.feed.next = async () => json(status);
    r.svc.start();
    r.posts.length = 0;
    await r.timers.advance(FIRST_CHECK_DELAY_MS);
    assert.equal(r.feedCalls(), 1);
    assert.ok(r.posts.every((p) => p.status !== 'error'), `status ${status}`);
    await r.timers.advance(5 * HOUR);
    assert.equal(r.feedCalls(), 1, 'no retry within the day');

    await r.svc.handle('check');
    assert.equal(r.last().status, 'error');
    assert.equal(r.last().message, UPDATE_RATE_LIMITED);
    r.svc.dispose();
  }
});

test('a rate limit keeps what was found before', async () => {
  const r = await available();
  r.feed.next = async () => json(403);
  await r.svc.check(false);
  assert.equal(r.svc.info().status, 'available');
  assert.equal(r.svc.info().latest, '0.6.0');
});

test('network error: automatic is quiet and retried by the hourly tick, forced shows an error', async () => {
  const r = rig();
  r.feed.next = async () => {
    throw new TypeError('fetch failed');
  };
  r.svc.start();
  r.posts.length = 0;
  await r.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(r.feedCalls(), 1);
  assert.equal(r.posts.length, 0);
  assert.equal(readUpdateState(r.storage.get(UPDATE_STATE_KEY)).lastChecked, undefined);
  await r.timers.advance(RECHECK_TICK_MS - FIRST_CHECK_DELAY_MS - 1);
  assert.equal(r.feedCalls(), 1, 'at most hourly');
  await r.timers.advance(1);
  assert.equal(r.feedCalls(), 2);
  assert.ok(r.logs.some((l) => l.includes('TypeError')));
  assert.ok(r.logs.every((l) => !l.includes('fetch failed')), 'the message is never logged');

  await r.svc.handle('check');
  assert.deepEqual(r.posts.map((p) => p.status), ['checking', 'error']);
  assert.equal(r.last().message, UPDATE_ERROR_OFFLINE);
  r.svc.dispose();
});

test('an automatic network error keeps the previous info; any other status counts as a network error', async () => {
  const r = await available();
  r.feed.next = async () => json(500);
  await r.svc.check(false);
  assert.equal(r.svc.info().status, 'available');
  assert.equal(r.posts.length, 0);
  await r.svc.check(true);
  assert.equal(r.last().status, 'error');
  assert.equal(r.last().message, UPDATE_ERROR_OFFLINE);
  // The next good check clears the error.
  r.feed.next = async () => json(200, releaseJson());
  await r.svc.check(true);
  assert.equal(r.last().status, 'available');
  assert.equal(r.last().message, undefined);
});

test('install: download, write, install, installed, then delete', async () => {
  const r = await available();
  await r.svc.handle('install');
  assert.deepEqual(r.events, ['post:downloading', 'write', 'install', 'post:installed', 'delete']);
  assert.equal(r.last().status, 'installed');
  assert.equal(r.fetched[r.fetched.length - 1]!.url, DOWNLOAD_OK);
  assert.equal(r.files.size, 0, 'the file is gone again');
  assert.equal(r.svc.info().status, 'installed');
});

test('install writes the version-named file with the downloaded bytes', async () => {
  const r = await available();
  r.hooks.install = async () => {
    assert.equal(r.files.get('middle-management-0.6.0.vsix')?.byteLength, SIZE);
  };
  await r.svc.install();
  assert.equal(r.last().status, 'installed');
});

test('install is refused unless an update is available', async () => {
  const none = rig();
  await none.svc.install();
  assert.equal(none.fetched.length, 0);
  assert.equal(none.posts.length, 0);

  const done = await available();
  await done.svc.install();
  const before = done.fetched.length;
  await done.svc.install();
  assert.equal(done.fetched.length, before, 'not again after it was installed');
  await done.svc.check(true);
  assert.equal(done.svc.info().status, 'installed', 'a check does not wipe the installed state');
});

test('install: a size mismatch is refused and nothing is written', async () => {
  const r = await available();
  r.download.next = async () => bin(SIZE - 1, DOWNLOAD_OK);
  await r.svc.install();
  assert.equal(r.last().status, 'error');
  assert.equal(r.last().message, UPDATE_ERROR_SIZE);
  assert.ok(!r.events.includes('write'));
  assert.ok(!r.events.includes('install'));
});

test('install: a release larger than the limit is refused without downloading', async () => {
  const r = rig({ feedBody: releaseJson('0.6.0', { size: MAX_VSIX_BYTES + 1 }) });
  await r.svc.check(true);
  const calls = r.fetched.length;
  await r.svc.install();
  assert.equal(r.fetched.length, calls);
  assert.equal(r.last().message, UPDATE_ERROR_SIZE);
});

test('install: a final address outside GitHub after a redirect is refused', async () => {
  const r = await available();
  r.download.next = async () => bin(SIZE, 'https://evil.example/middle-management-0.6.0.vsix');
  await r.svc.install();
  assert.equal(r.last().status, 'error');
  assert.equal(r.last().message, UPDATE_ERROR_DOWNLOAD);
  assert.ok(!r.events.includes('write'));
});

test('install: a redirect to GitHub release storage is fine', async () => {
  const r = await available();
  r.download.next = async () => bin(SIZE, 'https://objects.githubusercontent.com/github-production-release-asset/abc');
  await r.svc.install();
  assert.equal(r.last().status, 'installed');
});

test('install: a failed or interrupted download shows the download error', async () => {
  const r = await available();
  r.download.next = async () => bin(SIZE, DOWNLOAD_OK, 500);
  await r.svc.install();
  assert.equal(r.last().message, UPDATE_ERROR_DOWNLOAD);
  r.download.next = async () => {
    throw new TypeError('terminated');
  };
  await r.svc.install();
  assert.equal(r.last().message, UPDATE_ERROR_DOWNLOAD);
  assert.ok(r.logs.every((l) => !l.includes('terminated')));
});

test('install: VS Code failing to install shows the install error, deletes the file, and can be retried', async () => {
  const r = await available();
  r.hooks.install = async () => {
    throw new Error('/secret/path failed');
  };
  await r.svc.install();
  assert.equal(r.last().status, 'error');
  assert.equal(r.last().message, UPDATE_ERROR_INSTALL);
  assert.ok(r.events.includes('delete'));
  assert.ok(r.logs.every((l) => !l.includes('/secret/path')));
  assert.equal(r.svc.info().latest, '0.6.0');

  r.hooks.install = async () => {};
  await r.svc.handle('install');
  assert.equal(r.last().status, 'installed');
});

test('install: a failing delete is ignored and logged by name', async () => {
  const r = await available();
  r.hooks.deleteFile = async () => {
    throw new RangeError('x');
  };
  await r.svc.install();
  assert.equal(r.last().status, 'installed');
  assert.ok(r.logs.some((l) => l.includes('deleting the download failed (RangeError)')));
});

test('install: a file that cannot be saved shows the download error', async () => {
  const r = await available();
  r.hooks.writeFile = async () => {
    throw new Error('disk full');
  };
  await r.svc.install();
  assert.equal(r.last().message, UPDATE_ERROR_DOWNLOAD);
  assert.ok(!r.events.includes('install'));
});

test('later hides the notice for three days and persists; skip hides that version for good', async () => {
  const r = await available();
  await r.svc.handle('later');
  assert.equal(r.last().status, 'available');
  assert.equal(r.last().hidden, true);
  assert.equal(readUpdateState(r.storage.get(UPDATE_STATE_KEY)).laterUntil, T0 + LATER_MS);
  assert.equal(r.second().svc.info().hidden, true, 'another window sees it too');
  await r.timers.advance(LATER_MS);
  assert.equal(r.svc.info().hidden, false);

  await r.svc.handle('skip');
  assert.equal(r.last().hidden, true);
  assert.equal(readUpdateState(r.storage.get(UPDATE_STATE_KEY)).skipped, '0.6.0');
  await r.timers.advance(30 * 24 * HOUR);
  assert.equal(r.svc.info().hidden, true);
  assert.equal(r.svc.info().status, 'available', 'still available for the About tab');
});

test('later and skip with nothing found do nothing', async () => {
  const r = rig();
  await r.svc.handle('skip');
  assert.equal(r.storage.get(UPDATE_STATE_KEY), undefined);
});

test('reload runs only after an install', async () => {
  const r = await available();
  await r.svc.handle('reload');
  assert.equal(r.reloads(), 0);
  await r.svc.handle('install');
  await r.svc.handle('reload');
  assert.equal(r.reloads(), 1);
  const idle = rig();
  await idle.svc.handle('reload');
  assert.equal(idle.reloads(), 0);
});

test('notes opens the stored release page, in any status where latest is known', async () => {
  const r = await available();
  await r.svc.handle('notes');
  assert.deepEqual(r.opened, [`${REPO}/releases/tag/v0.6.0`]);
  await r.svc.handle('later');
  await r.svc.handle('notes');
  assert.equal(r.opened.length, 2, 'also while hidden');
  await r.svc.handle('install');
  assert.equal(r.svc.info().status, 'installed');
  await r.svc.handle('notes');
  assert.equal(r.opened.length, 3);
});

test('notes ignores a missing or disallowed address and logs only a name when opening throws', async () => {
  const none = rig();
  await none.svc.handle('notes');
  assert.deepEqual(none.opened, []);

  const bad = await available();
  bad.storage.set(UPDATE_STATE_KEY, { ...(bad.storage.get(UPDATE_STATE_KEY) as object), notesUrl: 'https://evil.example/x' });
  await bad.svc.handle('notes');
  assert.deepEqual(bad.opened, []);

  const boom = await available();
  boom.hooks.open = () => {
    throw new RangeError('secret /path');
  };
  await boom.svc.handle('notes');
  assert.ok(boom.logs.some((l) => l.includes('(RangeError)')));
  assert.ok(!boom.logs.some((l) => l.includes('secret')));
});

test('setting off: no automatic checks, a forced one still works; turning it on schedules one', async () => {
  const r = rig({ setting: 'off' });
  r.svc.start();
  assert.equal(r.last().auto, false);
  await r.timers.advance(3 * CHECK_INTERVAL_MS);
  assert.equal(r.feedCalls(), 0);
  await r.svc.handle('check');
  assert.equal(r.feedCalls(), 1);
  assert.equal(r.last().status, 'available');
  assert.equal(r.last().auto, false);

  const on = rig({ setting: 'off' });
  on.svc.start();
  on.setting.value = 'auto';
  on.svc.settingChanged();
  assert.equal(on.last().auto, true);
  await on.timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(on.feedCalls(), 1);
  on.svc.dispose();
  r.svc.dispose();
});

test('settingChanged to off cancels the pending first check', async () => {
  const r = rig();
  r.svc.start();
  r.setting.value = 'off';
  r.svc.settingChanged();
  await r.timers.advance(FIRST_CHECK_DELAY_MS + HOUR);
  assert.equal(r.feedCalls(), 0);
  r.svc.dispose();
});

test('dispose clears every timer and drops late results', async () => {
  const r = rig();
  r.svc.start();
  assert.equal(r.timers.pending, 2);
  r.svc.dispose();
  assert.equal(r.timers.pending, 0);
  await r.timers.advance(3 * CHECK_INTERVAL_MS);
  assert.equal(r.feedCalls(), 0);

  const late = rig();
  const gate = deferred<UpdateResponse>();
  late.feed.next = () => gate.promise;
  const done = late.svc.check(true);
  await settle();
  const posted = late.posts.length;
  late.svc.dispose();
  gate.resolve(json(200, releaseJson()));
  await done;
  assert.equal(late.posts.length, posted);
  assert.equal(readUpdateState(late.storage.get(UPDATE_STATE_KEY)).latest, undefined);
});

test('loopback is allowed only in development mode', async () => {
  const feed = 'http://127.0.0.1:8123/latest';
  const mock = (port = 8123): unknown => releaseJson('0.6.0', { url: `http://127.0.0.1:${port}/middle-management-0.6.0.vsix` });

  // Production: a loopback feed address is never requested.
  const prod = rig({ feedUrl: feed, allowLoopback: false, feedBody: mock() });
  await prod.svc.check(true);
  assert.equal(prod.fetched.length, 0);
  assert.equal(prod.last().status, 'error');

  // Production with the real feed address but a loopback download address in the answer: not trusted.
  const sneaky = rig({ feedBody: mock() });
  await sneaky.svc.check(true);
  assert.equal(sneaky.svc.info().status, 'upToDate');

  // Development: both work.
  const dev = rig({ feedUrl: feed, allowLoopback: true, feedBody: mock() });
  dev.download.next = async () => bin(SIZE, 'http://127.0.0.1:8123/middle-management-0.6.0.vsix');
  await dev.svc.check(true);
  assert.equal(dev.svc.info().status, 'available');
  await dev.svc.install();
  assert.equal(dev.last().status, 'installed');
  assert.equal(dev.fetched[dev.fetched.length - 1]!.url, 'http://127.0.0.1:8123/middle-management-0.6.0.vsix');

  // Development still refuses a download that ends up somewhere foreign.
  const odd = rig({ feedUrl: feed, allowLoopback: true, feedBody: mock() });
  odd.download.next = async () => bin(SIZE, 'http://example.com/x.vsix');
  await odd.svc.check(true);
  await odd.svc.install();
  assert.equal(odd.last().message, UPDATE_ERROR_DOWNLOAD);
});

test('loopback helpers', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/x'), true);
  assert.equal(isLoopbackUrl('http://localhost:3000/x'), true);
  assert.equal(isLoopbackUrl('http://localhost/x'), false, 'needs a port');
  assert.equal(isLoopbackUrl('https://127.0.0.1:8080/x'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.example:8080/x'), false);
  assert.equal(isLoopbackUrl('http://user:pw@127.0.0.1:8080/x'), false);
  assert.equal(isLoopbackUrl('nonsense'), false);

  assert.equal(isAllowedFeedUrl(RELEASES_LATEST_URL, false), true);
  assert.equal(isAllowedFeedUrl('http://127.0.0.1:8080/x', false), false);
  assert.equal(isAllowedFeedUrl('http://127.0.0.1:8080/x', true), true);
  assert.equal(isAllowedFeedUrl('https://api.github.com/repos/other/repo/releases/latest', true), false);

  assert.equal(isAllowedDownloadUrl('http://127.0.0.1:8080/x.vsix'), false);
  assert.equal(isAllowedDownloadUrl('http://127.0.0.1:8080/x.vsix', false), false);
  assert.equal(isAllowedDownloadUrl('http://127.0.0.1:8080/x.vsix', true), true);
  assert.equal(isAllowedDownloadUrl(DOWNLOAD_OK, true), true);

  assert.equal(readUpdateState({ v: 1, vsixUrl: 'http://127.0.0.1:8080/x.vsix' }).vsixUrl, undefined);
  assert.equal(readUpdateState({ v: 1, vsixUrl: 'http://127.0.0.1:8080/x.vsix' }, true).vsixUrl, 'http://127.0.0.1:8080/x.vsix');
});
