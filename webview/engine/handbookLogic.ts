/**
 * The Office handbook (the notice board): the CLAUDE.md chain, memory and permission rules, ordered, labelled and
 * counted. Pure (no DOM).
 */
import type { ConfigScope, HandbookFile, HostToWebview, MemoryEntry, MemoryType, PermissionRuleItem, RuleBehavior } from '../../src/shared/protocol.ts';

/** Loading order, widest first; later files are more specific and win when they disagree. */
export const SCOPE_ORDER: readonly ConfigScope[] = ['managed', 'user', 'project', 'local'];

export const SCOPE_LABELS: Readonly<Record<ConfigScope, string>> = {
  managed: 'Organisation',
  user: 'Yours, for every project',
  project: 'This project',
  local: 'Local to you',
};

export function scopeLabel(s: ConfigScope): string { return SCOPE_LABELS[s] ?? s; }

export interface InstructionRow {
  file: HandbookFile;
  scopeLabel: string;
  /** "12 KB"-style size, or ''. */
  size: string;
}

const sizeText = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1).replace(/\.0$/, '')} KB` : `${Math.round(kb)} KB`;
};

/**
 * The instruction files in precedence order: by scope (organisation, yours, project, local), keeping the host's order
 * within a scope (CLAUDE.md before its rules files).
 */
export function instructionRows(files: readonly HandbookFile[]): InstructionRow[] {
  const rank = (s: ConfigScope): number => { const i = SCOPE_ORDER.indexOf(s); return i < 0 ? SCOPE_ORDER.length : i; };
  return files
    .map((file, i) => ({ file, i }))
    .sort((a, b) => rank(a.file.scope) - rank(b.file.scope) || a.i - b.i)
    .map(({ file }) => ({ file, scopeLabel: scopeLabel(file.scope), size: sizeText(file.bytes) }));
}

export const MEMORY_TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  user: 'About you',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

export interface MemoryRow {
  entry: MemoryEntry;
  /** The title, or the file name when the entry has none. */
  title: string;
  /** The one-line hook, or ''. */
  hook: string;
  /** "About you", "Feedback"...; '' when the entry has no type. */
  typeLabel: string;
}

/** The memory entries as rows, in the host's order (the order of MEMORY.md). */
export function memoryRows(memory: readonly MemoryEntry[]): MemoryRow[] {
  return memory.map((entry) => ({
    entry,
    title: entry.title.trim() || entry.file,
    hook: entry.hook ?? '',
    typeLabel: entry.type ? MEMORY_TYPE_LABELS[entry.type] ?? '' : '',
  }));
}

/** Strictest first. */
export const BEHAVIOR_ORDER: readonly RuleBehavior[] = ['deny', 'ask', 'allow'];

export const BEHAVIOR_TITLES: Readonly<Record<RuleBehavior, string>> = {
  deny: 'Never allowed',
  ask: 'Always asks first',
  allow: 'Allowed without asking',
};

export interface RuleScopeGroup {
  scope: ConfigScope;
  title: string;
  rules: PermissionRuleItem[];
}

export interface RuleGroup {
  behavior: RuleBehavior;
  title: string;
  count: number;
  scopes: RuleScopeGroup[];
}

/** Rules by behaviour (deny, ask, allow), then by scope (organisation first), each in file order. Empty groups are left out. */
export function ruleGroups(rules: readonly PermissionRuleItem[]): RuleGroup[] {
  const out: RuleGroup[] = [];
  for (const behavior of BEHAVIOR_ORDER) {
    const ofKind = rules.filter((r) => r.behavior === behavior);
    if (!ofKind.length) continue;
    const scopes: RuleScopeGroup[] = [];
    for (const scope of SCOPE_ORDER) {
      const list = ofKind.filter((r) => r.scope === scope);
      if (list.length) scopes.push({ scope, title: scopeLabel(scope), rules: list });
    }
    out.push({ behavior, title: BEHAVIOR_TITLES[behavior], count: ofKind.length, scopes });
  }
  return out;
}

export interface HandbookCounts {
  instructions: number;
  memory: number;
  deny: number;
  ask: number;
  allow: number;
  rules: number;
}

export function handbookCounts(instructions: readonly HandbookFile[], memory: readonly MemoryEntry[], rules: readonly PermissionRuleItem[]): HandbookCounts {
  const n = (b: RuleBehavior): number => rules.filter((r) => r.behavior === b).length;
  return { instructions: instructions.length, memory: memory.length, deny: n('deny'), ask: n('ask'), allow: n('allow'), rules: rules.length };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 instruction files · 5 memories · 9 rules". */
export function summaryLine(c: HandbookCounts): string {
  return [plural(c.instructions, 'instruction file', 'instruction files'), plural(c.memory, 'memory', 'memories'), plural(c.rules, 'rule', 'rules')].join(' · ');
}

/** "1 never allowed · 2 ask first · 6 allowed"; zero parts are dropped; '' when there are no rules. */
export function rulesSummary(c: Pick<HandbookCounts, 'deny' | 'ask' | 'allow'>): string {
  const parts: string[] = [];
  if (c.deny) parts.push(`${c.deny} never allowed`);
  if (c.ask) parts.push(`${c.ask} ask first`);
  if (c.allow) parts.push(`${c.allow} allowed`);
  return parts.join(' · ');
}

export const EMPTY_INSTRUCTIONS = 'No CLAUDE.md files found. Add one to give every worker standing instructions.';
export const EMPTY_MEMORY = 'Nothing remembered yet.';
export const EMPTY_RULES = 'No permission rules. Workers ask before anything that needs approval.';

// ---------------------------------------------------------------------------
// Panel state (pure: what the panel keeps between host messages)

export interface HandbookData {
  instructions: HandbookFile[];
  memoryIndex: HandbookFile | null;
  memory: MemoryEntry[];
  rules: PermissionRuleItem[];
  truncated: boolean;
}

export interface HandbookState {
  data: HandbookData | null;
  loading: boolean;
  error: string | null;
}

export const HANDBOOK_INITIAL: HandbookState = { data: null, loading: false, error: null };

export function handbookRequested(s: HandbookState): HandbookState {
  return { ...s, loading: true, error: null };
}

/** The state after a host message, or null when it is not for the current request (other section, other `reqId`). */
export function handbookHandle(s: HandbookState, msg: HostToWebview, reqId: string): HandbookState | null {
  if (!reqId) return null;
  if (msg.type === 'catalog' && msg.reqId === reqId && msg.section === 'handbook') {
    return {
      data: { instructions: msg.instructions, memoryIndex: msg.memoryIndex ?? null, memory: msg.memory, rules: msg.rules, truncated: msg.truncated },
      loading: false,
      error: null,
    };
  }
  if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) return { ...s, loading: false, error: msg.message };
  return null;
}

/** Memory entries above this many start collapsed. */
export const MEMORY_OPEN_MAX = 8;
/** Rules above this many start collapsed. */
export const RULES_OPEN_MAX = 12;
/** Entries shown before "Show all". */
export const MEMORY_SHOWN = 25;
export const RULES_SHOWN = 40;

/** The one file id that every rule shares, or undefined when some have none or they differ. */
export function sharedFileId(rules: readonly PermissionRuleItem[]): string | undefined {
  const first = rules[0]?.fileId;
  return first !== undefined && rules.every((r) => r.fileId === first) ? first : undefined;
}
