/**
 * The ONE place that interprets Claude Code's config and usage data, and the one place that whitelists keys.
 * `~/.claude.json` and the SDK's init/usage results hold account data (email, organisation, ids, tokens, MCP server
 * bodies); nothing but the fields built below may leave this module. Every parser takes `unknown`, never throws, and
 * returns freshly built objects (never a reference into the input). No vscode import.
 */
import { inspect } from 'node:util';
import { EFFORT_LEVELS, LIMITS, MCP_TRANSPORTS, USAGE_WINDOW_IDS } from '../shared/protocol.ts';
import type { ClaudeDefaults, EffortLevel, McpTransport, ModelChoice, UsageExtra, UsageWindow, UsageWindowId } from '../shared/protocol.ts';

/** Largest `.claude.json` we will read. Bigger files are refused unread. */
export const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;

const MAX_STR = 100;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown, max = MAX_STR): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s === '' ? undefined : s.slice(0, max);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, round2(n)));
}

function isWindowId(v: string): v is UsageWindowId {
  return (USAGE_WINDOW_IDS as readonly string[]).includes(v);
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

function isoToMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Windows keyed by id (a 0..100 `utilization` and an ISO `resets_at`), the shape of both the cache and the probe. */
function windowsFromPercentObject(obj: unknown, asOf: number): UsageWindow[] {
  const out: UsageWindow[] = [];
  if (!isObj(obj)) return out;
  for (const id of USAGE_WINDOW_IDS) {
    const w = own(obj, id);
    if (!isObj(w)) continue;
    const u = num(own(w, 'utilization'));
    const win: UsageWindow = { id, pct: u === undefined ? null : clampPct(u), asOf };
    const r = isoToMs(own(w, 'resets_at'));
    if (r !== undefined) win.resetsAt = r;
    out.push(win);
    if (out.length >= LIMITS.usageWindows) break;
  }
  return out;
}

/** `extra_usage` of the cache or probe: amounts are in minor units (`decimal_places`); `currency` is kept as an ISO code. */
function extraFrom(v: unknown): UsageExtra | undefined {
  if (!isObj(v)) return undefined;
  const enabled = own(v, 'is_enabled');
  if (typeof enabled !== 'boolean') return undefined;
  const out: UsageExtra = { enabled };
  const dp = num(own(v, 'decimal_places'));
  const scale = dp !== undefined && dp >= 0 && dp <= 6 ? 10 ** Math.floor(dp) : 100;
  const used = num(own(v, 'used_credits'));
  const limit = num(own(v, 'monthly_limit'));
  if (used !== undefined && used >= 0) out.usedUsd = round2(used / scale);
  if (limit !== undefined && limit >= 0) out.limitUsd = round2(limit / scale);
  const cur = own(v, 'currency');
  if (typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur.trim())) out.currency = cur.trim().toUpperCase();
  const u = num(own(v, 'utilization'));
  if (u !== undefined) out.pct = clampPct(u);
  else if (own(v, 'utilization') === null) out.pct = null;
  return out;
}

/** Result of `parseUsageCache`. */
export interface UsageCacheInfo {
  windows: UsageWindow[];
  extra?: UsageExtra;
  /** Epoch ms the CLI fetched these numbers (`fetchedAtMs`). */
  fetchedAt?: number;
}

/**
 * From a parsed `.claude.json`: only `cachedUsageUtilization.utilization.<window>` and `.extra_usage`, plus its fetch time.
 * Shape: `{ fetchedAtMs, accountUuid (ignored), utilization: { five_hour: { utilization 0..100, resets_at ISO }, ...,
 * extra_usage: { is_enabled, monthly_limit, used_credits (minor units), utilization, currency, decimal_places, ... } } }`.
 */
export function parseUsageCache(raw: unknown, now: number = Date.now()): UsageCacheInfo {
  try {
    if (!isObj(raw)) return { windows: [] };
    const cache = own(raw, 'cachedUsageUtilization');
    if (!isObj(cache)) return { windows: [] };
    const fetched = num(own(cache, 'fetchedAtMs'));
    const asOf = fetched !== undefined && fetched > 0 ? fetched : now;
    const util = own(cache, 'utilization');
    const out: UsageCacheInfo = { windows: windowsFromPercentObject(util, asOf) };
    if (fetched !== undefined && fetched > 0) out.fetchedAt = fetched;
    if (isObj(util)) {
      const extra = extraFrom(own(util, 'extra_usage'));
      if (extra) out.extra = extra;
    }
    return out;
  } catch {
    return { windows: [] };
  }
}

