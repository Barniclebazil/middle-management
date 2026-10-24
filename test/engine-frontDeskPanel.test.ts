import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestTracker, bannerView, changesSource, closePromptView, dropLinesFor, editableValue, errorSummary, footerView, isFrontDeskTab, nextTab,
  doneText, makeView, resultSlot, skillSummary, panelDomId, pendingText, readOnlyReason, reqIdFactory, settingBadges, sourceView, tabDomId, tabLabel, textCommit, themeActions, userThemeActions, userThemesEmptyText, workspaceThemeLine, DEFAULT_THEMES_FOLDER, GROUP_HEADINGS,
} from '../webview/engine/frontDeskView.ts';
import { editorStep, initialEditorState, settingsView } from '../webview/engine/frontDeskLogic.ts';
import type { EditorState } from '../webview/engine/frontDeskLogic.ts';
import type { FrontDeskMakeState, FrontDeskSetting, FrontDeskSettingKey, FrontDeskSource, FrontDeskState, FrontDeskUserTheme, ThemeSkillStatus } from '../src/shared/protocol.ts';
import { FRONT_DESK_SETTINGS } from '../src/shared/protocol.ts';

const builtin: FrontDeskSource = { kind: 'builtin', label: 'Built-in office', fromWorkspace: false, exists: true, editable: false, readOnly: 'builtin', errors: [], usingLastGood: false };
const preset: FrontDeskSource = { kind: 'preset', presetId: 'example', label: 'Example office', fromWorkspace: false, exists: true, editable: false, readOnly: 'preset', errors: [], usingLastGood: false };
const file = (over: Partial<FrontDeskSource> = {}): FrontDeskSource => ({ kind: 'file', label: 'office.json', path: '~/office.json', fromWorkspace: false, exists: true, editable: true, rev: 'aaaaaaaaaaaaaaaa', errors: [], usingLastGood: false, ...over });
const PRESETS = [{ id: 'example', label: 'Example office', description: 'Ready made.' }];

function settings(over: Partial<Record<FrontDeskSettingKey, Partial<FrontDeskSetting>>> = {}): FrontDeskState['settings'] {
  const base: Record<string, FrontDeskSetting> = {
    companyName: { value: 'Co', source: 'default', workspaceWins: false }, branchName: { value: '', source: 'default', workspaceWins: false },
    managerName: { value: 'You', source: 'default', workspaceWins: false }, speechBubbles: { value: true, source: 'default', workspaceWins: false },
    bossQuotes: { value: true, source: 'default', workspaceWins: false }, scope: { value: 'all', source: 'default', workspaceWins: false },
    usageChecks: { value: 'auto', source: 'default', workspaceWins: false },
    updateChecks: { value: 'auto', source: 'default', workspaceWins: false },
    mode: { value: 'manager', source: 'default', workspaceWins: false },
  };
  for (const k of FRONT_DESK_SETTINGS) base[k] = { ...base[k]!, ...(over[k] ?? {}) };
  return base as FrontDeskState['settings'];
}

test('tabs: labels, ids and roving keys', () => {
  assert.equal(tabLabel('colours'), 'Colours');
  assert.equal(tabDomId('theme'), 'co-fd-tab-theme');
  assert.equal(panelDomId('staff'), 'co-fd-panel-staff');
  assert.equal(isFrontDeskTab('settings'), true);
  assert.equal(isFrontDeskTab('nope'), false);
  assert.equal(nextTab('ArrowRight', 'theme'), 'settings');
  assert.equal(nextTab('ArrowRight', 'colours'), 'about');
  assert.equal(nextTab('ArrowRight', 'about'), 'theme');
  assert.equal(nextTab('ArrowLeft', 'theme'), 'about');
  assert.equal(tabLabel('about'), 'About');
  assert.equal(nextTab('Home', 'staff'), 'theme');
  assert.equal(nextTab('End', 'staff'), 'about');
  assert.equal(nextTab('Enter', 'staff'), null);
});

test('readOnlyReason explains every reason in plain words', () => {
  assert.match(readOnlyReason(file({ readOnly: 'workspace', editable: false, fromWorkspace: true }))!, /set by the workspace, so it can’t be saved over here/);
  assert.match(readOnlyReason(file({ readOnly: 'notJson', editable: false }))!, /JSON theme object/);
  assert.match(readOnlyReason(file({ readOnly: 'notObject' as never, editable: false }))!, /JSON theme object/);
  assert.match(readOnlyReason(file({ readOnly: 'missing', editable: false, exists: false }))!, /doesn’t exist/);
  assert.match(readOnlyReason(builtin)!, /built-in office/);
  assert.match(readOnlyReason(preset)!, /ready-made office/);
  assert.equal(readOnlyReason(file()), null);
  assert.ok(readOnlyReason(file({ editable: false })));
});

