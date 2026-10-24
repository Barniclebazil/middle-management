import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebviewMessage as p } from '../src/shared/validate.ts';
import { EFFORT_LEVELS, FRONT_DESK_SETTINGS, LIMITS, THEME_ACTIONS } from '../src/shared/protocol.ts';

const SID = '123e4567-e89b-12d3-a456-426614174000';
const task = { type: 'newTask', nonce: 'n1', projectPath: '/home/u/proj', prompt: 'Do it', assignTo: { kind: 'new' }, permissionMode: 'default' };

test('simple messages', () => {
  for (const t of ['ready', 'closeCase', 'listProjects', 'browseProject', 'refreshUsage']) assert.deepEqual(p({ type: t, junk: 1 }), { type: t });
  assert.deepEqual(p({ type: 'openCase', agentId: 'a:1' }), { type: 'openCase', agentId: 'a:1' });
  assert.equal(p({ type: 'openCase' }), undefined);
  assert.equal(p({ type: 'openCase', agentId: '' }), undefined);
  assert.equal(p({ type: 'openCase', agentId: 'x'.repeat(LIMITS.idChars + 1) }), undefined);
  assert.equal(p({ type: 'openCase', agentId: 5 }), undefined);
});

test('rejects non-objects and unknown types', () => {
  for (const v of [undefined, null, 'ready', 5, [], [{ type: 'ready' }], {}, { type: 5 }, { type: 'nope' }, { type: '__proto__' }]) assert.equal(p(v), undefined);
});

test('newTask valid', () => {
  assert.deepEqual(p(task), task);
  const full = { ...task, assignTo: { kind: 'existing', sessionId: SID }, permissionMode: 'plan', model: 'opus', extra: 1 };
  const { extra: _e, ...expected } = full;
  assert.deepEqual(p(full), expected);
  assert.equal((p({ ...task, model: 'claude-haiku-5-5' }) as { model: string }).model, 'claude-haiku-5-5');
});

test('newTask invalid', () => {
  assert.equal(p({ ...task, nonce: '' }), undefined);
  assert.equal(p({ ...task, projectPath: '' }), undefined);
  assert.equal(p({ ...task, projectPath: 'a\0b' }), undefined);
  assert.equal(p({ ...task, projectPath: 'x'.repeat(LIMITS.pathChars + 1) }), undefined);
  assert.equal(p({ ...task, prompt: '   ' }), undefined);
  assert.equal(p({ ...task, prompt: 'x'.repeat(LIMITS.promptChars + 1) }), undefined);
  assert.ok(p({ ...task, prompt: 'x'.repeat(LIMITS.promptChars) }));
  assert.equal(p({ ...task, permissionMode: 'bypassPermissions' }), undefined);
  assert.equal(p({ ...task, permissionMode: undefined }), undefined);
  assert.equal(p({ ...task, assignTo: { kind: 'existing' } }), undefined);
  assert.equal(p({ ...task, assignTo: { kind: 'existing', sessionId: '../x' } }), undefined);
  assert.equal(p({ ...task, assignTo: { kind: 'other' } }), undefined);
  assert.equal(p({ ...task, assignTo: 'new' }), undefined);
  assert.equal(p({ ...task, model: '' }), undefined);
  assert.equal(p({ ...task, model: 'a b; rm' }), undefined);
  assert.equal(p({ ...task, model: 7 }), undefined);
  assert.equal(p({ ...task, model: 'm'.repeat(LIMITS.modelChars + 1) }), undefined);
});

test('reply, interrupt, openInClaudeCode', () => {
  assert.deepEqual(p({ type: 'reply', sessionId: SID, text: 'hi' }), { type: 'reply', sessionId: SID, text: 'hi' });
  assert.equal(p({ type: 'reply', sessionId: SID, text: ' ' }), undefined);
  assert.equal(p({ type: 'reply', sessionId: SID, text: 'x'.repeat(LIMITS.promptChars + 1) }), undefined);
  assert.equal(p({ type: 'reply', sessionId: 'bad id', text: 'hi' }), undefined);
  assert.equal(p({ type: 'reply', text: 'hi' }), undefined);
  for (const t of ['interrupt', 'openInClaudeCode']) {
    assert.deepEqual(p({ type: t, sessionId: SID }), { type: t, sessionId: SID });
    assert.equal(p({ type: t }), undefined);
    assert.equal(p({ type: t, sessionId: 'a/b' }), undefined);
    assert.equal(p({ type: t, sessionId: 'x'.repeat(129) }), undefined);
  }
});

