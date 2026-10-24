// One CLAUDE_CONFIG_DIR resolution: `src/claude/paths.ts` is the only place that reads it, every other path derives from
// it, and the processes we start (office runs and the usage probe) inherit the same environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeConfigJsonPath, claudeHome, claudeSettingsJsonPath, projectsDir, sessionsDir } from '../src/claude/paths.ts';
import { buildRunnerEnv } from '../src/manager/sessionRunner.ts';
import type { QueryFn } from '../src/manager/sessionRunner.ts';
import { runUsageProbe } from '../src/manager/usageProbe.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('only src/claude/paths.ts reads CLAUDE_CONFIG_DIR, and no other source file builds a ~/.claude path by hand', () => {
  const root = path.join(import.meta.dirname, '..', 'src');
  const paths = path.join(root, 'claude', 'paths.ts');
  for (const file of sourceFiles(root)) {
    if (file === paths) continue;
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    assert.equal(/CLAUDE_CONFIG_DIR/.test(code), false, `${path.relative(root, file)} reads CLAUDE_CONFIG_DIR`);
    assert.equal(/['"]\.claude(\.json)?['"]/.test(code), false, `${path.relative(root, file)} builds a .claude path by hand`);
  }
});

test('with CLAUDE_CONFIG_DIR set, sessions, projects, .claude.json and settings.json all sit under it', () => {
  const env = { CLAUDE_CONFIG_DIR: '/data/claude-alt' };
  const home = claudeHome(env, '/home/u');
  assert.equal(home, '/data/claude-alt');
  assert.equal(sessionsDir(home), path.join('/data/claude-alt', 'sessions'));
  assert.equal(projectsDir(home), path.join('/data/claude-alt', 'projects'));
  assert.equal(claudeConfigJsonPath(env, '/home/u'), path.join('/data/claude-alt', '.claude.json'));
  assert.equal(claudeSettingsJsonPath(env, '/home/u'), path.join('/data/claude-alt', 'settings.json'));
  // Unset: the usual layout.
  assert.equal(claudeHome({}, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(claudeConfigJsonPath({}, '/home/u'), path.join('/home/u', '.claude.json'));
  assert.equal(claudeSettingsJsonPath({}, '/home/u'), path.join('/home/u', '.claude', 'settings.json'));
});

test('office runs and the usage probe pass CLAUDE_CONFIG_DIR on to the Claude process', async () => {
  const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/data/claude-alt', CLAUDE_CODE_SESSION_ID: 'x' };
  const run = buildRunnerEnv(base);
  assert.equal(run['CLAUDE_CONFIG_DIR'], '/data/claude-alt');
  assert.equal(run['CLAUDE_CODE_SESSION_ID'], undefined);

  let seen: Record<string, string | undefined> | undefined;
  const never = new Promise<never>(() => {});
  const queryFn: QueryFn = (p) => {
    seen = (p.options as { env?: Record<string, string | undefined> }).env;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => never }),
      interrupt: async () => undefined,
      close: () => undefined,
      initializationResult: async () => ({ models: [] }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true }),
    } as never;
  };
  const r = await runUsageProbe({ queryFn, binaryPath: '/bin/claude', env: base });
  assert.equal(r.status, 'ok');
  assert.equal(seen?.['CLAUDE_CONFIG_DIR'], '/data/claude-alt');
  assert.equal(seen?.['CLAUDE_CODE_ENTRYPOINT'], 'claude-office-probe');
});
