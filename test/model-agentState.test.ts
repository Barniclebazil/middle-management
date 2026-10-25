import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTracker, LINGER_MS, TEMP_OPEN_TOOL_STALE_MS } from '../src/model/agentState.ts';
import type { OfficeInfoLookup } from '../src/model/agentState.ts';
import type { LiveStatus, RecordBatch, SubagentInfo } from '../src/claude/types.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { DEMO_DIR, FACT_FIXTURES, lastTimestamp, loadJsonl, loadMain, makeClock, rec, session, t, update } from './model-util.ts';

const SID = 'sid-1';

function setup(startHms = '12:00:00') {
  const clock = makeClock(t(startHms));
  const tracker = new AgentTracker({ now: clock.now });
  return { clock, tracker };
}

function mainOf(snaps: AgentSnapshot[]): AgentSnapshot {
  const m = snaps.find((s) => s.kind === 'main');
  assert.ok(m, 'main agent present');
  return m;
}

/** Feed records for a synthetic session and return the main snapshot at `at`. */
function run(records: unknown[], at: number, opts: { live?: LiveStatus } = {}) {
  const { clock, tracker } = setup();
  clock.set(at);
  tracker.apply(update([session(SID, { ...opts, mtimeMs: lastTimestamp(records) })], [{ sessionId: SID, reset: true, records }]));
  return mainOf(tracker.snapshot(at));
}

// ---------------------------------------------------------------- fixtures

test('fixture tour: idle after end_turn, title, project, lastPromptAt, startedAt', () => {
  const { sessionId, records } = loadMain(1);
  const { clock, tracker } = setup('10:02:00');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:01:52'), live: { pid: 1003, alive: true, status: 'idle', statusUpdatedAt: t('10:01:52') } })], [{ sessionId, reset: true, records }]));
  const snaps = tracker.snapshot(clock.now());
  assert.equal(snaps.length, 1);
  const s = snaps[0]!;
  assert.deepEqual(
    { id: s.id, kind: s.kind, title: s.title, project: s.project, activity: s.activity, status: s.status },
    { id: sessionId, kind: 'main', title: 'Walkthrough of every tool', project: 'demo-project', activity: 'idle', status: 'idle' },
  );
  assert.equal(s.since, t('10:01:50'));
  assert.equal(s.startedAt, t('10:00:00'));
  assert.equal(s.lastPromptAt, t('10:00:00'));
  assert.equal(s.parentId, undefined);
  assert.equal(s.detail, undefined);
});

test('fixture tour replayed record by record visits every tool activity in order', () => {
  const { sessionId, records } = loadMain(1);
  const { clock, tracker } = setup('10:00:00');
  const seen: string[] = [];
  const push = (s: AgentSnapshot): void => {
    const label = s.detail === undefined ? s.activity : `${s.activity}:${s.detail}`;
    if (seen[seen.length - 1] !== label) seen.push(label);
  };
  for (const r of records) {
    const ts = (r as { timestamp?: string }).timestamp;
    if (ts !== undefined) clock.set(Date.parse(ts));
    tracker.apply(update([session(sessionId, { mtimeMs: clock.now() })], [{ sessionId, reset: false, records: [r] }]));
    push(mainOf(tracker.snapshot(clock.now())));
  }
  // Each tool keeps showing through its result, the api-request and the thinking block that follow.
  assert.deepEqual(seen, [
    'idle', 'thinking', 'reading:app.ts', 'searching:"TODO"', 'searching:src/**/*.ts', 'researching:vite config options',
    'researching:example.com', 'writing:app.ts', 'drawing:logo.svg', 'running:Run the test suite', 'running:Build the bundle',
    'planning:Wiring up router', 'planning:code-review', 'researching:example.com', 'idle',
  ]);
});

test('fixture tour: after each result the tool keeps showing for 8 s, then thinking', () => {
  const { sessionId, records } = loadMain(1);
  const expected: Array<[string, string, string]> = [
    // [result time, activity, since]. Same-activity tools in a row (Grep+Glob, WebSearch+WebFetch, TodoWrite+Skill) share the first one's since.
    ['10:00:09', 'reading', '10:00:07'], ['10:00:14', 'searching', '10:00:12'], ['10:00:19', 'searching', '10:00:12'],
    ['10:00:24', 'researching', '10:00:22'], ['10:00:29', 'researching', '10:00:22'], ['10:00:34', 'writing', '10:00:32'],
    ['10:00:39', 'drawing', '10:00:37'], ['10:00:44', 'running', '10:00:42'], ['10:01:32', 'running', '10:00:47'],
    ['10:01:37', 'planning', '10:01:35'], ['10:01:42', 'planning', '10:01:35'], ['10:01:47', 'researching', '10:01:45'],
  ];
  for (const [resultAt, activity, since] of expected) {
    const upTo = records.filter((r) => {
      const ts = (r as { timestamp?: string }).timestamp;
      return ts === undefined || Date.parse(ts) <= t(resultAt);
    });
    const { tracker } = setup(resultAt);
    tracker.apply(update([session(sessionId, { mtimeMs: t(resultAt) })], [{ sessionId, reset: true, records: upTo }]));
    const lingering = mainOf(tracker.snapshot(t(resultAt) + 3_000));
    assert.equal(lingering.activity, activity, resultAt);
    assert.equal(lingering.since, t(since), resultAt);
    const later = mainOf(tracker.snapshot(t(resultAt) + 8_000));
    assert.equal(later.activity, 'thinking', `${resultAt} after linger`);
    assert.equal(later.since, t(resultAt) + 8_000, `${resultAt} thinking starts when the linger ends`);
  }
});

test('fixture tour: the 45 s build turns into the copier after 20 s, keeping its detail', () => {
  const { sessionId, records } = loadMain(1);
  const open = records.filter((r) => {
    const ts = (r as { timestamp?: string }).timestamp;
    return ts === undefined || Date.parse(ts) <= t('10:00:47');
  });
  const { clock, tracker } = setup('10:00:50');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:47') })], [{ sessionId, reset: true, records: open }]));
  let s = mainOf(tracker.snapshot(t('10:01:00')));
  assert.equal(s.activity, 'running');
  assert.equal(s.detail, 'Build the bundle');
  assert.equal(s.since, t('10:00:42'), 'running since the previous quick Bash, which was still lingering');
  s = mainOf(tracker.snapshot(t('10:01:08')));
  assert.equal(s.activity, 'copier');
  assert.equal(s.detail, 'Build the bundle');
  assert.equal(s.since, t('10:01:07'));
  assert.equal(s.status, 'working');
  void clock;
});

test('fixture ask: open AskUserQuestion needs you (live waiting, and by the 4 s rule)', () => {
  const { sessionId, records } = loadMain(2);
  const mtime = t('10:00:10');
  // Live status waiting.
  {
    const { tracker } = setup('10:00:11');
    tracker.apply(update([session(sessionId, { mtimeMs: mtime, live: { pid: 1002, alive: true, status: 'waiting', statusUpdatedAt: t('10:00:10') } })], [{ sessionId, reset: true, records }]));
    const s = mainOf(tracker.snapshot(t('10:00:11')));
    assert.equal(s.activity, 'needsYou');
    assert.equal(s.status, 'waiting');
    assert.equal(s.detail, 'Framework');
    assert.equal(s.title, 'Choosing a framework');
  }
  // No live file: needs 4 s first.
  {
    const { tracker } = setup('10:00:12');
    tracker.apply(update([session(sessionId, { mtimeMs: mtime })], [{ sessionId, reset: true, records }]));
    assert.equal(mainOf(tracker.snapshot(t('10:00:12'))).activity, 'thinking');
    const s = mainOf(tracker.snapshot(t('10:00:15')));
    assert.equal(s.activity, 'needsYou');
    assert.equal(s.status, 'waiting');
    assert.equal(s.since, t('10:00:14'));
  }
});

test('fixture running: Bash npm test since 10:00:10, then the copier after 20 s', () => {
  const { sessionId, records } = loadMain(3);
  const { tracker } = setup('10:00:15');
  const live = { pid: 1001, alive: true, status: 'busy', statusUpdatedAt: t('10:00:00') };
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:10'), live })], [{ sessionId, reset: true, records }]));
  let s = mainOf(tracker.snapshot(t('10:00:15')));
  assert.equal(s.activity, 'running');
  assert.equal(s.detail, 'Run the test suite');
  assert.equal(s.since, t('10:00:10'));
  assert.equal(s.status, 'working');
  assert.equal(s.title, 'Running the test suite');
  s = mainOf(tracker.snapshot(t('10:00:29')));
  assert.equal(s.activity, 'running');
  s = mainOf(tracker.snapshot(t('10:00:31')));
  assert.equal(s.activity, 'copier');
  assert.equal(s.detail, 'Run the test suite');
  assert.equal(s.since, t('10:00:30'));
  // Stays the same copier (same since) later on, and needsYou only if live says waiting.
  s = mainOf(tracker.snapshot(t('10:05:00')));
  assert.equal(s.activity, 'copier');
  assert.equal(s.since, t('10:00:30'));
});

test('fixture thinking: request sent, no reply yet', () => {
  const { sessionId, records } = loadMain(4);
  const { tracker } = setup('10:00:08');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:06') })], [{ sessionId, reset: true, records }]));
  // The Read result came back at 10:00:05, so the Read still shows for 8 s.
  let s = mainOf(tracker.snapshot(t('10:00:08')));
  assert.equal(s.activity, 'reading');
  assert.equal(s.since, t('10:00:03'));
  s = mainOf(tracker.snapshot(t('10:00:14')));
  assert.equal(s.activity, 'thinking');
  assert.equal(s.status, 'working');
  assert.equal(s.title, 'Reviewing the entry file');
  assert.equal(s.since, t('10:00:13'));
});

