import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeWatcher, PROBE_ENTRYPOINT, isLiveStatusFileName } from '../src/claude/sessions.ts';
import { PROBE_ENTRYPOINT_TAG } from '../src/manager/usageProbe.ts';
import type { ClaudeWatcherOptions } from '../src/claude/sessions.ts';
import type { SessionInfo, WatchUpdate } from '../src/claude/types.ts';
import { copyFixtureHome, rmTemp, setMtimes } from './claude-fixtures.ts';

const BASE = Date.parse('2026-10-18T10:10:00Z');
const MIN = 60_000;
const SID = (n: number): string => `aaaa000${n}-0000-4000-8000-00000000000${n}`;
const LIVE_PIDS = new Set([1001, 1002, 1003]);

interface Rig {
  home: string;
  clock: { now: number };
  make: (opts?: Partial<ClaudeWatcherOptions>) => ClaudeWatcher;
}

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const home = await copyFixtureHome();
  await setMtimes(home, '.jsonl', BASE);
  const clock = { now: BASE + MIN };
  const make = (opts: Partial<ClaudeWatcherOptions> = {}): ClaudeWatcher =>
    new ClaudeWatcher({
      claudeHome: home,
      scope: 'all',
      activeWindowMs: 30 * MIN,
      now: () => clock.now,
      isPidAlive: (pid) => LIVE_PIDS.has(pid),
      ...opts,
    });
  try {
    await fn({ home, clock, make });
  } finally {
    await rmTemp(home);
  }
}

function byId(u: WatchUpdate): Map<string, SessionInfo> {
  return new Map(u.sessions.map((s) => [s.sessionId, s]));
}

test('finds all 9 fixture sessions, links subagents with meta, and reads live status', async () => {
  await withRig(async ({ make, home }) => {
    const w = make();
    const u = await w.poll();
    assert.equal(w.errorCount, 0);
    assert.equal(u.sessions.length, 9);
    const sessions = byId(u);

    const parent = sessions.get(SID(5))!;
    assert.equal(parent.subagents.length, 2);
    const agents = new Map(parent.subagents.map((a) => [a.agentId, a]));
    const a1 = agents.get('a5ca1e00000000001')!;
    const a2 = agents.get('a5ca1e00000000002')!;
    assert.equal(a1.meta?.finished, true);
    assert.equal(a1.meta?.description, 'Review router');
    assert.equal(a1.meta?.agentType, 'Explore');
    assert.match(a1.meta?.toolUseId ?? '', /^toolu_01aa000501/);
    assert.equal(a2.meta?.finished, false);
    assert.equal(a2.meta?.description, 'Research bundlers');
    assert.equal(
      a1.path,
      path.join(home, 'projects', '-home-user-demo-project', SID(5), 'subagents', 'agent-a5ca1e00000000001.jsonl'),
    );
    for (const s of u.sessions) if (s.sessionId !== SID(5)) assert.equal(s.subagents.length, 0);

    assert.deepEqual(sessions.get(SID(3))!.live, {
      pid: 1001,
      alive: true,
      status: 'busy',
      name: 'Running the test suite',
      statusUpdatedAt: 1792000600000,
    });
    assert.equal(sessions.get(SID(2))!.live?.status, 'waiting');
    assert.equal(sessions.get(SID(2))!.live?.pid, 1002);
    assert.equal(sessions.get(SID(1))!.live?.status, 'idle');
    assert.equal(sessions.get(SID(1))!.live?.pid, 1003);
    assert.equal(sessions.get(SID(4))!.live, undefined);

    assert.equal(sessions.get(SID(3))!.cwd, '/home/user/demo-project');
    assert.equal(sessions.get(SID(4))!.cwd, '/home/user/demo-project'); // from the transcript records
    assert.equal(sessions.get(SID(9))!.cwd, 'C:\\Users\\alice\\work\\proj');
    assert.equal(sessions.get(SID(3))!.mtimeMs, BASE);
    assert.equal(sessions.get(SID(3))!.projectDir, path.join(home, 'projects', '-home-user-demo-project'));
    assert.equal(
      sessions.get(SID(3))!.transcriptPath,
      path.join(home, 'projects', '-home-user-demo-project', SID(3) + '.jsonl'),
    );
  });
});

