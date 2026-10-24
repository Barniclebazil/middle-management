// The mock extension host for the Front desk, shared by the panel playground (dev/panelsFrontDesk.ts) and the real-webview harness
// (dev/harness.ts): a fake FrontDeskState per source, delayed replies, a conflict on demand, and `settings` / `frontDesk` pushes after
// changes, in the real order (`settings`, then `frontDesk`, then `frontDeskDone`). It only talks through `listen()`, so the caller
// decides how messages reach the webview (a listener set, or `window.postMessage`).
//
// URL params it reads:
//   fd=builtin|preset|file|workspace|notObject|conflict|errors   what the host reports (default builtin)
//        workspace = the theme path is set by the workspace (read-only) and the workspace overrides some settings
//        notObject = the file is not a JSON object (read-only, using the last good theme)
//        conflict  = the first Save finds the file changed on disk
//        errors    = a file with problems; the office shows the last good theme
//   lag=<ms>        delay of every host reply (default 350)
//   savelag=<ms>   delay of the replies to saveTheme / saveThemeAs only (to see "Saving…")
//   fail=theme|save|setting   the host answers that call with an error
//   dialog=cancel   file dialogs are dismissed (cancelled)
//   diskchange=<ms> the file changes on disk this long after the first state (shows "changed on disk")
//   skill=missing|installed|outdated|modified|foreign|unknown   the state of the theme skill on the Make one with Claude card (default missing)
//   mine=0          the themes folder is empty (the Your offices empty state)
//   minemany=<n>    n themes in the folder instead of the three samples, and the "Showing the newest 50." note when n is over 50
// All names in it are made up.
import type { FrontDeskSettingKey, FrontDeskSetting, FrontDeskSource, FrontDeskState, FrontDeskUserTheme, HostToWebview, OfficeSettings, ThemeSkillStatus, WebviewToHost } from '../src/shared/protocol.ts';
import { parseTheme } from '../src/shared/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';

export type Scenario = 'builtin' | 'preset' | 'file' | 'workspace' | 'notObject' | 'conflict' | 'errors';
export const SCENARIOS: readonly Scenario[] = ['builtin', 'preset', 'file', 'workspace', 'notObject', 'conflict', 'errors'];

const EXAMPLE_THEME: OfficeTheme = { company: 'Example & Sons', branch: 'Head Office', manager: { name: 'Ms. Example' } };
const FILE_THEME: OfficeTheme = {
  company: 'Pennywhistle Paper', branch: 'Harbour', manager: { name: 'Alex Mercer' },
  receptionist: { name: 'Odette Marsh', look: { head: 'bob', hair: '#4a2c4f', outfit: 'blouse', shirt: '#e9f1ef', shortSleeves: true } },
  staff: [
    { name: 'Dana Whitcombe', role: 'Head of Accounts' },
    {},
    {
      name: 'Marta Quill', role: 'Printer Whisperer', pin: { project: 'print-queue' },
      look: { skin: 'brown', hair: '#2b1d1a', shirt: '#2f6f73', pants: '#3b3f4a' },
      lines: ['Have you tried turning the toner off and on again?', 'I named the scanner. It does not answer to it.'],
    },
  ],
  colors: { wall: '#cfe3e0', carpet: '#3f5f73', deskChairs: '#2f6f73' },
};
/** What the file on disk "changed to" for a conflict or a disk change. */
const DISK_THEME: OfficeTheme = { ...FILE_THEME, branch: 'Riverside' };

/** What the harness and the playground can tell the mock host about its surroundings. */
export interface MockHostOptions {
  /** Overrides `?fd=`. */
  scenario?: Scenario;
  presetTheme?: OfficeTheme;
  fileTheme?: OfficeTheme;
  /** Initial company, branch and manager name (the harness's `?company=`, `?branch=`, `?manager=`). */
  settings?: Partial<Pick<OfficeSettings, 'companyName' | 'branchName' | 'managerName'>>;
}

