// Pending `canUseTool` requests: the cards the webview shows, the registry that holds the promises, and the mapping
// from the user's DecisionPayload back to the SDK's PermissionResult. Pure. No `vscode` import.
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { LIMITS } from '../shared/protocol.ts';
import type { DecisionPayload, PendingBase, PendingField, PendingRequest, QuestionSpec } from '../shared/protocol.ts';

type Rec = Record<string, unknown>;
type PermissionCard = Extract<PendingRequest, { kind: 'permission' }>;

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers

/** Cut to `max` characters, ending in `...` when something was cut. */
export function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + '...';
}

function oneLine(s: string, max: number = LIMITS.toolSummaryChars): string {
  return cut(s.replace(/\s+/g, ' ').trim(), max);
}

function rec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function base(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Card building

export interface PendingToolCall {
  toolName: string;
  input: Rec;
  /** Raw SDK suggestions (kept by the registry; the webview only sees canAlwaysAllow / alwaysLabel). */
  suggestions?: readonly PermissionUpdate[] | null;
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  description?: string;
  suppressAlwaysAllowRule?: boolean;
}

function field(label: string, value: unknown, code?: boolean): PendingField | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const f: PendingField = { label, value: cut(value, LIMITS.fieldChars) };
  if (code) f.code = true;
  return f;
}

