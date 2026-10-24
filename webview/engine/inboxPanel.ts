/**
 * The In-tray panel (the manager's in-tray): everything waiting for you, urgent first, with a report view for
 * finished reports. The list comes from `deriveInbox` (inboxLogic.ts); read marks live in `ctx.inbox`. A report opens a
 * sub-view that asks the host for that turn (`getTurn`); a plan opens the plan view from plansPanel.ts; questions,
 * approvals and "needs you" rows open the case file. Text nodes only (`renderMarkdown` is the one markdown path).
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { ConversationItem, HostToWebview } from '../../src/shared/protocol.ts';
import type { IconId } from '../art/index.ts';
import { planBadge, formatCost, toolIcon } from './caseLogic.ts';
import { button, h, pixelIcon, portrait, renderMarkdown } from './dom.ts';
import { deriveInbox, pruneRead } from './inboxLogic.ts';
import type { InboxItem } from './inboxLogic.ts';
import { agoWords, inboxRow, inboxSummary, markAllKeys, toolRunSummary, turnBlocks } from './panelsLogic.ts';
import { createPlanView } from './plansPanel.ts';
import { modelLine } from './tooltip.ts';

export interface InboxDeps {
  /** The worker's look id for the portrait (the office's assignment), or null before one is known. */
  lookOf(agentId: string): string | null;
}

