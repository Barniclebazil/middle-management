/**
 * Applies the theme to the webview: the host's settings and theme, with the Front desk's unsaved draft layered
 * over the theme while it is being edited. One `apply()` updates the office colours, the looks of the manager, the
 * receptionist and every staff and temp slot, and the names, roles, lines and pins the engine reads.
 *
 * It replaces `main.ts`'s old `applySettings` (same effect for a host-only theme) and adds the colours, the
 * receptionist and the draft. DOM-free and free of `webview/art/*` imports: the art registry comes in through
 * an `ArtPort` (`themeArt.ts` has the real one), so tests can use a fake.
 */
import type { OfficeSettings } from '../../src/shared/protocol.ts';
import type { LookSpec, OfficeColorKey, OfficeTheme } from '../../src/shared/theme.ts';
import type { Office } from './office.ts';
import { MANAGER_LOOK_ID, NPC_LOOK_ID_OF, RECEPTIONIST_LOOK_ID, effectiveSettings, themeState } from './theme.ts';
import type { ThemeState } from './theme.ts';

/** The art registry as the applier needs it. */
export interface ArtPort {
  /** Sets the office colours (`undefined` restores the built-in office). True when they changed. */
  applyOfficeColors(colors: Partial<Record<OfficeColorKey, string>> | undefined): boolean;
  /** Drops every cache that bakes colours into pixels (after `applyOfficeColors` returned true). */
  invalidateArtCaches(): void;
  /**
   * Registers the look of `id` ('manager', 'receptionist', an NPC look id, 'staff-i' or 'temp-j') from `spec` on top of its
   * built-in look; `undefined` puts the built-in look back. Drops that id's cached frames.
   */
  setLook(id: string, spec: LookSpec | undefined): void;
}

/** The parts of `Office` the applier drives. */
export type ThemeTarget = Pick<Office, 'setTheme' | 'bossQuotes' | 'speechBubbles'>;

export interface ThemeApplierDeps {
  art: ArtPort;
  office: ThemeTarget;
  staffSlots: readonly string[];
  tempSlots: readonly string[];
  /** Settings until the host sends its own. */
  initial?: OfficeSettings;
}

/** What an `apply()` changed. */
export interface ThemeApplyResult {
  /** The office colours changed and the art caches were cleared: the caller must rebuild its `Scene`. */
  artReset: boolean;
  /** Look ids ('manager', 'receptionist', NPC look ids, slot ids) whose look was registered anew (invalidate faces and portraits). */
  looksChanged: string[];
  /** Names, roles, lines, pins, small talk or the effective company, branch and manager name changed. */
  namesChanged: boolean;
}

export const DEFAULT_SETTINGS: OfficeSettings = {
  companyName: 'Middle Management', branchName: 'Riverside Branch', speechBubbles: true, managerName: 'You', bossQuotes: true,
};

/** The theme sections the draft can replace; each present key replaces the host theme's whole section. */
const THEME_KEYS = [
  'name', 'description', 'company', 'branch', 'lineMode', 'titles', 'lines', 'manager', 'receptionist', 'cleaner', 'vendor', 'itFixer', 'itCritic',
  'colors', 'smallTalk', 'staff', 'temps',
] as const;

/** The draft layered over the host theme: every section the draft has (even an empty one) wins, the rest is the host's. */
export function layerTheme(host: OfficeTheme | undefined, draft: OfficeTheme | null): OfficeTheme | undefined {
  if (!draft) return host;
  const out: Record<string, unknown> = { ...(host ?? {}) };
  for (const k of THEME_KEYS) if (draft[k] !== undefined) out[k] = draft[k];
  return out as OfficeTheme;
}

export class ThemeApplier {
  private readonly deps: ThemeApplierDeps;
  private host: OfficeSettings;
  private hostTheme: OfficeTheme | undefined;
  private draft: OfficeTheme | null = null;
  private current: ThemeState;
  private effective: OfficeSettings;
  /** Registered look override per look id, as JSON ('' = the built-in look). */
  private readonly looksKey = new Map<string, string>();
  private namesKey: string | null = null;

  constructor(deps: ThemeApplierDeps) {
    this.deps = deps;
    this.host = deps.initial ?? DEFAULT_SETTINGS;
    this.current = themeState(undefined, deps.staffSlots, deps.tempSlots);
    this.effective = effectiveSettings(this.host, this.current);
  }

  /**
   * The host's settings message. Like every settings message it carries the whole current state, so a missing
   * `theme` means "no theme"; the other fields are merged over what was sent before. Nothing changes until `apply()`.
   */
  setHost(settings: OfficeSettings): void {
    const { theme, ...rest } = settings;
    this.host = { ...this.host, ...rest };
    this.hostTheme = theme;
  }

  /** A Front desk draft over the host theme (`null` reverts to the host theme). Nothing changes until `apply()`. */
  preview(theme: OfficeTheme | null): void {
    this.draft = theme;
  }

  /** True while a draft is layered over the host theme. */
  get previewing(): boolean {
    return this.draft !== null;
  }

  /** What everything reads: the host's settings with the (previewed) theme's company, branch and manager name on top. */
  get settings(): OfficeSettings {
    return this.effective;
  }

  /** The host's settings without the theme's overrides. */
  get hostSettings(): OfficeSettings {
    return this.host;
  }

  /** The theme state in force after the last `apply()`. */
  get state(): ThemeState {
    return this.current;
  }

  /** The host's theme, as the host sent it. */
  get hostThemeValue(): OfficeTheme | undefined {
    return this.hostTheme;
  }

  /** Applies the host theme plus the draft: colours first, then looks, then names and lines. */
  apply(): ThemeApplyResult {
    const { art, office, staffSlots, tempSlots } = this.deps;
    const theme = layerTheme(this.hostTheme, this.draft);
    const state = themeState(theme, staffSlots, tempSlots);
    this.current = state;
    this.effective = effectiveSettings(this.host, state);

    // Colours before looks: the caches the colours clear also hold the look frames.
    let artReset = false;
    if (art.applyOfficeColors(theme?.colors)) {
      art.invalidateArtCaches();
      artReset = true;
    }

    const specs = new Map<string, LookSpec>(state.looks.map((l) => [l.id, l.spec]));
    const looksChanged: string[] = [];
    for (const id of [MANAGER_LOOK_ID, RECEPTIONIST_LOOK_ID, ...Object.values(NPC_LOOK_ID_OF), ...staffSlots, ...tempSlots]) {
      const spec = specs.get(id);
      const key = spec ? JSON.stringify(spec) : '';
      if (key === (this.looksKey.get(id) ?? '')) continue;
      this.looksKey.set(id, key);
      art.setLook(id, spec);
      looksChanged.push(id);
    }

    office.setTheme(state);
    office.bossQuotes = this.effective.bossQuotes !== false;
    office.speechBubbles = this.effective.speechBubbles !== false;

    const namesKey = namesKeyOf(state, this.effective);
    const namesChanged = namesKey !== this.namesKey;
    this.namesKey = namesKey;
    return { artReset, looksChanged, namesChanged };
  }
}

/** Everything about names, roles, lines and pins, as a string to compare (the looks and colours are tracked apart). */
function namesKeyOf(state: ThemeState, settings: OfficeSettings): string {
  return JSON.stringify([
    settings.companyName, settings.branchName, settings.managerName,
    state.receptionistName ?? null, state.lineMode, state.pools, state.smallTalk ?? null, state.titles, state.npcs,
    [...state.staff], [...state.temps],
  ]);
}
