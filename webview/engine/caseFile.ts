/**
 * The case file: one worker's conversation, any request they are knocking
 * about, and a reply box. Two layouts:
 *
 * - `drawer` (the office): docks on the right (the office re-fits into the
 *   rest) or overlays the office when the panel is narrow.
 * - `page` (a case tab, v0.5): fills its own editor tab like the Claude Code
 *   chat. A header across the top, the conversation in a centred reading
 *   column with the knock card inline at its end, and the reply box (Send and
 *   Stop) pinned at the bottom. It never closes itself: Escape only closes a
 *   popover, and the tab is bound to one worker for its whole life.
 *
 * Everything from the host or a transcript is rendered with text nodes.
 */
import { LIMITS } from '../../src/shared/protocol.ts';
import type {
  CaseAddress, CaseClosedReason, CaseHeader, ClaudeDefaults, ConversationItem, DecisionPayload, HostToWebview, PendingRequest, QuestionSpec, WebviewToHost,
} from '../../src/shared/protocol.ts';
import type { IconId } from '../art/index.ts';
import type { AgentView } from './targets.ts';
import {
  allowDecision, alwaysCaption, answerDecision, answersReady, applyPending, caseErrorTarget, clockTime, controlBadge, denyDecision, emptyPick, footerMode,
  formatCost, mergeHeader, mergeItems, pageFocusTarget, pendingPlanItemId, permissionTitle, planDecision, planItemView, shortPath, statusLine, toggleOther,
  togglePick, toolIcon, workingLine,
} from './caseLogic.ts';
import type { FooterMode, QuestionPick } from './caseLogic.ts';
import { autoGrow, branchChip, button, h, isSendKey, pixelIcon, portrait, renderMarkdown, sendKeyLabel, sprite } from './dom.ts';
import {
  FLASH_MS, applyError, applyReply, chipMenu, choiceOptions, emptyTracker, errorText, headerChips, optionsMessage, requestKey, trackRequest,
} from './optionsLogic.ts';
import type { ChipKey, ChipView, OptionsTracker } from './optionsLogic.ts';
import { closePopover, isPopoverOpen, popoverAnchor, togglePopover } from './popover.ts';
import { PENDING_WORDS } from './tooltip.ts';
import { injectUiStyles } from './uiStyles.ts';

/** Below this panel width the drawer overlays the office instead of docking. */
export const OVERLAY_BELOW = 700;
export const DRAWER_MIN_W = 320;
export const DRAWER_MAX_W = 640;
export const DRAWER_DEFAULT_W = 400;
/** The office keeps at least this much width when the drawer docks. */
const OFFICE_MIN_W = 300;

/** Where the case file lives: the office's drawer, or a whole case tab. */
export type CaseLayout = 'drawer' | 'page';

export interface CaseDeps {
  post(msg: WebviewToHost): void;
  /** Latest snapshot of an agent (null once gone). */
  agent(id: string): AgentView | null;
  /** Character look for portraits. */
  lookOf(id: string): string | null;
  managerName(): string;
  /** "+ New task" in the header. Without it (a case tab, which may not send `newTask`) the button is not shown. */
  openMemo?(fromAgentId: string | null): void;
  /** The docked width changed (open, close, resize, overlay switch). Drawer only. */
  layoutChanged?(): void;
  /** `drawer` (default) or `page` (a case tab). The rest of the drawer-only deps are ignored in a page. */
  layout?: CaseLayout;
  /** Initial and persisted drawer width. */
  width?: number;
  saveWidth?(w: number): void;
  /** The user's Claude Code defaults, when known (else the drawer uses the last `claudeDefaults` it handled). */
  defaults?(): ClaudeDefaults | null;
  /** True while something above the case file should take Escape first (an open memo or panel): the case file then lets the key bubble to the central handler. */
  escapeFirst?(): boolean;
  /** The case file closed (any way: ×, Escape, the worker leaving, the back button). */
  onClosed?(): void;
  /** Where focus goes when the case file closes with nothing to return to (opened by a click in the office), instead of <body>. */
  fallbackFocus?(): void;
}

/** Where the case file's "← In-tray" button leads: opened from a panel, it offers the way back. */
export interface CaseBack { label: string; onBack(): void }

