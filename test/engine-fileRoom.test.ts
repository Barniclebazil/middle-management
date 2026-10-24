import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  breadcrumbs, childPath, entryMeta, formatDate, formatSize, groupEntries, handPrefill, isOpenable, parentPath,
  previewDecision, rootGroups, sortEntries, truncatedNote,
} from '../webview/engine/fileRoomLogic.ts';
import type { DirEntry, FileRoot } from '../src/shared/protocol.ts';

test('breadcrumbs start at the root and grow by segment', () => {
  assert.deepEqual(breadcrumbs('Docs', ''), [{ label: 'Docs', relPath: '' }]);
  assert.deepEqual(breadcrumbs('Docs', 'a/b é/c'), [
    { label: 'Docs', relPath: '' }, { label: 'a', relPath: 'a' }, { label: 'b é', relPath: 'a/b é' }, { label: 'c', relPath: 'a/b é/c' },
  ]);
  assert.equal(breadcrumbs('r', 'a//b').length, 3, 'empty segments are skipped');
  assert.equal(breadcrumbs('r', Array.from({ length: 300 }, (_, i) => `d${i}`).join('/')).length, 301);
});

test('parent and child paths', () => {
  assert.equal(parentPath(''), null);
  assert.equal(parentPath('a'), '');
  assert.equal(parentPath('a/b/c'), 'a/b');
  assert.equal(childPath('', 'x'), 'x');
  assert.equal(childPath('a/b', '日本'), 'a/b/日本');
});

const e = (name: string, kind: DirEntry['kind'] = 'file', more: Partial<DirEntry> = {}): DirEntry => ({ name, kind, ...more });

test('entries sort folders, files, others; names by number and case-blind', () => {
  const list = [e('b.txt'), e('Zeta', 'dir'), e('sock', 'other'), e('file10'), e('file2'), e('alpha', 'dir'), e('A.txt'), e('été'), e('日本')];
  assert.deepEqual(sortEntries(list).map((x) => x.name), ['alpha', 'Zeta', 'A.txt', 'b.txt', 'été', 'file2', 'file10', '日本', 'sock']);
  assert.equal(list[0]!.name, 'b.txt', 'input is not changed');
  assert.deepEqual(sortEntries([e('a'), e('A')]).map((x) => x.name), ['A', 'a'], 'ties are broken by code order');
  assert.deepEqual(sortEntries([]), []);
});

test('entries group by kind', () => {
  const g = groupEntries([e('f'), e('d', 'dir'), e('o', 'other'), e('g'), e('c', 'dir')]);
  assert.deepEqual(g.folders.map((x) => x.name), ['c', 'd']);
  assert.deepEqual(g.files.map((x) => x.name), ['f', 'g']);
  assert.deepEqual(g.others.map((x) => x.name), ['o']);
  assert.deepEqual(groupEntries([]), { folders: [], files: [], others: [] });
  const huge = Array.from({ length: 5000 }, (_, i) => e(`f${i}`, i % 2 ? 'dir' : 'file'));
  const hg = groupEntries(huge);
  assert.equal(hg.folders.length + hg.files.length, 5000);
  assert.equal(hg.files[0]!.name, 'f0');
  assert.equal(hg.files[1]!.name, 'f2');
});

test('only non-other entries open', () => {
  assert.ok(isOpenable(e('a')));
  assert.ok(isOpenable(e('a', 'dir')));
  assert.ok(!isOpenable(e('a', 'other')));
});

test('human sizes', () => {
  assert.equal(formatSize(undefined), '');
  assert.equal(formatSize(-1), '');
  assert.equal(formatSize(NaN), '');
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1 KB');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(12 * 1024), '12 KB');
  assert.equal(formatSize(3.2 * 1024 * 1024), '3.2 MB');
  assert.equal(formatSize(5 * 1024 ** 3), '5 GB');
  assert.equal(formatSize(5000 * 1024 ** 4), '5000 TB', 'stops at TB');
});

test('human dates', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime();
  assert.equal(formatDate(undefined, now), '');
  assert.equal(formatDate(Infinity, now), '');
  assert.equal(formatDate(new Date(2026, 9, 20, 9, 5).getTime(), now), '09:05');
  assert.equal(formatDate(new Date(2026, 2, 3, 9, 5).getTime(), now), '3 Mar');
  assert.equal(formatDate(new Date(2024, 11, 25, 9, 5).getTime(), now), '25 Dec 2024');
});

