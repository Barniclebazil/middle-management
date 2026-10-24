// The host side of the Front desk panel: builds its state and handles its messages. No `vscode` import: every
// dependency (settings, dialogs, files, the theme watcher, posting to the webview) is injected through `FrontDeskDeps`;
// `frontDeskAdapters.ts` has the real implementations. See docs/manager-mode.md section 17.
//
// The webview is untrusted. It never names a file: the theme file is always the one the `claudeOffice.themeFile` setting
// points at, and every other path comes from a dialog this host shows. Saving goes through `checkWriteGuards`, on both
// the configured path and the real (symlink-resolved) path, and writes only the re-parsed theme through `writeAtomic`.
//
// Logging: only request ids, action names, setting key names and lengths. Never a path, a setting value or theme text.
import { LIMITS, FRONT_DESK_BOOLEAN_SETTINGS, FRONT_DESK_ENUM_VALUES, FRONT_DESK_SETTINGS, FRONT_DESK_TEXT_SETTINGS } from '../shared/protocol.ts';
import type {
  FrontDeskReadOnly,
  FrontDeskSetting,
  FrontDeskSettingKey,
  FrontDeskSettingSource,
  FrontDeskSettingValue,
  FrontDeskSource,
  FrontDeskState,
  HostToWebview,
  SettingsTarget,
  SettingsUiKey,
  ThemeActionKind,
  ThemeSkillStatus,
  WebviewToHost,
} from '../shared/protocol.ts';
import { starterThemeObject } from '../shared/themeStarter.ts';
import { THEME_LIMITS } from '../shared/theme.ts';
import type { OfficeTheme } from '../shared/theme.ts';
import { PRESETS, findPreset, presetSetting, resolveThemeSource, shortenHome } from './themeSource.ts';
import type { ThemeSource } from './themeSource.ts';
import { checkWriteGuards, existingSchemaRef, revisionOf, serializeTheme, writeAtomic } from './themeWriter.ts';
import type { GuardResult, ThemeWriterDeps } from './themeWriter.ts';
import type { ThemeLoadResult } from './themeLoader.ts';
import { defaultThemesDir, settingValueFor } from './userThemes.ts';
import type { UserThemes } from './userThemes.ts';
import type { ThemeSkill } from './themeSkill.ts';
import { themePromptPaths, themePromptText } from './themePrompt.ts';

/** The shape of `WorkspaceConfiguration.inspect(key)`; only the four values the Front desk needs. */
export interface ConfigInspect {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** File access: the atomic-write functions plus a read, an existence check and `mkdir -p`. Reads reject with Node-style `code`s. */
export interface FrontDeskFs extends ThemeWriterDeps {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Create a folder and its parents; no error when it exists. */
  mkdir(path: string): Promise<void>;
}

/** The part of `UserThemes` the Front desk uses (the themes folder lister, `userThemes.ts`). */
export type FrontDeskUserThemes = Pick<UserThemes, 'rescan' | 'entries' | 'has' | 'truncated'>;
/** The part of `ThemeSkill` the Front desk uses (the skill installer, `themeSkill.ts`). */
export type FrontDeskSkill = Pick<ThemeSkill, 'status' | 'install' | 'remove'>;

export interface FrontDeskDeps {
  /** `inspect` of `claudeOffice.<key>` (key without the prefix). Undefined when the setting is not registered. */
  inspect(key: string): ConfigInspect | undefined;
  /** Write `claudeOffice.<key>` to the USER (global) settings. `undefined` removes the user value. */
  updateGlobal(key: string, value: string | boolean | undefined): Promise<void>;
  /** Post a message to the webview (the office view). */
  post(msg: HostToWebview): void;
  /** Post the usual `settings` message (settings plus theme). */
  postSettings(): void;

  // The theme watcher hand-off (the watcher and its latest result live in extension.ts / task 2.12).
  /** Re-read `claudeOffice.themeFile` into the watcher (`syncThemePath`). Must be safe to call when nothing changed. */
  applyThemePath(): void;
  /** `ThemeWatcher.reloadNow()`. Resolves after the new result was delivered (so `lastLoad()` is up to date). */
  reloadNow(): Promise<void>;
  /** The newest load result delivered by the watcher. Used only when its `path` equals the current source's path. */
  lastLoad(): ThemeLoadResult | undefined;
  /** The theme the office currently shows (the latest load, or the last good one while the file is broken). */
  currentTheme(): OfficeTheme | undefined;

