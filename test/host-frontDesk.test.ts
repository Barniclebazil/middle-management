import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LIMITS, FRONT_DESK_SETTINGS } from '../src/shared/protocol.ts';
import type { FrontDeskSettingKey, HostToWebview, SettingsTarget, WebviewToHost } from '../src/shared/protocol.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { parseTheme } from '../src/shared/theme.ts';
import { createFrontDesk } from '../src/host/frontDesk.ts';
import type { ConfigInspect, FrontDeskDeps } from '../src/host/frontDesk.ts';
import { loadThemeFile } from '../src/host/themeLoader.ts';
import type { ThemeLoadResult } from '../src/host/themeLoader.ts';
import { resolveThemeSource } from '../src/host/themeSource.ts';
import { revisionOf } from '../src/host/themeWriter.ts';
import { UserThemes, defaultThemesDir, settingValueFor } from '../src/host/userThemes.ts';
import { themePromptPaths, themePromptText } from '../src/host/themePrompt.ts';
import type { SkillResult, SkillStatus } from '../src/host/themeSkill.ts';

const EXTENSION_DIR = path.join(import.meta.dirname, '..');
const PRESET_DIR = path.join(EXTENSION_DIR, 'media', 'themes');
const SECRET = 'SeCrEtCoMpAnY';

/** A native path with the home folder shown as `~`, as `shortenHome` writes it: `~` then the platform's separator (`~\x` on Windows). */
const tilde = (...parts: string[]): string => ['~', ...parts].join(path.sep);

type Msg = HostToWebview;
type FrontDeskMsg = Extract<Msg, { type: 'frontDesk' }>;
type DoneMsg = Extract<Msg, { type: 'frontDeskDone' }>;

/** A stand-in for `ThemeSkill`: the status and the results of install and remove are set by the test. */
interface SkillFake {
  status: SkillStatus;
  installResult: SkillResult;
  removeResult: SkillResult;
  /** What happens to the status after a successful install or remove. */
  afterInstall: SkillStatus;
  afterRemove: SkillStatus;
  calls: string[];
}

interface Harness {
  dir: string;
  home: string;
  /** `<home>/.middle-management/themes`, the folder the real `UserThemes` lists. */
  themesDir: string;
  skill: SkillFake;
  clipboard: string[];
  /** What `openFolder` does: the folders asked for, and the answer (or an error to throw). */
  folder: { opened: string[]; answer: boolean | Error };
  userThemes: UserThemes;
  deps: FrontDeskDeps;
  fd: ReturnType<typeof createFrontDesk>;
  posted: Msg[];
  logs: string[];
  config: Record<string, ConfigInspect>;
  /** Queue of answers for the next dialogs. */
  saveAnswers: (string | undefined)[];
  openAnswers: (string | undefined)[];
  overwrite: { answer: boolean; asked: number };
  opened: string[];
  /** The options of every Save dialog shown. */
  dialogs: { title: string; defaultPath: string }[];
  settingsUi: { key: string; target: SettingsTarget }[];
  setUser(key: string, value: unknown): void;
  setWorkspace(key: string, value: unknown): void;
  /** Write a theme file and point the user setting at it, then load it like the watcher would. */
  useFile(name: string, text: string, scope?: 'user' | 'workspace'): Promise<string>;
  send(msg: WebviewToHost): Promise<Msg[]>;
  load(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-fd-')));
  const home = path.join(dir, 'home');
  await fs.mkdir(home);
  const posted: Msg[] = [];
  const logs: string[] = [];
  const config: Record<string, ConfigInspect> = {};
  let watchPath = '';
  let last: ThemeLoadResult | undefined;
  let good: OfficeTheme | undefined;
  const h = {} as Harness;
  const themesDir = defaultThemesDir(home);
  const userThemes = new UserThemes({
    dir: themesDir,
    readdir: (p) => fs.readdir(p),
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p, 'utf8'),
  });
  const skill: SkillFake = {
    status: 'missing',
    installResult: { ok: true },
    removeResult: { ok: true },
    afterInstall: 'installed',
    afterRemove: 'missing',
    calls: [],
  };
  const clipboard: string[] = [];
  const folder: Harness['folder'] = { opened: [], answer: true };

  const settingValue = (): string => {
    const i = config['themeFile'];
    const v = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? i?.defaultValue ?? '';
    return typeof v === 'string' ? v : '';
  };
  const deps: FrontDeskDeps = {
    inspect: (key) => config[key],
    updateGlobal: async (key, value) => {
      config[key] = { ...config[key], globalValue: value };
    },
    post: (m) => void posted.push(m),
    postSettings: () => void posted.push({ type: 'settings', settings: { companyName: 'x', branchName: 'x', speechBubbles: true, managerName: 'x', bossQuotes: true } }),
    applyThemePath: () => {
      const s = resolveThemeSource(settingValue(), home, undefined, PRESET_DIR);
      watchPath = s.path;
      if (s.path === '') {
        last = undefined;
        good = undefined;
      }
    },
    reloadNow: async () => {
      if (watchPath === '') return;
      last = await loadThemeFile(watchPath, { readFile: (p) => fs.readFile(p, 'utf8') });
      if (last.theme !== undefined && last.errors.length === 0) good = last.theme;
    },
    lastLoad: () => last,
    currentTheme: () => last?.theme ?? good,
    fs: {
      realpath: (p) => fs.realpath(p),
      writeFileExclusive: (p, d) => fs.writeFile(p, d, { flag: 'wx' }),
      rename: (a, b) => fs.rename(a, b),
      unlink: (p) => fs.unlink(p),
      mkdir: async (p) => void (await fs.mkdir(p, { recursive: true })),
      readFile: (p) => fs.readFile(p, 'utf8'),
      exists: async (p) => {
        try {
          await fs.stat(p);
          return true;
        } catch {
          return false;
        }
      },
    },
    homeDir: () => home,
    baseDir: () => undefined,
    presetDir: () => PRESET_DIR,
    extensionPath: () => EXTENSION_DIR,
    skillDir: () => path.join(home, '.claude', 'skills', 'middle-management-theme'),
    userThemes,
    skill: {
      status: async () => skill.status,
      install: async () => {
        skill.calls.push('install');
        if (skill.installResult.ok) skill.status = skill.afterInstall;
        return skill.installResult;
      },
      remove: async () => {
        skill.calls.push('remove');
        if (skill.removeResult.ok) skill.status = skill.afterRemove;
        return skill.removeResult;
      },
    },
    showSaveDialog: async (opts) => {
      // `joinPath` in frontDesk.ts joins with '/', which Windows accepts; normalise so the tests compare one separator style.
      h.dialogs.push({ ...opts, defaultPath: path.normalize(opts.defaultPath) });
      return h.saveAnswers.shift();
    },
    showOpenDialog: async () => h.openAnswers.shift(),
    confirmOverwrite: async () => {
      h.overwrite.asked++;
      return h.overwrite.answer;
    },
    openFile: async (p) => void h.opened.push(p),
    openSettingsUi: async (key, target) => void h.settingsUi.push({ key, target }),
    openFolder: async (dir) => {
      folder.opened.push(dir);
      if (folder.answer instanceof Error) throw folder.answer;
      return folder.answer;
    },
    writeClipboard: async (text) => void clipboard.push(text),
    log: (line) => void logs.push(line),
  };
  Object.assign(h, {
    dir,
    home,
    themesDir,
    userThemes,
    skill,
    clipboard,
    folder,
    dialogs: [],
    deps,
    fd: createFrontDesk(deps),
    posted,
    logs,
    config,
    saveAnswers: [],
    openAnswers: [],
    overwrite: { answer: true, asked: 0 },
    opened: [],
    settingsUi: [],
    setUser: (key: string, value: unknown) => {
      config[key] = { ...config[key], globalValue: value };
    },
    setWorkspace: (key: string, value: unknown) => {
      config[key] = { ...config[key], workspaceValue: value };
    },
    useFile: async (name: string, text: string, scope: 'user' | 'workspace' = 'user') => {
      const p = path.join(dir, name);
      await fs.writeFile(p, text, 'utf8');
      if (scope === 'user') h.setUser('themeFile', p);
      else h.setWorkspace('themeFile', p);
      await h.load();
      return p;
    },
    send: async (msg: WebviewToHost) => {
      const from = posted.length;
      await h.fd.handle(msg);
      return posted.slice(from);
    },
    load: async () => {
      deps.applyThemePath();
      await deps.reloadNow();
    },
  });
  return h;
}

