import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../webview/engine/office.ts';
import { agentTooltip, idleWords, rosterEntries } from '../webview/engine/tooltip.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();

test('an idle parent waiting on temps says so, in the roster and the tooltip', () => {
  const o = new Office(world, { seed: 5 });
  o.applySnapshot([
    agent('a', { activity: 'idle', status: 'idle' }),
    agent('b', { activity: 'idle', status: 'idle' }),
    agent('c', { activity: 'writing' }),
    agent('t1', { kind: 'temp', parentId: 'a', activity: 'searching' }),
    agent('t2', { kind: 'temp', parentId: 'a', activity: 'reading' }),
    agent('t3', { kind: 'temp', parentId: 'a', activity: 'reading', status: 'done' }),
    agent('t4', { kind: 'temp', parentId: 'b', activity: 'reading' }),
    agent('t5', { kind: 'temp', parentId: 'c', activity: 'reading' }),
  ], 0, HOST0);
  const rows = new Map(rosterEntries(o, HOST0).map((r) => [r.id, r]));
  assert.equal(rows.get('a')!.doing, 'Idle \u00b7 waiting on 2 temps');
  assert.equal(rows.get('b')!.doing, 'Idle \u00b7 waiting on 1 temp');
  assert.equal(rows.get('c')!.doing, 'Writing', 'only idle parents change');
  assert.equal(idleWords(0), 'Idle');
  const v = o.agentById('a')!;
  assert.ok(agentTooltip(v, 'Staff', null, HOST0, false, 2).lines.some((l) => l.startsWith('Idle \u00b7 waiting on 2 temps for ')));
  assert.ok(agentTooltip(v, 'Staff', null, HOST0, false, 0).lines.some((l) => l.startsWith('Idle for ')));
});
