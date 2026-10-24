/**
 * The panel host: the glue that turns the webview's live state into what the drawer's panels need.
 *
 *  - a registry of panels by id (`inbox`, `plans`, `usage`, `directory`, and with Round B enabled `files`, `library`, `phone`,
 *    `handbook` and `agency`; `main.ts` registers the Front desk with `host.register(view, { context })`, and ids nobody
 *    registered are ignored);
 *  - the `PanelContext` every panel gets (`agents`, `usage`, `defaults`, `now`, `post`, `inbox`, `openCase`, `openMemo`),
 *    backed by accessors, so a panel always reads the current value;
 *  - the Directory panel, wired to open panels through the registry and to outline props.
 *
 * `main.ts` owns the DOM (the drawer, the icon bar, the canvas); this file owns what opens and what it is told.
 * Persisting the open panel and the read marks is `main.ts`'s job too (`panelsWiring.ts` has the shapes).
 */
import type { InboxReadStore, MemoPrefill, PanelView } from '../../src/shared/panels.ts';
import type { AgentSnapshot, ClaudeDefaults, UsageSnapshot, WebviewToHost } from '../../src/shared/protocol.ts';
import type { IconId } from '../art/index.ts';
import { createAgencyPanel } from './agencyPanel.ts';
import { createDirectoryPanel } from './directoryPanel.ts';
import { PanelDrawer } from './drawer.ts';
import { h, pixelIcon } from './dom.ts';
import { createFileRoomPanel } from './fileRoomPanel.ts';
import { createHandbookPanel } from './handbookPanel.ts';
import type { DrawerContext } from './drawer.ts';
import { directoryEntries } from './hotspots.ts';
import type { Round } from './hotspots.ts';
import { createInboxPanel } from './inboxPanel.ts';
import { createLibraryPanel } from './libraryPanel.ts';
import { createPhonePanel } from './phonePanel.ts';
import { createPlansPanel } from './plansPanel.ts';
import { isDemoRefusal, propOf } from './panelsWiring.ts';
import type { PropId } from './hotspots.ts';
import type { AgentView } from './targets.ts';
import { createUsagePanel } from './usagePanel.ts';

export interface PanelHostDeps {
  drawer: PanelDrawer;
  /** Every outbound message goes through the webview's one post function. */
  post(msg: WebviewToHost): void;
  /** The worker's look id for portraits (null before one is known). */
  lookOf(agentId: string): string | null;
  /** Current agents (normalised), newest snapshot. */
  agents(): readonly AgentView[];
  usage(): UsageSnapshot | null;
  defaults(): ClaudeDefaults | null;
  /** The host clock (epoch ms; the harness may script it). */
  now(): number;
  inbox: InboxReadStore;
  /** Opens a worker's case file. The drawer suspends itself first, so the case offers "← <panel>" to come back. */
  openCase(agentId: string): void;
  openMemo(prefill?: MemoPrefill): void;
  /** Icon factory (`pixelIcon`). */
  icon(name: string): HTMLElement;
  /** A Directory row (or any panel) points at a prop (outline it) or stopped pointing at it. */
  onPropHover(prop: PropId | null): void;
  /** Which rounds' panels are registered and which entries the Directory lists. Default: Round A only. */
  rounds?: ReadonlySet<Round>;
  /** When set, only panels with these ids register (view mode: the Front desk alone); the rest are skipped. */
  only?: readonly string[];
}

export interface RegisterOptions {
  /** Extends the context for this panel (the Front desk adds `hostTheme`, `preview`, ...). Called each time the panel is opened. */
  context?(base: DrawerContext): DrawerContext;
}

export interface PanelHost {
  /** Makes a panel openable by id: from the icon bar, the Directory, a prop click and the restored state. */
  register(view: PanelView<HTMLElement>, opts?: RegisterOptions): void;
  has(id: string): boolean;
  /** Registered ids. */
  ids(): string[];
  /** The title of a registered panel (for "← In-tray" on the case file), or null. */
  titleOf(id: string | null): string | null;
  /** Opens a registered panel. False when the id is unknown (ignored) or the open panel vetoed leaving. */
  open(id: string): boolean;
  /** The icon bar's behaviour: pressing the open panel's button closes it, any other opens that panel. */
  toggle(id: string): boolean;
  /** The context a panel gets, without the drawer's `push`/`back` (the drawer adds them). */
  context(): DrawerContext;
}

const NOTICE_CSS = `
.co-demo-note { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 28px 10px; text-align: center; overflow-wrap: anywhere;
  color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-demo-note strong { color: var(--vscode-foreground, #cccccc); font-size: 13.5px; }
.co-demo-note canvas { image-rendering: pixelated; flex: none; }
`;
let noticeCss = false;
function injectNoticeCss(): void {
  if (noticeCss) return;
  noticeCss = true;
  const style = document.createElement('style');
  style.textContent = NOTICE_CSS;
  document.head.appendChild(style);
}

