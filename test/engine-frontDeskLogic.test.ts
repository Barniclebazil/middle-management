import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_MAX_BYTES, LOOK_FIELDS, SIGN_MIN_CONTRAST, SLOT_IDS, bannerOf, canClose, clearField, contrastRatio, draftChanged, draftErrors, draftFrom, dropReport,
  editorReduce, editorStep, inheritedLook, inheritedText, initialEditorState, isFieldPath, parseSlotId, previewTheme, resetColors, resetLook, restoreDraft,
  saveAction, saveChoices, saveMessage, serializeDraft, setField, settingsView, signReadability, signReadabilityDetail, slotList, sourceKey, toTheme,
  toThemeJson, validateSettingInput,
} from '../webview/engine/frontDeskLogic.ts';
import type { Draft, EditorEvent, EditorState } from '../webview/engine/frontDeskLogic.ts';
import { FRONT_DESK_SETTINGS, LIMITS } from '../src/shared/protocol.ts';
import { serializeTheme } from '../src/host/themeWriter.ts';
import type { FrontDeskSetting, FrontDeskSettingKey, FrontDeskSource, FrontDeskState } from '../src/shared/protocol.ts';
import { FURNITURE_COLOR_KEYS, LINE_POOL_KEYS, LINE_POOL_KIND, NPC_KEYS, OFFICE_COLOR_KEYS, TITLE_KEYS, parseTheme } from '../src/shared/theme.ts';
import type { LookSpec, OfficeTheme } from '../src/shared/theme.ts';

const json = (d: Draft): unknown => {
  const r = toThemeJson(d);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return JSON.parse(r.json);
};

// ---------------------------------------------------------------------------------------------------------------------
// Draft operations

test('draftFrom deep copies and treats null as the built-in office', () => {
  const host: OfficeTheme = { company: 'Acme', staff: [{ name: 'A', look: { hair: '#112233' } }] };
  const d = draftFrom(host);
  assert.deepEqual(d, host);
  d.staff![0]!.look!.hair = '#ffffff';
  assert.equal(host.staff![0]!.look!.hair, '#112233');
  assert.deepEqual(draftFrom(null), {});
  assert.deepEqual(draftFrom(undefined), {});
});

test('setField is immutable', () => {
  const d0 = draftFrom({ company: 'Acme', staff: [{ name: 'A' }], colors: { wall: '#ffffff' } });
  const frozen = JSON.stringify(d0);
  const d1 = setField(d0, 'staff-0.name', 'B');
  const d2 = setField(d1, 'colors.wall', '#000000');
  const d3 = setField(d2, 'company', 'Beta');
  assert.equal(JSON.stringify(d0), frozen);
  assert.equal(d1.staff![0]!.name, 'B');
  assert.equal(d2.colors!.wall, '#000000');
  assert.equal(d3.company, 'Beta');
  assert.notEqual(d1.staff, d0.staff);
});

test('person fields: name, role, lines, pin and look on staff', () => {
  let d: Draft = {};
  d = setField(d, 'staff-0.name', 'Odette');
  d = setField(d, 'staff-0.role', 'Receptionist');
  d = setField(d, 'staff-0.lines', ['Hi', 'Bye']);
  d = setField(d, 'staff-0.pin.project', 'office');
  d = setField(d, 'staff-0.pin.title', 'bug');
  d = setField(d, 'staff-0.look.head', 'cat');
  d = setField(d, 'staff-0.look.skirt', true);
  d = setField(d, 'staff-0.look.hair', '#AABBCC');
  assert.deepEqual(d.staff, [{ name: 'Odette', role: 'Receptionist', lines: ['Hi', 'Bye'], pin: { project: 'office', title: 'bug' }, look: { head: 'cat', skirt: true, hair: '#aabbcc' } }]);
  d = setField(d, 'staff-0.pin', { project: 'x' });
  assert.deepEqual(d.staff![0]!.pin, { project: 'x' });
  assert.ok(draftErrors(d).length === 0);
});

test('manager and receptionist fields, and cleaning up when emptied', () => {
  let d: Draft = {};
  d = setField(d, 'manager.name', 'Alex Mercer');
  d = setField(d, 'manager.lines', ['That is what she said']);
  d = setField(d, 'receptionist.look.outfit', 'blouse');
  assert.deepEqual(d.manager, { name: 'Alex Mercer', lines: ['That is what she said'] });
  assert.deepEqual(d.receptionist, { look: { outfit: 'blouse' } });
  d = clearField(d, 'receptionist.look.outfit');
  assert.equal('receptionist' in d, false);
  d = clearField(clearField(d, 'manager.name'), 'manager.lines');
  assert.equal('manager' in d, false);
  // the manager has no role and no pin; temps have no role, lines or pin
  assert.equal(setField(d, 'manager.role', 'x'), d);
  assert.equal(setField(d, 'manager.pin.project', 'x'), d);
  assert.equal(setField(d, 'temp-0.role', 'x'), d);
  assert.equal(setField(d, 'temp-0.lines', ['x']), d);
});

test('company, branch, smallTalk and colours', () => {
  let d: Draft = {};
  d = setField(d, 'company', 'Pennywhistle');
  d = setField(d, 'branch', 'Harbour');
  d = setField(d, 'smallTalk', [['a', 'b'], ['c', 'd']]);
  d = setField(d, 'colors.wall', '#ABCDEF');
  d = setField(d, 'colors.signText', '#ffffff');
  assert.deepEqual(d, { company: 'Pennywhistle', branch: 'Harbour', smallTalk: [['a', 'b'], ['c', 'd']], colors: { wall: '#abcdef', signText: '#ffffff' } });
  d = setField(d, 'company', '');
  d = clearField(d, 'branch');
  d = setField(d, 'smallTalk', null);
  d = clearField(d, 'colors.wall');
  d = clearField(d, 'colors.signText');
  assert.deepEqual(d, {});
});

test('setField ignores unknown paths, bad slots, wrong value types and prototype names', () => {
  const d: Draft = { company: 'x' };
  for (const path of ['', 'nope', 'staff-8.name', 'temp-6.name', 'staff-0', 'staff-0.nope', 'staff-0.look', 'staff-0.look.nope', 'staff-0.look.__proto__', 'colors.nope', 'colors', 'sign.name', '__proto__.x', 'constructor.name', 'staff-01.name', 'staff--1.name']) {
    assert.equal(setField(d, path, 'v'), d, path);
    assert.equal(isFieldPath(path), false, path);
  }
  assert.equal(setField(d, 'staff-0.name', 5 as unknown as string), d);
  assert.equal(setField(d, 'staff-0.look.skirt', 'yes'), d);
  assert.equal(setField(d, 'staff-0.look.hair', true), d);
  assert.equal(setField(d, 'staff-0.lines', 'one line' as unknown as string[]), d);
  assert.equal(setField(d, 'staff-0.lines', [1] as unknown as string[]), d);
  assert.equal(setField(d, 'smallTalk', [['a']] as unknown as [string, string][]), d);
  assert.equal(({} as Record<string, unknown>).name, undefined);
  assert.ok(isFieldPath('staff-7.look.beltColor') && isFieldPath('temp-5.name') && isFieldPath('colors.rugBorder') && isFieldPath('staff-3.pin.title'));
});

test('every look field can be set and the result parses', () => {
  let d: Draft = {};
  for (const f of LOOK_FIELDS) {
    const v = f.kind === 'boolean' ? true : f.kind === 'colour' ? '#123456' : f.options![0]!;
    d = setField(d, `staff-1.look.${f.key}`, v);
    d = setField(d, `temp-0.look.${f.key}`, v);
    d = setField(d, `manager.look.${f.key}`, v);
  }
  assert.deepEqual(draftErrors(d), []);
  assert.equal(Object.keys(d.staff![1]!.look!).length, LOOK_FIELDS.length);
  assert.equal(LOOK_FIELDS.length, 24);
});