test('decide allow/deny/plan', () => {
  const d = (decision: unknown) => p({ type: 'decide', requestId: 'r1', decision });
  assert.deepEqual(d({ kind: 'allow' }), { type: 'decide', requestId: 'r1', decision: { kind: 'allow' } });
  assert.deepEqual(d({ kind: 'allow', always: true }), { type: 'decide', requestId: 'r1', decision: { kind: 'allow', always: true } });
  assert.equal(d({ kind: 'allow', always: 'yes' }), undefined);
  assert.deepEqual(d({ kind: 'deny' }), { type: 'decide', requestId: 'r1', decision: { kind: 'deny' } });
  assert.deepEqual(d({ kind: 'deny', message: 'no' }), { type: 'decide', requestId: 'r1', decision: { kind: 'deny', message: 'no' } });
  assert.equal(d({ kind: 'deny', message: 5 }), undefined);
  assert.equal(d({ kind: 'deny', message: 'x'.repeat(LIMITS.feedbackChars + 1) }), undefined);
  assert.deepEqual(d({ kind: 'plan', approve: true }), { type: 'decide', requestId: 'r1', decision: { kind: 'plan', approve: true } });
  assert.deepEqual(d({ kind: 'plan', approve: false, feedback: 'more tests' }), { type: 'decide', requestId: 'r1', decision: { kind: 'plan', approve: false, feedback: 'more tests' } });
  assert.equal(d({ kind: 'plan' }), undefined);
  assert.equal(d({ kind: 'plan', approve: 'true' }), undefined);
  assert.equal(d({ kind: 'plan', approve: false, feedback: 1 }), undefined);
  assert.equal(d({ kind: 'bogus' }), undefined);
  assert.equal(d(undefined), undefined);
  assert.equal(d('allow'), undefined);
  assert.equal(p({ type: 'decide', decision: { kind: 'allow' } }), undefined);
  assert.equal(p({ type: 'decide', requestId: '', decision: { kind: 'allow' } }), undefined);
});

test('decide answer', () => {
  const d = (decision: unknown) => p({ type: 'decide', requestId: 'r1', decision });
  const ok = d({ kind: 'answer', answers: { 'Which colour?': 'Green', 'Pick many': ['a', 'b'] }, other: { 'Which colour?': 'Teal' } });
  assert.deepEqual(ok, { type: 'decide', requestId: 'r1', decision: { kind: 'answer', answers: { 'Which colour?': 'Green', 'Pick many': ['a', 'b'] }, other: { 'Which colour?': 'Teal' } } });
  assert.ok(d({ kind: 'answer', answers: { q: 'a' } }));
  assert.equal(d({ kind: 'answer' }), undefined);
  assert.equal(d({ kind: 'answer', answers: {} }), undefined);
  assert.equal(d({ kind: 'answer', answers: [] }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: 5 } }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: [1] } }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: ['x'.repeat(LIMITS.labelChars + 1)] } }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: Array(LIMITS.multiAnswers + 1).fill('a') } }), undefined);
  assert.equal(d({ kind: 'answer', answers: { ['x'.repeat(LIMITS.questionChars + 1)]: 'a' } }), undefined);
  assert.equal(d({ kind: 'answer', answers: JSON.parse('{"__proto__": "a"}') }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: 'a' }, other: 'x' }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: 'a' }, other: { q: 3 } }), undefined);
  assert.equal(d({ kind: 'answer', answers: { q: 'a' }, other: { q: 'x'.repeat(LIMITS.feedbackChars + 1) } }), undefined);
  const many = Object.fromEntries(Array.from({ length: LIMITS.questions + 1 }, (_, i) => [`q${i}`, 'a']));
  assert.equal(d({ kind: 'answer', answers: many }), undefined);
});

