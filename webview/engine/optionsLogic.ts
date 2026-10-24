/**
 * Pure logic behind the model, effort and approvals controls: the memo's
 * Model row and effort pips, and the case-file header chips with their
 * popover menus. Covers default resolution ("Default (Opus · xhigh)" from the
 * user's Claude Code settings), which effort levels a model supports, clamping
 * an effort the model can't take, the chip modes (live, next message,
 * read-only, Claude Code too old), and the setSessionOptions round trip.
 * DOM-free so it can be unit-tested with plain Node.
 */
import { EFFORT_LEVELS } from '../../src/shared/protocol.ts';
import type {
  AgentControl, CaseHeader, ClaudeDefaults, EffortLevel, HostToWebview, ModelChoice, PermissionMode, SessionOptions, WebviewToHost,
} from '../../src/shared/protocol.ts';
import { prettyModel } from './caseLogic.ts';

// ---------------------------------------------------------------------------
// Plan first on Haiku

/**
 * The cost note for "Plan first" on the `haiku` alias, or null. Claude Code 2.1.x runs plan mode on Sonnet when the model
 * is exactly `haiku`, then goes back to Haiku once the plan is approved, so the pair costs more than people expect.
 */
export function planHaikuNote(model: string | null | undefined, mode: PermissionMode | null | undefined): string | null {
  return model === 'haiku' && mode === 'plan' ? PLAN_HAIKU_NOTE : null;
}

const PLAN_HAIKU_NOTE = 'Plan first with Haiku: Claude Code does the planning on Sonnet, so it costs more.';

/** The same warning for the Approvals menu, where Plan first is not picked yet: shown on that choice while the model is `haiku`. */
export function planHaikuMenuDetail(model: string | null | undefined): string | null {
  return planHaikuNote(model, 'plan');
}

// ---------------------------------------------------------------------------
// Vocabulary