test('first poll batches every file with reset=true; later polls only report new records', async () => {
  await withRig(async ({ make, home, clock }) => {
    const w = make();
    const first = await w.poll();
    assert.equal(first.batches.length, 9 + 2);
    assert.ok(first.batches.every((b) => b.reset));
    assert.equal(first.batches.filter((b) => b.agentId !== undefined).length, 2);
    const partial = first.batches.find((b) => b.sessionId === SID(8) && b.agentId === undefined)!;
    assert.equal(partial.records.length, 8);

    clock.now += 1000;
    const second = await w.poll();
    assert.equal(second.batches.length, 0);
    assert.equal(second.sessions.length, 9);

    const transcript = path.join(home, 'projects', '-home-user-demo-project', SID(3) + '.jsonl');
    await fs.promises.appendFile(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'More' }) + '\n');
    const sub = path.join(
      home, 'projects', '-home-user-demo-project', SID(5), 'subagents', 'agent-a5ca1e00000000002.jsonl',
    );
    await fs.promises.appendFile(sub, JSON.stringify({ type: 'ai-title', aiTitle: 'Sub' }) + '\n');
    clock.now += 1000;
    const third = await w.poll();
    assert.equal(third.batches.length, 2);
    const main = third.batches.find((b) => b.agentId === undefined)!;
    assert.equal(main.sessionId, SID(3));
    assert.equal(main.reset, false);
    assert.deepEqual(main.records, [{ type: 'ai-title', aiTitle: 'More' }]);
    const agent = third.batches.find((b) => b.agentId !== undefined)!;
    assert.equal(agent.sessionId, SID(5));
    assert.equal(agent.agentId, 'a5ca1e00000000002');
    assert.equal(agent.reset, false);
    assert.equal(agent.records.length, 1);
  });
});

