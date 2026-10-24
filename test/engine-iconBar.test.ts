import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICONBAR_COLLAPSE_BELOW, ICONBAR_EDGE, ICONBAR_ITEMS, ICONBAR_LABELS_FROM, RAIL_BTN, RAIL_GAP, RAIL_GROUP_GAP, RAIL_PAD, badgeText, fittedBarMode, hoverTarget, iconBarItems,
  iconBarMode, iconBarRoom, itemLabel, mergeBadges, railDirectoryLabel, railHeight, railItems, railOverflow, resolveRoving, rovingNext, visibleItems,
} from '../webview/engine/iconBarLogic.ts';
import { NEW_TASK, entriesKey } from '../webview/engine/directoryLogic.ts';
import { directoryEntries } from '../webview/engine/hotspots.ts';

const A = new Set<'A' | 'B'>(['A']);
const AB = new Set<'A' | 'B'>(['A', 'B']);

test('Round A: In-tray, Plans, Usage, Front desk (bell), Directory, New task, in that order', () => {
  const a = iconBarItems(A);
  assert.deepEqual(a.map((i) => i.label), ['In-tray', 'Plans', 'Usage', 'Front desk', 'Directory', 'New task']);
  assert.deepEqual(a.map((i) => i.icon), ['inTray', 'plans', 'usage', 'bell', 'directory', 'newTask']);
  assert.deepEqual(a.map((i) => i.id), ['inbox', 'plans', 'usage', 'frontdesk', 'directory', 'newTask']);
});

test('Round B adds the five tools after New task, as a compact group, with the prop each one outlines', () => {
  const ab = iconBarItems(AB);
  assert.deepEqual(ab.slice(0, 6), iconBarItems(A));
  assert.deepEqual(ab.slice(6).map((i) => i.id), ['files', 'library', 'phone', 'handbook', 'agency']);
  assert.deepEqual(ab.slice(6).map((i) => i.label), ['File room', 'Training library', 'Phone', 'Office handbook', 'Temp agency']);
  assert.deepEqual(ab.slice(6).map((i) => i.icon), ['files', 'library', 'phone', 'handbook', 'agency']);
  assert.deepEqual(ab.slice(6).map((i) => hoverTarget(i)), ['filingCabinets', 'bookshelf', 'phone', 'noticeBoard', 'tempAgency']);
  assert.ok(ab.slice(6).every((i) => i.panel && i.compact && i.round === 'B'));
  assert.deepEqual(ab.filter((i) => i.groupStart).map((i) => i.id), ['files']);
  assert.equal(ab.filter((i) => i.compact).length, 5, 'the Round A items keep their labels');
  assert.equal(ICONBAR_ITEMS.length, 11);
  assert.deepEqual(iconBarItems(new Set<'A' | 'B'>(['B'])).map((i) => i.id), ['files', 'library', 'phone', 'handbook', 'agency']);
});

test('the items match the Directory: same ids, labels and icons for the panels', () => {
  const entries = directoryEntries(AB);
  for (const i of iconBarItems(AB)) {
    if (i.id === 'directory') continue;
    const e = entries.find((d) => d.panel === i.id);
    assert.ok(e, `${i.id} is in the Directory`);
    assert.equal(e.icon, i.icon);
    assert.equal(e.prop ?? null, i.prop);
    if (i.round === 'B') assert.equal(e.label, i.label);
  }
});

test('only the memo item has no pressed state and no prop', () => {
  const memo = ICONBAR_ITEMS.find((i) => i.id === NEW_TASK)!;
  assert.equal(memo.panel, false);
  assert.equal(hoverTarget(memo), null);
  assert.equal(iconBarItems(A).filter((i) => i.panel).length, 5);
  assert.equal(iconBarItems(AB).filter((i) => i.panel).length, 10);
  assert.equal(hoverTarget(ICONBAR_ITEMS[0]!), 'inTray');
  assert.equal(hoverTarget(ICONBAR_ITEMS[3]!), 'frontDesk');
});

