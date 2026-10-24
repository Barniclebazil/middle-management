import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaudeVersions, claudeCodeExtensionVersion, compareMajorMinor, extensionRootOfBinary, parseMajorMinor } from '../src/host/versionCheck.ts';

test('parseMajorMinor and compareMajorMinor', () => {
  assert.deepEqual(parseMajorMinor('2.1.302'), { major: 2, minor: 1 });
  assert.deepEqual(parseMajorMinor('v3.10.0-beta'), { major: 3, minor: 10 });
  assert.equal(parseMajorMinor('latest'), undefined);
  assert.equal(parseMajorMinor(undefined), undefined);
  assert.equal(compareMajorMinor('2.1.302', '2.1.9'), 'match');
  assert.equal(compareMajorMinor('2.2.0', '2.1.302'), 'mismatch');
  assert.equal(compareMajorMinor('3.1.0', '2.1.0'), 'mismatch');
  assert.equal(compareMajorMinor('x', '2.1.0'), 'unknown');
});

test('extensionRootOfBinary only accepts the extension layout', () => {
  assert.equal(extensionRootOfBinary('/h/.vscode/extensions/anthropic.claude-code-2.1.302-linux-x64/resources/native-binary/claude'), '/h/.vscode/extensions/anthropic.claude-code-2.1.302-linux-x64');
  assert.equal(extensionRootOfBinary('C:\\e\\anthropic.claude-code-2.1.302-win32-x64\\resources\\native-binary\\claude.exe'), 'C:\\e\\anthropic.claude-code-2.1.302-win32-x64');
  assert.equal(extensionRootOfBinary('/usr/bin/claude'), undefined);
});

test('claudeCodeExtensionVersion prefers package.json, falls back to the folder name', () => {
  assert.equal(claudeCodeExtensionVersion('/x/anthropic.claude-code-2.1.302-linux-x64', () => '{"version":"2.1.400"}'), '2.1.400');
  assert.equal(claudeCodeExtensionVersion('/x/anthropic.claude-code-2.1.302-linux-x64', () => undefined), '2.1.302');
  assert.equal(claudeCodeExtensionVersion('/x/anthropic.claude-code-2.1.302-linux-x64', () => 'not json'), '2.1.302');
  assert.equal(claudeCodeExtensionVersion('/x/claude', () => undefined), undefined);
});

test('checkClaudeVersions warns only on a major.minor difference', () => {
  const bin = '/x/anthropic.claude-code-2.1.302-linux-x64/resources/native-binary/claude';
  const base = { source: 'extension', binaryPath: bin, sdkVersion: '0.3.302', readFile: () => undefined };
  const ok = checkClaudeVersions({ ...base, sdkClaudeCodeVersion: '2.1.302' });
  assert.equal(ok.warn, false);
  assert.match(ok.lines[0]!, /2\.1\.302 supplies the binary/);
  const bad = checkClaudeVersions({ ...base, sdkClaudeCodeVersion: '2.2.0' });
  assert.equal(bad.warn, true);
  assert.match(bad.lines[0]!, /differ/);
  const other = checkClaudeVersions({ ...base, source: 'path', binaryPath: '/usr/bin/claude', sdkClaudeCodeVersion: '2.1.302' });
  assert.equal(other.warn, false);
  assert.match(other.lines[0]!, /not checked/);
  assert.equal(checkClaudeVersions({ ...base, sdkClaudeCodeVersion: undefined }).warn, false);
});
