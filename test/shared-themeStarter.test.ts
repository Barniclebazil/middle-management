import { test } from 'node:test';
import assert from 'node:assert/strict';
import { starterTheme, starterThemeObject } from '../src/shared/themeStarter.ts';
import { parseTheme, OFFICE_COLOR_KEYS, TITLE_KEYS, LINE_POOL_KEYS } from '../src/shared/theme.ts';
import { serializeTheme } from '../src/host/themeWriter.ts';
import { dropReport, draftFrom } from '../webview/engine/frontDeskLogic.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { readFileSync } from 'node:fs';
import { CLASSIC_TALK } from '../webview/engine/smallTalk/classics.ts';

test('the starter parses with no errors and fills every slot', () => {
  const text = starterTheme('/ext/media/theme.schema.json');
  const raw = JSON.parse(text) as Record<string, unknown>;
  assert.equal(raw.$schema, '/ext/media/theme.schema.json');
  const { theme, errors } = parseTheme(raw);
  assert.deepEqual(errors, []);
  assert.equal(theme.company, 'Middle Management');
  assert.equal(theme.branch, 'Riverside Branch');
  assert.equal(theme.manager?.name, 'You');
  assert.equal(theme.manager?.lines?.length, 40);
  assert.equal(theme.smallTalk?.length, 16);
  assert.equal(theme.staff?.length, 8);
  assert.equal(theme.temps?.length, 6);
  assert.deepEqual(theme.staff?.map((s) => s.name), ['Staff 1', 'Staff 2', 'IT Help Desk', 'Staff 4', 'Staff 5', 'Staff 6', 'Staff 7', 'Staff 8']);
  assert.ok(text.endsWith('\n'));
});

test('the starter small talk is exactly the classic pairs (smallTalk/classics.ts)', () => {
  const { theme } = parseTheme(JSON.parse(starterTheme('/s.json')));
  assert.deepEqual(theme.smallTalk, CLASSIC_TALK.map(([a, b]) => [a, b]));
});

test('the starter has a receptionist and every colour', () => {
  const { theme, errors } = parseTheme(JSON.parse(starterTheme('/s.json')));
  assert.deepEqual(errors, []);
  assert.equal(theme.receptionist?.look?.head, 'receptionist');
  assert.equal(theme.staff?.[2]?.look?.head, 'headset');
  assert.equal(OFFICE_COLOR_KEYS.length, 34);
  assert.deepEqual(Object.keys(theme.colors ?? {}).sort(), [...OFFICE_COLOR_KEYS].sort());
});

test('the starter keeps odd schema paths intact', () => {
  const p = 'C:\\Users\\a b\\ext\\media\\theme.schema.json';
  assert.equal((JSON.parse(starterTheme(p)) as { $schema: string }).$schema, p);
});

test('the canonical starter equals serializeTheme of itself and has no absolute $schema', () => {
  const first = serializeTheme(starterThemeObject());
  assert.ok(first.ok);
  const again = serializeTheme(JSON.parse(first.text));
  assert.ok(again.ok);
  assert.equal(again.text, first.text, 're-serialising is a no-op');
  assert.ok(!('$schema' in JSON.parse(first.text)));
  assert.ok(!/file:\/\//.test(first.text));
  assert.ok(!first.text.includes('"lines": []'), 'empty lines are not written');
});

test('the formatting check reports nothing for a fresh starter or a Save as of the example preset', () => {
  const starter = serializeTheme(starterThemeObject());
  assert.ok(starter.ok);
  assert.deepEqual(dropReport(starter.text, draftFrom(starter.theme)), []);
  const preset = JSON.parse(readFileSync(new URL('../media/themes/example.theme.json', import.meta.url), 'utf8')) as unknown;
  const copy = serializeTheme(preset);
  assert.ok(copy.ok);
  assert.ok(!copy.text.includes('"$schema"'));
  assert.deepEqual(dropReport(copy.text, draftFrom(copy.theme)), []);
});

test('the starter names itself, adds to the built-in lines, and shows every title and line pool', () => {
  const { theme, errors } = parseTheme(starterThemeObject());
  assert.deepEqual(errors, []);
  assert.equal(theme.name, 'My office');
  assert.ok((theme.description ?? '').length > 0);
  assert.equal(theme.lineMode, 'add');
  assert.deepEqual(Object.keys(theme.titles ?? {}).sort(), [...TITLE_KEYS].sort());
  for (const k of LINE_POOL_KEYS) assert.ok((theme.lines?.[k]?.length ?? 0) > 0, `lines.${k} is empty`);
  assert.equal(theme.itFixer?.name, 'Dez');
  assert.equal(theme.itCritic?.name, 'Fenwick');
  assert.equal(theme.cleaner, undefined);
  assert.equal(theme.vendor, undefined);
});

test('the starter has all 34 colours and serialises under the theme size limit', () => {
  const { theme } = parseTheme(starterThemeObject());
  assert.equal(OFFICE_COLOR_KEYS.length, 34);
  assert.deepEqual(Object.keys(theme.colors ?? {}).sort(), [...OFFICE_COLOR_KEYS].sort());
  const written = serializeTheme(starterThemeObject());
  assert.ok(written.ok, 'serializeTheme failed');
  assert.ok(written.text.length < LIMITS.themeJsonChars, `${written.text.length} chars`);
  assert.deepEqual(parseTheme(JSON.parse(written.text)).errors, []);
});
