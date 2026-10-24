import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SKILL_MARKER_NAME,
  SKILL_OWNER,
  ThemeSkill,
  buildMarker,
  fileHash,
  loadSkillSources,
  markerText,
  skillFiles,
} from '../src/host/themeSkill.ts';
import type { SkillInputs, SkillSources, ThemeSkillDeps } from '../src/host/themeSkill.ts';

const INPUTS: SkillInputs = {
  version: '1.2.3',
  themesDir: '/home/u/.middle-management/themes',
  template: 'Skill v{{VERSION}}. Save to {{THEMES_DIR}}. Again {{THEMES_DIR}} / {{VERSION}}.\n',
  schema: '{"type":"object"}\n',
  guide: '# Guide\n',
  example: JSON.stringify({ $schema: './theme.schema.json', name: 'Demo', rooms: { a: 1 } }),
};

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-skill-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface Rig {
  skill: ThemeSkill;
  dir: string;
  inputs: { current: SkillInputs };
  logs: string[];
  /** Fail the nth (1-based) exclusive write from now on, when set. */
  failWriteNumber: { n: number | undefined };
}

function rig(root: string, overrides: Partial<ThemeSkillDeps> = {}): Rig {
  const dir = path.join(root, 'skills', 'middle-management-theme');
  const inputs = { current: INPUTS };
  const logs: string[] = [];
  const failWriteNumber: { n: number | undefined } = { n: undefined };
  let writes = 0;
  const deps: ThemeSkillDeps = {
    skillDir: dir,
    homeDir: root,
    sources: async (): Promise<SkillSources> => ({ ok: true, inputs: inputs.current }),
    mkdir: async (p) => void (await fs.mkdir(p, { recursive: true })),
    readdir: (p) => fs.readdir(p),
    lstat: (p) => fs.lstat(p),
    readFile: (p) => fs.readFile(p, 'utf8'),
    rmdir: (p) => fs.rmdir(p),
    realpath: (p) => fs.realpath(p),
    writeFileExclusive: async (p, data) => {
      writes++;
      if (failWriteNumber.n === writes) throw new Error('disk full');
      await fs.writeFile(p, data, { flag: 'wx' });
    },
    rename: (a, b) => fs.rename(a, b),
    unlink: (p) => fs.unlink(p),
    log: (line) => void logs.push(line),
    ...overrides,
  };
  return { skill: new ThemeSkill(deps), dir, inputs, logs, failWriteNumber };
}

const NAMES = ['SKILL.md', 'theme.schema.json', 'guide.md', 'example.theme.json'];

// ---------------------------------------------------------------------------------------------------------------------
// skillFiles and the marker

test('skillFiles: files come in order with placeholders replaced', () => {
  const files = skillFiles(INPUTS);
  assert.deepEqual(files.map((f) => f.name), NAMES);
  assert.equal(files[0]!.text, 'Skill v1.2.3. Save to /home/u/.middle-management/themes. Again /home/u/.middle-management/themes / 1.2.3.\n');
  assert.equal(files[1]!.text, INPUTS.schema);
  assert.equal(files[2]!.text, INPUTS.guide);
});

test('skillFiles: "$" in the themes folder is not treated as a replacement pattern', () => {
  const files = skillFiles({ ...INPUTS, themesDir: "C:\\a$&b$'c" });
  assert.ok(files[0]!.text.includes("C:\\a$&b$'c"));
});

test('skillFiles: the example loses its top-level $schema, and nothing else', () => {
  const ex = skillFiles(INPUTS)[3]!.text;
  assert.equal(ex, '{\n  "name": "Demo",\n  "rooms": {\n    "a": 1\n  }\n}\n');
  const nested = skillFiles({ ...INPUTS, example: '{"rooms":{"$schema":"keep"},"$schema":"x"}' })[3]!.text;
  assert.deepEqual(JSON.parse(nested), { rooms: { $schema: 'keep' } });
});

test('skillFiles: an example that is not a JSON object is passed through', () => {
  assert.equal(skillFiles({ ...INPUTS, example: 'nope' })[3]!.text, 'nope');
  assert.equal(skillFiles({ ...INPUTS, example: '[1]' })[3]!.text, '[1]');
});

test('buildMarker: owner, version and 16-hex hashes of each file', () => {
  const files = skillFiles(INPUTS);
  const m = buildMarker('1.2.3', files);
  assert.equal(m.owner, SKILL_OWNER);
  assert.equal(m.version, '1.2.3');
  assert.deepEqual(Object.keys(m.files), NAMES);
  for (const f of files) {
    assert.match(m.files[f.name]!, /^[0-9a-f]{16}$/);
    assert.equal(m.files[f.name], fileHash(f.text));
  }
  assert.ok(markerText(m).endsWith('}\n'));
});

