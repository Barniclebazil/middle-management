/**
 * The real art registry behind `ThemeApplier` (see `themeApply.ts`): colours, caches and look overrides.
 * Kept apart from `themeApply.ts` so that file, and its tests, never import the DOM-bound art modules.
 */
import {
  LOOKS, MANAGER_LOOK, NPC_LOOKS, RECEPTIONIST_LOOK, applyOfficeColors, buildLook, defaultSlotLook, invalidateArtCaches, registerLook,
} from '../art/index.ts';
import type { LookSpec } from '../../src/shared/theme.ts';
import type { ArtPort } from './themeApply.ts';

export const artPort: ArtPort = {
  applyOfficeColors,
  invalidateArtCaches,
  setLook(id: string, spec: LookSpec | undefined): void {
    const npc = NPC_LOOKS[id];
    const base = npc ?? (id === MANAGER_LOOK || id === RECEPTIONIST_LOOK ? LOOKS[id]! : defaultSlotLook(id));
    if (!spec) return registerLook(base);
    const built = buildLook(id, spec, base);
    // `buildLook` drops the NPC-only traits (the cleaner's bucket, Dez's slouch, Fenwick's high waist): they stay.
    if (npc) {
      if (npc.carry) built.carry = npc.carry;
      if (npc.slouch) built.slouch = true;
      if (npc.highWaist) built.highWaist = true;
    }
    registerLook(built);
  },
};