async function cleanup(h: Harness): Promise<void> {
  await fs.rm(h.dir, { recursive: true, force: true });
}

const THEME_TEXT = JSON.stringify({ $schema: 'file:///kept/schema.json', company: 'Test Co', branch: 'Test Branch', manager: { name: 'Boss' } }, null, 4);
const NEW_THEME = { company: 'New Co', branch: 'New Branch', staff: [{ name: 'Alice' }] };

const types = (m: Msg[]): string[] => m.map((x) => x.type);
const stateOf = (m: Msg[]): FrontDeskMsg['state'] => {
  const s = m.find((x): x is FrontDeskMsg => x.type === 'frontDesk');
  assert.ok(s, 'no frontDesk message');
  return s.state;
};
const doneOf = (m: Msg[]): DoneMsg => {
  const d = m.find((x): x is DoneMsg => x.type === 'frontDeskDone');
  assert.ok(d, 'no frontDeskDone message');
  return d;
};
const save = (rev: string, theme: unknown, force?: true): WebviewToHost => ({ type: 'saveTheme', reqId: 'r1', rev, themeJson: JSON.stringify(theme), ...(force ? { force } : {}) });

// ---- state --------------------------------------------------------------------------------------------------------

test('state: built-in office with default settings (and fallbacks when inspect knows no default)', async () => {
  const h = await harness();
  try {
    const out = await h.send({ type: 'getFrontDesk', reqId: 'r1' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal((out[0] as FrontDeskMsg).reqId, 'r1');
    assert.deepEqual(doneOf(out), { type: 'frontDeskDone', reqId: 'r1', ok: true });
    const s = stateOf(out);
    assert.equal(s.source.kind, 'builtin');
    assert.equal(s.source.label, 'Built-in office');
    assert.equal(s.source.path, undefined);
    assert.equal(s.source.readOnly, 'builtin');
    assert.equal(s.source.editable, false);
    assert.equal(s.source.exists, true);
    assert.equal(s.source.fromWorkspace, false);
    assert.equal(s.source.rev, undefined);
    assert.deepEqual(s.source.errors, []);
    assert.deepEqual(s.presets.map((p) => p.id), ['example', 'spaceship', 'construction-site', 'metalwork-factory', 'cyberpunk', 'steampunk']);
    assert.deepEqual(Object.keys(s.settings), [...FRONT_DESK_SETTINGS]);
    assert.deepEqual(s.settings.companyName, { value: 'Middle Management', source: 'default', workspaceWins: false });
    assert.equal(s.settings.usageChecks.value, 'auto');
    assert.equal(s.settings.updateChecks.value, 'auto');
    assert.equal(s.settings.mode.value, 'manager');
    assert.equal(s.settings.speechBubbles.value, true);
  } finally {
    await cleanup(h);
  }
});

test('state: a preset source', async () => {
  const h = await harness();
  try {
    h.setUser('themeFile', 'preset:example');
    await h.load();
    const s = h.fd.buildState();
    assert.equal(s.source.kind, 'preset');
    assert.equal(s.source.presetId, 'example');
    assert.equal(s.source.label, 'Example office');
    assert.equal(s.source.path, 'preset:example');
    assert.equal(s.source.readOnly, 'preset');
    assert.equal(s.source.editable, false);
    assert.equal(s.source.rev, undefined);
    assert.deepEqual(s.source.errors, []);
  } finally {
    await cleanup(h);
  }
});

test('state: an unknown preset falls back to built-in and says why', async () => {
  const h = await harness();
  try {
    h.setUser('themeFile', 'preset:nope');
    const s = h.fd.buildState();
    assert.equal(s.source.kind, 'builtin');
    assert.equal(s.source.errors.length, 1);
    assert.match(s.source.errors[0] ?? '', /unknown preset/);
  } finally {
    await cleanup(h);
  }
});

test('state: a user theme file with its revision, short path and editable flag', async () => {
  const h = await harness();
  try {
    const p = path.join(h.home, 'office.json');
    await fs.writeFile(p, THEME_TEXT);
    h.setUser('themeFile', p);
    await h.load();
    const s = h.fd.buildState();
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.label, 'office.json');
    assert.equal(s.source.path, tilde('office.json'));
    assert.equal(s.source.rev, revisionOf(THEME_TEXT));
    assert.equal(s.source.exists, true);
    assert.equal(s.source.editable, true);
    assert.equal(s.source.readOnly, undefined);
    assert.equal(s.source.fromWorkspace, false);
    assert.equal(s.source.usingLastGood, false);
    assert.deepEqual(s.source.errors, []);
  } finally {
    await cleanup(h);
  }
});

test('state: errors are capped in number and length, the broken file keeps the last good theme', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('good.json', THEME_TEXT);
    assert.equal(h.fd.buildState().source.usingLastGood, false);
    const staff = Array.from({ length: 80 }, () => ({ name: 5, role: 'x'.repeat(10) }));
    await fs.writeFile(p, JSON.stringify({ company: 'Still fine', staff }));
    await h.load();
    const s = h.fd.buildState();
    assert.ok(s.source.errors.length > 0 && s.source.errors.length <= LIMITS.themeErrors);
    assert.ok(s.source.errors.every((e) => e.length <= LIMITS.themeErrorChars));
    // Cut text, not just a count.
    await fs.writeFile(p, '{ not json ' + 'x'.repeat(2000));
    await h.load();
    const t = h.fd.buildState();
    assert.ok(t.source.errors.every((e) => e.length <= LIMITS.themeErrorChars));
    assert.ok(t.source.errors.every((e) => !e.includes(p)), 'the full path is shown the short way');
    assert.equal(t.source.usingLastGood, true);
    assert.equal(t.source.editable, false, 'a file that is not JSON is never overwritten');
  } finally {
    await cleanup(h);
  }
});

test('state: a missing file', async () => {
  const h = await harness();
  try {
    h.setUser('themeFile', path.join(h.home, 'gone.json'));
    await h.load();
    const s = h.fd.buildState();
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.exists, false);
    assert.equal(s.source.readOnly, 'missing');
    assert.equal(s.source.editable, false);
    assert.equal(s.source.rev, undefined);
    assert.equal(s.source.errors.length, 1);
  } finally {
    await cleanup(h);
  }
});

test('state: a theme path set in the workspace is read-only, and Save is refused', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('ws.json', THEME_TEXT, 'workspace');
    const s = h.fd.buildState();
    assert.equal(s.source.fromWorkspace, true);
    assert.equal(s.source.readOnly, 'workspace');
    assert.equal(s.source.editable, false);
    const out = await h.send(save(s.source.rev ?? '', NEW_THEME));
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.equal(doneOf(out).conflict, undefined);
    assert.equal(await fs.readFile(p, 'utf8'), THEME_TEXT, 'nothing was written');
  } finally {
    await cleanup(h);
  }
});

/** Write a theme file into the themes folder (created if needed). */
async function addUserTheme(h: Harness, fileName: string, theme: unknown = { name: 'Pirate ship', description: 'Arr.' }): Promise<string> {
  await fs.mkdir(h.themesDir, { recursive: true });
  const p = path.join(h.themesDir, fileName);
  await fs.writeFile(p, JSON.stringify(theme), 'utf8');
  return p;
}