test('fixture subagents: parent idle, agent 1 done then dropped after 10 s, agent 2 researching', () => {
  const { sessionId, records } = loadMain(5);
  const subDir = join(DEMO_DIR, sessionId, 'subagents');
  const ids = ['a5ca1e00000000001', 'a5ca1e00000000002'];
  const subs: SubagentInfo[] = ids.map((id) => {
    const file = join(subDir, `agent-${id}.jsonl`);
    return {
      agentId: id,
      path: file,
      mtimeMs: lastTimestamp(loadJsonl(file)),
      meta: JSON.parse(readFileSync(join(subDir, `agent-${id}.meta.json`), 'utf8')),
    };
  });
  const batches: RecordBatch[] = [
    { sessionId, reset: true, records },
    ...ids.map((id) => ({ sessionId, agentId: id, reset: true, records: loadJsonl(join(subDir, `agent-${id}.jsonl`)) })),
  ];
  const upd = update([session(sessionId, { mtimeMs: t('10:01:17'), subagents: subs })], batches);
  const { clock, tracker } = setup('10:01:20');
  tracker.apply(upd);

  let snaps = tracker.snapshot(clock.now());
  assert.equal(snaps.length, 3);
  const main = mainOf(snaps);
  assert.equal(main.activity, 'idle');
  assert.equal(main.title, 'Parallel review with two agents');
  const a1 = snaps.find((s) => s.id === `${sessionId}/${ids[0]}`)!;
  const a2 = snaps.find((s) => s.id === `${sessionId}/${ids[1]}`)!;
  assert.equal(a1.kind, 'temp');
  assert.equal(a1.parentId, sessionId);
  assert.equal(a1.status, 'done');
  assert.equal(a1.title, 'Review router');
  assert.equal(a1.project, 'demo-project');
  assert.equal(a2.kind, 'temp');
  assert.equal(a2.parentId, sessionId);
  assert.equal(a2.activity, 'researching');
  assert.equal(a2.detail, 'vite config options');
  assert.equal(a2.status, 'working');
  assert.equal(a2.title, 'Research bundlers');
  assert.equal(a2.since, t('10:00:32'));
  assert.equal(a2.startedAt, t('10:00:20'));

  assert.equal(tracker.snapshot(t('10:01:29.9')).length, 3, 'still shown as done just under 10 s');
  snaps = tracker.snapshot(t('10:01:30'));
  assert.deepEqual(snaps.map((s) => s.id), [sessionId, `${sessionId}/${ids[1]}`]);

  // The watcher keeps listing agent 1: it must not come back.
  clock.set(t('10:01:31'));
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:01:17'), subagents: subs })]));
  assert.deepEqual(tracker.snapshot(clock.now()).map((s) => s.id), [sessionId, `${sessionId}/${ids[1]}`]);

  // Agent 2 has a tool call open, so the 4 min silence rule does not apply to it.
  clock.set(t('10:04:40'));
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:01:17'), subagents: subs })]));
  assert.equal(tracker.snapshot(clock.now()).find((s) => s.id.endsWith(ids[1]!))!.status, 'working');
  // It never changes again: finished after TEMP_OPEN_TOOL_STALE_MS without change, then dropped.
  clock.set(t('10:00:32') + TEMP_OPEN_TOOL_STALE_MS + 60_000);
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:01:17'), subagents: subs })]));
  const s2 = tracker.snapshot(clock.now()).find((s) => s.id.endsWith(ids[1]!))!;
  assert.equal(s2.status, 'done');
  assert.equal(tracker.snapshot(clock.now() + 10_000).some((s) => s.id.endsWith(ids[1]!)), false);
});

test('fixture compact: shredding for 60 s after compact_boundary, then idle', () => {
  const { sessionId, records } = loadMain(6);
  const { tracker } = setup('10:00:20');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:13') })], [{ sessionId, reset: true, records }]));
  let s = mainOf(tracker.snapshot(t('10:00:20')));
  assert.equal(s.activity, 'shredding');
  assert.equal(s.since, t('10:00:13'));
  assert.equal(s.status, 'working');
  assert.equal(s.title, 'Long session, compacted');
  s = mainOf(tracker.snapshot(t('10:01:30')));
  assert.equal(s.activity, 'idle');
});

test('fixture interrupted: idle, the open Bash call is dropped', () => {
  const { sessionId, records } = loadMain(7);
  const { tracker } = setup('10:00:20');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:13') })], [{ sessionId, reset: true, records }]));
  const s = mainOf(tracker.snapshot(t('10:00:40')));
  assert.equal(s.activity, 'idle');
  assert.equal(s.status, 'idle');
  assert.equal(s.since, t('10:00:13'));
  assert.equal(s.title, 'Build interrupted');
});

test('fixture partial: the cut line is skipped, state is thinking', () => {
  const { sessionId, records } = loadMain(8);
  assert.equal(records.length, 8);
  const { tracker } = setup('10:00:10');
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:08') })], [{ sessionId, reset: true, records }]));
  assert.equal(mainOf(tracker.snapshot(t('10:00:10'))).activity, 'searching', 'Grep result at 10:00:05 still lingers');
  const s = mainOf(tracker.snapshot(t('10:00:20')));
  assert.equal(s.activity, 'thinking');
  assert.equal(s.title, 'Partially written file');
});

test('fixture windows: backslash cwd gives project "proj", idle', () => {
  const { sessionId, records } = loadMain(9);
  const { tracker } = setup('10:05:00');
  tracker.apply(update([session(sessionId, {
    cwd: 'C:\\Users\\alice\\work\\proj',
    projectDir: 'C:\\Users\\alice\\.claude\\projects\\C--Users-alice-work-proj',
    mtimeMs: lastTimestamp(records),
  })], [{ sessionId, reset: true, records }]));
  const s = mainOf(tracker.snapshot(t('10:05:00')));
  assert.equal(s.title, 'Windows project check');
  assert.equal(s.project, 'proj');
  assert.equal(s.activity, 'idle');
  // cwd taken from the records when the watcher gives none.
  const { tracker: t2 } = setup('10:05:00');
  t2.apply(update([session(sessionId, { cwd: undefined, mtimeMs: lastTimestamp(records) })], [{ sessionId, reset: true, records }]));
  assert.equal(mainOf(t2.snapshot(t('10:05:00'))).project, 'proj');
});

// ---------------------------------------------------------------- since

test('since does not move while the activity stays the same', () => {
  const base = [rec.human(t('12:00:00')), rec.apiRequest(t('12:00:01')), rec.toolUse(t('12:00:02'), 'a', 'Read', { file_path: '/x/a.ts' })];
  const { clock, tracker } = setup('12:00:03');
  const info = (): ReturnType<typeof session> => session(SID, { mtimeMs: clock.now() });
  tracker.apply(update([info()], [{ sessionId: SID, reset: true, records: base }]));
  const first = mainOf(tracker.snapshot(clock.now()));
  assert.equal(first.activity, 'reading');
  assert.equal(first.since, t('12:00:02'));

  // Bookkeeping records and repeated snapshots do not reset since.
  clock.set(t('12:00:04'));
  tracker.apply(update([info()], [{ sessionId: SID, reset: false, records: [
    { type: 'attachment', timestamp: new Date(t('12:00:03.500')).toISOString() },
    { type: 'cost-state' }, { type: 'last-prompt' },
    { type: 'file-history-snapshot' }, { type: 'permission-mode' },
  ] }]));
  assert.equal(mainOf(tracker.snapshot(clock.now())).since, t('12:00:02'));

  // Result, api-request and a thinking block: the Read lingers, same activity, same since.
  clock.set(t('12:00:10'));
  tracker.apply(update([info()], [{ sessionId: SID, reset: false, records: [rec.toolResult(t('12:00:05'), 'a'), rec.apiRequest(t('12:00:06')), rec.thinking(t('12:00:08'))] }]));
  let s = mainOf(tracker.snapshot(clock.now()));
  assert.equal(s.activity, 'reading');
  assert.equal(s.since, t('12:00:02'));
  // Eight seconds after the result it is thinking, starting at that moment; more thinking records do not move it.
  clock.set(t('12:00:20'));
  tracker.apply(update([info()], [{ sessionId: SID, reset: false, records: [rec.apiRequest(t('12:00:15')), rec.thinking(t('12:00:16'))] }]));
  s = mainOf(tracker.snapshot(clock.now()));
  assert.equal(s.activity, 'thinking');
  assert.equal(s.since, t('12:00:13'));
  clock.set(t('12:00:20.500'));
  tracker.apply(update([info()], [{ sessionId: SID, reset: false, records: [rec.thinking(t('12:00:20.200'))] }]));
  assert.equal(mainOf(tracker.snapshot(clock.now())).since, t('12:00:13'));

  // Next tool: a new activity gets a new since.
  tracker.apply(update([info()], [{ sessionId: SID, reset: false, records: [rec.toolUse(t('12:00:21'), 'b', 'Grep', { pattern: 'foo' })] }]));
  s = mainOf(tracker.snapshot(t('12:00:22')));
  assert.equal(s.activity, 'searching');
  assert.equal(s.since, t('12:00:21'));
});

test('a batch that holds several tool calls keeps the start of the final activity', () => {
  const recs = [
    rec.human(t('12:00:00')),
    rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/x/a.ts' }), rec.toolResult(t('12:00:02'), 'a'),
    rec.toolUse(t('12:00:03'), 'b', 'Bash', { command: 'ls' }),
  ];
  const s = run(recs, t('12:00:04'));
  assert.equal(s.activity, 'running');
  assert.equal(s.since, t('12:00:03'));
  assert.equal(s.startedAt, t('12:00:00'));
});

// ---------------------------------------------------------------- reset

