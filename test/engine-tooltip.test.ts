import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTooltip, badgeLabel, cleanerTooltip, vendorTooltip, effortPips, formatTokens, itTooltip, managerTooltip, modelLine, receptionistTooltip, rosterMeta, spellLeftWords } from '../webview/engine/tooltip.ts';
import { IT_DEZ_ID, IT_FENWICK_ID } from '../webview/engine/itCrew.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';
import { HOST0, agent } from './engine-world.ts';

const view = (over: Partial<AgentSnapshot> = {}) => normalizeAgent(agent('a', over), HOST0)!;

test('model line: model, effort and context together', () => {
  const a = view({ model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62 } });
  assert.equal(modelLine(a), 'Opus 5.5 · xhigh · context 62% (124k / 200k)');
});

test('model line leaves out the parts that are missing', () => {
  assert.equal(modelLine(view({})), '');
  assert.equal(modelLine(view({ model: 'claude-sonnet-4-5-20250929' })), 'Sonnet 4.5');
  assert.equal(modelLine(view({ effort: 'high' })), 'high');
  assert.equal(modelLine(view({ model: 'opus', context: { tokens: 10, max: 200_000, pct: 0.4 } })), 'Opus · context 0% (10 / 200k)');
  assert.equal(modelLine(view({ context: { tokens: 50_000, max: 200_000, pct: 25 } })), 'context 25% (50k / 200k)');
  assert.equal(modelLine({ model: 'opus', effort: undefined, context: { tokens: Number.NaN, max: 0, pct: 40 } }), 'Opus · context 40%', 'no sizes when they are not usable');
});

test('approximate context gets a ~ and a million-token window reads 1M', () => {
  assert.equal(modelLine(view({ context: { tokens: 124_000, max: 200_000, pct: 62, approx: true } })), 'context ~62% (124k / 200k)');
  assert.equal(modelLine(view({ context: { tokens: 250_000, max: 1_000_000, pct: 25 } })), 'context 25% (250k / 1M)');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(-1), '');
});

test('effortPips counts low=1 to max=5, 0 when unknown', () => {
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map(effortPips), [1, 2, 3, 4, 5]);
  assert.equal(effortPips(undefined), 0);
  assert.equal(effortPips('turbo'), 0);
});

test('the tooltip badge carries tier, pretty name and effort; the text line keeps only the context', () => {
  const tip = agentTooltip(view({ model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62 } }), 'Staff', null, HOST0, false);
  assert.deepEqual(tip.badge, { tier: 'opus', label: 'Opus 5.5', effort: 'xhigh' });
  assert.equal(badgeLabel(tip.badge!), 'Model Opus 5.5, effort xhigh (4 of 5)');
  assert.ok(tip.lines.includes('context 62% (124k / 200k)'));
  assert.ok(!tip.lines.some((l) => l.includes('Opus') || l.includes('xhigh')), 'nothing appears twice');
  assert.deepEqual(agentTooltip(view({ effort: 'low' }), 'Staff', null, HOST0, false).badge, { tier: null, label: '', effort: 'low' });
  assert.deepEqual(agentTooltip(view({ model: 'claude-haiku-5-5' }), 'Staff', null, HOST0, false).badge, { tier: 'haiku', label: 'Haiku 5.5' });
  assert.deepEqual(agentTooltip(view({ model: 'mystery-1' }), 'Staff', null, HOST0, false).badge, { tier: null, label: 'mystery-1' });
  assert.equal(agentTooltip(view({}), 'Staff', null, HOST0, false).badge, undefined);
});

test('the agent tooltip carries the context line after what the worker is doing', () => {
  const v = view({ model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62 }, detail: 'Editing app.ts' });
  const tip = agentTooltip(v, 'Staff', null, HOST0, false);
  const i = tip.lines.indexOf('context 62% (124k / 200k)');
  assert.ok(i > 0, 'context line present');
  assert.match(tip.lines[i - 1]!, /^Writing for /);
  assert.equal(tip.lines[i + 1], 'Editing app.ts');
  const plain = agentTooltip(view({}), 'Staff', null, HOST0, false);
  assert.ok(!plain.lines.some((l) => l.includes('context')), 'nothing added when nothing is known');
});

test('receptionist tooltip', () => {
  assert.deepEqual(receptionistTooltip(), { title: 'Receptionist', lines: ['Theme, names, colours and settings'], hint: 'Click to open the Front desk' });
  assert.deepEqual(receptionistTooltip('  '), receptionistTooltip());
  const named = receptionistTooltip(' Dana ');
  assert.equal(named.title, 'Dana — Receptionist');
  assert.deepEqual(named.lines, ['Theme, names, colours and settings']);
  assert.equal(named.hint, 'Click to open the Front desk');
});

