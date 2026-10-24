import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_LIMITS } from '../src/shared/theme.ts';
import { themePromptPaths, themePromptText } from '../src/host/themePrompt.ts';

const input = {
  themesDir: '/home/a b/.middle-management/themes',
  schemaPath: '/opt/my ext/media/theme.schema.json',
  guidePath: '/opt/my ext/media/theme-guide.md',
  examplePath: '/opt/my ext/media/themes/spaceship.theme.json',
};
const text = themePromptText(input);

test('the first line is exact and followed by a blank line', () => {
  const lines = text.split('\n');
  assert.equal(lines[0], 'Make me a theme for Middle Management that: [describe your office here]');
  assert.equal(lines[1], '');
});

test('all paths appear verbatim, including ones with spaces', () => {
  for (const p of Object.values(input)) assert.ok(text.includes(p), p);
});

test('the text is printable ASCII plus newlines', () => {
  assert.match(text, /^[\x20-\x7e\n]+$/);
});

test('it mentions the key terms', () => {
  for (const w of ['lineMode', 'replace', 'name', 'description', 'Your offices']) assert.ok(text.includes(w), w);
});

test('the numbers match THEME_LIMITS', () => {
  const L = THEME_LIMITS;
  for (const s of [`${L.name} characters`, `${L.line} is the hard limit`, `${L.staff} staff and ${L.temps} temps`, `${L.lines} lines`, `${L.smallTalk}`, `${L.title} characters`]) {
    assert.ok(text.includes(s), s);
  }
});

test('themePromptPaths joins under the extension folder', () => {
  assert.deepEqual(themePromptPaths('/ext dir'), {
    schemaPath: '/ext dir/media/theme.schema.json',
    guidePath: '/ext dir/media/theme-guide.md',
    examplePath: '/ext dir/media/themes/spaceship.theme.json',
  });
});

test('it carries no show words', () => {
  const lower = text.toLowerCase();
  for (const w of ['dunder', 'mifflin', 'scranton', 'michael scott', 'dwight', 'reynholm']) assert.ok(!lower.includes(w), w);
});
