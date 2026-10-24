// MCP servers for the office phone: reads where servers are configured, decides which may start, and builds the closed
// `McpServerItem` list the webview gets (docs/manager-mode.md section 16, "MCP: fields never forwarded"). No vscode import.
//
// What this module guarantees:
// - The interpretation of the files is in `claudeConfig.ts` (the "task 5.5" section). The full server definitions, which
//   hold commands, arguments, environment, URLs and headers, stay in a `HostOnlyMcpConfigs` object that serialises and
//   prints as a placeholder. They are used for exactly one thing: `selectServersToStart`, for the catalog probe.
// - An `McpServerItem` is built by `makeMcpItem`, key by key. Nothing here spreads or copies a config object or a status row.
//   SDK status rows are reduced by `parseMcpLiveStatuses` to name, status, scope, transport and a tool COUNT; the `error`,
//   `serverInfo` and `config` values are never read (only the kind of `config.type`).
// - This module logs nothing.
//
// Which servers exist (the one rule set, used by both the list and the probe):
// 1. Sources: `~/.claude.json` `mcpServers` (user), `~/.claude.json` `projects[<cwd>].mcpServers` (local), `<cwd>/.mcp.json`
//    (project; the folder itself only, not its parents) and `managed-mcp.json` in the managed folder (managed).
// 2. A present `managed-mcp.json` is exclusive, as in Claude Code's managed deployment: when it exists, no other file-defined
//    server is listed or started.
// 3. Names that exist in several scopes are shown once, by Claude Code's precedence: local, then project, then user.
// 4. A project server is "approved" when it is not in `disabledMcpjsonServers` and (`enableAllProjectMcpServers` is true or it
//    is in `enabledMcpjsonServers`). Nothing from a project folder is ever started or reported live unless BOTH the editor's
//    workspace trust and Claude Code's trust dialog for that folder were accepted AND the server is approved. A project
//    server that is not allowed to start is listed with status `disabled`, unless a lower-precedence scope defines the same
//    name, in which case that one is the server (the unapproved project one is left out).
// 5. Plugin-provided servers are NOT read. Whether a plugin is enabled, and the layout of its servers, are unverified
//    (docs/sdk-spike.md 15b: the SDK did not report a local plugin's server either). The SDK scope `plugin` still maps to
//    `plugin`, should a row ever come with it.
// 6. claude.ai connectors are not in any config file. Their names come from `claudeAiMcpEverConnected` (names only, status
//    `unknown` unless a live row says more); a live row with the SDK scope `claudeai` is also accepted.
import * as path from 'node:path';
import { LIMITS, MCP_SCOPES, MCP_STATUSES, MCP_TRANSPORTS } from '../shared/protocol.ts';
import type { McpScope, McpServerItem, McpStatus, McpTransport } from '../shared/protocol.ts';
import {
  HostOnlyMcpConfigs,
  mcpTransportOf,
  mergeMcpApproval,
  parseCloudConnectorNames,
  parseMcpApprovalPart,
  parseMcpServers,
  parseTrustAccepted,
  pickProjectEntry,
  readCappedJson,
} from './claudeConfig.ts';
import type { CappedReadDeps, McpApprovalFacts, McpConfigEntry, McpConfigScope } from './claudeConfig.ts';
import { managedDirFor } from './handbook.ts';
import { PROJECT_CLAUDE_DIR, claudeConfigJsonPath, claudeSettingsJsonPath } from './paths.ts';

/** The two trust answers. The host passes `vscode.workspace.isTrusted` and `McpSnapshot.approval.trustAccepted`. */
export interface McpTrust {
  /** VS Code's Workspace Trust for the project folder. */
  workspaceTrusted: boolean;
  /** Claude Code's `hasTrustDialogAccepted` for the project folder. */
  claudeTrusted: boolean;
}

/** True only when both answers are yes. */
export function bothTrusted(t: McpTrust): boolean {
  return t.workspaceTrusted === true && t.claudeTrusted === true;
}

/** Everything read from disk about MCP servers. `hostOnly` holds the secret-bearing bodies: never serialise or log it. */
export interface McpSnapshot {
  /** Servers from files, in source order: managed, local, project, user (each in file order). Names, scopes, transports only. */
  entries: McpConfigEntry[];
  approval: McpApprovalFacts;
  /** claude.ai connector names (`claudeAiMcpEverConnected`). */
  cloudNames: string[];
  /** A `managed-mcp.json` with a `mcpServers` object exists, which makes managed servers exclusive. */
  managedPresent: boolean;
  /** HOST ONLY. The whitelisted server bodies, for `selectServersToStart` and nothing else. */
  hostOnly: HostOnlyMcpConfigs;
}