test('newTask effort', () => {
  for (const effort of EFFORT_LEVELS) assert.equal((p({ ...task, effort }) as { effort: string }).effort, effort);
  assert.equal('effort' in (p(task) as object), false);
  for (const bad of ['', 'LOW', 'ultra', 'none', ' high', 'high ', 7, null, true, {}, ['low']]) assert.equal(p({ ...task, effort: bad }), undefined, String(bad));
  assert.deepEqual(p({ ...task, model: 'opus[1m]', effort: 'xhigh' }), { ...task, model: 'opus[1m]', effort: 'xhigh' });
});

const opts = (options: unknown, extra: object = {}) => ({ type: 'setSessionOptions', nonce: 'n1', sessionId: SID, options, ...extra });

test('setSessionOptions valid', () => {
  assert.deepEqual(p(opts({ model: 'sonnet' })), { type: 'setSessionOptions', nonce: 'n1', sessionId: SID, options: { model: 'sonnet' } });
  assert.deepEqual((p(opts({ effort: 'max' })) as { options: object }).options, { effort: 'max' });
  assert.deepEqual((p(opts({ permissionMode: 'acceptEdits' })) as { options: object }).options, { permissionMode: 'acceptEdits' });
  for (const m of ['default', 'acceptEdits', 'plan']) assert.ok(p(opts({ permissionMode: m })));
  for (const effort of EFFORT_LEVELS) assert.deepEqual((p(opts({ effort })) as { options: object }).options, { effort });
  // all three at once; the result is a fresh object and extra top-level keys are dropped
  const all = { model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' };
  assert.deepEqual(p(opts(all, { junk: 1 })), { type: 'setSessionOptions', nonce: 'n1', sessionId: SID, options: all });
});

test('setSessionOptions null resets model and effort', () => {
  assert.deepEqual((p(opts({ model: null })) as { options: object }).options, { model: null });
  assert.deepEqual((p(opts({ effort: null })) as { options: object }).options, { effort: null });
  assert.deepEqual((p(opts({ model: null, effort: null, permissionMode: 'default' })) as { options: object }).options, { model: null, effort: null, permissionMode: 'default' });
  // permissionMode has no null
  assert.equal(p(opts({ permissionMode: null })), undefined);
  // undefined counts as absent, so only-undefined is empty
  assert.deepEqual((p(opts({ model: undefined, effort: 'low' })) as { options: object }).options, { effort: 'low' });
});

test('setSessionOptions rejects empty options', () => {
  for (const o of [{}, { model: undefined }, { model: undefined, effort: undefined, permissionMode: undefined }]) assert.equal(p(opts(o)), undefined);
  for (const o of [undefined, null, 'model', 5, [], [{ model: 'opus' }]]) assert.equal(p(opts(o)), undefined);
  assert.equal(p({ type: 'setSessionOptions', nonce: 'n1', sessionId: SID }), undefined);
});

test('setSessionOptions rejects bypassPermissions and unknown keys', () => {
  assert.equal(p(opts({ permissionMode: 'bypassPermissions' })), undefined);
  assert.equal(p(opts({ permissionMode: 'dontAsk' })), undefined);
  assert.equal(p(opts({ model: 'opus', permissionMode: 'bypassPermissions' })), undefined);
  assert.equal(p(opts({ model: 'opus', bypassPermissions: true })), undefined);
  assert.equal(p(opts({ effort: 'low', allowDangerouslySkipPermissions: true })), undefined);
  assert.equal(p(opts({ model: 'opus', extra: 1 })), undefined);
  assert.equal(p(opts({ model: 'opus', cwd: '/etc' })), undefined);
  assert.equal(p(opts({ model: 'opus', ['__proto__']: 1 })), undefined);
  assert.equal(p(opts(JSON.parse('{"model":"opus","__proto__":{"x":1}}'))), undefined);
});

test('setSessionOptions rejects bad values', () => {
  for (const effort of ['', 'LOW', 'ultra', 7, true, {}]) assert.equal(p(opts({ effort })), undefined, String(effort));
  for (const model of ['', 'a b', 'a;b', 'opus\n', 'a/b', 7, true, {}, 'm'.repeat(LIMITS.modelChars + 1)]) assert.equal(p(opts({ model })), undefined, String(model));
  assert.ok(p(opts({ model: 'm'.repeat(LIMITS.modelChars) })));
  assert.equal(p(opts({ permissionMode: 'nope' })), undefined);
  // a valid option next to an invalid one rejects the whole message
  assert.equal(p(opts({ model: 'opus', effort: 'ultra' })), undefined);
});

test('setSessionOptions rejects bad nonce and sessionId', () => {
  assert.equal(p(opts({ model: 'opus' }, { nonce: '' })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { nonce: undefined })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { nonce: 'x'.repeat(LIMITS.idChars + 1) })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { nonce: 'a\nb' })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { sessionId: '../x' })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { sessionId: '' })), undefined);
  assert.equal(p(opts({ model: 'opus' }, { sessionId: 'x'.repeat(129) })), undefined);
});

