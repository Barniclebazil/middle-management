import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRoom, fileRoomErrorText, isSecretName, isSecretPath } from '../src/host/fileRoom.ts';
import type { FileRoomFs, FileRoomDeps } from '../src/host/fileRoom.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import type { DirEntry } from '../src/shared/protocol.ts';

// ---- helpers ------------------------------------------------------------------------------------------------------

const realFs: FileRoomFs = {
  realpath: (p) => fs.realpath(p),
  stat: (p) => fs.stat(p),
  lstat: (p) => fs.lstat(p),
  lstatBig: (p) => fs.lstat(p, { bigint: true }),
  opendir: (p) => fs.opendir(p),
  open: async (p, flags) => {
    const h = await fs.open(p, flags);
    return {
      stat: () => h.stat({ bigint: true }),
      read: (b, o, l, pos) => h.read(b, o, l, pos),
      close: () => h.close(),
    };
  },
};

const made: string[] = [];
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-fileroom-')));
  made.push(d);
  return d;
}

interface Setup {
  /** A scratch folder holding `root` (the allowed folder) and `outside` (a sibling that must stay unreachable). */
  base: string;
  root: string;
  outside: string;
  room: FileRoom;
  rootId: string;
  logs: string[];
}

async function setup(deps: FileRoomDeps = {}): Promise<Setup> {
  const base = await tmpDir();
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside text');
  await fs.mkdir(path.join(outside, 'dir'));
  await fs.writeFile(path.join(outside, 'dir', 'inner.txt'), 'outside inner');
  const logs: string[] = [];
  const room = new FileRoom({ homeDir: path.join(base, 'home'), claudeHome: path.join(base, 'claude-home'), log: (l) => logs.push(l), ...deps });
  const [r] = await room.setRoots([{ kind: 'project', path: root }]);
  assert.ok(r);
  return { base, root, outside, room, rootId: r.rootId, logs };
}

async function names(room: FileRoom, rootId: string, rel = ''): Promise<DirEntry[]> {
  const r = await room.listDir(rootId, rel);
  assert.ok(r.ok, 'listing should succeed');
  return r.entries;
}

function wrapFs(over: Partial<FileRoomFs>): FileRoomFs {
  return { ...realFs, ...over };
}

// ---- secret matcher -----------------------------------------------------------------------------------------------

test('isSecretName: accepts the secret names', () => {
  for (const n of [
    '.env', '.env.local', '.env.production', '.ENV', '.env.example.local', '.envrc', '.env-local', 'prod.env',
    'server.pem', 'KEY.PEM', 'tls.key', 'a.b.key', 'cert.p12', 'cert.pfx', 'release.keystore', 'release.jks', 'AuthKey_X.p8',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'id_rsa_work', 'id_custom',
    '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd', '.dockercfg', '.s3cfg', '.boto',
    'credentials', 'credentials.json', 'credentials-prod.json', '.credentials.json', 'Credentials.JSON',
    'secrets.yml', 'secrets.json', 'db.secret', 'db.secrets', 'prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup',
    'service-account.json', 'serviceaccount-prod.json', 'client_secret_123.json', 'vault_pass.txt', 'vault-pass',
    'vault.kdbx', 'login.keychain-db',
  ]) assert.equal(isSecretName(n), true, n);
});

test('isSecretName: rejects ordinary names and the allowed variants', () => {
  for (const n of [
    '', '.env.example', '.env.sample', '.env.template', '.ENV.EXAMPLE', 'environment.ts', 'env.ts', 'envelope.md',
    'id_rsa.pub', 'id_ed25519.pub', 'idea.txt', 'identity.ts', 'keyboard.ts', 'monkey.ts', 'keys.md', 'key', 'pem', 'turkey.txt',
    'README.md', 'package.json', 'credentials.md', 'secret.md', 'secretary.ts', 'npmrc', 'netrc.txt', 'terraform.tf', '.gitignore',
    'config', 'known_hosts', 'authorized_keys', 'pubkey.txt', 'x.pem.pub',
  ]) assert.equal(isSecretName(n), false, n);
});

test('isSecretPath: a folder above the file can make it secret', () => {
  assert.equal(isSecretPath('.ssh/config'), true);
  assert.equal(isSecretPath('home/.aws/config'), true);
  assert.equal(isSecretPath('/home/u/.gnupg/pubring.kbx'), true);
  assert.equal(isSecretPath('x/.kube/config'), true);
  assert.equal(isSecretPath('x/.DOCKER/config.json'), true);
  assert.equal(isSecretPath('C:\\Users\\u\\.ssh\\known_hosts'), true);
  assert.equal(isSecretPath('src/.env'), true);
  assert.equal(isSecretPath('src/app.ts'), false);
  assert.equal(isSecretPath('.ssh'), false, 'the folder itself is not a file name match');
  assert.equal(isSecretPath('sshx/config'), false);
  assert.equal(isSecretPath(''), false);
});

// ---- roots --------------------------------------------------------------------------------------------------------

