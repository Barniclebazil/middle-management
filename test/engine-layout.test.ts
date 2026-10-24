import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_TABS_MAX, RAIL_W, STRIP_LIST_MAX_W, STRIP_LIST_MIN_W, STRIP_LIST_WIDE_MAX_W, STRIP_MAX_H, STRIP_MIN_W, belowListDetail, canSendHome, caseTabIds,
  caseTarget, easeToward, framingFocusX, isStrip, overlaps, parkedStopRect, propFocusCentre, propStopRect, stripFor, stripLayout, stripListColumns, stripListWidth, stripListWidthFor,
} from '../webview/engine/layoutLogic.ts';
import { computeView, defaultCamera, fitsWholeMap } from '../webview/engine/camera.ts';

/** The office map in px (MAP_W x MAP_H tiles of 16, webview/art/office-map.ts; not imported: the art needs the DOM types). */
const MAP_PX_W = 46 * 16;
const MAP_PX_H = 17 * 16;
type Size = [number, number];

test('strip thresholds: wide and short views are strips, the sidebar, tall tabs and boxy panels are not', () => {
  for (const [w, h] of [[2000, 400], [1600, 360], [1200, 420], [1000, 500], [2560, 600], [1300, 300]] as Size[]) assert.equal(isStrip(w, h), true, `${w}x${h}`);
  for (const [w, h] of [[360, 800], [700, 600], [1100, 700], [1400, 800], [1600, 700], [999, 300], [1199, 600], [1210, 601], [800, 300]] as Size[]) {
    assert.equal(isStrip(w, h), false, `${w}x${h}`);
  }
  assert.equal(STRIP_MAX_H, 600);
  assert.equal(STRIP_MIN_W, 1000);
  assert.equal(isStrip(1200, 600), true, 'exactly 2:1 and 600 tall counts');
  assert.equal(isStrip(NaN, 400), false);
  assert.equal(isStrip(2000, 0), false);
});

test('the three columns: rail, map, staff list; they tile the width and never overlap', () => {
  for (const [w, h] of [[2000, 400], [1600, 360], [1200, 420]] as Size[]) {
    const l = stripLayout(w, h);
    assert.ok(l.list);
    assert.deepEqual(l.rail, { x: 0, y: 0, w: RAIL_W, h });
    assert.equal(l.map.x, RAIL_W);
    assert.equal(l.map.x + l.map.w, l.list.x, 'the map ends where the list starts');
    assert.equal(l.list.x + l.list.w, w);
    assert.ok(l.list.w >= STRIP_LIST_MIN_W && l.list.w <= STRIP_LIST_MAX_W);
    assert.ok(!overlaps(l.rail, l.map) && !overlaps(l.map, l.list) && !overlaps(l.rail, l.list));
  }
  assert.equal(stripListWidth(2000), 340);
  assert.equal(stripListWidth(1600), 272);
  assert.equal(stripListWidth(1200), 260);
});

test('a docked drawer covers the staff list: the list goes and the map takes the room up to the drawer', () => {
  const l = stripLayout(2000, 400, 400);
  assert.equal(l.list, null);
  assert.deepEqual(l.map, { x: RAIL_W, y: 0, w: 2000 - RAIL_W - 400, h: 400 });
});

test('opening or closing a panel narrower than the staff list never moves the office', () => {
  for (const [w, h] of [[2000, 400], [2560, 600], [1600, 360]] as Size[]) {
    const open = stripLayout(w, h, 0, MAP_PX_W / MAP_PX_H);
    assert.ok(open.list);
    const docked = stripLayout(w, h, Math.min(400, open.list.w), MAP_PX_W / MAP_PX_H);
    assert.deepEqual(docked.map, open.map, `${w}x${h}`);
    const cam = defaultCamera();
    const a = computeView(open.map.w, open.map.h, MAP_PX_W, MAP_PX_H, 1, cam, 0);
    const b = computeView(docked.map.w, docked.map.h, MAP_PX_W, MAP_PX_H, 1, cam, 0);
    assert.deepEqual(b, a, 'same scale and offset');
  }
});

test('in a 2000x400 strip the whole map shows at full height between the rail and the list', () => {
  const l = stripLayout(2000, 400);
  const v = computeView(l.map.w, l.map.h, MAP_PX_W, MAP_PX_H, 1, { zoom: 1, cx: null, cy: null }, 0);
  assert.equal(v.pannable, false);
  assert.ok(Math.abs(MAP_PX_H * v.scale - 400) < 1, `map height ${MAP_PX_H * v.scale}`);
  assert.ok(v.ox >= 0 && v.ox + MAP_PX_W * v.scale <= l.map.w + 0.5, 'inside its column');
  // The narrowest strip still fits the map (no pan camera; at most the few pixels of wall the 1x snap crops).
  const n = stripLayout(STRIP_MIN_W, 500);
  assert.equal(fitsWholeMap(n.map.w, n.map.h, MAP_PX_W, MAP_PX_H, 1, { zoom: 1, cx: null, cy: null }), true);
});

