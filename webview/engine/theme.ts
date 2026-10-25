/**
 * Custom staff themes, webview side: turns the parsed theme file (`OfficeTheme`) into the per-slot
 * names, roles, lines and pins the engine needs. Pure and DOM-free; it never imports `webview/art/*`
 * (the look overrides come back as plain specs, `main.ts` registers them with the art registry).
 */
import type { OfficeSettings } from '../../src/shared/protocol.ts';
import { LINE_POOL_KEYS, LINE_POOL_KIND, NPC_KEYS } from '../../src/shared/theme.ts';
import type { LineMode, LinePoolKey, LookSpec, NpcKey, OfficeTheme, PairPoolKey, TitleKey } from '../../src/shared/theme.ts';
import { LINE_POOLS, SMALL_TALK } from './lines.ts';

/** Id of the manager's look in the art registry (`MANAGER_LOOK`), repeated here to stay free of art imports. */
export const MANAGER_LOOK_ID = 'manager';
/** Id of the receptionist's look in the art registry (`RECEPTIONIST_LOOK`). */
export const RECEPTIONIST_LOOK_ID = 'receptionist';
/** The look ids of the side characters (the art's `CLEANER_LOOK`, `VENDOR_LOOK`, `DEZ_LOOK` and `FENWICK_LOOK`). The IT fixer is Dez, the critic Fenwick. */
export const NPC_LOOK_ID_OF: Readonly<Record<NpcKey, string>> = { cleaner: 'cleaner', vendor: 'vendor', itFixer: 'dez', itCritic: 'fenwick' };

/** What a theme says about one slot (a staff slot or a temp slot). */
export interface SlotInfo {
  name?: string;
  role?: string;
  /** The person's own lines; they open a water-cooler chat now and then (not every time). */
  lines?: readonly string[];
  pin?: { project?: string; title?: string };
}

/** What one pool holds: single lines, or (opener, reply) pairs for the pairs pools. */
export type PoolEntry<K extends LinePoolKey> = K extends PairPoolKey ? readonly [string, string] : string;
/** The source lists a pool says its lines from, in the shape `LiveDeck.next(rng, ...sources)` takes. */
export type LineSources<K extends LinePoolKey = LinePoolKey> = readonly (readonly PoolEntry<K>[])[];
/** The pools whose entries are single lines. */
export type StringPoolKey = Exclude<LinePoolKey, PairPoolKey>;

export interface ThemeState {
  companyName?: string;
  branchName?: string;
  managerName?: string;
  /** The receptionist's name (labels and tooltip). */
  receptionistName?: string;
  /** `replace`: a pool the theme fills says only the theme's lines; `add` (the default) says the built-in lines too. */
  lineMode: LineMode;
  /**
   * The theme's own lines by pool, non-empty pools only, after merging the legacy fields (`manager.lines` joins
   * `bossVisit`; `receptionist.lines` joins `receptionPhone`, `receptionGreeting` and `receptionIdle`) and folding to ASCII.
   * Read them through `lineSources`, which also knows the mode and the built-in lines.
   */
  pools: { readonly [K in LinePoolKey]?: readonly PoolEntry<K>[] };
  /** The theme's own water-cooler pairs (`lineMode` decides whether they replace the built-in ones). */
  smallTalk?: readonly (readonly [string, string])[];
  /** Renamed job titles, folded to ASCII. */
  titles: Partial<Record<TitleKey, string>>;
  /** The side characters' names (their looks come in `looks` once the art applies them). */
  npcs: Partial<Record<NpcKey, { name?: string }>>;
  /** Staff slot id -> info (only slots the theme mentions). */
  staff: Map<string, SlotInfo>;
  /** Temp slot id -> info. */
  temps: Map<string, SlotInfo>;
  /** Look overrides to register: slot ids, 'manager' and 'receptionist', each with its (partial) spec. */
  looks: { id: string; spec: LookSpec }[];
}

const nonEmpty = (s: string | undefined): s is string => typeof s === 'string' && s !== '';

/**
 * Folds the typographic characters the pixel font cannot draw (it draws ASCII 32 to 126 and anything else as `?`) to
 * their ASCII look-alikes: curly quotes, dashes, the ellipsis and Unicode spaces. Other characters are left alone.
 */