test('sourceView: statuses, path, problems and the read-only note (files only)', () => {
  assert.equal(sourceView(builtin).title, 'Built-in office');
  assert.equal(sourceView(builtin).readOnlyNote, undefined);
  assert.equal(sourceView(preset).kindLabel, 'Ready-made');
  const ok = sourceView(file());
  assert.equal(ok.path, '~/office.json');
  assert.equal(ok.statusLines[0]!.tone, 'ok');
  const bad = sourceView(file({ errors: ['a', 'b'], usingLastGood: true }));
  assert.equal(bad.statusLines[0]!.tone, 'warn');
  assert.match(bad.statusLines[0]!.text, /last good/);
  assert.deepEqual(bad.errors, ['a', 'b']);
  assert.match(sourceView(file({ errors: ['a', 'b'] })).statusLines[0]!.text, /2 problems/);
  assert.match(sourceView(file({ errors: ['a'] })).statusLines[0]!.text, /1 problem found/);
  assert.equal(sourceView(file({ exists: false, editable: false, readOnly: 'missing' })).statusLines[0]!.tone, 'error');
  assert.ok(sourceView(file({ readOnly: 'workspace', editable: false, fromWorkspace: true })).readOnlyNote);
});

test('themeActions per source', () => {
  assert.deepEqual(themeActions(builtin, PRESETS).map((a) => a.label), ['Example office', 'Create theme file', 'Choose a file…']);
  const use = themeActions(builtin, PRESETS)[0]!;
  assert.equal(use.action, 'usePreset');
  assert.equal(use.presetId, 'example');
  assert.deepEqual(themeActions(builtin, []).map((a) => a.action), ['create', 'choose']);
  const copy = themeActions(preset, PRESETS);
  assert.equal(copy[0]!.label, 'Make an editable copy…');
  assert.equal(copy[0]!.action, 'copyPreset');
  assert.equal(copy[0]!.presetId, 'example');
  assert.deepEqual(themeActions(file(), PRESETS).map((a) => a.label), ['Open in editor', 'Reload', 'Choose another…', 'Back to built-in']);
  assert.ok(themeActions(file({ exists: false }), PRESETS)[0]!.disabled);
  // presetId only where the protocol allows it
  for (const a of [...themeActions(builtin, PRESETS), ...themeActions(preset, PRESETS), ...themeActions(file(), PRESETS)]) {
    assert.equal(a.presetId !== undefined, a.action === 'usePreset' || a.action === 'copyPreset', a.id);
  }
});

const MANY = [
  { id: 'example', label: 'Example office', description: 'Ready made.' },
  { id: 'spaceship', label: 'Spaceship', description: 'Crew deck.' },
  { id: 'cyberpunk', label: 'Cyberpunk', description: 'Neon.' },
];

test('themeActions: the built-in state groups ready-made offices and "make your own"', () => {
  const acts = themeActions(builtin, MANY);
  assert.deepEqual(acts.map((a) => a.group), ['presets', 'presets', 'presets', 'own', 'own']);
  assert.deepEqual(acts.slice(0, 3).map((a) => a.label), ['Example office', 'Spaceship', 'Cyberpunk']);
  assert.deepEqual(acts.slice(0, 3).map((a) => a.hint), ['Ready made.', 'Crew deck.', 'Neon.']);
  assert.equal(acts[3]!.variant, 'primary');
  assert.equal(acts[3]!.label, 'Create theme file');
  assert.equal(acts[4]!.label, 'Choose a file…');
  assert.equal(GROUP_HEADINGS.presets, 'Ready-made offices');
  assert.equal(GROUP_HEADINGS.own, 'Make your own');
});

test('themeActions: a preset lists the other presets but not itself', () => {
  const acts = themeActions(preset, MANY);
  assert.deepEqual(acts.map((a) => a.id), ['copy', 'use-spaceship', 'use-cyberpunk', 'builtin']);
  assert.equal(acts[0]!.variant, 'primary');
  assert.equal(acts[0]!.group, undefined);
  assert.equal(acts[1]!.action, 'usePreset');
  assert.equal(acts[1]!.presetId, 'spaceship');
  assert.equal(acts[3]!.variant, 'ghost');
  assert.ok(acts.every((a) => a.presetId !== 'example' || a.action === 'copyPreset'));
  // switching presets is a source change, so the unsaved-edits guard applies
  assert.equal(changesSource(acts[1]!.action), true);
});