test('placeholder filling: editing staff 4 only gives four {} placeholders, clearing it gives none', () => {
  let d: Draft = {};
  d = setField(d, 'staff-4.name', 'Kevin');
  assert.deepEqual(d.staff, [{}, {}, {}, {}, { name: 'Kevin' }]);
  assert.deepEqual((json(d) as OfficeTheme).staff, [{}, {}, {}, {}, { name: 'Kevin' }]);
  d = clearField(d, 'staff-4.name');
  assert.deepEqual(d.staff, [{}, {}, {}, {}, {}]);
  assert.deepEqual(toTheme(d).staff, undefined);
  assert.equal((json(d) as OfficeTheme).staff, undefined);
  // the draft's trailing placeholders trim to an empty list
  assert.deepEqual(toTheme({ staff: d.staff }).staff, undefined);
  // temps fill the same way
  const t = setField({}, 'temp-2.name', 'Intern');
  assert.deepEqual(t.temps, [{}, {}, { name: 'Intern' }]);
  // clearing something in a slot that is not there does not create placeholders
  assert.deepEqual(clearField({}, 'staff-3.name'), {});
});

test('a middle placeholder is kept and a later one still trims', () => {
  let d: Draft = {};
  d = setField(d, 'staff-2.name', 'C');
  d = setField(d, 'staff-0.name', 'A');
  d = setField(d, 'staff-5.name', 'F');
  d = clearField(d, 'staff-5.name');
  assert.deepEqual((json(d) as OfficeTheme).staff, [{ name: 'A' }, {}, { name: 'C' }]);
});

test('clearing the last field of a look or pin removes the empty object', () => {
  let d = setField(setField({}, 'staff-0.look.hair', '#111111'), 'staff-0.pin.title', 't');
  d = clearField(clearField(d, 'staff-0.look.hair'), 'staff-0.pin.title');
  assert.deepEqual(d.staff, [{}]);
});

test('resetLook removes only the look; resetColors removes all colours', () => {
  let d = draftFrom({
    manager: { name: 'M', look: { head: 'boss' } },
    receptionist: { look: { skin: 'deep' } },
    colors: { wall: '#ffffff', trim: '#000000' },
    staff: [{ name: 'A', look: { hair: '#111111' }, lines: ['x'] }, { look: { head: 'cat' } }],
    temps: [{ name: 'T', look: { shirt: '#222222' } }],
  });
  const before = JSON.stringify(d);
  const a = resetLook(d, 'staff-0');
  assert.deepEqual(a.staff, [{ name: 'A', lines: ['x'] }, { look: { head: 'cat' } }]);
  assert.deepEqual(resetLook(d, 'staff-1').staff, [d.staff![0], {}]);
  assert.deepEqual(resetLook(d, 'temp-0').temps, [{ name: 'T' }]);
  assert.deepEqual(resetLook(d, 'manager').manager, { name: 'M' });
  assert.equal('receptionist' in resetLook(d, 'receptionist'), false);
  assert.equal(resetLook(d, 'staff-6'), d);
  assert.equal(resetLook(d, 'sign'), d);
  assert.equal(resetLook(d, 'staff-9'), d);
  assert.equal(resetLook(a, 'staff-0'), a);
  assert.equal(JSON.stringify(d), before);
  const c = resetColors(d);
  assert.equal('colors' in c, false);
  assert.equal(c.company, undefined);
  assert.equal(resetColors(c), c);
  assert.equal(JSON.stringify(d), before);
});

test('toThemeJson trims, drops blanks, and stays a valid theme', () => {
  const d: Draft = {
    company: '  Acme  ', branch: '   ',
    manager: { name: ' Boss ', lines: ['  hi  ', '', '   '] },
    staff: [{ name: '', role: ' R ', lines: [], look: {} }, {}],
    smallTalk: [['  a ', ' b '], ['', '']],
  };
  const out = json(d) as OfficeTheme;
  assert.deepEqual(out, { company: 'Acme', manager: { name: 'Boss', lines: ['hi'] }, smallTalk: [['a', 'b']], staff: [{ role: 'R' }] });
  const r = toThemeJson(d);
  assert.ok(r.ok && r.json.endsWith('}\n'));
  assert.deepEqual(parseTheme(JSON.parse((r as { json: string }).json)).errors, []);
  assert.equal(toThemeJson({}).ok, true);
  assert.equal((toThemeJson({}) as { json: string }).json, '{}\n');
});

test('toThemeJson reports invalid values instead of producing a file the host would refuse', () => {
  const d = setField(setField({}, 'staff-0.look.hair', 'red'), 'colors.wall', '#12345');
  const r = toThemeJson(d);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors.length, 2);
    assert.match(r.error, /and 1 more/);
    assert.ok(r.errors.some((e) => e.startsWith('staff[0].look.hair')));
  }
  assert.deepEqual(draftErrors(setField({}, 'staff-0.name', 'x'.repeat(41))).length, 1);
  // half a small-talk pair is an error, not silently dropped
  assert.equal(toThemeJson(setField({}, 'smallTalk', [['only one side', '']])).ok, false);
  // an unknown enum value is reported
  assert.equal(toThemeJson(setField({}, 'staff-0.look.head', 'afro')).ok, false);
  // previewTheme leaves invalid values out so the office never shows half valid art
  const p = previewTheme(setField(setField({}, 'staff-0.look.hair', 'red'), 'staff-0.name', 'Ok'));
  assert.deepEqual(p.staff, [{ name: 'Ok', look: {} }]);
});

test('toThemeJson refuses text that reaches the size cap', () => {
  const line = 'x'.repeat(80);
  let d: Draft = {};
  for (let i = 0; i < 8; i++) d = setField(d, `staff-${i}.lines`, Array.from({ length: 60 }, () => line));
  const r = toThemeJson(d);
  assert.ok(r.ok);
  const len = r.ok ? r.json.length : 0;
  assert.ok(len > 30000 && len < LIMITS.themeJsonChars, 'the biggest valid theme stays well under the real cap');
  assert.equal(toThemeJson(d, len + 1).ok, true);
  const over = toThemeJson(d, len);
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.match(over.error, /too big/);
    assert.deepEqual(over.errors, []);
  }
  assert.equal(LIMITS.themeJsonChars, 524288);
});

