import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutView, receptionistUpdateLine, relativeTime, showUpdateCue, updateMemo } from '../webview/engine/updateLogic.ts';
import type { UpdateInfo, UpdateStatus } from '../src/shared/protocol.ts';
import { UPDATE_STATUSES } from '../src/shared/protocol.ts';

const info = (status: UpdateStatus, extra: Partial<UpdateInfo> = {}): UpdateInfo => ({ status, current: '0.5.0', auto: true, ...extra });
const names = { company: 'Acme', branch: 'Riverside Branch' };

test('cue: only available (not hidden) and installed', () => {
  for (const s of UPDATE_STATUSES) {
    const expected = s === 'available' || s === 'installed';
    assert.equal(showUpdateCue(info(s, { latest: '0.6.0' })), expected, s);
  }
  assert.equal(showUpdateCue(info('available', { hidden: true })), false);
  assert.equal(showUpdateCue(info('installed', { hidden: true })), true);
  assert.equal(showUpdateCue(undefined), false);
});

test('receptionist line follows the cue and stays short', () => {
  assert.equal(receptionistUpdateLine(info('available')), 'Post from head office!');
  assert.equal(receptionistUpdateLine(info('installed')), 'Reload to finish!');
  assert.equal(receptionistUpdateLine(info('available', { hidden: true })), undefined);
  assert.equal(receptionistUpdateLine(info('error')), undefined);
  assert.equal(receptionistUpdateLine(undefined), undefined);
  for (const s of ['available', 'installed'] as const) assert.ok((receptionistUpdateLine(info(s)) ?? '').length <= 25);
});

test('memo: available', () => {
  const m = updateMemo(info('available', { latest: '0.6.0', notesUrl: 'https://example.test/r' }), names);
  assert.ok(m);
  assert.equal(m.heading, 'INTEROFFICE MEMO');
  assert.equal(m.from, 'Head Office');
  assert.equal(m.to, 'All staff, Riverside Branch');
  assert.equal(m.subject, 'New version of the office');
  assert.equal(m.busy, false);
  assert.equal(m.notesUrl, 'https://example.test/r');
  const text = m.paragraphs.join(' ');
  assert.match(text, /0\.6\.0/);
  assert.match(text, /0\.5\.0/);
  assert.match(text, /reloads/);
  assert.deepEqual(m.buttons.map((b) => [b.action, b.kind]), [['install', 'primary'], ['later', 'secondary'], ['skip', 'ghost'], ['notes', 'link']]);
  assert.deepEqual(m.buttons.map((b) => b.label), ['Install now', 'Remind me later', 'Skip this version', 'Release notes']);
});

test('memo: available without notesUrl has no notesUrl key', () => {
  const m = updateMemo(info('available', { latest: '0.6.0' }), names);
  assert.ok(m && !('notesUrl' in m));
  assert.ok(!m.buttons.some((b) => b.action === 'notes'));
});

test('memo: hidden available still builds (caller decides when to show)', () => {
  assert.ok(updateMemo(info('available', { latest: '0.6.0', hidden: true }), names));
});

test('memo: downloading is busy with no buttons', () => {
  const m = updateMemo(info('downloading', { latest: '0.6.0' }), names);
  assert.ok(m);
  assert.equal(m.busy, true);
  assert.deepEqual(m.buttons, []);
  assert.deepEqual(m.paragraphs, ['Downloading version 0.6.0…']);
});

test('memo: installed', () => {
  const m = updateMemo(info('installed', { latest: '0.6.0' }), names);
  assert.ok(m);
  assert.deepEqual(m.paragraphs, ['Version 0.6.0 is installed. Reload the window to start using it.']);
  assert.deepEqual(m.buttons, [
    { action: 'reload', label: 'Reload now', kind: 'primary' },
    { action: 'close', label: 'Not now', kind: 'ghost' },
  ]);
  assert.equal(m.busy, false);
});

test('memo: error uses the message or a fallback', () => {
  const a = updateMemo(info('error', { message: 'No network.' }), names);
  assert.ok(a);
  assert.deepEqual(a.paragraphs, ['No network.']);
  assert.deepEqual(a.buttons.map((b) => [b.action, b.label, b.kind]), [['check', 'Try again', 'secondary'], ['close', 'Close', 'ghost']]);
  const b = updateMemo(info('error'), names);
  assert.ok(b && b.paragraphs[0] && b.paragraphs[0].length > 0);
});

test('memo: checking (after Try again) is busy, without buttons', () => {
  const m = updateMemo(info('checking'), names);
  assert.ok(m);
  assert.equal(m.busy, true);
  assert.deepEqual(m.buttons, []);
  assert.deepEqual(m.paragraphs, ['Checking with head office…']);
});

