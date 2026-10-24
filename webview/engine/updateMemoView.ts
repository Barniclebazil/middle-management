/**
 * The head office memo: a new version of the office is out (or installing, or installed, or the install failed). Same
 * stationery as the assignment memo (`memo.ts`): cream paper on the company letterhead in pixel lettering, "INTEROFFICE MEMO",
 * FROM / TO / RE lines; plus a "HEAD OFFICE" rubber stamp and a band across the top in the active theme's sign colours
 * (`memoAccent`, darkened where needed so the stamp reads as text; the built-in look in high contrast themes).
 *
 * The words and buttons are `updateMemo`'s. Buttons post `updateAction` (the host does the work and answers with a new
 * `update`), except `close`, which only closes the memo. The memo re-renders from the update store while it is open (available
 * -> downloading -> installed shows "Reload now") and closes itself when the host says the update was put off. It works in view
 * mode too (unlike the assignment memo); a link at the bottom opens the Front desk, since a click on the receptionist opens this
 * memo while the post is waiting.
 */
import type { OfficeSettings, UpdateAction, UpdateInfo, WebviewToHost } from '../../src/shared/protocol.ts';
import { drawPixelText, measurePixelText, signColours } from '../art/index.ts';
import { button, h } from './dom.ts';
import { memoAccent, memoAfterUpdate } from './updateCueLogic.ts';
import { updateMemo } from './updateLogic.ts';
import type { MemoButton, UpdateMemo } from './updateLogic.ts';
import { getUpdate, onUpdate } from './updateStore.ts';
import { injectUiStyles } from './uiStyles.ts';

export interface UpdateMemoDeps {
  post(msg: WebviewToHost): void;
  settings(): OfficeSettings;
  /** The memo's "Front desk" link. */
  openFrontDesk(): void;
}

const CSS = `
.co-hq { --co-hq-ink: var(--co-letterhead); --co-hq-band: var(--co-letterhead); --co-hq-stripe: var(--co-hq-band); width: min(470px, 100%); padding-top: 20px; }
.co-hq::before { height: 8px; background: linear-gradient(var(--co-hq-band) 0 5px, rgba(0,0,0,0.22) 5px 6px, var(--co-hq-stripe) 6px 8px); }
.co-hq .co-letter-rule { border-top-color: color-mix(in srgb, var(--co-hq-ink) 55%, var(--co-rule)); }
.co-hq-head { position: relative; }
.co-hq-head .co-mval { padding-top: 3px; overflow-wrap: anywhere; }
.co-hq-head .co-mrow:nth-child(2) .co-mval, .co-hq-head .co-mrow:nth-child(3) .co-mval { padding-right: 124px; }
.co-hq-subject { font-weight: 700; }
.co-hq-stamp { position: absolute; right: 2px; top: 2px; padding: 4px 6px 3px; border: 2px solid var(--co-hq-ink); border-radius: 3px;
  box-shadow: inset 0 0 0 1px var(--co-paper), inset 0 0 0 2px var(--co-hq-ink); transform: rotate(-7deg); opacity: 0.88;
  mix-blend-mode: multiply; pointer-events: none; line-height: 0; }
.co-hq-stamp canvas { image-rendering: pixelated; display: block; }
.co-hq-body { margin: 12px 0 4px; font-size: 13px; line-height: 1.55; }
.co-hq-body p { margin: 0 0 8px; text-wrap: pretty; }
.co-hq-busy { display: flex; align-items: center; gap: 10px; margin: 6px 0 4px; color: var(--co-ink-dim); font-size: 12px; }
.co-hq-busy[hidden] { display: none; }
.co-hq-belt { display: inline-grid; grid-auto-flow: column; gap: 2px; padding: 2px; border: 1px solid var(--co-rule); background: var(--co-field); }
.co-hq-belt i { width: 6px; height: 6px; background: var(--co-hq-ink); opacity: 0.18; animation: co-hq-belt 1.2s steps(1) infinite; }
${Array.from({ length: 10 }, (_, i) => `.co-hq-belt i:nth-child(${i + 1}) { animation-delay: ${(i * 0.12).toFixed(2)}s; }`).join('\n')}
@keyframes co-hq-belt { 0% { opacity: 1; } 30% { opacity: 0.55; } 60%, 100% { opacity: 0.18; } }
.co-hq-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 12px; padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--co-rule) 55%, transparent); }
.co-hq-foot:empty, .co-hq-foot .co-actions:empty { display: none; }
.co-hq .co-secondary { background: var(--co-field); color: var(--co-ink); border-color: color-mix(in srgb, var(--co-hq-ink) 60%, var(--co-rule)); }
.co-hq .co-secondary:not(:disabled):hover { background: color-mix(in srgb, var(--co-hq-ink) 10%, var(--co-field)); }
.co-hq .co-hq-link { font-size: 12.5px; color: var(--co-hq-ink); }
.co-hq .co-hq-link:hover { color: var(--co-ink); }
.co-hq-desk { margin-top: 10px; font-size: 12px; color: var(--co-ink-dim); }
.co-hq-desk .co-link { color: var(--co-ink-dim); font-size: 12px; }
.co-hq-desk .co-link:hover { color: var(--co-ink); }
/* Narrow sidebars: the stamp moves above the lines instead of over them, the buttons stack full width. */
@media (max-width: 400px) {
  .co-hq { padding: 14px 14px 14px; }
  .co-hq-head .co-mrow:nth-child(2) .co-mval, .co-hq-head .co-mrow:nth-child(3) .co-mval { padding-right: 0; }
  .co-hq-stamp { position: static; display: inline-block; margin: 0 0 6px 2px; transform: rotate(-4deg); }
  .co-hq-foot .co-actions { flex-direction: column; align-items: stretch; width: 100%; }
}
body.vscode-high-contrast .co-hq-stamp, body.vscode-high-contrast-light .co-hq-stamp { mix-blend-mode: normal; opacity: 1; }
body.vscode-high-contrast .co-hq::before, body.vscode-high-contrast-light .co-hq::before { height: 4px; background: var(--co-letterhead); }
@media (prefers-reduced-motion: reduce) {
  .co-hq-belt i { animation: none; }
  .co-hq-belt i:nth-child(-n+4) { opacity: 1; }
}
`;

