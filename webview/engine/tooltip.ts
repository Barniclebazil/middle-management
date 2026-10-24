/**
 * Words for people: hover tooltip content and the roster lines (pure text;
 * the DOM lives in `main.ts` and `roster.ts`).
 */
import type { Activity, AgentControl, EffortLevel, PendingKind } from '../../src/shared/protocol.ts';
import type { AgentView } from './targets.ts';
import type { Office } from './office.ts';
import type { Char } from './characters.ts';
import { slotInfoOf } from './theme.ts';
import { formatCost, prettyModel } from './caseLogic.ts';
import { tierOf } from './modelTier.ts';
import type { ModelTier } from './modelTier.ts';
import { IT_SUPPORT_ROLE } from '../../src/shared/itSupport.ts';
import { IT_DEZ_ID, IT_DEZ_NAME, IT_FENWICK_NAME } from './itCrew.ts';

/** Plain-words description of each activity. */
export const ACTIVITY_WORDS: Readonly<Record<Activity, string>> = {
  reading: 'Reading',
  searching: 'Searching the files',
  researching: 'Researching on the web',
  writing: 'Writing',
  drawing: 'Drawing',
  running: 'Running a command',
  copier: 'Waiting on a long command',
  planning: 'Planning',
  delegating: 'Handing work to temps',
  thinking: 'Thinking',
  needsYou: 'Waiting for you',
  shredding: 'Compacting the conversation',
  idle: 'Idle',
};

/** What a knocking worker wants, in words (tooltip, roster, case file). */
export const PENDING_WORDS: Readonly<Record<PendingKind, string>> = {
  permission: 'wants your OK',
  question: 'has a question',
  plan: 'has a plan to sign off',
};

/** Short roster suffix for a knocking worker. */
const PENDING_SHORT: Readonly<Record<PendingKind, string>> = { permission: 'approval', question: 'question', plan: 'plan sign-off' };

/** "web-app · ⎇ main" (either part may be missing). */
export function projectLine(project: string, branch: string | undefined): string {
  return [project, branch ? `\u2387 ${branch}` : ''].filter(Boolean).join(' \u00b7 ');
}

/** "45s", "2m 13s", "1h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface TooltipContent {
  title: string;
  lines: string[];
  /** What a click does ("Click to …"), shown apart from the facts. */
  hint?: string;
  /** Graphic model chip + effort meter (hover only). `label` is the pretty model name, '' when only the effort is known. */
  badge?: { tier: ModelTier | null; label: string; effort?: EffortLevel };
}

/** Effort levels in order, lowest first (the meter's pips). */
export const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Filled pips for an effort level: low=1 ... max=5; 0 for anything unknown. */
export function effortPips(level: string | undefined): number {
  return EFFORT_ORDER.indexOf(level as EffortLevel) + 1;
}

/** Screen-reader text for the badge row, "Model Opus 5.5, effort xhigh (4 of 5)". */
export function badgeLabel(b: NonNullable<TooltipContent['badge']>): string {
  const parts: string[] = [];
  if (b.label) parts.push(`Model ${b.label}`);
  if (b.effort) parts.push(`effort ${b.effort}${effortPips(b.effort) ? ` (${effortPips(b.effort)} of ${EFFORT_ORDER.length})` : ''}`);
  return parts.join(', ');
}

/** "Idle", or "Idle · waiting on N temp(s)" for a parent whose temps are still working. */
export function idleWords(waitingTemps: number): string {
  return waitingTemps > 0 ? `Idle · waiting on ${waitingTemps} temp${waitingTemps === 1 ? '' : 's'}` : ACTIVITY_WORDS.idle;
}

/** "124k", "1.5M", "850". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/**
 * "Opus 5.5 · xhigh · context 62% (124k / 200k)". Parts that are missing are left out; a guessed window size
 * (`approx`) puts a "~" before the percentage. '' when nothing is known.
 */
export function modelLine(a: Pick<AgentView, 'model' | 'effort' | 'context'>): string {
  const parts: string[] = [];
  const model = prettyModel(a.model);
  if (model) parts.push(model);
  if (a.effort) parts.push(a.effort);
  const ctx = contextLine(a);
  if (ctx) parts.push(ctx);
  return parts.join(' \u00b7 ');
}

/** "context 62% (124k / 200k)" alone, '' when unknown (the model and effort are drawn as a badge in the tooltip). */
export function contextLine(a: Pick<AgentView, 'context'>): string {
  const c = a.context;
  if (!c || !Number.isFinite(c.pct) || c.pct < 0) return '';
  const sizes = Number.isFinite(c.tokens) && Number.isFinite(c.max) && c.max > 0 ? ` (${formatTokens(c.tokens)} / ${formatTokens(c.max)})` : '';
  return `context ${c.approx ? '~' : ''}${Math.round(c.pct)}%${sizes}`;
}

