/**
 * Pure logic behind the case-file drawer: merging host updates, choosing the
 * footer, building decision payloads and the words shown in the header.
 * DOM-free so it can be unit-tested with plain Node.
 */
import { LIMITS, forAnotherCase } from '../../src/shared/protocol.ts';
import type {
  AgentControl, CaseAddress, CaseHeader, CaseTabBoot, ConversationItem, DecisionPayload, HostToWebview, PendingRequest, PlanStatus, QuestionSpec,
} from '../../src/shared/protocol.ts';
import { parseCaseTabBoot } from '../../src/shared/validate.ts';
import { ACTIVITY_WORDS } from './tooltip.ts';

// ---------------------------------------------------------------------------
// Merging host updates

export interface MergeResult {
  items: ConversationItem[];
  /** Ids that were already there and got replaced. */
  replaced: string[];
  /** Ids appended at the end, in order. */
  added: string[];
  /** Ids dropped from the front to stay within `max`. */
  dropped: string[];
}

/**
 * Upserts `incoming` into `current` by id: a known id is replaced in place, a
 * new one is appended (incoming order kept). Keeps at most `max` items (the
 * most recent). Never mutates its inputs.
 */
export function mergeItems(current: readonly ConversationItem[], incoming: readonly ConversationItem[], max: number = LIMITS.caseItems): MergeResult {
  const items = current.slice();
  const index = new Map<string, number>();
  items.forEach((it, i) => index.set(it.id, i));
  const replaced: string[] = [];
  const added: string[] = [];
  for (const it of incoming) {
    if (!it || typeof it.id !== 'string') continue;
    const at = index.get(it.id);
    if (at !== undefined) {
      items[at] = it;
      if (!replaced.includes(it.id) && !added.includes(it.id)) replaced.push(it.id);
    } else {
      index.set(it.id, items.length);
      items.push(it);
      added.push(it.id);
    }
  }
  const dropped: string[] = [];
  if (items.length > max) {
    for (const it of items.splice(0, items.length - max)) dropped.push(it.id);
  }
  const gone = new Set(dropped);
  return { items, replaced: replaced.filter((id) => !gone.has(id)), added: added.filter((id) => !gone.has(id)), dropped };
}

/** `caseAppend.pending`: undefined leaves the current request, null clears it, an object replaces it. */
export function applyPending(current: PendingRequest | null, incoming: PendingRequest | null | undefined): PendingRequest | null {
  if (incoming === undefined) return current;
  return incoming;
}

/** Partial header merge (keys whose value is undefined are ignored). */
export function mergeHeader(h: CaseHeader, partial: Partial<CaseHeader> | undefined): CaseHeader {
  if (!partial) return h;
  const out: CaseHeader = { ...h };
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Footer

export type FooterMode =
  /** A reply box. `label` is the send button; `hint` a short line under it. */
  | { kind: 'reply'; label: string; hint: string | null; placeholder: string; queued: boolean }
  /** Read-only: someone else has this session open. */
  | { kind: 'elsewhere'; text: string }
  /** Temps can't take orders; `parentId` links to their boss's case. */
  | { kind: 'temp'; text: string; parentId: string | null }
  /** Session ended or the case is closed. */
  | { kind: 'closed'; text: string };

/**
 * Picks the footer for a case header. `parentTitle`/`parentId` describe a
 * temp's boss when known; `isTemp` false marks a main session the host says
 * can't take orders (control 'none'), which is read-only rather than a temp.
 */
export function footerMode(h: Pick<CaseHeader, 'control' | 'busy' | 'title'> | null, parentTitle: string | null = null, parentId: string | null = null, isTemp = true): FooterMode {
  const control: AgentControl = h?.control ?? 'none';
  if (control === 'none' && !isTemp) return { kind: 'closed', text: 'Read-only: this session can\u2019t take orders from the office' };
  if (control === 'office') {
    const busy = h?.busy === true;
    return {
      kind: 'reply',
      label: busy ? 'Queue' : 'Send',
      hint: busy ? 'They\u2019ll read it when they finish this step' : null,
      placeholder: busy ? 'Add a note for when they finish this step…' : 'Reply to them…',
      queued: busy,
    };
  }
  if (control === 'free') {
    return { kind: 'reply', label: 'Continue in office', hint: 'Not running right now. Sending picks the session back up here.', placeholder: 'What should they do next?', queued: false };
  }
  if (control === 'elsewhere') return { kind: 'elsewhere', text: 'Open in another window, so it\u2019s read-only here.' };
  return { kind: 'temp', text: `Temps report to ${parentTitle ? `\u201c${parentTitle}\u201d` : 'their boss'}, not to you.`, parentId };
}

// ---------------------------------------------------------------------------
// Decisions

function clip(s: string | undefined, max: number): string | undefined {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : undefined;
}

/** Approve (optionally "always allow"). */
export function allowDecision(always = false): DecisionPayload {
  return always ? { kind: 'allow', always: true } : { kind: 'allow' };
}

/** Deny, with an optional reason shown to the model (blank is omitted). */
export function denyDecision(message?: string): DecisionPayload {
  const m = clip(message, LIMITS.feedbackChars);
  return m ? { kind: 'deny', message: m } : { kind: 'deny' };
}

/** Approve the plan, or keep planning with optional feedback. */
export function planDecision(approve: boolean, feedback?: string): DecisionPayload {
  if (approve) return { kind: 'plan', approve: true };
  const f = clip(feedback, LIMITS.feedbackChars);
  return f ? { kind: 'plan', approve: false, feedback: f } : { kind: 'plan', approve: false };
}

/** What the user picked for one question. */
export interface QuestionPick {
  /** Chosen option labels (at most one for single-select). */
  labels: string[];
  /** "Other…" is ticked. */
  otherOn: boolean;
  otherText: string;
}

export function emptyPick(): QuestionPick {
  return { labels: [], otherOn: false, otherText: '' };
}

/** Toggles an option: single-select replaces (and turns Other off), multi-select flips it. */
export function togglePick(q: QuestionSpec, p: QuestionPick, label: string): QuestionPick {
  if (!q.multiSelect) return { labels: [label], otherOn: false, otherText: p.otherText };
  const has = p.labels.includes(label);
  const labels = has ? p.labels.filter((l) => l !== label) : [...p.labels, label];
  // Keep the options' order, so the answer reads naturally.
  const order = q.options.map((o) => o.label);
  labels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ...p, labels };
}

