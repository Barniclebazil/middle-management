import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUG_SIPS, SIP_EVERY_MS, SIP_SPEED, effortOrDefault, isSipping, newCoffee, nextSipDelay, refill, sipFrameElapsed, stepCoffee, wantsRefill,
} from '../webview/engine/coffeeLogic.ts';
import type { CoffeeState } from '../webview/engine/coffeeLogic.ts';
import { makeRng } from '../webview/engine/types.ts';
import { EFFORT_LEVELS } from '../src/shared/protocol.ts';
import type { EffortLevel } from '../src/shared/protocol.ts';

const SIP_MS = 1_500;

/** Steps every 100 ms from 0 to `to`; returns the sip start times and the final state. */
function run(effort: EffortLevel, to: number, seated: (t: number) => boolean = () => true, seed = 7): { starts: number[]; state: CoffeeState } {
  const rng = makeRng(seed);
  let state = newCoffee(0, effort, rng);
  const starts: number[] = [];
  for (let t = 0; t <= to; t += 100) {
    const r = stepCoffee(state, t, { effort, seatedWorking: seated(t), rng, sipMs: SIP_MS });
    state = r.state;
    if (r.startedSip) starts.push(t);
  }
  return { starts, state };
}

test('the sip interval stays within 25 % of the level average', () => {
  const rng = makeRng(1);
  for (const e of EFFORT_LEVELS) {
    for (let i = 0; i < 200; i++) {
      const d = nextSipDelay(e, rng);
      assert.ok(d >= SIP_EVERY_MS[e] * 0.75 && d <= SIP_EVERY_MS[e] * 1.25, `${e}: ${d}`);
    }
  }
});

test('max effort sips at least 5x as often as low over an hour of seated work (with a refill each time the mug empties)', () => {
  const count = (e: EffortLevel): number => {
    const rng = makeRng(3);
    let s = newCoffee(0, e, rng);
    let n = 0;
    for (let t = 0; t <= 3_600_000; t += 100) {
      if (wantsRefill(s, true)) s = refill(s, t, e, rng);
      const r = stepCoffee(s, t, { effort: e, seatedWorking: true, rng, sipMs: SIP_MS });
      s = r.state;
      if (r.startedSip) n++;
    }
    return n;
  };
  assert.ok(count('max') >= 5 * count('low'));
});

test('never sips when not seated and working', () => {
  const { starts, state } = run('max', 3_600_000, () => false);
  assert.equal(starts.length, 0);
  assert.equal(state.sips, MUG_SIPS);
});

test('returning to work does not cause an instant sip', () => {
  const back = 600_000;
  const { starts } = run('max', back + 5_000, (t) => t >= back);
  assert.ok(starts.length === 0 || starts[0]! > back);
  assert.ok(starts.length <= 1);
});

test('keeps sipping while working with an empty mug, and wantsRefill once idle', () => {
  const { starts, state } = run('max', 3_600_000);
  assert.ok(starts.length > 3 * MUG_SIPS, `${starts.length} sips in an hour, well past the six in the mug`);
  assert.equal(state.sips, 0, 'the mug stays at empty, never below');
  assert.ok(starts.some((t) => t > 600_000), 'still sipping late in the stretch');
  assert.equal(wantsRefill(state, false), false, 'not while working');
  assert.equal(wantsRefill(state, true), true, 'once idle');
});

test('a sip runs for sipMs / speed and isSipping follows it', () => {
  const rng = makeRng(2);
  const s0 = newCoffee(0, 'max', rng);
  const r = stepCoffee(s0, s0.nextSipAt, { effort: 'max', seatedWorking: true, rng, sipMs: SIP_MS });
  assert.ok(r.startedSip);
  assert.equal(r.state.sips, MUG_SIPS - 1);
  assert.ok(isSipping(r.state, s0.nextSipAt + 10));
  assert.ok(!isSipping(r.state, s0.nextSipAt + SIP_MS / SIP_SPEED.max + 1));
});

test('wantsRefill only when idle and empty', () => {
  const full: CoffeeState = { sips: MUG_SIPS, nextSipAt: 0, sippingUntil: 0 };
  const empty: CoffeeState = { ...full, sips: 0 };
  assert.equal(wantsRefill(empty, true), true);
  assert.equal(wantsRefill(empty, false), false);
  assert.equal(wantsRefill(full, true), false);
  assert.equal(wantsRefill({ ...full, sips: 1 }, true), false);
});

test('refill gives a full mug and schedules the next sip', () => {
  const rng = makeRng(5);
  const empty: CoffeeState = { sips: 0, nextSipAt: 0, sippingUntil: 0 };
  const s = refill(empty, 1_000, 'high', rng);
  assert.equal(s.sips, MUG_SIPS);
  assert.ok(s.nextSipAt >= 1_000 + SIP_EVERY_MS.high * 0.75 && s.nextSipAt <= 1_000 + SIP_EVERY_MS.high * 1.25);
  assert.ok(!isSipping(s, 1_000));
});

test('sip speed rises with effort, and scales the animation clock', () => {
  for (let i = 1; i < EFFORT_LEVELS.length; i++) {
    assert.ok(SIP_SPEED[EFFORT_LEVELS[i]!] > SIP_SPEED[EFFORT_LEVELS[i - 1]!]);
    assert.ok(SIP_EVERY_MS[EFFORT_LEVELS[i]!] < SIP_EVERY_MS[EFFORT_LEVELS[i - 1]!]);
  }
  assert.equal(SIP_SPEED.low, 1);
  assert.equal(SIP_SPEED.max, 1.8);
  assert.equal(sipFrameElapsed(100, 'max'), 180);
});

test('missing effort means medium', () => {
  assert.equal(effortOrDefault(undefined), 'medium');
  for (const e of EFFORT_LEVELS) assert.equal(effortOrDefault(e), e);
});