/** Tooltip for an agent (staff or temp). `waitingTemps` = its temps that are not done yet. */
export function agentTooltip(a: AgentView, role: string, parentTitle: string | null, hostNow: number, leaving: boolean, waitingTemps = 0, name?: string): TooltipContent {
  const lines: string[] = [];
  const named = typeof name === 'string' && name.trim() !== '';
  // A named person leads with "Name — Role"; the session title then becomes its own line.
  if (named) lines.push(a.title);
  const where = projectLine(a.project, a.gitBranch);
  if (where) lines.push(where);
  if (!named) lines.push(role);
  if (a.kind === 'temp') lines.push(`Temp working for ${parentTitle ?? 'a session that has left'}`);
  let doing: string;
  if (leaving || a.status === 'done') doing = a.kind === 'temp' ? 'Finished, heading out' : 'Gone for the day';
  else doing = a.kind === 'main' && a.activity === 'idle' ? idleWords(waitingTemps) : ACTIVITY_WORDS[a.activity] ?? 'Working';
  lines.push(`${doing} for ${formatDuration(hostNow - a.since)}`);
  const facts = contextLine(a);
  if (facts) lines.push(facts);
  if (a.pending && !leaving) lines.push(`Knocking: ${PENDING_WORDS[a.pending.kind]}`);
  else if (a.detail && !leaving) lines.push(a.detail);
  if (a.control === 'elsewhere') lines.push('Open in another window (read-only here)');
  const tip: TooltipContent = { title: named ? `${name!.trim()} \u2014 ${role}` : a.title, lines };
  const label = prettyModel(a.model);
  const effort = a.effort && effortPips(a.effort) > 0 ? a.effort : undefined;
  if (label || effort) tip.badge = { tier: tierOf(a.model), label, ...(effort ? { effort } : {}) };
  if (!leaving) tip.hint = a.pending ? 'Click to answer' : 'Click to open their case file';
  return tip;
}

/**
 * A running Fable spell, for the boss's tooltip: who has his office and for how much longer (ms). `holder` is a person's
 * name when `named` (a theme names their slot), else the session title, which is quoted.
 */
export interface SulkInfo { holder: string; named?: boolean; msLeft: number }

/** "for another 3 min" (minutes rounded up), "for under a minute" in the last minute. */
export function spellLeftWords(msLeft: number): string {
  if (!(msLeft >= 60_000)) return 'for under a minute';
  return `for another ${Math.ceil(msLeft / 60_000)} min`;
}

/** Tooltip for the manager (you); `jobTitle` is the theme's title for the post. During a Fable spell (`sulk`), a line says who has the office and for how long. */
export function managerTooltip(managerName: string, sulk?: SulkInfo, jobTitle = 'Regional Manager'): TooltipContent {
  const name = managerName.trim();
  const title = !name || /^you$/i.test(name) ? `You — ${jobTitle}` : `${name} — ${jobTitle} (you)`;
  const lines: string[] = [];
  if (sulk) {
    const h = sulk.holder.trim();
    const who = !h ? 'A Fable worker' : sulk.named ? h : `\u201c${h}\u201d`;
    lines.push(`Sulking: ${who} has your office ${spellLeftWords(sulk.msLeft)}`);
  }
  return { title, lines, hint: 'Click to hand out a new task' };
}

/** Tooltip for the receptionist at the front desk ("Name \u2014 Receptionist" when the theme names them). */
export function receptionistTooltip(name?: string, jobTitle = 'Receptionist'): TooltipContent {
  const n = typeof name === 'string' ? name.trim() : '';
  return { title: n ? `${n} \u2014 ${jobTitle}` : jobTitle, lines: ['Theme, names, colours and settings'], hint: 'Click to open the Front desk' };
}

/** Tooltip for the cleaner (not clickable, so no hint); the theme may name them and retitle the post. */
export function cleanerTooltip(name?: string, jobTitle = 'Cleaner'): TooltipContent {
  return { title: namedTitle(name, jobTitle), lines: ['Wipes down empty desks, the kitchen and the bins'] };
}

/** Tooltip for the food cart's vendor (not clickable, so no hint); the theme may name them and retitle the post. */
export function vendorTooltip(name?: string, jobTitle = 'Food cart'): TooltipContent {
  return { title: namedTitle(name, jobTitle), lines: ['Tea, cake and crisps, every so often'] };
}

/** "Name \u2014 Title" when the theme names the person, else the title alone. */
function namedTitle(name: string | undefined, jobTitle: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  return n ? `${n} \u2014 ${jobTitle}` : jobTitle;
}