test('reset rebuilds a file from the new records and forgets the old state', () => {
  const { clock, tracker } = setup('12:00:10');
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:05') })], [{ sessionId: SID, reset: true, records: [
    rec.aiTitle('Old title'), rec.human(t('12:00:00')), rec.toolUse(t('12:00:05'), 'a', 'Bash', { command: 'sleep 99' }),
  ] }]));
  let s = mainOf(tracker.snapshot(clock.now()));
  assert.equal(s.activity, 'running');
  assert.equal(s.title, 'Old title');
  assert.equal(s.lastPromptAt, t('12:00:00'));
  const started = s.startedAt;

  // Without reset, a result closes the call (it lingers as running, then thinking).
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:06') })], [{ sessionId: SID, reset: false, records: [rec.toolResult(t('12:00:06'), 'a')] }]));
  assert.equal(mainOf(tracker.snapshot(clock.now())).activity, 'running');
  assert.equal(mainOf(tracker.snapshot(t('12:00:15'))).activity, 'thinking');

  // Reset: old open call, title and prompt time are gone.
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:20') })], [{ sessionId: SID, reset: true, records: [
    rec.toolUse(t('12:00:08'), 'z', 'Read', { file_path: '/x/z.ts' }),
  ] }]));
  s = mainOf(tracker.snapshot(t('12:00:10')));
  assert.equal(s.activity, 'reading');
  assert.equal(s.detail, 'z.ts');
  assert.equal(s.lastPromptAt, undefined);
  assert.equal(s.title, 'demo-project');
  assert.equal(s.startedAt, started, 'startedAt is stable across a rewrite');

  // Reset with a batch that has no open tool clears the open call completely.
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:30') })], [{ sessionId: SID, reset: true, records: [rec.human(t('12:00:25')), rec.text(t('12:00:28'))] }]));
  s = mainOf(tracker.snapshot(t('12:00:31')));
  assert.equal(s.activity, 'idle');
});

// ---------------------------------------------------------------- thresholds

test('Edit/Write open more than 15 s means an approval prompt (needsYou)', () => {
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'e', 'Edit', { file_path: '/x/a.ts' })];
  for (const [at, want] of [['12:00:10', 'writing'], ['12:00:15.9', 'writing'], ['12:00:17', 'needsYou']] as const) {
    const s = run(recs, t(at));
    assert.equal(s.activity, want, at);
    assert.equal(s.detail, 'a.ts');
  }
  const waiting = run(recs, t('12:00:17'));
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.since, t('12:00:16'));
  for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) {
    const r = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'e', tool, { file_path: '/x/a.ts', notebook_path: '/x/a.ipynb' })];
    assert.equal(run(r, t('12:00:30')).activity, 'needsYou', tool);
  }
  // Busy and fresh live status: the call is just running slowly, not waiting for approval.
  const busy = run(recs, t('12:00:17'), { live: { pid: 1, alive: true, status: 'busy', statusUpdatedAt: t('12:00:12') } });
  assert.equal(busy.activity, 'writing');
  // Busy but stale status: still an approval prompt.
  const stale = run(recs, t('12:00:17'), { live: { pid: 1, alive: true, status: 'busy', statusUpdatedAt: t('11:50:00') } });
  assert.equal(stale.activity, 'needsYou');
  // Once the result arrives it is thinking again.
  const done = run([...recs, rec.toolResult(t('12:00:20'), 'e')], t('12:00:21'));
  assert.equal(done.activity, 'writing', 'the finished Edit lingers, it is no longer a prompt');
  assert.equal(run([...recs, rec.toolResult(t('12:00:20'), 'e')], t('12:00:29')).activity, 'thinking');
});

test('AskUserQuestion and ExitPlanMode need you after 4 s', () => {
  const ask = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'q', 'AskUserQuestion', { questions: [{ header: 'Pick', question: 'Which?' }] })];
  assert.equal(run(ask, t('12:00:04')).activity, 'thinking');
  const a = run(ask, t('12:00:06'));
  assert.equal(a.activity, 'needsYou');
  assert.equal(a.detail, 'Pick');
  assert.equal(a.since, t('12:00:05'));
  const plan = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'p', 'ExitPlanMode', { plan: 'x' })];
  assert.equal(run(plan, t('12:00:04')).activity, 'planning');
  assert.equal(run(plan, t('12:00:06')).activity, 'needsYou');
  assert.equal(run(plan, t('12:00:06')).status, 'waiting');
});

test('Bash is never needsYou from the 15 s rule, only from live status waiting', () => {
  const bash = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'b', 'Bash', { command: 'make', description: 'Compile' })];
  assert.equal(run(bash, t('12:00:10')).activity, 'running');
  assert.equal(run(bash, t('12:00:30')).activity, 'copier');
  assert.equal(run(bash, t('12:00:30')).detail, 'Compile');
  assert.equal(run(bash, t('12:30:00'), { live: { pid: 1, alive: true, status: 'busy', statusUpdatedAt: t('12:00:01') } }).activity, 'copier');
  const w = run(bash, t('12:00:30'), { live: { pid: 1, alive: true, status: 'waiting' } });
  assert.equal(w.activity, 'needsYou');
  assert.equal(w.status, 'waiting');
  assert.equal(w.detail, 'Compile');
});

test('live status waiting means needsYou; a dead pid is ignored', () => {
  const recs = [rec.human(t('12:00:00')), rec.thinking(t('12:00:02'))];
  const w = run(recs, t('12:00:05'), { live: { pid: 1, alive: true, status: 'waiting', statusUpdatedAt: t('12:00:04') } });
  assert.equal(w.activity, 'needsYou');
  assert.equal(w.status, 'waiting');
  const dead = run(recs, t('12:00:05'), { live: { pid: 1, alive: false, status: 'waiting' } });
  assert.equal(dead.activity, 'thinking');
});

test('live status idle ends a stale thinking state but not a newer prompt', () => {
  const recs = [rec.human(t('12:00:00')), rec.apiRequest(t('12:00:01')), rec.thinking(t('12:00:02'))];
  const idle = run(recs, t('12:00:10'), { live: { pid: 1, alive: true, status: 'idle', statusUpdatedAt: t('12:00:05') } });
  assert.equal(idle.activity, 'idle');
  assert.equal(idle.status, 'idle');
  const older = run(recs, t('12:00:10'), { live: { pid: 1, alive: true, status: 'idle', statusUpdatedAt: t('11:00:00') } });
  assert.equal(older.activity, 'thinking');
  // An open tool wins over live idle.
  const open = run([...recs, rec.toolUse(t('12:00:03'), 'r', 'Read', { file_path: '/a' })], t('12:00:10'), { live: { pid: 1, alive: true, status: 'idle', statusUpdatedAt: t('12:00:05') } });
  assert.equal(open.activity, 'reading');
});

test('stale session: 10 minutes without change and no live pid is idle', () => {
  const recs = [rec.human(t('12:00:00')), rec.thinking(t('12:00:02'))];
  assert.equal(run(recs, t('12:09:00')).activity, 'thinking');
  const idle = run(recs, t('12:12:03'));
  assert.equal(idle.activity, 'idle');
  assert.equal(idle.status, 'idle');
  assert.equal(idle.since, t('12:10:02'));
  assert.equal(run(recs, t('12:12:03'), { live: { pid: 1, alive: false, status: 'busy' } }).activity, 'idle');
  assert.equal(run(recs, t('12:12:03'), { live: { pid: 1, alive: true, status: 'busy', statusUpdatedAt: t('12:12:00') } }).activity, 'thinking');
  const open = [...recs, rec.toolUse(t('12:00:03'), 'r', 'Read', { file_path: '/a' })];
  assert.equal(run(open, t('12:12:03')).activity, 'idle');
});

test('end_turn, turn_duration and interrupts are idle; mid-turn text is thinking', () => {
  const base = [rec.human(t('12:00:00')), rec.apiRequest(t('12:00:01'))];
  assert.equal(run([...base, rec.text(t('12:00:03'), 'end_turn')], t('12:00:04')).activity, 'idle');
  assert.equal(run([...base, rec.text(t('12:00:03'), null)], t('12:00:04')).activity, 'thinking');
  assert.equal(run([...base, rec.text(t('12:00:03'), 'tool_use')], t('12:00:04')).activity, 'thinking');
  assert.equal(run([...base, rec.turnDuration(t('12:00:03'))], t('12:00:04')).activity, 'idle');
  const i = run([...base, rec.toolUse(t('12:00:02'), 'r', 'Bash', { command: 'x' }), rec.interrupt(t('12:00:03'))], t('12:00:30'));
  assert.equal(i.activity, 'idle');
  assert.equal(i.since, t('12:00:03'));
  // A new human prompt after idle starts thinking.
  const n = run([...base, rec.text(t('12:00:03')), rec.turnDuration(t('12:00:04')), rec.human(t('12:00:20'))], t('12:00:21'));
  assert.equal(n.activity, 'thinking');
  assert.equal(n.since, t('12:00:20'));
});

test('tool_use without a result is open until its tool_result arrives; parallel calls use the newest', () => {
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/a.ts' }), rec.toolUse(t('12:00:02'), 'b', 'Grep', { pattern: 'x' })];
  assert.equal(run(recs, t('12:00:03')).activity, 'searching');
  assert.equal(run([...recs, rec.toolResult(t('12:00:03'), 'b')], t('12:00:04')).activity, 'reading');
  // Both done: the most recently started tool (b) lingers, whichever result came last.
  assert.equal(run([...recs, rec.toolResult(t('12:00:03'), 'b'), rec.toolResult(t('12:00:03'), 'a')], t('12:00:04')).activity, 'searching');
  assert.equal(run([...recs, rec.toolResult(t('12:00:03'), 'b'), rec.toolResult(t('12:00:03'), 'a')], t('12:00:12')).activity, 'thinking');
});

test('Agent and Task calls are delegating', () => {
  const s = run([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'a', 'Agent', { description: 'Look around' })], t('12:00:03'));
  assert.equal(s.activity, 'delegating');
  assert.equal(s.detail, 'Look around');
});

// ---------------------------------------------------------------- lastPromptAt and titles