const CSS = `
.co-inbox, .co-report { --ib-fg: var(--vscode-foreground, #cccccc); --ib-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --ib-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --ib-warn: var(--vscode-editorWarning-foreground, #cca700); --ib-warn-text: color-mix(in srgb, var(--ib-warn) 70%, var(--ib-fg));
  --ib-err: var(--vscode-errorForeground, #f48771); --ib-focus: var(--vscode-focusBorder, #007fd4);
  --ib-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); --ib-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16)); }
.co-inbox { display: flex; flex-direction: column; gap: 10px; }
.co-inbox-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.co-inbox-summary { margin: 0; font-size: 12px; color: var(--ib-dim); }
.co-inbox-sec { margin: 6px 0 -4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ib-dim); }
.co-inbox-sec.urgent { color: var(--ib-warn-text); }
.co-inbox-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-inbox-item { position: relative; display: flex; align-items: stretch; background: var(--ib-card); border: 1px solid var(--ib-border); border-radius: 5px; overflow: hidden; }
.co-inbox-item:hover { background: var(--ib-hover); }
.co-inbox-item.urgent { border-left: 4px solid var(--ib-warn); background: color-mix(in srgb, var(--ib-warn) 9%, var(--ib-card)); }
.co-inbox-item.unread:not(.urgent) { border-left: 4px solid var(--ib-focus); }
.co-inbox-item.read { background: transparent; }
.co-inbox-item.read:hover { background: var(--ib-hover); }
.co-inbox-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: flex-start; gap: 9px; padding: 8px 6px 8px 9px; text-align: left; cursor: pointer;
  font: inherit; color: var(--ib-fg); background: transparent; border: 0; }
.co-inbox-main:focus-visible, .co-inbox-mark:focus-visible { outline: 2px solid var(--ib-focus); outline-offset: -2px; }
.co-inbox-face { flex: none; width: 32px; height: 32px; border-radius: 4px; background: color-mix(in srgb, var(--ib-fg) 9%, transparent); }
.co-inbox-item.read .co-inbox-face { opacity: 0.7; }
.co-inbox-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.co-inbox-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.co-inbox-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.co-inbox-item.unread .co-inbox-title { font-weight: 700; }
.co-inbox-time { flex: none; font-size: 11.5px; color: var(--ib-dim); font-variant-numeric: tabular-nums; }
.co-inbox-detail { font-size: 12px; line-height: 16px; color: var(--ib-dim); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.co-inbox-item.unread .co-inbox-detail { color: color-mix(in srgb, var(--ib-fg) 80%, var(--ib-dim)); }
.co-inbox-meta { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
.co-inbox-kind { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; font-weight: 600;
  letter-spacing: 0.03em; text-transform: uppercase; border: 1px solid var(--ib-border); color: var(--ib-dim); }
.co-inbox-item.urgent .co-inbox-kind { color: var(--ib-warn-text); border-color: color-mix(in srgb, var(--ib-warn) 60%, transparent); background: color-mix(in srgb, var(--ib-warn) 14%, transparent); }
.co-inbox-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ib-focus); flex: none; }
.co-inbox-item.urgent .co-inbox-dot { background: var(--ib-warn); }
.co-inbox-mark { flex: none; width: 34px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ib-dim);
  background: transparent; border: 0; border-left: 1px solid transparent; font: inherit; font-size: 14px; }
.co-inbox-mark:hover { color: var(--ib-fg); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-inbox-empty { margin: 30px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--ib-dim); }
.co-inbox-empty strong { color: var(--ib-fg); font-size: 13.5px; }

.co-report { display: flex; flex-direction: column; gap: 10px; }
.co-report-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.co-report-head .co-inbox-face { width: 40px; height: 40px; }
.co-report-who { min-width: 0; display: flex; flex-direction: column; }
.co-report-title { font-size: 14px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.co-report-sub { font-size: 12px; color: var(--ib-dim); overflow-wrap: anywhere; }
.co-report-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.co-report-body { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ib-border); min-width: 0; }
.co-report-load { display: flex; align-items: center; gap: 8px; color: var(--ib-dim); margin: 8px 0; }
.co-report-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--ib-fg) 25%, transparent); border-top-color: var(--ib-fg); animation: co-report-spin 0.8s linear infinite; flex: none; }
@keyframes co-report-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-report-spin { animation: none; border-top-color: color-mix(in srgb, var(--ib-fg) 25%, transparent); } }
.co-report-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--ib-err) 55%, transparent); background: color-mix(in srgb, var(--ib-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-report-err strong { color: var(--ib-fg); }
.co-report-note { font-size: 11.5px; font-style: italic; color: var(--ib-dim); margin: 0; }
.co-report-md { overflow-wrap: anywhere; min-width: 0; }
.co-report-prompt { margin: 0; padding: 4px 10px; border-left: 3px solid var(--ib-border); color: var(--ib-dim); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.co-report-tools { border: 1px solid var(--ib-border); border-radius: 4px; padding: 0 8px; }
.co-report-tools > summary { cursor: pointer; padding: 4px 0; font-size: 12px; color: var(--ib-dim); }
.co-report-tools > summary:focus-visible { outline: 2px solid var(--ib-focus); outline-offset: 1px; }
.co-report-tools[open] > summary { border-bottom: 1px dashed var(--ib-border); margin-bottom: 4px; }
.co-report-tool { display: flex; align-items: center; gap: 7px; min-height: 22px; font-size: 12.5px; min-width: 0; }
.co-report-tool span.sum { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-report-tool .tag { flex: none; font-size: 10.5px; font-weight: 600; padding: 0 6px; border-radius: 8px; border: 1px solid var(--ib-border); }
.co-report-tool.error .sum, .co-report-tool.error .tag { color: var(--ib-err); }
.co-report-tool.denied .sum { text-decoration: line-through; opacity: 0.75; }
.co-report-tool.running .tag { color: var(--ib-dim); }
.co-report-notice { text-align: center; font-size: 11.5px; color: var(--ib-dim); display: flex; align-items: center; gap: 8px; }
.co-report-notice::before, .co-report-notice::after { content: ''; flex: 1; border-top: 1px dashed var(--ib-border); }
.co-report-notice.error { color: var(--ib-err); }
.co-report-notice.interrupted { color: var(--ib-warn-text); }
.co-report-plan { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
`;

