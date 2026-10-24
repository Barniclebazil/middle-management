// Lists the theme files in the user's themes folder (where Claude saves the offices it makes). No `vscode` import:
// file access and the clock are injected, like themeLoader.ts.
import { join, resolve } from 'node:path';
import { LIMITS } from '../shared/protocol.ts';
import type { FrontDeskUserTheme } from '../shared/protocol.ts';
import { loadThemeFile } from './themeLoader.ts';

const SUFFIX = '.theme.json';
const MAX_BYTES = 1024 * 1024;
const LABEL_CHARS = 40;

/** The folder Claude saves themes in: `<home>/.middle-management/themes`. */
export function defaultThemesDir(home: string): string {
  return join(home, '.middle-management', 'themes');
}

/** The `claudeOffice.themeFile` value for a file in the themes folder. Always `~` and forward slashes, so it survives settings sync. */
export function settingValueFor(fileName: string): string {
  return `~/.middle-management/themes/${fileName}`;
}

export interface UserThemesTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UserThemesDeps {
  /** The themes folder (absolute). */
  dir: string;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;
  readFile(path: string): Promise<string>;
  onChange?: () => void;
  timers?: UserThemesTimers;
  pollMs?: number;
  /** Defaults to `process.platform`; `win32` compares paths ignoring case. */
  platform?: string;
}

interface Entry {
  id: string;
  mtimeMs: number;
  size: number;
  label: string;
  description?: string;
  problems: boolean;
}

/** Drop control characters, then keep at most `max` code points so a surrogate pair is never split. */
function clip(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, max).join('') : t;
}

/** Lists `*.theme.json` files at the top level of one folder, newest first. Never throws. */
export class UserThemes {
  /** True when the folder holds more than LIMITS.userThemes theme files (the oldest are left out). */
  truncated = false;

  private readonly deps: UserThemesDeps;
  private readonly pollMs: number;
  private readonly timers: UserThemesTimers;
  private list: Entry[] = [];
  private cache = new Map<string, Entry>();
  private visible = false;
  private disposed = false;
  private busy = false;
  private timer: unknown;
  private lastSig = JSON.stringify([false, []]);

  constructor(deps: UserThemesDeps) {
    this.deps = deps;
    this.pollMs = deps.pollMs ?? 5000;
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  }

  /** Re-list the folder. Resolves true when the list (or `truncated`) changed. Never throws. */
  async rescan(): Promise<boolean> {
    try {
      return await this.scan();
    } catch {
      return false;
    }
  }

  /** The list for the Front desk, with `current` set on the entry whose file is `currentPath` (absolute, `~` already expanded). */
  entries(currentPath: string | undefined): FrontDeskUserTheme[] {
    const cur = currentPath === undefined || currentPath === '' ? undefined : this.norm(resolve(currentPath));
    return this.list.map((e) => {
      const t: FrontDeskUserTheme = {
        id: e.id,
        label: e.label,
        current: cur !== undefined && this.norm(resolve(this.deps.dir, e.id)) === cur,
        problems: e.problems,
      };
      if (e.description !== undefined) t.description = e.description;
      return t;
    });
  }

  /** True when `id` is a file name from the latest scan. */
  has(id: string): boolean {
    return this.list.some((e) => e.id === id);
  }

  /** The absolute path of a file from the latest scan; undefined for any other name. */
  pathFor(id: string): string | undefined {
    return this.has(id) ? join(this.deps.dir, id) : undefined;
  }

  /** Poll only while visible. Becoming visible scans at once. */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      if (!this.busy && this.timer === undefined) this.schedule(0);
    } else {
      this.clearTimer();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private norm(p: string): string {
    return (this.deps.platform ?? process.platform) === 'win32' ? p.toLowerCase() : p;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.timer = this.timers.setTimeout(() => void this.pollOnce(), ms);
  }

  private async pollOnce(): Promise<void> {
    this.timer = undefined;
    this.busy = true;
    try {
      if (await this.rescan() && !this.disposed) {
        try {
          this.deps.onChange?.();
        } catch {
          // A failing listener must not stop the poll.
        }
      }
    } finally {
      this.busy = false;
      if (this.visible && !this.disposed) this.schedule(this.pollMs);
    }
  }

  private async scan(): Promise<boolean> {
    const { dir } = this.deps;
    let names: string[];
    try {
      names = await this.deps.readdir(dir);
    } catch {
      names = [];
    }
    const found: Array<{ id: string; mtimeMs: number; size: number }> = [];
    for (const id of names) {
      if (id.startsWith('.') || !id.endsWith(SUFFIX) || id.length === SUFFIX.length || id.length > LIMITS.themeIdChars) continue;
      try {
        const st = await this.deps.stat(join(dir, id));
        if (st.isFile() && st.size <= MAX_BYTES) found.push({ id, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Gone or unreadable: leave it out.
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const truncated = found.length > LIMITS.userThemes;
    const next: Entry[] = [];
    const cache = new Map<string, Entry>();
    for (const f of found.slice(0, LIMITS.userThemes)) {
      const old = this.cache.get(f.id);
      const e = old !== undefined && old.mtimeMs === f.mtimeMs && old.size === f.size ? old : await this.read(f);
      if (e === undefined) continue;
      cache.set(f.id, e);
      next.push(e);
    }
    this.cache = cache;
    this.list = next;
    const sig = JSON.stringify([truncated, next]);
    const changed = sig !== this.lastSig;
    this.lastSig = sig;
    this.truncated = truncated;
    return changed;
  }

  private async read(f: { id: string; mtimeMs: number; size: number }): Promise<Entry | undefined> {
    const r = await loadThemeFile(join(this.deps.dir, f.id), this.deps);
    if (r.missing) return undefined;
    const stem = f.id.slice(0, -SUFFIX.length);
    const t = r.theme;
    const e: Entry = {
      id: f.id,
      mtimeMs: f.mtimeMs,
      size: f.size,
      label: clip(t?.name !== undefined && t.name.trim() !== '' ? t.name : stem, LABEL_CHARS),
      problems: !r.jsonObject || r.errors.length > 0,
    };
    let d = t?.description;
    if (d === undefined && t?.company !== undefined) d = t.branch !== undefined && t.branch !== '' ? `${t.company} - ${t.branch}` : t.company;
    if (d !== undefined && d.trim() !== '') e.description = clip(d, LIMITS.descriptionChars);
    return e;
  }
}
