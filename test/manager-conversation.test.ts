import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../src/shared/protocol.ts';
import type { ConversationItem } from '../src/shared/protocol.ts';
import { createSdkItemBuilder, itemsFromSdkMessage, itemsFromTranscript, seedCostFromTranscript, summarizeTool } from '../src/manager/conversation.ts';
import { createCostTracker } from '../src/manager/cost.ts';
import { readCaseFor, readTail } from '../src/manager/transcriptReader.ts';

const DIR = fileURLToPath(new URL('./fixtures/claude/projects/-home-user-demo-project/', import.meta.url));
const f = (n: number) => `${DIR}aaaa000${n}-0000-4000-8000-00000000000${n}.jsonl`;
const SUB = `${DIR}aaaa0005-0000-4000-8000-000000000005/subagents/agent-a5ca1e00000000001.jsonl`;

type Tool = Extract<ConversationItem, { kind: 'tool' }>;
const tools = (items: ConversationItem[]) => items.filter((i): i is Tool => i.kind === 'tool');

test('tour fixture: prompt, thinking, tools with summaries and states, final text', async () => {
  const { items, truncated } = await readTail(f(1));
  assert.equal(truncated, false);
  assert.equal(items[0]!.kind, 'prompt');
  assert.equal((items[0] as { text: string }).text, 'Show me how the demo project is laid out and run its checks.');
  assert.equal(items[1]!.kind, 'thinking');
  assert.deepEqual(
    tools(items).map((t) => t.summary),
    [
      'Read app.ts',
      'Searched for "TODO"',
      'Listed src/**/*.ts',
      'Searched the web for vite config options',
      'Fetched example.com',
      'Edited app.ts',
      'Wrote logo.svg',
      'Ran: Run the test suite',
      'Ran: Build the bundle',
      'Updated the to-do list',
      'Used skill code-review',
      'navigate',
    ],
  );
  assert.ok(tools(items).every((t) => t.state === 'done'));
  const read = tools(items)[0]!;
  assert.equal(read.id, 'toolu_01aa000101xxxxxxxxxxxxxx');
  assert.equal(read.name, 'Read');
  assert.match(read.input!, /app\.ts/);
  assert.match(read.output!, /createApp/);
  const last = items[items.length - 1]!;
  assert.equal(last.kind, 'assistant');
  assert.match((last as { text: string }).text, /Tests pass/);
  // ids unique
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test('running fixture keeps the open Bash running', async () => {
  const { items } = await readTail(f(3));
  const t = tools(items);
  assert.equal(t[t.length - 1]!.name, 'Bash');
  assert.equal(t[t.length - 1]!.state, 'running');
  assert.equal(t[t.length - 1]!.output, undefined);
});

test('interrupted fixture gives an interrupted notice and closes the open tool', async () => {
  const { items } = await readTail(f(7));
  const n = items.filter((i) => i.kind === 'notice');
  assert.equal(n.length, 1);
  assert.equal((n[0] as { notice: string }).notice, 'interrupted');
  assert.equal(items.some((i) => i.kind === 'prompt' && /Request interrupted/.test(i.text)), false);
  assert.equal(tools(items)[0]!.state, 'error');
});

test('compact fixture gives a notice', async () => {
  const { items } = await readTail(f(6));
  const last = items[items.length - 1]!;
  assert.equal(last.kind, 'notice');
  assert.equal((last as { notice: string }).notice, 'info');
});

test('partial fixture: bad last line is skipped', async () => {
  const { items, truncated } = await readTail(f(8));
  assert.equal(truncated, false);
  assert.ok(items.length > 0);
  assert.equal(items[0]!.kind, 'prompt');
});

test('subagent fixture needs sidechain: true', async () => {
  assert.deepEqual((await readTail(SUB)).items, []);
  const { items } = await readTail(SUB, { sidechain: true });
  assert.equal(items[0]!.kind, 'prompt');
  assert.deepEqual(tools(items).map((t) => t.summary).slice(0, 2), ['Read app.ts', 'Searched for "router"']);
  const viaCase = await readCaseFor({ id: 't1', kind: 'temp' }, () => SUB);
  assert.equal(viaCase.items.length, items.length);
  assert.deepEqual((await readCaseFor({ id: 'm1', kind: 'main' }, () => SUB)).items, []);
  assert.deepEqual((await readCaseFor({ id: 'm1', kind: 'main' }, () => undefined)).items, []);
});

test('missing file gives empty, no throw', async () => {
  assert.deepEqual(await readTail('/nonexistent/nope.jsonl'), { items: [], truncated: false });
});

test('readTail with a small maxBytes skips the partial first line and flags truncation', async () => {
  const { items, truncated } = await readTail(f(1), { maxBytes: 3000 });
  assert.equal(truncated, true);
  assert.ok(items.length > 0);
  assert.ok(items.length < 30);
});

test('readTail handles a file written on the fly, including blank and junk lines', async () => {
  const d = await mkdtemp(join(tmpdir(), 'conv-'));
  try {
    const file = join(d, 's.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
      '',
      'not json',
      '{"type":"assistant","mess',
    ];
    await writeFile(file, lines.join('\n'));
    const { items } = await readTail(file);
    assert.deepEqual(items.map((i) => i.id), ['u1']);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

const asst = (id: string, blocks: unknown[], extra: object = {}) => ({ type: 'assistant', message: { id, role: 'assistant', content: blocks }, ...extra });
const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

test('transcript: prompt filtering, merging, sdk origin, sidechain skip, malformed input', () => {
  const { items } = itemsFromTranscript([
    null, 5, 'x', [], { type: 42 },
    user('<local-command-stdout>x</local-command-stdout>', { uuid: 'l1' }),
    user('<command-name>/clear</command-name>', { uuid: 'l2' }),
    user('meta text', { isMeta: true, uuid: 'l3' }),
    user('first', { uuid: 'p1', turnOrigin: 'sdk' }),
    user([{ type: 'text', text: 'second' }], { uuid: 'p2' }),
    asst('m1', [{ type: 'text', text: 'A' }]),
    asst('m1', [{ type: 'text', text: 'B' }]),
    asst('m2', [{ type: 'text', text: 'C' }]),
    asst('m3', [{ type: 'text', text: 'side' }], { isSidechain: true }),
    { type: 'ai-title' }, { type: 'queue-operation' }, { type: 'file-history-snapshot' },
  ]);
  assert.deepEqual(items.map((i) => [i.kind, 'text' in i ? i.text : '']), [
    ['prompt', 'first'], ['prompt', 'second'], ['assistant', 'A\n\nB'], ['assistant', 'C'],
  ]);
  assert.equal(items[2]!.id, 'm1:0');
  assert.doesNotThrow(() => itemsFromTranscript(undefined as unknown as unknown[]));
});

test('transcript: denied, error, array results with images, api error', () => {
  const { items } = itemsFromTranscript([
    asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf x' } }]),
    asst('m1', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a/b.ts' } }]),
    asst('m1', [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/a/c.png' } }]),
    asst('m1', [{ type: 'tool_use', id: 't4', name: 'mcp__srv__do_thing', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected" }]),
    user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'File not found' }]),
    user([{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: 'see' }, { type: 'image', source: {} }] }]),
    user([{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }], { permissionDecision: 'reject' }),
    asst('e1', [{ type: 'text', text: 'API Error: 529 overloaded' }], { isApiErrorMessage: true, uuid: 'err1' }),
  ]);
  const t = tools(items);
  assert.deepEqual(t.map((x) => x.state), ['denied', 'error', 'done', 'denied']);
  assert.equal(t[0]!.summary, 'Ran: rm -rf x');
  assert.equal(t[2]!.output, 'see\n[image]');
  assert.equal(t[3]!.summary, 'do_thing');
  const last = items[items.length - 1]!;
  assert.deepEqual([last.kind, last.kind === 'notice' && last.notice], ['notice', 'error']);
});

test('truncation to caseItems', () => {
  const recs = Array.from({ length: LIMITS.caseItems + 25 }, (_, i) => user(`p${i}`, { uuid: `u${i}` }));
  const { items, truncated } = itemsFromTranscript(recs);
  assert.equal(items.length, LIMITS.caseItems);
  assert.equal(truncated, true);
  assert.equal(items[items.length - 1]!.id, `u${LIMITS.caseItems + 24}`);
  assert.equal(itemsFromTranscript(recs.slice(0, 5)).truncated, false);
});

test('text caps', () => {
  const big = 'x'.repeat(LIMITS.assistantTextChars + 500);
  const { items } = itemsFromTranscript([
    user('y'.repeat(LIMITS.promptChars + 10), { uuid: 'p' }),
    asst('m1', [{ type: 'text', text: big }]),
    asst('m2', [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/a/b', content: 'z'.repeat(9000) } }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'o'.repeat(9000) }]),
  ]);
  const p = items[0] as { text: string; truncated?: boolean };
  assert.equal(p.text.length, LIMITS.promptChars);
  assert.equal(p.truncated, true);
  assert.ok(p.text.endsWith('...'));
  const a = items[1] as { text: string; truncated?: boolean };
  assert.equal(a.text.length, LIMITS.assistantTextChars);
  assert.equal(a.truncated, true);
  const t = items[2] as Tool;
  assert.ok(t.input!.length <= LIMITS.toolPreviewChars);
  assert.ok(t.output!.length <= LIMITS.toolPreviewChars);
  assert.ok(t.summary.length <= LIMITS.toolSummaryChars);
  assert.ok(summarizeTool('Bash', { command: 'a'.repeat(1000) }).length <= LIMITS.toolSummaryChars);
});

test('summary phrasing', () => {
  assert.equal(summarizeTool('Bash', { command: 'npm test' }), 'Ran: npm test');
  assert.equal(summarizeTool('Bash', { command: 'npm test', description: 'Run tests' }), 'Ran: Run tests');
  assert.equal(summarizeTool('AskUserQuestion', {}), 'Asked you a question');
  assert.equal(summarizeTool('ExitPlanMode', {}), 'Proposed a plan');
  assert.equal(summarizeTool('Agent', { description: 'Review router' }), 'Delegated: Review router');
  assert.equal(summarizeTool('Task', { description: 'x' }), 'Delegated: x');
  assert.equal(summarizeTool('Read', null), 'Read a file');
  assert.equal(summarizeTool('Mystery', undefined), 'Mystery');
});

// ---- SDK builder ----

const SID = { session_id: 's1' };
const delta = (mid: string, index: number, text: string) => ({
  type: 'stream_event', ...SID, parent_tool_use_id: null, api_message_id: mid,
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
});

test('SDK builder: prompt, deltas, final, tool_use, tool_result, result cost', () => {
  const b = createSdkItemBuilder();
  assert.deepEqual(b.apply({ type: 'system', subtype: 'init', ...SID }), []);
  assert.deepEqual(b.apply({ type: 'system', subtype: 'status', status: 'requesting' }), []);

  const p = itemsFromSdkMessage({ type: 'user', uuid: 'pu1', message: { role: 'user', content: 'Do it' }, parent_tool_use_id: null }, b);
  assert.deepEqual(p.map((i) => [i.kind, i.id]), [['prompt', 'pu1']]);

  b.apply({ type: 'stream_event', ...SID, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } } });
  const d1 = b.apply(delta('msg_1', 0, 'Fluor'));
  const d2 = b.apply(delta('msg_1', 0, 'ite'));
  assert.equal(d1[0]!.id, 'msg_1:0');
  assert.equal(d2[0]!.id, 'msg_1:0');
  assert.deepEqual(d2[0], { kind: 'assistant', id: 'msg_1:0', text: 'Fluorite', streaming: true, at: d2[0]!.at });
  assert.equal(b.items().length, 2);

  const fin = b.apply({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Fluorite glows.' }] } });
  assert.equal(fin[0]!.id, 'msg_1:0');
  assert.equal((fin[0] as { text: string }).text, 'Fluorite glows.');
  assert.equal((fin[0] as { streaming?: boolean }).streaming, false);
  assert.equal(b.items().length, 2);

  const tu = b.apply({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_2', role: 'assistant', content: [
    { type: 'thinking', thinking: 'hm' },
    { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls -la', description: 'List files' } },
  ] } });
  assert.deepEqual(tu.map((i) => i.id), ['msg_2:0', 'toolu_x']);
  assert.equal((tu[1] as Tool).state, 'running');
  assert.equal((tu[1] as Tool).summary, 'Ran: List files');

  const tr = b.apply({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a\nb' }] } });
  assert.equal(tr.length, 1);
  assert.equal((tr[0] as Tool).state, 'done');
  assert.equal((tr[0] as Tool).output, 'a\nb');

  const res = b.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0039, uuid: 'r1', ...SID });
  assert.equal(res.length, 1);
  assert.deepEqual([res[0]!.kind, (res[0] as { notice: string }).notice, (res[0] as { costUsd: number }).costUsd], ['notice', 'cost', 0.0039]);
  assert.equal(b.items().length, 5);
});

test('SDK builder: deny result and interrupt sequence', () => {
  const b = createSdkItemBuilder();
  b.apply({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tA', name: 'Bash', input: { command: 'ls > l.txt' } }] } });
  const den = b.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', is_error: true, content: 'Nope' }] }, tool_result_meta: [{ tool_use_id: 'tA', permission_decision: { decision: 'reject', source: 'user_reject' } }] });
  assert.equal((den[0] as Tool).state, 'denied');

  b.apply({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tB', name: 'Bash', input: { command: 'for i in 1 2; do sleep 1; done' } }] } });
  const out = b.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tB', content: 'tick 1' }] } });
  assert.equal((out[0] as Tool).state, 'done');
  const intr = b.apply({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  assert.equal(intr.length, 1);
  assert.equal((intr[0] as { notice: string }).notice, 'interrupted');
  const res = b.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: 'tool_use', total_cost_usd: 0.0033, errors: [], uuid: 'r2' });
  // already reported by the interrupt text: only the cost notice is new
  assert.deepEqual(res.map((i) => (i as { notice: string }).notice), ['cost']);
  assert.equal(b.items().filter((i) => i.kind === 'notice' && i.notice === 'interrupted').length, 1);

  // interrupt without the text message: the result alone yields the notice
  const b2 = createSdkItemBuilder();
  const r2 = b2.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.001, uuid: 'r3' });
  assert.deepEqual(r2.map((i) => (i as { notice: string }).notice), ['interrupted', 'cost']);
  // the CLI's internal diagnostic line (seen on every real interrupt) is not an error
  const b3 = createSdkItemBuilder();
  b3.apply({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  const r5 = b3.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], total_cost_usd: 0.002, uuid: 'r5' });
  assert.deepEqual(r5.map((i) => (i as { notice: string }).notice), ['cost']);
  const r6 = b2.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] x', 'boom'], uuid: 'r6' });
  assert.deepEqual(r6.map((i) => [(i as { notice: string }).notice, (i as { text: string }).text]), [['error', 'boom']]);
  // a real error is an error
  const r3 = b2.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], uuid: 'r4' });
  assert.deepEqual(r3.map((i) => (i as { notice: string }).notice), ['error']);
});

test('SDK builder: ids are stable across upserts, order is kept, subagent tools carry the parent', () => {
  const b = createSdkItemBuilder();
  b.apply({ type: 'user', uuid: 'u', message: { role: 'user', content: 'go' } });
  b.apply(delta('m', 0, 'a'));
  b.apply({ type: 'assistant', message: { id: 'other', content: [{ type: 'tool_use', id: 'tt', name: 'Agent', input: { description: 'Sub' } }] } });
  b.apply(delta('m', 0, 'b'));
  b.apply({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'ab!' }] } });
  assert.deepEqual(b.items().map((i) => i.id), ['u', 'm:0', 'tt']);
  const sub = b.apply({ type: 'assistant', parent_tool_use_id: 'tt', message: { id: 'sm', content: [{ type: 'tool_use', id: 'st', name: 'Read', input: { file_path: '/x/y.ts' } }, { type: 'text', text: 'hidden' }] } });
  assert.deepEqual(sub.map((i) => i.id), ['st']);
  assert.equal((sub[0] as Tool).parentToolUseId, 'tt');
  assert.deepEqual(b.apply(null), []);
  assert.deepEqual(b.apply({ type: 'assistant' }), []);
});

test('SDK builder caps retained items at caseItems', () => {
  const b = createSdkItemBuilder();
  for (let i = 0; i < LIMITS.caseItems + 10; i++) b.apply({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `p${i}` } });
  assert.equal(b.items().length, LIMITS.caseItems);
  assert.equal(b.items()[0]!.id, 'u10');
});

