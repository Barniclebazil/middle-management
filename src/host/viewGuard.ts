// In view mode the office only shows the agents; every webview message except the allowlisted ones is answered with an error.
// No `vscode` import.
import type { HostToWebview, WebviewToHost } from '../shared/protocol.ts';
import { VIEW_MODE_ALLOWED } from '../shared/officeMode.ts';

export const VIEW_REFUSAL = 'The office is in view mode. Switch to manager mode to do this (Front desk → Settings → Office mode).';

/** True when view mode must not act on this message. */
export function viewModeRefuses(msg: WebviewToHost): boolean {
  return !VIEW_MODE_ALLOWED.has(msg.type);
}

/** The error to send back for a message received in view mode, or undefined when the message may go to the host. */
export function viewRefusal(msg: WebviewToHost): HostToWebview | undefined {
  if (!viewModeRefuses(msg)) return undefined;
  const err: Extract<HostToWebview, { type: 'error' }> = { type: 'error', message: VIEW_REFUSAL };
  // Echoes the ids the way demoRefusal does, so the asker can tell the error is theirs; view mode also refuses the
  // messages demo mode lets through (listProjects, browseProject carry no id), plus the Front desk requests.
  if (msg.type === 'openCase' || msg.type === 'openCaseTab' || msg.type === 'sendHome') err.agentId = msg.agentId;
  if (msg.type === 'newTask') err.nonce = msg.nonce;
  if (msg.type === 'reply' || msg.type === 'interrupt' || msg.type === 'openInClaudeCode') err.sessionId = msg.sessionId;
  if (msg.type === 'setSessionOptions') {
    err.nonce = msg.nonce;
    err.sessionId = msg.sessionId;
  }
  if (msg.type === 'getPlan' || msg.type === 'getTurn') err.reqId = msg.reqId;
  if (msg.type === 'getFileRoots' || msg.type === 'listDir' || msg.type === 'readFile' || msg.type === 'getCatalog') err.reqId = msg.reqId;
  if (
    msg.type === 'getFrontDesk' || msg.type === 'themeAction' || msg.type === 'setSetting' || msg.type === 'saveTheme' || msg.type === 'saveThemeAs'
  ) err.reqId = msg.reqId;
  if (msg.type === 'decide') err.requestId = msg.requestId;
  return err;
}
