import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OFFICE_MODE, OFFICE_MODES, VIEW_MODE_ALLOWED, parseOfficeMode } from '../src/shared/officeMode.ts';

test('the modes are manager and view, and manager is the default', () => {
  assert.deepEqual([...OFFICE_MODES], ['manager', 'view']);
  assert.equal(DEFAULT_OFFICE_MODE, 'manager');
});

test('parseOfficeMode accepts exactly view and manager', () => {
  assert.equal(parseOfficeMode('view'), 'view');
  assert.equal(parseOfficeMode('manager'), 'manager');
});

test('parseOfficeMode falls back to manager for anything else, without throwing', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const raw of [undefined, null, '', 'View', 'VIEW', ' view', 'view ', 'demo', 0, 1, true, false, {}, [], ['view'], { toString: () => 'view' }, circular, Symbol('view'), 10n]) {
    assert.equal(parseOfficeMode(raw), 'manager');
  }
});

test('view mode answers only ready, refreshUsage and closeCase (which only releases state)', () => {
  assert.deepEqual([...VIEW_MODE_ALLOWED].sort(), ['closeCase', 'ready', 'refreshUsage', 'updateAction']);
  assert.equal(VIEW_MODE_ALLOWED.has('openCaseTab'), false);
  assert.equal(VIEW_MODE_ALLOWED.has('sendHome'), false);
});