test('themeActions: preset buttons have accessible names that say what they do', () => {
  const acts = themeActions(builtin, MANY).filter((a) => a.group === 'presets');
  assert.deepEqual(acts.map((a) => a.ariaLabel), ['Use Example office', 'Use Spaceship', 'Use Cyberpunk']);
});

test('changesSource and pendingText', () => {
  assert.equal(changesSource('open'), false);
  assert.equal(changesSource('reload'), false);
  assert.equal(changesSource('useBuiltin'), true);
  assert.equal(changesSource('copyPreset'), true);
  assert.match(pendingText('choose'), /dialog/);
  assert.equal(pendingText('reload'), 'Reloading…');
  // only picking one of your own themes switches the source; the skill and folder actions never ask about unsaved edits
  assert.equal(changesSource('useUserTheme'), true);
  for (const a of ['openThemesFolder', 'installSkill', 'removeSkill', 'copyPrompt'] as const) assert.equal(changesSource(a), false, a);
});

test('pendingText and doneText: wording of the themes-folder and skill actions', () => {
  const words = {
    installSkill: ['Teaching Claude…', 'Done. Now ask Claude in any Claude Code chat.'],
    removeSkill: ['Removing the skill…', 'Removed.'],
    copyPrompt: ['Copying…', 'Copied. Paste it into Claude Code and describe your office.'],
    openThemesFolder: ['Opening…', 'Opened.'],
    useUserTheme: [pendingText('usePreset'), doneText('usePreset')],
  } as const;
  for (const [action, [pending, done]] of Object.entries(words)) {
    assert.equal(pendingText(action as keyof typeof words), pending, action);
    assert.equal(doneText(action as keyof typeof words), done, action);
  }
  assert.equal(pendingText('useUserTheme'), 'Switching…');
  assert.equal(doneText('useUserTheme'), 'Done.');
});

test('themeActions: a workspace-set path offers neither Choose nor Back to built-in', () => {
  const ws = file({ readOnly: 'workspace', editable: false, fromWorkspace: true });
  assert.deepEqual(themeActions(ws, PRESETS).map((a) => a.action), ['open', 'reload']);
  assert.match(workspaceThemeLine(ws)!, /workspace settings/);
  assert.equal(workspaceThemeLine(file()), undefined);
  assert.equal(workspaceThemeLine(builtin), undefined);
});

const MINE: FrontDeskUserTheme[] = [
  { id: 'pirate-ship.theme.json', label: 'Pirate ship', description: 'A creaky galleon.', current: false, problems: false },
  { id: 'lighthouse-crew.theme.json', label: 'Lighthouse crew', current: true, problems: false },
  { id: 'corner-bakery.theme.json', label: 'Corner bakery', description: 'Warm ovens.', current: false, problems: true },
];

test('userThemeActions: one button per theme, then Open themes folder', () => {
  const acts = userThemeActions({ source: builtin, userThemes: MINE });
  assert.deepEqual(acts.map((a) => a.id), ['mine-pirate-ship.theme.json', 'mine-lighthouse-crew.theme.json', 'mine-corner-bakery.theme.json', 'open-themes-folder']);
  assert.ok(acts.every((a) => a.group === 'mine'));
  const [pirate, lighthouse, bakery, folder] = acts as [typeof acts[0], typeof acts[0], typeof acts[0], typeof acts[0]];
  assert.equal(pirate.label, 'Pirate ship');
  assert.equal(pirate.action, 'useUserTheme');
  assert.equal(pirate.themeId, 'pirate-ship.theme.json');
  assert.equal(pirate.hint, 'A creaky galleon.');
  assert.equal(pirate.variant, 'secondary');
  assert.equal(pirate.disabled, undefined);
  assert.equal(pirate.ariaLabel, 'Use Pirate ship');
  assert.equal(lighthouse.disabled, 'In use');
  assert.match(bakery.hint!, /Warm ovens/);
  assert.doesNotMatch(bakery.hint!, /Has problems/);
  assert.equal(bakery.warn, 'Has problems');
  assert.equal(pirate.warn, undefined);
  assert.equal(bakery.disabled, undefined);
  assert.equal(folder.action, 'openThemesFolder');
  assert.equal(folder.variant, 'ghost');
  assert.equal(folder.themeId, undefined);
  assert.equal(folder.hint, undefined);
  assert.equal(GROUP_HEADINGS.mine, 'Your offices');
  // problems without a description still say so
  assert.equal(userThemeActions({ source: builtin, userThemes: [{ id: 'a.theme.json', label: 'A', current: false, problems: true }] })[0]!.hint, undefined);
  assert.equal(userThemeActions({ source: builtin, userThemes: [{ id: 'a.theme.json', label: 'A', current: false, problems: true }] })[0]!.warn, 'Has problems');
});

