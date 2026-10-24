import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE_MIN_W, PanelStack, allowsClose, clampDrawerWidth, drawerLayout, escapeConsumed } from '../webview/engine/drawerLogic.ts';
import type { StackView } from '../webview/engine/drawerLogic.ts';
import { readFileSync } from 'node:fs';
import { DRAWER_DEFAULT_W, DRAWER_MAX_W, DRAWER_MIN_W, OVERLAY_BELOW } from '../webview/engine/drawerLogic.ts';

function view(id: string, title = id, veto?: () => boolean): StackView & { asked: number } {
  const v = { id, title, asked: 0, beforeClose: veto ? () => { v.asked++; return veto(); } : undefined };
  return v as StackView & { asked: number };
}

test('allowsClose: only an explicit false vetoes', () => {
  assert.equal(allowsClose(null), true);
  assert.equal(allowsClose(view('a')), true);
  assert.equal(allowsClose({ id: 'a', title: 'a', beforeClose: () => true }), true);
  assert.equal(allowsClose({ id: 'a', title: 'a', beforeClose: () => false }), false);
  assert.equal(allowsClose({ id: 'a', title: 'a', beforeClose: () => undefined as unknown as boolean }), true);
  assert.equal(allowsClose({ id: 'a', title: 'a', beforeClose: () => { throw new Error('boom'); } }), true);
});

test('open replaces the stack; the same id is a no-op', () => {
  const s = new PanelStack<StackView>();
  assert.equal(s.open(view('inbox')), 'opened');
  assert.equal(s.size, 1);
  assert.equal(s.open(view('inbox')), 'same');
  assert.equal(s.open(view('plans')), 'opened');
  assert.equal(s.top()?.id, 'plans');
  assert.equal(s.size, 1);
});

test('push and back: a sub-view shows the previous title', () => {
  const s = new PanelStack<StackView>();
  s.open(view('inbox', 'In-tray'));
  assert.equal(s.previous(), null);
  assert.equal(s.push(view('report', 'Report')), 'pushed');
  assert.equal(s.previous()?.title, 'In-tray');
  assert.deepEqual(s.returnTarget(), { id: 'report', title: 'Report' });
  assert.equal(s.back(), 'popped');
  assert.deepEqual(s.returnTarget(), { id: 'inbox', title: 'In-tray' });
  assert.equal(s.back(), 'closed');
  assert.equal(s.size, 0);
  assert.equal(s.returnTarget(), null);
  assert.equal(s.back(), 'empty');
  assert.equal(s.close(), 'empty');
});

test('push onto an empty stack makes the view the root', () => {
  const s = new PanelStack<StackView>();
  assert.equal(s.push(view('a')), 'opened');
  assert.equal(s.size, 1);
});

test('beforeClose vetoes close, switch and back, and nothing changes', () => {
  const s = new PanelStack<StackView>();
  const desk = view('frontdesk', 'Front desk', () => false);
  s.open(desk);
  assert.equal(s.close(), 'vetoed');
  assert.equal(s.open(view('plans')), 'vetoed');
  assert.equal(s.back(), 'vetoed');
  assert.equal(s.top()?.id, 'frontdesk');
  assert.equal(desk.asked, 3);
});

test('a veto is lifted when the view agrees (the user chose Discard)', () => {
  const s = new PanelStack<StackView>();
  let dirty = true;
  s.open(view('frontdesk', 'Front desk', () => !dirty));
  assert.equal(s.close(), 'vetoed');
  dirty = false;
  assert.equal(s.close(), 'closed');
  assert.equal(s.size, 0);
});

test('only the top view is asked; pushing a sub-view does not ask the view underneath', () => {
  const s = new PanelStack<StackView>();
  const root = view('plans', 'Plans', () => false);
  const sub = view('plan', 'Plan');
  s.open(root);
  s.push(sub);
  assert.equal(root.asked, 0);
  assert.equal(s.back(), 'popped');
  assert.equal(root.asked, 0);
  assert.equal(s.back(), 'vetoed');
  assert.equal(root.asked, 1);
});

test('skipVeto (a hidden drawer) never asks', () => {
  const s = new PanelStack<StackView>();
  const desk = view('frontdesk', 'Front desk', () => false);
  s.open(desk);
  assert.equal(s.open(view('plans'), true), 'opened');
  assert.equal(desk.asked, 0);
  const again = view('frontdesk', 'Front desk', () => false);
  s.open(again);
  assert.equal(s.close(true), 'closed');
  assert.equal(again.asked, 0);
});

test('escapeConsumed: consumed whenever the drawer was showing, even when the close was vetoed', () => {
  let closes = 0;
  assert.equal(escapeConsumed(false, () => { closes++; }), false);
  assert.equal(closes, 0);
  assert.equal(escapeConsumed(true, () => { closes++; return false; }), true);
  assert.equal(closes, 1);
});

test('drawerLayout: overlay below the case file threshold, otherwise the width kept in range', () => {
  assert.deepEqual(drawerLayout(OVERLAY_BELOW - 1, 500), { overlay: true, width: 440 });
  assert.deepEqual(drawerLayout(360, 500), { overlay: true, width: 360 });
  assert.deepEqual(drawerLayout(330, 400), { overlay: true, width: 330 });
  assert.deepEqual(drawerLayout(1100, DRAWER_DEFAULT_W), { overlay: false, width: DRAWER_DEFAULT_W });
  assert.deepEqual(drawerLayout(1100, 5000), { overlay: false, width: DRAWER_MAX_W });
  assert.deepEqual(drawerLayout(1100, 10), { overlay: false, width: DRAWER_MIN_W });
  // The office keeps its minimum width: at 700 the drawer can be at most 700 - OFFICE_MIN_W = 400.
  assert.deepEqual(drawerLayout(OVERLAY_BELOW, 600), { overlay: false, width: OVERLAY_BELOW - OFFICE_MIN_W });
});

