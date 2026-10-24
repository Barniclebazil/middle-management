import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCaseTabBoot, parseWebviewMessage as p } from '../src/shared/validate.ts';
import { CASE_TAB_BOOT_ELEMENT_ID, LIMITS, SEND_HOME_AFTER_DEFAULT_HOURS, SEND_HOME_AFTER_MAX_HOURS, forAnotherCase, sendHomeAfterMs } from '../src/shared/protocol.ts';
import type { CaseAddress, HostToWebview } from '../src/shared/protocol.ts';

const HOUR = 3_600_000;
const BAD_IDS: [string, unknown][] = [
  ['missing', undefined],
  ['empty', ''],
  ['null', null],
  ['number', 5],
  ['object', { id: 'a' }],
  ['array', ['a']],
  ['NUL', 'a\u0000b'],
  ['newline', 'a\nb'],
  ['DEL', 'a\u007fb'],
  ['over the cap', 'a'.repeat(LIMITS.idChars + 1)],
];

// --- openCaseTab and sendHome ---------------------------------------------------------------------------------------

for (const type of ['openCaseTab', 'sendHome'] as const) {
  test(`${type}: a good id parses`, () => {
    assert.deepEqual(p({ type, agentId: 'agent-1' }), { type, agentId: 'agent-1' });
    assert.deepEqual(p({ type, agentId: 'a'.repeat(LIMITS.idChars) }), { type, agentId: 'a'.repeat(LIMITS.idChars) });
    // Ids are not session ids: a temp worker's id has a colon and a main's is a uuid; both pass the id() rule.
    assert.deepEqual(p({ type, agentId: '3f2a9c1e-0000-4000-8000-123456789abc:sub:7' }), { type, agentId: '3f2a9c1e-0000-4000-8000-123456789abc:sub:7' });
  });

  test(`${type}: bad ids are rejected`, () => {
    for (const [name, v] of BAD_IDS) assert.equal(p({ type, agentId: v }), undefined, name);
    assert.equal(p({ type }), undefined);
  });

  test(`${type}: extra fields are stripped`, () => {
    const out = p({ type, agentId: 'a1', sessionId: 's1', path: '/etc/passwd', force: true, __proto__: { x: 1 }, extra: { deep: 1 } });
    assert.deepEqual(out, { type, agentId: 'a1' });
    assert.deepEqual(Object.keys(out as object).sort(), ['agentId', 'type']);
  });

  test(`${type}: a session id is not accepted in place of the agent id`, () => {
    assert.equal(p({ type, sessionId: 's1' }), undefined);
  });
}

test('the two messages are distinct types', () => {
  assert.equal(p({ type: 'openCaseTab', agentId: 'a' })?.type, 'openCaseTab');
  assert.equal(p({ type: 'sendHome', agentId: 'a' })?.type, 'sendHome');
  assert.equal(p({ type: 'sendHomeNow', agentId: 'a' }), undefined);
});

test('existing messages still parse unchanged', () => {
  assert.deepEqual(p({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(p({ type: 'closeCase', agentId: 'ignored' }), { type: 'closeCase' });
  assert.deepEqual(p({ type: 'openCase', agentId: 'a' }), { type: 'openCase', agentId: 'a' });
  assert.deepEqual(p({ type: 'reply', sessionId: 's-1', text: 'hi' }), { type: 'reply', sessionId: 's-1', text: 'hi' });
});

test('bypassPermissions is still impossible to express', () => {
  assert.equal(p({ type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { permissionMode: 'bypassPermissions' } }), undefined);
  assert.equal(p({ type: 'setSessionOptions', nonce: 'n', sessionId: 's', options: { model: 'opus', bypassPermissions: true } }), undefined);
  // The new messages have no options to smuggle it in: it is dropped.
  assert.deepEqual(p({ type: 'openCaseTab', agentId: 'a', permissionMode: 'bypassPermissions' }), { type: 'openCaseTab', agentId: 'a' });
  assert.deepEqual(p({ type: 'sendHome', agentId: 'a', options: { permissionMode: 'bypassPermissions' } }), { type: 'sendHome', agentId: 'a' });
});

// --- the case tab's boot data ---------------------------------------------------------------------------------------

test('parseCaseTabBoot', () => {
  assert.equal(CASE_TAB_BOOT_ELEMENT_ID, 'mm-boot');
  assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'a1' }), { mode: 'case', agentId: 'a1' });
  assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'a1', cwd: '/home/x', extra: 1 }), { mode: 'case', agentId: 'a1' });
  for (const [name, v] of BAD_IDS) assert.equal(parseCaseTabBoot({ mode: 'case', agentId: v }), undefined, name);
  assert.equal(parseCaseTabBoot({ mode: 'office', agentId: 'a1' }), undefined);
  assert.equal(parseCaseTabBoot({ agentId: 'a1' }), undefined);
  for (const v of [undefined, null, 'case', 5, [], [{ mode: 'case', agentId: 'a' }]]) assert.equal(parseCaseTabBoot(v), undefined);
});