test('draftChanged compares canonical forms', () => {
  const host: OfficeTheme = { company: 'Acme', staff: [{ name: 'A' }] };
  assert.equal(draftChanged(draftFrom(host), host), false);
  assert.equal(draftChanged(draftFrom(null), null), false);
  assert.equal(draftChanged(setField(draftFrom(host), 'staff-3.name', 'x'), host), true);
  // placeholders and empties do not count
  assert.equal(draftChanged(clearField(setField(draftFrom(host), 'staff-3.name', 'x'), 'staff-3.name'), host), false);
  assert.equal(draftChanged({ ...draftFrom(host), colors: {} }, host), false);
  assert.equal(draftChanged({ company: ' Acme ', staff: [{ name: 'A' }] }, host), false);
  assert.equal(draftChanged(draftFrom(host), null), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Slots

test('parseSlotId and SLOT_IDS', () => {
  assert.equal(SLOT_IDS.length, 3 + 8 + 6);
  assert.deepEqual(SLOT_IDS.slice(0, 4), ['sign', 'manager', 'receptionist', 'staff-0']);
  assert.deepEqual(parseSlotId('staff-7'), { group: 'staff', index: 7 });
  assert.deepEqual(parseSlotId('temp-5'), { group: 'temp', index: 5 });
  assert.deepEqual(parseSlotId('sign'), { group: 'sign' });
  for (const bad of ['staff-8', 'temp-6', 'staff', 'staff-', 'x', '', 'Staff-1', 'staff-1 ']) assert.equal(parseSlotId(bad), null, bad);
});

test('slotList: order, labels, names and customised', () => {
  const d = draftFrom({
    company: 'Pennywhistle Paper',
    manager: { name: 'Alex Mercer' },
    staff: [{}, {}, { role: 'Techie' }, {}, { name: 'Kevin', look: { head: 'chili' } }],
    temps: [{}, { look: { shirt: '#123456' } }],
  });
  const list = slotList(d, null);
  assert.equal(list.length, 17);
  assert.deepEqual(list.map((s) => s.id), SLOT_IDS);
  assert.deepEqual(list.slice(0, 3).map((s) => s.label), ['Office sign', 'Manager', 'Receptionist']);
  assert.deepEqual(list.slice(0, 3).map((s) => s.name), ['Pennywhistle Paper', 'Alex Mercer', 'Receptionist']);
  assert.deepEqual(list.slice(0, 3).map((s) => s.customised), [true, true, false]);
  const staff = list.slice(3, 11);
  assert.equal(staff[0]!.label, 'Staff 1 · Deputy Vice Associate desk');
  assert.equal(staff[2]!.label, 'Staff 3 · IT Help Desk desk');
  assert.equal(staff[7]!.label, 'Staff 8 · HR Representative desk');
  assert.equal(staff[2]!.name, 'Techie'); // the theme's role when there is no name
  assert.equal(staff[2]!.named, true);
  assert.equal(staff[3]!.name, 'Accountant (crosswords)'); // built-in role
  assert.equal(staff[3]!.named, false);
  assert.equal(staff[4]!.name, 'Kevin');
  assert.deepEqual(staff.map((s) => s.customised), [false, false, true, false, true, false, false, false]);
  const temps = list.slice(11);
  assert.deepEqual(temps.map((s) => s.label), ['Temp 1', 'Temp 2', 'Temp 3', 'Temp 4', 'Temp 5', 'Temp 6']);
  assert.deepEqual(temps.map((s) => s.name), Array(6).fill('Temp'));
  assert.deepEqual(temps.map((s) => s.customised), [false, true, false, false, false, false]);
  assert.equal(staff[4]!.index, 4);
  assert.equal(list[0]!.index, undefined);
});

test('slotList marks changed slots against the host theme and accepts injected wording', () => {
  const host: OfficeTheme = { staff: [{ name: 'A' }, { name: 'B' }] };
  let d = draftFrom(host);
  assert.equal(slotList(d, host).some((s) => s.changed), false);
  d = setField(d, 'staff-1.name', 'Bee');
  d = setField(d, 'temp-0.name', 'Tom');
  const changed = slotList(d, host).filter((s) => s.changed).map((s) => s.id);
  assert.deepEqual(changed, ['staff-1', 'temp-0']);
  const injected = slotList({}, null, { role: (id) => `R:${id}`, desk: (i) => `D${i}` });
  assert.equal(injected[3]!.label, 'Staff 1 · D0 desk');
  assert.equal(injected[3]!.name, 'R:staff-0');
  assert.equal(injected[1]!.name, 'R:manager');
});

// ---------------------------------------------------------------------------------------------------------------------
// Inherited view

const builtin = (id: string): LookSpec => (id === 'staff-2' ? { head: 'headset', outfit: 'polo', shirt: '#3d6fa5', skirt: false } : id === 'manager' ? { head: 'boss', hair: '#3a2a24' } : {});

test('inheritedLook marks fields the draft sets and fills the rest from the built-in look', () => {
  const d = draftFrom({ staff: [{}, {}, { look: { shirt: '#ff0000', belt: true } }] });
  const rows = inheritedLook('staff-2', d, builtin);
  assert.equal(rows.length, LOOK_FIELDS.length);
  assert.deepEqual(rows.map((r) => r.field), LOOK_FIELDS.map((f) => f.key));
  const by = (f: string) => rows.find((r) => r.field === f)!;
  assert.deepEqual([by('shirt').value, by('shirt').inherited], ['#ff0000', false]);
  assert.deepEqual([by('belt').value, by('belt').inherited], [true, false]);
  assert.deepEqual([by('head').value, by('head').inherited], ['headset', true]);
  assert.deepEqual([by('skirt').value, by('skirt').inherited], [false, true]);
  assert.deepEqual([by('eye').value, by('eye').inherited], [undefined, true]);
  assert.equal(by('head').kind, 'enum');
  assert.deepEqual(by('head').options, LOOK_FIELDS[0]!.options);
  assert.equal(by('hair').kind, 'colour');
  assert.equal(by('belt').kind, 'boolean');
});

test('inheritedLook handles every slot kind, the sign and bad ids', () => {
  const d = draftFrom({ manager: { look: { head: 'short' } } });
  assert.equal(inheritedLook('manager', d, builtin).find((r) => r.field === 'head')!.value, 'short');
  assert.equal(inheritedLook('manager', d, builtin).find((r) => r.field === 'hair')!.value, '#3a2a24');
  assert.equal(inheritedLook('temp-3', d, builtin).every((r) => r.inherited), true);
  assert.deepEqual(inheritedLook('sign', d, builtin), []);
  assert.deepEqual(inheritedLook('staff-9', d, builtin), []);
  // the injected function gets the slot id
  const seen: string[] = [];
  inheritedLook('temp-1', {}, (id) => (seen.push(id), {}));
  assert.deepEqual(seen, ['temp-1']);
});

test('inheritedText for name and role', () => {
  const d = draftFrom({ manager: { name: 'Mike' }, staff: [{ role: 'Boss of bosses' }] });
  assert.deepEqual(inheritedText('manager', 'name', d), { value: 'Mike', inherited: false });
  assert.deepEqual(inheritedText('receptionist', 'name', d), { value: 'Receptionist', inherited: true });
  assert.deepEqual(inheritedText('staff-0', 'role', d), { value: 'Boss of bosses', inherited: false });
  assert.deepEqual(inheritedText('staff-2', 'role', d), { value: 'IT Help Desk', inherited: true });
  assert.deepEqual(inheritedText('staff-2', 'name', d), { value: '', inherited: true });
  assert.deepEqual(inheritedText('manager', 'name', {}, { role: () => 'x', name: () => 'Injected' }), { value: 'Injected', inherited: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// State machine

const file = (over: Partial<FrontDeskSource> = {}): FrontDeskSource => ({ kind: 'file', label: 'office.json', path: '~/office.json', fromWorkspace: false, exists: true, editable: true, rev: 'aaaaaaaaaaaaaaaa', errors: [], usingLastGood: false, ...over });

const run = (start: EditorState, ...evs: EditorEvent[]): EditorState => evs.reduce(editorReduce, start);
const S0 = initialEditorState('r1');

test('initial state', () => {
  assert.deepEqual(S0, { status: 'clean', keepMine: false, editedWhileSaving: false, rev: 'r1', hostRev: 'r1' });
  assert.equal(initialEditorState().rev, undefined);
  assert.equal(canClose(S0), true);
});

test('clean to dirty on edit; discard goes back with an adopt effect', () => {
  const dirty = run(S0, { type: 'edit' });
  assert.equal(dirty.status, 'dirty');
  assert.equal(canClose(dirty), false);
  const edited = run(dirty, { type: 'edit' });
  assert.equal(edited.status, 'dirty');
  const step = editorStep(dirty, { type: 'discard' });
  assert.equal(step.state.status, 'clean');
  assert.equal(step.effect, 'adopt');
  assert.equal(step.state.rev, 'r1');
  assert.equal(editorStep(S0, { type: 'discard' }).effect, undefined);
});

test('an edit that makes the draft equal the host again goes back to clean', () => {
  const dirty = run(S0, { type: 'edit' });
  assert.equal(run(dirty, { type: 'edit', matchesHost: true }).status, 'clean');
  assert.equal(run(dirty, { type: 'edit', matchesHost: false }).status, 'dirty');
  // not while the file changed on disk, or after Keep mine
  const stale = run(dirty, { type: 'hostTheme', rev: 'r2' });
  assert.equal(run(stale, { type: 'edit', matchesHost: true }).status, 'dirty');
});

test('save succeeds: dirty to saving to clean at the new revision', () => {
  const saving = run(S0, { type: 'edit' }, { type: 'saveRequested' });
  assert.equal(saving.status, 'saving');
  assert.equal(saving.saving, 'save');
  assert.equal(canClose(saving), false);
  // the host pushes the new state before frontDeskDone
  const pushed = run(saving, { type: 'hostTheme', rev: 'r2' });
  assert.equal(pushed.status, 'saving');
  assert.equal(editorStep(saving, { type: 'hostTheme', rev: 'r2' }).effect, undefined);
  const done = editorStep(pushed, { type: 'done', ok: true });
  assert.equal(done.state.status, 'clean');
  assert.equal(done.state.rev, 'r2');
  assert.equal(done.state.hostRev, 'r2');
  assert.equal(done.state.saving, undefined);
  assert.equal(canClose(done.state), true);
});

test('an edit while saving keeps the draft dirty after the save', () => {
  const s = run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'edit' }, { type: 'hostTheme', rev: 'r2' }, { type: 'done', ok: true });
  assert.equal(s.status, 'dirty');
  assert.equal(s.rev, 'r2');
  assert.equal(s.editedWhileSaving, false);
});

test('save cancelled (Save as dialog dismissed) returns to dirty', () => {
  const s = run(S0, { type: 'edit' }, { type: 'saveRequested', choice: 'saveAs' }, { type: 'done', ok: true, cancelled: true });
  assert.equal(s.status, 'dirty');
  assert.equal(s.message, undefined);
  assert.equal(s.saving, undefined);
});

test('save fails: error with a message, edits kept, dismissable, retry allowed', () => {
  const err = run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'done', ok: false, message: 'Disk full' });
  assert.equal(err.status, 'error');
  assert.equal(err.message, 'Disk full');
  assert.equal(canClose(err), false);
  assert.equal(run(err, { type: 'dismissError' }).status, 'dirty');
  assert.equal(run(err, { type: 'dismissError' }).message, undefined);
  assert.equal(run(err, { type: 'edit' }).status, 'dirty');
  assert.equal(run(err, { type: 'saveRequested' }).status, 'saving');
  assert.equal(run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'done', ok: false }).message, 'Could not save.');
  assert.equal(run(err, { type: 'discard' }).status, 'clean');
  assert.equal(run(S0, { type: 'dismissError' }), S0);
});

test('host theme change: clean adopts, dirty shows the changed-on-disk banner', () => {
  const step = editorStep(S0, { type: 'hostTheme', rev: 'r2' });
  assert.equal(step.state.status, 'clean');
  assert.equal(step.state.rev, 'r2');
  assert.equal(step.effect, 'adopt');
  // the same rev again is nothing
  assert.deepEqual(editorStep(S0, { type: 'hostTheme', rev: 'r1' }), { state: S0 });
  const dirty = run(S0, { type: 'edit' });
  const banner = editorStep(dirty, { type: 'hostTheme', rev: 'r2' });
  assert.equal(banner.effect, undefined);
  assert.equal(banner.state.status, 'dirty');
  assert.equal(banner.state.rev, 'r1');
  assert.equal(banner.state.hostRev, 'r2');
  assert.equal(bannerOf(banner.state), 'changedOnDisk');
  assert.equal(bannerOf(dirty), 'none');
  assert.equal(bannerOf(S0), 'none');
});

test('Load it drops the draft and adopts the host theme', () => {
  const stale = run(S0, { type: 'edit' }, { type: 'hostTheme', rev: 'r2' });
  const step = editorStep(stale, { type: 'loadIt' });
  assert.equal(step.state.status, 'clean');
  assert.equal(step.state.rev, 'r2');
  assert.equal(step.effect, 'adopt');
  assert.equal(bannerOf(step.state), 'none');
  assert.equal(editorStep(S0, { type: 'loadIt' }).effect, undefined);
});

test('conflict then Keep mine then Overwrite anyway (force save)', () => {
  const src = file();
  let s = run(S0, { type: 'edit' }, { type: 'saveRequested' });
  // host: frontDesk with the file's current rev, then frontDeskDone conflict
  s = run(s, { type: 'hostTheme', rev: 'r9' }, { type: 'done', ok: false, conflict: true });
  assert.equal(s.status, 'conflict');
  assert.equal(bannerOf(s), 'conflict');
  assert.equal(canClose(s), false);
  // Save is not offered until the user picks Load it or Keep mine
  assert.equal(run(s, { type: 'saveRequested' }).status, 'conflict');
  assert.equal(run(s, { type: 'edit' }).status, 'conflict');
  s = run(s, { type: 'keepMine' });
  assert.equal(s.status, 'dirty');
  assert.equal(s.keepMine, true);
  assert.equal(s.rev, 'r9');
  assert.equal(bannerOf(s), 'overwrite');
  assert.deepEqual(saveChoices(s, src), ['overwrite', 'saveAs']);
  assert.equal(saveAction(s, src), 'save');
  s = run(s, { type: 'saveRequested', choice: 'overwrite' });
  assert.equal(s.status, 'saving');
  assert.equal(s.saving, 'overwrite');
  assert.deepEqual(saveMessage(s, 'overwrite', 'q1', '{}\n'), { type: 'saveTheme', reqId: 'q1', rev: 'r9', themeJson: '{}\n', force: true });
  s = run(s, { type: 'hostTheme', rev: 'r10' }, { type: 'done', ok: true });
  assert.equal(s.status, 'clean');
  assert.equal(s.rev, 'r10');
  assert.equal(s.keepMine, false);
});

test('conflict then Load it', () => {
  const s = run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'hostTheme', rev: 'r9' }, { type: 'done', ok: false, conflict: true });
  const step = editorStep(s, { type: 'loadIt' });
  assert.equal(step.state.status, 'clean');
  assert.equal(step.state.rev, 'r9');
  assert.equal(step.effect, 'adopt');
  assert.equal(canClose(step.state), true);
});

