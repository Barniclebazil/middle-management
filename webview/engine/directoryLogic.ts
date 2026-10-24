/** The Directory panel's pure logic (no DOM, so it is tested in Node and compiles under the root tsconfig). */

/** The shape of one entry; matches `DirectoryEntry` in `hotspots.ts` (declared here so the two files stay independent). */
export interface DirectoryEntryLike {
  /** The panel id it opens, or 'newTask' for the memo. */
  panel: string;
  label: string;
  /** The office prop to highlight while the entry is hovered or focused. */
  prop?: string;
  /** Icon name for the factory. */
  icon: string;
  hint: string;
}

/** Entry id used for the memo. */
export const NEW_TASK = 'newTask';

/** A string that changes when the visible entries change (so a refresh with the same entries leaves the DOM, and focus, alone). */
export function entriesKey(entries: readonly DirectoryEntryLike[]): string {
  return entries.map((e) => [e.panel, e.label, e.prop ?? '', e.icon, e.hint].join('\u0001')).join('\u0002');
}
