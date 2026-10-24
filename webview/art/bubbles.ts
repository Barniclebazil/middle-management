/**
 * Bubble icons (8x8 art, outlined to 10x10) and helpers that draw speech
 * bubbles, thought bubbles and name labels. Everything draws in map pixels;
 * scale the target context for bigger output.
 */
import { OUTLINE } from './palette.ts';
import type { Palette } from './raster.ts';
import { PixelGrid } from './raster.ts';
import { drawPixelText, measurePixelText, FONT_LINE_HEIGHT } from './font.ts';

/**
 * Every icon: the bubble icons, then the UI icons for the icon bar and the
 * directory (Round A: inTray, plans, usage, bell, directory, newTask; Round B:
 * files, library, phone, handbook, agency). All are 8x8 art outlined to 10x10;
 * draw them in the DOM with `pixelIcon(id, px)`. The UI icons also have 18x18
 * art (`UI_ICONS`).
 */
export type IconId =
  | 'alert' | 'thinking' | 'search' | 'globe' | 'pencil' | 'terminal' | 'page' | 'folder'
  | 'palette' | 'clipboard' | 'shred' | 'coffee' | 'zzz' | 'stormcloud'
  | 'inTray' | 'plans' | 'usage' | 'bell' | 'directory' | 'newTask'
  | 'files' | 'library' | 'phone' | 'handbook' | 'agency';

const ICON_PAL: Palette = {
  r: '#e0453a', R: '#a8281f', d: '#4a4458', w: '#ffffff', b: '#4f8fd8', B: '#2f62a8', g: '#5fb85a', G: '#3d8a3a',
  y: '#f2c94c', Y: '#c99a2a', p: '#ee8fa0', k: '#26232a', t: '#d9b483', T: '#a8834f', h: '#7a5232', s: '#b8c4cc',
  c: '#6b4226', f: '#e9c97c', F: '#c9a457', l: '#a9a6a0', z: '#5b8fd6', o: '#e07a3a', m: '#9ec7e8',
  S: '#7d8a96', O: '#b0582a', e: '#efe6cf', n: '#3a3542',
};

