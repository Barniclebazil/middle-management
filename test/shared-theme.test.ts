import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTheme, THEME_LIMITS, HEAD_STYLES, OFFICE_COLOR_KEYS, ROOM_COLOR_KEYS, FURNITURE_COLOR_KEYS, trimTrailingPlaceholders, SKIN_TONES, BUILDS, OUTFITS,
  LINE_MODES, TITLE_KEYS, NPC_KEYS, LINE_POOL_KEYS, LINE_POOL_KIND, LINE_POOL_INFO,
} from '../src/shared/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';

const full: OfficeTheme = {
  company: 'Acme Paper',
  branch: 'Slough',
  manager: {
    name: 'Pat Boss',
    look: { head: 'boss', build: 'normal', outfit: 'suit', skin: 'fair', hair: '#112233', tie: '#aa0000', belt: true },
    lines: ['Quick word.', 'Who has the report?'],
  },
  smallTalk: [['Did you see the match?', 'No, I was filing.']],
  staff: [
    {
      name: 'Alex Rivers',
      role: 'Sales',
      look: {
        head: 'cat', build: 'tall', outfit: 'cardigan', skin: 'olive',
        hair: '#010203', hairHighlight: '#040506', eye: '#070809', shirt: '#0a0b0c', outer: '#0d0e0f', sleeve: '#101112',
        tie: '#131415', collar: '#161718', accent: '#191a1b', accent2: '#1c1d1e', pants: '#1f2021', legs: '#222324',
        shoes: '#252627', glasses: '#28292a', facialHair: '#2b2c2d', bow: '#2e2f30', beltColor: '#313233',
        skirt: false, shortSleeves: true, belt: false,
      },
      lines: ['Another day.'],
      pin: { project: 'api', title: 'refactor' },
    },
    { name: 'Sam Lee' },
  ],
  temps: [{ name: 'Temp One', look: { head: 'spiky' } }, {}],
};

test('a full valid theme round-trips with no errors', () => {
  const r = parseTheme(structuredClone(full));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme, full);
  // survives a JSON round trip too
  assert.deepEqual(parseTheme(JSON.parse(JSON.stringify(full))), { theme: full, errors: [] });
});

test('an empty object is a valid empty theme', () => {
  assert.deepEqual(parseTheme({}), { theme: {}, errors: [] });
});

test('non-object input', () => {
  for (const v of [undefined, null, 'x', 5, true, [], [{ staff: [] }]]) {
    assert.deepEqual(parseTheme(v), { theme: {}, errors: ['theme: expected a JSON object'] });
  }
});

test('never throws on hostile input', () => {
  const evil = new Proxy({}, { get() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } });
  const r = parseTheme(evil);
  assert.deepEqual(r.theme, {});
  assert.ok(r.errors.length >= 1);
});

test('colours are validated and lower-cased', () => {
  const r = parseTheme({ staff: [{ name: 'A', look: { hair: '#A1B2C3', shirt: 'red', tie: '#fff', eye: '#12345g', pants: 5, shoes: ' #aabbcc' } }] });
  assert.deepEqual(r.theme.staff, [{ name: 'A', look: { hair: '#a1b2c3' } }]);
  assert.deepEqual(r.errors, [
    'staff[0].look.eye: expected a colour like #a1b2c3',
    'staff[0].look.shirt: expected a colour like #a1b2c3',
    'staff[0].look.tie: expected a colour like #a1b2c3',
    'staff[0].look.pants: expected a colour like #a1b2c3',
    'staff[0].look.shoes: expected a colour like #a1b2c3',
  ]);
});

test('error paths use the index in the file', () => {
  const r = parseTheme({ staff: [{ name: 'A' }, { name: 'B' }, { name: 'C', look: { hair: 'nope' } }] });
  assert.deepEqual(r.errors, ['staff[2].look.hair: expected a colour like #a1b2c3']);
  assert.equal(r.theme.staff?.[2]?.name, 'C');
  assert.deepEqual(r.theme.staff?.[2]?.look, {});
});