test('conflict then Save as after Keep mine', () => {
  let s = run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'hostTheme', rev: 'r9' }, { type: 'done', ok: false, conflict: true }, { type: 'keepMine' });
  s = run(s, { type: 'saveRequested', choice: 'saveAs' });
  assert.equal(s.saving, 'saveAs');
  assert.deepEqual(saveMessage(s, 'saveAs', 'q2', '{}\n'), { type: 'saveThemeAs', reqId: 'q2', themeJson: '{}\n' });
  // the host switches source: the draft goes, and the late done is ignored
  const sw = editorStep(s, { type: 'sourceChanged', rev: 'n1' });
  assert.equal(sw.state.status, 'clean');
  assert.equal(sw.effect, 'adopt');
  assert.equal(run(sw.state, { type: 'done', ok: true }).status, 'clean');
});

test('Keep mine from the changed-on-disk banner; a newer change withdraws it', () => {
  let s = run(S0, { type: 'edit' }, { type: 'hostTheme', rev: 'r2' }, { type: 'keepMine' });
  assert.equal(s.keepMine, true);
  assert.equal(s.rev, 'r2');
  assert.equal(s.status, 'dirty');
  s = run(s, { type: 'hostTheme', rev: 'r3' });
  assert.equal(s.keepMine, false);
  assert.equal(bannerOf(s), 'changedOnDisk');
  // Keep mine is ignored when there is nothing to keep it against
  const plain = run(S0, { type: 'edit' });
  assert.equal(run(plain, { type: 'keepMine' }), plain);
  assert.equal(run(S0, { type: 'keepMine' }), S0);
});

