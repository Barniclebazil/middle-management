// The real `vscode` and Node implementations of the Front desk's injected dependencies (see `frontDesk.ts`).
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostToWebview } from '../shared/protocol.ts';
import type { OfficeTheme } from '../shared/theme.ts';
import type { ThemeLoadResult } from './themeLoader.ts';
import { besideOfficePanel } from './editorColumn.ts';
import type { ConfigInspect, FrontDeskDeps, FrontDeskSkill, FrontDeskUserThemes } from './frontDesk.ts';

/** What the extension owns and the adapters cannot build: the office view, the theme watcher and its latest result. */
export interface FrontDeskHooks {
  /** Post to the office view (`office.post`). */
  post(msg: HostToWebview): void;
  /** Post the usual `settings` message (`postSettings`). */
  postSettings(): void;
  /** `syncThemePath`: re-read `claudeOffice.themeFile` into the watcher. */
  applyThemePath(): void;
  /** `themeWatcher.reloadNow()`. */
  reloadNow(): Promise<void>;
  /** The latest `ThemeLoadResult` the watcher delivered. */
  lastLoad(): ThemeLoadResult | undefined;
  /** The theme the office shows now (`currentTheme`). */
  currentTheme(): OfficeTheme | undefined;
  /** The themes folder lister (`UserThemes`). */
  userThemes: FrontDeskUserThemes;
  /** The "Teach Claude" skill installer (`ThemeSkill`). */
  skill: FrontDeskSkill;
  /** The skill's folder, `<claude home>/skills/middle-management-theme` (absolute). */
  skillDir: string;
  /** The column of the office's editor tab, or undefined when the office is the sidebar view (`office.panelColumn()`). */
  editorColumn(): number | undefined;
  log(line: string): void;
}

const JSON_FILTER = { 'Theme JSON': ['json'] };

export function createFrontDeskDeps(context: vscode.ExtensionContext, hooks: FrontDeskHooks): FrontDeskDeps {
  const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('claudeOffice');
  return {
    inspect: (key): ConfigInspect | undefined => cfg().inspect(key),
    updateGlobal: (key, value) => Promise.resolve(cfg().update(key, value, vscode.ConfigurationTarget.Global)),
    post: hooks.post,
    postSettings: hooks.postSettings,
    applyThemePath: hooks.applyThemePath,
    reloadNow: hooks.reloadNow,
    lastLoad: hooks.lastLoad,
    currentTheme: hooks.currentTheme,
    fs: {
      realpath: (p) => fs.realpath(p),
      writeFileExclusive: (p, data) => fs.writeFile(p, data, { flag: 'wx' }),
      rename: (a, b) => fs.rename(a, b),
      unlink: (p) => fs.unlink(p),
      mkdir: async (p) => void (await fs.mkdir(p, { recursive: true })),
      readFile: (p) => fs.readFile(p, 'utf8'),
      exists: async (p) => {
        try {
          await fs.stat(p);
          return true;
        } catch {
          return false;
        }
      },
    },
    homeDir: () => os.homedir(),
    // Relative theme paths resolve against the first workspace folder, else the home folder (as `syncThemePath` does).
    baseDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    presetDir: () => path.join(context.extensionPath, 'media', 'themes'),
    extensionPath: () => context.extensionPath,
    skillDir: () => hooks.skillDir,
    userThemes: hooks.userThemes,
    skill: hooks.skill,
    showSaveDialog: async ({ title, defaultPath }) => {
      const picked = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters: JSON_FILTER, title });
      return picked?.fsPath;
    },
    showOpenDialog: async ({ title, defaultPath }) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: vscode.Uri.file(defaultPath),
        filters: JSON_FILTER,
        openLabel: 'Choose theme file',
        title,
      });
      return picked?.[0]?.fsPath;
    },
    confirmOverwrite: async (file) => {
      const answer = await vscode.window.showWarningMessage(`${file} already exists. Overwrite it?`, { modal: true }, 'Overwrite');
      return answer === 'Overwrite';
    },
    openFile: async (file) => {
      const viewColumn = besideOfficePanel(hooks.editorColumn(), vscode.ViewColumn.Beside);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), viewColumn === undefined ? undefined : { viewColumn });
    },
    openSettingsUi: async (key, target) => {
      const query = `claudeOffice.${key}`;
      // The user tab is the default of `workbench.action.openSettings`; the workspace tab has its own command.
      if (target === 'workspace') await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', { query });
      else await vscode.commands.executeCommand('workbench.action.openSettings', query);
    },
    // `openExternal` with a file URI shows the folder in the OS file manager. It resolves false (or throws) where that cannot be
    // done, such as a remote window, and the Front desk then tells the user where the folder is.
    openFolder: async (dir) => vscode.env.openExternal(vscode.Uri.file(dir)),
    writeClipboard: async (text) => vscode.env.clipboard.writeText(text),
    log: hooks.log,
  };
}
