// Live check: runs the real ClaudeWatcher + AgentTracker against ~/.claude and logs each change of the snapshot set.
// Usage: node dev/live-check.ts <targetDir> [--duration <s>] [--out <path>] [--scan-ms <ms>]
// Prints only snapshot fields (id suffix, kind, activity, status, detail), never transcript contents.
import { writeFileSync } from 'node:fs';
import { claudeHome } from '../src/claude/paths.ts';
import { ClaudeWatcher } from '../src/claude/sessions.ts';
import { AgentTracker } from '../src/model/agentState.ts';

export async function liveCheck(opts: {
  targetDir: string;
  durationS: number;
  out?: string;
  scanMs?: number;
  log?: (line: string) => void;
}): Promise<string[]> {
  const watcher = new ClaudeWatcher({
    claudeHome: claudeHome(),
    scope: { workspaceDirs: [opts.targetDir] },
    ...(opts.scanMs !== undefined ? { scanIntervalMs: opts.scanMs } : {}),
  });
  const tracker = new AgentTracker();
  const lines: string[] = [];
  const t0 = Date.now();
  let last = '';
  const end = t0 + opts.durationS * 1000;
  while (Date.now() < end) {
    const update = await watcher.poll();
    tracker.apply(update);
    const snap = tracker.snapshot();
    const body = snap
      .map((a) => `${a.id.slice(-6)} ${a.kind}${a.parentId ? '<-' + a.parentId.slice(-6) : ''} ${a.activity} ${a.status}${a.detail ? ' ' + JSON.stringify(a.detail) : ''}`)
      .join(' | ');
    if (body !== last) {
      last = body;
      const line = `${((Date.now() - t0) / 1000).toFixed(2)}s  ${body || '(no agents)'}`;
      lines.push(line);
      (opts.log ?? console.log)(line);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  lines.push(`done; watcher errors: ${watcher.errorCount}`);
  if (opts.out) writeFileSync(opts.out, lines.join('\n') + '\n');
  return lines;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const get = (f: string): string | undefined => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
  const target = a.find((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1]!.startsWith('--')));
  if (!target) {
    console.error('usage: node dev/live-check.ts <targetDir> [--duration s] [--out path] [--scan-ms ms]');
    process.exit(2);
  }
  const scan = get('--scan-ms');
  await liveCheck({
    targetDir: target,
    durationS: Number(get('--duration') ?? 150),
    ...(get('--out') ? { out: get('--out')! } : {}),
    ...(scan ? { scanMs: Number(scan) } : {}),
  });
}