test('a failed overwrite keeps Keep mine; a conflict during a forced save asks again', () => {
  let s = run(S0, { type: 'edit' }, { type: 'hostTheme', rev: 'r2' }, { type: 'keepMine' }, { type: 'saveRequested' });
  assert.equal(s.saving, 'overwrite'); // a plain save request after Keep mine means overwrite
  s = run(s, { type: 'done', ok: false, message: 'EACCES' });
  assert.equal(s.status, 'error');
  assert.equal(s.keepMine, true);
  assert.equal(bannerOf(s), 'overwrite');
  s = run(s, { type: 'saveRequested', choice: 'overwrite' }, { type: 'hostTheme', rev: 'r3' }, { type: 'done', ok: false, conflict: true });
  assert.equal(s.status, 'conflict');
  assert.equal(s.keepMine, false);
});

test('source change drops the draft from any state', () => {
  for (const s of [run(S0, { type: 'edit' }), run(S0, { type: 'edit' }, { type: 'saveRequested' }), run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'done', ok: false, conflict: true }), run(S0, { type: 'edit' }, { type: 'saveRequested' }, { type: 'done', ok: false, message: 'x' })]) {
    const step = editorStep(s, { type: 'sourceChanged', rev: 'z' });
    assert.equal(step.state.status, 'clean');
    assert.equal(step.state.rev, 'z');
    assert.equal(step.state.hostRev, 'z');
    assert.equal(step.effect, 'adopt');
  }
  const noRev = editorStep(run(S0, { type: 'edit' }), { type: 'sourceChanged' });
  assert.equal(noRev.state.rev, undefined);
});

test('events that make no sense are ignored', () => {
  assert.equal(run(S0, { type: 'saveRequested' }), S0);
  assert.equal(run(S0, { type: 'done', ok: true }), S0);
  assert.equal(run(S0, { type: 'done', ok: false, conflict: true }), S0);
  const saving = run(S0, { type: 'edit' }, { type: 'saveRequested' });
  assert.equal(run(saving, { type: 'saveRequested' }), saving);
  assert.equal(run(saving, { type: 'discard' }), saving);
  assert.equal(run(saving, { type: 'loadIt' }), saving);
});

test('the reducer never mutates its input', () => {
  const dirty = run(S0, { type: 'edit' });
  const snap = JSON.stringify(dirty);
  for (const ev of [{ type: 'edit' }, { type: 'discard' }, { type: 'saveRequested' }, { type: 'hostTheme', rev: 'q' }, { type: 'sourceChanged' }, { type: 'keepMine' }] as EditorEvent[]) editorReduce(dirty, ev);
  assert.equal(JSON.stringify(dirty), snap);
});

test('saveAction: save on a writable file, Save as on built-in, preset or any read-only source', () => {
  const st = run(S0, { type: 'edit' });
  assert.equal(saveAction(st, file()), 'save');
  assert.equal(saveAction(st, { ...file(), kind: 'builtin', label: 'Built-in office', editable: false, readOnly: 'builtin' }), 'saveAs');
  assert.equal(saveAction(st, { ...file(), kind: 'preset', presetId: 'p', label: 'Example office', editable: false, readOnly: 'preset' }), 'saveAs');
  assert.equal(saveAction(st, file({ editable: false, readOnly: 'workspace', fromWorkspace: true })), 'saveAs');
  assert.equal(saveAction(st, file({ editable: false, readOnly: 'notJson' })), 'saveAs');
  assert.equal(saveAction(st, file({ editable: false, readOnly: 'missing', exists: false })), 'saveAs');
  assert.equal(saveAction(st, file({ editable: false })), 'saveAs');
  assert.deepEqual(saveChoices(st, file()), ['save']);
  assert.deepEqual(saveChoices(st, file({ readOnly: 'preset', editable: false })), ['saveAs']);
  // Keep mine on a read-only source still only offers Save as
  assert.deepEqual(saveChoices({ ...st, keepMine: true }, file({ readOnly: 'builtin', editable: false })), ['saveAs']);
});

test('saveMessage builds the right host messages', () => {
  const st = run(S0, { type: 'edit' });
  assert.deepEqual(saveMessage(st, 'save', 'r', 'J'), { type: 'saveTheme', reqId: 'r', rev: 'r1', themeJson: 'J' });
  assert.equal('force' in saveMessage(st, 'save', 'r', 'J')!, false);
  assert.deepEqual(saveMessage(st, 'saveAs', 'r', 'J'), { type: 'saveThemeAs', reqId: 'r', themeJson: 'J' });
  assert.equal(saveMessage(initialEditorState(), 'save', 'r', 'J'), null);
  assert.equal(saveMessage(initialEditorState(), 'overwrite', 'r', 'J'), null);
  assert.equal(saveMessage(initialEditorState(), 'saveAs', 'r', 'J')!.type, 'saveThemeAs');
});

test('sourceKey tells sources apart', () => {
  const key = sourceKey(file());
  assert.notEqual(key, sourceKey(file({ path: '~/other.json' })));
  assert.notEqual(key, sourceKey({ ...file(), kind: 'builtin' }));
  assert.notEqual(sourceKey({ ...file(), kind: 'preset', presetId: 'a' }), sourceKey({ ...file(), kind: 'preset', presetId: 'b' }));
  // a changed rev is not a different source
  assert.equal(key, sourceKey(file({ rev: 'ffffffffffffffff' })));
});

// ---------------------------------------------------------------------------------------------------------------------
// dropReport

test('dropReport: nothing for a missing file or a clean canonical file', () => {
  assert.deepEqual(dropReport(null, {}), []);
  const canonical = JSON.stringify({ company: 'A', staff: [{ name: 'x' }] }, null, 2) + '\n';
  assert.deepEqual(dropReport(canonical, draftFrom(JSON.parse(canonical))), []);
  // $schema is kept by the host
  const withSchema = JSON.stringify({ $schema: './theme.schema.json', company: 'A' }, null, 2) + '\n';
  assert.deepEqual(dropReport(withSchema, { company: 'A' }), []);
});

test('dropReport lists unknown keys at every level', () => {
  const raw = JSON.stringify({
    company: 'A', mood: 'happy',
    manager: { name: 'M', hat: 'top', look: { head: 'boss', cape: true } },
    staff: [{ name: 'S', badge: 1, pin: { project: 'p', extra: 1 }, look: { wings: 2 } }],
    temps: [{ name: 'T', age: 3 }],
  }, null, 2) + '\n';
  const lines = dropReport(raw, {});
  for (const k of ['mood', 'manager.hat', 'manager.look.cape', 'staff[0].badge', 'staff[0].pin.extra', 'staff[0].look.wings', 'temps[0].age']) {
    assert.ok(lines.some((l) => l.includes(`"${k}"`) && /Unknown key/.test(l)), k);
  }
  assert.equal(lines.length, 7);
});

test('dropReport lists invalid values from parseTheme and skips ones the draft has fixed', () => {
  const raw = JSON.stringify({ staff: [{ name: 'S', look: { hair: 'red', head: 'afro' } }], colors: { wall: 'blue', nope: '#ffffff' } }, null, 2) + '\n';
  const lines = dropReport(raw, {});
  assert.ok(lines.some((l) => /staff\[0\]\.look\.hair: expected a colour/.test(l)));
  assert.ok(lines.some((l) => /staff\[0\]\.look\.head: expected one of/.test(l)));
  assert.ok(lines.some((l) => /colors\.wall/.test(l)));
  assert.ok(lines.some((l) => /colors\.nope: unknown colour/.test(l)));
  const fixed = dropReport(raw, setField(setField({}, 'staff-0.look.hair', '#aa0000'), 'colors.wall', '#00ff00'));
  assert.equal(fixed.some((l) => /look\.hair|colors\.wall/.test(l)), false);
  assert.ok(fixed.some((l) => /look\.head/.test(l)));
});