test('state: userThemes lists the themes folder with the one in use marked, and make carries the folders and the skill status', async () => {
  const h = await harness();
  try {
    // Before the first scan and skill check: an empty list and an unknown skill.
    const before = h.fd.buildState();
    assert.deepEqual(before.userThemes, []);
    assert.equal(before.userThemesTruncated, false);
    assert.deepEqual(before.make, { themesFolder: tilde('.middle-management', 'themes'), skillFolder: tilde('.claude', 'skills', 'middle-management-theme'), skill: 'unknown' });

    await addUserTheme(h, 'pirate-ship.theme.json');
    await addUserTheme(h, 'bakery.theme.json', { name: 'Corner bakery' });
    h.setUser('themeFile', settingValueFor('bakery.theme.json'));
    await h.load();
    h.skill.status = 'outdated';
    const s = stateOf(await h.send({ type: 'getFrontDesk', reqId: 'r1' }));
    assert.deepEqual(s.userThemes?.map((t) => [t.id, t.label, t.current]).sort(), [
      ['bakery.theme.json', 'Corner bakery', true],
      ['pirate-ship.theme.json', 'Pirate ship', false],
    ]);
    assert.equal(s.userThemesTruncated, false);
    assert.equal(s.make?.skill, 'outdated');
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.path, '~/.middle-management/themes/bakery.theme.json');

    // A built-in or preset source marks nothing.
    h.setUser('themeFile', undefined);
    await h.load();
    assert.ok(h.fd.buildState().userThemes?.every((t) => !t.current));
  } finally {
    await cleanup(h);
  }
});

test('themeAction useUserTheme: writes ~/.middle-management/themes/<file> to the user setting, reloads and replies with the state', async () => {
  const h = await harness();
  try {
    await addUserTheme(h, 'pirate-ship.theme.json', { name: 'Pirate ship', company: 'Salty Co' });
    const out = await h.send({ type: 'themeAction', reqId: 'r-use', action: 'useUserTheme', themeId: 'pirate-ship.theme.json' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, true);
    assert.equal(h.config['themeFile']?.globalValue, '~/.middle-management/themes/pirate-ship.theme.json');
    const s = stateOf(out);
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.editable, true);
    assert.equal(h.fd.buildState().settings.companyName.themeValue, 'Salty Co', 'the theme was reloaded');
    assert.deepEqual(s.userThemes?.map((t) => [t.id, t.current]), [['pirate-ship.theme.json', true]]);
  } finally {
    await cleanup(h);
  }
});

test("themeAction useUserTheme: a name the scan does not know, or no name, is refused with 'isn't in your themes folder'", async () => {
  const h = await harness();
  try {
    await addUserTheme(h, 'pirate-ship.theme.json');
    for (const themeId of ['gone.theme.json', '../escape.theme.json', undefined]) {
      const out = await h.send({ type: 'themeAction', reqId: 'r-use', action: 'useUserTheme', ...(themeId === undefined ? {} : { themeId }) });
      assert.deepEqual(types(out), ['frontDeskDone'], String(themeId));
      assert.equal(doneOf(out).ok, false);
      assert.equal(doneOf(out).message, "That theme isn't in your themes folder any more.");
    }
    assert.equal(h.config['themeFile'], undefined, 'nothing was written');

    // A file deleted after the last scan is caught by the rescan the action does first.
    await h.send({ type: 'getFrontDesk', reqId: 'r-get' });
    await fs.unlink(path.join(h.themesDir, 'pirate-ship.theme.json'));
    const out = await h.send({ type: 'themeAction', reqId: 'r-use', action: 'useUserTheme', themeId: 'pirate-ship.theme.json' });
    assert.equal(doneOf(out).ok, false);
    assert.equal(h.config['themeFile'], undefined);
  } finally {
    await cleanup(h);
  }
});

test('themeAction useUserTheme: refused while the workspace sets the theme path', async () => {
  const h = await harness();
  try {
    await addUserTheme(h, 'pirate-ship.theme.json');
    h.setWorkspace('themeFile', './ws.theme.json');
    const out = await h.send({ type: 'themeAction', reqId: 'r-use', action: 'useUserTheme', themeId: 'pirate-ship.theme.json' });
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.match(doneOf(out).message ?? '', /This workspace sets the theme file/);
    assert.equal(h.config['themeFile']?.globalValue, undefined);
  } finally {
    await cleanup(h);
  }
});

test('themeAction openThemesFolder: creates the folder and opens it', async () => {
  const h = await harness();
  try {
    const out = await h.send({ type: 'themeAction', reqId: 'r-folder', action: 'openThemesFolder' });
    assert.deepEqual(out, [{ type: 'frontDeskDone', reqId: 'r-folder', ok: true }]);
    assert.deepEqual(h.folder.opened, [h.themesDir]);
    assert.ok((await fs.stat(h.themesDir)).isDirectory());
  } finally {
    await cleanup(h);
  }
});

test('themeAction openThemesFolder: when the folder cannot be opened the message holds the ~ path', async () => {
  const h = await harness();
  try {
    h.folder.answer = false;
    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'openThemesFolder' });
    assert.equal(doneOf(out).ok, false);
    assert.ok(doneOf(out).message?.includes(tilde('.middle-management', 'themes')), doneOf(out).message);
    assert.ok(!doneOf(out).message?.includes(h.home), 'the home folder is shortened');

    h.folder.answer = new Error(`no file manager at ${h.dir}`);
    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'openThemesFolder' });
    assert.equal(doneOf(out).ok, false);
    assert.ok(doneOf(out).message?.includes(tilde('.middle-management', 'themes')));
    assert.ok(!h.logs.join('\n').includes(h.dir), 'the error text (which holds a path) is not logged');
  } finally {
    await cleanup(h);
  }
});

test('themeAction installSkill and removeSkill: call the skill, refresh the cached status and reply with the state', async () => {
  const h = await harness();
  try {
    h.skill.status = 'missing';
    await h.send({ type: 'getFrontDesk', reqId: 'r0' });
    assert.equal(h.fd.buildState().make?.skill, 'missing');

    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'installSkill' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, true);
    assert.equal(stateOf(out).make?.skill, 'installed');
    assert.equal(h.fd.buildState().make?.skill, 'installed');

    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'removeSkill' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, true);
    assert.equal(stateOf(out).make?.skill, 'missing');
    assert.deepEqual(h.skill.calls, ['install', 'remove']);
  } finally {
    await cleanup(h);
  }
});

test("themeAction installSkill: a refusal passes the skill's message through, with the state as it now is", async () => {
  const h = await harness();
  try {
    const message = '~/.claude/skills/middle-management-theme already exists and was not created by Middle Management, so it was left alone.';
    h.skill.status = 'foreign';
    h.skill.installResult = { ok: false, message };
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'installSkill' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.equal(doneOf(out).message, message);
    assert.equal(stateOf(out).make?.skill, 'foreign');

    h.skill.removeResult = { ok: false, message: 'Could not remove the skill.' };
    const rm = await h.send({ type: 'themeAction', reqId: 'r2', action: 'removeSkill' });
    assert.equal(doneOf(rm).message, 'Could not remove the skill.');
    assert.ok(!h.logs.join('\n').includes('left alone'), 'the skill message is not logged');
  } finally {
    await cleanup(h);
  }
});

test('refreshSkill: pushes the state only when the status changed', async () => {
  const h = await harness();
  try {
    h.skill.status = 'installed';
    const first = h.posted.length;
    await h.fd.refreshSkill();
    assert.equal(h.posted.length, first + 1);
    const push = h.posted[first] as FrontDeskMsg;
    assert.equal(push.type, 'frontDesk');
    assert.equal(push.reqId, undefined);
    assert.equal(push.state.make?.skill, 'installed');
    await h.fd.refreshSkill();
    assert.equal(h.posted.length, first + 1, 'unchanged: no push');
  } finally {
    await cleanup(h);
  }
});

