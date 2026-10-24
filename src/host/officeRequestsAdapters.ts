// The vscode-facing half of the Round B request router: builds the real `OfficeRequestsDeps` (the editor, the git extension,
// the SDK catalog probe, the neutral probe folder) and owns the one `FileRoom` and the one probe of the extension.
// Everything with logic lives in `officeRequests.ts` and is tested without vscode.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildMcpItems } from '../claude/mcpConfig.ts';
import { claudeHome } from '../claude/paths.ts';
import { defaultQueryFn } from '../manager/index.ts';
import { createCatalogProbe } from '../manager/catalogProbe.ts';
import type { CatalogProbe } from '../manager/catalogProbe.ts';
import type { HostToWebview } from '../shared/protocol.ts';
import { besideOfficePanel } from './editorColumn.ts';
import { FileRoom } from './fileRoom.ts';
import { findBinaryNow } from './managerAdapters.ts';
import { createOfficeRequests } from './officeRequests.ts';
import type { CatalogProbeLike, GitDiffResult, OfficeRequests, PathKind } from './officeRequests.ts';

export interface OfficeRequestsHooks {
  /** Post to the office view (`office.post`). */
  post(msg: HostToWebview): void;
  isDemo(): boolean;
  /** `office.anyVisible()` at start; the extension calls `setVisible` on later changes. */
  visible: boolean;
  /** The column of the office's editor tab, or undefined when the office is the sidebar view (`office.panelColumn()`). */
  editorColumn(): number | undefined;
  log(line: string): void;
}

export interface OfficeRequestsWiring {
  requests: OfficeRequests;
  dispose(): void;
}

// The slice of the built-in git extension's API (v1) used for the diff. It ships as `vscode.git`; there are no typings to import.
interface GitChangeLike {
  uri: vscode.Uri;
  status: number;
}
interface GitRepositoryLike {
  state?: { workingTreeChanges?: GitChangeLike[]; indexChanges?: GitChangeLike[]; untrackedChanges?: GitChangeLike[] };
}
/** `Status` values of the git extension's API that mean "HEAD has no such file". */
const GIT_INDEX_ADDED = 1;
const GIT_UNTRACKED = 7;

/** True when the repository's cached state says the file is new (untracked, or added to the index and not yet committed). */
function notInHead(repo: GitRepositoryLike, realPath: string): boolean {
  const same = (c: GitChangeLike): boolean => c.uri.fsPath === realPath;
  const st = repo.state;
  if (st === undefined) return false;
  if (st.untrackedChanges?.some((c) => same(c) && c.status === GIT_UNTRACKED) === true) return true;
  if (st.workingTreeChanges?.some((c) => same(c) && c.status === GIT_UNTRACKED) === true) return true;
  return st.indexChanges?.some((c) => same(c) && c.status === GIT_INDEX_ADDED) === true;
}
interface GitApiLike {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepositoryLike | null;
}
interface GitExtensionLike {
  getAPI(version: 1): GitApiLike;
}

/** The editor's diff of a real path against HEAD, through the git extension (it runs git; this extension never does). */
async function openGitDiff(realPath: string, viewColumn: number | undefined): Promise<GitDiffResult> {
  const ext = vscode.extensions.getExtension<GitExtensionLike>('vscode.git');
  if (ext === undefined) return { ok: false, reason: 'noGit' };
  let api: GitApiLike;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    api = exports.getAPI(1);
  } catch {
    return { ok: false, reason: 'noGit' }; // the extension is switched off (`git.enabled`), or too old for API 1
  }
  const uri = vscode.Uri.file(realPath);
  const repo = api.getRepository(uri);
  if (repo === null || repo === undefined) return { ok: false, reason: 'noRepo' };
  if (notInHead(repo, realPath)) return { ok: false, reason: 'untracked' };
  await vscode.commands.executeCommand('vscode.diff', api.toGitUri(uri, 'HEAD'), uri, `${path.basename(realPath)} (HEAD)`, viewColumn === undefined ? undefined : { viewColumn });
  return { ok: true };
}