const ICONS: Readonly<Record<IconId, readonly string[]>> = {
  alert: ['...rr...', '...rr...', '...rr...', '...rr...', '...RR...', '........', '...rr...', '...RR...'],
  thinking: ['........', '........', '........', 'dd.dd.dd', 'dd.dd.dd', '........', '........', '........'],
  search: ['.kkkk...', 'kmwmmk..', 'kwmmmk..', 'kmmmmk..', 'kmmmmk..', '.kkkkh..', '.....hh.', '......hh'],
  globe: ['..bbbb..', '.bgGbbb.', 'bggggbbb', 'bbgGbgbb', 'bbbbggGb', 'bgbbbggb', '.bbbbgb.', '..bbbb..'],
  pencil: ['......pp', '.....ypp', '....yyY.', '...yyY..', '..yyY...', '.tyY....', '.tt.....', 'k.......'],
  terminal: ['kkkkkkkk', 'kgkkkkkk', 'kkgkkkkk', 'kgkkkkkk', 'kkkkkkkk', 'kkkgggkk', 'kkkkkkkk', 'kkkkkkkk'],
  page: ['wwwww...', 'wllwww..', 'wwwwwww.', 'wllllww.', 'wwwwwww.', 'wllllww.', 'wwwwwww.', 'wllwwww.'],
  folder: ['FFF.....', 'FffF....', 'FFFFFFFF', 'Ffffffff', 'Ffffffff', 'Ffffffff', 'Ffffffff', 'FFFFFFFF'],
  palette: ['..tttt..', '.trrtbbt', 'ttrrtbbt', 'tyy..ttt', 'tyy..tgg', '.ttttggt', '..ttttT.', '........'],
  clipboard: ['..kkkk..', 'hhkwwkhh', 'hwwwwwwh', 'hwllllwh', 'hwwwwwwh', 'hwlllwwh', 'hwwwwwwh', 'hhhhhhhh'],
  shred: ['kkkkkkkk', 'kddddddk', 'kkkkkkkk', '.w.w.w.w', '.w.w.w.w', 'w.w.w.w.', '.w.w.w..', '...w....'],
  coffee: ['..s..s..', '.s..s...', 'wwwwww..', 'wccccwww', 'wwwwww.w', 'wwwwwwww', 'wwwwww..', '.wwww...'],
  zzz: ['....zzzz', '......z.', '.....z..', '....zzzz', 'zzz.....', '.z......', 'zzz.....', '........'],
  // the boss sulking: a dark storm cloud (it must read on the white bubble at small sizes) and a zigzag bolt; no rain (it blurs into the outline)
  stormcloud: ['..SSS...', '.SSSSSS.', 'SSSSSSSS', 'nnnnnnnn', '....yy..', '..yyyY..', '...yY...', '..y.....'],
  // UI icons (icon bar, directory, panels)
  inTray: ['..wwwww.', '.wwllww.', '.wwwwww.', 'TwllllwT', 'Twwwwwwt', 'TTTTTTTt', 'TttwwttT', 'TTTTTTTT'],
  plans: ['ssssssss', 'syywggws', 'syywggws', 'swwwwwws', 'swppwyys', 'swppwyys', 'ssssssss', '.S....S.'],
  usage: ['..lggg..', '.lwwwgg.', 'lwwkwwwg', 'lwwkwwwg', 'lwwkkwwg', 'lwwwwwwg', '.lwwwwg.', '..llll..'],
  bell: ['...kk...', '...yy...', '..ywyy..', '.ywyyyY.', '.yyyyYY.', 'yyyyyyYY', 'ssssssss', '.SSSSSS.'],
  directory: ['FFFFFFFF', 'FkkkkkkF', 'FwwwkwwF', 'FkkkkkkF', 'FwwkkwwF', 'FkkkkkkF', 'FwwwkwwF', 'FFFFFFFF'],
  newTask: ['wwwwww..', 'wllllw..', 'wwwwww..', 'wlllwwg.', 'wwwwwggg', 'wllwwwg.', 'wwwwww..', '........'],
  files: ['ssssssss', 'sswkksss', 'SSSSSSSS', 'sswkksss', 'SSSSSSSS', 'sswkksss', 'ssssssss', '.S....S.'],
  library: ['rr..gg..', 'rrbbgg..', 'rrbbggyy', 'rwbbgwyy', 'rrbbggyy', 'rrbbggyy', 'RRBBGGYY', 'hhhhhhhh'],
  phone: ['.rrrrrr.', 'rrrrrrrr', 'rR....Rr', '..rrrr..', '.rrwwrr.', '.rwRRwr.', 'rrrwwrrr', 'rrrrrrrr'],
  handbook: ['Bbbbbbb.', 'Bbwwwwbw', 'Bbbbbbbw', 'Bbbbbbbw', 'Bbbyybbw', 'Bbbbbbbw', 'Bbbbbbbw', 'BBBBBBBw'],
  agency: ['..hhhh..', '..tttt..', '..tttt..', '...tt...', '.oooooo.', 'oowwoooo', 'oowwoooo', 'oooooooo'],
};

/** All icon ids. */
export const ICON_IDS = Object.keys(ICONS) as IconId[];
/** Size of an icon canvas (8x8 art plus a 1px outline on each side). */
export const ICON_SIZE = 10;

const iconCache = new Map<IconId, HTMLCanvasElement>();

/** Cached 10x10 canvas for an icon (dark selective outline included). */
export function getIcon(id: IconId): HTMLCanvasElement {
  let c = iconCache.get(id);
  if (!c) {
    const g = new PixelGrid(ICON_SIZE, ICON_SIZE);
    g.stamp(ICONS[id], ICON_PAL, 1, 1);
    if (id !== 'thinking') g.outline(OUTLINE, 0.55);
    c = g.toCanvas();
    iconCache.set(id, c);
  }
  return c;
}

