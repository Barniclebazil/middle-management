import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePlacement, placeOnFirstOpen, placeOnTopNow, PLACED_KEY, PLACED_MESSAGE, POSITION_TOP_COMMAND } from '../src/view/placement.ts';
import type { PlacementEnv, PlacementStore } from '../src/view/placement.ts';

function fake(commands: string[]) {
  const data = new Map<string, unknown>();
  const store: PlacementStore = { get: (k) => data.get(k), update: async (k, v) => void data.set(k, v) };
  const ran: string[] = [];
  const infos: string[] = [];
  const env: PlacementEnv = { getCommands: async () => commands, run: async (c) => void ran.push(c), info: (m) => void infos.push(m) };
  return { data, store, ran, infos, env };
}

test('decidePlacement', () => {
  assert.equal(decidePlacement(false, true), 'move');
  assert.equal(decidePlacement(true, true), 'skip');
  assert.equal(decidePlacement(true, false), 'skip');
  assert.equal(decidePlacement(false, false), 'mark-only');
});

test('first open moves, focuses, tells the user and sets the flag', async () => {
  const f = fake([POSITION_TOP_COMMAND]);
  assert.equal(await placeOnFirstOpen(f.store, f.env), 'move');
  assert.deepEqual(f.ran, [POSITION_TOP_COMMAND, 'claudeOffice.office.focus']);
  assert.deepEqual(f.infos, [PLACED_MESSAGE]);
  assert.equal(f.data.get(PLACED_KEY), true);
});

test('a second run does nothing', async () => {
  const f = fake([POSITION_TOP_COMMAND]);
  await placeOnFirstOpen(f.store, f.env);
  f.ran.length = 0;
  f.infos.length = 0;
  assert.equal(await placeOnFirstOpen(f.store, f.env), 'skip');
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.infos, []);
});

test('a missing command skips quietly and still sets the flag', async () => {
  const f = fake([]);
  assert.equal(await placeOnFirstOpen(f.store, f.env), 'mark-only');
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.infos, []);
  assert.equal(f.data.get(PLACED_KEY), true);
});

test('never throws', async () => {
  const f = fake([POSITION_TOP_COMMAND]);
  f.env.run = async () => {
    throw new Error('boom');
  };
  assert.equal(await placeOnFirstOpen(f.store, f.env), 'skip');
  assert.equal(await placeOnTopNow(f.store, f.env), false);
});

test('the command ignores the flag', async () => {
  const f = fake([POSITION_TOP_COMMAND]);
  f.data.set(PLACED_KEY, true);
  assert.equal(await placeOnTopNow(f.store, f.env), true);
  assert.deepEqual(f.ran, [POSITION_TOP_COMMAND, 'claudeOffice.office.focus']);
  assert.deepEqual(f.infos, []);
});
