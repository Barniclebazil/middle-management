import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings, hasPin, pinMatches, slotInfoOf, slotName, themeState } from '../webview/engine/theme.ts';
import type { ThemeState } from '../webview/engine/theme.ts';
import type { OfficeSettings } from '../src/shared/protocol.ts';
import type { LookSpec, OfficeColorKey, OfficeTheme, StaffSpec } from '../src/shared/theme.ts';
import { DEFAULT_SETTINGS, ThemeApplier, layerTheme } from '../webview/engine/themeApply.ts';
import type { ArtPort, ThemeTarget } from '../webview/engine/themeApply.ts';

const STAFF = Array.from({ length: 8 }, (_, i) => `staff-${i}`);
const TEMPS = Array.from({ length: 6 }, (_, i) => `temp-${i}`);

const SETTINGS: OfficeSettings = { companyName: 'Middle Management', branchName: 'Riverside Branch', speechBubbles: true, managerName: 'You', bossQuotes: true };

test('no theme: an empty state that changes nothing', () => {
  const s = themeState(undefined, STAFF, TEMPS);
  assert.equal(s.staff.size, 0);
  assert.equal(s.temps.size, 0);
  assert.deepEqual(s.looks, []);
  assert.equal(s.companyName, undefined);
  assert.deepEqual(s.pools, {});
  assert.equal(s.lineMode, 'add');
  assert.equal(s.smallTalk, undefined);
  assert.equal(effectiveSettings(SETTINGS, s), SETTINGS, 'the very same settings object');
  assert.deepEqual(themeState({}, STAFF, TEMPS).looks, []);
});

test('themeState maps staff i to slot i, temps j to slot j, and gathers the manager and shared lines', () => {
  const theme: OfficeTheme = {
    company: 'Acme', branch: 'Springfield',
    manager: { name: 'Pat', look: { hair: '#112233' }, lines: ['Hi.', 'Bye.'] },
    smallTalk: [['Q?', 'A.']],
    staff: [
      { name: 'Ann', role: 'Sales', look: { head: 'bob' }, lines: ['One', 'Two'], pin: { project: 'web' } },
      { name: 'Bo' },
      { name: 'Cy', lines: [], pin: {} },
    ],
    temps: [{ name: 'Tess', look: { skin: 'deep' } }, {}],
  };
  const s = themeState(theme, STAFF, TEMPS);
  assert.equal(s.companyName, 'Acme');
  assert.equal(s.branchName, 'Springfield');
  assert.equal(s.managerName, 'Pat');
  assert.deepEqual(s.pools.bossVisit, ['Hi.', 'Bye.']);
  assert.deepEqual(s.smallTalk, [['Q?', 'A.']]);
  assert.deepEqual(s.staff.get('staff-0'), { name: 'Ann', role: 'Sales', lines: ['One', 'Two'], pin: { project: 'web' } });
  assert.deepEqual(s.staff.get('staff-1'), { name: 'Bo' });
  assert.deepEqual(s.staff.get('staff-2'), { name: 'Cy' }, 'empty lines and empty pin are dropped');
  assert.equal(s.staff.has('staff-3'), false);
  assert.deepEqual(s.temps.get('temp-0'), { name: 'Tess' });
  assert.deepEqual(s.temps.get('temp-1'), {});
  assert.deepEqual(s.looks, [
    { id: 'manager', spec: { hair: '#112233' } },
    { id: 'staff-0', spec: { head: 'bob' } },
    { id: 'temp-0', spec: { skin: 'deep' } },
  ]);
  assert.equal(slotName(s, 'staff-0'), 'Ann');
  assert.equal(slotName(s, 'temp-0'), 'Tess');
  assert.equal(slotName(s, 'temp-1'), undefined);
  assert.equal(slotName(s, 'staff-7'), undefined);
  assert.equal(slotInfoOf(s, 'temp-0')?.name, 'Tess');
  assert.equal(slotInfoOf(undefined, 'staff-0'), undefined);
});

test('a ninth staff member and a seventh temp are ignored', () => {
  const staff: StaffSpec[] = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, look: { hair: '#000000' } }));
  const s = themeState({ staff, temps: Array.from({ length: 7 }, (_, j) => ({ name: `T${j}`, look: { hair: '#000000' } })) }, STAFF, TEMPS);
  assert.equal(s.staff.size, 8);
  assert.equal(s.temps.size, 6);
  assert.equal(s.looks.length, 14);
  assert.ok(![...s.staff.values()].some((i) => i.name === 'P8'));
  assert.ok(!s.looks.some((l) => l.id === 'staff-8' || l.id === 'temp-6'));
});

