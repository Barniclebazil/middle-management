/** Activity-bar launcher: an icon that brings the bottom-panel office forward. */
import * as vscode from 'vscode';
import type { OfficeView } from './officeView.ts';
import { placeOnFirstOpen, placeOnTopNow } from './placement.ts';
import type { PlacementEnv } from './placement.ts';

const vscodeEnv: PlacementEnv = {
  getCommands: () => vscode.commands.getCommands(true),
  run: (command) => vscode.commands.executeCommand(command),
  info: (message) => void vscode.window.showInformationMessage(message),
};

/** Registers the launcher tree view and the `claudeOffice.show` command. */
export function registerLauncher(office: OfficeView, store: vscode.Memento): vscode.Disposable[] {
  /** Show and focus the office wherever it lives; never hides it. */
  const showOffice = (): void => {
    void placeOnFirstOpen(store, vscodeEnv); // once ever; no-op afterwards
    void vscode.commands.executeCommand('claudeOffice.office.focus');
  };

  // An empty tree makes the `viewsWelcome` content show instead of any rows.
  const provider: vscode.TreeDataProvider<never> = {
    getChildren: () => [],
    getTreeItem: () => {
      throw new Error('launcher tree is empty');
    },
  };
  const tree = vscode.window.createTreeView('claudeOffice.launcher', { treeDataProvider: provider });

  // Opening the launcher shows the office, then puts the side bar away again.
  const visibility = tree.onDidChangeVisibility((e) => {
    if (!e.visible) return;
    showOffice();
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
  });

  // First resolve of the panel view (without the launcher) shows up as the office becoming visible.
  const firstOpen = office.onDidChangeVisibility(() => {
    if (office.viewVisible()) void placeOnFirstOpen(store, vscodeEnv);
  });

  return [
    tree,
    visibility,
    firstOpen,
    vscode.commands.registerCommand('claudeOffice.show', showOffice),
    vscode.commands.registerCommand('claudeOffice.placeOnTop', () => placeOnTopNow(store, vscodeEnv)),
  ];
}