// ---------------------------------------------------------------------------------------------
// Plan items and cost tracking

type Plan = Extract<ConversationItem, { kind: 'plan' }>;
const plansOf = (items: ConversationItem[]) => items.filter((i): i is Plan => i.kind === 'plan');
const passt = (id: string, content: unknown[]) => ({ type: 'assistant', uuid: `u-${id}`, message: { id, role: 'assistant', content } });
const planUse = (id: string, plan: string, planFilePath?: string) =>
  passt(`m-${id}`, [{ type: 'tool_use', id, name: 'ExitPlanMode', input: planFilePath ? { plan, planFilePath } : { plan } }]);
const userRes = (id: string, content: string, isError = false) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });

test('plan: transcript pending, approved, with file path and no tool item', () => {
  const pending = itemsFromTranscript([planUse('toolu_p1', '# Plan\n1. step one', '/home/user/.claude/plans/placeholder.md')]).items;
  assert.deepEqual(plansOf(pending).map((p) => [p.id, p.status, p.text, p.planFilePath]), [['toolu_p1', 'pending', '# Plan\n1. step one', '/home/user/.claude/plans/placeholder.md']]);
  assert.equal(tools(pending).length, 0);
  const done = itemsFromTranscript([planUse('toolu_p1', 'Placeholder plan'), userRes('toolu_p1', 'User has approved your plan. You can now start coding.')]).items;
  assert.equal(done.length, 1);
  assert.equal((done[0] as Plan).status, 'approved');
  assert.equal((done[0] as Plan).feedback, undefined);
});

