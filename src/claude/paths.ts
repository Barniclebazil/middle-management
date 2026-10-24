import * as os from 'node:os';
import * as path from 'node:path';

/** Claude Code's data folder: `CLAUDE_CONFIG_DIR` if set, else `<home>/.claude`. */
export function claudeHome(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const override = env['CLAUDE_CONFIG_DIR'];
  if (override !== undefined && override !== '') return override;
  return path.join(home, '.claude');
}

/**
 * The config folder name INSIDE a project (`<project>/.claude`: project CLAUDE.md, skills, commands, agents, settings,
 * rules). It is project-relative: it is NOT the user's `~/.claude`, which only `claudeHome` builds.
 */
export const PROJECT_CLAUDE_DIR = '.claude';

/** `<claudeHome>/projects`, holding one folder per working directory. */
export function projectsDir(home: string): string {
  return path.join(home, 'projects');
}

/** `<claudeHome>/sessions`, holding `<pid>.json` live status files (and secret `*.key` files we never open). */
export function sessionsDir(home: string): string {
  return path.join(home, 'sessions');
}

/** Claude Code's folder name for a working directory: every character outside [a-zA-Z0-9] becomes '-'. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function normalise(p: string): string {
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * True when `child` equals `dir` or lies below it. Works on POSIX and Windows-style strings alike
 * (backslashes are treated as separators). Case-insensitive on win32 and for drive-letter paths.
 */
export function isInsideDir(child: string, dir: string, caseInsensitive?: boolean): boolean {
  const ci = caseInsensitive ?? (process.platform === 'win32' || /^[a-zA-Z]:/.test(dir));
  let c = normalise(child);
  let d = normalise(dir);
  if (ci) {
    c = c.toLowerCase();
    d = d.toLowerCase();
  }
  if (c === d) return true;
  return c.startsWith(d.endsWith('/') ? d : d + '/');
}

/**
 * Claude Code's account/state file: `<CLAUDE_CONFIG_DIR>/.claude.json` when that variable is set, else `<home>/.claude.json`
 * (note: NOT inside `~/.claude/`; live-checked in docs/sdk-spike.md section 14g). It holds account data: only
 * `claudeConfig.ts` may interpret its contents.
 */
export function claudeConfigJsonPath(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const override = env['CLAUDE_CONFIG_DIR'];
  if (override !== undefined && override !== '') return path.join(override, '.claude.json');
  return path.join(home, '.claude.json');
}

/** `<claudeHome>/settings.json`: the user's Claude Code settings (`CLAUDE_CONFIG_DIR` aware, like `claudeHome`). */
export function claudeSettingsJsonPath(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  return path.join(claudeHome(env, home), 'settings.json');
}
