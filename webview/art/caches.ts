/**
 * One switch for every cache that bakes colours into pixels. Call
 * `invalidateArtCaches()` after `applyOfficeColors` changes `C`; the next
 * `renderBackground()`, `getFurniture()`, sprite or frame request redraws
 * from the new colours. A `Scene` keeps its own background and furniture
 * references, so build a new one afterwards.
 */
import { clearCharacterCache, characterCacheSize } from './characters.ts';
import { clearFurnitureCache, furnitureCacheSize } from './furniture.ts';
import { clearMapCaches, mapCacheState } from './office-map.ts';
import { clearPropCaches, propCacheSize } from './props.ts';
import { clearFoodCartCache } from './foodCart.ts';

/**
 * Clears the background and furniture list (`office-map.ts`), the furniture
 * sprite memo (desks, chairs, walls, and the calendar, in-tray, badge and
 * pile states), the usage-ring and plan-note caches (`props.ts`) and every
 * cached character frame, and the food-cart sprites. Bubble icons and the font use fixed colours and stay.
 */
export function invalidateArtCaches(): void {
  clearMapCaches();
  clearFurnitureCache();
  clearPropCaches();
  clearCharacterCache();
  clearFoodCartCache();
}

/** For tests: what each colour-baking cache currently holds. */
export function artCacheSizes(): { background: number; furnitureList: number; sprites: number; props: number; frames: number } {
  const m = mapCacheState();
  return {
    background: m.background ? 1 : 0,
    furnitureList: m.furniture ? 1 : 0,
    sprites: furnitureCacheSize(),
    props: propCacheSize(),
    frames: characterCacheSize(),
  };
}