test('collapse rule: a single Directory button below 480 px', () => {
  assert.equal(iconBarMode(ICONBAR_COLLAPSE_BELOW - 1), 'collapsed');
  assert.equal(iconBarMode(360), 'collapsed');
  assert.equal(iconBarMode(ICONBAR_COLLAPSE_BELOW), 'icons');
  assert.equal(iconBarMode(ICONBAR_LABELS_FROM - 1), 'icons');
  assert.equal(iconBarMode(ICONBAR_LABELS_FROM), 'labelled');
  assert.deepEqual(visibleItems('collapsed', iconBarItems(AB)).map((i) => i.id), ['directory']);
  assert.equal(visibleItems('icons', iconBarItems(A)).length, 6);
  assert.equal(visibleItems('labelled', iconBarItems(A)).length, 6);
  assert.equal(visibleItems('icons', iconBarItems(AB)).length, 11);
  assert.equal(visibleItems('labelled', iconBarItems(AB)).length, 11);
});

test('roving index: arrows wrap, Home and End jump, other keys are ignored', () => {
  assert.equal(rovingNext(0, 6, 'ArrowRight'), 1);
  assert.equal(rovingNext(5, 6, 'ArrowRight'), 0);
  assert.equal(rovingNext(0, 6, 'ArrowLeft'), 5);
  assert.equal(rovingNext(3, 6, 'ArrowLeft'), 2);
  assert.equal(rovingNext(3, 6, 'Home'), 0);
  assert.equal(rovingNext(3, 6, 'End'), 5);
  assert.equal(rovingNext(3, 6, 'Enter'), null);
  assert.equal(rovingNext(3, 6, 'ArrowDown'), null);
  assert.equal(rovingNext(0, 0, 'ArrowRight'), null);
  assert.equal(rovingNext(0, 1, 'ArrowRight'), 0);
  assert.equal(rovingNext(99, 3, 'ArrowRight'), 0);
});

test('the tab stop falls back to the first visible item when its own item is hidden', () => {
  const all = visibleItems('icons', iconBarItems(A));
  assert.equal(resolveRoving('plans', all), 'plans');
  assert.equal(resolveRoving(null, all), 'inbox');
  assert.equal(resolveRoving('plans', visibleItems('collapsed', iconBarItems(A))), 'directory');
  assert.equal(resolveRoving('plans', []), null);
});

test('badge words', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-2), '');
  assert.equal(badgeText(Number.NaN), '');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(3.9), '3');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(itemLabel('In-tray', null), 'In-tray');
  assert.equal(itemLabel('In-tray', { count: 0 }), 'In-tray');
  assert.equal(itemLabel('In-tray', { count: 3 }), 'In-tray, 3 unread');
  assert.equal(itemLabel('In-tray', { count: 3, urgent: true }), 'In-tray, 3 unread, some need you');
});

test('the directory panel only redraws when its entries change', () => {
  const a = [{ panel: 'inbox', label: 'In-tray', icon: 'inTray', hint: 'x', prop: 'inTray' }, { panel: 'newTask', label: 'New task', icon: 'newTask', hint: 'y' }];
  assert.equal(entriesKey(a), entriesKey(a.map((e) => ({ ...e }))));
  assert.notEqual(entriesKey(a), entriesKey(a.slice(0, 1)));
  assert.notEqual(entriesKey(a), entriesKey([{ ...a[0]!, hint: 'changed' }, a[1]!]));
  assert.equal(entriesKey([]), '');
});

test('a collapsed bar totals the badges of the hidden items onto its Directory button', () => {
  assert.equal(mergeBadges([]), null);
  assert.equal(mergeBadges([{ count: 0 }, { count: -1 }]), null);
  assert.deepEqual(mergeBadges([{ count: 3 }, { count: 2 }]), { count: 5, urgent: false });
  assert.deepEqual(mergeBadges([{ count: 3 }, { count: 1, urgent: true }]), { count: 4, urgent: true });
  assert.deepEqual(mergeBadges([{ count: 3 }, { count: 0, urgent: true }]), { count: 3, urgent: false });
});

