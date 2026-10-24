import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProblem, scopeLabel, serverMeta, sortServers, statusLabel, statusTone, summaryLine, toolsLabel, transportLabel,
} from '../webview/engine/phoneLogic.ts';
import { MCP_SCOPES, MCP_STATUSES, MCP_TRANSPORTS } from '../src/shared/protocol.ts';
import type { McpServerItem, McpStatus } from '../src/shared/protocol.ts';

const srv = (name: string, status: McpStatus = 'connected', more: Partial<McpServerItem> = {}): McpServerItem =>
  ({ name, scope: 'user', transport: 'stdio', status, ...more });

test('every status has a label and a tone', () => {
  assert.deepEqual(MCP_STATUSES.map(statusLabel), ['Connected', 'Failed', 'Needs sign-in', 'Connecting…', 'Off', 'Unknown']);
  assert.deepEqual(MCP_STATUSES.map(statusTone), ['ok', 'err', 'warn', 'busy', 'off', 'dim']);
  assert.equal(statusLabel('nonsense' as McpStatus), 'Unknown');
  assert.equal(statusTone('nonsense' as McpStatus), 'dim');
  assert.ok(isProblem('failed') && isProblem('needsAuth'));
  assert.ok(!isProblem('connected') && !isProblem('disabled') && !isProblem('unknown') && !isProblem('pending'));
});

test('problems first, then by name', () => {
  const list = [srv('z'), srv('b', 'disabled'), srv('a', 'needsAuth'), srv('m', 'failed'), srv('c', 'pending'), srv('A2', 'failed'), srv('u', 'unknown'), srv('é')];
  assert.deepEqual(sortServers(list).map((s) => s.name), ['A2', 'm', 'a', 'u', 'c', 'é', 'z', 'b']);
  assert.equal(list[0]!.name, 'z', 'input is not changed');
  assert.deepEqual(sortServers([]), []);
  assert.deepEqual(sortServers([srv('日本'), srv('a')]).map((s) => s.name), ['a', '日本']);
  const huge = Array.from({ length: 100 }, (_, i) => srv(`s${i}`, MCP_STATUSES[i % 6]!));
  const sorted = sortServers(huge);
  assert.equal(sorted.length, 100);
  assert.equal(sorted[0]!.status, 'failed');
  assert.equal(sorted[99]!.status, 'disabled');
});

test('summary line', () => {
  assert.equal(summaryLine([]), 'No lines');
  assert.equal(summaryLine([srv('a')]), '1 line');
  assert.equal(summaryLine([srv('a'), srv('b'), srv('c', 'needsAuth'), srv('d')]), '4 lines · 1 needs sign-in');
  assert.equal(summaryLine([srv('a', 'failed'), srv('b', 'failed'), srv('c', 'needsAuth')]), '3 lines · 2 failed · 1 needs sign-in');
  assert.equal(summaryLine([srv('a', 'disabled'), srv('b', 'pending'), srv('c', 'unknown')]), '3 lines');
});

test('scope, transport and tools labels', () => {
  for (const s of MCP_SCOPES) assert.ok(scopeLabel(s).length > 0);
  for (const t of MCP_TRANSPORTS) assert.ok(transportLabel(t).length > 0);
  assert.equal(scopeLabel('project'), 'This project');
  assert.equal(scopeLabel('managed'), 'Set by your organisation');
  assert.equal(scopeLabel('x' as never), 'Unknown');
  assert.equal(transportLabel('stdio'), 'Local program');
  assert.equal(transportLabel('x' as never), 'Unknown');
  assert.equal(toolsLabel(undefined), '');
  assert.equal(toolsLabel(-2), '');
  assert.equal(toolsLabel(NaN), '');
  assert.equal(toolsLabel(0), 'No tools');
  assert.equal(toolsLabel(1), '1 tool');
  assert.equal(toolsLabel(12), '12 tools');
  assert.equal(serverMeta(srv('a', 'connected', { tools: 12 })), 'Yours · Local program · 12 tools');
  assert.equal(serverMeta(srv('a', 'connected', { scope: 'cloud', transport: 'http' })), 'Cloud · Web (HTTP)');
  // an unknown scope or kind is left out rather than shown as "Unknown · Unknown"
  assert.equal(serverMeta(srv('a', 'connected', { scope: 'unknown', transport: 'http', tools: 2 })), 'Web (HTTP) · 2 tools');
  assert.equal(serverMeta(srv('a', 'connected', { scope: 'user', transport: 'unknown' })), 'Yours');
  assert.equal(serverMeta(srv('a', 'connected', { scope: 'unknown', transport: 'unknown' })), 'Scope and kind not known');
  assert.equal(serverMeta(srv('a', 'connected', { scope: 'nonsense' as never, transport: 'unknown' })), 'Scope and kind not known');
});
