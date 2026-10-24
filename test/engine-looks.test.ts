import { test } from 'node:test';
import assert from 'node:assert/strict';

// The art modules use DOM types the root tsconfig lacks, so they are loaded
// through computed specifiers (see engine-world.ts); the values are untyped here.
const ART = new URL('../webview/art/', import.meta.url).href;
const looksSpec: string = `${ART}looks.ts`;
const charsSpec: string = `${ART}characters.ts`;
const looks = await import(looksSpec);
const chars = await import(charsSpec);

const { LOOKS, HEAD_SETS, ARCHETYPES, TEMP_LOOKS, STAFF_SLOT_IDS, TEMP_SLOT_IDS, MANAGER_LOOK, buildLook, defaultSlotLook } = looks;

test('HEAD_SETS has the 15 spec style names, each a full head set', () => {
  const names = ['boss', 'assistant', 'prankster', 'receptionist', 'crossword', 'cat', 'chili', 'knitting', 'hr', 'short', 'spiky', 'ponytail', 'curly', 'bob', 'headset'];
  assert.deepEqual(Object.keys(HEAD_SETS).sort(), [...names].sort());
  for (const n of names) {
    for (const view of ['front', 'back', 'side']) assert.ok(HEAD_SETS[n][view].length > 0, `${n}.${view}`);
  }
  assert.equal(HEAD_SETS['boss'], LOOKS['manager'].head);
  assert.equal(HEAD_SETS['bob'], LOOKS['temp5'].head);
});

test('there are 16 built-in looks and 8 + 6 slot ids', () => {
  assert.equal(Object.keys(LOOKS).length, 16);
  assert.equal(MANAGER_LOOK, 'manager');
  assert.deepEqual(STAFF_SLOT_IDS, Array.from({ length: 8 }, (_, i) => `staff-${i}`));
  assert.deepEqual(TEMP_SLOT_IDS, Array.from({ length: 6 }, (_, i) => `temp-${i}`));
});

test('buildLook with an empty spec reproduces the fallback', () => {
  for (const id of Object.keys(LOOKS)) {
    const base = LOOKS[id];
    const b = buildLook('x', {}, base);
    assert.equal(b.id, 'x');
    assert.equal(b.role, base.role);
    assert.equal(b.build, base.build);
    assert.equal(b.torso, base.torso);
    assert.equal(b.skirt, base.skirt);
    assert.equal(b.shortSleeves, base.shortSleeves);
    assert.equal(b.belt, base.belt);
    assert.equal(b.head, base.head);
    assert.deepEqual(b.pal, base.pal);
    assert.notEqual(b.outfit, base.outfit); // a copy, so later edits cannot leak back
  }
});

test('a hair colour override changes pal.h and the derived shade, and re-derives the highlight', () => {
  const base = LOOKS['receptionist']; // has an explicit highlight
  const b = buildLook('x', { hair: '#112233' }, base);
  assert.equal(b.pal.h, '#112233');
  assert.notEqual(b.pal.H, base.pal.H);
  assert.notEqual(b.pal.i, base.pal.i);
  assert.equal(base.pal.h, '#a65334'); // fallback untouched
  const withHi = buildLook('x', { hair: '#112233', hairHighlight: '#aabbcc' }, base);
  assert.equal(withHi.pal.i, '#aabbcc');
  assert.equal(buildLook('x', { hairHighlight: '#aabbcc' }, base).pal.h, base.pal.h);
});

test('other colour and flag keys map onto the palette and look args', () => {
  const b = buildLook('x', {
    eye: '#010203', shirt: '#102030', facialHair: '#404040', beltColor: '#505050', glasses: '#606060', bow: '#707070',
    skin: 'deep', build: 'tall', outfit: 'vest', skirt: true, shortSleeves: true, belt: true,
  }, LOOKS['manager']);
  assert.equal(b.pal.e, '#010203');
  assert.equal(b.pal.t, '#102030');
  assert.equal(b.pal.d, '#404040');
  assert.equal(b.pal.B, '#505050');
  assert.equal(b.pal.k, '#606060');
  assert.equal(b.pal.b, '#707070');
  assert.equal(b.pal.s, '#77492d'); // SKIN.deep
  assert.equal(b.build, 'tall');
  assert.equal(b.torso, 'vest');
  assert.equal(b.skirt, true);
  assert.equal(b.shortSleeves, true);
  assert.equal(b.pal.l, b.pal.s); // short sleeves: bare forearms
  assert.equal(b.belt, true);
});