test('themeState copies its input (later edits to the theme do not leak in)', () => {
  const theme: OfficeTheme = { staff: [{ name: 'Ann', lines: ['x'] }], manager: { lines: ['y'] }, smallTalk: [['a', 'b']] };
  const s = themeState(theme, STAFF, TEMPS);
  theme.staff![0]!.lines!.push('z');
  theme.manager!.lines!.push('z');
  theme.smallTalk!.push(['c', 'd']);
  assert.deepEqual(s.staff.get('staff-0')!.lines, ['x']);
  assert.deepEqual(s.pools.bossVisit, ['y']);
  assert.equal(s.smallTalk!.length, 1);
});

test('pinMatches: case-insensitive substring; both given = both must match; no pin = false', () => {
  assert.equal(pinMatches(undefined, { project: 'web', title: 'x' }), false);
  assert.equal(pinMatches({}, { project: 'web', title: 'x' }), false, 'a pin that names nothing never matches');
  assert.equal(pinMatches({ project: '' }, { project: 'web' }), false);
  assert.equal(pinMatches({ project: 'web' }, { project: 'My-Web-App' }), true);
  assert.equal(pinMatches({ project: 'WEB' }, { project: 'web-app' }), true);
  assert.equal(pinMatches({ project: 'api' }, { project: 'web-app' }), false);
  assert.equal(pinMatches({ project: 'web' }, {}), false, 'agent without a project');
  assert.equal(pinMatches({ title: 'fix' }, { title: 'Fix the login bug' }), true);
  assert.equal(pinMatches({ title: 'fix' }, { project: 'fix', title: 'Add feature' }), false, 'title pin looks at the title only');
  assert.equal(pinMatches({ project: 'web', title: 'fix' }, { project: 'web-app', title: 'Fix it' }), true);
  assert.equal(pinMatches({ project: 'web', title: 'fix' }, { project: 'web-app', title: 'Add it' }), false);
  assert.equal(pinMatches({ project: 'web', title: 'fix' }, { project: 'api', title: 'Fix it' }), false);
  assert.equal(hasPin(undefined), false);
  assert.equal(hasPin({}), false);
  assert.equal(hasPin({ title: 't' }), true);
});

test('effectiveSettings: theme company, branch and manager name override the settings; the rest stays', () => {
  const none = themeState({}, STAFF, TEMPS);
  assert.equal(effectiveSettings(SETTINGS, none), SETTINGS);
  const all = themeState({ company: 'Acme', branch: 'Springfield', manager: { name: 'Pat' } }, STAFF, TEMPS);
  assert.deepEqual(effectiveSettings(SETTINGS, all), { ...SETTINGS, companyName: 'Acme', branchName: 'Springfield', managerName: 'Pat' });
  const part: ThemeState = themeState({ branch: 'Springfield' }, STAFF, TEMPS);
  const out = effectiveSettings({ ...SETTINGS, companyName: 'Mine', managerName: 'Sam' }, part);
  assert.equal(out.companyName, 'Mine');
  assert.equal(out.branchName, 'Springfield');
  assert.equal(out.managerName, 'Sam');
  assert.equal(SETTINGS.branchName, 'Riverside Branch', 'the input is not modified');
});

// ---------------------------------------------------------------------------
// Receptionist in the theme state

test('themeState gathers the receptionist: name, lines (replace the built-ins) and look', () => {
  const s = themeState({ receptionist: { name: 'Dot', lines: ['Hold please.'], look: { hair: '#445566' } }, manager: { look: { hair: '#112233' } } }, STAFF, TEMPS);
  assert.equal(s.receptionistName, 'Dot');
  assert.deepEqual(s.pools.receptionPhone, ['Hold please.']);
  assert.deepEqual(s.pools.receptionGreeting, ['Hold please.']);
  assert.deepEqual(s.pools.receptionIdle, ['Hold please.']);
  assert.equal(s.pools.receptionAttending, undefined, 'the attending line is not a pool the receptionist lines join');
  assert.deepEqual(s.looks, [{ id: 'manager', spec: { hair: '#112233' } }, { id: 'receptionist', spec: { hair: '#445566' } }]);
  const none = themeState({ receptionist: { name: '', lines: [] } }, STAFF, TEMPS);
  assert.equal(none.receptionistName, undefined);
  assert.deepEqual(none.pools, {});
  assert.equal(themeState({}, STAFF, TEMPS).receptionistName, undefined);
});