test('getPlan', () => {
  const msg = { type: 'getPlan', reqId: 'r1', agentId: 'a:1', planId: 'toolu_01AbC-xyz_9' };
  assert.deepEqual(p({ ...msg, junk: 1 }), msg);
  assert.ok(p({ ...msg, planId: 'a.b:c-d_e' }));
  assert.ok(p({ ...msg, planId: 'x'.repeat(128) }));
  for (const planId of ['', 'x'.repeat(129), 'a b', 'a/b', '../x', 'a\0b', 'a\nb', 'toolu;rm', 5, null, undefined, {}]) assert.equal(p({ ...msg, planId }), undefined, String(planId));
  for (const reqId of ['', undefined, 5, 'x'.repeat(LIMITS.idChars + 1), 'a\nb']) assert.equal(p({ ...msg, reqId }), undefined, String(reqId));
  for (const agentId of ['', undefined, 5, 'x'.repeat(LIMITS.idChars + 1), 'a\u0007b']) assert.equal(p({ ...msg, agentId }), undefined, String(agentId));
});

test('getTurn', () => {
  const msg = { type: 'getTurn', reqId: 'r2', agentId: 'agent-1' };
  assert.deepEqual(p({ ...msg, planId: 'x' }), msg);
  for (const reqId of ['', undefined, 5, 'x'.repeat(LIMITS.idChars + 1)]) assert.equal(p({ ...msg, reqId }), undefined, String(reqId));
  for (const agentId of ['', undefined, 5, 'x'.repeat(LIMITS.idChars + 1)]) assert.equal(p({ ...msg, agentId }), undefined, String(agentId));
});

test('refreshUsage carries nothing', () => {
  assert.deepEqual(p({ type: 'refreshUsage', force: true, probe: 'now' }), { type: 'refreshUsage' });
});

