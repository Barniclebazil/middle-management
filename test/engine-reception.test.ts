import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newChar } from '../webview/engine/characters.ts';
import {
  CALL_GAP_MAX_MS, CALL_GAP_MIN_MS, CALL_MAX_MS, CALL_MIN_MS, GREET_GAP_MS, GREET_LOOK_MS, ReceptionBrain,
} from '../webview/engine/reception.ts';
import type { ReceptionCtx, ReceptionDecision } from '../webview/engine/reception.ts';
import { RECEPTION_ATTENDING_LINE, RECEPTION_GREETINGS, RECEPTION_IDLE_LINES, RECEPTION_PHONE_LINES } from '../webview/engine/lines.ts';
import { lineSources, themeState } from '../webview/engine/theme.ts';
import type { LinesHook } from '../webview/engine/theme.ts';
import type { SeatDef } from '../webview/engine/types.ts';

const SEAT: SeatDef = { id: 'desk-receptionist', owner: 'reception', tile: { x: 5, y: 5 }, facing: 'down', deskId: 'desk-receptionist', visit: { tile: { x: 5, y: 7 }, facing: 'up' } };
const me = newChar('__reception__', 'receptionist', 'receptionist', SEAT, 88, 96, 0);
const ctx = (over: Partial<ReceptionCtx> = {}): ReceptionCtx => ({ me, seat: SEAT, speechBubbles: true, ...over });

/** Her `lines` hook for a theme whose receptionist has these lines (they join the phone, greeting and idle pools). */
const receptionLines = (lines: string[]): LinesHook => {
  const state = themeState({ receptionist: { lines } }, [], []);
  return (key) => lineSources(state, key);
};

/** Runs the brain at 100 ms steps from t = 0 to `until`, calling `each` with every decision. */
function run(brain: ReceptionBrain, until: number, c: ReceptionCtx, each: (d: ReceptionDecision, t: number) => void, from = 0): void {
  for (let t = from; t <= until; t += 100) each(brain.decide(c, t), t);
}

/** Start times (ms) of the phone calls in a run. */
function callStarts(brain: ReceptionBrain, until: number, c = ctx()): number[] {
  const starts: number[] = [];
  let was = false;
  run(brain, until, c, (d, t) => {
    const on = d.goal.pose === 'sitPhone';
    if (on && !was) starts.push(t);
    was = on;
  });
  return starts;
}

const all = (...lists: (readonly string[])[]): Set<string> => new Set(lists.flat());

test('she sits at her seat and never walks; she types and reads', () => {
  const b = new ReceptionBrain(1);
  const poses = new Set<string>();
  run(b, 300_000, ctx({ speechBubbles: false }), (d) => {
    assert.equal(d.goal.key, 'seat:desk-receptionist');
    assert.deepEqual(d.goal.tile, SEAT.tile);
    assert.equal(d.goal.away, false);
    poses.add(d.goal.pose);
  });
  assert.ok(poses.has('sitType') && poses.has('sitRead') && poses.has('sitPhone'), [...poses].join());
  for (const p of poses) assert.ok(['sitType', 'sitRead', 'sitPhone', 'sitIdle'].includes(p), p);
});

test('deterministic for a seed (and different seeds differ)', () => {
  const trace = (seed: number): string => {
    const b = new ReceptionBrain(seed);
    const out: string[] = [];
    b.noteArrival('main', 20_000);
    run(b, 400_000, ctx(), (d, t) => out.push(`${t}:${d.goal.pose}:${d.say?.text ?? ''}`));
    return out.join('|');
  };
  assert.equal(trace(7), trace(7));
  assert.notEqual(trace(7), trace(8));
});