// ---------------------------------------------------------------------------
// ThemeApplier

/** A fake art registry: records what the applier asks of it. */
function fakeArt(): ArtPort & { colours: string; calls: string[]; looks: Map<string, LookSpec | undefined> } {
  const art = {
    colours: '{}',
    calls: [] as string[],
    looks: new Map<string, LookSpec | undefined>(),
    applyOfficeColors(c: Partial<Record<OfficeColorKey, string>> | undefined): boolean {
      const key = JSON.stringify(c ?? {});
      const changed = key !== art.colours;
      art.colours = key;
      art.calls.push('colours');
      return changed;
    },
    invalidateArtCaches(): void { art.calls.push('invalidate'); },
    setLook(id: string, spec: LookSpec | undefined): void { art.calls.push(`look:${id}`); art.looks.set(id, spec); },
  };
  return art;
}

function makeApplier(): { applier: ThemeApplier; art: ReturnType<typeof fakeArt>; office: ThemeTarget & { themes: (ThemeState | undefined)[] } } {
  const art = fakeArt();
  const office = {
    themes: [] as (ThemeState | undefined)[],
    bossQuotes: true,
    speechBubbles: true,
    setTheme(t: ThemeState | undefined): void { office.themes.push(t); },
  };
  return { applier: new ThemeApplier({ art, office, staffSlots: STAFF, tempSlots: TEMPS }), art, office };
}

const FULL: OfficeTheme = {
  company: 'Acme', branch: 'Springfield',
  manager: { name: 'Pat', look: { hair: '#112233' }, lines: ['Hi.'] },
  receptionist: { name: 'Dot', look: { head: 'bob' }, lines: ['Hold please.'] },
  colors: { wall: '#223344' },
  smallTalk: [['Q?', 'A.']],
  staff: [{ name: 'Ann', role: 'Sales', look: { head: 'bob' }, pin: { project: 'web' } }, { name: 'Bo' }],
  temps: [{ name: 'Tess', look: { skin: 'deep' } }],
};

test('ThemeApplier: host-only input has the same effect as the old applySettings', () => {
  const { applier, art, office } = makeApplier();
  // The old main.ts logic, verbatim apart from the registry calls.
  let oldHost: OfficeSettings = { ...DEFAULT_SETTINGS };
  const oldApply = (next: OfficeSettings): { settings: OfficeSettings; state: ThemeState; registered: Map<string, LookSpec | undefined> } => {
    const { theme, ...rest } = next;
    oldHost = { ...oldHost, ...rest };
    const state = themeState(theme, STAFF, TEMPS);
    const specs = new Map<string, LookSpec>(state.looks.map((l) => [l.id, l.spec]));
    const registered = new Map<string, LookSpec | undefined>();
    for (const id of [...STAFF, ...TEMPS, 'manager']) registered.set(id, specs.get(id));
    return { settings: effectiveSettings(oldHost, state), state, registered };
  };
  const messages: OfficeSettings[] = [
    { ...SETTINGS, theme: FULL },
    { ...SETTINGS, managerName: 'Sam', speechBubbles: false, theme: { ...FULL, branch: 'Harbour' } },
    { ...SETTINGS, companyName: 'Mine', bossQuotes: false },
  ];
  for (const m of messages) {
    const want = oldApply(m);
    applier.setHost(m);
    applier.apply();
    assert.deepEqual(applier.settings, want.settings);
    assert.deepEqual(applier.state.staff, want.state.staff);
    assert.deepEqual(applier.state.temps, want.state.temps);
    assert.deepEqual(applier.state.looks, want.state.looks);
    assert.deepEqual(applier.state.pools, want.state.pools);
    assert.deepEqual(applier.state.smallTalk, want.state.smallTalk);
    assert.equal(office.themes.at(-1), applier.state, 'the office gets the new state');
    assert.equal(office.bossQuotes, want.settings.bossQuotes !== false);
    assert.equal(office.speechBubbles, want.settings.speechBubbles !== false);
    // Whatever the registry holds now equals what the old code would have registered (unset = built-in look).
    for (const [id, spec] of want.registered) assert.deepEqual(art.looks.get(id), spec, `look ${id}`);
  }
  assert.equal(art.looks.get('receptionist'), undefined);
  assert.equal(applier.hostSettings.companyName, 'Mine');
});