test('a head override swaps the head grid; unknown names keep the fallback', () => {
  const base = LOOKS['temp0'];
  assert.equal(buildLook('x', { head: 'cat' }, base).head, HEAD_SETS['cat']);
  const junk = buildLook('x', { head: 'nope', skin: 'purple', build: 'giant', outfit: 'tuxedo' }, base);
  assert.equal(junk.head, base.head);
  assert.equal(junk.pal.s, base.pal.s);
  assert.equal(junk.build, base.build);
  assert.equal(junk.torso, base.torso);
  // Names that exist on Object.prototype are not head styles.
  assert.equal(buildLook('x', { head: 'constructor', skin: 'toString' }, base).head, base.head);
});

test('defaultSlotLook returns the inherited look under the slot id', () => {
  const s0 = defaultSlotLook('staff-0');
  assert.equal(s0.id, 'staff-0');
  assert.equal(s0.head, HEAD_SETS['assistant']);
  assert.deepEqual(s0.pal, LOOKS[ARCHETYPES[0]].pal);
  assert.equal(defaultSlotLook('staff-7').head, HEAD_SETS['hr']);
  const t3 = defaultSlotLook('temp-3');
  assert.equal(t3.id, 'temp-3');
  assert.equal(t3.head, LOOKS[TEMP_LOOKS[3]].head);
  assert.equal(LOOKS['assistant'].id, 'assistant'); // the built-in is not mutated
  assert.throws(() => defaultSlotLook('staff-8'));
});

test('the registry holds the built-ins and slot looks, and round-trips register/get/invalidate', () => {
  const { registerLook, getLook, invalidateLook, getCharacterFrame } = chars;
  for (const id of [...Object.keys(LOOKS), ...STAFF_SLOT_IDS, ...TEMP_SLOT_IDS]) assert.ok(getLook(id), id);
  assert.equal(getLook('staff-2').id, 'staff-2');
  assert.equal(getLook('staff-2').head, HEAD_SETS['headset']);
  assert.equal(getLook('receptionist').head, HEAD_SETS['receptionist']); // her own look, not a slot
  assert.equal(getLook('nobody'), undefined);

  const custom = buildLook('guest', { hair: '#ff0000' }, LOOKS['temp0']);
  registerLook(custom);
  assert.equal(getLook('guest'), custom);
  const replaced = buildLook('guest', { hair: '#00ff00' }, LOOKS['temp0']);
  registerLook(replaced);
  assert.equal(getLook('guest'), replaced);
  assert.doesNotThrow(() => invalidateLook('guest'));
  assert.doesNotThrow(() => invalidateLook('never-registered'));
  assert.equal(typeof getCharacterFrame, 'function');
});

test('rendering frames needs a canvas, which Node lacks; the unknown-id fallback is covered in the browser harness', { skip: typeof (globalThis as { document?: unknown }).document === 'undefined' }, () => {
  const { getCharacterFrame } = chars;
  const known = getCharacterFrame('temp0', 'stand', 'down', 0);
  assert.equal(getCharacterFrame('no-such-look', 'stand', 'down', 0).width, known.width);
});

// ---------------------------------------------------------------------------
// The IT Help Desk, the headset, sitPhone, look specs (task 3.7)

const { specOfLook, specOfDef, builtinSpecOf, builtinLookIdOf, RECEPTIONIST_LOOK, ALL_LOOKS } = looks;

