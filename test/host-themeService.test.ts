import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThemeService } from '../src/host/themeService.ts';
import type { ThemeChange, ThemeServiceDeps } from '../src/host/themeService.ts';

const PRESET_DIR = join(import.meta.dirname, '..', 'media', 'themes');
const MIN_THEME = (company: string): string => JSON.stringify({ company });

function setup(initial = '') {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const logs: string[] = [];
  const changes: ThemeChange[] = [];
  const state = { setting: initial, base: undefined as string | undefined };
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const deps: ThemeServiceDeps = {
    // Preset files come from the real packaged folder; everything else from the in-memory map.
    readFile: async (p) => {
      const f = files.get(p);
      if (f) return f.text;
      if (p.startsWith(PRESET_DIR)) return readFileSync(p, 'utf8');
      throw enoent();
    },
    stat: async (p) => {
      const f = files.get(p);
      if (f) return { mtimeMs: f.mtimeMs, size: f.text.length };
      if (p.startsWith(PRESET_DIR)) return { mtimeMs: 1, size: readFileSync(p).length };
      throw enoent();
    },
    homeDir: () => '/home/u',
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    log: (l) => logs.push(l),
    setting: () => state.setting,
    baseDir: () => state.base,
    presetDir: () => PRESET_DIR,
  };
  const svc = new ThemeService(deps, (c) => changes.push(c));
  /** Run the timer chain until the watcher's first load has been delivered. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      const t = timers.shift();
      if (t) t.fn();
      for (let j = 0; j < 10; j++) await new Promise((r) => setImmediate(r));
    }
  };
  return { svc, files, logs, changes, state, settle, timers };
}

test('the built-in office: no path is watched and nothing is loaded', async () => {
  const h = setup('');
  h.svc.applyThemePath();
  await h.settle();
  assert.equal(h.svc.source().kind, 'builtin');
  assert.equal(h.svc.lastLoad(), undefined);
  assert.equal(h.svc.currentTheme(), undefined);
  assert.equal(h.changes.length, 0);
});

test('preset:example loads the packaged example office with no errors', async () => {
  const h = setup('preset:example');
  h.svc.applyThemePath();
  assert.equal(h.svc.source().kind, 'preset');
  assert.equal(h.svc.source().path, join(PRESET_DIR, 'example.theme.json'));
  await h.settle();
  const load = h.svc.lastLoad();
  assert.ok(load, 'a load was delivered');
  assert.deepEqual(load.errors, []);
  assert.equal(load.path, join(PRESET_DIR, 'example.theme.json'));
  assert.equal(h.svc.currentTheme()?.company, 'Pennywhistle Paper');
  assert.equal(h.changes.at(-1)?.kind, 'load');
});

test('a bad or unknown preset id falls back to the built-in office and logs the reason once', async () => {
  for (const setting of ['preset:nope', 'preset:../../etc', 'preset:']) {
    const h = setup(setting);
    h.svc.applyThemePath();
    h.svc.applyThemePath();
    await h.settle();
    const src = h.svc.source();
    assert.equal(src.kind, 'builtin', setting);
    assert.match((src as { error?: string }).error ?? '', /using the built-in office/);
    assert.equal(h.logs.length, 1, 'logged once');
    assert.equal(h.svc.lastLoad(), undefined);
    assert.equal(h.svc.currentTheme(), undefined);
  }
});

test('a file theme: the load sets currentTheme; a later broken load keeps the last good theme', async () => {
  const h = setup('/themes/a.json');
  h.files.set('/themes/a.json', { text: MIN_THEME('Acme'), mtimeMs: 1 });
  h.svc.applyThemePath();
  await h.settle();
  assert.equal(h.svc.currentTheme()?.company, 'Acme');
  h.files.set('/themes/a.json', { text: '{ broken', mtimeMs: 2 });
  await h.svc.reloadNow();
  assert.equal(h.svc.lastLoad()?.theme, undefined);
  assert.ok((h.svc.lastLoad()?.errors.length ?? 0) > 0);
  assert.equal(h.svc.currentTheme()?.company, 'Acme', 'last good theme stays');
  // The broken file is fixed.
  h.files.set('/themes/a.json', { text: MIN_THEME('Beta'), mtimeMs: 3 });
  await h.svc.reloadNow();
  assert.equal(h.svc.currentTheme()?.company, 'Beta');
  assert.deepEqual(h.changes.map((c) => c.kind), ['load', 'load', 'load']);
});

test('switching the setting to empty clears the theme and the load, and says so once', async () => {
  const h = setup('/themes/a.json');
  h.files.set('/themes/a.json', { text: MIN_THEME('Acme'), mtimeMs: 1 });
  h.svc.applyThemePath();
  await h.settle();
  h.state.setting = '';
  h.svc.applyThemePath();
  assert.equal(h.svc.currentTheme(), undefined);
  assert.equal(h.svc.lastLoad(), undefined);
  assert.equal(h.changes.at(-1)?.kind, 'cleared');
  const n = h.changes.length;
  h.svc.applyThemePath();
  assert.equal(h.changes.length, n, 'nothing more to clear');
});

test('switching from a file to a preset loads the preset and replaces the theme', async () => {
  const h = setup('/themes/a.json');
  h.files.set('/themes/a.json', { text: MIN_THEME('Acme'), mtimeMs: 1 });
  h.svc.applyThemePath();
  await h.settle();
  h.state.setting = 'preset:example';
  h.svc.applyThemePath();
  await h.settle();
  assert.equal(h.svc.currentTheme()?.company, 'Pennywhistle Paper');
  assert.equal(h.svc.lastLoad()?.path, join(PRESET_DIR, 'example.theme.json'));
});

test('a relative path resolves against the workspace folder', async () => {
  const h = setup('t/x.json');
  h.state.base = '/work/proj';
  h.svc.applyThemePath();
  assert.equal(h.svc.source().kind, 'file');
  assert.equal(h.svc.source().path, join('/work/proj', 't/x.json'));
});

test('polling only while visible; dispose stops everything', async () => {
  const h = setup('/themes/a.json');
  h.files.set('/themes/a.json', { text: MIN_THEME('Acme'), mtimeMs: 1 });
  h.svc.applyThemePath();
  await h.settle(); // first load happens even while hidden
  assert.equal(h.timers.length, 0, 'no timers while hidden');
  h.svc.setVisible(true);
  assert.equal(h.timers.length, 1);
  h.svc.setVisible(false);
  assert.equal(h.timers.length, 0);
  h.svc.setVisible(true);
  h.svc.dispose();
  assert.equal(h.timers.length, 0);
});
