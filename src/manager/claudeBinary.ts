// Finds the Claude Code binary that the Agent SDK should spawn. Pure apart from the default file checks at the bottom:
// every input (platform, home, PATH, file checks) is injected so the lookup is unit-testable. No `vscode` import.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type BinarySource = 'setting' | 'extension' | 'local-bin' | 'path';

export interface FindBinaryOptions {
  /** The `claudeOffice.claudePath` setting; empty or absent means "not set". */
  settingPath?: string;
  /** `extensionPath` of every Claude Code extension found (8.1 builds this from `vscode.extensions.all`). */
  claudeCodeExtensionPaths: string[];
  homedir: string;
  /** `process.platform` (or a test value). */
  platform: string;
  /** The PATH environment variable. */
  PATH?: string;
  /** True when the path exists and is a file. */
  exists: (p: string) => boolean;
  /** True when the file can be run. Defaults to `exists`. Not consulted on win32. */
  isExecutable?: (p: string) => boolean;
}

export type FindBinaryResult = { path: string; source: BinarySource } | { error: string };

/** Shims the SDK cannot spawn (it never uses a shell). */
const WIN_SHIM = /\.(cmd|bat|ps1)$/i;

function pathApi(platform: string): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Normalised copy of a candidate: reports why it was refused (undefined = fine). */
function refuse(p: string, platform: string): string | undefined {
  if (platform === 'win32' && WIN_SHIM.test(p)) return 'a .cmd/.bat shim cannot be run (use claude.exe)';
  return undefined;
}

/**
 * Order: setting, then `<ext>/resources/native-binary/claude[.exe]` for each Claude Code extension, then
 * `~/.local/bin/claude[.exe]`, then PATH. First hit that exists as a runnable file wins. On win32 only `claude.exe`
 * is ever considered from the automatic places and `.cmd`/`.bat` shims are refused everywhere.
 */
export function findClaudeBinary(opts: FindBinaryOptions): FindBinaryResult {
  const p = pathApi(opts.platform);
  const win = opts.platform === 'win32';
  const exeName = win ? 'claude.exe' : 'claude';
  const isExec = opts.isExecutable ?? opts.exists;
  const usable = (file: string): boolean => {
    try {
      return opts.exists(file) && (win || isExec(file));
    } catch {
      return false;
    }
  };
  const tried: string[] = [];

  // 1. Setting.
  const setting = (opts.settingPath ?? '').trim();
  if (setting === '') {
    tried.push('setting claudeOffice.claudePath (not set)');
  } else {
    const why = refuse(setting, opts.platform);
    if (why !== undefined) tried.push(`setting claudeOffice.claudePath "${setting}" (${why})`);
    else if (usable(setting)) return { path: setting, source: 'setting' };
    else tried.push(`setting claudeOffice.claudePath "${setting}" (missing or not executable)`);
  }

  // 2. The Claude Code extension.
  if (opts.claudeCodeExtensionPaths.length === 0) {
    tried.push('the Claude Code extension (not installed or not found)');
  }
  for (const ext of opts.claudeCodeExtensionPaths) {
    const candidate = p.join(ext, 'resources', 'native-binary', exeName);
    if (usable(candidate)) return { path: candidate, source: 'extension' };
    tried.push(`${candidate} (missing)`);
  }

  // 3. ~/.local/bin
  if (opts.homedir !== '') {
    const candidate = p.join(opts.homedir, '.local', 'bin', exeName);
    if (usable(candidate)) return { path: candidate, source: 'local-bin' };
    tried.push(`${candidate} (missing)`);
  }

  // 4. PATH
  const sep = win ? ';' : ':';
  const dirs = (opts.PATH ?? '').split(sep).map((d) => (win ? d.replace(/^"(.*)"$/, '$1') : d)).filter((d) => d.trim() !== '');
  for (const dir of dirs) {
    const candidate = p.join(dir, exeName);
    if (usable(candidate)) return { path: candidate, source: 'path' };
  }
  tried.push(`${exeName} on PATH (${dirs.length} folder${dirs.length === 1 ? '' : 's'} searched)`);

  return {
    error:
      `Could not find the Claude Code program. Tried: ${tried.join('; ')}. ` +
      'Install the Claude Code extension, or set "claudeOffice.claudePath" to the full path of ' +
      `${exeName}${win ? ' (not a .cmd or .bat file)' : ''}.`,
  };
}

/** Real file checks for 8.1: a regular file, and (non-Windows) executable by this user. */
export function nodeFileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function nodeIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