/**
 * Larger UI icons (18x18 art outlined to 20x20) for the icon bar, the rail and the panels, where the 8x8 art reads as
 * blocky beside the office. `pixelIcon` uses them at whole multiples of 20 px; smaller sizes and the bubbles keep the 8x8 art.
 */
const UI_ICON_PAL: Palette = {
  ...ICON_PAL,
  W: '#d9d3c5', u: '#e4ecf1', q: '#56616c', i: '#fbe7a1', v: '#9fd88f', a: '#8db9ee', j: '#f2867a', H: '#5a3a22', P: '#c86478', x: '#f4b88a',
};

const UI_ICONS: Readonly<Partial<Record<IconId, readonly string[]>>> = {
  inTray: [
    '..................',
    '.....wwwwwwwwwww..',
    '.....wlllllllllW..',
    '.....wwwwwwwwwwW..',
    '...wwwwwwwwwwwwW..',
    '...wlllllllllwWW..',
    '...wwwwwwwwwwwWW..',
    '...wllllllwwwwWW..',
    '.TTwwwwwwwwwwwWWT.',
    'TfffffffffffffffFT',
    'TttttttttttttttttT',
    'TttttthhhhhhtttttT',
    'TtttttHHHHHHtttttT',
    'TttttttttttttttttT',
    'TTTTTTTTTTTTTTTTTT',
    '.hh............hh.',
    '..................',
    '..................',
  ],
  plans: [
    'SSSSSSSSSSSSSSSSSS',
    'SuuuuuuuuuuuuuuuuS',
    'SwllllwllllwllllwS',
    'SwwwwwwwwwwwwwwwwS',
    'SwyyyywggggwppppwS',
    'SwyYYywgGGgwpPPpwS',
    'SwyyyywggggwppppwS',
    'SwwwwwwwwwwwwwwwwS',
    'SwyyyywggggwwwwwwS',
    'SwyYYywgGGgwwwwwwS',
    'SwyyyywggggwwwwwwS',
    'SwwwwwwwwwwwwwwwwS',
    'SwbbbbwwwwwwwwwwwS',
    'SwbBBbwwwwwwwwwwwS',
    'SwbbbbwwwwwwwwwwwS',
    'SSSSSSSSSSSSSSSSSS',
    '..qq..........qq..',
    '.qqq..........qqq.',
  ],
  usage: [
    '......SSSSSS......',
    '....SSuuuuuuSS....',
    '...SuuwwwwwwuuS...',
    '..SuwgwwywwwrwuS..',
    '.SuwggwwyywwrrwuS.',
    '.SuggwwwwwwwkrrwS.',
    'SuwgwwwwwwwkwwrwuS',
    'SuwwwwwwwwkwwwwwuS',
    'SuwwwwwwwkwwwwwwuS',
    'SuwwwwwwkkwwwwwwuS',
    'SuwwwwwwkkwwwwwwuS',
    'SuwwwwwwwwwwwwwwuS',
    '.SuwwwwllllwwwwuS.',
    '.SuwwwwwwwwwwwwuS.',
    '..SuuwwwwwwwwuuS..',
    '...SSuuuuuuuuSS...',
    '.....SSSSSSSS.....',
    '..................',
  ],
  bell: [
    '..................',
    '........uS........',
    '........sS........',
    '.......uuSS.......',
    '........FF........',
    '......yyyyyy......',
    '....yiiyyyyyYY....',
    '...yiiyyyyyyyYY...',
    '..yiiyyyyyyyyyYY..',
    '..yiyyyyyyyyyyYY..',
    '.yyyyyyyyyyyyyyYY.',
    '.yyyyyyyyyyyyyyYY.',
    '.YYyyyyyyyyyyyYYY.',
    'uuuuuuuuuuuuuuuuuu',
    'sssssssssssssssssS',
    'SSSSSSSSSSSSSSSSSS',
    '.qqqqqqqqqqqqqqqq.',
    '..................',
  ],
  directory: [
    'FFFFFFFFFFFFFFFFFF',
    'FffffffffffffffffF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnnyyyyyyyyyynnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnwwwwwwnnnwwnnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnwwwwwnnnnwwnnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnwwwwwwwnnwwnnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnwwwwnnnnnwwnnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FfnwwwwwwnnnwwnnhF',
    'FfnnnnnnnnnnnnnnhF',
    'FhhhhhhhhhhhhhhhhF',
    'FFFFFFFFFFFFFFFFFF',
    '..................',
  ],
  newTask: [
    '..wwwwwwwwwww.....',
    '..wwwwwwwwwwWW....',
    '..wllllllllwWWW...',
    '..wwwwwwwwwwwWWW..',
    '..wlllllllllllWW..',
    '..wwwwwwwwwwwwWW..',
    '..wllllllllllwWW..',
    '..wwwwwwwwwwwwWW..',
    '..wllllllwwwwwWW..',
    '..wwwwwwwwwwwwWW..',
    '..wlllllwwwwGGGW..',
    '..wwwwwwwwwGgwgG..',
    '..wlllllwwGggwggG.',
    '..wwwwwwwwGwwwwwG.',
    '..WWWWWWWWGggwggG.',
    '...........GgwgG..',
    '............GGG...',
    '..................',
  ],
  files: [
    '.ssssssssssssssss.',
    'suuuuuuuuuuuuuuuuS',
    'sussssssssssssssqS',
    'sussswwwwwwsssssqS',
    'susssslllssssssqqS',
    'sussssskksssssssqS',
    'sSSSSSSSSSSSSSSSqS',
    'sussssssssssssssqS',
    'sussswwwwwwsssssqS',
    'susssslllssssssqqS',
    'sussssskksssssssqS',
    'sSSSSSSSSSSSSSSSqS',
    'sussssssssssssssqS',
    'sussswwwwwwsssssqS',
    'susssslllssssssqqS',
    'sussssskksssssssqS',
    'SqqqqqqqqqqqqqqqqS',
    '.qq............qq.',
  ],
  library: [
    '..................',
    '..................',
    '.rr...............',
    'rjrRbb.....oo.....',
    'rjrRbab.ggGoxoO...',
    'rjrRbabBgvgoxoOyy.',
    'rwwRbabBgvgoooOiyY',
    'rjrRbabBgvgowoOiyY',
    'rjrRbwbBgwgoxoOiyY',
    'rjrRbabBgvgoxoOiyY',
    'rjrRbabBgvgoxoOiyY',
    'rjrRbabBgvgoxoOiyY',
    'rrrRbbbBgggoooOyyY',
    'RRRRBBBBGGGOOOOYYY',
    'HhhhhhhhhhhhhhhhhH',
    'HHHHHHHHHHHHHHHHHH',
    '.H..............H.',
    '..................',
  ],
  phone: [
    '..................',
    '..rrrrrrrrrrrrrr..',
    '.rjjjjjjjjjjjjjrR.',
    'rjrrrrrrrrrrrrrrrR',
    'rrRR........RRrrR.',
    '.RR..........RRR..',
    '.....rrrrrrrr.....',
    '....rjjjjjjjjr....',
    '...rjrrwwwwrrrrR..',
    '..rjrrwkwwkwrrrR..',
    '..rjrrwwnnwwrrrR..',
    '.rjrrrwkwwkwrrrrR.',
    '.rjrrrrwwwwrrrrrR.',
    '.rrrrrrrrrrrrrrrR.',
    '.RRRRRRRRRRRRRRRR.',
    '..................',
    '..................',
    '..................',
  ],
  handbook: [
    '..BBBBBBBBBBBBBB..',
    '.BbaaaaaaaaaaaaBe.',
    '.BbbbbbbbbbbbbbBe.',
    '.BbbbbbbbbbbbbbBeW',
    '.BbbYYYYYYYYbbbBeW',
    '.BbbYiiiiiiYbbbBeW',
    '.BbbYYYYYYYYbbbBeW',
    '.BbbbbbbbbbbbbbBeW',
    '.BbbbbbyybbbbbbBeW',
    '.BbbbbyiyYbbbbbBeW',
    '.BbbbbyyyYbbbbbBeW',
    '.BbbbbbYYbbbbbbBeW',
    '.BbbbbbbbbbbbbbBeW',
    '.BbbbbbbbbbbbbbBeW',
    '.BbbbbbbbbbbbbbBeW',
    '.BBBBBBBBBBBBBBBeW',
    '..WeeeeeeeeeeeeeeW',
    '...WWWWWWWWWWWWWW.',
  ],
  agency: [
    '......hhhhhh......',
    '.....hhhhhhhh.....',
    '....hhhhhhhhhh....',
    '....hhttttttth....',
    '....httttttttt....',
    '....ttktttkttt....',
    '....ttttttttttx...',
    '.....tttTTtttx....',
    '......tttttt......',
    '.......TttT.......',
    '...oooowrrwoooo...',
    '..ooooowrrwoooooO.',
    '.ooooooorrooooooO.',
    '.ooooooorroeeeooO.',
    '.ooooooorrobbbooO.',
    '.oooooooRRooooooO.',
    '.OOOOOOOOOOOOOOOO.',
    '..................',
  ],
};