/** `replaceChildren` that skips nulls. */
function setKids(el: HTMLElement, ...xs: (Node | null | undefined)[]): void {
  el.replaceChildren(...xs.filter((x): x is Node => !!x));
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

const TICK_MS = 60_000;
/** After this long without an answer the report view says so and offers a retry. */
const SLOW_MS = 12_000;

let reqCounter = 0;
function nextReqId(prefix: string): string {
  reqCounter += 1;
  return `${prefix}-${reqCounter}-${Date.now().toString(36)}`;
}

/** Builds the In-tray panel. Register it under id `inbox`. */
export function createInboxPanel(deps: InboxDeps): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let root: HTMLElement | null = null;
  let topEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const derive = (): InboxItem[] => (ctx ? deriveInbox(ctx.agents(), ctx.inbox, ctx.now()) : []);

  function open(item: InboxItem): void {
    if (!ctx) return;
    const action = inboxRow(item, ctx.now()).action;
    if (action === 'report') ctx.push(createReportView(item, deps));
    else if (action === 'plan' && item.planId) ctx.push(createPlanView({ agentId: item.agentId, planId: item.planId, title: item.title }, deps));
    else ctx.openCase(item.agentId);
  }

  function row(item: InboxItem, c: PanelContext<HTMLElement>): HTMLElement {
    const r = inboxRow(item, c.now());
    const main = button([
      portrait(deps.lookOf(item.agentId), 32, 'co-inbox-face'),
      h('span', { class: 'co-inbox-text' },
        h('span', { class: 'co-inbox-line' }, h('span', { class: 'co-inbox-title', text: item.title }), h('span', { class: 'co-inbox-time', text: r.time })),
        item.detail ? h('span', { class: 'co-inbox-detail', text: item.detail }) : null,
        h('span', { class: 'co-inbox-meta' }, r.unread ? h('span', { class: 'co-inbox-dot', 'aria-hidden': 'true' }) : null, h('span', { class: 'co-inbox-kind', text: r.kindLabel }))),
    ], 'co-inbox-main', () => open(item), { 'aria-label': `${item.title}. ${item.detail}. ${r.describe}` });
    const li = h('li', { class: `co-inbox-item ${r.urgent ? 'urgent' : ''} ${r.unread ? 'unread' : 'read'}`, 'data-key': item.key }, main);
    if (!r.urgent) {
      const read = !r.unread;
      li.appendChild(button(read ? '○' : '✓', 'co-inbox-mark', () => (read ? c.inbox.markUnread(item.key) : c.inbox.markRead(item.key)), {
        title: read ? 'Mark unread' : 'Mark read', 'aria-label': read ? 'Mark unread' : 'Mark read',
      }));
    }
    return li;
  }

  function render(): void {
    const c = ctx;
    if (!c || !topEl || !listEl || !root) return;
    const items = derive();
    const active = listEl.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const activeKey = active?.closest<HTMLElement>('[data-key]')?.dataset['key'];
    const activeIsMark = !!active?.classList.contains('co-inbox-mark');
    // "Mark all read" is rebuilt on every render: keep the keyboard focus on it (or on the list once it is disabled).
    const markAllHadFocus = topEl.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement;
    const restoreMarkAll = (): void => {
      if (!markAllHadFocus) return;
      const btn = topEl?.querySelector<HTMLButtonElement>('button');
      if (btn && !btn.disabled) btn.focus({ preventScroll: true });
      else (listEl?.querySelector<HTMLElement>('.co-inbox-main') ?? root?.closest<HTMLElement>('[tabindex="-1"]'))?.focus({ preventScroll: true });
    };

    const markable = markAllKeys(items);
    const markAll = button('Mark all read', 'co-btn co-secondary co-small', () => {
      for (const k of markAllKeys(derive())) c.inbox.markRead(k);
    }, { title: 'Mark every report and plan as read' });
    markAll.disabled = markable.length === 0;
    setKids(topEl, h('p', { class: 'co-inbox-summary', role: 'status', text: inboxSummary(items) }), items.length ? markAll : null);

    if (items.length === 0) {
      listEl.replaceChildren(h('li', { class: 'co-inbox-empty' }, pixelIcon('inTray', 32), h('strong', { text: 'Nothing in your in-tray' }),
        h('span', { text: 'Reports, plans and questions from your staff land here.' })));
      restoreMarkAll();
      return;
    }
    const nodes: Node[] = [];
    const urgent = items.filter((i) => i.urgency === 'urgent');
    const rest = items.filter((i) => i.urgency !== 'urgent');
    if (urgent.length && rest.length) nodes.push(h('li', { class: 'co-inbox-sec urgent', role: 'presentation', text: 'Needs you now' }));
    for (const i of urgent) nodes.push(row(i, c));
    if (urgent.length && rest.length) nodes.push(h('li', { class: 'co-inbox-sec', role: 'presentation', text: 'Reports and plans' }));
    for (const i of rest) nodes.push(row(i, c));
    listEl.replaceChildren(...nodes);
    if (activeKey !== undefined) {
      const sel = activeIsMark ? '.co-inbox-mark' : '.co-inbox-main';
      const li = Array.from(listEl.querySelectorAll<HTMLElement>('[data-key]')).find((e) => e.dataset['key'] === activeKey);
      (li?.querySelector<HTMLElement>(sel) ?? li?.querySelector<HTMLElement>('.co-inbox-main'))?.focus({ preventScroll: true });
    }
    restoreMarkAll();
  }

  return {
    id: 'inbox',
    title: 'In-tray',
    icon: 'inTray',
    mount(body, c) {
      injectCss();
      ctx = c;
      // Drop old read marks for reports that are gone.
      const all = c.inbox.all();
      const kept = pruneRead(all, derive(), c.now());
      for (const k of Object.keys(all)) if (!(k in kept)) c.inbox.markUnread(k);
      topEl = h('div', { class: 'co-inbox-top' });
      listEl = h('ul', { class: 'co-inbox-list' });
      root = h('div', { class: 'co-inbox' }, topEl, listEl);
      body.appendChild(root);
      render();
      timer = setInterval(render, TICK_MS);
    },
    refresh() {
      render();
    },
    unmount() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      ctx = null;
      root = null;
      topEl = null;
      listEl = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Report view

type ReportState =
  | { kind: 'loading'; slow: boolean }
  | { kind: 'ready'; items: ConversationItem[]; truncated: boolean }
  | { kind: 'error'; message: string };

/** The sub-view for one finished report: loads the turn (`getTurn`) and shows its output. */
export function createReportView(item: InboxItem, deps: InboxDeps): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let head: HTMLElement | null = null;
  let actions: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let state: ReportState = { kind: 'loading', slow: false };
  let reqId = '';
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const agent = () => ctx?.agents().find((a) => a.id === item.agentId);

  function request(): void {
    if (!ctx) return;
    reqId = nextReqId('turn');
    state = { kind: 'loading', slow: false };
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (state.kind === 'loading') { state = { kind: 'loading', slow: true }; renderContent(); }
    }, SLOW_MS);
    ctx.post({ type: 'getTurn', reqId, agentId: item.agentId });
    renderContent();
  }

  function renderHead(): void {
    if (!head || !ctx) return;
    const a = agent();
    const sub = [a?.project, a ? modelLine(a) : '', agoWords(item.at, ctx.now())].filter(Boolean).join(' · ');
    head.replaceChildren(portrait(deps.lookOf(item.agentId), 40, 'co-inbox-face'),
      h('div', { class: 'co-report-who' }, h('span', { class: 'co-report-title', text: item.title }), h('span', { class: 'co-report-sub', text: sub })));
  }

  function renderActions(): void {
    if (!actions || !ctx) return;
    const c = ctx;
    const sessionId = agent()?.sessionId;
    const read = c.inbox.readAt(item.key) !== undefined;
    const reply = button('Reply', 'co-btn co-primary co-small', () => { if (sessionId) c.openMemo({ prefill: { sessionId, projectPath: agent()?.cwd } }); },
      { title: sessionId ? 'Send them a follow-up' : 'This worker has no session to reply to' });
    reply.disabled = !sessionId;
    setKids(actions, reply,
      button('Open case file', 'co-btn co-secondary co-small', () => c.openCase(item.agentId)),
      button(read ? 'Mark unread' : 'Mark read', 'co-btn co-ghost co-small', () => (read ? c.inbox.markUnread(item.key) : c.inbox.markRead(item.key))));
  }

  function previewNode(): Node | null {
    const text = agent()?.lastReport?.text;
    if (!text) return null;
    const md = h('div', { class: 'co-md co-report-md' });
    md.appendChild(renderMarkdown(text));
    return h('div', null, h('p', { class: 'co-report-note', text: 'The short version:' }), md);
  }

  function renderContent(): void {
    if (!content) return;
    if (state.kind === 'loading') {
      setKids(content, h('div', { class: 'co-report-load', role: 'status' }, h('span', { class: 'co-report-spin', 'aria-hidden': 'true' }),
        h('span', { text: state.slow ? 'Still waiting for the full report…' : 'Loading the full report…' })),
        state.slow ? button('Try again', 'co-btn co-secondary co-small', request) : null);
      return;
    }
    if (state.kind === 'error') {
      setKids(content, h('div', { class: 'co-report-err', role: 'alert' },
        h('span', null, h('strong', { text: 'Couldn’t load the full report. ' }), state.message),
        button('Try again', 'co-btn co-secondary co-small', request)), previewNode());
      return;
    }
    const nodes: Node[] = [];
    if (state.truncated) nodes.push(h('p', { class: 'co-report-note', text: 'This turn had more steps; only the latest are shown.' }));
    for (const b of turnBlocks(state.items)) nodes.push(renderBlock(b));
    if (!nodes.some((n) => n.nodeType === 1 && !(n as HTMLElement).classList.contains('co-report-note'))) {
      nodes.push(h('p', { class: 'co-report-note', text: 'Nothing to show for this turn.' }));
      const p = previewNode();
      if (p) nodes.push(p);
    }
    content.replaceChildren(...nodes);
  }

  return {
    id: 'inbox-report',
    title: 'Report',
    icon: 'inTray',
    mount(body, c) {
      injectCss();
      ctx = c;
      head = h('div', { class: 'co-report-head' });
      actions = h('div', { class: 'co-report-actions' });
      content = h('div', { class: 'co-report-body' });
      body.appendChild(h('div', { class: 'co-report' }, head, actions, content));
      // Opening a report marks it read; "Mark unread" in this view undoes that.
      if (c.inbox.readAt(item.key) === undefined) c.inbox.markRead(item.key, c.now());
      renderHead();
      renderActions();
      request();
    },
    refresh() {
      renderHead();
      renderActions();
    },
    handle(msg: HostToWebview) {
      if (msg.type === 'turn' && msg.reqId === reqId && msg.agentId === item.agentId) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        state = { kind: 'ready', items: msg.items, truncated: msg.truncated };
        renderContent();
      } else if (msg.type === 'error' && msg.reqId !== undefined && msg.reqId === reqId) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        state = { kind: 'error', message: msg.message };
        renderContent();
      }
    },
    unmount() {
      if (slowTimer !== null) clearTimeout(slowTimer);
      slowTimer = null;
      reqId = '';
      ctx = null;
      head = null;
      actions = null;
      content = null;
    },
  };
}

