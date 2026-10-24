/**
 * The shared colour palette: muted 2000s corporate. Environment colours are
 * named; character colours live with each look in `looks.ts`.
 */
import type { Color, Palette } from './raster.ts';
import type { OfficeColorKey } from '../../src/shared/theme.ts';

/** Outline base used by the selective outline on characters and props. */
export const OUTLINE: Color = '#1d1520';

/**
 * The built-in environment and prop colours (frozen). `C` starts as a copy and
 * `applyOfficeColors` rewrites parts of it from a theme.
 */
export const BASE_C = Object.freeze({
  // ceiling and walls
  ceiling: '#e4e0d4',
  ceilingShade: '#cfc9b9',
  ceilingGrid: '#b3ac99',
  lightPanel: '#f7fbff',
  lightPanelEdge: '#cfdce6',
  lightGlow: '#fffbe8',
  wall: '#d9c9a4',
  wallLight: '#e5d7b5',
  wallShade: '#c6b48d',
  wallDark: '#a99572',
  wallCap: '#8e7c61',
  wallCapLight: '#b3a07e',
  baseboard: '#5f5040',
  baseboardLight: '#7a6853',
  outside: '#2a2430',

  // floors
  carpet: '#66748a',
  carpetAlt: '#6c7a90',
  carpetSpeck: '#7a889d',
  carpetDark: '#58657a',
  carpetSeam: '#5d6a80',
  lobby: '#bfb196',
  lobbyAlt: '#b5a68a',
  lobbyGrout: '#a39579',
  kitchen: '#ddd5bf',
  kitchenAlt: '#c3b99f',
  kitchenGrout: '#b1a78d',
  conf: '#5f6c7f',
  confAlt: '#64718a',
  mgr: '#7a6d5b',
  mgrAlt: '#82745f',
  annex: '#6d7488',
  annexAlt: '#737a8d',
  rug: '#7d3b37',
  rugBorder: '#b88a4b',
  // company sign on the lobby wall
  signPlate: '#2d3d57',
  signPlateEdge: '#1f2a3c',
  signPlateLight: '#45597a',
  signPlateShade: '#22304a',
  signText: '#fff4d0',
  signTextShadow: '#141c2a',
  signBranch: '#b9b7a6',

  // wood and metal
  wood: '#b0804c',
  woodLight: '#c99a62',
  woodDark: '#8a5f35',
  woodEdge: '#5e3f24',
  darkWood: '#6f4528',
  darkWoodLight: '#8a5a37',
  darkWoodEdge: '#40261a',
  metal: '#9aa2ab',
  metalLight: '#c2c8ce',
  metalDark: '#6e7680',
  metalDeep: '#4d545d',
  desk: '#c2ab84',
  deskLight: '#d4bf98',
  deskEdge: '#8f7756',
  deskPanel: '#8d939b',
  deskPanelLight: '#a7adb4',
  deskPanelDark: '#666c75',

  // plastic and appliances
  beige: '#d8cfb4',
  beigeLight: '#e8e1cb',
  beigeShade: '#b5aa8d',
  beigeDark: '#8f8670',
  black: '#26232a',
  charcoal: '#3a3740',
  white: '#f4f2ea',
  offWhite: '#e2ded2',

  // chairs
  teal: '#2f7b83',
  tealLight: '#41979e',
  tealDark: '#225960',
  exec: '#2b2830',
  execLight: '#45404c',
  execDark: '#1a181e',
  orange: '#c9773b',
  orangeLight: '#df9152',
  orangeDark: '#99562a',

  // glass, windows, blinds
  glass: '#bfe0ee',
  glassLight: '#e9f7fc',
  glassFrame: '#8f9aa3',
  glassFrameLight: '#c9d1d6',
  sky: '#9fc3db',
  skyLight: '#c4dceb',
  skyLow: '#b7cfdc',
  city: '#7e8f9e',
  cityDark: '#6b7b89',
  blinds: '#ebe6da',
  blindsShade: '#cfc8b8',
  windowFrame: '#f0ede4',
  windowFrameShade: '#c5c0b2',

  // plants
  leaf: '#4f8a3c',
  leafLight: '#78ae52',
  leafDark: '#33612a',
  pot: '#b5643c',
  potLight: '#cf7c4f',
  potDark: '#83452a',
  soil: '#4a3426',

  // accents
  red: '#b8433a',
  redLight: '#d8645a',
  redDark: '#7f2a26',
  blue: '#3f6fb0',
  blueLight: '#6b97d2',
  blueDark: '#2a4a7c',
  green: '#4c9a4f',
  greenLight: '#7cc479',
  yellow: '#e2b93b',
  yellowLight: '#f2d675',
  gold: '#d7a83a',
  goldLight: '#f1d27a',
  goldDark: '#9c7524',
  paper: '#f6f3ea',
  paperLine: '#a9a6a0',
  ink: '#2b2b38',
  screenOff: '#1f2a2c',
  screenGlass: '#2b3b3e',
  shadow: '#1c122040',
} as const);

