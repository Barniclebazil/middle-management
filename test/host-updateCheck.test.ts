import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_INTERVAL_MS,
  LATER_MS,
  afterCheck,
  afterLater,
  afterSkip,
  availableMessage,
  isAllowedDownloadUrl,
  isNewer,
  noticeHidden,
  parseRelease,
  parseUpdateChecks,
  parseVersion,
  readUpdateState,
  shouldCheck,
  type ReleaseInfo,
  type UpdateState,
} from '../src/host/updateCheck.ts';

const DL = 'https://github.com/Barniclebazil/middle-management/releases/download/v0.6.0/middle-management-0.6.0.vsix';
const NOTES = 'https://github.com/Barniclebazil/middle-management/releases/tag/v0.6.0';

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.6.0',
    html_url: NOTES,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'other.txt', browser_download_url: DL, size: 5 },
      { name: 'middle-management-0.6.0.vsix', browser_download_url: DL, size: 1234 },
    ],
    ...over,
  };
}

const info: ReleaseInfo = { version: '0.6.0', notesUrl: NOTES, vsixUrl: DL, size: 1234 };

test('parseVersion accepts plain, v-prefixed and pre-release versions only', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('v10.0.7'), { major: 10, minor: 0, patch: 7 });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, pre: 'beta.1' });
  for (const bad of ['', 'latest', '1.2', '1.2.3.4', 'x1.2.3', '1.2.3-', '1.2.3 ', '1.2.3+build', undefined]) {
    assert.equal(parseVersion(bad), undefined, String(bad));
  }
});

test('isNewer compares numbers and refuses pre-release candidates', () => {
  assert.equal(isNewer('0.6.0', '0.5.0'), true);
  assert.equal(isNewer('v0.5.1', '0.5.0'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.5.0', '0.5.0'), false);
  assert.equal(isNewer('0.4.9', '0.5.0'), false);
  assert.equal(isNewer('0.6.0-beta', '0.5.0'), false);
  assert.equal(isNewer('0.6.0', '0.6.0-beta'), true);
  assert.equal(isNewer('0.6.1-beta', '0.6.0-beta'), false);
  assert.equal(isNewer('garbage', '0.5.0'), false);
  assert.equal(isNewer('0.6.0', 'garbage'), false);
  assert.equal(isNewer(undefined, '0.5.0'), false);
  assert.equal(isNewer('0.6.0', undefined), false);
});

test('parseUpdateChecks treats everything but off as auto', () => {
  assert.equal(parseUpdateChecks('off'), 'off');
  assert.equal(parseUpdateChecks('auto'), 'auto');
  assert.equal(parseUpdateChecks(undefined), 'auto');
  assert.equal(parseUpdateChecks(false), 'auto');
  assert.equal(parseUpdateChecks('OFF'), 'auto');
});

test('readUpdateState falls back on garbage and keeps good fields', () => {
  assert.deepEqual(readUpdateState(undefined), { v: 1 });
  assert.deepEqual(readUpdateState(null), { v: 1 });
  assert.deepEqual(readUpdateState('x'), { v: 1 });
  assert.deepEqual(readUpdateState([]), { v: 1 });
  assert.deepEqual(readUpdateState({ v: 2, lastChecked: 5 }), { v: 1 });
  assert.deepEqual(readUpdateState({ lastChecked: 5 }), { v: 1 });
  const full = { v: 1, lastChecked: 100, latest: '0.6.0', notesUrl: NOTES, vsixUrl: DL, size: 1234, skipped: '0.5.5', laterUntil: 200 };
  assert.deepEqual(readUpdateState(full), full);
  const partial = readUpdateState({
    v: 1,
    lastChecked: 'yesterday',
    latest: 'soon',
    notesUrl: 'https://evil.example/x',
    vsixUrl: 'http://github.com/Barniclebazil/middle-management/releases/download/a.vsix',
    size: -3,
    skipped: 7,
    laterUntil: 300,
  });
  assert.deepEqual(partial, { v: 1, laterUntil: 300 });
  assert.deepEqual(readUpdateState({ v: 1, lastChecked: Number.NaN, size: 1.5 }), { v: 1 });
});

test('shouldCheck: off, never checked, the interval boundary, and a clock set back', () => {
  assert.equal(shouldCheck({ v: 1 }, 1000, 'off'), false);
  assert.equal(shouldCheck({ v: 1, lastChecked: 1 }, 1e12, 'off'), false);
  assert.equal(shouldCheck({ v: 1 }, 1000, 'auto'), true);
  const t = 1_000_000;
  assert.equal(shouldCheck({ v: 1, lastChecked: t }, t + CHECK_INTERVAL_MS - 1, 'auto'), false);
  assert.equal(shouldCheck({ v: 1, lastChecked: t }, t + CHECK_INTERVAL_MS, 'auto'), true);
  assert.equal(shouldCheck({ v: 1, lastChecked: t }, t, 'auto'), false);
  assert.equal(shouldCheck({ v: 1, lastChecked: t + 5 }, t, 'auto'), true);
});

test('parseRelease accepts a good release', () => {
  const r = parseRelease(release());
  assert.deepEqual(r, { ok: true, release: info });
});

test('parseRelease rejects drafts, pre-releases and bad tags', () => {
  assert.equal(parseRelease(release({ draft: true })).ok, false);
  assert.equal(parseRelease(release({ prerelease: true })).ok, false);
  assert.equal(parseRelease(release({ tag_name: 'nightly' })).ok, false);
  assert.equal(parseRelease(release({ tag_name: undefined })).ok, false);
  const pre = parseRelease(release({ tag_name: 'v0.6.0-beta.1' }));
  assert.equal(pre.ok, false);
  if (!pre.ok) assert.match(pre.reason, /pre-release/);
  assert.equal(parseRelease(null).ok, false);
  assert.equal(parseRelease('x').ok, false);
  assert.equal(parseRelease({}).ok, false);
});

test('parseRelease rejects a wrong asset name, bad size and untrusted URLs', () => {
  const asset = (over: Record<string, unknown>) => ({ name: 'middle-management-0.6.0.vsix', browser_download_url: DL, size: 1234, ...over });
  assert.equal(parseRelease(release({ assets: [asset({ name: 'middle-management-0.5.0.vsix' })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ name: 'middle-management-0.6.0.vsix.zip' })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [] })).ok, false);
  assert.equal(parseRelease(release({ assets: 'nope' })).ok, false);
  assert.equal(parseRelease(release({ assets: [null, 4] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ size: undefined })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ size: 0 })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ size: 1.5 })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ size: '1234' })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ browser_download_url: 'https://evil.example/middle-management-0.6.0.vsix' })] })).ok, false);
  assert.equal(parseRelease(release({ assets: [asset({ browser_download_url: DL.replace('https:', 'http:') })] })).ok, false);
  assert.equal(parseRelease(release({ html_url: 'https://github.com/someone/else/releases/tag/v0.6.0' })).ok, false);
  assert.equal(parseRelease(release({ html_url: undefined })).ok, false);
});