test('overlaps ignores touching edges', () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 }), true);
});

test('where a worker opens: a tab in a strip or when their tab is open, else the drawer', () => {
  assert.equal(caseTarget(true, false), 'tab');
  assert.equal(caseTarget(true, true), 'tab');
  assert.equal(caseTarget(false, true), 'tab', 'a narrow view focuses an open tab instead of showing the case twice');
  assert.equal(caseTarget(false, false), 'drawer');
});

test('the x is offered for idle main workers only', () => {
  const idle = { kind: 'main', status: 'idle', activity: 'idle' };
  assert.equal(canSendHome(idle), true);
  assert.equal(canSendHome({ ...idle, status: 'done' }), true);
  assert.equal(canSendHome({ ...idle, kind: 'temp' }), false, 'temps leave with their lead');
  assert.equal(canSendHome({ ...idle, status: 'working', activity: 'writing' }), false);
  assert.equal(canSendHome({ ...idle, status: 'waiting' }), false);
  assert.equal(canSendHome({ ...idle, activity: 'needsYou' }), false);
  assert.equal(canSendHome({ ...idle, pending: { requestId: 'r', kind: 'plan' } }), false);
  assert.equal(canSendHome(null), false);
  assert.equal(canSendHome(undefined), false);
});

test('caseTabs ids are cleaned: strings, no blanks or repeats, in order, capped', () => {
  assert.deepEqual(caseTabIds(['a', 'b', 'a', '', 3, null, 'c']), ['a', 'b', 'c']);
  assert.deepEqual(caseTabIds('a'), []);
  assert.deepEqual(caseTabIds(undefined), []);
  assert.equal(caseTabIds(Array.from({ length: 30 }, (_, i) => `w${i}`)).length, CASE_TABS_MAX);
});

test('prop stops: placed over the prop in screen px, left out when mostly outside the visible map', () => {
  const view = { scale: 2, ox: 100, oy: 10 };
  const clip = { x: 44, y: 0, w: 1000, h: 400 };
  assert.deepEqual(propStopRect({ x: 10, y: 20, w: 8, h: 6 }, view, clip), { x: 120, y: 50, w: 16, h: 12 });
  assert.equal(propStopRect({ x: 600, y: 20, w: 8, h: 6 }, view, clip), null, 'off to the right');
  assert.deepEqual(propStopRect({ x: 468, y: 20, w: 8, h: 6 }, view, clip), { x: 1036, y: 50, w: 8, h: 12 }, 'half inside: clipped to the visible part');
  assert.equal(propStopRect({ x: 470, y: 20, w: 8, h: 6 }, view, clip), null, 'less than half inside');
  assert.equal(propStopRect({ x: 0, y: 0, w: 0, h: 6 }, view, clip), null);
});