/** From the SDK probe's `usage` result: `rate_limits.<window>` with a 0..100 `utilization` and an ISO `resets_at`. */
export function parseProbeUsage(raw: unknown, now: number = Date.now()): UsageWindow[] {
  try {
    if (!isObj(raw)) return [];
    if (own(raw, 'rate_limits_available') === false) return [];
    return windowsFromPercentObject(own(raw, 'rate_limits'), now);
  } catch {
    return [];
  }
}

/** Extra-usage info from the probe's `usage` result (`rate_limits.extra_usage`). */
export function parseProbeExtra(raw: unknown): UsageExtra | undefined {
  try {
    if (!isObj(raw)) return undefined;
    const rl = own(raw, 'rate_limits');
    return isObj(rl) ? extraFrom(own(rl, 'extra_usage')) : undefined;
  } catch {
    return undefined;
  }
}

/** The subscription type of the probe's `usage` result, shortened for display ('max' becomes 'Max'). */
export function parseProbePlan(raw: unknown): string | undefined {
  try {
    return isObj(raw) ? shortPlan(own(raw, 'subscription_type')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * From a `rate_limit_event`'s `rate_limit_info`: `unifiedWindows.<window>` with a 0..1 `utilization` and epoch-SECONDS
 * `resetsAt`. The binding window (`rateLimitType`) takes state 'warning' / 'blocked' from `status`.
 */
export function parseRateLimitInfo(raw: unknown, now: number = Date.now()): UsageWindow[] {
  try {
    if (!isObj(raw)) return [];
    const uw = own(raw, 'unifiedWindows');
    if (!isObj(uw)) return [];
    const status = own(raw, 'status');
    const state: 'warning' | 'blocked' | undefined =
      status === 'allowed_warning' ? 'warning' : status === 'rejected' ? 'blocked' : undefined;
    const binding = own(raw, 'rateLimitType');
    const out: UsageWindow[] = [];
    for (const id of USAGE_WINDOW_IDS) {
      const w = own(uw, id);
      if (!isObj(w)) continue;
      const u = num(own(w, 'utilization'));
      const win: UsageWindow = { id, pct: u === undefined ? null : clampPct(u * 100), asOf: now };
      const r = num(own(w, 'resetsAt'));
      if (r !== undefined && r > 0) win.resetsAt = Math.round(r * 1000);
      if (state !== undefined && binding === id) win.state = state;
      out.push(win);
      if (out.length >= LIMITS.usageWindows) break;
    }
    return out;
  } catch {
    return [];
  }
}

function shortPlan(v: unknown): string | undefined {
  const s = str(v, 40);
  if (s === undefined) return undefined;
  const t = s.replace(/^claude\s+/i, '');
  if (t === '') return undefined;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Result of `parseInitInfo`. */
export interface InitInfo {
  models: ModelChoice[];
  /** Short subscription label ('Max', 'Pro'), from `account.subscriptionType` only. */
  subscriptionType?: string;
}

/** From the SDK's `initializationResult()`: the model list and the subscription type. No other `account` field is read. */
export function parseInitInfo(raw: unknown): InitInfo {
  try {
    if (!isObj(raw)) return { models: [] };
    const models: ModelChoice[] = [];
    const list = own(raw, 'models');
    if (Array.isArray(list)) {
      for (const m of list) {
        if (models.length >= LIMITS.models) break;
        if (!isObj(m)) continue;
        const value = str(own(m, 'value'));
        if (value === undefined) continue;
        const choice: ModelChoice = { value, label: str(own(m, 'displayName')) ?? value };
        const resolved = str(own(m, 'resolvedModel'));
        if (resolved !== undefined) choice.resolved = resolved;
        const levels = own(m, 'supportedEffortLevels');
        if (Array.isArray(levels)) {
          const efforts = EFFORT_LEVELS.filter((l) => levels.includes(l));
          if (efforts.length > 0) choice.efforts = efforts;
        }
        models.push(choice);
      }
    }
    const out: InitInfo = { models };
    const acct = own(raw, 'account');
    if (isObj(acct)) {
      const plan = shortPlan(own(acct, 'subscriptionType'));
      if (plan !== undefined) out.subscriptionType = plan;
    }
    return out;
  } catch {
    return { models: [] };
  }
}

/**
 * The user's defaults from a parsed `settings.json` (`model`, `effortLevel`, `modelSettings.<model>.effortLevel`) and the
 * env. Only `ANTHROPIC_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL` are ever read from the env, and they win over the file
 * (as in Claude Code). `models` is left to the caller (from `parseInitInfo`).
 */
export function parseClaudeDefaults(settingsJson: unknown, env: Record<string, string | undefined> = {}): ClaudeDefaults {
  const out: ClaudeDefaults = { effortByModel: {} };
  try {
    if (isObj(settingsJson)) {
      const model = str(own(settingsJson, 'model'));
      if (model !== undefined) out.model = model;
      const eff = own(settingsJson, 'effortLevel');
      if (isEffort(eff)) out.effort = eff;
      const ms = own(settingsJson, 'modelSettings');
      if (isObj(ms)) {
        let n = 0;
        for (const key of Object.keys(ms)) {
          if (n >= LIMITS.models * 5) break;
          if (key === '__proto__') continue;
          const entry = ms[key];
          if (!isObj(entry)) continue;
          const e = own(entry, 'effortLevel');
          const k = str(key);
          if (isEffort(e) && k !== undefined) {
            Object.defineProperty(out.effortByModel, k, { value: e, enumerable: true, writable: true, configurable: true });
            n++;
          }
        }
      }
    }
    const envModel = str(env['ANTHROPIC_MODEL']);
    if (envModel !== undefined) out.model = envModel;
    const envEffort = env['CLAUDE_CODE_EFFORT_LEVEL']?.trim().toLowerCase();
    if (isEffort(envEffort)) out.effort = envEffort;
  } catch {
    /* keep what we have */
  }
  return out;
}

/** Injected fs for `readCappedJson`. */
export interface CappedReadDeps {
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string): Promise<string>;
}

/** Outcome of `readCappedJson`. Never carries file content except in `value`. */
export type CappedJson =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'missing' | 'tooLarge' | 'invalid' | 'error' };

/** Stat first and refuse files over `maxBytes` (default 32 MB) without reading them, then read and parse. Never throws. */
export async function readCappedJson(path: string, deps: CappedReadDeps, maxBytes: number = MAX_CLAUDE_JSON_BYTES): Promise<CappedJson> {
  let size: number;
  try {
    size = (await deps.stat(path)).size;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error' };
  }
  if (size > maxBytes) return { ok: false, reason: 'tooLarge' };
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error' };
  }
  return parseJsonText(text, maxBytes);
}

/** Parse already-read text (e.g. from the file poller) with the same size refusal. Never throws. */
export function parseJsonText(text: string, maxBytes: number = MAX_CLAUDE_JSON_BYTES): CappedJson {
  if (text.length > maxBytes) return { ok: false, reason: 'tooLarge' };
  try {
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

// ===== Round B, task 5.4: skill usage (catalog) ===========================================================================
// Everything for the training library's usage counters lives in this one section. A later task (5.5) adds MCP parsing in
// its own section. Only `skillUsage` is read from `~/.claude.json`: `{ "<skill name>": { usageCount, lastUsedAt } }`.

/** Most `skillUsage` rows kept. A real file has a few dozen; the cap only stops a runaway or hostile file. */
export const MAX_SKILL_USAGE_ENTRIES = 2000;

/** One skill's counters: the whitelisted `usageCount` and `lastUsedAt` and nothing else. */
export interface SkillUsageEntry {
  /** Times the skill was used (a whole number, 0 or more). */
  uses: number;
  /** Epoch ms of the last use, when recorded. */
  lastUsedAt?: number;
}

/**
 * From a parsed `.claude.json`: only `skillUsage.<name>.usageCount` and `.lastUsedAt`. Rows whose count is not a finite
 * non-negative number are dropped; a bad `lastUsedAt` is dropped alone. Names are cut to `LIMITS.nameChars` with control
 * characters turned into spaces, and at most `MAX_SKILL_USAGE_ENTRIES` rows are kept. Returns a `Map` (a name such as
 * `__proto__` is just a key) built fresh from the input. Never throws; anything unusable gives an empty map.
 */
export function parseSkillUsage(raw: unknown): Map<string, SkillUsageEntry> {
  const out = new Map<string, SkillUsageEntry>();
  try {
    if (!isObj(raw)) return out;
    const usage = own(raw, 'skillUsage');
    if (!isObj(usage)) return out;
    for (const key of Object.keys(usage)) {
      if (out.size >= MAX_SKILL_USAGE_ENTRIES) break;
      const row = usage[key];
      if (!isObj(row)) continue;
      const name = str(key, LIMITS.nameChars);
      const count = num(own(row, 'usageCount'));
      if (name === undefined || count === undefined || count < 0) continue;
      const entry: SkillUsageEntry = { uses: Math.floor(count) };
      const last = num(own(row, 'lastUsedAt'));
      if (last !== undefined && last > 0) entry.lastUsedAt = Math.floor(last);
      if (!out.has(name)) out.set(name, entry);
    }
  } catch {
    /* keep what we have */
  }
  return out;
}
// ===== end of Round B, task 5.4 section ===================================================================================

// ===== Round B, task 5.5: MCP server config ===============================================================================
// Everything that interprets MCP server definitions and the approval facts for project servers lives in this one section.
// Inputs are the already-parsed JSON of `~/.claude.json`, `<project>/.mcp.json`, `managed-mcp.json` and the settings files
// (the file reading is in `mcpConfig.ts`). The server BODIES (command, args, env, url, headers) are secret-bearing: they go
// only into a `HostOnlyMcpConfigs` object, which exists so the catalog probe can start the right servers, and which prints
// and serialises as a fixed placeholder. A `McpConfigEntry` carries the name, scope and kind of transport and nothing else.
/** Where a file-defined MCP server is configured. (Plugin servers are not read: see `mcpConfig.ts`.) */
export type McpConfigScope = 'user' | 'local' | 'project' | 'managed';

/** Most servers read from one source. A real file has a handful; the cap only stops a runaway or hostile file. */
export const MAX_MCP_SERVERS_PER_SOURCE = 200;
/** Most names kept in an approval list or the claude.ai connector list. */
export const MAX_MCP_NAME_LIST = 500;

const MAX_MCP_STRING = 8192;
const MAX_MCP_ARGS = 200;
const MAX_MCP_ENV = 200;

/** What may leave this module about one server. No command, arguments, environment, URL or headers. */
export interface McpConfigEntry {
  name: string;
  scope: McpConfigScope;
  transport: McpTransport;
}

/**
 * Whitelisted facts that decide whether a project (`.mcp.json`) server may start, from `~/.claude.json` `projects[<cwd>]`
 * and the user, project and local settings files. `trustAccepted` is `projects[<cwd>].hasTrustDialogAccepted`.
 */
export interface McpApprovalFacts {
  /** `enableAllProjectMcpServers`: the highest-precedence explicit boolean (local settings, project, user, then `.claude.json`). */
  enableAll: boolean;
  /** `enabledMcpjsonServers`, all sources together. */
  enabled: string[];
  /** `disabledMcpjsonServers`, all sources together. A name here is never approved. */
  disabled: string[];
  /** Claude Code's folder-trust dialog was accepted for exactly this folder. */
  trustAccepted: boolean;
}

/** The approval keys of one source (the `projects[<cwd>]` object, or a settings file). Each field is absent when the source has none. */
export interface McpApprovalPart {
  enableAll?: boolean;
  enabled: string[];
  disabled: string[];
}

/**
 * The full server definitions, host side only. Never put one in a message, a log line or an `McpServerItem`. The map is a
 * private field, so `JSON.stringify`, spreading and `console.log` cannot reach it; `toJSON` and `inspect` give a placeholder.
 */
export class HostOnlyMcpConfigs {
  #byKey = new Map<string, Record<string, unknown>>();

  static keyOf(scope: McpConfigScope, name: string): string {
    return `${scope}\u0000${name}`;
  }

  /** Store a definition (already whitelisted by `parseMcpServers`). */
  set(scope: McpConfigScope, name: string, config: Record<string, unknown>): void {
    this.#byKey.set(HostOnlyMcpConfigs.keyOf(scope, name), config);
  }

  /** The definition, or `undefined`. A copy, so a caller cannot change what is stored. */
  get(scope: McpConfigScope, name: string): Record<string, unknown> | undefined {
    const c = this.#byKey.get(HostOnlyMcpConfigs.keyOf(scope, name));
    return c === undefined ? undefined : cloneJson(c);
  }

  get size(): number {
    return this.#byKey.size;
  }

  toJSON(): string {
    return '[host-only MCP server definitions]';
  }

  toString(): string {
    return '[host-only MCP server definitions]';
  }

  [inspect.custom](): string {
    return '[host-only MCP server definitions]';
  }
}

function cloneJson(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
}

function isTransport(v: string): v is McpTransport {
  return (MCP_TRANSPORTS as readonly string[]).includes(v);
}

/**
 * The contract transport of one server definition. `type` maps: stdio, http, sse, ws and sdk as they are; `streamable-http`
 * becomes http; `sse-ide` and `ws-ide` become sse and ws; `claudeai-proxy` (a claude.ai connector, reached over HTTP through
 * claude.ai) becomes http. No `type` and a `command` is stdio (Claude Code's default). No `type` and a `url` only is
 * `unknown` (Claude Code's schema rejects it, so it is not guessed). Anything else is `unknown`.
 */
export function mcpTransportOf(type: unknown, hasCommand: boolean): McpTransport {
  if (typeof type === 'string') {
    const t = type.trim().toLowerCase();
    if (t === 'streamable-http' || t === 'claudeai-proxy') return 'http';
    if (t === 'sse-ide') return 'sse';
    if (t === 'ws-ide') return 'ws';
    return isTransport(t) && t !== 'unknown' ? t : 'unknown';
  }
  return type === undefined && hasCommand ? 'stdio' : 'unknown';
}

function plainString(v: unknown, max = MAX_MCP_STRING): string | undefined {
  return typeof v === 'string' && v !== '' && v.length <= max ? v : undefined;
}

function stringMap(v: unknown, max: number): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= max) break;
    const val = v[k];
    if (k === '__proto__' || k === '' || k.length > 1024 || typeof val !== 'string' || val.length > MAX_MCP_STRING) continue;
    Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
    n++;
  }
  return out;
}