/** Size of a UI icon canvas (18x18 art plus a 1px outline on each side). */
export const UI_ICON_SIZE = 20;

const uiIconCache = new Map<IconId, HTMLCanvasElement>();

/** Cached 20x20 canvas for a UI icon, or undefined when the icon only has 8x8 art. */
export function getUiIcon(id: IconId): HTMLCanvasElement | undefined {
  const rows = UI_ICONS[id];
  if (!rows) return undefined;
  let c = uiIconCache.get(id);
  if (!c) {
    const g = new PixelGrid(UI_ICON_SIZE, UI_ICON_SIZE);
    g.stamp(rows, UI_ICON_PAL, 1, 1);
    g.outline(OUTLINE, 0.55);
    c = g.toCanvas();
    uiIconCache.set(id, c);
  }
  return c;
}

/** Bubble style. */
export type BubbleKind = 'speech' | 'thought';

/** Bubble colours (override fields to theme them). */
export const BUBBLE_STYLE = { fill: '#fffdf6', border: '#2a2230', text: '#2a2230', shadow: 'rgba(20,12,24,0.35)' };

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

/**
 * Draws an empty bubble body with its tail pointing down to (tailX, y+h+tail).
 * (x, y, w, h) is the body rectangle including the 1px border. Returns nothing;
 * draw the contents inside (x+2, y+2, w-4, h-4).
 */
