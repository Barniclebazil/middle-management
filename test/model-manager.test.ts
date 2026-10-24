import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTracker } from '../src/model/agentState.ts';
import type { OfficeInfoLookup } from '../src/model/agentState.ts';
import type { SubagentInfo } from '../src/claude/types.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';
import { loadMain, makeClock, rec, session, t, update } from './model-util.ts';

const SID = 'sid-m';
const sub: SubagentInfo = { agentId: 'ag1', path: '/x/agent-ag1.jsonl', mtimeMs: t('12:00:20'), meta: { description: 'Scout', agentType: 'Explore', finished: false } };

function build(opts: ConstructorParameters<typeof AgentTracker>[0] = {}, mainRecs: unknown[] = [rec.human(t('12:00:00')), rec.thinking(t('12:00:02'))], subs: SubagentInfo[] = []) {
  const clock = makeClock(t('12:00:05'));
  const tracker = new AgentTracker({ now: clock.now, ...opts });
  tracker.apply(update([session(SID, { mtimeMs: t('12:00:04'), subagents: subs })], [{ sessionId: SID, reset: true, records: mainRecs }]));
  return { clock, tracker };
}
const main = (snaps: AgentSnapshot[]): AgentSnapshot => snaps.find((s) => s.kind === 'main')!;

test('sessionId: main is its own id, temp carries the parent session id', () => {
  const { tracker } = build({}, undefined, [sub]);
  const snaps = tracker.snapshot();
  assert.equal(snaps.length, 2);
  assert.equal(main(snaps).sessionId, SID);
  assert.equal(snaps[1]!.kind, 'temp');
  assert.equal(snaps[1]!.sessionId, SID);
});

test('cwd and gitBranch come from the latest records; branch HEAD or empty is omitted', () => {
  const a = { ...(rec.human(t('12:00:00')) as object), cwd: '/w/one', gitBranch: 'main' };
  const b = { ...(rec.thinking(t('12:00:02')) as object), cwd: '/w/two', gitBranch: 'feature/x' };
  const { tracker } = build({}, [a, b]);
  const s = main(tracker.snapshot());
  assert.equal(s.cwd, '/w/two');
  assert.equal(s.gitBranch, 'feature/x');

  const c = { ...(rec.thinking(t('12:00:03')) as object), gitBranch: 'HEAD' };
  const d = { ...(rec.thinking(t('12:00:03')) as object), gitBranch: '' };
  assert.equal(main(build({}, [a, c]).tracker.snapshot()).gitBranch, undefined);
  assert.equal(main(build({}, [a, d]).tracker.snapshot()).gitBranch, 'main');
});

test('cwd falls back to SessionInfo.cwd, gitBranch is absent without records', () => {
  const s = main(build().tracker.snapshot());
  assert.equal(s.cwd, '/home/user/demo-project');
  assert.equal(s.gitBranch, undefined);
});

test('fixture records carry cwd and gitBranch', () => {
  const { sessionId, records } = loadMain(4);
  const tracker = new AgentTracker({ now: () => t('10:00:10') });
  tracker.apply(update([session(sessionId, { mtimeMs: t('10:00:05') })], [{ sessionId, reset: true, records }]));
  const s = main(tracker.snapshot());
  assert.equal(s.cwd, '/home/user/demo-project');
  assert.equal(s.gitBranch, 'main');
});

test('control: from the lookup, else none for temps and undefined for mains', () => {
  const calls: string[] = [];
  const { tracker } = build({ controlOf: (a) => { calls.push(`${a.kind}:${a.sessionId}`); return a.kind === 'main' ? 'office' : 'elsewhere'; } }, undefined, [sub]);
  const snaps = tracker.snapshot();
  assert.equal(snaps[0]!.control, 'office');
  assert.equal(snaps[1]!.control, 'elsewhere');
  assert.deepEqual(calls, [`main:${SID}`, `temp:${SID}`]);

  const plain = build({}, undefined, [sub]).tracker.snapshot();
  assert.equal(plain[0]!.control, undefined);
  assert.equal('control' in plain[0]!, false);
  assert.equal(plain[1]!.control, 'none');
});

test('pending forces needsYou with a stable since and per-kind detail; clearing resumes normal rules', () => {
  let pending: { requestId: string; kind: 'permission' | 'question' | 'plan' } | undefined;
  const officeInfo: OfficeInfoLookup = () => (pending === undefined ? undefined : { pending });
  const recs = [rec.human(t('12:00:00')), rec.toolUse(t('12:00:02'), 'tu1', 'Bash', { command: 'ls' })];
  const { clock, tracker } = build({ officeInfo }, recs);
  const before = main(tracker.snapshot());
  assert.notEqual(before.activity, 'needsYou');
  assert.equal(before.pending, undefined);

  pending = { requestId: 'r1', kind: 'permission' };
  clock.set(t('12:00:06'));
  const p1 = main(tracker.snapshot());
  assert.deepEqual([p1.activity, p1.status, p1.detail, p1.since], ['needsYou', 'waiting', 'Approve: Bash', t('12:00:06')]);
  assert.deepEqual(p1.pending, { requestId: 'r1', kind: 'permission' });

  clock.set(t('12:00:09'));
  const p2 = main(tracker.snapshot());
  assert.equal(p2.since, t('12:00:06'));

  pending = { requestId: 'r2', kind: 'question' };
  clock.set(t('12:00:10'));
  const q = main(tracker.snapshot());
  assert.deepEqual([q.detail, q.since], ['Question for you', t('12:00:10')]);

  pending = { requestId: 'r3', kind: 'plan' };
  assert.equal(main(tracker.snapshot()).detail, 'Plan ready');

  pending = undefined;
  const after = main(tracker.snapshot());
  assert.equal(after.activity, before.activity);
  assert.equal(after.status, before.status);
  assert.equal(after.detail, before.detail);
});

test('permission without an open tool says just Approve; pending beats a stale-idle main', () => {
  const { clock, tracker } = build({ officeInfo: () => ({ pending: { requestId: 'r', kind: 'permission' } }) });
  clock.set(t('12:30:00'));
  const s = main(tracker.snapshot());
  assert.deepEqual([s.activity, s.status, s.detail], ['needsYou', 'waiting', 'Approve']);
});

test('costUsd passes through for mains only', () => {
  const { tracker } = build({ officeInfo: () => ({ costUsd: 1.25 }) }, undefined, [sub]);
  const snaps = tracker.snapshot();
  assert.equal(snaps[0]!.costUsd, 1.25);
  assert.equal(snaps[1]!.costUsd, undefined);
});

test('lookups returning undefined or throwing leave snapshots unchanged', () => {
  const base = build({}, undefined, [sub]).tracker.snapshot();
  const withLookups = build({ officeInfo: () => undefined }, undefined, [sub]).tracker.snapshot();
  assert.deepEqual(withLookups, base);
  const thrower = build({ officeInfo: () => { throw new Error('x'); } }, undefined, [sub]).tracker.snapshot();
  assert.deepEqual(thrower, base);
});

test('without lookups the snapshot equals the old shape plus the new optional fields', () => {
  const snaps = build({}, undefined, [sub]).tracker.snapshot();
  const m = main(snaps);
  const keys = Object.keys(m).sort();
  assert.deepEqual(keys, ['activity', 'cwd', 'id', 'kind', 'project', 'sessionId', 'since', 'startedAt', 'status', 'title', 'lastPromptAt'].sort());
});
