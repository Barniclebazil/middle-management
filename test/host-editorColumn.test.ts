import { test } from 'node:test';
import assert from 'node:assert/strict';
import { besideOfficePanel } from '../src/host/editorColumn.ts';

const BESIDE = -2; // vscode.ViewColumn.Beside

test('besideOfficePanel: beside when the office is an editor tab, the editor default for the sidebar view', () => {
  assert.equal(besideOfficePanel(1, BESIDE), BESIDE);
  assert.equal(besideOfficePanel(3, BESIDE), BESIDE);
  assert.equal(besideOfficePanel(undefined, BESIDE), undefined);
});
