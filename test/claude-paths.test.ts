import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { claudeHome, isInsideDir, projectDirName, projectsDir, sessionsDir } from '../src/claude/paths.ts';

test('projectDirName encodes POSIX cwds', () => {
  assert.equal(projectDirName('/home/user/project'), '-home-user-project');
  assert.equal(projectDirName('/home/user/demo-project'), '-home-user-demo-project');
});

test('projectDirName encodes Windows cwds', () => {
  assert.equal(projectDirName('C:\\Users\\alice\\work\\proj'), 'C--Users-alice-work-proj');
});

test('projectDirName replaces dots, underscores and non-ASCII too', () => {
  assert.equal(projectDirName('/a/b.c_d/é'), '-a-b-c-d--');
});

test('claudeHome uses CLAUDE_CONFIG_DIR when set', () => {
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/custom/claude' }, '/home/x'), '/custom/claude');
});

test('claudeHome falls back to <home>/.claude', () => {
  assert.equal(claudeHome({}, '/home/x'), path.join('/home/x', '.claude'));
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '' }, '/home/x'), path.join('/home/x', '.claude'));
});

test('projectsDir and sessionsDir', () => {
  assert.equal(projectsDir('/h/.claude'), path.join('/h/.claude', 'projects'));
  assert.equal(sessionsDir('/h/.claude'), path.join('/h/.claude', 'sessions'));
});

test('isInsideDir handles POSIX and Windows-style paths', () => {
  assert.equal(isInsideDir('/home/user/demo/src', '/home/user/demo'), true);
  assert.equal(isInsideDir('/home/user/demo', '/home/user/demo/'), true);
  assert.equal(isInsideDir('/home/user/demo-two', '/home/user/demo'), false);
  assert.equal(isInsideDir('/home/User/demo', '/home/user/demo', false), false);
  assert.equal(isInsideDir('C:\\Users\\Alice\\work\\proj\\src', 'c:\\users\\alice\\work'), true);
  assert.equal(isInsideDir('D:\\x', 'C:\\x'), false);
});

test('claudeConfigJsonPath: home file by default, inside CLAUDE_CONFIG_DIR when set', async () => {
  const { claudeConfigJsonPath, claudeSettingsJsonPath } = await import('../src/claude/paths.ts');
  assert.equal(claudeConfigJsonPath({}, '/home/x'), path.join('/home/x', '.claude.json'));
  assert.equal(claudeConfigJsonPath({ CLAUDE_CONFIG_DIR: '' }, '/home/x'), path.join('/home/x', '.claude.json'));
  assert.equal(claudeConfigJsonPath({ CLAUDE_CONFIG_DIR: '/custom/c' }, '/home/x'), path.join('/custom/c', '.claude.json'));
  assert.equal(claudeSettingsJsonPath({}, '/home/x'), path.join('/home/x', '.claude', 'settings.json'));
  assert.equal(claudeSettingsJsonPath({ CLAUDE_CONFIG_DIR: '/custom/c' }, '/home/x'), path.join('/custom/c', 'settings.json'));
});