test('calls start 120-240 s apart (first one 120-240 s in), last 6-12 s, with the phone line', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const b = new ReceptionBrain(seed);
    const lines: string[] = [];
    const lens: number[] = [];
    let startedAt = -1;
    const starts: number[] = [];
    run(b, 3_600_000, ctx(), (d, t) => {
      const on = d.goal.pose === 'sitPhone';
      if (on && startedAt < 0) { startedAt = t; starts.push(t); }
      if (!on && startedAt >= 0) { lens.push(t - startedAt); startedAt = -1; }
      if (d.say && on) lines.push(d.say.text);
    });
    assert.ok(starts.length >= 12, `${starts.length} calls in an hour`);
    assert.ok(starts[0]! >= CALL_GAP_MIN_MS && starts[0]! <= CALL_GAP_MAX_MS + 100, `first call at ${starts[0]}`);
    starts.slice(1).forEach((s, i) => {
      const gap = s - starts[i]!;
      assert.ok(gap >= CALL_GAP_MIN_MS && gap <= CALL_GAP_MAX_MS + 100, `gap ${gap}`);
    });
    for (const l of lens) assert.ok(l >= CALL_MIN_MS - 100 && l <= CALL_MAX_MS + 100, `call lasted ${l}`);
    assert.equal(lines.length, starts.length, 'one line per call');
    for (const l of lines) assert.ok(RECEPTION_PHONE_LINES.includes(l), l);
  }
  assert.equal(RECEPTION_PHONE_LINES[0], 'Front desk, how can I help?');
});

test('onPhone() is true exactly while she is on a call', () => {
  const b = new ReceptionBrain(3);
  let sawOn = false;
  run(b, 300_000, ctx(), (d) => {
    assert.equal(b.onPhone(), d.goal.pose === 'sitPhone');
    if (b.onPhone()) sawOn = true;
  });
  assert.ok(sawOn);
});

test('greets main agents only, at most once per 8 s, with a greeting line', () => {
  const b = new ReceptionBrain(11);
  const c = ctx();
  const says: { t: number; text: string }[] = [];
  const step = (t: number): void => { const d = b.decide(c, t); if (d.say) says.push({ t, text: d.say.text }); };
  // Warm up, then a temp arrives: no greeting.
  for (let t = 0; t < 5_000; t += 100) step(t);
  b.noteArrival('temp', 5_000);
  for (let t = 5_000; t < 9_000; t += 100) step(t);
  assert.equal(says.length, 0, 'temps are never greeted');
  // Three main agents in a burst: one greeting.
  b.noteArrival('main', 10_000);
  b.noteArrival('main', 10_500);
  b.noteArrival('main', 12_000);
  for (let t = 10_000; t < 17_000; t += 100) step(t);
  assert.equal(says.length, 1);
  assert.ok(RECEPTION_GREETINGS.includes(says[0]!.text));
  // Inside the 8 s window (10 s + 8 s = 18 s): ignored; after it: greeted.
  b.noteArrival('main', 17_900);
  for (let t = 17_000; t < 19_000; t += 100) step(t);
  assert.equal(says.length, 1, 'another arrival within 8 s of the last greeting is not greeted');
  b.noteArrival('main', 10_000 + GREET_GAP_MS + 200);
  for (let t = 19_000; t < 22_000; t += 100) step(t);
  assert.equal(says.length, 2);
  // She looks up (sitIdle) for the greeting, then goes back to work.
  const b2 = new ReceptionBrain(11);
  b2.decide(c, 0);
  b2.noteArrival('main', 100);
  assert.equal(b2.decide(c, 200).goal.pose, 'sitIdle');
  let back = false;
  for (let t = 300; t < 6_000; t += 100) if (['sitType', 'sitRead'].includes(b2.decide(c, t).goal.pose)) back = true;
  assert.ok(back);
});

test('no greeting while on the phone', () => {
  const b = new ReceptionBrain(2);
  const c = ctx();
  let t = 0;
  while (!b.onPhone() && t < 400_000) b.decide(c, (t += 100));
  assert.ok(b.onPhone());
  b.noteArrival('main', t);
  const says: string[] = [];
  for (let u = t; u < t + 5_000; u += 100) { const d = b.decide(c, u); if (d.say && RECEPTION_GREETINGS.includes(d.say.text)) says.push(d.say.text); }
  assert.deepEqual(says, []);
});

