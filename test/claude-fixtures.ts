import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const FIXTURE_HOME = path.join(import.meta.dirname, 'fixtures', 'claude');

export async function makeTempDir(prefix = 'claude-office-test-'): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Copies the synthetic `~/.claude` fixture into a fresh temp dir and returns the copy's path. */
export async function copyFixtureHome(): Promise<string> {
  const dir = await makeTempDir();
  await fs.promises.cp(FIXTURE_HOME, dir, { recursive: true });
  return dir;
}

/** Sets the mtime of every file below `dir` whose name ends with `suffix`. */
export async function setMtimes(dir: string, suffix: string, ms: number): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await setMtimes(p, suffix, ms);
    else if (entry.name.endsWith(suffix)) await fs.promises.utimes(p, ms / 1000, ms / 1000);
  }
}

export async function rmTemp(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}
