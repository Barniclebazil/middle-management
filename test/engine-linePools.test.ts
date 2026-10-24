// LINE_POOLS (webview/engine/lines.ts) maps every theme line pool to its built-in lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_POOL_INFO, LINE_POOL_KEYS, LINE_POOL_KIND } from '../src/shared/theme.ts';
import { LINE_POOLS } from '../webview/engine/lines.ts';

test('LINE_POOLS has exactly the theme line pool keys, in order', () => {
  assert.deepEqual(Object.keys(LINE_POOLS), [...LINE_POOL_KEYS]);
});

test('each pool holds lines or pairs as LINE_POOL_KIND says, and is not empty', () => {
  for (const key of LINE_POOL_KEYS) {
    const pool: readonly unknown[] = LINE_POOLS[key];
    assert.ok(Array.isArray(pool), key);
    assert.ok(pool.length > 0, `${key} is empty`);
    for (const entry of pool) {
      if (LINE_POOL_KIND[key] === 'pairs') {
        assert.ok(Array.isArray(entry) && entry.length === 2 && entry.every((s) => typeof s === 'string' && s.length > 0), `${key}: ${JSON.stringify(entry)}`);
      } else {
        assert.ok(typeof entry === 'string' && entry.length > 0, `${key}: ${JSON.stringify(entry)}`);
      }
    }
  }
});

test('the single-line pools hold exactly the one built-in line', () => {
  for (const key of ['bossSnoop', 'receptionAttending', 'itFix'] as const) assert.equal(LINE_POOLS[key].length, 1, key);
});

test('LINE_POOL_INFO describes every pool', () => {
  assert.deepEqual(Object.keys(LINE_POOL_INFO).sort(), [...LINE_POOL_KEYS].sort());
  for (const key of LINE_POOL_KEYS) {
    assert.ok(LINE_POOL_INFO[key].who.trim() !== '' && LINE_POOL_INFO[key].when.trim() !== '', key);
  }
});
