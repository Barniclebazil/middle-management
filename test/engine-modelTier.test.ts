import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_COLOURS, tierLabel, tierOf, tierRank } from '../webview/engine/modelTier.ts';

test('tierOf reads full ids', () => {
  assert.equal(tierOf('claude-fable-5-1'), 'fable');
  assert.equal(tierOf('claude-opus-5-5'), 'opus');
  assert.equal(tierOf('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.equal(tierOf('claude-haiku-4-5'), 'haiku');
  assert.equal(tierOf('claude-opus-4-6[1m]'), 'opus');
});

test('tierOf reads the older id form and aliases', () => {
  assert.equal(tierOf('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.equal(tierOf('claude-3-opus-20240229'), 'opus');
  for (const t of TIERS) assert.equal(tierOf(t), t);
  assert.equal(tierOf('opus[1m]'), 'opus');
});

test('tierOf ignores case and whitespace and accepts provider prefixes', () => {
  assert.equal(tierOf('  Claude-Opus-4-1 '), 'opus');
  assert.equal(tierOf(' SONNET '), 'sonnet');
  assert.equal(tierOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'sonnet');
  assert.equal(tierOf('anthropic/claude-opus-4-1'), 'opus');
});

test('tierOf returns null for missing or unknown ids', () => {
  for (const m of [undefined, '', '   ', '<synthetic>', 'gpt-4o', 'claude-3-5', 'opusx', 'claude-opusx-4', 'my-opus-model']) assert.equal(tierOf(m), null, String(m));
});

test('tierRank orders best first and unknown ranks as sonnet', () => {
  assert.ok(tierRank('fable') < tierRank('opus'));
  assert.ok(tierRank('opus') < tierRank('sonnet'));
  assert.ok(tierRank('sonnet') < tierRank('haiku'));
  assert.equal(tierRank(null), tierRank('sonnet'));
});

test('every tier has colours and a label', () => {
  for (const t of TIERS) {
    assert.match(TIER_COLOURS[t].bg, /^#[0-9a-f]{6}$/i);
    assert.match(TIER_COLOURS[t].fg, /^#[0-9a-f]{6}$/i);
  }
  assert.deepEqual(TIERS.map(tierLabel), ['Fable', 'Opus', 'Sonnet', 'Haiku']);
});