test('setRoots: de-duplicates by real path, keeps stable ids, labels and shortens the home folder', async () => {
  const base = await tmpDir();
  const home = path.join(base, 'home');
  const proj = path.join(home, 'work', 'shop');
  await fs.mkdir(proj, { recursive: true });
  const alias = path.join(base, 'alias');
  await fs.symlink(proj, alias);
  const other = path.join(base, 'other');
  await fs.mkdir(other);
  const room = new FileRoom({ homeDir: home, claudeHome: path.join(base, 'ch') });

  const first = await room.setRoots([
    { kind: 'workspace', path: proj },
    { kind: 'project', path: alias, label: 'dup' },
    { kind: 'agent', path: other, label: '  Night shift\n' },
    { kind: 'project', path: path.join(base, 'does-not-exist') },
    { kind: 'project', path: 'relative/dir' },
  ]);
  assert.equal(first.length, 2);
  assert.equal(first[0]?.kind, 'workspace');
  assert.equal(first[0]?.label, 'shop');
  assert.equal(first[0]?.display, '~/work/shop'.replace(/\//g, path.sep));
  assert.equal(first[0]?.projectPath, proj);
  assert.equal(first[1]?.label, 'Night shift');
  assert.equal(first[1]?.display, other, 'outside the home folder: shown in full');
  assert.notEqual(first[0]?.rootId, first[1]?.rootId);
  assert.match(first[0]?.rootId ?? '', /^[A-Za-z0-9]+$/);

  // The same paths, in another order and through the alias, keep their ids; a new path gets a new one.
  const extra = path.join(base, 'extra');
  await fs.mkdir(extra);
  const second = await room.setRoots([
    { kind: 'agent', path: extra },
    { kind: 'agent', path: other },
    { kind: 'project', path: alias },
  ]);
  assert.equal(second.length, 3);
  assert.equal(second[1]?.rootId, first[1]?.rootId);
  assert.equal(second[2]?.rootId, first[0]?.rootId);
  assert.ok(!first.some((r) => r.rootId === second[0]?.rootId));
  assert.deepEqual(room.getRoots(), second);

  // A root left out stops being valid, and comes back with its old id.
  await room.setRoots([{ kind: 'agent', path: other }]);
  assert.deepEqual((await room.listDir(first[0]?.rootId ?? '', '')), { ok: false, error: 'unknownRoot' });
  const back = await room.setRoots([{ kind: 'workspace', path: proj }]);
  assert.equal(back[0]?.rootId, first[0]?.rootId);
});

test('setRoots: skips a file, caps the list at LIMITS.fileRoots, and rejects a bad kind', async () => {
  const base = await tmpDir();
  const room = new FileRoom({ homeDir: base, claudeHome: path.join(base, 'ch') });
  const file = path.join(base, 'a-file');
  await fs.writeFile(file, 'x');
  const cands = [{ kind: 'project' as const, path: file }, { kind: 'bogus' as unknown as 'project', path: base }];
  for (let i = 0; i < LIMITS.fileRoots + 5; i++) {
    const d = path.join(base, `d${i}`);
    await fs.mkdir(d);
    cands.push({ kind: 'project', path: d });
  }
  const roots = await room.setRoots(cands);
  assert.equal(roots.length, LIMITS.fileRoots);
  assert.equal(new Set(roots.map((r) => r.rootId)).size, LIMITS.fileRoots);
  assert.ok(roots.every((r) => r.kind === 'project' && r.projectPath !== file));
});

test('setRoots: concurrent calls are applied in order', async () => {
  const base = await tmpDir();
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  await fs.mkdir(a);
  await fs.mkdir(b);
  const room = new FileRoom({ homeDir: base, claudeHome: path.join(base, 'ch') });
  const p1 = room.setRoots([{ kind: 'project', path: a }]);
  const p2 = room.setRoots([{ kind: 'project', path: b }]);
  await Promise.all([p1, p2]);
  assert.deepEqual(room.getRoots().map((r) => r.projectPath), [b]);
});

test('logs name a rootId only when it is a known root', async () => {
  const s = await setup();
  const forged = ['../r1', '__proto__', 'r999', '/etc/passwd'];
  for (const id of forged) {
    await s.room.listDir(id, '');
    await s.room.readFile(id, 'x');
  }
  await s.room.listDir(s.rootId, '');
  const all = s.logs.join('\n');
  for (const id of forged) assert.ok(!all.includes(id), `log must not echo ${id}`);
  assert.ok(s.logs.some((l) => l.includes('root=<invalid> refused unknownRoot')));
  assert.ok(s.logs.some((l) => l.includes(`root=${s.rootId} `) && /entries=\d+/.test(l)));
});

// ---- unknown root, bad paths --------------------------------------------------------------------------------------

test('an unknown rootId is refused by resolve, listDir and readFile', async () => {
  const s = await setup();
  for (const id of ['', 'r999', '__proto__', 'constructor', s.root, s.rootId + 'x']) {
    assert.deepEqual(await s.room.resolve(id, ''), { ok: false, error: 'unknownRoot' }, id);
    assert.deepEqual(await s.room.listDir(id, ''), { ok: false, error: 'unknownRoot' }, id);
    assert.deepEqual(await s.room.readFile(id, 'x'), { ok: false, error: 'unknownRoot' }, id);
  }
});

test('resolve: any form of .. or other invalid path is badPath, before the disk is touched', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'ok.txt'), 'x');
  for (const rel of ['..', '../outside', 'a/../../outside', 'a/..', '../', './x', 'a/./b', '...', '.. ', 'a/.. /b', '/etc/passwd', '//server/share', 'C:/x', 'C:', 'a\\b', '..\\outside', 'a//b', 'a/', 'a\0b', 'a\nb']) {
    assert.deepEqual(await s.room.resolve(s.rootId, rel), { ok: false, error: 'badPath' }, JSON.stringify(rel));
    assert.deepEqual(await s.room.listDir(s.rootId, rel), { ok: false, error: 'badPath' });
    assert.deepEqual(await s.room.readFile(s.rootId, rel), { ok: false, error: 'badPath' });
  }
  for (const bad of [undefined, null, 5, ['a'], {}]) {
    assert.deepEqual(await s.room.resolve(s.rootId, bad as unknown as string), { ok: false, error: 'badPath' });
  }
  assert.deepEqual(await s.room.resolve(s.rootId, 'ok.txt'), { ok: true, path: path.join(s.root, 'ok.txt') });
  assert.deepEqual(await s.room.resolve(s.rootId, ''), { ok: true, path: s.root });
});

