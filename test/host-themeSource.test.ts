import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PRESETS, findPreset, presetSetting, resolveThemeSource, shortenHome } from '../src/host/themeSource.ts';

const HOME = '/home/u';
const WS = '/ws';
const PRESET_DIR = '/ext/media/themes';

test('PRESETS holds the six packaged offices and every id is well formed', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['example', 'spaceship', 'construction-site', 'metalwork-factory', 'cyberpunk', 'steampunk']);
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z0-9-]{1,40}$/);
    assert.match(p.file, /^[A-Za-z0-9.-]+\.json$/);
    assert.ok(p.label !== '' && p.description !== '');
  }
  assert.equal(findPreset('example')?.file, 'example.theme.json');
  assert.equal(findPreset('nope'), undefined);
  assert.equal(presetSetting('example'), 'preset:example');
});

test('empty setting is the built-in office', () => {
  for (const s of ['', '   ', '\t']) {
    const r = resolveThemeSource(s, HOME, WS, PRESET_DIR);
    assert.equal(r.kind, 'builtin');
    assert.equal(r.path, '');
    assert.equal(r.displayPath, '');
    assert.equal(r.kind === 'builtin' ? r.error : 'x', undefined);
  }
});

test('preset:example resolves to a path inside the preset folder', () => {
  const r = resolveThemeSource('preset:example', HOME, WS, PRESET_DIR);
  assert.equal(r.kind, 'preset');
  assert.equal(r.kind === 'preset' ? r.presetId : '', 'example');
  assert.equal(r.path, '/ext/media/themes/example.theme.json');
  assert.equal(r.label, 'Example office');
  assert.equal(r.displayPath, 'preset:example');
  assert.equal(resolveThemeSource('  preset:example  ', HOME, WS, PRESET_DIR).kind, 'preset');
});

test('every preset resolves to its file inside the preset folder', () => {
  for (const p of PRESETS) {
    const r = resolveThemeSource('preset:' + p.id, HOME, WS, PRESET_DIR);
    assert.equal(r.kind, 'preset', p.id);
    assert.equal(r.path, join(PRESET_DIR, p.file), p.id);
    assert.equal(r.displayPath, 'preset:' + p.id, p.id);
  }
});

test('unknown or malformed preset ids fall back to builtin with an error and never become a path', () => {
  const bad = ['preset:nope', 'preset:../x', 'preset:EXAMPLE', 'preset:', 'preset:example.theme.json', 'preset:a/b', 'preset:' + 'a'.repeat(41), 'preset:exa mple', 'preset:/etc/passwd'];
  for (const s of bad) {
    const r = resolveThemeSource(s, HOME, WS, PRESET_DIR);
    assert.equal(r.kind, 'builtin', s);
    assert.equal(r.path, '', s);
    assert.ok(r.kind === 'builtin' && typeof r.error === 'string' && r.error.length > 0, s);
  }
  // A well-formed id of 40 characters is valid shape but still unknown.
  const r = resolveThemeSource('preset:' + 'a'.repeat(40), HOME, WS, PRESET_DIR);
  assert.match(r.kind === 'builtin' ? (r.error ?? '') : '', /unknown preset/);
  // Only the exact prefix counts: "Preset:example" is just a (relative) file name.
  assert.equal(resolveThemeSource('Preset:example', HOME, WS, PRESET_DIR).kind, 'file');
});

test('file settings: absolute, ~ and relative paths', () => {
  const abs = resolveThemeSource('/abs/dir/t.json', HOME, WS, PRESET_DIR);
  assert.equal(abs.kind, 'file');
  assert.equal(abs.path, '/abs/dir/t.json');
  assert.equal(abs.label, 't.json');
  assert.equal(abs.displayPath, '/abs/dir/t.json');

  const home = resolveThemeSource('~/offices/mine.json', HOME, WS, PRESET_DIR);
  assert.equal(home.path, '/home/u/offices/mine.json');
  assert.equal(home.displayPath, '~/offices/mine.json');
  assert.equal(home.label, 'mine.json');

  const rel = resolveThemeSource('themes/x.json', HOME, WS, PRESET_DIR);
  assert.equal(rel.path, '/ws/themes/x.json');
  assert.equal(rel.displayPath, '/ws/themes/x.json');

  const noBase = resolveThemeSource('x.json', HOME, undefined, PRESET_DIR);
  assert.equal(noBase.path, '/home/u/x.json');
  assert.equal(noBase.displayPath, '~/x.json');
  assert.equal(resolveThemeSource('x.json', HOME, '', PRESET_DIR).path, '/home/u/x.json');
});

test('shortenHome: home itself, siblings with the same prefix, trailing slash, Windows-style paths', () => {
  assert.equal(shortenHome('/home/u', '/home/u'), '~');
  assert.equal(shortenHome('/home/u/a/b.json', '/home/u'), '~/a/b.json');
  assert.equal(shortenHome('/home/u/a', '/home/u/'), '~/a');
  assert.equal(shortenHome('/home/user/a.json', '/home/u'), '/home/user/a.json');
  assert.equal(shortenHome('/etc/a.json', '/home/u'), '/etc/a.json');
  assert.equal(shortenHome('/a', ''), '/a');
  assert.equal(shortenHome('C:\\Users\\u\\t.json', 'C:\\Users\\u'), '~\\t.json');
  assert.equal(shortenHome('c:\\users\\U\\t.json', 'C:\\Users\\u'), '~\\t.json');
  assert.equal(shortenHome('C:\\Users\\user\\t.json', 'C:\\Users\\u'), 'C:\\Users\\user\\t.json');
});

test('Windows-style file paths keep their label and are shortened against a Windows home', () => {
  const r = resolveThemeSource('C:\\Users\\u\\Docs\\office.json', 'C:\\Users\\u', 'C:\\ws', PRESET_DIR);
  assert.equal(r.kind, 'file');
  assert.equal(r.label, 'office.json');
});
