/**
 * The webview's copy of the latest `UpdateInfo` the host sent (`{type:'update'}`).
 *
 * Why a store: the Front desk About tab may open after the message arrived, and the in-office cue reads it too. `panelsWiring`'s
 * `routePanelMessage` calls `setUpdate` for every `update` message before it reaches the bus, so the store is always current.
 * Plain module state (one webview, one store); listeners are called synchronously, in the order they were added.
 */
import type { UpdateInfo } from '../../src/shared/protocol.ts';

let latest: UpdateInfo | undefined;
const listeners = new Set<(u: UpdateInfo) => void>();

/** Keeps `u` as the latest info and tells the listeners. A listener that throws does not stop the others. */
export function setUpdate(u: UpdateInfo): void {
  latest = u;
  for (const l of [...listeners]) {
    try { l(u); } catch { /* a broken listener must not block the rest */ }
  }
}

/** The latest info, or undefined until the first `update` message. */
export function getUpdate(): UpdateInfo | undefined {
  return latest;
}

/** Listens for later `setUpdate` calls (not called for what is already stored). Returns the unsubscribe function. */
export function onUpdate(listener: (u: UpdateInfo) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forgets the info and the listeners (tests only). */
export function resetUpdateStore(): void {
  latest = undefined;
  listeners.clear();
}