test('resolve: a missing path is missing', async () => {
  const s = await setup();
  assert.deepEqual(await s.room.resolve(s.rootId, 'nope.txt'), { ok: false, error: 'missing' });
  assert.deepEqual(await s.room.resolve(s.rootId, 'nope/deeper/x'), { ok: false, error: 'missing' });
  await fs.writeFile(path.join(s.root, 'f'), 'x');
  assert.deepEqual(await s.room.resolve(s.rootId, 'f/under-a-file'), { ok: false, error: 'missing' });
});

// ---- symlink escapes ----------------------------------------------------------------------------------------------

test('a symlink file pointing outside the root is refused, and listed as other', async () => {
  const s = await setup();
  await fs.symlink(path.join(s.outside, 'private.txt'), path.join(s.root, 'leak.txt'));
  await fs.symlink('../outside/private.txt', path.join(s.root, 'rel-leak.txt'));
  for (const rel of ['leak.txt', 'rel-leak.txt']) {
    assert.deepEqual(await s.room.resolve(s.rootId, rel), { ok: false, error: 'outside' });
    assert.deepEqual(await s.room.readFile(s.rootId, rel), { ok: false, error: 'outside' });
  }
  const list = await names(s.room, s.rootId);
  assert.deepEqual(list, [{ name: 'leak.txt', kind: 'other' }, { name: 'rel-leak.txt', kind: 'other' }]);
});

test('a symlinked folder pointing outside is refused for listing and reading through it', async () => {
  const s = await setup();
  await fs.symlink(s.outside, path.join(s.root, 'portal'));
  assert.deepEqual(await s.room.listDir(s.rootId, 'portal'), { ok: false, error: 'outside' });
  assert.deepEqual(await s.room.listDir(s.rootId, 'portal/dir'), { ok: false, error: 'outside' });
  assert.deepEqual(await s.room.readFile(s.rootId, 'portal/private.txt'), { ok: false, error: 'outside' });
  assert.deepEqual(await s.room.readFile(s.rootId, 'portal/dir/inner.txt'), { ok: false, error: 'outside' });
  assert.deepEqual(await names(s.room, s.rootId), [{ name: 'portal', kind: 'other' }]);
});

test('a symlink inside the root pointing at the root parent is refused', async () => {
  const s = await setup();
  await fs.symlink(s.base, path.join(s.root, 'up'));
  assert.deepEqual(await s.room.readFile(s.rootId, 'up/outside/private.txt'), { ok: false, error: 'outside' });
  assert.deepEqual(await s.room.listDir(s.rootId, 'up'), { ok: false, error: 'outside' });
});

test('a symlink chain is followed to the end: out is refused, in is allowed', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'real.txt'), 'inside text');
  // hop1 -> hop2 -> hop3 -> outside
  await fs.symlink(path.join(s.outside, 'private.txt'), path.join(s.root, 'hop3'));
  await fs.symlink('hop3', path.join(s.root, 'hop2'));
  await fs.symlink('hop2', path.join(s.root, 'hop1'));
  assert.deepEqual(await s.room.readFile(s.rootId, 'hop1'), { ok: false, error: 'outside' });
  // chain -> real.txt inside
  await fs.symlink('real.txt', path.join(s.root, 'ok3'));
  await fs.symlink('ok3', path.join(s.root, 'ok2'));
  await fs.symlink('ok2', path.join(s.root, 'ok1'));
  const r = await s.room.readFile(s.rootId, 'ok1');
  assert.ok(r.ok);
  assert.equal(r.preview.text, 'inside text');
  const res = await s.room.resolve(s.rootId, 'ok1');
  assert.deepEqual(res, { ok: true, path: path.join(s.root, 'real.txt') }, 'the resolved path is the real file');
  // An inside link that goes out and back in is fine too.
  await fs.symlink(path.join(s.root, 'real.txt'), path.join(s.root, 'abs-in'));
  assert.equal((await s.room.readFile(s.rootId, 'abs-in')).ok, true);
});