/** Model choices on the memo and in the Model menu. `value` is the alias posted to the host; '' = the user's default. */
export const MODEL_CHOICES: readonly { value: '' | 'opus' | 'sonnet' | 'haiku'; label: string; hint: string }[] = [
  { value: '', label: 'Default', hint: 'From your Claude Code settings' },
  { value: 'opus', label: 'Opus', hint: 'Most capable' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Balanced' },
  { value: 'haiku', label: 'Haiku', hint: 'Fast and light' },
];

/**
 * Approval styles on the memo and in the Approvals menu. `short` is the case header chip's value; it uses the memo's own words
 * (task 10.1: the chip said "Knock first" and "File edits" where the memo said "Knock at my door" and "Auto-accept file edits").
 */
export const APPROVAL_CHOICES: readonly { value: PermissionMode; label: string; short: string; hint: string }[] = [
  { value: 'default', label: 'Knock at my door', short: 'Knock at my door', hint: 'They ask before anything your Claude Code rules don’t already allow.' },
  { value: 'acceptEdits', label: 'Auto-accept file edits', short: 'Auto-accept file edits', hint: 'File edits in the project go ahead without asking. Commands, web access and anything outside the project still knock.' },
  { value: 'plan', label: 'Plan first', short: 'Plan first', hint: 'They write a plan for your sign-off before touching anything. Plan mode can cost noticeably more.' },
];

/** Pip labels, lowest first. */
export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' };

/** One line per level, for tooltips and menu details. */
export const EFFORT_HINTS: Readonly<Record<EffortLevel, string>> = {
  low: 'Quick answers, fewest tokens',
  medium: 'A bit more thought',
  high: 'Thinks things through',
  xhigh: 'Extra thinking for hard problems',
  max: 'Everything it has: slowest and priciest',
};

/** Menu id of "Default" (reset to the user's Claude Code setting). Not a valid model alias or effort level. */
export const DEFAULT_ID = '~default';

// ---------------------------------------------------------------------------
// Models

function baseId(id: string): string {
  return id.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * The ModelChoice for a model value (alias or full id). '' / null / undefined
 * mean "the default model": the user's `model` setting, else a 'default' entry.
 * Matches the value, then the resolved id, then either ignoring a date suffix.
 * A full id that matches nothing gives undefined (its effort support is unknown).
 */
export function findModelChoice(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): ModelChoice | undefined {
  const list = Array.isArray(defaults?.models) ? defaults!.models! : [];
  if (!model) {
    const dm = defaults?.model;
    if (dm) return findModelChoice(defaults, dm);
    return list.find((c) => c.value === 'default');
  }
  const m = model.trim();
  const exact = list.find((c) => c.value === m) ?? list.find((c) => c.resolved === m);
  if (exact) return exact;
  const b = baseId(m);
  return list.find((c) => baseId(c.value) === b && /\[1m\]$/i.test(c.value) === /\[1m\]$/i.test(m))
    ?? list.find((c) => !!c.resolved && baseId(c.resolved) === b);
}

/** Display name for a model: "Opus", "Opus 4.1", or the choice's label. '' for nothing. */
export function modelName(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): string {
  if (!model) return '';
  const pretty = prettyModel(model);
  if (pretty !== model.trim()) return pretty;
  return findModelChoice(defaults, model)?.label || pretty;
}

/** Name of the model the user's default resolves to ("Opus"), or ''. */
export function defaultModelName(defaults: ClaudeDefaults | null | undefined): string {
  return defaults?.model ? modelName(defaults, defaults.model) : '';
}

/**
 * Model choices for the memo and the Model menu: Default, Opus, Sonnet, Haiku,
 * then any other model Claude Code offers (for example the 1M-context ones).
 * Hints say what each alias currently resolves to, when known.
 */
export function modelChoices(defaults: ClaudeDefaults | null | undefined): { value: string; label: string; hint: string }[] {
  const out = MODEL_CHOICES.map((m) => {
    const c = m.value ? findModelChoice(defaults, m.value) : undefined;
    const to = c?.resolved ? prettyModel(c.resolved) : '';
    return { value: m.value as string, label: m.label, hint: to && to !== m.label ? `${m.hint} · ${to}` : m.hint };
  });
  for (const c of Array.isArray(defaults?.models) ? defaults!.models! : []) {
    if (out.length >= 8) break;
    if (!c || typeof c.value !== 'string' || !c.value || c.value === 'default' || out.some((o) => o.value === c.value)) continue;
    out.push({ value: c.value, label: c.label || prettyModel(c.value), hint: c.resolved ? prettyModel(c.resolved) : '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effort support and defaults

/** Effort levels `model` supports, lowest first; null when unknown (offer every level). [] = the model takes none. */
export function supportedEfforts(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): readonly EffortLevel[] | null {
  const c = findModelChoice(defaults, model);
  if (!c || !Array.isArray(c.efforts)) return null;
  return EFFORT_LEVELS.filter((l) => c.efforts!.includes(l));
}

/** True when `model` can take `level` (unknown support counts as yes). */
export function effortSupported(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined, level: EffortLevel): boolean {
  const s = supportedEfforts(defaults, model);
  return !s || s.includes(level);
}

/** The supported level nearest to `level`: the next one down, else the next one up. Null when none is supported. */
export function clampLevel(level: EffortLevel, supported: readonly EffortLevel[]): EffortLevel | null {
  if (supported.includes(level)) return level;
  const i = EFFORT_LEVELS.indexOf(level);
  for (let j = i - 1; j >= 0; j--) if (supported.includes(EFFORT_LEVELS[j]!)) return EFFORT_LEVELS[j]!;
  for (let j = i + 1; j < EFFORT_LEVELS.length; j++) if (supported.includes(EFFORT_LEVELS[j]!)) return EFFORT_LEVELS[j]!;
  return null;
}

/**
 * The effort a session on `model` gets when none is chosen: the per-model
 * setting (`modelSettings.<model>.effortLevel`), else the global one, brought
 * within what the model supports. Undefined when unknown or the model takes none.
 */
export function defaultEffortFor(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): EffortLevel | undefined {
  if (!defaults) return undefined;
  const byModel = defaults.effortByModel && typeof defaults.effortByModel === 'object' ? defaults.effortByModel : {};
  const c = findModelChoice(defaults, model);
  let e: EffortLevel | undefined;
  for (const k of [model || defaults.model, c?.value, c?.resolved]) {
    if (k && Object.prototype.hasOwnProperty.call(byModel, k) && EFFORT_LEVELS.includes(byModel[k]!)) { e = byModel[k]; break; }
  }
  e ??= defaults.effort && EFFORT_LEVELS.includes(defaults.effort) ? defaults.effort : undefined;
  if (!e) return undefined;
  const s = supportedEfforts(defaults, model);
  return s ? clampLevel(e, s) ?? undefined : e;
}

/** "Default (Opus · xhigh)": what an untouched memo gets. Parts that aren't known are left out; plain "Default" when neither is. */
export function defaultLabel(defaults: ClaudeDefaults | null | undefined): string {
  const parts = [defaultModelName(defaults), defaultEffortFor(defaults, '') ?? ''].filter(Boolean);
  return parts.length ? `Default (${parts.join(' · ')})` : 'Default';
}

/** "Default (Opus)" for the Model row. */
export function defaultModelLabel(defaults: ClaudeDefaults | null | undefined): string {
  const n = defaultModelName(defaults);
  return n ? `Default (${n})` : 'Default';
}

/** "Default (xhigh)" for the Effort row, for the model chosen (or the default one). */
export function defaultEffortLabel(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): string {
  const e = defaultEffortFor(defaults, model);
  return e ? `Default (${e})` : 'Default';
}

/** One of the five effort pips. */
export interface EffortPip {
  level: EffortLevel;
  label: string;
  /** False when the model doesn't support this level (greyed out and disabled). */
  enabled: boolean;
  checked: boolean;
  /** Meter fill: 'on' up to the chosen level, 'ghost' up to the default's when Default is chosen, else 'off'. */
  fill: 'on' | 'ghost' | 'off';
  title: string;
}

/** The pips for `model` with `chosen` (null = Default). */
export function effortPips(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined, chosen: EffortLevel | null | undefined): EffortPip[] {
  const s = supportedEfforts(defaults, model);
  const def = chosen ? undefined : defaultEffortFor(defaults, model);
  const upTo = EFFORT_LEVELS.indexOf((chosen ?? def) as EffortLevel);
  const name = modelName(defaults, model) || defaultModelName(defaults) || 'This model';
  return EFFORT_LEVELS.map((level, i) => {
    const enabled = !s || s.includes(level);
    return {
      level, label: EFFORT_LABELS[level], enabled, checked: chosen === level,
      fill: upTo >= 0 && i <= upTo ? (chosen ? 'on' : 'ghost') : 'off',
      title: enabled ? `${EFFORT_LABELS[level]}: ${EFFORT_HINTS[level]}` : `${EFFORT_LABELS[level]}: not available on ${name}`,
    };
  });
}

/** Result of bringing an effort within what a model supports. `note` explains a change ('' / null when nothing changed). */
export interface EffortClamp { effort: EffortLevel | null; note: string | null }

/**
 * Brings a chosen effort within what `model` supports, for when the model
 * changes: the next level down (else up), or back to Default when the model
 * takes no effort level. The note says what happened in one short line.
 */
export function clampEffort(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined, effort: EffortLevel | null | undefined): EffortClamp {
  if (!effort) return { effort: null, note: null };
  const s = supportedEfforts(defaults, model);
  if (!s || s.includes(effort)) return { effort, note: null };
  const name = modelName(defaults, model) || defaultModelName(defaults) || 'That model';
  const to = clampLevel(effort, s);
  if (!to) return { effort: null, note: `${name} doesn’t use effort levels, so effort is back to Default.` };
  return { effort: to, note: `${name} doesn’t offer ${EFFORT_LABELS[effort]}, so effort is now ${EFFORT_LABELS[to]}.` };
}

/** "Haiku doesn’t use effort levels." when `model` takes none, else null (the pips are then all greyed out). */
export function noEffortNote(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): string | null {
  const s = supportedEfforts(defaults, model);
  if (!s || s.length) return null;
  return `${modelName(defaults, model) || defaultModelName(defaults) || 'This model'} doesn’t use effort levels.`;
}

// ---------------------------------------------------------------------------
// setSessionOptions round trip

export type ChipKey = 'model' | 'effort' | 'permissionMode';
export const CHIP_KEYS: readonly ChipKey[] = ['model', 'effort', 'permissionMode'];

export type RequestStatus = 'pending' | 'applied' | 'deferred' | 'failed';

/** One setSessionOptions call and what became of it. */
export interface OptionsRequest {
  nonce: string;
  sessionId: string;
  options: SessionOptions;
  status: RequestStatus;
  /** When it was sent, and when the reply came. */
  at: number;
  doneAt?: number;
  /** What the host says took effect now / was stored for the next message. */
  applied?: SessionOptions;
  deferred?: SessionOptions;
  /** The error text on failure. */
  message?: string;
  /** Header values when it was sent: an applied value shows until the header moves on. */
  was: Partial<Record<ChipKey, string | null>>;
}

/** Every recent request, plus the sessions whose Claude Code turned out too old to change options mid-session. */
export interface OptionsTracker { requests: OptionsRequest[]; outdated: string[] }

/** Requests kept (the newest). */
const KEEP = 12;

export function emptyTracker(): OptionsTracker {
  return { requests: [], outdated: [] };
}

/** The `setSessionOptions` message. */
export function optionsMessage(sessionId: string, options: SessionOptions, nonce: string): Extract<WebviewToHost, { type: 'setSessionOptions' }> {
  return { type: 'setSessionOptions', nonce, sessionId, options: { ...options } };
}

/** The SessionOptions for picking menu item `id` on chip `key` (DEFAULT_ID resets model/effort). */
export function choiceOptions(key: ChipKey, id: string): SessionOptions | null {
  if (key === 'model') return { model: id === DEFAULT_ID ? null : id };
  if (key === 'effort') {
    if (id === DEFAULT_ID) return { effort: null };
    return EFFORT_LEVELS.includes(id as EffortLevel) ? { effort: id as EffortLevel } : null;
  }
  return APPROVAL_CHOICES.some((c) => c.value === id) ? { permissionMode: id as PermissionMode } : null;
}

type HeaderLike = Pick<CaseHeader, 'model' | 'effort' | 'permissionMode'>;

/** Records a request just sent. `header` is the case header at that moment. */
export function trackRequest(t: OptionsTracker, msg: Extract<WebviewToHost, { type: 'setSessionOptions' }>, now: number, header: HeaderLike | null): OptionsTracker {
  const was: OptionsRequest['was'] = {};
  for (const k of CHIP_KEYS) if (k in msg.options) was[k] = (header?.[k] as string | undefined) ?? null;
  const req: OptionsRequest = { nonce: msg.nonce, sessionId: msg.sessionId, options: { ...msg.options }, status: 'pending', at: now, was };
  return { ...t, requests: [...t.requests.filter((r) => r.nonce !== msg.nonce), req].slice(-KEEP) };
}

/** Applies a `sessionOptions` reply. `matched` is false when the nonce isn't ours. */
export function applyReply(t: OptionsTracker, reply: Extract<HostToWebview, { type: 'sessionOptions' }>, now: number): { tracker: OptionsTracker; matched: boolean } {
  const i = t.requests.findIndex((r) => r.nonce === reply.nonce);
  if (i < 0) return { tracker: t, matched: false };
  const applied = reply.applied && typeof reply.applied === 'object' ? reply.applied : {};
  const deferred = reply.deferred && typeof reply.deferred === 'object' ? reply.deferred : {};
  const status: RequestStatus = Object.keys(deferred).length && !Object.keys(applied).length ? 'deferred' : 'applied';
  const requests = t.requests.slice();
  requests[i] = { ...requests[i]!, status, applied: { ...applied }, deferred: { ...deferred }, doneAt: now };
  return { tracker: { ...t, requests }, matched: true };
}

/** True when an error says this Claude Code can't change options mid-session (an older build). */
export function isOutdatedError(message: string | undefined): boolean {
  return /update (the )?claude code|cannot change .* on a running session|too old|newer version|not supported|unsupported|doesn.t support|does not support|no control channel/i.test(message ?? '');
}

/**
 * Applies an `error` that may answer one of our requests (same nonce). An
 * "update Claude Code" error also marks the session outdated, which turns its
 * chips read-only. `matched` is false when the error isn't about a request.
 */
export function applyError(t: OptionsTracker, err: { nonce?: string; message?: string }, now: number): { tracker: OptionsTracker; matched: boolean; outdated: boolean } {
  const i = err.nonce ? t.requests.findIndex((r) => r.nonce === err.nonce) : -1;
  if (i < 0) return { tracker: t, matched: false, outdated: false };
  const req = t.requests[i]!;
  const requests = t.requests.slice();
  const message = String(err.message ?? 'Something went wrong.');
  requests[i] = { ...req, status: 'failed', message, doneAt: now };
  const outdated = isOutdatedError(message);
  const out = outdated && !t.outdated.includes(req.sessionId) ? [...t.outdated, req.sessionId] : t.outdated;
  return { tracker: { requests, outdated: out }, matched: true, outdated };
}

/** True while any request for `sessionId` waits for its reply. */
export function hasPending(t: OptionsTracker, sessionId: string | undefined): boolean {
  return !!sessionId && t.requests.some((r) => r.sessionId === sessionId && r.status === 'pending');
}

/** The newest request for `sessionId` that touched `key`. */
function latestFor(t: OptionsTracker, sessionId: string | undefined, key: ChipKey): OptionsRequest | undefined {
  if (!sessionId) return undefined;
  for (let i = t.requests.length - 1; i >= 0; i--) {
    const r = t.requests[i]!;
    if (r.sessionId === sessionId && key in r.options) return r;
  }
  return undefined;
}

/** A short "what's the thing" line for an error, e.g. "Couldn’t change the model: …". */
export function errorText(key: ChipKey | null, message: string): string {
  const what = key === 'model' ? 'the model' : key === 'effort' ? 'the effort level' : key === 'permissionMode' ? 'approvals' : 'the settings';
  return `Couldn’t change ${what}: ${message}`;
}

/** The chip key a request was about (the first one), for error wording. */
export function requestKey(t: OptionsTracker, nonce: string | undefined): ChipKey | null {
  const r = nonce ? t.requests.find((x) => x.nonce === nonce) : undefined;
  return r ? CHIP_KEYS.find((k) => k in r.options) ?? null : null;
}

// ---------------------------------------------------------------------------
// Header chips

/**
 * How a chip behaves. 'live': an office run, changes now. 'next': a free
 * session, the change applies to its next message. 'readonly': running in
 * Claude Code itself (or a temp). 'outdated': this Claude Code is too old to
 * change options mid-session.
 */
export type ChipMode = 'live' | 'next' | 'readonly' | 'outdated';

/** One chip as the header draws it. */
export interface ChipView {
  key: ChipKey;
  /** "Model", "Effort", "Approvals". */
  label: string;
  /** What is in use (or was just asked for). */
  value: string;
  /** Free sessions: "next: Sonnet" when something is stored for the next message. */
  next: string | null;
  mode: ChipMode;
  /** Opens a menu. False for read-only chips and for effort on a model without effort levels. */
  editable: boolean;
  /** Tooltip and the read-only explanation. */
  hint: string;
  /** In flight, just applied, saved for the next message, or just failed. */
  status: RequestStatus | null;
}

export interface ChipInput {
  header: Pick<CaseHeader, 'control' | 'canSetOptions' | 'model' | 'effort' | 'permissionMode' | 'next' | 'busy' | 'sessionId'>;
  defaults: ClaudeDefaults | null | undefined;
  tracker: OptionsTracker;
  now: number;
  /** When the header's `next` last changed (a deferred reply newer than this wins until the header catches up). */
  nextAt?: number;
  /** The worker is a temp (subagent): no settings of their own. */
  isTemp?: boolean;
}

/** How long "applied" / "failed" marks stay on a chip. */
export const FLASH_MS = 4000;

const CHIP_LABEL: Readonly<Record<ChipKey, string>> = { model: 'Model', effort: 'Effort', permissionMode: 'Approvals' };

function effortValue(defaults: ClaudeDefaults | null | undefined, model: string | null | undefined, e: EffortLevel | null | undefined): string {
  if (e) return EFFORT_LABELS[e] ?? String(e);
  const s = supportedEfforts(defaults, model);
  if (s && !s.length) return 'n/a';
  const d = defaultEffortFor(defaults, model);
  return d ? `Default (${d})` : 'Default';
}

function valueText(key: ChipKey, v: string | null | undefined, defaults: ClaudeDefaults | null | undefined, model: string | null | undefined): string {
  if (key === 'model') return v ? modelName(defaults, v) : defaultModelLabel(defaults);
  if (key === 'effort') return effortValue(defaults, model, v as EffortLevel | null | undefined);
  return APPROVAL_CHOICES.find((c) => c.value === v)?.short ?? '—';
}

/** The chip mode for a header (before any per-key exception). */
export function chipMode(h: Pick<CaseHeader, 'control' | 'canSetOptions' | 'sessionId'>, tracker: OptionsTracker): ChipMode {
  if (!h.canSetOptions || !h.sessionId || (h.control !== 'office' && h.control !== 'free')) return 'readonly';
  if (tracker.outdated.includes(h.sessionId)) return 'outdated';
  return h.control === 'office' ? 'live' : 'next';
}

function readonlyHint(key: ChipKey, control: AgentControl | undefined, isTemp: boolean): string {
  if (isTemp || control === 'none') return 'Temps work with their boss’s settings.';
  if (key === 'permissionMode') return 'Running in Claude Code: change approvals there (Shift+Tab).';
  return 'Running in Claude Code: use /model or /effort in Claude Code.';
}

interface Resolved {
  mode: ChipMode;
  /** In use (overlaid with pending / just-applied requests). */
  current: Record<ChipKey, string | null | undefined>;
  /** Stored for the next message (free sessions). Absent key = nothing stored. */
  next: Partial<Record<ChipKey, string | null>>;
  status: Partial<Record<ChipKey, RequestStatus>>;
}

function resolve(input: ChipInput): Resolved {
  const { header: h, tracker, now } = input;
  const mode = chipMode(h, tracker);
  const nextStored: SessionOptions = h.next && typeof h.next === 'object' ? h.next : {};
  const current: Record<ChipKey, string | null | undefined> = { model: h.model, effort: h.effort, permissionMode: h.permissionMode };
  const next: Partial<Record<ChipKey, string | null>> = {};
  for (const k of CHIP_KEYS) if (k in nextStored) next[k] = (nextStored[k] as string | null | undefined) ?? null;
  const status: Partial<Record<ChipKey, RequestStatus>> = {};
  for (const k of CHIP_KEYS) {
    const r = latestFor(tracker, h.sessionId, k);
    if (!r) continue;
    const asked = (r.options[k] as string | null | undefined) ?? null;
    const fresh = r.doneAt !== undefined && now - r.doneAt < FLASH_MS;
    if (r.status === 'pending') {
      if (mode === 'next') next[k] = asked;
      else current[k] = asked;
      status[k] = 'pending';
    } else if (r.status === 'applied' && r.applied && k in r.applied) {
      // Shown until the header moves on from what it said when we asked.
      if ((current[k] ?? null) === (r.was[k] ?? null)) current[k] = (r.applied[k] as string | null | undefined) ?? null;
      if (fresh) status[k] = 'applied';
    } else if (r.status === 'deferred' && r.deferred && k in r.deferred) {
      if (r.doneAt !== undefined && r.doneAt >= (input.nextAt ?? -Infinity)) next[k] = (r.deferred[k] as string | null | undefined) ?? null;
      if (fresh) status[k] = 'deferred';
    } else if (r.status === 'failed' && fresh) {
      status[k] = 'failed';
    }
  }
  return { mode, current, next, status };
}

/** What the next turn will use for `key`: the stored next value, else the one in use. */
function upcoming(r: Resolved, key: ChipKey): string | null | undefined {
  return r.next[key] !== undefined ? r.next[key] : r.current[key];
}

/**
 * The three header chips. Values come from the header, overlaid with what
 * the user just asked for: a pending request shows its value at once, an
 * applied one until the header catches up, and a free session's stored
 * choices show as "next: …".
 */
export function headerChips(input: ChipInput): ChipView[] {
  const { header: h, defaults } = input;
  const r = resolve(input);
  const { mode, current, next } = r;
  // Effort support follows the model the next turn will use.
  const modelFor = upcoming(r, 'model') ?? '';
  const busy = h.control === 'office' && h.busy === true;
  return CHIP_KEYS.map((key): ChipView => {
    let editable = mode === 'live' || mode === 'next';
    let hint: string;
    if (mode === 'readonly') hint = readonlyHint(key, h.control, input.isTemp === true);
    else if (mode === 'outdated') hint = 'This Claude Code can’t change settings mid-session. Update Claude Code to use this.';
    else if (mode === 'next') hint = 'Not running now: a change applies to their next message.';
    else hint = busy ? 'A change applies from their next step.' : 'A change applies right away.';
    if (key === 'effort' && editable) {
      const s = supportedEfforts(defaults, modelFor);
      if (s && !s.length) {
        editable = false;
        hint = `${modelName(defaults, modelFor) || 'This model'} doesn’t use effort levels.`;
      }
    }
    const value = valueText(key, current[key], defaults, current.model);
    const nv = next[key];
    const nextText = mode === 'next' && nv !== undefined ? `next: ${valueText(key, nv, defaults, modelFor)}` : null;
    return { key, label: CHIP_LABEL[key], value, next: nextText, mode, editable, hint, status: r.status[key] ?? null };
  });
}

/** One entry of a chip's menu. */
export interface MenuChoice {
  id: string;
  label: string;
  detail?: string;
  checked: boolean;
  disabled: boolean;
  /** Effort meter, 0..5 bars, for the effort menu. */
  meter?: number;
}

/**
 * The menu for chip `key`: the choices, which one is ticked (the stored next
 * value for a free session, else the one in use) and which are unavailable.
 * A model in use that isn't one of the choices is listed first as "current".
 */
export function chipMenu(key: ChipKey, input: ChipInput): { title: string; note: string; items: MenuChoice[] } {
  const h = input.header;
  const defaults = input.defaults;
  const r = resolve(input);
  const pick = (k: ChipKey): string | null | undefined => upcoming(r, k);
  const note = r.mode === 'next' ? 'Applies to their next message.' : h.busy ? 'Applies from their next step.' : 'Applies right away.';
  if (key === 'model') {
    const cur = pick('model');
    const choices = modelChoices(defaults);
    const items: MenuChoice[] = [];
    const listed = !cur || choices.some((c) => c.value === cur);
    if (cur && !listed) items.push({ id: cur, label: `${modelName(defaults, cur)} (current)`, detail: 'Keep the model they’re on', checked: true, disabled: false });
    for (const c of choices) {
      items.push({
        id: c.value || DEFAULT_ID,
        label: c.value ? c.label : defaultModelLabel(defaults),
        detail: c.hint,
        checked: listed && (c.value ? c.value === cur : !cur),
        disabled: false,
      });
    }
    return { title: 'Model', note, items };
  }
  if (key === 'effort') {
    const model = pick('model');
    const cur = pick('effort') as EffortLevel | null | undefined;
    const s = supportedEfforts(defaults, model);
    const name = modelName(defaults, model) || defaultModelName(defaults) || 'this model';
    const def = defaultEffortFor(defaults, model);
    const items: MenuChoice[] = [{
      id: DEFAULT_ID, label: defaultEffortLabel(defaults, model), detail: 'From your Claude Code settings', checked: !cur, disabled: false,
      meter: def ? EFFORT_LEVELS.indexOf(def) + 1 : 0,
    }];
    EFFORT_LEVELS.forEach((l, i) => {
      const ok = !s || s.includes(l);
      items.push({ id: l, label: EFFORT_LABELS[l], detail: ok ? EFFORT_HINTS[l] : `Not available on ${name}`, checked: cur === l, disabled: !ok, meter: i + 1 });
    });
    return { title: 'Effort', note, items };
  }
  const cur = pick('permissionMode');
  return {
    title: 'Approvals', note,
    items: APPROVAL_CHOICES.map((c) => ({
      id: c.value, label: c.label, detail: c.value === 'plan' ? planHaikuMenuDetail(pick('model')) ?? c.hint : c.hint, checked: c.value === cur, disabled: false,
    })),
  };
}
