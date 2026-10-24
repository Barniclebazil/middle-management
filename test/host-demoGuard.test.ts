import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_REFUSAL, demoRefusal } from '../src/host/demoGuard.ts';

test('session-acting messages get the friendly error, with their ids', () => {
  assert.deepEqual(demoRefusal({ type: 'openCase', agentId: 'demo-1' }), { type: 'error', message: DEMO_REFUSAL, agentId: 'demo-1' });
  assert.deepEqual(demoRefusal({ type: 'reply', sessionId: 's', text: 'x' }), { type: 'error', message: DEMO_REFUSAL, sessionId: 's' });
  assert.deepEqual(demoRefusal({ type: 'decide', requestId: 'r', decision: { kind: 'allow' } }), { type: 'error', message: DEMO_REFUSAL, requestId: 'r' });
  assert.deepEqual(
    demoRefusal({ type: 'newTask', nonce: 'n', projectPath: '/p', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' }),
    { type: 'error', message: DEMO_REFUSAL, nonce: 'n' },
  );
  assert.deepEqual(
    demoRefusal({ type: 'setSessionOptions', nonce: 'n2', sessionId: 's2', options: { model: 'opus' } }),
    { type: 'error', message: DEMO_REFUSAL, nonce: 'n2', sessionId: 's2' },
  );
  assert.deepEqual(demoRefusal({ type: 'getPlan', reqId: 'r1', agentId: 'demo-1', planId: 'p' }), { type: 'error', message: DEMO_REFUSAL, reqId: 'r1' });
  assert.deepEqual(demoRefusal({ type: 'getTurn', reqId: 'r2', agentId: 'demo-1' }), { type: 'error', message: DEMO_REFUSAL, reqId: 'r2' });
  assert.match(DEMO_REFUSAL, /Turn off demo mode/);
});

test('harmless messages pass through', () => {
  for (const type of ['ready', 'closeCase', 'listProjects', 'browseProject'] as const) assert.equal(demoRefusal({ type }), undefined);
});

test('refreshUsage is account-wide, not about a session, so it passes through in demo mode', () => {
  assert.equal(demoRefusal({ type: 'refreshUsage' }), undefined);
});

test('every session-acting message is refused in demo mode with an error message', () => {
  const refused = ['openCase', 'newTask', 'reply', 'decide', 'interrupt', 'openInClaudeCode', 'setSessionOptions', 'getPlan', 'getTurn'];
  const msgs: Record<string, Parameters<typeof demoRefusal>[0]> = {
    openCase: { type: 'openCase', agentId: 'a' },
    newTask: { type: 'newTask', nonce: 'n', projectPath: '/p', prompt: 'x', assignTo: { kind: 'new' }, permissionMode: 'default' },
    reply: { type: 'reply', sessionId: 's', text: 'x' },
    decide: { type: 'decide', requestId: 'r', decision: { kind: 'allow' } },
    interrupt: { type: 'interrupt', sessionId: 's' },
    openInClaudeCode: { type: 'openInClaudeCode', sessionId: 's' },
    setSessionOptions: { type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { effort: 'high' } },
    getPlan: { type: 'getPlan', reqId: 'r', agentId: 'a', planId: 'p' },
    getTurn: { type: 'getTurn', reqId: 'r', agentId: 'a' },
  };
  for (const t of refused) assert.equal(demoRefusal(msgs[t]!)?.type, 'error', t);
});
