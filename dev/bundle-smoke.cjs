// Loads the BUNDLED extension (dist/extension.js) in plain node with a stub `vscode` module, runs activate(), pokes the
// webview message path and the SDK import (without any API call), then deactivate(). Catches load-time crashes such as
// the SDK's `import.meta.url` when the bundle is wrong. Run `npm run build` first.
//
//   node dev/bundle-smoke.cjs
'use strict';
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const bundle = path.resolve(__dirname, '..', 'dist', 'extension.js');
if (!fs.existsSync(bundle)) {
  console.error('dist/extension.js is missing: run `npm run build` first');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------------
// vscode stub

// A scratch CLAUDE_CONFIG_DIR, so the smoke test never reads the real ~/.claude*: the extension must resolve every path from it
// (sessions, projects, settings.json, .claude.json). It holds planted secrets that must never reach the webview.
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-smoke-cfg-'));
process.env.CLAUDE_CONFIG_DIR = cfgDir;
fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ model: 'smoke-model', effortLevel: 'high', apiKeyHelper: 'SMOKE-SECRET-HELPER', env: { ANTHROPIC_API_KEY: 'SMOKE-SECRET-KEY' } }));
fs.writeFileSync(
  path.join(cfgDir, '.claude.json'),
  JSON.stringify({
    oauthAccount: { emailAddress: 'SMOKE-SECRET@example.com', accountUuid: 'SMOKE-SECRET-UUID' },
    cachedUsageUtilization: { fetchedAtMs: Date.now(), accountUuid: 'SMOKE-SECRET-UUID', utilization: { five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600e3).toISOString() } } },
  }),
);

// A scratch home folder too (HOME / USERPROFILE are switched in main(), after the stub has looked for installed extensions):
// the Front desk shows files under it as `~/...`, and a theme file the smoke test creates must not land in the real home.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-smoke-home-'));

const logs = [];
const registeredCommands = new Map();
let viewProvider;
let saveDialogResult; // what the stubbed Save dialog returns
const settings = { claudePath: '', usageChecks: 'off' }; // the stubbed USER settings (what `update(..., Global)` writes) // usageChecks 'off': the smoke test never starts a Claude probe
const globalStateData = new Map();
let configListener; // the extension's onDidChangeConfiguration handler
const packageDefaults = Object.fromEntries(
  Object.entries(require('../package.json').contributes.configuration.properties).map(([k, v]) => [k.replace(/^claudeOffice\./, ''), v.default]),
); // set to '/bin/false' after activation: a real executable that exits at once (loads the SDK, costs nothing)

/** An installed Claude Code extension, if any, so the activation-time version check has something real to read. */
function installedClaudeCodeExtensions() {
  const out = [];
  for (const dir of ['.vscode', '.vscode-oss', '.vscode-insiders']) {
    const root = path.join(os.homedir(), dir, 'extensions');
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names.sort().reverse()) {
      if (n.toLowerCase().startsWith('anthropic.claude-code-')) out.push({ id: 'Anthropic.claude-code', extensionPath: path.join(root, n) });
    }
  }
  return out.slice(0, 1);
}
const disposable = { dispose() {} };
const event = () => disposable;

class Uri {
  constructor(fsPath, scheme = 'file') {
    this.fsPath = fsPath;
    this.scheme = scheme;
  }
  static file(p) { return new Uri(p); }
  static parse(s) { return new Uri(s, String(s).split(':')[0]); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `${this.scheme}:${this.fsPath}`; }
}

