// The vscode-facing half of Manager Mode wiring: builds the real `ManagerHostDeps` from the editor's APIs.
// Everything pure lives elsewhere (src/manager, src/host/*) and is unit-tested without vscode.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { readCaseFor } from '../manager/transcriptReader.ts';
import { createSdkItemBuilder, itemsFromSdkMessage } from '../manager/conversation.ts';
import { defaultQueryFn, findClaudeBinary, liveSessionIdsFromDisk, nodeFileExists, nodeIsExecutable } from '../manager/index.ts';
import type { FindBinaryResult, ManagerHostDeps } from '../manager/index.ts';
import { runUsageProbe } from '../manager/usageProbe.ts';
import type { ProbeResult } from '../manager/usageProbe.ts';
import type { SessionInfo } from '../claude/types.ts';
import { lastModelInTranscript, readTailText } from './lastModel.ts';
import { locateTranscript } from './transcriptLocator.ts';
import { checkClaudeVersions } from './versionCheck.ts';

/** The Claude Code extension's id, compared case-insensitively. */
const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

// Baked in by esbuild.mjs (`define`). Absent when running from source (tests, dev scripts).
declare const __SDK_VERSION__: string | undefined;
declare const __SDK_CLAUDE_CODE_VERSION__: string | undefined;

export interface AdapterOptions {
  post: ManagerHostDeps['post'];
  log: (msg: string) => void;
  /** The watcher's latest session set (for locating transcripts). */
  sessions: () => readonly SessionInfo[];
  /** Publish `agents` now. */
  refreshAgents: () => void;
  /** Where the learned context windows persist (the extension passes a shim over `globalState`). */
  storage?: ManagerHostDeps['storage'];
  /** Full text of a plan from the transcript model (the extension passes `AgentTracker.planText`, bound to the live tracker). */
  planText?: ManagerHostDeps['planText'];
  /** An office run reported rate-limit windows (the extension passes `UsageService.onRateLimit`). */
  onRateLimit?: ManagerHostDeps['onRateLimit'];
}

/** Look for the Claude binary right now, from the setting, the Claude Code extension, ~/.local/bin and PATH. */
export function findBinaryNow(): FindBinaryResult {
  const setting = vscode.workspace.getConfiguration('claudeOffice').get<string>('claudePath', '');
  const claudeCodeExtensionPaths = vscode.extensions.all
    .filter((e) => e.id.toLowerCase() === CLAUDE_CODE_EXTENSION_ID)
    .map((e) => e.extensionPath);
  return findClaudeBinary({
    settingPath: setting,
    claudeCodeExtensionPaths,
    homedir: os.homedir(),
    platform: process.platform,
    PATH: process.env['PATH'],
    exists: nodeFileExists,
    isExecutable: nodeIsExecutable,
  });
}

function statKind(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

export function managerHostDeps(o: AdapterOptions): ManagerHostDeps {
  return {
    post: o.post,
    queryFn: defaultQueryFn,
    findBinary: findBinaryNow,
    readCase: (agent) => readCaseFor(agent, (a) => locateTranscript(o.sessions(), a)),
    createSdkItemBuilder,
    itemsFromSdkMessage: (msg, builder) => itemsFromSdkMessage(msg, builder as ReturnType<typeof createSdkItemBuilder>),
    lastModelFor: async (sessionId) => {
      const file = locateTranscript(o.sessions(), { id: sessionId, kind: 'main', sessionId });
      return file === undefined ? undefined : lastModelInTranscript(await readTailText(file, 256 * 1024));
    },
    readTranscriptTail: async (sessionId) => {
      const file = locateTranscript(o.sessions(), { id: sessionId, kind: 'main', sessionId });
      return file === undefined ? undefined : readTailText(file, 256 * 1024);
    },
    listLiveSessionIds: () => liveSessionIdsFromDisk(),
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    showOpenDialog: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Choose project folder',
      });
      return picked?.[0]?.fsPath;
    },
    executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
    openUri: async (uri) => {
      // The host builds a `vscode://` link; use this editor's own scheme (vscodium, insiders, ...).
      const own = uri.replace(/^vscode:/, `${vscode.env.uriScheme}:`);
      return vscode.env.openExternal(vscode.Uri.parse(own));
    },
    exists: (p) => statKind(p) !== undefined,
    isDirectory: (p) => statKind(p)?.isDirectory() === true,
    refreshAgents: o.refreshAgents,
    ...(o.storage === undefined ? {} : { storage: o.storage }),
    ...(o.planText === undefined ? {} : { planText: o.planText }),
    ...(o.onRateLimit === undefined ? {} : { onRateLimit: o.onRateLimit }),
    log: o.log,
  };
}

/**
 * One usage probe with the real SDK: finds the Claude binary now (so a changed `claudePath` setting applies at once) and
 * runs `runUsageProbe` with the process environment, which is also what office runs inherit (so `CLAUDE_CONFIG_DIR`
 * means the same everywhere). Never throws or rejects; a missing binary is a `failed` result with a fixed phrase.
 */
export async function probeNow(log: (msg: string) => void): Promise<ProbeResult> {
  try {
    const found = findBinaryNow();
    if ('error' in found) return { status: 'failed', reason: 'Claude Code not found' };
    return await runUsageProbe({ queryFn: defaultQueryFn, binaryPath: found.path, env: process.env, log });
  } catch (e) {
    log(`usage probe: could not start (${e instanceof Error ? e.name : 'error'})`);
    return { status: 'failed', reason: 'could not start Claude Code' };
  }
}

/** Log-only: which Claude Code supplies the binary, and the version the bundled SDK expects. Never throws or blocks. */
export function logVersionSanity(log: (msg: string) => void): void {
  try {
    const found = findBinaryNow();
    const sdkVersion = typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : undefined;
    const sdkClaudeCodeVersion = typeof __SDK_CLAUDE_CODE_VERSION__ !== 'undefined' ? __SDK_CLAUDE_CODE_VERSION__ : undefined;
    if ('error' in found) {
      log(`Claude binary not found yet (${found.error.split('. Tried')[0]}). Agent SDK ${sdkVersion ?? 'unknown'} expects Claude Code ${sdkClaudeCodeVersion ?? 'unknown'}.`);
      return;
    }
    const res = checkClaudeVersions({
      source: found.source,
      binaryPath: found.path,
      sdkVersion,
      sdkClaudeCodeVersion,
      readFile: (p) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return undefined;
        }
      },
    });
    for (const line of res.lines) log(res.warn ? `WARNING: ${line}` : line);
  } catch (e) {
    log(`version check skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