/** Toggles "Other…": single-select clears the options when it turns on. */
export function toggleOther(q: QuestionSpec, p: QuestionPick): QuestionPick {
  const on = !p.otherOn;
  if (!q.multiSelect && on) return { labels: [], otherOn: true, otherText: p.otherText };
  return { ...p, otherOn: on };
}

/** True when a question has an answer (an option, or a non-blank "Other"). */
export function pickAnswered(p: QuestionPick | undefined): boolean {
  if (!p) return false;
  return p.labels.length > 0 || (p.otherOn && p.otherText.trim().length > 0);
}

/** True when every question has an answer. */
export function answersReady(questions: readonly QuestionSpec[], picks: readonly (QuestionPick | undefined)[]): boolean {
  return questions.length > 0 && questions.every((_, i) => pickAnswered(picks[i]));
}

/**
 * Builds the `answer` decision. Answers are keyed by the full question text:
 * one label (single) or the labels (multi). A non-blank "Other" goes in
 * `other` (it replaces a single answer, and is appended to a multi one); for a
 * single-select the answer itself is the typed text, so it is never empty.
 */
export function answerDecision(questions: readonly QuestionSpec[], picks: readonly (QuestionPick | undefined)[]): DecisionPayload {
  const answers: Record<string, string | string[]> = {};
  const other: Record<string, string> = {};
  questions.forEach((q, i) => {
    const p = picks[i] ?? emptyPick();
    const text = p.otherOn ? clip(p.otherText, LIMITS.feedbackChars) : undefined;
    if (q.multiSelect) {
      answers[q.question] = p.labels.slice(0, LIMITS.multiAnswers);
    } else if (text) {
      answers[q.question] = text.slice(0, LIMITS.labelChars);
    } else {
      answers[q.question] = p.labels[0] ?? '';
    }
    if (text) other[q.question] = text;
  });
  return Object.keys(other).length ? { kind: 'answer', answers, other } : { kind: 'answer', answers };
}

// ---------------------------------------------------------------------------
// Words and small formatting helpers

/** Icon ids from `art/bubbles.ts` (kept as strings here: that module needs the DOM). */
export type ToolIcon = 'page' | 'pencil' | 'terminal' | 'folder' | 'globe' | 'search' | 'clipboard' | 'alert' | 'palette' | 'thinking';