test('plan: transcript rejected with feedback, and without', () => {
  const rejected = itemsFromTranscript([
    planUse('toolu_p1', 'Placeholder plan'),
    userRes('toolu_p1', "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nPlaceholder: split it in two", true),
  ]).items;
  assert.equal((rejected[0] as Plan).status, 'rejected');
  assert.equal((rejected[0] as Plan).feedback, 'Placeholder: split it in two');
  const plain = itemsFromTranscript([planUse('toolu_p1', 'Placeholder plan'), userRes('toolu_p1', "The user doesn't want to proceed with this tool use. The tool use was rejected", true)]).items;
  assert.equal((plain[0] as Plan).status, 'rejected');
  assert.equal((plain[0] as Plan).feedback, undefined);
  const sdkDeny = itemsFromTranscript([planUse('toolu_p1', 'Placeholder plan'), userRes('toolu_p1', 'Add tests first', true)]).items;
  assert.equal((sdkDeny[0] as Plan).feedback, 'Add tests first');
  const dflt = itemsFromTranscript([planUse('toolu_p1', 'Placeholder plan'), userRes('toolu_p1', 'Keep planning.', true)]).items;
  assert.equal((dflt[0] as Plan).feedback, undefined);
});

test('plan: a newer plan supersedes a pending one, decided ones stay decided', () => {
  const items = itemsFromTranscript([
    planUse('toolu_a', 'Plan A'),
    planUse('toolu_b', 'Plan B'),
    userRes('toolu_b', 'User has approved your plan.'),
    planUse('toolu_c', 'Plan C'),
  ]).items;
  assert.deepEqual(plansOf(items).map((p) => [p.id, p.status]), [['toolu_a', 'superseded'], ['toolu_b', 'approved'], ['toolu_c', 'pending']]);
  assert.deepEqual(items.map((i) => i.id), ['toolu_a', 'toolu_b', 'toolu_c']);
});