async function statKind(realPath: string): Promise<PathKind | undefined> {
  try {
    const st = await fsp.stat(realPath);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    return undefined;
  }
}

/**
 * The folder catalog probes run in when no trusted project applies: an empty folder this extension owns, so the probe never
 * looks at the home folder. Undefined when it cannot be made (the probe then falls back to the home folder).
 */
function makeNeutralCwd(context: vscode.ExtensionContext, log: (line: string) => void): string | undefined {
  const dir = path.join(context.globalStorageUri.fsPath, 'probe-cwd');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    log(`probe folder could not be made (${e instanceof Error ? e.name : 'error'})`);
    return undefined;
  }
}

/**
 * One catalog probe for the whole extension. The Claude binary is looked up per call (so a changed `claudePath` applies at
 * once); the probe, with its caches and single-flight tables, is rebuilt only when the binary's path changes. With no
 * binary the calls answer `failed` and the router falls back to the disk scan (the phone shows the offline list).
 */
function lazyProbe(neutralCwd: string | undefined, log: (line: string) => void): CatalogProbeLike & { dispose(): void } {
  let current: { binaryPath: string; probe: CatalogProbe } | undefined;
  const probeFor = (): CatalogProbe | undefined => {
    const found = findBinaryNow();
    if ('error' in found) return undefined;
    if (current?.binaryPath !== found.path) {
      current?.probe.clearCache();
      current = {
        binaryPath: found.path,
        probe: createCatalogProbe({ queryFn: defaultQueryFn, binaryPath: found.path, env: process.env, ...(neutralCwd === undefined ? {} : { neutralCwd }), log }),
      };
    }
    return current.probe;
  };
  return {
    probeCatalog: async (cwd, trust, opts) => {
      const probe = probeFor();
      return probe === undefined ? { status: 'failed', reason: 'Claude Code not found' } : probe.probeCatalog(cwd, trust, opts);
    },
    probeMcpStatus: async (cwd, trust, snapshot, onUpdate, opts) => {
      const probe = probeFor();
      if (probe !== undefined) return probe.probeMcpStatus(cwd, trust, snapshot, onUpdate, opts);
      return { ...buildMcpItems({ snapshot, trust }), settled: true, status: 'failed', reason: 'Claude Code not found' };
    },
    dispose: () => current?.probe.clearCache(),
  };
}

/** Build the file room, the probe and the router with the real editor behind them, and keep the roots in step with the workspace folders. */
export function createOfficeRequestsWiring(context: vscode.ExtensionContext, hooks: OfficeRequestsHooks): OfficeRequestsWiring {
  const room = new FileRoom({ claudeHome: claudeHome(), log: hooks.log });
  const neutral = makeNeutralCwd(context, hooks.log);
  const probe = lazyProbe(neutral, hooks.log);
  const requests = createOfficeRequests({
    room,
    post: hooks.post,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    workspaceTrusted: () => vscode.workspace.isTrusted,
    statKind,
    openInEditor: async (realPath) => {
      const viewColumn = besideOfficePanel(hooks.editorColumn(), vscode.ViewColumn.Beside);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(realPath)), viewColumn === undefined ? undefined : { viewColumn });
    },
    openGitDiff: (realPath) => openGitDiff(realPath, besideOfficePanel(hooks.editorColumn(), vscode.ViewColumn.Beside)),
    probe,
    neutralCwd: () => neutral ?? context.globalStorageUri.fsPath,
    isDemo: hooks.isDemo,
    visible: hooks.visible,
    log: hooks.log,
  });
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    requests.refreshRoots().catch(() => hooks.log('roots refresh failed'));
  });
  requests.refreshRoots().catch(() => hooks.log('roots refresh failed'));
  return {
    requests,
    dispose: () => {
      folders.dispose();
      requests.dispose();
      probe.dispose();
    },
  };
}
