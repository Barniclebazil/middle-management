import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FRONTMATTER_HEAD_BYTES,
  ancestorDirs,
  buildAgentsCatalog,
  buildSkillsCatalog,
  findInstalledPlugins,
  nodeConfigFs,
  parseFrontmatter,
  projectClaudeDirs,
  readAgentsCatalog,
  readFrontmatter,
  readSkillUsage,
  readSkillsCatalog,
  scanAgents,
  scanSkillsAndCommands,
  splitTopLevel,
} from '../src/claude/catalog.ts';
import type { ConfigFs } from '../src/claude/catalog.ts';
import { parseSkillUsage } from '../src/claude/claudeConfig.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { makeTempDir, rmTemp } from './claude-fixtures.ts';

async function tree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, content);
  }
}

function ids() {
  const map = new Map<string, string>();
  const calls: string[] = [];
  const fileIdFor = (p: string): string => {
    calls.push(p);
    let id = map.get(p);
    if (id === undefined) {
      id = `f${map.size + 1}`;
      map.set(p, id);
    }
    return id;
  };
  return { fileIdFor, calls, map };
}

/** A ConfigFs wrapper that records what was read. */
function spyFs(inner: ConfigFs = nodeConfigFs) {
  const heads: { path: string; max: number }[] = [];
  const whole: string[] = [];
  const spy: ConfigFs = {
    stat: (p) => inner.stat(p),
    readdir: (p) => inner.readdir(p),
    readHead: (p, max) => {
      heads.push({ path: p, max });
      return inner.readHead(p, max);
    },
    readFile: (p) => {
      whole.push(p);
      return inner.readFile(p);
    },
  };
  return { fs: spy, heads, whole };
}

const skill = (name: string, desc: string, extra = ''): string => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nBODY_SECRET_${name}\n`;

/** A fixture home with user, synced, project and plugin skills, commands and agents. Returns the pieces. */
async function fixture() {
  const tmp = await makeTempDir('catalog-');
  const home = path.join(tmp, 'home');
  const configDir = path.join(home, '.claude');
  const cwd = path.join(home, 'work', 'proj');
  const pluginRoot = path.join(configDir, 'plugins', 'cache', 'mkt', 'plug-key', '1.0.0');
  await tree(tmp, {
    'home/.claude/skills/alpha/SKILL.md': skill('alpha', 'Alpha from the user folder'),
    'home/.claude/skills/synced/org_1/beta/SKILL.md': `---\nname: beta\ndescription: Beta synced from the account\nlicense: x\n---\nBODY\n`,
    'home/.claude/skills/notaskill/README.md': 'no SKILL.md here',
    'home/.claude/commands/hello.md': '---\ndescription: Say hello\nargument-hint: "[who]"\n---\nBODY_SECRET_hello\n',
    'home/.claude/agents/scout.md': '---\nname: scout\ndescription: Scouts things\nmodel: haiku\ntools: Read, Grep, Bash(git log:*, git diff:*)\n---\nBODY_SECRET_scout\n',
    'home/work/proj/.claude/skills/gamma/SKILL.md': skill('gamma', 'Gamma from the project'),
    'home/work/proj/.claude/commands/deploy.md': '---\ndescription: Deploy it\n---\nBODY\n',
    'home/work/proj/.claude/commands/ops/restart.md': '---\ndescription: Restart a service\n---\nBODY\n',
    'home/work/proj/.claude/agents/builder.md': '---\nname: builder\ndescription: Builds\ntools:\n  - Read\n  - Edit\n  - Write\n---\nBODY\n',
    'home/work/proj/.claude/agents/everything.md': '---\nname: everything\ndescription: Has no tools key\n---\nBODY\n',
    'home/work/proj/.claude/agents/star.md': '---\nname: star\ndescription: All tools by star\ntools: "*"\n---\nBODY\n',
    'home/.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'plug-key@mkt': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] } }),
    'home/.claude/plugins/cache/mkt/plug-key/1.0.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'plug', description: 'SENTINEL_MANIFEST' }),
    'home/.claude/plugins/cache/mkt/plug-key/1.0.0/skills/delta/SKILL.md': skill('delta', 'Delta from a plugin'),
    'home/.claude/plugins/cache/mkt/plug-key/1.0.0/commands/run.md': '---\ndescription: Run the plugin\n---\nBODY\n',
    'home/.claude/plugins/cache/mkt/plug-key/1.0.0/agents/helper.md': '---\nname: helper\ndescription: Plugin helper\ntools: [Read, Glob]\n---\nBODY\n',
    // A marketplace catalogue copy is NOT an install and must never be scanned.
    'home/.claude/plugins/marketplaces/mkt/plugins/catalogue-only/skills/ghostskill/SKILL.md': skill('ghostskill', 'Not installed'),
  });
  return { tmp, home, configDir, cwd, opts: { cwd, home, configDir, fs: nodeConfigFs } };
}

const SDK_COMMANDS = [
  { name: 'clear', description: 'Clear the conversation', argumentHint: '', builtin: true },
  { name: 'dataviz', description: 'A bundled skill', argumentHint: '', builtin: true },
  { name: 'alpha', description: 'Alpha (from the SDK)', argumentHint: '' },
  { name: 'beta', description: '', argumentHint: '', aliases: ['bundle:beta'] },
  { name: 'gamma', description: 'Gamma (from the SDK)', argumentHint: '' },
  { name: 'deploy', description: '', argumentHint: '' },
  { name: 'hello', description: 'Say hello (SDK)', argumentHint: '' },
  { name: 'ops:restart', description: '', argumentHint: '' },
  { name: 'plug:delta', description: '', argumentHint: '' },
  { name: 'plug:run', description: '', argumentHint: '[env]' },
  { name: 'ghost:thing', description: 'A plugin we cannot see on disk', argumentHint: '' },
  { name: 'loose', description: 'Nothing on disk explains this', argumentHint: '' },
  { name: '__internal', description: 'hidden', argumentHint: '', builtin: true },
];

// --- front matter -----------------------------------------------------------------------------------------------------

test('parseFrontmatter: plain, quoted, folded, lists and nested pairs', () => {
  const fm = parseFrontmatter(
    [
      '---',
      'name: plain name',
      'description: >-',
      '  first line',
      '  second line',
      '',
      '  third',
      'quoted: "He said \\"hi\\""',
      "single: 'it''s'",
      'comment: value # trailing comment',
      'tools: Read, Grep, Bash(git add:*, git commit:*)',
      'inline: [a, "b c", d]',
      'block:',
      '  - one',
      '  - two',
      'metadata:',
      '  type: feedback',
      '  other: x',
      'flow: {type: user, k: v}',
      'empty:',
      '---',
      'body: not a key',
    ].join('\n'),
  );
  assert.equal(fm.get('name'), 'plain name');
  assert.equal(fm.get('description'), 'first line second line third');
  assert.equal(fm.get('quoted'), 'He said "hi"');
  assert.equal(fm.get('single'), "it's");
  assert.equal(fm.get('comment'), 'value');
  assert.equal(fm.get('tools'), 'Read, Grep, Bash(git add:*, git commit:*)');
  assert.deepEqual(fm.get('inline'), ['a', 'b c', 'd']);
  assert.deepEqual(fm.get('block'), ['one', 'two']);
  assert.deepEqual({ ...(fm.get('metadata') as object) }, { type: 'feedback', other: 'x' });
  assert.deepEqual({ ...(fm.get('flow') as object) }, { type: 'user', k: 'v' });
  assert.equal(fm.get('empty'), '');
  assert.equal(fm.has('body'), false, 'nothing after the closing marker is read');
});

test('parseFrontmatter: CRLF, lone CR, BOM and trailing spaces on the markers', () => {
  const crlf = parseFrontmatter('---\r\nname: win\r\ndescription: >\r\n  folded\r\n  text\r\ntools: [A, B]\r\n---\r\nbody\r\n');
  assert.equal(crlf.get('name'), 'win');
  assert.equal(crlf.get('description'), 'folded text');
  assert.deepEqual(crlf.get('tools'), ['A', 'B']);
  assert.equal(parseFrontmatter('---\rname: mac\r---\rbody').get('name'), 'mac');
  assert.equal(parseFrontmatter('﻿---\nname: bom\n---\n').get('name'), 'bom');
  assert.equal(parseFrontmatter('---  \nname: sp\n---   \n').get('name'), 'sp');
  assert.equal(parseFrontmatter('---\nname: dots\n...\n').get('name'), 'dots');
});

test('parseFrontmatter: missing, malformed, unclosed and odd input give an empty map, never a throw', () => {
  for (const bad of ['', 'no front matter at all\nname: x', '\n---\nname: x\n---\n', '---\nname: never closed\ndescription: x', '---', '---\n---\n', '--- \tx\nname: y\n---\n', '```\n---\nname: x\n---']) {
    assert.equal(parseFrontmatter(bad).size, 0, JSON.stringify(bad));
  }
  const odd = parseFrontmatter('---\n: no key\n- stray item\n  indented junk\nname: ok\n%%%: bad\n---\n');
  assert.deepEqual([...odd.keys()], ['name']);
  assert.equal(parseFrontmatter('---\nkey: [unclosed, list\nother: ok\n---\n').get('key'), '');
});