/**
 * A server definition cut to the keys Claude Code's SDK accepts for its transport, with every value checked (strings only,
 * sizes capped). Unknown keys (OAuth blocks, helpers, anything else) are dropped, never passed on. Returns a fresh object.
 */
function whitelistServerConfig(raw: Record<string, unknown>, transport: McpTransport): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (transport === 'stdio') {
    const command = plainString(own(raw, 'command'));
    if (command === undefined) return undefined;
    out['type'] = 'stdio';
    out['command'] = command;
    const args = own(raw, 'args');
    if (Array.isArray(args)) out['args'] = args.slice(0, MAX_MCP_ARGS).filter((a): a is string => typeof a === 'string' && a.length <= MAX_MCP_STRING);
    const env = stringMap(own(raw, 'env'), MAX_MCP_ENV);
    if (env !== undefined) out['env'] = env;
  } else if (transport === 'http' || transport === 'sse' || transport === 'ws') {
    const url = plainString(own(raw, 'url'));
    if (url === undefined) return undefined;
    out['type'] = transport;
    out['url'] = url;
    const headers = stringMap(own(raw, 'headers'), MAX_MCP_ENV);
    if (headers !== undefined) out['headers'] = headers;
  } else {
    return undefined;
  }
  const timeout = num(own(raw, 'timeout'));
  if (timeout !== undefined && timeout >= 0) out['timeout'] = Math.floor(timeout);
  if (typeof own(raw, 'alwaysLoad') === 'boolean') out['alwaysLoad'] = own(raw, 'alwaysLoad');
  return out;
}

