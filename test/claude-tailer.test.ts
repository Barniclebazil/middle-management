import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INITIAL_WINDOW_BYTES, JsonlTailer, MAX_READ_BYTES } from '../src/claude/tailer.ts';
import { FIXTURE_HOME, makeTempDir, rmTemp } from './claude-fixtures.ts';

const PROJECT = path.join(FIXTURE_HOME, 'projects', '-home-user-demo-project');

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTemp(dir);
  }
}

test('first read of a fixture returns every record with reset=true, then nothing', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'tour.jsonl');
    await fs.promises.copyFile(path.join(PROJECT, 'aaaa0001-0000-4000-8000-000000000001.jsonl'), file);
    const expected = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '').length;
    const t = new JsonlTailer(file);
    const first = await t.read();
    assert.equal(first.reset, true);
    assert.equal(first.records.length, expected);
    const second = await t.read();
    assert.deepEqual(second, { records: [], reset: false });
  });
});

test('a half-written line is held back until its newline arrives', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'a.jsonl');
    await fs.promises.writeFile(file, '{"n":1}\n{"n":2}\n');
    const t = new JsonlTailer(file);
    assert.equal((await t.read()).records.length, 2);

    await fs.promises.appendFile(file, '{"n":3,"te');
    assert.deepEqual(await t.read(), { records: [], reset: false });
    await fs.promises.appendFile(file, 'xt":"hi"}');
    assert.deepEqual(await t.read(), { records: [], reset: false });
    await fs.promises.appendFile(file, '\n');
    const r = await t.read();
    assert.equal(r.reset, false);
    assert.deepEqual(r.records, [{ n: 3, text: 'hi' }]);
  });
});

test('a UTF-8 character split across appends is decoded intact', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'u.jsonl');
    await fs.promises.writeFile(file, '{"n":1}\n');
    const t = new JsonlTailer(file);
    await t.read();

    const line = Buffer.from('{"t":"h\u00e9llo \u20ac \u{1F600} end"}\n', 'utf8');
    // Cut inside the 3-byte euro sign and, later, inside the 4-byte emoji.
    const euro = line.indexOf(Buffer.from('\u20ac'));
    const emoji = line.indexOf(Buffer.from('\u{1F600}'));
    const cuts = [euro + 1, emoji + 2];
    let prev = 0;
    for (const cut of cuts) {
      await fs.promises.appendFile(file, line.subarray(prev, cut));
      assert.deepEqual((await t.read()).records, []);
      prev = cut;
    }
    await fs.promises.appendFile(file, line.subarray(prev));
    const r = await t.read();
    assert.deepEqual(r.records, [{ t: 'h\u00e9llo \u20ac \u{1F600} end' }]);
  });
});

test('truncation and rewrite are detected and reset the reader', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'r.jsonl');
    await fs.promises.writeFile(file, '{"name":"original","n":1}\n{"name":"original","n":2}\n');
    const t = new JsonlTailer(file);
    assert.equal((await t.read()).records.length, 2);

    // Shrunk.
    await fs.promises.writeFile(file, '{"name":"short"}\n');
    const shrunk = await t.read();
    assert.equal(shrunk.reset, true);
    assert.deepEqual(shrunk.records, [{ name: 'short' }]);

    // Grown, but the first bytes differ: fingerprint mismatch.
    await fs.promises.writeFile(
      file,
      '{"zzzz":"completely different start","n":1}\n{"zzzz":"x","n":2}\n{"zzzz":"y","n":3}\n',
    );
    const rewritten = await t.read();
    assert.equal(rewritten.reset, true);
    assert.equal(rewritten.records.length, 3);

    // Normal append afterwards is not a reset.
    await fs.promises.appendFile(file, '{"zzzz":"z","n":4}\n');
    const appended = await t.read();
    assert.equal(appended.reset, false);
    assert.equal(appended.records.length, 1);
  });
});

test('a file that starts tiny and grows is not mistaken for a rewrite', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'g.jsonl');
    await fs.promises.writeFile(file, '{"a":1}\n');
    const t = new JsonlTailer(file);
    assert.equal((await t.read()).records.length, 1);
    await fs.promises.appendFile(file, `{"a":2,"pad":"${'x'.repeat(200)}"}\n`);
    const r = await t.read();
    assert.equal(r.reset, false);
    assert.equal(r.records.length, 1);
    await fs.promises.appendFile(file, '{"a":3}\n');
    assert.equal((await t.read()).reset, false);
  });
});

test('the partial fixture yields its 8 valid records and holds the cut line', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'partial.jsonl');
    await fs.promises.copyFile(path.join(PROJECT, 'aaaa0008-0000-4000-8000-000000000008.jsonl'), file);
    const t = new JsonlTailer(file);
    const first = await t.read();
    assert.equal(first.reset, true);
    assert.equal(first.records.length, 8);
    assert.deepEqual(await t.read(), { records: [], reset: false });
    // Once a newline closes the cut line it is invalid JSON and is skipped, not thrown.
    await fs.promises.appendFile(file, '\n');
    assert.deepEqual(await t.read(), { records: [], reset: false });
  });
});

test('the first read parses only the last 192 KB and drops the partial first line', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'big.jsonl');
    const total = 3000;
    const lines: string[] = [];
    for (let i = 0; i < total; i++) lines.push(JSON.stringify({ i, pad: 'p'.repeat(150) }));
    await fs.promises.writeFile(file, lines.join('\n') + '\n');
    assert.ok(fs.statSync(file).size > INITIAL_WINDOW_BYTES * 2);

    const t = new JsonlTailer(file);
    const r = await t.read();
    assert.equal(r.reset, true);
    assert.ok(r.records.length > 500 && r.records.length < total);
    const ids = r.records.map((x) => (x as { i: number }).i);
    assert.equal(ids[ids.length - 1], total - 1);
    for (let k = 1; k < ids.length; k++) assert.equal(ids[k], ids[k - 1]! + 1);
    const bytes = r.records.length * (lines[0]!.length + 1);
    assert.ok(bytes <= INITIAL_WINDOW_BYTES + lines[0]!.length + 1);
  });
});

test('appended data beyond 16 MB is delivered over several reads without loss', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'huge.jsonl');
    await fs.promises.writeFile(file, '{"i":-1}\n');
    const t = new JsonlTailer(file);
    await t.read();

    const count = 190_000;
    const pad = 'q'.repeat(100);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(`{"i":${i},"pad":"${pad}"}\n`);
    const blob = parts.join('');
    assert.ok(Buffer.byteLength(blob) > MAX_READ_BYTES);
    await fs.promises.appendFile(file, blob);

    let seen = 0;
    let reads = 0;
    for (; reads < 10; reads++) {
      const r = await t.read();
      assert.equal(r.reset, false);
      if (r.records.length === 0) break;
      seen += r.records.length;
    }
    assert.equal(seen, count);
    assert.ok(reads >= 2, 'the 16 MB cap should have split the data over at least two reads');
  });
});

test('a missing file reads as empty and starts working once it appears', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'later.jsonl');
    const t = new JsonlTailer(file);
    assert.deepEqual(await t.read(), { records: [], reset: false });
    await fs.promises.writeFile(file, '{"a":1}\n');
    const r = await t.read();
    assert.equal(r.reset, true);
    assert.equal(r.records.length, 1);
  });
});

test('CRLF line endings and blank lines are tolerated', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'crlf.jsonl');
    await fs.promises.writeFile(file, '{"a":1}\r\n\r\n{"a":2}\r\n');
    const r = await new JsonlTailer(file).read();
    assert.deepEqual(r.records, [{ a: 1 }, { a: 2 }]);
  });
});
