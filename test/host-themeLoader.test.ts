import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThemeWatcher, expandHome, loadThemeFile, resolveThemePath } from '../src/host/themeLoader.ts';
import type { ThemeLoadResult, ThemeLoaderDeps } from '../src/host/themeLoader.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OFFICE_COLOR_KEYS, parseTheme } from '../src/shared/theme.ts';
import { revisionOf } from '../src/host/themeWriter.ts';
import { PRESETS } from '../src/host/themeSource.ts';
import { join } from 'node:path';

class FakeTime {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  timersApi = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.t + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown): void => void this.timers.delete(h as number),
  };
  get pending(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
    await new Promise((r) => setImmediate(r));
  }
}

interface FakeFile {
  text: string;
  mtimeMs: number;
  size: number;
}

function setup() {
  const time = new FakeTime();
  const files = new Map<string, FakeFile>();
  const logs: string[] = [];
  const stats = { n: 0, reads: 0, active: 0, maxActive: 0, delay: false };
  const results: ThemeLoadResult[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
  const deps: ThemeLoaderDeps = {
    readFile: async (p) => {
      stats.reads++;
      const f = files.get(p);
      if (!f) throw enoent(p);
      return f.text;
    },
    stat: async (p) => {
      stats.n++;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      if (stats.delay) await new Promise((r) => setImmediate(r));
      stats.active--;
      const f = files.get(p);
      if (!f) throw enoent(p);
      return { mtimeMs: f.mtimeMs, size: f.size };
    },
    homeDir: () => '/home/u',
    timers: time.timersApi,
    log: (l) => logs.push(l),
  };
  const put = (p: string, text: string, mtimeMs = time.t + 1) => files.set(p, { text, mtimeMs, size: text.length });
  const watcher = new ThemeWatcher(deps, (r) => results.push(r));
  return { deps, time, files, logs, stats, results, put, watcher };
}

test('expandHome handles ~ and ~/x only', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/a/b.json', '/home/u'), '/home/u/a/b.json');
  assert.equal(expandHome('~/a', '/home/u/'), '/home/u/a');
  assert.equal(expandHome('~other/a', '/home/u'), '~other/a');
  assert.equal(expandHome('/x/~/y', '/home/u'), '/x/~/y');
  assert.equal(expandHome('', '/home/u'), '');
});

test('resolveThemePath: absolute, home, relative and empty', () => {
  assert.equal(resolveThemePath('/abs/t.json', '/home/u', '/ws'), '/abs/t.json');
  assert.equal(resolveThemePath('~/x.json', '/home/u', '/ws'), '/home/u/x.json');
  assert.equal(resolveThemePath('~', '/home/u', '/ws'), '/home/u');
  assert.equal(resolveThemePath('x/y.json', '/home/u', '/ws'), join('/ws', 'x', 'y.json'));
  assert.equal(resolveThemePath('x/y.json', '/home/u', undefined), join('/home/u', 'x', 'y.json'));
  assert.equal(resolveThemePath('x/y.json', '/home/u', ''), join('/home/u', 'x', 'y.json'));
  assert.equal(resolveThemePath('', '/home/u', '/ws'), '');
  assert.equal(resolveThemePath('   ', '/home/u', '/ws'), '');
  assert.equal(resolveThemePath(' t.json ', '/home/u', '/ws'), join('/ws', 't.json'));
});

test('loadThemeFile: missing file', async () => {
  const s = setup();
  const r = await loadThemeFile('/nope.json', s.deps);
  assert.equal(r.theme, undefined);
  assert.deepEqual(r.errors, ['theme: file not found: /nope.json']);
  assert.equal(r.path, '/nope.json');
});

test('loadThemeFile: unreadable file', async () => {
  const r = await loadThemeFile('/x', { readFile: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) });
  assert.equal(r.theme, undefined);
  assert.deepEqual(r.errors, ['theme: could not read /x: denied']);
});

test('loadThemeFile: invalid JSON', async () => {
  const s = setup();
  s.put('/t.json', '{ "company": ');
  const r = await loadThemeFile('/t.json', s.deps);
  assert.equal(r.theme, undefined);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /^theme: not valid JSON: .+/);
});

test('loadThemeFile: invalid theme gives errors and a partial theme', async () => {
  const s = setup();
  s.put('/t.json', JSON.stringify({ company: 'Acme', staff: [{ name: 'Ann', look: { hair: 'red' } }] }));
  const r = await loadThemeFile('/t.json', s.deps);
  assert.equal(r.theme?.company, 'Acme');
  assert.equal(r.theme?.staff?.[0]?.name, 'Ann');
  assert.deepEqual(r.errors, ['staff[0].look.hair: expected a colour like #a1b2c3']);
});