test('a symlink loop is missing, not a hang or a crash', async () => {
  const s = await setup();
  await fs.symlink('loop-b', path.join(s.root, 'loop-a'));
  await fs.symlink('loop-a', path.join(s.root, 'loop-b'));
  assert.deepEqual(await s.room.resolve(s.rootId, 'loop-a'), { ok: false, error: 'missing' });
  assert.deepEqual(await names(s.room, s.rootId), [{ name: 'loop-a', kind: 'other' }, { name: 'loop-b', kind: 'other' }]);
});

test('a root that is itself a symlink is allowed, and paths in it stay confined', async () => {
  const s = await setup();
  const alias = path.join(s.base, 'root-alias');
  await fs.symlink(s.root, alias);
  await fs.writeFile(path.join(s.root, 'in.txt'), 'hello');
  await fs.symlink(path.join(s.outside, 'private.txt'), path.join(s.root, 'leak'));
  const [r] = await s.room.setRoots([{ kind: 'project', path: alias }]);
  assert.ok(r);
  assert.equal(r.projectPath, alias);
  const read = await s.room.readFile(r.rootId, 'in.txt');
  assert.ok(read.ok);
  assert.equal(read.preview.text, 'hello');
  assert.deepEqual(await s.room.readFile(r.rootId, 'leak'), { ok: false, error: 'outside' });
  assert.deepEqual(await s.room.resolve(r.rootId, 'in.txt'), { ok: true, path: path.join(s.root, 'in.txt') });
});

test('a root that is later replaced by a link elsewhere is refused', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'in.txt'), 'x');
  await fs.rename(s.root, s.root + '.moved');
  await fs.symlink(s.outside, s.root);
  assert.deepEqual(await s.room.resolve(s.rootId, 'private.txt'), { ok: false, error: 'missing' });
  assert.deepEqual(await s.room.readFile(s.rootId, 'private.txt'), { ok: false, error: 'missing' });
});

test('an absolute symlink pointing back inside the root is allowed (file and folder)', async () => {
  const s = await setup();
  await fs.mkdir(path.join(s.root, 'docs'));
  await fs.writeFile(path.join(s.root, 'docs', 'a.txt'), 'doc a');
  await fs.symlink(path.join(s.root, 'docs', 'a.txt'), path.join(s.root, 'a-link'));
  await fs.symlink(path.join(s.root, 'docs'), path.join(s.root, 'docs-link'));
  const f = await s.room.readFile(s.rootId, 'a-link');
  assert.ok(f.ok);
  assert.equal(f.preview.text, 'doc a');
  const viaDir = await s.room.readFile(s.rootId, 'docs-link/a.txt');
  assert.ok(viaDir.ok);
  const list = await names(s.room, s.rootId);
  assert.deepEqual(list.map((e) => [e.name, e.kind, e.link]), [
    ['docs', 'dir', undefined],
    ['docs-link', 'dir', true],
    ['a-link', 'file', true],
  ]);
  const inner = await names(s.room, s.rootId, 'docs-link');
  assert.deepEqual(inner.map((e) => e.name), ['a.txt']);
});

test('a dangling symlink is missing to resolve and other in a listing', async () => {
  const s = await setup();
  await fs.symlink(path.join(s.root, 'gone.txt'), path.join(s.root, 'dangling'));
  await fs.symlink(path.join(s.base, 'nowhere'), path.join(s.root, 'dangling-out'));
  assert.deepEqual(await s.room.resolve(s.rootId, 'dangling'), { ok: false, error: 'missing' });
  assert.deepEqual(await s.room.readFile(s.rootId, 'dangling-out'), { ok: false, error: 'missing' });
  assert.deepEqual(await names(s.room, s.rootId), [{ name: 'dangling', kind: 'other' }, { name: 'dangling-out', kind: 'other' }]);
});

// ---- the swap window ----------------------------------------------------------------------------------------------

test('a file swapped for another file between the check and the open is refused (device and inode compared)', async () => {
  let target = '';
  const s = await setup({
    fs: wrapFs({
      open: async (p, flags) => {
        // Between `lstat` and `open`: replace the file with a different one.
        await fs.rename(path.join(path.dirname(p), 'decoy'), p);
        return realFs.open(p, flags);
      },
    }),
  });
  target = path.join(s.root, 'doc.txt');
  await fs.writeFile(target, 'original');
  await fs.writeFile(path.join(s.root, 'decoy'), 'swapped');
  assert.deepEqual(await s.room.readFile(s.rootId, 'doc.txt'), { ok: false, error: 'changed' });
});

test('a file swapped for a symlink between the check and the open is refused (O_NOFOLLOW)', { skip: process.platform === 'win32' }, async () => {
  const s = await setup({
    fs: wrapFs({
      open: async (p, flags) => {
        await fs.rm(p);
        await fs.symlink(path.join(path.dirname(p), '..', 'outside', 'private.txt'), p);
        return realFs.open(p, flags);
      },
    }),
  });
  await fs.writeFile(path.join(s.root, 'doc.txt'), 'original');
  const r = await s.room.readFile(s.rootId, 'doc.txt');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && (r.error === 'missing' || r.error === 'changed'));
});

test('a folder swapped for a symlink out of the root between the check and the open is refused', async () => {
  const s = await setup({
    fs: wrapFs({
      open: async (p, flags) => {
        const dir = path.dirname(p);
        await fs.rename(dir, dir + '.old');
        await fs.symlink(path.join(path.dirname(dir), '..', 'outside', 'dir'), dir);
        return realFs.open(p, flags);
      },
    }),
  });
  await fs.mkdir(path.join(s.root, 'sub'));
  await fs.writeFile(path.join(s.root, 'sub', 'inner.txt'), 'inside');
  const r = await s.room.readFile(s.rootId, 'sub/inner.txt');
  assert.deepEqual(r, { ok: false, error: 'changed' });
});