  fs: FrontDeskFs;
  homeDir(): string;
  /** Base for a relative `themeFile` (first workspace folder), or undefined for the home folder. */
  baseDir(): string | undefined;
  /** The packaged preset folder, `<extension>/media/themes`. */
  presetDir(): string;
  /** The extension's own folder: the "Copy a prompt" text points Claude at the schema and guide inside it. */
  extensionPath(): string;
  /** The skill's folder, `<claude home>/skills/middle-management-theme` (absolute; the panel shows it with `~`). */
  skillDir(): string;

  /** The themes folder lister. The folder itself is `defaultThemesDir(homeDir())`. */
  userThemes: FrontDeskUserThemes;
  /** The "Teach Claude" skill installer. */
  skill: FrontDeskSkill;

  /** Save dialog. Resolves the chosen absolute path, or undefined when dismissed. */
  showSaveDialog(opts: { title: string; defaultPath: string }): Promise<string | undefined>;
  /** Open dialog for one `.json` file. Resolves the chosen absolute path, or undefined when dismissed. */
  showOpenDialog(opts: { title: string; defaultPath: string }): Promise<string | undefined>;
  /** Ask whether to overwrite an existing file (modal). */
  confirmOverwrite(path: string): Promise<boolean>;
  /** Open a file in an editor tab. */
  openFile(path: string): Promise<void>;
  /** Open the Settings editor on `claudeOffice.<key>`, in the user or workspace tab. */
  openSettingsUi(key: SettingsUiKey, target: SettingsTarget): Promise<void>;
  /** Show a folder in the OS file manager. Resolves false (or rejects) when that is not possible, for example on a remote host. */
  openFolder(dir: string): Promise<boolean>;
  /** Put text on the clipboard. */
  writeClipboard(text: string): Promise<void>;

