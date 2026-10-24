import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OfficeView } from './view/officeView.ts';
import { registerLauncher } from './view/officeLauncher.ts';
import { ClaudeWatcher } from './claude/sessions.ts';
import { claudeConfigJsonPath, claudeHome, claudeSettingsJsonPath } from './claude/paths.ts';
import { AgentTracker } from './model/agentState.ts';
import { DemoFeed } from './demo/demoFeed.ts';
import { OfficeFeed, resolveScope } from './host/officeFeed.ts';
import type { FeedScope } from './host/officeFeed.ts';
import { createManagerHost } from './manager/index.ts';
import type { ManagerHost } from './manager/index.ts';
import { routeWebviewMessage } from './host/messageRouter.ts';
import { CASE_TAB_REFUSALS } from './host/caseTabs.ts';
import { createReplyRouter } from './host/webviewSource.ts';
import { SentHome } from './host/sentHome.ts';
import { VIEW_MODE_NEW_TASK_MESSAGE, modeChangedMessage, modeWriteTarget, officeRunCount, stillRunningMessage, toggled } from './host/viewMode.ts';
import type { WebviewSource } from './host/webviewSource.ts';
import { logVersionSanity, managerHostDeps, probeNow } from './host/managerAdapters.ts';
import { UsageService } from './host/usageService.ts';
import type { UsageChecks } from './host/usageService.ts';
import { UpdateService } from './host/updateService.ts';
import { RELEASES_LATEST_URL, parseUpdateChecks } from './host/updateCheck.ts';
import { ClaudeDefaultsService } from './host/claudeDefaults.ts';
import { ThemeService } from './host/themeService.ts';
import { createFrontDesk } from './host/frontDesk.ts';
import type { FrontDesk } from './host/frontDesk.ts';
import { createFrontDeskDeps } from './host/frontDeskAdapters.ts';
import { UserThemes, defaultThemesDir } from './host/userThemes.ts';
import { SKILL_FOLDER_NAME, ThemeSkill, loadSkillSources } from './host/themeSkill.ts';
import type { SkillSources } from './host/themeSkill.ts';
import { createOfficeRequestsWiring } from './host/officeRequestsAdapters.ts';
import type { OfficeRequestsWiring } from './host/officeRequestsAdapters.ts';
import { FRONT_DESK_TABS } from './shared/protocol.ts';
import type { AgentSnapshot, FrontDeskTab, HostToWebview, OfficeSettings, WebviewToHost } from './shared/protocol.ts';
import { parseOfficeMode } from './shared/officeMode.ts';
import type { OfficeMode } from './shared/officeMode.ts';

/** The manager host, kept at module level so `deactivate` can stop every office run. */
let managerHost: ManagerHost | undefined;

/** `reqId` prefix of Front desk calls the extension makes itself (commands, the warning button). Their replies never reach the webview. */
const COMMAND_REQ = 'cmd:';

function readSettings(): OfficeSettings {
  const cfg = vscode.workspace.getConfiguration('claudeOffice');
  return {
    companyName: cfg.get<string>('companyName', 'Middle Management'),
    branchName: cfg.get<string>('branchName', 'Riverside Branch'),
    speechBubbles: cfg.get<boolean>('speechBubbles', true),
    managerName: cfg.get<string>('managerName', 'You'),
    bossQuotes: cfg.get<boolean>('bossQuotes', true),
  };
}

/** `claudeOffice.usageChecks`: anything but "off" means "auto". */
function readUsageChecks(): UsageChecks {
  return vscode.workspace.getConfiguration('claudeOffice').get<string>('usageChecks', 'auto') === 'off' ? 'off' : 'auto';
}

/** `claudeOffice.mode`: exactly "view" means view, anything else manager. */
function readMode(): OfficeMode {
  return parseOfficeMode(vscode.workspace.getConfiguration('claudeOffice').get('mode'));
}

