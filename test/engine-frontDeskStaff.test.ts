import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOUR_GROUPS, LOOK_COLOUR_GROUPS, LOOK_FIELD_LABELS, LOOK_FIELD_PAL_KEY, LOOK_OPTION_LABELS, STAFF_NARROW_BELOW, colourGroups, editLines,
  effectiveColours, hasOwnLook, isHexColour, linesCount, listMove, lookFieldModels, lookLayoutKey, lookSections, optionLabel, parseHex,
  rawLines, rawSlot, rawText, ratioText, signFix, signWarning, slotFeatures, slotLookOf, staffLayout, throttle,
} from '../webview/engine/frontDeskStaffView.ts';
import { LOOK_FIELDS, SLOT_IDS, inheritedLook, setField } from '../webview/engine/frontDeskLogic.ts';
import type { Draft } from '../webview/engine/frontDeskLogic.ts';
import { BUILDS, HEAD_STYLES, OFFICE_COLOR_KEYS, OUTFITS, SKIN_TONES, THEME_LIMITS } from '../src/shared/theme.ts';
import type { LookSpec, OfficeColorKey } from '../src/shared/theme.ts';

const DEFAULTS = Object.fromEntries(OFFICE_COLOR_KEYS.map((k, i) => [k, `#${(0x101010 * (i % 15) + 0x0a0a0a).toString(16).padStart(6, '0')}`])) as Record<OfficeColorKey, string>;
// A dark plate with light lettering, like the built-in sign.
DEFAULTS.signPlate = '#2d3d57';
DEFAULTS.signText = '#fff4d0';
DEFAULTS.signBranch = '#b9b7a6';

// ---------------------------------------------------------------------------------------------------------------------
// Layout and keyboard

test('staffLayout: split from 420 px, stack below; an unknown width keeps the previous layout', () => {
  assert.equal(STAFF_NARROW_BELOW, 420);
  assert.equal(staffLayout(360), 'stack');
  assert.equal(staffLayout(419.5), 'stack');
  assert.equal(staffLayout(420), 'split');
  assert.equal(staffLayout(1100), 'split');
  assert.equal(staffLayout(0, 'split'), 'split');
  assert.equal(staffLayout(-1, 'stack'), 'stack');
  assert.equal(staffLayout(Number.NaN, 'split'), 'split');
  assert.equal(staffLayout(0), 'stack');
});

test('listMove: arrows, Home/End and paging stay inside the list; other keys are not ours', () => {
  assert.equal(listMove('ArrowDown', 0, 17), 1);
  assert.equal(listMove('ArrowDown', 16, 17), 16);
  assert.equal(listMove('ArrowUp', 0, 17), 0);
  assert.equal(listMove('ArrowUp', 5, 17), 4);
  assert.equal(listMove('Home', 9, 17), 0);
  assert.equal(listMove('End', 2, 17), 16);
  assert.equal(listMove('PageDown', 14, 17), 16);
  assert.equal(listMove('PageUp', 3, 17), 0);
  assert.equal(listMove('PageDown', 0, 17, 4), 4);
  assert.equal(listMove('Enter', 3, 17), null);
  assert.equal(listMove('ArrowDown', 0, 0), null);
  assert.equal(listMove('ArrowDown', 99, 3), 2);
});

// ---------------------------------------------------------------------------------------------------------------------
// Hex

test('parseHex: normalises #abc, abc, #AABBCC and spaces to #aabbcc; blank is empty; the rest is invalid', () => {
  assert.deepEqual(parseHex('#abc'), { kind: 'ok', hex: '#aabbcc' });
  assert.deepEqual(parseHex('abc'), { kind: 'ok', hex: '#aabbcc' });
  assert.deepEqual(parseHex('  #A1B2C3 '), { kind: 'ok', hex: '#a1b2c3' });
  assert.deepEqual(parseHex('a1b2c3'), { kind: 'ok', hex: '#a1b2c3' });
  assert.deepEqual(parseHex(''), { kind: 'empty' });
  assert.deepEqual(parseHex('   '), { kind: 'empty' });
  for (const bad of ['#12', '#1234', '#12345', '#1234567', 'mauve', '#ggg', '##abc', 'rgb(1,2,3)', '#abcd']) assert.deepEqual(parseHex(bad), { kind: 'invalid' }, bad);
  assert.ok(isHexColour('#A1b2C3'));
  assert.ok(!isHexColour('#abc'));
  assert.ok(!isHexColour(undefined));
});