test('loadThemeFile: valid theme, with a byte order mark', async () => {
  const s = setup();
  s.put('/t.json', '﻿' + JSON.stringify({ company: 'Acme', branch: 'North' }));
  const r = await loadThemeFile('/t.json', s.deps);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.theme, { company: 'Acme', branch: 'North' });
});

test('watcher loads once on setPath and reloads only when mtime or size change', async () => {
  const s = setup();
  s.put('/home/u/t.json', '{"company":"A"}', 100);
  s.watcher.setVisible(true);
  s.watcher.setPath('~/t.json');
  await s.time.advance(10);
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0]!.path, '/home/u/t.json');
  assert.equal(s.results[0]!.theme?.company, 'A');
  await s.time.advance(10_000);
  assert.equal(s.results.length, 1);
  assert.equal(s.stats.reads, 1);
  assert.ok(s.stats.n >= 5);
  // Touch with new mtime.
  s.put('/home/u/t.json', '{"company":"B"}', 200);
  await s.time.advance(2100);
  assert.equal(s.results.length, 2);
  assert.equal(s.results[1]!.theme?.company, 'B');
  // Same mtime, different size: still reloads.
  s.files.set('/home/u/t.json', { text: '{"company":"CC"}', mtimeMs: 200, size: 999 });
  await s.time.advance(2100);
  assert.equal(s.results.length, 3);
  assert.equal(s.results[2]!.theme?.company, 'CC');
  s.watcher.dispose();
});

test('a missing file is reported once, then again when it appears', async () => {
  const s = setup();
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  await s.time.advance(6000);
  assert.equal(s.results.length, 1);
  assert.deepEqual(s.results[0]!.errors, ['theme: file not found: /t.json']);
  s.put('/t.json', '{"branch":"X"}');
  await s.time.advance(2100);
  assert.equal(s.results.length, 2);
  assert.equal(s.results[1]!.theme?.branch, 'X');
  s.watcher.dispose();
});

test('clearing the path stops polling; hiding pauses it and showing checks at once', async () => {
  const s = setup();
  s.put('/t.json', '{}', 1);
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  await s.time.advance(5000);
  const polled = s.stats.n;
  s.watcher.setVisible(false);
  assert.equal(s.time.pending, 0);
  s.put('/t.json', '{"company":"Z"}', 5);
  await s.time.advance(10_000);
  assert.equal(s.stats.n, polled);
  assert.equal(s.results.length, 1);
  s.watcher.setVisible(true);
  await s.time.advance(10);
  assert.equal(s.results.length, 2);
  s.watcher.setPath('');
  assert.equal(s.time.pending, 0);
  const n = s.stats.n;
  await s.time.advance(10_000);
  assert.equal(s.stats.n, n);
  assert.equal(s.results.length, 2);
  s.watcher.dispose();
});

test('hidden watcher still loads once on setPath, then idles', async () => {
  const s = setup();
  s.put('/t.json', '{"company":"H"}', 1);
  s.watcher.setPath('/t.json');
  await s.time.advance(10_000);
  assert.equal(s.results.length, 1);
  assert.equal(s.stats.n, 1);
  assert.equal(s.time.pending, 0);
  s.watcher.dispose();
});

test('polls never overlap even when stat is slow', async () => {
  const s = setup();
  s.stats.delay = true;
  s.put('/t.json', '{}', 1);
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  await s.time.advance(20_000);
  assert.equal(s.stats.maxActive, 1);
  assert.ok(s.stats.n >= 8);
  s.watcher.dispose();
});

test('lastGood survives a bad reload and clears when the path changes', async () => {
  const s = setup();
  s.put('/t.json', '{"company":"Good"}', 1);
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  await s.time.advance(10);
  assert.equal(s.watcher.lastGood()?.company, 'Good');
  s.put('/t.json', '{ broken', 2);
  await s.time.advance(2100);
  assert.equal(s.results.length, 2);
  assert.equal(s.results[1]!.theme, undefined);
  assert.equal(s.watcher.lastGood()?.company, 'Good');
  // Field errors also keep the previous clean theme as lastGood.
  s.put('/t.json', '{"company":"Half","branch":7}', 3);
  await s.time.advance(2100);
  assert.equal(s.results[2]!.theme?.company, 'Half');
  assert.equal(s.watcher.lastGood()?.company, 'Good');
  // A clean file replaces it.
  s.put('/t.json', '{"company":"Fixed"}', 4);
  await s.time.advance(2100);
  assert.equal(s.watcher.lastGood()?.company, 'Fixed');
  s.watcher.setPath('/other.json');
  assert.equal(s.watcher.lastGood(), undefined);
  s.watcher.dispose();
});