test('clampDrawerWidth keeps saved widths in range and survives junk', () => {
  assert.equal(clampDrawerWidth(100), DRAWER_MIN_W);
  assert.equal(clampDrawerWidth(900), DRAWER_MAX_W);
  assert.equal(clampDrawerWidth(401.6), 402);
  assert.equal(clampDrawerWidth(Number.NaN), DRAWER_DEFAULT_W);
});

test('the width constants match the case file (they are copied because caseFile.ts needs a DOM)', () => {
  const src = readFileSync(new URL('../webview/engine/caseFile.ts', import.meta.url), 'utf8');
  const read = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+);`).exec(src)?.[1]);
  assert.equal(read('OVERLAY_BELOW'), OVERLAY_BELOW);
  assert.equal(read('DRAWER_MIN_W'), DRAWER_MIN_W);
  assert.equal(read('DRAWER_MAX_W'), DRAWER_MAX_W);
  assert.equal(read('DRAWER_DEFAULT_W'), DRAWER_DEFAULT_W);
});

// -- close and open ask every view (task 4.7) ----------------------------------

test('close asks every view from the top down and stops at the first veto (a sub-view without beforeClose does not hide the root)', () => {
  const s = new PanelStack<StackView>();
  const root = view('frontdesk', 'Front desk', () => false);
  const sub = view('person', 'Staff 3');
  s.open(root);
  s.push(sub);
  assert.equal(s.close(), 'vetoed');
  assert.equal(root.asked, 1, 'the root was asked even though the top view agreed');
  assert.equal(s.size, 1, 'the stack is cut back to the root, so its prompt can show');
  assert.equal(s.top()?.id, 'frontdesk');
});

test('close: the first veto from the top wins and the views under it are not asked', () => {
  const s = new PanelStack<StackView>();
  const root = view('a', 'A', () => false);
  const mid = view('b', 'B', () => false);
  const top = view('c', 'C');
  s.open(root);
  s.push(mid);
  s.push(top);
  assert.equal(s.close(), 'vetoed');
  assert.equal(mid.asked, 1);
  assert.equal(root.asked, 0);
  assert.deepEqual([s.size, s.top()?.id], [2, 'b'], 'cut back to the vetoing view, not further');
});

test('close: when every view agrees the whole stack goes; skipVeto never asks anyone', () => {
  const s = new PanelStack<StackView>();
  const root = view('plans', 'Plans', () => true);
  const sub = view('plan', 'Plan', () => true);
  s.open(root);
  s.push(sub);
  assert.equal(s.close(), 'closed');
  assert.deepEqual([root.asked, sub.asked, s.size], [1, 1, 0]);
  const hidden = view('frontdesk', 'Front desk', () => false);
  s.open(hidden);
  s.push(view('person', 'Staff 3'));
  assert.equal(s.close(true), 'closed');
  assert.equal(hidden.asked, 0);
});

test('close after the user chose Discard in the revealed root closes normally', () => {
  const s = new PanelStack<StackView>();
  let dirty = true;
  s.open(view('frontdesk', 'Front desk', () => !dirty));
  s.push(view('person', 'Staff 3'));
  assert.equal(s.close(), 'vetoed');
  assert.equal(s.size, 1);
  dirty = false;
  assert.equal(s.close(), 'closed');
});

test('back still asks only the top view, never the root under it', () => {
  const s = new PanelStack<StackView>();
  const root = view('frontdesk', 'Front desk', () => false);
  s.open(root);
  s.push(view('person', 'Staff 3'));
  assert.equal(s.back(), 'popped');
  assert.equal(root.asked, 0);
  const sub = view('person2', 'Staff 4', () => false);
  s.push(sub);
  assert.equal(s.back(), 'vetoed');
  assert.deepEqual([sub.asked, root.asked, s.size], [1, 0, 2], 'back does not cut the stack');
});

test('open (switch panel) from a sub-view asks every view too; opening the root again only asks the sub-views above it', () => {
  const s = new PanelStack<StackView>();
  const root = view('frontdesk', 'Front desk', () => false);
  s.open(root);
  s.push(view('person', 'Staff 3'));
  assert.equal(s.open(view('plans', 'Plans')), 'vetoed');
  assert.equal(root.asked, 1);
  assert.equal(s.top()?.id, 'frontdesk');
  // Back on the root with a sub-view on top: opening the root again is not a switch, so the root is not asked.
  s.push(view('person', 'Staff 3'));
  assert.equal(s.open(root), 'opened');
  assert.equal(root.asked, 1, 'the root stays, so it is not asked');
  assert.deepEqual([s.size, s.top()?.id], [1, 'frontdesk']);
  // Opening the panel that is already on top changes nothing.
  assert.equal(s.open(root), 'same');
});

test('a hidden (suspended) drawer closed from its case asks like a normal close, so unsaved edits are not dropped silently', () => {
  const s = new PanelStack<StackView>();
  let dirty = true;
  const desk = view('frontdesk', 'Front desk', () => !dirty);
  s.open(desk);
  // The drawer is suspended behind a case file. Closing the case calls close(false), not close(true).
  assert.equal(s.close(false), 'vetoed');
  assert.equal(s.top()?.id, 'frontdesk', 'the drawer keeps its view, so the caller resumes it to show the prompt');
  dirty = false;
  assert.equal(s.close(false), 'closed');
});
