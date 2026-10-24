// Context window sizes. Transcripts record how many tokens a turn used but not how big the window is, so the size is
// learned from an office run when one has reported it, read from a `[1m]` suffix on the model id, or guessed.

/** The window assumed when nothing says otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The window of a `[1m]` model. */
export const LONG_CONTEXT_WINDOW = 1_000_000;

export interface ContextWindow {
  /** Window size in tokens. */
  max: number;
  /** True when `max` is a guess (the 200k default) rather than reported or implied by the model id. */
  approx?: true;
}

const LONG_SUFFIX = /\[1m\]$/i;

function usable(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * The window of `model`.
 *  1. `learned` (model id -> size) wins when a run has reported a size for that exact id, or for the id without its
 *     `[1m]` suffix. The host passes a map it fills from SDK init/result messages (task 2.7).
 *  2. A `[1m]` suffix means 1,000,000.
 *  3. Anything else, including an unknown model, is 200,000 and marked `approx`, unless `observedTokens` is above
 *     200,000: then the window cannot be 200k (transcript model ids carry no `[1m]` suffix, so a 1M session looks like
 *     any other), and the guess becomes 1,000,000, still `approx`.
 */
export function contextWindowFor(model: string | undefined, learned?: ReadonlyMap<string, number>, observedTokens?: number): ContextWindow {
  if (model !== undefined && model !== '') {
    const exact = learned?.get(model);
    if (usable(exact)) return { max: Math.floor(exact) };
    const bare = model.replace(LONG_SUFFIX, '');
    if (bare !== model) {
      const base = learned?.get(bare);
      if (usable(base)) return { max: Math.floor(base) };
      return { max: LONG_CONTEXT_WINDOW };
    }
  }
  if (typeof observedTokens === 'number' && observedTokens > DEFAULT_CONTEXT_WINDOW) return { max: LONG_CONTEXT_WINDOW, approx: true };
  return { max: DEFAULT_CONTEXT_WINDOW, approx: true };
}

/** `tokens` as a whole percentage of `max`, rounded and clamped to 0-100. */
export function contextPercent(tokens: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(tokens)) return 0;
  return Math.min(100, Math.max(0, Math.round((tokens / max) * 100)));
}
