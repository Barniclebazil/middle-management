import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_SETTINGS_BYTES,
  displayPath,
  instructionDirs,
  managedDirFor,
  nestedWorktree,
  parsePermissionRules,
  readHandbook,
  readInstructionFiles,
  readMemory,
  readPermissionRules,
} from '../src/claude/handbook.ts';
import type { HandbookOptions } from '../src/claude/handbook.ts';
import { FRONTMATTER_HEAD_BYTES, nodeConfigFs } from '../src/claude/catalog.ts';
import type { ConfigFs } from '../src/claude/catalog.ts';
import { projectDirName } from '../src/claude/paths.ts';
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

/** Fails the test when any file CONTENT is read where only stat is allowed; records head reads. */
function strictFs(allowHeadFor: (p: string) => boolean, allowWholeFor: (p: string) => boolean = () => false) {
  const heads: string[] = [];
  const whole: string[] = [];
  const f: ConfigFs = {
    stat: (p) => nodeConfigFs.stat(p),
    readdir: (p) => nodeConfigFs.readdir(p),
    readHead: (p, max) => {
      assert.ok(allowHeadFor(p), `unexpected head read of ${p}`);
      heads.push(p);
      return nodeConfigFs.readHead(p, max);
    },
    readFile: (p) => {
      assert.ok(allowWholeFor(p), `unexpected whole-file read of ${p}`);
      whole.push(p);
      return nodeConfigFs.readFile(p);
    },
  };
  return { fs: f, heads, whole };
}

/** The platform's absolute form of a POSIX-looking fake path: unchanged on POSIX, `D:\h\u` on Windows (where `/h/u` has no drive). */
const abs = (p: string): string => path.resolve(p);

/**
 * A tiny in-memory filesystem (files only; directories are implied) for walks that must reach the real filesystem root.
 * Keys and lookups go through `abs`, so fakes written as `/h/u/x` match the paths the code builds on Windows too.
 */
function memFs(raw: Record<string, string>): ConfigFs {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) files[abs(k)] = v;
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let d = path.dirname(p); !dirs.has(d); d = path.dirname(d)) {
    dirs.add(d);
    if (d === path.dirname(d)) break;
  }
  const enoent = (): never => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  return {
    stat: async (raw) => {
      const p = abs(raw);
      if (Object.prototype.hasOwnProperty.call(files, p)) return { size: files[p]!.length, isFile: () => true, isDirectory: () => false };
      if (dirs.has(p)) return { size: 0, isFile: () => false, isDirectory: () => true };
      return enoent();
    },
    readdir: async (raw) => {
      const p = abs(raw);
      if (!dirs.has(p)) return enoent();
      const names = new Set<string>();
      for (const k of [...Object.keys(files), ...dirs]) if (k !== p && path.dirname(k) === p) names.add(path.basename(k));
      return [...names];
    },
    readHead: async (p) => (Object.prototype.hasOwnProperty.call(files, abs(p)) ? files[abs(p)]! : enoent()),
    readFile: async (p) => (Object.prototype.hasOwnProperty.call(files, abs(p)) ? files[abs(p)]! : enoent()),
  };
}

interface Fx {
  tmp: string;
  home: string;
  configDir: string;
  managed: string;
  cwd: string;
  reg: ReturnType<typeof ids>;
  opts: HandbookOptions;
}

async function fixture(files: Record<string, string> = {}): Promise<Fx> {
  const tmp = await makeTempDir('handbook-');
  const home = path.join(tmp, 'home');
  const configDir = path.join(home, '.claude');
  const managed = path.join(home, 'managed');
  const cwd = path.join(home, 'work', 'proj', 'sub');
  await tree(tmp, files);
  await fs.promises.mkdir(cwd, { recursive: true });
  const reg = ids();
  return { tmp, home, configDir, managed, cwd, reg, opts: { cwd, home, configDir, fs: nodeConfigFs, fileIdFor: reg.fileIdFor, managedDir: managed } };
}

// --- the CLAUDE.md chain ------------------------------------------------------------------------------------------------