test('the 3rd archetype is the IT Help Desk: headset, polo with a lanyard, its own colours', () => {
  assert.equal(ARCHETYPES[2], 'helpdesk');
  assert.equal(ARCHETYPES.includes('receptionist'), false);
  const h = LOOKS['helpdesk'];
  assert.equal(h.role, 'IT Help Desk');
  assert.equal(h.head, HEAD_SETS['headset']);
  assert.equal(h.torso, 'polo');
  assert.equal(h.lanyard, true);
  assert.equal(h.shortSleeves, true);
  assert.equal(defaultSlotLook('staff-2').head, HEAD_SETS['headset']);
  assert.equal(defaultSlotLook('staff-2').lanyard, true);
  // The receptionist stays a look of her own and is drawn like the manager is.
  assert.equal(RECEPTIONIST_LOOK, 'receptionist');
  assert.equal(LOOKS['receptionist'].role, 'Receptionist');
  assert.deepEqual(ALL_LOOKS.slice(0, 2), ['manager', 'receptionist']);
  assert.equal(ALL_LOOKS.length, 16);
});

test('the headset head draws the band and cups with the bow colour (b) and its highlight (z) in every view', () => {
  const hs = HEAD_SETS['headset'];
  for (const view of ['front', 'back', 'side']) {
    assert.equal(hs[view].length, 11, view);
    for (const row of hs[view]) assert.equal(row.length, 12, `${view}: ${row}`);
    assert.ok(hs[view].some((r: string) => r.includes('b')), view);
    assert.ok(hs[view].some((r: string) => r.includes('z')), view);
  }
  const h = LOOKS['helpdesk'];
  assert.equal(h.pal.b, '#2c2b31');
  assert.notEqual(h.pal.z, h.pal.b);
  // A theme can put anyone in a headset; the band follows that look's bow colour.
  const cat = buildLook('x', { head: 'headset', bow: '#123456' }, LOOKS['cat']);
  assert.equal(cat.head, hs);
  assert.equal(cat.pal.b, '#123456');
  // A look built on the help desk keeps the lanyard; one built on anyone else has none.
  assert.equal(buildLook('x', { outfit: 'suit' }, LOOKS['helpdesk']).lanyard, true);
  assert.equal(buildLook('x', { head: 'headset' }, LOOKS['temp0']).lanyard, undefined);
});

test('sitPhone is a seated pose for every look, with listening, blinking and talking frames', () => {
  const { POSES, ALL_POSES, frameAt } = chars;
  const p = POSES['sitPhone'];
  assert.ok(ALL_POSES.includes('sitPhone'));
  assert.equal(p.seated, true);
  assert.equal(p.managerOnly, false);
  assert.deepEqual(p.dirs, ['down']);
  assert.equal(p.durations.length, p.frames);
  assert.equal(frameAt('sitPhone', 0), 0);
});

test('specOfLook reproduces every built-in through buildLook (same palette, head, build, outfit and flags)', () => {
  for (const id of Object.keys(LOOKS)) {
    const def = LOOKS[id];
    const spec = specOfLook(id);
    assert.deepEqual(spec, specOfDef(def), id);
    // Starting from the look itself (what a slot does) and from a bare look that sets few colours.
    for (const fallback of [def, buildLook('bare', {}, { ...LOOKS['temp3'], outfit: { skin: LOOKS['temp3'].outfit.skin, hair: '#000000', shirt: '#000000', pants: '#000000', shoes: '#000000' } })]) {
      const b = buildLook(id, spec, fallback);
      assert.deepEqual(b.pal, def.pal, `${id} from ${fallback.id}`);
      assert.equal(b.head, def.head, id);
      assert.equal(b.build, def.build, id);
      assert.equal(b.torso, def.torso, id);
      assert.equal(b.skirt, def.skirt, id);
      assert.equal(b.shortSleeves, def.shortSleeves, id);
      assert.equal(b.belt, def.belt, id);
    }
  }
  assert.deepEqual(specOfLook('helpdesk'), {
    head: 'headset', skin: 'olive', build: 'normal', outfit: 'polo', hair: '#5b3a26', shirt: '#34587f', collar: '#4d74a0',
    accent: '#c4453b', accent2: '#eef0ea', pants: '#9a8862', shoes: '#3a2c22', bow: '#2c2b31', skirt: false, shortSleeves: true, belt: true,
  });
  assert.deepEqual(specOfLook('nobody'), {});
  assert.deepEqual(specOfLook('constructor'), {});
});

