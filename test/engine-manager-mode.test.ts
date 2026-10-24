import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../webview/engine/office.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import { agentTooltip, managerTooltip, projectLine, rosterEntries } from '../webview/engine/tooltip.ts';
import { collectBubbles } from '../webview/engine/bubbles.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();

test('normalizeAgent carries the Manager Mode fields and drops bad ones', () => {
  const v = normalizeAgent(agent('a', {
    sessionId: 's-1', cwd: '/home/u/web', gitBranch: ' main ', control: 'office', costUsd: 0.5,
    pending: { requestId: 'r1', kind: 'question' },
  }), HOST0)!;
  assert.equal(v.sessionId, 's-1');
  assert.equal(v.cwd, '/home/u/web');
  assert.equal(v.gitBranch, 'main');
  assert.equal(v.control, 'office');
  assert.equal(v.costUsd, 0.5);
  assert.deepEqual(v.pending, { requestId: 'r1', kind: 'question' });
  const bad = normalizeAgent({ id: 'b', control: 'boss', pending: { requestId: 'r', kind: 'bribe' }, costUsd: -1, gitBranch: '  ' }, HOST0)!;
  assert.equal(bad.control, undefined);
  assert.equal(bad.pending, undefined);
  assert.equal(bad.costUsd, undefined);
  assert.equal(bad.gitBranch, undefined);
});

test('roster entries carry branch, control and what a knocking worker wants', () => {
  const o = new Office(world, { seed: 3 });
  o.applySnapshot([
    agent('a', { activity: 'needsYou', status: 'waiting', gitBranch: 'main', control: 'office', pending: { requestId: 'r', kind: 'plan' } }),
    agent('b', { activity: 'needsYou', status: 'waiting' }),
    agent('c', { control: 'elsewhere' }),
  ], 0, HOST0);
  const rows = new Map(rosterEntries(o, HOST0).map((r) => [r.id, r]));
  assert.equal(rows.get('a')!.doing, 'Needs you · plan sign-off');
  assert.equal(rows.get('a')!.branch, 'main');
  assert.equal(rows.get('a')!.control, 'office');
  assert.equal(rows.get('a')!.pending, 'plan');
  assert.equal(rows.get('b')!.doing, 'Needs you', 'a plain needsYou stays as it was');
  assert.equal(rows.get('b')!.pending, null);
  assert.equal(rows.get('c')!.control, 'elsewhere');
  assert.equal(rows.get('c')!.branch, '');
});

test('tooltips name the branch, the knock, and what a click does', () => {
  const v = normalizeAgent(agent('a', { project: 'web-app', gitBranch: 'feat/x', activity: 'needsYou', status: 'waiting', pending: { requestId: 'r', kind: 'permission' }, detail: 'ignored' }), HOST0)!;
  const tip = agentTooltip(v, 'Staff', null, HOST0, false);
  assert.equal(tip.lines[0], 'web-app · ⎇ feat/x');
  assert.ok(tip.lines.includes('Knocking: wants your OK'));
  assert.ok(!tip.lines.includes('ignored'), 'the knock replaces the detail line');
  assert.equal(tip.hint, 'Click to answer');
  const busy = agentTooltip(normalizeAgent(agent('b', { control: 'elsewhere' }), HOST0)!, 'Staff', null, HOST0, false);
  assert.ok(busy.lines.includes('Open in another window (read-only here)'));
  assert.equal(busy.hint, 'Click to open their case file');
  assert.ok(!busy.lines.some((l) => l.startsWith('Click')), 'the click hint is kept apart from the facts');
  assert.equal(agentTooltip(normalizeAgent(agent('c'), HOST0)!, 'Staff', null, HOST0, true).hint, undefined, 'nothing to click on someone leaving');
  assert.deepEqual(managerTooltip('Morgan'), { title: 'Morgan — Regional Manager (you)', lines: [], hint: 'Click to hand out a new task' });
  assert.equal(managerTooltip('You').title, 'You — Regional Manager', 'no "You … (you)"');
  assert.equal(projectLine('', 'main'), '⎇ main');
  assert.equal(projectLine('api', undefined), 'api');
});

test('a knocking worker with an open request gets a pulsing "!"; a plain needsYou does not', () => {
  const o = new Office(world, { seed: 4 });
  o.applySnapshot([
    agent('a', { activity: 'needsYou', status: 'waiting', pending: { requestId: 'r', kind: 'permission' } }),
    agent('b', { activity: 'needsYou', status: 'waiting' }),
  ], 0, HOST0);
  const reqs = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: true, managerName: 'You' }, 0);
  const alert = (id: string) => reqs.find((r) => r.charId === id && r.icon === 'alert');
  assert.equal(alert('a')?.pulse, true);
  assert.equal(alert('b')?.pulse, false);
});