test('the bar steps down rather than run under the floating New task button (live check: 800 px overlapped it)', () => {
  assert.equal(ICONBAR_EDGE, 8);
  // The live check in real VSCodium fonts: at 800 px the labelled bar spans x 8-731 (723 wide) and the "+ New task" pill,
  // 77 px wide at 8 px from the right edge, starts at x 715. The icons-only bar is about 430 wide.
  const bar = 723;
  const icons = 430;
  const pill = 77 + 8;
  assert.equal(iconBarRoom(800), 784);
  assert.equal(iconBarRoom(800, pill), 699);
  assert.equal(fittedBarMode(800, bar, icons, pill), 'icons', 'the pill would sit under the labels: icons only');
  assert.equal(fittedBarMode(800, bar, icons, 0), 'labelled', 'no pill (the roster shows its own New task): the labels fit');
  // the first width that clears the pill is bar + pill + both edges
  const clear = bar + pill + 2 * ICONBAR_EDGE;
  assert.equal(fittedBarMode(clear - 1, bar, icons, pill), 'icons');
  assert.equal(fittedBarMode(clear, bar, icons, pill), 'labelled');
  // the labelled bar never shows past its own edge either (a wider font, a "99+" badge)
  assert.equal(fittedBarMode(820, 805, icons, 0), 'icons');
  assert.equal(fittedBarMode(820, 804, icons, 0), 'labelled');
  // just above the collapse width the icons alone meet the pill (480-530 px): the bar collapses to the Directory button
  assert.equal(fittedBarMode(520, 0, icons, pill), 'collapsed');
  assert.equal(fittedBarMode(icons + pill + 2 * ICONBAR_EDGE, 0, icons, pill), 'icons');
  assert.equal(fittedBarMode(520, 0, icons, 0), 'icons', 'without the pill the icons fit');
  // below the collapse width nothing changes; an unmeasured width (0) keeps the plain rule
  assert.equal(fittedBarMode(ICONBAR_COLLAPSE_BELOW - 1, 0, 0, pill), 'collapsed');
  assert.equal(fittedBarMode(ICONBAR_LABELS_FROM - 1, 0, icons, 0), 'icons');
  assert.equal(fittedBarMode(800, 0, 0, pill), iconBarMode(800));
  // the room never goes below one button
  assert.equal(iconBarRoom(100, 500), 40);
});

test('rail: Up/Down move in a vertical toolbar (Left/Right do not), Home/End still jump', () => {
  assert.equal(rovingNext(0, 11, 'ArrowDown', true), 1);
  assert.equal(rovingNext(0, 11, 'ArrowUp', true), 10);
  assert.equal(rovingNext(10, 11, 'ArrowDown', true), 0);
  assert.equal(rovingNext(3, 11, 'ArrowRight', true), null);
  assert.equal(rovingNext(3, 11, 'ArrowLeft', true), null);
  assert.equal(rovingNext(3, 11, 'End', true), 10);
  assert.equal(rovingNext(3, 11, 'ArrowDown'), null, 'the horizontal bar keeps Left/Right');
});

test('rail height: padding, buttons, gaps and one group gap for the Round B tools', () => {
  const ab = iconBarItems(AB);
  assert.equal(railHeight(ab), 2 * RAIL_PAD + 11 * RAIL_BTN + 10 * RAIL_GAP + RAIL_GROUP_GAP);
  assert.equal(railHeight(ab), 392);
  assert.equal(railHeight(iconBarItems(A)), 2 * RAIL_PAD + 6 * RAIL_BTN + 5 * RAIL_GAP, 'no group gap without Round B');
  assert.equal(railHeight([]), 2 * RAIL_PAD);
});

test('rail overflow: every item at 400 px; shorter rails drop the last tools first and always keep the Directory', () => {
  const ab = iconBarItems(AB);
  assert.equal(railItems(ab, 400).length, 11);
  const at360 = railItems(ab, 360);
  assert.deepEqual(at360.map((i) => i.id), ['inbox', 'plans', 'usage', 'frontdesk', 'directory', 'newTask', 'files', 'library', 'phone', 'handbook']);
  assert.deepEqual(railOverflow(ab, at360).map((i) => i.id), ['agency']);
  assert.equal(railDirectoryLabel(railOverflow(ab, at360)), 'Directory (more: Temp agency)');
  assert.equal(railDirectoryLabel([]), 'Directory');
  const at250 = railItems(ab, 250);
  assert.ok(railHeight(at250) <= 250);
  assert.ok(at250.some((i) => i.id === 'directory'));
  assert.deepEqual(at250.map((i) => i.id), ['inbox', 'plans', 'usage', 'frontdesk', 'directory', 'newTask']);
  // So short that the Directory would fall off: it takes the last place.
  const at150 = railItems(ab, 150);
  assert.ok(at150.some((i) => i.id === 'directory'));
  assert.ok(railHeight(at150) <= 150);
  assert.deepEqual(at150.map((i) => i.id), ['inbox', 'plans', 'usage', 'directory']);
  assert.deepEqual(railItems(ab, 10).map((i) => i.id), ['directory']);
});