function readScope(): FeedScope {
  const setting = vscode.workspace.getConfiguration('claudeOffice').get<string>('scope', 'workspace');
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return resolveScope(setting, folders);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Middle Management');
  const log = (msg: string): void => {
    try {
      output.appendLine(`[${new Date().toISOString()}] ${msg}`);
    } catch {
      // Logging must never throw.
    }
  };

  /** Run `fn`, logging a failure as its error name only (never its message, which could carry paths or account data). */
  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      log(`${what} failed (${e instanceof Error ? e.name : 'error'})`);
    }
  };
  const timers = { setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>) };

  // Construction order. `feed`, `office`, `host`, `usage` and the defaults service refer to each other (the tracker asks the host
  // about pending requests and live runs, the host asks the feed to publish and the usage service about rate limits, the view
  // hands messages to the host), so each is created in turn and the earlier ones reach the later ones lazily:
  //   1. host (storage, planText and onRateLimit are lazy lookups)  2. office view  3. feed (its tracker learns windows from the host)
  //   4. usage service and Claude defaults (post through the view)  5. listeners, visibility and the first posts.
  let feed!: OfficeFeed;
  let tracker: AgentTracker | undefined; // the live tracker (the feed makes a new one when the scope changes)
  let usage: UsageService | undefined;
  let updates: UpdateService | undefined;
  let fd: FrontDesk | undefined;
  let officeRequests: OfficeRequestsWiring | undefined; // the Round B file room and catalog router
  let sentHome: SentHome | undefined; // sending workers home (v0.5): the record, the filter, the auto timer
  const globalState = context.globalState;
  // The office mode, kept here only: the router, the office pages and the commands read it, the configuration listener updates it.
  let mode: OfficeMode = readMode();
  let latestAgents: AgentSnapshot[] = []; // the latest published snapshot, for counting the office-run workers on a switch to view
  // `postTo` (v0.5, task 8.3): the manager host sends case streams and replies to exactly the webviews that asked or have the
  // case open. It is added next to the adapter result so this file compiles before and after `ManagerHostDeps` declares it.
  const hostDeps = {
    ...managerHostDeps({
      post: (msg) => {
        if (msg.type === 'projects') officeRequests?.requests.setProjects(msg.projects); // folders the user browsed to become file room roots
        office.post(msg);
      },
      log,
      sessions: () => feed.latestSessions(),
      refreshAgents: () => feed.refreshNow(),
      storage: { get: (k) => globalState.get(k), set: (k, v) => globalState.update(k, v) },
      planText: (agentId, planId) => tracker?.planText(agentId, planId),
      onRateLimit: (windows) => usage?.onRateLimit(windows),
    }),
    postTo: (sources: readonly WebviewSource[], msg: HostToWebview): void => office.postTo(sources, msg),
  };
  const host = createManagerHost(hostDeps);
  managerHost = host;
  // The manager host takes the sender since task 8.3 (`handle(msg, source?)`); until then the extra argument is ignored.
  const hostHandle: (msg: WebviewToHost, source: WebviewSource) => Promise<void> = host.handle;
  // Replies of the Front desk and the file room go back to the webview that asked (by `reqId`); anything else is broadcast.
  const replies = createReplyRouter({ post: (m) => office.post(m), postTo: (s, m) => office.postTo(s, m) });

  const office = new OfficeView(context.extensionUri, {
    log,
    getMode: () => mode,
    // Closing an idle worker's tab sends them home; a busy worker only loses the tab. `byUser` is false for a host close.
    onCaseTabClosed: (agentId, info) => {
      if (info.byUser) guarded('tab close send home', () => sentHome?.onTabClosed(agentId));
    },
    onMessage: (msg, source) =>
      routeWebviewMessage(msg, source, {
        isDemo: () => feed.isDemo(),
        isViewMode: () => mode === 'view',
        post: (m) => office.post(m),
        postTo: (s, m) => office.postTo(s, m),
        replies,
        refreshUsage: () => void usage?.refresh(),
        updateAction: (action) => updates?.handle(action),
        handle: (m, s) => hostHandle(m, s),
        openCaseTab: (agentId, source, look) => {
          const result = office.openCaseTab(agentId, look);
          if (result === 'unknown' || result === 'full') office.postTo([source], { type: 'error', agentId, message: CASE_TAB_REFUSALS[result] });
        },
        sendHome: (agentId, source) => {
          const result = sentHome?.sendHome(agentId) ?? { ok: false as const, reason: 'The office is not ready yet.' };
          if (!result.ok) office.postTo([source], { type: 'error', agentId, message: result.reason });
        },
        ...(fd === undefined ? {} : { frontDesk: fd }),
        ...(officeRequests === undefined ? {} : { officeRequests: officeRequests.requests }),
      }),
  });
  const home = claudeHome();
  feed = new OfficeFeed({
    createWatcher: (scope) => new ClaudeWatcher({ claudeHome: home, scope }),
    createTracker: () => {
      tracker = new AgentTracker({
        officeInfo: (sid) => host.getOfficeInfo(sid),
        controlOf: (a) => host.controlFor(a),
        learnedWindows: host.contextWindows,
      });
      return tracker;
    },
    publish: (msg) => {
      office.post(msg);
      if (msg.type === 'agents') latestAgents = msg.agents;
      if (msg.type === 'agents' && !feed.isDemo()) {
        host.onAgents(msg.agents);
        officeRequests?.requests.setAgentCwds(msg.agents.map((a) => a.cwd)); // the cwds of real agents are file room roots
      }
    },
    now: () => Date.now(),
    timers,
    log,
    demo: new DemoFeed(),
    filterAgents: (agents, sessions) => sentHome?.filter(agents, sessions) ?? agents, // sent-home workers leave the published list
  });
  sentHome = new SentHome({
    storage: { get: (k) => globalState.get(k), set: (k, v) => globalState.update(k, v) },
    now: () => Date.now(),
    readSetting: () => vscode.workspace.getConfiguration('claudeOffice').get<unknown>('sendHomeAfter'),
    isDemo: () => feed.isDemo(),
    stopIfIdle: (sessionId) => host.stopIfIdle(sessionId),
    closeCaseTab: (agentId) => office.closeCaseTab(agentId),
    openCaseTabs: () => office.openCaseTabs(),
    refresh: () => feed.refreshNow(),
    timers,
    log,
  });

  const defaultsService = new ClaudeDefaultsService({
    post: (msg) => office.post(msg),
    fs: { stat: (p) => fs.stat(p), readFile: (p) => fs.readFile(p, 'utf8') },
    timers,
    settingsPath: claudeSettingsJsonPath(),
    env: () => process.env,
    log,
  });
  const usageService = new UsageService({
    probe: () => probeNow(log),
    post: (msg) => office.post(msg),
    now: Date.now,
    timers,
    fs: { stat: (p) => fs.stat(p), readFile: (p) => fs.readFile(p, 'utf8') },
    configPath: claudeConfigJsonPath(),
    usageChecks: readUsageChecks(),
    apiKeyEnv: () => (process.env['ANTHROPIC_API_KEY'] ?? '') !== '', // only whether it is set, never the value
    onProbeOk: (r) => defaultsService.setModels(r.models),
    log,
  });
  usage = usageService;

  // The built-in update check. In a development host, MIDDLE_MANAGEMENT_UPDATE_URL (a loopback address) points it at a mock feed.
  const devFeed = context.extensionMode === vscode.ExtensionMode.Development ? process.env['MIDDLE_MANAGEMENT_UPDATE_URL'] : undefined;
  const updatesDir = vscode.Uri.joinPath(context.globalStorageUri, 'updates');
  const updateService = new UpdateService({
    currentVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
    feedUrl: devFeed ? devFeed : RELEASES_LATEST_URL,
    allowLoopback: devFeed ? true : false,
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    timers,
    storage: { get: (k) => globalState.get(k), set: (k, v) => globalState.update(k, v) },
    readSetting: () => parseUpdateChecks(vscode.workspace.getConfiguration('claudeOffice').get('updateChecks')),
    post: (msg) => office.post(msg),
    log,
    writeFile: async (name, data) => {
      await vscode.workspace.fs.createDirectory(updatesDir);
      const uri = vscode.Uri.joinPath(updatesDir, name);
      await vscode.workspace.fs.writeFile(uri, data);
      return uri.fsPath;
    },
    deleteFile: async (p) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(p));
    },
    install: async (p) => {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(p));
    },
    reload: () => void vscode.commands.executeCommand('workbench.action.reloadWindow'),
    openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
  });
  updates = updateService;

  const postSettings = (): void => office.post({ type: 'settings', settings: { ...readSettings(), theme: theme.currentTheme() } });

  // Theme state (the watcher, its latest load, the theme shown, the source from `claudeOffice.themeFile`) lives in the theme
  // service; the Front desk reads and drives it through the hooks below. The file is polled only while the office is visible.
  const theme = new ThemeService(
    {
      readFile: (p) => fs.readFile(p, 'utf8'),
      stat: async (p) => {
        const st = await fs.stat(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      },
      homeDir: () => os.homedir(),
      timers,
      log,
      setting: () => vscode.workspace.getConfiguration('claudeOffice').get<string>('themeFile', ''),
      // Relative paths resolve against the first workspace folder, else the home folder (never the working directory).
      baseDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      presetDir: () => path.join(context.extensionPath, 'media', 'themes'),
    },
    (change) => {
      postSettings();
      guarded('front desk push', () => fd?.pushState());
      if (change.kind !== 'load') return;
      const errors = change.result.errors;
      for (const line of errors) output.appendLine(`theme: ${line.startsWith('theme: ') ? line.slice(7) : line}`);
      if (errors.length > 0) {
        void vscode.window
          .showWarningMessage(`Theme file has ${errors.length} problem(s). See the Middle Management output for details.`, 'Open file')
          .then((choice) => (choice === 'Open file' ? runFrontDeskCommand({ type: 'themeAction', reqId: `${COMMAND_REQ}open`, action: 'open' }) : undefined));
      }
    },
  );

  // The themes folder lister ("Your offices") and the skill installer ("Make one with Claude"). Both feed the Front desk. The lister
  // polls only while the office is visible; the skill is checked when the Front desk opens and once shortly after activation.
  const themesDir = defaultThemesDir(os.homedir());
  const userThemes = new UserThemes({
    dir: themesDir,
    readdir: (p) => fs.readdir(p),
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p, 'utf8'),
    onChange: () => guarded('front desk push', () => fd?.pushState()),
  });
  // The four source files never change while the extension runs, so they are read once (on the first status check).
  let skillSources: Promise<SkillSources> | undefined;
  const skillDir = path.join(claudeHome(), 'skills', SKILL_FOLDER_NAME);
  const themeSkill = new ThemeSkill({
    skillDir,
    homeDir: os.homedir(),
    sources: () =>
      (skillSources ??= loadSkillSources(context.extensionPath, (p) => fs.readFile(p, 'utf8'), String(context.extension.packageJSON.version ?? '0.0.0'), themesDir)),
    realpath: (p) => fs.realpath(p),
    writeFileExclusive: (p, data) => fs.writeFile(p, data, { flag: 'wx' }),
    rename: (a, b) => fs.rename(a, b),
    unlink: (p) => fs.unlink(p),
    mkdir: async (p) => void (await fs.mkdir(p, { recursive: true })),
    readdir: (p) => fs.readdir(p),
    lstat: (p) => fs.lstat(p),
    readFile: (p) => fs.readFile(p, 'utf8'),
    rmdir: (p) => fs.rmdir(p),
    log,
  });

  // The Front desk: its replies go to the webview, except those of calls the extension makes itself (`cmd:` reqIds), which
  // become an error message when they failed (a dismissed dialog is not a failure) and a plain state push otherwise.
  const frontDesk = createFrontDesk(
    createFrontDeskDeps(context, {
      editorColumn: () => office.panelColumn(),
      post: (msg: HostToWebview) => {
        if (msg.type === 'frontDeskDone' && msg.reqId.startsWith(COMMAND_REQ)) {
          if (!msg.ok && msg.cancelled !== true && msg.message) void vscode.window.showErrorMessage(msg.message);
          return;
        }
        if (msg.type === 'frontDesk' && msg.reqId?.startsWith(COMMAND_REQ)) {
          office.post({ type: 'frontDesk', state: msg.state });
          return;
        }
        replies.post(msg);
      },
      postSettings,
      applyThemePath: () => theme.applyThemePath(),
      reloadNow: () => theme.reloadNow(),
      lastLoad: () => theme.lastLoad(),
      currentTheme: () => theme.currentTheme(),
      userThemes,
      skill: themeSkill,
      skillDir,
      log,
    }),
  );
  fd = frontDesk;
  officeRequests = createOfficeRequestsWiring(context, { post: (msg) => replies.post(msg), isDemo: () => feed.isDemo() || mode === 'view', visible: office.anyVisible(), editorColumn: () => office.panelColumn(), log });
  /** Write the mode to the scope that currently decides it (workspace folder, then workspace, else global). */
  const writeMode = async (next: OfficeMode): Promise<void> => {
    try {
      const active = vscode.window.activeTextEditor?.document.uri;
      const folder = (active ? vscode.workspace.getWorkspaceFolder(active) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
      const cfg = vscode.workspace.getConfiguration('claudeOffice', folder?.uri);
      const target = modeWriteTarget(cfg.inspect('mode'));
      const where = target === 'workspaceFolder' ? vscode.ConfigurationTarget.WorkspaceFolder : target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await cfg.update('mode', next, where);
    } catch (e) {
      log(`changing the mode failed (${e instanceof Error ? e.name : 'error'})`);
      void vscode.window.showErrorMessage('Middle Management could not change the mode. Set claudeOffice.mode in Settings instead.');
    }
  };
  const runFrontDeskCommand = (msg: Parameters<FrontDesk['handle']>[0]): Promise<void> => frontDesk.handle(msg);

  // Everything that polls does so only while the office is visible: the feed, the theme file, the plan-usage service (its
  // `.claude.json` cache poller and its probe timer) and the Claude settings poller.
  const applyVisibility = (visible: boolean): void => {
    guarded('feed visibility', () => feed.setVisible(visible));
    guarded('send home visibility', () => sentHome?.setVisible(visible));
    guarded('theme visibility', () => theme.setVisible(visible));
    guarded('user themes visibility', () => userThemes.setVisible(visible));
    guarded('usage visibility', () => usageService.setVisible(visible));
    guarded('defaults visibility', () => defaultsService.setVisible(visible));
    guarded('office requests visibility', () => officeRequests?.requests.setVisible(visible));
  };

  try {
    feed.setScope(readScope());
  } catch (e) {
    log(`initial scope failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(OfficeView.viewId, office),
    vscode.commands.registerCommand('claudeOffice.openInEditor', () => office.openPanel()),
    ...registerLauncher(office, context.globalState),
    vscode.commands.registerCommand('claudeOffice.newTask', () => {
      if (mode === 'view') {
        void vscode.window.showInformationMessage(VIEW_MODE_NEW_TASK_MESSAGE, 'Switch to Manager Mode').then((choice) => (choice ? writeMode('manager') : undefined));
        return;
      }
      const active = vscode.window.activeTextEditor?.document.uri;
      const folder = (active ? vscode.workspace.getWorkspaceFolder(active) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
      office.showMemo(folder?.uri.fsPath);
    }),
    vscode.commands.registerCommand('claudeOffice.toggleMode', async () => {
      const next = toggled(mode);
      await writeMode(next);
      if (readMode() === next) void vscode.window.showInformationMessage(modeChangedMessage(next));
    }),
    vscode.commands.registerCommand('claudeOffice.toggleDemo', () => {
      const on = !feed.isDemo();
      feed.setDemo(on);
      if (on) {
        host.onAgents([]); // demo workers are not real: close any open case
        office.closeAllCaseTabs(); // and any case tab (`caseTabs` is [] while demoing)
      }
      void vscode.window.showInformationMessage(`Middle Management demo mode ${on ? 'on' : 'off'}`);
    }),
    // "Create Theme File" is the Front desk's create flow (save dialog, starter theme, point the setting at it, open it).
    vscode.commands.registerCommand('claudeOffice.createThemeFile', () => runFrontDeskCommand({ type: 'themeAction', reqId: `${COMMAND_REQ}create`, action: 'create' })),
    vscode.commands.registerCommand('claudeOffice.checkForUpdates', async () => {
      await vscode.commands.executeCommand('claudeOffice.openFrontDesk', 'about');
      await updateService.check(true);
    }),
    vscode.commands.registerCommand('claudeOffice.openFrontDesk', (tab?: unknown) =>
      office.showFrontDesk(typeof tab === 'string' && (FRONT_DESK_TABS as readonly string[]).includes(tab) ? (tab as FrontDeskTab) : undefined),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeOffice.mode')) {
        const next = readMode();
        if (next !== mode) {
          mode = next;
          // Entering view mode: the case tabs go first (each close sends a `closeCase` the manager host still hears), then every
          // office page is built again with the new `data-office-mode`. No process is stopped, in either direction.
          if (next === 'view') guarded('close case tabs', () => office.closeAllCaseTabs());
          guarded('reload office', () => office.reloadAll());
          const running = next === 'view' && !feed.isDemo() ? officeRunCount(latestAgents) : 0;
          if (running > 0) {
            void vscode.window.showInformationMessage(stillRunningMessage(running), 'Switch back').then((choice) => (choice ? writeMode('manager') : undefined));
          }
        }
      }
      if (e.affectsConfiguration('claudeOffice.themeFile')) theme.applyThemePath();
      if (e.affectsConfiguration('claudeOffice')) {
        postSettings();
        guarded('front desk push', () => frontDesk.pushState());
      }
      if (e.affectsConfiguration('claudeOffice.scope')) feed.setScope(readScope());
      if (e.affectsConfiguration('claudeOffice.sendHomeAfter')) guarded('sendHomeAfter', () => sentHome?.settingChanged());
      if (e.affectsConfiguration('claudeOffice.updateChecks')) guarded('updateChecks', () => updateService.settingChanged());
      if (e.affectsConfiguration('claudeOffice.usageChecks')) guarded('usageChecks', () => usageService.setUsageChecks(readUsageChecks()));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      feed.setScope(readScope());
      theme.applyThemePath();
      guarded('front desk push', () => frontDesk.pushState());
    }),
    office.onDidChangeVisibility((visible) => applyVisibility(visible)),
    { dispose: () => feed.dispose() },
    { dispose: () => sentHome?.dispose() },
    { dispose: () => theme.dispose() },
    { dispose: () => userThemes.dispose() },
    { dispose: () => clearTimeout(skillRefresh) },
    { dispose: () => usageService.dispose() },
    { dispose: () => updateService.dispose() },
    { dispose: () => defaultsService.dispose() },
    { dispose: () => officeRequests?.dispose() },
    { dispose: () => void host.dispose() },
    { dispose: () => office.dispose() },
  );

  // Bring an outdated skill install up to date a few seconds after start-up, off the activation path. It never touches a skill the
  // user edited or one that is not ours, and `refreshIfOurs` does not throw; the catch is only a guard.
  const skillRefresh = setTimeout(() => {
    void themeSkill
      .refreshIfOurs()
      .then(() => frontDesk.refreshSkill())
      .catch((e: unknown) => log(`skill refresh failed (${e instanceof Error ? e.name : 'error'})`));
  }, 5000);
  skillRefresh.unref();

  postSettings();
  office.post({ type: 'agents', agents: [] });
  applyVisibility(office.anyVisible());
  theme.applyThemePath();
  logVersionSanity(log);
  guarded('update check', () => updateService.start());
}

/** Deny every pending request, stop every office run (at most a few seconds), then let the extension host exit. */
export async function deactivate(): Promise<void> {
  const host = managerHost;
  managerHost = undefined;
  await host?.dispose();
}