test('instruction chain: managed, user, then each folder from the outermost ancestor down (past home), local after project', async () => {
  const f = await fixture({
    'home/managed/CLAUDE.md': 'M'.repeat(11),
    'home/.claude/CLAUDE.md': 'U'.repeat(22),
    'home/.claude/rules/style.md': 'r',
    'home/CLAUDE.md': 'H'.repeat(33),
    'home/work/CLAUDE.md': 'W',
    'home/work/CLAUDE.local.md': 'WL',
    'home/work/proj/CLAUDE.md': 'P'.repeat(44),
    'home/work/proj/.claude/CLAUDE.md': 'PD',
    'home/work/proj/.claude/rules/testing.md': 'T',
    'home/work/proj/.claude/rules/nested/deep.md': 'D',
    'home/work/proj/CLAUDE.local.md': 'PL',
    'home/work/proj/sub/CLAUDE.md': 'S',
    'home/work/proj/sub/notes.txt': 'not an instruction file',
    'CLAUDE.md': 'ABOVE HOME',
    'home/managed/.claude/rules/org.md': 'o',
  });
  try {
    const { files, truncated } = await readInstructionFiles(f.opts);
    assert.equal(truncated, false);
    assert.deepEqual(
      files.map((x) => [x.scope, x.label, x.display]),
      [
        ['managed', 'CLAUDE.md', displayPath(path.join(f.managed, 'CLAUDE.md'), f.home)],
        ['managed', 'rules/org.md', displayPath(path.join(f.managed, '.claude', 'rules', 'org.md'), f.home)],
        ['user', 'CLAUDE.md', '~/.claude/CLAUDE.md'],
        ['user', 'rules/style.md', '~/.claude/rules/style.md'],
        ['project', 'CLAUDE.md', displayPath(path.join(f.tmp, 'CLAUDE.md'), f.home)],
        ['project', 'CLAUDE.md', '~/CLAUDE.md'],
        ['project', 'CLAUDE.md', '~/work/CLAUDE.md'],
        ['local', 'CLAUDE.local.md', '~/work/CLAUDE.local.md'],
        ['project', 'CLAUDE.md', '~/work/proj/CLAUDE.md'],
        ['project', '.claude/CLAUDE.md', '~/work/proj/.claude/CLAUDE.md'],
        ['project', 'rules/nested/deep.md', '~/work/proj/.claude/rules/nested/deep.md'],
        ['project', 'rules/testing.md', '~/work/proj/.claude/rules/testing.md'],
        ['local', 'CLAUDE.local.md', '~/work/proj/CLAUDE.local.md'],
        ['project', 'CLAUDE.md', '~/work/proj/sub/CLAUDE.md'],
      ],
    );
    assert.deepEqual(files.slice(0, 5).map((x) => x.bytes), [11, 1, 22, 1, 10], 'managed, managed rules, user, user rules, then the folder above home');
    assert.equal(new Set(files.map((x) => x.fileId)).size, files.length);
    assert.equal(files[0]!.fileId, f.reg.map.get(path.join(f.managed, 'CLAUDE.md')));
  } finally {
    await rmTemp(f.tmp);
  }
});

