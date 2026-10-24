import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_MS, agoText, backAt, calendarTooltip, clockTooltip, contextPile, costText, effectiveWindow, isStale, probeNote, resetText,
  ringState, shortSpan, updatedText, usageLevel, whenText, windowTooltip, emptyUsageView,
} from '../webview/engine/usageLogic.ts';
import type { UsageSnapshot, UsageWindow } from '../src/shared/protocol.ts';

/** Local-time epoch ms in October 2026. */
const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();
const MIN = 60_000;

const win = (over: Partial<UsageWindow> = {}): UsageWindow => ({ id: 'five_hour', pct: 34, asOf: 0, ...over });
const snap = (windows: UsageWindow[], over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ kind: 'plan', windows, source: 'probe', probe: 'ok', ...over });

test('usageLevel thresholds at exactly 59, 60, 84, 85', () => {
  assert.equal(usageLevel(0), 'ok');
  assert.equal(usageLevel(59), 'ok');
  assert.equal(usageLevel(59.9), 'ok');
  assert.equal(usageLevel(60), 'warn');
  assert.equal(usageLevel(84), 'warn');
  assert.equal(usageLevel(84.9), 'warn');
  assert.equal(usageLevel(85), 'danger');
  assert.equal(usageLevel(100), 'danger');
  assert.equal(usageLevel(null), 'unknown');
  assert.equal(usageLevel(Number.NaN), 'unknown');
});

test('contextPile edges', () => {
  assert.deepEqual(contextPile(undefined), { sheets: 0, warn: false });
  assert.deepEqual(contextPile(Number.NaN), { sheets: 0, warn: false });
  assert.deepEqual(contextPile(0), { sheets: 0, warn: false });
  assert.deepEqual(contextPile(-5), { sheets: 0, warn: false });
  assert.deepEqual(contextPile(1), { sheets: 1, warn: false });
  assert.deepEqual(contextPile(25), { sheets: 1, warn: false });
  assert.deepEqual(contextPile(26), { sheets: 2, warn: false });
  assert.deepEqual(contextPile(50), { sheets: 2, warn: false });
  assert.deepEqual(contextPile(62), { sheets: 3, warn: false });
  assert.deepEqual(contextPile(75), { sheets: 3, warn: false });
  assert.deepEqual(contextPile(76), { sheets: 4, warn: false });
  assert.deepEqual(contextPile(89.9), { sheets: 4, warn: false });
  assert.deepEqual(contextPile(90), { sheets: 4, warn: true });
  assert.deepEqual(contextPile(100), { sheets: 4, warn: true });
  assert.deepEqual(contextPile(250), { sheets: 4, warn: true });
});

test('reset text: same day, across midnight, later in the week, further out', () => {
  assert.equal(resetText(at(19, 22, 40), at(19, 20, 30)), 'resets 22:40 (in 2h 10m)');
  assert.equal(resetText(at(19, 20, 45), at(19, 20, 30)), 'resets 20:45 (in 15m)');
  assert.equal(resetText(at(19, 20, 30) + 10_000, at(19, 20, 30)), 'resets 20:30 (in 1m)', 'rounds up to a minute');
  assert.equal(resetText(at(20, 0, 30), at(19, 23, 30)), 'resets tomorrow 00:30 (in 1h)');
  assert.equal(resetText(at(20, 9, 5), at(19, 23, 59)), 'resets tomorrow 09:05 (in 9h 6m)');
  assert.equal(resetText(at(22, 9, 0), at(19, 10, 0)), 'resets Thu 09:00 (in 2d 23h)');
  assert.match(resetText(at(29, 9, 0), at(19, 10, 0)), /^resets 29 Oct 09:00 \(in \d+d( \d+h)?\)$/); // the span depends on the zone's clock change on 25 Oct
  assert.equal(resetText(at(19, 9, 0), at(19, 9, 0)), 'reset');
  assert.equal(resetText(at(19, 8, 0), at(19, 9, 0)), 'reset');
  assert.equal(resetText(undefined, at(19, 9, 0)), '');
  assert.equal(shortSpan(0), '1m');
  assert.equal(shortSpan(48 * 60 * MIN), '2d');
  assert.equal(whenText(at(25, 13, 0), at(19, 10, 0)), 'Sun 13:00');
});

test('a window whose reset has passed counts as reset', () => {
  const now = at(19, 12);
  const w = win({ pct: 91, resetsAt: now - 1, state: 'blocked' });
  assert.deepEqual(effectiveWindow(w, now), { id: 'five_hour', pct: 0, asOf: 0, reset: true });
  assert.deepEqual(effectiveWindow({ ...w, resetsAt: now }, now).reset, true, 'a reset at exactly now has happened');
  const live = effectiveWindow({ ...w, resetsAt: now + 1 }, now);
  assert.deepEqual([live.pct, live.state, live.reset], [91, 'blocked', false]);
  const s = snap([w], { asOf: now - MIN });
  assert.deepEqual(ringState(s, 'five_hour', now), { pct: 0, level: 'ok', stale: false, blocked: false, reset: true });
  assert.equal(clockTooltip(s, now), 'New window · 0% used');
  assert.equal(backAt(s, now), null, 'a passed block gives no BACK plate');
});