// ---- unsafe file types --------------------------------------------------------------------------------------------

function makeFifo(p: string): boolean {
  try {
    execFileSync('mkfifo', [p], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('a FIFO is refused, not read, and is listed as other', { timeout: 10_000 }, async (t) => {
  const s = await setup();
  if (!makeFifo(path.join(s.root, 'pipe'))) return t.skip('mkfifo is not available');
  assert.deepEqual(await s.room.readFile(s.rootId, 'pipe'), { ok: false, error: 'notFile' });
  assert.deepEqual(await names(s.room, s.rootId), [{ name: 'pipe', kind: 'other' }]);
  // Through an inside symlink too.
  await fs.symlink('pipe', path.join(s.root, 'pipe-link'));
  assert.deepEqual(await s.room.readFile(s.rootId, 'pipe-link'), { ok: false, error: 'notFile' });
  const list = await names(s.room, s.rootId);
  assert.deepEqual(list.find((e) => e.name === 'pipe-link'), { name: 'pipe-link', kind: 'other', link: true });
});

test('a folder or a device is not a file', async (t) => {
  const s = await setup();
  await fs.mkdir(path.join(s.root, 'sub'));
  assert.deepEqual(await s.room.readFile(s.rootId, 'sub'), { ok: false, error: 'notFile' });
  assert.deepEqual(await s.room.readFile(s.rootId, ''), { ok: false, error: 'notFile' });
  if (process.platform === 'win32') return t.skip('no /dev');
  await fs.symlink('/dev/null', path.join(s.root, 'null'));
  assert.deepEqual(await s.room.readFile(s.rootId, 'null'), { ok: false, error: 'outside' });
});

test('listDir refuses a file', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'f.txt'), 'x');
  assert.deepEqual(await s.room.listDir(s.rootId, 'f.txt'), { ok: false, error: 'notDir' });
  assert.deepEqual(await s.room.listDir(s.rootId, 'missing-dir'), { ok: false, error: 'missing' });
});

// ---- listings -----------------------------------------------------------------------------------------------------

test('listDir sorts folders first, then case-insensitively, with size and mtime for files', async () => {
  const s = await setup();
  for (const d of ['zeta', 'Alpha', 'beta']) await fs.mkdir(path.join(s.root, d));
  await fs.writeFile(path.join(s.root, 'b.txt'), 'bbbb');
  await fs.writeFile(path.join(s.root, 'A.txt'), 'a');
  await fs.writeFile(path.join(s.root, 'c.txt'), '');
  await fs.writeFile(path.join(s.root, '.hidden'), 'h');
  const r = await s.room.listDir(s.rootId, '');
  assert.ok(r.ok);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => e.name), ['Alpha', 'beta', 'zeta', '.hidden', 'A.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(r.entries.slice(0, 3).map((e) => e.kind), ['dir', 'dir', 'dir']);
  const b = r.entries.find((e) => e.name === 'b.txt');
  assert.equal(b?.kind, 'file');
  assert.equal(b?.size, 4);
  assert.ok(typeof b?.mtime === 'number' && Math.abs((b?.mtime ?? 0) - Date.now()) < 60_000);
  assert.equal(r.entries[0]?.size, undefined, 'folders have no size');
  assert.ok(r.entries.every((e) => e.link === undefined && e.secret === undefined));
  const sub = await names(s.room, s.rootId, 'zeta');
  assert.deepEqual(sub, []);
});

test('listDir truncates a folder of more than LIMITS.dirEntries entries, sorted before the cut, and stats only the kept ones', async () => {
  let lstats = 0;
  let stats = 0;
  const s = await setup({
    fs: wrapFs({
      lstat: (p) => (lstats++, realFs.lstat(p)),
      stat: (p) => (stats++, realFs.stat(p)),
    }),
  });
  const total = LIMITS.dirEntries + 120;
  const pad = (i: number): string => String(i).padStart(4, '0');
  await Promise.all(Array.from({ length: total }, (_, i) => fs.writeFile(path.join(s.root, `f${pad(i)}.txt`), 'x')));
  await fs.mkdir(path.join(s.root, 'zz-folder')); // sorts last by name, but folders come first
  lstats = 0;
  stats = 0;
  const r = await s.room.listDir(s.rootId, '');
  assert.ok(r.ok);
  assert.equal(r.entries.length, LIMITS.dirEntries);
  assert.equal(r.truncated, true);
  assert.equal(r.entries[0]?.name, 'zz-folder');
  assert.equal(r.entries[1]?.name, 'f0000.txt');
  assert.equal(r.entries[LIMITS.dirEntries - 1]?.name, `f${pad(LIMITS.dirEntries - 2)}.txt`);
  assert.ok(lstats <= LIMITS.dirEntries, `lstat calls: ${lstats}`);
  assert.ok(stats <= 2, `stat calls: ${stats}`); // the folder itself, once
});