test('instruction chain: only stat, never the contents; only existing regular files', async () => {
  const f = await fixture({ 'home/.claude/CLAUDE.md': 'SENTINEL_BODY', 'home/work/proj/sub/CLAUDE.md': 'SENTINEL_BODY2', 'home/work/proj/CLAUDE.local.md/inner': 'x' });
  try {
    const strict = strictFs(() => false);
    const out = await readInstructionFiles({ ...f.opts, fs: strict.fs });
    assert.deepEqual(out.files.map((x) => x.label), ['CLAUDE.md', 'CLAUDE.md'], 'a directory named CLAUDE.local.md is not a file');
    assert.equal(JSON.stringify(out).includes('SENTINEL_BODY'), false);
    assert.equal(strict.heads.length + strict.whole.length, 0);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('instruction chain: the home folder file is listed once when it is also the user config dir', async () => {
  const f = await fixture({ 'home/.claude/CLAUDE.md': 'U', 'home/.claude/rules/r.md': 'r', 'home/CLAUDE.md': 'H' });
  try {
    const { files } = await readInstructionFiles({ ...f.opts, cwd: f.home });
    assert.deepEqual(files.map((x) => [x.scope, x.display]), [['user', '~/.claude/CLAUDE.md'], ['user', '~/.claude/rules/r.md'], ['project', '~/CLAUDE.md']]);
    // A relative cwd gives no project files, only managed and user.
    const rel = await readInstructionFiles({ ...f.opts, cwd: 'relative/dir' });
    assert.deepEqual(rel.files.map((x) => x.scope), ['user', 'user']);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('instruction chain: a cwd outside home walks up to, but not including, the filesystem root (in-memory fs)', async () => {
  const files: Record<string, string> = {
    '/etc/claude-code/CLAUDE.md': 'managed',
    '/h/u/.claude/CLAUDE.md': 'user',
    '/CLAUDE.md': 'root',
    '/srv/CLAUDE.md': 'srv',
    '/srv/app/.claude/CLAUDE.md': 'app',
    '/srv/app/CLAUDE.local.md': 'local',
    '/h/CLAUDE.md': 'elsewhere, not an ancestor',
  };
  const reg = ids();
  const out = await readInstructionFiles({ cwd: abs('/srv/app'), home: abs('/h/u'), configDir: abs('/h/u/.claude'), fs: memFs(files), fileIdFor: reg.fileIdFor, platform: 'linux' });
  assert.deepEqual(
    out.files.map((x) => [x.scope, x.display]),
    [
      ['managed', path.join('/etc/claude-code', 'CLAUDE.md')],
      ['user', '~/.claude/CLAUDE.md'],
      ['project', abs('/srv/CLAUDE.md')],
      ['project', abs('/srv/app/.claude/CLAUDE.md')],
      ['local', abs('/srv/app/CLAUDE.local.md')],
    ],
  );
});

test('instruction chain: managed folder per platform, caps at handbookFiles and sets truncated', async () => {
  assert.equal(managedDirFor('linux'), '/etc/claude-code');
  assert.equal(managedDirFor('freebsd'), '/etc/claude-code');
  assert.equal(managedDirFor('darwin'), '/Library/Application Support/ClaudeCode');
  assert.equal(managedDirFor('win32'), 'C:\\Program Files\\ClaudeCode');
  const rules: Record<string, string> = {};
  for (let i = 0; i < 60; i++) rules[`home/.claude/rules/r${String(i).padStart(2, '0')}.md`] = 'x';
  const f = await fixture(rules);
  try {
    const out = await readInstructionFiles(f.opts);
    assert.equal(out.files.length, LIMITS.handbookFiles);
    assert.equal(out.truncated, true);
    assert.equal(f.reg.calls.length, LIMITS.handbookFiles, 'ids only for listed files');
  } finally {
    await rmTemp(f.tmp);
  }
});

test('instruction chain: a fileIdFor that fails leaves the file out rather than listing it unopenable', async () => {
  const f = await fixture({ 'home/.claude/CLAUDE.md': 'U', 'home/work/proj/sub/CLAUDE.md': 'S' });
  try {
    const out = await readInstructionFiles({ ...f.opts, fileIdFor: (p) => { if (p.includes('.claude')) throw new Error('no'); return 'ok'; } });
    assert.deepEqual(out.files.map((x) => x.display), ['~/work/proj/sub/CLAUDE.md']);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('displayPath: home shortened to ~, others untouched, length capped', () => {
  assert.equal(displayPath('/h/u/a/b.md', '/h/u'), '~/a/b.md');
  assert.equal(displayPath('/h/u', '/h/u'), '/h/u');
  assert.equal(displayPath('/etc/x', '/h/u'), '/etc/x');
  assert.equal(displayPath('/h/user2/x', '/h/user'), '/h/user2/x');
  assert.equal(displayPath('/' + 'a'.repeat(5000), '/h/u').length, LIMITS.pathChars);
});

// --- memory -------------------------------------------------------------------------------------------------------------

test('memory: index and entries from front matter, sorted by file name', async () => {
  const f = await fixture();
  const mem = path.join(f.configDir, 'projects', projectDirName(f.cwd), 'memory');
  await tree(mem, {
    'MEMORY.md': '- [Titles](a.md) - hook text from the index\n',
    'b-feedback.md': '---\nname: Prefer short answers\ndescription: The user likes brevity\nmetadata:\n  type: feedback\n---\nBODY_SECRET_B\n',
    'a-user.md': '---\nname: Who the user is\ndescription: >-\n  A folded\n  hook line\ntype: user\n---\nBODY_SECRET_A\n',
    'c-bad-type.md': '---\nname: Odd one\ndescription: has an unknown type\nmetadata:\n  type: gossip\n---\n',
    'd-no-frontmatter.md': 'just notes, no front matter\nBODY_SECRET_D\n',
    'e-crlf.md': '---\r\nname: Windows saved\r\ndescription: CRLF hook\r\nmetadata:\r\n  type: project\r\n---\r\nbody\r\n',
    'f-malformed.md': '---\nname: never closed\ndescription: lost\n',
    'g-ref.md': '---\nname: A reference\nmetadata:\n  type: reference\n---\n',
    'notes.txt': 'not markdown',
    '.hidden.md': '---\nname: hidden\n---\n',
    'sub/inner.md': '---\nname: nested\n---\n',
  });
  try {
    const strict = strictFs((p) => p.startsWith(mem) && p.endsWith('.md') && !p.endsWith('MEMORY.md'));
    const out = await readMemory({ ...f.opts, fs: strict.fs });
    assert.equal(out.truncated, false);
    assert.deepEqual(out.index, { fileId: f.reg.map.get(path.join(mem, 'MEMORY.md')), scope: 'local', label: 'MEMORY.md', display: `~/.claude/projects/${projectDirName(f.cwd)}/memory/MEMORY.md`, bytes: Buffer.byteLength('- [Titles](a.md) - hook text from the index\n') });
    assert.deepEqual(
      out.entries.map((e) => ({ ...e, fileId: undefined })),
      [
        { fileId: undefined, file: 'a-user.md', title: 'Who the user is', hook: 'A folded hook line', type: 'user' },
        { fileId: undefined, file: 'b-feedback.md', title: 'Prefer short answers', hook: 'The user likes brevity', type: 'feedback' },
        { fileId: undefined, file: 'c-bad-type.md', title: 'Odd one', hook: 'has an unknown type' },
        { fileId: undefined, file: 'd-no-frontmatter.md', title: 'd-no-frontmatter' },
        { fileId: undefined, file: 'e-crlf.md', title: 'Windows saved', hook: 'CRLF hook', type: 'project' },
        { fileId: undefined, file: 'f-malformed.md', title: 'f-malformed' },
        { fileId: undefined, file: 'g-ref.md', title: 'A reference', type: 'reference' },
      ],
    );
    assert.ok(out.entries.every((e) => /^f\d+$/.test(e.fileId)));
    assert.equal(JSON.stringify(out).includes('BODY_SECRET'), false);
    assert.equal(strict.whole.length, 0);
    assert.ok(strict.heads.every((h) => !h.endsWith('MEMORY.md')), 'MEMORY.md itself is never read');
    assert.equal(JSON.stringify(out).includes(f.tmp), false, 'no absolute path');
  } finally {
    await rmTemp(f.tmp);
  }
});

test('memory: absent folder, no index, a huge head, and the entry cap', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readMemory(f.opts), { entries: [], truncated: false });
    const mem = path.join(f.configDir, 'projects', projectDirName(f.cwd), 'memory');
    const files: Record<string, string> = { 'huge.md': '---\nname: huge\ndescription: ' + 'z'.repeat(FRONTMATTER_HEAD_BYTES * 2) + '\n---\n' };
    for (let i = 0; i < LIMITS.memoryEntries + 5; i++) files[`m${String(i).padStart(3, '0')}.md`] = `---\nname: m${i}\n---\n`;
    await tree(mem, files);
    const out = await readMemory(f.opts);
    assert.equal(out.index, undefined);
    assert.equal(out.entries.length, LIMITS.memoryEntries);
    assert.equal(out.truncated, true);
    assert.equal(f.reg.calls.length, LIMITS.memoryEntries);
    await rmTemp(mem);
    await tree(mem, { 'bigfile.md': files['huge.md']!.replace('name: huge', 'name: Big Title') });
    const one = await readMemory(f.opts);
    assert.deepEqual(one.entries.map((e) => [e.file, e.title, e.hook]), [['bigfile.md', 'bigfile', undefined]], 'a front matter larger than the head is ignored; the file name is the title');
  } finally {
    await rmTemp(f.tmp);
  }
});

// --- permission rules ---------------------------------------------------------------------------------------------------

test('parsePermissionRules: only allow/ask/deny strings; every other key is ignored', () => {
  const out = parsePermissionRules({
    env: { TOKEN: 'SENTINEL_ENV' },
    hooks: { PreToolUse: [{ hooks: [{ command: 'SENTINEL_HOOK' }] }] },
    apiKeyHelper: 'SENTINEL_HELPER',
    permissions: {
      allow: ['Read', 'Bash(npm run test:*)', 'Read', '', '  ', 5, null, { x: 'SENTINEL_OBJ' }, 'ctl\u0000x\ny'],
      deny: ['Read(./.env)'],
      ask: 'not a list',
      defaultMode: 'bypassPermissions',
      additionalDirectories: ['/SENTINEL_DIR'],
    },
    model: 'SENTINEL_MODEL',
  });
  assert.deepEqual(out, { allow: ['Read', 'Bash(npm run test:*)', 'ctl x y'], ask: [], deny: ['Read(./.env)'] });
  assert.equal(JSON.stringify(out).includes('SENTINEL'), false);
  assert.equal(JSON.stringify(out).includes('bypass'), false);
  for (const bad of [undefined, null, 1, 'x', [], {}, { permissions: null }, { permissions: [] }, { permissions: 'x' }]) assert.deepEqual(parsePermissionRules(bad), { allow: [], ask: [], deny: [] });
  const proto = parsePermissionRules(JSON.parse('{"permissions":{"__proto__":{"allow":["x"]}}}'));
  assert.deepEqual(proto.allow, []);
  assert.equal(parsePermissionRules({ permissions: { allow: ['r'.repeat(1000)] } }).allow[0]!.length, LIMITS.ruleChars);
  const big = parsePermissionRules({ permissions: { allow: Array.from({ length: 900 }, (_, i) => `Bash(c${i})`) } });
  assert.equal(big.allow.length, LIMITS.permissionRules);
});

test('permission rules: four scopes, allow then ask then deny, each in file order, with the file id', async () => {
  const f = await fixture({
    'home/managed/managed-settings.json': JSON.stringify({ permissions: { deny: ['WebFetch'], allow: ['Read(//managed)'] } }),
    'home/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], ask: ['Bash(git push:*)'] } }),
    'home/work/proj/sub/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm run build:*)', 'Bash(npm run test:*)'], deny: ['Read(./secrets/**)'] } }),
    'home/work/proj/sub/.claude/settings.local.json': JSON.stringify({ permissions: { ask: ['Edit'], deny: ['Bash(rm:*)'] } }),
    'home/work/proj/.claude/settings.json': JSON.stringify({ permissions: { allow: ['NotMine'] } }),
  });
  try {
    const strict = strictFs(() => false, (p) => p.endsWith('.json'));
    const { rules, truncated } = await readPermissionRules({ ...f.opts, fs: strict.fs });
    assert.equal(truncated, false);
    assert.deepEqual(
      rules.map((r) => [r.behavior, r.scope, r.rule]),
      [
        ['allow', 'managed', 'Read(//managed)'],
        ['allow', 'user', 'Bash(ls:*)'],
        ['allow', 'project', 'Bash(npm run build:*)'],
        ['allow', 'project', 'Bash(npm run test:*)'],
        ['ask', 'user', 'Bash(git push:*)'],
        ['ask', 'local', 'Edit'],
        ['deny', 'managed', 'WebFetch'],
        ['deny', 'project', 'Read(./secrets/**)'],
        ['deny', 'local', 'Bash(rm:*)'],
      ],
    );
    const idOf = (p: string): string | undefined => f.reg.map.get(p);
    assert.equal(rules[0]!.fileId, idOf(path.join(f.managed, 'managed-settings.json')));
    assert.equal(rules[1]!.fileId, idOf(path.join(f.configDir, 'settings.json')));
    assert.equal(rules[8]!.fileId, idOf(path.join(f.cwd, '.claude', 'settings.local.json')));
    assert.ok(rules.every((r) => r.fileId !== undefined && !r.fileId.includes('/')));
    assert.equal(JSON.stringify(rules).includes(f.tmp), false);
    assert.deepEqual(strict.whole.map((p) => path.basename(p)).sort(), ['managed-settings.json', 'settings.json', 'settings.json', 'settings.local.json']);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('permission rules: sentinel test, no other settings key ever leaves the module', async () => {
  const settings = {
    env: { ANTHROPIC_API_KEY: 'SENTINEL_API_KEY' },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'SENTINEL_HOOK_CMD' }] }] },
    apiKeyHelper: '/bin/SENTINEL_HELPER',
    awsAuthRefresh: 'SENTINEL_AWS',
    model: 'SENTINEL_MODEL',
    statusLine: { command: 'SENTINEL_STATUS' },
    mcpServers: { s: { env: { K: 'SENTINEL_MCP_ENV' }, url: 'SENTINEL_URL' } },
    enabledPlugins: { 'SENTINEL_PLUGIN@m': true },
    permissions: { defaultMode: 'bypassPermissions', additionalDirectories: ['/SENTINEL_DIR'], allow: ['Read'], deny: ['Bash(curl:*)'], ask: [], disableBypassPermissionsMode: 'disable' },
  };
  const files: Record<string, string> = {};
  for (const rel of ['home/managed/managed-settings.json', 'home/.claude/settings.json', 'home/work/proj/sub/.claude/settings.json', 'home/work/proj/sub/.claude/settings.local.json']) files[rel] = JSON.stringify(settings);
  const f = await fixture(files);
  try {
    const out = await readHandbook(f.opts);
    assert.equal(out.rules.length, 8);
    const json = JSON.stringify(out);
    assert.equal(json.includes('SENTINEL'), false);
    assert.equal(json.includes('bypass'), false);
    assert.deepEqual([...new Set(out.rules.flatMap((r) => Object.keys(r)))].sort(), ['behavior', 'fileId', 'rule', 'scope']);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('permission rules: missing, invalid and oversize files; a path reached twice is read once', async () => {
  const f = await fixture({
    'home/.claude/settings.json': '{ this is not json',
    'home/work/proj/sub/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Read'] } }),
  });
  try {
    await fs.promises.writeFile(path.join(f.cwd, '.claude', 'settings.local.json'), ' '.repeat(MAX_SETTINGS_BYTES + 1) + '{"permissions":{"deny":["TooBig"]}}');
    const strict = strictFs(() => false, (p) => !p.endsWith('settings.local.json'));
    const { rules } = await readPermissionRules({ ...f.opts, fs: strict.fs });
    assert.deepEqual(rules.map((r) => r.rule), ['Read'], 'oversize file refused unread, invalid and missing files skipped');
    // cwd is home: project settings is the user settings file, read once.
    await fs.promises.writeFile(path.join(f.configDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Once'] } }));
    const home = await readPermissionRules({ ...f.opts, cwd: f.configDir.replace(/\.claude$/, '').replace(/\/$/, ''), configDir: path.join(f.home, '.claude') });
    assert.deepEqual(home.rules.map((r) => [r.scope, r.rule]), [['user', 'Once']]);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('permission rules: over the cap, deny and ask rules survive a long allow list', async () => {
  const allow = Array.from({ length: 600 }, (_, i) => `Bash(cmd${i})`);
  const f = await fixture({ 'home/.claude/settings.json': JSON.stringify({ permissions: { allow, ask: ['AskOne'], deny: ['DenyOne', 'DenyTwo'] } }) });
  try {
    const { rules, truncated } = await readPermissionRules(f.opts);
    assert.equal(truncated, true);
    assert.equal(rules.length, LIMITS.permissionRules);
    assert.deepEqual(rules.filter((r) => r.behavior !== 'allow').map((r) => r.rule), ['AskOne', 'DenyOne', 'DenyTwo']);
    assert.equal(rules[0]!.behavior, 'allow', 'still listed allow first');
    assert.equal(rules.filter((r) => r.behavior === 'allow').length, LIMITS.permissionRules - 3);
  } finally {
    await rmTemp(f.tmp);
  }
});

// --- everything together ------------------------------------------------------------------------------------------------

test('readHandbook: instructions, memory and rules together, no absolute path outside display', async () => {
  const f = await fixture();
  const mem = path.join(f.configDir, 'projects', projectDirName(f.cwd), 'memory');
  await tree(f.tmp, {
    'home/.claude/CLAUDE.md': 'U',
    'home/work/proj/sub/CLAUDE.md': 'S',
    'home/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Read'] } }),
  });
  await tree(mem, { 'MEMORY.md': '- [x](x.md) - y\n', 'x.md': '---\nname: X\ndescription: Y\nmetadata:\n  type: user\n---\n' });
  try {
    const out = await readHandbook(f.opts);
    assert.deepEqual(out.instructions.map((x) => x.display), ['~/.claude/CLAUDE.md', '~/work/proj/sub/CLAUDE.md']);
    assert.equal(out.memoryIndex?.label, 'MEMORY.md');
    assert.deepEqual(out.memory.map((m) => [m.file, m.title, m.hook, m.type]), [['x.md', 'X', 'Y', 'user']]);
    assert.deepEqual(out.rules.map((r) => r.rule), ['Read']);
    assert.equal(out.truncated, false);
    assert.equal(JSON.stringify(out).includes(f.tmp), false, 'every path is home-shortened or an opaque id');
    // Every file the registry was asked about is absolute.
    assert.ok(f.reg.calls.length >= 5 && f.reg.calls.every((c) => path.isAbsolute(c)));
    // A bare machine gives an empty handbook, not an error.
    const bare = await makeTempDir('handbook-bare-');
    try {
      const empty = await readHandbook({ cwd: path.join(bare, 'p'), home: bare, configDir: path.join(bare, '.claude'), fs: nodeConfigFs, fileIdFor: ids().fileIdFor, managedDir: path.join(bare, 'managed') });
      assert.deepEqual(empty, { instructions: [], memory: [], rules: [], truncated: false });
    } finally {
      await rmTemp(bare);
    }
  } finally {
    await rmTemp(f.tmp);
  }
});