test('attending: looks up and says the line once, pauses calls, and calls resume afterwards', () => {
  const b = new ReceptionBrain(5);
  const c = ctx();
  // Run up to just before the first call is due, then open the Front desk for 5 minutes.
  const baseline = callStarts(new ReceptionBrain(5), 1_000_000);
  assert.ok(baseline.length >= 3);
  let t = 0;
  for (; t < baseline[0]! - 5_000; t += 100) b.decide(c, t);
  b.setAttending(true);
  b.setAttending(true);
  const says: string[] = [];
  const poses = new Set<string>();
  for (let u = t; u < t + 300_000; u += 100) {
    const d = b.decide(c, u);
    if (d.say) says.push(d.say.text);
    poses.add(d.goal.pose);
    assert.equal(b.onPhone(), false);
  }
  t += 300_000;
  assert.deepEqual(says, [RECEPTION_ATTENDING_LINE], 'says it once');
  assert.deepEqual([...poses], ['sitIdle'], 'looks up, no calls, no typing');
  assert.equal(b.isAttending(), true);
  b.setAttending(false);
  let called = false;
  for (let u = t; u < t + 2 * CALL_GAP_MAX_MS + 1_000; u += 100) if (b.decide(c, u).goal.pose === 'sitPhone') called = true;
  assert.ok(called, 'calls come back after the panel closes');
  // Re-opening says it again.
  b.setAttending(true);
  assert.equal(b.decide(c, t + 10_000_000).say?.text, RECEPTION_ATTENDING_LINE);
});

test('opening the Front desk during a call ends the call', () => {
  const b = new ReceptionBrain(9);
  const c = ctx();
  let t = 0;
  while (!b.onPhone()) b.decide(c, (t += 100));
  b.setAttending(true);
  const d = b.decide(c, t + 100);
  assert.equal(b.onPhone(), false);
  assert.equal(d.goal.pose, 'sitIdle');
  assert.equal(d.say?.text, RECEPTION_ATTENDING_LINE);
});

test('theme lines are mixed into the built-in phone, greeting and idle lines', () => {
  const lines = ['Reception, hold please.', 'One sec.'];
  const builtIn = all(RECEPTION_PHONE_LINES, RECEPTION_GREETINGS, RECEPTION_IDLE_LINES);
  const said = (c: ReceptionCtx): string[] => {
    const b = new ReceptionBrain(4);
    const out: string[] = [];
    for (let t = 0; t <= 8 * 3_600_000; t += 500) {
      if (t % 30_000 === 0) b.noteArrival('main', t);
      const d = b.decide(c, t);
      if (d.say) out.push(d.say.text);
    }
    return out;
  };
  const themed = said(ctx({ lines: receptionLines(lines) }));
  assert.ok(themed.length >= 100, `${themed.length} lines in 8 hours`);
  for (const s of themed) assert.ok(builtIn.has(s) || lines.includes(s), `unexpected line: ${s}`);
  for (const l of lines) assert.ok(themed.includes(l), `themed line said: ${l}`);
  assert.ok(themed.some((s) => builtIn.has(s)), 'built-in lines are still said');
  // Without theme lines, and with an empty list, only the built-ins.
  for (const c of [ctx(), ctx({ lines: receptionLines([]) })]) for (const s of said(c)) assert.ok(builtIn.has(s), `unexpected line: ${s}`);
});