test('parseFrontmatter: __proto__ and duplicate keys, control characters, long values', () => {
  const fm = parseFrontmatter('---\n__proto__: bad\nname: first\nname: second\ndesc: a\u0001b\tc\n---\n');
  assert.equal(fm.has('__proto__'), false);
  assert.equal(fm.get('name'), 'first');
  assert.equal(fm.get('desc'), 'a b c');
  assert.equal(({} as Record<string, unknown>)['bad'], undefined);
  const long = parseFrontmatter(`---\ndescription: ${'x'.repeat(5000)}\n---\n`);
  assert.ok((long.get('description') as string).length <= 2000);
});

test('readFrontmatter: reads only the head; a huge front matter is ignored; a huge body is never read', async () => {
  const tmp = await makeTempDir('catalog-fm-');
  try {
    const bigBody = '---\nname: big-body\ndescription: small front matter\n---\n' + 'BODY_SECRET\n'.repeat(200_000);
    const hugeFm = '---\nname: huge\ndescription: ' + 'y'.repeat(FRONTMATTER_HEAD_BYTES * 2) + '\n---\nbody\n';
    await tree(tmp, { 'a.md': bigBody, 'b.md': hugeFm, 'c.md': '---\nname: [broken\n---\n' });
    const { fs: spy, heads, whole } = spyFs();
    const a = await readFrontmatter(spy, path.join(tmp, 'a.md'));
    assert.equal(a.get('name'), 'big-body');
    assert.equal(JSON.stringify([...a]).includes('BODY_SECRET'), false);
    assert.equal((await readFrontmatter(spy, path.join(tmp, 'b.md'))).size, 0);
    assert.equal((await readFrontmatter(spy, path.join(tmp, 'missing.md'))).size, 0);
    assert.equal(whole.length, 0, 'never reads a whole file');
    assert.ok(heads.length >= 3 && heads.every((h) => h.max === FRONTMATTER_HEAD_BYTES));
  } finally {
    await rmTemp(tmp);
  }
});

test('splitTopLevel: commas inside brackets, parentheses and quotes stay put', () => {
  assert.deepEqual(splitTopLevel('Read, Bash(a, b), "x, y", [1, 2] ,'), ['Read', 'Bash(a, b)', '"x, y"', '[1, 2]']);
});

// --- skills and commands ----------------------------------------------------------------------------------------------