test('themeAction copyPrompt: writes the prompt with the themes folder and the shipped file paths to the clipboard', async () => {
  const h = await harness();
  try {
    const out = await h.send({ type: 'themeAction', reqId: 'r-copy', action: 'copyPrompt' });
    assert.deepEqual(out, [{ type: 'frontDeskDone', reqId: 'r-copy', ok: true }]);
    assert.deepEqual(h.clipboard, [themePromptText({ themesDir: h.themesDir, ...themePromptPaths(EXTENSION_DIR) })]);
    assert.ok(h.clipboard[0]?.includes(path.join(EXTENSION_DIR, 'media', 'theme-guide.md')));
    assert.ok(h.clipboard[0]?.includes(h.themesDir));

    h.deps.writeClipboard = async () => {
      throw new Error(`clipboard ${h.dir}`);
    };
    const bad = await h.send({ type: 'themeAction', reqId: 'r-bad', action: 'copyPrompt' });
    assert.equal(doneOf(bad).ok, false);
    assert.ok(!h.logs.join('\n').includes(h.dir));
  } finally {
    await cleanup(h);
  }
});

test('themeAction: choose and useBuiltin are refused while the workspace sets the theme path', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('ws.json', THEME_TEXT, 'workspace');
    h.config['themeFile'] = { ...h.config['themeFile'], globalValue: p };
    h.openAnswers.push(path.join(h.home, 'other.json'));
    for (const action of ['choose', 'useBuiltin'] as const) {
      const out = await h.send({ type: 'themeAction', reqId: `r-${action}`, action });
      assert.deepEqual(types(out), ['frontDeskDone']);
      assert.equal(doneOf(out).ok, false);
      assert.match(doneOf(out).message ?? '', /workspace settings/);
    }
    assert.equal(h.config['themeFile']?.globalValue, p, 'the user setting was not touched');
    assert.equal(h.openAnswers.length, 1, 'no file dialog was shown');
  } finally {
    await cleanup(h);
  }
});

test('state: a workspace folder value counts as workspace scope too', async () => {
  const h = await harness();
  try {
    const p = path.join(h.dir, 'f.json');
    await fs.writeFile(p, THEME_TEXT);
    h.config['themeFile'] = { workspaceFolderValue: p };
    await h.load();
    assert.equal(h.fd.buildState().source.fromWorkspace, true);
    assert.equal(h.fd.buildState().source.readOnly, 'workspace');
  } finally {
    await cleanup(h);
  }
});

test('state: settings source, userValue and workspaceWins', async () => {
  const h = await harness();
  try {
    h.config['companyName'] = { defaultValue: 'Middle Management', globalValue: 'Mine' };
    h.config['branchName'] = { defaultValue: 'Riverside Branch', globalValue: 'Mine', workspaceValue: 'Theirs' };
    h.config['managerName'] = { defaultValue: 'You', workspaceFolderValue: 'Folder', workspaceValue: 'Ws' };
    h.config['speechBubbles'] = { defaultValue: true, globalValue: false };
    h.config['scope'] = { defaultValue: 'workspace', globalValue: 'bogus' };
    const s = h.fd.buildState().settings;
    assert.deepEqual(s.companyName, { value: 'Mine', source: 'user', userValue: 'Mine', workspaceWins: false });
    assert.deepEqual(s.branchName, { value: 'Theirs', source: 'workspace', userValue: 'Mine', workspaceWins: true });
    assert.deepEqual(s.managerName, { value: 'Folder', source: 'workspace', workspaceWins: true });
    assert.deepEqual(s.speechBubbles, { value: false, source: 'user', userValue: false, workspaceWins: false });
    assert.deepEqual(s.scope, { value: 'workspace', source: 'default', workspaceWins: false }, 'a bad stored value counts as unset');
  } finally {
    await cleanup(h);
  }
});

test('state: themeValue shows the names the theme sets, and only for a theme source', async () => {
  const h = await harness();
  try {
    await h.useFile('named.json', JSON.stringify({ company: 'Theme Co', branch: 'Theme Branch', manager: { name: 'Theme Boss' } }));
    const s = h.fd.buildState().settings;
    assert.equal(s.companyName.themeValue, 'Theme Co');
    assert.equal(s.branchName.themeValue, 'Theme Branch');
    assert.equal(s.managerName.themeValue, 'Theme Boss');
    assert.equal(s.speechBubbles.themeValue, undefined);
    assert.equal(s.companyName.value, 'Middle Management', 'value is still the setting, not the theme');
    // A theme without those names.
    await h.useFile('plain.json', JSON.stringify({ staff: [{ name: 'A' }] }));
    assert.equal(h.fd.buildState().settings.companyName.themeValue, undefined);
    // Back to the built-in office: nothing from the theme.
    await h.send({ type: 'themeAction', reqId: 'r2', action: 'useBuiltin' });
    assert.equal(h.fd.buildState().settings.companyName.themeValue, undefined);
  } finally {
    await cleanup(h);
  }
});

// ---- theme actions ------------------------------------------------------------------------------------------------

test('themeAction create: starter theme via a Save dialog, user setting, opened in the editor', async () => {
  const h = await harness();
  try {
    const p = path.join(h.home, 'mine.theme.json');
    h.saveAnswers.push(p);
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'create' });
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, true);
    const text = await fs.readFile(p, 'utf8');
    assert.ok(parseTheme(JSON.parse(text)).errors.length === 0);
    assert.equal((JSON.parse(text) as Record<string, unknown>)['$schema'], undefined, '*.theme.json is covered by jsonValidation, so no $schema is written');
    assert.equal(h.config['themeFile']?.globalValue, p);
    assert.deepEqual(h.opened, [p]);
    const s = stateOf(out);
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.rev, revisionOf(text));
    assert.equal(s.source.editable, true);
    assert.equal(h.overwrite.asked, 0);
  } finally {
    await cleanup(h);
  }
});

test('themeAction create: cancel changes nothing, a declined overwrite keeps the old file, a non-.json name is refused', async () => {
  const h = await harness();
  try {
    h.saveAnswers.push(undefined);
    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'create' });
    assert.deepEqual(out, [{ type: 'frontDeskDone', reqId: 'r1', ok: true, cancelled: true }]);
    assert.equal(h.config['themeFile'], undefined);

    const existing = path.join(h.home, 'exists.json');
    await fs.writeFile(existing, 'precious');
    h.saveAnswers.push(existing);
    h.overwrite.answer = false;
    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'create' });
    assert.equal(h.overwrite.asked, 1);
    assert.equal(doneOf(out).cancelled, true);
    assert.equal(await fs.readFile(existing, 'utf8'), 'precious');
    assert.equal(h.config['themeFile'], undefined);

    h.saveAnswers.push(path.join(h.home, 'notes.txt'));
    out = await h.send({ type: 'themeAction', reqId: 'r3', action: 'create' });
    assert.equal(doneOf(out).ok, false);
    assert.match(doneOf(out).message ?? '', /\.json/);
    await assert.rejects(fs.stat(path.join(h.home, 'notes.txt')));
  } finally {
    await cleanup(h);
  }
});

test('themeAction choose: an Open dialog sets the user setting, cancel does nothing', async () => {
  const h = await harness();
  try {
    const p = path.join(h.home, 'chosen.json');
    await fs.writeFile(p, THEME_TEXT);
    h.openAnswers.push(p);
    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'choose' });
    assert.equal(h.config['themeFile']?.globalValue, p);
    assert.equal(stateOf(out).source.kind, 'file');
    assert.equal(stateOf(out).source.rev, revisionOf(THEME_TEXT));
    assert.equal(doneOf(out).ok, true);

    h.openAnswers.push(undefined);
    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'choose' });
    assert.deepEqual(out, [{ type: 'frontDeskDone', reqId: 'r2', ok: true, cancelled: true }]);
    assert.equal(h.config['themeFile']?.globalValue, p);
  } finally {
    await cleanup(h);
  }
});