/**
 * From the `mcpServers` value of one source (an object `{ "<name>": { type?, command?, args?, env? | url?, headers? } }`):
 * one entry per usable server, in file order, at most `MAX_MCP_SERVERS_PER_SOURCE`. The whitelisted body of each startable
 * server goes into `sink`; the returned entries hold the name, scope and transport only. A name is kept only when it is
 * plain text of at most `LIMITS.nameChars` (no control characters, not `__proto__`), so what the phone shows is exactly
 * the key Claude Code uses. A body that is not an object is skipped. Never throws.
 */
export function parseMcpServers(raw: unknown, scope: McpConfigScope, sink: HostOnlyMcpConfigs): McpConfigEntry[] {
  const out: McpConfigEntry[] = [];
  try {
    if (!isObj(raw)) return out;
    for (const key of Object.keys(raw)) {
      if (out.length >= MAX_MCP_SERVERS_PER_SOURCE) break;
      if (key === '__proto__' || key.length > LIMITS.nameChars || str(key, LIMITS.nameChars) !== key) continue;
      const body = raw[key];
      if (!isObj(body)) continue;
      const transport = mcpTransportOf(own(body, 'type'), plainString(own(body, 'command')) !== undefined);
      out.push({ name: key, scope, transport });
      const cfg = whitelistServerConfig(body, transport);
      if (cfg !== undefined) sink.set(scope, key, cfg);
    }
  } catch {
    /* keep what we have */
  }
  return out;
}