// ---------------------------------------------------------------------------------------------------------------------
// status

test('status: missing when there is no folder', () =>
  withTemp(async (root) => {
    assert.equal(await rig(root).skill.status(), 'missing');
  }));

test('status: missing when the folder is empty', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    assert.equal(await r.skill.status(), 'missing');
  }));

test('status: installed after install, and the files are on disk', () =>
  withTemp(async (root) => {
    const r = rig(root);
    assert.deepEqual(await r.skill.install(), { ok: true });
    assert.equal(await r.skill.status(), 'installed');
    for (const f of skillFiles(INPUTS)) assert.equal(await fs.readFile(path.join(r.dir, f.name), 'utf8'), f.text);
    const marker = JSON.parse(await fs.readFile(path.join(r.dir, SKILL_MARKER_NAME), 'utf8'));
    assert.deepEqual(marker, buildMarker('1.2.3', skillFiles(INPUTS)));
    // No temp files left behind.
    assert.deepEqual((await fs.readdir(r.dir)).sort(), [...NAMES, SKILL_MARKER_NAME].sort());
  }));

test('status: outdated when the version changes, and for a changed template, guide, schema or example', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    const changes: Partial<SkillInputs>[] = [
      { version: '1.3.0' },
      { template: 'new {{VERSION}}' },
      { guide: 'new guide' },
      { schema: '{}' },
      { example: '{"name":"Other"}' },
      { themesDir: '/elsewhere' },
    ];
    for (const c of changes) {
      r.inputs.current = { ...INPUTS, ...c };
      assert.equal(await r.skill.status(), 'outdated', JSON.stringify(c));
    }
    r.inputs.current = INPUTS;
    assert.equal(await r.skill.status(), 'installed');
  }));

test('status: unchanged when the sources cannot be read', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    const down = rig(root, { sources: async () => ({ ok: false, message: 'gone' }) });
    assert.equal(await down.skill.status(), 'installed');
  }));

test('status: modified when a file is edited', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.appendFile(path.join(r.dir, 'guide.md'), 'my notes\n');
    assert.equal(await r.skill.status(), 'modified');
  }));

test('status: modified when a listed file is deleted', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.unlink(path.join(r.dir, 'SKILL.md'));
    assert.equal(await r.skill.status(), 'modified');
  }));

test('status: modified wins over outdated', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.appendFile(path.join(r.dir, 'guide.md'), 'x');
    r.inputs.current = { ...INPUTS, version: '9.9.9' };
    assert.equal(await r.skill.status(), 'modified');
  }));

test('status: foreign when there are files but no marker', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    await fs.writeFile(path.join(r.dir, 'SKILL.md'), 'someone else');
    assert.equal(await r.skill.status(), 'foreign');
  }));

test('status: foreign when the folder is a symlink', () =>
  withTemp(async (root) => {
    const r = rig(root);
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await fs.mkdir(path.dirname(r.dir), { recursive: true });
    await fs.symlink(other, r.dir);
    assert.equal(await r.skill.status(), 'foreign');
  }));

test('status: foreign when the path is a file', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(path.dirname(r.dir), { recursive: true });
    await fs.writeFile(r.dir, 'x');
    assert.equal(await r.skill.status(), 'foreign');
  }));

test('status: foreign when the marker has a different owner, or does not parse', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    await fs.writeFile(path.join(r.dir, 'SKILL.md'), 'x');
    await fs.writeFile(path.join(r.dir, SKILL_MARKER_NAME), JSON.stringify({ owner: 'someone.else', version: '1', files: {} }));
    assert.equal(await r.skill.status(), 'foreign');
    await fs.writeFile(path.join(r.dir, SKILL_MARKER_NAME), '{ not json');
    assert.equal(await r.skill.status(), 'foreign');
    await fs.writeFile(path.join(r.dir, SKILL_MARKER_NAME), JSON.stringify({ owner: SKILL_OWNER, files: [] }));
    assert.equal(await r.skill.status(), 'foreign');
  }));

// ---------------------------------------------------------------------------------------------------------------------
// install

test('install: refuses a foreign folder, names it, and leaves its files untouched', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    await fs.writeFile(path.join(r.dir, 'SKILL.md'), 'mine');
    const res = await r.skill.install();
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.message.includes('~/skills/middle-management-theme'), res.message);
    assert.deepEqual(await fs.readdir(r.dir), ['SKILL.md']);
    assert.equal(await fs.readFile(path.join(r.dir, 'SKILL.md'), 'utf8'), 'mine');
  }));