test('plan: long plan is truncated', () => {
  const items = itemsFromTranscript([planUse('toolu_p1', 'x'.repeat(LIMITS.planChars + 500))]).items;
  const p = items[0] as Plan;
  assert.equal(p.truncated, true);
  assert.equal(p.text.length, LIMITS.planChars);
  assert.ok(p.text.endsWith('...'));
});

test('plan: live stream updates the existing item instead of adding one', () => {
  const b = createSdkItemBuilder();
  const open = b.apply({ ...planUse('toolu_p1', 'Placeholder plan', '/home/user/.claude/plans/x.md'), parent_tool_use_id: null });
  assert.deepEqual(open.map((i) => [i.kind, i.id, (i as Plan).status]), [['plan', 'toolu_p1', 'pending']]);
  const ok = b.apply({ ...userRes('toolu_p1', 'User has approved your plan.'), parent_tool_use_id: null });
  assert.deepEqual(ok.map((i) => [i.id, (i as Plan).status]), [['toolu_p1', 'approved']]);
  assert.equal(b.items().length, 1);
  assert.equal((b.items()[0] as Plan).status, 'approved');
  // re-emitted tool_use does not reset a decided plan
  b.apply({ ...planUse('toolu_p1', 'Placeholder plan'), parent_tool_use_id: null });
  assert.equal((b.items()[0] as Plan).status, 'approved');

  const r = createSdkItemBuilder();
  r.apply(planUse('toolu_p2', 'Plan one'));
  const second = r.apply(planUse('toolu_p3', 'Plan two'));
  assert.deepEqual(second.map((i) => [i.id, (i as Plan).status]), [['toolu_p2', 'superseded'], ['toolu_p3', 'pending']]);
  const rej = r.apply(userRes('toolu_p3', 'Please shorten it', true));
  assert.deepEqual([(rej[0] as Plan).status, (rej[0] as Plan).feedback], ['rejected', 'Please shorten it']);
  assert.equal(r.items().length, 2);
});

