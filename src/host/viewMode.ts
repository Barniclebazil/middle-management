// The pure parts of switching between manager and view mode (`claudeOffice.mode`): which scope a toggle writes to, how many
// office-run workers a switch to view mode leaves running, and the words shown. No `vscode` import.
import type { OfficeMode } from '../shared/officeMode.ts';
import type { AgentSnapshot } from '../shared/protocol.ts';

/** Where a toggle writes: the scope that currently decides the value, so the new mode is not shadowed by an older, narrower one. */
export type ModeWriteTarget = 'workspaceFolder' | 'workspace' | 'global';

/** The two narrower scopes of `WorkspaceConfiguration.inspect('mode')`; a scope counts when its value is not undefined. */
export interface InspectedMode {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
}

export function modeWriteTarget(inspected: InspectedMode | undefined): ModeWriteTarget {
  if (inspected?.workspaceFolderValue !== undefined) return 'workspaceFolder';
  if (inspected?.workspaceValue !== undefined) return 'workspace';
  return 'global';
}

/** The other mode. */
export function toggled(mode: OfficeMode): OfficeMode {
  return mode === 'view' ? 'manager' : 'view';
}

/** How many of these workers were started from the office (`control === 'office'`). */
export function officeRunCount(agents: readonly Pick<AgentSnapshot, 'control'>[]): number {
  let n = 0;
  for (const a of agents) if (a.control === 'office') n++;
  return n;
}

/** The toast when the office enters view mode with `n` (at least 1) office-run workers still live. */
export function stillRunningMessage(n: number): string {
  const tasks = n === 1 ? '1 task you started' : `${n} tasks you started`;
  return `${tasks} from the office ${n === 1 ? 'is' : 'are'} still running. Switch back to manager mode to answer ${n === 1 ? 'it' : 'them'}.`;
}

/** The confirmation after the toggle command. */
export function modeChangedMessage(mode: OfficeMode): string {
  return `Middle Management is now in ${mode} mode.`;
}

/** The notice `claudeOffice.newTask` shows in view mode (instead of opening the memo). */
export const VIEW_MODE_NEW_TASK_MESSAGE = 'Middle Management is in view mode.';
