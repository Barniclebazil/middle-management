import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebviewMessage as p, relPath } from '../src/shared/validate.ts';
import { CATALOG_SECTIONS, LIMITS, MCP_SERVER_ITEM_KEYS } from '../src/shared/protocol.ts';
import type { McpServerItem } from '../src/shared/protocol.ts';

const ACCEPT: [string, string][] = [
  ['empty (the root)', ''],
  ['one name', 'README.md'],
  ['nested', 'src/shared/validate.ts'],
  ['leading dot dir', '.github/x'],
  ['dotfile', '.env'],
  ['dots in names', 'a.b/c..d/e...f.tar.gz'],
  ['name starting with two dots', '..x/y'],
  ['spaces', 'my docs/a file.txt'],
  ['space padded segment', ' a /b'],
  ['unicode', 'dokumente/\u00fcbersicht/\u65e5\u672c\u8a9e.md'],
  ['colon inside a name', 'notes/a:b.txt'],
  ['single letter file', 'c'],
  ['at the length cap', 'a/'.repeat(511) + 'a'.repeat(2)],
];

const REJECT: [string, unknown][] = [
  ['dot-dot prefix', '../x'],
  ['dot-dot inside', 'a/../b'],
  ['dot-dot trailing', 'a/..'],
  ['dot-dot alone', '..'],
  ['dot alone', '.'],
  ['dot segment', 'a/./b'],
  ['dots only segment', 'a/.../b'],
  ['dot and space segment', 'a/. ./b'],
  ['absolute', '/etc/passwd'],
  ['root slash', '/'],
  ['windows drive backslash', 'C:\\x'],
  ['windows drive slash', 'C:/x'],
  ['lowercase drive', 'c:/x'],
  ['bare drive', 'C:'],
  ['UNC', '\\\\server\\share'],
  ['UNC forward slashes', '//server/share'],
  ['backslash', 'a\\b'],
  ['NUL', 'a\u0000b'],
  ['newline', 'a\nb'],
  ['tab', 'a\tb'],
  ['escape', 'a\u001bb'],
  ['DEL', 'a\u007fb'],
  ['empty segment', 'a//b'],
  ['trailing slash', 'a/'],
  ['over the cap', 'a'.repeat(LIMITS.relPathChars + 1)],
  ['number', 5],
  ['null', null],
  ['undefined', undefined],
  ['array', ['a']],
  ['object', { toString: () => 'a' }],
];

test('relPath accepts', () => {
  for (const [name, v] of ACCEPT) assert.equal(relPath(v), v, name);
  assert.equal(relPath('a'.repeat(LIMITS.relPathChars)), 'a'.repeat(LIMITS.relPathChars));
});

test('relPath rejects', () => {
  for (const [name, v] of REJECT) assert.equal(relPath(v), undefined, name);
});

const ROOT = 'root-1';
const bad = { rootId: ['', 'x'.repeat(LIMITS.idChars + 1), 'a\nb', 'a\0b', 5, null, {}] as unknown[] };

test('getFileRoots', () => {
  assert.deepEqual(p({ type: 'getFileRoots', reqId: 'r1', junk: 1 }), { type: 'getFileRoots', reqId: 'r1' });
  assert.equal(p({ type: 'getFileRoots' }), undefined);
  assert.equal(p({ type: 'getFileRoots', reqId: '' }), undefined);
});

test('listDir and readFile', () => {
  for (const type of ['listDir', 'readFile'] as const) {
    assert.deepEqual(p({ type, reqId: 'r1', rootId: ROOT, relPath: 'src/a b.ts', junk: 1, path: '/etc/passwd' }), { type, reqId: 'r1', rootId: ROOT, relPath: 'src/a b.ts' });
    assert.deepEqual(p({ type, reqId: 'r1', rootId: ROOT, relPath: '' }), { type, reqId: 'r1', rootId: ROOT, relPath: '' });
    for (const rootId of bad.rootId) assert.equal(p({ type, reqId: 'r1', rootId, relPath: '' }), undefined);
    assert.equal(p({ type, reqId: 'r1', relPath: '' }), undefined);
    assert.equal(p({ type, reqId: '', rootId: ROOT, relPath: '' }), undefined);
    assert.equal(p({ type, rootId: ROOT, relPath: '' }), undefined);
    assert.equal(p({ type, reqId: 'r1', rootId: ROOT }), undefined);
    for (const [, rel] of REJECT) assert.equal(p({ type, reqId: 'r1', rootId: ROOT, relPath: rel }), undefined);
  }
});

