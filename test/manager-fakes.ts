// Shared fakes for the manager tests: a scripted SDK query, manual timers and short SDK message shapes copied from
// docs/sdk-spike.md. Not a test file itself.
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationItem } from '../src/shared/protocol.ts';
import type { ControlMethod, QueryFn, SdkQuery } from '../src/manager/sessionRunner.ts';
import type { SdkItemBuilderLike } from '../src/manager/managerHost.ts';

/** Let queued promise callbacks and setImmediate work run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export class FakeTimers {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.#timers.delete(h as number);
  };
  get pending(): number {
    return this.#timers.size;
  }
  /** Move time forward, running due timers in order (timers they schedule run too if due). */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, t] of this.#timers) {
        if (t.at <= end && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const t = this.#timers.get(nextId)!;
      this.#timers.delete(nextId);
      this.now = Math.max(this.now, t.at);
      t.fn();
      await settle(2);
    }
    this.now = end;
    await settle(2);
  }
}

/** Every optional control method of SdkQuery; `fakeSdk({ omit })` / `new FakeQuery(params, omit)` leaves some out. */
export const CONTROL_METHODS: readonly ControlMethod[] = [
  'setModel', 'setPermissionMode', 'applyFlagSettings', 'initializationResult', 'getContextUsage', 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
];

export class FakeQuery implements SdkQuery {
  readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options };
  /** Every control call, in order: `{method, args}`. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** Per method, an error the call rejects with (set it before the call). */
  controlErrors: Partial<Record<ControlMethod, unknown>> = {};
  /** Per method, the value the call resolves with. */
  controlResults: Partial<Record<ControlMethod, unknown>> = {};
  setModel?: SdkQuery['setModel'];
  setPermissionMode?: SdkQuery['setPermissionMode'];
  applyFlagSettings?: SdkQuery['applyFlagSettings'];
  initializationResult?: SdkQuery['initializationResult'];
  getContextUsage?: SdkQuery['getContextUsage'];
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: SdkQuery['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'];
  /** Text of every user message the runner pushed, in order. */
  readonly received: string[] = [];
  interrupts = 0;
  closed = false;
  #out: SDKMessage[] = [];
  #waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null;
  #waitingFail: ((e: unknown) => void) | null = null;
  #done = false;
  #failure: { error: unknown } | undefined;
  /** Called when the runner interrupts. Default: nothing. */
  onInterrupt: (() => void) | undefined;

  /** `omit`: control methods this query does not have, like an older Claude Code build. */
  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, omit: readonly ControlMethod[] = []) {
    this.params = params;
    for (const method of CONTROL_METHODS) {
      if (omit.includes(method)) continue;
      (this as Record<string, unknown>)[method] = async (...args: unknown[]): Promise<unknown> => {
        this.calls.push({ method, args });
        const err = this.controlErrors[method];
        if (err !== undefined) throw err;
        return this.controlResults[method];
      };
    }
    void this.#drainInput();
  }

  async #drainInput(): Promise<void> {
    try {
      for await (const m of this.params.prompt) {
        const c = m.message.content;
        this.received.push(typeof c === 'string' ? c : JSON.stringify(c));
      }
    } catch {
      // ignore
    }
    // Input ended: like the real SDK, finish after the queued output.
    this.finish();
  }

  emit(...msgs: unknown[]): void {
    for (const m of msgs) {
      if (this.#waiting) {
        const w = this.#waiting;
        this.#waiting = null;
        this.#waitingFail = null;
        w({ value: m as SDKMessage, done: false });
      } else this.#out.push(m as SDKMessage);
    }
  }

  finish(): void {
    this.#done = true;
    if (this.#waiting && this.#out.length === 0) {
      const w = this.#waiting;
      this.#waiting = null;
      this.#waitingFail = null;
      w({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.#failure = { error };
    if (this.#waitingFail) {
      const f = this.#waitingFail;
      this.#waiting = null;
      this.#waitingFail = null;
      f(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.#out.shift();
        if (m !== undefined) return Promise.resolve({ value: m, done: false });
        if (this.#failure) return Promise.reject(this.#failure.error);
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<SDKMessage>>((res, rej) => {
          this.#waiting = res;
          this.#waitingFail = rej;
        });
      },
    };
  }

  async interrupt(): Promise<unknown> {
    this.interrupts++;
    this.onInterrupt?.();
    return undefined;
  }

  close(): void {
    this.closed = true;
    this.finish();
  }

  /** Ask the runner's canUseTool, like the SDK does. */
  ask(toolName: string, input: Record<string, unknown>, extra: { toolUseID?: string; suggestions?: unknown[]; signal?: AbortSignal; blockedPath?: string } = {}): Promise<unknown> {
    const canUseTool = this.params.options.canUseTool!;
    const toolUseID = extra.toolUseID ?? `toolu_${Math.random().toString(36).slice(2, 8)}`;
    const opts: Parameters<typeof canUseTool>[2] = { signal: extra.signal ?? new AbortController().signal, toolUseID, requestId: `req_${toolUseID}` };
    if (extra.suggestions !== undefined) opts.suggestions = extra.suggestions as never;
    if (extra.blockedPath !== undefined) opts.blockedPath = extra.blockedPath;
    return canUseTool(toolName, input, opts);
  }
}

export interface FakeSdk {
  queryFn: QueryFn;
  queries: FakeQuery[];
  /** If set, queryFn throws it. */
  throwOnCall?: unknown;
}

export function fakeSdk(opts: { omit?: readonly ControlMethod[] } = {}): FakeSdk {
  const sdk: FakeSdk = {
    queries: [],
    queryFn: (params) => {
      if (sdk.throwOnCall !== undefined) throw sdk.throwOnCall;
      const q = new FakeQuery(params, opts.omit ?? []);
      sdk.queries.push(q);
      return q;
    },
  };
  return sdk;
}

// --- message shapes (docs/sdk-spike.md sections 3, 5 and 10) ------------------------------------------------------------

export const SID = 'c91aa617-0000-4000-8000-000000000001';

export const initMsg = (sid = SID, extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5', permissionMode: 'default', uuid: 'init-' + sid.slice(-3), ...extra,
});
export const assistantText = (text: string, sid = SID, id = 'msg_1') => ({
  type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'a-' + id,
  message: { id, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }] },
});
export const assistantTool = (name: string, input: Record<string, unknown>, sid = SID, id = 'msg_2', toolId = 'toolu_01') => ({
  type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'a-' + id,
  message: { id, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] },
});
export const resultMsg = (cost: number, sid = SID, subtype = 'success', uuid = 'res-1') => ({
  type: 'result', subtype, is_error: subtype !== 'success', stop_reason: 'end_turn', num_turns: 1, total_cost_usd: cost,
  result: subtype === 'success' ? 'DONE' : undefined, session_id: sid, uuid,
});
export const rateLimitMsg = (info: Record<string, unknown>, sid = SID) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'rl-1', session_id: sid });
export const statusMsg = (mode: string, sid = SID) => ({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sid, uuid: 'st-' + mode });

