/** One-time placement of the office (no `vscode` import, so it is unit-testable): move VS Code's panel to the top so the office sits above the editor. */
export const PLACED_KEY = 'claudeOffice.placedOnTop';
export const POSITION_TOP_COMMAND = 'workbench.action.positionPanelTop';
export const PLACED_MESSAGE =
  'Middle Management moved the panel to the top so the office sits above your editor. To move it back: right-click the panel title → Panel Position.';

export type PlacementAction = 'move' | 'skip' | 'mark-only';

/** Pure once-only decision: already done does nothing; no such command only records the flag; otherwise move. */
export function decidePlacement(alreadyPlaced: boolean, commandExists: boolean): PlacementAction {
  if (alreadyPlaced) return 'skip';
  return commandExists ? 'move' : 'mark-only';
}

/** The slice of `vscode.Memento` this module needs. */
export interface PlacementStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The slice of the vscode API this module needs, so tests can fake it. */
export interface PlacementEnv {
  getCommands(): PromiseLike<string[]>;
  run(command: string): PromiseLike<unknown>;
  info(message: string): void;
}

async function moveToTop(env: PlacementEnv): Promise<boolean> {
  if (!(await env.getCommands()).includes(POSITION_TOP_COMMAND)) return false;
  await env.run(POSITION_TOP_COMMAND);
  await env.run('claudeOffice.office.focus');
  return true;
}

/** Automatic first-open placement. Never throws. Returns what it did. */
export async function placeOnFirstOpen(store: PlacementStore, env: PlacementEnv): Promise<PlacementAction> {
  try {
    if (store.get(PLACED_KEY) === true) return 'skip';
    // Set the flag first: moving the panel re-resolves the view, which must not re-enter.
    await store.update(PLACED_KEY, true);
    const action = decidePlacement(false, (await env.getCommands()).includes(POSITION_TOP_COMMAND));
    if (action === 'move') {
      await moveToTop(env);
      env.info(PLACED_MESSAGE);
    }
    return action;
  } catch {
    return 'skip';
  }
}

/** The `claudeOffice.placeOnTop` command: always moves (ignores the flag) and reveals the office. Never throws. */
export async function placeOnTopNow(store: PlacementStore, env: PlacementEnv): Promise<boolean> {
  try {
    const moved = await moveToTop(env);
    if (!moved) await env.run('claudeOffice.office.focus');
    await store.update(PLACED_KEY, true);
    return moved;
  } catch {
    return false;
  }
}