test('Round A limits', () => {
  assert.deepEqual([LIMITS.reportChars, LIMITS.plansPerAgent, LIMITS.planTitleChars, LIMITS.turnItems, LIMITS.usageWindows, LIMITS.models], [1000, 5, 120, 80, 8, 20]);
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

// --- Front desk (task 1.4) ---------------------------------------------------------------------------------------------

const REV = '0123456789abcdef';

test('Front desk limits and keys', () => {
  assert.deepEqual([LIMITS.themeJsonChars, LIMITS.settingChars, LIMITS.themeErrors, LIMITS.themeErrorChars, LIMITS.presets], [524288, 100, 50, 300, 10]);
  assert.deepEqual([...FRONT_DESK_SETTINGS], ['mode', 'companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks']);
  assert.ok(!(FRONT_DESK_SETTINGS as readonly string[]).includes('claudePath'));
  assert.ok(!(FRONT_DESK_SETTINGS as readonly string[]).includes('themeFile'));
});

test('updateAction: only the listed actions, extra fields dropped', () => {
  for (const action of ['check', 'install', 'later', 'skip', 'reload', 'notes']) assert.deepEqual(p({ type: 'updateAction', action }), { type: 'updateAction', action });
  assert.deepEqual(p({ type: 'updateAction', action: 'check', junk: 1 }), { type: 'updateAction', action: 'check' });
  for (const action of ['', 'Check', 'download', 'toString', undefined, null, 5, true, ['check']]) assert.equal(p({ type: 'updateAction', action }), undefined, String(action));
  assert.equal(p({ type: 'updateAction' }), undefined);
});

test('getFrontDesk', () => {
  assert.deepEqual(p({ type: 'getFrontDesk', reqId: 'r1', junk: 1 }), { type: 'getFrontDesk', reqId: 'r1' });
  for (const reqId of ['', undefined, 5, null, 'x'.repeat(LIMITS.idChars + 1), 'a\nb']) assert.equal(p({ type: 'getFrontDesk', reqId }), undefined, String(reqId));
});

test('themeAction: actions without a presetId or themeId', () => {
  for (const action of THEME_ACTIONS.filter((a) => a !== 'usePreset' && a !== 'copyPreset' && a !== 'useUserTheme')) {
    assert.deepEqual(p({ type: 'themeAction', reqId: 'r', action, junk: 1 }), { type: 'themeAction', reqId: 'r', action }, action);
    assert.equal(p({ type: 'themeAction', reqId: 'r', action, presetId: 'example' }), undefined, `${action} forbids presetId`);
    assert.equal(p({ type: 'themeAction', reqId: 'r', action, presetId: '' }), undefined, `${action} forbids empty presetId`);
    assert.equal(p({ type: 'themeAction', reqId: 'r', action, presetId: null }), undefined, `${action} forbids null presetId`);
    for (const themeId of ['pirate-ship.theme.json', '', null, 5]) {
      assert.equal(p({ type: 'themeAction', reqId: 'r', action, themeId }), undefined, `${action} forbids themeId ${String(themeId)}`);
    }
  }
});

test('themeAction: useUserTheme needs a valid themeId', () => {
  const action = 'useUserTheme';
  assert.deepEqual(p({ type: 'themeAction', reqId: 'r', action, themeId: 'pirate-ship.theme.json' }), { type: 'themeAction', reqId: 'r', action, themeId: 'pirate-ship.theme.json' });
  assert.ok(p({ type: 'themeAction', reqId: 'r', action, themeId: 'My Office (2).theme.json' }));
  assert.ok(p({ type: 'themeAction', reqId: 'r', action, themeId: 'x'.repeat(LIMITS.themeIdChars - '.theme.json'.length) + '.theme.json' }));
  const tooLong = 'x'.repeat(LIMITS.themeIdChars - '.theme.json'.length + 1) + '.theme.json';
  const bad = [undefined, null, '', 5, {}, tooLong, 'a/b.theme.json', '../a.theme.json', 'a\\b.theme.json', '/etc/x.theme.json', 'a..b.theme.json', '.hidden.theme.json', 'pirate-ship.json', 'pirate-ship.theme.json.bak', 'a\nb.theme.json', 'a\0b.theme.json', 'a\tb.theme.json'];
  for (const themeId of bad) assert.equal(p({ type: 'themeAction', reqId: 'r', action, themeId }), undefined, String(themeId));
  assert.equal(p({ type: 'themeAction', reqId: 'r', action, themeId: 'pirate-ship.theme.json', presetId: 'example' }), undefined, 'no presetId beside a themeId');
});

test('themeAction: presetId actions forbid a themeId', () => {
  for (const action of ['usePreset', 'copyPreset']) {
    assert.equal(p({ type: 'themeAction', reqId: 'r', action, presetId: 'example', themeId: 'pirate-ship.theme.json' }), undefined, action);
  }
});

test('themeAction: usePreset and copyPreset need a valid presetId', () => {
  for (const action of ['usePreset', 'copyPreset']) {
    assert.deepEqual(p({ type: 'themeAction', reqId: 'r', action, presetId: 'example' }), { type: 'themeAction', reqId: 'r', action, presetId: 'example' });
    assert.ok(p({ type: 'themeAction', reqId: 'r', action, presetId: 'a-b-9' }));
    assert.ok(p({ type: 'themeAction', reqId: 'r', action, presetId: 'x'.repeat(40) }));
    for (const presetId of [undefined, null, '', 'x'.repeat(41), 'Example', 'a_b', 'a b', 'a/b', '../x', 'a.b', 'preset:example', 'a\nb', 'a\0b', 5, {}]) {
      assert.equal(p({ type: 'themeAction', reqId: 'r', action, presetId }), undefined, `${action} ${String(presetId)}`);
    }
  }
});

test('themeAction: bad action or reqId', () => {
  for (const action of ['', 'delete', 'write', 'CREATE', undefined, 5, null]) assert.equal(p({ type: 'themeAction', reqId: 'r', action }), undefined, String(action));
  assert.equal(p({ type: 'themeAction', action: 'open' }), undefined);
  assert.equal(p({ type: 'themeAction', reqId: '', action: 'open' }), undefined);
});

test('setSetting: text keys', () => {
  for (const key of ['companyName', 'branchName', 'managerName']) {
    assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key, value: 'Pennywhistle Paper' }), { type: 'setSetting', reqId: 'r', key, value: 'Pennywhistle Paper' });
    assert.equal((p({ type: 'setSetting', reqId: 'r', key, value: '  padded \u00a0 ' }) as { value: string }).value, 'padded');
    assert.equal((p({ type: 'setSetting', reqId: 'r', key, value: '' }) as { value: string }).value, '');
    assert.equal((p({ type: 'setSetting', reqId: 'r', key, value: '   ' }) as { value: string }).value, '');
    assert.ok(p({ type: 'setSetting', reqId: 'r', key, value: 'x'.repeat(LIMITS.settingChars) }));
    assert.equal(p({ type: 'setSetting', reqId: 'r', key, value: 'x'.repeat(LIMITS.settingChars + 1) }), undefined);
    // The cap applies after trimming.
    assert.ok(p({ type: 'setSetting', reqId: 'r', key, value: ' ' + 'x'.repeat(LIMITS.settingChars) + ' ' }));
    for (const value of ['a\nb', 'a\tb', 'a\rb', 'a\0b', 'a\u0007b', 'a\u007fb', 'a\u0085b', 'a\u2028b']) assert.equal(p({ type: 'setSetting', reqId: 'r', key, value }), undefined, JSON.stringify(value));
    for (const value of [true, false, 5, {}, [], undefined]) assert.equal(p({ type: 'setSetting', reqId: 'r', key, value }), undefined, String(value));
  }
});

