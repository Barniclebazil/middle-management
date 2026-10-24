// Turns Claude Code transcript records and live Agent SDK messages into ConversationItem[].
// Pure: no vscode, no I/O, never throws on malformed input.
import { LIMITS } from '../shared/protocol.ts';
import type { ConversationItem, NoticeKind, ToolStepState } from '../shared/protocol.ts';
import { basename, classifyTool, shorten } from '../model/activity.ts';
import { createCostTracker } from './cost.ts';
import type { CostTracker } from './cost.ts';

type Rec = Record<string, unknown>;
type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

export interface TranscriptResult { items: ConversationItem[]; truncated: boolean }

export interface TranscriptOptions {
  /** Include sidechain (subagent) records. Set when reading a subagent transcript. */
  sidechain?: boolean;
  /** Keep at most this many items (default and ceiling: LIMITS.caseItems). */
  maxItems?: number;
}

export interface SdkItemBuilderOptions {
  /**
   * Cost tracker shared with the session runner (RunnerDeps.cost). Use the same instance wherever the same result
   * stream is observed, or a resume or a repeated result is counted twice. Default: a private tracker.
   */
  cost?: CostTracker;
  /** Session id used for cost when a result message carries no `session_id`. */
  sessionId?: string;
}

export interface SdkItemBuilder {
  /** Feed one SDK message. Returns the items added or changed by it (upserts, in order). */
  apply(msg: unknown): ConversationItem[];
  /** All retained items (at most LIMITS.caseItems, oldest first). */
  items(): ConversationItem[];
  /** Tell the builder the host called interrupt(), so the next error_during_execution is an interruption. */
  markInterrupted(): void;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function rec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Cut to `max` characters, ending in `...` when something was cut. */
export function cutText(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  return { text: s.slice(0, Math.max(0, max - 3)) + '...', cut: true };
}

function oneLine(s: string, max: number): string {
  return cutText(s.replace(/\s+/g, ' ').trim(), max).text;
}

function timeOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

function withAt<T extends { at?: number }>(item: T, at: number | undefined): T {
  if (at !== undefined) item.at = at;
  return item;
}

function mcpShortName(name: string): string {
  const parts = name.split('__').filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : name;
}

function host(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function field(input: unknown, key: string): string | undefined {
  return nonEmpty(rec(input)?.[key]);
}

function pathOf(input: unknown): string | undefined {
  return field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path');
}

// ---------------------------------------------------------------------------------------------
// Tool summaries and previews

/** One-line human phrasing of a tool call, at most LIMITS.toolSummaryChars. */
export function summarizeTool(name: string, input: unknown): string {
  let s: string;
  try {
    s = summaryFor(typeof name === 'string' ? name : '', input);
  } catch {
    s = typeof name === 'string' ? name : 'Tool';
  }
  return oneLine(s, LIMITS.toolSummaryChars);
}

function summaryFor(name: string, input: unknown): string {
  const p = pathOf(input);
  const file = p === undefined ? undefined : basename(p);
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return file ? `Read ${file}` : 'Read a file';
    case 'Grep': {
      const pat = field(input, 'pattern');
      return pat ? `Searched for "${oneLine(pat, 80)}"` : 'Searched the code';
    }
    case 'Glob': {
      const pat = field(input, 'pattern');
      return pat ? `Listed ${oneLine(pat, 80)}` : 'Listed files';
    }
    case 'LS':
      return file ? `Listed ${file}` : 'Listed a folder';
    case 'WebSearch': {
      const q = field(input, 'query');
      return q ? `Searched the web for ${oneLine(q, 100)}` : 'Searched the web';
    }
    case 'WebFetch': {
      const u = field(input, 'url');
      return u ? `Fetched ${host(u)}` : 'Fetched a page';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Edited ${file}` : 'Edited a file';
    case 'Write':
      return file ? `Wrote ${file}` : 'Wrote a file';
    case 'Bash': {
      const d = field(input, 'description') ?? field(input, 'command');
      return d ? `Ran: ${oneLine(d, 120)}` : 'Ran a command';
    }
    case 'BashOutput':
      return 'Checked a background command';
    case 'KillShell':
    case 'KillBash':
      return 'Stopped a background command';
    case 'AskUserQuestion':
      return 'Asked you a question';
    case 'ExitPlanMode':
      return 'Proposed a plan';
    case 'Agent':
    case 'Task': {
      const d = field(input, 'description');
      return d ? `Delegated: ${oneLine(d, 120)}` : 'Delegated a task';
    }
    case 'TodoWrite':
      return 'Updated the to-do list';
    case 'Skill': {
      const sk = field(input, 'skill') ?? field(input, 'name');
      return sk ? `Used skill ${oneLine(sk, 60)}` : 'Used a skill';
    }
    case 'ToolSearch':
      return 'Looked up tools';
    case 'SendMessage': {
      const to = field(input, 'to');
      return to ? `Messaged ${oneLine(to, 60)}` : 'Sent a message';
    }
    default:
      break;
  }
  if (name.startsWith('mcp__')) return mcpShortName(name);
  // Unknown tool: fall back to the office's own classification detail, then the bare name.
  const detail = classifyTool(name, input).detail;
  return name === '' ? 'Tool' : detail && detail !== shorten(name) ? `${name}: ${detail}` : name;
}

/** Compact, truncated preview of a tool input. */
export function previewInput(name: string, input: unknown): string | undefined {
  try {
    if (input === undefined || input === null) return undefined;
    let text: string;
    const cmd = name === 'Bash' ? field(input, 'command') : undefined;
    if (cmd !== undefined) text = cmd;
    else if (typeof input === 'string') text = input;
    else text = JSON.stringify(input) ?? '';
    if (text === '' || text === '{}') return undefined;
    return cutText(text, LIMITS.toolPreviewChars).text;
  } catch {
    return undefined;
  }
}

/** Text of a tool_result `content` (string or block array). Images become "[image]". */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const r = rec(b);
    if (!r) continue;
    if (r['type'] === 'text' && typeof r['text'] === 'string') parts.push(r['text']);
    else if (r['type'] === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

const DENIED_RE =
  /doesn't want to proceed|user rejected|rejected tool use|tool use was rejected|permission to use .{1,80} has been denied|user declined|user denied|was denied by the user/i;

function isDeniedText(t: string): boolean {
  return DENIED_RE.test(t.slice(0, 600));
}

function stateFor(block: Rec, text: string, extra?: Rec): ToolStepState {
  const denied = (d: unknown): boolean => {
    const dec = typeof d === 'string' ? d : str(rec(d)?.['decision']) ?? str(rec(d)?.['behavior']);
    return dec === 'reject' || dec === 'deny' || dec === 'denied';
  };
  if (extra) {
    if (denied(extra['permissionDecision'])) return 'denied';
    const meta = extra['tool_result_meta'];
    if (Array.isArray(meta) && meta.some((m) => denied(rec(m)?.['permission_decision']))) return 'denied';
    if (typeof extra['toolUseResult'] === 'string' && isDeniedText(extra['toolUseResult'] as string)) return 'denied';
  }
  if (denied(block['permissionDecision'])) return 'denied';
  if (block['is_error'] === true) return isDeniedText(text) ? 'denied' : 'error';
  return 'done';
}

// ---------------------------------------------------------------------------------------------
// Plans (ExitPlanMode)

type PlanItem = Extract<ConversationItem, { kind: 'plan' }>;

function makePlan(id: string, input: unknown, at: number | undefined): PlanItem {
  const raw = str(rec(input)?.['plan']) ?? '';
  const { text, cut } = cutText(raw, LIMITS.planChars);
  const item: PlanItem = { kind: 'plan', id, text, status: 'pending' };
  if (cut) item.truncated = true;
  const pf = nonEmpty(rec(input)?.['planFilePath']);
  if (pf !== undefined) item.planFilePath = cutText(pf, LIMITS.pathChars).text;
  return withAt(item, at);
}

const SAID_RE = /the user said:\s*([\s\S]*)$/i;
const DEFAULT_REJECT_TEXTS = new Set(['Keep planning.']);

/** The user's reason from a rejected ExitPlanMode result, if there is one. */
function planFeedback(text: string): string | undefined {
  const said = SAID_RE.exec(text)?.[1]?.trim();
  let fb = said !== undefined && said !== '' ? said : isDeniedText(text) ? undefined : text.trim();
  if (fb === undefined || fb === '' || DEFAULT_REJECT_TEXTS.has(fb)) return undefined;
  fb = cutText(fb, LIMITS.feedbackChars).text;
  return fb;
}

/** Plan lifecycle shared by the transcript and live paths. Methods return the plan items they changed. */
class Plans {
  readonly byId = new Map<string, PlanItem>();

  /** A plan opens: older pending plans are superseded. Re-opening a known id changes nothing. */
  open(id: string, input: unknown, at: number | undefined): { item: PlanItem; changed: PlanItem[] } {
    const known = this.byId.get(id);
    if (known) return { item: known, changed: [] };
    const changed: PlanItem[] = [];
    for (const p of this.byId.values()) {
      if (p.status === 'pending') {
        p.status = 'superseded';
        changed.push(p);
      }
    }
    const item = makePlan(id, input, at);
    this.byId.set(id, item);
    changed.push(item);
    return { item, changed };
  }

  /** The tool_result arrived. Returns the updated plan, or undefined if `id` is not a plan or already decided. */
  decide(id: string, block: Rec, extra?: Rec): PlanItem | undefined {
    const p = this.byId.get(id);
    if (!p || (p.status !== 'pending' && p.status !== 'superseded')) return undefined;
    const text = resultText(block['content']);
    if (stateFor(block, text, extra) === 'done') {
      p.status = 'approved';
    } else {
      p.status = 'rejected';
      const fb = planFeedback(text);
      if (fb !== undefined) p.feedback = fb;
    }
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared item store

class Store {
  readonly list: ConversationItem[] = [];
  readonly byId = new Map<string, ConversationItem>();
  dropped = false;
  private readonly cap: number;
  /** Next content block index per API message id. */
  readonly blockCount = new Map<string, number>();

  constructor(cap: number) {
    this.cap = Math.max(1, Math.min(cap, LIMITS.caseItems));
  }

  /** Insert or replace by id (replace keeps position). Returns the stored item. */
  put(item: ConversationItem): ConversationItem {
    const old = this.byId.get(item.id);
    if (old) {
      const i = this.list.indexOf(old);
      if (i >= 0) this.list[i] = item;
    } else {
      this.list.push(item);
      while (this.list.length > this.cap) {
        const gone = this.list.shift()!;
        this.byId.delete(gone.id);
        this.dropped = true;
      }
    }
    this.byId.set(item.id, item);
    return item;
  }

  get(id: string): ConversationItem | undefined {
    return this.byId.get(id);
  }

  /** Reserve block indexes for a message that carries `n` blocks; returns the first index. */
  reserve(messageId: string, n: number): number {
    const at = this.blockCount.get(messageId) ?? 0;
    this.blockCount.set(messageId, at + n);
    return at;
  }
}

function makeTool(id: string, name: string, input: unknown, at: number | undefined, parent?: string): ToolItem {
  const item: ToolItem = { kind: 'tool', id, name, state: 'running', summary: summarizeTool(name, input) };
  const pre = previewInput(name, input);
  if (pre !== undefined) item.input = pre;
  if (parent) item.parentToolUseId = parent;
  return withAt(item, at);
}

function finishTool(tool: ToolItem, block: Rec, extra?: Rec): void {
  const text = resultText(block['content']);
  tool.state = stateFor(block, text, extra);
  if (text !== '') tool.output = cutText(text, LIMITS.toolPreviewChars).text;
  else delete tool.output;
}

function textItem(kind: 'prompt' | 'assistant', id: string, text: string, at: number | undefined): ConversationItem {
  const { text: t, cut } = cutText(text, kind === 'prompt' ? LIMITS.promptChars : LIMITS.assistantTextChars);
  const out: ConversationItem = kind === 'prompt' ? { kind, id, text: t } : { kind, id, text: t };
  if (cut) out.truncated = true;
  return withAt(out, at);
}

function notice(id: string, kind: NoticeKind, text: string, at: number | undefined, costUsd?: number): ConversationItem {
  const n: ConversationItem = { kind: 'notice', id, notice: kind, text: cutText(text, LIMITS.errorChars).text };
  if (costUsd !== undefined) n.costUsd = costUsd;
  return withAt(n, at);
}

const INTERRUPT_RE = /^\[Request interrupted by user/;

function isSkippablePromptText(t: string): boolean {
  const s = t.trimStart();
  return s === '' || s.startsWith('<local-command') || s.startsWith('<command-') || s.startsWith('<system-reminder');
}

/** Concatenate the text of a user message content that is not tool_result. */
function userTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    const r = rec(b);
    if (r && r['type'] === 'text' && typeof r['text'] === 'string') out.push(r['text']);
  }
  return out;
}

function toolResults(content: unknown): Rec[] {
  if (!Array.isArray(content)) return [];
  const out: Rec[] = [];
  for (const b of content) {
    const r = rec(b);
    if (r && r['type'] === 'tool_result') out.push(r);
  }
  return out;
}

function errorTextOf(r: Rec): string {
  const err = r['error'];
  const m = typeof err === 'string' ? err : str(rec(err)?.['message']);
  if (m) return m;
  const content = rec(r['message'])?.['content'];
  const t = resultText(content);
  if (t) return t;
  return str(r['content']) ?? str(r['text']) ?? 'API error';
}

// ---------------------------------------------------------------------------------------------
// Transcript

/**
 * Convert transcript records (parsed JSONL lines, in file order) to conversation items.
 * Keeps the last `LIMITS.caseItems` items; `truncated` is true when older ones were dropped.
 */
export function itemsFromTranscript(records: unknown[], opts: TranscriptOptions = {}): TranscriptResult {
  const store = new Store(opts.maxItems ?? LIMITS.caseItems);
  if (!Array.isArray(records)) return { items: [], truncated: false };
  const tools = new Map<string, ToolItem>();
  const plans = new Plans();
  let n = 0;
  /** The assistant text item that a following text block of the same message may extend. */
  let lastText: { msgId: string; id: string } | undefined;

  const interruptOpenTools = (): void => {
    for (const t of tools.values()) if (t.state === 'running') { t.state = 'error'; t.output = 'Interrupted by user'; }
  };

  for (const raw of records) {
    n++;
    try {
      const r = rec(raw);
      if (!r) continue;
      if (r['isSidechain'] === true && opts.sidechain !== true) continue;
      const type = r['type'];
      const at = timeOf(r['timestamp']);
      const uuid = nonEmpty(r['uuid']);

      if (type === 'user') {
        if (r['isMeta'] === true) continue;
        const content = rec(r['message'])?.['content'];
        for (const b of toolResults(content)) {
          const id = str(b['tool_use_id']);
          const tool = id ? tools.get(id) : undefined;
          if (tool) finishTool(tool, b, r);
          else if (id) {
            const plan = plans.decide(id, b, r);
            if (plan) store.put({ ...plan });
          }
        }
        const texts = userTexts(content);
        for (const t of texts) {
          if (INTERRUPT_RE.test(t.trimStart())) {
            interruptOpenTools();
            store.put(notice(`${uuid ?? 'rec' + n}:interrupted`, 'interrupted', t.trim(), at));
            lastText = undefined;
          } else if (!isSkippablePromptText(t)) {
            store.put(textItem('prompt', texts.length > 1 ? `${uuid ?? 'rec' + n}:${texts.indexOf(t)}` : uuid ?? `rec${n}`, t, at));
            lastText = undefined;
          }
        }
        continue;
      }

      if (type === 'assistant') {
        const msg = rec(r['message']);
        if (!msg) continue;
        if (r['isApiErrorMessage'] === true) {
          store.put(notice(uuid ?? `rec${n}`, 'error', errorTextOf(r), at));
          lastText = undefined;
          continue;
        }
        const msgId = nonEmpty(msg['id']) ?? `rec${n}`;
        const blocks = Array.isArray(msg['content']) ? (msg['content'] as unknown[]) : typeof msg['content'] === 'string' ? [{ type: 'text', text: msg['content'] }] : [];
        const first = store.reserve(msgId, blocks.length);
        blocks.forEach((raw2, i) => {
          const b = rec(raw2);
          if (!b) return;
          const id = `${msgId}:${first + i}`;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            if (b['text'].trim() === '') return;
            if (lastText && lastText.msgId === msgId) {
              const prev = store.get(lastText.id);
              if (prev && prev.kind === 'assistant') {
                const merged = textItem('assistant', prev.id, prev.text + '\n\n' + b['text'], prev.at) as typeof prev;
                if (prev.truncated) merged.truncated = true;
                store.put(merged);
                return;
              }
            }
            store.put(textItem('assistant', id, b['text'], at));
            lastText = { msgId, id };
          } else if (b['type'] === 'thinking') {
            store.put(withAt<ConversationItem>({ kind: 'thinking', id }, at));
            lastText = undefined;
          } else if (b['type'] === 'tool_use') {
            const tid = nonEmpty(b['id']) ?? id;
            if (b['name'] === 'ExitPlanMode') {
              const { item, changed } = plans.open(tid, b['input'], at);
              for (const c of changed) store.put(c === item ? c : { ...c });
            } else {
              const tool = makeTool(tid, str(b['name']) ?? 'tool', b['input'], at);
              tools.set(tid, tool);
              store.put(tool);
            }
            lastText = undefined;
          }
        });
        continue;
      }

      if (type === 'system') {
        const sub = r['subtype'];
        if (sub === 'compact_boundary') {
          store.put(notice(uuid ?? `rec${n}`, 'info', 'Conversation compacted', at));
          lastText = undefined;
        } else if (sub === 'api_error' || sub === 'error') {
          store.put(notice(uuid ?? `rec${n}`, 'error', errorTextOf(r), at));
          lastText = undefined;
        }
        continue;
      }
      // Everything else (ai-title, file-history-snapshot, queue-operation, attachment, ...) is bookkeeping.
    } catch {
      // A malformed record never stops the rest.
    }
  }
  return { items: store.list.slice(), truncated: store.dropped };
}

// ---------------------------------------------------------------------------------------------
// Live SDK messages

/** Create the stateful converter for the SDK messages of one office run. */
export function createSdkItemBuilder(opts: SdkItemBuilderOptions = {}): SdkItemBuilder {
  const store = new Store(LIMITS.caseItems);
  const cost = opts.cost ?? createCostTracker();
  const plans = new Plans();
  const tools = new Map<string, ToolItem>();
  const streams = new Map<string, string>(); // item id -> accumulated raw text
  const currentMsg = new Map<string, string>(); // parent tool use id ('' = main) -> API message id
  let n = 0;
  let interrupted = false;

  const apply = (msg: unknown): ConversationItem[] => {
    const changed: ConversationItem[] = [];
    const put = (item: ConversationItem): void => {
      store.put(item);
      changed.push({ ...item });
    };
    try {
      const m = rec(msg);
      if (!m) return changed;
      n++;
      const type = m['type'];
      const uuid = nonEmpty(m['uuid']);
      const at = timeOf(m['timestamp']) ?? Date.now();
      const parent = nonEmpty(m['parent_tool_use_id']);

      if (type === 'user') {
        const content = rec(m['message'])?.['content'];
        for (const b of toolResults(content)) {
          const tool = tools.get(str(b['tool_use_id']) ?? '');
          if (tool) {
            finishTool(tool, b, m);
            changed.push({ ...tool });
          } else {
            const plan = plans.decide(str(b['tool_use_id']) ?? '', b, m);
            if (plan) put(plan);
          }
        }
        if (parent) return changed;
        const texts = userTexts(content);
        for (const t of texts) {
          if (INTERRUPT_RE.test(t.trimStart())) {
            interrupted = true;
            for (const tool of tools.values()) {
              if (tool.state === 'running') {
                tool.state = 'error';
                tool.output = 'Interrupted by user';
                changed.push({ ...tool });
              }
            }
            put(notice(`${uuid ?? 'sdk' + n}:interrupted`, 'interrupted', t.trim(), at));
          } else if (!isSkippablePromptText(t) && m['isSynthetic'] !== true) {
            put(textItem('prompt', texts.length > 1 ? `${uuid ?? 'sdk' + n}:${texts.indexOf(t)}` : uuid ?? `sdk${n}`, t, at));
          }
        }
        return changed;
      }

      if (type === 'stream_event') {
        const ev = rec(m['event']);
        if (!ev || parent) return changed;
        if (ev['type'] === 'message_start') {
          const id = str(rec(ev['message'])?.['id']);
          if (id) currentMsg.set('', id);
          return changed;
        }
        if (ev['type'] === 'content_block_delta') {
          const delta = rec(ev['delta']);
          if (!delta || delta['type'] !== 'text_delta' || typeof delta['text'] !== 'string') return changed;
          const mid = nonEmpty(m['api_message_id']) ?? currentMsg.get('') ?? 'stream';
          const index = typeof ev['index'] === 'number' ? ev['index'] : 0;
          const id = `${mid}:${index}`;
          const raw = (streams.get(id) ?? '') + delta['text'];
          streams.set(id, raw.length > LIMITS.assistantTextChars * 2 ? raw.slice(0, LIMITS.assistantTextChars * 2) : raw);
          const item = textItem('assistant', id, raw, store.get(id)?.at ?? at) as Extract<ConversationItem, { kind: 'assistant' }>;
          item.streaming = true;
          put(item);
        }
        return changed;
      }

      if (type === 'assistant') {
        const message = rec(m['message']);
        if (!message) return changed;
        if (m['isApiErrorMessage'] === true) {
          put(notice(uuid ?? `sdk${n}`, 'error', errorTextOf(m), at));
          return changed;
        }
        const msgId = nonEmpty(message['id']) ?? nonEmpty(m['api_message_id']) ?? uuid ?? `sdk${n}`;
        const blocks = Array.isArray(message['content']) ? (message['content'] as unknown[]) : typeof message['content'] === 'string' ? [{ type: 'text', text: message['content'] }] : [];
        const first = store.reserve(msgId, blocks.length);
        blocks.forEach((raw, i) => {
          const b = rec(raw);
          if (!b) return;
          const id = `${msgId}:${first + i}`;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            if (parent || b['text'].trim() === '') return;
            const item = textItem('assistant', id, b['text'], store.get(id)?.at ?? at) as Extract<ConversationItem, { kind: 'assistant' }>;
            item.streaming = false;
            streams.delete(id);
            put(item);
          } else if (b['type'] === 'thinking') {
            if (!parent) put(withAt<ConversationItem>({ kind: 'thinking', id }, at));
          } else if (b['type'] === 'tool_use') {
            const tid = nonEmpty(b['id']) ?? id;
            if (b['name'] === 'ExitPlanMode' && !parent) {
              for (const c of plans.open(tid, b['input'], at).changed) put(c);
            } else {
              const tool = makeTool(tid, str(b['name']) ?? 'tool', b['input'], at, parent);
              tools.set(tid, tool);
              put(tool);
            }
          }
        });
        return changed;
      }

      if (type === 'result') {
        const sub = str(m['subtype']);
        const base = uuid ?? `sdk${n}`;
        // `[ede_diagnostic] ...` lines are the CLI's internal diagnostics (seen on every interrupt); they are not user-facing errors.
        const errors = Array.isArray(m['errors'])
          ? (m['errors'] as unknown[]).map((e) => (typeof e === 'string' ? e : str(rec(e)?.['message']) ?? '')).filter((e) => e !== '' && !e.startsWith('[ede_diagnostic]'))
          : [];
        if (sub === 'error_during_execution' && errors.length === 0) {
          if (!interrupted) put(notice(`${base}:interrupted`, 'interrupted', 'Interrupted by user', at));
          interrupted = false;
          for (const tool of tools.values()) {
            if (tool.state === 'running') {
              tool.state = 'error';
              tool.output = 'Interrupted by user';
              changed.push({ ...tool });
            }
          }
        } else if (sub !== undefined && sub !== 'success') {
          put(notice(`${base}:error`, 'error', errors.length > 0 ? errors.join('\n') : str(m['result']) ?? `Run ended: ${sub}`, at));
        } else if (m['is_error'] === true) {
          put(notice(`${base}:error`, 'error', str(m['result']) ?? 'Run failed', at));
        }
        // total_cost_usd is the session's running total; the tracker turns it into this turn's cost.
        const total = m['total_cost_usd'];
        if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
          const sid = nonEmpty(m['session_id']) ?? opts.sessionId ?? '';
          const { turnUsd, totalUsd } = cost.observe(sid, total);
          put(notice(`${base}:cost`, 'cost', `Turn cost $${turnUsd.toFixed(4)} (session $${totalUsd.toFixed(4)})`, at, turnUsd));
        }
        return changed;
      }

      if (type === 'system') {
        if (m['subtype'] === 'compact_boundary') put(notice(uuid ?? `sdk${n}`, 'info', 'Conversation compacted', at));
        return changed;
      }
    } catch {
      // Ignore malformed messages.
    }
    return changed;
  };

  return {
    apply,
    items: () => store.list.map((i) => ({ ...i })),
    markInterrupted: () => { interrupted = true; },
  };
}

/**
 * Seed a cost tracker from a transcript's newest `cost-state.totalCostUSD`, so the first live result of a resumed
 * session counts only its own turn. Returns the seeded total, or undefined when the records carry none.
 */
export function seedCostFromTranscript(records: unknown[], sessionId: string, tracker: CostTracker): number | undefined {
  if (!Array.isArray(records)) return undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = rec(records[i]);
    if (r?.['type'] !== 'cost-state') continue;
    const v = r['totalCostUSD'];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      tracker.seed(sessionId, v);
      return v;
    }
  }
  return undefined;
}

/** Convenience wrapper matching the doc's naming: convert one SDK message with a builder. */
export function itemsFromSdkMessage(msg: unknown, builder: SdkItemBuilder): ConversationItem[] {
  return builder.apply(msg);
}