// --- addressing -----------------------------------------------------------------------------------------------------

const own: CaseAddress = { agentId: 'A', sessionId: 'sA', requestId: 'rA' };
const header = { agentId: 'A', title: 't', project: 'p', activity: 'idle', status: 'idle', control: 'office' } as const;

test('forAnotherCase: the case messages are addressed by agentId', () => {
  const mine: HostToWebview[] = [
    { type: 'caseFile', agentId: 'A', header, items: [], pending: null, truncated: false },
    { type: 'caseAppend', agentId: 'A', items: [] },
    { type: 'caseClosed', agentId: 'A', reason: 'agentGone' },
    { type: 'planText', reqId: 'q', agentId: 'A', planId: 'x', text: '', status: 'pending' },
    { type: 'turn', reqId: 'q', agentId: 'A', items: [], truncated: false },
  ];
  for (const m of mine) assert.equal(forAnotherCase(m, own), false, m.type);
  for (const m of mine) assert.equal(forAnotherCase({ ...m, agentId: 'B' } as HostToWebview, own), true, `${m.type} for B`);
});

test('forAnotherCase: error is addressed by agentId, else sessionId, else requestId', () => {
  const err = (e: Partial<Extract<HostToWebview, { type: 'error' }>>): HostToWebview => ({ type: 'error', message: 'm', ...e });
  assert.equal(forAnotherCase(err({ agentId: 'A' }), own), false);
  assert.equal(forAnotherCase(err({ agentId: 'B' }), own), true);
  // agentId wins over a conflicting session id
  assert.equal(forAnotherCase(err({ agentId: 'A', sessionId: 'sB' }), own), false);
  assert.equal(forAnotherCase(err({ agentId: 'B', sessionId: 'sA' }), own), true);
  assert.equal(forAnotherCase(err({ sessionId: 'sA' }), own), false);
  assert.equal(forAnotherCase(err({ sessionId: 'sB' }), own), true);
  assert.equal(forAnotherCase(err({ requestId: 'rA' }), own), false);
  assert.equal(forAnotherCase(err({ requestId: 'rB' }), own), true);
  // Lenient: an id-less error, or one that only carries the tab's own nonce / reqId, is not for another case.
  assert.equal(forAnotherCase(err({}), own), false);
  assert.equal(forAnotherCase(err({ nonce: 'n1' }), own), false);
  assert.equal(forAnotherCase(err({ reqId: 'r1' }), own), false);
  // Unknown own session or request: cannot say it is for another case.
  assert.equal(forAnotherCase(err({ sessionId: 'sB' }), { agentId: 'A' }), false);
  assert.equal(forAnotherCase(err({ requestId: 'rB' }), { agentId: 'A' }), false);
  assert.equal(forAnotherCase(err({ requestId: 'rB' }), { agentId: 'A', sessionId: 'sA' }), false);
});

test('forAnotherCase: sessionOptions by sessionId, everything else is shared state', () => {
  assert.equal(forAnotherCase({ type: 'sessionOptions', nonce: 'n', sessionId: 'sA', applied: {}, deferred: {} }, own), false);
  assert.equal(forAnotherCase({ type: 'sessionOptions', nonce: 'n', sessionId: 'sB', applied: {}, deferred: {} }, own), true);
  assert.equal(forAnotherCase({ type: 'sessionOptions', nonce: 'n', sessionId: 'sB', applied: {}, deferred: {} }, { agentId: 'A' }), false);
  const shared: HostToWebview[] = [
    { type: 'agents', agents: [] },
    { type: 'caseTabs', agentIds: ['B'] },
    { type: 'projects', projects: [] },
    { type: 'taskStarted', nonce: 'n', sessionId: 'sB', agentId: 'B' },
  ];
  for (const m of shared) assert.equal(forAnotherCase(m, own), false, m.type);
});

test('the error message still allows the old shapes (backwards compatible with the drawer)', () => {
  const old: HostToWebview = { type: 'error', sessionId: 's1', requestId: 'r1', message: 'x' };
  assert.equal('agentId' in old, false);
  assert.equal(forAnotherCase(old, { agentId: 'A' }), false);
});

test('caseTabs carries ids in opening order, within the limit', () => {
  const m: HostToWebview = { type: 'caseTabs', agentIds: ['b', 'a'] };
  assert.deepEqual(m.agentIds, ['b', 'a']);
  assert.equal(LIMITS.caseTabs, 20);
});

// --- settings -------------------------------------------------------------------------------------------------------