test('lastPromptAt follows human prompts only', () => {
  const recs: unknown[] = [
    rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/a' }), rec.toolResult(t('12:00:02'), 'a'),
    { type: 'user', timestamp: new Date(t('12:00:03')).toISOString(), isMeta: true, message: { role: 'user', content: 'meta text' } },
    { type: 'user', timestamp: new Date(t('12:00:04')).toISOString(), turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>x</task-notification>' } },
    { type: 'user', timestamp: new Date(t('12:00:05')).toISOString(), message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } },
    rec.interrupt(t('12:00:06')),
  ];
  const s = run(recs, t('12:00:10'));
  assert.equal(s.lastPromptAt, t('12:00:00'));
  // A typed prompt without turnOrigin (plain string) counts, a later human one replaces it.
  const s2 = run([...recs, { type: 'user', timestamp: new Date(t('12:00:07')).toISOString(), message: { role: 'user', content: 'plain prompt' } }], t('12:00:10'));
  assert.equal(s2.lastPromptAt, t('12:00:07'));
  assert.equal(s2.activity, 'thinking');
  const s3 = run([...recs, rec.human(t('12:00:08'))], t('12:00:10'));
  assert.equal(s3.lastPromptAt, t('12:00:08'));
  assert.equal(run([rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/a' })], t('12:00:02')).lastPromptAt, undefined);
});

test('title falls back from ai-title to live name to cwd folder to project dir', () => {
  const recs = [rec.human(t('12:00:00')), rec.text(t('12:00:01'))];
  const mk = (opts: Parameters<typeof session>[1], extra: unknown[] = []) => {
    const { tracker } = setup();
    tracker.apply(update([session(SID, { mtimeMs: t('12:00:01'), ...opts })], [{ sessionId: SID, reset: true, records: [...extra, ...recs] }]));
    return mainOf(tracker.snapshot(t('12:00:02')));
  };
  const live = { pid: 1, alive: true, status: 'idle', name: 'Live name' };
  assert.equal(mk({ live }, [rec.aiTitle('First'), rec.aiTitle('Latest')]).title, 'Latest');
  assert.equal(mk({ live }).title, 'Live name');
  assert.equal(mk({}).title, 'demo-project');
  assert.equal(mk({ cwd: undefined }).title, '-home-user-demo-project');
  assert.equal(mk({ cwd: undefined }).project, '-home-user-demo-project');
});

// ---------------------------------------------------------------- subagent lifecycle

function subSetup(extraSub: Partial<SubagentInfo> = {}) {
  const { clock, tracker } = setup('12:00:30');
  const sub: SubagentInfo = { agentId: 'ag1', path: '/x/agent-ag1.jsonl', mtimeMs: t('12:00:20'), meta: { description: 'Scout', agentType: 'Explore', finished: false }, ...extraSub };
  const subRecs = [rec.human(t('12:00:10'), 'go'), rec.thinking(t('12:00:11')), rec.toolUse(t('12:00:12'), 's1', 'Grep', { pattern: 'x' })];
  const feed = (extra: RecordBatch[] = [], listed: SubagentInfo[] = [sub], mainRecs: unknown[] = [rec.human(t('12:00:00')), rec.text(t('12:00:05'))]) => {
    tracker.apply(update([session(SID, { mtimeMs: t('12:00:20'), subagents: listed })], [{ sessionId: SID, reset: true, records: mainRecs }, ...extra]));
  };
  return { clock, tracker, sub, subRecs, feed };
}

test('temps appear from batches or from the session listing', () => {
  const { clock, tracker, subRecs, feed } = subSetup();
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: subRecs }]);
  let snaps = tracker.snapshot(clock.now());
  const temp = snaps.find((s) => s.kind === 'temp')!;
  assert.equal(temp.id, `${SID}/ag1`);
  assert.equal(temp.parentId, SID);
  assert.equal(temp.title, 'Scout');
  assert.equal(temp.activity, 'searching');
  assert.equal(temp.detail, '"x"');
  assert.equal(temp.startedAt, t('12:00:10'));
  assert.equal(temp.status, 'working');

  // Only listed (no records yet): present, idle, titled from meta.
  const fresh = new AgentTracker({ now: clock.now });
  fresh.apply(update([session(SID, { mtimeMs: t('12:00:20'), subagents: [{ agentId: 'ag2', path: '/p', mtimeMs: t('12:00:25'), meta: { agentType: 'Explore' } }] })]));
  snaps = fresh.snapshot(clock.now());
  assert.equal(snaps.length, 2);
  assert.equal(snaps[1]!.title, 'Explore');
  assert.equal(snaps[1]!.startedAt, clock.now());

  // A temp that disappears from the listing is removed; the main stays.
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:20'), subagents: [] })]));
  assert.equal(tracker.snapshot(clock.now()).filter((s) => s.kind === 'temp').length, 0);
});

test('temp finish signals: handback, meta.finished, parent notification, sidechain end_turn, 4 min idle', () => {
  const finishing = (name: string, setupFn: (ctx: ReturnType<typeof subSetup>) => void): void => {
    const ctx = subSetup();
    setupFn(ctx);
    const temp = ctx.tracker.snapshot(ctx.clock.now()).find((s) => s.kind === 'temp');
    assert.ok(temp, `${name}: shown as done first`);
    assert.equal(temp.status, 'done', name);
    assert.equal(ctx.tracker.snapshot(ctx.clock.now() + 9_900).some((s) => s.kind === 'temp'), true, `${name}: still there at 9.9 s`);
    assert.equal(ctx.tracker.snapshot(ctx.clock.now() + 10_000).some((s) => s.kind === 'temp'), false, `${name}: dropped at 10 s`);
  };
  finishing('handback', (c) => c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...c.subRecs, rec.toolUse(t('12:00:15'), 'h', 'SubagentHandback', { result: 'x' })] }]));
  finishing('meta.finished', (c) => c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: c.subRecs }], [{ ...c.sub, meta: { description: 'Scout', finished: true } }]));
  finishing('notification', (c) => c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: c.subRecs }], [c.sub], [rec.human(t('12:00:00')), rec.notification(t('12:00:25'), 'ag1')]));
  finishing('end_turn text', (c) => c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...c.subRecs, rec.toolResult(t('12:00:13'), 's1'), rec.text(t('12:00:14'), 'end_turn')] }]));
  finishing('4 min idle', (c) => {
    c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...c.subRecs, rec.toolResult(t('12:00:13'), 's1'), rec.text(t('12:00:14'), null)] }]);
    c.clock.set(t('12:04:30'));
    c.tracker.apply(update([session(SID, { mtimeMs: t('12:04:29'), subagents: [c.sub] })]));
  });

  // Not finished yet at 3 min 59 s; a null stop_reason is not a finish.
  const c = subSetup({ mtimeMs: t('12:00:20') });
  c.feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...c.subRecs, rec.toolResult(t('12:00:13'), 's1'), rec.text(t('12:00:14'), null)] }]);
  assert.equal(c.tracker.snapshot(t('12:04:19')).find((s) => s.kind === 'temp')!.status, 'working');
  assert.equal(c.tracker.snapshot(t('12:04:21')).find((s) => s.kind === 'temp')!.status, 'done');
});

test('an old finished temp (seen long after it ended) is not shown', () => {
  const { clock, tracker, sub, feed } = subSetup();
  clock.set(t('13:00:00'));
  feed([], [{ ...sub, meta: { description: 'Scout', finished: true } }]);
  assert.equal(tracker.snapshot(clock.now()).some((s) => s.kind === 'temp'), false);
});

test('sessions that are no longer listed disappear with their temps', () => {
  const { clock, tracker, subRecs, feed } = subSetup();
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: subRecs }]);
  assert.equal(tracker.snapshot(clock.now()).length, 2);
  tracker.apply(update([]));
  assert.deepEqual(tracker.snapshot(clock.now()), []);
  tracker.apply(update([session('other', { mtimeMs: t('12:00:20') })]));
  assert.deepEqual(tracker.snapshot(clock.now()).map((s) => s.id), ['other']);
});

// ---------------------------------------------------------------- robustness

test('mid-conversation first batches and garbage records are handled', () => {
  const garbage: unknown[] = [null, 7, 'x', [], {}, { type: 5 }, { type: 'user' }, { type: 'user', message: null }, { type: 'assistant', message: { content: 'str' } },
    { type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }, { type: 'tool_use', name: 5, id: 1 }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }, null] } }, { type: 'system' }, { type: 'queue-operation', content: 5 },
    { type: 'ai-title', aiTitle: 5 }, { type: 'assistant', timestamp: 'not a date', message: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } }];
  const { tracker } = setup('12:00:10');
  assert.doesNotThrow(() => tracker.apply(update([session(SID, { mtimeMs: t('12:00:05') })], [
    { sessionId: SID, reset: true, records: garbage },
    { sessionId: 'unknown', reset: false, records: [rec.human(t('12:00:00'))] },
    { sessionId: SID, agentId: 'nope', reset: false, records: undefined as unknown as unknown[] },
  ])));
  assert.equal(tracker.snapshot(t('12:00:11')).filter((s) => s.kind === 'main').length, 1);

  // First batch starts with tool_results whose tool_use was never seen.
  const s = run([rec.toolResult(t('12:00:01'), 'never-seen'), rec.apiRequest(t('12:00:02'))], t('12:00:03'));
  assert.equal(s.activity, 'thinking');
  assert.equal(s.startedAt, t('12:00:01'));
  // A tool_use whose result was before the cut is simply open.
  const o = run([rec.toolResult(t('12:00:01'), 'never-seen'), rec.toolUse(t('12:00:02'), 'n', 'WebSearch', { query: 'q' })], t('12:00:03'));
  assert.equal(o.activity, 'researching');
});

test('compact summary and meta user entries do not count as the next prompt', () => {
  const recs = [rec.human(t('12:00:00')), rec.text(t('12:00:02')), rec.compact(t('12:00:03')),
    { type: 'user', timestamp: new Date(t('12:00:04')).toISOString(), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued...' } }];
  const s = run(recs, t('12:00:10'));
  assert.equal(s.activity, 'shredding');
  assert.equal(s.lastPromptAt, t('12:00:00'));
  assert.equal(run(recs, t('12:02:00')).activity, 'idle');
});

test('startedAt falls back to the first time the agent was seen', () => {
  const { clock, tracker } = setup('12:00:07');
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:00') })], [{ sessionId: SID, reset: true, records: [{ type: 'ai-title', aiTitle: 'T' }] }]));
  clock.set(t('12:00:09'));
  assert.equal(mainOf(tracker.snapshot(clock.now())).startedAt, t('12:00:07'));
});

test('open tool bookkeeping stays bounded', () => {
  const recs: unknown[] = [rec.human(t('12:00:00'))];
  for (let i = 0; i < 500; i++) recs.push(rec.toolUse(t('12:00:01') + i, `id${i}`, 'Read', { file_path: '/a' }));
  const s = run(recs, t('12:00:05'));
  assert.equal(s.activity, 'reading');
});

// ---------------------------------------------------------------- lingering tools

test('a tool whose result arrives 15 ms later is still shown 200 ms after that', () => {
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'r', 'Read', { file_path: '/p/src/app.ts' }), rec.toolResult(t('12:00:01.015'), 'r')];
  const s = run(recs, t('12:00:01.215'));
  assert.equal(s.activity, 'reading');
  assert.equal(s.detail, 'app.ts');
  assert.equal(s.since, t('12:00:01'));
  assert.equal(s.status, 'working');
});

