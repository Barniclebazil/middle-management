/** Model tiers (families), best first. TIERS[0] is the top tier (the one that takes over the boss's office), so a future top model only changes this list. */
export const TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ModelTier = typeof TIERS[number];

const ALIAS = /^(fable|opus|sonnet|haiku)(?:\[1m\])?$/;
// A whole -/./-delimited family word inside a claude id; allows an old-style "3-5-" version before it and any provider prefix.
const ID = /(?:^|[^a-z0-9])claude-(?:\d{1,2}-(?:\d{1,2}-)?)?(fable|opus|sonnet|haiku)(?![a-z0-9])/;

/** The family of a model id ("claude-opus-4-6[1m]", "claude-3-5-sonnet-20241022", "sonnet", provider-prefixed ids), or null when missing or unknown. */
export function tierOf(model: string | undefined): ModelTier | null {
  if (!model) return null;
  const m = model.trim().toLowerCase();
  const r = ALIAS.exec(m) ?? ID.exec(m);
  return r ? (r[1] as ModelTier) : null;
}

/**
 * Seating rank: the index in TIERS (0 = best). An unknown model (null) ranks as sonnet, the middle: an agent whose
 * model is not known yet is seated in the middle and moves once its model is known.
 */
export function tierRank(t: ModelTier | null): number {
  return TIERS.indexOf(t ?? 'sonnet');
}

/** Chip colours that read in light and dark themes; white on each background is at least 4.5:1 (WCAG AA). */
export const TIER_COLOURS: Readonly<Record<ModelTier, { bg: string; fg: string }>> = {
  fable: { bg: '#b45309', fg: '#ffffff' },
  opus: { bg: '#6d28d9', fg: '#ffffff' },
  sonnet: { bg: '#1d4ed8', fg: '#ffffff' },
  haiku: { bg: '#15803d', fg: '#ffffff' },
};

/** "Fable", "Opus", "Sonnet" or "Haiku". */
export function tierLabel(t: ModelTier): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