test('setSetting: boolean keys', () => {
  for (const key of ['speechBubbles', 'bossQuotes']) {
    assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key, value: true }), { type: 'setSetting', reqId: 'r', key, value: true });
    assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key, value: false }), { type: 'setSetting', reqId: 'r', key, value: false });
    for (const value of ['true', 'false', '', 'yes', 0, 1, {}, [], undefined]) assert.equal(p({ type: 'setSetting', reqId: 'r', key, value }), undefined, String(value));
  }
});

test('setSetting: enum keys', () => {
  for (const v of ['all', 'workspace']) assert.equal((p({ type: 'setSetting', reqId: 'r', key: 'scope', value: v }) as { value: string }).value, v);
  for (const v of ['auto', 'off']) assert.equal((p({ type: 'setSetting', reqId: 'r', key: 'usageChecks', value: v }) as { value: string }).value, v);
  for (const v of ['manager', 'view']) assert.equal((p({ type: 'setSetting', reqId: 'r', key: 'mode', value: v }) as { value: string }).value, v);
  assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key: 'mode', value: null }), { type: 'setSetting', reqId: 'r', key: 'mode', value: null });
  for (const value of ['', 'View', 'MANAGER', 'watch', 'auto', 'all', ' view', true, false, 5, {}]) assert.equal(p({ type: 'setSetting', reqId: 'r', key: 'mode', value }), undefined, String(value));
  for (const value of ['', 'ALL', 'everything', 'auto', ' all', true, 5, {}]) assert.equal(p({ type: 'setSetting', reqId: 'r', key: 'scope', value }), undefined, String(value));
  for (const value of ['', 'on', 'Auto', 'all', 'workspace', false, 5]) assert.equal(p({ type: 'setSetting', reqId: 'r', key: 'usageChecks', value }), undefined, String(value));
});