test('the linger ends 8 s after the result and falls back to thinking', () => {
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'g', 'Grep', { pattern: 'foo' }), rec.toolResult(t('12:00:02'), 'g'), rec.apiRequest(t('12:00:03'))];
  assert.equal(LINGER_MS, 8000);
  const before = run(recs, t('12:00:09.9'));
  assert.equal(before.activity, 'searching');
  assert.equal(before.detail, '"foo"');
  const after = run(recs, t('12:00:10'));
  assert.equal(after.activity, 'thinking');
  assert.equal(after.detail, undefined);
  assert.equal(after.since, t('12:00:10'));
});

test('lingering stops at a new tool, a prompt, the end of the turn, an interrupt or a compaction', () => {
  const base = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/a.ts' }), rec.toolResult(t('12:00:02'), 'a')];
  const at = t('12:00:04');
  assert.equal(run(base, at).activity, 'reading');
  assert.equal(run([...base, rec.toolUse(t('12:00:03'), 'b', 'Bash', { command: 'ls' })], at).activity, 'running');
  assert.equal(run([...base, rec.human(t('12:00:03'))], at).activity, 'thinking');
  assert.equal(run([...base, rec.text(t('12:00:03'), 'end_turn')], at).activity, 'idle');
  assert.equal(run([...base, rec.turnDuration(t('12:00:03'))], at).activity, 'idle');
  assert.equal(run([...base, rec.interrupt(t('12:00:03'))], at).activity, 'idle');
  assert.equal(run([...base, rec.compact(t('12:00:03'))], at).activity, 'shredding');
  // Mid-turn text and thinking do not end it.
  assert.equal(run([...base, rec.text(t('12:00:03'), 'tool_use'), rec.thinking(t('12:00:03.500'))], at).activity, 'reading');
  // needsYou rules still win: live waiting.
  assert.equal(run(base, at, { live: { pid: 1, alive: true, status: 'waiting' } }).activity, 'needsYou');
});

test('two consecutive Reads keep one since but update the detail', () => {
  const { clock, tracker } = setup('12:00:03');
  const feed = (records: unknown[]): void => tracker.apply(update([session(SID, { mtimeMs: clock.now() })], [{ sessionId: SID, reset: false, records }]));
  feed([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'a', 'Read', { file_path: '/p/one.ts' }), rec.toolResult(t('12:00:02'), 'a')]);
  let s = mainOf(tracker.snapshot(clock.now()));
  assert.deepEqual([s.activity, s.detail, s.since], ['reading', 'one.ts', t('12:00:01')]);
  clock.set(t('12:00:06'));
  feed([rec.toolUse(t('12:00:05'), 'b', 'Read', { file_path: '/p/two.ts' })]);
  s = mainOf(tracker.snapshot(clock.now()));
  assert.deepEqual([s.activity, s.detail, s.since], ['reading', 'two.ts', t('12:00:01')]);
  clock.set(t('12:00:07'));
  feed([rec.toolResult(t('12:00:06'), 'b')]);
  s = mainOf(tracker.snapshot(clock.now()));
  assert.deepEqual([s.activity, s.detail, s.since], ['reading', 'two.ts', t('12:00:01')]);
});

test('a background Agent launch lingers as delegating', () => {
  const recs = [
    rec.human(t('12:00:00')),
    rec.toolUse(t('12:00:01'), 'ag', 'Agent', { description: 'Research bundlers', subagent_type: 'general-purpose' }),
    rec.toolResult(t('12:00:01.013'), 'ag'),
    rec.apiRequest(t('12:00:02')),
  ];
  const s = run(recs, t('12:00:05'));
  assert.equal(s.activity, 'delegating');
  assert.equal(s.detail, 'Research bundlers');
  assert.equal(s.since, t('12:00:01'));
  assert.equal(run(recs, t('12:00:12')).activity, 'thinking');
});

test('a quick Bash lingers as running; a long one that finishes keeps the same running label', () => {
  const quick = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'b', 'Bash', { command: 'ls', description: 'List' }), rec.toolResult(t('12:00:01.050'), 'b')];
  const s = run(quick, t('12:00:03'));
  assert.equal(s.activity, 'running');
  assert.equal(s.detail, 'List');
  const long = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'b', 'Bash', { command: 'make' })];
  assert.equal(run(long, t('12:00:40')).activity, 'copier');
  assert.equal(run([...long, rec.toolResult(t('12:00:41'), 'b')], t('12:00:42')).activity, 'running');
});

test('an answered AskUserQuestion does not linger as needsYou', () => {
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'q', 'AskUserQuestion', { questions: [{ header: 'H' }] }), rec.toolResult(t('12:00:20'), 'q')];
  assert.equal(run(recs, t('12:00:21')).activity, 'thinking');
});

test('temps linger their tools too', () => {
  const { clock, tracker, sub, feed } = subSetup();
  const recs = [rec.human(t('12:00:10'), 'go'), rec.toolUse(t('12:00:12'), 's1', 'Read', { file_path: '/x/a.ts' }), rec.toolResult(t('12:00:12.010'), 's1')];
  clock.set(t('12:00:14'));
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: recs }], [{ ...sub, mtimeMs: t('12:00:12') }]);
  const temp = tracker.snapshot(clock.now()).find((x) => x.kind === 'temp')!;
  assert.equal(temp.activity, 'reading');
  assert.equal(temp.since, t('12:00:12'));
  assert.equal(tracker.snapshot(t('12:00:21')).find((x) => x.kind === 'temp')!.activity, 'thinking');
});

// ---------------------------------------------------------------- temp lifecycle: open tools, revival, status

const BASH_SUB = (): unknown[] => [rec.human(t('12:00:10'), 'go'), rec.toolUse(t('12:00:12'), 'b1', 'Bash', { command: 'render.sh', description: 'Render audio' })];