test('themeAction open: opens the file in an editor; the built-in office has none', async () => {
  const h = await harness();
  try {
    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'open' });
    assert.equal(doneOf(out).ok, false);
    assert.deepEqual(h.opened, []);
    const p = await h.useFile('o.json', THEME_TEXT);
    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'open' });
    assert.equal(doneOf(out).ok, true);
    assert.deepEqual(h.opened, [p]);
    // An editor that fails to open is an error reply, not a throw.
    h.deps.openFile = async () => {
      throw new Error('boom at ' + p);
    };
    out = await h.send({ type: 'themeAction', reqId: 'r3', action: 'open' });
    assert.equal(doneOf(out).ok, false);
    assert.ok(!h.logs.join('\n').includes(p));
  } finally {
    await cleanup(h);
  }
});

test('themeAction reload: re-reads the file and reports the new revision', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('r.json', THEME_TEXT);
    const changed = JSON.stringify({ company: 'Changed' });
    await fs.writeFile(p, changed);
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'reload' });
    assert.equal(stateOf(out).source.rev, revisionOf(changed));
    assert.equal(doneOf(out).ok, true);
  } finally {
    await cleanup(h);
  }
});

test('themeAction useBuiltin clears the user setting; usePreset sets preset:<id>', async () => {
  const h = await harness();
  try {
    await h.useFile('b.json', THEME_TEXT);
    let out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'usePreset', presetId: 'example' });
    assert.equal(h.config['themeFile']?.globalValue, 'preset:example');
    assert.equal(stateOf(out).source.kind, 'preset');
    assert.deepEqual(stateOf(out).source.errors, []);
    assert.equal(doneOf(out).ok, true);

    out = await h.send({ type: 'themeAction', reqId: 'r2', action: 'useBuiltin' });
    assert.equal(h.config['themeFile']?.globalValue, undefined);
    assert.equal(stateOf(out).source.kind, 'builtin');

    out = await h.send({ type: 'themeAction', reqId: 'r3', action: 'usePreset', presetId: 'nope' });
    assert.equal(doneOf(out).ok, false);
    assert.equal(h.config['themeFile']?.globalValue, undefined);
    out = await h.send({ type: 'themeAction', reqId: 'r4', action: 'usePreset' });
    assert.equal(doneOf(out).ok, false);
  } finally {
    await cleanup(h);
  }
});

test('themeAction: with a workspace theme path the user choice is stored and the reply says it is hidden', async () => {
  const h = await harness();
  try {
    await h.useFile('ws.json', THEME_TEXT, 'workspace');
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'usePreset', presetId: 'example' });
    assert.equal(h.config['themeFile']?.globalValue, 'preset:example');
    assert.equal(stateOf(out).source.fromWorkspace, true);
    assert.equal(doneOf(out).ok, true);
    assert.match(doneOf(out).message ?? '', /workspace/);
  } finally {
    await cleanup(h);
  }
});

test('themeAction copyPreset: writes the re-serialised preset to a new file and switches to it', async () => {
  const h = await harness();
  try {
    const p = path.join(h.home, 'copy.json');
    h.saveAnswers.push(p);
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'copyPreset', presetId: 'example' });
    assert.equal(doneOf(out).ok, true);
    const text = await fs.readFile(p, 'utf8');
    const original = JSON.parse(await fs.readFile(path.join(PRESET_DIR, 'example.theme.json'), 'utf8')) as OfficeTheme;
    const copy = JSON.parse(text) as OfficeTheme & Record<string, unknown>;
    assert.equal(copy['$schema'], undefined, 'the preset-relative $schema is not carried into the copy');
    assert.equal(copy.company, original.company);
    assert.equal(parseTheme(copy).errors.length, 0);
    assert.ok(text.endsWith('\n'));
    assert.equal(h.config['themeFile']?.globalValue, p);
    assert.equal(stateOf(out).source.kind, 'file');
    assert.equal(stateOf(out).source.editable, true);

    // Cancel, and an unknown preset.
    h.saveAnswers.push(undefined);
    const c = await h.send({ type: 'themeAction', reqId: 'r2', action: 'copyPreset', presetId: 'example' });
    assert.equal(doneOf(c).cancelled, true);
    const u = await h.send({ type: 'themeAction', reqId: 'r3', action: 'copyPreset', presetId: 'nope' });
    assert.equal(doneOf(u).ok, false);
  } finally {
    await cleanup(h);
  }
});

test('themeAction create and copyPreset: the Save dialog (and Save as) starts in the themes folder, which is created first', async () => {
  const h = await harness();
  try {
    h.saveAnswers.push(undefined, undefined);
    await h.send({ type: 'themeAction', reqId: 'r1', action: 'create' });
    await h.send({ type: 'themeAction', reqId: 'r2', action: 'copyPreset', presetId: 'spaceship' });
    assert.deepEqual(h.dialogs.map((d) => d.defaultPath), [path.join(h.themesDir, 'my-office.theme.json'), path.join(h.themesDir, 'spaceship-copy.theme.json')]);
    assert.ok((await fs.stat(h.themesDir)).isDirectory());

    // saveThemeAs (Save as from the editor) starts in the themes folder too: my-office.theme.json without a current file...
    h.saveAnswers.push(undefined, undefined);
    await h.send({ type: 'saveThemeAs', reqId: 'r3', themeJson: JSON.stringify({ company: 'X' }) });
    assert.equal(h.dialogs[2]?.defaultPath, path.join(h.themesDir, 'my-office.theme.json'));
    // ...and the current file's name with one.
    await h.useFile('current.theme.json', THEME_TEXT);
    await h.send({ type: 'saveThemeAs', reqId: 'r4', themeJson: JSON.stringify({ company: 'X' }) });
    assert.equal(h.dialogs[3]?.defaultPath, path.join(h.themesDir, 'current.theme.json'));
  } finally {
    await cleanup(h);
  }
});

test('themeAction copyPreset: the copy is named "<label> (my copy)" and shows up in the list', async () => {
  const h = await harness();
  try {
    const p = path.join(h.themesDir, 'spaceship-copy.theme.json');
    h.saveAnswers.push(p);
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'copyPreset', presetId: 'spaceship' });
    assert.equal(doneOf(out).ok, true);
    const copy = JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, unknown>;
    assert.equal(copy['name'], 'Spaceship (my copy)');
    assert.equal(Object.keys(copy)[0], 'name', 'the canonical order is kept');
    assert.equal(parseTheme(copy).errors.length, 0);
    assert.deepEqual(stateOf(out).userThemes?.map((t) => [t.id, t.label, t.current]), [['spaceship-copy.theme.json', 'Spaceship (my copy)', true]]);
  } finally {
    await cleanup(h);
  }
});

test('saveThemeAs into the themes folder: the saved theme is listed (and marked in use) in the reply', async () => {
  const h = await harness();
  try {
    const p = path.join(h.themesDir, 'saved.theme.json');
    h.saveAnswers.push(p);
    const out = await h.send({ type: 'saveThemeAs', reqId: 'r1', themeJson: JSON.stringify({ name: 'Saved one', company: 'X' }) });
    assert.equal(doneOf(out).ok, true);
    assert.deepEqual(stateOf(out).userThemes?.map((t) => [t.id, t.label, t.current]), [['saved.theme.json', 'Saved one', true]]);
  } finally {
    await cleanup(h);
  }
});

// ---- setSetting ---------------------------------------------------------------------------------------------------

