import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextPercent, contextWindowFor, DEFAULT_CONTEXT_WINDOW, LONG_CONTEXT_WINDOW } from '../src/model/contextWindow.ts';

test('an unknown model gets 200k and is marked approx', () => {
  assert.deepEqual(contextWindowFor('claude-opus-5-5'), { max: 200_000, approx: true });
  assert.deepEqual(contextWindowFor(undefined), { max: DEFAULT_CONTEXT_WINDOW, approx: true });
  assert.deepEqual(contextWindowFor(''), { max: DEFAULT_CONTEXT_WINDOW, approx: true });
});

test('a [1m] suffix means 1,000,000 and is exact', () => {
  const w = contextWindowFor('claude-opus-5-5[1m]');
  assert.deepEqual(w, { max: LONG_CONTEXT_WINDOW });
  assert.equal('approx' in w, false);
  assert.equal(contextWindowFor('claude-opus-5-5[1M]').max, 1_000_000);
});

test('a learned window wins, without approx', () => {
  const learned = new Map([['claude-opus-5-5', 500_000]]);
  assert.deepEqual(contextWindowFor('claude-opus-5-5', learned), { max: 500_000 });
  // Other models are unaffected.
  assert.deepEqual(contextWindowFor('claude-haiku-5-5', learned), { max: 200_000, approx: true });
});

test('a learned window beats the [1m] suffix, and is found for the bare id too', () => {
  assert.equal(contextWindowFor('m[1m]', new Map([['m[1m]', 123_000]])).max, 123_000);
  assert.equal(contextWindowFor('m[1m]', new Map([['m', 456_000]])).max, 456_000);
  assert.equal(contextWindowFor('m', new Map([['m[1m]', 456_000]])).approx, true);
});

test('nonsense learned values are ignored', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(contextWindowFor('m', new Map([['m', bad]])), { max: 200_000, approx: true });
  }
});

test('observed tokens above 200k lift the guessed window to 1M (still approx)', () => {
  assert.deepEqual(contextWindowFor('claude-opus-5-5', undefined, 199_999), { max: 200_000, approx: true });
  assert.deepEqual(contextWindowFor('claude-opus-5-5', undefined, 200_000), { max: 200_000, approx: true });
  assert.deepEqual(contextWindowFor('claude-opus-5-5', undefined, 250_000), { max: 1_000_000, approx: true });
  assert.deepEqual(contextWindowFor(undefined, undefined, 250_000), { max: 1_000_000, approx: true });
});

test('a learned window or a [1m] suffix still wins over the observed tokens', () => {
  assert.deepEqual(contextWindowFor('m', new Map([['m', 200_000]]), 250_000), { max: 200_000 });
  assert.deepEqual(contextWindowFor('m[1m]', undefined, 250_000), { max: 1_000_000 });
});

test('contextPercent rounds and clamps to 0-100', () => {
  assert.equal(contextPercent(0, 200_000), 0);
  assert.equal(contextPercent(100_000, 200_000), 50);
  assert.equal(contextPercent(33_333, 200_000), 17);
  assert.equal(contextPercent(1, 200_000), 0);
  assert.equal(contextPercent(250_000, 200_000), 100);
  assert.equal(contextPercent(-10, 200_000), 0);
  assert.equal(contextPercent(10, 0), 0);
  assert.equal(contextPercent(Number.NaN, 200_000), 0);
});
