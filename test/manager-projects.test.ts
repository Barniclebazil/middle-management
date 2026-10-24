import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/shared/protocol.ts';
import { listProjects, parseGitHead, readGitBranch, recentCwdsFrom } from '../src/manager/projects.ts';
import type { ProjectFs } from '../src/manager/projects.ts';

/** A tiny in-memory file system: `files` maps path to text, `dirs` lists extra folders. Reading a folder gives undefined. */
function memfs(files: Record<string, string>, dirs: string[] = []): ProjectFs {
  const all = new Set<string>(dirs);
  for (const f of Object.keys(files)) {
    all.add(f);
    let d = f;
    for (;;) {
      const i = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\'));
      if (i <= 0) break;
      d = d.slice(0, i);
      all.add(d);
    }
  }
  return { exists: (p) => all.has(p), readFile: (p) => files[p] };
}

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

test('parseGitHead: branch, nested branch, detached, junk', () => {
  assert.equal(parseGitHead('ref: refs/heads/main\n'), 'main');
  assert.equal(parseGitHead('ref: refs/heads/feature/x-1\n'), 'feature/x-1');
  assert.equal(parseGitHead(SHA + '\n'), 'a1b2c3d');
  assert.equal(parseGitHead('hello'), undefined);
});

test('readGitBranch: normal repo', () => {
  const fs = memfs({ '/p/repo/.git/HEAD': 'ref: refs/heads/main\n' });
  assert.equal(readGitBranch('/p/repo', fs), 'main');
});

test('readGitBranch: walks up from a subfolder to the repo root', () => {
  const fs = memfs({ '/p/repo/.git/HEAD': 'ref: refs/heads/dev\n' }, ['/p/repo/src/deep']);
  assert.equal(readGitBranch('/p/repo/src/deep', fs), 'dev');
});

test('readGitBranch: detached HEAD gives the first 7 characters of the sha', () => {
  const fs = memfs({ '/p/repo/.git/HEAD': SHA + '\n' });
  assert.equal(readGitBranch('/p/repo', fs), 'a1b2c3d');
});

test('readGitBranch: worktree where .git is a file with an absolute gitdir', () => {
  const fs = memfs({
    '/p/wt/.git': 'gitdir: /p/main/.git/worktrees/wt\n',
    '/p/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
  });
  assert.equal(readGitBranch('/p/wt', fs), 'feature');
});

test('readGitBranch: submodule with a relative gitdir', () => {
  const fs = memfs({
    '/p/super/sub/.git': 'gitdir: ../.git/modules/sub\n',
    '/p/super/.git/modules/sub/HEAD': 'ref: refs/heads/sub-branch\n',
    '/p/super/.git/HEAD': 'ref: refs/heads/outer\n',
  });
  assert.equal(readGitBranch('/p/super/sub', fs), 'sub-branch');
  assert.equal(readGitBranch('/p/super', fs), 'outer');
});

test('readGitBranch: not a repo, unreadable .git, and Windows paths', () => {
  assert.equal(readGitBranch('/p/none', memfs({}, ['/p/none'])), undefined);
  assert.equal(readGitBranch('/p/x', { exists: (p) => p === '/p/x/.git', readFile: () => undefined }), undefined);
  const win = memfs({ 'C:\\work\\app\\.git\\HEAD': 'ref: refs/heads/win\n' });
  assert.equal(readGitBranch('C:\\work\\app\\src', { exists: win.exists, readFile: win.readFile }), 'win');
});

test('readGitBranch never throws', () => {
  const boom: ProjectFs = { exists: () => { throw new Error('x'); }, readFile: () => { throw new Error('y'); } };
  assert.equal(readGitBranch('/p', boom), undefined);
});

test('listProjects: workspace first, then recent, then browsed; duplicates removed; flags set', () => {
  const fs = memfs({ '/w/a/.git/HEAD': 'ref: refs/heads/main\n' }, ['/w/b', '/r/one', '/br']);
  const list = listProjects({
    workspaceFolders: ['/w/a', '/w/b'],
    recentCwds: ['/r/one', '/w/a', '/gone/dir', '/r/one'],
    browsed: ['/br', '/w/b'],
    ...fs,
    platform: 'linux',
  });
  assert.deepEqual(list.map((p) => [p.path, p.source, p.exists]), [
    ['/w/a', 'workspace', true],
    ['/w/b', 'workspace', true],
    ['/r/one', 'recent', true],
    ['/gone/dir', 'recent', false],
    ['/br', 'browsed', true],
  ]);
  assert.equal(list[0]!.gitBranch, 'main');
  assert.equal(list[0]!.name, 'a');
  assert.equal(list[1]!.gitBranch, undefined);
});

test('listProjects: case-insensitive on win32 only', () => {
  const fs = memfs({}, []);
  const win = listProjects({ workspaceFolders: ['C:\\Work\\App'], recentCwds: ['c:\\work\\app', 'D:\\x'], ...fs, platform: 'win32' });
  assert.deepEqual(win.map((p) => p.path), ['C:\\Work\\App', 'D:\\x']);
  const posix = listProjects({ workspaceFolders: ['/Work/App'], recentCwds: ['/work/app'], ...fs, platform: 'linux' });
  assert.equal(posix.length, 2);
});

test('listProjects: caps at LIMITS.projects and keeps the browsed folder', () => {
  const fs = memfs({});
  const recent = Array.from({ length: 80 }, (_, i) => `/r/${i}`);
  const list = listProjects({ workspaceFolders: ['/w'], recentCwds: recent, browsed: ['/picked'], ...fs, platform: 'linux' });
  assert.equal(list.length, LIMITS.projects);
  assert.equal(list[0]!.path, '/w');
  assert.equal(list[list.length - 1]!.path, '/picked');
});

test('listProjects ignores relative and junk paths', () => {
  const list = listProjects({ workspaceFolders: ['rel/path', ''], recentCwds: ['/ok', 5 as unknown as string], ...memfs({}), platform: 'linux' });
  assert.deepEqual(list.map((p) => p.path), ['/ok']);
});

test('recentCwdsFrom: newest first, de-duplicated, temps skipped, sessions merged', () => {
  const out = recentCwdsFrom(
    [
      { kind: 'main', cwd: '/a', since: 100 },
      { kind: 'main', cwd: '/b', since: 300 },
      { kind: 'temp', cwd: '/temp-only', since: 999 },
      { kind: 'main', cwd: '/a', since: 50, lastPromptAt: 400 },
      { kind: 'main', since: 10 },
    ],
    [{ cwd: '/c', mtimeMs: 350 }, { mtimeMs: 1 }],
  );
  assert.deepEqual(out, ['/a', '/c', '/b']);
});
