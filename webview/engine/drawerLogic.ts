/**
 * The panel drawer's pure logic (no DOM, so it is tested in Node and compiles under the root tsconfig): the navigation
 * stack with its `beforeClose` veto rules, the Escape rule, and the width rule shared with the case file.
 */

/** Same values as the case file's exports (`caseFile.ts`); `test/engine-drawer.test.ts` checks they have not drifted. */
export const OVERLAY_BELOW = 700;
export const DRAWER_MIN_W = 320;
export const DRAWER_MAX_W = 640;
export const DRAWER_DEFAULT_W = 400;

/** The office keeps at least this much width when the drawer docks (the same value the case file uses). */
export const OFFICE_MIN_W = 300;
/** Width of the drawer when it overlays the office (narrow panels). */
const OVERLAY_MAX_W = 440;

/** What the stack needs to know about a view (a `PanelView` satisfies it). */
export interface StackView {
  id: string;
  title: string;
  beforeClose?(): boolean;
}

/** Where "← <title>" should lead back to. */
export interface ReturnTarget {
  id: string;
  title: string;
}

/** Asks a view whether it may go away. A view that throws or returns nothing counts as agreeing; only `false` vetoes. */
export function allowsClose(view: StackView | null | undefined): boolean {
  if (!view || typeof view.beforeClose !== 'function') return true;
  try {
    return view.beforeClose() !== false;
  } catch {
    return true;
  }
}

export type OpenResult = 'opened' | 'same' | 'vetoed';
export type PushResult = 'opened' | 'pushed';
export type BackResult = 'popped' | 'closed' | 'vetoed' | 'empty';
export type CloseResult = 'closed' | 'vetoed' | 'empty';

/**
 * The drawer's navigation state: a stack of views, the top one being shown.
 *  - `back` asks only the top view's `beforeClose()` (the view underneath is still there when you come back, with its state).
 *  - `close` and `open` (another panel) throw the whole stack away, so they ask EVERY view, top to root, and stop at the first
 *    veto. That keeps a sub-view without a `beforeClose` (the Front desk's person page at narrow widths) from closing its
 *    root's unsaved edits without a word. On a veto the stack is cut back to the vetoing view, so its prompt can show.
 *  - Pushing a sub-view never asks.
 * `skipVeto` is for a drawer that is hidden (its views could not ask the user anyway).
 */
export class PanelStack<V extends StackView> {
  private items: V[] = [];

  get size(): number {
    return this.items.length;
  }

  top(): V | null {
    return this.items[this.items.length - 1] ?? null;
  }

  /** The view under the top one (what "back" returns to), or null. */
  previous(): V | null {
    return this.items[this.items.length - 2] ?? null;
  }

  /**
   * Index of the first view that vetoes, asking from the top down to `floor` (inclusive); -1 when none does. Stops at the first
   * veto, so the views under it are not asked.
   */
  private vetoAt(floor: number): number {
    for (let i = this.items.length - 1; i >= floor; i--) if (!allowsClose(this.items[i])) return i;
    return -1;
  }

  /** The depth the stack was cut back to by the last veto (the vetoing view is the top), for callers that remount. */
  private cutTo(index: number): void {
    this.items.length = index + 1;
  }

  /**
   * Shows `view` as the only entry. Opening the panel that is already on top changes nothing. Opening the root panel again
   * while sub-views are stacked on it drops just the sub-views (asking them); any other panel replaces the whole stack and
   * asks every view.
   */
  open(view: V, skipVeto = false): OpenResult {
    const top = this.top();
    if (top && top.id === view.id) return 'same';
    if (top && !skipVeto) {
      const floor = this.items[0]?.id === view.id ? 1 : 0;
      const i = this.vetoAt(floor);
      if (i >= 0) {
        this.cutTo(i);
        return 'vetoed';
      }
    }
    this.items = [view];
    return 'opened';
  }

  /** Shows `view` on top of the current one (it becomes the root when nothing is open). */
  push(view: V): PushResult {
    const empty = this.items.length === 0;
    this.items.push(view);
    return empty ? 'opened' : 'pushed';
  }

  /** Pops the top view; closes (empties) the stack when there was only one. */
  back(skipVeto = false): BackResult {
    const top = this.top();
    if (!top) return 'empty';
    if (!skipVeto && !allowsClose(top)) return 'vetoed';
    this.items.pop();
    return this.items.length === 0 ? 'closed' : 'popped';
  }

  /** Empties the stack, asking every view from the top to the root; the first veto stops it and cuts the stack back to that view. */
  close(skipVeto = false): CloseResult {
    if (!this.top()) return 'empty';
    if (!skipVeto) {
      const i = this.vetoAt(0);
      if (i >= 0) {
        this.cutTo(i);
        return 'vetoed';
      }
    }
    this.items = [];
    return 'closed';
  }

  /** The top view as a return target for the case file. */
  returnTarget(): ReturnTarget | null {
    const top = this.top();
    return top ? { id: top.id, title: top.title } : null;
  }
}

/**
 * Escape handling for the drawer step of the order popover → memo → drawer → case. Returns true when Escape was
 * consumed: the drawer was showing, so Escape tried to close it (even if a view vetoed, so the case file does not also
 * close underneath the veto prompt).
 */
export function escapeConsumed(showing: boolean, close: () => unknown): boolean {
  if (!showing) return false;
  close();
  return true;
}

export interface DrawerLayout {
  overlay: boolean;
  /** CSS px. */
  width: number;
}

/** The case file's width rule: overlay below OVERLAY_BELOW, otherwise the saved width kept in range and clear of the office minimum. */
export function drawerLayout(viewportW: number, width: number): DrawerLayout {
  const vw = Math.max(1, viewportW);
  if (vw < OVERLAY_BELOW) return { overlay: true, width: Math.min(vw, Math.max(DRAWER_MIN_W, Math.min(OVERLAY_MAX_W, vw))) };
  const max = Math.max(DRAWER_MIN_W, Math.min(DRAWER_MAX_W, vw - OFFICE_MIN_W));
  return { overlay: false, width: Math.max(DRAWER_MIN_W, Math.min(max, width)) };
}

/** Keeps a saved or dragged width inside the drawer's range. */
export function clampDrawerWidth(w: number): number {
  return Math.max(DRAWER_MIN_W, Math.min(DRAWER_MAX_W, Math.round(Number.isFinite(w) ? w : DRAWER_DEFAULT_W)));
}