test('ThemeApplier: a message without a theme removes the theme (the built-in looks come back)', () => {
  const { applier, art } = makeApplier();
  applier.setHost({ ...SETTINGS, theme: FULL });
  const first = applier.apply();
  assert.deepEqual(first.looksChanged, ['manager', 'receptionist', 'staff-0', 'temp-0']);
  assert.equal(first.namesChanged, true);
  assert.equal(first.artReset, true, 'a theme with colours resets the art');
  applier.setHost({ ...SETTINGS });
  const second = applier.apply();
  assert.deepEqual(second.looksChanged, ['manager', 'receptionist', 'staff-0', 'temp-0']);
  assert.equal(second.artReset, true, 'the theme colours went away');
  assert.equal(art.looks.get('manager'), undefined);
  assert.equal(art.looks.get('receptionist'), undefined);
  assert.equal(applier.settings.managerName, 'You');
  assert.equal(applier.state.staff.size, 0);
});

test('ThemeApplier: only the looks that changed are re-registered and invalidated', () => {
  const { applier, art } = makeApplier();
  applier.setHost({ ...SETTINGS, theme: FULL });
  applier.apply();
  art.calls.length = 0;
  const again = applier.apply();
  assert.deepEqual(again, { artReset: false, looksChanged: [], namesChanged: false });
  assert.deepEqual(art.calls, ['colours'], 'no re-registration, no cache reset');
  applier.setHost({ ...SETTINGS, theme: { ...FULL, receptionist: { ...FULL.receptionist, look: { head: 'curly' } }, staff: [{ name: 'Ann', look: { head: 'bob' } }, { name: 'Bo', look: { hair: '#abcdef' } }] } });
  art.calls.length = 0;
  const r = applier.apply();
  assert.deepEqual(r.looksChanged, ['receptionist', 'staff-1']);
  assert.deepEqual(art.calls, ['colours', 'look:receptionist', 'look:staff-1']);
  assert.equal(r.artReset, false);
  assert.equal(r.namesChanged, true, 'a role and a pin went away');
});

test('ThemeApplier: colours reset the art only when they change, and are applied before the looks', () => {
  const { applier, art } = makeApplier();
  const withColours = (c: Partial<Record<OfficeColorKey, string>> | undefined, look?: LookSpec): OfficeTheme => ({ colors: c, receptionist: look ? { look } : undefined });
  applier.setHost({ ...SETTINGS });
  assert.equal(applier.apply().artReset, false, 'no theme, no colours: nothing to reset');
  applier.preview(withColours({ wall: '#102030' }, { head: 'bob' }));
  art.calls.length = 0;
  const a = applier.apply();
  assert.equal(a.artReset, true);
  assert.deepEqual(art.calls, ['colours', 'invalidate', 'look:receptionist'], 'colours, cache reset, then looks');
  // A colour drag sends many applies; the same colours never reset again.
  for (let i = 0; i < 5; i++) assert.equal(applier.apply().artReset, false);
  applier.preview(withColours({ wall: '#102031' }));
  assert.equal(applier.apply().artReset, true);
  assert.equal(applier.apply().artReset, false);
  applier.preview(null);
  assert.equal(applier.apply().artReset, true, 'reverting to the host (no colours) restores the built-in office');
  assert.equal(applier.apply().artReset, false);
});