test('setSetting: null resets every allowlisted key', () => {
  for (const key of FRONT_DESK_SETTINGS) assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key, value: null }), { type: 'setSetting', reqId: 'r', key, value: null }, key);
  // A missing value is not a reset.
  for (const key of FRONT_DESK_SETTINGS) assert.equal(p({ type: 'setSetting', reqId: 'r', key }), undefined, key);
});

test('setSetting: only allowlisted keys', () => {
  for (const key of ['claudePath', 'themeFile', 'claudeOffice.companyName', 'claudeOffice.claudePath', 'unknown', '', 'constructor', '__proto__', 'toString', 'CompanyName', 5, null, undefined]) {
    for (const value of ['x', true, false, null, 'all', '/bin/sh']) assert.equal(p({ type: 'setSetting', reqId: 'r', key, value }), undefined, `${String(key)} ${String(value)}`);
  }
  assert.equal(p({ type: 'setSetting', key: 'companyName', value: 'x' }), undefined);
  assert.equal(p({ type: 'setSetting', reqId: '', key: 'companyName', value: 'x' }), undefined);
});

test('setSetting: extra keys are dropped', () => {
  assert.deepEqual(p({ type: 'setSetting', reqId: 'r', key: 'scope', value: 'all', target: 'workspace', path: '/etc/passwd', file: 'x' }), { type: 'setSetting', reqId: 'r', key: 'scope', value: 'all' });
});

test('saveTheme', () => {
  const msg = { type: 'saveTheme', reqId: 'r', rev: REV, themeJson: '{"staff":[]}' };
  assert.deepEqual(p(msg), msg);
  assert.deepEqual(p({ ...msg, force: true }), { ...msg, force: true });
  assert.deepEqual(p({ ...msg, force: undefined }), msg);
});

test('saveTheme: rev must be 16 lowercase hex characters', () => {
  const msg = { type: 'saveTheme', reqId: 'r', themeJson: '{}' };
  assert.ok(p({ ...msg, rev: 'abcdef0123456789' }));
  for (const rev of ['0123456789ABCDEF', '0123456789abcdeF', '0123456789abcde', '0123456789abcdef0', '', ' 0123456789abcdef', '0123456789abcdef\n', '0123456789abcdeg', 'g'.repeat(16), undefined, null, 5, {}]) {
    assert.equal(p({ ...msg, rev }), undefined, String(rev));
  }
});

test('saveTheme: themeJson is a capped string, not parsed', () => {
  const base = { type: 'saveTheme', reqId: 'r', rev: REV };
  assert.ok(p({ ...base, themeJson: 'x'.repeat(LIMITS.themeJsonChars) }));
  assert.equal(p({ ...base, themeJson: 'x'.repeat(LIMITS.themeJsonChars + 1) }), undefined);
  assert.equal((p({ ...base, themeJson: 'not json {' }) as { themeJson: string }).themeJson, 'not json {');
  for (const themeJson of [undefined, null, 5, {}, [], { staff: [] }]) assert.equal(p({ ...base, themeJson }), undefined, String(themeJson));
});

test('saveTheme: force is only the literal true', () => {
  const msg = { type: 'saveTheme', reqId: 'r', rev: REV, themeJson: '{}' };
  for (const force of [false, 'true', 1, 0, null, {}, [], 'yes']) assert.equal(p({ ...msg, force }), undefined, String(force));
  assert.equal(p({ ...msg, reqId: '' }), undefined);
  assert.equal(p({ ...msg, reqId: undefined }), undefined);
});