export function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: BubbleKind, tailX: number = x + Math.floor(w / 2)): void {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h); tailX = Math.round(tailX);
  const { fill: f, border: b, shadow } = BUBBLE_STYLE;
  // shadow
  fill(ctx, x + 1, y + h, w - 1, 1, shadow);
  // body with rounded corners
  const r = kind === 'thought' ? 2 : 1;
  fill(ctx, x + r, y, w - 2 * r, h, b);
  fill(ctx, x, y + r, w, h - 2 * r, b);
  if (r === 2) { fill(ctx, x + 1, y + 1, 1, 1, b); fill(ctx, x + w - 2, y + 1, 1, 1, b); fill(ctx, x + 1, y + h - 2, 1, 1, b); fill(ctx, x + w - 2, y + h - 2, 1, 1, b); }
  fill(ctx, x + r, y + 1, w - 2 * r, h - 2, f);
  fill(ctx, x + 1, y + r, w - 2, h - 2 * r, f);
  if (kind === 'speech') {
    const tx = Math.max(x + 2, Math.min(x + w - 4, tailX - 1));
    fill(ctx, tx, y + h - 1, 3, 1, f);
    fill(ctx, tx, y + h, 3, 1, b);
    fill(ctx, tx + 1, y + h, 1, 1, f);
    fill(ctx, tx + 1, y + h + 1, 1, 1, f);
    fill(ctx, tx, y + h + 1, 1, 1, b);
    fill(ctx, tx + 2, y + h + 1, 1, 1, b);
    fill(ctx, tx + 1, y + h + 2, 1, 1, b);
  } else {
    // trailing puffs
    const tx = Math.max(x + 2, Math.min(x + w - 4, tailX - 1));
    fill(ctx, tx, y + h + 1, 3, 2, b);
    fill(ctx, tx + 1, y + h + 1, 1, 2, f);
    fill(ctx, tx, y + h + 1, 1, 1, b);
    fill(ctx, tx + 1, y + h + 4, 1, 1, b);
  }
}

