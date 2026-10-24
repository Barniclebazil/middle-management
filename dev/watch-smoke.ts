// Read-only smoke check: one ClaudeWatcher poll against the real Claude data folder.
// Prints counts and ids only, never transcript contents.
// Run with: node dev/watch-smoke.ts
import { claudeHome } from '../src/claude/paths.ts';
import { ClaudeWatcher } from '../src/claude/sessions.ts';

const home = claudeHome();
const watcher = new ClaudeWatcher({ claudeHome: home, scope: 'all' });
const started = Date.now();
const update = await watcher.poll();
const elapsed = Date.now() - started;

const counts = new Map<string, number>();
for (const b of update.batches) {
  const key = b.sessionId + (b.agentId ? '/' + b.agentId : '');
  counts.set(key, (counts.get(key) ?? 0) + b.records.length);
}

console.log(`claude home: ${home}`);
console.log(`poll took ${elapsed} ms, errors: ${watcher.errorCount}`);
console.log(`sessions: ${update.sessions.length}, batches: ${update.batches.length}`);
for (const s of update.sessions) {
  const live = s.live ? `${s.live.status}${s.live.alive ? '' : ' (pid dead)'}` : 'no live status';
  const age = Math.round((Date.now() - s.mtimeMs) / 1000);
  console.log(
    `  ${s.sessionId}  records=${counts.get(s.sessionId) ?? 0}  live=${live}  subagents=${s.subagents.length}  age=${age}s`,
  );
}