test('memo: other statuses give none', () => {
  for (const s of ['idle', 'upToDate'] as const) assert.equal(updateMemo(info(s), names), undefined, s);
});

test('memo: branch name handling', () => {
  const to = (branch: string): string | undefined => updateMemo(info('installed', { latest: '1' }), { company: 'Acme', branch })?.to;
  assert.equal(to(''), 'All staff');
  assert.equal(to('   '), 'All staff');
  assert.equal(to(' Harbour '), 'All staff, Harbour');
  assert.equal(to('Riverside Branch'), 'All staff, Riverside Branch');
});

test('relativeTime boundaries', () => {
  const now = 10_000_000_000;
  const ago = (ms: number): string => relativeTime(now - ms, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59_999), 'just now');
  assert.equal(ago(60_000), '1 minute ago');
  assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(59 * 60_000 + 59_000), '59 minutes ago');
  assert.equal(ago(3_600_000), '1 hour ago');
  assert.equal(ago(5 * 3_600_000), '5 hours ago');
  assert.equal(ago(24 * 3_600_000 - 1), '23 hours ago');
  assert.equal(ago(24 * 3_600_000), 'yesterday');
  assert.equal(ago(47 * 3_600_000), 'yesterday');
  assert.equal(ago(48 * 3_600_000), '2 days ago');
  assert.equal(ago(13 * 86_400_000), '13 days ago');
  assert.equal(ago(14 * 86_400_000), '2 weeks ago');
  assert.equal(ago(60 * 86_400_000), '2 months ago');
  assert.equal(relativeTime(now + 5000, now), 'just now');
});

test('about: no info uses the fallback version', () => {
  const v = aboutView(undefined, 1000, '0.5.0');
  assert.equal(v.versionLine, 'Middle Management 0.5.0');
  assert.equal(v.lastChecked, 'never');
  assert.equal(v.statusLine, '');
  assert.equal(v.checking, false);
  assert.equal(v.autoLine, 'Checks GitHub once a day.');
  assert.deepEqual(v.buttons, [{ action: 'check', label: 'Check for updates', kind: 'secondary' }]);
});

test('about: status lines and buttons per status', () => {
  const now = 1_000_000;
  const at = (s: UpdateStatus, extra: Partial<UpdateInfo> = {}) => aboutView(info(s, { latest: '0.6.0', ...extra }), now, 'x');
  assert.equal(at('checking').statusLine, 'Checking GitHub…');
  assert.equal(at('checking').checking, true);
  assert.equal(at('checking').buttons[0]?.action, 'check');
  assert.equal(at('upToDate').statusLine, 'You have the latest version.');
  assert.equal(at('available').statusLine, 'Version 0.6.0 is available.');
  assert.equal(at('available', { hidden: true }).statusLine, 'Version 0.6.0 is available.');
  assert.deepEqual(at('available').buttons.map((b) => [b.action, b.label, b.kind]), [
    ['check', 'Check for updates', 'secondary'], ['install', 'Install 0.6.0', 'primary'],
  ]);
  const withNotes = (extra: Partial<UpdateInfo> = {}) => at('available', { notesUrl: 'https://example.test/r', ...extra }).buttons;
  const link = { action: 'notes', label: 'Release notes', kind: 'link' };
  assert.deepEqual(withNotes().at(-1), link);
  assert.deepEqual(withNotes({ hidden: true }).at(-1), link);
  assert.ok(!at('upToDate', { notesUrl: 'https://example.test/r' }).buttons.some((b) => b.action === 'notes'));
  assert.equal(at('downloading').statusLine, 'Downloading version 0.6.0…');
  assert.equal(at('downloading').buttons.length, 1);
  assert.equal(at('installed').statusLine, 'Version 0.6.0 is installed. Reload to finish.');
  assert.deepEqual(at('installed').buttons.map((b) => b.action), ['check', 'reload']);
  assert.equal(at('error', { message: 'Offline.' }).statusLine, 'Offline.');
  assert.equal(at('error').statusLine, '');
  assert.equal(at('idle', { message: 'No releases have been published yet.' }).statusLine, 'No releases have been published yet.');
  assert.equal(at('idle').statusLine, '');
});

test('about: version, last checked and auto line', () => {
  const now = 100 * 86_400_000;
  const v = aboutView(info('upToDate', { current: '0.7.1', checkedAt: now - 5 * 60_000, auto: false }), now, '0.5.0');
  assert.equal(v.versionLine, 'Middle Management 0.7.1');
  assert.equal(v.lastChecked, '5 minutes ago');
  assert.equal(v.autoLine, 'Automatic checks are off.');
  assert.equal(aboutView(info('upToDate', { checkedAt: now - 86_400_000 }), now, 'x').lastChecked, 'yesterday');
});