test('setSetting writes the user value, then replies settings, frontDesk, frontDeskDone', async () => {
  const h = await harness();
  try {
    const out = await h.send({ type: 'setSetting', reqId: 'r1', key: 'speechBubbles', value: false });
    assert.deepEqual(types(out), ['settings', 'frontDesk', 'frontDeskDone']);
    assert.equal(h.config['speechBubbles']?.globalValue, false);
    assert.equal(h.config['speechBubbles']?.workspaceValue, undefined);
    assert.deepEqual(stateOf(out).settings.speechBubbles, { value: false, source: 'user', userValue: false, workspaceWins: false });
    assert.equal((out[1] as FrontDeskMsg).reqId, 'r1');
    assert.deepEqual(out[2], { type: 'frontDeskDone', reqId: 'r1', ok: true });

    await h.send({ type: 'setSetting', reqId: 'r2', key: 'scope', value: 'workspace' });
    assert.equal(h.config['scope']?.globalValue, 'workspace');
    await h.send({ type: 'setSetting', reqId: 'r2b', key: 'mode', value: 'view' });
    assert.equal(h.config['mode']?.globalValue, 'view');
    await h.send({ type: 'setSetting', reqId: 'r3', key: 'companyName', value: 'Acme' });
    assert.equal(h.config['companyName']?.globalValue, 'Acme');
  } finally {
    await cleanup(h);
  }
});

test('setSetting: null resets, an empty company or manager name resets, an empty branch name is kept', async () => {
  const h = await harness();
  try {
    h.setUser('companyName', 'Acme');
    h.setUser('managerName', 'Boss');
    h.setUser('branchName', 'Somewhere');
    h.setUser('bossQuotes', false);
    await h.send({ type: 'setSetting', reqId: 'r1', key: 'bossQuotes', value: null });
    assert.equal(h.config['bossQuotes']?.globalValue, undefined);
    await h.send({ type: 'setSetting', reqId: 'r2', key: 'companyName', value: '' });
    assert.equal(h.config['companyName']?.globalValue, undefined);
    await h.send({ type: 'setSetting', reqId: 'r3', key: 'managerName', value: '' });
    assert.equal(h.config['managerName']?.globalValue, undefined);
    await h.send({ type: 'setSetting', reqId: 'r4', key: 'branchName', value: '' });
    assert.equal(h.config['branchName']?.globalValue, '');
    assert.equal(h.fd.buildState().settings.branchName.value, '');
    assert.equal(h.fd.buildState().settings.branchName.userValue, '');
    await h.send({ type: 'setSetting', reqId: 'r5', key: 'branchName', value: null });
    assert.equal(h.config['branchName']?.globalValue, undefined);
  } finally {
    await cleanup(h);
  }
});

test('setSetting: when a workspace value wins the user value is still written and workspaceWins shows it', async () => {
  const h = await harness();
  try {
    h.config['companyName'] = { defaultValue: 'Middle Management', workspaceValue: 'Repo Co' };
    const out = await h.send({ type: 'setSetting', reqId: 'r1', key: 'companyName', value: 'Mine' });
    assert.equal(h.config['companyName']?.globalValue, 'Mine');
    assert.equal(h.config['companyName']?.workspaceValue, 'Repo Co');
    assert.deepEqual(stateOf(out).settings.companyName, { value: 'Repo Co', source: 'workspace', userValue: 'Mine', workspaceWins: true });
    assert.equal(doneOf(out).ok, true);
  } finally {
    await cleanup(h);
  }
});

test('setSetting: wrong types, unknown keys, long text and a failing write are refused without a state push', async () => {
  const h = await harness();
  try {
    const bad: [string, string | boolean | null][] = [
      ['speechBubbles', 'true'],
      ['scope', 'everywhere'],
      ['usageChecks', true],
      ['updateChecks', 'daily'],
      ['mode', 'watch'],
      ['companyName', false],
      ['companyName', 'x'.repeat(LIMITS.settingChars + 1)],
    ];
    for (const [key, value] of bad) {
      const out = await h.send({ type: 'setSetting', reqId: 'r1', key: key as FrontDeskSettingKey, value });
      assert.deepEqual(types(out), ['frontDeskDone'], `${key}=${String(value)}`);
      assert.equal(doneOf(out).ok, false);
    }
    const unknown = await h.send({ type: 'setSetting', reqId: 'r2', key: 'themeFile' as FrontDeskSettingKey, value: '/etc/passwd' });
    assert.equal(doneOf(unknown).ok, false);
    assert.equal(h.config['themeFile'], undefined);
    assert.equal(h.config['speechBubbles'], undefined);
    h.deps.updateGlobal = async () => {
      throw new Error('read-only settings file ' + h.dir);
    };
    const failed = await h.send({ type: 'setSetting', reqId: 'r3', key: 'scope', value: 'all' });
    assert.deepEqual(types(failed), ['frontDeskDone']);
    assert.equal(doneOf(failed).ok, false);
    assert.ok(!h.logs.join('\n').includes(h.dir));
  } finally {
    await cleanup(h);
  }
});

test('openSettingsUi calls the opener with the key and target, and sends no reply', async () => {
  const h = await harness();
  try {
    const out = await h.send({ type: 'openSettingsUi', key: 'companyName', target: 'workspace' });
    assert.deepEqual(out, []);
    await h.send({ type: 'openSettingsUi', key: 'scope', target: 'user' });
    assert.deepEqual(h.settingsUi, [
      { key: 'companyName', target: 'workspace' },
      { key: 'scope', target: 'user' },
    ]);
    await h.send({ type: 'openSettingsUi', key: 'themeFile', target: 'workspace' });
    assert.equal(h.settingsUi.length, 3, 'themeFile is allowed');
    await h.send({ type: 'openSettingsUi', key: 'claudePath' as FrontDeskSettingKey, target: 'user' });
    assert.equal(h.settingsUi.length, 3, 'other keys are not');
    h.deps.openSettingsUi = async () => {
      throw new Error('no such command');
    };
    assert.deepEqual(await h.send({ type: 'openSettingsUi', key: 'scope', target: 'user' }), []);
  } finally {
    await cleanup(h);
  }
});

test('handles() is true for the six front desk messages (and openSettingsUi) only', async () => {
  const h = await harness();
  try {
    assert.equal(h.fd.handles({ type: 'getFrontDesk', reqId: 'r' }), true);
    assert.equal(h.fd.handles({ type: 'openSettingsUi', key: 'scope', target: 'user' }), true);
    assert.equal(h.fd.handles({ type: 'saveThemeAs', reqId: 'r', themeJson: '{}' }), true);
    assert.equal(h.fd.handles({ type: 'ready' }), false);
    assert.equal(h.fd.handles({ type: 'listProjects' }), false);
  } finally {
    await cleanup(h);
  }
});

test('pushState sends a frontDesk without a reqId', async () => {
  const h = await harness();
  try {
    h.fd.pushState();
    assert.equal(h.posted.length, 1);
    assert.equal((h.posted[0] as FrontDeskMsg).reqId, undefined);
  } finally {
    await cleanup(h);
  }
});

// ---- saveTheme ----------------------------------------------------------------------------------------------------