function newNonce(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const NEAR_BOTTOM_PX = 28;

export class CaseFile {
  readonly el: HTMLElement;
  private readonly deps: CaseDeps;
  private agentId: string | null = null;
  private header: CaseHeader | null = null;
  private items: ConversationItem[] = [];
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly expanded = new Set<string>();
  private pending: PendingRequest | null = null;
  private pendingShownId: string | null = null;
  private sentFor: string | null = null;
  private truncated = false;
  private loaded = false;
  private closed: CaseClosedReason | null = null;
  /** The host refused to open this file (unknown worker, demo mode…): shown instead of the loading note. */
  private loadError: string | null = null;
  private width: number;
  private overlay = false;
  private viewportW = 1;
  private focusCard = false;
  private footerKey = '';
  private readonly drafts = new Map<string, string>();
  private returnFocus: Element | null = null;
  /** Last snapshot and look seen for the open agent: a temp that has just left still reads as a temp. */
  private lastSeen: AgentView | null = null;
  private lastLook: string | null = null;
  /** "← In-tray" (a case opened from a panel). */
  private backTarget: CaseBack | null = null;
  private readonly backBtn: HTMLButtonElement;
  /** A case tab (`layout: 'page'`) rather than the office drawer. */
  private readonly page: boolean;
  /** The element that scrolls the conversation: the body in the drawer, the whole thread (conversation and card) in a page. */
  private readonly scroller: HTMLElement;
  /** Where the footer's content goes: the footer itself in the drawer, a slot in the pinned dock in a page. */
  private readonly footerSlot: HTMLElement;
  /** "Running a command…" above the reply box (page only). */
  private readonly workingEl: HTMLElement | null;
  /** The page has placed its first focus (the card or the reply box) for this file. */
  private pageFocused = false;

  // Fixed parts
  private readonly face: HTMLCanvasElement;
  private readonly titleEl: HTMLDivElement;
  private readonly metaEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly actionsEl: HTMLDivElement;
  private readonly mainEl: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly pill: HTMLButtonElement;
  private readonly pendingEl: HTMLDivElement;
  private readonly errorEl: HTMLDivElement;
  private errorTimer = 0;
  private readonly footer: HTMLDivElement;
  /** Screen-reader announcements (sent, queued, new replies). */
  private readonly live: HTMLDivElement;
  private textarea: HTMLTextAreaElement | null = null;
  private headKey = '';
  // Model / effort / approvals chips
  private readonly optsEl: HTMLDivElement;
  private readonly optsHint: HTMLDivElement;
  private optsKey = '';
  private optsDirty = false;
  private optsTimer = 0;
  private tracker: OptionsTracker = emptyTracker();
  private lastDefaults: ClaudeDefaults | null = null;
  /** When the header's `next` last changed (see ChipInput.nextAt). */
  private nextAt = 0;

  constructor(parent: HTMLElement, deps: CaseDeps) {
    injectUiStyles();
    this.deps = deps;
    this.page = deps.layout === 'page';
    this.width = clampWidth(deps.width ?? DRAWER_DEFAULT_W);
    this.el = this.page
      ? h('main', { class: 'co-case co-ui co-page', 'aria-label': 'Case file', tabindex: '-1' })
      : h('aside', { class: 'co-case co-ui', role: 'complementary', 'aria-label': 'Case file', tabindex: '-1' });
    this.el.hidden = true;

    this.face = portrait(null, this.page ? 40 : 44, 'co-head-face');
    this.titleEl = h('div', { class: 'co-head-title', role: 'heading', 'aria-level': '2' });
    this.metaEl = h('div', { class: 'co-head-meta' });
    this.statusEl = h('div', { class: 'co-head-status' });
    this.actionsEl = h('div', { class: 'co-head-actions' });
    this.optsEl = h('div', { class: 'co-head-opts', role: 'group', 'aria-label': 'Model, effort and approvals' });
    this.optsHint = h('div', { class: 'co-opt-hint', id: 'co-opt-hint' });
    this.optsHint.hidden = true;
    this.backBtn = button('', 'co-btn co-secondary co-small co-case-back', () => this.backTarget?.onBack(), { title: 'Back to the panel' });
    this.backBtn.hidden = true;
    const headTop = h('div', { class: 'co-head-top' }, this.face, h('div', { class: 'co-head-text' }, this.titleEl, this.metaEl, this.statusEl));

    this.body = h('div', { class: 'co-case-body', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off' });
    this.pill = button('↓ New', 'co-btn co-primary co-small co-new-pill', () => this.scrollToEnd(true), { title: 'Jump to the latest', 'aria-label': 'New messages below: jump to the latest' });
    this.pill.hidden = true;

    this.pendingEl = h('section', { class: 'co-pending', 'aria-live': 'polite', tabindex: '-1' }) as HTMLDivElement;
    this.pendingEl.hidden = true;
    this.errorEl = h('div', { class: 'co-banner co-inline-err', role: 'alert' }) as HTMLDivElement;
    this.errorEl.hidden = true;
    this.footer = h('div', { class: 'co-footer' });
    this.live = h('div', { class: 'co-sr', role: 'status', 'aria-live': 'polite' });

    if (this.page) {
      // A case tab: header, a scrolling thread (conversation, then the knock card) in a centred column, the reply box pinned below.
      const head = h('header', { class: 'co-case-head' }, h('div', { class: 'co-page-col co-page-head' }, headTop, this.actionsEl, this.optsEl, this.optsHint));
      this.scroller = h('div', { class: 'co-page-scroll' }, h('div', { class: 'co-page-col co-page-thread' }, this.body, this.pendingEl));
      this.mainEl = h('div', { class: 'co-case-main' }, this.scroller, this.pill);
      this.workingEl = h('div', { class: 'co-page-working', 'aria-hidden': 'true' });
      this.workingEl.hidden = true;
      this.footerSlot = h('div', { class: 'co-page-slot' });
      this.footer.classList.add('co-page-dock');
      this.footer.appendChild(h('div', { class: 'co-page-col' }, this.errorEl, this.workingEl, this.footerSlot));
      this.el.append(head, this.mainEl, this.footer, this.live);
    } else {
      const handle = h('div', { class: 'co-resize', title: 'Drag to resize', 'aria-hidden': 'true' });
      this.wireResize(handle);
      const close = button('×', 'co-icon-btn', () => this.close(), { 'aria-label': 'Close case file (Esc)', title: 'Close (Esc)' });
      const head = h('header', { class: 'co-case-head' }, this.backBtn, headTop, this.optsEl, this.optsHint, this.actionsEl, close);
      this.scroller = this.body;
      this.mainEl = h('div', { class: 'co-case-main' }, this.body, this.pill);
      this.workingEl = null;
      this.footerSlot = this.footer;
      this.el.append(handle, head, this.mainEl, this.errorEl, this.pendingEl, this.footer, this.live);
      this.el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !this.deps.escapeFirst?.()) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
      });
    }
    this.scroller.addEventListener('scroll', () => { if (this.nearBottom()) this.pill.hidden = true; }, { passive: true });
    parent.appendChild(this.el);
  }

  /** Agent id of the open case, or null. */
  get openId(): string | null {
    return this.agentId;
  }

  /** Width the office should leave free on the right (0 when closed or overlaying). */
  get dockWidth(): number {
    return this.agentId && !this.overlay && !this.page ? this.width : 0;
  }

  /** What this case knows about its own address, for `forAnotherCase` (a case tab claims host messages with it). */
  address(): CaseAddress | null {
    if (!this.agentId) return null;
    const out: CaseAddress = { agentId: this.agentId };
    const sid = this.view()?.sessionId;
    if (sid) out.sessionId = sid;
    if (this.pending) out.requestId = this.pending.requestId;
    return out;
  }

  /** Tells the drawer how wide the whole webview is. */
  setViewport(w: number): void {
    this.viewportW = Math.max(1, w);
    if (this.page) return; // a case tab fills its tab at any width; the CSS does the rest
    const overlay = w < OVERLAY_BELOW;
    const changed = overlay !== this.overlay;
    this.overlay = overlay;
    this.applyWidth();
    if (changed) this.deps.layoutChanged?.();
  }

  /** Opens an agent's case file (or, if it is already open, just brings the card into view). */
  open(agentId: string, opts: { focusPending?: boolean; back?: CaseBack | null } = {}): void {
    this.setBack(this.page ? null : opts.back ?? null);
    if (this.agentId === agentId) {
      if (opts.focusPending) this.revealCard();
      return;
    }
    if (!this.agentId) this.returnFocus = document.activeElement;
    this.saveDraft();
    this.reset();
    this.agentId = agentId;
    this.focusCard = opts.focusPending === true;
    this.el.hidden = false;
    this.applyWidth();
    this.renderHeader();
    this.renderBody();
    this.renderPending();
    this.renderFooter(true);
    this.deps.post({ type: 'openCase', agentId });
    this.deps.layoutChanged?.();
    // Focus the drawer itself (not the reply box): opening a file to read it shouldn't grab typing. A page moves focus on to the
    // card or the reply box once the file is in (applyPageFocus).
    this.el.focus({ preventScroll: true });
  }

  /** Asks the host for the open file again (a case tab's "Try again" after a refusal or a read error). */
  reload(): void {
    if (!this.agentId) return;
    this.loadError = null;
    this.closed = this.closed === 'agentGone' ? 'agentGone' : null;
    this.renderBody();
    this.renderFooter();
    this.deps.post({ type: 'openCase', agentId: this.agentId });
  }

  /** Closes the drawer and tells the host to stop streaming. A case tab never closes itself (the host owns its tab). */
  close(): void {
    if (!this.agentId || this.page) return;
    if (this.ownsPopover()) closePopover(false);
    this.saveDraft();
    this.deps.post({ type: 'closeCase' });
    this.reset();
    this.setBack(null);
    this.el.hidden = true;
    this.deps.layoutChanged?.();
    this.deps.onClosed?.();
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
    // Focus left on <body>, or still on a control inside the now hidden element (the browser only moves it later).
    else if (document.activeElement === null || document.activeElement === document.body || this.el.contains(document.activeElement)) this.deps.fallbackFocus?.();
  }

  private setBack(back: CaseBack | null): void {
    this.backTarget = back;
    this.backBtn.hidden = !back;
    this.backBtn.textContent = back ? back.label : '';
    if (back) this.backBtn.setAttribute('aria-label', back.label.replace(/^←\s*/, 'Back to '));
    else this.backBtn.removeAttribute('aria-label');
  }

  /** Handles a host message; returns true if it was for the drawer. */
  handle(msg: HostToWebview): boolean {
    switch (msg.type) {
      case 'caseFile': {
        if (msg.agentId !== this.agentId) return true;
        const wasNear = this.nearBottom();
        this.header = msg.header;
        this.items = mergeItems([], Array.isArray(msg.items) ? msg.items : []).items;
        this.truncated = msg.truncated === true;
        this.loaded = true;
        this.closed = null;
        this.loadError = null;
        this.setPending(msg.pending ?? null);
        this.renderHeader();
        this.renderBody();
        this.renderFooter();
        if (wasNear || this.items.length) this.scrollToEnd(true);
        if (this.focusCard && this.pending) this.revealCard();
        this.focusCard = false;
        this.applyPageFocus();
        return true;
      }
      case 'caseAppend': {
        if (msg.agentId !== this.agentId) return true;
        const wasNear = this.nearBottom();
        if (msg.header && this.header) {
          if (msg.header.next !== undefined) this.nextAt = Date.now();
          this.header = mergeHeader(this.header, msg.header);
        }
        if (Array.isArray(msg.items) && msg.items.length) {
          const r = mergeItems(this.items, msg.items);
          this.items = r.items;
          if (!this.loaded) {
            this.renderBody();
          } else {
            for (const id of r.dropped) { this.nodes.get(id)?.remove(); this.nodes.delete(id); }
            if (r.dropped.length) this.truncated = true;
            for (const id of r.replaced) this.replaceNode(id);
            for (const id of r.added) this.appendNode(id);
            if ([...r.added, ...r.replaced].some((id) => this.items.find((x) => x.id === id)?.kind === 'plan')) this.syncPlans();
            if (r.added.some((id) => this.items.find((x) => x.id === id)?.kind === 'assistant')) this.announce(`${this.view()?.title ?? 'They'} replied`);
          }
          if (wasNear) this.scrollToEnd(false);
          else if (r.added.length || r.replaced.length) this.pill.hidden = false;
        }
        if ('pending' in msg && msg.pending !== undefined) this.setPending(applyPending(this.pending, msg.pending));
        this.renderHeader();
        this.renderFooter();
        return true;
      }
      case 'claudeDefaults': {
        this.lastDefaults = msg.defaults && typeof msg.defaults === 'object' ? msg.defaults : null;
        this.renderChips();
        return false; // the memo wants it too
      }
      case 'sessionOptions': {
        const r = applyReply(this.tracker, msg, Date.now());
        if (!r.matched) return false;
        this.tracker = r.tracker;
        this.renderChips();
        this.flashLater();
        const req = r.tracker.requests.find((x) => x.nonce === msg.nonce);
        if (req?.status === 'deferred') this.announce('Saved for their next message');
        else if (req?.status === 'applied') this.announce(msg.applied && Object.keys(msg.applied).length ? 'Changed' : 'No change needed');
        return true;
      }
      case 'caseClosed': {
        if (msg.agentId !== this.agentId || msg.reason === 'replaced') return true;
        this.closed = msg.reason;
        this.setPending(null);
        // The header too (task 10.1): it kept saying "Idle" with live option chips above "They've left the office".
        this.renderHeader();
        this.renderChips();
        this.renderBody();
        this.renderFooter();
        // A page whose focus was on a control that just went (the reply box, the card): keep the keyboard in the tab.
        if (this.page && (document.activeElement === null || document.activeElement === document.body)) this.el.focus({ preventScroll: true });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Shows a host error inline when it belongs to the open case (same session or same pending request).
   * Returns false when it does not, so the caller can fall back to the toast.
   */
  showError(msg: Extract<HostToWebview, { type: 'error' }>): boolean {
    // A refused setSessionOptions: say so next to the chips (and go read-only if Claude Code is too old).
    if (msg.nonce !== undefined) {
      const key = requestKey(this.tracker, msg.nonce);
      const r = applyError(this.tracker, msg, Date.now());
      if (r.matched) {
        this.tracker = r.tracker;
        this.renderChips();
        this.flashLater();
        if (!this.agentId) return true;
        const text = String(msg.message ?? 'Something went wrong.').slice(0, LIMITS.errorChars);
        this.errorEl.textContent = r.outdated ? `${errorText(key, text)} The chips are read-only until you update Claude Code.` : errorText(key, text);
        this.errorEl.hidden = false;
        window.clearTimeout(this.errorTimer);
        this.errorTimer = window.setTimeout(() => { this.errorEl.hidden = true; }, 10000);
        return true;
      }
    }
    if (!this.agentId) return false;
    // Since v0.5 an `agentId` decides first: another worker's error is never ours, ours always is. Without one: still waiting for
    // the file and the host says no (unknown worker, demo mode…) means "couldn't open"; otherwise it must match the session or request.
    const target = caseErrorTarget(msg, {
      agentId: this.agentId, loaded: this.loaded, sessionId: this.header?.sessionId, liveSessionId: this.view()?.sessionId, requestId: this.pending?.requestId,
    });
    if (target === 'other') return false;
    if (target === 'load') {
      this.loadError = String(msg.message ?? 'Something went wrong.').slice(0, LIMITS.errorChars);
      this.renderBody();
      this.renderFooter();
      return true;
    }
    this.errorEl.textContent = String(msg.message ?? 'Something went wrong.').slice(0, LIMITS.errorChars);
    this.errorEl.hidden = false;
    window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => { this.errorEl.hidden = true; }, 10000);
    // A refused decision leaves the request pending: let the user try again.
    if (msg.requestId !== undefined && this.pending?.requestId === msg.requestId && this.sentFor === msg.requestId) {
      this.sentFor = null;
      this.renderPending();
    }
    return true;
  }

  /** Keeps the header in step with the live agent snapshot (cheap; call on every agents message). */
  refresh(): void {
    if (!this.agentId) return;
    this.renderHeader();
    this.renderFooter();
  }

  /** The theme changed someone's look: repaint the portrait even though the look id is the same. */
  refreshLooks(): void {
    delete this.face.dataset['look'];
    this.headKey = '';
    this.refresh();
  }

  /** True when the open popover hangs from one of this drawer's chips. */
  private ownsPopover(): boolean {
    const a = popoverAnchor();
    return !!a && this.el.contains(a);
  }

  // -------------------------------------------------------------------------
  // Layout

  private applyWidth(): void {
    if (this.page) return;
    const s = this.el.style;
    if (this.overlay) {
      s.width = `${Math.min(this.viewportW, Math.max(DRAWER_MIN_W, Math.min(440, this.viewportW)))}px`;
    } else {
      const max = Math.max(DRAWER_MIN_W, Math.min(DRAWER_MAX_W, this.viewportW - OFFICE_MIN_W));
      this.width = Math.max(DRAWER_MIN_W, Math.min(max, this.width));
      s.width = `${this.width}px`;
    }
    this.el.classList.toggle('overlay', this.overlay);
  }

  private wireResize(handle: HTMLElement): void {
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (this.overlay || e.button !== 0) return;
      dragging = true;
      handle.classList.add('drag');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.width = clampWidth(this.viewportW - e.clientX);
      this.applyWidth();
      this.deps.layoutChanged?.();
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('drag');
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      this.deps.saveWidth?.(this.width);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------------------------
  // Header

  /** The open agent's live snapshot, else the last one seen. */
  private agentNow(): AgentView | null {
    if (!this.agentId) return null;
    const a = this.deps.agent(this.agentId);
    if (a) this.lastSeen = a;
    return a ?? this.lastSeen;
  }

  private lookNow(): string | null {
    if (!this.agentId) return null;
    const l = this.deps.lookOf(this.agentId);
    if (l) this.lastLook = l;
    return l ?? this.lastLook;
  }

  /** The header to show: the host's, else one made up from the live snapshot while loading. */
  private view(): CaseHeader | null {
    const a = this.agentNow();
    if (this.header) {
      // The live snapshot is fresher for what they're doing right now.
      return a ? { ...this.header, activity: a.activity, status: a.status } : this.header;
    }
    if (!a || !this.agentId) return null;
    const hdr: CaseHeader = {
      agentId: this.agentId, title: a.title, project: a.project, activity: a.activity, status: a.status,
      control: a.control ?? 'none',
    };
    if (a.sessionId) hdr.sessionId = a.sessionId;
    if (a.cwd) hdr.cwd = a.cwd;
    if (a.gitBranch) hdr.gitBranch = a.gitBranch;
    if (a.costUsd !== undefined) hdr.costUsd = a.costUsd;
    return hdr;
  }

  private renderHeader(): void {
    const v = this.view();
    const a = this.agentNow();
    const look = this.lookNow();
    const knocking = !!this.pending || a?.activity === 'needsYou';
    const key = JSON.stringify([v, look, knocking, this.closed]);
    if (key === this.headKey) return;
    this.headKey = key;
    if (look && this.face.dataset['look'] !== look) {
      this.face.dataset['look'] = look;
      const fresh = portrait(look, 44, 'co-head-face');
      this.face.getContext('2d')?.clearRect(0, 0, this.face.width, this.face.height);
      this.face.getContext('2d')?.drawImage(fresh, 0, 0);
    }
    if (!v) {
      this.titleEl.textContent = 'Case file';
      this.metaEl.replaceChildren();
      this.statusEl.textContent = '';
      this.actionsEl.replaceChildren();
      this.renderWorking(null);
      return;
    }
    this.titleEl.textContent = v.title;
    this.titleEl.title = v.title;
    const project = h('span', { class: 'co-head-project', text: v.project || shortPath(v.cwd) || 'Unknown project', title: v.cwd ?? v.project });
    const badge = controlBadge(v.control);
    // Never seen in the office (it left before the file opened): the host's control 'none' means a temp.
    const isTemp = a ? a.kind === 'temp' : v.control === 'none';
    this.metaEl.replaceChildren(
      project,
      branchChip(v.gitBranch) ?? '',
      badge ? h('span', { class: 'co-chip co-ctl', title: badge.title }, sprite(badge.icon, 1), ` ${badge.label}`) : '',
      isTemp ? h('span', { class: 'co-chip co-ctl', text: 'temp', title: 'A subagent working for another session' }) : '',
    );
    const chipsShown = this.loaded && !!this.header;
    let status = statusLine(v, !chipsShown);
    if (isTemp && v.status === 'done') status = status.replace('Gone for the day', 'Finished, heading out');
    if (this.pending) status = `Knocking: ${PENDING_WORDS[this.pending.kind]}`;
    else if (this.closed === 'agentGone') status = 'Left the office';
    this.statusEl.replaceChildren(h('span', { class: 'co-dot' }), status);
    this.statusEl.className = 'co-head-status';
    if (knocking && !this.closed) this.statusEl.classList.add('needs');
    else if (v.busy || (v.status === 'working' && v.activity !== 'idle')) this.statusEl.classList.add('busy');

    this.renderWorking(this.closed ? null : workingLine(v, knocking));

    const actions: Node[] = [];
    // A page has Stop next to Send in the pinned reply box instead.
    if (!this.page && v.control === 'office' && v.busy && v.sessionId && !this.closed) {
      const sid = v.sessionId;
      actions.push(button([h('span', { 'aria-hidden': 'true', text: '■' }), h('span', { class: 'co-long', text: 'Stop' })], 'co-btn co-danger co-small', () => this.deps.post({ type: 'interrupt', sessionId: sid }), {
        title: 'Stop: interrupt the current step (the session stays open; you can reply after)', 'aria-label': 'Stop',
      }));
    }
    if (v.sessionId && !isTemp) {
      const sid = v.sessionId;
      actions.push(button(h('span', null, h('span', { class: 'co-long', text: 'Open in ' }), 'Claude Code', h('span', { class: 'co-ext', 'aria-hidden': 'true', text: ' ↗' })), 'co-btn co-secondary co-small', () => this.deps.post({ type: 'openInClaudeCode', sessionId: sid }), {
        title: 'Open this session in the Claude Code panel', 'aria-label': 'Open in Claude Code',
      }));
    }
    const openMemo = this.page ? undefined : this.deps.openMemo;
    if (openMemo) {
      actions.push(button(h('span', null, '+ ', h('span', { class: 'co-long', text: 'New ' }), 'task'), 'co-btn co-ghost co-small', () => openMemo(this.agentId), {
        title: `Write a new assignment memo for ${v.project || 'this project'}`, 'aria-label': 'New task',
      }));
    }
    this.actionsEl.replaceChildren(...actions);
    this.renderChips();
  }

  /** The "Running a command…" line above a page's reply box (null hides it). */
  private renderWorking(text: string | null): void {
    const el = this.workingEl;
    if (!el) return;
    el.hidden = text === null;
    if (text === null) { el.replaceChildren(); return; }
    if (el.dataset['text'] === text && el.childElementCount) return;
    el.dataset['text'] = text;
    el.replaceChildren(h('span', { class: 'co-dots' }, h('i'), h('i'), h('i')), h('span', { text }));
  }

  // -------------------------------------------------------------------------
  // Model, effort and approvals chips

  private defaults(): ClaudeDefaults | null {
    return this.deps.defaults?.() ?? this.lastDefaults;
  }

  /** Re-renders the chips after the "just changed" marks run out. */
  private flashLater(): void {
    window.clearTimeout(this.optsTimer);
    this.optsTimer = window.setTimeout(() => this.renderChips(), FLASH_MS + 60);
  }

  private chipInput(): Parameters<typeof headerChips>[0] | null {
    const v = this.view();
    if (!v || !this.loaded || !this.header || this.closed === 'agentGone') return null;
    const a = this.agentNow();
    return { header: v, defaults: this.defaults(), tracker: this.tracker, now: Date.now(), nextAt: this.nextAt, isTemp: a ? a.kind === 'temp' : v.control === 'none' };
  }

  private renderChips(): void {
    const input = this.chipInput();
    if (!input) {
      if (this.ownsPopover()) closePopover(false);
      this.optsEl.replaceChildren();
      this.optsHint.hidden = true;
      this.optsKey = '';
      return;
    }
    const chips = headerChips(input);
    const key = JSON.stringify(chips);
    if (key === this.optsKey) return;
    // Don't pull the anchor out from under an open menu; redraw when it closes.
    if (isPopoverOpen() && this.ownsPopover()) { this.optsDirty = true; return; }
    this.optsKey = key;
    this.optsDirty = false;
    const focused = this.optsEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['opt'] : undefined;
    this.optsEl.replaceChildren(...chips.map((c) => this.chip(c)));
    this.optsHint.hidden = true;
    if (focused) this.optsEl.querySelector<HTMLElement>(`[data-opt="${focused}"]`)?.focus({ preventScroll: true });
  }

  private chip(c: ChipView): HTMLButtonElement {
    const mark = c.status === 'pending' ? h('span', { class: 'co-dots co-optchip-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
      : c.status === 'applied' ? h('span', { class: 'co-optchip-mark ok', 'aria-hidden': 'true', text: '✓' })
        : c.status === 'failed' ? h('span', { class: 'co-optchip-mark err', 'aria-hidden': 'true', text: '!' }) : null;
    const said = c.status === 'pending' ? ', changing' : c.status === 'applied' ? ', changed' : c.status === 'deferred' ? ', saved for their next message' : c.status === 'failed' ? ', not changed' : '';
    const b = h('button', {
      type: 'button', class: `co-optchip ${c.mode}${c.editable ? '' : ' ro'}${c.status ? ` ${c.status}` : ''}`, 'data-opt': c.key,
      'aria-label': `${c.label}: ${c.value}${c.next ? `, ${c.next}` : ''}${said}`,
    },
    h('span', { class: 'co-optchip-k', text: c.label }), h('span', { class: 'co-optchip-v', text: c.value }),
    c.next ? h('span', { class: 'co-optchip-next', text: c.next }) : null,
    mark,
    c.editable ? h('span', { class: 'co-optchip-caret', 'aria-hidden': 'true', text: '▾' }) : (c.mode === 'readonly' || c.mode === 'outdated') ? sprite('lock', 1) : null);
    if (c.editable) {
      b.title = c.hint;
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', () => this.openChipMenu(c.key, b));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.openChipMenu(c.key, b); }
      });
    } else {
      // Read-only: the hint shows under the chips on hover or focus (and on click, for touch).
      b.setAttribute('aria-disabled', 'true');
      b.setAttribute('aria-describedby', 'co-opt-hint');
      const show = (): void => { this.optsHint.textContent = c.hint; this.optsHint.hidden = false; };
      const hide = (): void => { if (!b.matches(':focus-visible')) this.optsHint.hidden = true; };
      b.addEventListener('mouseenter', show);
      b.addEventListener('focus', show);
      b.addEventListener('click', show);
      b.addEventListener('mouseleave', hide);
      b.addEventListener('blur', () => { this.optsHint.hidden = true; });
    }
    return b;
  }

  private openChipMenu(key: ChipKey, anchor: HTMLButtonElement): void {
    const input = this.chipInput();
    if (!input) return;
    const menu = chipMenu(key, input);
    togglePopover({
      anchor, label: menu.title, note: menu.note,
      items: menu.items.map((m) => ({ id: m.id, label: m.label, detail: m.detail, checked: m.checked, disabled: m.disabled, meter: m.meter })),
      onSelect: (id) => this.setOption(key, id),
      onClose: () => { if (this.optsDirty) this.renderChips(); },
    });
  }

  private setOption(key: ChipKey, id: string): void {
    const v = this.view();
    const sid = v?.sessionId;
    const options = choiceOptions(key, id);
    if (!v || !sid || !options) return;
    const msg = optionsMessage(sid, options, newNonce());
    this.tracker = trackRequest(this.tracker, msg, Date.now(), v);
    this.errorEl.hidden = true;
    this.deps.post(msg);
    this.renderChips();
  }

  // -------------------------------------------------------------------------
  // Conversation

  private renderBody(): void {
    this.nodes.clear();
    const kids: Node[] = [];
    if (this.closed === 'agentGone') kids.push(h('div', { class: 'co-banner', text: 'They’ve left the office. This file is read-only now.' }));
    if (this.closed === 'error') {
      kids.push(this.page
        ? h('div', { class: 'co-banner' }, h('span', { text: 'Couldn’t read their file. ' }), button('Try again', 'co-link', () => this.reload()))
        : h('div', { class: 'co-banner', text: 'Couldn’t read their file. Try closing and opening it again.' }));
    }
    if (!this.loaded) {
      kids.push(this.loadError
        ? h('div', { class: 'co-empty co-load-err', role: 'alert' }, pixelIcon('alert', 30), h('strong', { text: 'Couldn’t open this file.' }), h('span', { class: 'co-empty-detail', text: this.loadError }),
          this.page ? button('Try again', 'co-btn co-secondary co-small', () => this.reload(), { title: 'Ask for their file again' }) : null)
        : h('div', { class: 'co-empty', role: 'status' }, pixelIcon('folder', 30), 'Pulling their file from the cabinet…'));
      this.body.replaceChildren(...kids);
      return;
    }
    if (this.truncated) {
      const v = this.view();
      const a = this.agentNow();
      const sid = v?.sessionId;
      kids.push(h('div', { class: 'co-earlier' }, h('span', { text: 'Older messages aren’t shown here.' }),
        sid && a?.kind !== 'temp' ? button('See the full history in Claude Code', 'co-link', () => this.deps.post({ type: 'openInClaudeCode', sessionId: sid })) : null));
    }
    if (!this.items.length) kids.push(h('div', { class: 'co-empty' }, pixelIcon('page', 30), 'Nothing in this file yet.'));
    for (const it of this.items) {
      const n = this.renderItem(it);
      this.nodes.set(it.id, n);
      kids.push(n);
    }
    this.body.replaceChildren(...kids);
  }

  private replaceNode(id: string): void {
    const it = this.items.find((x) => x.id === id);
    const old = this.nodes.get(id);
    if (!it || !old) return;
    const n = this.renderItem(it);
    old.replaceWith(n);
    this.nodes.set(id, n);
  }

  private appendNode(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    this.body.querySelector(':scope > .co-empty')?.remove();
    const n = this.renderItem(it);
    this.nodes.set(id, n);
    this.body.appendChild(n);
  }

  private renderItem(it: ConversationItem): HTMLElement {
    switch (it.kind) {
      case 'prompt': {
        const time = clockTime(it.at);
        return h('div', { class: 'co-item' },
          h('div', { class: 'co-slip' },
            h('div', { class: 'co-slip-kicker' }, h('span', { text: 'Memo' }), time ? h('span', { text: time }) : null),
            h('div', { class: 'co-slip-text', text: it.text }),
            it.truncated ? h('div', { class: 'co-cut', text: '(cut short)' }) : null,
            h('div', { class: 'co-slip-sign', text: `\u2014 ${this.signature()}` })));
      }
      case 'assistant': {
        const md = h('div', { class: 'co-md' });
        md.appendChild(renderMarkdown(it.text));
        return h('div', { class: `co-item co-reply${it.streaming ? ' co-streaming' : ''}` }, md,
          it.truncated ? h('div', { class: 'co-cut', text: '…the rest was too long to show here' }) : null);
      }
      case 'tool': return this.renderTool(it);
      case 'plan': return this.renderPlan(it);
      case 'thinking': return h('div', { class: 'co-item' }, h('span', { class: 'co-thinking', text: '…thinking' }));
      case 'notice': {
        let text = it.text;
        if (it.notice === 'cost' && it.costUsd !== undefined) text = `This turn: ${formatCost(it.costUsd)}`;
        if (it.notice === 'interrupted') text = `⏹ ${it.text || 'Interrupted'}`;
        return h('div', { class: `co-item co-notice ${it.notice}`, role: it.notice === 'error' ? 'alert' : null }, h('span', { text }));
      }
      default:
        return h('div', { class: 'co-item' });
    }
  }

  private renderPlan(it: Extract<ConversationItem, { kind: 'plan' }>): HTMLElement {
    const isPendingCard = this.pending?.kind === 'plan' && !this.closed && pendingPlanItemId(this.items) === it.id;
    const v = planItemView(it, isPendingCard);
    const time = clockTime(it.at);
    const open = v.folded ? this.expanded.has(it.id) : true;
    const paper = h('div', { class: `co-plan-paper co-md co-planitem-paper${open ? '' : ' folded'}`, tabindex: '0', 'aria-label': `Plan: ${v.badge.label}` });
    paper.appendChild(renderMarkdown(it.text));
    const wrap = h('div', { class: `co-item co-planitem ${v.badge.tone}`, 'data-status': it.status },
      h('div', { class: 'co-planitem-head' },
        pixelIcon('clipboard', 14), h('span', { class: 'co-planitem-kicker', text: 'Plan' }),
        time ? h('span', { class: 'co-planitem-time', text: time }) : null,
        h('span', { class: `co-badge ${v.badge.tone}`, text: v.badge.label, title: v.badge.title })),
      paper);
    if (v.folded) {
      const more = button(open ? 'Show less' : 'Read the whole plan', 'co-link co-plan-more', () => {
        const now = !this.expanded.has(it.id);
        if (now) this.expanded.add(it.id);
        else this.expanded.delete(it.id);
        paper.classList.toggle('folded', !now);
        more.textContent = now ? 'Show less' : 'Read the whole plan';
        more.setAttribute('aria-expanded', String(now));
      }, { 'aria-expanded': String(open) });
      wrap.appendChild(more);
    }
    if (v.cutNote) wrap.appendChild(h('div', { class: 'co-cut', text: v.cutNote, title: it.planFilePath ?? null }));
    if (v.feedback) wrap.appendChild(h('div', { class: 'co-plan-fb' }, h('span', { class: 'co-plan-fb-k', text: 'Your notes' }), h('span', { class: 'co-plan-fb-v', text: v.feedback })));
    if (v.signOffBelow) wrap.appendChild(h('div', { class: 'co-plan-signoff' }, button('Approve it or send it back below ↓', 'co-link', () => this.revealCard())));
    return wrap;
  }

  /** Plan items and the plan card depend on each other (who carries the full text); bring both up to date. */
  private syncPlans(): void {
    for (const it of this.items) if (it.kind === 'plan') this.replaceNode(it.id);
    const card = this.pendingEl.querySelector('.co-card.co-plan-card');
    if (card) card.classList.toggle('compact', pendingPlanItemId(this.items) !== null);
  }

  /** Who signed the memos in this file: you, or for a temp, the session that hired them. */
  private signature(): string {
    const a = this.agentNow();
    if (a?.kind === 'temp') return (a.parentId ? this.deps.agent(a.parentId)?.title : null) ?? 'their boss';
    return this.deps.managerName();
  }

  private renderTool(it: Extract<ConversationItem, { kind: 'tool' }>): HTMLElement {
    const open = this.expanded.has(it.id);
    const expandable = !!(it.input || it.output);
    const wrap = h('div', { class: `co-item co-tool ${it.state}${it.parentToolUseId ? ' sub' : ''}${open && expandable ? ' open' : ''}` });
    let state: Node | string = '';
    if (it.state === 'running') state = h('span', { class: 'co-dots', title: 'Running', 'aria-label': 'running' }, h('i'), h('i'), h('i'));
    else if (it.state === 'error') state = h('span', { class: 'co-tag', text: 'error' });
    else if (it.state === 'denied') state = h('span', { class: 'co-tag', text: 'denied' });
    const head = h('button', {
      type: 'button', class: 'co-tool-head', 'aria-expanded': expandable ? String(open) : null, 'aria-disabled': expandable ? null : 'true',
      title: `${it.name}: ${it.summary}`,
    }, pixelIcon(toolIcon(it.name) as IconId, 18), h('span', { class: 'co-tool-sum', text: it.summary || it.name }), h('span', { class: 'co-tool-state' }, state),
    expandable ? h('span', { class: 'co-tool-chev', 'aria-hidden': 'true', text: '▶' }) : null);
    wrap.appendChild(head);
    if (!expandable) return wrap;
    const detail = h('div', { class: 'co-tool-detail' });
    detail.hidden = !open;
    if (it.input) detail.append(h('div', { class: 'co-tool-label', text: 'Input' }), h('pre', { class: 'co-pre', text: it.input }));
    if (it.output) detail.append(h('div', { class: 'co-tool-label', text: it.state === 'error' ? 'Error' : 'Output' }), h('pre', { class: 'co-pre out', text: it.output }));
    wrap.appendChild(detail);
    head.addEventListener('click', () => {
      const now = !this.expanded.has(it.id);
      if (now) this.expanded.add(it.id);
      else this.expanded.delete(it.id);
      detail.hidden = !now;
      head.setAttribute('aria-expanded', String(now));
      wrap.classList.toggle('open', now);
    });
    return wrap;
  }

  private nearBottom(): boolean {
    const b = this.scroller;
    return b.scrollHeight - b.scrollTop - b.clientHeight < NEAR_BOTTOM_PX;
  }

  private scrollToEnd(hidePill: boolean): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    if (hidePill) this.pill.hidden = true;
  }

  /**
   * A page's first focus once the file is in: the knock card when someone is knocking, else the reply box when they can be
   * written to, else the page (see pageFocusTarget). Only once per file, and never away from something the user picked.
   */
  private applyPageFocus(): void {
    if (!this.page || this.pageFocused || !this.loaded) return;
    this.pageFocused = true;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== this.el && a !== document.body && this.el.contains(a)) return;
    const target = pageFocusTarget({
      knocking: !!this.pending && !this.closed, footer: this.mode().kind, canSend: !!this.view()?.sessionId, closed: this.closed === 'agentGone', loadError: !!this.loadError,
    });
    if (target === 'card') this.revealCard();
    else if (target === 'reply' && this.textarea) this.textarea.focus({ preventScroll: true });
    else this.el.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Pending card

  private setPending(p: PendingRequest | null): void {
    const prev = this.pending?.requestId ?? null;
    this.pending = p;
    if ((p?.requestId ?? null) !== prev && p) this.sentFor = null;
    this.renderPending();
    if ((p?.requestId ?? null) !== prev && this.loaded) this.syncPlans();
  }

  private revealCard(): void {
    if (this.pendingEl.hidden) return;
    if (this.page) this.scrollCardIntoView();
    else this.pendingEl.scrollTop = 0;
    this.pendingEl.focus({ preventScroll: true });
    this.pendingEl.classList.remove('flash');
    void this.pendingEl.offsetWidth;
    this.pendingEl.classList.add('flash');
  }

  private renderPending(): void {
    const p = this.closed ? null : this.pending;
    if (!this.page) {
      // A short panel hides the conversation behind the card (display: none loses the scroll
      // position); when the card goes, show the latest again.
      const backToEnd = !p && this.mainEl.classList.contains('squeezed') && (this.nearBottom() || this.mainEl.offsetParent === null);
      this.mainEl.classList.toggle('squeezed', !!p);
      if (backToEnd) this.scrollToEnd(true);
    }
    this.el.classList.toggle('knocking', !!p);
    if (!p) {
      // A page whose focus was on the card (or dropped to <body> when its buttons were disabled after a decision): back to the reply box.
      const a = document.activeElement;
      const refocus = this.page && this.pendingShownId !== null && (a === null || a === document.body || this.pendingEl.contains(a));
      this.pendingShownId = null;
      this.pendingEl.hidden = true;
      this.pendingEl.replaceChildren();
      if (refocus) (this.textarea ?? this.el).focus({ preventScroll: true });
      return;
    }
    if (p.requestId === this.pendingShownId) return;
    const fresh = this.pendingShownId === null;
    this.pendingShownId = p.requestId;
    let card: HTMLElement;
    if (p.kind === 'permission') card = this.permissionCard(p);
    else if (p.kind === 'question') card = this.questionCard(p);
    else card = this.planCard(p);
    this.pendingEl.replaceChildren(card);
    this.pendingEl.setAttribute('aria-label', p.kind === 'permission' ? 'Approval request' : p.kind === 'question' ? 'Question' : 'Plan for sign-off');
    const wasNear = this.page && this.nearBottom();
    this.pendingEl.hidden = false;
    // In a page the card is the end of the thread: follow it when the reader was at the end.
    if (wasNear && this.loaded) this.scrollCardIntoView();
    if (this.sentFor === p.requestId) this.markSent();
    else if (!fresh || this.loaded) {
      this.pendingEl.classList.remove('flash');
      void this.pendingEl.offsetWidth;
      this.pendingEl.classList.add('flash');
    }
  }

  /** Page only: shows the inline card, its top first when it is taller than the thread's window, else down to its buttons. */
  private scrollCardIntoView(): void {
    const sc = this.scroller;
    const cardTop = this.pendingEl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    if (this.pendingEl.offsetHeight > sc.clientHeight - 24) sc.scrollTop = Math.max(0, cardTop - 12);
    else this.scrollToEnd(true);
  }

  private knock(kind: string): HTMLElement {
    return h('div', { class: 'co-knock' }, pixelIcon('alert', 14), `Knock knock · ${kind}`);
  }

  private decide(decision: DecisionPayload): void {
    const p = this.pending;
    if (!p || this.sentFor === p.requestId) return;
    this.deps.post({ type: 'decide', requestId: p.requestId, decision });
    this.sentFor = p.requestId;
    this.markSent();
  }

  /** Disables the card after a decision until the host clears or replaces the request. */
  private markSent(): void {
    for (const el of Array.from(this.pendingEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>('button, textarea, input'))) el.disabled = true;
    if (!this.pendingEl.querySelector('.co-sent')) {
      (this.pendingEl.querySelector('.co-card-foot') ?? this.pendingEl.firstElementChild)?.appendChild(h('div', { class: 'co-sent', role: 'status' },
        h('span', { class: 'co-dots' }, h('i'), h('i'), h('i')), 'Sent. Waiting for them to carry on…'));
    }
  }

  private permissionCard(p: Extract<PendingRequest, { kind: 'permission' }>): HTMLElement {
    const card = h('div', { class: 'co-card' }, this.knock(p.toolName || 'Permission'), h('div', { class: 'co-card-title', text: permissionTitle(p.toolName, p.summary) }));
    const fields = p.fields.slice(0, LIMITS.fields);
    const old = fields.find((f) => f.label === 'Old');
    const neu = fields.find((f) => f.label === 'New');
    const list = h('dl', { class: 'co-fields' });
    for (const f of fields) {
      if (old && neu && (f === old || f === neu)) continue;
      list.append(h('dt', { text: f.label }), h('dd', null, f.code ? h('pre', { class: 'co-pre', text: f.value }) : f.value));
    }
    if (list.childElementCount) card.appendChild(list);
    if (old && neu) {
      card.appendChild(h('div', { class: 'co-diff' },
        h('div', { class: 'co-diff-label', text: 'Replace this…' }), h('pre', { class: 'co-pre old', text: old.value }),
        h('div', { class: 'co-diff-label', text: '…with this' }), h('pre', { class: 'co-pre new', text: neu.value })));
    }
    if (p.reason) card.appendChild(h('div', { class: 'co-reason', text: `Why they’re asking: ${p.reason}` }));

    const actions = h('div', { class: 'co-actions' });
    const approve = button('Approve', 'co-btn co-primary', () => this.decide(allowDecision()), { title: 'Let them do it this once' });
    actions.appendChild(approve);
    let caption: HTMLElement | null = null;
    if (p.canAlwaysAllow) {
      const label = p.alwaysLabel || 'Always allow';
      actions.appendChild(button('Always allow', 'co-btn co-secondary', () => this.decide(allowDecision(true)), { title: label, 'aria-describedby': `co-always-${p.requestId}` }));
      caption = h('div', { class: 'co-caption', id: `co-always-${p.requestId}`, text: alwaysCaption(label) });
    }
    const why = h('textarea', { class: 'co-textarea', rows: '2', maxlength: String(LIMITS.feedbackChars), placeholder: 'Tell them why (optional) — they’ll read this', 'aria-label': 'Reason for denying' });
    const denyBox = h('div', { class: 'co-feedback' }, why,
      h('div', { class: 'co-actions' },
        button('Deny', 'co-btn co-danger', () => this.decide(denyDecision(why.value)), { title: `Send the denial (${sendKeyLabel()})` }),
        button('Back', 'co-btn co-ghost', () => showDeny(false))));
    // The deny box replaces the buttons (and the "Always allow" caption, which no longer applies).
    const showDeny = (on: boolean): void => {
      denyBox.hidden = !on;
      actions.hidden = on;
      if (caption) caption.hidden = on;
      if (on) why.focus();
      else denyBtn.focus(); // back to the button that opened the box, never onto Approve (a stray Enter would approve)
    };
    denyBox.hidden = true;
    why.addEventListener('keydown', (e) => {
      if (isSendKey(e)) { e.preventDefault(); this.decide(denyDecision(why.value)); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showDeny(false); }
    });
    const denyBtn = button('Deny…', 'co-btn co-danger', () => showDeny(true), { title: 'Say no (you can add a reason)' });
    actions.appendChild(denyBtn);
    card.appendChild(h('div', { class: 'co-card-foot' }, actions, denyBox, caption));
    return card;
  }

  private questionCard(p: Extract<PendingRequest, { kind: 'question' }>): HTMLElement {
    const qs = p.questions.slice(0, LIMITS.questions);
    const picks: QuestionPick[] = qs.map(() => emptyPick());
    const card = h('div', { class: 'co-card' }, this.knock(qs.length > 1 ? `${qs.length} questions` : 'Question'));
    const send = button('Send answer', 'co-btn co-primary', () => {
      if (answersReady(qs, picks)) this.decide(answerDecision(qs, picks));
    }, { title: `Send your answer (${sendKeyLabel()})` });
    const hint = h('span', { class: 'co-hint' });
    const update = (): void => {
      const ready = answersReady(qs, picks);
      send.disabled = !ready || this.sentFor === p.requestId;
      hint.textContent = ready ? '' : qs.length > 1 ? 'Answer every question to send' : 'Pick an answer to send';
    };
    qs.forEach((q, qi) => card.appendChild(this.questionBlock(q, qi, p.requestId, picks, update)));
    card.addEventListener('keydown', (e) => {
      if (isSendKey(e) && answersReady(qs, picks)) { e.preventDefault(); this.decide(answerDecision(qs, picks)); }
    });
    const skip = button('Skip question', 'co-btn co-ghost co-small', () => this.decide(denyDecision()), { title: 'Decline to answer; the worker carries on without it' });
    card.appendChild(h('div', { class: 'co-card-foot' }, h('div', { class: 'co-actions' }, send, skip, hint)));
    update();
    return card;
  }

  private questionBlock(q: QuestionSpec, qi: number, rid: string, picks: QuestionPick[], changed: () => void): HTMLElement {
    const role = q.multiSelect ? 'checkbox' : 'radio';
    const group = h('div', { class: 'co-opts', role: q.multiSelect ? 'group' : 'radiogroup', 'aria-labelledby': `co-q-${rid}-${qi}` });
    const optButtons: { btn: HTMLButtonElement; label: string }[] = [];
    const otherInput = h('input', { class: 'co-input co-other-input', type: 'text', maxlength: String(LIMITS.feedbackChars), placeholder: 'Type your own answer', 'aria-label': 'Your own answer' });
    const otherBtn = h('button', { type: 'button', class: 'co-opt', role, 'aria-checked': 'false' },
      h('span', { class: `co-mark ${q.multiSelect ? 'check' : 'radio'}` }), h('span', { class: 'co-opt-label', text: 'Other…' }),
      h('span', { class: 'co-opt-desc', text: 'Write your own answer' }));
    const otherWrap = h('div', { class: 'co-opt-preview' }, otherInput);
    otherWrap.hidden = true;
    const sync = (): void => {
      const pk = picks[qi]!;
      for (const o of optButtons) o.btn.setAttribute('aria-checked', String(pk.labels.includes(o.label)));
      otherBtn.setAttribute('aria-checked', String(pk.otherOn));
      otherWrap.hidden = !pk.otherOn;
      changed();
    };
    for (const opt of q.options.slice(0, LIMITS.options)) {
      const btn = h('button', { type: 'button', class: 'co-opt', role, 'aria-checked': 'false' },
        h('span', { class: `co-mark ${q.multiSelect ? 'check' : 'radio'}` }), h('span', { class: 'co-opt-label', text: opt.label }),
        opt.description ? h('span', { class: 'co-opt-desc', text: opt.description }) : null,
        opt.preview ? h('pre', { class: 'co-pre co-opt-preview', text: opt.preview }) : null);
      btn.addEventListener('click', () => { picks[qi] = togglePick(q, picks[qi]!, opt.label); sync(); });
      optButtons.push({ btn, label: opt.label });
      group.appendChild(btn);
    }
    otherBtn.addEventListener('click', () => {
      picks[qi] = toggleOther(q, picks[qi]!);
      sync();
      if (picks[qi]!.otherOn) otherInput.focus();
    });
    otherInput.addEventListener('input', () => { picks[qi] = { ...picks[qi]!, otherText: otherInput.value }; changed(); });
    group.append(otherBtn, otherWrap);
    return h('div', { class: 'co-q' },
      h('div', { class: 'co-q-head' },
        q.header ? h('span', { class: 'co-q-chip', text: q.header }) : null,
        h('span', { class: 'co-q-text', id: `co-q-${rid}-${qi}`, text: q.question }),
        h('span', { class: 'co-q-hint', text: q.multiSelect ? 'Pick any' : 'Pick one' })),
      group);
  }

  private planCard(p: Extract<PendingRequest, { kind: 'plan' }>): HTMLElement {
    const paper = h('div', { class: 'co-plan-paper co-md', tabindex: '0', 'aria-label': 'The plan' });
    paper.appendChild(renderMarkdown(p.plan));
    // When the plan is in the history above, the card skips the full text (except on short panels, where the history is hidden).
    const above = button('Read it above ↑', 'co-link co-plan-above', () => {
      const id = pendingPlanItemId(this.items);
      const node = id ? this.nodes.get(id) : undefined;
      if (!node) return;
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      node.querySelector<HTMLElement>('.co-planitem-paper')?.focus({ preventScroll: true });
    });
    const card = h('div', { class: `co-card co-plan-card${pendingPlanItemId(this.items) ? ' compact' : ''}` }, this.knock('Plan'),
      h('div', { class: 'co-card-title' }, h('span', { text: 'Here’s the plan. Sign off? ' }), above), paper);
    if (p.planFilePath) card.appendChild(h('div', { class: 'co-plan-path', text: `Saved to ${shortPath(p.planFilePath)}`, title: p.planFilePath }));
    const fb = h('textarea', { class: 'co-textarea', rows: '2', maxlength: String(LIMITS.feedbackChars), placeholder: 'What should they change? (optional)', 'aria-label': 'Feedback on the plan' });
    const actions = h('div', { class: 'co-actions' });
    const approve = button('Approve plan', 'co-btn co-primary', () => this.decide(planDecision(true)), { title: 'They leave plan mode and start making changes' });
    const back = (): void => { box.hidden = true; actions.hidden = false; keep.focus(); }; // not Approve: a stray Enter would approve
    const box = h('div', { class: 'co-feedback' }, fb, h('div', { class: 'co-actions' },
      button('Send feedback', 'co-btn co-primary', () => this.decide(planDecision(false, fb.value)), { title: `They keep planning with your notes (${sendKeyLabel()})` }),
      button('Back', 'co-btn co-ghost', back)));
    box.hidden = true;
    fb.addEventListener('keydown', (e) => {
      if (isSendKey(e)) { e.preventDefault(); this.decide(planDecision(false, fb.value)); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); }
    });
    const keep = button('Keep planning…', 'co-btn co-secondary', () => { actions.hidden = true; box.hidden = false; fb.focus(); }, { title: 'Send it back with notes' });
    actions.append(approve, keep);
    card.appendChild(h('div', { class: 'co-card-foot' }, actions, box, h('div', { class: 'co-caption', text: 'Approving lets them leave plan mode and start making changes.' })));
    return card;
  }

  // -------------------------------------------------------------------------
  // Footer

  private mode(): FooterMode {
    if (this.closed === 'agentGone') return { kind: 'closed', text: 'They’ve left the office.' };
    const v = this.view();
    const a = this.agentNow();
    const parentId = a?.parentId ?? null;
    const parent = parentId ? this.deps.agent(parentId) : null;
    return footerMode(v, parent?.title ?? null, parent ? parentId : null, a ? a.kind === 'temp' : true);
  }

  private renderFooter(force = false): void {
    const m = this.mode();
    const v = this.view();
    const knocking = !!this.pending && !this.closed;
    const canStop = this.page && v?.control === 'office' && v.busy === true && !this.closed;
    const key = JSON.stringify([m, v?.sessionId ?? '', this.loaded, knocking, this.loadError, canStop]);
    if (!force && key === this.footerKey) return;
    this.saveDraft();
    // A page lives in its reply box: when the box is rebuilt (they started or stopped working), typing carries on in the new one.
    const typing = this.page && !!this.textarea && document.activeElement === this.textarea
      ? { start: this.textarea.selectionStart, end: this.textarea.selectionEnd } : null;
    this.footerKey = key;
    this.textarea = null;
    const kids: Node[] = [];
    if (this.loadError) {
      kids.push(h('div', { class: 'co-footer-note' }, h('span', { text: 'Nothing to reply to here.' })));
    } else if (m.kind === 'reply') {
      // While someone is knocking the card is the main event; the reply box stays, smaller.
      const ta = h('textarea', { class: 'co-textarea', rows: knocking ? '1' : '2', maxlength: String(LIMITS.promptChars), placeholder: knocking ? 'Or reply instead\u2026' : m.placeholder, 'aria-label': m.label === 'Continue in office' ? 'Message to continue this session' : 'Reply' });
      ta.value = (this.agentId && this.drafts.get(this.agentId)) || '';
      const sid = v?.sessionId;
      const send = (): void => {
        const text = ta.value;
        if (!text.trim() || !sid) return;
        this.deps.post({ type: 'reply', sessionId: sid, text: text.slice(0, LIMITS.promptChars) });
        ta.value = '';
        if (this.agentId) this.drafts.delete(this.agentId);
        autoGrow(ta);
        sendBtn.disabled = true;
        this.scrollToEnd(true);
        const said = m.label === 'Queue' ? 'Queued. They’ll read it when they finish this step.' : m.label === 'Continue in office' ? 'Sent. Picking the session back up…' : 'Sent.';
        hint.textContent = said;
        hint.classList.add('sent');
        this.announce(said);
      };
      const sendBtn = button([m.label, h('span', { class: 'co-kbd', text: sendKeyLabel() })], 'co-btn co-primary', send, {
        title: m.label === 'Continue in office' ? 'Resume this session in the office with your message' : m.queued ? 'Queue your note for after the current step' : 'Send your reply',
      });
      sendBtn.disabled = !ta.value.trim() || !sid;
      const maxPx = this.page ? Math.max(180, Math.round(window.innerHeight * 0.4)) : 180;
      ta.addEventListener('input', () => {
        sendBtn.disabled = !ta.value.trim() || !sid;
        autoGrow(ta, maxPx);
        if (hint.classList.contains('sent')) { hint.classList.remove('sent'); hint.textContent = hintText; }
      });
      ta.addEventListener('keydown', (e) => { if (isSendKey(e)) { e.preventDefault(); send(); } });
      const hintText = m.hint ?? (sid ? `${this.deps.managerName()} → ${v?.title ?? 'them'}` : 'Waiting for their session id…');
      const hint = h('span', { class: `co-hint${m.queued ? ' queued' : ''}`, text: hintText });
      if (this.page) {
        // The Claude Code-style composer: one rounded box holding the text and a bar with the hint, Stop and Send.
        const stop = canStop && sid
          ? button([h('span', { class: 'co-stop-sq', 'aria-hidden': 'true' }), 'Stop'], 'co-btn co-secondary co-stop', () => this.deps.post({ type: 'interrupt', sessionId: sid }), {
            title: 'Stop: interrupt the current step (the session stays open; you can reply after)', 'aria-label': 'Stop',
          })
          : null;
        const bar = h('div', { class: 'co-composer-bar' }, hint, h('div', { class: 'co-composer-actions' }, stop, sendBtn));
        const box = h('div', { class: `co-composer${knocking ? ' knocking' : ''}` }, ta, bar);
        // A click on the box's padding or bar (not a button) puts the caret in the text, as in a chat input.
        box.addEventListener('mousedown', (e) => {
          if (e.target === box || e.target === bar) { e.preventDefault(); ta.focus(); }
        });
        kids.push(box);
      } else {
        kids.push(ta, h('div', { class: 'co-footer-row' }, hint, sendBtn));
      }
      this.textarea = ta;
      requestAnimationFrame(() => autoGrow(ta, maxPx));
    } else if (m.kind === 'elsewhere') {
      const ta = h('textarea', { class: 'co-textarea', rows: '1', disabled: true, placeholder: 'You can’t reply from here while it’s open elsewhere', 'aria-label': 'Reply (unavailable)' });
      const sid = v?.sessionId;
      kids.push(this.page ? h('div', { class: 'co-composer disabled' }, ta) : ta, h('div', { class: 'co-footer-note' }, sprite('lock', 2), h('span', { text: m.text }),
        sid ? button(['Open in Claude Code', h('span', { 'aria-hidden': 'true', text: '↗' })], 'co-btn co-secondary co-small', () => this.deps.post({ type: 'openInClaudeCode', sessionId: sid }), { title: 'Reply from the window that has this session' }) : null));
    } else if (m.kind === 'temp') {
      const pid = m.parentId;
      kids.push(h('div', { class: 'co-footer-note' }, pixelIcon('clipboard', 16), h('span', { text: m.text }),
        // A case tab is bound to one worker: the boss's file opens from the office, not from here.
        pid && !this.page ? button('Open their boss’s file', 'co-link', () => this.open(pid)) : null));
    } else {
      kids.push(h('div', { class: 'co-footer-note' }, h('span', { text: m.text })));
    }
    this.footerSlot.replaceChildren(...kids);
    if (typing && this.textarea) {
      this.textarea.focus({ preventScroll: true });
      this.textarea.setSelectionRange(typing.start, typing.end);
    } else if (this.page && (document.activeElement === null || document.activeElement === document.body) && this.loaded && this.pageFocused) {
      // The control that had focus went with the old footer: keep the keyboard in the tab.
      (this.textarea ?? this.el).focus({ preventScroll: true });
    }
  }

  private announce(text: string): void {
    this.live.textContent = '';
    window.setTimeout(() => { this.live.textContent = text; }, 30);
  }

  private saveDraft(): void {
    if (this.agentId && this.textarea) {
      if (this.textarea.value) this.drafts.set(this.agentId, this.textarea.value);
      else this.drafts.delete(this.agentId);
    }
  }

  private reset(): void {
    this.agentId = null;
    this.header = null;
    this.items = [];
    this.nodes.clear();
    this.expanded.clear();
    this.pending = null;
    this.pendingShownId = null;
    this.sentFor = null;
    this.truncated = false;
    this.loaded = false;
    this.closed = null;
    this.loadError = null;
    this.footerKey = '';
    this.headKey = '';
    this.textarea = null;
    this.focusCard = false;
    this.lastSeen = null;
    this.lastLook = null;
    this.pill.hidden = true;
    this.errorEl.hidden = true;
    this.pageFocused = false;
    this.renderWorking(null);
    window.clearTimeout(this.optsTimer);
    this.optsEl.replaceChildren();
    this.optsHint.hidden = true;
    this.optsKey = '';
    this.optsDirty = false;
    this.nextAt = 0;
    delete this.face.dataset['look'];
    this.face.getContext('2d')?.clearRect(0, 0, this.face.width, this.face.height);
  }
}

function clampWidth(w: number): number {
  return Math.max(DRAWER_MIN_W, Math.min(DRAWER_MAX_W, Math.round(w)));
}
