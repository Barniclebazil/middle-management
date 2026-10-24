import type { AgentSnapshot, ClaudeDefaults, FrontDeskTab, HostToWebview, OfficeSettings, SessionOptions, UsageSnapshot, WebviewToHost } from './protocol.ts';
import type { OfficeTheme } from './theme.ts';

export type { FrontDeskTab };

/**
 * The webview panel interface (Round A). Types only, and DOM-free: this file compiles under both tsconfigs (the root
 * one has no DOM lib). The `Body` type parameter stands for the element a panel mounts into; the webview instantiates it
 * with `HTMLElement` (`PanelView<HTMLElement>`), tests and the host can leave it as `unknown`.
 *
 * Panels are built in parallel by separate tasks and only talk to the rest of the webview through `PanelContext`.
 * See docs/manager-mode.md section 14.
 */

/** Prefill for the new-task memo (`PanelContext.openMemo`). Every field is optional. */
export interface MemoPrefill {
  /** Task text, e.g. '/skill-name ' or a file path. */
  prompt?: string;
  /** Absolute project path to preselect. */
  projectPath?: string;
  /** Assign to this existing free session instead of hiring a new worker. */
  sessionId?: string;
  /** Preselected model, effort and approvals. */
  options?: SessionOptions;
}

/**
 * The read store behind the in-tray's read/unread state. Keys are stable item ids (for example
 * `report:<agentId>:<at>`). In v0.3 it is per webview view and kept in the webview's saved state; it may move to host
 * storage later without changing this interface.
 */
export interface InboxReadStore {
  /** Epoch ms when the key was marked read, or undefined when unread. */
  readAt(key: string): number | undefined;
  markRead(key: string, at?: number): void;
  markUnread(key: string): void;
  /** A copy of every read mark. */
  all(): Readonly<Record<string, number>>;
  /** Called after any change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** What the drawer hands to a panel. Data accessors are functions so a panel always reads the current value. */
export interface PanelContext<Body = unknown> {
  /** Send a message to the host (it is validated by `parseWebviewMessage` there). */
  post(msg: WebviewToHost): void;
  /** Open an agent's case file. If a panel is open, the case drawer shows "← <panel title>" to return. */
  openCase(agentId: string): void;
  /** Open the new-task memo, optionally prefilled. */
  openMemo(opts?: { prefill?: MemoPrefill }): void;
  /** Show another panel on top of this one; `back()` returns here. */
  push(view: PanelView<Body>): void;
  /** Pop to the previous panel; closes the drawer when the stack is empty. */
  back(): void;
  /** Current agents, newest snapshot. */
  agents(): readonly AgentSnapshot[];
  /** Latest usage, or null before the host has sent one. */
  usage(): UsageSnapshot | null;
  /** Latest Claude Code defaults and model list, or null before the host has sent them. */
  defaults(): ClaudeDefaults | null;
  /** The current time in epoch ms (injectable, so tests and the harness can fake it). */
  now(): number;
  /** In-tray read marks. */
  inbox: InboxReadStore;
}

/** One drawer panel. Created once; `mount` may be called again after `unmount`. */
export interface PanelView<Body = unknown> {
  /** Stable id: 'inbox', 'plans', 'usage', 'directory' and later others. */
  id: string;
  /** Title for the drawer header, the icon bar tooltip and the back button. */
  title: string;
  /** Name of the 8x8 pixel icon in the icon registry. */
  icon: string;
  /** Build the panel's content inside `body`. Use text nodes only. */
  mount(body: Body, ctx: PanelContext<Body>): void;
  /** Called when `agents`, `usage`, `defaults` or the inbox read marks change while mounted. */
  refresh?(): void;
  /** Called for every host message while mounted (for example `planText`, `turn`, or an `error` with a `reqId`). */
  handle?(msg: HostToWebview): void;
  /** Remove listeners and timers. The drawer clears `body` afterwards. */
  unmount?(): void;
  /**
   * Called before the drawer closes or switches panel. Return false to veto (the panel then asks the user, for example
   * "Keep editing / Discard", and closes the drawer itself). Added for the Front desk panel (see `FrontDeskCtx` and
   * docs/manager-mode.md section 17); the drawer shell (task 3.3) honours it.
   */
  beforeClose?(): boolean;
}

/**
 * What the Front desk panel gets: the usual `PanelContext` plus access to the live office theme and settings and a way to
 * preview an unsaved theme. Built by the webview's `main.ts` (task 4.7); the panel (tasks 3.10 and 3.11) uses only this.
 */
export interface FrontDeskCtx<Body = unknown> extends PanelContext<Body> {
  /** The theme the host last sent (the saved theme, without any preview), or null for the built-in office. */
  hostTheme(): OfficeTheme | null;
  /** The settings the host last sent, or null before the first `settings` message. */
  hostSettings(): OfficeSettings | null;
  /**
   * Show a draft theme in the office at once (layered over the host's settings), or `null` to go back to the host's theme.
   * Nothing is written; only Save does that.
   */
  preview(theme: OfficeTheme | null): void;
  /**
   * Listen to host messages the Front desk cares about (`frontDesk`, `frontDeskDone`, `settings`, `openFrontDesk`),
   * also when the panel is not the one receiving `handle`. Returns the unsubscribe function.
   */
  onHost(listener: (msg: HostToWebview) => void): () => void;
}