test('booleans must be booleans', () => {
  const r = parseTheme({ manager: { look: { skirt: 'yes', belt: true, shortSleeves: 1 } } });
  assert.deepEqual(r.theme.manager, { look: { belt: true } });
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0]!, /^manager\.look\.skirt: /);
});

test('head, build, outfit and skin must be known values', () => {
  const ok = parseTheme({ temps: HEAD_STYLES.map((head) => ({ look: { head } })) });
  assert.equal(ok.errors.filter((e) => !e.includes('temps:')).length, 0);
  for (const [key, values] of [['head', HEAD_STYLES], ['skin', SKIN_TONES], ['build', BUILDS], ['outfit', OUTFITS]] as const) {
    for (const v of values) assert.deepEqual(parseTheme({ manager: { look: { [key]: v } } }), { theme: { manager: { look: { [key]: v } } }, errors: [] });
    const bad = parseTheme({ staff: [{ name: 'A', look: { [key]: 'nope' } }] });
    assert.deepEqual(bad.theme.staff, [{ name: 'A', look: {} }]);
    assert.equal(bad.errors.length, 1);
    assert.ok(bad.errors[0]!.startsWith(`staff[0].look.${key}: expected one of `), bad.errors[0]);
  }
  // case matters, non-strings rejected
  assert.equal(parseTheme({ manager: { look: { head: 'Boss' } } }).errors.length, 1);
  assert.equal(parseTheme({ manager: { look: { head: 3 } } }).errors.length, 1);
});

test('strings are trimmed, non-empty, control-free and bounded', () => {
  const r = parseTheme({ company: '  Acme  ', branch: '   ', manager: { name: 'x'.repeat(THEME_LIMITS.name + 1) } });
  assert.equal(r.theme.company, 'Acme');
  assert.equal(r.theme.branch, undefined);
  assert.deepEqual(r.theme.manager, {});
  assert.equal(r.errors.length, 2);
  assert.ok(parseTheme({ company: 'x'.repeat(THEME_LIMITS.name) }).errors.length === 0);
  assert.equal(parseTheme({ company: 'a\nb' }).errors.length, 1);
  assert.equal(parseTheme({ company: 'a\u0000b' }).errors.length, 1);
  assert.equal(parseTheme({ company: 7 }).theme.company, undefined);
  const lim = parseTheme({ staff: [{ name: 'A', role: 'r'.repeat(THEME_LIMITS.role + 1), lines: ['l'.repeat(THEME_LIMITS.line + 1), 'ok', ''] }] });
  assert.deepEqual(lim.theme.staff, [{ name: 'A', lines: ['ok'] }]);
  assert.equal(lim.errors.length, 3);
});

