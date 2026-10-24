import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeDefaults, HostToWebview } from '../src/shared/protocol.ts';
import { CASE_TAB_TYPES, caseErrorTarget, claimForTab, pageFocusTarget, readCaseTabBoot, tabLook, workingLine } from '../webview/engine/caseLogic.ts';

// ---------------------------------------------------------------------------
// Boot

test('readCaseTabBoot reads the boot element text into a fresh {mode, agentId}', () => {
  assert.deepEqual(readCaseTabBoot('{"mode":"case","agentId":"w-1"}'), { mode: 'case', agentId: 'w-1' });
  assert.deepEqual(readCaseTabBoot('  {"mode":"case","agentId":"w-1","sessionId":"s","extra":true}\n'), { mode: 'case', agentId: 'w-1' }, 'extra keys dropped');
});

test('readCaseTabBoot: missing, empty, bad JSON or anything else is undefined, never a throw', () => {
  for (const text of [null, undefined, '', '   ', '{', 'not json', '[]', '"case"', 'null', '42']) assert.equal(readCaseTabBoot(text), undefined, String(text));
  for (const obj of [{ mode: 'office', agentId: 'w-1' }, { mode: 'case' }, { mode: 'case', agentId: '' }, { mode: 'case', agentId: 7 }, { mode: 'case', agentId: 'a\nb' }, { agentId: 'w-1' }]) {
    assert.equal(readCaseTabBoot(JSON.stringify(obj)), undefined, JSON.stringify(obj));
  }
  assert.equal(readCaseTabBoot(JSON.stringify({ mode: 'case', agentId: 'x'.repeat(10_000) })), undefined, 'over-long id');
});

// ---------------------------------------------------------------------------
// Claiming host messages

const own = { agentId: 'w-1', sessionId: 's-1', requestId: 'r-1' };
const header = { agentId: 'w-1', title: 't', project: 'p', activity: 'idle', status: 'idle', control: 'office' } as const;

test('claimForTab keeps the tab\'s own case messages and the shared state', () => {
  const mine: HostToWebview[] = [
    { type: 'caseFile', agentId: 'w-1', header, items: [], pending: null, truncated: false },
    { type: 'caseAppend', agentId: 'w-1', items: [] },
    { type: 'caseClosed', agentId: 'w-1', reason: 'agentGone' },
    { type: 'agents', agents: [] },
    { type: 'settings', settings: { companyName: 'c', branchName: 'b', speechBubbles: true, managerName: 'm', bossQuotes: true } },
    { type: 'claudeDefaults', defaults: { model: 'opus', models: [] } as unknown as ClaudeDefaults },
    { type: 'sessionOptions', nonce: 'n', sessionId: 's-1', applied: {}, deferred: {} },
    { type: 'error', agentId: 'w-1', message: 'x' },
    { type: 'error', sessionId: 's-1', message: 'x' },
    { type: 'error', requestId: 'r-1', message: 'x' },
    { type: 'error', nonce: 'mine', message: 'x' },
    { type: 'error', message: 'no address' },
  ];
  for (const m of mine) assert.equal(claimForTab(m, own), true, JSON.stringify(m));
});

test('claimForTab drops another worker\'s, session\'s or request\'s messages', () => {
  const theirs: HostToWebview[] = [
    { type: 'caseFile', agentId: 'w-2', header: { ...header, agentId: 'w-2' }, items: [], pending: null, truncated: false },
    { type: 'caseAppend', agentId: 'w-2', items: [] },
    { type: 'caseClosed', agentId: 'w-2', reason: 'agentGone' },
    { type: 'sessionOptions', nonce: 'n', sessionId: 's-2', applied: {}, deferred: {} },
    { type: 'error', agentId: 'w-2', message: 'x' },
    // agentId decides first, even when the session would have matched
    { type: 'error', agentId: 'w-2', sessionId: 's-1', message: 'x' },
    { type: 'error', sessionId: 's-2', message: 'x' },
    { type: 'error', requestId: 'r-2', message: 'x' },
  ];
  for (const m of theirs) assert.equal(claimForTab(m, own), false, JSON.stringify(m));
});

test('claimForTab drops the office view\'s own messages and anything malformed', () => {
  const office = [
    { type: 'caseTabs', agentIds: ['w-1'] }, { type: 'projects', projects: [] }, { type: 'openMemo' }, { type: 'openFrontDesk' },
    { type: 'fileRoots', roots: [] }, { type: 'taskStarted', nonce: 'n', sessionId: 's', agentId: 'w-1' }, { type: 'planText', reqId: 'q', agentId: 'w-1' },
    { type: 'turn', reqId: 'q', agentId: 'w-1' },
  ];
  for (const m of office) assert.equal(claimForTab(m, own), false, m.type);
  for (const m of [null, undefined, 1, 'agents', {}, { type: 7 }, { type: 'nope' }]) assert.equal(claimForTab(m, own), false, JSON.stringify(m));
  assert.ok(CASE_TAB_TYPES.has('caseAppend') && !CASE_TAB_TYPES.has('caseTabs'));
});

test('claimForTab is lenient before the tab knows its session and request', () => {
  const early = { agentId: 'w-1' };
  assert.equal(claimForTab({ type: 'sessionOptions', nonce: 'n', sessionId: 's-9', applied: {}, deferred: {} }, early), true);
  assert.equal(claimForTab({ type: 'error', sessionId: 's-9', message: 'x' }, early), true);
  assert.equal(claimForTab({ type: 'error', requestId: 'r-9', message: 'x' }, early), true);
  assert.equal(claimForTab({ type: 'caseAppend', agentId: 'w-9', items: [] }, early), false, 'the agentId is always known');
});

