/**
 * The Plans panel (the whiteboard): plans from every worker in three stacked sections, "Waiting for sign-off",
 * "Approved" and "Sent back" (`planBoard`, plansLogic.ts). A card opens the plan view, which loads the full text
 * (`getPlan`) and, for a plan an office run is blocked on, lets you approve it or send it back with notes (the same
 * `decide` message the case file sends). Other plans are read-only. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { HostToWebview, PlanStatus } from '../../src/shared/protocol.ts';
import { LIMITS } from '../../src/shared/protocol.ts';
import { planBadge, planDecision, shortPath } from './caseLogic.ts';
import { button, h, pixelIcon, portrait, renderMarkdown } from './dom.ts';
import { charsText, planAgeText, planReadOnlyHint, supersededText } from './panelsLogic.ts';
import { PLAN_COLUMNS, PLAN_COLUMN_TITLES, planBoard } from './plansLogic.ts';
import type { PlanCard } from './plansLogic.ts';
import { isSendKey, sendKeyLabel } from './dom.ts';

export interface PlansDeps {
  /** The worker's look id for the portrait (the office's assignment), or null before one is known. */
  lookOf(agentId: string): string | null;
}

const CSS = `
.co-plans, .co-planv { --pl-fg: var(--vscode-foreground, #cccccc); --pl-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --pl-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --pl-warn: var(--vscode-editorWarning-foreground, #cca700); --pl-warn-text: color-mix(in srgb, var(--pl-warn) 70%, var(--pl-fg));
  --pl-ok: var(--vscode-testing-iconPassed, #73c991); --pl-ok-text: color-mix(in srgb, var(--pl-ok) 70%, var(--pl-fg));
  --pl-err: var(--vscode-errorForeground, #f48771); --pl-focus: var(--vscode-focusBorder, #007fd4);
  --pl-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); --pl-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16));
  --pl-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)); }
.co-plans { display: flex; flex-direction: column; gap: 14px; }
.co-plans-sec { display: flex; flex-direction: column; gap: 6px; }
.co-plans-h { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--pl-dim); }
.co-plans-sec.waiting .co-plans-h { color: var(--pl-warn-text); }
.co-plans-count { padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; letter-spacing: 0; background: var(--vscode-badge-background, rgba(128,128,128,0.3));
  color: var(--vscode-badge-foreground, var(--pl-fg)); border: 1px solid var(--vscode-contrastBorder, transparent); }
.co-plans-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-plans-none { margin: 0; padding: 8px 10px; font-size: 12px; color: var(--pl-dim); border: 1px dashed var(--pl-border); border-radius: 5px; }
.co-plans-card { display: flex; align-items: flex-start; gap: 9px; width: 100%; padding: 8px 10px; text-align: left; cursor: pointer; font: inherit; color: var(--pl-fg);
  background: var(--pl-card); border: 1px solid var(--pl-border); border-radius: 5px; }
.co-plans-card:hover { background: var(--pl-hover); }
.co-plans-card:focus-visible { outline: 2px solid var(--pl-focus); outline-offset: 1px; }
.co-plans-card.blocking { border-left: 4px solid var(--pl-warn); background: color-mix(in srgb, var(--pl-warn) 9%, var(--pl-card)); }
.co-plans-face { flex: none; width: 28px; height: 28px; border-radius: 4px; background: color-mix(in srgb, var(--pl-fg) 9%, transparent); }
.co-plans-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.co-plans-title { font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.co-plans-who { font-size: 12px; color: var(--pl-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-plans-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 2px; font-size: 11.5px; color: var(--pl-dim); }
.co-plans-badge { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; line-height: 16px; font-weight: 600; letter-spacing: 0.03em;
  text-transform: uppercase; border: 1px solid var(--pl-border); color: var(--pl-fg); white-space: nowrap; }
.co-plans-badge::before { content: ''; width: 6px; height: 6px; background: currentColor; flex: none; }
.co-plans-badge.warn { border-color: color-mix(in srgb, var(--pl-warn) 60%, transparent); background: color-mix(in srgb, var(--pl-warn) 13%, transparent); color: var(--pl-warn-text); }
.co-plans-badge.warn::before { border-radius: 50%; }
.co-plans-badge.ok { border-color: color-mix(in srgb, var(--pl-ok) 55%, transparent); background: color-mix(in srgb, var(--pl-ok) 12%, transparent); color: var(--pl-ok-text); }
.co-plans-badge.ok::before { clip-path: polygon(0 55%, 18% 40%, 40% 62%, 82% 15%, 100% 30%, 40% 100%); }
.co-plans-badge.err { border-color: color-mix(in srgb, var(--pl-err) 55%, transparent); background: color-mix(in srgb, var(--pl-err) 11%, transparent); color: var(--pl-err); }
.co-plans-badge.err::before { clip-path: polygon(0 100%, 50% 0, 100% 100%); }
.co-plans-badge.dim::before { border-radius: 50%; opacity: 0.6; }
.co-plans-needs { font-weight: 700; color: var(--pl-warn-text); }
.co-plans-sup { margin: 0; font-size: 11.5px; color: var(--pl-dim); text-align: center; }
.co-plans-empty { margin: 24px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--pl-dim); }
.co-plans-empty strong { color: var(--pl-fg); font-size: 13.5px; }

.co-planv { display: flex; flex-direction: column; gap: 10px; min-height: 100%; }
.co-planv-head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.co-planv-head .co-plans-face { width: 36px; height: 36px; }
.co-planv-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.co-planv-sub { font-size: 12px; color: var(--pl-dim); overflow-wrap: anywhere; }
.co-planv-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--pl-dim); }
.co-planv-paper { padding: 10px 12px; border: 1px solid var(--pl-border); border-radius: 4px; background: color-mix(in srgb, var(--pl-fg) 5%, transparent); overflow-wrap: anywhere; min-width: 0; }
.co-planv-load { display: flex; align-items: center; gap: 8px; color: var(--pl-dim); margin: 8px 0; }
.co-planv-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--pl-fg) 25%, transparent); border-top-color: var(--pl-fg); animation: co-planv-spin 0.8s linear infinite; flex: none; }
@keyframes co-planv-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-planv-spin { animation: none; border-top-color: color-mix(in srgb, var(--pl-fg) 25%, transparent); } }
.co-planv-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--pl-err) 55%, transparent); background: color-mix(in srgb, var(--pl-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-planv-err strong { color: var(--pl-fg); }
.co-planv-note { margin: 0; font-size: 11.5px; font-style: italic; color: var(--pl-dim); overflow-wrap: anywhere; }
.co-planv-path { margin: 0; font-size: 11.5px; color: var(--pl-dim); overflow-wrap: anywhere; }
.co-planv-path code { font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace); font-size: 0.95em; }
.co-planv-fb { padding: 6px 10px; border-left: 3px solid var(--pl-err); background: color-mix(in srgb, var(--pl-err) 8%, transparent); border-radius: 0 3px 3px 0; display: flex; flex-direction: column; gap: 2px; }
.co-planv-fb-k { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--pl-dim); }
.co-planv-fb-v { white-space: pre-wrap; overflow-wrap: anywhere; }
.co-planv-hint { margin: 0; font-size: 12px; color: var(--pl-dim); padding: 6px 10px; border: 1px dashed var(--pl-border); border-radius: 4px; }
.co-planv > div:empty { display: none; }
.co-planv-links { display: flex; flex-wrap: wrap; gap: 6px; }
.co-planv-decide { position: sticky; bottom: -14px; z-index: 1; margin: auto -12px -14px; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px;
  background: color-mix(in srgb, var(--pl-warn) 9%, var(--pl-bg)); border-top: 3px solid var(--pl-warn); }
.co-planv-decide-t { font-weight: 600; }
.co-planv-decide-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.co-planv-decide textarea { width: 100%; min-height: 54px; resize: vertical; padding: 5px 7px; font: inherit; color: var(--vscode-input-foreground, var(--pl-fg));
  background: var(--vscode-input-background, rgba(128,128,128,0.12)); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, var(--pl-border))); border-radius: 3px; }
.co-planv-decide textarea:focus { outline: 1px solid var(--pl-focus); outline-offset: -1px; border-color: var(--pl-focus); }
.co-planv-decide-cap { font-size: 11.5px; color: var(--pl-dim); }
.co-planv-sent { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 8px 10px; border: 1px solid var(--pl-border); border-radius: 4px; }
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

const SLOW_MS = 12_000;
let reqCounter = 0;
function nextReqId(): string {
  reqCounter += 1;
  return `plan-${reqCounter}-${Date.now().toString(36)}`;
}

/** Builds the Plans panel. Register it under id `plans`. */
export function createPlansPanel(deps: PlansDeps): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let root: HTMLElement | null = null;

  function card(c: PlanCard, pc: PanelContext<HTMLElement>): HTMLElement {
    const badge = planBadge(c.plan.status);
    const age = planAgeText(c, pc.now());
    const btn = button([
      portrait(deps.lookOf(c.agentId), 28, 'co-plans-face'),
      h('span', { class: 'co-plans-text' },
        h('span', { class: 'co-plans-title', text: c.plan.title || 'Untitled plan' }),
        h('span', { class: 'co-plans-who', text: [c.agentTitle, c.project].filter(Boolean).join(' · ') }),
        h('span', { class: 'co-plans-foot' },
          h('span', { class: `co-plans-badge ${badge.tone}`, text: badge.label, title: badge.title }),
          h('span', { text: age }),
          c.blocking ? h('span', { class: 'co-plans-needs', text: 'Needs your decision' }) : null)),
    ], `co-plans-card${c.blocking ? ' blocking' : ''}`, () => pc.push(createPlanView({ agentId: c.agentId, planId: c.plan.id, title: c.plan.title }, deps)), { 'data-key': c.key });
    return h('li', null, btn);
  }

  function render(): void {
    const pc = ctx;
    if (!pc || !root) return;
    const board = planBoard(pc.agents());
    const active = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['key'] : undefined;
    const total = board.waiting.length + board.approved.length + board.sentBack.length;
    if (total === 0) {
      setKids(root, h('div', { class: 'co-plans-empty' }, pixelIcon('plans', 32), h('strong', { text: 'No plans yet' }),
        h('span', { text: 'When a worker in plan mode proposes a plan, it shows up here for your sign-off.' })),
        board.superseded ? h('p', { class: 'co-plans-sup', text: supersededText(board.superseded) }) : null);
      return;
    }
    const sections = PLAN_COLUMNS.map((col) => {
      const cards = board[col];
      return h('section', { class: `co-plans-sec ${col}`, 'aria-label': PLAN_COLUMN_TITLES[col] },
        h('h3', { class: 'co-plans-h' }, h('span', { text: PLAN_COLUMN_TITLES[col] }), h('span', { class: 'co-plans-count', text: String(cards.length) })),
        cards.length ? h('ul', { class: 'co-plans-list' }, ...cards.map((c) => card(c, pc))) : h('p', { class: 'co-plans-none', text: 'None' }));
    });
    setKids(root, ...sections, board.superseded ? h('p', { class: 'co-plans-sup', text: supersededText(board.superseded) }) : null);
    if (active !== undefined) {
      const el = Array.from(root.querySelectorAll<HTMLElement>('[data-key]')).find((e) => e.dataset['key'] === active);
      el?.focus({ preventScroll: true });
    }
  }

  return {
    id: 'plans',
    title: 'Plans',
    icon: 'plans',
    mount(body, c) {
      injectCss();
      ctx = c;
      root = h('div', { class: 'co-plans' });
      body.appendChild(root);
      render();
    },
    refresh() {
      render();
    },
    unmount() {
      ctx = null;
      root = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Plan view

export interface PlanViewArgs {
  agentId: string;
  /** The plan's tool_use id (`getPlan`'s `planId`). */
  planId: string;
  /** Plan title as shown in the list (fallback until the text loads). */
  title: string;
}

type PlanState =
  | { kind: 'loading'; slow: boolean }
  | { kind: 'ready'; text: string; truncated: boolean; status: PlanStatus; planFilePath?: string; feedback?: string }
  | { kind: 'error'; message: string };

/** The sub-view for one plan: loads the text (`getPlan`), shows status and feedback, and offers the decision when an office run waits on it. */
export function createPlanView(args: PlanViewArgs, deps: PlansDeps): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let head: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let decideEl: HTMLElement | null = null;
  let state: PlanState = { kind: 'loading', slow: false };
  let reqId = '';
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  /** What was sent from here (so the buttons give way to a confirmation until the agents update arrives). */
  let sent: 'approved' | 'sentBack' | null = null;
  let askingFeedback = false;
  let feedbackDraft = '';
  let decideKey = '';

  const cardNow = (): PlanCard | undefined => {
    if (!ctx) return undefined;
    const board = planBoard(ctx.agents());
    return [...board.waiting, ...board.approved, ...board.sentBack].find((c) => c.agentId === args.agentId && c.plan.id === args.planId);
  };
  const agentNow = () => ctx?.agents().find((a) => a.id === args.agentId);

  function request(): void {
    if (!ctx) return;
    reqId = nextReqId();
    state = { kind: 'loading', slow: false };
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (state.kind === 'loading') { state = { kind: 'loading', slow: true }; renderContent(); }
    }, SLOW_MS);
    ctx.post({ type: 'getPlan', reqId, agentId: args.agentId, planId: args.planId });
    renderContent();
  }

  /** The status to show: the live one from the agent list, else the one in the reply. */
  function statusNow(): PlanStatus {
    const live = cardNow()?.plan.status;
    if (live) return live;
    return state.kind === 'ready' ? state.status : 'pending';
  }

  function renderHead(): void {
    if (!head || !ctx) return;
    const card = cardNow();
    const a = agentNow();
    const status = statusNow();
    const badge = planBadge(status);
    const title = card?.plan.title || args.title || 'Plan';
    const metaBits: string[] = [];
    if (card) metaBits.push(planAgeText(card, ctx.now()));
    if (card?.plan.chars) metaBits.push(charsText(card.plan.chars));
    head.replaceChildren(portrait(deps.lookOf(args.agentId), 36, 'co-plans-face'),
      h('div', { style: 'min-width:0;display:flex;flex-direction:column;gap:3px' },
        h('h3', { class: 'co-planv-title', text: title }),
        h('span', { class: 'co-planv-sub', text: [a?.title, a?.project].filter(Boolean).join(' · ') }),
        h('span', { class: 'co-planv-meta' }, h('span', { class: `co-plans-badge ${badge.tone}`, text: badge.label, title: badge.title }), metaBits.length ? h('span', { text: metaBits.join(' · ') }) : null)));
  }

  function renderContent(): void {
    if (!content) return;
    if (state.kind === 'loading') {
      setKids(content, h('div', { class: 'co-planv-load', role: 'status' }, h('span', { class: 'co-planv-spin', 'aria-hidden': 'true' }),
        h('span', { text: state.slow ? 'Still waiting for the plan…' : 'Loading the plan…' })),
        state.slow ? button('Try again', 'co-btn co-secondary co-small', request) : null);
      return;
    }
    if (state.kind === 'error') {
      setKids(content, h('div', { class: 'co-planv-err', role: 'alert' },
        h('span', null, h('strong', { text: 'Couldn’t load the plan. ' }), state.message),
        button('Try again', 'co-btn co-secondary co-small', request)));
      return;
    }
    const paper = h('div', { class: 'co-md co-planv-paper', tabindex: '0', 'aria-label': 'The plan' });
    paper.appendChild(renderMarkdown(state.text));
    const nodes: (Node | null)[] = [paper];
    if (state.truncated) nodes.push(h('p', { class: 'co-planv-note', text: state.planFilePath ? `The plan was too long to show in full. All of it is in the file below.` : 'The plan was too long to show in full.' }));
    const fb = state.feedback?.trim();
    if (fb) nodes.push(h('div', { class: 'co-planv-fb' }, h('span', { class: 'co-planv-fb-k', text: 'Your notes' }), h('span', { class: 'co-planv-fb-v', text: fb })));
    if (state.planFilePath) nodes.push(h('p', { class: 'co-planv-path', title: state.planFilePath }, 'Saved to ', h('code', { text: shortPath(state.planFilePath) })));
    setKids(content, ...nodes);
  }

  /** Rebuilds the decision area when what it shows changes (or when forced); otherwise leaves it, so typing a note is not interrupted. */
  function renderDecide(force = false): void {
    const c = ctx;
    if (!decideEl || !c) return;
    const card = cardNow();
    const a = agentNow();
    const status = statusNow();
    const requestId = a?.pending?.kind === 'plan' ? a.pending.requestId : undefined;
    const blocking = !!card?.blocking && requestId !== undefined;
    const hint = blocking || sent ? '' : planReadOnlyHint(status, a?.control === 'office');
    const key = `${blocking}|${sent}|${askingFeedback}|${hint}|${a?.title ?? ''}`;
    if (!force && key === decideKey) return;
    decideKey = key;
    decideEl.className = '';
    const children: Node[] = [];
    if (blocking && !sent) {
      decideEl.className = 'co-planv-decide';
      children.push(h('div', { class: 'co-planv-decide-t', text: `${a?.title ?? 'They'} is waiting for your decision` }));
      if (!askingFeedback) {
        children.push(h('div', { class: 'co-planv-decide-row' },
          button('Approve plan', 'co-btn co-primary', () => decide(true, ''), { title: 'They leave plan mode and start making changes' }),
          button('Send back\u2026', 'co-btn co-secondary', () => { askingFeedback = true; renderDecide(); decideEl?.querySelector('textarea')?.focus(); }, { title: 'They keep planning with your notes' })));
        children.push(h('div', { class: 'co-planv-decide-cap', text: 'Approving lets them leave plan mode and start making changes.' }));
      } else {
        const ta = h('textarea', { rows: '3', maxlength: String(LIMITS.feedbackChars), placeholder: 'What should they change? (optional)', 'aria-label': 'Feedback for the plan' });
        ta.value = feedbackDraft;
        ta.addEventListener('input', () => { feedbackDraft = ta.value; });
        ta.addEventListener('keydown', (e) => {
          if (isSendKey(e)) { e.preventDefault(); decide(false, ta.value); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askingFeedback = false; renderDecide(); }
        });
        children.push(ta, h('div', { class: 'co-planv-decide-row' },
          button('Send back', 'co-btn co-primary', () => decide(false, ta.value), { title: `They keep planning with your notes (${sendKeyLabel()})` }),
          button('Cancel', 'co-btn co-ghost', () => { askingFeedback = false; renderDecide(); })));
      }
    } else if (sent) {
      children.push(h('div', { class: 'co-planv-sent', role: 'status' }, pixelIcon('plans', 16),
        h('span', { text: sent === 'approved' ? 'Approved. They are going ahead.' : 'Sent back. They are revising the plan.' })));
    } else if (hint) {
      children.push(h('p', { class: 'co-planv-hint', text: hint }));
    }
    decideEl.replaceChildren(...children);
  }

  function decide(approve: boolean, feedback: string): void {
    const c = ctx;
    const a = agentNow();
    if (!c || a?.pending?.kind !== 'plan') return;
    c.post({ type: 'decide', requestId: a.pending.requestId, decision: planDecision(approve, feedback) });
    sent = approve ? 'approved' : 'sentBack';
    askingFeedback = false;
    renderDecide();
  }

  return {
    id: 'plan',
    title: 'Plan',
    icon: 'plans',
    mount(body, c) {
      injectCss();
      ctx = c;
      sent = null;
      askingFeedback = false;
      feedbackDraft = '';
      decideKey = '';
      head = h('div', { class: 'co-planv-head' });
      content = h('div');
      decideEl = h('div');
      const links = h('div', { class: 'co-planv-links' }, button('Open case file', 'co-btn co-secondary co-small', () => c.openCase(args.agentId)));
      body.appendChild(h('div', { class: 'co-planv' }, head, content, links, decideEl));
      renderHead();
      renderDecide(true);
      request();
    },
    refresh() {
      renderHead();
      renderDecide();
    },
    handle(msg: HostToWebview) {
      if (msg.type === 'planText' && msg.reqId === reqId) {
        if (slowTimer !== null) clearTimeout(slowTimer);
        const next: PlanState = { kind: 'ready', text: msg.text, truncated: !!msg.truncated, status: msg.status };
        if (msg.planFilePath) next.planFilePath = msg.planFilePath;
        if (msg.feedback) next.feedback = msg.feedback;
        state = next;
        renderContent();
        renderHead();
        renderDecide();
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
      content = null;
      decideEl = null;
    },
  };
}
