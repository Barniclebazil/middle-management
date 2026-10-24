/**
 * The vendor's food cart: a chrome-and-wood tea trolley with a striped valance, a tea urn, a carrot cake, doughnuts
 * and crisps. Drawn as a scene extra in front of the vendor (`pushCart`), or parked while the manager picks something
 * (`pickFood`).
 *
 * Coordinates: like a character, the cart has a feet-style anchor at the bottom centre of its sprite
 * (`FOOD_CART_ANCHOR[facing]`): blit `foodCartSprite(facing)` at `(ax - anchor.x, ay - anchor.y)` for a floor point
 * `(ax, ay)`. `foodCartPlacement(facing, feetX, feetY)` does the whole job from the vendor's feet: it puts the cart
 * ahead of the vendor in the walking direction (handle at the vendor's hands) and gives the `sortY` to draw it at.
 *
 * Sorting (cf. `POST_SORT_Y` in post.ts): the cart's sortY is its floor line, `feetY + FOOD_CART_SORT_DY[facing]`.
 * Walking left or right that is just below the vendor's feet, so the cart (and its handle) draws over the vendor's
 * near hand; walking down the cart is in front of the vendor (hides the legs); walking up it is behind.
 *
 * Colours are fixed (prop palette), so no theme change needs to redraw it; the memo is still dropped by
 * `invalidateArtCaches` for uniformity.
 */
import { OUTLINE, PROP_PAL } from './palette.ts';
import type { Palette } from './raster.ts';
import { PixelGrid, flipCanvas } from './raster.ts';
import { FOOD_ROWS, ITEM_PAL } from './characters.ts';

/** Which way the cart faces (= the way the vendor pushes it). */
export type CartFacing = 'left' | 'right' | 'up' | 'down';

/** Sprite size per facing, in map pixels. */
export const FOOD_CART_SIZE: Readonly<Record<CartFacing, { w: number; h: number }>> = {
  right: { w: 30, h: 22 },
  left: { w: 30, h: 22 },
  down: { w: 20, h: 24 },
  up: { w: 20, h: 24 },
};

/** The anchor inside the sprite: bottom centre, where the wheels meet the floor. */
export const FOOD_CART_ANCHOR: Readonly<Record<CartFacing, { x: number; y: number }>> = {
  right: { x: 15, y: 22 },
  left: { x: 15, y: 22 },
  down: { x: 10, y: 24 },
  up: { x: 10, y: 24 },
};

/** The cart's anchor relative to the vendor's feet: ahead of the vendor, handle in hand. */
export const FOOD_CART_OFFSET: Readonly<Record<CartFacing, { dx: number; dy: number }>> = {
  right: { dx: 19, dy: 1 },
  left: { dx: -19, dy: 1 },
  down: { dx: 0, dy: 12 },
  up: { dx: 0, dy: -9 },
};

/** sortY of the cart relative to the vendor's feet y (equal to `FOOD_CART_OFFSET[f].dy`: the cart's own floor line). */
export const FOOD_CART_SORT_DY: Readonly<Record<CartFacing, number>> = {
  right: FOOD_CART_OFFSET.right.dy,
  left: FOOD_CART_OFFSET.left.dy,
  down: FOOD_CART_OFFSET.down.dy,
  up: FOOD_CART_OFFSET.up.dy,
};

/** Where to draw the cart for a vendor whose feet are at map pixel (feetX, feetY): sprite top-left and sortY. */
export function foodCartPlacement(facing: CartFacing, feetX: number, feetY: number): { x: number; y: number; sortY: number } {
  const o = FOOD_CART_OFFSET[facing];
  const a = FOOD_CART_ANCHOR[facing];
  return { x: feetX + o.dx - a.x, y: feetY + o.dy - a.y, sortY: feetY + FOOD_CART_SORT_DY[facing] };
}

// ---------------------------------------------------------------------------
// Drawing

/** Cart palette (fixed on purpose: the cart is a visitor's object, not office furniture, so it ignores theme colours): chrome frame (8 + -), charcoal grips and tyres (9), light wood shelves (W, w, v), the red-and-white valance (7, 2). */
const CART_PAL: Palette = { ...PROP_PAL, W: '#d9b07a', w: '#b98a55', v: '#8f6538' };

// The tea urn: lid knob, chrome body with a highlight and a shade column, a gauge window, a tap on the side.
const URN = [
  '..99..',
  '.++++.',
  '+8888-',
  '+8888-',
  '+8668-',
  '+8668-',
  '+8888-',
  '+8888-',
  '-----9',
];
// A whole carrot cake on a plate, one slice gone (frosting 0, sponge c/C, piped carrots A with leaves z).
const CAKE = [
  '.Az.Az.',
  '00000..',
  'ccccC0.',
  '00000c.',
  'cccCCC.',
  '2222222',
];
// A stack of paper cups and a short row of crisps packets lying down, for the bottom shelf.
const CUPS = ['22', '22', '22'];
const CRISPS_FLAT = ['7756655', '7r56r55'];

const memo = new Map<string, HTMLCanvasElement>();
function cached(key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = memo.get(key);
  if (!c) { c = make(); memo.set(key, c); }
  return c;
}

/** Drops the memoised cart sprites (wired into `invalidateArtCaches`). */
export function clearFoodCartCache(): void {
  memo.clear();
}

