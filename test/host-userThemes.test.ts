import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '../src/shared/protocol.ts';
import { UserThemes, defaultThemesDir, settingValueFor } from '../src/host/userThemes.ts';
import type { UserThemesDeps } from '../src/host/userThemes.ts';
import { expandHome } from '../src/host/themeLoader.ts';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mm-userthemes-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function make(dir: string, extra: Partial<UserThemesDeps> = {}): { ut: UserThemes; reads: string[] } {
  const reads: string[] = [];
  const ut = new UserThemes({
    dir,
    readdir,
    stat,
    readFile: (p) => {
      reads.push(p);
      return readFile(p, 'utf8');
    },
    ...extra,
  });
  return { ut, reads };
}

/** Write a file and stamp its modified time (seconds since the epoch). */
async function put(dir: string, name: string, text: string, mtimeSec = 1_700_000_000): Promise<void> {
  const tmp = join(dir, `${name}.stage`);
  await writeFile(tmp, text);
  await utimes(tmp, mtimeSec, mtimeSec);
  await rename(tmp, join(dir, name));
}

const ids = (ut: UserThemes): string[] => ut.entries(undefined).map((e) => e.id);

test('defaultThemesDir and settingValueFor', () => {
  assert.equal(defaultThemesDir('/home/a'), join('/home/a', '.middle-management', 'themes'));
  assert.equal(settingValueFor('pirate-ship.theme.json'), '~/.middle-management/themes/pirate-ship.theme.json');
  assert.equal(expandHome(settingValueFor('x.theme.json'), '/home/a'), '/home/a/.middle-management/themes/x.theme.json');
  assert.equal(expandHome(settingValueFor('x.theme.json'), 'C:\\Users\\a'), 'C:\\Users\\a/.middle-management/themes/x.theme.json');
});

test('a missing folder gives an empty list and no error', async () => {
  await withDir(async (dir) => {
    const { ut } = make(join(dir, 'nope'));
    assert.equal(await ut.rescan(), false);
    assert.deepEqual(ut.entries(undefined), []);
    assert.equal(ut.truncated, false);
  });
});

test('filters dotfiles, tmp files, wrong suffixes, subfolders and big files', async () => {
  await withDir(async (dir) => {
    await put(dir, 'a.theme.json', '{}');
    await put(dir, '.hidden.theme.json', '{}');
    await put(dir, 'b.theme.json.tmp', '{}');
    await put(dir, 'c.json', '{}');
    await put(dir, 'd.theme.json.bak', '{}');
    await mkdir(join(dir, 'sub.theme.json'));
    await put(dir, 'big.theme.json', ' '.repeat(1024 * 1024 + 1));
    await put(dir, 'edge.theme.json', ' '.repeat(1024 * 1024));
    await mkdir(join(dir, 'sub'));
    await put(join(dir, 'sub'), 'deep.theme.json', '{}');
    const { ut } = make(dir);
    assert.equal(await ut.rescan(), true);
    assert.deepEqual(ids(ut).sort(), ['a.theme.json', 'edge.theme.json']);
  });
});

test('label is the theme name, else the file stem, clipped to 40', async () => {
  await withDir(async (dir) => {
    await put(dir, 'named.theme.json', '{"name":"Pirate ship"}', 1_700_000_003);
    await put(dir, 'lighthouse-crew.theme.json', '{}', 1_700_000_002);
    await put(dir, `${'x'.repeat(60)}.theme.json`, '{}', 1_700_000_001);
    const { ut } = make(dir);
    await ut.rescan();
    const labels = ut.entries(undefined).map((e) => e.label);
    assert.deepEqual(labels, ['Pirate ship', 'lighthouse-crew', 'x'.repeat(40)]);
  });
});

test('description: own text, else company with branch, else none; non-ASCII kept', async () => {
  await withDir(async (dir) => {
    await put(dir, 'a.theme.json', '{"description":"A ship at sea","company":"Ignored"}', 1_700_000_004);
    await put(dir, 'b.theme.json', '{"company":"Corner bakery","branch":"Harbour"}', 1_700_000_003);
    await put(dir, 'c.theme.json', '{"company":"Corner bakery"}', 1_700_000_002);
    await put(dir, 'd.theme.json', '{}', 1_700_000_001);
    await put(dir, 'e.theme.json', '{"description":"Caf\\u00e9 \\u2014 open"}', 1_700_000_000);
    const { ut } = make(dir);
    await ut.rescan();
    const d = ut.entries(undefined).map((e) => e.description);
    assert.deepEqual(d, ['A ship at sea', 'Corner bakery - Harbour', 'Corner bakery', undefined, 'Caf\u00e9 \u2014 open']);
  });
});
 