test('a throwing handler or stat never breaks the chain', async () => {
  const s = setup();
  const seen: ThemeLoadResult[] = [];
  const w = new ThemeWatcher({ ...s.deps, stat: async () => Promise.reject(new Error('weird')) }, (r) => {
    seen.push(r);
    throw new Error('handler boom');
  });
  w.setVisible(true);
  w.setPath('/t.json');
  await s.time.advance(7000);
  assert.equal(seen.length, 1);
  assert.ok(s.logs.some((l) => l.includes('handler boom')));
  assert.ok(s.time.pending > 0);
  w.dispose();
  assert.equal(s.time.pending, 0);
});

test('dispose stops everything and ignores later calls', async () => {
  const s = setup();
  s.put('/t.json', '{}', 1);
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  s.watcher.dispose();
  s.watcher.setPath('/t.json');
  s.watcher.setVisible(false);
  s.watcher.setVisible(true);
  await s.time.advance(10_000);
  assert.equal(s.results.length, 0);
  assert.equal(s.time.pending, 0);
});

test('loadThemeFile: rev is the revision of the raw text and jsonObject says whether it was an object', async () => {
  const s = setup();
  const text = '{ "company": "Acme" }\n';
  s.put('/t.json', text);
  const ok = await loadThemeFile('/t.json', s.deps);
  assert.equal(ok.rev, revisionOf(text));
  assert.equal(ok.jsonObject, true);

  // A byte order mark is part of the raw text, so it is part of the revision too.
  s.put('/bom.json', '\ufeff{}');
  const bom = await loadThemeFile('/bom.json', s.deps);
  assert.equal(bom.rev, revisionOf('\ufeff{}'));
  assert.equal(bom.jsonObject, true);

  // Field errors still count as an object.
  s.put('/bad.json', '{"company":5}');
  const bad = await loadThemeFile('/bad.json', s.deps);
  assert.equal(bad.jsonObject, true);
  assert.ok(bad.errors.length > 0);

  for (const body of ['[1,2]', '"text"', '42', 'null', 'true']) {
    s.put('/x.json', body);
    const r = await loadThemeFile('/x.json', s.deps);
    assert.equal(r.jsonObject, false, body);
    assert.equal(r.rev, revisionOf(body), body);
  }

  s.put('/broken.json', '{ nope');
  const broken = await loadThemeFile('/broken.json', s.deps);
  assert.equal(broken.jsonObject, false);
  assert.equal(broken.rev, revisionOf('{ nope'));

  const missing = await loadThemeFile('/missing.json', s.deps);
  assert.equal(missing.rev, undefined);
  assert.equal(missing.jsonObject, false);
  const unreadable = await loadThemeFile('/x', { readFile: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) });
  assert.equal(unreadable.rev, undefined);
});

test('watcher results carry rev, and reloadNow re-reads at once and notifies like a change', async () => {
  const s = setup();
  s.put('/t.json', '{"company":"A"}', 100);
  s.watcher.setVisible(true);
  s.watcher.setPath('/t.json');
  await s.time.advance(10);
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0]!.rev, revisionOf('{"company":"A"}'));

  // The file changes but the poll has not run yet: reloadNow sees it without waiting for the timer.
  s.put('/t.json', '{"company":"B"}', 200);
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 2);
  assert.equal(s.results[1]!.theme?.company, 'B');
  assert.equal(s.results[1]!.rev, revisionOf('{"company":"B"}'));
  assert.equal(s.watcher.lastGood()?.company, 'B');

  // The poll that follows does not report the same change twice.
  await s.time.advance(2100);
  assert.equal(s.results.length, 2);

  // An unchanged file is still reported by reloadNow (that is the point of an explicit reload).
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 3);
  assert.equal(s.results[2]!.rev, s.results[1]!.rev);
  s.watcher.dispose();
});