export function foldAscii(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

const foldLines = (xs: readonly string[] | undefined): string[] => (xs ?? []).map(foldAscii).filter((x) => x.trim() !== '');
const foldPairs = (xs: readonly (readonly [string, string])[] | undefined): [string, string][] =>
  (xs ?? []).map(([a, b]) => [foldAscii(a), foldAscii(b)] as [string, string]).filter(([a, b]) => a.trim() !== '' && b.trim() !== '');
const foldName = (s: string | undefined): string | undefined => (nonEmpty(s) ? foldAscii(s) : undefined);

/** The legacy line fields and the pools they join (after the pool's own theme lines). */
const BOSS_LEGACY_POOLS: readonly LinePoolKey[] = ['bossVisit'];
const RECEPTIONIST_LEGACY_POOLS: readonly LinePoolKey[] = ['receptionPhone', 'receptionGreeting', 'receptionIdle'];

/** Maps a parsed theme onto the slots. Entries beyond the available slots are ignored. */
export function themeState(theme: OfficeTheme | undefined, staffSlots: readonly string[], tempSlots: readonly string[]): ThemeState {
  const state: ThemeState = { lineMode: 'add', pools: {}, titles: {}, npcs: {}, staff: new Map(), temps: new Map(), looks: [] };
  if (!theme) return state;
  if (nonEmpty(theme.company)) state.companyName = theme.company;
  if (nonEmpty(theme.branch)) state.branchName = theme.branch;
  if (theme.lineMode === 'replace') state.lineMode = 'replace';
  const pools: Record<string, readonly unknown[]> = {};
  for (const key of LINE_POOL_KEYS) {
    const own = theme.lines?.[key] as readonly unknown[] | undefined;
    if (!own) continue;
    const folded = LINE_POOL_KIND[key] === 'pairs' ? foldPairs(own as [string, string][]) : foldLines(own as string[]);
    if (folded.length > 0) pools[key] = folded;
  }
  const join = (keys: readonly LinePoolKey[], legacy: readonly string[]): void => {
    if (legacy.length === 0) return;
    for (const key of keys) pools[key] = [...(pools[key] ?? []), ...legacy];
  };
  if (theme.manager) {
    if (nonEmpty(theme.manager.name)) state.managerName = foldAscii(theme.manager.name);
    join(BOSS_LEGACY_POOLS, foldLines(theme.manager.lines));
    if (theme.manager.look) state.looks.push({ id: MANAGER_LOOK_ID, spec: theme.manager.look });
  }
  if (theme.receptionist) {
    if (nonEmpty(theme.receptionist.name)) state.receptionistName = foldAscii(theme.receptionist.name);
    join(RECEPTIONIST_LEGACY_POOLS, foldLines(theme.receptionist.lines));
    if (theme.receptionist.look) state.looks.push({ id: RECEPTIONIST_LOOK_ID, spec: theme.receptionist.look });
  }
  state.pools = pools as ThemeState['pools'];
  const smallTalk = foldPairs(theme.smallTalk);
  if (smallTalk.length > 0) state.smallTalk = smallTalk;
  for (const [key, title] of Object.entries(theme.titles ?? {}) as [TitleKey, string | undefined][]) {
    const folded = foldName(title);
    if (folded !== undefined) state.titles[key] = folded;
  }
  for (const key of NPC_KEYS) {
    const name = foldName(theme[key]?.name);
    if (name !== undefined) state.npcs[key] = { name };
    const look = theme[key]?.look;
    if (look) state.looks.push({ id: NPC_LOOK_ID_OF[key], spec: look });
  }
  (theme.staff ?? []).forEach((spec, i) => {
    const slot = staffSlots[i];
    if (slot === undefined) return;
    const info: SlotInfo = {};
    if (nonEmpty(spec.name)) info.name = foldAscii(spec.name);
    if (nonEmpty(spec.role)) info.role = spec.role;
    const lines = foldLines(spec.lines);
    if (lines.length > 0) info.lines = lines;
    if (spec.pin && (nonEmpty(spec.pin.project) || nonEmpty(spec.pin.title))) {
      info.pin = {};
      if (nonEmpty(spec.pin.project)) info.pin.project = spec.pin.project;
      if (nonEmpty(spec.pin.title)) info.pin.title = spec.pin.title;
    }
    state.staff.set(slot, info);
    if (spec.look) state.looks.push({ id: slot, spec: spec.look });
  });
  (theme.temps ?? []).forEach((spec, j) => {
    const slot = tempSlots[j];
    if (slot === undefined) return;
    const info: SlotInfo = {};
    if (nonEmpty(spec.name)) info.name = foldAscii(spec.name);
    state.temps.set(slot, info);
    if (spec.look) state.looks.push({ id: slot, spec: spec.look });
  });
  return state;
}

/** True when the pin names something and the agent matches all of it (case-insensitive substring). No pin is never a match. */
export function pinMatches(pin: SlotInfo['pin'], agent: { project?: string; title?: string }): boolean {
  if (!pin) return false;
  const hasProject = nonEmpty(pin.project);
  const hasTitle = nonEmpty(pin.title);
  if (!hasProject && !hasTitle) return false;
  if (hasProject && !(agent.project ?? '').toLowerCase().includes(pin.project!.toLowerCase())) return false;
  if (hasTitle && !(agent.title ?? '').toLowerCase().includes(pin.title!.toLowerCase())) return false;
  return true;
}

/** True when a pin actually restricts matching (has a project or a title). */
export function hasPin(pin: SlotInfo['pin']): boolean {
  return !!pin && (nonEmpty(pin.project) || nonEmpty(pin.title));
}

/** Theme company, branch and manager name override the matching settings when present. */
export function effectiveSettings(s: OfficeSettings, t: ThemeState): OfficeSettings {
  if (t.companyName === undefined && t.branchName === undefined && t.managerName === undefined) return s;
  return {
    ...s,
    companyName: t.companyName ?? s.companyName,
    branchName: t.branchName ?? s.branchName,
    managerName: t.managerName ?? s.managerName,
  };
}

/** What the theme says about a slot id (staff slots first, then temp slots). */
export function slotInfoOf(t: ThemeState | undefined, slotId: string): SlotInfo | undefined {
  return t?.staff.get(slotId) ?? t?.temps.get(slotId);
}

/** The person's name for a slot, or undefined when the theme gives none. */
export function slotName(t: ThemeState | undefined, slotId: string): string | undefined {
  const n = slotInfoOf(t, slotId)?.name;
  return nonEmpty(n) ? n : undefined;
}

/** The cached source arrays per theme state (a `WeakMap` keyed by the state), so repeated calls return the same references. */
const SOURCES = new WeakMap<ThemeState, Map<string, readonly (readonly unknown[])[]>>();
/** The same for no theme at all: just the built-in pool. */
const BUILT_IN_SOURCES = new Map<string, readonly (readonly unknown[])[]>();

/** One source list per key: `own` in replace mode when it is filled, else the built-in lines plus `own` when there is any. */
function sourcesFor<T>(cache: Map<string, readonly (readonly unknown[])[]>, id: string, builtIn: readonly T[], own: readonly T[] | undefined, mode: LineMode): readonly (readonly T[])[] {
  let sources = cache.get(id) as readonly (readonly T[])[] | undefined;
  if (!sources) {
    sources = !own || own.length === 0 ? [builtIn] : mode === 'replace' ? [own] : [builtIn, own];
    cache.set(id, sources);
  }
  return sources;
}

/**
 * What a pool says its lines from, as the sources for `LiveDeck.next(rng, ...sources)`. Without a theme (or when the theme
 * leaves the pool empty) it is the built-in pool alone; otherwise `add` mixes the theme's lines in and `replace` says only
 * those. The returned array and the arrays in it are stable per theme state, because a `LiveDeck` restarts its round when a
 * source is a different array than last time.
 */
export function lineSources<K extends LinePoolKey>(theme: ThemeState | undefined, key: K): LineSources<K> {
  const builtIn = LINE_POOLS[key] as readonly PoolEntry<K>[];
  if (!theme) return sourcesFor(BUILT_IN_SOURCES, key, builtIn, undefined, 'add');
  let cache = SOURCES.get(theme);
  if (!cache) SOURCES.set(theme, (cache = new Map()));
  return sourcesFor(cache, key, builtIn, theme.pools[key] as readonly PoolEntry<K>[] | undefined, theme.lineMode);
}

/** The same for the water-cooler pairs (`smallTalk`). */
export function smallTalkSources(theme: ThemeState | undefined): readonly (readonly (readonly [string, string])[])[] {
  const cache = theme ? (SOURCES.get(theme) ?? (SOURCES.set(theme, new Map()), SOURCES.get(theme)!)) : BUILT_IN_SOURCES;
  return sourcesFor<readonly [string, string]>(cache, 'smallTalk', SMALL_TALK, theme?.smallTalk, theme?.lineMode ?? 'add');
}

/** A brain context's hook for its single-line pools: the theme's sources for `key`. */
export type LinesHook = (key: StringPoolKey) => LineSources<StringPoolKey>;
/** A brain context's hook for the pairs pools. */
export type PairsHook = (key: PairPoolKey) => LineSources<PairPoolKey>;

/** Resolves a brain's optional `lines` hook: the theme's sources, or the built-in pool alone (hand-built contexts). */
export function poolSources(hook: LinesHook | undefined, key: StringPoolKey): LineSources<StringPoolKey> {
  return hook ? hook(key) : lineSources(undefined, key);
}

/** Resolves a brain's optional `pairs` hook the same way. */
export function pairSources(hook: PairsHook | undefined, key: PairPoolKey): LineSources<PairPoolKey> {
  return hook ? hook(key) : lineSources(undefined, key);
}