/** Tooltip for one of the IT pair, by character id (not clickable, so no hint); `name` and `jobTitle` come from the theme. */
export function itTooltip(id: string, name?: string, jobTitle = IT_SUPPORT_ROLE): TooltipContent {
  const who = (builtIn: string): string => (typeof name === 'string' && name.trim() !== '' ? name.trim() : builtIn);
  if (id === IT_DEZ_ID) return { title: `${who(IT_DEZ_NAME)}, ${jobTitle}`, lines: ['Has tried turning it off and on again'] };
  return { title: `${who(IT_FENWICK_NAME)}, ${jobTitle}`, lines: ['Unimpressed by anything an AI made'] };
}

/** One roster line, worked out from a character (DOM-free, for tests). */
export interface RosterEntry {
  id: string;
  look: string;
  temp: boolean;
  /** For temps: the staff member they work for (when that person is listed). */
  parentId?: string;
  title: string;
  /** The themed person's name for this slot, '' when none. */
  name: string;
  /** The theme's role for this slot, '' when none (the roster falls back to the look's role). */
  role: string;
  doing: string;
  detail: string;
  since: string;
  needsYou: boolean;
  gone: boolean;
  /** Git branch, '' when unknown. */
  branch: string;
  control?: AgentControl;
  /** What a knocking office-run worker wants, if anything. */
  pending: PendingKind | null;
  /** The detail line a wide strip list shows (`rosterMeta`): "Opus 5.5 · xhigh · 42% context · $0.42"; '' when nothing is known. */
  meta?: string;
}

/**
 * The staff list's detail line for a worker (task 10.1, shown only where the list has width to spare): the model, effort,
 * how full the context is and the cost so far. Parts that are unknown are left out; '' when none is known.
 */
export function rosterMeta(a: Pick<AgentView, 'model' | 'effort' | 'context' | 'costUsd'>): string {
  const parts: string[] = [];
  const model = prettyModel(a.model);
  if (model) parts.push(model);
  if (a.effort) parts.push(a.effort);
  const c = a.context;
  if (c && Number.isFinite(c.pct) && c.pct >= 0) parts.push(`${c.approx ? '~' : ''}${Math.round(c.pct)}% context`);
  const cost = formatCost(a.costUsd);
  if (cost) parts.push(cost);
  return parts.join(' \u00b7 ');
}

/** Roster order: staff in hand-out order, each followed by their temps; then anyone else. */
export function rosterEntries(office: Office, hostNow: number): RosterEntry[] {
  const chars = [...office.chars.values()].filter((c) => !c.removed && c.agent);
  const archetypes = office.world.staffSlots;
  const rank = (c: Char): number => {
    const i = archetypes.indexOf(c.look);
    return i >= 0 ? i : archetypes.length;
  };
  const byStart = (a: Char, b: Char): number => (a.agent!.startedAt - b.agent!.startedAt) || (a.id < b.id ? -1 : 1);
  const mains = chars.filter((c) => c.agent!.kind === 'main').sort((a, b) => (rank(a) - rank(b)) || byStart(a, b));
  const temps = chars.filter((c) => c.agent!.kind === 'temp').sort(byStart);
  const ordered: Char[] = [];
  const used = new Set<string>();
  for (const m of mains) {
    ordered.push(m);
    used.add(m.id);
    for (const t of temps) if (t.agent!.parentId === m.id) { ordered.push(t); used.add(t.id); }
  }
  for (const t of temps) if (!used.has(t.id)) ordered.push(t);
  const waitingOn = (m: Char): number => temps.filter((t) => t.agent!.parentId === m.id && t.agent!.status !== 'done').length;
  return ordered.map((c) => {
    const a = c.agent!;
    const gone = c.leaving || a.status === 'done';
    const needsYou = !gone && (a.activity === 'needsYou' || a.status === 'waiting');
    let doing: string;
    if (gone) doing = a.kind === 'temp' ? 'Finished, heading out' : 'Gone for the day';
    else if (needsYou) doing = a.pending ? `Needs you \u00b7 ${PENDING_SHORT[a.pending.kind]}` : 'Needs you';
    else if (a.kind === 'main' && a.activity === 'idle') doing = idleWords(waitingOn(c));
    else doing = ACTIVITY_WORDS[a.activity] ?? 'Working';
    const parentId = a.kind === 'temp' && a.parentId && used.has(a.parentId) && office.chars.get(a.parentId)?.agent?.kind === 'main' ? a.parentId : undefined;
    const info = slotInfoOf(office.theme, c.look);
    return {
      id: c.id, look: c.look, temp: a.kind === 'temp', parentId, title: a.title, name: info?.name ?? '', role: info?.role || (a.kind === 'temp' ? office.theme?.titles?.temp : undefined) || '', doing,
      detail: gone || needsYou ? '' : a.detail ?? '', since: formatDuration(hostNow - a.since), needsYou, gone,
      branch: a.gitBranch ?? '', control: a.control, pending: gone ? null : a.pending?.kind ?? null, meta: rosterMeta(a),
    };
  });
}