/** A red-and-white striped valance row from x0, `w` wide. */
function valance(g: PixelGrid, x0: number, y: number, w: number, h: number): void {
  for (let i = 0; i < w; i++) {
    const c = Math.floor(i / 2) % 2 === 0 ? CART_PAL['7']! : CART_PAL['2']!;
    for (let j = 0; j < h; j++) g.set(x0 + i, y + j, c);
  }
  for (let i = 0; i < w; i++) g.set(x0 + i, y + h - 1, Math.floor(i / 2) % 2 === 0 ? CART_PAL['R']! : CART_PAL['n']!);
}

const WHEEL = ['.9.', '9-9', '.9.'];

/** Side view, pushed to the right: handle on the left end, urn at the far (right) end. 30 x 22. */
function sideCart(): HTMLCanvasElement {
  const { w, h } = FOOD_CART_SIZE.right;
  const g = new PixelGrid(w, h);
  const P = CART_PAL;
  // legs, bottom shelf and wheels
  for (const x of [5, 24]) { g.fill(x, 12, 1, 7, P['8']!); g.set(x, 18, P['-']!); }
  g.fill(3, 16, 24, 1, P['W']!);
  g.fill(3, 17, 24, 1, P['v']!);
  g.stamp(CUPS, P, 7, 13);
  g.stamp(['22'], P, 10, 15);
  g.stamp(CRISPS_FLAT, P, 14, 14);
  g.stamp(WHEEL, P, 4, 19);
  g.stamp(WHEEL, P, 23, 19);
  // the tray: top surface (2 rows), then the striped valance on its front face
  g.fill(2, 9, 26, 1, P['W']!);
  g.fill(2, 10, 26, 1, P['w']!);
  valance(g, 2, 11, 26, 2);
  // push handle: a chrome bar from the tray end down to a charcoal grip
  g.set(1, 10, P['+']!);
  g.set(1, 11, P['+']!);
  g.fill(0, 12, 2, 2, P['9']!);
  // goodies on the tray: doughnuts, a packet of crisps, the cake, the urn
  g.stamp(FOOD_ROWS.doughnut, ITEM_PAL, 3, 6);
  g.stamp(['.xx.', 'x.Xx', 'WxxW'], ITEM_PAL, 4, 3);
  g.stamp(FOOD_ROWS.crisps, ITEM_PAL, 9, 5);
  g.stamp(CAKE, ITEM_PAL, 14, 4);
  g.stamp(URN, P, 21, 1);
  g.set(27, 6, P['9']!);
  g.set(27, 7, P['-']!);
  g.outline(OUTLINE, 0.6);
  return g.toCanvas();
}

/** End view: `handleNear` puts the push handle on the near (bottom) edge of the tray (cart going up, away from the camera). 20 x 24. */
function endCart(handleNear: boolean): HTMLCanvasElement {
  const { w, h } = FOOD_CART_SIZE.down;
  const g = new PixelGrid(w, h);
  const P = CART_PAL;
  // legs, bottom shelf and wheels
  for (const x of [2, 17]) { g.fill(x, 15, 1, 6, P['8']!); g.set(x, 20, P['-']!); }
  g.fill(1, 18, 18, 1, P['W']!);
  g.fill(1, 19, 18, 1, P['v']!);
  g.stamp(CRISPS_FLAT, P, 6, 16);
  g.stamp(WHEEL, P, 1, 21);
  g.stamp(WHEEL, P, 16, 21);
  // the tray seen end-on: a deep top surface, then the valance
  g.fill(1, 5, 18, 8, P['W']!);
  g.fill(1, 5, 18, 1, P['w']!);
  g.fill(1, 12, 18, 1, P['w']!);
  valance(g, 1, 13, 18, 2);
  if (handleNear) {
    // the handle across the near end, under the vendor's hands
    g.fill(3, 15, 14, 1, P['+']!);
    g.fill(3, 16, 2, 1, P['9']!);
    g.fill(15, 16, 2, 1, P['9']!);
  } else {
    g.fill(3, 3, 14, 1, P['+']!);
    g.fill(3, 4, 1, 1, P['8']!);
    g.fill(16, 4, 1, 1, P['8']!);
  }
  // goodies: back row cake and urn, front row doughnut and crisps
  const back = handleNear ? 1 : 0;
  g.stamp(CAKE, ITEM_PAL, 2, 3 + back);
  g.stamp(URN, P, 12, 0 + back);
  g.set(11, 5 + back, P['9']!);
  g.stamp(FOOD_ROWS.doughnut, ITEM_PAL, 3, 8 + back);
  g.stamp(FOOD_ROWS.crisps, ITEM_PAL, 10, 7 + back);
  g.stamp(FOOD_ROWS.crisps, ITEM_PAL, 14, 8 + back);
  g.outline(OUTLINE, 0.6);
  return g.toCanvas();
}

/** The food cart facing `facing` (see the module comment for its size, anchor and placement). */
export function foodCartSprite(facing: CartFacing): HTMLCanvasElement {
  return cached(`cart:${facing}`, () => {
    if (facing === 'right') return sideCart();
    if (facing === 'left') return flipCanvas(sideCart());
    return endCart(facing === 'up');
  });
}