// ---------------------------------------------------------------------------------------------------------------------
// Colours

test('COLOUR_GROUPS: every office colour exactly once, in the nine groups', () => {
  const keys = COLOUR_GROUPS.flatMap((g) => g.keys.map(([k]) => k));
  assert.equal(keys.length, OFFICE_COLOR_KEYS.length);
  assert.deepEqual([...keys].sort(), [...OFFICE_COLOR_KEYS].sort());
  assert.deepEqual(COLOUR_GROUPS.map((g) => g.title), ['Walls and ceiling', 'Floors', 'Rug', 'Chairs', 'Sign', 'Furniture', 'Plants', 'Windows and glass', 'Lights and outside']);
  assert.equal(COLOUR_GROUPS[1]!.keys.length, 6);
  for (const g of COLOUR_GROUPS) for (const [, label] of g.keys) assert.ok(label.length > 0);
});

test('colourGroups: inherited rows show the built-in; own valid colours are lower case; bad text is flagged', () => {
  const groups = colourGroups({ wall: '#AABBCC', rug: 'mauve' }, DEFAULTS);
  const row = (k: OfficeColorKey) => groups.flatMap((g) => g.rows).find((r) => r.key === k)!;
  assert.deepEqual(row('wall'), { key: 'wall', label: 'Walls', builtin: DEFAULTS.wall, value: '#aabbcc', inherited: false });
  assert.equal(row('trim').inherited, true);
  assert.equal(row('trim').value, DEFAULTS.trim);
  assert.equal(row('rug').inherited, false);
  assert.equal(row('rug').invalid, 'mauve');
  assert.equal(row('rug').value, DEFAULTS.rug);
  assert.equal(groups[0]!.customised, 1);
  assert.equal(groups[2]!.customised, 1);
  assert.equal(groups[1]!.customised, 0);
  assert.ok(colourGroups(undefined, DEFAULTS).every((g) => g.customised === 0 && g.rows.every((r) => r.inherited)));
  assert.equal(effectiveColours({ wall: '#AABBCC', rug: 'mauve' }, DEFAULTS).rug, DEFAULTS.rug);
  assert.equal(effectiveColours({ wall: '#AABBCC' }, DEFAULTS).wall, '#aabbcc');
});

test('signWarning: none for the built-in sign; names the faint line, the ratio and a direction', () => {
  assert.equal(signWarning(undefined, DEFAULTS), null);
  const low = signWarning({ signText: '#34465f' }, DEFAULTS);
  assert.ok(low);
  assert.deepEqual(low.keys, ['signText']);
  assert.equal(low.direction, 'lighter');
  assert.match(low.detail, /^The company name is too close/);
  assert.match(low.detail, /contrast 1\.\d:1/);
  assert.match(low.detail, /aim for 3:1/);
  const both = signWarning({ signPlate: '#f4f0e0', signText: '#ffffff', signBranch: '#eeeeee' }, DEFAULTS);
  assert.ok(both);
  assert.deepEqual(both.keys, ['signText', 'signBranch']);
  assert.equal(both.direction, 'darker');
  assert.match(both.detail, /company and branch names are/);
  const branch = signWarning({ signBranch: '#3a4a64' }, DEFAULTS);
  assert.deepEqual(branch?.keys, ['signBranch']);
  // An unusable value counts as the built-in colour, as in the office.
  assert.equal(signWarning({ signText: 'nope' }, DEFAULTS), null);
  assert.equal(signFix(undefined, DEFAULTS), null);
  assert.deepEqual(signFix({ signText: '#34465f' }, DEFAULTS), { signText: DEFAULTS.signText });
  const fix = signFix({ signPlate: '#f4f0e0', signText: '#ffffff', signBranch: '#eeeeee' }, DEFAULTS)!;
  assert.deepEqual(Object.keys(fix), ['signText', 'signBranch']);
  assert.equal(signWarning({ signPlate: '#f4f0e0', ...fix }, DEFAULTS), null);
  assert.equal(ratioText('#000000', '#ffffff'), '21.0:1');
  assert.equal(ratioText('x', '#ffffff'), '');
});