test('listDir with exactly LIMITS.dirEntries entries is not truncated', async () => {
  const s = await setup();
  await Promise.all(Array.from({ length: LIMITS.dirEntries }, (_, i) => fs.writeFile(path.join(s.root, `n${i}`), '')));
  const r = await s.room.listDir(s.rootId, '');
  assert.ok(r.ok);
  assert.equal(r.entries.length, LIMITS.dirEntries);
  assert.equal(r.truncated, false);
});

test('listDir marks secret files, but only files', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, '.env'), 'TOKEN=abc');
  await fs.writeFile(path.join(s.root, '.env.example'), 'TOKEN=');
  await fs.writeFile(path.join(s.root, 'id_rsa'), 'key');
  await fs.writeFile(path.join(s.root, 'id_rsa.pub'), 'pub');
  await fs.writeFile(path.join(s.root, 'notes.txt'), 'n');
  await fs.mkdir(path.join(s.root, '.ssh'));
  await fs.writeFile(path.join(s.root, '.ssh', 'config'), 'Host x');
  await fs.symlink('.env', path.join(s.root, 'innocent-link'));
  const list = await names(s.room, s.rootId);
  const secret = new Map(list.map((e) => [e.name, e.secret === true]));
  assert.deepEqual([...secret].filter(([, v]) => v).map(([k]) => k).sort(), ['.env', 'id_rsa', 'innocent-link']);
  assert.equal(list.find((e) => e.name === '.ssh')?.secret, undefined);
  const inner = await names(s.room, s.rootId, '.ssh');
  assert.equal(inner[0]?.secret, true, 'everything under .ssh is secret');
});

// ---- previews -----------------------------------------------------------------------------------------------------

test('readFile: a small text file, an empty file, and an unreadable name', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'a b é.txt'), 'héllo\nworld\n');
  await fs.writeFile(path.join(s.root, 'empty.txt'), '');
  const a = await s.room.readFile(s.rootId, 'a b é.txt');
  assert.deepEqual(a, { ok: true, preview: { size: 13, text: 'héllo\nworld\n' } });
  const e = await s.room.readFile(s.rootId, 'empty.txt');
  assert.deepEqual(e, { ok: true, preview: { size: 0, text: '' } });
  assert.deepEqual(await s.room.readFile(s.rootId, 'nope'), { ok: false, error: 'missing' });
});

test('readFile: a file of exactly previewBytes is whole, one byte more is truncated', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'exact.txt'), 'a'.repeat(LIMITS.previewBytes));
  await fs.writeFile(path.join(s.root, 'over.txt'), 'a'.repeat(LIMITS.previewBytes + 1));
  const exact = await s.room.readFile(s.rootId, 'exact.txt');
  assert.ok(exact.ok);
  assert.equal(exact.preview.text?.length, LIMITS.previewBytes);
  assert.equal(exact.preview.truncated, undefined);
  const over = await s.room.readFile(s.rootId, 'over.txt');
  assert.ok(over.ok);
  assert.equal(over.preview.text?.length, LIMITS.previewBytes);
  assert.equal(over.preview.truncated, true);
  assert.equal(over.preview.size, LIMITS.previewBytes + 1);
});

test('readFile: a 300 KB text file is cut at a UTF-8 character boundary', async () => {
  const s = await setup();
  // The cut at previewBytes lands inside a character for 2-byte and 4-byte text at every offset.
  const cases: Array<[string, string]> = [['two', 'é'], ['three', '€'], ['four', '😀']];
  for (const [label, ch] of cases) {
    const unit = Buffer.byteLength(ch);
    for (let lead = 0; lead < 4; lead++) {
      const body = 'a'.repeat(lead) + ch.repeat(Math.ceil(300 * 1024 / unit));
      const name = `${label}-${lead}.txt`;
      await fs.writeFile(path.join(s.root, name), body);
      const r = await s.room.readFile(s.rootId, name);
      assert.ok(r.ok, name);
      const text = r.preview.text ?? '';
      assert.equal(r.preview.truncated, true, name);
      assert.ok(!text.includes('\ufffd'), `${name}: no broken character`);
      const bytes = Buffer.byteLength(text);
      assert.ok(bytes <= LIMITS.previewBytes && bytes > LIMITS.previewBytes - 4, `${name}: ${bytes} bytes`);
      assert.ok(body.startsWith(text), name);
      assert.ok(r.preview.size > 300 * 1000);
    }
  }
});

test('readFile: a file over previewMaxFileBytes is tooLarge and is never opened', async () => {
  let opens = 0;
  const s = await setup({ fs: wrapFs({ open: (p, f) => (opens++, realFs.open(p, f)) }) });
  const size = 5 * 1024 * 1024;
  await fs.writeFile(path.join(s.root, 'big.log'), Buffer.alloc(size, 0x61));
  const r = await s.room.readFile(s.rootId, 'big.log');
  assert.deepEqual(r, { ok: true, preview: { size, tooLarge: true } });
  assert.equal(opens, 0);
  await fs.writeFile(path.join(s.root, 'limit.log'), Buffer.alloc(LIMITS.previewMaxFileBytes, 0x61));
  const edge = await s.room.readFile(s.rootId, 'limit.log');
  assert.ok(edge.ok);
  assert.equal(edge.preview.tooLarge, undefined, 'exactly the maximum is still previewed');
  assert.equal(edge.preview.truncated, true);
});

