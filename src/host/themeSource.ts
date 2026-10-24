// Where the office theme comes from: the built-in office, a packaged preset, or a user file. Pure: no fs, no vscode.
import { join } from 'node:path';
import { resolveThemePath } from './themeLoader.ts';

export interface ThemePreset {
  id: string;
  label: string;
  description: string;
  /** File name inside the preset folder (`media/themes`). */
  file: string;
}

/** The only presets the setting may name. The extension's install path is never stored in settings. */
export const PRESETS: readonly ThemePreset[] = [
  {
    id: 'example',
    label: 'Example office',
    description: 'Pennywhistle Paper, Harbour Branch: made-up staff, a receptionist and a seaside colour scheme of teal, slate and sand.',
    file: 'example.theme.json',
  },
  {
    id: 'spaceship',
    label: 'Spaceship',
    description: 'A fully themed starship crew where everyone talks ship, from the bridge to the galley, in cool deck greys and teal under a field of stars.',
    file: 'spaceship.theme.json',
  },
  {
    id: 'construction-site',
    label: 'Construction Site',
    description: 'A hi-vis site crew in the cabins, a gatehouse sign-in and concrete, plywood and safety-orange colours.',
    file: 'construction-site.theme.json',
  },
  {
    id: 'metalwork-factory',
    label: 'Metalwork Factory',
    description: 'Welders, furnace keepers and a crane driver, a works gate and a soot, steel and ember colour scheme.',
    file: 'metalwork-factory.theme.json',
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    description: 'A neon tower office in the endless rain: data brokers, drone couriers and a dark magenta and cyan palette.',
    file: 'cyberpunk.theme.json',
  },
  {
    id: 'steampunk',
    label: 'Steampunk',
    description: 'An airship and clockwork counting house: cog-wrights, a pneumatic post and brass, mahogany and baize.',
    file: 'steampunk.theme.json',
  },
];

export const PRESET_PREFIX = 'preset:';
export const PRESET_ID_RE = /^[a-z0-9-]{1,40}$/;

export function findPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The setting value that selects a preset. */
export function presetSetting(id: string): string {
  return PRESET_PREFIX + id;
}

interface SourceBase {
  /** Short name for the panel header. */
  label: string;
  /** Absolute file path, '' for the built-in office. */
  path: string;
  /** Path with the home folder shown as `~`; `preset:<id>` for a preset; '' for builtin. Display only. */
  displayPath: string;
}

export type ThemeSource =
  | (SourceBase & { kind: 'builtin'; error?: string })
  | (SourceBase & { kind: 'preset'; presetId: string })
  | (SourceBase & { kind: 'file' });

function isSep(c: string | undefined): boolean {
  return c === '/' || c === '\\';
}

/** Show `<home>/x` as `~/x`. Works for POSIX and Windows-style strings; drive-letter paths compare case-insensitively. */
export function shortenHome(p: string, home: string): string {
  if (home === '' || p === '') return p;
  const h = home.length > 1 && isSep(home[home.length - 1]) ? home.slice(0, -1) : home;
  const ci = /^[a-zA-Z]:/.test(h);
  const head = p.slice(0, h.length);
  if (ci ? head.toLowerCase() !== h.toLowerCase() : head !== h) return p;
  if (p.length === h.length) return '~';
  return isSep(p[h.length]) ? '~' + p.slice(h.length) : p;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== '');
  return parts[parts.length - 1] ?? p;
}

/**
 * Turn the `claudeOffice.themeFile` value into a source.
 * - '' (or only spaces): the built-in office.
 * - `preset:<id>`: a packaged preset, as `join(presetDir, file)`. An unknown or malformed id falls back to the built-in
 *   office with an `error` message (it never becomes a file path).
 * - anything else: a file; `~` expands to `home` and a relative path resolves against `baseDir` (home when empty).
 */
export function resolveThemeSource(setting: string, home: string, baseDir: string | undefined, presetDir: string): ThemeSource {
  const t = setting.trim();
  if (t === '') return { kind: 'builtin', label: 'Built-in office', path: '', displayPath: '' };
  if (t.startsWith(PRESET_PREFIX)) {
    const id = t.slice(PRESET_PREFIX.length);
    if (!PRESET_ID_RE.test(id)) {
      return { kind: 'builtin', label: 'Built-in office', path: '', displayPath: '', error: 'theme: the preset name in the Theme File setting is not valid; using the built-in office.' };
    }
    const preset = findPreset(id);
    if (preset === undefined) {
      return { kind: 'builtin', label: 'Built-in office', path: '', displayPath: '', error: `theme: unknown preset "${id}"; using the built-in office.` };
    }
    return { kind: 'preset', presetId: preset.id, label: preset.label, path: join(presetDir, preset.file), displayPath: presetSetting(preset.id) };
  }
  const path = resolveThemePath(t, home, baseDir);
  return { kind: 'file', label: baseName(path), path, displayPath: shortenHome(path, home) };
}