// ---------------------------------------------------------------------------------------------------------------------
// Slots and raw draft access

test('slotFeatures: the sign, people and temps get the parts setField allows', () => {
  assert.deepEqual(slotFeatures('sign'), { sign: true, name: false, role: false, pin: false, lines: false, look: false });
  assert.deepEqual(slotFeatures('manager'), { sign: false, name: true, role: false, pin: false, lines: true, look: true });
  assert.deepEqual(slotFeatures('receptionist'), slotFeatures('manager'));
  assert.deepEqual(slotFeatures('staff-7'), { sign: false, name: true, role: true, pin: true, lines: true, look: true });
  assert.deepEqual(slotFeatures('temp-5'), { sign: false, name: true, role: false, pin: false, lines: false, look: true });
  assert.equal(slotFeatures('staff-8').look, false);
  assert.equal(slotFeatures('nope').name, false);
  for (const id of SLOT_IDS) assert.ok(Object.values(slotFeatures(id)).some(Boolean), id);
});

test('raw access reads what was typed, untrimmed, with blanks', () => {
  let d: Draft = {};
  d = setField(d, 'staff-2.name', ' Marta ');
  d = setField(d, 'staff-2.pin.project', 'website');
  d = setField(d, 'staff-2.lines', ['Hello', '', 'Bye']);
  d = setField(d, 'manager.name', 'Alex');
  assert.equal(rawText(d, 'staff-2', 'name'), ' Marta ');
  assert.equal(rawText(d, 'staff-2', 'pin.project'), 'website');
  assert.equal(rawText(d, 'staff-2', 'pin.title'), '');
  assert.equal(rawText(d, 'staff-2', 'role'), '');
  assert.equal(rawText(d, 'manager', 'name'), 'Alex');
  assert.equal(rawText(d, 'staff-0', 'name'), '');
  assert.deepEqual(rawLines(d, 'staff-2'), ['Hello', '', 'Bye']);
  assert.deepEqual(rawLines(d, 'manager'), []);
  assert.deepEqual(rawSlot(d, 'staff-0'), {});
  assert.equal(rawSlot(d, 'staff-5'), undefined);
  assert.equal(rawSlot(d, 'sign'), undefined);
  assert.equal(hasOwnLook(d, 'staff-2'), false);
  d = setField(d, 'staff-2.look.hair', '#112233');
  assert.equal(hasOwnLook(d, 'staff-2'), true);
});