test('nine staff keep eight and report the extras once', () => {
  const staff = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}` }));
  const r = parseTheme({ staff });
  assert.equal(r.theme.staff?.length, THEME_LIMITS.staff);
  assert.equal(r.theme.staff?.[7]?.name, 'S7');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /^staff: only the first 8 entries are used; 1 dropped$/);
});

test('other caps: temps, lines, smallTalk', () => {
  const t = parseTheme({ temps: Array.from({ length: 10 }, () => ({})) });
  assert.equal(t.theme.temps?.length, THEME_LIMITS.temps);
  assert.equal(t.errors.length, 1);
  const l = parseTheme({ manager: { lines: Array.from({ length: 70 }, (_, i) => `line ${i}`) } });
  assert.equal(l.theme.manager?.lines?.length, THEME_LIMITS.lines);
  assert.equal(l.errors.length, 1);
  const s = parseTheme({ smallTalk: Array.from({ length: THEME_LIMITS.smallTalk + 1 }, () => ['a', 'b']) });
  assert.equal(s.theme.smallTalk?.length, THEME_LIMITS.smallTalk);
  assert.equal(s.errors.length, 1);
});

test('invalid staff entries become {} placeholders at the same index', () => {
  const r = parseTheme({ staff: [{ role: 'x' }, { name: '  ' }, { name: 5 }, 'bob', null, { name: 'Ok' }] });
  assert.deepEqual(r.theme.staff, [{ role: 'x' }, {}, {}, {}, {}, { name: 'Ok' }]);
  assert.equal(r.errors.length, 4);
  assert.ok(r.errors[0]!.startsWith('staff[1].name'));
  assert.ok(r.errors[1]!.startsWith('staff[2].name'));
  assert.ok(r.errors[2]!.startsWith('staff[3]: expected an object'));
  assert.ok(r.errors[3]!.startsWith('staff[4]: expected an object'));
});

test('a bad staff[1] keeps staff[2] at index 2 and the result round-trips', () => {
  const r = parseTheme({ staff: [{ name: 'A' }, { name: 7 }, { name: 'C' }] });
  assert.equal(r.theme.staff?.[2]?.name, 'C');
  assert.equal(r.errors.length, 1);
  const again = parseTheme(JSON.parse(JSON.stringify(r.theme)));
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.theme, r.theme);
});

test('temps are positional too', () => {
  const r = parseTheme({ temps: [{ name: 'A' }, 'x', { name: 'C' }] });
  assert.deepEqual(r.theme.temps, [{ name: 'A' }, {}, { name: 'C' }]);
  assert.equal(r.errors.length, 1);
});

test('trimTrailingPlaceholders drops only trailing empty entries', () => {
  assert.deepEqual(trimTrailingPlaceholders([{}, { name: 'B' }, {}, {}]), [{}, { name: 'B' }]);
  assert.deepEqual(trimTrailingPlaceholders([{}, {}]), []);
});

test('nameless staff are fine', () => {
  const r = parseTheme({ staff: [{ role: 'Temp', look: { head: 'headset', outfit: 'polo' } }] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme.staff, [{ role: 'Temp', look: { head: 'headset', outfit: 'polo' } }]);
});

test('receptionist parses like manager', () => {
  const r = parseTheme({ receptionist: { name: ' Odette ', look: { head: 'receptionist', hair: '#ABCDEF', bad: 1 }, lines: ['Hello', '', 'Bye'], extra: 1 } });
  assert.deepEqual(r.theme.receptionist, { name: 'Odette', look: { head: 'receptionist', hair: '#abcdef' }, lines: ['Hello', 'Bye'] });
  assert.equal(r.errors.length, 1);
  const bad = parseTheme({ receptionist: 'x' });
  assert.equal(bad.theme.receptionist, undefined);
  assert.equal(bad.errors[0], 'receptionist: expected an object');
});

test('office colours: valid, invalid and unknown keys', () => {
  assert.equal(ROOM_COLOR_KEYS.length, 17);
  assert.equal(FURNITURE_COLOR_KEYS.length, 17);
  assert.deepEqual(OFFICE_COLOR_KEYS, [...ROOM_COLOR_KEYS, ...FURNITURE_COLOR_KEYS]);
  const r = parseTheme({ colors: { wall: '#ABCDEF', rug: 'red', carpet: '#fff', nope: '#000000', signText: 5 } });
  assert.deepEqual(r.theme.colors, { wall: '#abcdef' });
  assert.equal(r.errors.length, 4);
  assert.ok(r.errors.includes('colors.rug: expected a colour like #a1b2c3'));
  assert.ok(r.errors.some((e) => e.startsWith('colors.nope: unknown colour')));
  assert.equal(parseTheme({ colors: [] }).errors[0], 'colors: expected an object');
  const polluted = parseTheme(JSON.parse('{"colors":{"__proto__":{"a":1}}}'));
  assert.equal(polluted.theme.colors, undefined);
});

test('headset is a head style', () => {
  assert.ok((HEAD_STYLES as readonly string[]).includes('headset'));
  assert.deepEqual(parseTheme({ manager: { look: { head: 'headset' } } }).errors, []);
});

test('a non-array staff or temps is dropped with an error', () => {
  const r = parseTheme({ staff: { name: 'A' }, temps: 'x', smallTalk: 3 });
  assert.deepEqual(r.theme, {});
  assert.equal(r.errors.length, 3);
});

test('smallTalk entries must be [string, string]', () => {
  const r = parseTheme({ smallTalk: [['a', 'b'], ['only one'], ['a', 'b', 'c'], 'ab', ['a', 5], ['a', ' '], ['  hi ', ' there  ']] });
  assert.deepEqual(r.theme.smallTalk, [['a', 'b'], ['hi', 'there']]);
  assert.equal(r.errors.length, 5);
  assert.ok(r.errors[0]!.startsWith('smallTalk[1]: '));
});

test('pin handling', () => {
  const r = parseTheme({
    staff: [
      { name: 'A', pin: { project: ' api ' } },
      { name: 'B', pin: { title: 'fix' } },
      { name: 'C', pin: { project: 'p', title: 't', extra: 1 } },
      { name: 'D', pin: {} },
      { name: 'E', pin: { project: '', title: 5 } },
      { name: 'F', pin: 'api' },
      { name: 'G', pin: { project: 'x'.repeat(THEME_LIMITS.pin + 1) } },
      { name: 'H', pin: { project: 'x'.repeat(THEME_LIMITS.pin) } },
    ],
  });
  const pins = r.theme.staff?.map((s) => s.pin);
  assert.deepEqual(pins, [{ project: 'api' }, { title: 'fix' }, { project: 'p', title: 't' }, undefined, undefined, undefined, undefined, { project: 'x'.repeat(THEME_LIMITS.pin) }]);
  assert.equal(r.theme.staff?.length, 8, 'entries survive when only the pin is bad');
  assert.ok(r.errors.some((e) => e.startsWith('staff[3].pin: needs a project or a title')));
  assert.ok(r.errors.some((e) => e.startsWith('staff[5].pin: expected an object')));
});

test('prototype keys are rejected', () => {
  const polluted = JSON.parse('{"__proto__": {"polluted": true}, "company": "X"}') as unknown;
  const a = parseTheme(polluted);
  assert.deepEqual(a.theme, {});
  assert.equal(a.errors.length, 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const b = parseTheme(JSON.parse('{"staff":[{"name":"A","constructor":{"x":1}},{"name":"B","look":{"prototype":{},"hair":"#000000"}},{"name":"C","pin":{"__proto__":1,"project":"p"}}]}'));
  assert.deepEqual(b.theme.staff, [{}, { name: 'B' }, { name: 'C' }]);
  assert.equal(b.errors.length, 3);
  assert.ok(b.errors.every((e) => /not allowed/.test(e)));
  assert.equal(({} as Record<string, unknown>).x, undefined);

  const c = parseTheme(JSON.parse('{"manager":{"constructor":1,"name":"M"},"temps":[{"__proto__":{"a":1}}]}'));
  assert.deepEqual(c.theme, { temps: [{}] });
});

test('unknown keys are stripped from the output', () => {
  const r = parseTheme({
    $schema: 'x',
    wat: 1,
    company: 'C',
    manager: { name: 'M', extra: true, look: { hair: '#000000', unknown: 'x' } },
    staff: [{ name: 'A', nickname: 'a', look: { hat: 'top', head: 'cat' }, pin: { project: 'p', other: 1 } }],
    temps: [{ name: 'T', age: 3, look: { weird: 1 } }],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme, {
    company: 'C',
    manager: { name: 'M', look: { hair: '#000000' } },
    staff: [{ name: 'A', look: { head: 'cat' }, pin: { project: 'p' } }],
    temps: [{ name: 'T', look: {} }],
  });
});

test('output is freshly built, not the input', () => {
  const input = { staff: [{ name: 'A', look: { hair: '#000000' }, lines: ['hi'] }] };
  const r = parseTheme(input);
  assert.notEqual(r.theme.staff, input.staff);
  assert.notEqual(r.theme.staff?.[0]?.look, input.staff[0]!.look);
  assert.notEqual(r.theme.staff?.[0]?.lines, input.staff[0]!.lines);
});

// ---------------------------------------------------------------------------------------------------------------------
// Names, line pools, titles, side characters and furniture colours

test('the new key lists have the agreed members, and every pool has a kind and a description', () => {
  assert.deepEqual([...LINE_MODES], ['add', 'replace']);
  assert.deepEqual([...TITLE_KEYS], ['manager', 'receptionist', 'cleaner', 'temp', 'vendor', 'itSupport']);
  assert.deepEqual([...NPC_KEYS], ['cleaner', 'vendor', 'itFixer', 'itCritic']);
  assert.equal(LINE_POOL_KEYS.length, 28);
  assert.deepEqual(Object.keys(LINE_POOL_KIND), [...LINE_POOL_KEYS]);
  assert.deepEqual(Object.keys(LINE_POOL_INFO), [...LINE_POOL_KEYS]);
  assert.deepEqual(LINE_POOL_KEYS.filter((k) => LINE_POOL_KIND[k] === 'pairs'), ['itFixerTalk', 'itCriticTalk', 'bossPlanApproved', 'bossCommandApproved', 'bossEditApproved']);
  assert.deepEqual(LINE_POOL_KEYS.slice(-5), ['itFixerTalk', 'itCriticTalk', 'bossPlanApproved', 'bossCommandApproved', 'bossEditApproved'], 'pairs pools come last');
  for (const k of LINE_POOL_KEYS) {
    assert.ok(LINE_POOL_INFO[k].who.length > 0 && LINE_POOL_INFO[k].when.length > 0, k);
  }
  assert.deepEqual(LINE_POOL_INFO.itFix, { who: 'the IT fixer', when: 'the opening line of every fix' });
});

test('name and description: trimmed, bounded and optional', () => {
  const ok = parseTheme({ name: '  Pirate ship ', description: 'Arr, a ship.' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.theme, { name: 'Pirate ship', description: 'Arr, a ship.' });
  assert.deepEqual(parseTheme({ name: 'x'.repeat(THEME_LIMITS.name) }).errors, []);
  assert.equal(parseTheme({ name: 'x'.repeat(THEME_LIMITS.name + 1) }).errors[0], `name: too long (max ${THEME_LIMITS.name} characters)`);
  assert.deepEqual(parseTheme({ description: 'x'.repeat(THEME_LIMITS.description) }).errors, []);
  assert.equal(parseTheme({ description: 'x'.repeat(THEME_LIMITS.description + 1) }).errors[0], `description: too long (max ${THEME_LIMITS.description} characters)`);
  const bad = parseTheme({ name: 5, description: ' ' });
  assert.deepEqual(bad.theme, {});
  assert.deepEqual(bad.errors, ['name: expected text, got number', 'description: must not be empty']);
  assert.equal(THEME_LIMITS.description, 160);
});

test('lineMode: add or replace, anything else is dropped with an error', () => {
  for (const m of ['add', 'replace']) assert.deepEqual(parseTheme({ lineMode: m }), { theme: { lineMode: m }, errors: [] });
  for (const bad of ['Replace', 'swap', '', 1, null, true]) {
    const r = parseTheme({ lineMode: bad });
    assert.deepEqual(r.theme, {}, String(bad));
    assert.deepEqual(r.errors, ['lineMode: expected one of add, replace'], String(bad));
  }
});

test('lines: lines pools and pairs pools, every key valid', () => {
  const raw = {
    lines: {
      bossVisit: ['  Report, now. ', 'Chop chop.'],
      bossSnoop: ['No mistakes.'],
      itFixerTalk: [['Opener', ' Reply ']],
      itCriticTalk: [['Another opener', 'Another reply'], ['Third', 'Fourth']],
    },
  };
  const r = parseTheme(raw);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme.lines, {
    bossVisit: ['Report, now.', 'Chop chop.'],
    bossSnoop: ['No mistakes.'],
    itFixerTalk: [['Opener', 'Reply']],
    itCriticTalk: [['Another opener', 'Another reply'], ['Third', 'Fourth']],
  });
  assert.notEqual(r.theme.lines?.bossVisit, raw.lines.bossVisit, 'built fresh');
  // Every pool key is accepted, with the right kind of entry.
  const all = Object.fromEntries(LINE_POOL_KEYS.map((k) => [k, LINE_POOL_KIND[k] === 'pairs' ? [['a', 'b']] : ['a']]));
  const full = parseTheme({ lines: all });
  assert.deepEqual(full.errors, []);
  assert.deepEqual(Object.keys(full.theme.lines ?? {}), [...LINE_POOL_KEYS]);
  assert.deepEqual(parseTheme({ lines: {} }), { theme: { lines: {} }, errors: [] });
});

test('lines: unknown pool keys are errors and dropped; a non-object is dropped', () => {
  const r = parseTheme({ lines: { bossVisit: ['Hi'], nope: ['x'], bossVisits: ['x'] } });
  assert.deepEqual(r.theme.lines, { bossVisit: ['Hi'] });
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors[0]!.startsWith('lines.nope: unknown line pool (expected one of bossVisit, bossSnack'));
  assert.ok(r.errors[1]!.startsWith('lines.bossVisits: unknown line pool'));
  assert.deepEqual(parseTheme({ lines: ['x'] }), { theme: {}, errors: ['lines: expected an object'] });
  assert.deepEqual(parseTheme({ lines: 'x' }), { theme: {}, errors: ['lines: expected an object'] });
  const polluted = parseTheme(JSON.parse('{"lines":{"__proto__":{"a":1}}}'));
  assert.equal(polluted.theme.lines, undefined);
  assert.ok(polluted.errors[0]!.includes('not allowed'));
});

test('lines: bad pool shapes and entries', () => {
  const wrong = parseTheme({ lines: { bossVisit: 'Hi', itFixerTalk: ['a', 'b'], cartCalls: [['a', 'b']], itSneers: { a: 1 } } });
  assert.deepEqual(wrong.theme.lines, { itFixerTalk: [], cartCalls: [] });
  assert.equal(wrong.errors[0], 'lines.bossVisit: expected a list of text lines');
  assert.ok(wrong.errors.includes('lines.itFixerTalk[0]: expected a pair of two text lines'));
  assert.ok(wrong.errors.includes('lines.cartCalls[0]: expected text, got an array'));
  assert.ok(wrong.errors.includes('lines.itSneers: expected a list of text lines'));
  const mixed = parseTheme({ lines: { bossSulk: ['ok', '', 5, '  ', 'fine'], itFixerTalk: [['a', 'b'], ['only'], ['a', 5], ['a', ' '], ['c', 'd']] } });
  assert.deepEqual(mixed.theme.lines, { bossSulk: ['ok', 'fine'], itFixerTalk: [['a', 'b'], ['c', 'd']] });
  assert.equal(mixed.errors.length, 3 + 3);
  assert.ok(mixed.errors.includes('lines.bossSulk[1]: must not be empty'));
  assert.ok(mixed.errors.includes('lines.itFixerTalk[1]: expected a pair of two text lines'));
  assert.ok(mixed.errors.includes('lines.itFixerTalk[2][1]: expected text, got number'));
});

test('lines: a line is at most 80 characters, a pool at most 60 lines or pairs', () => {
  const long = parseTheme({ lines: { bossVisit: ['x'.repeat(THEME_LIMITS.line), 'x'.repeat(THEME_LIMITS.line + 1)], itFixerTalk: [['a', 'x'.repeat(THEME_LIMITS.line + 1)]] } });
  assert.equal(long.theme.lines?.bossVisit?.length, 1);
  assert.deepEqual(long.theme.lines?.itFixerTalk, []);
  assert.deepEqual(long.errors, [
    `lines.bossVisit[1]: too long (max ${THEME_LIMITS.line} characters)`,
    `lines.itFixerTalk[0][1]: too long (max ${THEME_LIMITS.line} characters)`,
  ]);
  const many = parseTheme({
    lines: {
      cartCalls: Array.from({ length: THEME_LIMITS.lines + 5 }, (_, i) => `call ${i}`),
      itCriticTalk: Array.from({ length: THEME_LIMITS.lines + 5 }, (_, i) => [`a${i}`, `b${i}`]),
    },
  });
  assert.equal(many.theme.lines?.cartCalls?.length, THEME_LIMITS.lines);
  assert.equal(many.theme.lines?.itCriticTalk?.length, THEME_LIMITS.lines);
  assert.deepEqual(many.errors, [
    `lines.cartCalls: only the first ${THEME_LIMITS.lines} lines are used; 5 dropped`,
    `lines.itCriticTalk: only the first ${THEME_LIMITS.lines} entries are used; 5 dropped`,
  ]);
  const exact = parseTheme({ lines: { cartCalls: Array.from({ length: THEME_LIMITS.lines }, (_, i) => `c${i}`) } });
  assert.deepEqual(exact.errors, []);
});

test('smallTalk is allowed up to 200 pairs now', () => {
  assert.equal(THEME_LIMITS.smallTalk, 200);
  const r = parseTheme({ smallTalk: Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`]) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.theme.smallTalk?.length, 200);
  const over = parseTheme({ smallTalk: Array.from({ length: 203 }, () => ['a', 'b']) });
  assert.equal(over.theme.smallTalk?.length, 200);
  assert.deepEqual(over.errors, ['smallTalk: only the first 200 entries are used; 3 dropped']);
  // The pairs pools in `lines` keep the lower cap.
  assert.equal(parseTheme({ lines: { itFixerTalk: Array.from({ length: 61 }, () => ['a', 'b']) } }).theme.lines?.itFixerTalk?.length, 60);
});

