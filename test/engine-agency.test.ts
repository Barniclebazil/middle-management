import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agencyCount, agentNote, groupAgents, hirePrefill, modelLabel, toolsSummary } from '../webview/engine/agencyLogic.ts';
import type { AgentTypeItem } from '../src/shared/protocol.ts';

const agent = (name: string, source: AgentTypeItem['source'] = 'user', more: Partial<AgentTypeItem> = {}): AgentTypeItem =>
  ({ name, description: `Handles ${name}`, source, ...more });

test('groups by source, built-in first, each by name', () => {
  const g = groupAgents([agent('z', 'plugin'), agent('b', 'user'), agent('a', 'user'), agent('general', 'builtin'), agent('p', 'project'), agent('A10'), agent('A9')]);
  assert.deepEqual(g.map((x) => x.source), ['builtin', 'project', 'user', 'plugin']);
  assert.deepEqual(g.map((x) => x.title), ['Built in', 'This project', 'Yours', 'From plugins']);
  assert.deepEqual(g[2]!.agents.map((x) => x.name), ['a', 'A9', 'A10', 'b']);
  assert.deepEqual(groupAgents([]), []);
  assert.deepEqual(groupAgents([agent('é'), agent('日本'), agent('e')])[0]!.agents.map((x) => x.name), ['e', 'é', '日本']);
});

test('search filters name and description', () => {
  const list = [agent('reviewer', 'user', { description: 'Reviews pull requests' }), agent('writer', 'builtin')];
  assert.equal(groupAgents(list, 'pull').length, 1);
  assert.equal(groupAgents(list, 'WRITER')[0]!.agents[0]!.name, 'writer');
  assert.deepEqual(groupAgents(list, 'nothing'), []);
  assert.equal(groupAgents(list, '').length, 2);
});

test('huge lists', () => {
  const many = Array.from({ length: 100 }, (_, i) => agent(`t${i}`, (['builtin', 'user', 'project', 'plugin'] as const)[i % 4]!));
  assert.equal(groupAgents(many).reduce((n, g) => n + g.agents.length, 0), 100);
});

test('model labels', () => {
  assert.equal(modelLabel(undefined), 'Same as the worker');
  assert.equal(modelLabel(''), 'Same as the worker');
  assert.equal(modelLabel('  '), 'Same as the worker');
  assert.equal(modelLabel('inherit'), 'Same as the worker');
  assert.equal(modelLabel('Inherit'), 'Same as the worker');
  assert.equal(modelLabel('sonnet'), 'Sonnet');
  assert.equal(modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(modelLabel('some-other-model'), 'some-other-model');
});

test('tools summary', () => {
  assert.equal(toolsSummary(undefined), 'All tools');
  assert.equal(toolsSummary([]), 'No tools');
  assert.equal(toolsSummary(['Read']), 'Read');
  assert.equal(toolsSummary(['Read', 'Grep', 'Glob']), 'Read, Grep, Glob');
  assert.equal(toolsSummary(['Read', 'Grep', 'Glob', 'Bash', 'Edit']), 'Read, Grep, Glob +2');
  assert.equal(toolsSummary(Array.from({ length: 60 }, (_, i) => `T${i}`)), 'T0, T1, T2 +57');
  assert.equal(toolsSummary(['a', 'b', 'c'], 2), 'a, b +1');
  assert.equal(toolsSummary(['a', 'b'], 0), 'a +1', 'always shows at least one');
});

test('hire prefill, notes and counts', () => {
  assert.deepEqual(hirePrefill({ name: 'code-reviewer' }), { prompt: 'Use the code-reviewer subagent to ' });
  assert.deepEqual(hirePrefill({ name: '日本' }), { prompt: 'Use the 日本 subagent to ' });
  assert.equal(agentNote({ source: 'plugin', plugin: 'docs' }), 'Plugin: docs');
  assert.equal(agentNote({ source: 'plugin' }), '');
  assert.equal(agentNote({ source: 'user', plugin: 'docs' }), '');
  assert.equal(agencyCount(7, 7), '7 types');
  assert.equal(agencyCount(1, 1), '1 type');
  assert.equal(agencyCount(3, 7), '3 of 7 types');
  assert.equal(agencyCount(0, 0), '0 types');
});
