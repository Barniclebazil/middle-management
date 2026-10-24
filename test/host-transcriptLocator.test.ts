import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateTranscript } from '../src/host/transcriptLocator.ts';
import type { SessionInfo } from '../src/claude/types.ts';

const sessions: SessionInfo[] = [
  { sessionId: 's1', transcriptPath: '/p/s1.jsonl', projectDir: '/p', mtimeMs: 1, subagents: [{ agentId: 'a9', path: '/p/s1/subagents/agent-a9.jsonl', mtimeMs: 1 }] },
  { sessionId: 's2', transcriptPath: '/p/s2.jsonl', projectDir: '/p', mtimeMs: 1, subagents: [] },
];

test('main agents map to their session transcript', () => {
  assert.equal(locateTranscript(sessions, { id: 's2', kind: 'main', sessionId: 's2' }), '/p/s2.jsonl');
  assert.equal(locateTranscript(sessions, { id: 's1', kind: 'main' }), '/p/s1.jsonl');
});

test('temps map to the subagent file of their parent session', () => {
  assert.equal(locateTranscript(sessions, { id: 's1/a9', kind: 'temp', sessionId: 's1' }), '/p/s1/subagents/agent-a9.jsonl');
  assert.equal(locateTranscript(sessions, { id: 's1/a9', kind: 'temp' }), '/p/s1/subagents/agent-a9.jsonl');
});

test('unknown sessions and subagents give undefined', () => {
  assert.equal(locateTranscript(sessions, { id: 'zz', kind: 'main' }), undefined);
  assert.equal(locateTranscript(sessions, { id: 's1/nope', kind: 'temp', sessionId: 's1' }), undefined);
  assert.equal(locateTranscript([], { id: 's1', kind: 'main' }), undefined);
});