test('reloadNow works while hidden, reports a deleted file, and does nothing without a path or after dispose', async () => {
  const s = setup();
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 0);

  s.put('/t.json', '{"company":"H"}', 1);
  s.watcher.setPath('/t.json');
  await s.time.advance(10);
  assert.equal(s.results.length, 1);
  assert.equal(s.time.pending, 0);

  s.files.delete('/t.json');
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 2);
  assert.deepEqual(s.results[1]!.errors, ['theme: file not found: /t.json']);
  assert.equal(s.results[1]!.rev, undefined);
  assert.equal(s.watcher.lastGood()?.company, 'H');
  assert.equal(s.time.pending, 0, 'reloadNow must not start the poll timer while hidden');

  s.watcher.dispose();
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 2);
});

test('reloadNow expands ~, survives a throwing handler and ignores a result that arrives after the path changed', async () => {
  const s = setup();
  s.put('/home/u/t.json', '{"company":"A"}', 1);
  s.watcher.setPath('~/t.json');
  await s.time.advance(10);
  await s.watcher.reloadNow();
  assert.equal(s.results.length, 2);
  assert.equal(s.results[1]!.path, '/home/u/t.json');

  // Path changes while the read is in flight: the stale result is dropped.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const seen: ThemeLoadResult[] = [];
  const w = new ThemeWatcher({ ...s.deps, readFile: async (p) => (await gate, s.deps.readFile(p)) }, (r) => seen.push(r));
  w.setPath('/home/u/t.json');
  const pending = w.reloadNow();
  w.setPath('/other.json');
  release();
  await pending;
  await s.time.advance(10);
  assert.ok(seen.every((r) => r.path === '/other.json'));
  w.dispose();

  const thrower = new ThemeWatcher(s.deps, () => {
    throw new Error('handler boom');
  });
  thrower.setPath('/home/u/t.json');
  await s.time.advance(10);
  await thrower.reloadNow();
  assert.ok(s.logs.some((l) => l.includes('handler boom')));
  thrower.dispose();
});

test('every packaged preset in PRESETS parses from media/themes with no errors, a full cast and all colours', () => {
  const dir = fileURLToPath(new URL('../media/themes/', import.meta.url));
  assert.ok(PRESETS.length >= 6);
  for (const p of PRESETS) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, p.file), 'utf8'));
    const { theme, errors } = parseTheme(raw);
    assert.deepEqual(errors, [], p.id);
    // The example predates three colour keys and keeps their built-in defaults, so it is exempt from the full-cast and full-colour checks.
    if (p.id !== 'example') {
      assert.equal(theme.staff?.length, 8, p.id);
      for (const k of OFFICE_COLOR_KEYS) assert.ok(theme.colors?.[k], `${p.id}: colour ${k}`);
    }
    assert.ok((theme.company ?? '').trim() !== '', `${p.id}: company`);
    assert.ok((theme.branch ?? '').trim() !== '', `${p.id}: branch`);
  }
});

test('the packaged example office parses with zero errors and uses a receptionist and colours', () => {
  const file = fileURLToPath(new URL('../media/themes/example.theme.json', import.meta.url));
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const { theme, errors } = parseTheme(raw);
  assert.deepEqual(errors, []);
  assert.ok(theme.receptionist?.name);
  assert.ok((theme.receptionist?.lines?.length ?? 0) >= 3);
  assert.ok(Object.keys(theme.colors ?? {}).length >= 8);
  assert.ok((theme.staff?.length ?? 0) >= 6);
  assert.equal((raw as Record<string, unknown>)['$schema'], '../theme.schema.json');
});

test('loadThemeFile: missing is true only for ENOENT/ENOTDIR, and text is kept only when the file was read', async () => {
  const codes = async (code: string | undefined) =>
    loadThemeFile('/t.json', {
      readFile: async () => {
        throw Object.assign(new Error('boom'), code === undefined ? {} : { code });
      },
    });
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const r = await codes(code);
    assert.equal(r.missing, true, code);
    assert.equal(r.text, undefined, code);
  }
  for (const code of ['EACCES', undefined]) {
    const r = await codes(code);
    assert.equal(r.missing, false, String(code));
    assert.equal(r.text, undefined, String(code));
  }
  const ok = await loadThemeFile('/t.json', { readFile: async () => '{"company":"A"}' });
  assert.equal(ok.missing, false);
  assert.equal(ok.text, '{"company":"A"}');
  const bad = await loadThemeFile('/t.json', { readFile: async () => '{ nope' });
  assert.equal(bad.missing, false);
  assert.equal(bad.text, '{ nope');
});
