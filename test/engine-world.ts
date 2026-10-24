// Loads the real office map for engine tests. The art modules use DOM types
// (the root tsconfig has none), so they're imported through a computed
// specifier: tsc doesn't follow it, Node runs it fine (the map data itself is
// DOM-free until sprites are requested).
import type { AgentSnapshot } from '../src/shared/protocol.ts';
import type { WorldDef } from '../webview/engine/types.ts';

const ART = new URL('../webview/art/', import.meta.url).href;

export async function loadWorld(): Promise<WorldDef> {
  const mapSpec: string = `${ART}office-map.ts`;
  const looksSpec: string = `${ART}looks.ts`;
  const map = await import(mapSpec);
  const looks = await import(looksSpec);
  return {
    w: map.MAP_W, h: map.MAP_H, tile: map.TILE, grid: map.walkGrid, seats: map.seats, tempSeats: map.tempSeats,
    poi: map.poi, archetypes: looks.ARCHETYPES, tempLooks: looks.TEMP_LOOKS,
    staffSlots: looks.STAFF_SLOT_IDS, tempSlots: looks.TEMP_SLOT_IDS,
  };
}

/** Host clock used by the tests. */
export const HOST0 = 1_800_000_000_000;

/** A main agent snapshot with sensible defaults. */
export function agent(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id, kind: 'main', title: `Session ${id}`, project: 'proj', activity: 'writing', status: 'working',
    since: HOST0 - 5_000, startedAt: HOST0 - 60_000, ...over,
  };
}