test('manager tooltip: no lines normally; during a Fable spell, who has the office and for how long', () => {
  assert.deepEqual(managerTooltip('You'), { title: 'You — Regional Manager', lines: [], hint: 'Click to hand out a new task' });
  assert.equal(managerTooltip(' Sam ').title, 'Sam — Regional Manager (you)');
  const tip = managerTooltip('You', { holder: 'Design landing page', msLeft: 2 * 60_000 + 5_000 });
  assert.deepEqual(tip.lines, ['Sulking: \u201cDesign landing page\u201d has your office for another 3 min']);
  assert.equal(tip.hint, 'Click to hand out a new task');
  assert.deepEqual(managerTooltip('You', { holder: ' Dana ', named: true, msLeft: 5 * 60_000 }).lines, ['Sulking: Dana has your office for another 5 min']);
  assert.deepEqual(managerTooltip('You', { holder: ' ', msLeft: 30_000 }).lines, ['Sulking: A Fable worker has your office for under a minute']);
});

test('spell time left: minutes rounded up, under a minute at the end', () => {
  assert.equal(spellLeftWords(5 * 60_000), 'for another 5 min');
  assert.equal(spellLeftWords(4 * 60_000 + 1), 'for another 5 min');
  assert.equal(spellLeftWords(60_000), 'for another 1 min');
  assert.equal(spellLeftWords(59_999), 'for under a minute');
  assert.equal(spellLeftWords(-5), 'for under a minute');
  assert.equal(spellLeftWords(Number.NaN), 'for under a minute');
});

test('staff list detail line (task 10.1): model, effort, context and cost; unknown parts left out', () => {
  const a = view({ model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62 }, costUsd: 0.42 });
  assert.equal(rosterMeta(a), 'Opus 5.5 \u00b7 xhigh \u00b7 62% context \u00b7 $0.42');
  assert.equal(rosterMeta(view({ model: 'claude-haiku-5-5' })), 'Haiku 5.5');
  assert.equal(rosterMeta(view({ context: { tokens: 1, max: 2, pct: 48.4, approx: true }, costUsd: 0.18 })), '~48% context \u00b7 $0.18');
  assert.equal(rosterMeta(view({})), '');
});

test('IT pair tooltips: name and role in the title, one line, no hint, and never the word slop', () => {
  const dez = itTooltip(IT_DEZ_ID);
  assert.equal(dez.title, 'Dez, IT support');
  assert.deepEqual(dez.lines, ['Has tried turning it off and on again']);
  const fen = itTooltip(IT_FENWICK_ID);
  assert.equal(fen.title, 'Fenwick, IT support');
  assert.deepEqual(fen.lines, ['Unimpressed by anything an AI made']);
  for (const t of [dez, fen]) {
    assert.equal(t.hint, undefined);
    assert.ok(!/slop/i.test(JSON.stringify(t)));
  }
});

test('theme titles replace the built-in job titles and fall back when unset', () => {
  assert.equal(managerTooltip('You', undefined, 'Head Gardener').title, 'You \u2014 Head Gardener');
  assert.equal(managerTooltip('Sam', undefined, 'Head Gardener').title, 'Sam \u2014 Head Gardener (you)');
  assert.equal(managerTooltip('Sam', undefined, undefined).title, 'Sam \u2014 Regional Manager (you)');
  assert.equal(receptionistTooltip(undefined, 'Gatekeeper').title, 'Gatekeeper');
  assert.equal(receptionistTooltip('Mara Quill', 'Gatekeeper').title, 'Mara Quill \u2014 Gatekeeper');
  assert.equal(receptionistTooltip('Mara Quill', undefined).title, 'Mara Quill \u2014 Receptionist');
  assert.equal(cleanerTooltip().title, 'Cleaner');
  assert.equal(cleanerTooltip(undefined, 'Tidier').title, 'Tidier');
  assert.equal(vendorTooltip().title, 'Food cart');
  assert.equal(vendorTooltip(undefined, 'Snack Wrangler').title, 'Snack Wrangler');
  assert.equal(itTooltip(IT_DEZ_ID, undefined, 'Wire Wizards').title, 'Dez, Wire Wizards');
  assert.equal(itTooltip(IT_FENWICK_ID, undefined, 'Wire Wizards').title, 'Fenwick, Wire Wizards');
});

test('theme names replace the side characters\' built-in names', () => {
  assert.equal(cleanerTooltip('Mara Quill').title, 'Mara Quill \u2014 Cleaner');
  assert.equal(cleanerTooltip(' Mara Quill ', 'Tidier').title, 'Mara Quill \u2014 Tidier');
  assert.equal(cleanerTooltip('  ').title, 'Cleaner');
  assert.equal(vendorTooltip('Odo Pell').title, 'Odo Pell \u2014 Food cart');
  assert.equal(itTooltip(IT_DEZ_ID, 'Sable Rook').title, 'Sable Rook, IT support');
  assert.equal(itTooltip(IT_FENWICK_ID, 'Tamsin Vale', 'Wire Wizards').title, 'Tamsin Vale, Wire Wizards');
  assert.equal(itTooltip(IT_DEZ_ID, '').title, 'Dez, IT support');
  assert.deepEqual(itTooltip(IT_DEZ_ID, 'Sable Rook').lines, itTooltip(IT_DEZ_ID).lines);
});
