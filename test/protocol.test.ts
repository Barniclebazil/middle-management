import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITIES, LIMITS, THEME_ACTIONS } from '../src/shared/protocol.ts';
import type { Activity } from '../src/shared/protocol.ts';

test('ACTIVITIES lists all 13 activities', () => {
  const first: Activity = ACTIVITIES[0]!;
  assert.equal(first, 'reading');
  assert.equal(ACTIVITIES.length, 13);
  assert.equal(new Set(ACTIVITIES).size, 13);
});

test('THEME_ACTIONS lists the make-your-own actions once each', () => {
  assert.equal(new Set(THEME_ACTIONS).size, THEME_ACTIONS.length);
  for (const a of ['useUserTheme', 'openThemesFolder', 'installSkill', 'removeSkill', 'copyPrompt'] as const) assert.ok(THEME_ACTIONS.includes(a), a);
  assert.equal(LIMITS.userThemes, 50);
  assert.equal(LIMITS.themeIdChars, 120);
});
