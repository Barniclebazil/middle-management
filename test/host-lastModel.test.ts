import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastModelInTranscript, readTailText } from '../src/host/lastModel.ts';

const rec = (type: string, model?: string) => JSON.stringify({ type, message: model ? { model, role: type } : { role: type } });

test('the last assistant record wins; synthetic and non-assistant records are skipped', () => {
  const text = [rec('assistant', 'claude-opus-4'), rec('user'), rec('assistant', 'claude-haiku-4-5'), rec('assistant', '<synthetic>'), rec('user'), '{broken'].join('\n');
  assert.equal(lastModelInTranscript(text), 'claude-haiku-4-5');
  assert.equal(lastModelInTranscript(''), undefined);
  assert.equal(lastModelInTranscript(rec('user')), undefined);
});

test('only the tail of the file is read, and a missing file gives nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lastmodel-'));
  try {
    const f = join(dir, 's.jsonl');
    const filler = rec('user') + '\n';
    writeFileSync(f, rec('assistant', 'claude-old') + '\n' + filler.repeat(5000) + rec('assistant', 'claude-new') + '\n');
    const tail = await readTailText(f, 1024);
    assert.ok(tail.length <= 1024);
    assert.equal(lastModelInTranscript(tail), 'claude-new');
    assert.equal(await readTailText(join(dir, 'missing.jsonl'), 1024), '');
    // Model only in the part beyond the tail: not found (never reads the whole file).
    writeFileSync(f, rec('assistant', 'claude-old') + '\n' + filler.repeat(5000));
    assert.equal(lastModelInTranscript(await readTailText(f, 1024)), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
