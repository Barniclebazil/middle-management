/** MCP servers (the phone): each one is a "line". Status words, light colours, order and the summary. Pure (no DOM). */
import type { HostToWebview, McpScope, McpServerItem, McpStatus, McpTransport } from '../../src/shared/protocol.ts';

/** The colour of the status light; the same tones as the plan badges. */
export type LightTone = 'ok' | 'warn' | 'err' | 'busy' | 'off' | 'dim';

export const STATUS_LABELS: Readonly<Record<McpStatus, string>> = {
  connected: 'Connected',
  failed: 'Failed',
  needsAuth: 'Needs sign-in',
  pending: 'Connecting…',
  disabled: 'Off',
  unknown: 'Unknown',
};

export const STATUS_TONES: Readonly<Record<McpStatus, LightTone>> = {
  connected: 'ok',
  failed: 'err',
  needsAuth: 'warn',
  pending: 'busy',
  disabled: 'off',
  unknown: 'dim',
};

export function statusLabel(s: McpStatus): string { return STATUS_LABELS[s] ?? STATUS_LABELS.unknown; }
export function statusTone(s: McpStatus): LightTone { return STATUS_TONES[s] ?? 'dim'; }

/** Problems first (failed, needs sign-in, unknown), then the quiet ones. */
const STATUS_RANK: Readonly<Record<McpStatus, number>> = { failed: 0, needsAuth: 1, unknown: 2, pending: 3, connected: 4, disabled: 5 };

/** Whether the line needs the user's attention. */
export function isProblem(s: McpStatus): boolean { return s === 'failed' || s === 'needsAuth'; }

/** Problems first, then by name (numbers in order, case ignored). Returns a new array. */
export function sortServers(servers: readonly McpServerItem[]): McpServerItem[] {
  return [...servers].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2) ||
    a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "4 lines · 1 failed · 1 needs sign-in"; "1 line"; "No lines". Only problems are called out. */
export function summaryLine(servers: readonly McpServerItem[]): string {
  if (!servers.length) return 'No lines';
  const failed = servers.filter((s) => s.status === 'failed').length;
  const auth = servers.filter((s) => s.status === 'needsAuth').length;
  const parts = [`${servers.length} ${servers.length === 1 ? 'line' : 'lines'}`];
  if (failed) parts.push(`${failed} failed`);
  if (auth) parts.push(`${auth} needs sign-in`);
  return parts.join(' · ');
}

export const SCOPE_LABELS: Readonly<Record<McpScope, string>> = {
  user: 'Yours',
  project: 'This project',
  local: 'Local to you',
  plugin: 'Plugin',
  managed: 'Set by your organisation',
  cloud: 'Cloud',
  unknown: 'Unknown',
};

export const TRANSPORT_LABELS: Readonly<Record<McpTransport, string>> = {
  stdio: 'Local program',
  http: 'Web (HTTP)',
  sse: 'Web (SSE)',
  ws: 'Web socket',
  sdk: 'Built in',
  unknown: 'Unknown',
};

export function scopeLabel(s: McpScope): string { return SCOPE_LABELS[s] ?? SCOPE_LABELS.unknown; }
export function transportLabel(t: McpTransport): string { return TRANSPORT_LABELS[t] ?? TRANSPORT_LABELS.unknown; }

/** "12 tools", "1 tool", "No tools"; '' when the count is unknown. */
export function toolsLabel(tools: number | undefined): string {
  if (tools === undefined || !Number.isFinite(tools) || tools < 0) return '';
  const n = Math.floor(tools);
  return n === 0 ? 'No tools' : `${n} ${n === 1 ? 'tool' : 'tools'}`;
}

/** The small print under a line's name: "Yours · Local program · 12 tools". */
export function serverMeta(s: McpServerItem): string {
  // An unknown scope or kind says nothing on its own ("Unknown · Unknown"): leave it out, and say so once when nothing is known.
  const known = (label: string): string => (label === SCOPE_LABELS.unknown ? '' : label);
  const parts = [known(scopeLabel(s.scope)), known(transportLabel(s.transport)), toolsLabel(s.tools)].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Scope and kind not known';
}

export const EMPTY_LINES = 'No MCP servers are set up. They are added with `claude mcp add` or in a .mcp.json file.';

// ---------------------------------------------------------------------------
// Panel state (pure: what the panel keeps between host messages)

export interface PhoneState {
  /** The last list the host sent, or null before the first reply. */
  servers: McpServerItem[] | null;
  /** The host cut the list at its limit. */
  truncated: boolean;
  /** A request is out. The old list stays on screen meanwhile. */
  loading: boolean;
  error: string | null;
}

export const PHONE_INITIAL: PhoneState = { servers: null, truncated: false, loading: false, error: null };

/** The state once a request has been sent. */
export function phoneRequested(s: PhoneState): PhoneState {
  return { ...s, loading: true, error: null };
}

/**
 * The state after a host message, or null when the message is not for this panel's current request (another section,
 * another `reqId`, an `error` for something else). A `catalog` reply for the current `reqId` may arrive several times.
 */
export function phoneHandle(s: PhoneState, msg: HostToWebview, reqId: string): PhoneState | null {
  if (!reqId) return null;
  if (msg.type === 'catalog' && msg.reqId === reqId && msg.section === 'mcp') {
    return { servers: msg.servers, truncated: msg.truncated, loading: false, error: null };
  }
  if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) return { ...s, loading: false, error: msg.message };
  return null;
}

/** "3 connecting" for the summary line; '' when none are. */
export function connectingNote(servers: readonly McpServerItem[]): string {
  const n = servers.filter((s) => s.status === 'pending').length;
  return n ? `${n} connecting` : '';
}

/** Splits `text` on backticks into plain and code parts: "run `x` now" -> [{text:'run '}, {text:'x', code:true}, {text:' now'}]. */
export function codeParts(text: string): { text: string; code?: true }[] {
  return text.split('`').map((t, i) => (i % 2 ? { text: t, code: true as const } : { text: t })).filter((p) => p.text !== '');
}
