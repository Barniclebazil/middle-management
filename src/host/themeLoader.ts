// Loads and watches the user's theme file. No `vscode` import: file access and timers are injected.
import { isAbsolute, join } from 'node:path';
import { parseTheme } from '../shared/theme.ts';
import { revisionOf } from './themeWriter.ts';
import type { OfficeTheme } from '../shared/theme.ts';

export interface ThemeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ThemeLoaderDeps {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  homeDir(): string;
  timers: ThemeTimers;
  log(line: string): void;
}

export interface ThemeLoadResult {
  /** Undefined when the file is missing, unreadable or not JSON. With field errors it is the partial theme. */
  theme: OfficeTheme | undefined;
  /** Readable problems, each already prefixed `theme: ` or with the offending field path. */
  errors: string[];
  /** The path that was read (with `~` expanded). */
  path: string;
  /** `revisionOf` the raw file text. Undefined when the file could not be read. */
  rev?: string;
  /** True when the file parsed as a JSON object (what the write guards need); false for a missing, unreadable or non-object file. */
  jsonObject: boolean;
  /** True when the file does not exist (ENOENT or ENOTDIR), as opposed to being unreadable for another reason. */
  missing: boolean;
  /** The raw file text, kept only when the file was read (so absent for a missing or unreadable file). Never log it. */
  text?: string;
}

/** Expand a leading `~` or `~/` to the home folder. Anything else is returned unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home.endsWith('/') ? home + p.slice(2) : home + p.slice(1);
  return p;
}

/**
 * Turn the setting value into a file path: '' stays '', `~` expands to home, absolute paths are unchanged and
 * relative ones resolve against `baseDir` (or home when `baseDir` is empty), never the process working directory.
 */
export function resolveThemePath(p: string, home: string, baseDir?: string): string {
  const t = p.trim();
  if (t === '') return '';
  const e = expandHome(t, home);
  if (isAbsolute(e)) return e;
  return join(baseDir !== undefined && baseDir !== '' ? baseDir : home, e);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read, JSON-parse and validate one theme file. Never throws. `path` is used as given (expand `~` first). */
export async function loadThemeFile(path: string, deps: Pick<ThemeLoaderDeps, 'readFile'>): Promise<ThemeLoadResult> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    const msg = missing ? `theme: file not found: ${path}` : `theme: could not read ${path}: ${errText(e)}`;
    return { theme: undefined, errors: [msg], path, jsonObject: false, missing };
  }
  const rev = revisionOf(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { theme: undefined, errors: [`theme: not valid JSON: ${errText(e)}`], path, rev, jsonObject: false, missing: false, text };
  }
  const { theme, errors } = parseTheme(raw);
  return { theme, errors, path, rev, jsonObject: typeof raw === 'object' && raw !== null && !Array.isArray(raw), missing: false, text };
}

/**
 * Watches one theme file. While visible and a path is set it polls `stat` every `pollMs` (a setTimeout chain, so polls
 * never overlap) and reloads when the modified time or size changes. It also loads once whenever the path is set, even
 * while hidden. Calls `onChange` after each reload. Never throws.
 */
export class ThemeWatcher {
  private readonly deps: ThemeLoaderDeps;
  private readonly onChange: (r: ThemeLoadResult) => void;
  private readonly pollMs: number;

  private path = '';
  private visible = false;
  private disposed = false;
  private gen = 0;
  private timer: unknown;
  private busy = false;
  private lastSig: string | undefined;
  private good: OfficeTheme | undefined;

  constructor(deps: ThemeLoaderDeps, onChange: (r: ThemeLoadResult) => void, pollMs = 2000) {
    this.deps = deps;
    this.onChange = onChange;
    this.pollMs = pollMs;
  }

  /** The newest theme that loaded with no errors from the current path. Cleared when the path changes. */
  lastGood(): OfficeTheme | undefined {
    return this.good;
  }

  /** Watch a new file (`~` allowed) and load it once. An empty path stops watching. The same path again is ignored. */
  setPath(path: string): void {
    if (this.disposed || path === this.path) return;
    this.path = path;
    this.good = undefined;
    this.lastSig = undefined;
    this.restart();
  }

  /** Poll only while visible. Becoming visible again checks the file at once. */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      if (this.path !== '' && !this.busy && this.timer === undefined) this.schedule(this.gen, 0);
    } else {
      this.clearTimer();
    }
  }

  /**
   * Re-read the file now, outside the poll timer, and notify like a change (even when the file looks unchanged).
   * Does nothing when no path is set. Never throws.
   */
  async reloadNow(): Promise<void> {
    if (this.disposed || this.path === '') return;
    const gen = this.gen;
    const path = expandHome(this.path, this.safeHome());
    try {
      let sig: string;
      try {
        const st = await this.deps.stat(path);
        sig = `${st.mtimeMs}:${st.size}`;
      } catch {
        sig = 'missing';
      }
      if (gen !== this.gen) return;
      this.lastSig = sig;
      const result = await loadThemeFile(path, this.deps);
      if (gen !== this.gen) return;
      this.deliver(result);
    } catch (e) {
      this.deps.log(`theme: reload failed: ${errText(e)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.clearTimer();
  }

  private restart(): void {
    this.gen++;
    this.clearTimer();
    this.busy = false;
    if (this.path !== '') this.schedule(this.gen, 0);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(gen: number, ms: number): void {
    this.timer = this.deps.timers.setTimeout(() => void this.pollOnce(gen), ms);
  }

  private async pollOnce(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    this.timer = undefined;
    this.busy = true;
    const path = expandHome(this.path, this.safeHome());
    try {
      let sig: string;
      try {
        const st = await this.deps.stat(path);
        sig = `${st.mtimeMs}:${st.size}`;
      } catch {
        sig = 'missing';
      }
      if (gen !== this.gen) return;
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        const result = await loadThemeFile(path, this.deps);
        if (gen !== this.gen) return;
        this.deliver(result);
      }
    } catch (e) {
      this.deps.log(`theme: poll failed: ${errText(e)}`);
    } finally {
      if (gen === this.gen) {
        this.busy = false;
        if (this.visible && !this.disposed && this.path !== '') this.schedule(gen, this.pollMs);
      }
    }
  }

  private deliver(result: ThemeLoadResult): void {
    if (result.theme !== undefined && result.errors.length === 0) this.good = result.theme;
    try {
      this.onChange(result);
    } catch (e) {
      this.deps.log(`theme: change handler failed: ${errText(e)}`);
    }
  }

  private safeHome(): string {
    try {
      return this.deps.homeDir();
    } catch {
      return '';
    }
  }
}
