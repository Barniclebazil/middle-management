// The theme state that used to live in the `activate()` closures: the watcher, its latest load, the theme the office shows
// (the latest load's theme, or the last good one while the file is broken) and the source resolved from the
// `claudeOffice.themeFile` setting. No `vscode` import: the setting, the home and preset folders, the fs and the timers are
// injected. The Front desk reaches it through `lastLoad` / `currentTheme` / `applyThemePath` / `reloadNow`.
import type { OfficeTheme } from '../shared/theme.ts';
import { ThemeWatcher } from './themeLoader.ts';
import type { ThemeLoadResult, ThemeLoaderDeps } from './themeLoader.ts';
import { resolveThemeSource } from './themeSource.ts';
import type { ThemeSource } from './themeSource.ts';

export interface ThemeServiceDeps extends ThemeLoaderDeps {
  /** The raw `claudeOffice.themeFile` value ('' when unset). */
  setting(): string;
  /** First workspace folder, or undefined (relative theme paths then resolve against the home folder). */
  baseDir(): string | undefined;
  /** `<extension>/media/themes`, where `preset:<id>` files live. */
  presetDir(): string;
}

/** Why `onChange` was called: a file load (also a failed one) or the source being cleared back to the built-in office. */
export type ThemeChange = { kind: 'load'; result: ThemeLoadResult } | { kind: 'cleared' };

export class ThemeService {
  readonly #deps: ThemeServiceDeps;
  readonly #watcher: ThemeWatcher;
  #lastLoad: ThemeLoadResult | undefined;
  #current: OfficeTheme | undefined;
  #source: ThemeSource = { kind: 'builtin', label: 'Built-in office', path: '', displayPath: '' };
  #lastSourceError: string | undefined;
  readonly #onChange: (change: ThemeChange) => void;

  /** `onChange` runs after the state below is updated; it posts `settings` and pushes the Front desk state. Must not throw. */
  constructor(deps: ThemeServiceDeps, onChange: (change: ThemeChange) => void) {
    this.#deps = deps;
    this.#watcher = new ThemeWatcher(
      deps,
      (result) => {
        this.#lastLoad = result;
        this.#current = result.theme ?? this.#watcher.lastGood();
        onChange({ kind: 'load', result });
      },
    );
    this.#onChange = onChange;
  }
  /** The newest load the watcher delivered (cleared when the source goes back to the built-in office). */
  lastLoad(): ThemeLoadResult | undefined {
    return this.#lastLoad;
  }

  /** The theme the office shows now. */
  currentTheme(): OfficeTheme | undefined {
    return this.#current;
  }

  /** The source the setting resolved to at the last `applyThemePath`. */
  source(): ThemeSource {
    return this.#source;
  }

  /**
   * Re-read the setting into the watcher (the old `syncThemePath`). `preset:<id>` resolves to the packaged file; a bad or
   * unknown id falls back to the built-in office (the Front desk shows the error; it is logged here once per message).
   * Safe to call when nothing changed.
   */
  applyThemePath(): void {
    const source = resolveThemeSource(this.#deps.setting(), this.#deps.homeDir(), this.#deps.baseDir(), this.#deps.presetDir());
    this.#source = source;
    const err = source.kind === 'builtin' ? source.error : undefined;
    if (err !== undefined && err !== this.#lastSourceError) this.#deps.log(err);
    this.#lastSourceError = err;
    this.#watcher.setPath(source.path);
    if (source.path === '' && (this.#current !== undefined || this.#lastLoad !== undefined)) {
      this.#current = undefined;
      this.#lastLoad = undefined;
      this.#onChange({ kind: 'cleared' });
    }
  }

  /** Re-read the file now and notify like a change. */
  reloadNow(): Promise<void> {
    return this.#watcher.reloadNow();
  }

  /** Poll the file only while the office is visible. */
  setVisible(visible: boolean): void {
    this.#watcher.setVisible(visible);
  }

  dispose(): void {
    this.#watcher.dispose();
  }
}