/** Inputs of `readMcpConfig`. `fs` is the capped reader's fs (the catalog's `ConfigFs` fits). */
export interface McpReadOptions {
  /** The project folder: the active workspace folder or the root asked for. */
  cwd: string;
  /** Default `process.env`. Only `paths.ts` reads `CLAUDE_CONFIG_DIR` from it. */
  env?: Record<string, string | undefined>;
  home: string;
  fs: CappedReadDeps;
  /** Default `process.platform`. Picks the managed folder. */
  platform?: string;
  /** Overrides the managed folder (tests). */
  managedDir?: string;
}

const MAX_SMALL_JSON_BYTES = 2 * 1024 * 1024;

async function readSmall(fs: CappedReadDeps, file: string): Promise<unknown> {
  const r = await readCappedJson(file, fs, MAX_SMALL_JSON_BYTES);
  return r.ok ? r.value : undefined;
}

/** `~/.claude.json` is rewritten often by running sessions: one retry on a torn (invalid) read. */
async function readClaudeJson(fs: CappedReadDeps, file: string): Promise<unknown> {
  let r = await readCappedJson(file, fs);
  if (!r.ok && r.reason === 'invalid') r = await readCappedJson(file, fs);
  return r.ok ? r.value : undefined;
}

function mcpServersOf(doc: unknown): unknown {
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>)['mcpServers'] : undefined;
}

function hasMcpServersObject(doc: unknown): boolean {
  const m = mcpServersOf(doc);
  return typeof m === 'object' && m !== null && !Array.isArray(m);
}

/** Read the four server sources, the approval facts and the trust flag. Missing or unreadable files count as empty. Never throws. */
export async function readMcpConfig(opts: McpReadOptions): Promise<McpSnapshot> {
  const env = opts.env ?? process.env;
  const hostOnly = new HostOnlyMcpConfigs();
  const entries: McpConfigEntry[] = [];
  const out = (scope: McpConfigScope, raw: unknown): void => {
    entries.push(...parseMcpServers(raw, scope, hostOnly));
  };
  const snapshot: McpSnapshot = {
    entries,
    approval: { enableAll: false, enabled: [], disabled: [], trustAccepted: false },
    cloudNames: [],
    managedPresent: false,
    hostOnly,
  };
  try {
    const managedDir = opts.managedDir ?? managedDirFor(opts.platform ?? process.platform);
    const managedDoc = await readSmall(opts.fs, path.join(managedDir, 'managed-mcp.json'));
    snapshot.managedPresent = hasMcpServersObject(managedDoc);
    out('managed', mcpServersOf(managedDoc));

    const claudeJson = await readClaudeJson(opts.fs, claudeConfigJsonPath(env, opts.home));
    const projectEntry = pickProjectEntry(claudeJson, opts.cwd);
    out('local', projectEntry === undefined ? undefined : projectEntry['mcpServers']);
    out('project', mcpServersOf(await readSmall(opts.fs, path.join(opts.cwd, '.mcp.json'))));
    out('user', mcpServersOf(claudeJson));
    snapshot.cloudNames = parseCloudConnectorNames(claudeJson);

    const settings = await Promise.all([
      readSmall(opts.fs, path.join(opts.cwd, PROJECT_CLAUDE_DIR, 'settings.local.json')),
      readSmall(opts.fs, path.join(opts.cwd, PROJECT_CLAUDE_DIR, 'settings.json')),
      readSmall(opts.fs, claudeSettingsJsonPath(env, opts.home)),
    ]);
    snapshot.approval = mergeMcpApproval(
      [...settings.map((s) => parseMcpApprovalPart(s)), parseMcpApprovalPart(projectEntry)],
      parseTrustAccepted(claudeJson, opts.cwd),
    );
  } catch {
    /* keep what we have */
  }
  return snapshot;
}

/** Approved by Claude Code's rules: not in the disabled list, and enable-all or in the enabled list. */
export function isProjectServerApproved(name: string, a: Pick<McpApprovalFacts, 'enableAll' | 'enabled' | 'disabled'>): boolean {
  if (a.disabled.includes(name)) return false;
  return a.enableAll || a.enabled.includes(name);
}

/** One server after the rules in the header comment: shown once, and either allowed to start or blocked (project only). */
export interface ResolvedMcpServer {
  entry: McpConfigEntry;
  /** False for a project server that is untrusted or unapproved. It is never started. */
  allowed: boolean;
  /** Has a startable definition (stdio, http, sse or ws with a command or URL) and is allowed. */
  startable: boolean;
}

const SCOPE_ORDER: readonly McpConfigScope[] = ['local', 'project', 'user'];