test('builtinSpecOf maps manager, receptionist, staff-i and temp-j to their built-ins', () => {
  assert.deepEqual(builtinSpecOf('manager'), specOfLook('manager'));
  assert.deepEqual(builtinSpecOf('receptionist'), specOfLook('receptionist'));
  ARCHETYPES.forEach((arch: string, i: number) => {
    assert.equal(builtinLookIdOf(`staff-${i}`), arch);
    assert.deepEqual(builtinSpecOf(`staff-${i}`), specOfLook(arch));
  });
  TEMP_LOOKS.forEach((t: string, j: number) => assert.deepEqual(builtinSpecOf(`temp-${j}`), specOfLook(t)));
  assert.equal(builtinSpecOf('staff-2').head, 'headset');
  for (const bad of ['sign', 'staff-8', 'temp-6', 'helpdesk', '']) assert.deepEqual(builtinSpecOf(bad), {}, bad);
});

test('LOOK_FIELD_USE lists only the fields a look draws', () => {
  const { LOOK_FIELD_USE, lookFieldUse } = chars;
  const always = ['head', 'build', 'outfit', 'skin', 'skirt', 'shortSleeves', 'hair', 'sleeve', 'pants', 'shoes', 'eye'];
  for (const id of Object.keys(LOOKS)) {
    const use: string[] = LOOK_FIELD_USE[id];
    for (const f of always) assert.ok(use.includes(f), `${id} uses ${f}`);
  }
  const has = (id: string, f: string): boolean => LOOK_FIELD_USE[id].includes(f);
  // the shirt only where it shows: the cat lady's buttoned cardigan (with its own collar colour) hides it
  assert.ok(has('helpdesk', 'shirt') && !has('cat', 'shirt'));
  // tie only on outfits with a tie
  assert.ok(has('manager', 'tie') && has('assistant', 'tie') && !has('helpdesk', 'tie') && !has('receptionist', 'tie'));
  // legs only with a skirt; belt colour only with a tucked-in shirt and no skirt
  assert.ok(has('receptionist', 'legs') && !has('manager', 'legs'));
  assert.ok(has('assistant', 'beltColor') && !has('manager', 'beltColor') && !has('cat', 'beltColor'));
  assert.ok(!has('cat', 'belt') && has('manager', 'belt'));
  // glasses, facial hair and bow only where the head draws them
  assert.ok(has('assistant', 'glasses') && !has('manager', 'glasses'));
  assert.ok(has('hr', 'facialHair') && !has('manager', 'facialHair'));
  assert.ok(has('helpdesk', 'bow') && has('cat', 'bow') && !has('manager', 'bow'));
  // the lanyard uses accent and accent2; the floral top does too; a plain polo does not
  assert.ok(has('helpdesk', 'accent') && has('helpdesk', 'accent2') && has('knitting', 'accent2'));
  assert.ok(!has('temp0', 'accent') && !has('temp0', 'accent2'));
  // an edited look: give the help desk a suit and the tie shows up
  assert.ok(lookFieldUse(buildLook('x', { outfit: 'suit' }, LOOKS['helpdesk'])).includes('tie'));
});

test('the starter theme equals the built-ins: every look is specOfLook, the colours are BASE_C', async () => {
  const { starterTheme } = await import('../src/shared/themeStarter.ts');
  const paletteSpec: string = `${ART}palette.ts`;
  const palette = await import(paletteSpec);
  const theme = JSON.parse(starterTheme('/s.json'));
  assert.deepEqual(theme.manager.look, specOfLook('manager'));
  assert.deepEqual(theme.receptionist.look, specOfLook('receptionist'));
  assert.equal(theme.staff.length, ARCHETYPES.length);
  ARCHETYPES.forEach((arch: string, i: number) => {
    assert.deepEqual(theme.staff[i].look, specOfLook(arch), `staff[${i}]`);
    assert.equal(theme.staff[i].role, LOOKS[arch].role, `staff[${i}].role`);
  });
  TEMP_LOOKS.forEach((t: string, j: number) => assert.deepEqual(theme.temps[j].look, specOfLook(t), `temps[${j}]`));
  const base = Object.fromEntries(Object.entries(palette.OFFICE_COLOR_SHADES).map(([k, keys]) => [k, palette.BASE_C[(keys as string[])[0]!]]));
  assert.deepEqual(theme.colors, base);
});

