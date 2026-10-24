import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LINE_POOL_KEYS, LINE_POOL_KIND, NPC_KEYS, OFFICE_COLOR_KEYS, THEME_LIMITS, TITLE_KEYS, parseTheme } from '../src/shared/theme.ts';
import { checkWriteGuards, existingSchemaRef, revisionOf, serializeTheme, writeAtomic } from '../src/host/themeWriter.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import type { ThemeWriterDeps, WriteGuardInput } from '../src/host/themeWriter.ts';

const realDeps: ThemeWriterDeps = {
  realpath: (p) => fs.realpath(p),
  writeFileExclusive: (p, d) => fs.writeFile(p, d, { flag: 'wx' }),
  rename: (a, b) => fs.rename(a, b),
  unlink: (p) => fs.unlink(p),
};

async function tmpDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-theme-')));
}

// ---- revisionOf ---------------------------------------------------------------------------------------------------

test('revisionOf is 16 hex characters, stable, and sensitive to every byte', () => {
  const a = revisionOf('{"company":"A"}');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(revisionOf('{"company":"A"}'), a);
  assert.notEqual(revisionOf('{"company":"B"}'), a);
  assert.notEqual(revisionOf('{"company":"A"}\n'), a);
  assert.equal(revisionOf(''), 'e3b0c44298fc1c14');
});

// ---- serializeTheme -----------------------------------------------------------------------------------------------

function keys(text: string): string[] {
  return Object.keys(JSON.parse(text) as object);
}

test('serializeTheme: fixed key order, $schema first, pretty JSON with a trailing newline', () => {
  const shuffled = {
    temps: [{ look: { head: 'short', skin: 'warm' }, name: 'T' }],
    staff: [{ lines: ['hi'], look: { shirt: '#ABCDEF', head: 'cat', skirt: true, hair: '#112233' }, pin: { title: 'tt', project: 'pp' }, role: 'R', name: 'N' }],
    smallTalk: [['a', 'b']],
    colors: { signText: '#ffffff', wall: '#000000', carpet: '#123456' },
    receptionist: { lines: ['yo'], name: 'Rec' },
    manager: { lines: ['m'], look: { head: 'boss' }, name: 'Mgr' },
    branch: 'Br',
    company: 'Co',
    $schema: 'ignored-input-value',
  };
  const r = serializeTheme(shuffled, 'file:///x/theme.schema.json');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(keys(r.text), ['$schema', 'company', 'branch', 'manager', 'receptionist', 'colors', 'smallTalk', 'staff', 'temps']);
  const o = JSON.parse(r.text) as Record<string, any>;
  assert.equal(o['$schema'], 'file:///x/theme.schema.json');
  assert.deepEqual(Object.keys(o.staff[0]), ['name', 'role', 'pin', 'look', 'lines']);
  assert.deepEqual(Object.keys(o.staff[0].pin), ['project', 'title']);
  assert.deepEqual(Object.keys(o.staff[0].look), ['head', 'hair', 'shirt', 'skirt']);
  assert.equal(o.staff[0].look.shirt, '#abcdef');
  assert.deepEqual(Object.keys(o.colors), ['wall', 'carpet', 'signText']);
  assert.deepEqual(Object.keys(o.manager), ['name', 'look', 'lines']);
  assert.deepEqual(Object.keys(o.temps[0]), ['name', 'look']);
  assert.ok(r.text.endsWith('}\n'));
  assert.ok(r.text.startsWith('{\n  "$schema": '));
  assert.equal(r.text, JSON.stringify(o, null, 2) + '\n');
});

test('serializeTheme: colors follow OFFICE_COLOR_KEYS order for every key', () => {
  const colors: Record<string, string> = {};
  for (const k of [...OFFICE_COLOR_KEYS].reverse()) colors[k] = '#0a0b0c';
  const r = serializeTheme({ colors });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(Object.keys((JSON.parse(r.text) as { colors: object }).colors), [...OFFICE_COLOR_KEYS]);
});

test('serializeTheme: no $schema unless given, and output is stable when run twice', () => {
  const r1 = serializeTheme({ company: 'A', staff: [{ name: 'x' }] });
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.deepEqual(keys(r1.text), ['company', 'staff']);
  const r2 = serializeTheme(JSON.parse(r1.text));
  assert.ok(r2.ok);
  if (r2.ok) assert.equal(r2.text, r1.text);
  const e = serializeTheme({}, '');
  assert.ok(e.ok);
  if (e.ok) assert.equal(e.text, '{}\n');
});

