/**
 * View fitting and the pan/zoom camera (pure math, CSS pixels).
 *
 * - Fit mode: the whole map, "contain", centred, at an integer device-pixel
 *   scale when that keeps at least ~85% of the available size, otherwise a
 *   fractional scale (drawn "sharp bilinear" by main.ts). Just below 1 device
 *   px it stays at 1 and crops a few pixels of wall instead of blurring.
 * - Camera mode (when the fitted scale would be below MIN_FIT_SCALE, e.g. a
 *   narrow sidebar): the map fills the height and can be dragged and zoomed.
 *   Zooming with the wheel also works in fit mode; double-click resets.
 */

/** Below this fitted scale the view switches to the pan camera. */
export const MIN_FIT_SCALE = 0.9;
const MAX_ZOOM_FACTOR = 4;

export interface View {
  /** CSS px per map px. */
  scale: number;
  /** CSS px position of the map's top-left corner. */
  ox: number;
  oy: number;
  /** True when the view can be panned (map bigger than the viewport). */
  pannable: boolean;
}

export interface CameraState {
  /** User zoom relative to the default scale (1 = default). */
  zoom: number;
  /** Map px at the centre of the viewport (null = default centre). */
  cx: number | null;
  cy: number | null;
}

export function defaultCamera(): CameraState {
  return { zoom: 1, cx: null, cy: null };
}

/** The scale that shows the whole map (before integer snapping). */
export function containScale(vw: number, vh: number, mw: number, mh: number): number {
  return Math.max(0.01, Math.min(vw / mw, vh / mh));
}

/**
 * Default scale: contain (integer device pixels when close), or fill height
 * when that would be too small.
 *
 * Just under 1 device px per map px (a 250 px tall bottom panel shows the
 * 272 px map at 0.92) the art would be shrunk and blurred; it is drawn at
 * 1 device px instead and the outer wall edges are cropped by a few pixels
 * (the view can still be dragged or zoomed out).
 */
export function baseScale(vw: number, vh: number, mw: number, mh: number, dpr: number): { scale: number; camera: boolean } {
  const s = containScale(vw, vh, mw, mh);
  if (s < MIN_FIT_SCALE) return { scale: Math.max(vh / mh, 0.01), camera: true };
  const dev = s * dpr;
  const snapped = Math.floor(dev);
  if (snapped >= 1 && snapped / dev >= 0.85) return { scale: snapped / dpr, camera: false };
  if (snapped === 0 && dev >= 0.85) return { scale: 1 / dpr, camera: false };
  return { scale: s, camera: false };
}

/**
 * True when the default (fit) view shows the whole map, give or take the few pixels the 1-device-px snap in `baseScale`
 * crops: not the pan camera and not zoomed in. Layout (the roster, the room under the icon bar) treats such a view as a
 * fitted one even though it can be dragged by those few pixels.
 */
export function fitsWholeMap(vw: number, vh: number, mw: number, mh: number, dpr: number, cam: CameraState): boolean {
  return cam.zoom <= 1 && !baseScale(vw, vh, mw, mh, dpr).camera;
}

/**
 * Computes the view for a viewport, map size and camera state. `focusX` is
 * the default horizontal centre (map px) in camera mode.
 */
export function computeView(vw: number, vh: number, mw: number, mh: number, dpr: number, cam: CameraState, focusX: number): View {
  const base = baseScale(vw, vh, mw, mh, dpr);
  const minScale = Math.min(base.scale, containScale(vw, vh, mw, mh));
  const scale = Math.max(minScale, Math.min(base.scale * MAX_ZOOM_FACTOR, base.scale * cam.zoom));
  const w = mw * scale;
  const h = mh * scale;
  const axis = (viewLen: number, mapLen: number, centre: number | null, fallback: number): number => {
    if (mapLen <= viewLen) return Math.round((viewLen - mapLen) / 2);
    const c = centre ?? fallback;
    const o = viewLen / 2 - c * scale;
    return Math.min(0, Math.max(viewLen - mapLen, o));
  };
  const ox = axis(vw, w, cam.cx, base.camera ? focusX : mw / 2);
  const oy = axis(vh, h, cam.cy, mh / 2);
  return { scale, ox, oy, pannable: w > vw + 0.5 || h > vh + 0.5 };
}

/** Map px at the viewport centre for a view. */
export function viewCentre(v: View, vw: number, vh: number): { x: number; y: number } {
  return { x: (vw / 2 - v.ox) / v.scale, y: (vh / 2 - v.oy) / v.scale };
}

/** Clamps the zoom so the view never gets smaller than "show everything" (no dead zone when zooming back in). */
export function clampCamera(cam: CameraState, vw: number, vh: number, mw: number, mh: number, dpr: number): CameraState {
  const base = baseScale(vw, vh, mw, mh, dpr).scale;
  const minZoom = Math.min(1, containScale(vw, vh, mw, mh) / base);
  const zoom = Math.max(minZoom, Math.min(MAX_ZOOM_FACTOR, cam.zoom));
  return zoom === cam.zoom ? cam : { ...cam, zoom };
}

/** Pans by a CSS-pixel drag delta. */
export function panBy(cam: CameraState, v: View, vw: number, vh: number, dx: number, dy: number): CameraState {
  const c = viewCentre(v, vw, vh);
  return { ...cam, cx: c.x - dx / v.scale, cy: c.y - dy / v.scale };
}

/** Zooms by `factor` keeping the map point under (px, py) (CSS px) fixed. */
export function zoomAt(cam: CameraState, v: View, vw: number, vh: number, px: number, py: number, factor: number): CameraState {
  const mx = (px - v.ox) / v.scale;
  const my = (py - v.oy) / v.scale;
  const zoom = Math.max(0.25, Math.min(MAX_ZOOM_FACTOR, cam.zoom * factor));
  const realFactor = zoom / cam.zoom;
  const newScale = v.scale * realFactor;
  // Keep (mx, my) under the cursor: new centre = m + (centre - p) / newScale.
  const cx = mx + (vw / 2 - px) / newScale;
  const cy = my + (vh / 2 - py) / newScale;
  return { zoom, cx, cy };
}

/** CSS px → map px. */
export function toMap(v: View, px: number, py: number): { x: number; y: number } {
  return { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale };
}

/** Device px per bubble px for text (bubbles, labels) and for icon bubbles. */
export interface OverlayUnits { text: number; icon: number }

/**
 * UI scale for the overlay. Icons follow the office's own (rounded) scale so
 * they stay in proportion with the 16x24 people; text never drops below
 * 2 CSS px per font pixel (a 3x5 font at 1x is unreadable on a normal
 * screen), and grows with the office when the office is drawn bigger.
 */
export function overlayUnits(scale: number, dpr: number): OverlayUnits {
  const world = Math.max(1, Math.round(scale * dpr));
  const minText = Math.max(2, Math.round(2 * dpr));
  return { text: Math.max(world, minText), icon: Math.max(world, Math.max(1, Math.round(dpr))) };
}