test('a rewritten transcript produces a reset batch', async () => {
  await withRig(async ({ make, home, clock }) => {
    const w = make();
    await w.poll();
    const transcript = path.join(home, 'projects', '-home-user-demo-project', SID(3) + '.jsonl');
    await fs.promises.writeFile(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Fresh' }) + '\n');
    clock.now += 1000;
    const u = await w.poll();
    assert.equal(u.batches.length, 1);
    assert.equal(u.batches[0]!.reset, true);
    assert.equal(u.batches[0]!.records.length, 1);
  });
});

test('scope by workspace dir: project folder name match', async () => {
  await withRig(async ({ make }) => {
    const u = await make({ scope: { workspaceDirs: ['/home/user/demo-project'] } }).poll();
    assert.equal(u.sessions.length, 8);
    assert.ok(!byId(u).has(SID(9)));
  });
});

test('scope by workspace dir: Windows-style project', async () => {
  await withRig(async ({ make }) => {
    const u = await make({ scope: { workspaceDirs: ['C:\\Users\\alice\\work\\proj'] } }).poll();
    assert.deepEqual(u.sessions.map((s) => s.sessionId), [SID(9)]);
    assert.equal(u.batches.length, 1);
  });
});

test('scope by workspace dir: a parent folder matches through the cwd, a sibling prefix does not', async () => {
  await withRig(async ({ make }) => {
    // Neither folder name matches `/home/user`, so this goes through the live cwd and the first-record cwd.
    const parent = await make({ scope: { workspaceDirs: ['/home/user'] } }).poll();
    assert.equal(parent.sessions.length, 8);
    const prefix = await make({ scope: { workspaceDirs: ['/home/user/demo'] } }).poll();
    assert.equal(prefix.sessions.length, 0);
    const other = await make({ scope: { workspaceDirs: ['/home/other'] } }).poll();
    assert.equal(other.sessions.length, 0);
    const none = await make({ scope: { workspaceDirs: [] } }).poll();
    assert.equal(none.sessions.length, 0);
    const both = await make({
      scope: { workspaceDirs: ['/home/other', 'C:\\Users\\alice\\work\\proj', '/home/user/demo-project'] },
    }).poll();
    assert.equal(both.sessions.length, 9);
  });
});

test('sessions disappear when they age out, unless a live pid keeps them', async () => {
  await withRig(async ({ make, clock }) => {
    const w = make();
    assert.equal((await w.poll()).sessions.length, 9);

    clock.now = BASE + 29 * MIN;
    assert.equal((await w.poll()).sessions.length, 9);

    clock.now = BASE + 31 * MIN;
    const aged = await w.poll();
    assert.deepEqual(
      aged.sessions.map((s) => s.sessionId).sort(),
      [SID(1), SID(2), SID(3)],
    );
    assert.equal(aged.batches.length, 0);

    // With no live pids at all, nothing is left.
    const gone = make({ isPidAlive: () => false });
    assert.equal((await gone.poll()).sessions.length, 0);
  });
});

test('a session that ages out and is later written to again returns with a reset batch', async () => {
  await withRig(async ({ make, home, clock }) => {
    const w = make({ isPidAlive: () => false });
    await w.poll();
    clock.now = BASE + 40 * MIN;
    assert.equal((await w.poll()).sessions.length, 0);

    const transcript = path.join(home, 'projects', '-home-user-demo-project', SID(4) + '.jsonl');
    const later = BASE + 41 * MIN;
    await fs.promises.appendFile(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Again' }) + '\n');
    await fs.promises.utimes(transcript, later / 1000, later / 1000);
    clock.now = later + 10_000;
    const u = await w.poll();
    assert.deepEqual(u.sessions.map((s) => s.sessionId), [SID(4)]);
    assert.equal(u.batches.length, 1);
    assert.equal(u.batches[0]!.reset, true);
  });
});

test('stale subagents are dropped, but one whose meta says finished:false stays', async () => {
  await withRig(async ({ make, home }) => {
    await setMtimes(path.join(home, 'projects', '-home-user-demo-project', SID(5)), '.jsonl', BASE - 120 * MIN);
    const u = await make().poll();
    const parent = byId(u).get(SID(5))!;
    assert.deepEqual(parent.subagents.map((a) => a.agentId), ['a5ca1e00000000002']);
    assert.equal(u.batches.filter((b) => b.agentId !== undefined).length, 1);
  });
});

test('meta.json is re-read when its mtime changes', async () => {
  await withRig(async ({ make, home, clock }) => {
    const w = make();
    await w.poll();
    const metaPath = path.join(
      home, 'projects', '-home-user-demo-project', SID(5), 'subagents', 'agent-a5ca1e00000000002.meta.json',
    );
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    meta['finished'] = true;
    await fs.promises.writeFile(metaPath, JSON.stringify(meta));
    const t = (BASE + 5 * MIN) / 1000;
    await fs.promises.utimes(metaPath, t, t);
    clock.now += 1000;
    const u = await w.poll();
    const a2 = byId(u).get(SID(5))!.subagents.find((a) => a.agentId === 'a5ca1e00000000002')!;
    assert.equal(a2.meta?.finished, true);
  });
});

test('only <digits>.json files in sessions/ are eligible; *.key files are never opened', async () => {
  assert.equal(isLiveStatusFileName('1001.json'), true);
  assert.equal(isLiveStatusFileName('123.0123456789abcdef.key'), false);
  assert.equal(isLiveStatusFileName('123.key'), false);
  assert.equal(isLiveStatusFileName('123.json.key'), false);
  assert.equal(isLiveStatusFileName('abc.json'), false);
  assert.equal(isLiveStatusFileName('1001.json.bak'), false);

  await withRig(async ({ make, home }) => {
    const keyFile = path.join(home, 'sessions', '1001.0123456789abcdef0123456789abcdef.key');
    await fs.promises.writeFile(keyFile, 'TOP-SECRET');
    // Unreadable to this user: any attempt to open it would be recorded as an error.
    await fs.promises.chmod(keyFile, 0o000);
    const w = make();
    const u = await w.poll();
    assert.equal(u.sessions.length, 9);
    assert.equal(w.errorCount, 0);
    assert.equal(byId(u).get(SID(3))!.live?.status, 'busy');
    await fs.promises.chmod(keyFile, 0o600);
  });
});

test('the probe entrypoint constant matches the usage probe\'s tag', () => {
  assert.equal(PROBE_ENTRYPOINT, PROBE_ENTRYPOINT_TAG);
});

test('a pid file with the usage probe entrypoint is ignored: it never shows as a session or overrides live status', async () => {
  await withRig(async ({ make, home }) => {
    const probeSid = 'bbbb0000-0000-4000-8000-0000000000aa';
    const write = (name: string, body: Record<string, unknown>): Promise<void> =>
      fs.promises.writeFile(path.join(home, 'sessions', name), JSON.stringify(body));
    LIVE_PIDS.add(1004);
    LIVE_PIDS.add(1005);
    try {
      // A probe with a session id of its own, a transcript-less session in the same folder ...
      await write('1004.json', { pid: 1004, sessionId: probeSid, cwd: '/home/user/demo-project', status: 'idle', entrypoint: PROBE_ENTRYPOINT_TAG, statusUpdatedAt: 1792000700000 });
      // ... and a (corrupt) probe file that borrows a real session id with a newer status.
      await write('1005.json', { pid: 1005, sessionId: SID(3), cwd: '/home/user/demo-project', status: 'waiting', entrypoint: PROBE_ENTRYPOINT_TAG, statusUpdatedAt: 1792000999999 });
      const w = make();
      const sessions = byId(await w.poll());
      assert.equal(w.errorCount, 0);
      assert.equal(sessions.size, 9);
      assert.equal(sessions.has(probeSid), false);
      assert.equal(sessions.get(SID(3))!.live?.pid, 1001);
      assert.equal(sessions.get(SID(3))!.live?.status, 'busy');

      // Control: the same file with any other entrypoint is a normal live file and wins (newer, alive).
      await write('1005.json', { pid: 1005, sessionId: SID(3), cwd: '/home/user/demo-project', status: 'waiting', entrypoint: 'claude-office', statusUpdatedAt: 1792000999999 });
      const w2 = make();
      assert.equal(byId(await w2.poll()).get(SID(3))!.live?.status, 'waiting');
    } finally {
      LIVE_PIDS.delete(1004);
      LIVE_PIDS.delete(1005);
    }
  });
});

test('a pid file whose process is gone is reported with alive=false and does not keep an old session', async () => {
  await withRig(async ({ make, clock }) => {
    const w = make({ isPidAlive: () => false });
    const u = await w.poll();
    assert.equal(byId(u).get(SID(3))!.live?.alive, false);
    clock.now = BASE + 31 * MIN;
    assert.equal((await w.poll()).sessions.length, 0);
  });
});

test('a missing claudeHome yields an empty update without errors', async () => {
  const w = new ClaudeWatcher({ claudeHome: path.join('/nonexistent', 'claude-office-test'), scope: 'all' });
  const u = await w.poll();
  assert.deepEqual(u, { sessions: [], batches: [] });
  assert.equal(w.errorCount, 0);
});

test('start() polls repeatedly without overlap and swallows callback errors', async () => {
  await withRig(async ({ make }) => {
    const w = make();
    let calls = 0;
    const updates: WatchUpdate[] = [];
    await new Promise<void>((resolve) => {
      w.start(5, (u) => {
        calls++;
        updates.push(u);
        if (calls === 1) throw new Error('consumer bug');
        if (calls === 3) resolve();
      });
    });
    w.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, seen, 'no more updates after stop()');
    assert.equal(w.errorCount, 1);
    assert.equal(updates[0]!.sessions.length, 9);
    assert.equal(updates[1]!.batches.length, 0);
  });
});