test('ThemeApplier: preview layers a draft over the host theme and null reverts', () => {
  const { applier, art, office } = makeApplier();
  applier.setHost({ ...SETTINGS, theme: FULL });
  applier.apply();
  assert.equal(applier.previewing, false);
  const draft: OfficeTheme = { branch: 'Draft Branch', receptionist: { name: 'Ro', lines: ['Draft line.'] }, staff: [{ name: 'Zed', look: { head: 'spiky' } }], colors: {} };
  applier.preview(draft);
  const r = applier.apply();
  assert.equal(applier.previewing, true);
  assert.equal(applier.settings.branchName, 'Draft Branch');
  assert.equal(applier.settings.companyName, 'Acme', 'sections the draft lacks come from the host theme');
  assert.equal(applier.state.managerName, 'Pat');
  assert.equal(applier.state.receptionistName, 'Ro');
  assert.deepEqual(applier.state.pools.receptionPhone, ['Draft line.']);
  assert.equal(applier.state.staff.get('staff-0')?.name, 'Zed');
  assert.equal(applier.state.staff.has('staff-1'), false, 'the draft staff list replaces the host one');
  assert.equal(applier.state.temps.get('temp-0')?.name, 'Tess');
  assert.deepEqual(art.looks.get('staff-0'), { head: 'spiky' });
  assert.equal(art.looks.get('receptionist'), undefined, 'her look override is gone in the draft');
  assert.ok(r.looksChanged.includes('receptionist') && r.looksChanged.includes('staff-0'));
  assert.equal(r.artReset, true, 'the draft has empty colours');
  assert.equal(r.namesChanged, true);
  assert.equal(office.themes.at(-1), applier.state);
  // The host theme is untouched: reverting brings everything back.
  applier.preview(null);
  const back = applier.apply();
  assert.equal(applier.previewing, false);
  assert.equal(applier.settings.branchName, 'Springfield');
  assert.equal(applier.state.receptionistName, 'Dot');
  assert.equal(applier.state.staff.get('staff-1')?.name, 'Bo');
  assert.deepEqual(art.looks.get('receptionist'), { head: 'bob' });
  assert.deepEqual(art.looks.get('staff-0'), { head: 'bob' });
  assert.equal(back.artReset, true);
  assert.deepEqual(back.looksChanged.sort(), ['receptionist', 'staff-0']);
  // A new host message while previewing keeps the draft on top.
  applier.preview(draft);
  applier.setHost({ ...SETTINGS, managerName: 'Sam', theme: { ...FULL, company: 'Other' } });
  applier.apply();
  assert.equal(applier.settings.companyName, 'Other');
  assert.equal(applier.settings.branchName, 'Draft Branch');
});

test('layerTheme: draft sections win whole; the host is not modified', () => {
  const host: OfficeTheme = { company: 'A', staff: [{ name: 'x' }], colors: { wall: '#111111' } };
  const draft: OfficeTheme = { staff: [], colors: { trim: '#222222' } };
  const out = layerTheme(host, draft)!;
  assert.deepEqual(out, { company: 'A', staff: [], colors: { trim: '#222222' } });
  assert.deepEqual(host, { company: 'A', staff: [{ name: 'x' }], colors: { wall: '#111111' } });
  assert.equal(layerTheme(host, null), host);
  assert.equal(layerTheme(undefined, null), undefined);
  assert.deepEqual(layerTheme(undefined, draft), draft);
});

test('ThemeApplier with the real art registry: colours, the receptionist look and the caches', async () => {
  const ART = new URL('../webview/art/', import.meta.url).href;
  const specA: string = `${ART}index.ts`;
  const specB: string = new URL('../webview/engine/themeArt.ts', import.meta.url).href;
  const art = await import(specA);
  const { artPort } = await import(specB);
  const office = { bossQuotes: true, speechBubbles: true, setTheme(): void {} };
  const applier = new ThemeApplier({ art: artPort, office, staffSlots: art.STAFF_SLOT_IDS, tempSlots: art.TEMP_SLOT_IDS });
  const builtIn = art.getLook('receptionist');
  try {
    applier.setHost({ ...SETTINGS, theme: { colors: { wall: '#3a2f55' }, receptionist: { look: { hair: '#ff00aa' } }, staff: [{}, {}, { look: { hair: '#00ffaa' } }] } });
    const r = applier.apply();
    assert.equal(r.artReset, true);
    assert.deepEqual(r.looksChanged, ['receptionist', 'staff-2']);
    assert.equal(art.getLook('receptionist').outfit.hair, '#ff00aa');
    assert.equal(art.getLook('staff-2').outfit.hair, '#00ffaa');
    assert.equal(art.getLook('staff-2').lanyard, true, 'the help desk keeps its lanyard');
    assert.equal(art.C.wall, '#3a2f55');
    assert.equal(applier.apply().artReset, false);
    applier.setHost({ ...SETTINGS });
    const back = applier.apply();
    assert.equal(back.artReset, true);
    assert.equal(art.getLook('receptionist').outfit.hair, builtIn.outfit.hair);
    assert.deepEqual({ ...art.C }, { ...art.BASE_C });
  } finally {
    art.applyOfficeColors(undefined);
    art.invalidateArtCaches();
  }
});