test('slotLookOf: the look a theme gives each slot', () => {
  const theme = { manager: { look: { hair: '#111111' } }, staff: [{}, { look: { head: 'bob' as const } }], temps: [{ look: { skin: 'deep' as const } }] };
  assert.deepEqual(slotLookOf(theme, 'manager'), { hair: '#111111' });
  assert.deepEqual(slotLookOf(theme, 'staff-1'), { head: 'bob' });
  assert.equal(slotLookOf(theme, 'staff-0'), undefined);
  assert.deepEqual(slotLookOf(theme, 'temp-0'), { skin: 'deep' });
  assert.equal(slotLookOf(theme, 'receptionist'), undefined);
  assert.equal(slotLookOf(null, 'manager'), undefined);
  assert.equal(slotLookOf(theme, 'sign'), undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// The look editor

test('labels cover every look field and every enum value', () => {
  for (const f of LOOK_FIELDS) assert.ok(LOOK_FIELD_LABELS[f.key], f.key);
  for (const [field, values] of [['head', HEAD_STYLES], ['build', BUILDS], ['outfit', OUTFITS], ['skin', SKIN_TONES]] as const) {
    for (const v of values) assert.ok(LOOK_OPTION_LABELS[field][v], `${field}.${v}`);
  }
  assert.equal(optionLabel('outfit', 'shirtTie'), 'Shirt and tie');
  assert.equal(optionLabel('head', 'nope'), 'nope');
  const colourFields = LOOK_FIELDS.filter((f) => f.kind === 'colour').map((f) => f.key);
  assert.deepEqual(LOOK_COLOUR_GROUPS.flatMap((g) => g.fields).sort(), [...colourFields].sort());
  for (const f of colourFields) assert.ok(LOOK_FIELD_PAL_KEY[f], f);
});

const BUILTIN: LookSpec = { head: 'boss', build: 'normal', outfit: 'suit', skin: 'fair', hair: '#3a2a24', shirt: '#eeeee8', outer: '#353a4a', tie: '#9a2f3c', pants: '#353a4a', shoes: '#1f1c22', skirt: false, shortSleeves: false, belt: false };
const USED = ['head', 'build', 'outfit', 'skin', 'hair', 'hairHighlight', 'shirt', 'outer', 'sleeve', 'tie', 'collar', 'pants', 'shoes', 'skirt', 'shortSleeves', 'belt'];

test('lookFieldModels: own, built-in and worked-out values; fields that do not show are marked unused', () => {
  let d: Draft = {};
  d = setField(d, 'manager.look.hair', '#AA0000');
  d = setField(d, 'manager.look.glasses', '#123456');
  const rows = inheritedLook('manager', d, () => BUILTIN);
  const models = lookFieldModels(rows, USED, (f) => (f === 'sleeve' ? '#353a4a' : f === 'eye' ? '#2a1d22' : f === 'hairHighlight' ? '#5a4a44' : f === 'tie' ? '#9A2F3C' : undefined));
  const m = (f: keyof LookSpec) => models.find((x) => x.field === f)!;
  assert.equal(m('hair').source, 'own');
  assert.equal(m('hair').shown, '#aa0000');
  assert.equal(m('hair').inherited, false);
  assert.equal(m('shirt').source, 'builtin');
  assert.equal(m('shirt').shown, '#eeeee8');
  assert.equal(m('sleeve').source, 'auto');
  // A built-in value the look still paints is "built-in"; one it no longer paints (re-derived) is "auto".
  assert.equal(m('tie').source, 'builtin');
  assert.equal(m('tie').shown, '#9a2f3c');
  assert.equal(m('hairHighlight').source, 'auto');
  assert.equal(m('hairHighlight').shown, '#5a4a44');
  assert.equal(m('sleeve').shown, '#353a4a');
  assert.equal(m('glasses').used, false);
  assert.equal(m('glasses').source, 'own');
  assert.equal(m('head').used, true);
  assert.equal(m('head').label, 'Head');
  assert.deepEqual(m('build').options, BUILDS);
  assert.equal(m('legs').used, false);
  assert.equal(m('skirt').value, false);
  assert.ok(models.every((x) => !x.invalid));

  const s = lookSections(models);
  assert.deepEqual(s.shape.map((x) => x.field), ['head', 'build', 'outfit', 'skin']);
  assert.deepEqual(s.colours.map((g) => g.id), ['face', 'top', 'legs']);
  assert.deepEqual(s.colours[0]!.rows.map((x) => x.field), ['hair', 'hairHighlight']);
  assert.deepEqual(s.options.map((x) => x.field), ['skirt', 'shortSleeves', 'belt']);
  assert.ok(s.more.some((x) => x.field === 'glasses'));
  assert.ok(s.more.every((x) => !x.used && x.kind !== 'enum'));
  assert.equal(s.shape.length + s.colours.reduce((n, g) => n + g.rows.length, 0) + s.options.length + s.more.length, LOOK_FIELDS.length);

  // The layout key changes when a field moves between sections, not when a value changes.
  const k1 = lookLayoutKey(s);
  const k2 = lookLayoutKey(lookSections(lookFieldModels(inheritedLook('manager', setField(d, 'manager.look.hair', '#00aa00'), () => BUILTIN), USED, () => undefined)));
  assert.equal(k1, k2);
  const k3 = lookLayoutKey(lookSections(lookFieldModels(rows, [...USED, 'glasses'], () => undefined)));
  assert.notEqual(k1, k3);
});

test('lookFieldModels: an unusable own value is flagged', () => {
  const rows = inheritedLook('staff-0', { staff: [{ look: { hair: 'brown' as unknown as string, head: 'bald' as never } }] }, () => BUILTIN);
  const models = lookFieldModels(rows, USED, () => '#000000');
  assert.equal(models.find((x) => x.field === 'hair')!.invalid, true);
  assert.equal(models.find((x) => x.field === 'hair')!.shown, '#000000');
  assert.equal(models.find((x) => x.field === 'head')!.invalid, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Lines

test('editLines: set, add, remove and a multi-line paste, within the limits', () => {
  assert.deepEqual(editLines([], { op: 'add' }), { lines: [''], focus: 0 });
  assert.deepEqual(editLines(['a'], { op: 'set', index: 0, text: 'hello' }), { lines: ['hello'], focus: 0 });
  assert.deepEqual(editLines(['a'], { op: 'set', index: 3, text: 'x' }), { lines: ['a'], focus: null });
  assert.equal(editLines(['a'], { op: 'set', index: 0, text: 'x'.repeat(200) }).lines[0]!.length, THEME_LIMITS.line);
  assert.deepEqual(editLines(['a', 'b', 'c'], { op: 'remove', index: 1 }), { lines: ['a', 'c'], focus: 1 });
  assert.deepEqual(editLines(['a', 'b'], { op: 'remove', index: 1 }), { lines: ['a'], focus: 0 });
  assert.deepEqual(editLines(['a'], { op: 'remove', index: 0 }), { lines: [], focus: null });
  const full = Array.from({ length: THEME_LIMITS.lines }, (_, i) => `l${i}`);
  assert.equal(editLines(full, { op: 'add' }).lines.length, THEME_LIMITS.lines);
  assert.deepEqual(editLines(['a', 'z'], { op: 'paste', index: 0, text: 'one\r\ntwo\n\n three \n' }), { lines: ['one', 'two', 'three', 'z'], focus: 2 });
  assert.deepEqual(editLines(['a', 'b'], { op: 'paste', index: 0, text: 'x\ny\nz' }, 3), { lines: ['x', 'y', 'b'], focus: 1 });
  assert.equal(linesCount(0), 'No lines of their own');
  assert.equal(linesCount(3), `3 of ${THEME_LIMITS.lines} lines`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Throttle

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
      clear(h: unknown) { pending.delete(h as number); },
      now: () => now,
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pendingCount: () => pending.size,
  };
}

test('throttle: the first value goes at once, a burst sends one value per interval and always the last one', () => {
  const t = fakeTimers();
  const sent: string[] = [];
  const th = throttle<string>((v) => { sent.push(v); }, 150, t.timers);
  th.push('a');
  assert.deepEqual(sent, ['a']);
  t.advance(20); th.push('b');
  t.advance(20); th.push('c');
  t.advance(20); th.push('d');
  assert.deepEqual(sent, ['a']);
  t.advance(100);
  assert.deepEqual(sent, ['a', 'd']);
  t.advance(500);
  assert.deepEqual(sent, ['a', 'd']);
  th.push('e');
  assert.deepEqual(sent, ['a', 'd', 'e']);
  t.advance(10); th.push('f');
  th.flush();
  assert.deepEqual(sent, ['a', 'd', 'e', 'f']);
  assert.equal(t.pendingCount(), 0);
  t.advance(10); th.push('g');
  th.cancel();
  t.advance(1000);
  assert.deepEqual(sent, ['a', 'd', 'e', 'f']);
  th.flush();
  assert.deepEqual(sent, ['a', 'd', 'e', 'f']);
});