test('isAllowedDownloadUrl allows the repo and GitHub redirect hosts only', () => {
  assert.equal(isAllowedDownloadUrl(DL), true);
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/abc?x=1'), true);
  assert.equal(isAllowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/abc?x=1'), true);
  assert.equal(isAllowedDownloadUrl('http://github.com/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com.evil.example/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://evil.example/https://github.com/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com@evil.example/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://user:pw@github.com/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com:8443/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com:444/x'), false);
  assert.equal(isAllowedDownloadUrl('https://evilobjects.githubusercontent.com/x'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com/other/repo/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com/Barniclebazil/middle-management/releases/download/../../../../other/repo/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com/Barniclebazil/middle-management/releases/download/'), false);
  assert.equal(isAllowedDownloadUrl('ftp://github.com/Barniclebazil/middle-management/releases/download/v1/a.vsix'), false);
  assert.equal(isAllowedDownloadUrl('not a url'), false);
  assert.equal(isAllowedDownloadUrl(''), false);
});

test('noticeHidden, afterLater and afterSkip', () => {
  const s = { v: 1 as const, laterUntil: 5000 };
  assert.equal(noticeHidden({ v: 1 }, '0.6.0', 1000), false);
  assert.equal(noticeHidden({ v: 1, skipped: '0.6.0' }, '0.6.0', 1000), true);
  assert.equal(noticeHidden({ v: 1, skipped: '0.6.0' }, '0.7.0', 1000), false);
  assert.equal(noticeHidden(s, '0.6.0', 4999), true);
  assert.equal(noticeHidden(s, '0.6.0', 5000), false);

  const base: UpdateState = { v: 1, latest: '0.6.0' };
  const later = afterLater(base, 1000);
  assert.equal(later.laterUntil, 1000 + LATER_MS);
  assert.equal(later.latest, '0.6.0');
  assert.equal(base.laterUntil, undefined);

  const skipped = afterSkip({ ...base, laterUntil: 9 }, '0.6.0');
  assert.equal(skipped.skipped, '0.6.0');
  assert.equal('laterUntil' in skipped, false);
  assert.equal(skipped.latest, '0.6.0');
});

test('afterCheck stores or clears the release and stamps the time', () => {
  const old = { v: 1 as const, lastChecked: 1, latest: '0.5.5', notesUrl: NOTES, vsixUrl: DL, size: 9, skipped: '0.5.4', laterUntil: 77 };
  const stored = afterCheck({ v: 1 }, 500, info);
  assert.deepEqual(stored, { v: 1, lastChecked: 500, latest: '0.6.0', notesUrl: NOTES, vsixUrl: DL, size: 1234 });
  const replaced = afterCheck(old, 600, info);
  assert.equal(replaced.skipped, '0.5.4');
  assert.equal(replaced.laterUntil, 77);
  assert.equal(replaced.latest, '0.6.0');
  assert.equal(old.latest, '0.5.5');
  assert.deepEqual(afterCheck(old, 700, undefined), { v: 1, lastChecked: 700, skipped: '0.5.4', laterUntil: 77 });
});

test('availableMessage names both versions', () => {
  assert.equal(availableMessage('0.6.0', '0.5.0'), 'Middle Management 0.6.0 is out. You have 0.5.0.');
});