test('userThemeActions: a workspace-set theme file disables the entries; an older host and an empty folder', () => {
  const ws = file({ readOnly: 'workspace', editable: false, fromWorkspace: true });
  const acts = userThemeActions({ source: ws, userThemes: MINE });
  assert.equal(acts[0]!.disabled, 'The theme file is set in the workspace settings.');
  assert.equal(acts[1]!.disabled, 'In use');
  assert.equal(acts[3]!.disabled, undefined, 'Open themes folder still works');
  // a file that is not from the workspace leaves them enabled
  assert.equal(userThemeActions({ source: file(), userThemes: MINE })[0]!.disabled, undefined);
  assert.deepEqual(userThemeActions({ source: builtin }), []);
  assert.deepEqual(userThemeActions({ source: builtin, userThemes: [] }).map((a) => a.action), ['openThemesFolder']);
  const cut = userThemeActions({ source: builtin, userThemes: MINE, userThemesTruncated: true });
  assert.equal(cut[cut.length - 1]!.hint, 'Showing the newest 50.');
});

test('userThemesEmptyText: only for a listed, empty folder', () => {
  const make: FrontDeskMakeState = { themesFolder: '~/mm/themes', skillFolder: '~/mm/skill', skill: 'missing' };
  assert.equal(userThemesEmptyText({ userThemes: [], make }), 'Themes Claude makes for you show up here. They’re saved in ~/mm/themes.');
  assert.match(userThemesEmptyText({ userThemes: [] })!, new RegExp(`saved in ${DEFAULT_THEMES_FOLDER.replace(/[.~]/g, '\\$&')}\\.$`));
  assert.equal(userThemesEmptyText({ userThemes: MINE, make }), undefined);
  assert.equal(userThemesEmptyText({ make }), undefined);
});

test('themeActions: Your offices come first for every source, and an older host sees no change', () => {
  const user = { userThemes: MINE };
  for (const src of [builtin, preset, file()]) {
    const base = themeActions(src, MANY);
    const withMine = themeActions(src, MANY, user);
    assert.deepEqual(withMine.map((a) => a.group).slice(0, 4), ['mine', 'mine', 'mine', 'mine'], src.kind);
    assert.deepEqual(withMine.slice(4), base, src.kind);
    // no list from the host: exactly today's actions
    assert.deepEqual(themeActions(src, MANY, {}), base, src.kind);
    assert.ok(base.every((a) => a.group !== 'mine'));
  }
  // an empty list shows only Open themes folder
  assert.deepEqual(themeActions(builtin, [], { userThemes: [] }).map((a) => a.action), ['openThemesFolder', 'create', 'choose']);
  // themeId only where the protocol allows it
  for (const a of themeActions(preset, MANY, user)) assert.equal(a.themeId !== undefined, a.action === 'useUserTheme', a.id);
});

const make = (skill: ThemeSkillStatus): FrontDeskMakeState => ({ themesFolder: '~/mm/themes', skillFolder: '~/.claude/skills/mm-theme', skill });

test('makeView: what the card shows for each skill state', () => {
  const brief = (skill: ThemeSkillStatus): unknown => { const v = makeView(make(skill)); return [v.text, v.buttons.map((b) => [b.label, b.action, b.variant, b.confirm !== undefined]), v.hint]; };
  assert.deepEqual(brief('missing'), [undefined, [['Teach Claude', 'installSkill', 'primary', false]],
    'Adds a small skill to Claude Code so it knows how to write Middle Management themes. Nothing else is changed.']);
  assert.deepEqual(brief('installed'), ['Claude knows how.', [['Remove', 'removeSkill', 'ghost', false]], undefined]);
  assert.deepEqual(brief('outdated'), [undefined, [['Update', 'installSkill', 'primary', false]], 'A newer version comes with this update of the extension.']);
  assert.deepEqual(brief('modified'), ['The skill’s files were changed by hand.',
    [['Reinstall…', 'installSkill', 'secondary', true], ['Remove…', 'removeSkill', 'ghost', true]], undefined]);
  assert.deepEqual(brief('foreign'), ['A different skill already uses this folder, so Middle Management won’t touch it.', [], undefined]);
  assert.deepEqual(brief('unknown'), ['Checking…', [], undefined]);
  for (const skill of ['missing', 'installed', 'outdated', 'modified', 'foreign', 'unknown'] as const) {
    assert.equal(makeView(make(skill)).skillFolder, '~/.claude/skills/mm-theme', skill);
  }
  // the confirm text says what is lost; the buttons are not part of the theme list (no group, no theme or preset id)
  const mod = makeView(make('modified')).buttons;
  assert.ok(mod.every((b) => b.confirm === 'Your edits to the skill’s files will be lost.' && b.group === undefined && b.presetId === undefined && b.themeId === undefined));
  assert.equal(new Set(mod.map((b) => b.id)).size, 2);
});