test('the starter titles, sample lines, IT names and furniture colours equal the built-ins', async () => {
  const { starterThemeObject } = await import('../src/shared/themeStarter.ts');
  const { TITLE_KEYS, LINE_POOL_KEYS } = await import('../src/shared/theme.ts');
  const { IT_SUPPORT_ROLE } = await import('../src/shared/itSupport.ts');
  const { managerTooltip, receptionistTooltip, cleanerTooltip, vendorTooltip, itTooltip } = await import('../webview/engine/tooltip.ts');
  const { LINE_POOLS } = await import('../webview/engine/lines.ts');
  const { IT_DEZ_NAME, IT_FENWICK_NAME } = await import('../webview/engine/itCrew.ts');
  const paletteSpec: string = `${ART}palette.ts`;
  const palette = await import(paletteSpec);
  const t = starterThemeObject() as {
    titles: Record<string, string>;
    lines: Record<string, (string | string[])[]>;
    itFixer: { name: string };
    itCritic: { name: string };
    colors: Record<string, string>;
  };
  const builtIn: Record<string, string> = {
    manager: LOOKS['manager'].role,
    receptionist: LOOKS['receptionist'].role,
    cleaner: cleanerTooltip().title,
    temp: LOOKS['temp0'].role,
    vendor: vendorTooltip().title,
    itSupport: IT_SUPPORT_ROLE,
  };
  assert.deepEqual(Object.keys(t.titles).sort(), [...TITLE_KEYS].sort());
  for (const k of TITLE_KEYS) assert.equal(t.titles[k], builtIn[k], `titles.${k}`);
  // the tooltips' own defaults agree with the looks
  assert.ok(managerTooltip('x').title.includes(builtIn['manager']!));
  assert.equal(receptionistTooltip().title, builtIn['receptionist']);
  assert.ok(itTooltip('dez').title.includes(builtIn['itSupport']!));
  for (const id of TEMP_LOOKS) assert.equal(LOOKS[id].role, builtIn['temp'], id);

  assert.deepEqual(Object.keys(t.lines).sort(), [...LINE_POOL_KEYS].sort());
  for (const k of LINE_POOL_KEYS) {
    const pool = (LINE_POOLS[k] as readonly (string | readonly string[])[]).map((e) => JSON.stringify(e));
    assert.ok(t.lines[k]!.length > 0, `lines.${k} is empty`);
    for (const e of t.lines[k]!) assert.ok(pool.includes(JSON.stringify(e)), `lines.${k}: not in the built-in pool: ${JSON.stringify(e)}`);
  }

  assert.equal(t.itFixer.name, IT_DEZ_NAME);
  assert.equal(t.itCritic.name, IT_FENWICK_NAME);

  // every furniture colour, not just the first shade of each key, is the built-in value
  const base = Object.fromEntries(Object.entries(palette.OFFICE_COLOR_SHADES).map(([k, keys]) => [k, palette.BASE_C[(keys as string[])[0]!]]));
  assert.deepEqual(t.colors, base);
});

test('the cleaner, the vendor and the IT pair are NPC looks outside LOOKS, so the Staff tab and theme slots never offer them', () => {
  const { NPC_LOOKS, NPC_LOOK_IDS, CLEANER_LOOK, VENDOR_LOOK, ALL_LOOKS } = looks;
  assert.deepEqual(NPC_LOOK_IDS, ['cleaner', 'vendor', 'dez', 'fenwick']);
  assert.equal(CLEANER_LOOK, 'cleaner');
  assert.equal(VENDOR_LOOK, 'vendor');
  for (const id of NPC_LOOK_IDS) {
    assert.equal(Object.hasOwn(LOOKS, id), false, id);
    assert.equal(ALL_LOOKS.includes(id), false, id);
    assert.equal(NPC_LOOKS[id].id, id);
    assert.equal(chars.getLook(id), NPC_LOOKS[id], `${id} is registered`);
  }
  // rubber gloves: the cleaner's palette has the glove keys, the built-ins do not
  assert.equal(NPC_LOOKS['cleaner'].pal.y, NPC_LOOKS['cleaner'].outfit.gloves);
  for (const id of Object.keys(LOOKS)) assert.equal(LOOKS[id].pal.y, undefined, id);
});