let stylesIn = false;
function injectStyles(): void {
  if (stylesIn) return;
  stylesIn = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** A pixel-text canvas, `scale` CSS px per pixel. */
function pixelText(text: string, scale: number, color: string, shadow?: string): HTMLCanvasElement {
  const m = measurePixelText(text);
  const c = document.createElement('canvas');
  c.width = Math.max(1, m.w + 1);
  c.height = m.h + 1;
  c.style.width = `${c.width * scale}px`;
  const ctx = c.getContext('2d');
  if (ctx) drawPixelText(ctx, text, 0, 0, color, 1, shadow);
  c.setAttribute('aria-hidden', 'true');
  return c;
}

const isHc = (): boolean => document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');

export class UpdateMemoView {
  private readonly deps: UpdateMemoDeps;
  private readonly back: HTMLDivElement;
  private readonly paper: HTMLDivElement;
  private readonly letterhead: HTMLDivElement;
  private readonly dateEl: HTMLSpanElement;
  private readonly toEl: HTMLDivElement;
  private readonly fromEl: HTMLDivElement;
  private readonly subjectEl: HTMLDivElement;
  private readonly stamp: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly busy: HTMLDivElement;
  private readonly busyText: HTMLSpanElement;
  private readonly foot: HTMLDivElement;
  private returnFocus: Element | null = null;
  private letterKey = '';
  private stampKey = '';
  /** An action was posted and the host has not answered yet: the buttons stay disabled until the next update. */
  private waiting = false;

  constructor(parent: HTMLElement, deps: UpdateMemoDeps) {
    injectUiStyles();
    injectStyles();
    this.deps = deps;
    this.back = h('div', { class: 'co-memo-back co-ui co-hq-back' });
    this.back.hidden = true;
    this.back.addEventListener('mousedown', (e) => { if (e.target === this.back) this.close(); });
    this.letterhead = h('div', { class: 'co-letterhead', role: 'img' });
    this.dateEl = h('span');
    this.fromEl = h('div', { class: 'co-mval co-from' });
    this.toEl = h('div', { class: 'co-mval' });
    this.subjectEl = h('div', { class: 'co-mval co-hq-subject', id: 'co-hq-subject' });
    this.stamp = h('div', { class: 'co-hq-stamp', 'aria-hidden': 'true' });
    this.body = h('div', { class: 'co-hq-body', id: 'co-hq-body' });
    this.busyText = h('span');
    const belt = h('span', { class: 'co-hq-belt', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, () => h('i')));
    this.busy = h('div', { class: 'co-hq-busy', role: 'status' }, belt, this.busyText);
    this.busy.hidden = true;
    this.foot = h('div', { class: 'co-hq-foot' });
    const desk = h('div', { class: 'co-hq-desk' },
      button('Open the Front desk', 'co-link', () => { this.close(); this.deps.openFrontDesk(); }, { title: 'Theme, names, colours, settings and the About tab' }));
    const close = button('×', 'co-icon-btn', () => this.close(), { 'aria-label': 'Close memo (Esc)', title: 'Close (Esc)' });
    this.paper = h('div', {
      class: 'co-memo co-hq', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'co-hq-subject', 'aria-describedby': 'co-hq-body', tabindex: '-1',
    },
    this.letterhead,
    h('hr', { class: 'co-letter-rule' }),
    h('div', { class: 'co-memo-kicker' }, h('span', { text: 'INTEROFFICE MEMO' }), this.dateEl),
    h('div', { class: 'co-hq-head' },
      this.stamp,
      h('div', { class: 'co-mrow' }, h('div', { class: 'co-mlabel', text: 'FROM:' }), this.fromEl),
      h('div', { class: 'co-mrow' }, h('div', { class: 'co-mlabel', text: 'TO:' }), this.toEl),
      h('div', { class: 'co-mrow' }, h('div', { class: 'co-mlabel', text: 'RE:' }), this.subjectEl)),
    this.body,
    this.busy,
    this.foot,
    desk,
    close);
    this.paper.addEventListener('keydown', (e) => this.onKey(e));
    this.back.appendChild(this.paper);
    parent.appendChild(this.back);
    onUpdate((u) => this.onInfo(u));
  }

  get isOpen(): boolean {
    return !this.back.hidden;
  }

  /** Opens the memo for the current update info; false (and nothing opens) when there is nothing to say. */
  open(): boolean {
    const memo = this.memoFor(getUpdate());
    if (!memo) return false;
    if (!this.isOpen) this.returnFocus = document.activeElement;
    this.back.hidden = false;
    this.waiting = false;
    this.dateEl.textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    this.render(memo);
    requestAnimationFrame(() => this.paper.focus({ preventScroll: true }));
    return true;
  }

  close(): void {
    if (!this.isOpen) return;
    this.back.hidden = true;
    this.waiting = false;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  }

  /** The theme or the names changed: repaint the letterhead and the accents (cheap when nothing changed). */
  refresh(): void {
    if (!this.isOpen) return;
    this.renderLetterhead();
    this.applyAccent();
  }

  // -------------------------------------------------------------------------

  private memoFor(u: UpdateInfo | undefined): UpdateMemo | undefined {
    const s = this.deps.settings();
    return u ? updateMemo(u, { company: s.companyName || '', branch: s.branchName || '' }) : undefined;
  }

  private onInfo(u: UpdateInfo): void {
    if (!this.isOpen) return;
    const memo = this.memoFor(u);
    if (memoAfterUpdate(u, !!memo) === 'close' || !memo) { this.close(); return; }
    this.waiting = false;
    const hadFocus = this.paper.contains(document.activeElement);
    this.render(memo);
    // The buttons were rebuilt: keep the keyboard inside the memo (on its first button, else the paper).
    if (hadFocus && !this.paper.contains(document.activeElement)) (this.foot.querySelector<HTMLButtonElement>('button') ?? this.paper).focus({ preventScroll: true });
  }

  private render(memo: UpdateMemo): void {
    this.renderLetterhead();
    this.applyAccent();
    this.fromEl.replaceChildren(h('span', { class: 'co-sign', text: memo.from }));
    this.toEl.textContent = memo.to;
    this.subjectEl.textContent = memo.subject;
    this.body.replaceChildren(...memo.paragraphs.map((p) => h('p', { text: p })));
    this.busy.hidden = !memo.busy;
    this.busyText.textContent = memo.busy ? (memo.paragraphs[0]?.includes('Checking') ? 'Asking head office…' : 'On its way…') : '';
    this.renderButtons(memo.busy ? [] : memo.buttons);
  }

  private renderButtons(buttons: MemoButton[]): void {
    const actions = h('div', { class: 'co-actions' });
    let link: HTMLButtonElement | null = null;
    for (const b of buttons) {
      if (b.kind === 'link') {
        link = button(b.label, 'co-link co-hq-link', () => this.act(b.action), { title: 'Opens the release page in your browser' });
        continue;
      }
      const cls = b.kind === 'primary' ? 'co-btn co-primary' : b.kind === 'secondary' ? 'co-btn co-secondary' : 'co-btn co-ghost';
      const el = button(b.label, cls, () => this.act(b.action), { 'data-action': b.action });
      if (this.waiting && b.action !== 'close') el.disabled = true;
      actions.appendChild(el);
    }
    this.foot.replaceChildren(...(actions.childElementCount ? [actions] : []), ...(link ? [link] : []));
  }

  private act(action: UpdateAction | 'close'): void {
    if (action === 'close') { this.close(); return; }
    this.deps.post({ type: 'updateAction', action });
    // The release notes open in the browser; everything else waits for the host's next update.
    if (action === 'notes') return;
    this.waiting = true;
    for (const el of Array.from(this.foot.querySelectorAll<HTMLButtonElement>('.co-actions button'))) {
      if (el.dataset['action'] !== 'close') el.disabled = true;
    }
  }

  private renderLetterhead(): void {
    const s = this.deps.settings();
    const company = (s.companyName || 'Middle Management').toUpperCase();
    const branch = s.branchName || '';
    const cs = getComputedStyle(document.body);
    const ink = cs.getPropertyValue('--co-letterhead').trim() || '#23395b';
    const inkDim = cs.getPropertyValue('--co-ink-dim').trim() || '#6d6252';
    const key = `${company}|${branch}|${ink}|${inkDim}`;
    if (key === this.letterKey) return;
    this.letterKey = key;
    const kids: Node[] = [pixelText(company, 4, ink, isHc() ? undefined : 'rgba(35,57,91,0.25)')];
    if (branch) kids.push(pixelText(branch, 2, inkDim));
    this.letterhead.replaceChildren(...kids);
    this.letterhead.setAttribute('aria-label', branch ? `${s.companyName || 'Middle Management'} — ${branch}` : (s.companyName || 'Middle Management'));
  }

  /** The theme's sign colours on the band and the stamp (CSS variables on the paper; none in high contrast). */
  private applyAccent(): void {
    const paper = getComputedStyle(document.body).getPropertyValue('--co-paper').trim();
    const accent = memoAccent(signColours(), paper, isHc());
    if (accent) {
      this.paper.style.setProperty('--co-hq-ink', accent.ink);
      this.paper.style.setProperty('--co-hq-band', accent.band);
      this.paper.style.setProperty('--co-hq-stripe', accent.stripe);
    } else {
      this.paper.style.removeProperty('--co-hq-ink');
      this.paper.style.removeProperty('--co-hq-band');
      this.paper.style.removeProperty('--co-hq-stripe');
    }
    const ink = accent?.ink ?? (getComputedStyle(document.body).getPropertyValue('--co-letterhead').trim() || '#23395b');
    if (ink === this.stampKey) return;
    this.stampKey = ink;
    this.stamp.replaceChildren(pixelText('HEAD OFFICE', 2, ink));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the memo.
      const f = Array.from(this.paper.querySelectorAll<HTMLElement>('button')).filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === this.paper)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
}