test('openFile and openDiff', () => {
  for (const type of ['openFile', 'openDiff'] as const) {
    assert.deepEqual(p({ type, rootId: ROOT, relPath: '.github/x', reqId: 'r1', extra: true }), { type, rootId: ROOT, relPath: '.github/x' });
    for (const rootId of bad.rootId) assert.equal(p({ type, rootId, relPath: 'a' }), undefined);
    for (const [, rel] of REJECT) assert.equal(p({ type, rootId: ROOT, relPath: rel }), undefined);
    assert.equal(p({ type, rootId: ROOT }), undefined);
  }
});

test('getCatalog', () => {
  for (const section of CATALOG_SECTIONS) assert.deepEqual(p({ type: 'getCatalog', reqId: 'r1', section, junk: 1 }), { type: 'getCatalog', reqId: 'r1', section });
  assert.deepEqual(p({ type: 'getCatalog', reqId: 'r1', section: 'mcp', rootId: ROOT }), { type: 'getCatalog', reqId: 'r1', section: 'mcp', rootId: ROOT });
  for (const section of ['', 'Skills', 'secrets', 'all', '__proto__', 'constructor', 5, null, undefined]) assert.equal(p({ type: 'getCatalog', reqId: 'r1', section }), undefined);
  for (const rootId of bad.rootId) assert.equal(p({ type: 'getCatalog', reqId: 'r1', section: 'agents', rootId }), undefined);
  // `refresh` is `true` or absent; nothing else passes, and it never turns up when it was not asked for.
  assert.deepEqual(p({ type: 'getCatalog', reqId: 'r1', section: 'skills', refresh: true }), { type: 'getCatalog', reqId: 'r1', section: 'skills', refresh: true });
  assert.deepEqual(p({ type: 'getCatalog', reqId: 'r1', section: 'mcp', rootId: ROOT, refresh: true }), { type: 'getCatalog', reqId: 'r1', section: 'mcp', rootId: ROOT, refresh: true });
  for (const refresh of [false, 'true', 1, 0, null, {}, []]) assert.equal(p({ type: 'getCatalog', reqId: 'r1', section: 'skills', refresh }), undefined, `refresh ${JSON.stringify(refresh)}`);
  assert.equal('refresh' in (p({ type: 'getCatalog', reqId: 'r1', section: 'skills' }) as object), false);
  assert.equal(p({ type: 'getCatalog', section: 'skills' }), undefined);
  assert.equal(p({ type: 'getCatalog', reqId: '', section: 'skills' }), undefined);
});

test('openConfigFile', () => {
  assert.deepEqual(p({ type: 'openConfigFile', fileId: 'f:12', path: '/home/u/.claude/settings.json', rootId: ROOT }), { type: 'openConfigFile', fileId: 'f:12' });
  for (const fileId of ['', 'x'.repeat(LIMITS.idChars + 1), 'a\nb', 'a\0b', 5, null, undefined, {}]) assert.equal(p({ type: 'openConfigFile', fileId }), undefined);
});

test('the Round B limits are the agreed numbers', () => {
  assert.equal(LIMITS.dirEntries, 500);
  assert.equal(LIMITS.previewBytes, 262144);
  assert.equal(LIMITS.relPathChars, 1024);
  assert.ok(LIMITS.previewMaxFileBytes > LIMITS.previewBytes);
});

test('McpServerItem has no field that could hold a command, args, env, headers or URL', () => {
  // Compile-time: the key list must match the interface exactly (extra or missing keys are a type error).
  const all: Record<keyof McpServerItem, true> = { name: true, scope: true, transport: true, status: true, tools: true };
  assert.deepEqual([...MCP_SERVER_ITEM_KEYS].sort(), Object.keys(all).sort());
  for (const key of MCP_SERVER_ITEM_KEYS) assert.ok(!/command|args|env|header|url|uri|endpoint|token|secret|error|message/i.test(key), key);
});

test('never throws on hostile Round B input', () => {
  const hostile: unknown[] = [undefined, null, 0, [], {}, { toString() { throw new Error('boom'); } }, Object.create(null)];
  for (const type of ['getFileRoots', 'listDir', 'readFile', 'openFile', 'openDiff', 'getCatalog', 'openConfigFile']) {
    for (const h of hostile) {
      assert.doesNotThrow(() => p({ type, reqId: h, rootId: h, relPath: h, section: h, fileId: h }));
      assert.equal(p({ type, reqId: h, rootId: h, relPath: h, section: h, fileId: h }), undefined);
    }
  }
});
