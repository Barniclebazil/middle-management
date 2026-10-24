import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationItem, UsageSnapshot } from '../src/shared/protocol.ts';
import type { InboxItem } from '../webview/engine/inboxLogic.ts';
import {
  REFRESH_COOLDOWN_MS, agoWords, costRows, extraRow, formatMoney, inboxAction, inboxRow, inboxSummary, markAllKeys, nextCheckText, planAgeText, planReadOnlyHint,
  probeNoteFor, refreshButtonState, shortAgo, staleNote, supersededText, toolRunSummary, turnBlocks, usageBarRows,
} from '../webview/engine/panelsLogic.ts';

const NOW = Date.parse('2026-10-19T12:00:00');
const MIN = 60_000;
const HOUR = 60 * MIN;

function item(over: Partial<InboxItem> = {}): InboxItem {
  return { key: 'report:a:1', kind: 'report', urgency: 'normal', title: 'T', detail: 'D', agentId: 'a', at: NOW - 5 * MIN, read: false, ...over };
}

test('shortAgo and agoWords', () => {
  assert.equal(shortAgo(NOW - 10_000, NOW), 'now');
  assert.equal(shortAgo(NOW - 5 * MIN, NOW), '5m');
  assert.equal(shortAgo(NOW - 3 * HOUR, NOW), '3h');
  assert.equal(shortAgo(NOW - 2 * 24 * HOUR, NOW), '2d');
  assert.equal(shortAgo(NOW - 15 * 24 * HOUR, NOW), '2w');
  assert.equal(shortAgo(NOW + 5 * MIN, NOW), 'now');
  assert.equal(agoWords(NOW - 5 * MIN, NOW), '5m ago');
  assert.equal(agoWords(NOW, NOW), 'just now');
});

test('inboxAction: reports open the report view, indexed plans the plan view, the rest the case file', () => {
  assert.equal(inboxAction(item()), 'report');
  assert.equal(inboxAction(item({ kind: 'plan', planId: 'p1' })), 'plan');
  assert.equal(inboxAction(item({ kind: 'plan' })), 'case');
  assert.equal(inboxAction(item({ kind: 'question', urgency: 'urgent' })), 'case');
  assert.equal(inboxAction(item({ kind: 'approval', urgency: 'urgent' })), 'case');
  assert.equal(inboxAction(item({ kind: 'attention', urgency: 'urgent' })), 'case');
});

test('inboxRow describes the row in words as well as flags', () => {
  const r = inboxRow(item(), NOW);
  assert.deepEqual({ kind: r.kindLabel, unread: r.unread, urgent: r.urgent, time: r.time }, { kind: 'Report', unread: true, urgent: false, time: '5m' });
  assert.equal(r.describe, 'Report, unread, 5m ago');
  assert.equal(inboxRow(item({ read: true }), NOW).describe, 'Report, read, 5m ago');
  const u = inboxRow(item({ kind: 'question', urgency: 'urgent' }), NOW);
  assert.equal(u.describe, 'Question, needs you now, 5m ago');
  assert.equal(u.urgent, true);
});

test('inboxSummary', () => {
  assert.equal(inboxSummary([]), '');
  assert.equal(inboxSummary([item({ read: true })]), 'All read');
  assert.equal(inboxSummary([item(), item({ key: 'b' })]), '2 unread');
  assert.equal(inboxSummary([item(), item({ key: 'q', kind: 'question', urgency: 'urgent' })]), '2 unread · 1 needs you');
  assert.equal(inboxSummary([item({ kind: 'question', urgency: 'urgent' }), item({ key: 'q2', kind: 'approval', urgency: 'urgent' })]), '2 unread · 2 need you');
});

test('markAllKeys skips urgent and already read items', () => {
  const items = [item({ key: 'a' }), item({ key: 'b', read: true }), item({ key: 'c', kind: 'question', urgency: 'urgent' }), item({ key: 'd', kind: 'plan' })];
  assert.deepEqual(markAllKeys(items), ['a', 'd']);
});