function notice(ms: number, agentId: string, status: string): unknown {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: new Date(ms).toISOString(), content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n</task-notification>` };
}

function tempOf(tracker: AgentTracker, at: number): AgentSnapshot | undefined {
  return tracker.snapshot(at).find((s) => s.kind === 'temp');
}

test('a temp with an open Bash survives 6 min of silence and shows the copier', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }]);
  clock.set(t('12:06:12'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:06:00'), subagents: [sub] })]));
  const temp = tempOf(tracker, clock.now())!;
  assert.equal(temp.status, 'working');
  assert.equal(temp.activity, 'copier');
  assert.equal(temp.detail, 'Render audio');
});

test('a temp with an open Bash finishes on meta.finished', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }]);
  clock.set(t('12:06:12'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:06:00'), subagents: [{ ...sub, mtimeMs: t('12:06:05'), meta: { description: 'Scout', finished: true } }] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
});

test('a temp with an open Bash finishes when the parent process is gone', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }]);
  clock.set(t('12:06:12'));
  const live: LiveStatus = { pid: 1, alive: false, status: 'busy' };
  tracker.apply(update([session(SID, { mtimeMs: t('12:06:00'), subagents: [sub], live })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
});

test('a temp with an open Bash finishes after TEMP_OPEN_TOOL_STALE_MS', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }]);
  const lastChange = t('12:00:12');
  clock.set(lastChange + TEMP_OPEN_TOOL_STALE_MS - 1_000);
  tracker.apply(update([session(SID, { mtimeMs: lastChange, subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'working');
  clock.set(lastChange + TEMP_OPEN_TOOL_STALE_MS + 1_000);
  tracker.apply(update([session(SID, { mtimeMs: lastChange, subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
});

test('a temp with an open Bash still finishes on handback, notification and end_turn', () => {
  const sig = (name: string, extra: unknown[], main: unknown[] = [rec.human(t('12:00:00'))]): void => {
    const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
    feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...BASH_SUB(), ...extra] }], [sub], main);
    assert.equal(tempOf(tracker, clock.now())!.status, 'done', name);
  };
  sig('handback', [rec.toolUse(t('12:00:13'), 'h', 'SubagentHandback', { result: 'x' })]);
  sig('notification', [], [rec.human(t('12:00:00')), notice(t('12:00:25'), 'ag1', 'completed')]);
  sig('end_turn', [rec.text(t('12:00:14'), 'end_turn')]);
});

test('a temp with no open tool still finishes after 4 min of silence', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:14') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [...BASH_SUB(), rec.toolResult(t('12:00:13'), 'b1'), rec.text(t('12:00:14'), null)] }], [sub]);
  clock.set(t('12:04:13'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:14'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'working');
  clock.set(t('12:04:15'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:14'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
});

test('a temp finished by silence and dropped comes back when newer records arrive', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:14') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: [rec.human(t('12:00:10')), rec.text(t('12:00:14'), null)] }], [sub]);
  clock.set(t('12:04:30'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:14'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
  clock.set(t('12:04:45'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:14'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now()), undefined, 'dropped');
  // Not revived by the unchanged listing.
  clock.set(t('12:05:00'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:14'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now()), undefined, 'still dropped');
  // New records with later timestamps.
  clock.set(t('12:06:00'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:05:58'), subagents: [{ ...sub, mtimeMs: t('12:05:58') }] })], [
    { sessionId: SID, agentId: 'ag1', reset: false, records: [rec.human(t('12:05:55'), 'again'), rec.toolUse(t('12:05:58'), 'g1', 'Grep', { pattern: 'y' })] },
  ]));
  const temp = tempOf(tracker, clock.now())!;
  assert.equal(temp.kind, 'temp');
  assert.equal(temp.status, 'working');
  assert.equal(temp.activity, 'searching');
});

test('a temp finished by a stopped notification is done and revives when its transcript grows', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  const main = [rec.human(t('12:00:00')), notice(t('12:00:30'), 'ag1', 'stopped')];
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }], [sub], main);
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
  clock.set(t('12:00:45'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:30'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now()), undefined, 'dropped');
  // Resumed later: newer records. The old notification must not finish it again.
  clock.set(t('12:10:00'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:09:58'), subagents: [{ ...sub, mtimeMs: t('12:09:58') }] })], [
    { sessionId: SID, agentId: 'ag1', reset: false, records: [rec.human(t('12:09:50'), 'resume'), rec.thinking(t('12:09:58'))] },
  ]));
  const temp = tempOf(tracker, clock.now())!;
  assert.equal(temp.status, 'working');
  // A fresh notification for the resumed run finishes it again.
  clock.set(t('12:10:20'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:09:58'), subagents: [{ ...sub, mtimeMs: t('12:09:58') }] })], [
    { sessionId: SID, reset: false, records: [notice(t('12:10:15'), 'ag1', 'completed')] },
  ]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
});

test('a revival by a newer listed mtime alone also works', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('12:00:12') });
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: BASH_SUB() }], [sub], [rec.human(t('12:00:00')), notice(t('12:00:30'), 'ag1', 'killed')]);
  assert.equal(tempOf(tracker, clock.now())!.status, 'done');
  clock.set(t('12:01:00'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:30'), subagents: [sub] })]));
  assert.equal(tempOf(tracker, clock.now()), undefined);
  clock.set(t('12:05:00'));
  tracker.apply(update([session(SID, { mtimeMs: t('12:04:58'), subagents: [{ ...sub, mtimeMs: t('12:04:58') }] })]));
  assert.equal(tempOf(tracker, clock.now())!.status, 'working');
});

test('startup: a subagent that handed back long ago does not flash up, and stays gone', () => {
  const { clock, tracker, sub, feed } = subSetup({ mtimeMs: t('11:00:20') });
  clock.set(t('12:00:00'));
  const recs = [rec.human(t('11:00:10')), rec.toolUse(t('11:00:15'), 'h', 'SubagentHandback', { result: 'x' }), rec.toolResult(t('11:00:16'), 'h')];
  feed([{ sessionId: SID, agentId: 'ag1', reset: true, records: recs }], [{ ...sub, mtimeMs: t('11:00:20') }]);
  assert.equal(tempOf(tracker, clock.now()), undefined);
  clock.set(t('12:00:10'));
  tracker.apply(update([session(SID, { mtimeMs: t('11:00:20'), subagents: [{ ...sub, mtimeMs: t('11:00:20') }] })]));
  assert.equal(tempOf(tracker, clock.now()), undefined);
});

// ---------------------------------------------------------------- per-session facts (model, effort, context, cost, report, plans)

const OPUS = { model: 'claude-opus-5-5' };
const usage = (input: number, cacheCreate = 0, cacheRead = 0, output = 0): Record<string, number> => ({
  input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: output,
});

/** A tracker fed `records` as the main session SID, plus a helper to feed more later. */
function factsSetup(records: unknown[], opts: { learned?: Map<string, number>; officeInfo?: OfficeInfoLookup } = {}) {
  const clock = makeClock(t('14:10:00'));
  const tracker = new AgentTracker({ now: clock.now, ...(opts.learned === undefined ? {} : { learnedWindows: opts.learned }), ...(opts.officeInfo === undefined ? {} : { officeInfo: opts.officeInfo }) });
  const feed = (recs: unknown[], reset = false): void => {
    tracker.apply(update([session(SID, { mtimeMs: lastTimestamp(recs) || t('14:00:00') })], [{ sessionId: SID, reset, records: recs }]));
  };
  feed(records, true);
  return { clock, tracker, feed, main: (): AgentSnapshot => mainOf(tracker.snapshot(clock.now())) };
}

test('facts fixture: model skips <synthetic>, effort, context, cost, report, plans', () => {
  const { records } = { records: loadJsonl(join(FACT_FIXTURES, 'facts-main.jsonl')) };
  const { main } = factsSetup(records);
  const s = main();
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'xhigh');
  // The newest assistant usage with tokens: 9 + 100 + 41500 (output_tokens excluded, zeros of the synthetic record skipped).
  assert.deepEqual(s.context, { tokens: 41_609, max: 200_000, pct: 21, approx: true });
  assert.equal(s.costUsd, 0.75);
  assert.deepEqual(s.lastReport, { at: t('14:01:50'), text: 'FINAL REPORT TWO' });
  assert.deepEqual(s.plans, [
    { id: 'toolu_P1', at: t('14:01:05'), title: 'Plan A: PLACEHOLDER TITLE', status: 'approved', chars: 52, decidedAt: t('14:01:20') },
    { id: 'toolu_P2', at: t('14:01:30'), title: 'Plan B: PLACEHOLDER TITLE', status: 'rejected', chars: 35, decidedAt: t('14:01:40') },
  ]);
  assert.equal(s.activity, 'idle');
});

test('facts fixture: planText returns text, path and feedback; snapshots carry no text', () => {
  const { tracker, main } = factsSetup(loadJsonl(join(FACT_FIXTURES, 'facts-main.jsonl')));
  const a = tracker.planText(SID, 'toolu_P1');
  assert.deepEqual(a, { text: '# Plan A: PLACEHOLDER TITLE\n\n1. step one\n2. step two', truncated: false, status: 'approved', planFilePath: '/home/user/.claude/plans/plan-a.md' });
  const b = tracker.planText(SID, 'toolu_P2');
  assert.equal(b?.status, 'rejected');
  assert.equal(b?.feedback, 'FEEDBACK PLACEHOLDER');
  assert.equal(tracker.planText(SID, 'nope'), undefined);
  assert.equal(tracker.planText('other-session', 'toolu_P1'), undefined);
  assert.equal(JSON.stringify(main()).includes('step one'), false);
});

test('facts fixture: the first turn alone reports its end_turn text, not the mid-turn text', () => {
  const records = loadJsonl(join(FACT_FIXTURES, 'facts-main.jsonl')).slice(0, 8);
  const s = factsSetup(records).main();
  assert.deepEqual(s.lastReport, { at: t('14:00:06'), text: 'FINAL REPORT ONE' });
  assert.deepEqual(s.context, { tokens: 32_512, max: 200_000, pct: 16, approx: true });
  assert.equal(s.effort, 'high');
  assert.equal(s.costUsd, 0.5);
  assert.equal(s.plans, undefined);
});

test('model: the newest assistant model wins and <synthetic> is skipped', () => {
  const s = run([
    rec.human(t('14:00:00')),
    rec.assistant(t('14:00:01'), { model: 'claude-haiku-5-5', usage: usage(1, 0, 1000) }),
    rec.assistant(t('14:00:02'), { model: 'claude-opus-5-5', usage: usage(1, 0, 3000) }),
    rec.assistant(t('14:00:03'), { model: '<synthetic>', text: 'No response requested.', usage: usage(0) }),
  ], t('14:00:04'));
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.context?.tokens, 3001);
});

test('model: absent when no assistant record carries one', () => {
  const s = run([rec.human(t('14:00:00')), rec.text(t('14:00:01'))], t('14:00:02'));
  assert.equal(s.model, undefined);
  assert.equal(s.context, undefined);
  assert.equal(s.effort, undefined);
  assert.equal(s.costUsd, undefined);
  assert.equal(s.plans, undefined);
});

test('effort: kept for the five levels, anything else dropped (the previous value stays)', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: level })], t('14:00:02')).effort, level);
  }
  assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'turbo' })], t('14:00:02')).effort, undefined);
  assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: 7 })], t('14:00:02')).effort, undefined);
  assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: null })], t('14:00:02')).effort, undefined);
  const kept = run([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'low' }), rec.assistant(t('14:00:02'), { ...OPUS, effort: 'turbo' }), rec.assistant(t('14:00:03'), { ...OPUS })], t('14:00:04'));
  assert.equal(kept.effort, 'low');
  // perTurnEffort is the fallback when `effort` is null or invalid.
  assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: null, perTurnEffort: 'max' })], t('14:00:02')).effort, 'max');
  // A newer valid value replaces the old one.
  assert.equal(run([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'low' }), rec.assistant(t('14:00:02'), { ...OPUS, effort: 'high' })], t('14:00:03')).effort, 'high');
});

test('effort: a placeholder (<synthetic>) record does not change it', () => {
  const s = run([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'low' }), rec.assistant(t('14:00:02'), { model: '<synthetic>', effort: 'max', text: 'x' })], t('14:00:03'));
  assert.equal(s.effort, 'low');
});

test('effort: an office run effort overrides the transcript while the lookup reports it', () => {
  const { main } = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'low' })], { officeInfo: () => ({ effort: 'max' }) });
  assert.equal(main().effort, 'max');
  const bad = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, effort: 'low' })], { officeInfo: () => ({ effort: 'bogus' as never }) });
  assert.equal(bad.main().effort, 'low');
});

test('model: an office run model overrides the transcript while the lookup reports it, then the transcript returns', () => {
  let live: string | undefined = 'claude-sonnet-5-5';
  const { main } = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS })], { officeInfo: () => (live === undefined ? undefined : { model: live }) });
  assert.equal(main().model, 'claude-sonnet-5-5');
  live = '';
  assert.equal(main().model, 'claude-opus-5-5'); // an empty string is not a model
  live = undefined;
  assert.equal(main().model, 'claude-opus-5-5');
});

test('model: an office run model is shown even before the transcript has an assistant record', () => {
  const { main } = factsSetup([rec.human(t('14:00:00'))], { officeInfo: () => ({ model: 'claude-opus-5-5[1m]' }) });
  assert.equal(main().model, 'claude-opus-5-5[1m]');
});

test('context: an office run context overrides the transcript while reported, field by field, and the transcript returns after', () => {
  let live: { tokens: number; max: number; pct: number; approx?: boolean } | undefined = { tokens: 150_000, max: 1_000_000, pct: 15 };
  const { main } = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 100_000) })], { officeInfo: () => (live === undefined ? undefined : { context: live }) });
  assert.deepEqual(main().context, { tokens: 150_000, max: 1_000_000, pct: 15 });
  live = { tokens: 10, max: 200_000, pct: 0, approx: true };
  assert.deepEqual(main().context, { tokens: 10, max: 200_000, pct: 0, approx: true });
  live = undefined;
  assert.deepEqual(main().context, { tokens: 100_000, max: 200_000, pct: 50, approx: true });
});

test('context: an office run context with no transcript figure is shown, and extra or malformed fields are not copied', () => {
  const extra = { tokens: 5, max: 200_000, pct: 0, secret: 'x' } as never;
  const a = factsSetup([rec.human(t('14:00:00'))], { officeInfo: () => ({ context: extra }) });
  assert.deepEqual(a.main().context, { tokens: 5, max: 200_000, pct: 0 });
  for (const bad of [{ tokens: -1, max: 10, pct: 0 }, { tokens: 1, max: 0, pct: 0 }, { tokens: Number.NaN, max: 10, pct: 0 }, { tokens: 1, max: 10, pct: 'x' }, 'nope', null]) {
    const b = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 100_000) })], { officeInfo: () => ({ context: bad as never }) });
    assert.deepEqual(b.main().context, { tokens: 100_000, max: 200_000, pct: 50, approx: true }, 'falls back to the transcript');
  }
});

test('context: tokens are input + cache read + cache creation, output excluded', () => {
  const s = run([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(100, 2_000, 30_000, 99_999) })], t('14:00:02'));
  assert.deepEqual(s.context, { tokens: 32_100, max: 200_000, pct: 16, approx: true });
});

test('context: pct rounds, and a guessed window grows when exceeded', () => {
  const half = run([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 100_001) })], t('14:00:02'));
  assert.equal(half.context?.pct, 50);
  const over = run([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 450_000) })], t('14:00:02'));
  assert.deepEqual(over.context, { tokens: 450_000, max: 1_000_000, pct: 45, approx: true });
});

test('context: the guessed window is 200k up to 200,000 tokens and 1M (approx) above', () => {
  const at = (n: number): AgentSnapshot['context'] => run([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, n) })], t('14:00:02')).context;
  assert.deepEqual(at(199_999), { tokens: 199_999, max: 200_000, pct: 100, approx: true });
  assert.deepEqual(at(250_000), { tokens: 250_000, max: 1_000_000, pct: 25, approx: true });
});

test('context: a learned 200k window is kept (and clamped) above 200,000 tokens', () => {
  const learned = new Map([['claude-opus-5-5', 200_000]]);
  const { main } = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 250_000) })], { learned });
  assert.deepEqual(main().context, { tokens: 250_000, max: 200_000, pct: 100 });
});

test('context: a [1m] model has a 1,000,000 window and no approx', () => {
  const s = run([rec.assistant(t('14:00:01'), { model: 'claude-opus-5-5[1m]', usage: usage(10, 0, 249_990) })], t('14:00:02'));
  assert.deepEqual(s.context, { tokens: 250_000, max: 1_000_000, pct: 25 });
});

test('context: a learned window applies at once, also to sessions already tracked', () => {
  const learned = new Map<string, number>();
  const { main, tracker, clock } = factsSetup([rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(0, 0, 100_000) })], { learned });
  assert.deepEqual(main().context, { tokens: 100_000, max: 200_000, pct: 50, approx: true });
  learned.set('claude-opus-5-5', 1_000_000);
  assert.deepEqual(mainOf(tracker.snapshot(clock.now())).context, { tokens: 100_000, max: 1_000_000, pct: 10 });
});

test('context: records without usable usage leave the last figure alone', () => {
  const s = run([
    rec.assistant(t('14:00:01'), { ...OPUS, usage: usage(5, 0, 1000) }),
    rec.assistant(t('14:00:02'), { ...OPUS }),
    rec.assistant(t('14:00:03'), { ...OPUS, usage: usage(0) }),
  ], t('14:00:04'));
  assert.equal(s.context?.tokens, 1005);
});

test('cost-state: the newest record wins; garbage is ignored', () => {
  const s = run([rec.costState(0.1), rec.human(t('14:00:00')), rec.costState(0.25), { type: 'cost-state', totalCostUSD: 'lots' }, { type: 'cost-state', totalCostUSD: -1 }], t('14:00:01'));
  assert.equal(s.costUsd, 0.25);
});

test('cost: an office run figure overrides the cost-state while reported, and the transcript figure returns after', () => {
  let live: number | undefined = 1.5;
  const { main, feed } = factsSetup([rec.costState(0.25)], { officeInfo: () => (live === undefined ? undefined : { costUsd: live }) });
  assert.equal(main().costUsd, 1.5);
  live = undefined;
  assert.equal(main().costUsd, 0.25);
  feed([rec.costState(0.5)]);
  assert.equal(main().costUsd, 0.5);
});

test('lastReport: not set mid-turn, set at end_turn, replaced at the next turn end', () => {
  const { main, feed } = factsSetup([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'thinking out loud', stop: null })]);
  assert.equal(main().lastReport, undefined);
  feed([rec.assistant(t('14:00:02'), { ...OPUS, tool: { id: 'a', name: 'Read' } })]);
  assert.equal(main().lastReport, undefined);
  feed([rec.toolResult(t('14:00:03'), 'a'), rec.assistant(t('14:00:04'), { ...OPUS, text: 'all done', stop: 'end_turn' })]);
  assert.deepEqual(main().lastReport, { at: t('14:00:04'), text: 'all done' });
  // The next turn: the old report stays until the new turn ends.
  feed([rec.human(t('14:01:00')), rec.assistant(t('14:01:01'), { ...OPUS, text: 'second turn, partway', stop: null })]);
  assert.deepEqual(main().lastReport, { at: t('14:00:04'), text: 'all done' });
  feed([rec.assistant(t('14:01:02'), { ...OPUS, text: 'second report', stop: 'end_turn' })]);
  assert.deepEqual(main().lastReport, { at: t('14:01:02'), text: 'second report' });
});

test('lastReport: the turn-duration entry ends a turn whose final text had no end stop_reason', () => {
  const { main, feed } = factsSetup([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'streamed final text', stop: null })]);
  assert.equal(main().lastReport, undefined);
  feed([rec.turnDuration(t('14:00:02'))]);
  assert.deepEqual(main().lastReport, { at: t('14:00:02'), text: 'streamed final text' });
  // A second turn_duration with nothing new does not rewrite it.
  feed([rec.turnDuration(t('14:00:09'))]);
  assert.equal(main().lastReport?.at, t('14:00:02'));
});

test('lastReport: text before a tool call, an interrupt or a new prompt is never a report', () => {
  const toolFirst = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'let me look', stop: null }), rec.assistant(t('14:00:02'), { ...OPUS, tool: { id: 'a', name: 'Read' } }), rec.toolResult(t('14:00:03'), 'a'), rec.turnDuration(t('14:00:04'))], t('14:00:05'));
  assert.equal(toolFirst.lastReport, undefined);
  const interrupted = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'partway', stop: null }), rec.interrupt(t('14:00:02')), rec.turnDuration(t('14:00:03'))], t('14:00:04'));
  assert.equal(interrupted.lastReport, undefined);
  const prompted = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'partway', stop: null }), rec.human(t('14:00:02'), 'next'), rec.turnDuration(t('14:00:03'))], t('14:00:04'));
  assert.equal(prompted.lastReport, undefined);
});

test('lastReport: synthetic placeholder text and empty text are not reports', () => {
  const s = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { model: '<synthetic>', text: 'No response requested.', stop: 'stop_sequence' }), rec.assistant(t('14:00:02'), { ...OPUS, text: '   ', stop: 'end_turn' })], t('14:00:03'));
  assert.equal(s.lastReport, undefined);
});

test('lastReport: capped at LIMITS.reportChars with truncated: true; exact fit is not truncated', () => {
  const long = 'w'.repeat(LIMITS.reportChars + 250);
  const cut = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: long, stop: 'end_turn' })], t('14:00:02'));
  assert.equal(cut.lastReport?.text.length, LIMITS.reportChars);
  assert.equal(cut.lastReport?.truncated, true);
  const exact = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'e'.repeat(LIMITS.reportChars), stop: 'end_turn' })], t('14:00:02'));
  assert.equal(exact.lastReport?.text.length, LIMITS.reportChars);
  assert.equal('truncated' in exact.lastReport!, false);
  // Never ends in half a surrogate pair.
  const emoji = run([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, text: 'a'.repeat(LIMITS.reportChars - 1) + '\u{1F600}', stop: 'end_turn' })], t('14:00:02'));
  assert.equal(emoji.lastReport?.text.length, LIMITS.reportChars - 1);
  assert.equal(emoji.lastReport?.truncated, true);
});

test('plans: approved, rejected with feedback, and superseded (synthetic records)', () => {
  const s = run([
    rec.human(t('14:00:00')),
    rec.exitPlan(t('14:00:01'), 'p1', '# First plan\nbody', '/plans/one.md'),
    rec.planApproved(t('14:00:10'), 'p1'),
    rec.exitPlan(t('14:00:20'), 'p2', '# Second plan'),
    rec.planRejected(t('14:00:30'), 'p2', 'try again'),
    rec.exitPlan(t('14:00:40'), 'p3', '# Third plan'),
    rec.exitPlan(t('14:00:50'), 'p4', '# Fourth plan'),
  ], t('14:01:00'));
  assert.deepEqual(s.plans?.map((p) => [p.id, p.title, p.status, p.decidedAt]), [
    ['p1', 'First plan', 'approved', t('14:00:10')],
    ['p2', 'Second plan', 'rejected', t('14:00:30')],
    ['p3', 'Third plan', 'superseded', t('14:00:50')],
    ['p4', 'Fourth plan', 'pending', undefined],
  ]);
  assert.equal(s.plans?.[0]?.chars, '# First plan\nbody'.length);
});

test('plans: a plain rejection and an approval with the text only in toolUseResult', () => {
  const { tracker, main } = factsSetup([
    rec.exitPlan(t('14:00:01'), 'p1'),
    rec.planApproved(t('14:00:02'), 'p1', '# Text from result', '/plans/x.md'),
    rec.exitPlan(t('14:00:03'), 'p2', '# B'),
    rec.planRejected(t('14:00:04'), 'p2'),
  ]);
  const plans = main().plans!;
  assert.equal(plans[0]!.title, 'Text from result');
  assert.equal(plans[0]!.status, 'approved');
  assert.equal(plans[1]!.status, 'rejected');
  assert.deepEqual(tracker.planText(SID, 'p1'), { text: '# Text from result', truncated: false, status: 'approved', planFilePath: '/plans/x.md' });
  assert.equal(tracker.planText(SID, 'p2')!.feedback, undefined);
});

test('plans: 5 newest kept, text only for the 3 newest', () => {
  const recs: unknown[] = [rec.human(t('14:00:00'))];
  for (let i = 1; i <= 7; i++) recs.push(rec.exitPlan(t('14:00:00') + i * 1000, `p${i}`, `# Plan ${i}`), rec.planApproved(t('14:00:00') + i * 1000 + 500, `p${i}`));
  const { tracker, main } = factsSetup(recs);
  assert.deepEqual(main().plans?.map((p) => p.id), ['p3', 'p4', 'p5', 'p6', 'p7']);
  assert.equal(tracker.planText(SID, 'p4'), undefined);
  assert.equal(tracker.planText(SID, 'p5')?.text, '# Plan 5');
  assert.equal(tracker.planText(SID, 'p7')?.text, '# Plan 7');
});

