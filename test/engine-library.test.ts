import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_SOURCE_ORDER, SKILL_SOURCE_ORDER, daysAgoText, groupCommands, groupSkills, groupTotal, libraryCounts, matchesQuery,
  pluginNote, sortItems, usageLabel, usePrefill,
} from '../webview/engine/libraryLogic.ts';
import type { CommandItem, SkillItem } from '../src/shared/protocol.ts';

const skill = (name: string, source: SkillItem['source'] = 'user', more: Partial<SkillItem> = {}): SkillItem =>
  ({ name, invoke: name, description: `Does ${name}`, source, ...more });
const cmd = (name: string, source: CommandItem['source'] = 'builtin', more: Partial<CommandItem> = {}): CommandItem =>
  ({ name, invoke: name, description: `Runs ${name}`, source, ...more });

test('skills group by source in a fixed order', () => {
  const g = groupSkills([skill('a', 'plugin'), skill('b', 'user'), skill('c', 'project'), skill('d', 'synced')]);
  assert.deepEqual(g.map((x) => x.source), ['project', 'user', 'synced', 'plugin']);
  assert.deepEqual(g.map((x) => x.source), [...SKILL_SOURCE_ORDER]);
  assert.equal(g[0]!.title, 'This project');
  assert.deepEqual(groupSkills([]), []);
});

test('commands group by source, built-in first', () => {
  const g = groupCommands([cmd('x', 'user'), cmd('y', 'builtin'), cmd('z', 'plugin'), cmd('w', 'project')]);
  assert.deepEqual(g.map((x) => x.source), [...COMMAND_SOURCE_ORDER]);
  assert.equal(g[0]!.title, 'Built in');
});

test('search covers name, invoke and description, all words, any case', () => {
  const s = skill('pdf-tools', 'user', { invoke: 'docs:pdf-tools', description: 'Fill and merge PDF forms' });
  assert.ok(matchesQuery(s, ''));
  assert.ok(matchesQuery(s, '   '));
  assert.ok(matchesQuery(s, 'PDF'));
  assert.ok(matchesQuery(s, 'merge forms'));
  assert.ok(matchesQuery(s, 'docs:'));
  assert.ok(!matchesQuery(s, 'merge spreadsheets'));
  assert.ok(matchesQuery(skill('café'), 'CAFÉ'));
  assert.ok(matchesQuery(skill('日本語'), '日本'));
  const g = groupSkills([s, skill('other')], 'pdf');
  assert.equal(groupTotal(g), 1);
  assert.deepEqual(groupSkills([skill('a')], 'zzz'), []);
  assert.equal(groupTotal(groupCommands([cmd('init'), cmd('review')], 'rev')), 1);
});

test('sort: most used, then name', () => {
  const items = [skill('b'), skill('a'), skill('c', 'user', { uses: 3 }), skill('d', 'user', { uses: 12 }), skill('e', 'user', { uses: 3 }), skill('a10'), skill('a2')];
  assert.deepEqual(sortItems(items).map((x) => x.name), ['d', 'c', 'e', 'a', 'a2', 'a10', 'b']);
  assert.deepEqual(groupSkills(items)[0]!.items.map((x) => x.name), ['d', 'c', 'e', 'a', 'a2', 'a10', 'b']);
  assert.deepEqual(sortItems([skill('é'), skill('e'), skill('f')]).map((x) => x.name), ['e', 'é', 'f']);
  assert.deepEqual(sortItems([]), []);
  assert.deepEqual(sortItems([skill('a'), skill('A')]).map((x) => x.name), ['A', 'a']);
});

test('huge lists group and sort', () => {
  const many = Array.from({ length: 3000 }, (_, i) => skill(`s${i}`, SKILL_SOURCE_ORDER[i % 4]!, { uses: i % 7 }));
  const g = groupSkills(many);
  assert.equal(groupTotal(g), 3000);
  assert.equal(groupTotal(groupSkills(many, 's29')), 111);
  const first = g[0]!.items;
  assert.ok((first[0]!.uses ?? 0) >= (first[1]!.uses ?? 0));
});

test('relative days', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const day = 86_400_000;
  assert.equal(daysAgoText(now - 3600_000, now), 'today');
  assert.equal(daysAgoText(now + 5 * day, now), 'today');
  assert.equal(daysAgoText(now - day, now), 'yesterday');
  assert.equal(daysAgoText(now - 3 * day, now), '3 days ago');
  assert.equal(daysAgoText(now - 59 * day, now), '59 days ago');
  assert.equal(daysAgoText(now - 90 * day, now), '3 months ago');
  assert.equal(daysAgoText(now - 800 * day, now), '2 years ago');
});

test('usage labels', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const day = 86_400_000;
  assert.equal(usageLabel(12, now - 3 * day, now), 'Used 12 times · last 3 days ago');
  assert.equal(usageLabel(1, now - day, now), 'Used 1 time · last yesterday');
  assert.equal(usageLabel(4, undefined, now), 'Used 4 times');
  assert.equal(usageLabel(4, NaN, now), 'Used 4 times');
  assert.equal(usageLabel(0, now, now), 'Not used yet');
  assert.equal(usageLabel(undefined, undefined, now), 'Not used yet');
  assert.equal(usageLabel(NaN, now, now), 'Not used yet');
  assert.equal(usageLabel(2.9, now, now), 'Used 2 times · last today');
});

test('use this prefill and plugin note', () => {
  assert.deepEqual(usePrefill({ invoke: 'review' }), { prompt: '/review ' });
  assert.deepEqual(usePrefill({ invoke: 'docs:pdf-tools' }), { prompt: '/docs:pdf-tools ' });
  assert.deepEqual(usePrefill({ invoke: '日本' }), { prompt: '/日本 ' });
  assert.equal(pluginNote({ source: 'plugin', plugin: 'docs' }), 'Plugin: docs');
  assert.equal(pluginNote({ source: 'plugin' }), '');
  assert.equal(pluginNote({ source: 'user', plugin: 'docs' }), '');
});

test('counts line', () => {
  assert.equal(libraryCounts(12, 12, 30, 30), '12 skills · 30 commands');
  assert.equal(libraryCounts(1, 1, 1, 1), '1 skill · 1 command');
  assert.equal(libraryCounts(3, 12, 0, 30), '3 of 12 skills · 0 of 30 commands');
  assert.equal(libraryCounts(0, 0, 0, 0), '0 skills · 0 commands');
});
