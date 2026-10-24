/**
 * Front desk view helpers (task 3.10): the DOM-free wording and decisions behind the panel shell, the Theme tab and the
 * Settings tab. No DOM, so it is tested in Node (`test/engine-frontDeskPanel.test.ts`). The draft and the dirty/conflict
 * state machine themselves live in `frontDeskLogic.ts`; the glue that owns them is `frontDeskController.ts`.
 */
import type { FrontDeskMakeState, FrontDeskPreset, FrontDeskSettingKey, FrontDeskSettingValue, FrontDeskSource, FrontDeskState, FrontDeskTab, ThemeActionKind, ThemeSkillStatus } from '../../src/shared/protocol.ts';
import { FRONT_DESK_TABS, LIMITS } from '../../src/shared/protocol.ts';
import { bannerOf, dropReport, saveChoices, saveLabel, validateSettingInput } from './frontDeskLogic.ts';
import type { Banner, Draft, EditorState, SaveChoice, SettingRow } from './frontDeskLogic.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Tabs

const TAB_LABELS: Record<FrontDeskTab, string> = { theme: 'Theme', settings: 'Settings', staff: 'Staff', colours: 'Colours', about: 'About' };

/** The visible name of a tab. */
export function tabLabel(tab: FrontDeskTab): string {
  return TAB_LABELS[tab];
}

/** DOM id of a tab button (`aria-labelledby` of its panel). */
export function tabDomId(tab: FrontDeskTab): string {
  return `co-fd-tab-${tab}`;
}

/** DOM id of a tab's panel (`aria-controls` of its button). */
export function panelDomId(tab: FrontDeskTab): string {
  return `co-fd-panel-${tab}`;
}

/** True for a string that is one of the four tabs (the panel ignores anything else from `openFrontDesk`). */
export function isFrontDeskTab(v: unknown): v is FrontDeskTab {
  return typeof v === 'string' && (FRONT_DESK_TABS as readonly string[]).includes(v);
}

/** The tab a roving-tabindex key moves to: Left/Right wrap round, Home/End jump. Null for any other key. */
export function nextTab(key: string, current: FrontDeskTab, tabs: readonly FrontDeskTab[] = FRONT_DESK_TABS): FrontDeskTab | null {
  const i = tabs.indexOf(current);
  if (i < 0 || tabs.length === 0) return null;
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length] ?? null;
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length] ?? null;
  if (key === 'Home') return tabs[0] ?? null;
  if (key === 'End') return tabs[tabs.length - 1] ?? null;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The theme source

export type Tone = 'ok' | 'warn' | 'error' | 'info';

export interface StatusLine {
  tone: Tone;
  text: string;
}

export interface SourceView {
  /** Heading: "Built-in office", a ready-made office's name or the file name. */
  title: string;
  /** Small label next to the heading: "Built-in", "Ready-made" or "Your file". */
  kindLabel: string;
  /** The `~`-shortened path, for files only. */
  path?: string;
  statusLines: StatusLine[];
  /** The host's problem lines (`source.errors`), as is. */
  errors: string[];
  /** Plain-words reason a save over this source is refused; absent when saving writes the file. */
  readOnlyNote?: string;
}

