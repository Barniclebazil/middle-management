import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_INSTRUCTIONS, EMPTY_MEMORY, EMPTY_RULES, handbookCounts, instructionRows, memoryRows, ruleGroups, rulesSummary, scopeLabel,
  summaryLine,
} from '../webview/engine/handbookLogic.ts';
import { CONFIG_SCOPES, MEMORY_TYPES } from '../src/shared/protocol.ts';
import type { ConfigScope, HandbookFile, MemoryEntry, PermissionRuleItem, RuleBehavior } from '../src/shared/protocol.ts';

const file = (id: string, scope: ConfigScope, bytes?: number): HandbookFile => {
  const f: HandbookFile = { fileId: id, scope, label: id, display: `~/${id}` };
  if (bytes !== undefined) f.bytes = bytes;
  return f;
};
const rule = (r: string, behavior: RuleBehavior, scope: ConfigScope): PermissionRuleItem => ({ behavior, rule: r, scope });

test('scope labels', () => {
  for (const s of CONFIG_SCOPES) assert.ok(scopeLabel(s).length > 0);
  assert.equal(scopeLabel('managed'), 'Organisation');
  assert.equal(scopeLabel('local'), 'Local to you');
  assert.equal(scopeLabel('odd' as ConfigScope), 'odd');
});

test('instructions are in precedence order, stable within a scope', () => {
  const rows = instructionRows([file('l', 'local'), file('p1', 'project', 2048), file('u', 'user', 100), file('m', 'managed'), file('p2', 'project', 12 * 1024), file('x', 'odd' as ConfigScope)]);
  assert.deepEqual(rows.map((r) => r.file.fileId), ['m', 'u', 'p1', 'p2', 'l', 'x']);
  assert.deepEqual(rows.map((r) => r.scopeLabel).slice(0, 2), ['Organisation', 'Yours, for every project']);
  assert.deepEqual(rows.map((r) => r.size), ['', '100 B', '2 KB', '12 KB', '', '']);
  assert.equal(instructionRows([file('a', 'user', 1536)])[0]!.size, '1.5 KB');
  assert.deepEqual(instructionRows([]), []);
});

test('memory rows keep order and fall back sensibly', () => {
  const mem: MemoryEntry[] = [
    { fileId: '1', file: 'a.md', title: 'About me', hook: 'Likes tea', type: 'user' },
    { fileId: '2', file: 'b.md', title: '  ', type: 'feedback' },
    { fileId: '3', file: '日本.md', title: '日本', type: 'odd' as never },
    { fileId: '4', file: 'd.md', title: 'No type' },
  ];
  const rows = memoryRows(mem);
  assert.deepEqual(rows.map((r) => r.title), ['About me', 'b.md', '日本', 'No type']);
  assert.deepEqual(rows.map((r) => r.hook), ['Likes tea', '', '', '']);
  assert.deepEqual(rows.map((r) => r.typeLabel), ['About you', 'Feedback', '', '']);
  for (const t of MEMORY_TYPES) assert.ok(memoryRows([{ fileId: 'x', file: 'f', title: 't', type: t }])[0]!.typeLabel);
  assert.deepEqual(memoryRows([]), []);
  assert.equal(memoryRows(Array.from({ length: 200 }, (_, i) => ({ fileId: `${i}`, file: `${i}.md`, title: `t${i}` }))).length, 200);
});

test('rules group by behaviour, then scope', () => {
  const g = ruleGroups([
    rule('Bash(ls)', 'allow', 'local'), rule('Read', 'allow', 'user'), rule('Bash(rm:*)', 'deny', 'project'),
    rule('Bash(git push)', 'ask', 'user'), rule('WebFetch', 'deny', 'managed'), rule('Edit', 'allow', 'user'), rule('Bash(rm -rf *)', 'deny', 'project'),
  ]);
  assert.deepEqual(g.map((x) => x.behavior), ['deny', 'ask', 'allow']);
  assert.deepEqual(g.map((x) => x.count), [3, 1, 3]);
  assert.deepEqual(g[0]!.scopes.map((s) => s.scope), ['managed', 'project']);
  assert.deepEqual(g[0]!.scopes[1]!.rules.map((r) => r.rule), ['Bash(rm:*)', 'Bash(rm -rf *)'], 'file order');
  assert.deepEqual(g[2]!.scopes.map((s) => s.title), ['Yours, for every project', 'Local to you']);
  assert.deepEqual(g[2]!.scopes[0]!.rules.map((r) => r.rule), ['Read', 'Edit']);
  assert.deepEqual(ruleGroups([]), []);
  assert.deepEqual(ruleGroups([rule('Read', 'allow', 'user')]).map((x) => x.behavior), ['allow']);
  const huge = Array.from({ length: 500 }, (_, i) => rule(`Tool${i}`, (['allow', 'ask', 'deny'] as const)[i % 3]!, CONFIG_SCOPES[i % 4]!));
  assert.equal(ruleGroups(huge).reduce((n, x) => n + x.count, 0), 500);
});

test('counts, summaries and empty states', () => {
  const c = handbookCounts([file('a', 'user'), file('b', 'project')], [{ fileId: '1', file: 'a', title: 'a' }], [rule('a', 'allow', 'user'), rule('b', 'allow', 'user'), rule('c', 'deny', 'user'), rule('d', 'ask', 'user')]);
  assert.deepEqual(c, { instructions: 2, memory: 1, deny: 1, ask: 1, allow: 2, rules: 4 });
  assert.equal(summaryLine(c), '2 instruction files · 1 memory · 4 rules');
  const none = handbookCounts([], [], []);
  assert.equal(summaryLine(none), '0 instruction files · 0 memories · 0 rules');
  assert.equal(summaryLine({ instructions: 1, memory: 5, deny: 0, ask: 0, allow: 1, rules: 1 }), '1 instruction file · 5 memories · 1 rule');
  assert.equal(rulesSummary(c), '1 never allowed · 1 ask first · 2 allowed');
  assert.equal(rulesSummary({ deny: 0, ask: 0, allow: 3 }), '3 allowed');
  assert.equal(rulesSummary({ deny: 0, ask: 0, allow: 0 }), '');
  for (const s of [EMPTY_INSTRUCTIONS, EMPTY_MEMORY, EMPTY_RULES]) assert.ok(s.length > 0);
});