test('readFile: binary files get binary and no text', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'nul.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04, 0x61, 0x62]));
  await fs.writeFile(path.join(s.root, 'png.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0)]));
  await fs.writeFile(path.join(s.root, 'junk.dat'), Buffer.alloc(2000, 0xff)); // no NUL, all invalid UTF-8
  await fs.writeFile(path.join(s.root, 'nul-late.txt'), Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]));
  await fs.writeFile(path.join(s.root, 'doc.md'), Buffer.from([0x23, 0x20, 0x00])); // markdown flag needs text
  for (const n of ['nul.bin', 'png.png', 'junk.dat', 'nul-late.txt', 'doc.md']) {
    const r = await s.room.readFile(s.rootId, n);
    assert.ok(r.ok, n);
    assert.equal(r.preview.binary, true, n);
    assert.equal(r.preview.text, undefined, n);
    assert.equal(r.preview.markdown, undefined, n);
    assert.equal(r.preview.truncated, undefined, n);
  }
});

test('readFile: mostly-text with a few stray bytes is still text; a NUL after 8 KB is not looked for', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.root, 'latin1.txt'), Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' au lait, a long line of otherwise plain ascii text')]));
  const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0]), Buffer.alloc(10, 0x62)]);
  await fs.writeFile(path.join(s.root, 'late-nul.txt'), late);
  const a = await s.room.readFile(s.rootId, 'latin1.txt');
  assert.ok(a.ok);
  assert.equal(a.preview.binary, undefined);
  assert.ok(a.preview.text?.startsWith('caf\ufffd au lait'));
  const b = await s.room.readFile(s.rootId, 'late-nul.txt');
  assert.ok(b.ok);
  assert.equal(b.preview.binary, undefined);
  assert.equal(b.preview.text?.length, late.length);
});

test('readFile: markdown flag for .md, .markdown and .mdx, any case, only', async () => {
  const s = await setup();
  for (const n of ['a.md', 'b.markdown', 'c.mdx', 'D.MD', 'e.txt', 'f.mdoc', 'md', 'g.md.txt', 'h.md.bak']) await fs.writeFile(path.join(s.root, n), '# hi');
  const flags: Record<string, boolean | undefined> = {};
  for (const n of ['a.md', 'b.markdown', 'c.mdx', 'D.MD', 'e.txt', 'f.mdoc', 'md', 'g.md.txt', 'h.md.bak']) {
    const r = await s.room.readFile(s.rootId, n);
    assert.ok(r.ok, n);
    assert.equal(r.preview.text, '# hi');
    flags[n] = r.preview.markdown;
  }
  assert.deepEqual(flags, { 'a.md': true, 'b.markdown': true, 'c.mdx': true, 'D.MD': true, 'e.txt': undefined, 'f.mdoc': undefined, md: undefined, 'g.md.txt': undefined, 'h.md.bak': undefined });
});

// ---- secrets ------------------------------------------------------------------------------------------------------

test('readFile: a secret file reports secret and is never opened', async () => {
  let opens = 0;
  const s = await setup({ fs: wrapFs({ open: (p, f) => (opens++, realFs.open(p, f)) }) });
  await fs.writeFile(path.join(s.root, '.env'), 'TOKEN=hunter2');
  await fs.mkdir(path.join(s.root, '.aws'));
  await fs.writeFile(path.join(s.root, '.aws', 'config'), 'region=x');
  await fs.writeFile(path.join(s.root, 'tls.pem'), 'pem');
  await fs.symlink('.env', path.join(s.root, 'plain.txt'));
  await fs.symlink('.aws', path.join(s.root, 'cloud'));
  await fs.writeFile(path.join(s.root, 'id_rsa'), 'k'.repeat(10)); // even a small private key
  const big = 'tooLarge-secret.key';
  await fs.writeFile(path.join(s.root, big), Buffer.alloc(LIMITS.previewMaxFileBytes + 1, 0x61)); // secret wins over tooLarge
  for (const [rel, size] of [['.env', 13], ['.aws/config', 8], ['tls.pem', 3], ['plain.txt', 13], ['cloud/config', 8], ['id_rsa', 10], [big, LIMITS.previewMaxFileBytes + 1]] as const) {
    assert.deepEqual(await s.room.readFile(s.rootId, rel), { ok: true, preview: { size, secret: true } }, rel);
  }
  assert.equal(opens, 0);
  // The allowed variants are read.
  await fs.writeFile(path.join(s.root, '.env.example'), 'TOKEN=');
  await fs.writeFile(path.join(s.root, 'id_rsa.pub'), 'ssh-rsa AAA');
  assert.equal((await s.room.readFile(s.rootId, '.env.example')).ok, true);
  const pub = await s.room.readFile(s.rootId, 'id_rsa.pub');
  assert.ok(pub.ok);
  assert.equal(pub.preview.text, 'ssh-rsa AAA');
  assert.equal(pub.preview.secret, undefined);
  assert.equal(opens, 2);
});