test('onlyLooks: poses with art for some looks only fall back for the others; mugSip and chairSpin stay manager-only', () => {
  const { POSES, ALL_POSES, poseForLook, lookHasPose } = chars;
  for (const p of ALL_POSES) {
    const info = POSES[p];
    assert.equal(info.durations.length, info.frames, p);
    // managerOnly is exactly "only the manager"
    assert.equal(info.managerOnly, Boolean(info.onlyLooks && info.onlyLooks.length === 1 && info.onlyLooks[0] === 'manager'), p);
    if (info.onlyLooks) {
      assert.ok(info.fallback, `${p} has a fallback`);
      assert.equal(POSES[info.fallback].onlyLooks, undefined, `${p} falls back to a pose every look has`);
      assert.equal(POSES[info.fallback].seated, info.seated, `${p} falls back to a pose seated the same way`);
    }
  }
  assert.equal(poseForLook('manager', 'mugSip'), 'mugSip');
  assert.equal(poseForLook('assistant', 'mugSip'), 'sitIdle');
  assert.equal(poseForLook('staff-3', 'chairSpin'), 'sitIdle');
  assert.equal(poseForLook('manager', 'pickFood'), 'pickFood');
  assert.equal(poseForLook('vendor', 'pickFood'), 'stand');
  assert.equal(poseForLook('cleaner', 'wipe'), 'wipe');
  assert.equal(poseForLook('temp-0', 'wipe'), 'stand');
  assert.equal(poseForLook('vendor', 'pushCart'), 'pushCart');
  assert.equal(poseForLook('cleaner', 'pushCart'), 'walk');
  assert.equal(lookHasPose('temp-2', 'deskSip'), true);
  assert.equal(lookHasPose('cleaner', 'mugSip'), false);
});

test('deskSip is a seated 4-frame pose for every look; wipe faces left/right; the engine mirror lists it as seated', async () => {
  const { POSES, ALL_POSES } = chars;
  const types = await import(new URL('../webview/engine/types.ts', import.meta.url).href);
  const p = POSES['deskSip'];
  assert.equal(p.seated, true);
  assert.equal(p.frames, 4);
  assert.equal(p.onlyLooks, undefined);
  assert.deepEqual(p.dirs, ['down']);
  for (const d of ['left', 'right', 'down']) assert.ok(POSES['wipe'].dirs.includes(d), d);
  for (const pose of ALL_POSES) assert.equal(types.SEATED_POSES.has(pose), POSES[pose].seated, pose);
});

test('food items: three ids with rectangular rows; the cart placement puts the cart ahead of the vendor', async () => {
  const { FOOD_IDS, FOOD_ROWS, DEFAULT_FOOD } = chars;
  assert.deepEqual(FOOD_IDS, ['carrotCake', 'doughnut', 'crisps']);
  assert.ok(FOOD_IDS.includes(DEFAULT_FOOD));
  for (const id of FOOD_IDS) {
    const rows = FOOD_ROWS[id];
    assert.ok(rows.length >= 3 && rows.length <= 6, id);
    for (const r of rows) assert.equal(r.length, rows[0].length, id);
  }
  const cart = await import(`${ART}foodCart.ts`);
  for (const f of ['left', 'right', 'up', 'down']) {
    const size = cart.FOOD_CART_SIZE[f];
    const a = cart.FOOD_CART_ANCHOR[f];
    assert.equal(a.y, size.h, f);
    const p = cart.foodCartPlacement(f, 100, 200);
    assert.equal(p.x + a.x, 100 + cart.FOOD_CART_OFFSET[f].dx, f);
    assert.equal(p.y + a.y, 200 + cart.FOOD_CART_OFFSET[f].dy, f);
    assert.equal(p.sortY, 200 + cart.FOOD_CART_SORT_DY[f], f);
  }
  assert.ok(cart.foodCartPlacement('right', 100, 200).x > 100);
  assert.ok(cart.foodCartPlacement('left', 100, 200).x + cart.FOOD_CART_SIZE.left.w < 100);
  assert.ok(cart.foodCartPlacement('down', 100, 200).sortY > 200, 'in front of the vendor');
  assert.ok(cart.foodCartPlacement('up', 100, 200).sortY < 200, 'behind the vendor');
});