test('saveThemeAs', () => {
  const msg = { type: 'saveThemeAs', reqId: 'r', themeJson: '{"a":1}' };
  assert.deepEqual(p(msg), msg);
  // rev and force have no meaning here and are dropped.
  assert.deepEqual(p({ ...msg, rev: REV, force: true }), msg);
  assert.ok(p({ ...msg, themeJson: 'x'.repeat(LIMITS.themeJsonChars) }));
  assert.equal(p({ ...msg, themeJson: 'x'.repeat(LIMITS.themeJsonChars + 1) }), undefined);
  for (const themeJson of [undefined, null, 5, {}]) assert.equal(p({ ...msg, themeJson }), undefined, String(themeJson));
  assert.equal(p({ ...msg, reqId: '' }), undefined);
});

test('openSettingsUi', () => {
  for (const key of FRONT_DESK_SETTINGS) for (const target of ['user', 'workspace']) {
    assert.deepEqual(p({ type: 'openSettingsUi', key, target, junk: 1 }), { type: 'openSettingsUi', key, target });
  }
  assert.deepEqual(p({ type: 'openSettingsUi', key: 'mode', target: 'user' }), { type: 'openSettingsUi', key: 'mode', target: 'user' });
  assert.deepEqual(p({ type: 'openSettingsUi', key: 'themeFile', target: 'workspace' }), { type: 'openSettingsUi', key: 'themeFile', target: 'workspace' });
  for (const key of ['claudePath', 'claudeOffice.scope', 'unknown', '', 'constructor', undefined, 5]) assert.equal(p({ type: 'openSettingsUi', key, target: 'user' }), undefined, String(key));
  for (const target of ['', 'global', 'User', 'folder', undefined, null, 5]) assert.equal(p({ type: 'openSettingsUi', key: 'scope', target }), undefined, String(target));
});

test('no Front desk message carries a path', () => {
  const extras = { path: '/etc/passwd', file: '/tmp/x.json', filePath: 'a', themeFile: '/tmp/y', uri: 'file:///x' };
  const msgs: unknown[] = [
    { type: 'getFrontDesk', reqId: 'r' },
    { type: 'themeAction', reqId: 'r', action: 'choose' },
    { type: 'themeAction', reqId: 'r', action: 'copyPreset', presetId: 'example' },
    { type: 'setSetting', reqId: 'r', key: 'scope', value: 'all' },
    { type: 'saveTheme', reqId: 'r', rev: REV, themeJson: '{}' },
    { type: 'saveThemeAs', reqId: 'r', themeJson: '{}' },
  ];
  for (const m of msgs) {
    const out = p({ ...(m as object), ...extras }) as unknown as Record<string, unknown>;
    assert.deepEqual(out, m);
    for (const k of Object.keys(extras)) assert.ok(!(k in out), k);
  }
  assert.deepEqual(p({ type: 'openSettingsUi', key: 'scope', target: 'user', ...extras }), { type: 'openSettingsUi', key: 'scope', target: 'user' });
});

test('never throws on hostile Front desk input', () => {
  assert.equal(p({ type: 'setSetting', reqId: 'r', key: 'scope', get value(): string { throw new Error('boom'); } }), undefined);
  assert.equal(p({ type: 'themeAction', reqId: 'r', get action(): string { throw new Error('boom'); } }), undefined);
  assert.equal(p({ type: 'saveTheme', reqId: 'r', rev: REV, get themeJson(): string { throw new Error('boom'); } }), undefined);
});

test('never throws on hostile input', () => {
  const evil = { get type(): string { throw new Error('boom'); } };
  assert.equal(p(evil), undefined);
  const cyc: Record<string, unknown> = { type: 'decide', requestId: 'r' };
  cyc.decision = cyc;
  assert.equal(p(cyc), undefined);
});