  log(line: string): void;
}

export interface FrontDesk {
  /** True for the six messages this module answers plus `openSettingsUi`: route them here before the demo guard. */
  handles(msg: WebviewToHost): boolean;
  /** Handle one message. Never rejects: every failure becomes a `frontDeskDone{ok:false}` (or a log line for `openSettingsUi`). */
  handle(msg: WebviewToHost): Promise<void>;
  /** The state as the panel shows it now. */
  buildState(): FrontDeskState;
  /** Post `frontDesk` with no `reqId` (a push): call it when the theme file or a setting changed. */
  pushState(): void;
  /** Re-check the skill folder and push the state when its status changed. Never rejects. */
  refreshSkill(): Promise<void>;
}

const MESSAGE_TYPES = new Set(['getFrontDesk', 'themeAction', 'setSetting', 'saveTheme', 'saveThemeAs', 'openSettingsUi']);

/** The package.json defaults, used only when `inspect` knows no default (an unregistered setting). */
const FALLBACK_DEFAULTS: Record<FrontDeskSettingKey, FrontDeskSettingValue> = {
  mode: 'manager',
  companyName: 'Middle Management',
  branchName: 'Riverside Branch',
  managerName: 'You',
  speechBubbles: true,
  bossQuotes: true,
  scope: 'workspace',
  usageChecks: 'auto',
  updateChecks: 'auto',
};

const SAVE_TITLE = 'Save Middle Management theme file';
const CREATE_FILE_NAME = 'my-office.theme.json';
const THEME_NOT_FOUND = "That theme isn't in your themes folder any more.";

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

function errCode(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

function isMissingCode(e: unknown): boolean {
  return errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR';
}

/** A log-safe description of an error: its name and code, never its message (which usually holds a path). */
function errTag(e: unknown): string {
  const code = errCode(e);
  const name = e instanceof Error ? e.name : typeof e;
  return typeof code === 'string' ? `${name}/${code}` : name;
}

/** A value of the right type for `key`, or undefined when it is not one (so a bad stored value counts as unset). */
function coerceSetting(key: FrontDeskSettingKey, v: unknown): FrontDeskSettingValue | undefined {
  if ((FRONT_DESK_TEXT_SETTINGS as readonly string[]).includes(key)) return typeof v === 'string' ? v : undefined;
  if ((FRONT_DESK_BOOLEAN_SETTINGS as readonly string[]).includes(key)) return typeof v === 'boolean' ? v : undefined;
  const allowed = (FRONT_DESK_ENUM_VALUES as Partial<Record<FrontDeskSettingKey, readonly string[]>>)[key];
  return typeof v === 'string' && allowed !== undefined && allowed.includes(v) ? v : undefined;
}

function themeValueFor(key: FrontDeskSettingKey, theme: OfficeTheme | undefined): string | undefined {
  if (theme === undefined) return undefined;
  const v = key === 'companyName' ? theme.company : key === 'branchName' ? theme.branch : key === 'managerName' ? theme.manager?.name : undefined;
  return typeof v === 'string' ? v : undefined;
}

export function createFrontDesk(deps: FrontDeskDeps): FrontDesk {
  // ---------------------------------------------------------------------------------------------------------------
  // State

  /** The `themeFile` value in force and whether it is set at workspace (or folder) scope. */
  function themeSetting(): { setting: string; fromWorkspace: boolean } {
    const i = deps.inspect('themeFile');
    const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const wsRaw = i?.workspaceFolderValue !== undefined ? i.workspaceFolderValue : i?.workspaceValue;
    const setting = pick(wsRaw) ?? pick(i?.globalValue) ?? pick(i?.defaultValue) ?? '';
    return { setting, fromWorkspace: wsRaw !== undefined && setting.trim() !== '' };
  }

  /** The themes folder (absolute): where Claude saves the offices it makes and where the save dialogs start. */
  function themesDir(): string {
    return defaultThemesDir(deps.homeDir());
  }

  /** The skill status as last checked. `refreshSkill` updates it; `buildState` must stay synchronous. */
  let skillStatus: ThemeSkillStatus = 'unknown';

  /** Check the skill folder now. Resolves true when the status changed. `ThemeSkill.status` never throws; this guards a fake. */
  async function refreshSkillStatus(): Promise<boolean> {
    const before = skillStatus;
    try {
      skillStatus = await deps.skill.status();
    } catch (e) {
      deps.log(`frontDesk skill status failed ${errTag(e)}`);
    }
    return skillStatus !== before;
  }

  function currentSource(): { source: ThemeSource; setting: string; fromWorkspace: boolean } {
    const t = themeSetting();
    const source = resolveThemeSource(t.setting, deps.homeDir(), deps.baseDir(), deps.presetDir());
    return { source, ...t };
  }

  function settingState(key: FrontDeskSettingKey, theme: OfficeTheme | undefined): FrontDeskSetting {
    const i = deps.inspect(key);
    const ws = coerceSetting(key, i?.workspaceFolderValue) ?? coerceSetting(key, i?.workspaceValue);
    const user = coerceSetting(key, i?.globalValue);
    const def = coerceSetting(key, i?.defaultValue) ?? FALLBACK_DEFAULTS[key];
    const source: FrontDeskSettingSource = ws !== undefined ? 'workspace' : user !== undefined ? 'user' : 'default';
    const out: FrontDeskSetting = { value: ws ?? user ?? def, source, workspaceWins: ws !== undefined };
    if (user !== undefined) out.userValue = user;
    const tv = themeValueFor(key, theme);
    if (tv !== undefined) out.themeValue = tv;
    return out;
  }

  /**
   * `fresh` overrides what the last load says with a fresh read of the file: used when a save found the file changed
   * (`rev` is the file's current revision) or gone (`rev` undefined).
   */
  function stateWith(fresh?: { rev: string | undefined }): FrontDeskState {
    const { source: src, fromWorkspace } = currentSource();
    const theme = deps.currentTheme();
    const load = src.path !== '' && deps.lastLoad()?.path === src.path ? deps.lastLoad() : undefined;
    const source: FrontDeskSource = {
      kind: src.kind,
      label: src.label,
      fromWorkspace,
      exists: true,
      editable: false,
      errors: [],
      usingLastGood: false,
    };
    if (src.kind === 'preset') source.presetId = src.presetId;
    if (src.kind !== 'builtin') source.path = src.displayPath;

    // Problems: the loader's, with the full path shown the short way; a builtin fallback explains itself.
    const raw: string[] = src.kind === 'builtin' ? (src.error !== undefined ? [src.error] : []) : (load?.errors ?? []);
    source.errors = raw.slice(0, LIMITS.themeErrors).map((e) => clip(src.path !== '' ? e.split(src.path).join(src.displayPath) : e, LIMITS.themeErrorChars));

    if (src.kind === 'file') {
      let exists = true;
      let rev = load?.rev;
      let jsonObject = load?.jsonObject ?? true;
      if (fresh !== undefined) {
        rev = fresh.rev;
        exists = fresh.rev !== undefined;
        jsonObject = true;
      } else if (load !== undefined && load.rev === undefined && !load.jsonObject) {
        // An unreadable file is still "there"; only ENOENT/ENOTDIR counts as missing.
        exists = !load.missing;
      }
      source.exists = exists;
      if (rev !== undefined) source.rev = rev;
      if (fresh === undefined && load?.text !== undefined && load.text.length <= LIMITS.themeJsonChars) source.rawText = load.text;
      source.usingLastGood = fresh === undefined && load !== undefined && load.theme === undefined && load.errors.length > 0 && theme !== undefined;
      let readOnly: FrontDeskReadOnly | undefined;
      if (!/\.json$/i.test(src.path)) readOnly = 'notJson';
      else if (fromWorkspace) readOnly = 'workspace';
      else if (!exists) readOnly = 'missing';
      else if (!jsonObject) readOnly = 'notObject';
      if (readOnly !== undefined) source.readOnly = readOnly;
      // A file that is not a JSON object is never overwritten (readOnly 'notObject').
      source.editable = readOnly === undefined;
    } else {
      source.readOnly = src.kind;
    }

    const settings = {} as Record<FrontDeskSettingKey, FrontDeskSetting>;
    for (const key of FRONT_DESK_SETTINGS) settings[key] = settingState(key, src.kind === 'builtin' ? undefined : theme);
    const home = deps.homeDir();
    return {
      source,
      presets: PRESETS.slice(0, LIMITS.presets).map((p) => ({ id: p.id, label: p.label, description: p.description })),
      userThemes: deps.userThemes.entries(src.kind === 'file' ? src.path : undefined),
      userThemesTruncated: deps.userThemes.truncated,
      make: {
        themesFolder: clip(shortenHome(themesDir(), home), LIMITS.pathChars),
        skillFolder: clip(shortenHome(deps.skillDir(), home), LIMITS.pathChars),
        skill: skillStatus,
      },
      settings,
    };
  }

  function buildState(): FrontDeskState {
    return stateWith();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Replies

  function postState(reqId: string | undefined, state: FrontDeskState): void {
    deps.post(reqId === undefined ? { type: 'frontDesk', state } : { type: 'frontDesk', state, reqId });
  }

  function done(reqId: string, ok: boolean, extra?: { message?: string; conflict?: boolean; cancelled?: boolean }): void {
    const msg: HostToWebview = { type: 'frontDeskDone', reqId, ok };
    if (extra?.message !== undefined) msg.message = clip(extra.message, LIMITS.errorChars);
    if (extra?.conflict === true) msg.conflict = true;
    if (extra?.cancelled === true) msg.cancelled = true;
    deps.post(msg);
  }

  function fail(reqId: string, message: string): void {
    done(reqId, false, { message });
  }

  /** State then a plain success, for a call that changed the source or only reads. */
  function replyState(reqId: string, message?: string): void {
    postState(reqId, buildState());
    done(reqId, true, message !== undefined ? { message } : undefined);
  }

  // One save at a time: the fresh read, the guards and the write must not interleave with another save.
  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Helpers shared by the handlers

  function hasJsonExt(p: string): boolean {
    return /\.json$/i.test(p);
  }

  async function setThemeSetting(value: string | undefined): Promise<void> {
    await deps.updateGlobal('themeFile', value);
    deps.applyThemePath();
    await deps.reloadNow();
  }

  /** Why Choose and Back to built-in are refused: they write the user setting, which the workspace value hides. */
  const WORKSPACE_THEME_REFUSAL = 'This workspace sets the theme file, so a change here would have no effect. Change it in the workspace settings.';

  /** The note shown when a workspace `themeFile` hides the user's change. */
  function workspaceNote(): string | undefined {
    return themeSetting().fromWorkspace ? 'This workspace sets its own theme file, so your choice is saved but not used here.' : undefined;
  }

  type Pick = { path: string } | { reply: 'cancelled' } | { reply: 'refused'; message: string };

  /** Save dialog, `.json` check and overwrite confirmation, for a file the host is about to create. */
  async function pickNewFile(title: string, defaultPath: string): Promise<Pick> {
    const path = await deps.showSaveDialog({ title, defaultPath });
    if (path === undefined || path === '') return { reply: 'cancelled' };
    if (!hasJsonExt(path)) return { reply: 'refused', message: 'A theme file must have a name ending in .json.' };
    return { path };
  }

  /** Where a save dialog for a new theme starts: the themes folder (created first, errors ignored), so the file shows up in "Your offices". */
  async function themesDialogPath(name: string): Promise<string> {
    const dir = themesDir();
    try {
      await deps.fs.mkdir(dir);
    } catch (e) {
      deps.log(`frontDesk themes folder create failed ${errTag(e)}`);
    }
    return joinPath(dir, name);
  }

  /** Write `text` to a file the user just chose, switch the user setting to it and reload. */
  async function writeNewThemeFile(reqId: string, path: string, text: string, overwriteAsked: boolean): Promise<boolean> {
    if (!overwriteAsked && (await deps.fs.exists(path))) {
      if (!(await deps.confirmOverwrite(path))) {
        done(reqId, true, { cancelled: true });
        return false;
      }
    }
    const w = await locked(() => writeAtomic(path, text, deps.fs));
    if (!w.ok) {
      deps.log(`frontDesk req=${reqId} write failed`);
      fail(reqId, 'Could not write the theme file. Check that the folder exists and can be written to.');
      return false;
    }
    await setThemeSetting(path);
    await deps.userThemes.rescan(); // a file saved into the themes folder joins "Your offices" at once
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Handlers

  async function onGet(reqId: string): Promise<void> {
    deps.log(`getFrontDesk req=${reqId}`);
    await Promise.all([deps.userThemes.rescan(), refreshSkillStatus()]);
    replyState(reqId);
  }

  async function onThemeAction(reqId: string, action: ThemeActionKind, presetId: string | undefined, themeId: string | undefined): Promise<void> {
    deps.log(`themeAction req=${reqId} action=${action}`);
    switch (action) {
      case 'reload': {
        deps.applyThemePath();
        await deps.reloadNow();
        return replyState(reqId);
      }
      case 'open': {
        const { source } = currentSource();
        if (source.kind === 'builtin') return fail(reqId, 'The built-in office has no theme file to open.');
        try {
          await deps.openFile(source.path);
        } catch (e) {
          deps.log(`themeAction req=${reqId} open failed ${errTag(e)}`);
          return fail(reqId, 'Could not open the theme file.');
        }
        return replyState(reqId);
      }
      case 'useBuiltin': {
        if (themeSetting().fromWorkspace) return fail(reqId, WORKSPACE_THEME_REFUSAL);
        await setThemeSetting(undefined);
        return replyState(reqId, workspaceNote());
      }
      case 'usePreset': {
        const preset = presetId !== undefined ? findPreset(presetId) : undefined;
        if (preset === undefined) return fail(reqId, 'That example office is not available.');
        await setThemeSetting(presetSetting(preset.id));
        return replyState(reqId, workspaceNote());
      }
      case 'choose': {
        if (themeSetting().fromWorkspace) return fail(reqId, WORKSPACE_THEME_REFUSAL);
        const picked = await deps.showOpenDialog({ title: 'Choose a Middle Management theme file', defaultPath: deps.homeDir() });
        if (picked === undefined || picked === '') return done(reqId, true, { cancelled: true });
        await setThemeSetting(picked);
        return replyState(reqId, workspaceNote());
      }
      case 'create': {
        const p = await pickNewFile('Create Middle Management theme file', await themesDialogPath(CREATE_FILE_NAME));
        if ('reply' in p) return p.reply === 'cancelled' ? done(reqId, true, { cancelled: true }) : fail(reqId, p.message);
        const starter = serializeTheme(starterThemeObject());
        if (!starter.ok) return fail(reqId, 'The starter theme could not be built.');
        if (!(await writeNewThemeFile(reqId, p.path, starter.text, false))) return;
        try {
          await deps.openFile(p.path);
        } catch (e) {
          deps.log(`themeAction req=${reqId} open failed ${errTag(e)}`);
        }
        return replyState(reqId, workspaceNote());
      }
      case 'copyPreset': {
        const preset = presetId !== undefined ? findPreset(presetId) : undefined;
        if (preset === undefined) return fail(reqId, 'That example office is not available.');
        let text: string;
        try {
          const raw: unknown = JSON.parse(await deps.fs.readFile(joinPath(deps.presetDir(), preset.file)));
          // The copy is the user's own office, so it carries its own name (`name` is the first key `serializeTheme` writes).
          const named = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw, name: copyName(preset.label) } : raw;
          const s = serializeTheme(named);
          if (!s.ok) return fail(reqId, 'The example office could not be read.');
          text = s.text;
        } catch (e) {
          deps.log(`themeAction req=${reqId} preset read failed ${errTag(e)}`);
          return fail(reqId, 'The example office could not be read.');
        }
        const p = await pickNewFile('Save a copy of the example office', await themesDialogPath(`${preset.id}-copy.theme.json`));
        if ('reply' in p) return p.reply === 'cancelled' ? done(reqId, true, { cancelled: true }) : fail(reqId, p.message);
        if (!(await writeNewThemeFile(reqId, p.path, text, false))) return;
        return replyState(reqId, workspaceNote());
      }
      case 'useUserTheme': {
        if (themeSetting().fromWorkspace) return fail(reqId, WORKSPACE_THEME_REFUSAL);
        // The webview sends a file name only; it must be one the latest scan found. Scan again first: the folder may have changed.
        await deps.userThemes.rescan();
        if (themeId === undefined || !deps.userThemes.has(themeId)) return fail(reqId, THEME_NOT_FOUND);
        await setThemeSetting(settingValueFor(themeId));
        return replyState(reqId, workspaceNote());
      }
      case 'openThemesFolder': {
        const dir = themesDir();
        const shown = shortenHome(dir, deps.homeDir());
        let opened = false;
        try {
          await deps.fs.mkdir(dir);
          opened = await deps.openFolder(dir);
        } catch (e) {
          deps.log(`themeAction req=${reqId} open folder failed ${errTag(e)}`);
        }
        return opened ? done(reqId, true) : fail(reqId, `Could not open the folder. You can find your themes in ${shown}.`);
      }
      case 'installSkill':
      case 'removeSkill': {
        const r = action === 'installSkill' ? await deps.skill.install() : await deps.skill.remove();
        await refreshSkillStatus();
        if (r.ok) return replyState(reqId);
        deps.log(`themeAction req=${reqId} ${action} refused`);
        postState(reqId, buildState()); // the status may have changed under the panel (a folder that is not ours, say)
        return fail(reqId, r.message);
      }
      case 'copyPrompt': {
        const text = themePromptText({ themesDir: themesDir(), ...themePromptPaths(deps.extensionPath()) });
        try {
          await deps.writeClipboard(text);
        } catch (e) {
          deps.log(`themeAction req=${reqId} clipboard failed ${errTag(e)}`);
          return fail(reqId, 'Could not copy the prompt to the clipboard.');
        }
        return done(reqId, true);
      }
    }
  }

  /** The name a copied example office gets, cut so that `parseTheme` still accepts it. */
  function copyName(label: string): string {
    const suffix = ' (my copy)';
    return clip(label, THEME_LIMITS.name - suffix.length).trimEnd() + suffix;
  }

  function joinPath(dir: string, file: string): string {
    return dir.endsWith('/') || dir.endsWith('\\') ? dir + file : `${dir}/${file}`;
  }

  async function onSetSetting(reqId: string, key: FrontDeskSettingKey, value: string | boolean | null): Promise<void> {
    const len = typeof value === 'string' ? value.length : 0;
    deps.log(`setSetting req=${reqId} key=${String(key)} len=${len}`);
    if (!(FRONT_DESK_SETTINGS as readonly string[]).includes(key)) return fail(reqId, 'That setting cannot be changed here.');
    let toWrite: string | boolean | undefined;
    if (value === null) toWrite = undefined;
    else {
      const v = coerceSetting(key, typeof value === 'string' && (FRONT_DESK_TEXT_SETTINGS as readonly string[]).includes(key) ? value.trim() : value);
      if (v === undefined) return fail(reqId, 'That value is not allowed for this setting.');
      if (typeof v === 'string' && (FRONT_DESK_TEXT_SETTINGS as readonly string[]).includes(key) && v.length > LIMITS.settingChars) {
        return fail(reqId, `That text is too long (at most ${LIMITS.settingChars} characters).`);
      }
      // An empty company or manager name means "use the default". An empty branch name is a real value: a one-line sign.
      toWrite = v === '' && (key === 'companyName' || key === 'managerName') ? undefined : v;
    }
    try {
      await deps.updateGlobal(key, toWrite);
    } catch (e) {
      deps.log(`setSetting req=${reqId} key=${key} write failed ${errTag(e)}`);
      return fail(reqId, 'Could not save the setting.');
    }
    deps.postSettings();
    replyState(reqId);
  }

  /** Guards on the configured path and on the real one, so a symlink cannot point a save at a non-.json file. */
  function guard(base: Omit<Parameters<typeof checkWriteGuards>[0], 'path'>, configured: string, real: string): GuardResult {
    const a = checkWriteGuards({ ...base, path: configured });
    if (!a.ok) return a;
    return checkWriteGuards({ ...base, path: real });
  }

  async function onSaveTheme(reqId: string, rev: string, themeJson: string, force: boolean): Promise<void> {
    deps.log(`saveTheme req=${reqId} chars=${themeJson.length}${force ? ' force' : ''}`);
    return locked(async () => {
      if (themeJson.length > LIMITS.themeJsonChars) return fail(reqId, 'The theme is too large to save.');
      let content: unknown;
      try {
        content = JSON.parse(themeJson);
      } catch {
        return fail(reqId, 'The theme could not be read, so nothing was saved.');
      }
      const { source, fromWorkspace } = currentSource();
      const path = source.path;

      // A fresh read and the real path. Only a file source has either.
      let freshText: string | undefined;
      let realPath = path;
      if (source.kind === 'file') {
        try {
          freshText = await deps.fs.readFile(path);
        } catch (e) {
          if (!isMissingCode(e)) {
            deps.log(`saveTheme req=${reqId} read failed ${errTag(e)}`);
            return fail(reqId, 'Could not read the theme file to check it, so nothing was saved.');
          }
        }
        try {
          realPath = await deps.fs.realpath(path);
        } catch (e) {
          if (!isMissingCode(e)) {
            deps.log(`saveTheme req=${reqId} realpath failed ${errTag(e)}`);
            return fail(reqId, 'Could not resolve the theme file, so nothing was saved.');
          }
        }
      }
      const currentRev = freshText === undefined ? undefined : revisionOf(freshText);
      const load = deps.lastLoad();
      const g = guard(
        {
          sourceKind: source.kind,
          lastLoadWasObject: source.kind === 'file' && load?.path === path && load.jsonObject,
          fromWorkspace,
          content,
          rev,
          currentRev,
          force,
        },
        path,
        realPath,
      );
      if (!g.ok) {
        deps.log(`saveTheme req=${reqId} refused ${g.reason}`);
        if (g.reason === 'conflict' || g.reason === 'missing') {
          postState(reqId, stateWith({ rev: currentRev }));
          return done(reqId, false, { message: g.message, conflict: true });
        }
        return fail(reqId, g.message);
      }

      const schemaRef = freshText !== undefined ? existingSchemaRef(freshText) : undefined;
      const s = serializeTheme(content, schemaRef);
      if (!s.ok) return fail(reqId, `The theme has ${s.errors.length} problem(s), so it was not saved: ${s.errors[0] ?? ''}`);
      const w = await writeAtomic(path, s.text, deps.fs);
      if (!w.ok) {
        deps.log(`saveTheme req=${reqId} write failed`);
        return fail(reqId, 'Could not write the theme file. Check that it can be written to.');
      }
      deps.log(`saveTheme req=${reqId} saved chars=${s.text.length}`);
      await deps.reloadNow();
      deps.postSettings();
      postState(reqId, buildState());
      done(reqId, true);
    });
  }

  async function onSaveThemeAs(reqId: string, themeJson: string): Promise<void> {
    deps.log(`saveThemeAs req=${reqId} chars=${themeJson.length}`);
    if (themeJson.length > LIMITS.themeJsonChars) return fail(reqId, 'The theme is too large to save.');
    let content: unknown;
    try {
      content = JSON.parse(themeJson);
    } catch {
      return fail(reqId, 'The theme could not be read, so nothing was saved.');
    }
    const s = serializeTheme(content);
    if (!s.ok) return fail(reqId, `The theme has ${s.errors.length} problem(s), so it was not saved: ${s.errors[0] ?? ''}`);
    // Start in the themes folder, with the current file's name when there is one, so the copy joins "Your offices".
    const { source } = currentSource();
    const current = source.kind === 'file' ? (source.path.split(/[\\/]/).pop() ?? '') : '';
    const p = await pickNewFile(SAVE_TITLE, await themesDialogPath(hasJsonExt(current) ? current : CREATE_FILE_NAME));
    if ('reply' in p) return p.reply === 'cancelled' ? done(reqId, true, { cancelled: true }) : fail(reqId, p.message);
    // The Save dialog already asked before replacing an existing file, so there is no second question here.
    if (!(await writeNewThemeFile(reqId, p.path, s.text, true))) return;
    deps.postSettings();
    replyState(reqId, workspaceNote());
  }

  async function onOpenSettingsUi(key: SettingsUiKey, target: SettingsTarget): Promise<void> {
    deps.log(`openSettingsUi key=${String(key)} target=${target}`);
    if (key !== 'themeFile' && !(FRONT_DESK_SETTINGS as readonly string[]).includes(key)) return;
    try {
      await deps.openSettingsUi(key, target);
    } catch (e) {
      deps.log(`openSettingsUi key=${key} failed ${errTag(e)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  return {
    handles: (msg) => MESSAGE_TYPES.has(msg.type),
    buildState,
    pushState: () => postState(undefined, buildState()),
    async refreshSkill() {
      try {
        if (await refreshSkillStatus()) postState(undefined, buildState());
      } catch (e) {
        deps.log(`frontDesk skill refresh failed ${errTag(e)}`);
      }
    },
    async handle(msg) {
      const reqId = 'reqId' in msg ? msg.reqId : undefined;
      try {
        switch (msg.type) {
          case 'getFrontDesk':
            return await onGet(msg.reqId);
          case 'themeAction':
            return await onThemeAction(msg.reqId, msg.action, msg.presetId, msg.themeId);
          case 'setSetting':
            return await onSetSetting(msg.reqId, msg.key, msg.value);
          case 'saveTheme':
            return await onSaveTheme(msg.reqId, msg.rev, msg.themeJson, msg.force === true);
          case 'saveThemeAs':
            return await onSaveThemeAs(msg.reqId, msg.themeJson);
          case 'openSettingsUi':
            return await onOpenSettingsUi(msg.key, msg.target);
          default:
            return;
        }
      } catch (e) {
        deps.log(`frontDesk ${msg.type} failed ${errTag(e)}`);
        if (reqId !== undefined) fail(reqId, 'Something went wrong. Nothing was changed.');
      }
    },
  };
}