// ---------------------------------------------------------------------------
// The IT support pair (dez and fenwick) and their poses: fixPc, scoff, readCard

const IT_POSES = ['fixPc', 'scoff', 'readCard'];
const IT_IDS = ['dez', 'fenwick'];

test('dez and fenwick: one shared job title, distinct silhouettes (messy hair and stubble vs parting and big glasses)', () => {
  const { NPC_LOOKS, DEZ_LOOK, FENWICK_LOOK, IT_SUPPORT_ROLE } = looks;
  assert.equal(DEZ_LOOK, 'dez');
  assert.equal(FENWICK_LOOK, 'fenwick');
  assert.equal(IT_SUPPORT_ROLE, 'IT support');
  assert.equal(chars.IT_SUPPORT_ROLE, IT_SUPPORT_ROLE);
  const dez = NPC_LOOKS['dez'];
  const fen = NPC_LOOKS['fenwick'];
  for (const d of [dez, fen]) {
    assert.equal(d.role, IT_SUPPORT_ROLE, d.id);
    for (const view of ['front', 'back', 'side']) {
      assert.equal(d.head[view].length, 11, `${d.id}.${view}`);
      for (const row of d.head[view]) assert.equal(row.length, 12, `${d.id}.${view}: ${row}`);
    }
    // NPC heads are not theme head styles
    assert.equal(Object.values(HEAD_SETS).includes(d.head), false, d.id);
  }
  const has = (rows: readonly string[], k: string): boolean => rows.some((r) => r.includes(k));
  // dez: stubble (facial hair) on the face and side; a dark tee with a pale graphic; slouches
  assert.ok(has(dez.head.front, 'd') && has(dez.head.side, 'd'));
  assert.equal(has(dez.head.front, 'k'), false);
  assert.equal(dez.torso, 'tee');
  assert.equal(dez.slouch, true);
  assert.equal(dez.shortSleeves, true);
  // fenwick: glasses front and side, a parting line in the hair; short-sleeved shirt and tie; tall, trousers worn high
  assert.ok(has(fen.head.front, 'k') && has(fen.head.side, 'k'));
  assert.equal(has(fen.head.front, 'd'), false);
  assert.equal(fen.torso, 'pocketTie');
  assert.equal(fen.build, 'tall');
  assert.equal(fen.highWaist, true);
  assert.equal(fen.shortSleeves, true);
  assert.equal(fen.belt, true);
  // the colours that make them read: dark tee / pale graphic, pale shirt / dark tie
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1, 7), 16);
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  assert.ok(lum(dez.pal.t) < 80 && lum(dez.pal.x) > 180, 'dez: dark tee, pale chest graphic');
  assert.ok(lum(dez.pal.h) < 60, 'dez: dark hair');
  assert.ok(lum(fen.pal.t) > 200 && lum(fen.pal.n) < 80, 'fenwick: pale shirt, dark tie');
});

test('fixPc, scoff and readCard: IT-only standing poses in four directions; every other look falls back', async () => {
  const { POSES, ALL_POSES, poseForLook, lookHasPose } = chars;
  const types = await import(new URL('../webview/engine/types.ts', import.meta.url).href);
  const fallbacks: Record<string, string> = { fixPc: 'stand', scoff: 'stand', readCard: 'talk' };
  for (const p of IT_POSES) {
    const info = POSES[p];
    assert.ok(ALL_POSES.includes(p), p);
    assert.deepEqual([...info.onlyLooks], IT_IDS, p);
    assert.equal(info.fallback, fallbacks[p], p);
    assert.equal(info.seated, false, p);
    assert.equal(info.managerOnly, false, p);
    assert.ok(info.frames >= 2 && info.frames <= 4, p);
    assert.equal(info.durations.length, info.frames, p);
    for (const d of ['left', 'right', 'down', 'up']) assert.ok(info.dirs.includes(d), `${p} ${d}`);
    assert.equal(types.SEATED_POSES.has(p), false, p);
    for (const id of IT_IDS) {
      assert.equal(lookHasPose(id, p), true, `${id} ${p}`);
      assert.equal(poseForLook(id, p), p, `${id} ${p}`);
    }
    for (const id of ['manager', 'assistant', 'staff-2', 'temp-4', 'cleaner', 'vendor']) {
      assert.equal(lookHasPose(id, p), false, `${id} ${p}`);
      assert.equal(poseForLook(id, p), fallbacks[p], `${id} ${p}`);
    }
  }
  assert.equal(POSES['fixPc'].frames, 4);
});