/**
 * The demo office has no real folders or Claude Code setup, so the host refuses every Round B request there (with the demo
 * guard's error, carrying the request's `reqId`). The webview has no demo flag, so a Round B panel is wrapped in this: it
 * mounts as usual, and when the refusal comes back it swaps the panel's raw error for a friendly "Not available in the demo"
 * note (and stops forwarding anything to the panel). Turning demo mode off needs nothing: the next mount asks again.
 * `what` completes "<what> ..." in the note, e.g. "The phone shows your real MCP servers."
 */
export function withDemoNotice(view: PanelView<HTMLElement>, what: string): PanelView<HTMLElement> {
  let bodyEl: HTMLElement | null = null;
  let shown = false;
  const showNotice = (): void => {
    if (!bodyEl) return;
    injectNoticeCss();
    shown = true;
    view.unmount?.();
    bodyEl.replaceChildren(h('div', { class: 'co-demo-note', role: 'status', 'data-demo-note': '1' }, pixelIcon(view.icon as IconId, 32),
      h('strong', { text: 'Not available in the demo' }),
      h('span', { text: `${what} The demo office has no real projects or Claude Code setup behind it. Turn demo mode off (Middle Management: Toggle Demo) to use it.` })));
  };
  const wrapped: PanelView<HTMLElement> = {
    id: view.id,
    title: view.title,
    icon: view.icon,
    mount(body, ctx) {
      bodyEl = body;
      shown = false;
      view.mount(body, ctx);
    },
    handle(msg) {
      if (shown) return;
      if (msg.type === 'error' && typeof msg.reqId === 'string' && isDemoRefusal(msg.message)) { showNotice(); return; }
      view.handle?.(msg);
    },
    unmount() {
      if (!shown) view.unmount?.();
      shown = false;
      bodyEl = null;
    },
  };
  if (view.refresh) wrapped.refresh = () => { if (!shown) view.refresh?.(); };
  if (view.beforeClose) wrapped.beforeClose = () => view.beforeClose?.() ?? true;
  return wrapped;
}

/** Builds the host and registers the panels (Round A, and Round B's five tools when `deps.rounds` has B). */
export function createPanelHost(deps: PanelHostDeps): PanelHost {
  const registry = new Map<string, { view: PanelView<HTMLElement>; opts: RegisterOptions }>();
  const { drawer } = deps;

  const base: DrawerContext = {
    post: (msg) => deps.post(msg),
    openCase: (id) => deps.openCase(id),
    openMemo: (opts) => deps.openMemo(opts?.prefill),
    agents: () => deps.agents() as readonly AgentSnapshot[],
    usage: () => deps.usage(),
    defaults: () => deps.defaults(),
    now: () => deps.now(),
    inbox: deps.inbox,
  };

  const host: PanelHost = {
    register(view, opts = {}) {
      if (deps.only && !deps.only.includes(view.id)) return;
      registry.set(view.id, { view, opts });
    },
    has: (id) => registry.has(id),
    ids: () => [...registry.keys()],
    titleOf: (id) => (id ? registry.get(id)?.view.title ?? null : null),
    open(id) {
      const entry = registry.get(id);
      if (!entry) return false;
      return drawer.open(entry.view, entry.opts.context ? entry.opts.context(base) : base);
    },
    toggle(id) {
      if (drawer.currentId() === id) return drawer.close();
      return host.open(id);
    },
    context: () => base,
  };

  host.register(createInboxPanel({ lookOf: deps.lookOf }));
  host.register(createPlansPanel({ lookOf: deps.lookOf }));
  host.register(createUsagePanel());
  if (deps.rounds?.has('B')) {
    host.register(withDemoNotice(createFileRoomPanel(), 'The file room browses the folders of your real projects.'));
    host.register(withDemoNotice(createLibraryPanel(), 'The training library lists your real skills and slash commands.'));
    host.register(withDemoNotice(createPhonePanel(), 'The phone shows your real MCP servers.'));
    host.register(withDemoNotice(createHandbookPanel(), 'The office handbook reads your real CLAUDE.md files, memory and permission rules.'));
    host.register(withDemoNotice(createAgencyPanel(), 'The temp agency lists your real subagent types.'));
  }
  host.register(createDirectoryPanel({
    entries: () => directoryEntries(deps.rounds ?? new Set<Round>(['A'])),
    openPanel: (id) => { host.open(id); },
    icon: deps.icon,
    onHover: (prop) => deps.onPropHover(propOf(prop)),
  }));
  return host;
}

export { routePanelMessage } from './panelsWiring.ts';