const result = (total: number, uuid: string, sid = 's1') => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: total, uuid, session_id: sid });
const costOf = (items: ConversationItem[]) => (items.find((i) => i.kind === 'notice' && i.notice === 'cost') as { costUsd: number; text: string }).costUsd;

test('cost: running totals become turn deltas across three results and a resume', () => {
  const tracker = createCostTracker();
  const b = createSdkItemBuilder({ cost: tracker });
  assert.equal(costOf(b.apply(result(0.10, 'r1'))), 0.10);
  assert.ok(Math.abs(costOf(b.apply(result(0.25, 'r2'))) - 0.15) < 1e-9);
  const third = b.apply(result(0.30, 'r3'));
  assert.ok(Math.abs(costOf(third) - 0.05) < 1e-9);
  assert.match((third[0] as { text: string }).text, /Turn cost \$0\.0500 \(session \$0\.3000\)/);
  assert.equal(tracker.total('s1'), 0.30);

  // resume: a new builder in the same process shares the tracker, the CLI restores the total, so no double count
  const resumed = createSdkItemBuilder({ cost: tracker });
  assert.ok(Math.abs(costOf(resumed.apply(result(0.34, 'r4'))) - 0.04) < 1e-9);
  assert.equal(tracker.sum(), 0.34);
  // a repeated identical result is a zero-cost turn
  assert.equal(costOf(resumed.apply(result(0.34, 'r4b'))), 0);
});