/** The office icon for a tool name. */
export function toolIcon(name: string): ToolIcon {
  const n = name.split('__').pop() ?? name;
  switch (name) {
    case 'Read': case 'NotebookRead': return 'page';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'pencil';
    case 'Bash': case 'BashOutput': case 'KillShell': case 'KillBash': return 'terminal';
    case 'Grep': case 'Glob': case 'LS': return 'folder';
    case 'WebFetch': return 'globe';
    case 'WebSearch': return 'search';
    case 'Task': case 'Agent': case 'TodoWrite': case 'ExitPlanMode': return 'clipboard';
    case 'AskUserQuestion': return 'alert';
    default: break;
  }
  if (name.startsWith('mcp__')) return /search|query|find/i.test(n) ? 'search' : /fetch|browse|url|web/i.test(n) ? 'globe' : 'terminal';
  return 'terminal';
}

/** "Opus 4.1" from "claude-opus-4-1-20250805"; aliases are capitalised; unknown ids pass through. */
export function prettyModel(model: string | undefined): string {
  if (!model) return '';
  const m = model.trim();
  const fam = (f: string): string => f.charAt(0).toUpperCase() + f.slice(1);
  let r = /^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(m);
  if (r) return `${fam(r[1]!.toLowerCase())} ${r[2]}${r[3] ? `.${r[3]}` : ''}${r[4] ? ' (1M)' : ''}`;
  r = /^claude-(\d)(?:-(\d))?-(fable|opus|sonnet|haiku)(?:-\d{8})?$/i.exec(m);
  if (r) return `${fam(r[3]!.toLowerCase())} ${r[1]}${r[2] ? `.${r[2]}` : ''}`;
  r = /^(fable|opus|sonnet|haiku)(\[1m\])?$/i.exec(m);
  if (r) return `${fam(r[1]!.toLowerCase())}${r[2] ? ' (1M)' : ''}`;
  return m;
}

/** "$0.42"; tiny amounts read "<$0.01". */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Shortens a home directory to "~" for display (Linux, macOS and Windows home layouts). */
export function shortPath(path: string | undefined): string {
  if (!path) return '';
  const unix = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(path);
  if (unix) return `~${path.slice(unix[1]!.length)}`;
  const win = /^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/.exec(path);
  if (win) return `~${path.slice(win[0].length)}`;
  return path;
}

/** Words for a permission mode. */
export const MODE_WORDS = { default: 'Knocks at your door', acceptEdits: 'Auto-accepts file edits', plan: 'Plans first' } as const;

/**
 * One status line: "Writing · Opus 4.1 · $0.42 so far". `withOptions: false`
 * leaves out the model and approvals (the header chips already show them).
 */
export function statusLine(h: Pick<CaseHeader, 'activity' | 'status' | 'model' | 'costUsd' | 'busy' | 'control' | 'permissionMode'>, withOptions = true): string {
  const parts: string[] = [];
  if (h.status === 'done') parts.push('Gone for the day');
  else if (h.activity === 'needsYou') parts.push('Waiting for you');
  else parts.push(ACTIVITY_WORDS[h.activity] ?? 'Working');
  const model = withOptions ? prettyModel(h.model) : '';
  if (model) parts.push(model);
  if (withOptions && h.control === 'office' && h.permissionMode && h.permissionMode !== 'default') parts.push(MODE_WORDS[h.permissionMode]);
  const cost = formatCost(h.costUsd);
  if (cost) parts.push(`${cost} so far`);
  return parts.join(' · ');
}

/** A short badge for who takes orders (roster and case header). */
export function controlBadge(control: AgentControl | undefined): { label: string; icon: 'memo' | 'lock'; title: string } | null {
  if (control === 'office') return { label: 'office-run', icon: 'memo', title: 'Started here: takes orders from the office' };
  if (control === 'elsewhere') return { label: 'busy elsewhere', icon: 'lock', title: 'Open in another window: read-only here' };
  return null;
}

/** Clock time "14:05" for an item timestamp. */
export function clockTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const TOOL_VERBS: Readonly<Record<string, string>> = {
  Bash: 'run', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit', Read: 'read', Grep: 'search for',
  Glob: 'look for', LS: 'list', WebFetch: 'fetch', WebSearch: 'search the web for',
};

/**
 * The permission card headline, "Wants to <summary>". A summary that starts
 * with a capitalised verb ("Run the tests") reads as is; a bare command or
 * path gets the tool's verb ("Wants to run npm test").
 */
export function permissionTitle(toolName: string, summary: string): string {
  const s = summary.trim().replace(/\s+/g, ' ');
  if (!s) return `Wants to use ${toolName}`;
  const m = /^([A-Z][a-z]+)(\b.*)$/.exec(s);
  if (m) return `Wants to ${m[1]!.toLowerCase()}${m[2]}`;
  const verb = TOOL_VERBS[toolName];
  return verb ? `Wants to ${verb} ${s}` : `Wants to use ${toolName}: ${s}`;
}