test('privacy: the readers never open credentials, history, sessions or the account file', async () => {
  const f = await fixture({
    'home/.claude/.credentials.json': 'SENTINEL_CREDS',
    'home/.claude/history.jsonl': 'SENTINEL_HISTORY',
    'home/.claude/sessions/1.key': 'SENTINEL_KEY',
    'home/.claude/session-env/x': 'SENTINEL_ENV',
    'home/.claude/paste-cache/x': 'SENTINEL_PASTE',
    'home/.claude/file-history/x': 'SENTINEL_FH',
    'home/.claude.json': 'SENTINEL_ACCOUNT',
    'home/.claude/CLAUDE.md': 'U',
  });
  try {
    const touched: string[] = [];
    const spy: ConfigFs = {
      stat: (p) => { touched.push(p); return nodeConfigFs.stat(p); },
      readdir: (p) => { touched.push(p); return nodeConfigFs.readdir(p); },
      readHead: (p, m) => { touched.push(p); return nodeConfigFs.readHead(p, m); },
      readFile: (p) => { touched.push(p); return nodeConfigFs.readFile(p); },
    };
    const out = await readHandbook({ ...f.opts, fs: spy });
    assert.ok(touched.length > 0);
    assert.equal(touched.some((p) => /credentials|history\.jsonl|sessions|session-env|paste-cache|file-history|\.claude\.json/.test(p)), false);
    assert.equal(JSON.stringify(out).includes('SENTINEL'), false);
  } finally {
    await rmTemp(f.tmp);
  }
});