test('dropReport mentions formatting and key order, not valid JSON, and non-objects', () => {
  const messy = '{"staff":[{"name":"S"}],"company":"A"}';
  const lines = dropReport(messy, draftFrom(JSON.parse(messy)));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Formatting/);
  // right layout but a person's keys out of order
  const order = JSON.stringify({ staff: [{ role: 'r', name: 'n' }] }, null, 2) + '\n';
  assert.match(dropReport(order, {}).join('\n'), /Formatting/);
  // right order and layout, no mention
  assert.deepEqual(dropReport(JSON.stringify({ staff: [{ name: 'n', role: 'r' }] }, null, 2) + '\n', {}), []);
  assert.match(dropReport('{ not json', {})[0]!, /not valid JSON/);
  assert.match(dropReport('[1,2]', {})[0]!, /not a JSON object/);
  assert.match(dropReport('', {})[0]!, /not valid JSON/);
  // a byte order mark is read and then reported as formatting
  assert.match(dropReport('﻿{}', {}).join('\n'), /Formatting/);
});

test('dropReport covers the starter-style file: only $schema, empty lists and nothing lost', () => {
  const raw = JSON.stringify({ $schema: '/x/theme.schema.json', company: 'A', receptionist: { name: 'R', lines: [] }, staff: [{ name: 'S', role: 'r', lines: [] }] }, null, 2) + '\n';
  assert.deepEqual(dropReport(raw, draftFrom(JSON.parse(raw))), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// A theme that uses every field survives open, edit and save

/** A theme using every field: titles, every line pool, the four side characters, every colour, 150 small-talk pairs. */
function fullTheme(): OfficeTheme {
  const lines: Record<string, unknown> = {};
  for (const k of LINE_POOL_KEYS) {
    lines[k] = LINE_POOL_KIND[k] === 'pairs' ? [[`${k} opener one`, `${k} reply one`], [`${k} opener two`, `${k} reply two`]] : [`${k} line one`, `${k} line two`];
  }
  const titles: Record<string, string> = {};
  for (const k of TITLE_KEYS) titles[k] = `Title for ${k}`;
  const colors: Record<string, string> = {};
  OFFICE_COLOR_KEYS.forEach((k, i) => (colors[k] = `#${(0x102030 + i * 0x010101).toString(16)}`));
  const side: Record<string, unknown> = {};
  for (const k of NPC_KEYS) side[k] = { name: `The ${k}`, look: { head: 'short', skin: 'olive', shirt: '#336699', skirt: false } };
  const raw = {
    name: 'Harbour lighthouse',
    description: 'A lighthouse keepers office on a rainy coast.',
    company: 'Lamp & Tide',
    branch: 'North Rock',
    lineMode: 'replace',
    titles,
    manager: { name: 'Keeper', look: { head: 'boss', hair: '#3a2a24' }, lines: ['Mind the stairs', 'Tea is on'] },
    receptionist: { name: 'Signal', look: { head: 'receptionist' }, lines: ['Lighthouse desk'] },
    ...side,
    colors,
    lines,
    smallTalk: Array.from({ length: 150 }, (_, i) => [`Opener ${i}`, `Reply ${i}`]),
    staff: [{ name: 'Wick', role: 'Lamp trimmer', pin: { project: 'beacon' }, look: { head: 'cat', outfit: 'vest' }, lines: ['Trim, trim'] }, {}, { name: 'Oar' }],
    temps: [{ name: 'Gull', look: { head: 'spiky' } }],
  };
  const parsed = parseTheme(raw);
  assert.deepEqual(parsed.errors, []);
  return parsed.theme;
}

/** The file text the host writes for the full theme (the canonical form). */
const fullText = (): string => {
  const r = serializeTheme(fullTheme());
  assert.ok(r.ok);
  return r.ok ? r.text : '';
};

const CANONICAL_TOP_KEYS = [
  'name', 'description', 'company', 'branch', 'lineMode', 'titles', 'manager', 'receptionist',
  'cleaner', 'vendor', 'itFixer', 'itCritic', 'colors', 'lines', 'smallTalk', 'staff', 'temps',
];

test('a full theme loaded into the draft and saved after a company edit changes only the company', () => {
  const full = fullTheme();
  const edited = toTheme(setField(draftFrom(full), 'company', 'Beacon & Co'));
  assert.equal(edited.company, 'Beacon & Co');
  assert.deepEqual(edited, { ...toTheme(full), company: 'Beacon & Co' });
  // every new field is still there, and what `toTheme` carries is exactly what was loaded
  assert.deepEqual(toTheme(draftFrom(full)), full);
  assert.equal(edited.lineMode, 'replace');
  assert.equal(edited.name, 'Harbour lighthouse');
  assert.equal(Object.keys(edited.lines ?? {}).length, LINE_POOL_KEYS.length);
  assert.equal(edited.smallTalk?.length, 150);
  for (const k of NPC_KEYS) assert.equal(edited[k]?.name, `The ${k}`);
  // and it still saves
  const out = json(setField(draftFrom(full), 'company', 'Beacon & Co')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), CANONICAL_TOP_KEYS);
});

test('toTheme keeps the new fields in canonical order and cleans them like the rest', () => {
  const d: Draft = {
    temps: [{ name: ' T ' }],
    lines: { itFixerTalk: [[' a ', ' b '], ['', '']], bossVisit: [' hi ', '   '], bossSnack: [] },
    titles: { vendor: ' Seller ', manager: 'Keeper' },
    itCritic: { name: ' C ' },
    cleaner: {},
    lineMode: 'add',
    description: ' d ',
    name: ' n ',
  };
  const t = toTheme(d);
  assert.deepEqual(Object.keys(t), ['name', 'description', 'lineMode', 'titles', 'itCritic', 'lines', 'temps']);
  assert.deepEqual(t.lines, { bossVisit: ['hi'], itFixerTalk: [['a', 'b']] });
  assert.deepEqual(t.titles, { manager: 'Keeper', vendor: 'Seller' });
  assert.deepEqual(t.itCritic, { name: 'C' });
  // a bad line mode is kept so that it is reported, not silently saved or lost
  assert.ok(draftErrors({ lineMode: 'swap' as 'add' }).some((e) => /lineMode/.test(e)));
});

test('furniture colours flow through the colours path like the room colours', () => {
  let d: Draft = {};
  for (const k of FURNITURE_COLOR_KEYS) {
    assert.ok(isFieldPath(`colors.${k}`), k);
    d = setField(d, `colors.${k}`, '#ABCDEF');
  }
  assert.deepEqual(Object.keys(toTheme(d).colors!), [...FURNITURE_COLOR_KEYS]);
  assert.equal(toTheme(d).colors!.sky, '#abcdef');
  assert.deepEqual(draftErrors(d), []);
  assert.equal(toTheme(clearField(d, 'colors.sky')).colors!.sky, undefined);
  assert.deepEqual(toTheme(resetColors(d)), {});
});

test('dropReport: a full theme in canonical form loses nothing', () => {
  assert.deepEqual(dropReport(fullText(), draftFrom(fullTheme())), []);
  // the same file with a company edit still loses nothing
  assert.deepEqual(dropReport(fullText(), setField(draftFrom(fullTheme()), 'company', 'Other')), []);
});

test('dropReport: unknown top-level, person, title and pool keys are still reported', () => {
  const raw = { ...fullTheme() } as Record<string, unknown>;
  raw.mood = 'happy';
  raw.cleaner = { name: 'C', hat: 'top', look: { cape: true } };
  raw.titles = { manager: 'M', janitor: 'J' };
  raw.lines = { bossVisit: ['x'], bossDance: ['y'] };
  // (the file's key order is not canonical, so a Formatting note comes too; it is not what this test is about)
  const lines = dropReport(JSON.stringify(raw, null, 2) + '\n', draftFrom(fullTheme())).filter((l) => !/^Formatting/.test(l));
  for (const k of ['mood', 'cleaner.hat', 'cleaner.look.cape']) {
    assert.ok(lines.some((l) => l.includes(`"${k}"`) && /Unknown key/.test(l)), k);
  }
  assert.ok(lines.some((l) => /titles\.janitor: unknown title/.test(l)));
  assert.ok(lines.some((l) => /lines\.bossDance: unknown line pool/.test(l)));
  assert.equal(lines.length, 5, lines.join('\n'));
});

test('dropReport: the formatting note follows the new canonical key order', () => {
  const full = JSON.parse(fullText()) as Record<string, unknown>;
  const reorder = (order: string[]): string => JSON.stringify(Object.fromEntries(order.map((k) => [k, full[k]])), null, 2) + '\n';
  const inFileOrder = CANONICAL_TOP_KEYS;
  assert.deepEqual(dropReport(reorder(inFileOrder), draftFrom(fullTheme())), []);
  // the colours before the lines is canonical, the other way round is not
  const swapped = inFileOrder.filter((k) => k !== 'lines');
  swapped.splice(swapped.indexOf('colors'), 0, 'lines');
  assert.match(dropReport(reorder(swapped), draftFrom(fullTheme())).join('\n'), /Formatting/);
  // so is a side character ahead of the receptionist, and a pool out of order
  const early = inFileOrder.filter((k) => k !== 'cleaner');
  early.splice(early.indexOf('manager'), 0, 'cleaner');
  assert.match(dropReport(reorder(early), draftFrom(fullTheme())).join('\n'), /Formatting/);
  const poolsBackwards = JSON.stringify({ ...full, lines: Object.fromEntries(Object.entries(full.lines as object).reverse()) }, null, 2) + '\n';
  assert.match(dropReport(poolsBackwards, draftFrom(fullTheme())).join('\n'), /Formatting/);
});

test('a freshly loaded full theme is not dirty, and editing only a new field makes it dirty', () => {
  const host = fullTheme();
  assert.equal(draftChanged(draftFrom(host), host), false);
  assert.equal(draftChanged(restoreDraft(serializeDraft(draftFrom(host), 's')!, 's')!.draft, host), false);
  const withEmpties: Draft = { ...draftFrom(host), titles: { ...host.titles, vendor: '  ' }, lines: { ...host.lines, bossSnack: [] } };
  assert.equal(draftChanged(withEmpties, host), true, 'a blanked title and an emptied pool are real edits');
  assert.equal(draftChanged({ ...draftFrom(host), lineMode: 'add' }, host), true);
  assert.equal(draftChanged(setField(draftFrom(host), 'colors.sky', '#000000'), host), true);
  // no section of the theme is dirty on its own
  const slots = slotList(draftFrom(host), host);
  assert.equal(slots.some((s) => s.changed), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Settings

const setting = (value: FrontDeskSetting['value'], over: Partial<FrontDeskSetting> = {}): FrontDeskSetting => ({ value, source: 'default', workspaceWins: false, ...over });
const fdState = (over: Partial<Record<FrontDeskSettingKey, FrontDeskSetting>> = {}): FrontDeskState => ({
  source: file(),
  presets: [],
  settings: {
    mode: setting('manager'), companyName: setting('Middle Management'), branchName: setting('Harbour Branch'), managerName: setting('You'),
    speechBubbles: setting(true), bossQuotes: setting(true), scope: setting('all'), usageChecks: setting('auto'), updateChecks: setting('auto'),
    ...over,
  },
});

test('settingsView gives one row per setting in order with the right controls', () => {
  const rows = settingsView(fdState());
  assert.deepEqual(rows.map((r) => r.key), [...FRONT_DESK_SETTINGS]);
  assert.deepEqual(rows.map((r) => r.control), ['select', 'text', 'text', 'text', 'toggle', 'toggle', 'select', 'select', 'select']);
  assert.equal(rows[1]!.label, 'Company name');
  assert.deepEqual(rows[0]!.options, [{ value: 'manager', label: 'Manager: hand out tasks and use the office tools' }, { value: 'view', label: 'View: just watch' }]);
  assert.equal(rows[0]!.label, 'Office mode');
  assert.equal(rows[0]!.hint, 'View mode only shows the agents; the Front desk stays open to you.');
  assert.deepEqual(rows[6]!.options, [{ value: 'all', label: 'All sessions' }, { value: 'workspace', label: 'This workspace only' }]);
  assert.deepEqual(rows[7]!.options!.map((o) => o.value), ['auto', 'off']);
  assert.equal(rows[1]!.options, undefined);
  assert.equal(rows[4]!.value, true);
  assert.equal(rows.every((r) => r.hint.length > 0 && !r.canReset && r.workspaceBadge === undefined && r.themeNote === undefined), true);
});

test('settingsView shows the workspace badge, the theme note and the reset flag', () => {
  const rows = settingsView(fdState({
    companyName: setting('WS Corp', { source: 'workspace', userValue: 'My Corp', workspaceWins: true }),
    managerName: setting('Mike', { source: 'user', userValue: 'Mike', themeValue: 'Alex Mercer' }),
    speechBubbles: setting(false, { source: 'user', userValue: false }),
    scope: setting('workspace', { source: 'workspace', workspaceWins: false }),
  }));
  const by = (k: string) => rows.find((r) => r.key === k)!;
  assert.equal(by('companyName').workspaceBadge, 'Workspace overrides this');
  assert.equal(by('companyName').value, 'WS Corp');
  assert.equal(by('companyName').canReset, true);
  assert.equal(by('companyName').source, 'workspace');
  assert.equal(by('managerName').themeValue, 'Alex Mercer');
  assert.match(by('managerName').themeNote!, /Alex Mercer/);
  assert.equal(by('managerName').workspaceBadge, undefined);
  assert.equal(by('speechBubbles').canReset, true);
  assert.equal(by('speechBubbles').value, false);
  // a workspace-only value gives no badge (nothing of the user's is overridden) and cannot be reset here
  assert.equal(by('scope').workspaceBadge, undefined);
  assert.equal(by('scope').canReset, false);
  assert.equal(by('branchName').canReset, false);
});

test('validateSettingInput mirrors the validator', () => {
  // text
  assert.deepEqual(validateSettingInput('companyName', '  Acme  '), { ok: true, value: 'Acme' });
  assert.deepEqual(validateSettingInput('branchName', ''), { ok: true, value: '' });
  assert.deepEqual(validateSettingInput('branchName', '   '), { ok: true, value: '' });
  assert.deepEqual(validateSettingInput('managerName', 'x'.repeat(100)), { ok: true, value: 'x'.repeat(100) });
  assert.equal(validateSettingInput('managerName', 'x'.repeat(101)).ok, false);
  assert.deepEqual(validateSettingInput('managerName', ' ' + 'x'.repeat(100) + ' '), { ok: true, value: 'x'.repeat(100) });
  for (const bad of ['a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a b', 'a b']) assert.equal(validateSettingInput('companyName', bad).ok, false, JSON.stringify(bad));
  assert.equal(validateSettingInput('companyName', 5).ok, false);
  assert.equal(validateSettingInput('companyName', undefined).ok, false);
  assert.equal(validateSettingInput('companyName', true).ok, false);
  // booleans
  assert.deepEqual(validateSettingInput('speechBubbles', false), { ok: true, value: false });
  assert.deepEqual(validateSettingInput('bossQuotes', true), { ok: true, value: true });
  for (const bad of ['true', 'false', 1, 0, undefined]) assert.equal(validateSettingInput('bossQuotes', bad).ok, false);
  // enums
  assert.deepEqual(validateSettingInput('scope', 'workspace'), { ok: true, value: 'workspace' });
  assert.deepEqual(validateSettingInput('mode', 'view'), { ok: true, value: 'view' });
  assert.equal(validateSettingInput('mode', 'watch').ok, false);
  assert.deepEqual(validateSettingInput('usageChecks', 'off'), { ok: true, value: 'off' });
  assert.deepEqual(validateSettingInput('updateChecks', 'off'), { ok: true, value: 'off' });
  assert.equal(validateSettingInput('updateChecks', 'daily').ok, false);
  assert.equal(validateSettingInput('scope', 'everything').ok, false);
  assert.equal(validateSettingInput('usageChecks', true).ok, false);
  assert.equal(validateSettingInput('scope', 'ALL').ok, false);
  // null resets any key
  for (const k of FRONT_DESK_SETTINGS) assert.deepEqual(validateSettingInput(k, null), { ok: true, value: null });
  // keys outside the allowlist
  assert.equal(validateSettingInput('claudePath' as FrontDeskSettingKey, 'x').ok, false);
  assert.equal(validateSettingInput('__proto__' as FrontDeskSettingKey, 'x').ok, false);
});

test('validateSettingInput errors are readable', () => {
  const r = validateSettingInput('companyName', 'x'.repeat(200));
  assert.ok(!r.ok && /100/.test(r.error));
  const e = validateSettingInput('scope', 'nope');
  assert.ok(!e.ok && /all, workspace/.test(e.error));
});

// ---------------------------------------------------------------------------------------------------------------------
// Contrast

test('contrastRatio against known WCAG values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#336699', '#336699'), 1);
  assert.equal(contrastRatio('#fff', '#000'), 21);
  // well known: #777777 on white is 4.48:1, #767676 is 4.54:1, #595959 is 7:1
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.48) < 0.01);
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.01);
  assert.ok(Math.abs(contrastRatio('#595959', '#ffffff') - 7) < 0.02);
  // red on white is 4.00:1
  assert.ok(Math.abs(contrastRatio('#ff0000', '#ffffff') - 3.998) < 0.01);
  assert.ok(Number.isNaN(contrastRatio('red', '#ffffff')));
  assert.ok(Number.isNaN(contrastRatio('#ffffff', '')));
  assert.ok(Math.abs(contrastRatio('#ABCDEF', '#123456') - contrastRatio('#abcdef', '#123456')) < 1e-12);
});

