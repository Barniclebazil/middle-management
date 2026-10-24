// The office mode (`claudeOffice.mode`): manager (the full office) or view (the agents walking around, nothing else).
// No `vscode`, no DOM.
import type { WebviewToHost } from './protocol.ts';

export const OFFICE_MODES = ['manager', 'view'] as const;
export type OfficeMode = (typeof OFFICE_MODES)[number];
export const DEFAULT_OFFICE_MODE: OfficeMode = 'manager';

/** Exactly 'view' or 'manager'; anything else (undefined, '', 'View', numbers, objects) is 'manager'. Never throws. */
export function parseOfficeMode(raw: unknown): OfficeMode {
  return raw === 'view' ? 'view' : DEFAULT_OFFICE_MODE;
}

/**
 * Webview to host message types the host still answers in view mode (after the Front desk route). An allowlist: a message
 * type added later is refused until it is listed here. None starts Claude Code: `refreshUsage` is the usage probe, and
 * `closeCase` only releases state (switching to view mode closes every case tab, which sends a synthetic `closeCase` per tab,
 * and the manager host must still forget those cases). `updateAction` only checks for and installs a new extension version.
 */
export const VIEW_MODE_ALLOWED: ReadonlySet<WebviewToHost['type']> = new Set<WebviewToHost['type']>(['ready', 'refreshUsage', 'closeCase', 'updateAction']);