/** The servers to show, de-duplicated by name (see the header comment for the rules). Pure. */
export function resolveMcpServers(snap: McpSnapshot, trust: McpTrust): ResolvedMcpServer[] {
  const out: ResolvedMcpServer[] = [];
  const startable = (e: McpConfigEntry): boolean => snap.hostOnly.get(e.scope, e.name) !== undefined;
  if (snap.managedPresent) {
    const seen = new Set<string>();
    for (const e of snap.entries) {
      if (e.scope !== 'managed' || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ entry: e, allowed: true, startable: startable(e) });
    }
    return out;
  }
  const trusted = bothTrusted(trust);
  const taken = new Set<string>();
  const blocked: McpConfigEntry[] = [];
  for (const scope of SCOPE_ORDER) {
    for (const e of snap.entries) {
      if (e.scope !== scope || taken.has(e.name)) continue;
      if (scope === 'project' && !(trusted && isProjectServerApproved(e.name, snap.approval))) {
        blocked.push(e);
        continue;
      }
      taken.add(e.name);
      out.push({ entry: e, allowed: true, startable: startable(e) });
    }
  }
  const seenBlocked = new Set<string>();
  for (const e of blocked) {
    if (taken.has(e.name) || seenBlocked.has(e.name)) continue;
    seenBlocked.add(e.name);
    out.push({ entry: e, allowed: false, startable: false });
  }
  return out;
}

/**
 * HOST ONLY. The `mcpServers` option for the catalog probe: exactly the servers that are shown, allowed and startable, as
 * whitelisted definitions. Contains secrets: pass it to the SDK and nowhere else. `names` is for counts and tests.
 */
export function selectServersToStart(snap: McpSnapshot, trust: McpTrust): { servers: Record<string, Record<string, unknown>>; names: string[] } {
  const servers: Record<string, Record<string, unknown>> = {};
  const names: string[] = [];
  for (const r of resolveMcpServers(snap, trust)) {
    if (!r.startable) continue;
    const cfg = snap.hostOnly.get(r.entry.scope, r.entry.name);
    if (cfg === undefined) continue;
    servers[r.entry.name] = cfg;
    names.push(r.entry.name);
  }
  return { servers, names };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live status rows
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A live row reduced to what the phone may show. Built only by `parseMcpLiveStatuses`.
 * The SDK row's `config`, `error`, `serverInfo` and tool list are never carried; `tools` is a count.
 */
export interface McpLiveRow {
  name: string;
  status: McpStatus;
  scope: McpScope;
  transport: McpTransport;
  tools?: number;
}

/**
 * The SDK `source` (preferred, as the SDK documents) or `scope` onto the contract:
 * `user`, `project`, `local`, `plugin` as they are; `managed` and `enterprise` become `managed`; `claudeai` becomes `cloud`;
 * everything else (`dynamic`, `agent`, `sdk`, a value not known yet, or nothing) becomes `unknown`.
 * (Servers started from the probe's explicit `mcpServers` come back as `dynamic`; the list keeps the scope of the file
 * they were read from, so this mapping only matters for rows the files did not define.)
 */
export function mcpScopeOf(source: unknown, scope: unknown): McpScope {
  const pick = (v: unknown): McpScope | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim().toLowerCase();
    if (t === 'claudeai') return 'cloud';
    if (t === 'enterprise') return 'managed';
    if (t === 'user' || t === 'project' || t === 'local' || t === 'plugin' || t === 'managed') return t;
    return undefined;
  };
  return pick(source) ?? pick(scope) ?? 'unknown';
}

/** The SDK status word onto the contract: `needs-auth` becomes `needsAuth`; an unnamed one is `unknown`, never text. */
export function mcpStatusOf(v: unknown): McpStatus {
  if (v === 'needs-auth' || v === 'needsAuth') return 'needsAuth';
  return typeof v === 'string' && (MCP_STATUSES as readonly string[]).includes(v) && v !== 'unknown' ? (v as McpStatus) : 'unknown';
}

const MAX_TOOL_COUNT = 100_000;
const MAX_LIVE_ROWS = LIMITS.mcpServers * 2;

