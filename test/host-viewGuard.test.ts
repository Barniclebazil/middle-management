import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_REFUSAL, viewModeRefuses, viewRefusal } from '../src/host/viewGuard.ts';
import { demoRefusal } from '../src/host/demoGuard.ts';
import { VIEW_MODE_ALLOWED } from '../src/shared/officeMode.ts';
import { parseWebviewMessage } from '../src/shared/validate.ts';
import type { HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';

type MsgType = WebviewToHost['type'];

// One valid message per type. Typed as a full Record, so a new message type fails the typecheck until it gets a sample here.
const SAMPLES: { [T in MsgType]: Extract<WebviewToHost, { type: T }> } = {
  ready: { type: 'ready' },
  openCase: { type: 'openCase', agentId: 'a1' },
  closeCase: { type: 'closeCase' },
  listProjects: { type: 'listProjects' },
  browseProject: { type: 'browseProject' },
  newTask: { type: 'newTask', nonce: 'n1', projectPath: '/p', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' },
  reply: { type: 'reply', sessionId: 's1', text: 'x' },
  decide: { type: 'decide', requestId: 'r1', decision: { kind: 'allow' } },
  interrupt: { type: 'interrupt', sessionId: 's1' },
  openInClaudeCode: { type: 'openInClaudeCode', sessionId: 's1' },
  setSessionOptions: { type: 'setSessionOptions', nonce: 'n2', sessionId: 's2', options: { effort: 'high' } },
  refreshUsage: { type: 'refreshUsage' },
  getPlan: { type: 'getPlan', reqId: 'q1', agentId: 'a1', planId: 'toolu_1' },
  getTurn: { type: 'getTurn', reqId: 'q2', agentId: 'a1' },
  getFrontDesk: { type: 'getFrontDesk', reqId: 'q3' },
  themeAction: { type: 'themeAction', reqId: 'q4', action: 'reload' },
  setSetting: { type: 'setSetting', reqId: 'q5', key: 'speechBubbles', value: null },
  saveTheme: { type: 'saveTheme', reqId: 'q6', rev: '0123456789abcdef', themeJson: '{}' },
  saveThemeAs: { type: 'saveThemeAs', reqId: 'q7', themeJson: '{}' },
  openSettingsUi: { type: 'openSettingsUi', key: 'themeFile', target: 'user' },
  getFileRoots: { type: 'getFileRoots', reqId: 'q8' },
  listDir: { type: 'listDir', reqId: 'q9', rootId: 'root', relPath: '' },
  readFile: { type: 'readFile', reqId: 'q10', rootId: 'root', relPath: 'a.txt' },
  openFile: { type: 'openFile', rootId: 'root', relPath: 'a.txt' },
  openDiff: { type: 'openDiff', rootId: 'root', relPath: 'a.txt' },
  getCatalog: { type: 'getCatalog', reqId: 'q11', section: 'skills' },
  openConfigFile: { type: 'openConfigFile', fileId: 'f1' },
  openCaseTab: { type: 'openCaseTab', agentId: 'a2' },
  sendHome: { type: 'sendHome', agentId: 'a3' },
  updateAction: { type: 'updateAction', action: 'check' },
};
const ALL: WebviewToHost[] = Object.values(SAMPLES);

/** The error without its `message`, to compare which ids two guards echo. */
function idsOf(err: HostToWebview | undefined): Record<string, unknown> | undefined {
  if (!err) return undefined;
  const { message: _message, ...ids } = err as Extract<HostToWebview, { type: 'error' }>;
  return ids;
}

test('every sample is a valid message, and each key matches its type', () => {
  for (const [key, msg] of Object.entries(SAMPLES)) {
    assert.equal(msg.type, key);
    assert.deepEqual(parseWebviewMessage(msg), msg, `sample ${key} should pass the validator`);
  }
});

test('the allowlist only names types that have a sample', () => {
  for (const type of VIEW_MODE_ALLOWED) assert.ok(type in SAMPLES, type);
});

test('only ready, refreshUsage, closeCase and updateAction pass in view mode', () => {
  const passed = ALL.filter((m) => !viewModeRefuses(m)).map((m) => m.type);
  assert.deepEqual(passed.sort(), ['closeCase', 'ready', 'refreshUsage', 'updateAction']);
  for (const msg of ALL) assert.equal(viewRefusal(msg) === undefined, !viewModeRefuses(msg), msg.type);
});

test('the v0.5 messages are refused', () => {
  assert.equal(viewModeRefuses(SAMPLES.openCaseTab), true);
  assert.equal(viewModeRefuses(SAMPLES.sendHome), true);
  assert.deepEqual(viewRefusal(SAMPLES.openCaseTab), { type: 'error', message: VIEW_REFUSAL, agentId: 'a2' });
  assert.deepEqual(viewRefusal(SAMPLES.sendHome), { type: 'error', message: VIEW_REFUSAL, agentId: 'a3' });
});

test('the refusal text points at the setting', () => {
  assert.equal(VIEW_REFUSAL, 'The office is in view mode. Switch to manager mode to do this (Front desk → Settings → Office mode).');
});

test('where demo mode also refuses, the same ids are echoed', () => {
  let compared = 0;
  for (const msg of ALL) {
    const demo = demoRefusal(msg);
    if (!demo) continue;
    compared++;
    assert.deepEqual(idsOf(viewRefusal(msg)), idsOf(demo), msg.type);
    assert.equal((viewRefusal(msg) as { message: string }).message, VIEW_REFUSAL);
  }
  assert.ok(compared >= 15);
});

test('messages demo mode lets through but view mode refuses carry their ids', () => {
  for (const type of ['listProjects', 'browseProject'] as const) {
    assert.equal(demoRefusal(SAMPLES[type]), undefined);
    assert.deepEqual(viewRefusal(SAMPLES[type]), { type: 'error', message: VIEW_REFUSAL });
  }
  assert.deepEqual(viewRefusal(SAMPLES.getFrontDesk), { type: 'error', message: VIEW_REFUSAL, reqId: 'q3' });
  assert.deepEqual(viewRefusal(SAMPLES.themeAction), { type: 'error', message: VIEW_REFUSAL, reqId: 'q4' });
  assert.deepEqual(viewRefusal(SAMPLES.setSetting), { type: 'error', message: VIEW_REFUSAL, reqId: 'q5' });
  assert.deepEqual(viewRefusal(SAMPLES.saveTheme), { type: 'error', message: VIEW_REFUSAL, reqId: 'q6' });
  assert.deepEqual(viewRefusal(SAMPLES.saveThemeAs), { type: 'error', message: VIEW_REFUSAL, reqId: 'q7' });
  // No id to echo: the fire and forget openers and openSettingsUi.
  for (const type of ['openSettingsUi', 'openFile', 'openDiff', 'openConfigFile'] as const) {
    assert.deepEqual(viewRefusal(SAMPLES[type]), { type: 'error', message: VIEW_REFUSAL });
  }
});