test('turnBlocks groups consecutive tool steps and drops thinking', () => {
  const tool = (id: string, state: 'done' | 'error' = 'done'): ConversationItem => ({ kind: 'tool', id, name: 'Bash', state, summary: id });
  const items: ConversationItem[] = [
    { kind: 'prompt', id: 'p', text: 'go' }, { kind: 'thinking', id: 'th' }, tool('a'), tool('b', 'error'), { kind: 'thinking', id: 'th2' }, tool('c'),
    { kind: 'assistant', id: 'x', text: 'done' }, tool('d'),
  ];
  const blocks = turnBlocks(items);
  assert.deepEqual(blocks.map((b) => (b.kind === 'tools' ? `tools:${b.items.map((i) => i.id).join('')}` : b.item.kind)), ['prompt', 'tools:abc', 'assistant', 'tools:d']);
  const run = blocks[1];
  assert.ok(run && run.kind === 'tools');
  assert.equal(toolRunSummary(run.items), '3 steps, 1 failed');
  assert.equal(toolRunSummary([{ state: 'done' }]), '1 step');
  assert.deepEqual(turnBlocks([]), []);
});

test('planAgeText and hints', () => {
  assert.equal(planAgeText({ column: 'waiting', at: NOW - 9 * MIN }, NOW), 'waiting 9m');
  assert.equal(planAgeText({ column: 'waiting', at: NOW }, NOW), 'waiting just now');
  assert.equal(planAgeText({ column: 'approved', at: NOW - 3 * HOUR }, NOW), 'approved 3h ago');
  assert.equal(planAgeText({ column: 'sentBack', at: NOW - 2 * 24 * HOUR }, NOW), 'sent back 2d ago');
  assert.match(planReadOnlyHint('pending', false), /Decide in Claude Code/);
  assert.match(planReadOnlyHint('pending', true), /Nobody is waiting/);
  assert.equal(planReadOnlyHint('approved', false), '');
  assert.equal(supersededText(0), '');
  assert.equal(supersededText(1), '1 superseded plan hidden');
  assert.equal(supersededText(3), '3 superseded plans hidden');
});

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { kind: 'plan', source: 'probe', probe: 'ok', asOf: NOW - 2 * MIN, windows: [], ...over };
}

test('usageBarRows: fixed order, levels in words, blocked and reset states', () => {
  const s = snap({
    windows: [
      { id: 'seven_day_sonnet', pct: 20, resetsAt: NOW + 3 * 24 * HOUR, asOf: NOW },
      { id: 'five_hour', pct: 34, resetsAt: NOW + 130 * MIN, asOf: NOW },
      { id: 'seven_day', pct: 88, resetsAt: NOW + 24 * HOUR, asOf: NOW },
      { id: 'seven_day_opus', pct: 100, resetsAt: NOW + 2 * HOUR, asOf: NOW, state: 'blocked' },
    ],
  });
  const rows = usageBarRows(s, NOW);
  assert.deepEqual(rows.map((r) => r.label), ['5-hour window', 'Weekly', 'Weekly · Opus', 'Weekly · Sonnet']);
  assert.deepEqual(rows.map((r) => r.levelText), ['OK', 'Near the limit', 'Limit reached', 'OK']);
  assert.equal(rows[0]!.pctText, '34%');
  assert.equal(rows[0]!.fraction, 0.34);
  assert.match(rows[0]!.resetLine, /^resets .* \(in 2h 10m\)$/);
  assert.equal(rows[2]!.blocked, true);
  assert.equal(rows[2]!.fraction, 1);
  assert.match(rows[2]!.backLine, /^Back .* \(in 2h\)$/);
  assert.equal(rows[2]!.resetLine, '');
});

test('usageBarRows: a window past its reset time counts as reset; unknown percent shows ?', () => {
  const s = snap({ windows: [{ id: 'five_hour', pct: 95, resetsAt: NOW - MIN, asOf: NOW - HOUR }, { id: 'seven_day', pct: null, asOf: NOW }] });
  const [a, b] = usageBarRows(s, NOW);
  assert.equal(a!.pctText, '0%');
  assert.equal(a!.levelText, 'New window');
  assert.equal(a!.resetLine, 'just reset');
  assert.equal(b!.pctText, '?');
  assert.equal(b!.level, 'unknown');
  assert.equal(b!.levelText, 'No reading');
  assert.deepEqual(usageBarRows(null, NOW), []);
});

test('usageBarRows clamps out-of-range percentages', () => {
  const rows = usageBarRows(snap({ windows: [{ id: 'five_hour', pct: 140, asOf: NOW }, { id: 'seven_day', pct: -5, asOf: NOW }] }), NOW);
  assert.equal(rows[0]!.fraction, 1);
  assert.equal(rows[0]!.pctText, '100%');
  assert.equal(rows[1]!.fraction, 0);
});

