// Read-only smoke check: node dev/model-smoke.ts <path-to-main-transcript.jsonl>
// Feeds the last 192 KB of a real transcript to the AgentTracker and prints the snapshot without any transcript text.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { AgentTracker } from '../src/model/agentState.ts';

const TAIL_BYTES = 192 * 1024;
const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node dev/model-smoke.ts <path-to-jsonl>');
  process.exit(2);
}

const fd = openSync(file, 'r');
const { size, mtimeMs } = fstatSync(fd);
const start = Math.max(0, size - TAIL_BYTES);
const buf = Buffer.alloc(size - start);
readSync(fd, buf, 0, buf.length, start);
closeSync(fd);

let lines = buf.toString('utf8').split('\n');
if (start > 0) lines = lines.slice(1); // first line is probably cut in half
const records: unknown[] = [];
for (const line of lines) {
  if (line.trim() === '') continue;
  try {
    records.push(JSON.parse(line));
  } catch {
    // partial line
  }
}

const sessionId = basename(file, '.jsonl');
const tracker = new AgentTracker();
tracker.apply({
  sessions: [{ sessionId, transcriptPath: file, projectDir: file.slice(0, file.lastIndexOf('/')), mtimeMs, subagents: [] }],
  batches: [{ sessionId, reset: true, records }],
});
const now = Date.now();
console.log(`records parsed: ${records.length}, bytes read: ${buf.length}, transcript age: ${Math.round((now - mtimeMs) / 1000)} s`);
for (const s of tracker.snapshot(now)) {
  console.log(`id=${s.id} kind=${s.kind} activity=${s.activity} status=${s.status} since=${new Date(s.since).toISOString()} (${Math.round((now - s.since) / 1000)} s ago)`);
}
