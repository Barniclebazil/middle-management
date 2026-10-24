import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROP_IDS, PROP_ROUND, buildHotspots, catalogTipLine, directoryEntries, hotspotAt, isPropId, propTooltip } from '../webview/engine/hotspots.ts';
import type { PropAnchors } from '../webview/engine/hotspots.ts';

const A = new Set(['A'] as const);
const AB = new Set(['A', 'B'] as const);

const anchors: PropAnchors = {
  frontDesk: { x: 64, y: 74, w: 48, h: 38 },
  clock: { x: 70, y: 80, w: 8, h: 8 },
  calendar: { x: 200, y: 20, w: 10, h: 12 },
  inTray: { x: 300, y: 50, w: 12, h: 6 },
  whiteboard: { x: 100, y: 10, w: 40, h: 24 },
  directoryBoard: { x: 20, y: 60, w: 16, h: 20 },
  bookshelf: { x: 400, y: 10, w: 30, h: 40 },
  phone: { x: 410, y: 60, w: 6, h: 6 },
};

test('prop ids and rounds cover all eleven props', () => {
  assert.equal(PROP_IDS.length, 11);
  for (const id of ['clock', 'calendar', 'inTray', 'whiteboard', 'directoryBoard', 'frontDesk']) assert.equal(PROP_ROUND[id as keyof typeof PROP_ROUND], 'A');
  for (const id of ['bookshelf', 'phone', 'tempAgency', 'filingCabinets', 'noticeBoard']) assert.equal(PROP_ROUND[id as keyof typeof PROP_ROUND], 'B');
  assert.ok(isPropId('clock'));
  assert.ok(!isPropId('toaster'));
  assert.ok(!isPropId(3));
});

test('Round B props are not clickable while B is off', () => {
  const a = buildHotspots(anchors, A);
  assert.deepEqual(a.map((h) => h.id), ['clock', 'calendar', 'inTray', 'whiteboard', 'directoryBoard', 'frontDesk']);
  assert.equal(hotspotAt(420, 30, a, null), null, 'bookshelf is decoration in Round A');
  assert.equal(hotspotAt(412, 62, a, null), null);
  const ab = buildHotspots(anchors, AB);
  assert.deepEqual(hotspotAt(420, 30, ab, null), { kind: 'prop', id: 'bookshelf' });
  assert.deepEqual(hotspotAt(412, 62, ab, null), { kind: 'prop', id: 'phone' });
  assert.equal(buildHotspots(anchors, new Set()).length, 0);
});

test('props without a usable anchor are left out', () => {
  const h = buildHotspots({ clock: { x: 0, y: 0, w: 0, h: 5 }, calendar: { x: NaN, y: 0, w: 5, h: 5 }, inTray: { x: 1, y: 1, w: 4, h: 4 } }, A);
  assert.deepEqual(h.map((x) => x.id), ['inTray']);
});

test('characters always win over props', () => {
  const hs = buildHotspots(anchors, A);
  assert.deepEqual(hotspotAt(80, 90, hs, 'worker-1'), { kind: 'char', id: 'worker-1' });
  assert.deepEqual(hotspotAt(0, 0, hs, 'worker-1'), { kind: 'char', id: 'worker-1' }, 'even where there is no prop');
});

test('the smallest rect wins among overlapping props', () => {
  const hs = buildHotspots(anchors, A);
  // The clock hangs inside the front desk rect.
  assert.deepEqual(hotspotAt(72, 82, hs, null), { kind: 'prop', id: 'clock' });
  assert.deepEqual(hotspotAt(66, 76, hs, null), { kind: 'prop', id: 'frontDesk' });
  // Order of the list does not matter.
  assert.deepEqual(hotspotAt(72, 82, [...hs].reverse(), null), { kind: 'prop', id: 'clock' });
});

