// Office colours from a theme: applyOfficeColors (C over BASE_C, with derived shades) and invalidateArtCaches.
// The art modules use DOM types, so they're imported through computed specifiers (see engine-world.ts). A tiny
// fake canvas stands in for the DOM: each canvas records the colours drawn into it, so a redraw can be checked for
// stale colours without real pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FURNITURE_COLOR_KEYS, OFFICE_COLOR_KEYS } from '../src/shared/theme.ts';
import type { OfficeColorKey } from '../src/shared/theme.ts';

// ---------------------------------------------------------------------------
// Fake canvas: records every colour that reaches it (fills, images drawn into it, putImageData)

class FakeCanvas {
  width = 1;
  height = 1;
  readonly colors = new Set<string>();
  private readonly ctx = new FakeContext(this);
  getContext(): FakeContext { return this.ctx; }
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

class FakeContext {
  fillStyle = '#000000';
  imageSmoothingEnabled = true;
  readonly canvas: FakeCanvas;
  constructor(canvas: FakeCanvas) { this.canvas = canvas; }
  fillRect(): void { this.canvas.colors.add(String(this.fillStyle).toLowerCase()); }
  clearRect(): void {}
  drawImage(src: FakeCanvas): void { for (const c of src.colors) this.canvas.colors.add(c); }
  translate(): void {}
  scale(): void {}
  save(): void {}
  restore(): void {}
  createImageData(w: number, h: number): { data: Uint8ClampedArray } { return { data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img: { data: Uint8ClampedArray }): void {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      this.canvas.colors.add(`#${hex2(d[i]!)}${hex2(d[i + 1]!)}${hex2(d[i + 2]!)}${d[i + 3] === 255 ? '' : hex2(d[i + 3]!)}`);
    }
  }
}

(globalThis as { document?: unknown }).document = { createElement: () => new FakeCanvas() };

const ART = new URL('../webview/art/', import.meta.url).href;
const load = async (file: string): Promise<any> => { const spec: string = `${ART}${file}`; return import(spec); };
const palette = await load('palette.ts');
const map = await load('office-map.ts');
const chars = await load('characters.ts');
const props = await load('props.ts');
const caches = await load('caches.ts');

const { BASE_C, C, OFFICE_COLOR_SHADES, applyOfficeColors, shadeLike, hexToHsl, hslToHex } = palette;
const lightness = (c: string): number => hexToHsl(c)[2];

test('C starts as BASE_C, which is frozen; the shade table covers exactly the theme colours', () => {
  applyOfficeColors(undefined);
  assert.deepEqual({ ...C }, { ...BASE_C });
  assert.ok(Object.isFrozen(BASE_C));
  assert.deepEqual(Object.keys(OFFICE_COLOR_SHADES).sort(), [...OFFICE_COLOR_KEYS].sort());
  for (const [k, keys] of Object.entries(OFFICE_COLOR_SHADES) as [string, string[]][]) {
    assert.ok(keys.length >= 1, k);
    for (const key of keys) assert.ok(Object.hasOwn(BASE_C, key), `${k} -> ${key}`);
  }
  // The sign moved into C.
  assert.equal(C.signPlate, '#2d3d57');
  assert.equal(C.signText, '#fff4d0');
  assert.equal(C.signBranch, '#b9b7a6');
});

test('an override sets its colour and derived shades, and nothing else', () => {
  assert.equal(applyOfficeColors({ wall: '#336699' }), true);
  assert.equal(C.wall, '#336699');
  for (const k of ['wallLight', 'wallShade', 'wallDark', 'wallCap', 'wallCapLight']) assert.notEqual(C[k], BASE_C[k], k);
  assert.ok(lightness(C.wallLight) > lightness(C.wall), 'wallLight is lighter');
  assert.ok(lightness(C.wallShade) < lightness(C.wall), 'wallShade is darker');
  assert.ok(lightness(C.wallDark) < lightness(C.wallShade), 'wallDark is darker still');
  const touched = new Set(OFFICE_COLOR_SHADES.wall);
  for (const k of Object.keys(BASE_C)) if (!touched.has(k)) assert.equal(C[k], BASE_C[k], k);
});

test('every theme colour writes its whole row of the table', () => {
  const probe = '#4a7d2c';
  for (const key of OFFICE_COLOR_KEYS) {
    applyOfficeColors({ [key]: probe });
    const keys: string[] = OFFICE_COLOR_SHADES[key];
    assert.equal(C[keys[0]!], probe, key);
    for (const k of keys.slice(1)) assert.equal(C[k], shadeLike(probe, BASE_C[keys[0]!], BASE_C[k]), `${key} -> ${k}`);
  }
  applyOfficeColors({ deskChairs: '#aa2233', kitchenChairs: '#2233aa', managerChair: '#334455' });
  assert.equal(C.teal, '#aa2233');
  assert.equal(C.orange, '#2233aa');
  assert.equal(C.exec, '#334455');
  assert.ok(lightness(C.tealLight) > lightness(C.teal) && lightness(C.tealDark) < lightness(C.teal));
  assert.ok(lightness(C.execLight) > lightness(C.exec) && lightness(C.execDark) < lightness(C.exec));
});

test('furniture colours: each key leads with its main palette key, then its shades', () => {
  const rows: Record<string, string[]> = {
    desks: ['desk', 'deskLight', 'deskEdge'], deskPanels: ['deskPanel', 'deskPanelLight', 'deskPanelDark'],
    wood: ['wood', 'woodLight', 'woodDark', 'woodEdge'], darkWood: ['darkWood', 'darkWoodLight', 'darkWoodEdge'],
    metal: ['metal', 'metalLight', 'metalDark', 'metalDeep'], computers: ['beige', 'beigeLight', 'beigeShade', 'beigeDark'],
    screens: ['screenOff', 'screenGlass'], plants: ['leaf', 'leafLight', 'leafDark'], plantPots: ['pot', 'potLight', 'potDark'],
    glass: ['glass', 'glassLight'], glassFrames: ['glassFrame', 'glassFrameLight'], blinds: ['blinds', 'blindsShade'],
    windowFrames: ['windowFrame', 'windowFrameShade'], sky: ['sky', 'skyLight', 'skyLow'], skyline: ['city', 'cityDark'],
    ceilingLights: ['lightPanel', 'lightPanelEdge', 'lightGlow'], outside: ['outside'],
  };
  assert.deepEqual([...FURNITURE_COLOR_KEYS].sort(), Object.keys(rows).sort());
  for (const [k, keys] of Object.entries(rows)) assert.deepEqual([...OFFICE_COLOR_SHADES[k as OfficeColorKey]], keys, k);
  for (const k of OFFICE_COLOR_KEYS) assert.ok(Object.hasOwn(OFFICE_COLOR_SHADES, k), `${k} has a row`);
});

test('desks recolours C.desk and its shades; undefined restores BASE_C', () => {
  assert.equal(applyOfficeColors({ desks: '#123456' }), true);
  assert.equal(C.desk, '#123456');
  for (const k of ['deskLight', 'deskEdge'] as const) assert.notEqual(C[k], BASE_C[k], k);
  assert.ok(lightness(C.deskLight) > lightness(C.desk), 'deskLight is lighter');
  assert.ok(lightness(C.deskEdge) < lightness(C.desk), 'deskEdge is darker');
  const touched = new Set(OFFICE_COLOR_SHADES.desks);
  for (const k of Object.keys(BASE_C)) if (!touched.has(k as never)) assert.equal(C[k as keyof typeof C], BASE_C[k as keyof typeof BASE_C], k);
  assert.equal(applyOfficeColors(undefined), true);
  assert.deepEqual({ ...C }, { ...BASE_C });
  assert.equal(applyOfficeColors(undefined), false);
});

test('a dark floor gets dark alternate tones; a pale one gets pale ones', () => {
  applyOfficeColors({ carpet: '#1e2026', lobbyFloor: '#f4f1ea' });
  for (const k of ['carpetAlt', 'carpetDark', 'carpetSeam']) assert.ok(lightness(C[k]) < 0.2, `${k} ${C[k]}`);
  assert.ok(lightness(C.carpetSpeck) > lightness(C.carpet) && lightness(C.carpetSpeck) < 0.35, 'specks stay a little lighter');
  assert.notEqual(C.carpetAlt, C.carpet);
  for (const k of ['lobbyAlt', 'lobbyGrout']) assert.ok(lightness(C[k]) > 0.75, `${k} ${C[k]}`);
});

test('the shade helper reproduces the built-in relations and round-trips HSL', () => {
  for (const [, keys] of Object.entries(OFFICE_COLOR_SHADES) as [string, string[]][]) {
    for (const k of keys.slice(1)) {
      const want = BASE_C[k] as string;
      const got = shadeLike(BASE_C[keys[0]!], BASE_C[keys[0]!], want) as string;
      for (let i = 1; i < 7; i += 2) assert.ok(Math.abs(parseInt(got.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 2, `${k}: ${got} vs ${want}`);
    }
  }
  for (const c of ['#000000', '#ffffff', '#7f7f7f', '#d9c9a4', '#2f7b83', '#ff0000']) assert.equal(hslToHex(...(hexToHsl(c) as [number, number, number])), c);
});

test('a colour equal to the built-in keeps the built-in shades exactly; upper case is accepted', () => {
  applyOfficeColors({ wall: BASE_C.wall.toUpperCase(), carpet: BASE_C.carpet });
  assert.deepEqual({ ...C }, { ...BASE_C });
});

test('reset restores BASE_C, and the return value says whether C changed', () => {
  applyOfficeColors({ rug: '#101010', signText: '#000000' });
  assert.equal(applyOfficeColors(undefined), true);
  assert.deepEqual({ ...C }, { ...BASE_C });
  assert.equal(applyOfficeColors(undefined), false);
  assert.equal(applyOfficeColors({}), false);
  applyOfficeColors({ rug: '#101010' });
  assert.equal(applyOfficeColors({ rug: '#101010' }), false, 'same colours again: no change');
  assert.equal(applyOfficeColors({}), true);
});

test('unknown keys and invalid colours are ignored', () => {
  applyOfficeColors(undefined);
  const bad = { wall: 'red', carpet: '#12345', rug: 42, ceiling: '#gggggg', trim: '', bogus: '#123456', constructor: '#123456', toString: '#654321' };
  assert.equal(applyOfficeColors(bad as unknown as Record<string, string>), false);
  assert.deepEqual({ ...C }, { ...BASE_C });
  assert.equal(applyOfficeColors(null as unknown as undefined), false);
  assert.equal(applyOfficeColors('nope' as unknown as undefined), false);
});

test('the sign lettering shadow follows the plate: deep under light text, light under dark text', () => {
  applyOfficeColors({ signPlate: '#e9e4d6', signText: '#22283a' });
  assert.ok(lightness(C.signTextShadow) > lightness(C.signText));
  applyOfficeColors({ signPlate: '#0e1116', signText: '#7fe0ff' });
  assert.ok(lightness(C.signTextShadow) < lightness(C.signText));
  applyOfficeColors(undefined);
  assert.equal(C.signTextShadow, BASE_C.signTextShadow);
});

// ---------------------------------------------------------------------------
// Caches

function fillEveryCache(): void {
  map.renderBackground();
  map.getFurniture();
  chars.getCharacterFrame('manager', 'chairSpin', 'down', 2);
  chars.getCharacterFrame('helpdesk', 'sitPhone', 'down', 0);
  props.drawUsageRing(new FakeCanvas().getContext(), 0, 0, 50, 'ok');
  props.drawPlanNotes(new FakeCanvas().getContext(), 0, 0, { pending: 1, approved: 2, rejected: 0 });
  props.drawCalendar(new FakeCanvas().getContext(), 0, 0, 40, 'warn');
  props.drawInTray(new FakeCanvas().getContext(), 0, 0, 3, true, 0);
  props.drawDeskPile(new FakeCanvas().getContext(), 10, 10, 2, true);
}

test('invalidateArtCaches empties every colour-baking cache', () => {
  applyOfficeColors(undefined);
  fillEveryCache();
  const full = caches.artCacheSizes();
  for (const [k, v] of Object.entries(full)) assert.ok((v as number) > 0, `${k} filled`);
  caches.invalidateArtCaches();
  assert.deepEqual(caches.artCacheSizes(), { background: 0, furnitureList: 0, sprites: 0, props: 0, frames: 0 });
});

test('after a recolour and invalidate, the redraw has the new colours and none of the replaced ones', () => {
  applyOfficeColors(undefined);
  caches.invalidateArtCaches();
  const bg0 = map.renderBackground();
  for (const k of ['wall', 'ceiling', 'carpet', 'lobby', 'kitchen', 'rug', 'rugBorder', 'baseboard', 'signPlate']) assert.ok(bg0.colors.has(BASE_C[k]), `built-in ${k} drawn`);
  const colours = {
    wall: '#336699', trim: '#202830', ceiling: '#f0f0ff', carpet: '#22252c', lobbyFloor: '#e8e8e8', kitchenFloor: '#cfe0d0',
    conferenceFloor: '#30303a', managerFloor: '#403020', annexFloor: '#2a3040', rug: '#205030', rugBorder: '#e0c060',
    deskChairs: '#aa2233', kitchenChairs: '#2233aa', managerChair: '#556677', signPlate: '#e9e4d6', signText: '#22283a', signBranch: '#5c6070',
  };
  applyOfficeColors(colours);
  // Not invalidated yet: the cached background is the old one.
  assert.equal(map.renderBackground(), bg0);
  caches.invalidateArtCaches();
  const bg = map.renderBackground();
  assert.notEqual(bg, bg0);
  for (const c of [colours.wall, colours.ceiling, colours.carpet, colours.lobbyFloor, colours.rug, colours.rugBorder, colours.trim, colours.signPlate]) {
    assert.ok(bg.colors.has(c), `new ${c} drawn`);
  }
  for (const k of ['wall', 'wallShade', 'ceiling', 'carpet', 'lobby', 'lobbyAlt', 'kitchen', 'rug', 'baseboard', 'signPlate', 'signPlateEdge']) {
    assert.ok(!bg.colors.has(BASE_C[k]), `no stale ${k} (${BASE_C[k]})`);
  }
  // Furniture: interior walls and every chair redraw too.
  const furniture = map.getFurniture();
  const coloursOf = (kind: string): Set<string> => {
    const out = new Set<string>();
    for (const f of furniture) if (f.kind === kind) for (const c of f.sprite.colors) out.add(c);
    return out;
  };
  const walls = coloursOf('wall');
  const chairs = coloursOf('chair');
  assert.ok(walls.has(colours.wall) && !walls.has(BASE_C.wall) && !walls.has(BASE_C.wallCap), 'interior walls redrawn');
  for (const c of [colours.deskChairs, colours.kitchenChairs, colours.managerChair]) assert.ok(chairs.has(c), `chairs have ${c}`);
  for (const k of ['teal', 'tealLight', 'tealDark', 'orange', 'orangeLight', 'exec', 'execLight']) assert.ok(!chairs.has(BASE_C[k]), `no stale ${k} on chairs`);
  // The spinning manager's chair is inside his frames.
  const spin = chars.getCharacterFrame('manager', 'chairSpin', 'down', 2);
  assert.ok([...spin.colors].every((c: string) => c !== BASE_C.exec));
  // The sign text uses the live colours.
  const sign = new FakeCanvas();
  map.drawSignText(sign.getContext(), 'Pennywhistle', 'Branch');
  assert.ok(sign.colors.has(colours.signText) && sign.colors.has(colours.signBranch));
  // Reset brings the built-in office back.
  applyOfficeColors(undefined);
  caches.invalidateArtCaches();
  const again = map.renderBackground();
  assert.ok(again.colors.has(BASE_C.wall) && !again.colors.has(colours.wall));
});

// propPal: the prop palette follows the theme for furniture and room colours; object colours stay fixed.

const screens = await load('screens.ts');
const PROP_FOLLOWS: Record<string, string> = {
  '8': 'metal', '+': 'metalLight', '-': 'metalDark', w: 'wood', W: 'woodLight', v: 'woodDark',
  g: 'leaf', G: 'leafLight', d: 'leafDark', b: 'beige', B: 'beigeLight', n: 'beigeShade', m: 'potDark', M: 'pot', t: 'teal',
};

test('propPal equals PROP_PAL while C is BASE_C', () => {
  applyOfficeColors(undefined);
  assert.deepEqual(palette.propPal(), palette.PROP_PAL);
});

test('propPal follows the mapped C entries after a recolour; fixed entries do not move; undefined restores', () => {
  try {
    applyOfficeColors({ wood: '#335577', metal: '#aa2222', plants: '#118833', computers: '#202020', plantPots: '#884400' });
    const pal = palette.propPal();
    for (const [ch, key] of Object.entries(PROP_FOLLOWS)) {
      assert.equal(pal[ch], palette.C[key], `${ch} follows C.${key}`);
    }
    assert.equal(pal.w, '#335577');
    assert.equal(pal['8'], '#aa2222');
    assert.notEqual(pal.g, palette.PROP_PAL.g);
    for (const ch of Object.keys(palette.PROP_PAL)) {
      if (ch in PROP_FOLLOWS) continue;
      assert.equal(pal[ch], palette.PROP_PAL[ch], `${ch} stays fixed`);
    }
    assert.equal(palette.propPal(), pal, 'memoised between recolours');
    applyOfficeColors(undefined);
    assert.deepEqual(palette.propPal(), palette.PROP_PAL);
  } finally {
    applyOfficeColors(undefined);
  }
});

test("the 'off' screen follows C.screenOff and C.screenGlass", () => {
  const fills = (): string[] => {
    const out: string[] = [];
    const ctx = { set fillStyle(v: string) { out.push(v.toLowerCase()); }, fillRect(): void {} };
    screens.drawScreen(ctx, { x: 0, y: 0, w: 7, h: 7 }, 'off', 0);
    return out;
  };
  try {
    applyOfficeColors(undefined);
    assert.deepEqual(fills(), ['#1f2a2c', '#2b3b3e']);
    applyOfficeColors({ screens: '#102030' });
    assert.deepEqual(fills(), [palette.C.screenOff, palette.C.screenGlass]);
    assert.equal(fills()[0], '#102030');
  } finally {
    applyOfficeColors(undefined);
  }
});