/** Stand-in for 7.2's item builder: assistant text and tool_use become items, a result becomes a cost notice. */
export function fakeBuilder(): SdkItemBuilderLike & { interrupted: number } {
  const all = new Map<string, ConversationItem>();
  const put = (i: ConversationItem): ConversationItem => {
    all.set(i.id, i);
    return i;
  };
  const b = {
    interrupted: 0,
    apply(msg: unknown): ConversationItem[] {
      const m = msg as { type?: string; uuid?: string; total_cost_usd?: number; message?: { id?: string; content?: Array<{ type: string; text?: string; id?: string; name?: string }> } };
      if (m.type === 'assistant') {
        const out: ConversationItem[] = [];
        (m.message?.content ?? []).forEach((b, i) => {
          if (b.type === 'text') out.push(put({ kind: 'assistant', id: `${m.message!.id}:${i}`, text: b.text ?? '' }));
          if (b.type === 'tool_use') out.push(put({ kind: 'tool', id: b.id!, name: b.name!, state: 'running', summary: `Used ${b.name}` }));
        });
        return out;
      }
      if (m.type === 'result') return [put({ kind: 'notice', id: `${m.uuid}:cost`, notice: 'cost', text: 'cost', costUsd: m.total_cost_usd })];
      return [];
    },
    items: () => [...all.values()],
    markInterrupted() {
      b.interrupted++;
    },
  };
  return b;
}