const SKILLS: readonly ThemeSkillStatus[] = ['missing', 'installed', 'outdated', 'modified', 'foreign', 'unknown'];
const THEMES_FOLDER = '~/.middle-management/themes';
const SKILL_FOLDER = '~/.claude/skills/middle-management-theme';
const USER_THEMES: FrontDeskUserTheme[] = [
  { id: 'pirate-ship.theme.json', label: 'Pirate ship', description: 'A creaky galleon where everyone talks like a pirate.', current: false, problems: false },
  { id: 'lighthouse-crew.theme.json', label: 'Lighthouse crew', description: 'Keepers on a rock in the sea, with a lamp room and a foghorn.', current: false, problems: false },
  { id: 'corner-bakery.theme.json', label: 'Corner bakery', description: 'Early starts, warm ovens and a queue out of the door.', current: false, problems: true },
];

const FILE_PATH = '~/offices/pennywhistle.theme.json';
const SAVED_PATH = '~/offices/my-office.theme.json';

function rev(n: number): string {
  return n.toString(16).padStart(16, '0');
}

/** A file text with an unknown key and loose formatting, so the "this will change" list has something to show. */
function messyFile(theme: OfficeTheme): string {
  return JSON.stringify({ ...theme, notes: 'my own notes', staff: theme.staff?.map((s) => ({ ...s, mood: 'happy' })) });
}

const PRESETS = [
  { id: 'example', label: 'Example office', description: 'A ready-made office with a named manager, receptionist and colours.' },
  { id: 'spaceship', label: 'Spaceship', description: 'A starship crew at their consoles, a galley, the bridge and a docking bay, in cool deck greys and teal.' },
  { id: 'construction-site', label: 'Construction Site', description: 'A hi-vis site crew in the cabins, a gatehouse sign-in and concrete, plywood and safety-orange colours.' },
  { id: 'metalwork-factory', label: 'Metalwork Factory', description: 'Welders, furnace keepers and a crane driver, a works gate and a soot, steel and ember colour scheme.' },
  { id: 'cyberpunk', label: 'Cyberpunk', description: 'A neon tower office in the endless rain: data brokers, drone couriers and a dark magenta and cyan palette.' },
  { id: 'steampunk', label: 'Steampunk', description: 'An airship and clockwork counting house: cog-wrights, a pneumatic post and brass, mahogany and baize.' },
];

function setting(value: string | boolean, over: Partial<FrontDeskSetting> = {}): FrontDeskSetting {
  return { value, source: 'default', workspaceWins: false, ...over };
}

function defaultSettings(mode: string): Record<FrontDeskSettingKey, FrontDeskSetting> {
  return {
    mode: setting(mode),
    companyName: setting('Middle Management'), branchName: setting(''), managerName: setting('You'),
    speechBubbles: setting(true), bossQuotes: setting(true), scope: setting('all'), usageChecks: setting('auto'), updateChecks: setting('auto'),
  };
}

/** The mock extension host. `send` delivers a host message to every listener (the panel's `onHost`). */
export class MockHost {
  readonly scenario: Scenario;
  private readonly lag: number;
  private readonly params: URLSearchParams;
  private readonly listeners = new Set<(msg: HostToWebview) => void>();
  private readonly log: (line: string) => void;
  private revNo = 1;
  private conflictLeft: boolean;
  private source: FrontDeskSource;
  theme: OfficeTheme | null;
  private settings: Record<FrontDeskSettingKey, FrontDeskSetting>;
  private diskTimer = false;
  /** The theme skill's state, changed by Teach Claude and Remove. */
  private skill: ThemeSkillStatus;
  /** The id of the themes-folder theme in use, if any. */
  private userThemeId: string | null = null;

  /** The theme `fd=preset` and "Use example office" load (the harness replaces it with the real packaged preset). */
  private presetTheme: OfficeTheme = EXAMPLE_THEME;
  /** The theme of the file scenarios (the harness can replace it with the file `?theme=<url>` names). */
  private fileTheme: OfficeTheme = FILE_THEME;