test('install: does not write through a symlinked folder', () =>
  withTemp(async (root) => {
    const r = rig(root);
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await fs.mkdir(path.dirname(r.dir), { recursive: true });
    await fs.symlink(other, r.dir);
    assert.equal((await r.skill.install()).ok, false);
    assert.deepEqual(await fs.readdir(other), []);
  }));

test('install: the marker is written last, so a failed write leaves none', () =>
  withTemp(async (root) => {
    const r = rig(root);
    r.failWriteNumber.n = 3;
    const res = await r.skill.install();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /disk full/);
    // Nothing of ours had been there before, so what was written is taken away again.
    await assert.rejects(fs.stat(r.dir));
    assert.equal(await r.skill.status(), 'missing');
  }));

test('install: a failed first install in an existing empty folder removes what it wrote and the folder', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    r.failWriteNumber.n = 5; // the marker
    assert.equal((await r.skill.install()).ok, false);
    await assert.rejects(fs.stat(r.dir));
    assert.equal(await r.skill.status(), 'missing');
  }));

test('install: a failed install over our own install keeps what was written, and a retry works', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    r.inputs.current = { ...INPUTS, version: '2.0.0' };
    r.failWriteNumber.n = 8; // the refresh's 3rd write (writes 1-5 were the first install)
    assert.equal((await r.skill.install()).ok, false);
    const names = await fs.readdir(r.dir);
    assert.ok(names.includes(SKILL_MARKER_NAME));
    assert.ok((await fs.readFile(path.join(r.dir, 'SKILL.md'), 'utf8')).startsWith('Skill v2.0.0'));
    // The old marker is still there and SKILL.md no longer matches it.
    assert.equal(await r.skill.status(), 'modified');
    r.failWriteNumber.n = undefined;
    assert.deepEqual(await r.skill.install(), { ok: true });
    assert.equal(await r.skill.status(), 'installed');
  }));

test('install: over our own marker, files the old version listed and the new one lacks are deleted', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    // Pretend an older version also shipped legacy.md, and the user added notes.md.
    await fs.writeFile(path.join(r.dir, 'legacy.md'), 'old');
    await fs.writeFile(path.join(r.dir, 'notes.md'), 'mine');
    const markerPath = path.join(r.dir, SKILL_MARKER_NAME);
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    marker.files['legacy.md'] = fileHash('old');
    marker.files['../outside.md'] = 'x';
    await fs.writeFile(markerPath, JSON.stringify(marker));
    assert.deepEqual(await r.skill.install(), { ok: true });
    assert.deepEqual((await fs.readdir(r.dir)).sort(), [...NAMES, SKILL_MARKER_NAME, 'notes.md'].sort());
    assert.equal(await r.skill.status(), 'installed');
  }));

test('install: overwrites a modified install', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.writeFile(path.join(r.dir, 'guide.md'), 'edited');
    assert.equal(await r.skill.status(), 'modified');
    assert.deepEqual(await r.skill.install(), { ok: true });
    assert.equal(await r.skill.status(), 'installed');
    assert.equal(await fs.readFile(path.join(r.dir, 'guide.md'), 'utf8'), INPUTS.guide);
  }));

test('install: reports unreadable sources as a message and writes nothing', () =>
  withTemp(async (root) => {
    const r = rig(root, { sources: async () => ({ ok: false, message: 'media/skill/SKILL.md is missing' }) });
    assert.deepEqual(await r.skill.install(), { ok: false, message: 'media/skill/SKILL.md is missing' });
    await assert.rejects(fs.stat(r.dir));
  }));

test('install: a thrown dependency becomes a message, not an exception', () =>
  withTemp(async (root) => {
    const r = rig(root, { sources: async () => Promise.reject(new Error('boom')) });
    const res = await r.skill.install();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /boom/);
  }));

// ---------------------------------------------------------------------------------------------------------------------
// remove

test('remove: deletes only the listed files, keeps user files and the folder', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.writeFile(path.join(r.dir, 'notes.md'), 'mine');
    assert.deepEqual(await r.skill.remove(), { ok: true });
    assert.deepEqual(await fs.readdir(r.dir), ['notes.md']);
  }));

test('remove: removes the folder when nothing else is in it, and a second remove is fine', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    assert.deepEqual(await r.skill.remove(), { ok: true });
    await assert.rejects(fs.stat(r.dir));
    assert.deepEqual(await r.skill.remove(), { ok: true });
  }));

test('remove: works on a modified install', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.writeFile(path.join(r.dir, 'guide.md'), 'edited');
    assert.deepEqual(await r.skill.remove(), { ok: true });
    await assert.rejects(fs.stat(r.dir));
  }));

test('remove: refuses a foreign folder and touches nothing', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await fs.mkdir(r.dir, { recursive: true });
    await fs.writeFile(path.join(r.dir, 'SKILL.md'), 'mine');
    const res = await r.skill.remove();
    assert.equal(res.ok, false);
    assert.deepEqual(await fs.readdir(r.dir), ['SKILL.md']);
  }));