const SIGN_DEFAULTS = { signPlate: '#2d3d57', signText: '#fff4d0', signBranch: '#b9b7a6' };

test('signReadability uses defaults for unset keys and warns below 3:1', () => {
  assert.equal(SIGN_MIN_CONTRAST, 3);
  assert.equal(signReadability(undefined, SIGN_DEFAULTS), 'ok');
  assert.equal(signReadability({}, SIGN_DEFAULTS), 'ok');
  // text close to the default plate
  assert.equal(signReadability({ signText: '#2d3d60' }, SIGN_DEFAULTS), 'low');
  // plate changed to the colour of the default text
  assert.equal(signReadability({ signPlate: '#fff4d0' }, SIGN_DEFAULTS), 'low');
  const d = signReadabilityDetail({ signPlate: '#b9b7a6' }, SIGN_DEFAULTS);
  assert.equal(d.branch, 'low');
  assert.equal(d.branchRatio, 1);
  assert.equal(d.sign, 'low');
  assert.ok(d.signRatio < 3);
  assert.equal(signReadabilityDetail({ signPlate: '#000000' }, SIGN_DEFAULTS).sign, 'ok');
  // either pair low gives low overall; both good gives ok
  assert.equal(signReadability({ signBranch: '#2d3d57' }, SIGN_DEFAULTS), 'low');
  assert.equal(signReadability({ signPlate: '#000000', signText: '#ffffff', signBranch: '#ffffff' }, SIGN_DEFAULTS), 'ok');
  // exactly on the threshold passes: black plate, grey with ratio just over 3
  const grey = '#6a6a6a';
  assert.ok(contrastRatio(grey, '#000000') > 3);
  assert.equal(signReadability({ signPlate: '#000000', signText: grey, signBranch: grey }, SIGN_DEFAULTS), 'ok');
  assert.equal(signReadability({ signPlate: '#000000', signText: '#555555', signBranch: grey }, SIGN_DEFAULTS), 'low');
  // missing or unusable colours cannot be judged
  assert.equal(signReadability({}, {}), 'ok');
  assert.equal(signReadability({ signText: 'nope' as string }, SIGN_DEFAULTS), 'ok');
  // all OFFICE_COLOR_KEYS stay valid keys
  assert.ok(OFFICE_COLOR_KEYS.includes('signPlate'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Persistence

test('serializeDraft and restoreDraft round-trip for the same source', () => {
  const d = draftFrom({ company: 'Acme', staff: [{}, { name: 'B', look: { hair: '#112233' } }], colors: { wall: '#ffffff' } });
  const text = serializeDraft(d, 'file||~/office.json', 'r1')!;
  assert.equal(typeof text, 'string');
  const back = restoreDraft(text, 'file||~/office.json');
  assert.deepEqual(back, { draft: d, rev: 'r1' });
  const noRev = restoreDraft(serializeDraft(d, 'k')!, 'k')!;
  assert.equal(noRev.rev, undefined);
  assert.deepEqual(noRev.draft, d);
});

test('restoreDraft drops the draft when the source differs or the data is not ours', () => {
  const text = serializeDraft({ company: 'Acme' }, 'file||a.json', 'r')!;
  assert.equal(restoreDraft(text, 'file||b.json'), null);
  assert.equal(restoreDraft(text, 'builtin||'), null);
  assert.equal(restoreDraft(undefined, 'file||a.json'), null);
  assert.equal(restoreDraft(null, 'file||a.json'), null);
  assert.equal(restoreDraft(42, 'file||a.json'), null);
  assert.equal(restoreDraft({ v: 1 }, 'file||a.json'), null);
  assert.equal(restoreDraft('not json', 'file||a.json'), null);
  assert.equal(restoreDraft('[]', 'file||a.json'), null);
  assert.equal(restoreDraft(JSON.stringify({ v: 2, source: 'x', draft: {} }), 'x'), null);
  assert.equal(restoreDraft(JSON.stringify({ v: 1, source: 'x', draft: [] }), 'x'), null);
});

test('restoreDraft sanitises what it brings back', () => {
  const evil = JSON.stringify({ v: 1, source: 'x', rev: 7, draft: { company: 'A', mood: 'x', staff: [{ name: 'S', look: { hair: 'red' } }], __proto__: { polluted: true } } });
  const back = restoreDraft(evil, 'x')!;
  assert.deepEqual(back.draft.staff, [{ name: 'S', look: {} }]);
  assert.equal(back.draft.company, 'A');
  assert.equal('mood' in back.draft, false);
  assert.equal(back.rev, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('the saved draft is capped at 256 KB', () => {
  assert.equal(DRAFT_MAX_BYTES, 262144);
  const line = 'y'.repeat(80);
  let d: Draft = {};
  for (let i = 0; i < 8; i++) d = setField(d, `staff-${i}.lines`, Array.from({ length: 60 }, () => line));
  const ok = serializeDraft(d, 'k');
  assert.ok(ok !== null && ok.length < DRAFT_MAX_BYTES);
  // an over-long draft (not valid as a theme, but a draft can hold anything the UI typed) is refused
  const big = { ...d, company: 'z'.repeat(DRAFT_MAX_BYTES) };
  assert.equal(serializeDraft(big, 'k'), null);
  // multi-byte text counts in bytes: 90k three-byte characters is over the cap while 90k characters is not
  assert.equal(serializeDraft({ company: '€'.repeat(90_000) }, 'k'), null);
  assert.notEqual(serializeDraft({ company: 'e'.repeat(90_000) }, 'k'), null);
  // and a stored text that grew past the cap is not restored
  const text = JSON.stringify({ v: 1, source: 'k', rev: null, draft: { company: 'z'.repeat(DRAFT_MAX_BYTES) } });
  assert.equal(restoreDraft(text, 'k'), null);
});

test('an unsaved draft survives a persistence round trip with placeholders and trims on save', () => {
  const d = setField({}, 'staff-3.name', 'Kevin');
  const back = restoreDraft(serializeDraft(d, 'k')!, 'k')!;
  assert.deepEqual(back.draft.staff, [{}, {}, {}, { name: 'Kevin' }]);
});