  constructor(params: URLSearchParams, log: (line: string) => void, opts: MockHostOptions = {}) {
    this.params = params;
    this.log = log;
    const asked = (opts.scenario ?? params.get('fd')) as Scenario | null;
    this.scenario = asked && SCENARIOS.includes(asked) ? asked : 'builtin';
    if (opts.presetTheme) this.presetTheme = opts.presetTheme;
    if (opts.fileTheme) this.fileTheme = opts.fileTheme;
    this.lag = Number.isFinite(Number(params.get('lag'))) && params.get('lag') !== null ? Number(params.get('lag')) : 350;
    this.conflictLeft = this.scenario === 'conflict';
    const skill = params.get('skill') as ThemeSkillStatus | null;
    this.skill = skill !== null && SKILLS.includes(skill) ? skill : 'missing';
    this.settings = defaultSettings(params.get('mode') === 'view' ? 'view' : 'manager');
    for (const k of ['companyName', 'branchName', 'managerName'] as const) {
      const v = opts.settings?.[k];
      if (typeof v === 'string') this.settings[k] = setting(v);
    }
    this.theme = null;
    this.source = { kind: 'builtin', label: 'Built-in office', fromWorkspace: false, exists: true, editable: false, readOnly: 'builtin', errors: [], usingLastGood: false };
    this.initScenario();
  }

  private fileSource(over: Partial<FrontDeskSource> = {}): FrontDeskSource {
    return {
      kind: 'file', label: 'pennywhistle.theme.json', path: FILE_PATH, fromWorkspace: false, exists: true, editable: true,
      rev: rev(this.revNo), rawText: messyFile(this.theme ?? {}), errors: [], usingLastGood: false, ...over,
    };
  }

  private initScenario(): void {
    switch (this.scenario) {
      case 'preset':
        this.theme = this.presetTheme;
        this.source = { kind: 'preset', presetId: 'example', label: 'Example office', fromWorkspace: false, exists: true, editable: false, readOnly: 'preset', errors: [], usingLastGood: false };
        break;
      case 'file':
      case 'conflict':
        this.theme = this.fileTheme;
        this.source = this.fileSource();
        this.settings.companyName = setting('Middle Management', { source: 'user', userValue: 'Middle Management', themeValue: 'Pennywhistle Paper' });
        this.settings.managerName = setting('You', { themeValue: 'Alex Mercer' });
        break;
      case 'workspace':
        this.theme = this.fileTheme;
        this.source = this.fileSource({ path: '~/work/repo/.office/theme.json', fromWorkspace: true, editable: false, readOnly: 'workspace', label: 'theme.json' });
        this.settings.companyName = setting('Acme Corp', { source: 'workspace', userValue: 'My Company', workspaceWins: true, themeValue: 'Pennywhistle Paper' });
        this.settings.branchName = setting('Harbour Branch', { source: 'workspace', workspaceWins: true });
        this.settings.managerName = setting('You', { themeValue: 'Alex Mercer' });
        this.settings.scope = setting('workspace', { source: 'workspace', workspaceWins: true, userValue: 'all' });
        this.settings.speechBubbles = setting(false, { source: 'user', userValue: false });
        break;
      case 'notObject':
        this.theme = this.fileTheme;
        this.source = this.fileSource({ editable: false, readOnly: 'notJson', rawText: '[1, 2, 3]', errors: ['theme: expected a JSON object'], usingLastGood: true });
        break;
      case 'errors':
        this.theme = this.fileTheme;
        this.source = this.fileSource({
          errors: [
            'staff[2].look.hair: expected a colour like #a1b2c3',
            'staff[4].name: must be at most 40 characters',
            'colors.wall: unknown colour "mauve"',
            'manager.look.head: unknown head style "bald"',
            'smallTalk[1]: expected a pair of two strings',
            'temps[0].look.skin: unknown skin tone "purple"',
          ],
          usingLastGood: true,
        });
        break;
      default:
        break;
    }
  }

  /** The themes folder's listing: none for `mine=0`, `minemany=<n>` generated ones, else the three samples. */
  private userThemes(): { themes: FrontDeskUserTheme[]; truncated: boolean } {
    const many = Number(this.params.get('minemany'));
    let all = this.params.get('mine') === '0' ? [] : USER_THEMES;
    if (Number.isFinite(many) && many > 0) all = Array.from({ length: many }, (_, i) => ({ id: `office-${i + 1}.theme.json`, label: `Office ${i + 1}`, current: false, problems: false }));
    const themes = all.slice(0, 50).map((t) => ({ ...t, current: t.id === this.userThemeId }));
    return { themes, truncated: all.length > themes.length };
  }