function compact(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function genericFields(input: Rec, max: number, skip: ReadonlySet<string> = new Set()): PendingField[] {
  const out: PendingField[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (out.length >= max) break;
    if (skip.has(k) || v === undefined || v === null) continue;
    const f = field(k, compact(v));
    if (f) out.push(f);
  }
  return out;
}

/** `mcp__server__tool` gives `{server, tool}`. */
function mcpParts(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const parts = name.split('__');
  if (parts.length < 3) return { server: '', tool: parts[1] ?? name };
  return { server: parts[1] ?? '', tool: parts.slice(2).join('__') };
}

function prettyMcp(name: string): string {
  const m = mcpParts(name);
  if (!m) return name;
  return m.server !== '' ? `${m.server}: ${m.tool}` : m.tool;
}

function filePathOf(input: Rec): string | undefined {
  return nonEmpty(input['file_path']) ?? nonEmpty(input['path']) ?? nonEmpty(input['notebook_path']);
}

/** One-line summary and the detail fields for a permission card. Never throws. */
export function describeTool(toolName: string, input: Rec): { summary: string; fields: PendingField[] } {
  const f: (PendingField | undefined)[] = [];
  let summary: string;
  switch (toolName) {
    case 'Bash': {
      const command = nonEmpty(input['command']);
      const description = nonEmpty(input['description']);
      summary = description ?? (command !== undefined ? `Run ${command}` : 'Run a command');
      f.push(field('Command', command, true), field('Description', description));
      break;
    }
    case 'Edit': {
      const p = filePathOf(input);
      summary = p !== undefined ? `Edit ${base(p)}` : 'Edit a file';
      f.push(field('File', p), field('Old', typeof input['old_string'] === 'string' ? input['old_string'] : undefined, true), field('New', typeof input['new_string'] === 'string' ? input['new_string'] : undefined, true));
      if (input['replace_all'] === true) f.push(field('Replace all', 'yes'));
      break;
    }
    case 'MultiEdit': {
      const p = filePathOf(input);
      summary = p !== undefined ? `Edit ${base(p)}` : 'Edit a file';
      f.push(field('File', p));
      const edits = Array.isArray(input['edits']) ? input['edits'] : [];
      // 12 fields in all: File, then up to 5 old/new pairs, then a "more" line.
      const shown = Math.min(edits.length, 5);
      for (let i = 0; i < shown; i++) {
        const e = rec(edits[i]);
        const n = edits.length > 1 ? ` ${i + 1}` : '';
        f.push(field(`Old${n}`, typeof e?.['old_string'] === 'string' ? e['old_string'] : undefined, true), field(`New${n}`, typeof e?.['new_string'] === 'string' ? e['new_string'] : undefined, true));
      }
      if (edits.length > shown) f.push(field('More', `${edits.length - shown} more edit${edits.length - shown === 1 ? '' : 's'}`));
      break;
    }
    case 'Write': {
      const p = filePathOf(input);
      summary = p !== undefined ? `Write ${base(p)}` : 'Write a file';
      f.push(field('File', p), field('Content', typeof input['content'] === 'string' ? input['content'] : undefined, true));
      break;
    }
    case 'NotebookEdit': {
      const p = nonEmpty(input['notebook_path']) ?? filePathOf(input);
      summary = p !== undefined ? `Edit notebook ${base(p)}` : 'Edit a notebook';
      f.push(
        field('Notebook', p),
        field('Cell', nonEmpty(input['cell_id']) ?? (typeof input['cell_number'] === 'number' ? String(input['cell_number']) : undefined)),
        field('Mode', nonEmpty(input['edit_mode'])),
        field('Type', nonEmpty(input['cell_type'])),
        field('Source', typeof input['new_source'] === 'string' ? input['new_source'] : undefined, true),
      );
      break;
    }
    case 'WebFetch': {
      const url = nonEmpty(input['url']);
      summary = url !== undefined ? `Fetch ${hostOf(url)}` : 'Fetch a web page';
      f.push(field('URL', url), field('Prompt', nonEmpty(input['prompt'])));
      break;
    }
    case 'WebSearch': {
      const q = nonEmpty(input['query']);
      summary = q !== undefined ? `Search the web for "${q}"` : 'Search the web';
      f.push(field('Query', q));
      break;
    }
    case 'Read':
    case 'LS': {
      const p = filePathOf(input);
      summary = p !== undefined ? `${toolName === 'LS' ? 'List' : 'Read'} ${base(p)}` : `Use ${toolName}`;
      f.push(field(toolName === 'LS' ? 'Path' : 'File', p), field('Offset', typeof input['offset'] === 'number' ? String(input['offset']) : undefined), field('Limit', typeof input['limit'] === 'number' ? String(input['limit']) : undefined));
      break;
    }
    case 'Glob':
    case 'Grep': {
      const pattern = nonEmpty(input['pattern']);
      summary = pattern !== undefined ? `${toolName === 'Glob' ? 'Find files' : 'Search for'} ${pattern}` : `Use ${toolName}`;
      f.push(field('Pattern', pattern, true), field('Path', nonEmpty(input['path'])), field('Glob', nonEmpty(input['glob'])));
      break;
    }
    default: {
      const mcp = mcpParts(toolName);
      if (mcp) {
        summary = `Use ${prettyMcp(toolName)}`;
        f.push(field('Tool', prettyMcp(toolName)));
        f.push(...genericFields(input, LIMITS.fields - 1));
      } else {
        summary = `Use ${toolName}`;
        f.push(...genericFields(input, LIMITS.fields));
      }
    }
  }
  return { summary: oneLine(summary), fields: f.filter((x): x is PendingField => x !== undefined).slice(0, LIMITS.fields) };
}

/** Label for the always-allow button, from the first addRules suggestion, else setMode, else a plain default. */
export function alwaysLabelFor(suggestions: readonly PermissionUpdate[], toolName: string): string {
  for (const s of suggestions) {
    if (s.type === 'addRules') {
      const r = s.rules[0];
      if (r) {
        const content = r.ruleContent !== undefined && r.ruleContent !== '' ? r.ruleContent : undefined;
        return cut(content !== undefined ? `Always allow "${content}"` : `Always allow ${r.toolName || toolName}`, 200);
      }
    }
  }
  for (const s of suggestions) {
    if (s.type === 'setMode' && s.mode === 'acceptEdits') return 'Auto-accept file edits this session';
  }
  return 'Always allow';
}

function parseQuestions(input: Rec): { spec: QuestionSpec; origLabels: Map<string, string> }[] {
  const raw = Array.isArray(input['questions']) ? input['questions'] : [];
  const out: { spec: QuestionSpec; origLabels: Map<string, string> }[] = [];
  for (const q of raw) {
    if (out.length >= LIMITS.questions) break;
    const r = rec(q);
    const question = nonEmpty(r?.['question']);
    if (!r || question === undefined) continue;
    const origLabels = new Map<string, string>();
    const options: QuestionSpec['options'] = [];
    for (const o of Array.isArray(r['options']) ? r['options'] : []) {
      if (options.length >= LIMITS.options) break;
      const or = rec(o);
      const label = nonEmpty(or?.['label']);
      if (!or || label === undefined) continue;
      const shown = cut(label, LIMITS.labelChars);
      if (origLabels.has(shown)) continue;
      origLabels.set(shown, label);
      const opt: QuestionSpec['options'][number] = { label: shown, description: cut(typeof or['description'] === 'string' ? or['description'] : '', LIMITS.fieldChars) };
      if (typeof or['preview'] === 'string' && or['preview'] !== '') opt.preview = cut(or['preview'], LIMITS.fieldChars);
      options.push(opt);
    }
    out.push({
      spec: {
        question: cut(question, LIMITS.questionChars),
        header: cut(typeof r['header'] === 'string' ? r['header'] : '', 60),
        options,
        multiSelect: r['multiSelect'] === true,
      },
      origLabels,
    });
  }
  return out;
}

/** Build the card for a canUseTool call: AskUserQuestion is a question, ExitPlanMode a plan, the rest permissions. */
export function buildPendingRequest(b: PendingBase, call: PendingToolCall): PendingRequest {
  if (call.toolName === 'AskUserQuestion') {
    const qs = parseQuestions(call.input);
    if (qs.length > 0) return { ...b, kind: 'question', questions: qs.map((q) => q.spec) };
  }
  if (call.toolName === 'ExitPlanMode') {
    const plan = typeof call.input['plan'] === 'string' ? call.input['plan'] : '';
    const card: PendingRequest = { ...b, kind: 'plan', plan: cut(plan, LIMITS.planChars) };
    const pf = nonEmpty(call.input['planFilePath']);
    if (pf !== undefined) card.planFilePath = cut(pf, LIMITS.pathChars);
    return card;
  }
  const { summary, fields } = describeTool(call.toolName, call.input);
  const shown = fields.slice(0, call.blockedPath !== undefined ? LIMITS.fields - 1 : LIMITS.fields);
  if (call.blockedPath !== undefined && call.blockedPath !== '' && !shown.some((x) => x.value === call.blockedPath)) {
    shown.push({ label: 'Path', value: cut(call.blockedPath, LIMITS.fieldChars) });
  }
  const suggestions = call.suggestions ?? [];
  const canAlways = suggestions.length > 0 && call.suppressAlwaysAllowRule !== true;
  const card: PermissionCard = {
    ...b,
    kind: 'permission',
    toolName: cut(call.toolName, 200),
    summary: nonEmpty(call.title) !== undefined && summary === `Use ${call.toolName}` ? oneLine(call.title!) : summary,
    fields: shown,
    canAlwaysAllow: canAlways,
  };
  const reason = nonEmpty(call.decisionReason) ?? nonEmpty(call.description) ?? nonEmpty(call.title);
  if (reason !== undefined && reason !== card.summary) card.reason = cut(reason, LIMITS.fieldChars);
  if (canAlways) card.alwaysLabel = alwaysLabelFor(suggestions, call.toolName);
  return card;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decisions

export const DEFAULT_DENY_MESSAGE = 'The user declined.';
export const DEFAULT_SKIP_QUESTION_MESSAGE = 'The user chose not to answer. Continue without this information, or make a reasonable assumption.';
export const DEFAULT_PLAN_REJECT_MESSAGE = 'Keep planning.';
export const INTERRUPTED_MESSAGE = 'Interrupted';

/**
 * The suggestions to apply for "always allow". Persistent destinations that reach beyond this machine's local choices
 * (userSettings, projectSettings) are redirected to `localSettings`; `session` and `cliArg` stay as given.
 */
export function alwaysPermissions(suggestions: readonly PermissionUpdate[]): PermissionUpdate[] {
  return suggestions.map((s) => (s.destination === 'userSettings' || s.destination === 'projectSettings' ? { ...s, destination: 'localSettings' as const } : s));
}

interface QuestionMeta {
  spec: QuestionSpec;
  origQuestion: string;
  origLabels: Map<string, string>;
}

/** What the registry keeps next to each card. */
export interface PendingEntryData {
  request: PendingRequest;
  input: Rec;
  suggestions: readonly PermissionUpdate[];
  questions?: QuestionMeta[];
}

export type DecisionOutcome = { ok: true; result: PermissionResult } | { ok: false; message: string };

function bad(message: string): DecisionOutcome {
  return { ok: false, message };
}

function cleanMessage(m: string | undefined, fallback: string): string {
  return m !== undefined && m.trim() !== '' ? cut(m, LIMITS.feedbackChars) : fallback;
}

/** Map the user's decision to the SDK result, or say why it cannot be applied (the request then stays pending). */
export function decisionToResult(entry: PendingEntryData, decision: DecisionPayload): DecisionOutcome {
  const req = entry.request;
  switch (req.kind) {
    case 'permission': {
      if (decision.kind === 'allow') {
        if (decision.always === true) {
          if (!req.canAlwaysAllow) return bad('"Always allow" is not available for this request.');
          return { ok: true, result: { behavior: 'allow', updatedInput: entry.input, updatedPermissions: alwaysPermissions(entry.suggestions) } };
        }
        return { ok: true, result: { behavior: 'allow', updatedInput: entry.input } };
      }
      if (decision.kind === 'deny') return { ok: true, result: { behavior: 'deny', message: cleanMessage(decision.message, DEFAULT_DENY_MESSAGE) } };
      return bad('This request needs Allow or Deny.');
    }
    case 'plan': {
      if (decision.kind !== 'plan') return bad('This request needs a plan decision.');
      if (decision.approve) return { ok: true, result: { behavior: 'allow', updatedInput: entry.input } };
      return { ok: true, result: { behavior: 'deny', message: cleanMessage(decision.feedback, DEFAULT_PLAN_REJECT_MESSAGE) } };
    }
    case 'question': {
      if (decision.kind === 'deny') return { ok: true, result: { behavior: 'deny', message: cleanMessage(decision.message, DEFAULT_SKIP_QUESTION_MESSAGE) } };
      if (decision.kind !== 'answer') return bad('This request needs answers.');
      const metas = entry.questions ?? [];
      const known = new Map(metas.map((m) => [m.spec.question, m] as const));
      for (const k of Object.keys(decision.answers)) if (!known.has(k)) return bad('An answer does not match any question.');
      for (const k of Object.keys(decision.other ?? {})) if (!known.has(k)) return bad('A free-text answer does not match any question.');
      const answers: Record<string, string> = {};
      for (const m of metas) {
        const q = m.spec.question;
        const given = decision.answers[q];
        const otherRaw = decision.other?.[q];
        const other = otherRaw !== undefined && otherRaw.trim() !== '' ? otherRaw.trim() : undefined;
        const chosen = given === undefined ? [] : Array.isArray(given) ? given : given === '' ? [] : [given];
        const valid: string[] = [];
        for (const label of chosen) {
          const orig = m.origLabels.get(label);
          if (orig === undefined) {
            if (other === undefined) return bad(`"${cut(label, 60)}" is not an option for "${cut(q, 60)}".`);
            continue; // a pseudo label such as "Other" next to a free-text answer
          }
          if (!valid.includes(orig)) valid.push(orig);
        }
        if (m.spec.multiSelect) {
          const parts = other !== undefined ? [...valid, other] : valid;
          if (parts.length === 0) return bad(`Choose at least one option for "${cut(q, 60)}".`);
          answers[m.origQuestion] = parts.join(', ');
        } else {
          if (other !== undefined) answers[m.origQuestion] = other;
          else if (valid.length === 1) answers[m.origQuestion] = valid[0]!;
          else if (valid.length === 0) return bad(`Answer "${cut(q, 60)}".`);
          else return bad(`Choose only one option for "${cut(q, 60)}".`);
        }
      }
      return { ok: true, result: { behavior: 'allow', updatedInput: { questions: entry.input['questions'], answers } } };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry

export interface CreatePendingArgs extends PendingToolCall {
  sessionId: string;
  /** The SDK's toolUseID; used to make the requestId. */
  toolUseID?: string;
  /** The SDK's abort signal for this call: the pending request is denied when it fires. */
  signal?: AbortSignal;
}

export type PendingRemovedHow = 'decided' | 'cancelled' | 'aborted';

export interface PendingRegistryOptions {
  now?: () => number;
  onAdded?: (request: PendingRequest) => void;
  onRemoved?: (request: PendingRequest, how: PendingRemovedHow) => void;
  /** Ids, kinds and outcomes only; never the request's text. */
  log?: (msg: string) => void;
}

export type DecideOutcome =
  | { ok: true; request: PendingRequest }
  | { ok: false; duplicate: boolean; message: string };

interface Entry extends PendingEntryData {
  resolve: (r: PermissionResult) => void;
  cleanup: () => void;
  seq: number;
}

export class PendingRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #recent: string[] = [];
  readonly #now: () => number;
  readonly #opts: PendingRegistryOptions;
  #seq = 0;

  constructor(opts: PendingRegistryOptions = {}) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Register a request. The promise resolves with the SDK result once decided, cancelled or aborted. Never rejects. */
  create(args: CreatePendingArgs): { requestId: string; request: PendingRequest; promise: Promise<PermissionResult> } {
    const seq = ++this.#seq;
    let requestId = `${args.sessionId}:${(args.toolUseID ?? `req${seq}`).slice(0, 80)}`.slice(0, LIMITS.idChars);
    if (this.#entries.has(requestId) || this.#recent.includes(requestId)) requestId = `${requestId.slice(0, LIMITS.idChars - 12)}#${seq}`;
    const request = buildPendingRequest({ requestId, sessionId: args.sessionId, at: this.#now() }, args);
    let resolve!: (r: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((res) => {
      resolve = res;
    });
    const entry: Entry = {
      request,
      input: args.input,
      suggestions: args.suggestions ?? [],
      resolve,
      cleanup: () => {},
      seq,
    };
    if (request.kind === 'question') {
      entry.questions = parseQuestions(args.input).map((q) => ({ spec: q.spec, origQuestion: this.#origQuestion(args.input, q.spec.question), origLabels: q.origLabels }));
    }
    const signal = args.signal;
    if (signal?.aborted === true) {
      resolve(this.#cancelResult(INTERRUPTED_MESSAGE));
      return { requestId, request, promise };
    }
    this.#entries.set(requestId, entry);
    if (signal) {
      const onAbort = (): void => this.#remove(requestId, this.#cancelResult(INTERRUPTED_MESSAGE), 'aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    this.#fire(() => this.#opts.onAdded?.(request));
    return { requestId, request, promise };
  }

  /** Apply a decision. A bad one leaves the request pending. A repeat of an answered id is reported as `duplicate`. */
  decide(requestId: string, decision: DecisionPayload): DecideOutcome {
    const entry = this.#entries.get(requestId);
    if (!entry) {
      return this.#recent.includes(requestId)
        ? { ok: false, duplicate: true, message: 'That request was already answered.' }
        : { ok: false, duplicate: false, message: 'That request is no longer waiting for an answer.' };
    }
    const out = decisionToResult(entry, decision);
    if (!out.ok) return { ok: false, duplicate: false, message: out.message };
    const request = entry.request;
    this.#remove(requestId, out.result, 'decided');
    return { ok: true, request };
  }

  /** Deny (with interrupt) every request of a session: used by interrupt and stop. Returns the cancelled cards. */
  cancelSession(sessionId: string, message: string = INTERRUPTED_MESSAGE): PendingRequest[] {
    const out: PendingRequest[] = [];
    for (const e of this.#sorted()) {
      if (e.request.sessionId !== sessionId) continue;
      out.push(e.request);
      this.#remove(e.request.requestId, this.#cancelResult(message), 'cancelled');
    }
    return out;
  }

  cancelAll(message: string = INTERRUPTED_MESSAGE): PendingRequest[] {
    const out: PendingRequest[] = [];
    for (const e of this.#sorted()) {
      out.push(e.request);
      this.#remove(e.request.requestId, this.#cancelResult(message), 'cancelled');
    }
    return out;
  }

  get(requestId: string): PendingRequest | undefined {
    return this.#entries.get(requestId)?.request;
  }

  /** The open requests of a session, oldest first. */
  list(sessionId: string): PendingRequest[] {
    return this.#sorted().filter((e) => e.request.sessionId === sessionId).map((e) => e.request);
  }

  /** The request the card should show now: the oldest one. */
  first(sessionId: string): PendingRequest | undefined {
    return this.list(sessionId)[0];
  }

  #sorted(): Entry[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
  }

  #cancelResult(message: string): PermissionResult {
    return { behavior: 'deny', message, interrupt: true };
  }

  #origQuestion(input: Rec, shown: string): string {
    const raw = Array.isArray(input['questions']) ? input['questions'] : [];
    for (const q of raw) {
      const t = nonEmpty(rec(q)?.['question']);
      if (t !== undefined && cut(t, LIMITS.questionChars) === shown) return t;
    }
    return shown;
  }

  #remove(requestId: string, result: PermissionResult, how: PendingRemovedHow): void {
    const entry = this.#entries.get(requestId);
    if (!entry) return;
    this.#entries.delete(requestId);
    this.#recent.push(requestId);
    if (this.#recent.length > 64) this.#recent.shift();
    try {
      entry.cleanup();
    } catch {
      // ignore
    }
    entry.resolve(result);
    this.#fire(() => this.#opts.log?.(`pending ${requestId} settled ${how}: ${result.behavior}`));
    this.#fire(() => this.#opts.onRemoved?.(entry.request, how));
  }

  #fire(fn: () => void): void {
    try {
      fn();
    } catch {
      // A listener bug must not strand the SDK's promise.
    }
  }
}