/** Plain words for why Save cannot write over `source`; null when it can. Handles every `readOnly` reason the host may send. */
export function readOnlyReason(source: FrontDeskSource): string | null {
  const reason = source.readOnly as string | undefined;
  if (reason === undefined) {
    if (source.kind === 'builtin') return 'The built-in office can’t be changed. Save as… writes a theme file of your own.';
    if (source.kind === 'preset') return 'This ready-made office is read-only. Save as… writes a copy of your own.';
    return source.editable ? null : 'This file can’t be saved over.';
  }
  switch (reason) {
    case 'builtin': return 'The built-in office can’t be changed. Save as… writes a theme file of your own.';
    case 'preset': return 'This ready-made office is read-only. Save as… writes a copy of your own.';
    case 'workspace': return 'This theme path is set by the workspace, so it can’t be saved over here. Change it in the workspace settings.';
    case 'notJson':
    case 'notObject': return 'This file isn’t a JSON theme object, so it can’t be saved over. Fix it in the editor, or choose another file.';
    case 'missing': return 'This file doesn’t exist, so there is nothing to save over. Create a theme file or choose another one.';
    default: return 'This theme can’t be saved over.';
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the Theme tab shows about the current source. */
export function sourceView(source: FrontDeskSource): SourceView {
  const view: SourceView = {
    title: source.label,
    kindLabel: source.kind === 'builtin' ? 'Built-in' : source.kind === 'preset' ? 'Ready-made' : 'Your file',
    statusLines: [],
    errors: [...source.errors],
  };
  if (source.kind === 'builtin') {
    view.statusLines.push({ tone: 'info', text: 'The office uses its built-in look. Pick a theme below to change it.' });
  } else if (source.kind === 'preset') {
    view.statusLines.push({ tone: 'info', text: 'A ready-made office that ships with the extension. Make an editable copy to change it.' });
  } else {
    if (source.path !== undefined) view.path = source.path;
    if (!source.exists) view.statusLines.push({ tone: 'error', text: 'The file doesn’t exist.' });
    else if (source.usingLastGood) view.statusLines.push({ tone: 'warn', text: 'The file has problems, so the office is using the last good version.' });
    else if (source.errors.length > 0) view.statusLines.push({ tone: 'warn', text: `${plural(source.errors.length, 'problem', 'problems')} found in the file.` });
    else view.statusLines.push({ tone: 'ok', text: 'Loaded with no problems.' });
    if (source.fromWorkspace) view.statusLines.push({ tone: 'info', text: 'The path comes from a workspace setting.' });
  }
  // The built-in and ready-made offices explain themselves above; the read-only note is for files.
  const ro = source.kind === 'file' ? readOnlyReason(source) : null;
  if (ro !== null) view.readOnlyNote = ro;
  return view;
}

export type ActionVariant = 'primary' | 'secondary' | 'ghost';

export interface ThemeActionSpec {
  /** Stable key for the button (also the focus-restore key). */
  id: string;
  label: string;
  action: ThemeActionKind;
  presetId?: string;
  /** The file name of a theme in the themes folder (`useUserTheme`). */
  themeId?: string;
  hint?: string;
  variant: ActionVariant;
  /** Set when the action cannot run now; the text says why. */
  disabled?: string;
  /** Sub-heading group: the ready-made offices or the "make your own" actions. Ungrouped actions render on their own. */
  group?: ActionGroup;
  /** Accessible name when the visible label alone does not say what the button does. */
  ariaLabel?: string;
  /** A problem to flag next to the hint, in the warning colour (for example "Has problems"). */
  warn?: string;
  /** Set when the action asks first; the text says what is lost. The confirm button reads "<label> anyway". */
  confirm?: string;
}

export type ActionGroup = 'mine' | 'presets' | 'own';

/** Sub-headings for the action groups. */
export const GROUP_HEADINGS: Record<ActionGroup, string> = { mine: 'Your offices', presets: 'Ready-made offices', own: 'Make your own' };

/** Where the themes folder is shown when the host does not say. */
export const DEFAULT_THEMES_FOLDER = '~/.middle-management/themes';

/** One button per ready-made office: the office's name as the label, its description as the hint. */
function presetAction(p: FrontDeskPreset): ThemeActionSpec {
  return { id: `use-${p.id}`, label: p.label, ariaLabel: `Use ${p.label}`, action: 'usePreset', presetId: p.id, hint: p.description, variant: 'secondary', group: 'presets' };
}

type UserThemesState = Pick<FrontDeskState, 'source' | 'userThemes' | 'userThemesTruncated'>;

/** The "Your offices" group: one button per theme file in the themes folder, then Open themes folder. Empty for an older host. */
export function userThemeActions(state: UserThemesState): ThemeActionSpec[] {
  const themes = state.userThemes;
  if (themes === undefined) return [];
  const fromWorkspace = state.source.kind === 'file' && state.source.fromWorkspace;
  const out: ThemeActionSpec[] = themes.map((t): ThemeActionSpec => {
    const spec: ThemeActionSpec = { id: `mine-${t.id}`, label: t.label, ariaLabel: `Use ${t.label}`, action: 'useUserTheme', themeId: t.id, variant: 'secondary', group: 'mine' };
    if (t.description !== undefined && t.description !== '') spec.hint = t.description;
    if (t.problems) spec.warn = 'Has problems';
    if (t.current) spec.disabled = 'In use';
    else if (fromWorkspace) spec.disabled = 'The theme file is set in the workspace settings.';
    return spec;
  });
  const folder: ThemeActionSpec = { id: 'open-themes-folder', label: 'Open themes folder', action: 'openThemesFolder', variant: 'ghost', group: 'mine' };
  if (state.userThemesTruncated === true) folder.hint = `Showing the newest ${LIMITS.userThemes}.`;
  out.push(folder);
  return out;
}

/** The hint above Open themes folder while the themes folder has no themes yet; undefined otherwise (or for an older host). */
export function userThemesEmptyText(state: Pick<FrontDeskState, 'userThemes' | 'make'>): string | undefined {
  if (state.userThemes === undefined || state.userThemes.length > 0) return undefined;
  return `Themes Claude makes for you show up here. They’re saved in ${state.make?.themesFolder ?? DEFAULT_THEMES_FOLDER}.`;
}

/** The short status shown after "Make one with Claude" while the card is closed; undefined while the state is unknown. */
export function skillSummary(skill: ThemeSkillStatus): string | undefined {
  switch (skill) {
    case 'missing': return 'Teach Claude first';
    case 'installed': return 'Claude knows how';
    case 'outdated': return 'Update ready';
    case 'modified': return 'Skill edited';
    case 'foreign': return 'Folder in use';
    default: return undefined;
  }
}

/** Where a theme action's result line shows: under step 1 of the Make card, under the card's footer button, or at the bottom of the tab. */
export type ResultSlot = 'step' | 'foot' | 'bottom';
export function resultSlot(action: ThemeActionKind): ResultSlot {
  if (action === 'installSkill' || action === 'removeSkill') return 'step';
  return action === 'copyPrompt' ? 'foot' : 'bottom';
}

export interface MakeView {
  /** The status line or explanation that replaces the buttons' lead-in; absent when the buttons speak for themselves. */
  text?: string;
  /** Quiet line under the buttons. */
  hint?: string;
  buttons: ThemeActionSpec[];
  /** The skill's folder, `~`-shortened. */
  skillFolder: string;
}

const SKILL_EDITED = 'Your edits to the skill’s files will be lost.';

/** What step 1 of the "Make one with Claude" card shows for the skill's state. */
export function makeView(make: FrontDeskMakeState): MakeView {
  const view: MakeView = { buttons: [], skillFolder: make.skillFolder };
  switch (make.skill) {
    case 'missing':
      view.buttons.push({ id: 'skill-install', label: 'Teach Claude', action: 'installSkill', variant: 'primary' });
      view.hint = 'Adds a small skill to Claude Code so it knows how to write Middle Management themes. Nothing else is changed.';
      break;
    case 'installed':
      view.text = 'Claude knows how.';
      view.buttons.push({ id: 'skill-remove', label: 'Remove', action: 'removeSkill', variant: 'ghost' });
      break;
    case 'outdated':
      view.buttons.push({ id: 'skill-install', label: 'Update', action: 'installSkill', variant: 'primary' });
      view.hint = 'A newer version comes with this update of the extension.';
      break;
    case 'modified':
      view.text = 'The skill’s files were changed by hand.';
      view.buttons.push(
        { id: 'skill-install', label: 'Reinstall…', action: 'installSkill', variant: 'secondary', confirm: SKILL_EDITED },
        { id: 'skill-remove', label: 'Remove…', action: 'removeSkill', variant: 'ghost', confirm: SKILL_EDITED },
      );
      break;
    case 'foreign':
      view.text = 'A different skill already uses this folder, so Middle Management won’t touch it.';
      break;
    default:
      view.text = 'Checking…';
      break;
  }
  return view;
}

/** The actions the Theme tab offers for the current source. `userState` is the host state's `userThemes` and `userThemesTruncated`: the "Your offices" group comes first. */
export function themeActions(source: FrontDeskSource, presets: readonly FrontDeskPreset[], userState: Pick<FrontDeskState, 'userThemes' | 'userThemesTruncated'> = {}): ThemeActionSpec[] {
  return [...userThemeActions({ source, ...userState }), ...sourceActions(source, presets)];
}

function sourceActions(source: FrontDeskSource, presets: readonly FrontDeskPreset[]): ThemeActionSpec[] {
  if (source.kind === 'builtin') {
    return [
      ...presets.map(presetAction),
      { id: 'create', label: 'Create theme file', action: 'create', hint: 'Writes a starter theme to a file you pick, then uses it.', variant: 'primary', group: 'own' },
      { id: 'choose', label: 'Choose a file…', action: 'choose', hint: 'Use a theme file you already have.', variant: 'secondary', group: 'own' },
    ];
  }
  if (source.kind === 'preset') {
    const out: ThemeActionSpec[] = [];
    if (source.presetId !== undefined) {
      out.push({ id: 'copy', label: 'Make an editable copy…', action: 'copyPreset', presetId: source.presetId, hint: 'Saves a copy to a file you pick, then uses it.', variant: 'primary' });
    }
    // The office in use is left out; every other one is a straight switch (and asks first when there are unsaved edits).
    out.push(...presets.filter((p) => p.id !== source.presetId).map(presetAction));
    out.push({ id: 'builtin', label: 'Back to built-in', action: 'useBuiltin', hint: 'Go back to the office’s own look.', variant: 'ghost' });
    return out;
  }
  // A workspace-set path wins over anything the panel can write (the user setting), so Choose and Back to built-in would do nothing.
  const own = !source.fromWorkspace;
  return [
    { id: 'open', label: 'Open in editor', action: 'open', hint: 'Edit the theme file in VS Code.', variant: 'primary', ...(source.exists ? {} : { disabled: 'The file doesn’t exist.' }) },
    { id: 'reload', label: 'Reload', action: 'reload', hint: 'Read the file again.', variant: 'secondary' },
    ...(own ? [
      { id: 'choose', label: 'Choose another…', action: 'choose', hint: 'Switch to a different theme file.', variant: 'secondary' } satisfies ThemeActionSpec,
      { id: 'builtin', label: 'Back to built-in', action: 'useBuiltin', hint: 'Stop using a theme file. The file itself is kept.', variant: 'ghost' } satisfies ThemeActionSpec,
    ] : []),
  ];
}

/** The line shown instead of Choose and Back to built-in when the workspace sets the theme path; undefined otherwise. */
export function workspaceThemeLine(source: FrontDeskSource): string | undefined {
  return source.kind === 'file' && source.fromWorkspace ? 'This theme file is set in the workspace settings. Change it there.' : undefined;
}

/** True for actions that switch to another theme (and so drop unsaved edits); false for Open and Reload. */
export function changesSource(action: ThemeActionKind): boolean {
  return action !== 'open' && action !== 'reload' && action !== 'openThemesFolder' && action !== 'installSkill' && action !== 'removeSkill' && action !== 'copyPrompt';
}

/** The text shown while a theme action waits for the host. */
export function pendingText(action: ThemeActionKind): string {
  switch (action) {
    case 'open': return 'Opening…';
    case 'reload': return 'Reloading…';
    case 'openThemesFolder': return 'Opening…';
    case 'installSkill': return 'Teaching Claude…';
    case 'removeSkill': return 'Removing the skill…';
    case 'copyPrompt': return 'Copying…';
    case 'choose':
    case 'create':
    case 'copyPreset': return 'Waiting for the file dialog…';
    default: return 'Switching…';
  }
}

/** The text shown after a theme action succeeded. */
export function doneText(action: ThemeActionKind): string {
  switch (action) {
    case 'open': return 'Opened in the editor.';
    case 'reload': return 'Reloaded.';
    case 'openThemesFolder': return 'Opened.';
    case 'installSkill': return 'Done. Now ask Claude in any Claude Code chat.';
    case 'removeSkill': return 'Removed.';
    case 'copyPrompt': return 'Copied. Paste it into Claude Code and describe your office.';
    default: return 'Done.';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings

/** The value a setting's control shows: the user's own value when a workspace one hides it, else the effective value. */
export function editableValue(state: FrontDeskState, key: FrontDeskSettingKey, row: SettingRow): FrontDeskSettingValue {
  const s = state.settings[key];
  if (s.workspaceWins && s.userValue !== undefined) return s.userValue;
  return row.value;
}

export type TextCommit = { kind: 'unchanged' } | { kind: 'invalid'; error: string } | { kind: 'send'; value: string };

/** What committing a text input does: nothing (same as the current value), an inline error, or a `setSetting` with the trimmed text. */
export function textCommit(key: FrontDeskSettingKey, raw: string, current: string): TextCommit {
  const r = validateSettingInput(key, raw);
  if (!r.ok) return { kind: 'invalid', error: r.error };
  const value = typeof r.value === 'string' ? r.value : '';
  return value === current ? { kind: 'unchanged' } : { kind: 'send', value };
}

export interface SettingBadge {
  kind: 'workspace' | 'theme';
  text: string;
  /** For `workspace`: the link-button label that opens the workspace settings. */
  linkLabel?: string;
  /** For `theme`: the longer explanation. */
  note?: string;
  /** For `theme`: a quiet extra line when the workspace also sets a value that loses to the theme. */
  extra?: string;
}

/** The badges under a setting row. */
export function settingBadges(row: SettingRow): SettingBadge[] {
  const out: SettingBadge[] = [];
  if (row.workspaceBadge !== undefined) out.push({ kind: 'workspace', text: row.workspaceBadge, linkLabel: 'Change workspace value' });
  if (row.themeNote !== undefined) {
    out.push({ kind: 'theme', text: 'Your theme sets this', note: row.themeNote, ...(row.workspaceAlso !== undefined ? { extra: row.workspaceAlso } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Footer, banner and prompts

/** Lines to show before a save writes over an existing file; empty = nothing to confirm. */
export function dropLinesFor(choice: SaveChoice, source: FrontDeskSource, draft: Draft): string[] {
  if (choice === 'saveAs') return [];
  if (source.kind !== 'file' || !source.exists) return [];
  return dropReport(source.rawText ?? null, draft);
}

export interface FooterButton {
  choice: SaveChoice;
  label: string;
  primary: boolean;
  disabled: boolean;
}

export interface FooterView {
  visible: boolean;
  title: string;
  /** The failure text of a failed save (status 'error'). */
  message?: string;
  /** Draft problems that block saving (at most `maxErrors` lines, then "and N more"). */
  errors: string[];
  buttons: FooterButton[];
  canDiscard: boolean;
  /** True while a save is running. */
  saving: boolean;
}

/** Shortens a problem list to `max` lines with a closing "and N more problems". */
export function errorSummary(errors: readonly string[], max = 4): string[] {
  if (errors.length <= max) return [...errors];
  return [...errors.slice(0, max), `…and ${plural(errors.length - max, 'more problem', 'more problems')}.`];
}

/** What the sticky footer shows. `errors` is `draftErrors(draft)`; `notice` is a local failure (for example a theme too big to save). */
export function footerView(editor: EditorState, source: FrontDeskSource, errors: readonly string[], notice: string | null = null): FooterView {
  const visible = editor.status !== 'clean';
  const saving = editor.status === 'saving';
  const view: FooterView = {
    visible,
    title: saving ? 'Saving…' : editor.status === 'conflict' ? 'The file changed on disk' : 'Unsaved changes',
    errors: errorSummary(errors),
    buttons: [],
    canDiscard: visible && !saving,
    saving,
  };
  const message = editor.status === 'error' ? (editor.message ?? 'Could not save.') : notice;
  if (message !== null && message !== undefined) view.message = message;
  if (editor.status === 'conflict') return view;
  const choices = saveChoices(editor, source);
  view.buttons = choices.map((choice, i): FooterButton => ({
    choice, label: saveLabel(choice), primary: i === 0, disabled: saving || errors.length > 0,
  }));
  return view;
}

export interface BannerView {
  kind: Exclude<Banner, 'none'>;
  text: string;
  /** Load it / Keep mine are offered for the first two banners. */
  offerChoice: boolean;
}

/** The banner above the tab content, or null. */
export function bannerView(editor: EditorState): BannerView | null {
  const b = bannerOf(editor);
  if (b === 'none') return null;
  if (b === 'changedOnDisk') return { kind: b, text: 'This file changed on disk while you were editing. Load it to replace your edits with the file’s version, or keep yours.', offerChoice: true };
  if (b === 'conflict') return { kind: b, text: 'Couldn’t save: the file changed on disk since you started editing. Load it to replace your edits, or keep yours.', offerChoice: true };
  return { kind: b, text: 'Keeping your version. Overwrite anyway replaces the newer file; Save as… writes a new one.', offerChoice: false };
}

export interface ClosePromptView {
  text: string;
  /** False while a save runs: only Keep editing is offered. */
  canDiscard: boolean;
}

/** The inline "Keep editing / Discard" prompt that `beforeClose` shows. */
export function closePromptView(editor: EditorState): ClosePromptView {
  if (editor.status === 'saving') return { text: 'A save is still running. Wait for it to finish before closing.', canDiscard: false };
  return { text: 'You have unsaved changes. Close and lose them?', canDiscard: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests

/** Makes request ids `fd1`, `fd2`, ... (unique per panel; the host only echoes them). */
export function reqIdFactory(prefix = 'fd'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** What `frontDeskDone` carries, minus the id. */
export interface DoneResult {
  ok: boolean;
  message?: string;
  conflict?: boolean;
  cancelled?: boolean;
}

/** Remembers which callback waits for which `reqId`; each is called once. */
export class RequestTracker {
  private readonly waiting = new Map<string, (r: DoneResult) => void>();

  register(reqId: string, cb: (r: DoneResult) => void): void {
    this.waiting.set(reqId, cb);
  }

  /** Calls and forgets the callback of `reqId`. Returns false for an id nobody waits for. */
  resolve(reqId: string, r: DoneResult): boolean {
    const cb = this.waiting.get(reqId);
    if (cb === undefined) return false;
    this.waiting.delete(reqId);
    cb(r);
    return true;
  }

  has(reqId: string): boolean {
    return this.waiting.has(reqId);
  }

  get size(): number {
    return this.waiting.size;
  }
}