function nameList(v: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (const n of v) {
    if (out.length >= MAX_MCP_NAME_LIST) break;
    if (typeof n === 'string' && n !== '' && n.length <= LIMITS.nameChars && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The approval keys of one source: `enableAllProjectMcpServers` (only a real boolean counts), `enabledMcpjsonServers` and
 * `disabledMcpjsonServers` (arrays of names; anything else is ignored). Works on `projects[<cwd>]` and on a settings file.
 */
export function parseMcpApprovalPart(raw: unknown): McpApprovalPart {
  const part: McpApprovalPart = { enabled: [], disabled: [] };
  try {
    if (!isObj(raw)) return part;
    const all = own(raw, 'enableAllProjectMcpServers');
    if (typeof all === 'boolean') part.enableAll = all;
    part.enabled = nameList(own(raw, 'enabledMcpjsonServers'));
    part.disabled = nameList(own(raw, 'disabledMcpjsonServers'));
  } catch {
    /* keep what we have */
  }
  return part;
}

/**
 * Merge approval parts, highest precedence first (local settings, project settings, user settings, `.claude.json`): the
 * first explicit `enableAllProjectMcpServers` wins; the two name lists are unions.
 */
export function mergeMcpApproval(partsHighestFirst: readonly McpApprovalPart[], trustAccepted: boolean): McpApprovalFacts {
  let enableAll = false;
  let decided = false;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const p of partsHighestFirst) {
    if (!decided && p.enableAll !== undefined) {
      enableAll = p.enableAll;
      decided = true;
    }
    for (const n of p.enabled) if (enabled.length < MAX_MCP_NAME_LIST && !enabled.includes(n)) enabled.push(n);
    for (const n of p.disabled) if (disabled.length < MAX_MCP_NAME_LIST && !disabled.includes(n)) disabled.push(n);
  }
  return { enableAll, enabled, disabled, trustAccepted };
}

function samePath(a: string, b: string): boolean {
  const n = (p: string): string => {
    let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

/** The `projects[<cwd>]` object of a parsed `.claude.json`: the key must be this exact folder (slash style and a trailing slash aside). */
export function pickProjectEntry(claudeJson: unknown, cwd: string): Record<string, unknown> | undefined {
  try {
    if (!isObj(claudeJson)) return undefined;
    const projects = own(claudeJson, 'projects');
    if (!isObj(projects)) return undefined;
    for (const key of Object.keys(projects)) {
      if (key !== '__proto__' && samePath(key, cwd)) {
        const v = projects[key];
        return isObj(v) ? v : undefined;
      }
    }
  } catch {
    /* none */
  }
  return undefined;
}

/**
 * `projects[<cwd>].hasTrustDialogAccepted === true` for exactly this folder. Claude Code may also inherit trust from a parent
 * folder; that is deliberately not copied (an untrusted answer only means fewer servers are started).
 */
export function parseTrustAccepted(claudeJson: unknown, cwd: string): boolean {
  const entry = pickProjectEntry(claudeJson, cwd);
  return entry !== undefined && own(entry, 'hasTrustDialogAccepted') === true;
}

/** claude.ai connector names: `claudeAiMcpEverConnected` (an array of strings) of a parsed `.claude.json`, nothing else of it. */
export function parseCloudConnectorNames(claudeJson: unknown): string[] {
  try {
    return isObj(claudeJson) ? nameList(own(claudeJson, 'claudeAiMcpEverConnected')).slice(0, LIMITS.mcpServers) : [];
  } catch {
    return [];
  }
}
// ===== end of Round B, task 5.5 section ===================================================================================