test('plans: a rewritten transcript (reset) starts the facts over', () => {
  const { main, feed } = factsSetup([rec.exitPlan(t('14:00:01'), 'p1', '# Old'), rec.assistant(t('14:00:02'), { ...OPUS, effort: 'low', usage: usage(1, 0, 10) }), rec.costState(3)]);
  assert.equal(main().plans?.length, 1);
  feed([rec.human(t('14:05:00'))], true);
  const s = main();
  assert.equal(s.plans, undefined);
  assert.equal(s.model, undefined);
  assert.equal(s.effort, undefined);
  assert.equal(s.context, undefined);
  assert.equal(s.costUsd, undefined);
});

test('temp (subagent) transcript: model, effort and context are read; no report, cost or plans', () => {
  const sub: SubagentInfo = { agentId: 'ag1', path: '/x/agent-ag1.jsonl', mtimeMs: t('14:00:15'), meta: { agentType: 'Explore', description: 'Look around' } };
  const clock = makeClock(t('14:00:20'));
  const tracker = new AgentTracker({ now: clock.now });
  tracker.apply(update([session(SID, { mtimeMs: t('14:00:15'), subagents: [sub] })], [
    { sessionId: SID, reset: true, records: [rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, effort: 'high', usage: usage(1, 0, 20_000) })] },
    { sessionId: SID, agentId: 'ag1', reset: true, records: loadJsonl(join(FACT_FIXTURES, 'facts-temp.jsonl')) },
  ]));
  const snaps = tracker.snapshot(clock.now());
  const temp = snaps.find((x) => x.kind === 'temp')!;
  assert.equal(temp.model, 'claude-haiku-5-5');
  assert.equal(temp.effort, 'low');
  assert.deepEqual(temp.context, { tokens: 5_206, max: 200_000, pct: 3, approx: true });
  assert.equal(temp.lastReport, undefined);
  assert.equal(temp.costUsd, undefined);
  assert.equal(temp.plans, undefined);
  // The parent keeps its own facts.
  const parent = mainOf(snaps);
  assert.equal(parent.model, 'claude-opus-5-5');
  assert.equal(parent.effort, 'high');
  assert.equal(parent.context?.tokens, 20_001);
});

