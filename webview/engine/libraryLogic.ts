/**
 * The Training library (the bookshelf): skills and commands grouped by source, searched, sorted and labelled. Pure (no
 * DOM). Everything is generic over the two item types because they share the fields the panel needs.
 */
import type { CommandItem, CommandSource, SkillItem, SkillSource } from '../../src/shared/protocol.ts';
import type { MemoPrefill } from '../../src/shared/panels.ts';

export const SKILL_SOURCE_ORDER: readonly SkillSource[] = ['project', 'user', 'synced', 'plugin'];
export const SKILL_SOURCE_TITLES: Readonly<Record<SkillSource, string>> = {
  project: 'This project',
  user: 'Yours',
  synced: 'Synced',
  plugin: 'From plugins',
};

export const COMMAND_SOURCE_ORDER: readonly CommandSource[] = ['builtin', 'project', 'user', 'plugin'];
export const COMMAND_SOURCE_TITLES: Readonly<Record<CommandSource, string>> = {
  builtin: 'Built in',
  project: 'This project',
  user: 'Yours',
  plugin: 'From plugins',
};

interface Searchable { name: string; invoke: string; description: string }

/** Every word of the query must appear in the name, the invoke text or the description (case ignored). An empty query matches all. */
export function matchesQuery(item: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.name}\n${item.invoke}\n${item.description}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

interface Sortable { name: string; uses?: number }

/** Most used first, then by name (numbers in order, case ignored). Returns a new array. */
export function sortItems<T extends Sortable>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    (b.uses ?? 0) - (a.uses ?? 0) ||
    a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface LibraryGroup<T, S extends string> {
  source: S;
  title: string;
  items: T[];
}

function group<T extends Searchable & Sortable & { source: S }, S extends string>(
  items: readonly T[], query: string, order: readonly S[], titles: Readonly<Record<S, string>>,
): LibraryGroup<T, S>[] {
  const out: LibraryGroup<T, S>[] = [];
  for (const source of order) {
    const list = sortItems(items.filter((i) => i.source === source && matchesQuery(i, query)));
    if (list.length) out.push({ source, title: titles[source], items: list });
  }
  return out;
}

/** Skills by source (in `SKILL_SOURCE_ORDER`), filtered by the query, most used first. Empty groups are left out. */
export function groupSkills(skills: readonly SkillItem[], query = ''): LibraryGroup<SkillItem, SkillSource>[] {
  return group(skills, query, SKILL_SOURCE_ORDER, SKILL_SOURCE_TITLES);
}

/** Commands by source (in `COMMAND_SOURCE_ORDER`), filtered by the query, then by name. */
export function groupCommands(commands: readonly CommandItem[], query = ''): LibraryGroup<CommandItem, CommandSource>[] {
  return group(commands, query, COMMAND_SOURCE_ORDER, COMMAND_SOURCE_TITLES);
}

/** The number of items across groups. */
export function groupTotal(groups: readonly { items: readonly unknown[] }[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

const DAY_MS = 86_400_000;

/** "today", "yesterday", "3 days ago", "2 months ago", "1 year ago". A time in the future counts as today. */
export function daysAgoText(at: number, now: number): string {
  const days = Math.floor(Math.max(0, now - at) / DAY_MS);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/** "Used 12 times · last 3 days ago", "Used 1 time", "Used 4 times"; "Not used yet" when there is no count. */
export function usageLabel(uses: number | undefined, lastUsedAt: number | undefined, now: number): string {
  if (uses === undefined || !Number.isFinite(uses) || uses <= 0) return 'Not used yet';
  const n = Math.floor(uses);
  const base = `Used ${n} ${n === 1 ? 'time' : 'times'}`;
  return lastUsedAt !== undefined && Number.isFinite(lastUsedAt) ? `${base} · last ${daysAgoText(lastUsedAt, now)}` : base;
}

/** "Use this": the slash command, ready for the rest to be typed. */
export function usePrefill(item: Pick<Searchable, 'invoke'>): MemoPrefill {
  return { prompt: `/${item.invoke} ` };
}

/** Where a plugin's item came from, for the small print: "Plugin: name", or '' when it is not a plugin's. */
export function pluginNote(item: { source: string; plugin?: string }): string {
  return item.source === 'plugin' && item.plugin ? `Plugin: ${item.plugin}` : '';
}

export const EMPTY_SKILLS = 'No skills found yet.';
export const EMPTY_COMMANDS = 'No commands found.';
/** Shown instead of both sections when there are no skills and no commands at all. */
export const EMPTY_LIBRARY = 'No skills or slash commands yet. Skills live in .claude/skills and commands in .claude/commands.';
export const NO_MATCHES = 'Nothing matches that search.';

/** The line above the list: "12 skills · 30 commands", or what the search left: "3 of 12 skills". */
export function libraryCounts(shownSkills: number, totalSkills: number, shownCommands: number, totalCommands: number): string {
  const s = (n: number): string => `${n} ${n === 1 ? 'skill' : 'skills'}`;
  const c = (n: number): string => `${n} ${n === 1 ? 'command' : 'commands'}`;
  if (shownSkills === totalSkills && shownCommands === totalCommands) return `${s(totalSkills)} · ${c(totalCommands)}`;
  return `${shownSkills} of ${s(totalSkills)} · ${shownCommands} of ${c(totalCommands)}`;
}