test('settings helpers: editable value, text commit, badges', () => {
  const state: FrontDeskState = {
    source: builtin, presets: [],
    settings: settings({ companyName: { value: 'Acme', source: 'workspace', userValue: 'Mine', workspaceWins: true }, managerName: { value: 'You', themeValue: 'Alex Mercer' } }),
  };
  const rows = settingsView(state);
  const company = rows.find((r) => r.key === 'companyName')!;
  assert.equal(editableValue(state, 'companyName', company), 'Mine');
  assert.equal(editableValue(state, 'managerName', rows.find((r) => r.key === 'managerName')!), 'You');
  assert.deepEqual(settingBadges(company).map((b) => b.kind), ['workspace']);
  assert.equal(settingBadges(company)[0]!.text, 'Workspace overrides this');
  const mgr = settingBadges(rows.find((r) => r.key === 'managerName')!);
  assert.equal(mgr[0]!.text, 'Your theme sets this');
  assert.match(mgr[0]!.note!, /Alex Mercer/);
  assert.deepEqual(textCommit('companyName', '  Acme  ', 'Acme'), { kind: 'unchanged' });
  assert.deepEqual(textCommit('companyName', ' New ', 'Acme'), { kind: 'send', value: 'New' });
  assert.deepEqual(textCommit('branchName', '   ', 'X'), { kind: 'send', value: '' });
  assert.equal(textCommit('companyName', 'a\tb', 'x').kind, 'invalid');
  assert.equal(textCommit('companyName', 'x'.repeat(101), 'x').kind, 'invalid');
});

test('settings badges: the theme is the only winner when it and the workspace both set a key', () => {
  const state: FrontDeskState = {
    source: builtin, presets: [],
    settings: settings({
      companyName: { value: 'Workspace Co', source: 'workspace', workspaceWins: true, themeValue: 'Pennywhistle Paper' },
      branchName: { value: 'Harbour Branch', source: 'workspace', userValue: 'Mine', workspaceWins: true },
    }),
  };
  const rows = settingsView(state);
  const co = rows.find((r) => r.key === 'companyName')!;
  const badges = settingBadges(co);
  assert.deepEqual(badges.map((b) => b.kind), ['theme']);
  assert.equal(co.workspaceBadge, undefined);
  assert.match(badges[0]!.note!, /Pennywhistle Paper/);
  assert.equal(badges[0]!.extra, 'The workspace also sets “Workspace Co”, but your theme wins.');
  assert.deepEqual(settingBadges(rows.find((r) => r.key === 'branchName')!).map((b) => b.kind), ['workspace'], 'no theme value: the workspace badge stays');
});

test('footerView: states, buttons and blocking errors', () => {
  const clean = initialEditorState('aaaaaaaaaaaaaaaa');
  assert.equal(footerView(clean, file(), []).visible, false);
  const dirty: EditorState = editorStep(clean, { type: 'edit' }).state;
  const f = footerView(dirty, file(), []);
  assert.equal(f.visible, true);
  assert.equal(f.title, 'Unsaved changes');
  assert.deepEqual(f.buttons.map((b) => [b.label, b.primary, b.disabled]), [['Save', true, false]]);
  assert.equal(footerView(dirty, builtin, []).buttons[0]!.label, 'Save as…');
  assert.equal(footerView(dirty, file(), ['colors.wall: bad']).buttons[0]!.disabled, true);
  assert.deepEqual(footerView(dirty, file(), ['x']).errors, ['x']);
  const keep = editorStep(editorStep(dirty, { type: 'hostTheme', rev: 'bbbbbbbbbbbbbbbb' }).state, { type: 'keepMine' }).state;
  assert.deepEqual(footerView(keep, file(), []).buttons.map((b) => b.label), ['Overwrite anyway', 'Save as…']);
  const saving = editorStep(dirty, { type: 'saveRequested' }).state;
  const fs = footerView(saving, file(), []);
  assert.equal(fs.title, 'Saving…');
  assert.equal(fs.canDiscard, false);
  assert.equal(fs.buttons[0]!.disabled, true);
  const conflict = editorStep(saving, { type: 'done', ok: false, conflict: true }).state;
  assert.deepEqual(footerView(conflict, file(), []).buttons, []);
  const failed = editorStep(saving, { type: 'done', ok: false, message: 'Disk full' }).state;
  assert.equal(footerView(failed, file(), []).message, 'Disk full');
  assert.equal(footerView(dirty, file(), [], 'Too big').message, 'Too big');
});