test('cost: seeding from a transcript cost-state stops a resume counting its lifetime as one turn', () => {
  const records = [{ type: 'cost-state', totalCostUSD: 1.0 }, planUse('toolu_p1', 'p'), { type: 'cost-state', totalCostUSD: 1.5 }, { type: 'cost-state', totalCostUSD: 'bad' }];
  const tracker = createCostTracker();
  assert.equal(seedCostFromTranscript(records, 's1', tracker), 1.5);
  assert.equal(seedCostFromTranscript([{ type: 'user' }], 's2', tracker), undefined);
  const b = createSdkItemBuilder({ cost: tracker });
  assert.ok(Math.abs(costOf(b.apply(result(1.62, 'r1'))) - 0.12) < 1e-9);
  // unseeded, the same resume would report the whole total
  assert.equal(costOf(createSdkItemBuilder().apply(result(1.62, 'r1'))), 1.62);
});

test('cost: a tracker shared with a runner-like caller is not double counted', () => {
  const tracker = createCostTracker();
  const b = createSdkItemBuilder({ cost: tracker });
  const msgs = [result(0.2, 'r1', 'sA'), result(0.5, 'r2', 'sA'), result(0.1, 'r3', 'sB')];
  for (const m of msgs) {
    const before = tracker.total(m.session_id) ?? 0;
    const items = b.apply(m); // the builder observes first (same stream the runner reads)
    // the runner observing the same total afterwards sees no further turn cost
    assert.equal(tracker.observe(m.session_id, m.total_cost_usd).turnUsd, 0);
    assert.ok(costOf(items) <= m.total_cost_usd - before + 1e-9);
  }
  assert.ok(Math.abs(tracker.sum() - 0.6) < 1e-9);
  // session id falls back to the option when the message has none
  const t2 = createCostTracker();
  const b2 = createSdkItemBuilder({ cost: t2, sessionId: 'fallback' });
  b2.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.4, uuid: 'x' });
  assert.equal(t2.total('fallback'), 0.4);
});