test('change detection: serialised snapshots are stable between polls and change only with the new facts', () => {
  const learned = new Map<string, number>();
  const { clock, tracker, feed } = factsSetup([rec.human(t('14:00:00')), rec.assistant(t('14:00:01'), { ...OPUS, effort: 'high', usage: usage(1, 0, 1000), text: 'done', stop: 'end_turn' }), rec.turnDuration(t('14:00:02')), rec.costState(1)], { learned });
  const key = (): string => JSON.stringify(tracker.snapshot(clock.now()));
  const base = key();
  // Time passing and empty polls change nothing.
  clock.advance(30_000);
  tracker.apply(update([session(SID, { mtimeMs: t('14:00:02') })]));
  assert.equal(key(), base);
  assert.equal(JSON.stringify(tracker.snapshot(clock.now())), key());
  // Each fact moves the key.
  const seen = new Set([base]);
  const step = (recs: unknown[]): void => {
    feed(recs);
    const k = key();
    assert.equal(seen.has(k), false);
    seen.add(k);
  };
  step([rec.assistant(t('14:00:03'), { ...OPUS, effort: 'low', usage: usage(1, 0, 1000), tool: { id: 'z', name: 'Read' } }), rec.toolResult(t('14:00:04'), 'z')]); // effort
  step([rec.assistant(t('14:00:05'), { ...OPUS, usage: usage(1, 0, 5000), tool: { id: 'y', name: 'Read' } }), rec.toolResult(t('14:00:06'), 'y')]); // context
  step([rec.costState(2)]); // cost
  step([rec.exitPlan(t('14:00:07'), 'p1', '# P')]); // plan opens
  step([rec.planApproved(t('14:00:08'), 'p1')]); // plan decided
  step([rec.assistant(t('14:00:09'), { ...OPUS, text: 'again', stop: 'end_turn' })]); // report
  learned.set('claude-opus-5-5', 1_000_000); // learned window
  const k = key();
  assert.equal(seen.has(k), false);
});

// ---------------------------------------------------------------- hand approvals

const userOk = { decision: 'accept', source: 'user_temporary' };

test('lastApproval: a Bash accepted by the user is a command approval', () => {
  const s = run([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'b', 'Bash', { command: 'npm test' }), rec.decided(t('12:00:05'), 'b', userOk)], t('12:00:06'));
  assert.deepEqual(s.lastApproval, { at: t('12:00:05'), kind: 'command' });
});

test('lastApproval: an accepted Edit is an edit approval, with any user_ source and extra fields', () => {
  const s = run([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'e', 'Edit', { file_path: '/a.ts' }), rec.decided(t('12:00:05'), 'e', { decision: 'accept', source: 'user_permanent', grantScope: 'session' })], t('12:00:06'));
  assert.deepEqual(s.lastApproval, { at: t('12:00:05'), kind: 'edit' });
});

test('lastApproval: an accepted ExitPlanMode is a plan approval and the plan is still approved', () => {
  const s = run([rec.human(t('12:00:00')), rec.exitPlan(t('12:00:01'), 'p', '# Plan\n\n1. step'), rec.decided(t('12:00:09'), 'p', userOk)], t('12:00:10'));
  assert.deepEqual(s.lastApproval, { at: t('12:00:09'), kind: 'plan' });
  assert.equal(s.plans?.[0]?.status, 'approved');
});

test('lastApproval: config auto-allows, rejections and other tools are not approvals', () => {
  const call = (name: string, decision: Record<string, unknown>, isError = false) =>
    run([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'x', name, {}), rec.decided(t('12:00:05'), 'x', decision, isError)], t('12:00:06'));
  assert.equal(call('Bash', { decision: 'accept', source: 'config' }).lastApproval, undefined);
  assert.equal(call('Bash', { decision: 'reject', source: 'user_reject' }, true).lastApproval, undefined);
  assert.equal(call('Edit', { decision: 'reject', source: 'user_reject' }, true).lastApproval, undefined);
  assert.equal(call('AskUserQuestion', userOk).lastApproval, undefined);
  assert.equal(call('Read', userOk).lastApproval, undefined);
  // A result with no permissionDecision at all, and a rejected plan, leave it unset too.
  assert.equal(run([rec.human(t('12:00:00')), rec.toolUse(t('12:00:01'), 'x', 'Bash', {}), rec.toolResult(t('12:00:05'), 'x')], t('12:00:06')).lastApproval, undefined);
  const rejectedPlan = run([rec.human(t('12:00:00')), rec.exitPlan(t('12:00:01'), 'p', '# Plan'), rec.planRejected(t('12:00:05'), 'p')], t('12:00:06'));
  assert.equal(rejectedPlan.lastApproval, undefined);
  assert.equal(rejectedPlan.plans?.[0]?.status, 'rejected');
});

test('lastApproval: a later approval replaces an earlier one, an auto-allow after it does not', () => {
  const recs: unknown[] = [
    rec.human(t('12:00:00')),
    rec.toolUse(t('12:00:01'), 'e', 'Write', { file_path: '/a.ts' }), rec.decided(t('12:00:02'), 'e', userOk),
    rec.toolUse(t('12:00:03'), 'b', 'Bash', { command: 'ls' }), rec.decided(t('12:00:04'), 'b', userOk),
  ];
  assert.deepEqual(run(recs, t('12:00:05')).lastApproval, { at: t('12:00:04'), kind: 'command' });
  const auto = [...recs, rec.toolUse(t('12:00:06'), 'c', 'Bash', { command: 'pwd' }), rec.decided(t('12:00:07'), 'c', { decision: 'accept', source: 'config' })];
  assert.deepEqual(run(auto, t('12:00:08')).lastApproval, { at: t('12:00:04'), kind: 'command' });
});

test('lastApproval: the facts fixture plan approval is recorded', () => {
  const recs = loadJsonl(join(FACT_FIXTURES, 'facts-main.jsonl'));
  const s = run(recs, lastTimestamp(recs) + 1000);
  assert.equal(s.lastApproval?.kind, 'plan');
});