  state(): FrontDeskState {
    const mine = this.userThemes();
    return JSON.parse(JSON.stringify({
      source: this.source, presets: PRESETS, settings: this.settings,
      userThemes: mine.themes, ...(mine.truncated ? { userThemesTruncated: true } : {}),
      make: { themesFolder: THEMES_FOLDER, skillFolder: SKILL_FOLDER, skill: this.skill },
    })) as FrontDeskState;
  }

  officeSettings(): OfficeSettings {
    const s = this.settings;
    const out: OfficeSettings = {
      companyName: String(s.companyName.value), branchName: String(s.branchName.value), managerName: String(s.managerName.value),
      speechBubbles: s.speechBubbles.value === true, bossQuotes: s.bossQuotes.value === true,
    };
    if (this.theme) out.theme = this.theme;
    return out;
  }

  listen(l: (msg: HostToWebview) => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private send(msg: HostToWebview): void {
    this.log(`host ${msg.type}${'reqId' in msg && msg.reqId ? ` ${msg.reqId}` : ''}`);
    for (const l of [...this.listeners]) l(msg);
  }

  private later(fn: () => void, ms: number = this.lag): void {
    window.setTimeout(fn, ms);
  }

  private saveLag(): number {
    const v = this.params.get('savelag');
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : this.lag;
  }

  private reply(reqId: string, done: { ok: boolean; message?: string; conflict?: boolean; cancelled?: boolean }, withState = true): void {
    if (withState) this.send({ type: 'frontDesk', state: this.state(), reqId });
    this.send({ type: 'frontDeskDone', reqId, ...done });
  }

  /** The file changes on disk: new revision, new theme. A push, no reqId. */
  diskChange(): void {
    if (this.source.kind !== 'file') return;
    this.revNo += 1;
    this.theme = { ...(this.fileTheme === FILE_THEME ? DISK_THEME : { ...this.fileTheme, branch: 'Riverside' }) };
    this.source = { ...this.source, rev: rev(this.revNo), rawText: messyFile(this.theme) };
    this.send({ type: 'settings', settings: this.officeSettings() });
    this.send({ type: 'frontDesk', state: this.state() });
  }

  handle(m: WebviewToHost): void {
    switch (m.type) {
      case 'getFrontDesk': {
        this.later(() => {
          this.reply(m.reqId, { ok: true });
          const ms = Number(this.params.get('diskchange'));
          if (ms > 0 && !this.diskTimer) {
            this.diskTimer = true;
            window.setTimeout(() => { this.diskChange(); }, ms);
          }
        });
        break;
      }
      case 'themeAction': {
        this.later(() => {
          if (this.params.get('fail') === 'theme') { this.reply(m.reqId, { ok: false, message: 'Could not do that (mock failure).' }, false); return; }
          if (this.params.get('dialog') === 'cancel' && (m.action === 'choose' || m.action === 'create' || m.action === 'copyPreset')) { this.reply(m.reqId, { ok: true, cancelled: true }, false); return; }
          this.applyThemeAction(m.action, m.reqId, m.themeId);
        });
        break;
      }
      case 'setSetting': {
        this.later(() => {
          if (this.params.get('fail') === 'setting') { this.reply(m.reqId, { ok: false, message: 'VS Code refused the write (mock failure).' }, false); return; }
          const cur = this.settings[m.key];
          const next: FrontDeskSetting = { ...cur };
          if (m.value === null) {
            delete next.userValue;
            next.source = cur.workspaceWins ? 'workspace' : 'default';
            if (!cur.workspaceWins) next.value = defaultSettings()[m.key].value;
          } else {
            next.userValue = m.value;
            if (!cur.workspaceWins) { next.value = m.value; next.source = 'user'; }
          }
          this.settings[m.key] = next;
          this.send({ type: 'settings', settings: this.officeSettings() });
          this.reply(m.reqId, { ok: true });
        });
        break;
      }
      case 'saveTheme': {
        this.later(() => {
          if (this.params.get('fail') === 'save') { this.reply(m.reqId, { ok: false, message: 'Could not write the file: disk is full (mock failure).' }, false); return; }
          if (this.source.kind !== 'file' || this.source.readOnly !== undefined) { this.reply(m.reqId, { ok: false, message: 'This theme can’t be saved over.' }, false); return; }
          if (this.conflictLeft && m.force !== true) {
            this.conflictLeft = false;
            this.diskChange();
            this.send({ type: 'frontDeskDone', reqId: m.reqId, ok: false, conflict: true });
            return;
          }
          if (m.rev !== rev(this.revNo) && m.force !== true) {
            this.send({ type: 'frontDeskDone', reqId: m.reqId, ok: false, conflict: true });
            return;
          }
          this.write(m.themeJson, m.reqId, false);
        }, this.saveLag());
        break;
      }
      case 'saveThemeAs': {
        this.later(() => {
          if (this.params.get('dialog') === 'cancel') { this.reply(m.reqId, { ok: true, cancelled: true }, false); return; }
          this.write(m.themeJson, m.reqId, true);
        }, this.saveLag());
        break;
      }
      case 'openSettingsUi':
        this.log(`host: Settings editor on ${m.key} (${m.target})`);
        break;
      default:
        break;
    }
  }

  private applyThemeAction(action: string, reqId: string, themeId?: string): void {
    if (action === 'copyPrompt' || action === 'openThemesFolder') {
      this.log(`host: ${action === 'copyPrompt' ? 'prompt copied to the clipboard' : `opened ${THEMES_FOLDER}`}`);
      this.reply(reqId, { ok: true }, false);
      return;
    }
    if (action === 'installSkill' || action === 'removeSkill') {
      this.skill = action === 'installSkill' ? 'installed' : 'missing';
      this.reply(reqId, { ok: true });
      return;
    }
    if (action !== 'useUserTheme') this.userThemeId = null;
    if (action === 'useUserTheme') {
      const t = USER_THEMES.find((u) => u.id === themeId);
      this.userThemeId = themeId ?? null;
      this.revNo += 1;
      this.theme = this.fileTheme;
      this.source = this.fileSource({ label: t?.label ?? themeId ?? 'theme', path: `${THEMES_FOLDER}/${themeId ?? ''}` });
    } else if (action === 'useBuiltin') {
      this.theme = null;
      this.source = { kind: 'builtin', label: 'Built-in office', fromWorkspace: false, exists: true, editable: false, readOnly: 'builtin', errors: [], usingLastGood: false };
    } else if (action === 'usePreset') {
      this.theme = this.presetTheme;
      this.source = { kind: 'preset', presetId: 'example', label: 'Example office', fromWorkspace: false, exists: true, editable: false, readOnly: 'preset', errors: [], usingLastGood: false };
    } else if (action === 'create' || action === 'choose' || action === 'copyPreset') {
      this.revNo += 1;
      if (action === 'create') this.theme = {};
      else if (action === 'choose') this.theme = this.fileTheme;
      this.source = this.fileSource({ label: 'my-office.theme.json', path: SAVED_PATH });
    } else if (action === 'reload') {
      this.revNo += 0;
    }
    this.send({ type: 'settings', settings: this.officeSettings() });
    this.reply(reqId, { ok: true });
  }

  /** Save or Save as: the order is `settings`, `frontDesk`, `frontDeskDone`. */
  private write(themeJson: string, reqId: string, asNew: boolean): void {
    const parsed = parseTheme(JSON.parse(themeJson));
    this.revNo += 1;
    this.theme = parsed.theme;
    if (asNew) this.source = { ...this.fileSource({ label: 'my-office.theme.json', path: SAVED_PATH }) };
    this.source = { ...this.source, rev: rev(this.revNo), rawText: themeJson, errors: [], usingLastGood: false };
    this.send({ type: 'settings', settings: this.officeSettings() });
    this.reply(reqId, { ok: true });
  }
}