test('equal areas go to the prop listed first; edges are left/top inclusive, right/bottom exclusive', () => {
  const hs = buildHotspots({ clock: { x: 0, y: 0, w: 10, h: 10 }, calendar: { x: 5, y: 5, w: 10, h: 10 } }, A);
  assert.deepEqual(hotspotAt(7, 7, hs, null), { kind: 'prop', id: 'clock' });
  assert.deepEqual(hotspotAt(0, 0, hs, null), { kind: 'prop', id: 'clock' });
  assert.equal(hotspotAt(10, 0, hs, null), null);
  assert.equal(hotspotAt(0, 10, hs, null), null);
  assert.deepEqual(hotspotAt(14.9, 14.9, hs, null), { kind: 'prop', id: 'calendar' });
  assert.equal(hotspotAt(15, 15, hs, null), null);
});

test('front desk tooltip and the other prop tooltips', () => {
  const fd = propTooltip('frontDesk');
  assert.equal(fd.title, 'Front desk');
  assert.ok(fd.lines.includes('Theme, names, colours and settings'));
  assert.equal(fd.hint, 'Click to open the Front desk');
  for (const id of PROP_IDS) {
    const t = propTooltip(id);
    assert.ok(t.title.length > 0);
    // Round B props say what a click does too, in the same voice (and name the panel the Directory row names).
    assert.match(t.hint ?? '', /^Click to open /, id);
    assert.ok(t.lines.length > 0, id);
  }
  const hintOf = (id: Parameters<typeof propTooltip>[0]): string | undefined => propTooltip(id).hint;
  assert.equal(hintOf('bookshelf'), 'Click to open the Training library');
  assert.equal(hintOf('phone'), 'Click to open the Phone');
  assert.equal(hintOf('tempAgency'), 'Click to open the Temp agency');
  assert.equal(hintOf('filingCabinets'), 'Click to open the File room');
  assert.equal(hintOf('noticeBoard'), 'Click to open the Office handbook');
  propTooltip('clock').lines.push('x');
  assert.equal(propTooltip('clock').lines.length, 1, 'tooltips are fresh copies');
});

test('directory entries: Round A order, Front desk included, Round B only when enabled', () => {
  const a = directoryEntries(A);
  assert.deepEqual(a.map((e) => e.label), ['In-tray', 'Plans', 'Usage', 'Front desk', 'New task']);
  assert.deepEqual(a.map((e) => e.panel), ['inbox', 'plans', 'usage', 'frontdesk', 'newTask']);
  assert.deepEqual(a.map((e) => e.icon), ['inTray', 'plans', 'usage', 'bell', 'newTask']);
  assert.equal(a.find((e) => e.panel === 'frontdesk')!.prop, 'frontDesk');
  assert.equal(a.find((e) => e.panel === 'newTask')!.prop, undefined);
  for (const e of a) assert.ok(e.hint.length > 0);
  const ab = directoryEntries(AB);
  assert.deepEqual(ab.slice(0, 5), a);
  assert.deepEqual(ab.slice(5).map((e) => e.icon), ['files', 'library', 'phone', 'handbook', 'agency']);
  for (const e of ab) if (e.prop) assert.ok(isPropId(e.prop));
  assert.ok(ab.slice(5).every((e) => PROP_ROUND[e.prop!] === 'B'));
});

test('catalogTipLine: the phone and the bookshelf say what their lights and books mean once a panel has the data', () => {
  assert.equal(catalogTipLine('phone', {}), null, 'no reply yet: the static tooltip only');
  assert.equal(catalogTipLine('bookshelf', {}), null);
  assert.equal(catalogTipLine('phone', { lights: [] }), 'No lines set up');
  assert.equal(catalogTipLine('phone', { lights: ['connected'] }), '1 line');
  assert.equal(catalogTipLine('phone', { lights: ['failed', 'needsAuth', 'pending', 'connected', 'disabled'] }), '5 lines · 1 failed · 1 needs sign-in · 1 connecting');
  assert.equal(catalogTipLine('bookshelf', { shelf: 0 }), 'Empty shelves: no skills or commands yet');
  assert.equal(catalogTipLine('bookshelf', { shelf: 1 }), '1 skill or command, one book each');
  assert.equal(catalogTipLine('bookshelf', { shelf: 12 }), '12 skills and commands, one book each');
  assert.equal(catalogTipLine('bookshelf', { shelf: Number.NaN }), null);
  // other props never get a line, whatever is known
  assert.equal(catalogTipLine('clock', { lights: ['failed'], shelf: 3 }), null);
});