test('sendHomeAfterMs: default, zero, clamp and bad input', () => {
  assert.equal(SEND_HOME_AFTER_DEFAULT_HOURS, 8);
  assert.equal(sendHomeAfterMs(8), 8 * HOUR);
  assert.equal(sendHomeAfterMs(undefined), 8 * HOUR);
  assert.equal(sendHomeAfterMs(0), 0);
  assert.equal(sendHomeAfterMs(0.5), HOUR / 2);
  assert.equal(sendHomeAfterMs(1), HOUR);
  assert.equal(sendHomeAfterMs(SEND_HOME_AFTER_MAX_HOURS), SEND_HOME_AFTER_MAX_HOURS * HOUR);
  assert.equal(sendHomeAfterMs(SEND_HOME_AFTER_MAX_HOURS + 1), SEND_HOME_AFTER_MAX_HOURS * HOUR);
  assert.equal(sendHomeAfterMs(1e9), SEND_HOME_AFTER_MAX_HOURS * HOUR);
  for (const v of [-1, NaN, Infinity, -Infinity, '8', '', null, true, {}, []]) assert.equal(sendHomeAfterMs(v), 8 * HOUR, String(v));
});

test('package.json scope setting defaults to workspace', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const setting = pkg.contributes.configuration.properties['claudeOffice.scope'];
  assert.equal(setting.default, 'workspace');
  assert.deepEqual(setting.enum, ['all', 'workspace']);
});

test('package.json declares the v0.5 setting and command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const setting = pkg.contributes.configuration.properties['claudeOffice.sendHomeAfter'];
  assert.equal(setting.type, 'number');
  assert.equal(setting.default, SEND_HOME_AFTER_DEFAULT_HOURS);
  assert.equal(setting.minimum, 0);
  assert.equal(setting.maximum, SEND_HOME_AFTER_MAX_HOURS);
  assert.ok(typeof setting.description === 'string' && setting.description.length > 0);
  // The manifest default and the shared reader agree.
  assert.equal(sendHomeAfterMs(setting.default), 8 * HOUR);
  const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'claudeOffice.placeOnTop');
  assert.equal(cmd?.title, 'Middle Management: Put the office on top');
  // There is deliberately no tabs-versus-drawer setting: the webview decides by its own width.
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.doesNotMatch(k, /tab|drawer/i, k);
});

// --- the look hand-off ------------------------------------------------------------------------------------------------

test('openCaseTab keeps a good look, including every built-in look id', () => {
  for (const look of ['staff-0', 'staff-7', 'temp3', 'temp0', 'manager', 'receptionist', 'assistant', 'hr', 'a', 'a'.repeat(40)]) {
    assert.deepEqual(p({ type: 'openCaseTab', agentId: 'a', look }), { type: 'openCaseTab', agentId: 'a', look }, look);
  }
});

test('openCaseTab drops a bad look but still opens the tab, and drops extra keys', () => {
  const bad: unknown[] = ['a'.repeat(41), 'Staff-0', '../x', '-x', '_x', 'x y', '<script>', '', 7, null, {}, ['staff-0'], 'staff-0\n'];
  for (const look of bad) assert.deepEqual(p({ type: 'openCaseTab', agentId: 'a', look }), { type: 'openCaseTab', agentId: 'a' }, JSON.stringify(look));
  assert.deepEqual(p({ type: 'openCaseTab', agentId: 'a', look: 'temp1', permissionMode: 'bypassPermissions', x: 1 }), { type: 'openCaseTab', agentId: 'a', look: 'temp1' });
  assert.deepEqual(p({ type: 'openCaseTab', agentId: 'a' }), { type: 'openCaseTab', agentId: 'a' }, 'no look: old senders work');
  assert.equal(p({ type: 'openCaseTab', look: 'staff-0' }), undefined, 'a bad id still rejects the message');
  assert.deepEqual(p({ type: 'sendHome', agentId: 'a', look: 'staff-0' }), { type: 'sendHome', agentId: 'a' }, 'sendHome has no look');
});

test('parseCaseTabBoot: with a look, without one, and with a bad one', () => {
  assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'w', look: 'staff-2' }), { mode: 'case', agentId: 'w', look: 'staff-2' });
  assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'w' }), { mode: 'case', agentId: 'w' });
  for (const look of ['Staff', '../x', 'a'.repeat(41), 4, null, '<b>']) assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'w', look }), { mode: 'case', agentId: 'w' }, String(look));
  assert.deepEqual(parseCaseTabBoot({ mode: 'case', agentId: 'w', look: 'temp0', extra: 1 }), { mode: 'case', agentId: 'w', look: 'temp0' });
});

test('forAnotherCase: caseLook is addressed by agentId', () => {
  const m: HostToWebview = { type: 'caseLook', agentId: 'a', look: 'staff-1' };
  assert.equal(forAnotherCase(m, { agentId: 'a' }), false);
  assert.equal(forAnotherCase(m, { agentId: 'b' }), true);
});