/** From `mcpServerStatus()`: one reduced row per server (first one wins for a repeated name). Never throws. */
export function parseMcpLiveStatuses(raw: unknown): McpLiveRow[] {
  const out: McpLiveRow[] = [];
  try {
    if (!Array.isArray(raw)) return out;
    const seen = new Set<string>();
    for (const r of raw) {
      if (out.length >= MAX_LIVE_ROWS) break;
      if (typeof r !== 'object' || r === null || Array.isArray(r)) continue;
      const row = r as Record<string, unknown>;
      const name = cleanName(row['name']);
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      const cfg = row['config'];
      let transport: McpTransport = 'unknown';
      if (typeof cfg === 'object' && cfg !== null && !Array.isArray(cfg)) {
        const c = cfg as Record<string, unknown>;
        transport = mcpTransportOf(c['type'], typeof c['command'] === 'string' && c['command'] !== '');
      }
      const live: McpLiveRow = { name, status: mcpStatusOf(row['status']), scope: mcpScopeOf(row['source'], row['scope']), transport };
      const tools = row['tools'];
      if (Array.isArray(tools)) live.tools = Math.min(tools.length, MAX_TOOL_COUNT);
      out.push(live);
    }
  } catch {
    /* keep what we have */
  }
  return out;
}

function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s === '' || s === '__proto__' ? undefined : s.slice(0, LIMITS.nameChars);
}

// ---------------------------------------------------------------------------------------------------------------------
// The item list
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The ONLY constructor of an `McpServerItem`: one explicit assignment per key of `MCP_SERVER_ITEM_KEYS`. An out-of-range
 * scope, transport or status becomes `unknown`, a name is cut to `LIMITS.nameChars`, `tools` is kept only as a whole count.
 */
export function makeMcpItem(name: string, scope: McpScope, transport: McpTransport, status: McpStatus, tools?: number): McpServerItem {
  const item: McpServerItem = {
    name: name.slice(0, LIMITS.nameChars),
    scope: (MCP_SCOPES as readonly string[]).includes(scope) ? scope : 'unknown',
    transport: (MCP_TRANSPORTS as readonly string[]).includes(transport) ? transport : 'unknown',
    status: (MCP_STATUSES as readonly string[]).includes(status) ? status : 'unknown',
  };
  if (typeof tools === 'number' && Number.isInteger(tools) && tools >= 0) item.tools = Math.min(tools, MAX_TOOL_COUNT);
  return item;
}

/** Inputs of `buildMcpItems`. */
export interface BuildMcpItemsInput {
  snapshot: McpSnapshot;
  trust: McpTrust;
  /** Reduced live rows (`parseMcpLiveStatuses`). Absent offline: every status is `unknown` (or `disabled`, below). */
  live?: readonly McpLiveRow[];
  /** The live list is final. Until then an allowed server with no row yet is `pending`; afterwards it is `unknown`. */
  settled?: boolean;
}

/**
 * The phone's list. Per server:
 * - blocked project server (untrusted, unapproved or disabled): `disabled`, whatever the live rows say;
 * - a server we did not start (no startable definition): `unknown`;
 * - otherwise the live row's status and tool count; with no row yet: `pending` while the list is unsettled (a live list was
 *   given), else `unknown`; offline (no live list): `unknown`.
 * After the file-defined servers come rows the files did not define: live rows by their mapped scope (a claude.ai connector is
 * `cloud`), then `claudeAiMcpEverConnected` names as `cloud`, `http`, status from a matching live row or `unknown`.
 * At most `LIMITS.mcpServers` items; `truncated` is true when more existed.
 */
export function buildMcpItems(input: BuildMcpItemsInput): { servers: McpServerItem[]; truncated: boolean } {
  const live = new Map<string, McpLiveRow>();
  for (const r of input.live ?? []) if (!live.has(r.name)) live.set(r.name, r);
  const all: McpServerItem[] = [];
  const known = new Set<string>();
  for (const r of resolveMcpServers(input.snapshot, input.trust)) {
    const e = r.entry;
    known.add(e.name);
    const row = live.get(e.name);
    let status: McpStatus;
    let tools: number | undefined;
    if (!r.allowed) status = 'disabled';
    else if (!r.startable) status = 'unknown';
    else if (row !== undefined) {
      status = row.status;
      tools = row.tools;
    } else status = input.live !== undefined && input.settled !== true ? 'pending' : 'unknown';
    all.push(makeMcpItem(e.name, e.scope, e.transport, status, tools));
  }
  // Names of file-defined servers that were shadowed or left out still belong to the files: never add them from live rows.
  for (const e of input.snapshot.entries) known.add(e.name);
  for (const row of live.values()) {
    if (known.has(row.name)) continue;
    known.add(row.name);
    all.push(makeMcpItem(row.name, row.scope, row.transport, row.status, row.tools));
  }
  for (const name of input.snapshot.cloudNames) {
    if (known.has(name)) continue;
    known.add(name);
    all.push(makeMcpItem(name, 'cloud', 'http', 'unknown'));
  }
  const truncated = all.length > LIMITS.mcpServers;
  return { servers: truncated ? all.slice(0, LIMITS.mcpServers) : all, truncated };
}