test('titles: each key is trimmed text of at most 40 characters; unknown keys are errors', () => {
  const r = parseTheme({ titles: { manager: ' Captain ', receptionist: 'Purser', cleaner: 'Deckhand', temp: 'Cabin boy', vendor: 'Cook', itSupport: 'Engineer' } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme.titles, { manager: 'Captain', receptionist: 'Purser', cleaner: 'Deckhand', temp: 'Cabin boy', vendor: 'Cook', itSupport: 'Engineer' });
  assert.deepEqual(parseTheme({ titles: { manager: 'x'.repeat(40) } }).errors, []);
  assert.equal(THEME_LIMITS.title, 40);
  const bad = parseTheme({ titles: { manager: 'x'.repeat(41), cleaner: '', temp: 3, boss: 'Chief', itSupport: 'Fine' } });
  assert.deepEqual(bad.theme.titles, { itSupport: 'Fine' });
  assert.deepEqual(bad.errors, [
    'titles.manager: too long (max 40 characters)',
    'titles.cleaner: must not be empty',
    'titles.temp: expected text, got number',
    'titles.boss: unknown title (expected one of manager, receptionist, cleaner, temp, vendor, itSupport)',
  ]);
  assert.deepEqual(parseTheme({ titles: 'Captain' }), { theme: {}, errors: ['titles: expected an object'] });
  assert.deepEqual(parseTheme({ titles: {} }), { theme: { titles: {} }, errors: [] });
});

test('cleaner, vendor, itFixer and itCritic: a name and a look, nothing else', () => {
  const r = parseTheme({
    cleaner: { name: ' Mop ', look: { head: 'short', hair: '#ABCDEF', bad: 1 }, lines: ['no lines here'], extra: true },
    vendor: { name: 'Cook' },
    itFixer: { look: { outfit: 'vest' } },
    itCritic: {},
  });
  assert.deepEqual(r.theme, {
    cleaner: { name: 'Mop', look: { head: 'short', hair: '#abcdef' } },
    vendor: { name: 'Cook' },
    itFixer: { look: { outfit: 'vest' } },
    itCritic: {},
  });
  assert.deepEqual(r.errors, []);
  const bad = parseTheme({ cleaner: 'x', vendor: { name: 5 }, itFixer: { name: 'y'.repeat(41), look: { head: 'nope' } }, itCritic: { look: [] } });
  assert.deepEqual(bad.theme, { vendor: {}, itFixer: { look: {} }, itCritic: {} });
  assert.deepEqual(bad.errors, [
    'cleaner: expected an object',
    'vendor.name: expected text, got number',
    'itFixer.name: too long (max 40 characters)',
    `itFixer.look.head: expected one of ${HEAD_STYLES.join(', ')}`,
    'itCritic.look: expected an object',
  ]);
  const polluted = parseTheme(JSON.parse('{"itCritic":{"constructor":1,"name":"N"}}'));
  assert.deepEqual(polluted.theme, {});
});

test('furniture colours are valid colour keys', () => {
  const r = parseTheme({ colors: { desks: '#ABCDEF', outside: '#000000', skyline: 'blue', screens: '#12345' } });
  assert.deepEqual(r.theme.colors, { desks: '#abcdef', outside: '#000000' });
  assert.deepEqual(r.errors, ['colors.skyline: expected a colour like #a1b2c3', 'colors.screens: expected a colour like #a1b2c3']);
  const all = parseTheme({ colors: Object.fromEntries(FURNITURE_COLOR_KEYS.map((k) => [k, '#0a0b0c'])) });
  assert.deepEqual(all.errors, []);
  assert.deepEqual(Object.keys(all.theme.colors ?? {}), [...FURNITURE_COLOR_KEYS]);
});

test('a full new-style theme parses clean and round-trips; unknown top-level keys are still dropped', () => {
  const raw = {
    $schema: 'x',
    name: 'Lighthouse crew',
    description: 'A quiet shift on the rocks.',
    lineMode: 'replace',
    company: 'Beacon Co',
    lines: { bossVisit: ['Keep the lamp lit.'], itFixerTalk: [['Tide is in.', 'So it is.']] },
    titles: { manager: 'Keeper' },
    cleaner: { name: 'Mop' },
    colors: { wall: '#aabbcc', desks: '#112233' },
    smallTalk: [['a', 'b']],
    wat: 1,
  };
  const r = parseTheme(raw);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.theme), ['name', 'description', 'company', 'lineMode', 'cleaner', 'titles', 'lines', 'colors', 'smallTalk']);
  const again = parseTheme(JSON.parse(JSON.stringify(r.theme)));
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.theme, r.theme);
});

test('legacy themes parse exactly as before', () => {
  const r = parseTheme({
    company: 'Acme',
    manager: { name: 'Pat', lines: ['Hi'] },
    receptionist: { lines: ['Hello'] },
    colors: { wall: '#aabbcc' },
    smallTalk: [['a', 'b']],
    staff: [{ name: 'A', lines: ['x'] }],
    temps: [{ name: 'T' }],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme, {
    company: 'Acme',
    manager: { name: 'Pat', lines: ['Hi'] },
    receptionist: { lines: ['Hello'] },
    colors: { wall: '#aabbcc' },
    smallTalk: [['a', 'b']],
    staff: [{ name: 'A', lines: ['x'] }],
    temps: [{ name: 'T' }],
  });
  for (const key of ['name', 'description', 'lineMode', 'lines', 'titles', 'cleaner', 'vendor', 'itFixer', 'itCritic'] as const) {
    assert.equal(key in r.theme, false, key);
  }
});