function renderBlock(b: ReturnType<typeof turnBlocks>[number]): HTMLElement {
  if (b.kind === 'tools') {
    const details = h('details', { class: 'co-report-tools' }, h('summary', { text: toolRunSummary(b.items) }),
      ...b.items.map((t) => h('div', { class: `co-report-tool ${t.state}`, title: `${t.name}: ${t.summary}` },
        pixelIcon(toolIcon(t.name) as IconId, 14), h('span', { class: 'sum', text: t.summary || t.name }),
        t.state === 'done' ? null : h('span', { class: 'tag', text: t.state === 'running' ? 'running' : t.state }))));
    if (b.items.length <= 3) details.setAttribute('open', '');
    return details;
  }
  const it = b.item;
  switch (it.kind) {
    case 'assistant': {
      const md = h('div', { class: 'co-md co-report-md' });
      md.appendChild(renderMarkdown(it.text));
      return h('div', null, md, it.truncated ? h('p', { class: 'co-report-note', text: '…the rest was too long to show here' }) : null);
    }
    case 'prompt': return h('p', { class: 'co-report-prompt', text: it.text });
    case 'notice': {
      let text = it.text;
      if (it.notice === 'cost' && it.costUsd !== undefined) text = `This turn: ${formatCost(it.costUsd)}`;
      else if (it.notice === 'interrupted') text = `⏹ ${it.text || 'Interrupted'}`;
      return h('div', { class: `co-report-notice ${it.notice}`, role: it.notice === 'error' ? 'alert' : null }, h('span', { text }));
    }
    case 'plan': {
      const badge = planBadge(it.status);
      return h('div', { class: 'co-report-plan' }, pixelIcon('plans', 14), h('span', { text: `Proposed a plan · ${badge.label}` }));
    }
    default: return h('div');
  }
}