// A minimal canvas for rendering frames in Node: keeps the ImageData that PixelGrid.toCanvas puts.
class DataCanvas {
  width = 1;
  height = 1;
  data: Uint8ClampedArray = new Uint8ClampedArray(4);
  getContext(): unknown {
    return {
      imageSmoothingEnabled: false,
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => { this.data = img.data; },
    };
  }
  /** Every opaque pixel as `#rrggbb`, row-major ('' for transparent). */
  pixels(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.data.length; i += 4) {
      const [r, g, b, a] = [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
      out.push(a === 0 ? '' : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    }
    return out;
  }
}

test('the IT pair render every frame of fixPc, scoff, readCard (and stand, walk) in all four directions; the card shows in readCard', () => {
  const g = globalThis as { document?: unknown };
  const had = Object.hasOwn(g, 'document');
  const prev = g.document;
  g.document = { createElement: () => new DataCanvas() };
  try {
    const { getCharacterFrame, POSES, ITEM_PAL, CHAR_W, CHAR_ANCHOR_Y, clearCharacterCache } = chars;
    clearCharacterCache();
    const px = (look: string, pose: string, dir: string, f: number): string[] => (getCharacterFrame(look, pose, dir, f) as DataCanvas).pixels();
    for (const look of IT_IDS) {
      for (const pose of [...IT_POSES, 'stand', 'walk']) {
        for (const dir of ['left', 'right', 'down', 'up']) {
          const frames: string[] = [];
          for (let f = 0; f < POSES[pose].frames; f++) {
            const c = getCharacterFrame(look, pose, dir, f) as DataCanvas;
            assert.equal(c.width, CHAR_W, `${look} ${pose} ${dir} ${f}`);
            assert.equal(c.height, CHAR_ANCHOR_Y, `${look} ${pose} ${dir} ${f}`);
            const p = c.pixels();
            assert.ok(p.filter((x) => x !== '').length > 120, `${look} ${pose} ${dir} ${f} draws a figure`);
            frames.push(p.join(','));
          }
          // the IT poses animate: not every frame is the same picture
          if (IT_POSES.includes(pose)) assert.ok(new Set(frames).size > 1, `${look} ${pose} ${dir} animates`);
        }
        // right is the mirrored left
        for (let f = 0; f < POSES[pose].frames; f++) {
          const l = px(look, pose, 'left', f);
          const r = px(look, pose, 'right', f);
          const mirrored: string[] = [];
          for (let y = 0; y < CHAR_ANCHOR_Y; y++) mirrored.push(...l.slice(y * CHAR_W, (y + 1) * CHAR_W).reverse());
          assert.deepEqual(r, mirrored, `${look} ${pose} right mirrors left, frame ${f}`);
        }
      }
      // the crib card: its red rule shows in readCard (front and side) but not when just talking or standing
      const rule = ITEM_PAL['7'].toLowerCase();
      for (const dir of ['down', 'left', 'right']) {
        for (let f = 0; f < POSES['readCard'].frames; f++) assert.ok(px(look, 'readCard', dir, f).includes(rule), `${look} readCard ${dir} ${f} shows the card`);
        assert.equal(px(look, 'talk', dir, 1).includes(rule), false, `${look} talk ${dir}`);
        assert.equal(px(look, 'stand', dir, 0).includes(rule), false, `${look} stand ${dir}`);
      }
    }
    // the fallback really is the fallback: another look asked for the IT poses draws its stand / talk frames
    assert.equal(getCharacterFrame('assistant', 'fixPc', 'left', 0), getCharacterFrame('assistant', 'stand', 'left', 0));
    assert.equal(getCharacterFrame('assistant', 'readCard', 'down', 1), getCharacterFrame('assistant', 'talk', 'down', 1));
    clearCharacterCache();
  } finally {
    if (had) g.document = prev; else delete g.document;
  }
});