test('row small print', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime();
  const t = new Date(2026, 2, 3).getTime();
  assert.equal(entryMeta(e('a', 'file', { size: 1536, mtime: t }), now), '1.5 KB · 3 Mar');
  assert.equal(entryMeta(e('a', 'file'), now), '');
  assert.equal(entryMeta(e('a', 'file', { size: 5, link: true }), now), '5 B · Link');
  assert.equal(entryMeta(e('.env', 'file', { size: 5, secret: true }), now), '5 B · Secret');
  assert.equal(entryMeta(e('d', 'dir', { link: true }), now), 'Link');
  assert.equal(entryMeta(e('d', 'dir'), now), '');
  assert.equal(entryMeta(e('s', 'other'), now), 'Cannot be opened');
  assert.equal(truncatedNote(500, false), '');
  assert.match(truncatedNote(500, true), /first 500 items/);
});

test('preview decisions cover every flag', () => {
  const base = { size: 10 };
  const secret = previewDecision({ ...base, secret: true });
  assert.equal(secret.kind, 'secret');
  assert.ok(secret.openOnly && secret.text === undefined);
  assert.match(secret.message, /secret/);
  assert.equal(previewDecision({ size: 9 * 1024 * 1024, tooLarge: true }).kind, 'tooLarge');
  assert.match(previewDecision({ size: 9 * 1024 * 1024, tooLarge: true }).message, /too large.*9 MB/);
  assert.equal(previewDecision({ ...base, binary: true }).kind, 'binary');
  assert.equal(previewDecision({ ...base, binary: true }).openOnly, true);
  assert.equal(previewDecision({ ...base, secret: true, tooLarge: true, binary: true, text: 'x' }).kind, 'secret', 'order: secret, tooLarge, binary');
  assert.equal(previewDecision({ ...base, tooLarge: true, binary: true }).kind, 'tooLarge');
  const plain = previewDecision({ ...base, text: 'hello' });
  assert.deepEqual([plain.kind, plain.text, plain.markdown, plain.message, plain.openOnly], ['text', 'hello', false, '', false]);
  const md = previewDecision({ ...base, text: '# hi', markdown: true });
  assert.deepEqual([md.kind, md.markdown], ['markdown', true]);
  assert.equal(previewDecision({ size: 0, text: '' }).message, 'This file is empty.');
  const cut = previewDecision({ size: 3 * 1024 * 1024, text: 'é'.repeat(1024), truncated: true, markdown: true });
  assert.equal(cut.kind, 'truncated');
  assert.equal(cut.markdown, true);
  assert.equal(cut.openOnly, false);
  assert.match(cut.message, /first 2 KB of 3 MB/, 'bytes, not characters');
  const none = previewDecision({ size: 3 });
  assert.equal(none.kind, 'binary');
  assert.ok(none.openOnly);
});

test('hand to a worker', () => {
  const root = { projectPath: '/work/proj' };
  assert.deepEqual(handPrefill(root, 'src/a b.ts', false), { projectPath: '/work/proj', prompt: 'src/a b.ts' });
  assert.deepEqual(handPrefill(root, 'src/日本', true), { projectPath: '/work/proj', prompt: 'src/日本/' });
  assert.deepEqual(handPrefill(root, '', true), { projectPath: '/work/proj' });
});

test('root picker groups by kind, in order, without empty groups', () => {
  const r = (rootId: string, label: string, kind: FileRoot['kind']): FileRoot => ({ rootId, label, kind, display: `~/${label}`, projectPath: `/x/${label}` });
  assert.deepEqual(rootGroups([]), []);
  const g = rootGroups([r('1', 'zed', 'project'), r('2', 'b', 'workspace'), r('3', 'A', 'workspace'), r('4', 'é', 'project')]);
  assert.deepEqual(g.map((x) => x.kind), ['workspace', 'project']);
  assert.deepEqual(g[0]!.roots.map((x) => x.label), ['A', 'b']);
  assert.deepEqual(g[1]!.roots.map((x) => x.label), ['é', 'zed']);
  const agents = rootGroups([r('5', 'w', 'agent')]);
  assert.equal(agents.length, 1);
  assert.ok(agents[0]!.title.length > 0);
  const many = Array.from({ length: 100 }, (_, i) => r(`r${i}`, `p${i}`, 'agent'));
  assert.equal(rootGroups(many)[0]!.roots.length, 100);
});