test('remove: ignores marker entries that are not plain names or not regular files', () =>
  withTemp(async (root) => {
    const r = rig(root);
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'keep');
    await fs.mkdir(r.dir, { recursive: true });
    await fs.mkdir(path.join(r.dir, 'sub'));
    await fs.writeFile(path.join(r.dir, 'sub', 'inner.txt'), 'keep');
    await fs.symlink(outside, path.join(r.dir, 'link.md'));
    await fs.writeFile(
      path.join(r.dir, SKILL_MARKER_NAME),
      JSON.stringify({ owner: SKILL_OWNER, version: '1', files: { '../../../outside.txt': 'a', 'sub/inner.txt': 'b', 'sub': 'c', 'link.md': 'd' } }),
    );
    assert.deepEqual(await r.skill.remove(), { ok: true });
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(r.dir, 'sub', 'inner.txt'), 'utf8'), 'keep');
    assert.ok((await fs.lstat(path.join(r.dir, 'link.md'))).isSymbolicLink());
    assert.ok(!(await fs.readdir(r.dir)).includes(SKILL_MARKER_NAME));
  }));

// ---------------------------------------------------------------------------------------------------------------------
// refreshIfOurs

test('refreshIfOurs: updates an outdated install', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    r.inputs.current = { ...INPUTS, version: '2.0.0' };
    await r.skill.refreshIfOurs();
    assert.equal(await r.skill.status(), 'installed');
    assert.ok((await fs.readFile(path.join(r.dir, 'SKILL.md'), 'utf8')).startsWith('Skill v2.0.0'));
  }));

test('refreshIfOurs: leaves a modified install alone', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    await fs.writeFile(path.join(r.dir, 'guide.md'), 'edited');
    r.inputs.current = { ...INPUTS, version: '2.0.0' };
    await r.skill.refreshIfOurs();
    assert.equal(await fs.readFile(path.join(r.dir, 'guide.md'), 'utf8'), 'edited');
    assert.equal(await r.skill.status(), 'modified');
  }));

test('refreshIfOurs: does nothing for missing and foreign, and never installs from scratch', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.refreshIfOurs();
    await assert.rejects(fs.stat(r.dir));
    await fs.mkdir(r.dir, { recursive: true });
    await fs.writeFile(path.join(r.dir, 'SKILL.md'), 'mine');
    await r.skill.refreshIfOurs();
    assert.deepEqual(await fs.readdir(r.dir), ['SKILL.md']);
  }));

test('refreshIfOurs: a failing refresh is logged and does not throw', () =>
  withTemp(async (root) => {
    const r = rig(root);
    await r.skill.install();
    r.inputs.current = { ...INPUTS, version: '2.0.0' };
    r.failWriteNumber.n = 6; // writes 1-5 were the first install (four files and the marker); the refresh's first write is number 6
    await r.skill.refreshIfOurs();
    assert.ok(r.logs.some((l) => l.includes('refresh failed')));
  }));

// ---------------------------------------------------------------------------------------------------------------------
// loadSkillSources

test('loadSkillSources: reads the four files from the extension folder', async () => {
  const seen: string[] = [];
  const texts: Record<string, string> = {
    [path.join('/ext', 'media', 'skill', 'SKILL.md')]: 'T',
    [path.join('/ext', 'media', 'theme.schema.json')]: 'S',
    [path.join('/ext', 'media', 'theme-guide.md')]: 'G',
    [path.join('/ext', 'media', 'themes', 'spaceship.theme.json')]: '{"name":"x"}',
  };
  const res = await loadSkillSources('/ext', async (p) => {
    seen.push(p);
    const t = texts[p];
    if (t === undefined) throw new Error('unexpected ' + p);
    return t;
  }, '0.6.0', '/themes');
  assert.deepEqual(res, {
    ok: true,
    inputs: { version: '0.6.0', themesDir: '/themes', template: 'T', schema: 'S', guide: 'G', example: '{"name":"x"}' },
  });
  assert.equal(seen.length, 4);
});

test('loadSkillSources: a missing file is an error result naming the file, not a throw', async () => {
  const res = await loadSkillSources('/ext', async (p) => {
    if (p.endsWith('theme-guide.md')) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return '{}';
  }, '1', '/t');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /theme-guide\.md/);
});

test('loadSkillSources: an example that is not a JSON object is an error result', async () => {
  const res = await loadSkillSources('/ext', async (p) => (p.endsWith('spaceship.theme.json') ? 'oops' : 'x'), '1', '/t');
  assert.equal(res.ok, false);
});
