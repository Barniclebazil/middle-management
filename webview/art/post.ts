/**
 * Post from head office (the update notice): a sealed envelope propped on the reception counter in front of the receptionist,
 * and a small envelope badge over the counter's left end that pulses slowly, like the in-tray badge but calmer. The badge takes
 * its colours from the caller (the theme's sign, chosen by `engine/updateCueLogic.ts` `postColours`), so it reads on every theme;
 * the envelopes themselves are paper with a red wax seal. Map pixels; drawn with (ox, oy) = the map origin, like `props.ts`.
 */
import { C, OUTLINE } from './palette.ts';
import type { Color } from './raster.ts';
import { PixelGrid, mix } from './raster.ts';
import { TILE } from './office-map.ts';

/** The reception counter front sorts at 5 * TILE + 31 (its seat row's desk fronts); the post sorts just after it, on the ledge. */
export const POST_SORT_Y = 5 * TILE + 31.5;

/** The envelope on the counter ledge, centred on the receptionist (map px, outline included). */
export const POST_ENVELOPE_RECT = { x: 84, y: 89, w: 9, h: 7 } as const;
/** The badge over the counter's left end (map px, outline and tail included). */
export const POST_BADGE_RECT = { x: 63, y: 71, w: 13, h: 13 } as const;

/** The theme's sign colours as drawn right now (they follow the Front desk's colour edits and previews). */
export function signColours(): { plate: string; text: string; branch: string } {
  return { plate: C.signPlate, text: C.signText, branch: C.signBranch };
}

const PAPER = '#fbf6e8';
const PAPER_SHADE = '#e3d9bf';
const SEAL = '#b8433a';
const SEAL_LIGHT = '#d8645a';

const cache = new Map<string, HTMLCanvasElement>();
function cached(key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) {
    // A theme being edited in the Front desk can go through many colours: keep the memo small.
    if (cache.size > 48) cache.clear();
    c = make();
    cache.set(key, c);
  }
  return c;
}

/** A 7 x 5 sealed envelope (flap V in `flap`, red seal where it meets) stamped at (x, y) of `g`. */
function stampEnvelope(g: PixelGrid, x: number, y: number, flap: Color): void {
  g.fill(x, y, 7, 5, PAPER);
  g.stamp(['f.....f', '.f...f.', '..fsf..', '.......', 'ddddddd'], { f: flap, s: SEAL, d: PAPER_SHADE }, x, y);
  g.set(x + 3, y + 1, SEAL_LIGHT);
}

/** The envelope propped on the counter: paper, a brown-ink flap and the seal. 9 x 7 with its outline. */
function counterEnvelopeSprite(): HTMLCanvasElement {
  const flap = mix(C.woodDark, OUTLINE, 0.25);
  return cached(`counter:${flap}`, () => {
    const g = new PixelGrid(9, 7);
    stampEnvelope(g, 1, 1, flap);
    g.outline(OUTLINE, 0.6);
    return g.toCanvas();
  });
}

/**
 * The badge: a rounded plate with the envelope on it and a short tail pointing down at the counter. `bright` lights the rim
 * (the slow pulse); without it the rim sits halfway between the rim colour and the plate. 13 x 13 with its outline.
 */
function badgeSprite(plate: Color, rim: Color, bright: boolean): HTMLCanvasElement {
  return cached(`badge:${plate}:${rim}:${bright}`, () => {
    const g = new PixelGrid(13, 13);
    const edge = bright ? rim : mix(rim, plate, 0.55);
    // plate 11 x 9 at (1,1) with cut corners, rim one pixel in
    g.fill(2, 1, 9, 9, plate);
    g.fill(1, 2, 11, 7, plate);
    for (let i = 2; i <= 10; i++) { g.set(i, 1, edge); g.set(i, 9, edge); }
    for (let j = 2; j <= 8; j++) { g.set(1, j, edge); g.set(11, j, edge); }
    // tail under the plate
    g.fill(5, 10, 3, 1, edge);
    g.set(6, 11, edge);
    stampEnvelope(g, 3, 3, plate);
    g.outline(OUTLINE, 0.8);
    return g.toCanvas();
  });
}

/** The badge on its own (13 x 13 map px), for the "post waiting" pointer at the edge of a panned view. */
export function postBadgeSprite(colours: { plate: Color; rim: Color }, bright: boolean): HTMLCanvasElement {
  return badgeSprite(colours.plate, colours.rim, bright);
}

/** Draws the counter envelope and the badge. Call after the reception desk front (sortY `POST_SORT_Y`). */
export function drawHeadOfficePost(ctx: CanvasRenderingContext2D, ox: number, oy: number, colours: { plate: Color; rim: Color }, bright: boolean): void {
  ctx.drawImage(counterEnvelopeSprite(), ox + POST_ENVELOPE_RECT.x, oy + POST_ENVELOPE_RECT.y);
  ctx.drawImage(badgeSprite(colours.plate, colours.rim, bright), ox + POST_BADGE_RECT.x, oy + POST_BADGE_RECT.y);
}

/** Drops the cached sprites (tests; every key already carries its colours, so a theme change needs no clearing). */
export function clearPostCache(): void {
  cache.clear();
}
