import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deck, LiveDeck, makeRng, pairKey } from '../webview/engine/types.ts';

const POOL = Array.from({ length: 12 }, (_, i) => `line ${i}`);
const deal = (d: Deck<string>, n: number): string[] => Array.from({ length: n }, () => d.next());

test('a deck deals every card once per round, with no repeat inside a round', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const d = new Deck(makeRng(seed), POOL);
    for (let round = 0; round < 6; round++) {
      const got = deal(d, POOL.length);
      assert.deepEqual([...got].sort(), [...POOL].sort(), `round ${round} (seed ${seed}) deals each card once`);
    }
  }
});

test('the first card of a new round is never the last one dealt', () => {
  // A constant rng shuffles the same way every round, which would repeat the seam card without the swap.
  for (const rng of [makeRng(9), () => 0, () => 0.999, () => 0.5]) {
    const d = new Deck(rng, POOL);
    const got = deal(d, POOL.length * 40);
    got.slice(1).forEach((l, i) => assert.notEqual(l, got[i], `repeat at ${i + 1}`));
  }
  // Two cards: strictly alternating.
  const two = new Deck(makeRng(3), ['a', 'b']);
  const seq = deal(two, 20);
  seq.slice(1).forEach((l, i) => assert.notEqual(l, seq[i]));
});

test('a one-card deck repeats its card; an empty deck throws', () => {
  const one = new Deck(makeRng(1), ['only']);
  assert.deepEqual(deal(one, 3), ['only', 'only', 'only']);
  const none = new Deck<string>(makeRng(1), []);
  assert.equal(none.size, 0);
  assert.throws(() => none.next(), /empty/);
});

test('a deck dedupes by key: the string itself, or a pair key for pairs', () => {
  const d = new Deck(makeRng(2), ['a', 'b', 'a', 'c', 'b']);
  assert.equal(d.size, 3);
  assert.deepEqual([...deal(d, 3)].sort(), ['a', 'b', 'c']);
  const pairs: [string, string][] = [['x', 'y'], ['x', 'y'], ['x', 'z'], ['y', 'x']];
  const p = new Deck(makeRng(2), pairs, pairKey);
  assert.equal(p.size, 3, 'same opener with another reply, and swapped pairs, are different cards');
  assert.equal(pairKey(['a', 'b']), 'a\u0000b');
  assert.notEqual(pairKey(['ab', 'c']), pairKey(['a', 'bc']));
});

test('the same seed deals the same order, another seed another', () => {
  const run = (seed: number): string => deal(new Deck(makeRng(seed), POOL), POOL.length * 3).join('|');
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test('a live deck mixes its sources, and rebuilds when a source changes identity', () => {
  const a = ['a1', 'a2', 'a3'];
  const b = ['b1', 'a1'];
  const rng = makeRng(4);
  const live = new LiveDeck<string>();
  const round1 = Array.from({ length: 4 }, () => live.next(rng, a, b));
  assert.deepEqual([...round1].sort(), ['a1', 'a2', 'a3', 'b1'], 'a1 is in both sources and counts once');
  // The same arrays keep the same deck (a second round continues; no rebuild).
  const round2 = Array.from({ length: 4 }, () => live.next(rng, a, b));
  assert.deepEqual([...round2].sort(), ['a1', 'a2', 'a3', 'b1']);
  assert.notEqual(round2[0], round1[3], 'no repeat across the seam');
  // A new array (a new theme) is a new pool at once.
  const c = ['c1', 'c2'];
  const after = Array.from({ length: 5 }, () => live.next(rng, a, c));
  assert.deepEqual([...new Set(after)].sort(), ['a1', 'a2', 'a3', 'c1', 'c2']);
  // Undefined and empty sources are fine; with nothing at all it throws like an empty deck.
  assert.equal(new LiveDeck<string>().next(rng, ['x'], undefined, []), 'x');
  assert.throws(() => new LiveDeck<string>().next(rng, undefined, []), /empty/);
});