test('formatMoney uses the currency, defaults to USD, survives a bad code', () => {
  assert.equal(formatMoney(12.3, 'GBP'), '£12.30');
  assert.equal(formatMoney(12.3, 'gbp'), '£12.30');
  assert.equal(formatMoney(12.3, undefined), '$12.30');
  assert.equal(formatMoney(5, 'EUR'), '€5.00');
  assert.equal(formatMoney(5, 'not-a-code'), '$5.00');
});

test('extraRow', () => {
  assert.equal(extraRow(undefined), null);
  assert.equal(extraRow({ enabled: false, usedUsd: 1 }), null);
  const r = extraRow({ enabled: true, usedUsd: 12.3, limitUsd: 50, currency: 'GBP', pct: 24.6 });
  assert.ok(r);
  assert.equal(r.usedText, '£12.30');
  assert.equal(r.limitText, '£50.00');
  assert.equal(r.pctText, '25%');
  assert.equal(r.level, 'ok');
  // The percentage is worked out from the amounts when the host gave none.
  const w = extraRow({ enabled: true, usedUsd: 45, limitUsd: 50 });
  assert.equal(w?.pctText, '90%');
  assert.equal(w?.level, 'danger');
  assert.equal(w?.usedText, '$45.00');
  const n = extraRow({ enabled: true, usedUsd: 3 });
  assert.equal(n?.limitText, 'no limit set');
  assert.equal(n?.fraction, null);
});

test('refreshButtonState: checking, cooling down, ready', () => {
  assert.deepEqual(refreshButtonState('running', null, NOW), { label: 'Checking…', disabled: true, title: 'Reading your usage now' });
  const cooling = refreshButtonState('ok', NOW - 20_000, NOW);
  assert.equal(cooling.disabled, true);
  assert.equal(cooling.label, 'Refresh');
  assert.match(cooling.title, /again in 40 s/);
  assert.equal(refreshButtonState('ok', NOW - REFRESH_COOLDOWN_MS, NOW).disabled, false);
  assert.equal(refreshButtonState('ok', null, NOW).disabled, false);
  assert.equal(refreshButtonState(undefined, null, NOW).disabled, false);
  // A running probe wins over the cooldown.
  assert.equal(refreshButtonState('running', NOW, NOW).label, 'Checking…');
});

test('probeNoteFor, staleNote and nextCheckText', () => {
  assert.equal(probeNoteFor(null), 'Usage not read yet');
  assert.match(probeNoteFor(snap({ probe: 'signedOut' })), /Not signed in/);
  assert.match(probeNoteFor(snap({ probe: 'unsupported' })), /cannot report usage/);
  assert.match(probeNoteFor(snap({ probe: 'off' })), /switched off/);
  assert.match(probeNoteFor(snap({ probe: 'failed' })), /retry/);
  assert.equal(probeNoteFor(snap()), '');
  assert.equal(probeNoteFor(snap({ probe: 'running' })), '');
  assert.equal(probeNoteFor(snap({ probe: 'idle' })), 'Usage not read yet');
  assert.equal(probeNoteFor(snap({ probe: 'idle', kind: 'apiKey' })), '');
  assert.equal(staleNote(snap(), NOW), '');
  assert.match(staleNote(snap({ asOf: NOW - 30 * MIN }), NOW), /more than 15 minutes/);
  assert.equal(staleNote(null, NOW), '');
  assert.equal(staleNote(snap({ probe: 'signedOut', windows: [] }), NOW), '');
  assert.equal(nextCheckText(snap({ nextAt: NOW + 4 * MIN }), NOW), 'Next check in 4m');
  assert.equal(nextCheckText(snap({ nextAt: NOW - MIN }), NOW), '');
  assert.equal(nextCheckText(snap(), NOW), '');
});

test('costRows: most expensive first, free and unknown agents left out', () => {
  const { rows, total } = costRows([
    { id: 'a', title: 'B', costUsd: 1 }, { id: 'b', title: 'A', costUsd: 1 }, { id: 'c', title: 'C', costUsd: 3.5 },
    { id: 'd', title: 'D' }, { id: 'e', title: 'E', costUsd: 0 }, { id: 'f', title: 'F', costUsd: Number.NaN },
  ]);
  assert.deepEqual(rows.map((r) => r.agentId), ['c', 'b', 'a']);
  assert.equal(total, 5.5);
  assert.deepEqual(costRows([]), { rows: [], total: 0 });
});