test('view mode is never a strip: the whole canvas is the map\'s room, at every size', () => {
  for (const [w, h] of [[2000, 400], [1600, 360], [1000, 500], [360, 700], [1100, 700]] as Size[]) {
    assert.equal(stripFor(w, h, true), false, `view ${w}x${h}`);
    assert.equal(stripFor(w, h, false), isStrip(w, h), `manager ${w}x${h}`);
  }
  // With no rail and no list the 2000 x 400 view fits the map at full height, centred in the full width.
  const v = computeView(2000, 400, MAP_PX_W, MAP_PX_H, 1, defaultCamera(), 30 * 16);
  assert.ok(MAP_PX_H * v.scale <= 400 + 0.5);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Task 10.1: the leftover width of a very wide strip, the list below a tall office, parked prop stops

const ASPECT = MAP_PX_W / MAP_PX_H;

test('leftover width: the width a full-height map cannot use goes to the staff list, not to letterbox', () => {
  // 2000 x 400: the map is 1082.4 px wide at full height; the list takes the rest (it was 340 with 267 px of gutter each side).
  const l = stripLayout(2000, 400, 0, ASPECT);
  assert.ok(l.list);
  assert.equal(l.map.w, 1083);
  assert.equal(l.list.w, 2000 - RAIL_W - 1083);
  const v = computeView(l.map.w, l.map.h, MAP_PX_W, MAP_PX_H, 1, defaultCamera(), 0);
  assert.ok(Math.abs(MAP_PX_H * v.scale - 400) < 1, 'the map keeps its full height');
  assert.ok(l.map.w - MAP_PX_W * v.scale < 1, 'no gutter beside the map');
  // A strip with no spare width keeps the plain 17% list; no aspect (unknown) keeps it too.
  assert.equal(stripListWidthFor(1200, 500, ASPECT), stripListWidth(1200));
  assert.equal(stripListWidthFor(2000, 400), stripListWidth(2000));
  assert.equal(stripListWidthFor(2000, 400, 0), 340);
  // Very wide: capped; the rest is an even margin round the map.
  assert.equal(stripListWidthFor(4000, 400, ASPECT), STRIP_LIST_WIDE_MAX_W);
  // Never narrower than the plain list, and a docked drawer still covers it.
  for (const [w, h] of [[1000, 500], [1300, 300], [1600, 350], [2560, 600]] as Size[]) assert.ok(stripListWidthFor(w, h, ASPECT) >= stripListWidth(w), `${w}x${h}`);
  assert.equal(stripLayout(2000, 400, 400, ASPECT).list, null);
});

test('leftover width: columns and the detail line follow the room, the detail goes first when rows would not fit', () => {
  assert.deepEqual(stripListColumns(873, 400, 6), { cols: 2, detail: true, narrow: false }, '2000 x 400: two columns of 436 with detail');
  assert.deepEqual(stripListColumns(608, 350, 6), { cols: 2, detail: false, narrow: true }, '1600 x 350: two columns of 304, no branch');
  assert.deepEqual(stripListColumns(1200, 400, 6), { cols: 3, detail: true, narrow: false });
  assert.deepEqual(stripListColumns(340, 400, 6), { cols: 1, detail: false, narrow: false }, 'the plain list');
  assert.deepEqual(stripListColumns(260, 500, 6), { cols: 1, detail: false, narrow: true });
  assert.equal(stripListColumns(873, 400, 18).detail, false, 'a crowded office drops the detail line first');
  assert.equal(stripListColumns(873, 400, 0).cols, 2);
});

test('the list below a tall office shows the detail line only when every row still fits', () => {
  assert.equal(belowListDetail(1384, 300, 6), true, 'the office in a 1400 x 900 editor tab');
  assert.equal(belowListDetail(1384, 120, 6), false);
  assert.equal(belowListDetail(600, 300, 18), false);
  assert.equal(belowListDetail(1384, 300, 0), false);
});

test('a prop stop scrolled out of view parks on the nearest edge; focusing it centres the camera on the prop', () => {
  const clip = { x: 0, y: 0, w: 360, h: 800 };
  const view = { scale: 3, ox: -1200, oy: 0 };
  // The Front desk (far left of the map) is off to the left of a 360 px sidebar.
  const fd = { x: 32, y: 64, w: 40, h: 24 };
  assert.equal(propStopRect(fd, view, clip), null);
  assert.deepEqual(parkedStopRect(fd, view, clip), { x: 0, y: 192, w: 120, h: 72 });
  assert.deepEqual(parkedStopRect({ x: 700, y: 10, w: 30, h: 400 }, { scale: 3, ox: 0, oy: 0 }, clip), { x: 270, y: 0, w: 90, h: 800 }, 'clamped to the clip');
  assert.deepEqual(propFocusCentre(fd), { cx: 52, cy: 76 });
  // After the pan the stop is in view again.
  const c = propFocusCentre(fd);
  const panned = { scale: 3, ox: clip.w / 2 - c.cx * 3, oy: 0 };
  assert.ok(propStopRect(fd, panned, clip));
});

test('framingFocusX: a narrow view frames the glass office and the sulk spot; a view that already shows both is left alone', () => {
  const box = { x0: 28 * 16, x1: 43 * 16 }; // tiles 28-42
  const dflt = 30 * 16;
  // A 360x300 sidebar: scale = 300 / 272, so ~326 map px are visible; the 240 px box fits and is centred.
  const scale = 300 / MAP_PX_H;
  const f = framingFocusX(360 / scale, box, dflt);
  assert.equal(f, (box.x0 + box.x1) / 2);
  const v = computeView(360, 300, MAP_PX_W, MAP_PX_H, 1, defaultCamera(), f);
  const sulkX = v.ox + (40 * 16 + 8) * v.scale;
  const officeL = v.ox + box.x0 * v.scale;
  assert.ok(sulkX > 0 && sulkX < 360, 'the sulking boss is on screen');
  assert.ok(officeL >= 0, 'the glass office is on screen too');
  // Without the rule he is off screen.
  const v0 = computeView(360, 300, MAP_PX_W, MAP_PX_H, 1, defaultCamera(), dflt);
  assert.ok(v0.ox + (40 * 16 + 8) * v0.scale > 360);
  // A view that shows the whole box around the default focus changes nothing.
  assert.equal(framingFocusX(600, box, dflt), dflt);
  assert.equal(framingFocusX(900, { x0: 400, x1: 600 }, 480), 480);
  // Too narrow for the box: the right end (the sulking boss) stays in view.
  assert.equal(framingFocusX(200, box, dflt), box.x1 - 100);
});

test('easeToward: moves towards the target without overshooting and snaps when close', () => {
  assert.equal(easeToward(100, 100, 33, 150), 100);
  const a = easeToward(0, 100, 33, 150);
  assert.ok(a > 0 && a < 100);
  assert.ok(easeToward(a, 100, 33, 150) > a);
  assert.equal(easeToward(99.9, 100, 33, 150), 100);
  assert.equal(easeToward(0, 100, 0, 150), 0);
  let x = 0;
  for (let i = 0; i < 60; i++) x = easeToward(x, 100, 33, 150);
  assert.equal(x, 100);
});