test('instruction chain: the walk goes past the home folder and leaves out the filesystem root', async () => {
  const files: Record<string, string> = {
    '/CLAUDE.md': 'root, never read',
    '/CLAUDE.local.md': 'root local, never read',
    '/home/CLAUDE.md': 'above home',
    '/home/u/CLAUDE.md': 'home',
    '/home/u/work/CLAUDE.local.md': 'work local',
    '/home/u/work/app/CLAUDE.md': 'app',
  };
  const out = await readInstructionFiles({ cwd: abs('/home/u/work/app'), home: abs('/home/u'), configDir: abs('/home/u/.claude'), fs: memFs(files), fileIdFor: ids().fileIdFor, platform: 'linux' });
  assert.deepEqual(
    out.files.map((x) => [x.scope, x.display]),
    [['project', abs('/home/CLAUDE.md')], ['project', '~/CLAUDE.md'], ['local', '~/work/CLAUDE.local.md'], ['project', '~/work/app/CLAUDE.md']],
  );
  assert.deepEqual(instructionDirs('/home/u/work'), [abs('/home'), abs('/home/u'), abs('/home/u/work')]);
  assert.deepEqual(instructionDirs('/'), []);
  assert.deepEqual(instructionDirs('relative/dir'), []);
});

test('instruction chain: managed rules come after the managed CLAUDE.md and before the user files', async () => {
  const files: Record<string, string> = {
    '/etc/claude-code/CLAUDE.md': 'm',
    '/etc/claude-code/.claude/rules/b.md': 'bb',
    '/etc/claude-code/.claude/rules/sub/a.md': 'a',
    '/etc/claude-code/.claude/rules/notes.txt': 'not a rule',
    '/h/u/.claude/CLAUDE.md': 'u',
  };
  const out = await readInstructionFiles({ cwd: abs('/srv/app'), home: abs('/h/u'), configDir: abs('/h/u/.claude'), fs: memFs(files), fileIdFor: ids().fileIdFor, platform: 'linux' });
  assert.deepEqual(
    out.files.map((x) => [x.scope, x.label]),
    [['managed', 'CLAUDE.md'], ['managed', 'rules/b.md'], ['managed', 'rules/sub/a.md'], ['user', 'CLAUDE.md']],
  );
});

