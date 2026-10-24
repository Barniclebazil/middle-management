import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey, placePopover } from '../webview/engine/popoverLogic.ts';

const items = [{ label: 'Default' }, { label: 'Low' }, { label: 'Med' }, { label: 'High' }, { label: 'XHigh', disabled: true }, { label: 'Max', disabled: true }];

test('arrows move with wrap-around; Home/End jump', () => {
  assert.deepEqual(menuKey('ArrowDown', 0, items), { kind: 'focus', index: 1 });
  assert.deepEqual(menuKey('ArrowDown', 5, items), { kind: 'focus', index: 0 });
  assert.deepEqual(menuKey('ArrowUp', 0, items), { kind: 'focus', index: 5 });
  assert.deepEqual(menuKey('ArrowDown', -1, items), { kind: 'focus', index: 0 });
  assert.deepEqual(menuKey('ArrowUp', -1, items), { kind: 'focus', index: 5 });
  assert.deepEqual(menuKey('Home', 3, items), { kind: 'focus', index: 0 });
  assert.deepEqual(menuKey('End', 1, items), { kind: 'focus', index: 5 });
});

test('Enter and Space select an enabled item; disabled items can be focused but not chosen', () => {
  assert.deepEqual(menuKey('Enter', 2, items), { kind: 'select', index: 2 });
  assert.deepEqual(menuKey(' ', 3, items), { kind: 'select', index: 3 });
  assert.deepEqual(menuKey('Enter', 4, items), { kind: 'none' });
  assert.deepEqual(menuKey('ArrowDown', 3, items), { kind: 'focus', index: 4 });
  assert.deepEqual(menuKey('Enter', -1, items), { kind: 'none' });
});

test('Escape and Tab close and return focus to the anchor', () => {
  assert.deepEqual(menuKey('Escape', 2, items), { kind: 'close', returnFocus: true });
  assert.deepEqual(menuKey('Tab', 2, items), { kind: 'close', returnFocus: true });
  assert.deepEqual(menuKey('Escape', -1, []), { kind: 'close', returnFocus: true });
});

test('typing a letter jumps to the next item starting with it', () => {
  assert.deepEqual(menuKey('m', 0, items), { kind: 'focus', index: 2 });
  assert.deepEqual(menuKey('M', 2, items), { kind: 'focus', index: 5 }, 'next match after the current one');
  assert.deepEqual(menuKey('m', 5, items), { kind: 'focus', index: 2 }, 'wraps');
  assert.deepEqual(menuKey('q', 0, items), { kind: 'none' });
  assert.deepEqual(menuKey('Shift', 0, items), { kind: 'none' });
  assert.deepEqual(menuKey('ArrowDown', 0, []), { kind: 'none' });
});

test('placement: below by default, flipped above near the bottom, kept inside the viewport', () => {
  const vp = { w: 400, h: 600 };
  const below = placePopover({ left: 20, top: 100, right: 120, bottom: 124 }, { w: 220, h: 200 }, vp);
  assert.deepEqual(below, { left: 20, top: 128, side: 'below', maxHeight: null });
  const above = placePopover({ left: 20, top: 500, right: 120, bottom: 524 }, { w: 220, h: 200 }, vp);
  assert.deepEqual(above, { left: 20, top: 296, side: 'above', maxHeight: null });
  const right = placePopover({ left: 330, top: 100, right: 390, bottom: 124 }, { w: 220, h: 100 }, vp);
  assert.equal(right.left, 400 - 8 - 220, 'pulled left to stay on screen');
  const left = placePopover({ left: 2, top: 100, right: 40, bottom: 124 }, { w: 100, h: 100 }, vp);
  assert.equal(left.left, 8);
});

test('placement: too tall for either side goes where there is more room, with a max height', () => {
  const p = placePopover({ left: 10, top: 200, right: 60, bottom: 224 }, { w: 200, h: 900 }, { w: 400, h: 600 });
  assert.equal(p.side, 'below');
  assert.equal(p.top, 228);
  assert.equal(p.maxHeight, 600 - 8 - 228);
  const q = placePopover({ left: 10, top: 450, right: 60, bottom: 474 }, { w: 200, h: 900 }, { w: 400, h: 600 });
  assert.equal(q.side, 'above');
  assert.equal(q.maxHeight, 450 - 4 - 8);
  assert.equal(q.top, 8);
});