test('stale snapshots', () => {
  const now = at(19, 12);
  assert.equal(isStale(null, now), true);
  assert.equal(isStale(snap([]), now), true, 'no reading at all');
  assert.equal(isStale(snap([win()], { asOf: now - STALE_MS }), now), false);
  assert.equal(isStale(snap([win()], { asOf: now - STALE_MS - 1 }), now), true);
  const s = snap([win({ pct: 34, resetsAt: now + 130 * MIN })], { asOf: now - 20 * MIN });
  assert.equal(clockTooltip(s, now), '34% used · resets 14:10 (in 2h 10m) · updated 20 min ago');
  assert.equal(ringState(s, 'five_hour', now).stale, true);
});

test('clock and calendar tooltips', () => {
  const now = at(19, 20, 30);
  const s = snap([win({ pct: 34.4, resetsAt: at(19, 22, 40), asOf: now }), win({ id: 'seven_day', pct: 71, resetsAt: at(22, 9, 0), asOf: now })], { asOf: now });
  assert.equal(clockTooltip(s, now), '34% used · resets 22:40 (in 2h 10m)');
  assert.equal(calendarTooltip(s, now), '71% used \u00b7 resets Thu 09:00 (in 2d 12h)');
  assert.equal(windowTooltip(s, 'seven_day_opus', now), 'Usage not read yet');
  assert.equal(clockTooltip(null, now), 'Usage not read yet');
  assert.equal(clockTooltip(snap([], { probe: 'signedOut', kind: 'unknown', source: 'none' }), now), 'Not signed in to a Claude account');
  assert.equal(clockTooltip(snap([win({ pct: null })], { probe: 'unsupported' }), now), 'This Claude Code cannot report usage');
  assert.equal(clockTooltip(snap([], { kind: 'apiKey' }), now), 'API-key billing: cost is shown ≈ at API prices');
  assert.equal(probeNote('off'), 'Usage checks are switched off');
  assert.equal(probeNote('failed'), 'Could not read usage, will retry');
});

test('backAt gives the time of the blocked window, with a day when it is not today', () => {
  const now = at(19, 15, 0);
  const blocked = win({ pct: 100, state: 'blocked', resetsAt: at(19, 17, 30), asOf: now });
  const s = snap([blocked], { asOf: now });
  assert.equal(backAt(s), '17:30');
  assert.equal(backAt(s, now), '17:30');
  assert.equal(clockTooltip(s, now), 'Limit reached · back 17:30');
  assert.deepEqual(ringState(s, 'five_hour', now), { pct: 100, level: 'danger', stale: false, blocked: true, reset: false });
  assert.equal(backAt(snap([win({ state: 'warning', resetsAt: at(19, 17, 30) })]), now), null, 'a warning is not a block');
  assert.equal(backAt(snap([win({ state: 'blocked' })]), now), null, 'no reset time known');
  assert.equal(backAt(null), null);
  const both = snap([blocked, win({ id: 'seven_day', state: 'blocked', pct: 100, resetsAt: at(21, 9, 0) })]);
  assert.equal(backAt(both, now), 'Wed 09:00', 'the latest reset wins, with its day');
  assert.equal(backAt(both), '09:00');
});

test('cost wording says API prices only for API-key users', () => {
  assert.equal(costText(snap([], { kind: 'apiKey' }), 1.234), '≈ $1.23 at API prices');
  assert.equal(costText(snap([]), 1.234), '$1.23');
  assert.equal(costText(null, 0), '$0.00');
  assert.equal(costText(snap([], { kind: 'apiKey' }), 0.001), '≈ <$0.01 at API prices');
  assert.equal(costText(snap([], { kind: 'apiKey' }), undefined), '');
  assert.equal(costText(snap([]), -1), '');
});

test('"Updated ..." wording', () => {
  const now = at(19, 12);
  assert.equal(updatedText(null, now), '');
  assert.equal(updatedText(snap([]), now), '');
  assert.equal(updatedText(snap([], { asOf: now - 120_000 }), now), 'Updated 2 min ago');
  assert.equal(updatedText(snap([], { asOf: now - 10_000 }), now), 'Updated just now');
  assert.equal(agoText(now - 65 * MIN, now), '1h 5m ago');
  assert.equal(agoText(now - 3 * 24 * 60 * MIN, now), '3d ago');
});

test('emptyUsageView: one message, never the note plus a second empty line', () => {
  assert.deepEqual(emptyUsageView(''), { title: 'No usage reading yet', hint: 'Press Refresh to read it from Claude Code.' });
  assert.deepEqual(emptyUsageView('Usage not read yet'), { title: 'Usage not read yet', hint: 'Press Refresh to read it from Claude Code.' });
  assert.deepEqual(emptyUsageView('Not signed in to a Claude account'), { title: 'Not signed in to a Claude account' });
});