test('non-ASCII text is kept whole, emoji included', async () => {
  await withDir(async (dir) => {
    // The theme parser caps name at 40 and description at 160 UTF-16 units, so these sit at those caps.
    const boat = '\u{1F6A2}';
    await put(dir, 'a.theme.json', JSON.stringify({ name: `${boat.repeat(18)}Caf\u00e9`, description: `${boat.repeat(79)}ab` }), 1_700_000_001);
    await put(dir, 'b.theme.json', JSON.stringify({ company: 'Caf\u00e9 Lune', branch: `Harbour ${boat}` }), 1_700_000_000);
    const { ut } = make(dir);
    await ut.rescan();
    const [a, b] = ut.entries(undefined);
    assert.equal(a?.label, `${boat.repeat(18)}Caf\u00e9`);
    assert.equal(a?.description, `${boat.repeat(79)}ab`);
    assert.equal(a?.problems, false);
    assert.equal(b?.description, `Caf\u00e9 Lune - Harbour ${boat}`);
    for (const e of [a, b]) assert.doesNotMatch(`${e?.label}${e?.description}`, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

test('problems is set for bad JSON and for schema errors only', async () => {
  await withDir(async (dir) => {
    await put(dir, 'ok.theme.json', '{"name":"Fine"}', 1_700_000_003);
    await put(dir, 'bad.theme.json', '{not json', 1_700_000_002);
    await put(dir, 'schema.theme.json', '{"name":42}', 1_700_000_001);
    await put(dir, 'array.theme.json', '[]', 1_700_000_000);
    const { ut } = make(dir);
    await ut.rescan();
    const p = Object.fromEntries(ut.entries(undefined).map((e) => [e.id, e.problems]));
    assert.deepEqual(p, { 'ok.theme.json': false, 'bad.theme.json': true, 'schema.theme.json': true, 'array.theme.json': true });
  });
});

test('newest first, ties broken by name', async () => {
  await withDir(async (dir) => {
    await put(dir, 'old.theme.json', '{}', 1_700_000_000);
    await put(dir, 'new.theme.json', '{}', 1_700_000_100);
    await put(dir, 'mid-b.theme.json', '{}', 1_700_000_050);
    await put(dir, 'mid-a.theme.json', '{}', 1_700_000_050);
    const { ut } = make(dir);
    await ut.rescan();
    assert.deepEqual(ids(ut), ['new.theme.json', 'mid-a.theme.json', 'mid-b.theme.json', 'old.theme.json']);
  });
});

test('keeps the newest 50 and sets truncated', async () => {
  await withDir(async (dir) => {
    const n = LIMITS.userThemes + 3;
    for (let i = 0; i < n; i++) await put(dir, `t${String(i).padStart(3, '0')}.theme.json`, '{}', 1_700_000_000 + i);
    const { ut } = make(dir);
    await ut.rescan();
    const got = ids(ut);
    assert.equal(got.length, LIMITS.userThemes);
    assert.equal(ut.truncated, true);
    assert.equal(got[0], `t${String(n - 1).padStart(3, '0')}.theme.json`);
    assert.equal(ut.has('t000.theme.json'), false);
    await rm(join(dir, 't052.theme.json'));
    await rm(join(dir, 't051.theme.json'));
    await rm(join(dir, 't050.theme.json'));
    await rm(join(dir, 't049.theme.json'));
    assert.equal(await ut.rescan(), true);
    assert.equal(ut.truncated, false);
  });
});

test('entries marks the current theme by path', async () => {
  await withDir(async (dir) => {
    await put(dir, 'a.theme.json', '{}', 1_700_000_001);
    await put(dir, 'b.theme.json', '{}', 1_700_000_000);
    const { ut } = make(dir);
    await ut.rescan();
    const cur = (p: string | undefined): string[] => ut.entries(p).filter((e) => e.current).map((e) => e.id);
    assert.deepEqual(cur(join(dir, 'b.theme.json')), ['b.theme.json']);
    assert.deepEqual(cur(join(dir, 'sub', '..', 'a.theme.json')), ['a.theme.json']);
    assert.deepEqual(cur(join(dir, 'c.theme.json')), []);
    assert.deepEqual(cur(undefined), []);
    assert.deepEqual(cur(''), []);
    assert.deepEqual(cur(join(dir, 'B.theme.json')), []);
    const win = make(dir, { platform: 'win32' }).ut;
    await win.rescan();
    assert.deepEqual(win.entries(join(dir, 'A.THEME.JSON')).filter((e) => e.current).map((e) => e.id), ['a.theme.json']);
  });
});

test('has and pathFor only accept names from the latest scan', async () => {
  await withDir(async (dir) => {
    await put(dir, 'a.theme.json', '{}');
    await put(dir, 'new.theme.json', '{}');
    const { ut } = make(dir);
    assert.equal(ut.has('a.theme.json'), false);
    await ut.rescan();
    assert.equal(ut.has('a.theme.json'), true);
    assert.equal(ut.pathFor('a.theme.json'), join(dir, 'a.theme.json'));
    for (const bad of ['', '../a.theme.json', join(dir, 'a.theme.json'), 'missing.theme.json', 'sub/a.theme.json']) {
      assert.equal(ut.has(bad), false, bad);
      assert.equal(ut.pathFor(bad), undefined, bad);
    }
    await rm(join(dir, 'a.theme.json'));
    await ut.rescan();
    assert.equal(ut.has('a.theme.json'), false);
  });
});

test('unchanged files are not read again; changed ones are; rescan reports changes', async () => {
  await withDir(async (dir) => {
    await put(dir, 'a.theme.json', '{"name":"One"}', 1_700_000_000);
    await put(dir, 'b.theme.json', '{"name":"Two"}', 1_700_000_001);
    const { ut, reads } = make(dir);
    assert.equal(await ut.rescan(), true);
    assert.equal(reads.length, 2);
    assert.equal(await ut.rescan(), false);
    assert.equal(reads.length, 2);
    await put(dir, 'a.theme.json', '{"name":"Uno"}', 1_700_000_005);
    assert.equal(await ut.rescan(), true);
    assert.equal(reads.length, 3);
    assert.equal(ut.entries(undefined)[0]?.label, 'Uno');
    await put(dir, 'c.theme.json', '{}', 1_700_000_009);
    assert.equal(await ut.rescan(), true);
    await rm(join(dir, 'c.theme.json'));
    assert.equal(await ut.rescan(), true);
    assert.equal(await ut.rescan(), false);
  });
});

test('rescan never throws', async () => {
  const ut = new UserThemes({
    dir: '/x',
    readdir: () => Promise.reject(new Error('boom')),
    stat: () => Promise.reject(new Error('boom')),
    readFile: () => Promise.reject(new Error('boom')),
  });
  assert.equal(await ut.rescan(), false);
  const ut2 = new UserThemes({
    dir: '/x',
    readdir: () => Promise.resolve(['a.theme.json']),
    stat: () => Promise.reject(new Error('boom')),
    readFile: () => Promise.reject(new Error('boom')),
  });
  assert.equal(await ut2.rescan(), false);
  assert.deepEqual(ut2.entries(undefined), []);
});

test('setVisible polls every interval, calls onChange only on change, and stops when hidden or disposed', async () => {
  await withDir(async (dir) => {
    let changes = 0;
    const { ut } = make(dir, { onChange: () => void changes++, pollMs: 20 });
    const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    try {
      ut.setVisible(true);
      await settle(60);
      assert.equal(changes, 0);
      await put(dir, 'a.theme.json', '{}');
      await settle(80);
      assert.equal(changes, 1);
      await settle(60);
      assert.equal(changes, 1);
      ut.setVisible(false);
      await settle(30);
      await put(dir, 'b.theme.json', '{}');
      await settle(80);
      assert.equal(changes, 1);
      ut.setVisible(true);
      await settle(60);
      assert.equal(changes, 2);
    } finally {
      ut.dispose();
    }
    await put(dir, 'c.theme.json', '{}');
    await settle(80);
    assert.equal(changes, 2);
  });
});