const vscodeStub = {
  Uri,
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logs.push(l), dispose() {} }),
    registerWebviewViewProvider: (id, provider) => { viewProvider = provider; return disposable; },
    createTreeView: () => ({ onDidChangeVisibility: event, dispose() {} }), // the activity-bar launcher
    createWebviewPanel: () => { throw new Error('createWebviewPanel is not expected in the smoke test'); },
    showInformationMessage: async () => undefined,
    showErrorMessage: async (m) => { logs.push(`error message shown (${String(m).length} chars)`); },
    showWarningMessage: async () => undefined,
    showSaveDialog: async () => (saveDialogResult ? Uri.file(saveDialogResult) : undefined),
    showTextDocument: async () => undefined,
    showOpenDialog: async () => undefined,
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id, fn) => { registeredCommands.set(id, fn); return disposable; },
    executeCommand: async (id) => { throw new Error(`command '${id}' not found`); },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(os.tmpdir()), name: 'tmp', index: 0 }],
    getConfiguration: () => ({
      get: (key, dflt) => (key in settings ? settings[key] : dflt),
      inspect: (key) => ({ defaultValue: packageDefaults[key], ...(key in settings ? { globalValue: settings[key] } : {}) }),
      update: async (key, value) => {
        if (value === undefined) delete settings[key]; else settings[key] = value;
        configListener?.({ affectsConfiguration: (k) => k === 'claudeOffice' || k === `claudeOffice.${key}` });
      },
    }),
    openTextDocument: async (u) => ({ uri: u }),
    getWorkspaceFolder: () => undefined,
    onDidChangeConfiguration: (cb) => { configListener = cb; return disposable; },
    onDidChangeWorkspaceFolders: event,
  },
  extensions: { all: installedClaudeCodeExtensions(), getExtension: () => undefined },
  env: { uriScheme: 'vscode', openExternal: async () => true, clipboard: { writeText: async () => {}, readText: async () => '' } },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub, children: [], paths: [] };