test('secret files stay secret when the root is below a .ssh folder', async () => {
  const base = await tmpDir();
  const root = path.join(base, '.ssh', 'keys');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'notes.txt'), 'x');
  const room = new FileRoom({ homeDir: base, claudeHome: path.join(base, 'ch') });
  const [r] = await room.setRoots([{ kind: 'project', path: root }]);
  assert.ok(r);
  assert.deepEqual(await room.readFile(r.rootId, 'notes.txt'), { ok: true, preview: { size: 1, secret: true } });
  assert.equal((await names(room, r.rootId))[0]?.secret, true);
});

// ---- the Claude data folder ---------------------------------------------------------------------------------------

test('private files of the Claude data folder are never listed, resolved or read', async () => {
  const base = await tmpDir();
  const ch = path.join(base, 'dot-claude');
  await fs.mkdir(path.join(ch, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(ch, 'projects', 'p'), { recursive: true });
  await fs.mkdir(path.join(ch, 'session-env'));
  await fs.mkdir(path.join(ch, 'paste-cache'));
  await fs.mkdir(path.join(ch, 'file-history'));
  await fs.writeFile(path.join(ch, '.credentials.json'), '{"token":"x"}');
  await fs.writeFile(path.join(ch, 'history.jsonl'), 'h');
  await fs.writeFile(path.join(ch, 'sessions', '123.key'), 'k');
  await fs.writeFile(path.join(ch, 'sessions', '123.json'), '{}');
  await fs.writeFile(path.join(ch, 'session-env', 'x'), 'x');
  await fs.writeFile(path.join(ch, 'settings.json'), '{"a":1}');
  const room = new FileRoom({ homeDir: base, claudeHome: ch });
  // Reached from the data folder itself, and from its parent (a root above it).
  for (const rootPath of [ch, base]) {
    const [r] = await room.setRoots([{ kind: 'project', path: rootPath }]);
    assert.ok(r);
    const prefix = rootPath === ch ? '' : 'dot-claude/';
    const top = await names(room, r.rootId, prefix.replace(/\/$/, ''));
    assert.deepEqual(top.map((e) => e.name).sort(), ['projects', 'sessions', 'settings.json']);
    for (const rel of ['.credentials.json', 'history.jsonl', 'sessions/123.key', 'session-env', 'session-env/x', 'paste-cache', 'file-history']) {
      assert.deepEqual(await room.resolve(r.rootId, prefix + rel), { ok: false, error: 'notAllowed' }, rel);
      assert.deepEqual(await room.readFile(r.rootId, prefix + rel), { ok: false, error: 'notAllowed' }, rel);
    }
    assert.deepEqual(await room.listDir(r.rootId, prefix + 'session-env'), { ok: false, error: 'notAllowed' });
    assert.deepEqual((await names(room, r.rootId, prefix + 'sessions')).map((e) => e.name), ['123.json']);
    const ok = await room.readFile(r.rootId, prefix + 'settings.json');
    assert.ok(ok.ok);
    assert.equal(ok.preview.text, '{"a":1}');
  }
  // A link to a private file is refused as well.
  await fs.symlink(path.join(ch, 'history.jsonl'), path.join(base, 'hist-link'));
  const [r] = await room.setRoots([{ kind: 'project', path: base }]);
  assert.ok(r);
  assert.deepEqual(await room.readFile(r.rootId, 'hist-link'), { ok: false, error: 'notAllowed' });
  assert.deepEqual((await names(room, r.rootId)).find((e) => e.name === 'hist-link'), { name: 'hist-link', kind: 'other' });
  // And a root that is a private folder is not accepted.
  assert.deepEqual(await room.setRoots([{ kind: 'project', path: path.join(ch, 'session-env') }]), []);
});

// ---- logging ------------------------------------------------------------------------------------------------------

test('log lines hold ids, kinds and counts, never paths, names or contents', async () => {
  const s = await setup();
  await fs.mkdir(path.join(s.root, 'zq-folder-name'));
  await fs.writeFile(path.join(s.root, 'zq-file-name.txt'), 'zq-file-contents');
  await fs.writeFile(path.join(s.root, '.env'), 'zq-secret-contents');
  await fs.symlink(path.join(s.outside, 'private.txt'), path.join(s.root, 'zq-link-name'));
  await s.room.listDir(s.rootId, '');
  await s.room.readFile(s.rootId, 'zq-file-name.txt');
  await s.room.readFile(s.rootId, '.env');
  await s.room.readFile(s.rootId, 'zq-link-name');
  await s.room.readFile(s.rootId, 'zq-missing');
  await s.room.listDir('r404', '');
  assert.ok(s.logs.length >= 6);
  const all = s.logs.join('\n');
  for (const needle of ['zq-', os.tmpdir(), 'mm-fileroom', s.base, 'private.txt', 'hunter']) assert.ok(!all.includes(needle), `log leaks ${needle}`);
  assert.ok(s.logs.some((l) => l.includes(`root=${s.rootId}`) && /entries=\d+/.test(l)));
  assert.ok(s.logs.some((l) => /bytes=\d+/.test(l)));
});

test('fileRoomErrorText has a short path-free sentence for every error', () => {
  for (const e of ['unknownRoot', 'badPath', 'outside', 'missing', 'notAllowed', 'notDir', 'notFile', 'changed', 'failed'] as const) {
    const t = fileRoomErrorText(e);
    assert.ok(t.length > 0 && t.length <= LIMITS.errorChars && !t.includes('/'), e);
  }
});