test('instruction chain: a worktree nested in its main repo skips the main folder project files but keeps its CLAUDE.local.md', async () => {
  const files: Record<string, string> = {
    '/r/main/.git/HEAD': 'ref',
    '/r/main/CLAUDE.md': 'main project',
    '/r/main/.claude/CLAUDE.md': 'main dot',
    '/r/main/.claude/rules/x.md': 'main rule',
    '/r/main/CLAUDE.local.md': 'main local',
    '/r/CLAUDE.md': 'above main',
    '/r/main/.claude/worktrees/wt/.git': `gitdir: ${abs('/r/main/.git/worktrees/wt')}\n`,
    '/r/main/.claude/worktrees/wt/CLAUDE.md': 'wt project',
    '/r/main/.claude/worktrees/wt/CLAUDE.local.md': 'wt local',
    '/r/main/.claude/worktrees/wt/pkg/CLAUDE.md': 'pkg',
  };
  const cwd = abs('/r/main/.claude/worktrees/wt/pkg');
  const out = await readInstructionFiles({ cwd, home: abs('/h/u'), configDir: abs('/h/u/.claude'), fs: memFs(files), fileIdFor: ids().fileIdFor, platform: 'linux' });
  assert.deepEqual(
    out.files.map((x) => [x.scope, x.display]),
    [
      ['project', abs('/r/CLAUDE.md')],
      ['local', abs('/r/main/CLAUDE.local.md')],
      ['project', abs('/r/main/.claude/worktrees/wt/CLAUDE.md')],
      ['local', abs('/r/main/.claude/worktrees/wt/CLAUDE.local.md')],
      ['project', abs('/r/main/.claude/worktrees/wt/pkg/CLAUDE.md')],
    ],
  );
  assert.deepEqual(await nestedWorktree(memFs(files), cwd), { worktreeRoot: abs('/r/main/.claude/worktrees/wt'), mainRoot: abs('/r/main') });
});

