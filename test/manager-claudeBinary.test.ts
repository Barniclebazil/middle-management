import test from 'node:test';
import assert from 'node:assert/strict';
import { findClaudeBinary } from '../src/manager/claudeBinary.ts';
import type { FindBinaryOptions } from '../src/manager/claudeBinary.ts';

function opts(files: string[], extra: Partial<FindBinaryOptions> = {}): FindBinaryOptions {
  const set = new Set(files);
  return {
    claudeCodeExtensionPaths: [],
    homedir: '/home/me',
    platform: 'linux',
    PATH: '/usr/local/bin:/usr/bin',
    exists: (p) => set.has(p),
    ...extra,
  };
}

test('the setting wins when it exists', () => {
  const r = findClaudeBinary(opts(['/opt/claude', '/home/me/.local/bin/claude'], { settingPath: '/opt/claude' }));
  assert.deepEqual(r, { path: '/opt/claude', source: 'setting' });
});

test('a missing setting falls through to the extension binary', () => {
  const ext = '/ext/anthropic.claude-code-2.1.302-linux-x64';
  const r = findClaudeBinary(opts([ext + '/resources/native-binary/claude'], { settingPath: '/nope/claude', claudeCodeExtensionPaths: [ext] }));
  assert.deepEqual(r, { path: ext + '/resources/native-binary/claude', source: 'extension' });
});

test('order: extension, then ~/.local/bin, then PATH', () => {
  const ext = '/ext/cc';
  const all = [ext + '/resources/native-binary/claude', '/home/me/.local/bin/claude', '/usr/bin/claude'];
  assert.equal((findClaudeBinary(opts(all, { claudeCodeExtensionPaths: [ext] })) as { source: string }).source, 'extension');
  assert.equal((findClaudeBinary(opts(all.slice(1), { claudeCodeExtensionPaths: [ext] })) as { source: string }).source, 'local-bin');
  assert.deepEqual(findClaudeBinary(opts(all.slice(2), { claudeCodeExtensionPaths: [ext] })), { path: '/usr/bin/claude', source: 'path' });
});

test('the first of several Claude Code extensions that has the binary is used', () => {
  const r = findClaudeBinary(opts(['/e2/resources/native-binary/claude'], { claudeCodeExtensionPaths: ['/e1', '/e2'] }));
  assert.deepEqual(r, { path: '/e2/resources/native-binary/claude', source: 'extension' });
});

test('a non-executable file is skipped on POSIX', () => {
  const r = findClaudeBinary(opts(['/usr/bin/claude', '/usr/local/bin/claude'], { isExecutable: (p) => p === '/usr/bin/claude' }));
  assert.deepEqual(r, { path: '/usr/bin/claude', source: 'path' });
});

test('win32 accepts claude.exe only and never .cmd or .bat', () => {
  const ext = 'C:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code-2.1.302-win32-x64';
  const exe = ext + '\\resources\\native-binary\\claude.exe';
  const r = findClaudeBinary(opts([exe], { platform: 'win32', homedir: 'C:\\Users\\me', PATH: 'C:\\npm', claudeCodeExtensionPaths: [ext] }));
  assert.deepEqual(r, { path: exe, source: 'extension' });

  // Only a claude.cmd shim on PATH: not found.
  const shim = findClaudeBinary(opts(['C:\\npm\\claude.cmd', 'C:\\npm\\claude'], { platform: 'win32', homedir: 'C:\\Users\\me', PATH: 'C:\\npm' }));
  assert.ok('error' in shim);

  // claude.exe on PATH is found.
  const onPath = findClaudeBinary(opts(['C:\\npm\\claude.exe'], { platform: 'win32', homedir: 'C:\\Users\\me', PATH: 'C:\\x;C:\\npm' }));
  assert.deepEqual(onPath, { path: 'C:\\npm\\claude.exe', source: 'path' });

  // ~\.local\bin\claude.exe
  const local = findClaudeBinary(opts(['C:\\Users\\me\\.local\\bin\\claude.exe'], { platform: 'win32', homedir: 'C:\\Users\\me', PATH: '' }));
  assert.deepEqual(local, { path: 'C:\\Users\\me\\.local\\bin\\claude.exe', source: 'local-bin' });
});

test('win32 refuses a .cmd/.bat setting and says why', () => {
  const r = findClaudeBinary(opts(['C:\\npm\\claude.cmd'], { platform: 'win32', homedir: 'C:\\Users\\me', PATH: '', settingPath: 'C:\\npm\\claude.cmd' }));
  assert.ok('error' in r);
  assert.match((r as { error: string }).error, /\.cmd\/\.bat shim/);
});

test('the error names what was tried and what to do', () => {
  const r = findClaudeBinary(opts([], { settingPath: '/bad/claude', claudeCodeExtensionPaths: ['/ext/cc'] }));
  assert.ok('error' in r);
  const msg = (r as { error: string }).error;
  assert.match(msg, /claudeOffice\.claudePath "\/bad\/claude"/);
  assert.match(msg, /\/ext\/cc\/resources\/native-binary\/claude/);
  assert.match(msg, /\.local\/bin\/claude/);
  assert.match(msg, /PATH/);
  assert.match(msg, /Install the Claude Code extension/);
});

test('a throwing file check counts as missing', () => {
  const r = findClaudeBinary(opts([], { exists: () => { throw new Error('boom'); } }));
  assert.ok('error' in r);
});
