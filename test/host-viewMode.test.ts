import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_MODE_NEW_TASK_MESSAGE, modeChangedMessage, modeWriteTarget, officeRunCount, stillRunningMessage, toggled } from '../src/host/viewMode.ts';

test('toggled flips the mode', () => {
  assert.equal(toggled('manager'), 'view');
  assert.equal(toggled('view'), 'manager');
});

test('modeWriteTarget picks the narrowest scope that has a value', () => {
  assert.equal(modeWriteTarget(undefined), 'global');
  assert.equal(modeWriteTarget({}), 'global');
  assert.equal(modeWriteTarget({ globalValue: 'view', defaultValue: 'manager' } as object), 'global');
  assert.equal(modeWriteTarget({ workspaceValue: 'view' }), 'workspace');
  assert.equal(modeWriteTarget({ workspaceFolderValue: 'view' }), 'workspaceFolder');
  assert.equal(modeWriteTarget({ workspaceFolderValue: 'manager', workspaceValue: 'view' }), 'workspaceFolder');
  assert.equal(modeWriteTarget({ workspaceFolderValue: undefined, workspaceValue: 'manager' }), 'workspace');
});

test('officeRunCount counts only workers started from the office', () => {
  assert.equal(officeRunCount([]), 0);
  assert.equal(officeRunCount([{}, { control: 'free' }, { control: 'elsewhere' }, { control: 'none' }]), 0);
  assert.equal(officeRunCount([{ control: 'office' }, { control: 'free' }, { control: 'office' }, {}]), 2);
});

test('stillRunningMessage gets the singular and plural right', () => {
  assert.equal(stillRunningMessage(1), '1 task you started from the office is still running. Switch back to manager mode to answer it.');
  assert.equal(stillRunningMessage(2), '2 tasks you started from the office are still running. Switch back to manager mode to answer them.');
  assert.equal(stillRunningMessage(12), '12 tasks you started from the office are still running. Switch back to manager mode to answer them.');
});

test('the fixed messages', () => {
  assert.equal(modeChangedMessage('view'), 'Middle Management is now in view mode.');
  assert.equal(modeChangedMessage('manager'), 'Middle Management is now in manager mode.');
  assert.equal(VIEW_MODE_NEW_TASK_MESSAGE, 'Middle Management is in view mode.');
});
