import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaseHeader, ClaudeDefaults } from '../src/shared/protocol.ts';
import {
  APPROVAL_CHOICES, DEFAULT_ID, FLASH_MS, applyError, applyReply, chipMenu, chipMode, choiceOptions, clampEffort, clampLevel, defaultEffortFor,
  defaultEffortLabel, defaultLabel, defaultModelLabel, effortPips, effortSupported, emptyTracker, errorText, findModelChoice, hasPending, headerChips,
  isOutdatedError, modelChoices, modelName, noEffortNote, optionsMessage, planHaikuNote, requestKey, supportedEfforts, trackRequest,
} from '../webview/engine/optionsLogic.ts';
import type { ChipInput, OptionsTracker } from '../webview/engine/optionsLogic.ts';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const D: ClaudeDefaults = {
  model: 'opus', effort: 'xhigh', effortByModel: { sonnet: 'high' },
  models: [
    { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', efforts: [...ALL] },
    { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-4-5', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001', efforts: [] },
    { value: 'opus[1m]', label: 'Opus (1M)', resolved: 'claude-opus-5-5[1m]' },
  ],
};

// ---------------------------------------------------------------------------
// Defaults and models

test('default label: "Default (Opus · xhigh)" from the settings, parts left out when unknown', () => {
  assert.equal(defaultLabel(D), 'Default (Opus · xhigh)');
  assert.equal(defaultLabel({ effortByModel: {}, effort: 'high' }), 'Default (high)');
  assert.equal(defaultLabel({ effortByModel: {}, model: 'claude-sonnet-4-5' }), 'Default (Sonnet 4.5)');
  assert.equal(defaultLabel({ effortByModel: {} }), 'Default');
  assert.equal(defaultLabel(null), 'Default');
  assert.equal(defaultModelLabel(D), 'Default (Opus)');
  assert.equal(defaultModelLabel(null), 'Default');
});

test('default effort: per-model setting first, then the global one, brought within what the model supports', () => {
  assert.equal(defaultEffortFor(D, ''), 'xhigh', 'default model (opus) uses the global effort');
  assert.equal(defaultEffortFor(D, 'sonnet'), 'high', 'modelSettings.sonnet.effortLevel');
  assert.equal(defaultEffortFor(D, 'claude-sonnet-4-5'), 'high', 'a full id finds the alias’s per-model setting');
  assert.equal(defaultEffortFor({ ...D, effortByModel: {} }, 'sonnet'), 'high', 'xhigh clamps down to high on Sonnet');
  assert.equal(defaultEffortFor(D, 'haiku'), undefined, 'Haiku takes no effort');
  assert.equal(defaultEffortFor(null, 'opus'), undefined);
  assert.equal(defaultEffortLabel(D, 'sonnet'), 'Default (high)');
  assert.equal(defaultEffortLabel(D, 'haiku'), 'Default');
});

test('model lookup: alias, resolved id, date suffix; unknown full ids stay unknown', () => {
  assert.equal(findModelChoice(D, 'sonnet')?.value, 'sonnet');
  assert.equal(findModelChoice(D, 'claude-haiku-4-5-20251001')?.value, 'haiku');
  assert.equal(findModelChoice(D, 'claude-haiku-4-5')?.value, 'haiku', 'date suffix ignored');
  assert.equal(findModelChoice(D, 'claude-opus-5-5[1m]')?.value, 'opus[1m]');
  assert.equal(findModelChoice(D, 'claude-opus-4-1-20250805'), undefined);
  assert.equal(findModelChoice(D, '')?.value, 'opus', 'empty = the default model');
  assert.equal(findModelChoice({ effortByModel: {}, models: [{ value: 'default', label: 'Default' }] }, null)?.value, 'default');
  assert.equal(modelName(D, 'opus[1m]'), 'Opus (1M)');
  assert.equal(modelName(D, 'claude-opus-4-1-20250805'), 'Opus 4.1');
});

test('model choices: the base four, then other models from Claude Code, hints say what the alias resolves to', () => {
  const c = modelChoices(D);
  assert.deepEqual(c.map((x) => x.value), ['', 'opus', 'sonnet', 'haiku', 'opus[1m]']);
  assert.equal(c[1]!.hint, 'Most capable · Opus 5.5');
  assert.deepEqual(modelChoices(null).map((x) => x.value), ['', 'opus', 'sonnet', 'haiku']);
  assert.equal(modelChoices({ effortByModel: {}, models: [{ value: 'default', label: 'Default (recommended)' }] }).length, 4, '"default" is not a second Default');
});

// ---------------------------------------------------------------------------
// Effort pips

test('pip support: from the model’s efforts; unknown lists mean every level', () => {
  assert.deepEqual(supportedEfforts(D, 'sonnet'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedEfforts(D, 'haiku'), []);
  assert.equal(supportedEfforts(D, 'opus[1m]'), null, 'no efforts list');
  assert.equal(supportedEfforts(D, 'claude-opus-4-1'), null, 'model not in the list');
  assert.equal(supportedEfforts(null, 'sonnet'), null);
  assert.equal(effortSupported(D, 'sonnet', 'max'), false);
  assert.equal(effortSupported(D, 'opus[1m]', 'max'), true);
  const pips = effortPips(D, 'sonnet', 'medium');
  assert.deepEqual(pips.map((p) => p.label), ['Low', 'Med', 'High', 'XHigh', 'Max']);
  assert.deepEqual(pips.map((p) => p.enabled), [true, true, true, false, false]);
  assert.deepEqual(pips.map((p) => p.checked), [false, true, false, false, false]);
  assert.deepEqual(pips.map((p) => p.fill), ['on', 'on', 'off', 'off', 'off']);
  assert.match(pips[4]!.title, /not available on Sonnet/);
  assert.ok(effortPips(null, 'x', 'max').every((p) => p.enabled), 'unknown support: all enabled');
});

test('pips with Default chosen show the default level as a ghost', () => {
  assert.deepEqual(effortPips(D, '', null).map((p) => p.fill), ['ghost', 'ghost', 'ghost', 'ghost', 'off']);
  assert.ok(effortPips(D, '', null).every((p) => !p.checked));
  assert.deepEqual(effortPips(null, '', null).map((p) => p.fill), ['off', 'off', 'off', 'off', 'off'], 'unknown default: nothing filled');
});

test('clamping: an unsupported effort moves down (else up), or back to Default when the model takes none', () => {
  assert.equal(clampLevel('max', ['low', 'medium', 'high']), 'high');
  assert.equal(clampLevel('low', ['high', 'max']), 'high');
  assert.equal(clampLevel('high', []), null);
  assert.deepEqual(clampEffort(D, 'sonnet', 'max'), { effort: 'high', note: 'Sonnet doesn’t offer Max, so effort is now High.' });
  assert.deepEqual(clampEffort(D, 'haiku', 'low'), { effort: null, note: 'Haiku doesn’t use effort levels, so effort is back to Default.' });
  assert.deepEqual(clampEffort(D, 'sonnet', 'medium'), { effort: 'medium', note: null });
  assert.deepEqual(clampEffort(D, 'opus', null), { effort: null, note: null });
  assert.deepEqual(clampEffort(null, 'sonnet', 'max'), { effort: 'max', note: null }, 'unknown support: kept');
  assert.deepEqual(clampEffort(D, '', 'max'), { effort: 'max', note: null }, 'Default model (Opus) supports Max');
  assert.equal(noEffortNote(D, 'haiku'), 'Haiku doesn’t use effort levels.');
  assert.equal(noEffortNote(D, 'sonnet'), null);
});

// ---------------------------------------------------------------------------
// Messages and the request tracker

const office: ChipInput['header'] = { control: 'office', canSetOptions: true, sessionId: 's1', model: 'claude-opus-4-1-20250805', effort: 'xhigh', permissionMode: 'plan' };
const free: ChipInput['header'] = { control: 'free', canSetOptions: true, sessionId: 's2', model: 'claude-sonnet-4-5', effort: 'medium', next: {} };
const external: ChipInput['header'] = { control: 'elsewhere', sessionId: 's3', model: 'claude-sonnet-4-5', effort: 'high' };
const input = (header: ChipInput['header'], tracker: OptionsTracker = emptyTracker(), now = 1000, extra: Partial<ChipInput> = {}): ChipInput => ({ header, defaults: D, tracker, now, ...extra });

test('message building: setSessionOptions with a nonce; menu ids map to options (Default resets with null)', () => {
  assert.deepEqual(optionsMessage('s1', { effort: 'high' }, 'n1'), { type: 'setSessionOptions', nonce: 'n1', sessionId: 's1', options: { effort: 'high' } });
  assert.deepEqual(choiceOptions('model', 'sonnet'), { model: 'sonnet' });
  assert.deepEqual(choiceOptions('model', DEFAULT_ID), { model: null });
  assert.deepEqual(choiceOptions('effort', DEFAULT_ID), { effort: null });
  assert.deepEqual(choiceOptions('effort', 'max'), { effort: 'max' });
  assert.equal(choiceOptions('effort', 'huge'), null);
  assert.deepEqual(choiceOptions('permissionMode', 'acceptEdits'), { permissionMode: 'acceptEdits' });
  assert.equal(choiceOptions('permissionMode', 'bypassPermissions'), null, 'bypass can’t be expressed');
  assert.deepEqual(APPROVAL_CHOICES.map((c) => c.value), ['default', 'acceptEdits', 'plan']);
});

test('tracker: pending, then applied (office) or deferred (free); replies for other nonces are ignored', () => {
  let t = trackRequest(emptyTracker(), optionsMessage('s1', { model: 'sonnet' }, 'n1'), 100, office);
  assert.equal(t.requests[0]!.status, 'pending');
  assert.deepEqual(t.requests[0]!.was, { model: 'claude-opus-4-1-20250805' });
  assert.equal(hasPending(t, 's1'), true);
  assert.equal(applyReply(t, { type: 'sessionOptions', nonce: 'other', sessionId: 's1', applied: {}, deferred: {} }, 200).matched, false);
  const r = applyReply(t, { type: 'sessionOptions', nonce: 'n1', sessionId: 's1', applied: { model: 'sonnet' }, deferred: {} }, 200);
  assert.equal(r.matched, true);
  t = r.tracker;
  assert.equal(t.requests[0]!.status, 'applied');
  assert.equal(t.requests[0]!.doneAt, 200);
  assert.equal(hasPending(t, 's1'), false);
  let f = trackRequest(emptyTracker(), optionsMessage('s2', { effort: 'low' }, 'n2'), 100, free);
  f = applyReply(f, { type: 'sessionOptions', nonce: 'n2', sessionId: 's2', applied: {}, deferred: { effort: 'low' } }, 300).tracker;
  assert.equal(f.requests[0]!.status, 'deferred');
});

test('errors: matched by nonce; an "update Claude Code" error marks the session outdated', () => {
  const t = trackRequest(emptyTracker(), optionsMessage('s1', { effort: 'max' }, 'n1'), 100, office);
  assert.equal(requestKey(t, 'n1'), 'effort');
  assert.equal(applyError(t, { nonce: 'zzz', message: 'x' }, 200).matched, false);
  const plain = applyError(t, { nonce: 'n1', message: 'That session has gone.' }, 200);
  assert.equal(plain.matched, true);
  assert.equal(plain.outdated, false);
  assert.equal(plain.tracker.requests[0]!.status, 'failed');
  assert.deepEqual(plain.tracker.outdated, []);
  const old = applyError(t, { nonce: 'n1', message: 'This Claude Code can’t change settings mid-session. Update Claude Code to use this.' }, 200);
  assert.equal(old.outdated, true);
  assert.deepEqual(old.tracker.outdated, ['s1']);
  assert.equal(isOutdatedError('setModel is not supported by this version'), true);
  assert.equal(isOutdatedError('Could not reach Claude Code'), false);
  assert.equal(errorText('effort', 'nope'), 'Couldn’t change the effort level: nope');
});

test('isOutdatedError matches the host "cannot change … on a running session" message', () => {
  assert.equal(isOutdatedError('This Claude Code build cannot change the model on a running session. Please update the Claude Code extension.'), true);
  assert.equal(isOutdatedError('Session not found'), false);
});

// ---------------------------------------------------------------------------
// Header chips

test('chip modes: office live, free next message, Claude Code read-only, old Claude Code outdated', () => {
  assert.equal(chipMode(office, emptyTracker()), 'live');
  assert.equal(chipMode(free, emptyTracker()), 'next');
  assert.equal(chipMode(external, emptyTracker()), 'readonly');
  assert.equal(chipMode({ ...office, canSetOptions: false }, emptyTracker()), 'readonly', 'the host says no');
  assert.equal(chipMode({ ...office, sessionId: undefined }, emptyTracker()), 'readonly');
  assert.equal(chipMode(office, { requests: [], outdated: ['s1'] }), 'outdated');
});

test('office chips: values in use, editable, "applies right away" (or next step when busy)', () => {
  const chips = headerChips(input(office));
  assert.deepEqual(chips.map((c) => [c.label, c.value, c.mode, c.editable]), [
    ['Model', 'Opus 4.1', 'live', true], ['Effort', 'XHigh', 'live', true], ['Approvals', 'Plan first', 'live', true],
  ]);
  assert.equal(chips[0]!.hint, 'A change applies right away.');
  assert.equal(headerChips(input({ ...office, busy: true }))[0]!.hint, 'A change applies from their next step.');
  assert.ok(chips.every((c) => c.next === null && c.status === null));
});

test('free chips: "next: …" from CaseHeader.next; {} means nothing stored', () => {
  assert.ok(headerChips(input(free)).every((c) => c.next === null && c.mode === 'next'));
  const chips = headerChips(input({ ...free, next: { model: 'opus', effort: null } }));
  assert.equal(chips[0]!.value, 'Sonnet 4.5');
  assert.equal(chips[0]!.next, 'next: Opus');
  assert.equal(chips[1]!.next, 'next: Default (xhigh)', 'effort reset, for the model the next turn uses (Opus)');
  assert.equal(chips[2]!.next, null);
  assert.equal(chips[0]!.hint, 'Not running now: a change applies to their next message.');
});

test('external chips: read-only with the Claude Code hint; temps say they use their boss’s settings', () => {
  const chips = headerChips(input(external));
  assert.ok(chips.every((c) => c.mode === 'readonly' && !c.editable));
  assert.equal(chips[0]!.hint, 'Running in Claude Code: use /model or /effort in Claude Code.');
  assert.match(chips[2]!.hint, /Shift\+Tab/);
  assert.equal(chips[2]!.value, '—', 'approvals unknown');
  assert.equal(headerChips(input({ ...external, control: 'none' }, emptyTracker(), 0, { isTemp: true }))[0]!.hint, 'Temps work with their boss’s settings.');
});

test('outdated chips: read-only with the update hint', () => {
  const chips = headerChips(input(office, { requests: [], outdated: ['s1'] }));
  assert.ok(chips.every((c) => c.mode === 'outdated' && !c.editable));
  assert.match(chips[0]!.hint, /Update Claude Code/);
});

test('effort chip on a model without effort levels is not editable', () => {
  const chips = headerChips(input({ ...office, model: 'claude-haiku-4-5-20251001', effort: undefined }));
  assert.equal(chips[1]!.value, 'n/a');
  assert.equal(chips[1]!.editable, false);
  assert.equal(chips[1]!.hint, 'Haiku 4.5 doesn’t use effort levels.');
});

test('chip states: pending shows the asked value, applied stays until the header moves on, failed reverts', () => {
  let t = trackRequest(emptyTracker(), optionsMessage('s1', { model: 'sonnet' }, 'n1'), 1000, office);
  let c = headerChips(input(office, t, 1100))[0]!;
  assert.deepEqual([c.value, c.status], ['Sonnet', 'pending']);
  t = applyReply(t, { type: 'sessionOptions', nonce: 'n1', sessionId: 's1', applied: { model: 'sonnet' }, deferred: {} }, 1500).tracker;
  c = headerChips(input(office, t, 1600))[0]!;
  assert.deepEqual([c.value, c.status], ['Sonnet', 'applied']);
  c = headerChips(input(office, t, 1500 + FLASH_MS + 1))[0]!;
  assert.deepEqual([c.value, c.status], ['Sonnet', null], 'the mark fades, the value stays');
  c = headerChips(input({ ...office, model: 'claude-sonnet-4-5' }, t, 9000))[0]!;
  assert.equal(c.value, 'Sonnet 4.5', 'the header caught up and wins');
  let e = trackRequest(emptyTracker(), optionsMessage('s1', { effort: 'max' }, 'n2'), 1000, office);
  e = applyError(e, { nonce: 'n2', message: 'nope' }, 1200).tracker;
  c = headerChips(input(office, e, 1300))[1]!;
  assert.deepEqual([c.value, c.status], ['XHigh', 'failed']);
});

test('free chip states: pending and deferred show as next; a newer header `next` wins', () => {
  let t = trackRequest(emptyTracker(), optionsMessage('s2', { effort: 'low' }, 'n1'), 1000, free);
  let c = headerChips(input(free, t, 1100))[1]!;
  assert.deepEqual([c.value, c.next, c.status], ['Med', 'next: Low', 'pending']);
  t = applyReply(t, { type: 'sessionOptions', nonce: 'n1', sessionId: 's2', applied: {}, deferred: { effort: 'low' } }, 1400).tracker;
  c = headerChips(input(free, t, 1500, { nextAt: 0 }))[1]!;
  assert.deepEqual([c.next, c.status], ['next: Low', 'deferred']);
  c = headerChips(input({ ...free, next: {} }, t, 9000, { nextAt: 5000 }))[1]!;
  assert.equal(c.next, null, 'the next message used it up');
});

// ---------------------------------------------------------------------------
// Menus

test('model menu: Default, the choices, and the model in use when it isn’t one of them', () => {
  const m = chipMenu('model', input(office));
  assert.equal(m.title, 'Model');
  assert.equal(m.note, 'Applies right away.');
  assert.deepEqual(m.items.map((i) => i.id), ['claude-opus-4-1-20250805', DEFAULT_ID, 'opus', 'sonnet', 'haiku', 'opus[1m]']);
  assert.equal(m.items[0]!.label, 'Opus 4.1 (current)');
  assert.deepEqual(m.items.filter((i) => i.checked).map((i) => i.id), ['claude-opus-4-1-20250805']);
  assert.equal(m.items[1]!.label, 'Default (Opus)');
  const f = chipMenu('model', input({ ...free, model: 'sonnet', next: { model: 'opus' } }));
  assert.deepEqual(f.items.filter((i) => i.checked).map((i) => i.id), ['opus'], 'the stored next value is ticked');
  assert.equal(f.note, 'Applies to their next message.');
});

test('effort menu: Default with its level, unsupported levels disabled with the reason, meters', () => {
  const m = chipMenu('effort', input({ ...free, next: { model: 'sonnet' } }));
  assert.deepEqual(m.items.map((i) => i.label), ['Default (high)', 'Low', 'Med', 'High', 'XHigh', 'Max']);
  assert.deepEqual(m.items.map((i) => i.disabled), [false, false, false, false, true, true]);
  assert.equal(m.items[5]!.detail, 'Not available on Sonnet');
  assert.deepEqual(m.items.map((i) => i.meter), [3, 1, 2, 3, 4, 5]);
  assert.deepEqual(m.items.filter((i) => i.checked).map((i) => i.id), ['medium']);
});

test('approvals menu: the three styles, the one in use ticked', () => {
  const m = chipMenu('permissionMode', input(office));
  assert.deepEqual(m.items.map((i) => [i.id, i.checked]), [['default', false], ['acceptEdits', false], ['plan', true]]);
  assert.equal(m.items[1]!.label, 'Auto-accept file edits');
});

test('Plan first on Haiku: the cost note only for the exact haiku alias and plan mode', () => {
  assert.match(planHaikuNote('haiku', 'plan')!, /Sonnet.*costs more/);
  for (const [model, mode] of [['haiku', 'default'], ['haiku', 'acceptEdits'], ['sonnet', 'plan'], ['', 'plan'], ['claude-haiku-4-5', 'plan'], [null, 'plan'], ['haiku', null]] as const) {
    assert.equal(planHaikuNote(model, mode), null, `${model}/${mode}`);
  }
  const haiku = chipMenu('permissionMode', input({ ...free, model: 'haiku' }));
  assert.match(haiku.items.find((i) => i.id === 'plan')!.detail!, /Plan first with Haiku/);
  assert.doesNotMatch(haiku.items.find((i) => i.id === 'default')!.detail ?? '', /Haiku/);
  assert.doesNotMatch(chipMenu('permissionMode', input({ ...free, model: 'sonnet' })).items.find((i) => i.id === 'plan')!.detail!, /Plan first with Haiku/);
});

test('a header without options yet (older host) reads as read-only', () => {
  const h: Pick<CaseHeader, 'control' | 'sessionId'> = { control: 'office', sessionId: 's1' };
  assert.equal(chipMode(h, emptyTracker()), 'readonly');
});
