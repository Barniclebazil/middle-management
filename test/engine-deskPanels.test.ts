import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_INITIAL, codeParts, connectingNote, phoneHandle, phoneRequested } from '../webview/engine/phoneLogic.ts';
import { HANDBOOK_INITIAL, handbookHandle, handbookRequested, sharedFileId } from '../webview/engine/handbookLogic.ts';
import { AGENCY_INITIAL, agencyHandle, agencyRequested } from '../webview/engine/agencyLogic.ts';
import type { HostToWebview, McpServerItem, PermissionRuleItem } from '../src/shared/protocol.ts';

const srv = (name: string, status: McpServerItem['status']): McpServerItem => ({ name, scope: 'user', transport: 'stdio', status });
const mcpReply = (reqId: string, servers: McpServerItem[], truncated = false): HostToWebview => ({ type: 'catalog', reqId, section: 'mcp', servers, truncated });

test('phone: repeated replies for the current request each replace the list', () => {
  let s = phoneRequested(PHONE_INITIAL);
  assert.equal(s.loading, true);
  s = phoneHandle(s, mcpReply('r1', [srv('a', 'pending')]), 'r1')!;
  assert.equal(s.loading, false);
  assert.equal(s.servers?.[0]?.status, 'pending');
  s = phoneHandle(s, mcpReply('r1', [srv('a', 'connected')]), 'r1')!;
  assert.equal(s.servers?.[0]?.status, 'connected');
});

test('phone: stale, foreign and empty-id messages are ignored', () => {
  const s = phoneRequested(PHONE_INITIAL);
  assert.equal(phoneHandle(s, mcpReply('old', []), 'r2'), null);
  assert.equal(phoneHandle(s, { type: 'catalog', reqId: 'r2', section: 'agents', agents: [], truncated: false }, 'r2'), null);
  assert.equal(phoneHandle(s, { type: 'error', message: 'toast' }, 'r2'), null);
  assert.equal(phoneHandle(s, { type: 'error', reqId: 'old', message: 'x' }, 'r2'), null);
  assert.equal(phoneHandle(s, mcpReply('', []), ''), null);
});

test('phone: an error for the current request keeps the old list and stops loading', () => {
  let s = phoneHandle(phoneRequested(PHONE_INITIAL), mcpReply('r1', [srv('a', 'connected')]), 'r1')!;
  s = phoneRequested(s);
  assert.equal(s.servers?.length, 1);
  const e = phoneHandle(s, { type: 'error', reqId: 'r2', message: 'Nope' }, 'r2')!;
  assert.equal(e.loading, false);
  assert.equal(e.error, 'Nope');
  assert.equal(e.servers?.length, 1);
  assert.equal(phoneRequested(e).error, null);
});

test('phone: connectingNote and codeParts', () => {
  assert.equal(connectingNote([srv('a', 'connected')]), '');
  assert.equal(connectingNote([srv('a', 'pending'), srv('b', 'pending'), srv('c', 'failed')]), '2 connecting');
  assert.deepEqual(codeParts('run `x y` now'), [{ text: 'run ' }, { text: 'x y', code: true }, { text: ' now' }]);
  assert.deepEqual(codeParts('`a`'), [{ text: 'a', code: true }]);
  assert.deepEqual(codeParts('plain'), [{ text: 'plain' }]);
});

test('handbook: reply and error handling', () => {
  const reply = (reqId: string): HostToWebview => ({
    type: 'catalog', reqId, section: 'handbook', instructions: [{ fileId: 'f1', scope: 'user', label: 'CLAUDE.md', display: '~/.claude/CLAUDE.md' }],
    memoryIndex: { fileId: 'mi', scope: 'user', label: 'MEMORY.md', display: '~/m/MEMORY.md' }, memory: [], rules: [], truncated: true,
  });
  let s = handbookRequested(HANDBOOK_INITIAL);
  assert.equal(handbookHandle(s, reply('x'), 'r1'), null);
  s = handbookHandle(s, reply('r1'), 'r1')!;
  assert.equal(s.data?.instructions.length, 1);
  assert.equal(s.data?.memoryIndex?.fileId, 'mi');
  assert.equal(s.data?.truncated, true);
  // no memoryIndex in the reply -> null
  const noIdx = handbookHandle(s, { type: 'catalog', reqId: 'r1', section: 'handbook', instructions: [], memory: [], rules: [], truncated: false }, 'r1')!;
  assert.equal(noIdx.data?.memoryIndex, null);
  const err = handbookHandle(handbookRequested(s), { type: 'error', reqId: 'r3', message: 'Denied' }, 'r3')!;
  assert.deepEqual([err.error, err.loading, err.data?.instructions.length], ['Denied', false, 1]);
});

test('handbook: sharedFileId', () => {
  const r = (fileId?: string): PermissionRuleItem => (fileId ? { behavior: 'allow', rule: 'x', scope: 'user', fileId } : { behavior: 'allow', rule: 'x', scope: 'user' });
  assert.equal(sharedFileId([]), undefined);
  assert.equal(sharedFileId([r('a'), r('a')]), 'a');
  assert.equal(sharedFileId([r('a'), r('b')]), undefined);
  assert.equal(sharedFileId([r('a'), r()]), undefined);
  assert.equal(sharedFileId([r()]), undefined);
});

test('agency: reply and error handling', () => {
  const reply = (reqId: string): HostToWebview => ({ type: 'catalog', reqId, section: 'agents', agents: [{ name: 'Plan', description: 'd', source: 'builtin' }], truncated: false });
  const s = agencyRequested(AGENCY_INITIAL);
  assert.equal(agencyHandle(s, reply('old'), 'r1'), null);
  assert.equal(agencyHandle(s, mcpReply('r1', []), 'r1'), null);
  const ok = agencyHandle(s, reply('r1'), 'r1')!;
  assert.equal(ok.agents?.[0]?.name, 'Plan');
  assert.equal(ok.loading, false);
  assert.equal(agencyHandle(ok, { type: 'error', reqId: 'zzz', message: 'x' }, 'r1'), null);
  assert.equal(agencyHandle(agencyRequested(ok), { type: 'error', reqId: 'r2', message: 'Bad' }, 'r2')!.error, 'Bad');
});