// ---------------------------------------------------------------------------------------------------------------------

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const ext = require(bundle); // would throw here if `import.meta` was left in the bundle
  check('bundle loads (import.meta defined away)', typeof ext.activate === 'function' && typeof ext.deactivate === 'function');

  const globalState = { get: (k) => globalStateData.get(k), update: async (k, v) => void globalStateData.set(k, v) };
  const context = { subscriptions: [], globalState, extension: { packageJSON: { version: '0.0.0-smoke' } }, extensionUri: Uri.file(path.resolve(__dirname, '..')), extensionPath: path.resolve(__dirname, '..'), globalStorageUri: Uri.file(path.join(os.tmpdir(), 'mm-bundle-smoke')) };
  ext.activate(context);
  check('activate() returns without throwing', true);
  check('view provider registered', !!viewProvider);
  for (const id of ['claudeOffice.openInEditor', 'claudeOffice.toggleDemo', 'claudeOffice.newTask', 'claudeOffice.show', 'claudeOffice.createThemeFile', 'claudeOffice.openFrontDesk']) check(`command ${id}`, registeredCommands.has(id));
  check('version sanity logged', logs.some((l) => /Agent SDK 0\.3\.302/.test(l)), logs.find((l) => /Agent SDK/.test(l)) ?? 'no line');
  settings.claudePath = '/bin/false';

  // A fake webview view, as VS Code would hand to the provider.
  const posted = [];
  let onMessage;
  const webviewView = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'csp',
      asWebviewUri: (u) => u,
      onDidReceiveMessage: (cb) => { onMessage = cb; return disposable; },
      postMessage: async (m) => { posted.push(m); return true; },
    },
    onDidChangeVisibility: event,
    onDidDispose: event,
  };
  viewProvider.resolveWebviewView(webviewView);
  check('webview html set', webviewView.webview.html.includes('<canvas id="office">'));

  onMessage({ type: 'ready' });
  await sleep(50);
  check('ready replays settings and agents', posted.some((m) => m.type === 'settings') && posted.some((m) => m.type === 'agents'));

  // The usage service and the settings poller started when the view became visible (checks are off, so no probe). A second
  // `ready` replays the cached messages.
  posted.length = 0;
  onMessage({ type: 'ready' });
  await sleep(50);
  const defaultsMsg = posted.find((m) => m.type === 'claudeDefaults');
  const usageMsg = posted.find((m) => m.type === 'usage');
  check('ready replays claudeDefaults from <CLAUDE_CONFIG_DIR>/settings.json', defaultsMsg?.defaults?.model === 'smoke-model' && defaultsMsg.defaults.effort === 'high', JSON.stringify(defaultsMsg?.defaults ?? null));
  check('ready replays usage from <CLAUDE_CONFIG_DIR>/.claude.json, probe off', usageMsg?.usage?.probe === 'off' && usageMsg.usage.windows.some((w) => w.id === 'five_hour' && w.pct === 42), JSON.stringify(usageMsg?.usage ?? null).slice(0, 120));
  check('no planted secret reached the webview', !JSON.stringify(posted).includes('SMOKE-SECRET'));

  posted.length = 0;
  onMessage({ type: 'refreshUsage' });
  onMessage({ type: 'getPlan', reqId: 'rp1', agentId: 'nope', planId: 'nope' });
  onMessage({ type: 'getTurn', reqId: 'rt1', agentId: 'nope' });
  onMessage({ type: 'setSessionOptions', nonce: 'so1', sessionId: 'nope', options: { effort: 'high' } });
  await sleep(100);
  check('refreshUsage with checks off is harmless', !posted.some((m) => m.type === 'error' && m.reqId === undefined && m.nonce === undefined));
  check('getPlan, getTurn and setSessionOptions for unknown targets answer with their error', ['rp1', 'rt1'].every((id) => posted.some((m) => m.type === 'error' && m.reqId === id)) && posted.some((m) => m.type === 'error' && m.nonce === 'so1'));

  // ---- Front desk: the round trips go through the real extension code against the stubbed configuration ----------------------
  const settle = async (pred, ms = 3000) => {
    for (let i = 0; i < ms / 20; i++) {
      const hit = posted.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return undefined;
  };
  const sentToWebview = []; // every message posted from here on, kept for the path scan
  const extPath = path.resolve(__dirname, '..');
  const lastState = (req) => [...posted].reverse().find((m) => m.type === 'frontDesk' && (req === undefined || m.reqId === req));

  posted.length = 0;
  onMessage({ type: 'getFrontDesk', reqId: 'fd1' });
  const fd1 = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd1');
  const s1 = lastState('fd1')?.state;
  check('getFrontDesk on the built-in office answers with the state, then done', fd1?.ok === true && s1?.source.kind === 'builtin' && s1.source.errors.length === 0 && Array.isArray(s1.presets) && s1.presets.some((p) => p.id === 'example'), JSON.stringify(s1?.source ?? null));
  check('the state lists every Front desk setting with its default', s1 && ['mode', 'companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks'].every((k) => k in s1.settings) && s1.settings.companyName.value === 'Middle Management');
  sentToWebview.push(...posted);

  posted.length = 0;
  onMessage({ type: 'themeAction', reqId: 'fd2', action: 'usePreset', presetId: 'example' });
  const fd2 = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd2');
  const s2 = lastState('fd2')?.state;
  check('themeAction usePreset example loads the packaged preset with no errors', fd2?.ok === true && s2?.source.kind === 'preset' && s2.source.presetId === 'example' && s2.source.errors.length === 0 && s2.source.readOnly === 'preset', JSON.stringify(s2?.source ?? null));
  check('the setting holds preset:example, never a path', settings.themeFile === 'preset:example');
  const themed = [...posted].reverse().find((m) => m.type === 'settings' && m.settings.theme);
  check('the example theme reached the webview in a settings message', themed?.settings.theme.company === 'Pennywhistle Paper', themed?.settings.theme.company ?? 'no theme');
  check('every theme load and setting change pushed a state (no reqId)', posted.some((m) => m.type === 'frontDesk' && m.reqId === undefined));
  sentToWebview.push(...posted);

  posted.length = 0;
  onMessage({ type: 'setSetting', reqId: 'fd3', key: 'companyName', value: 'Smoke Co' });
  const fd3 = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd3');
  const s3 = lastState('fd3')?.state;
  check('setSetting companyName round trip: stored as a user setting and shown back', fd3?.ok === true && settings.companyName === 'Smoke Co' && s3?.settings.companyName.value === 'Smoke Co' && s3.settings.companyName.source === 'user');
  check('the settings message carries the new company name', posted.some((m) => m.type === 'settings' && m.settings.companyName === 'Smoke Co'));
  onMessage({ type: 'setSetting', reqId: 'fd3b', key: 'companyName', value: null });
  const fd3b = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd3b');
  check('setSetting null resets it to the default', fd3b?.ok === true && !('companyName' in settings) && lastState('fd3b')?.state.settings.companyName.value === 'Middle Management');
  sentToWebview.push(...posted);

  posted.length = 0;
  onMessage({ type: 'themeAction', reqId: 'fd4', action: 'useBuiltin' });
  const fd4 = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd4');
  check('themeAction useBuiltin goes back to the built-in office', fd4?.ok === true && lastState('fd4')?.state.source.kind === 'builtin' && !('themeFile' in settings) && posted.some((m) => m.type === 'settings' && m.settings.theme === undefined));
  sentToWebview.push(...posted);

  // A bad preset id in the setting falls back to the built-in office, with the error in the state.
  posted.length = 0;
  await vscodeStub.workspace.getConfiguration().update('themeFile', 'preset:nope');
  onMessage({ type: 'getFrontDesk', reqId: 'fd5' });
  await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fd5');
  const s5 = lastState('fd5')?.state;
  check('an unknown preset falls back to the built-in office with the error surfaced', s5?.source.kind === 'builtin' && s5.source.errors.length > 0, JSON.stringify(s5?.source.errors ?? null).slice(0, 100));
  await vscodeStub.workspace.getConfiguration().update('themeFile', undefined);
  sentToWebview.push(...posted);

  // The command runs the Front desk create flow; its replies never reach the webview, and the new file is a real theme.
  posted.length = 0;
  const newTheme = path.join(fakeHome, 'smoke.theme.json');
  saveDialogResult = newTheme;
  await registeredCommands.get('claudeOffice.createThemeFile')();
  await sleep(100);
  check('claudeOffice.createThemeFile creates the starter file and points the setting at it', fs.existsSync(newTheme) && settings.themeFile === newTheme && lastState()?.state.source.kind === 'file' && lastState().state.source.path === '~/smoke.theme.json', lastState()?.state.source.path);
  check('the create command\'s replies stay out of the webview (no cmd: reqId)', !JSON.stringify(posted).includes('cmd:'));
  sentToWebview.push(...posted);
  saveDialogResult = undefined;
  await vscodeStub.workspace.getConfiguration().update('themeFile', undefined);

  posted.length = 0;
  registeredCommands.get('claudeOffice.openFrontDesk')();
  registeredCommands.get('claudeOffice.openFrontDesk')('colours');
  await sleep(20);
  check('claudeOffice.openFrontDesk posts openFrontDesk (with the tab when given a valid one)', posted.some((m) => m.type === 'openFrontDesk' && m.tab === undefined) && posted.some((m) => m.type === 'openFrontDesk' && m.tab === 'colours'));

  // Nothing sent to the webview by the Front desk or the settings plumbing may carry an absolute path (`~` display paths only).
  const fdMessages = sentToWebview.filter((m) => m.type === 'frontDesk' || m.type === 'frontDeskDone' || m.type === 'settings');
  // `rawText` is the theme file's own text (its `$schema` line names the extension's schema file); `make.skillFolder` is `~`-shortened for display, but the smoke test's CLAUDE_CONFIG_DIR sits outside the fake home so it stays absolute here; everything else must be path-free.
  const text = JSON.stringify(fdMessages, (k, v) => (k === 'rawText' ? '[theme file text]' : k === 'skillFolder' ? '[skill folder]' : v));
  const leaks = [extPath, cfgDir, os.tmpdir(), fakeHome].filter((p) => p && text.includes(p));
  check('no absolute path in any Front desk or settings message to the webview', leaks.length === 0 && fdMessages.length > 5, leaks.length ? `leaked: ${leaks.map((p) => p.length).join(',')}` : `${fdMessages.length} messages scanned`);

  posted.length = 0;
  onMessage({ type: 'nonsense', x: 1 });
  onMessage({ type: 'decide', requestId: 5, decision: {} });
  onMessage(null);
  await sleep(20);
  check('invalid messages are dropped and logged', posted.length === 0 && logs.filter((l) => /dropped an invalid webview message/.test(l)).length === 3);

  onMessage({ type: 'listProjects' });
  await sleep(100);
  const projects = posted.find((m) => m.type === 'projects');
  check('listProjects answered', !!projects && Array.isArray(projects.projects));

  onMessage({ type: 'openCase', agentId: 'does-not-exist' });
  await sleep(50);
  check('openCase for an unknown agent gives an error', posted.some((m) => m.type === 'error'));

  // The command: the view is visible and ready, so the memo opens at once.
  posted.length = 0;
  registeredCommands.get('claudeOffice.newTask')();
  await sleep(20);
  check('claudeOffice.newTask posts openMemo', posted.some((m) => m.type === 'openMemo'));

  // Loads the SDK chunk from the bundle and spawns /bin/false: expect a prompt error, no API call, no cost.
  posted.length = 0;
  onMessage({ type: 'newTask', nonce: 'n1', projectPath: os.tmpdir(), prompt: 'smoke', assignTo: { kind: 'new' }, permissionMode: 'default' });
  let err;
  for (let i = 0; i < 100 && !err; i++) {
    await sleep(100);
    err = posted.find((m) => m.type === 'error' && m.nonce === 'n1');
  }
  check('newTask loads the bundled SDK and fails cleanly on a dud binary', !!err, err ? String(err.message).slice(0, 80) : 'no error within 10 s');
  check('no taskStarted for the dud run', !posted.some((m) => m.type === 'taskStarted'));

  // Demo mode refuses session actions.
  await registeredCommands.get('claudeOffice.toggleDemo')();
  posted.length = 0;
  onMessage({ type: 'openCase', agentId: 'demo-1' });
  await sleep(20);
  const refusal = posted.find((m) => m.type === 'error');
  check('demo mode answers with a friendly error', !!refusal && /Demo workers can't take orders/.test(refusal.message));
  posted.length = 0;
  onMessage({ type: 'getFrontDesk', reqId: 'fdd' });
  const fdDemo = await settle((m) => m.type === 'frontDeskDone' && m.reqId === 'fdd');
  check('the Front desk works in demo mode (routed before the demo guard)', fdDemo?.ok === true && posted.some((m) => m.type === 'frontDesk' && m.reqId === 'fdd'));
  posted.length = 0;
  onMessage({ type: 'getPlan', reqId: 'dp1', agentId: 'demo-1', planId: 'p' });
  onMessage({ type: 'getTurn', reqId: 'dt1', agentId: 'demo-1' });
  onMessage({ type: 'setSessionOptions', nonce: 'dso1', sessionId: 'demo-1', options: { effort: 'low' } });
  await sleep(20);
  check(
    'demo mode refuses getPlan, getTurn and setSessionOptions with their ids',
    posted.filter((m) => m.type === 'error' && /Demo workers can't take orders/.test(m.message)).length === 3 &&
      posted.some((m) => m.reqId === 'dp1') && posted.some((m) => m.reqId === 'dt1') && posted.some((m) => m.nonce === 'dso1'),
  );
  await registeredCommands.get('claudeOffice.toggleDemo')();

  await ext.deactivate();
  check('deactivate() completes', true);
  for (const d of context.subscriptions) { try { d.dispose(); } catch { /* ignore */ } }
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

const timeout = setTimeout(() => { console.error('FAIL smoke test timed out'); process.exit(1); }, 60000);
main().then(
  () => {
    clearTimeout(timeout);
    console.log(failures === 0 ? 'bundle smoke test passed' : `bundle smoke test FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (e) => {
    clearTimeout(timeout);
    console.error('FAIL', e && e.stack ? e.stack : e);
    console.error(logs.slice(-10).join('\n'));
    process.exit(1);
  },
);
