// Demo workers are not real sessions, so messages that act on sessions are answered with a friendly error.
// No `vscode` import.
import type { HostToWebview, WebviewToHost } from '../shared/protocol.ts';

export const DEMO_REFUSAL = "Demo workers can't take orders. Turn off demo mode to manage real sessions.";

/**
 * Messages that would act on, read, or open a real session (demo workers have no session behind them: no options to set,
 * no transcript to take a plan or a turn from, no case tab to open, no one to send home), and the Round B file room and catalog requests (the demo office has no real
 * folders or config, and they read the user's disk). Harmless and answered normally: `ready`, `closeCase`, `listProjects`,
 * `browseProject` and `refreshUsage` (account-wide plan usage, not tied to any worker; the service debounces it and the
 * probe uses no tokens).
 */
export function needsRealSession(msg: WebviewToHost): boolean {
  switch (msg.type) {
    case 'openCase':
    case 'openCaseTab':
    case 'sendHome':
    case 'newTask':
    case 'reply':
    case 'decide':
    case 'interrupt':
    case 'openInClaudeCode':
    case 'setSessionOptions':
    case 'getPlan':
    case 'getTurn':
    case 'getFileRoots':
    case 'listDir':
    case 'readFile':
    case 'openFile':
    case 'openDiff':
    case 'getCatalog':
    case 'openConfigFile':
      return true;
    default:
      return false;
  }
}

/** The error to send back for a message received in demo mode, or undefined when the message may go to the host. */
export function demoRefusal(msg: WebviewToHost): HostToWebview | undefined {
  if (!needsRealSession(msg)) return undefined;
  const err: Extract<HostToWebview, { type: 'error' }> = { type: 'error', message: DEMO_REFUSAL };
  // The worker the refusal concerns (v0.5), so a case tab or the drawer can tell the error is theirs.
  if (msg.type === 'openCase' || msg.type === 'openCaseTab' || msg.type === 'sendHome') err.agentId = msg.agentId;
  if (msg.type === 'newTask') err.nonce = msg.nonce;
  if (msg.type === 'reply' || msg.type === 'interrupt' || msg.type === 'openInClaudeCode') err.sessionId = msg.sessionId;
  if (msg.type === 'setSessionOptions') {
    err.nonce = msg.nonce;
    err.sessionId = msg.sessionId;
  }
  if (msg.type === 'getPlan' || msg.type === 'getTurn') err.reqId = msg.reqId;
  // The Round B requests with a reply carry their `reqId` back; openFile, openDiff and openConfigFile are fire and forget (a toast).
  if (msg.type === 'getFileRoots' || msg.type === 'listDir' || msg.type === 'readFile' || msg.type === 'getCatalog') err.reqId = msg.reqId;
  if (msg.type === 'decide') err.requestId = msg.requestId;
  return err;
}