test('instruction chain: a worktree outside its main repo, a plain repo, a submodule and a bad .git file change nothing', async () => {
  const base = { '/r/main/CLAUDE.md': 'main', '/r/main/.git/HEAD': 'x' };
  const cases: Record<string, Record<string, string>> = {
    outside: { ...base, '/w/wt/.git': `gitdir: ${abs('/r/main/.git/worktrees/wt')}`, '/w/wt/CLAUDE.md': 'wt' },
    plain: { ...base, '/r/main/pkg/CLAUDE.md': 'pkg' },
    submodule: { ...base, '/r/main/sub/.git': `gitdir: ${abs('/r/main/.git/modules/sub')}`, '/r/main/sub/CLAUDE.md': 'sub' },
    garbage: { ...base, '/r/main/sub/.git': 'not a pointer', '/r/main/sub/CLAUDE.md': 'sub' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const cwd = abs(name === 'outside' ? '/w/wt' : name === 'plain' ? '/r/main/pkg' : '/r/main/sub');
    assert.equal(await nestedWorktree(memFs(files), cwd), undefined, name);
  }
  const out = await readInstructionFiles({ cwd: abs('/r/main/sub'), home: abs('/h/u'), configDir: abs('/h/u/.claude'), fs: memFs(cases['submodule']!), fileIdFor: ids().fileIdFor, platform: 'linux' });
  assert.deepEqual(out.files.map((x) => x.display), [abs('/r/main/CLAUDE.md'), abs('/r/main/sub/CLAUDE.md')]);
});

test('instruction chain: a worktree .git file is read with a small cap, and nothing else is opened', async () => {
  const files = { '/m/.git/HEAD': 'x', '/m/wts/a/.git': `gitdir: ${abs('/m/.git/worktrees/a')}\n` + 'z'.repeat(5000), '/m/wts/a/CLAUDE.md': 'a' };
  const heads: Array<[string, number]> = [];
  const inner = memFs(files);
  const spy: ConfigFs = {
    ...inner,
    readHead: (p, n) => {
      heads.push([p, n]);
      return inner.readHead(p, n);
    },
    readFile: () => Promise.reject(new Error('no whole-file reads')),
  };
  assert.deepEqual(await nestedWorktree(spy, abs('/m/wts/a')), { worktreeRoot: abs('/m/wts/a'), mainRoot: abs('/m') });
  assert.deepEqual(heads, [[abs('/m/wts/a/.git'), 1024]]);
});