test('themeState: the side characters\' names and looks, and the IT fixer is Dez and the critic Fenwick', () => {
  const s = themeState({
    cleaner: { name: 'Mara Quill', look: { hair: '#112233' } },
    vendor: { name: 'Odo Pell' },
    itFixer: { look: { shirt: '#445566' } },
    itCritic: { name: 'Sable Rook', look: { glasses: '#778899' } },
  }, STAFF, TEMPS);
  assert.deepEqual(s.npcs, { cleaner: { name: 'Mara Quill' }, vendor: { name: 'Odo Pell' }, itCritic: { name: 'Sable Rook' } });
  assert.deepEqual(s.looks, [
    { id: 'cleaner', spec: { hair: '#112233' } },
    { id: 'dez', spec: { shirt: '#445566' } },
    { id: 'fenwick', spec: { glasses: '#778899' } },
  ]);
  assert.deepEqual(themeState({ cleaner: {} }, STAFF, TEMPS).looks, []);
});

test('ThemeApplier: NPC looks are registered, left alone when unchanged, and reset when the theme goes', () => {
  const { applier, art } = makeApplier();
  applier.setHost({ ...SETTINGS, theme: { cleaner: { look: { hair: '#abcdef' } }, itCritic: { look: { glasses: '#123456' } } } });
  assert.deepEqual(applier.apply().looksChanged, ['cleaner', 'fenwick']);
  assert.deepEqual(art.looks.get('cleaner'), { hair: '#abcdef' });
  assert.deepEqual(applier.apply().looksChanged, []);
  applier.setHost({ ...SETTINGS });
  assert.deepEqual(applier.apply().looksChanged, ['cleaner', 'fenwick']);
  assert.equal(art.looks.get('cleaner'), undefined, 'back to the built-in look');
  assert.equal(art.looks.get('fenwick'), undefined);
});

test('ThemeApplier with the real art registry: NPC overrides keep their costume and carry, and a theme change resets them', async () => {
  const ART = new URL('../webview/art/', import.meta.url).href;
  const specA: string = `${ART}index.ts`;
  const specB: string = new URL('../webview/engine/themeArt.ts', import.meta.url).href;
  const art = await import(specA);
  const { artPort } = await import(specB);
  const office = { bossQuotes: true, speechBubbles: true, setTheme(): void {} };
  const applier = new ThemeApplier({ art: artPort, office, staffSlots: art.STAFF_SLOT_IDS, tempSlots: art.TEMP_SLOT_IDS });
  const builtIn = { cleaner: art.NPC_LOOKS.cleaner, dez: art.NPC_LOOKS.dez, fenwick: art.NPC_LOOKS.fenwick, vendor: art.NPC_LOOKS.vendor };
  try {
    applier.setHost({ ...SETTINGS, theme: {
      cleaner: { look: { hair: '#ff00aa', outer: '#00aa44' } },
      itFixer: { look: { shirt: '#445566' } },
      itCritic: { look: { glasses: '#778899' } },
      vendor: { look: { build: 'tall' } },
    } });
    assert.deepEqual(applier.apply().looksChanged, ['cleaner', 'vendor', 'dez', 'fenwick']);
    const cleaner = art.getLook('cleaner');
    assert.equal(cleaner.outfit.hair, '#ff00aa');
    assert.equal(cleaner.outfit.outer, '#00aa44');
    assert.equal(cleaner.carry, 'bucket', 'the bucket stays');
    assert.equal(cleaner.torso, 'tabard', 'colour-only overrides keep the tabard');
    assert.equal(cleaner.head, builtIn.cleaner.head, 'and the headband');
    assert.equal(cleaner.pal.y, cleaner.outfit.gloves, 'and the gloves');
    assert.equal(art.getLook('dez').slouch, true);
    assert.equal(art.getLook('dez').outfit.shirt, '#445566');
    assert.equal(art.getLook('fenwick').highWaist, true);
    assert.equal(art.getLook('fenwick').outfit.glasses, '#778899');
    assert.equal(art.getLook('vendor').build, 'tall');
    assert.equal(art.getLook('vendor').torso, 'apron');
    // An outfit or head the theme sets is taken as asked, but the bucket still goes with the cleaner.
    applier.setHost({ ...SETTINGS, theme: { cleaner: { look: { outfit: 'plain', head: 'bob' } } } });
    applier.apply();
    assert.equal(art.getLook('cleaner').torso, 'plain');
    assert.equal(art.getLook('cleaner').head, art.HEAD_SETS.bob);
    assert.equal(art.getLook('cleaner').carry, 'bucket');
    applier.setHost({ ...SETTINGS });
    applier.apply();
    for (const id of ['cleaner', 'vendor', 'dez', 'fenwick']) assert.equal(art.getLook(id), builtIn[id as keyof typeof builtIn], `${id} is the built-in look again`);
  } finally {
    art.applyOfficeColors(undefined);
    art.invalidateArtCaches();
  }
});
