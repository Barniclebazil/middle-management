/** Subagent types (the temp agency): grouping, labels and the hire prefill. Pure (no DOM). */
import type { AgentTypeItem, AgentTypeSource, HostToWebview } from '../../src/shared/protocol.ts';
import type { MemoPrefill } from '../../src/shared/panels.ts';
import { prettyModel } from './caseLogic.ts';
import { matchesQuery } from './libraryLogic.ts';

export const SOURCE_ORDER: readonly AgentTypeSource[] = ['builtin', 'project', 'user', 'plugin'];

export const SOURCE_TITLES: Readonly<Record<AgentTypeSource, string>> = {
  builtin: 'Built in',
  project: 'This project',
  user: 'Yours',
  plugin: 'From plugins',
};

export interface AgencyGroup {
  source: AgentTypeSource;
  title: string;
  agents: AgentTypeItem[];
}

/** Types by source (built-in first), each by name, filtered by the query (name and description). Empty groups are left out. */
export function groupAgents(agents: readonly AgentTypeItem[], query = ''): AgencyGroup[] {
  const out: AgencyGroup[] = [];
  for (const source of SOURCE_ORDER) {
    const list = agents
      .filter((a) => a.source === source && matchesQuery({ name: a.name, invoke: '', description: a.description }, query))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (list.length) out.push({ source, title: SOURCE_TITLES[source], agents: list });
  }
  return out;
}

export const INHERIT_LABEL = 'Same as the worker';

/** "Sonnet", "Opus 4.1"; "Same as the worker" for `inherit`, an empty value or none. */
export function modelLabel(model: string | undefined): string {
  const m = model?.trim();
  if (!m || m.toLowerCase() === 'inherit') return INHERIT_LABEL;
  return prettyModel(m) || INHERIT_LABEL;
}

/** "All tools" when the list is absent; "No tools" when empty; else the first few and "+N": "Read, Grep, Glob +4". */
export function toolsSummary(tools: readonly string[] | undefined, show = 3): string {
  if (tools === undefined) return 'All tools';
  if (!tools.length) return 'No tools';
  const head = tools.slice(0, Math.max(1, show)).join(', ');
  const rest = tools.length - Math.max(1, show);
  return rest > 0 ? `${head} +${rest}` : head;
}

/** "Hire for a task": the sentence start, ready for the task to be typed. */
export function hirePrefill(agent: Pick<AgentTypeItem, 'name'>): MemoPrefill {
  return { prompt: `Use the ${agent.name} subagent to ` };
}

/** "Plugin: name" for a plugin's type; '' otherwise. */
export function agentNote(a: Pick<AgentTypeItem, 'source' | 'plugin'>): string {
  return a.source === 'plugin' && a.plugin ? `Plugin: ${a.plugin}` : '';
}

export const EMPTY_AGENTS = 'No subagent types found.';
export const NO_MATCHES = 'Nothing matches that search.';

/** "7 types", "1 type"; with a search, "3 of 7 types". */
export function agencyCount(shown: number, total: number): string {
  const t = `${total} ${total === 1 ? 'type' : 'types'}`;
  return shown === total ? t : `${shown} of ${t}`;
}

// ---------------------------------------------------------------------------
// Panel state (pure: what the panel keeps between host messages)

export interface AgencyState {
  agents: AgentTypeItem[] | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export const AGENCY_INITIAL: AgencyState = { agents: null, truncated: false, loading: false, error: null };

export function agencyRequested(s: AgencyState): AgencyState {
  return { ...s, loading: true, error: null };
}

/** The state after a host message, or null when it is not for the current request (other section, other `reqId`). */
export function agencyHandle(s: AgencyState, msg: HostToWebview, reqId: string): AgencyState | null {
  if (!reqId) return null;
  if (msg.type === 'catalog' && msg.reqId === reqId && msg.section === 'agents') {
    return { agents: msg.agents, truncated: msg.truncated, loading: false, error: null };
  }
  if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) return { ...s, loading: false, error: msg.message };
  return null;
}

/** A tool list longer than this is folded behind its summary. */
export const TOOLS_INLINE_MAX = 3;