/**
 * The line under "Always allow" saying exactly what it switches on. The host's
 * label reads like 'Always allow "npm test *" in this project' or 'Auto-accept
 * file edits this session'.
 */
export function alwaysCaption(label: string | undefined): string {
  const l = (label ?? '').trim().replace(/\s+/g, ' ');
  const rest = /^always allow\b\s*(.*)$/i.exec(l)?.[1]?.trim() ?? null;
  if (rest === null && l) return `\u201cAlways allow\u201d also turns on: ${l.charAt(0).toLowerCase()}${l.slice(1)}.`;
  if (!rest) return '\u201cAlways allow\u201d means they won\u2019t ask again for requests like this one.';
  return `\u201cAlways allow\u201d means they won\u2019t ask again for ${rest}.`;
}

/** True when a host `error` belongs to the open case: same session, or same pending request. Otherwise it is a toast. */
export function errorBelongsToCase(err: { sessionId?: string; requestId?: string }, caseSessionId: string | undefined, pendingRequestId: string | undefined): boolean {
  if (err.sessionId !== undefined && err.sessionId === caseSessionId) return true;
  return err.requestId !== undefined && err.requestId === pendingRequestId;
}

// ---------------------------------------------------------------------------
// Plan items

/** The status badge on a plan item. `tone` picks the colour. */
export function planBadge(status: PlanStatus | string | undefined): { label: string; tone: 'warn' | 'ok' | 'err' | 'dim'; title: string } {
  switch (status) {
    case 'pending': return { label: 'Waiting for sign-off', tone: 'warn', title: 'They’re waiting for you to approve it or send it back' };
    case 'approved': return { label: 'Approved', tone: 'ok', title: 'You signed it off; they went ahead' };
    case 'rejected': return { label: 'Sent back', tone: 'err', title: 'You sent it back; they kept planning' };
    case 'superseded': return { label: 'Superseded', tone: 'dim', title: 'Replaced by a newer plan before anyone decided' };
    default: return { label: 'Plan', tone: 'dim', title: 'A plan they wrote' };
  }
}

/** Plans longer than this many lines start folded in the history. */
export const PLAN_FOLD_LINES = 14;

/** How a plan item in the history is drawn. */
export interface PlanItemView {
  badge: ReturnType<typeof planBadge>;
  /** Start folded (superseded, or long and already decided). */
  folded: boolean;
  /** Show "Sign off below": this is the plan the pending card is asking about. */
  signOffBelow: boolean;
  /** "Your notes: …" when the user sent it back with feedback. */
  feedback: string | null;
  /** The note shown when the text was cut. */
  cutNote: string | null;
}

/**
 * The view of one plan item. `pendingIsPlan` is true while the open case has a
 * plan request waiting (its card at the bottom carries Approve / Keep planning).
 */
export function planItemView(it: { text: string; status: PlanStatus | string; truncated?: boolean; feedback?: string; planFilePath?: string }, pendingIsPlan: boolean): PlanItemView {
  const lines = (it.text || '').split('\n').length;
  const feedback = typeof it.feedback === 'string' && it.feedback.trim() ? it.feedback.trim() : null;
  const cutNote = it.truncated
    ? (it.planFilePath ? `The plan was too long to show in full. All of it is in ${shortPath(it.planFilePath)}.` : 'The plan was too long to show in full.')
    : null;
  return {
    badge: planBadge(it.status),
    // The plan waiting for sign-off is the one to read: never folded.
    folded: it.status === 'superseded' || (it.status !== 'pending' && lines > PLAN_FOLD_LINES),
    signOffBelow: it.status === 'pending' && pendingIsPlan,
    feedback,
    cutNote,
  };
}

/** Id of the plan item the pending plan card is about: the newest pending one. */
export function pendingPlanItemId(items: readonly ConversationItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'plan' && it.status === 'pending') return it.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors: which case a host error is about

/** Where a host error goes in an open case: the "couldn't open" state, the inline banner, or not this case at all. */
export type CaseErrorTarget = 'load' | 'inline' | 'other';

/**
 * Routes a host `error` (one that is not a reply to a chip change, which the options tracker claims by `nonce`) for the case
 * of `own.agentId`. Since v0.5 `error.agentId` is tested first: another worker's id means "not ours" and our own id means ours
 * (the "couldn't open" state while the file is still loading, else the banner). Without an `agentId` the old rules stand: while
 * loading, an error with no request address (or with this worker's live session) is a refusal to open the file; once loaded,
 * an error is ours when its `sessionId` or `requestId` matches (see errorBelongsToCase).
 */