test('skills catalog: source tagging, plugin naming, kinds, descriptions and fileIds', async () => {
  const f = await fixture();
  try {
    const reg = ids();
    const cat = await readSkillsCatalog({ ...f.opts, sdkCommands: SDK_COMMANDS, skillUsage: new Map(), fileIdFor: reg.fileIdFor });
    const skills = Object.fromEntries(cat.skills.map((s) => [s.invoke, s]));
    const commands = Object.fromEntries(cat.commands.map((c) => [c.invoke, c]));

    assert.deepEqual(Object.keys(skills).sort(), ['alpha', 'beta', 'gamma', 'ghost:thing', 'loose', 'plug:delta']);
    assert.equal(skills['alpha']!.source, 'user');
    assert.equal(skills['alpha']!.description, 'Alpha (from the SDK)', 'the SDK description wins');
    assert.equal(skills['beta']!.source, 'synced');
    assert.equal(skills['beta']!.description, 'Beta synced from the account', 'front matter fills an empty SDK description');
    assert.equal(skills['gamma']!.source, 'project');
    assert.deepEqual({ name: skills['plug:delta']!.name, source: skills['plug:delta']!.source, plugin: skills['plug:delta']!.plugin }, { name: 'delta', source: 'plugin', plugin: 'plug' });
    assert.equal(skills['plug:delta']!.description, 'Delta from a plugin');
    // Unmatched: a colon name is a plugin item without a file; a bare one has no better home than 'user'.
    assert.deepEqual({ ...skills['ghost:thing']! }, { name: 'thing', invoke: 'ghost:thing', description: 'A plugin we cannot see on disk', source: 'plugin', plugin: 'ghost' });
    assert.deepEqual({ ...skills['loose']! }, { name: 'loose', invoke: 'loose', description: 'Nothing on disk explains this', source: 'user' });
    assert.ok(!('ghostskill' in skills) && !Object.keys(skills).some((k) => k.includes('ghostskill')), 'a marketplace catalogue copy is not an install');

    assert.deepEqual(Object.keys(commands).sort(), ['clear', 'dataviz', 'deploy', 'hello', 'ops:restart', 'plug:run']);
    assert.equal(commands['clear']!.source, 'builtin');
    assert.equal(commands['clear']!.fileId, undefined);
    assert.equal(commands['dataviz']!.source, 'builtin', 'bundled skills are built-in commands (no builtin skill source)');
    assert.equal(commands['hello']!.source, 'user');
    assert.equal(commands['hello']!.argumentHint, '[who]', 'the SDK row has an empty hint: front matter fills it');
    assert.equal(commands['deploy']!.source, 'project');
    assert.equal(commands['deploy']!.description, 'Deploy it');
    assert.equal(commands['ops:restart']!.source, 'project');
    assert.deepEqual({ plugin: commands['plug:run']!.plugin, source: commands['plug:run']!.source, name: commands['plug:run']!.name, hint: commands['plug:run']!.argumentHint }, { plugin: 'plug', source: 'plugin', name: 'run', hint: '[env]' });
    assert.ok(!('__internal' in commands));

    // fileIds: present for everything found on disk, absent otherwise, and the registry saw absolute SKILL.md / .md paths.
    for (const s of [skills['alpha']!, skills['beta']!, skills['gamma']!, skills['plug:delta']!, commands['hello']!, commands['deploy']!, commands['plug:run']!]) assert.match(s.fileId ?? '', /^f\d+$/);
    assert.equal(skills['loose']!.fileId, undefined);
    assert.equal(skills['ghost:thing']!.fileId, undefined);
    assert.ok(reg.calls.length > 0 && reg.calls.every((c) => path.isAbsolute(c) && f.opts.cwd !== undefined));
    assert.ok(reg.calls.includes(path.join(f.configDir, 'skills', 'alpha', 'SKILL.md')));
    assert.ok(reg.calls.includes(path.join(f.cwd, '.claude', 'commands', 'deploy.md')));

    // No absolute path (and no body) anywhere in the items.
    const json = JSON.stringify(cat);
    assert.equal(json.includes(f.tmp), false);
    assert.equal(json.includes('BODY_SECRET'), false);
    assert.equal(json.includes('SENTINEL_MANIFEST'), false);
    assert.equal(cat.truncated, false);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('skills catalog: usage joins on the bare name; stale rows and rows-less skills', async () => {
  const f = await fixture();
  try {
    const usage = parseSkillUsage({
      skillUsage: {
        alpha: { usageCount: 12, lastUsedAt: 1_700_000_000_000 },
        delta: { usageCount: 3, lastUsedAt: 1_700_000_000_001 },
        'bundle:beta': { usageCount: 4 },
        'removed-skill': { usageCount: 99, lastUsedAt: 1 },
        clear: { usageCount: 50 },
        hello: { usageCount: 8 },
      },
    });
    const cat = await readSkillsCatalog({ ...f.opts, sdkCommands: SDK_COMMANDS, skillUsage: usage, fileIdFor: ids().fileIdFor });
    const by = (inv: string) => cat.skills.find((s) => s.invoke === inv)!;
    assert.deepEqual([by('alpha').uses, by('alpha').lastUsedAt], [12, 1_700_000_000_000]);
    assert.deepEqual([by('plug:delta').uses, by('plug:delta').lastUsedAt], [3, 1_700_000_000_001], 'plugin item joins on its bare name');
    assert.equal(by('beta').uses, 4, 'an alias row joins too');
    assert.equal(by('gamma').uses, undefined, 'no row: no record, not zero');
    assert.equal('lastUsedAt' in by('beta'), false);
    assert.equal(cat.skills.some((s) => s.name === 'removed-skill'), false, 'stale rows add nothing');
    assert.equal(JSON.stringify(cat.commands).includes('50'), false, 'commands carry no usage');
    assert.equal(cat.commands.find((c) => c.invoke === 'hello')!.name, 'hello');
  } finally {
    await rmTemp(f.tmp);
  }
});

test('skills catalog: filesystem-only fallback when the SDK list is missing or empty', async () => {
  const f = await fixture();
  try {
    for (const sdk of [undefined, null, [], 'nope', {}]) {
      const cat = await readSkillsCatalog({ ...f.opts, sdkCommands: sdk, skillUsage: parseSkillUsage({ skillUsage: { alpha: { usageCount: 2 } } }), fileIdFor: ids().fileIdFor });
      assert.deepEqual(cat.skills.map((s) => [s.invoke, s.source]), [['alpha', 'user'], ['beta', 'synced'], ['plug:delta', 'plugin'], ['gamma', 'project']]);
      assert.deepEqual(cat.commands.map((c) => [c.invoke, c.source]), [['deploy', 'project'], ['hello', 'user'], ['ops:restart', 'project'], ['plug:run', 'plugin']]);
      assert.equal(cat.skills.find((s) => s.invoke === 'alpha')!.uses, 2);
      assert.ok(cat.skills.every((s) => s.fileId !== undefined) && cat.commands.every((c) => c.fileId !== undefined));
      assert.equal(cat.commands.find((c) => c.invoke === 'hello')!.argumentHint, '[who]');
      assert.equal(cat.commands.some((c) => c.source === 'builtin'), false);
    }
    // A bare machine: nothing on disk and no SDK list.
    const empty = await makeTempDir('catalog-empty-');
    try {
      const cat = await readSkillsCatalog({ cwd: path.join(empty, 'p'), home: empty, configDir: path.join(empty, '.claude'), fs: nodeConfigFs, skillUsage: new Map(), fileIdFor: ids().fileIdFor });
      assert.deepEqual(cat, { skills: [], commands: [], truncated: false });
    } finally {
      await rmTemp(empty);
    }
  } finally {
    await rmTemp(f.tmp);
  }
});

test('skills catalog: a builtin row beats an unmarked duplicate; duplicates collapse; names and descriptions are cut', () => {
  const cat = buildSkillsCatalog({
    sdkCommands: [
      { name: 'dup', description: 'plain' },
      { name: 'dup', description: 'built in', builtin: true },
      { name: '/slashed', description: 'x'.repeat(1000), argumentHint: 'h'.repeat(1000) },
      { name: 'n'.repeat(1000), description: 'long name' },
      { name: 'ctl\u0000x', description: 'a\nb\tc' },
      'junk',
      null,
      { description: 'no name' },
      { name: 42 },
    ],
    scan: { items: [] },
    usage: new Map(),
    fileIdFor: ids().fileIdFor,
  });
  assert.equal(cat.commands.find((c) => c.invoke === 'dup')!.source, 'builtin');
  assert.equal(cat.skills.filter((s) => s.invoke === 'dup').length, 0);
  const slashed = cat.skills.find((s) => s.invoke === 'slashed')!;
  assert.equal(slashed.description.length, LIMITS.descriptionChars);
  assert.ok(slashed.description.endsWith('…'));
  assert.ok(cat.skills.some((s) => s.name.length === LIMITS.nameChars && s.name.endsWith('…')));
  assert.equal(cat.skills.find((s) => s.invoke === 'ctl x')!.description, 'a b c');
  assert.equal(cat.skills.length + cat.commands.length, 4);
});

test('skills catalog: caps counts, sets truncated, and asks for ids only for kept items', () => {
  const sdk: unknown[] = [];
  const items = [];
  for (let i = 0; i < 350; i++) {
    sdk.push({ name: `s${String(i).padStart(3, '0')}`, description: 'd' });
    items.push({ kind: 'skill' as const, source: 'user' as const, name: `s${String(i).padStart(3, '0')}`, keys: [`s${String(i).padStart(3, '0')}`], file: `/cfg/skills/s${i}/SKILL.md` });
  }
  for (let i = 0; i < 320; i++) sdk.push({ name: `c${String(i).padStart(3, '0')}`, description: 'd', builtin: true });
  const reg = ids();
  const cat = buildSkillsCatalog({ sdkCommands: sdk, scan: { items }, usage: new Map(), fileIdFor: reg.fileIdFor });
  assert.equal(cat.skills.length, LIMITS.catalogSkills);
  assert.equal(cat.commands.length, LIMITS.catalogCommands);
  assert.equal(cat.truncated, true);
  assert.equal(reg.calls.length, LIMITS.catalogSkills, 'ids only for items that survive the cap');
  assert.equal(cat.skills[0]!.name, 's000', 'sorted by name before cutting');
  const small = buildSkillsCatalog({ sdkCommands: [{ name: 'only', description: '' }], scan: { items: [] }, usage: new Map(), fileIdFor: reg.fileIdFor });
  assert.equal(small.truncated, false);
});

test('skills catalog: a fileIdFor that throws or returns an empty id just leaves the fileId off', () => {
  const scan = { items: [{ kind: 'skill' as const, source: 'user' as const, name: 'a', keys: ['a'], file: '/x/a/SKILL.md' }] };
  for (const fileIdFor of [() => { throw new Error('boom'); }, () => '']) {
    const cat = buildSkillsCatalog({ sdkCommands: [{ name: 'a', description: 'x' }], scan, usage: new Map(), fileIdFor });
    assert.equal(cat.skills[0]!.fileId, undefined);
    assert.equal(cat.skills[0]!.source, 'user');
  }
});

test('skills scan: front matter name overrides the folder name, the folder name still matches; odd files are skipped', async () => {
  const tmp = await makeTempDir('catalog-names-');
  try {
    const configDir = path.join(tmp, '.claude');
    await tree(tmp, {
      '.claude/skills/folder-name/SKILL.md': skill('shown-name', 'Renamed'),
      '.claude/skills/broken/SKILL.md': '---\nname: [oops\n---\n',
      '.claude/skills/nofm/SKILL.md': 'just text, no front matter\n',
      '.claude/skills/.hidden/SKILL.md': skill('hidden', 'x'),
      '.claude/skills/not-a-dir': 'file',
    });
    const scan = await scanSkillsAndCommands({ cwd: path.join(tmp, 'p'), home: tmp, configDir, fs: nodeConfigFs });
    const byName = Object.fromEntries(scan.items.map((i) => [i.name, i]));
    assert.deepEqual(Object.keys(byName).sort(), ['broken', 'nofm', 'shown-name']);
    assert.deepEqual(byName['shown-name']!.keys, ['shown-name', 'folder-name']);
    assert.equal(byName['nofm']!.description, undefined);
    // The SDK lists it under either name.
    const cat = buildSkillsCatalog({ sdkCommands: [{ name: 'folder-name', description: 'x' }], scan, usage: new Map(), fileIdFor: ids().fileIdFor });
    assert.equal(cat.skills[0]!.source, 'user');
    assert.equal(cat.skills[0]!.fileId, 'f1');
  } finally {
    await rmTemp(tmp);
  }
});

test('skills scan: heads only, never a whole file, and never anything outside the catalog folders', async () => {
  const f = await fixture();
  try {
    await tree(f.tmp, { 'home/.claude/.credentials.json': 'SENTINEL_CREDS', 'home/.claude/history.jsonl': 'SENTINEL_HISTORY', 'home/.claude.json': 'SENTINEL_STATE' });
    const { fs: spy, heads, whole } = spyFs();
    await scanSkillsAndCommands({ ...f.opts, fs: spy });
    await scanAgents({ ...f.opts, fs: spy });
    assert.ok(heads.length > 5);
    assert.ok(heads.every((h) => h.max === FRONTMATTER_HEAD_BYTES));
    // Whole-file reads: only the two small plugin JSON files.
    assert.ok(whole.every((p) => p.endsWith('installed_plugins.json') || p.endsWith('plugin.json')), whole.join(','));
    const touched = [...heads.map((h) => h.path), ...whole];
    assert.ok(touched.every((p) => !/credentials|history|\.claude\.json|sessions|session-env|paste-cache|file-history/.test(p)));
  } finally {
    await rmTemp(f.tmp);
  }
});

// --- plugins ----------------------------------------------------------------------------------------------------------

test('plugins: installed_plugins.json (v2 and flat v1), manifest name, and the cache fallback', async () => {
  const tmp = await makeTempDir('catalog-plug-');
  try {
    const cfg = path.join(tmp, '.claude');
    const a = path.join(cfg, 'plugins', 'cache', 'm', 'one', '1.0.0');
    const b = path.join(cfg, 'plugins', 'cache', 'm', 'two', '2.0.0');
    await tree(tmp, {
      '.claude/plugins/cache/m/one/1.0.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'one-manifest' }),
      '.claude/plugins/cache/m/two/2.0.0/skills/s/SKILL.md': skill('s', 'x'),
    });
    // v2 shape, one plugin with a manifest name and one without a manifest.
    await tree(tmp, { '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'one@m': [{ installPath: a }], 'two@m': [{ installPath: b }, { installPath: b }], 'gone@m': [{ installPath: path.join(cfg, 'nope') }], 'bad@m': 'x' } }) });
    assert.deepEqual((await findInstalledPlugins(nodeConfigFs, cfg)).map((p) => p.name), ['one-manifest', 'two']);
    // flat v1 shape
    await tree(tmp, { '.claude/plugins/installed_plugins.json': JSON.stringify({ 'one@m': { installPath: a } }) });
    assert.deepEqual((await findInstalledPlugins(nodeConfigFs, cfg)).map((p) => p.name), ['one-manifest']);
    // damaged or absent file: fall back to the cache layout (newest version folder)
    for (const text of ['{not json', '[]', '{"plugins":{}}']) {
      await tree(tmp, { '.claude/plugins/installed_plugins.json': text });
      assert.deepEqual((await findInstalledPlugins(nodeConfigFs, cfg)).map((p) => p.name).sort(), ['one-manifest', 'two'], text);
    }
    await fs.promises.rm(path.join(cfg, 'plugins', 'installed_plugins.json'));
    assert.equal((await findInstalledPlugins(nodeConfigFs, cfg)).length, 2);
    // nothing at all
    assert.deepEqual(await findInstalledPlugins(nodeConfigFs, path.join(tmp, 'elsewhere')), []);
  } finally {
    await rmTemp(tmp);
  }
});

// --- agents -----------------------------------------------------------------------------------------------------------

const SDK_AGENTS = [
  { name: 'Explore', description: 'Fast read-only search agent', model: 'inherit' },
  { name: 'Plan', description: 'Architect' },
  { name: 'scout', description: 'Scouts (SDK text)', model: 'sonnet' },
  { name: 'builder', description: '' },
  { name: 'everything', description: 'Has no tools key' },
  { name: 'star', description: 'x' },
  { name: 'plug:helper', description: 'Plugin helper' },
  { name: 'other:thing', description: 'Plugin we cannot see' },
  '??',
];

test('agents catalog: builtin, user, project and plugin sources; tools and model from front matter', async () => {
  const f = await fixture();
  try {
    const reg = ids();
    const cat = await readAgentsCatalog({ ...f.opts, sdkAgents: SDK_AGENTS, fileIdFor: reg.fileIdFor });
    const by = Object.fromEntries(cat.agents.map((a) => [a.name, a]));
    assert.deepEqual(Object.keys(by).sort(), ['Explore', 'Plan', 'builder', 'everything', 'other:thing', 'plug:helper', 'scout', 'star']);
    assert.deepEqual({ ...by['Explore']! }, { name: 'Explore', description: 'Fast read-only search agent', source: 'builtin', model: 'inherit' });
    assert.equal(by['Plan']!.fileId, undefined);
    assert.equal(by['Plan']!.tools, undefined);
    assert.equal(by['scout']!.source, 'user');
    assert.equal(by['scout']!.model, 'sonnet', 'the SDK model wins over the file');
    assert.equal(by['scout']!.description, 'Scouts (SDK text)');
    assert.deepEqual(by['scout']!.tools, ['Read', 'Grep', 'Bash(git log:*, git diff:*)']);
    assert.equal(by['builder']!.source, 'project');
    assert.deepEqual(by['builder']!.tools, ['Read', 'Edit', 'Write']);
    assert.equal(by['builder']!.description, 'Builds', 'file text fills an empty SDK description');
    assert.equal('tools' in by['everything']!, false, 'no tools key: all tools');
    assert.equal('tools' in by['star']!, false, '"*": all tools');
    assert.deepEqual({ source: by['plug:helper']!.source, plugin: by['plug:helper']!.plugin, tools: by['plug:helper']!.tools }, { source: 'plugin', plugin: 'plug', tools: ['Read', 'Glob'] });
    assert.deepEqual({ source: by['other:thing']!.source, plugin: by['other:thing']!.plugin, fileId: by['other:thing']!.fileId }, { source: 'plugin', plugin: 'other', fileId: undefined });
    for (const n of ['scout', 'builder', 'everything', 'star', 'plug:helper']) assert.match(by[n]!.fileId ?? '', /^f\d+$/);
    assert.equal(reg.calls.some((c) => !path.isAbsolute(c)), false);
    const json = JSON.stringify(cat);
    assert.equal(json.includes(f.tmp), false);
    assert.equal(json.includes('BODY_SECRET'), false);
    assert.equal(cat.truncated, false);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('agents catalog: filesystem-only fallback, and the scan alone sets the list', async () => {
  const f = await fixture();
  try {
    for (const sdk of [undefined, [], 7]) {
      const cat = await readAgentsCatalog({ ...f.opts, sdkAgents: sdk, fileIdFor: ids().fileIdFor });
      assert.deepEqual(cat.agents.map((a) => [a.name, a.source]), [['builder', 'project'], ['everything', 'project'], ['plug:helper', 'plugin'], ['scout', 'user'], ['star', 'project']]);
      assert.equal(cat.agents.find((a) => a.name === 'scout')!.model, 'haiku');
      assert.ok(cat.agents.every((a) => a.fileId !== undefined));
    }
  } finally {
    await rmTemp(f.tmp);
  }
});

test('agents catalog: agent count is capped and ids are asked only for kept items', () => {
  const many = { agents: Array.from({ length: 130 }, (_, i) => ({ source: 'user' as const, name: `a${String(i).padStart(3, '0')}`, file: `/c/${i}.md` })) };
  const reg = ids();
  const capped = buildAgentsCatalog({ sdkAgents: undefined, scan: many, fileIdFor: reg.fileIdFor });
  assert.equal(capped.agents.length, LIMITS.agentTypes);
  assert.equal(capped.truncated, true);
  assert.equal(reg.calls.length, LIMITS.agentTypes);
});

test('agents scan: caps tools per agent and name length, dedupes, ignores a body that looks like tools', async () => {
  const tmp = await makeTempDir('catalog-tools-');
  try {
    const cfg = path.join(tmp, '.claude');
    const many = Array.from({ length: 100 }, (_, i) => `T${i}`).join(', ');
    await tree(tmp, {
      '.claude/agents/wide.md': `---\nname: wide\ndescription: d\ntools: ${many}, T1, ${'L'.repeat(500)}\n---\ntools: BODY_SECRET\n`,
      '.claude/agents/dupes.md': '---\nname: dupes\ndescription: d\ntools: Read, Read, Edit\n---\n',
      '.claude/agents/empty.md': '---\nname: empty\ndescription: d\ntools:\n---\n',
      '.claude/agents/nofm.md': 'no front matter\n',
      '.claude/agents/crlf.md': '---\r\nname: crlf\r\ndescription: d\r\ntools: A, B\r\n---\r\nbody\r\n',
    });
    const scan = await scanAgents({ cwd: path.join(tmp, 'p'), home: tmp, configDir: cfg, fs: nodeConfigFs });
    const by = Object.fromEntries(scan.agents.map((a) => [a.name, a]));
    assert.equal(by['wide']!.tools!.length, LIMITS.toolsPerAgent);
    assert.ok(by['wide']!.tools!.every((t) => t.length <= LIMITS.toolNameChars));
    assert.deepEqual(by['dupes']!.tools, ['Read', 'Edit']);
    assert.equal(by['empty']!.tools, undefined);
    assert.equal(by['nofm']!.name, 'nofm');
    assert.equal(by['nofm']!.description, undefined);
    assert.deepEqual(by['crlf']!.tools, ['A', 'B']);
    assert.equal(JSON.stringify(scan).includes('BODY_SECRET'), false);
  } finally {
    await rmTemp(tmp);
  }
});

// --- project folders ---------------------------------------------------------------------------------------------------

test('ancestorDirs: nearest first, stops after home (inclusive) or at the root; relative cwd gives nothing', () => {
  assert.deepEqual(ancestorDirs('/home/u/a/b', '/home/u'), ['/home/u/a/b', '/home/u/a', '/home/u']);
  assert.deepEqual(ancestorDirs('/home/u', '/home/u'), ['/home/u']);
  assert.deepEqual(ancestorDirs('/srv/x/y', '/home/u'), ['/srv/x/y', '/srv/x', '/srv', '/']);
  assert.deepEqual(ancestorDirs('/', '/home/u'), ['/']);
  assert.deepEqual(ancestorDirs('rel/path', '/home/u'), []);
  assert.deepEqual(ancestorDirs('/home/user2/x', '/home/user'), ['/home/user2/x', '/home/user2', '/home', '/']);
});

test('projectClaudeDirs: the user config dir is not listed as a project dir', () => {
  assert.deepEqual(projectClaudeDirs('/home/u/p', '/home/u', '/home/u/.claude'), ['/home/u/p/.claude']);
  assert.deepEqual(projectClaudeDirs('/home/u/p', '/home/u', '/elsewhere/cfg'), ['/home/u/p/.claude', '/home/u/.claude']);
  assert.deepEqual(projectClaudeDirs('/home/u', '/home/u', '/home/u/.claude'), []);
});

test('project skills are found in parent folders up to home, nearest wins for the same name', async () => {
  const tmp = await makeTempDir('catalog-walk-');
  try {
    const home = path.join(tmp, 'home');
    await tree(tmp, {
      'home/.claude/settings.json': '{}',
      'home/mono/.claude/skills/shared/SKILL.md': skill('shared', 'From the repo root'),
      'home/mono/pkg/.claude/skills/shared/SKILL.md': skill('shared', 'From the package'),
      'home/mono/.claude/skills/rootonly/SKILL.md': skill('rootonly', 'Root'),
      'outside/.claude/skills/above/SKILL.md': skill('above', 'Above home'),
    });
    const cwd = path.join(home, 'mono', 'pkg');
    const scan = await scanSkillsAndCommands({ cwd, home, configDir: path.join(home, '.claude'), fs: nodeConfigFs });
    const shared = scan.items.filter((i) => i.name === 'shared');
    assert.equal(shared[0]!.description, 'From the package');
    const cat = buildSkillsCatalog({ sdkCommands: [{ name: 'shared', description: '' }, { name: 'rootonly', description: '' }], scan, usage: new Map(), fileIdFor: ids().fileIdFor });
    assert.equal(cat.skills.find((s) => s.invoke === 'shared')!.description, 'From the package');
    assert.equal(cat.skills.find((s) => s.invoke === 'rootonly')!.source, 'project');
    assert.equal(scan.items.some((i) => i.name === 'above'), false);
  } finally {
    await rmTemp(tmp);
  }
});

// --- skillUsage reader --------------------------------------------------------------------------------------------------

test('readSkillUsage: whitelist through the capped reader, one retry on a torn read, nothing else leaks', async () => {
  const body = JSON.stringify({ oauthAccount: { emailAddress: 'SENTINEL_EMAIL' }, mcpServers: { s: { env: { K: 'SENTINEL_ENV' } } }, skillUsage: { alpha: { usageCount: 3, lastUsedAt: 9 } } });
  let reads = 0;
  const flaky: ConfigFs = {
    stat: async () => ({ size: body.length, isFile: () => true, isDirectory: () => false }),
    readdir: async () => [],
    readHead: async () => '',
    readFile: async () => (++reads === 1 ? body.slice(0, 20) : body),
  };
  const m = await readSkillUsage('/x/.claude.json', flaky);
  assert.deepEqual([...m], [['alpha', { uses: 3, lastUsedAt: 9 }]]);
  assert.equal(reads, 2);
  assert.equal(JSON.stringify([...m]).includes('SENTINEL'), false);
  const missing: ConfigFs = { ...flaky, stat: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
  assert.equal((await readSkillUsage('/x/.claude.json', missing)).size, 0);
  const huge: ConfigFs = { ...flaky, stat: async () => ({ size: 33 * 1024 * 1024, isFile: () => true, isDirectory: () => false }) };
  reads = 0;
  assert.equal((await readSkillUsage('/x/.claude.json', huge)).size, 0);
  assert.equal(reads, 0, 'refused unread over 32 MB');
});

// --- untrusted folder: the probe ran without project settings (projectLoaded: false) ----------------------------------------

const UNTRUSTED_SCAN = {
  items: [
    { kind: 'skill' as const, source: 'user' as const, name: 'alpha', keys: ['alpha'], file: '/cfg/skills/alpha/SKILL.md' },
    { kind: 'skill' as const, source: 'project' as const, name: 'gamma', keys: ['gamma'], file: '/p/.claude/skills/gamma/SKILL.md', description: 'Gamma from the project' },
    { kind: 'command' as const, source: 'project' as const, name: 'ops:restart', keys: ['ops:restart'], file: '/p/.claude/commands/ops/restart.md', description: 'Restart', argumentHint: '[svc]' },
    { kind: 'skill' as const, source: 'project' as const, name: 'alpha', keys: ['alpha'], file: '/p/.claude/skills/alpha/SKILL.md' },
    { kind: 'skill' as const, source: 'plugin' as const, plugin: 'plug', name: 'delta', keys: ['plug:delta'], file: '/cfg/plugins/delta/SKILL.md' },
  ],
};
const UNTRUSTED_SDK = [
  { name: 'clear', description: 'Clear', builtin: true },
  { name: 'alpha', description: 'Alpha (SDK)' },
  { name: 'user-only', description: 'No file' },
];

test('skills catalog: projectLoaded false merges scanned project items, keeps SDK rows, no duplicates', () => {
  const reg = ids();
  const cat = buildSkillsCatalog({ sdkCommands: UNTRUSTED_SDK, scan: UNTRUSTED_SCAN, usage: new Map(), fileIdFor: reg.fileIdFor, projectLoaded: false });
  assert.deepEqual(cat.skills.map((s) => [s.invoke, s.source]), [['alpha', 'user'], ['gamma', 'project'], ['user-only', 'user']]);
  assert.deepEqual(cat.commands.map((c) => [c.invoke, c.source]), [['clear', 'builtin'], ['ops:restart', 'project']]);
  const gamma = cat.skills.find((s) => s.invoke === 'gamma')!;
  assert.equal(gamma.description, 'Gamma from the project');
  assert.match(gamma.fileId ?? '', /^f\d+$/);
  assert.equal(cat.commands.find((c) => c.invoke === 'ops:restart')!.argumentHint, '[svc]');
  assert.ok(!cat.skills.some((s) => s.invoke === 'plug:delta'), 'only project scope is merged, not plugins');
  assert.equal(cat.truncated, false);
});

test('skills catalog: a project item clashing with an SDK user row adds no duplicate and keeps the existing precedence', () => {
  const cat = buildSkillsCatalog({ sdkCommands: UNTRUSTED_SDK, scan: UNTRUSTED_SCAN, usage: new Map(), fileIdFor: ids().fileIdFor, projectLoaded: false });
  const alphas = cat.skills.filter((s) => s.invoke === 'alpha');
  assert.equal(alphas.length, 1);
  assert.equal(alphas[0]!.source, 'user');
  assert.equal(alphas[0]!.description, 'Alpha (SDK)');
});

test('skills catalog: projectLoaded true or absent leaves the SDK set alone', () => {
  const base = buildSkillsCatalog({ sdkCommands: UNTRUSTED_SDK, scan: UNTRUSTED_SCAN, usage: new Map(), fileIdFor: ids().fileIdFor });
  const trusted = buildSkillsCatalog({ sdkCommands: UNTRUSTED_SDK, scan: UNTRUSTED_SCAN, usage: new Map(), fileIdFor: ids().fileIdFor, projectLoaded: true });
  assert.deepEqual(trusted, base);
  assert.deepEqual(base.skills.map((s) => s.invoke), ['alpha', 'user-only']);
  assert.deepEqual(base.commands.map((c) => c.invoke), ['clear']);
});

test('skills catalog: with projectLoaded false the caps, sorting and lazy ids still apply', () => {
  const sdk = Array.from({ length: LIMITS.catalogSkills }, (_, i) => ({ name: `s${String(i).padStart(3, '0')}`, description: 'd' }));
  const items = Array.from({ length: 5 }, (_, i) => ({ kind: 'skill' as const, source: 'project' as const, name: `p${i}`, keys: [`p${i}`], file: `/p/${i}/SKILL.md` }));
  const reg = ids();
  const cat = buildSkillsCatalog({ sdkCommands: sdk, scan: { items }, usage: new Map(), fileIdFor: reg.fileIdFor, projectLoaded: false });
  assert.equal(cat.skills.length, LIMITS.catalogSkills);
  assert.equal(cat.truncated, true);
  assert.equal(reg.calls.length, cat.skills.filter((s) => s.source === 'project').length, 'ids only for surviving items');
  assert.ok(cat.skills.every((s, i, a) => i === 0 || a[i - 1]!.name.toLowerCase() <= s.name.toLowerCase()));
});

const UNTRUSTED_AGENT_SCAN = {
  agents: [
    { source: 'user' as const, name: 'scout', file: '/cfg/agents/scout.md', tools: ['Read'] },
    { source: 'project' as const, name: 'builder', file: '/p/.claude/agents/builder.md', description: 'Builds', model: 'haiku', tools: ['Edit'] },
    { source: 'project' as const, name: 'scout', file: '/p/.claude/agents/scout.md' },
    { source: 'plugin' as const, plugin: 'plug', name: 'plug:helper', file: '/cfg/plugins/helper.md' },
  ],
};
const UNTRUSTED_AGENT_SDK = [{ name: 'Explore', description: 'Search', model: 'inherit' }, { name: 'scout', description: 'Scouts' }];

test('agents catalog: projectLoaded false merges scanned project agents, keeps SDK rows, no duplicates', () => {
  const reg = ids();
  const cat = buildAgentsCatalog({ sdkAgents: UNTRUSTED_AGENT_SDK, scan: UNTRUSTED_AGENT_SCAN, fileIdFor: reg.fileIdFor, projectLoaded: false });
  assert.deepEqual(cat.agents.map((a) => [a.name, a.source]), [['builder', 'project'], ['Explore', 'builtin'], ['scout', 'user']]);
  const b = cat.agents.find((a) => a.name === 'builder')!;
  assert.deepEqual({ description: b.description, model: b.model, tools: b.tools }, { description: 'Builds', model: 'haiku', tools: ['Edit'] });
  assert.match(b.fileId ?? '', /^f\d+$/);
  assert.equal(cat.agents.filter((a) => a.name === 'scout').length, 1);
  assert.equal(reg.map.has('/p/.claude/agents/scout.md'), false, 'the clashing project file is not used');
});

test('agents catalog: projectLoaded true or absent is unchanged; caps still apply when false', () => {
  const base = buildAgentsCatalog({ sdkAgents: UNTRUSTED_AGENT_SDK, scan: UNTRUSTED_AGENT_SCAN, fileIdFor: ids().fileIdFor });
  assert.deepEqual(base.agents.map((a) => a.name), ['Explore', 'scout']);
  assert.deepEqual(buildAgentsCatalog({ sdkAgents: UNTRUSTED_AGENT_SDK, scan: UNTRUSTED_AGENT_SCAN, fileIdFor: ids().fileIdFor, projectLoaded: true }), base);
  const sdk = Array.from({ length: LIMITS.agentTypes }, (_, i) => ({ name: `a${String(i).padStart(3, '0')}`, description: 'd' }));
  const scan = { agents: Array.from({ length: 5 }, (_, i) => ({ source: 'project' as const, name: `p${i}`, file: `/p/${i}.md` })) };
  const reg = ids();
  const capped = buildAgentsCatalog({ sdkAgents: sdk, scan, fileIdFor: reg.fileIdFor, projectLoaded: false });
  assert.equal(capped.agents.length, LIMITS.agentTypes);
  assert.equal(capped.truncated, true);
  assert.equal(reg.calls.length, capped.agents.filter((a) => a.source === 'project').length);
});