// ---------------------------------------------------------------------------
// Errors in an open case

test('caseErrorTarget: an agentId decides first', () => {
  const loaded = { agentId: 'w-1', loaded: true, sessionId: 's-1', liveSessionId: 's-1', requestId: 'r-1' };
  assert.equal(caseErrorTarget({ agentId: 'w-2', sessionId: 's-1' }, loaded), 'other');
  assert.equal(caseErrorTarget({ agentId: 'w-1' }, loaded), 'inline');
  assert.equal(caseErrorTarget({ agentId: 'w-1', sessionId: 's-other' }, loaded), 'inline');
  assert.equal(caseErrorTarget({ agentId: 'w-1' }, { ...loaded, loaded: false }), 'load');
  assert.equal(caseErrorTarget({ agentId: 'w-2' }, { ...loaded, loaded: false }), 'other', 'another worker\'s refusal never blocks this file');
});

test('caseErrorTarget without an agentId keeps the drawer\'s old rules', () => {
  const loading = { agentId: 'w-1', loaded: false, liveSessionId: 's-1' };
  assert.equal(caseErrorTarget({}, loading), 'load', 'id-less refusal while loading');
  assert.equal(caseErrorTarget({ sessionId: 's-1' }, loading), 'load');
  assert.equal(caseErrorTarget({ sessionId: 's-2' }, loading), 'other');
  assert.equal(caseErrorTarget({ nonce: 'n' }, loading), 'other');
  assert.equal(caseErrorTarget({ requestId: 'r' }, loading), 'other');
  const loaded = { agentId: 'w-1', loaded: true, sessionId: 's-1', requestId: 'r-1' };
  assert.equal(caseErrorTarget({ sessionId: 's-1' }, loaded), 'inline');
  assert.equal(caseErrorTarget({ requestId: 'r-1' }, loaded), 'inline');
  assert.equal(caseErrorTarget({ sessionId: 's-2' }, loaded), 'other');
  assert.equal(caseErrorTarget({}, loaded), 'other', 'id-less once loaded: a toast');
});

// ---------------------------------------------------------------------------
// First focus and the working line

test('pageFocusTarget: the knock card first, then the reply box, else the page', () => {
  const base = { knocking: false, footer: 'reply' as const, canSend: true, closed: false, loadError: false };
  assert.equal(pageFocusTarget(base), 'reply');
  assert.equal(pageFocusTarget({ ...base, knocking: true }), 'card');
  assert.equal(pageFocusTarget({ ...base, canSend: false }), 'page', 'no session id yet');
  for (const footer of ['elsewhere', 'temp', 'closed'] as const) assert.equal(pageFocusTarget({ ...base, footer }), 'page', footer);
  assert.equal(pageFocusTarget({ ...base, footer: 'elsewhere', knocking: true }), 'card');
  assert.equal(pageFocusTarget({ ...base, closed: true, knocking: true }), 'page', 'a worker who left');
  assert.equal(pageFocusTarget({ ...base, loadError: true }), 'page');
});

test('workingLine shows what they are doing only while a turn runs', () => {
  assert.equal(workingLine({ activity: 'running', status: 'working', busy: true }, false), 'Running a command…');
  assert.equal(workingLine({ activity: 'idle', status: 'working', busy: true }, false), 'Working…');
  assert.equal(workingLine({ activity: 'reading', status: 'working' }, false), 'Reading…', 'a live session without busy');
  assert.equal(workingLine({ activity: 'idle', status: 'idle', busy: false }, false), null);
  assert.equal(workingLine({ activity: 'idle', status: 'working' }, false), null);
  assert.equal(workingLine({ activity: 'running', status: 'working', busy: true }, true), null, 'the card speaks while knocking');
  assert.equal(workingLine({ activity: 'needsYou', status: 'waiting' }, false), null);
  assert.equal(workingLine(null, false), null);
});

test('readCaseTabBoot keeps a good look and drops a bad one', () => {
  assert.deepEqual(readCaseTabBoot('{"mode":"case","agentId":"w-1","look":"staff-4"}'), { mode: 'case', agentId: 'w-1', look: 'staff-4' });
  assert.deepEqual(readCaseTabBoot('{"mode":"case","agentId":"w-1","look":"../x"}'), { mode: 'case', agentId: 'w-1' });
});

test('tabLook: a handed look the art knows wins; unknown or missing falls back to the guess', () => {
  const known = (l: string): boolean => l === 'staff-3' || l === 'manager';
  assert.equal(tabLook('staff-3', known, 'staff-0'), 'staff-3');
  assert.equal(tabLook('manager', known, null), 'manager');
  assert.equal(tabLook('nobody', known, 'staff-0'), 'staff-0');
  assert.equal(tabLook('nobody', known, null), null);
  assert.equal(tabLook(undefined, known, 'temp1'), 'temp1');
  assert.equal(tabLook('', known, 'temp1'), 'temp1');
});

test('claimForTab: caseLook is claimed only for the tab\'s own worker', () => {
  assert.ok(CASE_TAB_TYPES.has('caseLook'));
  assert.equal(claimForTab({ type: 'caseLook', agentId: 'a', look: 'staff-1' }, { agentId: 'a' }), true);
  assert.equal(claimForTab({ type: 'caseLook', agentId: 'b', look: 'staff-1' }, { agentId: 'a' }), false);
});