export function caseErrorTarget(
  err: { agentId?: string; sessionId?: string; requestId?: string; nonce?: string },
  own: { agentId: string; loaded: boolean; sessionId?: string; liveSessionId?: string; requestId?: string },
): CaseErrorTarget {
  if (err.agentId !== undefined) {
    if (err.agentId !== own.agentId) return 'other';
    return own.loaded ? 'inline' : 'load';
  }
  if (!own.loaded && err.nonce === undefined && err.requestId === undefined && (err.sessionId === undefined || err.sessionId === own.liveSessionId)) return 'load';
  return errorBelongsToCase(err, own.sessionId, own.requestId) ? 'inline' : 'other';
}

// ---------------------------------------------------------------------------
// Case tab (v0.5, docs/manager-mode.md section 18)

/**
 * Reads a case tab's boot data from the text of its `<script type="application/json" id="mm-boot">` element (null when
 * the element is missing). Undefined for missing text, bad JSON or anything `parseCaseTabBoot` rejects. Never throws.
 */
export function readCaseTabBoot(text: string | null | undefined): CaseTabBoot | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return parseCaseTabBoot(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Host message types a case tab acts on. Everything else (the office's own state: caseTabs, projects, fileRoots, openMemo,
 * the Front desk, the panels' replies, taskStarted) is dropped even if a host sends it by mistake.
 */
export const CASE_TAB_TYPES: ReadonlySet<HostToWebview['type']> = new Set<HostToWebview['type']>([
  'agents', 'settings', 'usage', 'claudeDefaults', 'caseFile', 'caseAppend', 'caseClosed', 'caseLook', 'sessionOptions', 'error',
]);

/**
 * The look a case tab paints for its worker. `handed` is what the office sent (the boot's `look`, or a later `caseLook`);
 * `known` says whether the art has that look; `guess` is the tab's own Assigner pick. A handed look wins when the art knows it,
 * else the guess (which may be null: no portrait yet). Pure.
 */
export function tabLook(handed: string | undefined, known: (look: string) => boolean, guess: string | null): string | null {
  if (handed !== undefined && handed !== '' && known(handed)) return handed;
  return guess;
}

/**
 * True when a case tab bound to `own.agentId` should handle `msg`: an object of a type the tab acts on that does not
 * explicitly address another worker, session or request (`forAnotherCase`, the same rule the host uses). Never throws.
 */
export function claimForTab(msg: unknown, own: CaseAddress): msg is HostToWebview {
  if (!msg || typeof msg !== 'object') return false;
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== 'string' || !CASE_TAB_TYPES.has(type as HostToWebview['type'])) return false;
  try {
    return !forAnotherCase(msg as HostToWebview, own);
  } catch {
    return false;
  }
}

/** Where keyboard focus starts in a case tab once the file is in: the knock card, the reply box, or the page itself. */
export type PageFocus = 'card' | 'reply' | 'page';

/**
 * The first focus of a case tab. A knock (a pending request the user can answer) wins: the card. Otherwise the reply box when
 * there is one that can send (an office run, idle or busy, where a busy one queues; or a free session). Otherwise (loading
 * error, read-only, a temp, the worker gone) the page, so nothing pretends to take typing.
 */
export function pageFocusTarget(s: { knocking: boolean; footer: FooterMode['kind']; canSend: boolean; closed: boolean; loadError: boolean }): PageFocus {
  if (s.closed || s.loadError) return 'page';
  if (s.knocking) return 'card';
  if (s.footer === 'reply' && s.canSend) return 'reply';
  return 'page';
}

/**
 * The "working" line above the reply box of a case tab ("Running a command…"), or null when they aren't working. Only shown
 * while a turn runs (an office run's `busy`, or a live session whose status is working with a real activity).
 */
export function workingLine(h: Pick<CaseHeader, 'activity' | 'status' | 'busy'> | null, knocking: boolean): string | null {
  if (!h || knocking) return null;
  const working = h.busy === true || (h.status === 'working' && h.activity !== 'idle' && h.activity !== 'needsYou');
  if (!working) return null;
  const words = h.activity !== 'idle' && h.activity !== 'needsYou' ? ACTIVITY_WORDS[h.activity] : undefined;
  return `${words ?? 'Working'}\u2026`;
}
