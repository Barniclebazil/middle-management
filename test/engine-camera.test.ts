import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseScale, clampCamera, computeView, defaultCamera, fitsWholeMap, panBy, toMap } from '../webview/engine/camera.ts';

const MW = 736;
const MH = 272;

test('fit mode uses an integer device-pixel scale when it is close, else fractional', () => {
  assert.deepEqual(baseScale(1600, 600, MW, MH, 1), { scale: 2, camera: false });
  assert.deepEqual(baseScale(1600, 300, MW, MH, 1), { scale: 1, camera: false });
  const editor = baseScale(1200, 700, MW, MH, 1);
  assert.equal(editor.camera, false);
  assert.ok(Math.abs(editor.scale - 1200 / MW) < 1e-9);
  // HiDPI: 1.5 css px per map px is an integer 3 device px.
  assert.deepEqual(baseScale(1104, 408, MW, MH, 2), { scale: 1.5, camera: false });
  // A 250 px panel: 1x with a few pixels of wall cropped, not a blurry 0.92x.
  assert.deepEqual(baseScale(1600, 250, MW, MH, 1), { scale: 1, camera: false });
  const v = computeView(1600, 250, MW, MH, 1, defaultCamera(), 480);
  assert.equal(v.oy, -11);
  assert.equal(v.ox, Math.round((1600 - MW) / 2));
  // Further down it shrinks rather than cropping a lot.
  assert.ok(baseScale(1600, 220, MW, MH, 1).scale < 1);
});

test('a narrow sidebar switches to a pannable camera that fills the height', () => {
  const b = baseScale(380, 700, MW, MH, 1);
  assert.equal(b.camera, true);
  assert.ok(Math.abs(b.scale - 700 / MH) < 1e-9);
  const v = computeView(380, 700, MW, MH, 1, defaultCamera(), 480);
  assert.ok(v.pannable);
  assert.equal(v.oy, 0);
  assert.ok(Math.abs(toMap(v, 190, 350).x - 480) < 1, 'centred on the focus point');
  // Panning is clamped to the map edges.
  const far = computeView(380, 700, MW, MH, 1, panBy(defaultCamera(), v, 380, 700, 100_000, 0), 480);
  assert.equal(far.ox, 0);
  // Zooming out stops at "show everything".
  const out = clampCamera({ zoom: 0.01, cx: null, cy: null }, 380, 700, MW, MH, 1);
  const vo = computeView(380, 700, MW, MH, 1, out, 480);
  assert.ok(Math.abs(vo.scale - 380 / MW) < 1e-9);
  assert.equal(vo.pannable, false);
});

test('fitsWholeMap: a fit view counts even when the 1-device-px snap crops a few pixels; the pan camera and zoom-in do not (task 4.2)', () => {
  // 700 px wide (a 1100 px window with the 400 px drawer docked): drawn at 1x, 18 px cropped each side, still "the whole office".
  const v = computeView(700, 700, MW, MH, 1, defaultCamera(), 0);
  assert.equal(v.scale, 1);
  assert.ok(v.pannable, 'the snap crop makes it draggable');
  assert.equal(fitsWholeMap(700, 700, MW, MH, 1, defaultCamera()), true);
  assert.equal(fitsWholeMap(1100, 700, MW, MH, 1, defaultCamera()), true);
  assert.equal(fitsWholeMap(360, 700, MW, MH, 1, defaultCamera()), false, 'the sidebar pan camera');
  assert.equal(fitsWholeMap(1100, 700, MW, MH, 1, { ...defaultCamera(), zoom: 2 }), false, 'zoomed in');
});