/** A named palette colour. */
export type PaletteKey = keyof typeof BASE_C;

/**
 * The live environment colours every sprite reads when it is drawn. Same keys
 * as `BASE_C`; `applyOfficeColors` rewrites it. Sprites are cached, so call
 * `invalidateArtCaches()` (index.ts) after a change.
 */
export const C: Record<PaletteKey, Color> = { ...BASE_C };

// ---------------------------------------------------------------------------
// Office colours from a theme

/**
 * Which `C` keys each theme colour sets. The first key takes the theme colour
 * as given; the others are shades derived from it with the same lightness,
 * saturation and hue relation they have in `BASE_C` (so a dark floor gets
 * dark alternate tiles, a light wall a lighter highlight, and so on). The sign
 * lettering's shadow (`signTextShadow`) follows `signPlate` and `signText`.
 */
export const OFFICE_COLOR_SHADES: Readonly<Record<OfficeColorKey, readonly PaletteKey[]>> = {
  wall: ['wall', 'wallLight', 'wallShade', 'wallDark', 'wallCap', 'wallCapLight'],
  trim: ['baseboard', 'baseboardLight'],
  ceiling: ['ceiling', 'ceilingShade', 'ceilingGrid'],
  carpet: ['carpet', 'carpetAlt', 'carpetSpeck', 'carpetDark', 'carpetSeam'],
  lobbyFloor: ['lobby', 'lobbyAlt', 'lobbyGrout'],
  kitchenFloor: ['kitchen', 'kitchenAlt', 'kitchenGrout'],
  conferenceFloor: ['conf', 'confAlt'],
  managerFloor: ['mgr', 'mgrAlt'],
  annexFloor: ['annex', 'annexAlt'],
  rug: ['rug'],
  rugBorder: ['rugBorder'],
  deskChairs: ['teal', 'tealLight', 'tealDark'],
  kitchenChairs: ['orange', 'orangeLight', 'orangeDark'],
  managerChair: ['exec', 'execLight', 'execDark'],
  signPlate: ['signPlate', 'signPlateEdge', 'signPlateLight', 'signPlateShade'],
  signText: ['signText'],
  signBranch: ['signBranch'],
  desks: ['desk', 'deskLight', 'deskEdge'],
  deskPanels: ['deskPanel', 'deskPanelLight', 'deskPanelDark'],
  wood: ['wood', 'woodLight', 'woodDark', 'woodEdge'],
  darkWood: ['darkWood', 'darkWoodLight', 'darkWoodEdge'],
  metal: ['metal', 'metalLight', 'metalDark', 'metalDeep'],
  computers: ['beige', 'beigeLight', 'beigeShade', 'beigeDark'],
  screens: ['screenOff', 'screenGlass'],
  plants: ['leaf', 'leafLight', 'leafDark'],
  plantPots: ['pot', 'potLight', 'potDark'],
  glass: ['glass', 'glassLight'],
  glassFrames: ['glassFrame', 'glassFrameLight'],
  blinds: ['blinds', 'blindsShade'],
  windowFrames: ['windowFrame', 'windowFrameShade'],
  sky: ['sky', 'skyLight', 'skyLow'],
  skyline: ['city', 'cityDark'],
  ceilingLights: ['lightPanel', 'lightPanelEdge', 'lightGlow'],
  outside: ['outside'],
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function rgbOf(hex: Color): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** `#rrggbb` -> [h 0-360, s 0-1, l 0-1]. */
export function hexToHsl(hex: Color): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** [h 0-360, s 0-1, l 0-1] -> `#rrggbb`. */
export function hslToHex(h: number, s: number, l: number): Color {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (t: number): number => {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const to2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  if (s === 0) return `#${to2(l)}${to2(l)}${to2(l)}`;
  return `#${to2(f(hh + 1 / 3))}${to2(f(hh))}${to2(f(hh - 1 / 3))}`;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Gives `colour` the relation `baseShade` has to `baseMain`: lightness moves
 * proportionally towards black (darker shades) or white (lighter ones),
 * saturation scales, and the hue shifts by the same angle. Any colour gets
 * sensible tones, and `shadeLike(baseMain, baseMain, baseShade)` is about `baseShade`.
 */
export function shadeLike(colour: Color, baseMain: Color, baseShade: Color): Color {
  const [h0, s0, l0] = hexToHsl(baseMain);
  const [h1, s1, l1] = hexToHsl(baseShade);
  const [h, s, l] = hexToHsl(colour);
  const nl = l1 <= l0 ? (l0 > 0 ? l * (l1 / l0) : l) : (l0 < 1 ? 1 - (1 - l) * ((1 - l1) / (1 - l0)) : l);
  const ratio = s0 > 0.02 ? Math.min(2, s1 / s0) : 1;
  const ns = s0 > 0.02 ? clamp01(s * ratio) : clamp01(s + (s1 - s0));
  return hslToHex(h + (h1 - h0), ns, clamp01(nl));
}

/** True for a usable theme colour (`#rrggbb`). */
export function isOfficeColor(v: unknown): v is string {
  return typeof v === 'string' && HEX6.test(v);
}

/**
 * Resets `C` to `BASE_C`, then applies a theme's office colours: each valid
 * override sets its keys in `OFFICE_COLOR_SHADES` (the colour itself plus
 * derived shades). Unknown keys and anything that isn't `#rrggbb` are ignored;
 * a colour equal to the built-in one keeps the built-in shades exactly.
 * `undefined` or `{}` restores the built-in office. Returns true when `C`
 * changed, i.e. when the caller must `invalidateArtCaches()` and redraw.
 */
export function applyOfficeColors(colors: Partial<Record<OfficeColorKey, string>> | undefined): boolean {
  const before = JSON.stringify(C);
  propPalMemo = undefined;
  Object.assign(C, BASE_C);
  if (colors && typeof colors === 'object') {
    for (const [k, v] of Object.entries(colors)) {
      if (!Object.hasOwn(OFFICE_COLOR_SHADES, k) || !isOfficeColor(v)) continue;
      const keys = OFFICE_COLOR_SHADES[k as OfficeColorKey];
      const main = keys[0]!;
      const value = v.toLowerCase();
      if (value === BASE_C[main]) continue;
      C[main] = value;
      for (const key of keys.slice(1)) C[key] = shadeLike(value, BASE_C[main], BASE_C[key]);
    }
    // The sign lettering's drop shadow: a deeper plate tone under light text, a lighter one under dark text.
    if (C.signPlate !== BASE_C.signPlate || C.signText !== BASE_C.signText) {
      const textIsLight = hexToHsl(C.signText)[2] >= hexToHsl(C.signPlate)[2];
      C.signTextShadow = textIsLight
        ? shadeLike(C.signPlate, BASE_C.signPlate, BASE_C.signTextShadow)
        : shadeLike(C.signPlate, BASE_C.signPlate, BASE_C.signPlateLight);
    }
  }
  return JSON.stringify(C) !== before;
}

/** The current value of every theme colour (what `C` holds for each key's first entry). */
export function currentOfficeColors(): Record<OfficeColorKey, string> {
  return Object.fromEntries(Object.entries(OFFICE_COLOR_SHADES).map(([k, keys]) => [k, C[keys[0]!]])) as Record<OfficeColorKey, string>;
}

/**
 * A palette of single-character keys for prop sprites authored as strings.
 * Built from `BASE_C`, so this is the built-in look; sprites that follow a theme
 * use `propPal()` instead.
 * Digits and punctuation are reserved for props so they never clash with the
 * letter keys used by characters.
 */
export const PROP_PAL: Palette = {
  o: OUTLINE,
  '0': BASE_C.paper,
  '1': BASE_C.paperLine,
  '2': BASE_C.white,
  '3': BASE_C.ink,
  '4': '#6b4226', // coffee
  '5': BASE_C.yellow,
  '6': BASE_C.blue,
  '7': BASE_C.red,
  '8': BASE_C.metal,
  '9': BASE_C.charcoal,
  '+': BASE_C.metalLight,
  '-': BASE_C.metalDark,
  '=': BASE_C.gold,
  '~': BASE_C.goldLight,
  '^': BASE_C.goldDark,
  g: BASE_C.leaf,
  G: BASE_C.leafLight,
  d: BASE_C.leafDark,
  w: BASE_C.wood,
  W: BASE_C.woodLight,
  v: BASE_C.woodDark,
  b: BASE_C.beige,
  B: BASE_C.beigeLight,
  n: BASE_C.beigeShade,
  r: BASE_C.redLight,
  R: BASE_C.redDark,
  p: '#8a3f6e', // beet purple
  P: '#b45a8e',
  y: '#f0d24a', // jello yellow
  Y: '#f7e58a',
  k: BASE_C.black,
  t: BASE_C.teal,
  c: '#cf8a47', // chili
  C: '#a9542b',
  s: '#e8b48f', // skin for figurines
  S: '#c98f6e', // figurine skin shade
  h: '#6a4a2a', // figurine hair
  m: BASE_C.potDark,
  M: BASE_C.pot,
  x: '#e07ab0', // candy pink
  X: '#7bc4e8', // candy blue
  z: '#9ed46a', // candy green
  q: '#f1e7c8', // yarn cream
  Q: '#d36b7c', // yarn rose
  u: '#7a8fc4', // yarn blue
  a: '#e6dfcf', // cat white
  A: '#d88f45', // cat orange
};

/** `PROP_PAL` keys that follow the theme, and the `C` key each reads (the same `BASE_C` key `PROP_PAL` is built from). */
const THEMED_PROP_KEYS: Readonly<Record<string, PaletteKey>> = {
  '8': 'metal', '+': 'metalLight', '-': 'metalDark',
  w: 'wood', W: 'woodLight', v: 'woodDark',
  g: 'leaf', G: 'leafLight', d: 'leafDark',
  b: 'beige', B: 'beigeLight', n: 'beigeShade',
  m: 'potDark', M: 'pot',
  t: 'teal',
};

let propPalMemo: Palette | undefined;

/**
 * `PROP_PAL` with the theme-able entries read from the live `C`: metal, wood,
 * plant leaves, computer beige, plant pots and the desk-chair teal (every key
 * whose `BASE_C` source a theme colour can set). Fixed entries stay as they
 * are: outline, paper, ink, coffee, red, blue, yellow, gold, charcoal, black and
 * the other object colours, which no theme colour owns. With `C` equal to
 * `BASE_C` it deep-equals `PROP_PAL`. Memoised until `applyOfficeColors` runs, so
 * calling it per draw is cheap; treat the result as read-only.
 */
export function propPal(): Palette {
  if (!propPalMemo) {
    const pal: Record<string, Color> = { ...PROP_PAL };
    for (const [ch, key] of Object.entries(THEMED_PROP_KEYS)) pal[ch] = C[key];
    propPalMemo = pal;
  }
  return propPalMemo;
}