/** A theme that uses every field: titles, every line pool, the four side characters, every colour and 150 small-talk pairs. */
function fullTheme(): Record<string, unknown> {
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
  return {
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
}

const CANONICAL_TOP_KEYS = [
  '$schema', 'name', 'description', 'company', 'branch', 'lineMode', 'titles', 'manager', 'receptionist',
  'cleaner', 'vendor', 'itFixer', 'itCritic', 'colors', 'lines', 'smallTalk', 'staff', 'temps',
];

test('serializeTheme: a theme using every field survives a round trip', () => {
  const full = fullTheme();
  const expected = parseTheme(full);
  assert.deepEqual(expected.errors, []);
  const r = serializeTheme(full);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(parseTheme(JSON.parse(r.text)), expected);
  assert.deepEqual(r.theme, expected.theme);
  // nothing was lost along the way
  assert.equal(Object.keys(r.theme.lines ?? {}).length, LINE_POOL_KEYS.length);
  assert.equal(r.theme.smallTalk?.length, 150);
  assert.equal(r.theme.lineMode, 'replace');
});

test('serializeTheme: every field is written in the canonical order, at every level', () => {
  // The input is in the reverse of the canonical order, so only the writer can put it right.
  const full = fullTheme();
  const reversed: Record<string, unknown> = {};
  for (const k of Object.keys(full).reverse()) reversed[k] = full[k];
  reversed['lines'] = Object.fromEntries(Object.entries(full['lines'] as object).reverse());
  reversed['titles'] = Object.fromEntries(Object.entries(full['titles'] as object).reverse());
  const r = serializeTheme(reversed, 'file:///x/theme.schema.json');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(keys(r.text), CANONICAL_TOP_KEYS);
  const o = JSON.parse(r.text) as Record<string, any>;
  assert.deepEqual(Object.keys(o.titles), [...TITLE_KEYS]);
  assert.deepEqual(Object.keys(o.lines), [...LINE_POOL_KEYS]);
  assert.deepEqual(Object.keys(o.colors), [...OFFICE_COLOR_KEYS]);
  for (const k of NPC_KEYS) assert.deepEqual(Object.keys(o[k]), ['name', 'look']);
  assert.deepEqual(o.lines.itFixerTalk[0], ['itFixerTalk opener one', 'itFixerTalk reply one']);
  assert.deepEqual(o.lines.bossVisit, ['bossVisit line one', 'bossVisit line two']);
  assert.equal(o.smallTalk.length, 150);
  assert.equal(r.text, JSON.stringify(o, null, 2) + '\n');
});

test('serializeTheme: serialising a full theme twice gives identical text', () => {
  const r1 = serializeTheme(fullTheme(), 'file:///x/theme.schema.json');
  assert.ok(r1.ok);
  if (!r1.ok) return;
  const r2 = serializeTheme(JSON.parse(r1.text), 'file:///x/theme.schema.json');
  assert.ok(r2.ok);
  if (r2.ok) assert.equal(r2.text, r1.text);
});

test('serializeTheme: empty pools, titles and side characters are left out', () => {
  const r = serializeTheme({ lines: { bossVisit: [], itFixerTalk: [] }, titles: {}, cleaner: {}, vendor: { name: 'V' }, company: 'A' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(JSON.parse(r.text), { company: 'A', vendor: { name: 'V' } });
  const only = serializeTheme({ lines: { bossSnack: ['x'] } });
  assert.ok(only.ok);
  if (only.ok) assert.deepEqual(JSON.parse(only.text), { lines: { bossSnack: ['x'] } });
});

test('serializeTheme refuses a theme with any error and writes nothing', () => {
  const cases: unknown[] = [
    { company: 7 },
    { staff: [{ name: 'A', look: { hair: 'red' } }] },
    { colors: { wall: 'blue' } },
    { colors: { floor: '#ffffff' } },
    [],
    null,
    'text',
    JSON.parse('{"company":"A","__proto__":{"x":1}}'),
  ];
  for (const c of cases) {
    const r = serializeTheme(c, 'x');
    assert.equal(r.ok, false, JSON.stringify(c));
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});

test('serializeTheme trims trailing {} placeholders but keeps a middle one', () => {
  const r = serializeTheme({
    staff: [{ name: 'A' }, {}, { name: 'C' }, {}, {}],
    temps: [{}, { name: 'T' }, {}],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  const o = JSON.parse(r.text) as { staff: object[]; temps: object[] };
  assert.deepEqual(o.staff, [{ name: 'A' }, {}, { name: 'C' }]);
  assert.deepEqual(o.temps, [{}, { name: 'T' }]);
  const onlyBlanks = serializeTheme({ staff: [{}, {}], temps: [{}] });
  assert.ok(onlyBlanks.ok);
  if (onlyBlanks.ok) assert.equal(onlyBlanks.text, '{}\n');
});

test('serializeTheme: the written text re-parses to the same theme', () => {
  const src = { company: 'C', manager: { name: 'M', look: { head: 'boss', belt: false } }, staff: [{ name: 'S', lines: ['a', 'b'] }, {}, { name: 'Z' }], colors: { rug: '#aabbcc' } };
  const r = serializeTheme(src, 's');
  assert.ok(r.ok);
  if (!r.ok) return;
  const back = parseTheme(JSON.parse(r.text));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.theme, r.theme);
  assert.equal(back.theme.manager?.look?.belt, false);
});

test('existingSchemaRef reads $schema from file text', () => {
  assert.equal(existingSchemaRef('{"$schema":"../s.json","company":"A"}'), '../s.json');
  assert.equal(existingSchemaRef('﻿{"$schema":"u"}'), 'u');
  assert.equal(existingSchemaRef('{"company":"A"}'), undefined);
  assert.equal(existingSchemaRef('{"$schema":7}'), undefined);
  assert.equal(existingSchemaRef('{broken'), undefined);
  assert.equal(existingSchemaRef('[1]'), undefined);
});

// ---- writeAtomic --------------------------------------------------------------------------------------------------

test('writeAtomic replaces an existing file and leaves no temp files behind', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 't.json');
    await fs.writeFile(f, 'old');
    const r = await writeAtomic(f, 'new\n', realDeps);
    assert.deepEqual(r, { ok: true, path: f });
    assert.equal(await fs.readFile(f, 'utf8'), 'new\n');
    assert.deepEqual(await fs.readdir(dir), ['t.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomic creates a missing file when its folder exists', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'new.json');
    const r = await writeAtomic(f, '{}\n', realDeps);
    assert.deepEqual(r, { ok: true, path: f });
    assert.equal(await fs.readFile(f, 'utf8'), '{}\n');
    const bad = await writeAtomic(path.join(dir, 'nodir', 'x.json'), '{}', realDeps);
    assert.equal(bad.ok, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomic through a symlink updates the target and keeps the link', async () => {
  const dir = await tmpDir();
  try {
    await fs.mkdir(path.join(dir, 'real'));
    const target = path.join(dir, 'real', 'office.json');
    const link = path.join(dir, 'link.json');
    await fs.writeFile(target, 'old');
    await fs.symlink(target, link);
    const r = await writeAtomic(link, 'fresh\n', realDeps);
    assert.deepEqual(r, { ok: true, path: target });
    assert.ok((await fs.lstat(link)).isSymbolicLink());
    assert.equal(await fs.readFile(target, 'utf8'), 'fresh\n');
    assert.equal(await fs.readFile(link, 'utf8'), 'fresh\n');
    assert.deepEqual((await fs.readdir(path.join(dir, 'real'))).sort(), ['office.json']);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['link.json', 'real']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomic through a dangling symlink resolves the link folder, not the missing target', async () => {
  const dir = await tmpDir();
  try {
    const link = path.join(dir, 'dangling.json');
    await fs.symlink(path.join(dir, 'gone.json'), link);
    const r = await writeAtomic(link, 'x', realDeps);
    // realpath of a dangling link fails with ENOENT, so the write lands at the link's own name in its folder, replacing the link.
    assert.equal(r.ok, true);
    assert.equal(await fs.readFile(link, 'utf8'), 'x');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomic uses a wx temp file with a random suffix next to the target', async () => {
  const calls: string[] = [];
  const written: string[] = [];
  let n = 0;
  const deps: ThemeWriterDeps = {
    realpath: async (p) => p,
    writeFileExclusive: async (p, d) => void (calls.push('write ' + p), written.push(d)),
    rename: async (a, b) => void calls.push(`rename ${a} -> ${b}`),
    unlink: async (p) => void calls.push('unlink ' + p),
    randomHex: () => `r${++n}`,
  };
  const r = await writeAtomic('/d/t.json', 'T', deps);
  assert.deepEqual(r, { ok: true, path: '/d/t.json' });
  assert.deepEqual(calls, ['write /d/.t.json.r1.tmp', 'rename /d/.t.json.r1.tmp -> /d/t.json']);
});

test('writeAtomic retries a taken temp name without deleting the other file', async () => {
  const calls: string[] = [];
  let n = 0;
  const deps: ThemeWriterDeps = {
    realpath: async (p) => p,
    writeFileExclusive: async (p) => {
      calls.push('write ' + p);
      if (p.endsWith('.r1.tmp')) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
    rename: async (a, b) => void calls.push(`rename ${a} -> ${b}`),
    unlink: async (p) => void calls.push('unlink ' + p),
    randomHex: () => `r${++n}`,
  };
  const r = await writeAtomic('/d/t.json', 'T', deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['write /d/.t.json.r1.tmp', 'write /d/.t.json.r2.tmp', 'rename /d/.t.json.r2.tmp -> /d/t.json']);
  // Always EEXIST: gives up, never unlinks.
  const calls2: string[] = [];
  const always: ThemeWriterDeps = { ...deps, writeFileExclusive: async () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })), unlink: async (p) => void calls2.push(p) };
  const r2 = await writeAtomic('/d/t.json', 'T', always);
  assert.equal(r2.ok, false);
  assert.deepEqual(calls2, []);
});

test('writeAtomic cleans up the temp file when the write or the rename fails', async () => {
  const unlinked: string[] = [];
  const base: ThemeWriterDeps = {
    realpath: async (p) => p,
    writeFileExclusive: async () => undefined,
    rename: async () => undefined,
    unlink: async (p) => void unlinked.push(p),
    randomHex: () => 'x',
  };
  const renameFails = await writeAtomic('/d/t.json', 'T', { ...base, rename: async () => Promise.reject(new Error('EXDEV')) });
  assert.equal(renameFails.ok, false);
  assert.match(renameFails.ok ? '' : renameFails.message, /EXDEV/);
  assert.deepEqual(unlinked, ['/d/.t.json.x.tmp']);
  unlinked.length = 0;
  const writeFails = await writeAtomic('/d/t.json', 'T', { ...base, writeFileExclusive: async () => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' })) });
  assert.equal(writeFails.ok, false);
  assert.deepEqual(unlinked, ['/d/.t.json.x.tmp']);
  // An unlink that itself fails does not hide the real error or throw.
  const both = await writeAtomic('/d/t.json', 'T', { ...base, rename: async () => Promise.reject(new Error('boom')), unlink: async () => Promise.reject(new Error('nope')) });
  assert.equal(both.ok, false);
  assert.match(both.ok ? '' : both.message, /boom/);
});

test('writeAtomic reports a path that cannot be resolved without throwing', async () => {
  const r = await writeAtomic('/d/t.json', 'T', {
    realpath: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    writeFileExclusive: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
  });
  assert.equal(r.ok, false);
});

// ---- checkWriteGuards ---------------------------------------------------------------------------------------------

function input(over: Partial<WriteGuardInput> = {}): WriteGuardInput {
  return {
    sourceKind: 'file',
    path: '/home/u/office.json',
    lastLoadWasObject: true,
    fromWorkspace: false,
    content: { company: 'A' },
    rev: 'aaaaaaaaaaaaaaaa',
    currentRev: 'aaaaaaaaaaaaaaaa',
    ...over,
  };
}

function reason(r: ReturnType<typeof checkWriteGuards>): string {
  return r.ok ? 'ok' : r.reason;
}

test('guards: everything holds, so the write is allowed', () => {
  assert.deepEqual(checkWriteGuards(input()), { ok: true });
});

test('guards: only a file source can be written (notFile)', () => {
  for (const sourceKind of ['builtin', 'preset'] as const) {
    const r = checkWriteGuards(input({ sourceKind }));
    assert.equal(reason(r), 'notFile');
    assert.ok(!r.ok && r.message.length > 0);
  }
  // force never overrides it
  assert.equal(reason(checkWriteGuards(input({ sourceKind: 'preset', force: true }))), 'notFile');
});

test('guards: the path must end in .json, case-insensitively (notJson)', () => {
  for (const p of ['/h/office.txt', '/h/office', '/h/office.json.bak', '/h/package.jsonc', '/h/.json5', '']) {
    assert.equal(reason(checkWriteGuards(input({ path: p }))), 'notJson', p);
  }
  for (const p of ['/h/OFFICE.JSON', '/h/a.Json', 'C:\\Users\\u\\t.json', '/h/.json']) {
    assert.equal(reason(checkWriteGuards(input({ path: p }))), 'ok', p);
  }
  assert.equal(reason(checkWriteGuards(input({ path: '/h/x.txt', force: true }))), 'notJson');
});

test('guards: a workspace-scoped setting is refused (workspace)', () => {
  const r = checkWriteGuards(input({ fromWorkspace: true }));
  assert.equal(reason(r), 'workspace');
  assert.ok(!r.ok && /workspace/i.test(r.message));
  assert.equal(reason(checkWriteGuards(input({ fromWorkspace: true, force: true }))), 'workspace');
});

test('guards: a file that did not load as a JSON object is refused (notObject)', () => {
  assert.equal(reason(checkWriteGuards(input({ lastLoadWasObject: false }))), 'notObject');
  assert.equal(reason(checkWriteGuards(input({ lastLoadWasObject: false, force: true }))), 'notObject');
});

test('guards: the content must parse with zero errors (invalid)', () => {
  const bad: unknown[] = [{ company: 3 }, { colors: { wall: 'nope' } }, [], null, { staff: [{ name: 'A', look: { head: 'dragon' } }] }];
  for (const content of bad) {
    const r = checkWriteGuards(input({ content }));
    assert.equal(reason(r), 'invalid', JSON.stringify(content));
    assert.ok(!r.ok && r.message.length > 0);
  }
  assert.equal(reason(checkWriteGuards(input({ content: { company: 3 }, force: true }))), 'invalid');
});

test('guards: a changed file is a conflict, and force overrides it', () => {
  const r = checkWriteGuards(input({ currentRev: 'bbbbbbbbbbbbbbbb' }));
  assert.equal(reason(r), 'conflict');
  assert.equal(reason(checkWriteGuards(input({ currentRev: 'bbbbbbbbbbbbbbbb', force: true }))), 'ok');
  // no rev from the editor at all counts as a mismatch
  assert.equal(reason(checkWriteGuards(input({ rev: undefined }))), 'conflict');
  assert.equal(reason(checkWriteGuards(input({ rev: undefined, force: true }))), 'ok');
});

test('guards: a file deleted since load is its own case (missing), refused unless forced', () => {
  const r = checkWriteGuards(input({ currentRev: undefined }));
  assert.equal(reason(r), 'missing');
  assert.ok(!r.ok && /deleted|moved/.test(r.message));
  assert.equal(reason(checkWriteGuards(input({ currentRev: undefined, force: true }))), 'ok');
});

test('guards: the first failing guard wins', () => {
  const all = input({ sourceKind: 'builtin', path: '/x.txt', fromWorkspace: true, lastLoadWasObject: false, content: 5, currentRev: 'z' });
  assert.equal(reason(checkWriteGuards(all)), 'notFile');
  assert.equal(reason(checkWriteGuards({ ...all, sourceKind: 'file' })), 'notJson');
  assert.equal(reason(checkWriteGuards({ ...all, sourceKind: 'file', path: '/x.json' })), 'workspace');
  assert.equal(reason(checkWriteGuards({ ...all, sourceKind: 'file', path: '/x.json', fromWorkspace: false })), 'notObject');
  assert.equal(reason(checkWriteGuards({ ...all, sourceKind: 'file', path: '/x.json', fromWorkspace: false, lastLoadWasObject: true })), 'invalid');
});

test('serialize then guard then write round-trips through a real file', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'office.json');
    const original = '{\n  "$schema": "s.json", "company": "Old", "extra": 1\n}\n';
    await fs.writeFile(f, original);
    const rev = revisionOf(original);
    const content = { company: 'New', staff: [{ name: 'A' }, {}] };
    const g = checkWriteGuards({ sourceKind: 'file', path: f, lastLoadWasObject: true, fromWorkspace: false, content, rev, currentRev: revisionOf(await fs.readFile(f, 'utf8')) });
    assert.deepEqual(g, { ok: true });
    const s = serializeTheme(content, existingSchemaRef(original));
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.deepEqual((await writeAtomic(f, s.text, realDeps)).ok, true);
    assert.equal(await fs.readFile(f, 'utf8'), '{\n  "$schema": "s.json",\n  "company": "New",\n  "staff": [\n    {\n      "name": "A"\n    }\n  ]\n}\n');
    // The old revision is now stale.
    assert.equal(reason(checkWriteGuards({ sourceKind: 'file', path: f, lastLoadWasObject: true, fromWorkspace: false, content, rev, currentRev: revisionOf(await fs.readFile(f, 'utf8')) })), 'conflict');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- the maximal theme -------------------------------------------------------------------------------------------

test('a theme that uses every THEME_LIMITS maximum parses, serialises and fits LIMITS.themeJsonChars', () => {
  const L = THEME_LIMITS.line;
  const line = (tag: string, i: number): string => `${tag} ${i}: ${'The quarterly figures are late again, so the whole floor waits by the kettle for news. '.repeat(2)}`.slice(0, L);
  const name40 = (tag: string): string => `${tag} `.padEnd(40, 'N').slice(0, 40);
  let c = 0;
  const hex = (): string => '#' + ((++c * 2654435761) >>> 0).toString(16).padStart(6, '0').slice(-6);
  const heads = ['boss', 'assistant', 'prankster', 'receptionist', 'crossword', 'cat', 'chili', 'knitting', 'hr', 'short', 'spiky', 'ponytail', 'curly', 'bob', 'headset'];
  const skins = ['fair', 'rosy', 'warm', 'olive', 'brown', 'deep'];
  const builds = ['normal', 'tall', 'small', 'big'];
  const outfits = ['suit', 'shirtTie', 'looseTie', 'cardigan', 'buttonCardigan', 'vest', 'floral', 'openCardigan', 'plain', 'polo', 'blouse'];
  const look = (k: number) => ({
    head: heads[k % heads.length], build: builds[k % 4], outfit: outfits[k % outfits.length], skin: skins[k % 6],
    hair: hex(), hairHighlight: hex(), eye: hex(), shirt: hex(), outer: hex(), sleeve: hex(), tie: hex(), collar: hex(), accent: hex(), accent2: hex(),
    pants: hex(), legs: hex(), shoes: hex(), glasses: hex(), facialHair: hex(), bow: hex(), beltColor: hex(),
    skirt: k % 2 === 0, shortSleeves: k % 2 === 1, belt: k % 3 === 0,
  });
  const n = THEME_LIMITS.lines;
  const lines: Record<string, unknown> = {};
  for (const k of LINE_POOL_KEYS) {
    lines[k] = LINE_POOL_KIND[k] === 'pairs'
      ? Array.from({ length: n }, (_, i) => [line(`${k} opener`, i), line(`${k} reply`, i)])
      : Array.from({ length: n }, (_, i) => line(k, i));
  }
  const titles: Record<string, string> = {};
  for (const t of TITLE_KEYS) titles[t] = name40(`Title ${t}`);
  const colors: Record<string, string> = {};
  OFFICE_COLOR_KEYS.forEach((k) => { colors[k] = hex(); });
  const speakers = (tag: string) => Array.from({ length: n }, (_, i) => line(tag, i));
  const theme = {
    name: name40('Maximal theme'), description: 'x'.repeat(THEME_LIMITS.description), company: name40('Company'), branch: name40('Branch'), lineMode: 'replace', titles,
    manager: { name: name40('Manager'), look: look(1), lines: speakers('manager') },
    receptionist: { name: name40('Receptionist'), look: look(2), lines: speakers('reception') },
    cleaner: { name: name40('Cleaner'), look: look(3) }, vendor: { name: name40('Vendor'), look: look(4) },
    itFixer: { name: name40('Fixer'), look: look(5) }, itCritic: { name: name40('Critic'), look: look(6) },
    colors, lines,
    smallTalk: Array.from({ length: THEME_LIMITS.smallTalk }, (_, i) => [line('small talk A', i), line('small talk B', i)]),
    staff: Array.from({ length: THEME_LIMITS.staff }, (_, i) => ({
      name: name40(`Staff ${i}`), role: 'R'.repeat(THEME_LIMITS.role), look: look(i + 7),
      pin: { project: 'p'.repeat(THEME_LIMITS.pin), title: 't'.repeat(THEME_LIMITS.pin) },
      lines: Array.from({ length: 60 }, (_, j) => line(`staff${i}`, j)),
    })),
    temps: Array.from({ length: THEME_LIMITS.temps }, (_, i) => ({ name: name40(`Temp ${i}`), look: look(i + 20) })),
  };
  assert.deepEqual(parseTheme(theme).errors, []);
  const ser = serializeTheme(theme, './theme.schema.json');
  assert.ok(ser.ok, ser.ok ? '' : ser.errors.slice(0, 3).join('; '));
  if (ser.ok) assert.ok(ser.text.length <= LIMITS.themeJsonChars, `${ser.text.length} chars vs ${LIMITS.themeJsonChars}`);
});