test('saveTheme: writes the re-parsed theme, keeps $schema, and replies settings, frontDesk, frontDeskDone with the new rev', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('save.json', THEME_TEXT);
    const oldRev = h.fd.buildState().source.rev ?? '';
    const out = await h.send(save(oldRev, NEW_THEME));
    assert.deepEqual(types(out), ['settings', 'frontDesk', 'frontDeskDone']);
    assert.deepEqual(out[2], { type: 'frontDeskDone', reqId: 'r1', ok: true });
    assert.equal((out[1] as FrontDeskMsg).reqId, 'r1');
    const text = await fs.readFile(p, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    assert.equal(written['$schema'], 'file:///kept/schema.json');
    assert.equal(written['company'], 'New Co');
    assert.equal(written['manager'], undefined, 'only the saved theme is written');
    assert.ok(text.endsWith('\n'));
    const s = stateOf(out);
    assert.equal(s.source.rev, revisionOf(text));
    assert.notEqual(s.source.rev, oldRev);
    assert.equal(s.source.editable, true);
    assert.equal(s.settings.companyName.themeValue, 'New Co');
    assert.deepEqual((await fs.readdir(h.dir)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');

    // The new rev works for the next save.
    const again = await h.send(save(s.source.rev ?? '', { company: 'Third' }));
    assert.equal(doneOf(again).ok, true);
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a symlinked theme file stays a link and updates its .json target', async () => {
  const h = await harness();
  try {
    const target = path.join(h.dir, 'real.json');
    await fs.writeFile(target, THEME_TEXT);
    const link = path.join(h.dir, 'link.json');
    await fs.symlink(target, link);
    h.setUser('themeFile', link);
    await h.load();
    const out = await h.send(save(h.fd.buildState().source.rev ?? '', NEW_THEME));
    assert.equal(doneOf(out).ok, true);
    assert.ok((await fs.lstat(link)).isSymbolicLink());
    assert.equal((JSON.parse(await fs.readFile(target, 'utf8')) as { company: string }).company, 'New Co');
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a changed file is a conflict (state pushed with the current rev), and force overwrites it', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('c.json', THEME_TEXT);
    const oldRev = h.fd.buildState().source.rev ?? '';
    const external = JSON.stringify({ company: 'Edited elsewhere' });
    await fs.writeFile(p, external);
    const out = await h.send(save(oldRev, NEW_THEME));
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.equal(doneOf(out).conflict, true);
    assert.ok((doneOf(out).message ?? '') !== '');
    assert.equal(stateOf(out).source.rev, revisionOf(external));
    assert.equal((out[0] as FrontDeskMsg).reqId, 'r1');
    assert.equal(await fs.readFile(p, 'utf8'), external, 'a conflict writes nothing');

    // Overwrite anyway: same save with the new rev and force.
    const forced = await h.send(save(revisionOf(external), NEW_THEME, true));
    assert.deepEqual(types(forced), ['settings', 'frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(forced).ok, true);
    assert.equal((JSON.parse(await fs.readFile(p, 'utf8')) as { company: string }).company, 'New Co');
    // Even the old rev does not stop a forced save.
    await fs.writeFile(p, JSON.stringify({ company: 'Again' }));
    assert.equal(doneOf(await h.send(save(oldRev, NEW_THEME, true))).ok, true);
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a file deleted since the load is a conflict with a "missing" state; force recreates it', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('m.json', THEME_TEXT);
    const rev = h.fd.buildState().source.rev ?? '';
    await fs.unlink(p);
    const out = await h.send(save(rev, NEW_THEME));
    assert.deepEqual(types(out), ['frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).conflict, true);
    assert.equal(doneOf(out).ok, false);
    const s = stateOf(out);
    assert.equal(s.source.exists, false);
    assert.equal(s.source.readOnly, 'missing');
    assert.equal(s.source.rev, undefined);
    await assert.rejects(fs.stat(p));

    const forced = await h.send(save(rev, NEW_THEME, true));
    assert.equal(doneOf(forced).ok, true);
    const written = JSON.parse(await fs.readFile(p, 'utf8')) as { $schema?: string; company: string };
    assert.equal(written.company, 'New Co');
    assert.equal(written.$schema, undefined, 'a recreated file gets no absolute schema path');
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a symlink whose target is not a .json file is refused', async () => {
  const h = await harness();
  try {
    const target = path.join(h.dir, 'notes.txt');
    await fs.writeFile(target, THEME_TEXT);
    const link = path.join(h.dir, 'theme.json');
    await fs.symlink(target, link);
    h.setUser('themeFile', link);
    await h.load();
    const s = h.fd.buildState();
    assert.equal(s.source.editable, true, 'the state only sees the configured name');
    const out = await h.send(save(s.source.rev ?? '', NEW_THEME));
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.match(doneOf(out).message ?? '', /\.json/);
    assert.equal(await fs.readFile(target, 'utf8'), THEME_TEXT);
    assert.ok((await fs.lstat(link)).isSymbolicLink());
    assert.ok(!h.logs.join('\n').includes(target));
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a file that is not a JSON object is never overwritten', async () => {
  const h = await harness();
  try {
    for (const [name, text] of [['arr.json', '[1, 2, 3]'], ['broken.json', '{ "company": '], ['empty.json', '']] as const) {
      const p = await h.useFile(name, text);
      const rev = h.fd.buildState().source.rev ?? revisionOf(text);
      const out = await h.send(save(rev, NEW_THEME));
      assert.deepEqual(types(out), ['frontDeskDone'], name);
      assert.equal(doneOf(out).ok, false, name);
      assert.equal(doneOf(out).conflict, undefined, name);
      assert.equal(await fs.readFile(p, 'utf8'), text, name);
      const forced = await h.send(save(rev, NEW_THEME, true));
      assert.equal(doneOf(forced).ok, false, `${name}: force never overrides notObject`);
      assert.equal(await fs.readFile(p, 'utf8'), text, name);
    }
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: a non-.json file name is refused', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('theme.txt', THEME_TEXT);
    assert.equal(h.fd.buildState().source.readOnly, 'notJson');
    const out = await h.send(save(h.fd.buildState().source.rev ?? '', NEW_THEME, true));
    assert.equal(doneOf(out).ok, false);
    assert.equal(await fs.readFile(p, 'utf8'), THEME_TEXT);
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: text that is not JSON, or a theme with problems, is refused and nothing is written', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('v.json', THEME_TEXT);
    const rev = h.fd.buildState().source.rev ?? '';
    const notJson = await h.send({ type: 'saveTheme', reqId: 'r1', rev, themeJson: '{ nope' });
    assert.deepEqual(types(notJson), ['frontDeskDone']);
    assert.equal(doneOf(notJson).ok, false);
    const invalid = await h.send(save(rev, { company: 12345, staff: 'nope' }));
    assert.deepEqual(types(invalid), ['frontDeskDone']);
    assert.equal(doneOf(invalid).ok, false);
    assert.match(doneOf(invalid).message ?? '', /problem/);
    const huge = await h.send({ type: 'saveTheme', reqId: 'r3', rev, themeJson: ' '.repeat(LIMITS.themeJsonChars + 1) });
    assert.equal(doneOf(huge).ok, false);
    assert.equal(await fs.readFile(p, 'utf8'), THEME_TEXT);
  } finally {
    await cleanup(h);
  }
});

test('saveTheme on the built-in office or the example office is refused (the panel turns Save into Save as)', async () => {
  const h = await harness();
  try {
    let out = await h.send(save('0123456789abcdef', NEW_THEME));
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.equal(doneOf(out).conflict, undefined);
    h.setUser('themeFile', 'preset:example');
    await h.load();
    const before = await fs.readFile(path.join(PRESET_DIR, 'example.theme.json'), 'utf8');
    out = await h.send(save('0123456789abcdef', NEW_THEME, true));
    assert.equal(doneOf(out).ok, false);
    assert.match(doneOf(out).message ?? '', /read-only|copy/i);
    assert.equal(await fs.readFile(path.join(PRESET_DIR, 'example.theme.json'), 'utf8'), before);
  } finally {
    await cleanup(h);
  }
});

test('saveTheme: two saves with the same rev never both win', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('race.json', THEME_TEXT);
    const rev = h.fd.buildState().source.rev ?? '';
    await Promise.all([h.fd.handle(save(rev, { company: 'A' })), h.fd.handle(save(rev, { company: 'B' }))]);
    const results = h.posted.filter((m): m is DoneMsg => m.type === 'frontDeskDone');
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.conflict === true).length, 1);
    assert.match(await fs.readFile(p, 'utf8'), /"company": "[AB]"/);
  } finally {
    await cleanup(h);
  }
});

// ---- saveThemeAs --------------------------------------------------------------------------------------------------

test('saveThemeAs: Save dialog, new file, user setting switched, replies settings, frontDesk, frontDeskDone', async () => {
  const h = await harness();
  try {
    const p = path.join(h.home, 'as.json');
    h.saveAnswers.push(p);
    const out = await h.send({ type: 'saveThemeAs', reqId: 'r1', themeJson: JSON.stringify(NEW_THEME) });
    assert.deepEqual(types(out), ['settings', 'frontDesk', 'frontDeskDone']);
    assert.equal(doneOf(out).ok, true);
    const text = await fs.readFile(p, 'utf8');
    const written = JSON.parse(text) as { $schema?: string; company: string };
    assert.equal(written.company, 'New Co');
    assert.equal(written.$schema, undefined);
    assert.equal(h.config['themeFile']?.globalValue, p);
    const s = stateOf(out);
    assert.equal(s.source.kind, 'file');
    assert.equal(s.source.path, tilde('as.json'));
    assert.equal(s.source.rev, revisionOf(text));
    assert.equal(s.source.editable, true);
    assert.equal(h.overwrite.asked, 0, 'the dialog already asked');

    // Saving over an existing file the dialog confirmed: no rev check for a chosen file.
    await fs.writeFile(p, 'old stuff');
    h.saveAnswers.push(p);
    const again = await h.send({ type: 'saveThemeAs', reqId: 'r2', themeJson: JSON.stringify({ company: 'Second' }) });
    assert.equal(doneOf(again).ok, true);
    assert.equal((JSON.parse(await fs.readFile(p, 'utf8')) as { company: string }).company, 'Second');
  } finally {
    await cleanup(h);
  }
});

test('saveThemeAs: cancel, a non-.json name and an invalid theme', async () => {
  const h = await harness();
  try {
    h.saveAnswers.push(undefined);
    let out = await h.send({ type: 'saveThemeAs', reqId: 'r1', themeJson: JSON.stringify(NEW_THEME) });
    assert.deepEqual(out, [{ type: 'frontDeskDone', reqId: 'r1', ok: true, cancelled: true }]);
    assert.equal(h.config['themeFile'], undefined);

    h.saveAnswers.push(path.join(h.home, 'plain.txt'));
    out = await h.send({ type: 'saveThemeAs', reqId: 'r2', themeJson: JSON.stringify(NEW_THEME) });
    assert.equal(doneOf(out).ok, false);
    await assert.rejects(fs.stat(path.join(h.home, 'plain.txt')));

    // An invalid theme is refused before any dialog is shown (the queued answer stays unused).
    h.saveAnswers.push(path.join(h.home, 'never.json'));
    out = await h.send({ type: 'saveThemeAs', reqId: 'r3', themeJson: JSON.stringify({ company: 7 }) });
    assert.equal(doneOf(out).ok, false);
    out = await h.send({ type: 'saveThemeAs', reqId: 'r4', themeJson: 'not json' });
    assert.equal(doneOf(out).ok, false);
    assert.equal(h.saveAnswers.length, 1);
    assert.equal(h.config['themeFile'], undefined);
  } finally {
    await cleanup(h);
  }
});

test('saveThemeAs into a folder that does not exist fails cleanly', async () => {
  const h = await harness();
  try {
    h.saveAnswers.push(path.join(h.dir, 'no-such-folder', 'x.json'));
    const out = await h.send({ type: 'saveThemeAs', reqId: 'r1', themeJson: JSON.stringify(NEW_THEME) });
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.equal(h.config['themeFile'], undefined);
    assert.ok(!(doneOf(out).message ?? '').includes(h.dir));
  } finally {
    await cleanup(h);
  }
});

// ---- logging ------------------------------------------------------------------------------------------------------

test('logs hold request ids, action names, key names and lengths, never a path, value or theme text', async () => {
  const h = await harness();
  try {
    const p = await h.useFile('log.json', JSON.stringify({ company: SECRET }));
    const rev = h.fd.buildState().source.rev ?? '';
    await h.send({ type: 'getFrontDesk', reqId: 'q1' });
    await h.send({ type: 'setSetting', reqId: 'q2', key: 'companyName', value: SECRET });
    await h.send({ type: 'setSetting', reqId: 'q3', key: 'scope', value: 'workspace' });
    await h.send(save(rev, { company: SECRET }));
    await h.send({ type: 'saveTheme', reqId: 'q4', rev, themeJson: JSON.stringify({ company: SECRET, staff: 5 }) });
    h.saveAnswers.push(path.join(h.home, `${SECRET}.json`));
    await h.send({ type: 'saveThemeAs', reqId: 'q5', themeJson: JSON.stringify({ company: SECRET }) });
    h.saveAnswers.push(path.join(h.home, `${SECRET}-2.json`));
    await h.send({ type: 'themeAction', reqId: 'q6', action: 'create' });
    await h.send({ type: 'themeAction', reqId: 'q7', action: 'open' });
    await h.send({ type: 'openSettingsUi', key: 'companyName', target: 'user' });
    await fs.unlink(p).catch(() => undefined);
    await h.send(save(rev, { company: SECRET }));
    const log = h.logs.join('\n');
    assert.ok(h.logs.length > 5);
    assert.ok(!log.includes(h.dir), 'no path');
    assert.ok(!log.includes(os.tmpdir()), 'no path');
    assert.ok(!log.includes(SECRET), 'no value or theme text');
    assert.ok(!log.includes('workspace'), 'no setting value');
    assert.match(log, /setSetting req=q2 key=companyName len=13/);
    assert.match(log, /saveTheme req=r1 chars=\d+/);
    assert.match(log, /themeAction req=q6 action=create/);
  } finally {
    await cleanup(h);
  }
});

test('an unexpected failure inside a handler becomes frontDeskDone{ok:false} and logs only an error name', async () => {
  const h = await harness();
  try {
    h.deps.reloadNow = async () => {
      throw Object.assign(new Error(`EIO on ${h.dir}`), { code: 'EIO' });
    };
    const out = await h.send({ type: 'themeAction', reqId: 'r1', action: 'reload' });
    assert.deepEqual(types(out), ['frontDeskDone']);
    assert.equal(doneOf(out).ok, false);
    assert.ok(!h.logs.join('\n').includes(h.dir));
    assert.match(h.logs.join('\n'), /EIO/);
  } finally {
    await cleanup(h);
  }
});

test('state: rawText is the file text for a readable file, and absent for builtin, preset, missing and oversized files', async () => {
  const h = await harness();
  try {
    assert.equal(h.fd.buildState().source.rawText, undefined, 'builtin');
    const p = await h.useFile('raw.json', THEME_TEXT);
    assert.equal(h.fd.buildState().source.rawText, THEME_TEXT);
    // A broken file was still read, so its text is sent.
    await fs.writeFile(p, '{ nope');
    await h.load();
    assert.equal(h.fd.buildState().source.rawText, '{ nope');
    // Oversized: left out.
    await fs.writeFile(p, JSON.stringify({ company: 'x'.repeat(LIMITS.themeJsonChars) }));
    await h.load();
    assert.equal(h.fd.buildState().source.rawText, undefined, 'oversized');
    // At the limit exactly: kept.
    const pad = '{"company":"' + 'x'.repeat(LIMITS.themeJsonChars - 14) + '"}';
    assert.equal(pad.length, LIMITS.themeJsonChars);
    await fs.writeFile(p, pad);
    await h.load();
    assert.equal(h.fd.buildState().source.rawText, pad);
    // Missing.
    await fs.unlink(p);
    await h.load();
    assert.equal(h.fd.buildState().source.rawText, undefined, 'missing');
    // Preset.
    h.setUser('themeFile', 'preset:' + h.fd.buildState().presets[0]!.id);
    await h.send({ type: 'getFrontDesk', reqId: 'r1' });
    await h.load();
    const s = h.fd.buildState();
    assert.equal(s.source.kind, 'preset');
    assert.equal(s.source.rawText, undefined, 'preset');
  } finally {
    await cleanup(h);
  }
});

test("state: readOnly is 'notObject' for broken JSON and for an array file", async () => {
  const h = await harness();
  try {
    for (const [name, text] of [['arr.json', '[1, 2]'], ['broken.json', '{ "company": '], ['empty.json', '']] as const) {
      await h.useFile(name, text);
      const s = h.fd.buildState().source;
      assert.equal(s.readOnly, 'notObject', name);
      assert.equal(s.editable, false, name);
      assert.equal(s.exists, true, name);
    }
  } finally {
    await cleanup(h);
  }
});
