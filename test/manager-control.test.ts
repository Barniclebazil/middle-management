import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ResumeRefused, assertCanResume, checkResume, controlFor, liveSessionIdsFromDisk } from '../src/manager/control.ts';

const none = new Set<string>();

/** A fake session file's key: the path `liveSessionIdsFromDisk` builds for `<home>/sessions/<name>` (backslashes on Windows). */
const sessionFile = (name: string): string => path.join('/c', 'sessions', name);

test('temps are never controllable', () => {
  assert.equal(controlFor({ id: 's/a1', kind: 'temp', sessionId: 's' }, new Set(['s']), new Set(['s'])), 'none');
});

test('a runner in this extension means office, even with a live sessions file', () => {
  assert.equal(controlFor({ id: 's', kind: 'main', sessionId: 's' }, new Set(['s']), new Set(['s'])), 'office');
});

test('a live process elsewhere means elsewhere', () => {
  assert.equal(controlFor({ id: 's', kind: 'main', sessionId: 's' }, new Set(['s']), none), 'elsewhere');
});

test('no runner and no live process means free; the id is the session id when sessionId is absent', () => {
  assert.equal(controlFor({ id: 's', kind: 'main', sessionId: 's' }, none, none), 'free');
  assert.equal(controlFor({ id: 's', kind: 'main' }, new Set(['s']), none), 'elsewhere');
});

test('checkResume / assertCanResume allow only free sessions', () => {
  assert.deepEqual(checkResume('s', none, none), { ok: true });
  const live = checkResume('s', new Set(['s']), none);
  assert.equal(live.ok, false);
  assert.equal((live as { control: string }).control, 'elsewhere');
  const run = checkResume('s', new Set(['s']), new Set(['s']));
  assert.equal((run as { control: string }).control, 'office');
  assert.doesNotThrow(() => assertCanResume('s', none, none));
  assert.throws(() => assertCanResume('s', new Set(['s']), none), (e: unknown) => e instanceof ResumeRefused && e.control === 'elsewhere');
});

test('liveSessionIdsFromDisk reads only <digits>.json, only live pids, never *.key', () => {
  const read: string[] = [];
  const files: Record<string, string> = {
    [sessionFile('100.json')]: JSON.stringify({ pid: 100, sessionId: 'alive-1' }),
    [sessionFile('200.json')]: JSON.stringify({ pid: 200, sessionId: 'dead-1' }),
    [sessionFile('300.json')]: 'not json',
    [sessionFile('400.abcdef.key')]: 'SECRET',
    [sessionFile('500.json')]: JSON.stringify({ sessionId: 'alive-by-filename' }),
  };
  const ids = liveSessionIdsFromDisk({
    home: '/c',
    fs: {
      readdir: () => ['100.json', '200.json', '300.json', '400.abcdef.key', '500.json', 'notes.txt'],
      readFile: (f) => {
        read.push(f);
        return files[f]!;
      },
    },
    isPidAlive: (pid) => pid === 100 || pid === 500,
  });
  assert.deepEqual([...ids].sort(), ['alive-1', 'alive-by-filename']);
  assert.ok(!read.some((f) => f.includes('.key')));
});

test('liveSessionIdsFromDisk ignores the usage probe (entrypoint claude-office-probe) but not other entrypoints', () => {
  const files: Record<string, string> = {
    [sessionFile('100.json')]: JSON.stringify({ pid: 100, sessionId: 'probe-1', entrypoint: 'claude-office-probe' }),
    [sessionFile('200.json')]: JSON.stringify({ pid: 200, sessionId: 'office-1', entrypoint: 'claude-office' }),
    [sessionFile('300.json')]: JSON.stringify({ pid: 300, sessionId: 'vscode-1', entrypoint: 'claude-vscode' }),
    [sessionFile('400.json')]: JSON.stringify({ pid: 400, sessionId: 'plain-1' }),
  };
  const ids = liveSessionIdsFromDisk({
    home: '/c',
    fs: { readdir: () => Object.keys(files).map((f) => path.basename(f)), readFile: (f) => files[f]! },
    isPidAlive: () => true,
  });
  assert.deepEqual([...ids].sort(), ['office-1', 'plain-1', 'vscode-1']);
});

test('liveSessionIdsFromDisk gives an empty set when the folder is missing', () => {
  const ids = liveSessionIdsFromDisk({ home: '/c', fs: { readdir: () => { throw new Error('ENOENT'); }, readFile: () => '' } });
  assert.equal(ids.size, 0);
});
