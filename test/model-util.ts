import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveStatus, SessionInfo, SubagentInfo, WatchUpdate } from '../src/claude/types.ts';

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude');
export const FACT_FIXTURES = join(import.meta.dirname, 'fixtures', 'model');
export const DEMO_DIR = join(FIXTURES, 'projects', '-home-user-demo-project');

/** Epoch ms of a fixture-day time such as t('10:01:20'). */
export function t(hms: string): number {
  return Date.parse(`2026-10-18T${hms}${hms.includes('.') ? '' : '.000'}Z`);
}

/** Read a JSONL fixture, skipping lines that do not parse (the cut-off last line of aaaa0008). */
export function loadJsonl(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // deliberate partial line
    }
  }
  return out;
}

export function loadMain(n: number): { sessionId: string; path: string; records: unknown[] } {
  const sessionId = `aaaa000${n}-0000-4000-8000-00000000000${n}`;
  const dir = n === 9 ? join(FIXTURES, 'projects', 'C--Users-alice-work-proj') : DEMO_DIR;
  const path = join(dir, `${sessionId}.jsonl`);
  return { sessionId, path, records: loadJsonl(path) };
}

export function lastTimestamp(records: unknown[]): number {
  let best = 0;
  for (const r of records) {
    const ts = (r as { timestamp?: string }).timestamp;
    if (typeof ts === 'string') best = Math.max(best, Date.parse(ts));
  }
  return best;
}

export function session(sessionId: string, opts: Partial<SessionInfo> & { live?: LiveStatus; subagents?: SubagentInfo[] } = {}): SessionInfo {
  return {
    sessionId,
    transcriptPath: `/x/${sessionId}.jsonl`,
    projectDir: '/home/u/.claude/projects/-home-user-demo-project',
    cwd: '/home/user/demo-project',
    mtimeMs: 0,
    subagents: [],
    ...opts,
  };
}

export function update(sessions: SessionInfo[], batches: WatchUpdate['batches'] = []): WatchUpdate {
  return { sessions, batches };
}

/** A manually advanced clock. */
export function makeClock(start: number): { now: () => number; set: (v: number) => void; advance: (ms: number) => void } {
  let cur = start;
  return { now: () => cur, set: (v) => { cur = v; }, advance: (ms) => { cur += ms; } };
}

// ---- synthetic records ----

const iso = (ms: number): string => new Date(ms).toISOString();

export const rec = {
  human: (ms: number, text = 'do it'): unknown => ({ type: 'user', turnOrigin: 'human', timestamp: iso(ms), isSidechain: false, message: { role: 'user', content: text } }),
  apiRequest: (ms: number): unknown => ({ type: 'api-request', timestamp: iso(ms), querySource: 'repl_main_thread' }),
  thinking: (ms: number): unknown => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }], stop_reason: null } }),
  text: (ms: number, stop: string | null = 'end_turn'): unknown => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: stop } }),
  toolUse: (ms: number, id: string, name: string, input: unknown = {}): unknown => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } }),
  toolResult: (ms: number, id: string): unknown => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } }),
  turnDuration: (ms: number): unknown => ({ type: 'system', subtype: 'turn_duration', timestamp: iso(ms) }),
  compact: (ms: number): unknown => ({ type: 'system', subtype: 'compact_boundary', timestamp: iso(ms) }),
  interrupt: (ms: number): unknown => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  aiTitle: (title: string): unknown => ({ type: 'ai-title', aiTitle: title }),
  /** An assistant record with the per-session facts: model, effort, usage, and optionally text or a tool call. */
  assistant: (ms: number, o: { model?: string; effort?: unknown; perTurnEffort?: unknown; usage?: Record<string, number>; text?: string; stop?: string | null; tool?: { id: string; name: string; input?: unknown } } = {}): unknown => {
    const content: unknown[] = [];
    if (o.text !== undefined) content.push({ type: 'text', text: o.text });
    if (o.tool !== undefined) content.push({ type: 'tool_use', id: o.tool.id, name: o.tool.name, input: o.tool.input ?? {} });
    if (content.length === 0) content.push({ type: 'thinking', thinking: 'hm' });
    const message: Record<string, unknown> = { role: 'assistant', content, stop_reason: o.stop === undefined ? (o.tool !== undefined ? 'tool_use' : o.text !== undefined ? 'end_turn' : null) : o.stop };
    if (o.model !== undefined) message['model'] = o.model;
    if (o.usage !== undefined) message['usage'] = o.usage;
    const r: Record<string, unknown> = { type: 'assistant', timestamp: iso(ms), message };
    if (o.effort !== undefined) r['effort'] = o.effort;
    if (o.perTurnEffort !== undefined) r['perTurnEffort'] = o.perTurnEffort;
    return r;
  },
  costState: (total: number): unknown => ({ type: 'cost-state', sessionId: 'x', totalCostUSD: total, modelUsage: {}, hasUnknownModelCost: false }),
  exitPlan: (ms: number, id: string, plan?: string, planFilePath?: string): unknown =>
    rec.assistant(ms, { model: 'claude-opus-5-5', tool: { id, name: 'ExitPlanMode', input: plan === undefined ? {} : { plan, ...(planFilePath === undefined ? {} : { planFilePath }) } } }),
  planApproved: (ms: number, id: string, plan?: string, filePath?: string): unknown => ({
    type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'User has approved your plan.' }] },
    ...(plan === undefined ? {} : { toolUseResult: { plan, isAgent: false, ...(filePath === undefined ? {} : { filePath }) } }),
  }),
  planRejected: (ms: number, id: string, reason?: string): unknown => ({
    type: 'user', timestamp: iso(ms),
    message: { role: 'user', content: [{ type: 'tool_result', is_error: true, tool_use_id: id, content: "The user doesn't want to proceed with this tool use." + (reason === undefined ? ' STOP what you are doing and wait for the user to tell you how to proceed.' : ` The user provided the following reason for the rejection:  ${reason}`) }] },
    permissionDecision: { decision: 'reject', source: 'user_reject' },
  }),
  notification: (ms: number, agentId: string): unknown => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(ms), content: `<task-notification>\n<task-id>${agentId}</task-id>\n</task-notification>` }),
};