test('her phone, greeting and idle lines are dealt from decks: each once before any comes back', () => {
  const lines = ['Reception, hold please.', 'One sec.', RECEPTION_PHONE_LINES[0]!];
  const b = new ReceptionBrain(8);
  const c = ctx({ lines: receptionLines(lines) });
  const phone: string[] = [];
  const idle: string[] = [];
  const greet: string[] = [];
  for (let t = 0; t <= 8 * 3_600_000; t += 500) {
    if (t % 20_000 === 0) b.noteArrival('main', t);
    const d = b.decide(c, t);
    if (!d.say) continue;
    (d.goal.pose === 'sitPhone' ? phone : d.goal.pose === 'sitIdle' ? greet : idle).push(d.say.text);
  }
  // The phone line is the built-in "signature" one and also a theme line: it counts once.
  const rounds: [string[], readonly string[]][] = [
    [phone, RECEPTION_PHONE_LINES], [greet, RECEPTION_GREETINGS], [idle, RECEPTION_IDLE_LINES],
  ];
  for (const [got, pool] of rounds) {
    const n = new Set([...pool, ...lines]).size;
    assert.ok(got.length >= n, `${got.length} lines for a pool of ${n}`);
    for (let i = 0; i + n <= got.length; i += n) {
      assert.equal(new Set(got.slice(i, i + n)).size, n, `lines ${i}-${i + n} are one full round`);
    }
    got.slice(1).forEach((l, i) => assert.notEqual(l, got[i]));
  }
});

test('silent with speech bubbles off: no greetings, calls, remarks or attending line', () => {
  const b = new ReceptionBrain(6);
  const c = ctx({ speechBubbles: false });
  b.noteArrival('main', 500);
  b.setAttending(true);
  const said: string[] = [];
  const poses = new Set<string>();
  run(b, 100_000, c, (d) => { if (d.say) said.push(d.say.text); poses.add(d.goal.pose); });
  b.setAttending(false);
  run(b, 900_000, c, (d) => { if (d.say) said.push(d.say.text); poses.add(d.goal.pose); }, 100_100);
  assert.deepEqual(said, []);
  assert.ok(poses.has('sitPhone'), 'she still takes calls, just silently');
});

test('hold: ends on its own, and then the waiting call, greeting and remark all happen', () => {
  const b = new ReceptionBrain(1);
  const c = ctx();
  const free = callStarts(new ReceptionBrain(1), 400_000)[0]!;
  const until = free + 20_000;
  b.noteArrival('main', 500);
  b.hold(until);
  const says: { t: number; text: string }[] = [];
  const phone: number[] = [];
  let was = false;
  run(b, 600_000, c, (d, t) => {
    if (d.say) says.push({ t, text: d.say.text });
    const on = d.goal.pose === 'sitPhone';
    if (on && !was) phone.push(t);
    was = on;
    if (t < until) {
      assert.equal(d.say, undefined);
      assert.notEqual(d.goal.pose, 'sitPhone');
      assert.equal(d.goal.key, 'seat:desk-receptionist');
    }
  });
  assert.ok(phone.length > 0 && phone[0]! >= until, `the call waited: first at ${phone[0]}, hold to ${until}`);
  // (Her pending greeting comes first, then the call; neither is dropped.)
  assert.ok(phone[0]! - until <= GREET_LOOK_MS + 300, `and came right after the hold: ${phone[0]! - until} ms later`);
  const greet = says.find((s) => RECEPTION_GREETINGS.includes(s.text));
  assert.ok(greet && greet.t >= until, 'the pending greeting was kept and said after the hold');
});

test('hold: a call already under way is not cut short, and the Front desk still wins', () => {
  const b = new ReceptionBrain(1);
  const c = ctx();
  const start = callStarts(new ReceptionBrain(1), 400_000)[0]!;
  let t = 0;
  for (; t <= start + 300; t += 100) b.decide(c, t);
  assert.equal(b.onPhone(), true);
  b.hold(t + 60_000);
  const d = b.decide(c, t + 100);
  assert.equal(d.goal.pose, 'sitPhone', 'the call goes on');
  b.setAttending(true);
  const a = b.decide(c, t + 200);
  assert.equal(a.say?.text, RECEPTION_ATTENDING_LINE, 'the panel wins over the hold');
  assert.equal(a.goal.pose, 'sitIdle');
});