/**
 * Draws a small bubble containing an icon, its tail tip at (anchorX, anchorY)
 * (usually just above a character's head: feetY - 25). Returns the bubble
 * rectangle.
 */
export function drawIconBubble(ctx: CanvasRenderingContext2D, icon: IconId, anchorX: number, anchorY: number, kind: BubbleKind = 'speech'): { x: number; y: number; w: number; h: number } {
  const w = ICON_SIZE + 4;
  const h = ICON_SIZE + 4;
  const tail = kind === 'thought' ? 5 : 3;
  const x = Math.round(anchorX - w / 2);
  const y = Math.round(anchorY - tail - h);
  drawBubble(ctx, x, y, w, h, kind, anchorX);
  ctx.drawImage(getIcon(icon), x + 2, y + 2);
  return { x, y, w, h };
}

/** Splits text into lines no wider than maxW pixels. */
export function wrapPixelText(text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word;
    if (measurePixelText(next).w <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * Draws a text bubble (optionally with a leading icon) whose tail tip is at
 * (anchorX, anchorY). Text wraps at `maxW` pixels. Returns the bubble rect.
 */
export function drawTextBubble(
  ctx: CanvasRenderingContext2D,
  text: string,
  anchorX: number,
  anchorY: number,
  opts: { kind?: BubbleKind; maxW?: number; icon?: IconId; bounds?: { w: number; h: number } } = {},
): { x: number; y: number; w: number; h: number } {
  const kind = opts.kind ?? 'speech';
  const iconW = opts.icon ? ICON_SIZE + 1 : 0;
  const lines = wrapPixelText(text, (opts.maxW ?? 72) - iconW);
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, measurePixelText(l).w);
  const textH = lines.length * FONT_LINE_HEIGHT - 1;
  const w = tw + iconW + 6;
  const h = Math.max(textH, opts.icon ? ICON_SIZE : 0) + 5;
  const tail = kind === 'thought' ? 5 : 3;
  let x = Math.round(anchorX - w / 2);
  const y = Math.round(anchorY - tail - h);
  if (opts.bounds) x = Math.max(1, Math.min(opts.bounds.w - w - 1, x));
  drawBubble(ctx, x, y, w, h, kind, anchorX);
  let tx = x + 3;
  if (opts.icon) { ctx.drawImage(getIcon(opts.icon), x + 2, y + Math.floor((h - ICON_SIZE) / 2)); tx += iconW; }
  const ty = y + 3 + Math.floor((h - 5 - textH) / 2);
  lines.forEach((l, i) => drawPixelText(ctx, l, tx, ty + i * FONT_LINE_HEIGHT, BUBBLE_STYLE.text));
  return { x, y, w, h };
}

/** Draws a small dark name tag centred at x with its top at y. Returns its rect. */
export function drawNameLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, color = '#fff4d8'): { x: number; y: number; w: number; h: number } {
  const m = measurePixelText(text);
  const w = m.w + 4;
  const h = 8;
  const x = Math.round(cx - w / 2);
  y = Math.round(y);
  fill(ctx, x + 1, y, w - 2, h, 'rgba(24,18,30,0.78)');
  fill(ctx, x, y + 1, w, h - 2, 'rgba(24,18,30,0.78)');
  drawPixelText(ctx, text, x + 2, y + 1, color);
  return { x, y, w, h };
}
