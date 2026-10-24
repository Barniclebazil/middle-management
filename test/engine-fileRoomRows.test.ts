// The row helpers the File room panel uses (fileRoomLogic.ts): detail line, Link and Secret markers, accessible name, and the
// folder you leave when you go up. The panels themselves need a DOM, which the test runner does not have (no jsdom), so their
// rendering, keyboard and request handling were checked in the panel playground (dev/panels.ts) with screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childBelow, entryChips, entryDetail, entryLabel } from '../webview/engine/fileRoomLogic.ts';
import type { DirEntry } from '../src/shared/protocol.ts';

test('childBelow: the folder you came out of when going up', () => {
  assert.equal(childBelow('', 'src/engine/deep'), 'src');
  assert.equal(childBelow('src', 'src/engine/deep'), 'engine');
  assert.equal(childBelow('src/engine', 'src/engine/deep'), 'deep');
  assert.equal(childBelow('src', 'src'), undefined);
  assert.equal(childBelow('', ''), undefined);
});

test('rows: detail, markers and accessible name', () => {
  const now = Date.parse('2026-10-20T12:00:00');
  const file: DirEntry = { name: 'notes.md', kind: 'file', size: 2150, mtime: Date.parse('2026-10-20T09:05:00') };
  assert.equal(entryDetail(file, now), '2.1 KB · 09:05');
  assert.deepEqual(entryChips(file), []);
  assert.equal(entryLabel(file, entryDetail(file, now), []), 'notes.md, 2.1 KB · 09:05');

  const secret: DirEntry = { name: '.env', kind: 'file', size: 10, mtime: now, secret: true };
  assert.deepEqual(entryChips(secret), ['Secret']);
  assert.match(entryLabel(secret, entryDetail(secret, now), entryChips(secret)), /^\.env, .*secret$/);

  const link: DirEntry = { name: 'current', kind: 'dir', link: true };
  assert.equal(entryDetail(link, now), '');
  assert.deepEqual(entryChips(link), ['Link']);
  assert.equal(entryLabel(link, '', ['Link']), 'current, folder, link');
  assert.equal(entryLabel({ name: 'src', kind: 'dir' }, '', []), 'src, folder');
  assert.deepEqual(entryChips({ name: 'l', kind: 'file', link: true, secret: true }), ['Link', 'Secret']);

  assert.equal(entryDetail({ name: 'x.sock', kind: 'other' }, now), 'Cannot be opened');
});