test('errorSummary shortens long lists', () => {
  assert.deepEqual(errorSummary(['a', 'b'], 4), ['a', 'b']);
  const long = errorSummary(['1', '2', '3', '4', '5', '6'], 4);
  assert.equal(long.length, 5);
  assert.match(long[4]!, /2 more problems/);
});

test('bannerView and closePromptView', () => {
  const clean = initialEditorState('aaaaaaaaaaaaaaaa');
  assert.equal(bannerView(clean), null);
  const dirty = editorStep(clean, { type: 'edit' }).state;
  const disk = editorStep(dirty, { type: 'hostTheme', rev: 'bbbbbbbbbbbbbbbb' }).state;
  assert.equal(bannerView(disk)?.kind, 'changedOnDisk');
  assert.equal(bannerView(disk)?.offerChoice, true);
  const kept = editorStep(disk, { type: 'keepMine' }).state;
  assert.equal(bannerView(kept)?.kind, 'overwrite');
  assert.equal(bannerView(kept)?.offerChoice, false);
  const conflict = editorStep(editorStep(dirty, { type: 'saveRequested' }).state, { type: 'done', ok: false, conflict: true }).state;
  assert.equal(bannerView(conflict)?.kind, 'conflict');
  assert.equal(closePromptView(dirty).canDiscard, true);
  assert.equal(closePromptView(editorStep(dirty, { type: 'saveRequested' }).state).canDiscard, false);
});

test('dropLinesFor: only for writing over an existing file with a known text', () => {
  assert.deepEqual(dropLinesFor('save', builtin, {}), []);
  assert.deepEqual(dropLinesFor('save', file(), {}), []); // no rawText
  assert.deepEqual(dropLinesFor('saveAs', file({ rawText: '{"x":1}' }), {}), []);
  const lines = dropLinesFor('save', file({ rawText: '{"company":"A","mood":"x"}' }), { company: 'A' });
  assert.ok(lines.some((l) => /Unknown key "mood"/.test(l)));
  assert.deepEqual(dropLinesFor('save', file({ exists: false, rawText: '{"mood":1}' }), {}), []);
});

test('request ids and the tracker', () => {
  const next = reqIdFactory();
  assert.deepEqual([next(), next()], ['fd1', 'fd2']);
  const t = new RequestTracker();
  const got: string[] = [];
  t.register('a', (r) => got.push(`a:${r.ok}`));
  assert.equal(t.has('a'), true);
  assert.equal(t.resolve('b', { ok: true }), false);
  assert.equal(t.resolve('a', { ok: false }), true);
  assert.equal(t.resolve('a', { ok: true }), false); // once only
  assert.deepEqual(got, ['a:false']);
  assert.equal(t.size, 0);
});

test('skillSummary: a short status for every skill state', () => {
  assert.equal(skillSummary('missing'), 'Teach Claude first');
  assert.equal(skillSummary('installed'), 'Claude knows how');
  assert.equal(skillSummary('outdated'), 'Update ready');
  assert.equal(skillSummary('modified'), 'Skill edited');
  assert.equal(skillSummary('foreign'), 'Folder in use');
  assert.equal(skillSummary('unknown'), undefined);
});

test('resultSlot: the card\'s own actions render inside the card, the rest at the bottom', () => {
  assert.equal(resultSlot('installSkill'), 'step');
  assert.equal(resultSlot('removeSkill'), 'step');
  assert.equal(resultSlot('copyPrompt'), 'foot');
  for (const a of ['open', 'reload', 'openThemesFolder', 'useUserTheme', 'usePreset', 'useBuiltin'] as const) assert.equal(resultSlot(a), 'bottom');
});
