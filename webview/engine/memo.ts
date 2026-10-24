/**
 * The assignment memo: a paper form on company letterhead for handing out a
 * task to a new hire or an existing worker. Opened by clicking the manager,
 * the "New task" buttons, or from a case file.
 */
import type { MemoPrefill } from '../../src/shared/panels.ts';
import { LIMITS } from '../../src/shared/protocol.ts';
import type { ClaudeDefaults, EffortLevel, HostToWebview, OfficeSettings, PermissionMode, ProjectOption, WebviewToHost } from '../../src/shared/protocol.ts';
import { drawPixelText, measurePixelText } from '../art/index.ts';
import { shortPath } from './caseLogic.ts';
import { autoGrow, branchChip, button, h, isSendKey, pixelIcon, portrait, sendKeyLabel, sprite } from './dom.ts';
import {
  APPROVAL_CHOICES, applyPrefill, assignableWorkers, counterText, defaultProject, memoMessage, memoProblem, memoSummary, orderProjects,
} from './memoLogic.ts';
import type { Assignee, MemoState, WorkerInfo } from './memoLogic.ts';
import { clampEffort, defaultEffortLabel, defaultLabel, defaultModelLabel, effortPips, modelChoices, noEffortNote, planHaikuNote } from './optionsLogic.ts';
import { injectUiStyles } from './uiStyles.ts';

export interface MemoDeps {
  post(msg: WebviewToHost): void;
  settings(): OfficeSettings;
  /** The theme's title for the manager's post (the memo signs with it); undefined keeps "Regional Manager". */
  managerTitle?(): string | undefined;
  /** Every worker in the office (the memo filters them). */
  workers(): WorkerInfo[];
  lookOf(id: string): string | null;
  /** A task started (or a reply was sent): open that worker's case file. */
  openCase(agentId: string): void;
  /** The user's Claude Code defaults, when the host has sent them (else the memo uses the last `claudeDefaults` it handled). */
  defaults?(): ClaudeDefaults | null;
}

/**
 * Arrow keys, Home and End for a radio group of buttons (roving tabindex):
 * moving also selects, like native radios. Disabled (or aria-disabled) radios are skipped.
 */
function wireRadioKeys(group: HTMLElement): void {
  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!radios.length) return;
    const i = radios.indexOf(document.activeElement as HTMLButtonElement);
    let n: number;
    if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = radios.length - 1;
    else n = (Math.max(0, i) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length;
    e.preventDefault();
    radios[n]!.click();
    radios[n]!.focus();
  });
}

/** Roving tabindex: only the checked radio (else the first enabled one) is in the Tab order. */
function rove(group: HTMLElement): void {
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const usable = (b: HTMLButtonElement): boolean => !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  const on = radios.find((b) => b.getAttribute('aria-checked') === 'true' && usable(b)) ?? radios.find(usable);
  for (const b of radios) b.tabIndex = b === on ? 0 : -1;
}

const SOURCE_LABEL: Readonly<Record<ProjectOption['source'], string>> = { workspace: 'This window', recent: 'Recent', browsed: 'Browsed' };

function newNonce(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class Memo {
  private readonly deps: MemoDeps;
  private readonly back: HTMLDivElement;
  private readonly paper: HTMLDivElement;
  private readonly letterhead: HTMLDivElement;
  private readonly dateEl: HTMLSpanElement;
  private readonly toEl: HTMLDivElement;
  private readonly fromEl: HTMLDivElement;
  private readonly pickBtn: HTMLButtonElement;
  private readonly list: HTMLDivElement;
  private readonly task: HTMLTextAreaElement;
  private readonly counter: HTMLDivElement;
  private readonly adv: HTMLDetailsElement;
  private readonly advSummary: HTMLElement;
  private readonly optsNote: HTMLDivElement;
  private readonly modelSeg: HTMLDivElement;
  private readonly effortGroup: HTMLDivElement;
  private readonly effortDefault: HTMLButtonElement;
  private readonly pipButtons: HTMLButtonElement[] = [];
  private readonly effortNote: HTMLDivElement;
  private readonly modeCards: HTMLDivElement;
  private readonly modeHint: HTMLDivElement;
  private readonly planNote: HTMLDivElement;
  private readonly summaryText: HTMLSpanElement;
  private readonly errEl: HTMLDivElement;
  private readonly hint: HTMLSpanElement;
  private readonly sendBtn: HTMLButtonElement;

  private projects: ProjectOption[] | null = null;
  private projectPath: string | null = null;
  private preferPath: string | undefined;
  private awaiting: 'list' | 'browse' | null = null;
  private assigneeId: string | null = null;
  private model = '';
  /** null = the default effort for the model. */
  private effort: EffortLevel | null = null;
  private mode: PermissionMode = 'default';
  private lastDefaults: ClaudeDefaults | null = null;
  /** Why the effort just changed by itself (a model switch clamped it); cleared on the next effort pick. */
  private clampNote = '';
  /** Prefill waiting for the project list, and the note it left under "To:". */
  private pendingPrefill: MemoPrefill | null = null;
  private prefillNote = '';
  private modelKey = '';
  private sending: string | null = null;
  /** Nonces of memos sent but not yet started (the case opens when they start, even if the memo was closed). */
  private readonly inFlight = new Set<string>();
  private returnFocus: Element | null = null;
  private letterKey = '';
  private workersKey = '';

  constructor(parent: HTMLElement, deps: MemoDeps) {
    injectUiStyles();
    this.deps = deps;
    this.back = h('div', { class: 'co-memo-back co-ui' });
    this.back.hidden = true;
    this.back.addEventListener('mousedown', (e) => { if (e.target === this.back) this.close(); });

    this.letterhead = h('div', { class: 'co-letterhead', role: 'img' });
    this.dateEl = h('span');
    this.toEl = h('div', { class: 'co-mval' });
    this.fromEl = h('div', { class: 'co-mval co-from' });
    this.pickBtn = h('button', { type: 'button', class: 'co-pick', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', id: 'co-memo-project' });
    this.list = h('div', { class: 'co-list', role: 'listbox', 'aria-label': 'Projects' });
    this.list.hidden = true;
    this.pickBtn.addEventListener('click', () => this.toggleList());
    this.pickBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.toggleList(true); }
    });
    this.list.addEventListener('keydown', (e) => this.listKey(e));

    this.task = h('textarea', {
      id: 'co-memo-task', maxlength: String(LIMITS.promptChars + 1000), rows: '5',
      placeholder: 'What needs doing? e.g. “Fix the flaky login test and explain what was wrong.”',
    });
    this.task.addEventListener('input', () => { autoGrow(this.task, 320); this.errEl.hidden = true; this.update(); });
    this.counter = h('div', { class: 'co-counter', 'aria-live': 'polite' });

    this.modelSeg = h('div', { class: 'co-seg', role: 'radiogroup', 'aria-labelledby': 'co-memo-model-l' });
    wireRadioKeys(this.modelSeg);

    // Effort: "Default (…)" plus five labelled pips that read as a meter.
    this.effortDefault = h('button', { type: 'button', role: 'radio', class: 'co-effort-def', 'aria-checked': 'true', 'data-v': '' }, h('span', { text: 'Default' }));
    this.effortDefault.addEventListener('click', () => this.pickEffort(null));
    const pips = h('div', { class: 'co-pips' });
    for (const p of effortPips(null, '', null)) {
      const b = h('button', { type: 'button', role: 'radio', class: 'co-pip', 'aria-checked': 'false', 'data-v': p.level },
        h('span', { class: 'co-pip-bar', 'aria-hidden': 'true' }), h('span', { class: 'co-pip-label', text: p.label }));
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true' || b.disabled) return;
        this.pickEffort(p.level);
      });
      this.pipButtons.push(b);
      pips.appendChild(b);
    }
    this.effortGroup = h('div', { class: 'co-effort', role: 'radiogroup', 'aria-labelledby': 'co-memo-effort-l' }, this.effortDefault, pips);
    wireRadioKeys(this.effortGroup);
    this.effortNote = h('div', { class: 'co-seg-note co-effort-note', 'aria-live': 'polite' });

    this.modeCards = h('div', { class: 'co-seg', role: 'radiogroup', 'aria-label': 'Approvals' });
    for (const c of APPROVAL_CHOICES) {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-v': c.value, title: c.hint }, h('span', { text: c.label }));
      b.addEventListener('click', () => { this.mode = c.value; this.update(); });
      this.modeCards.appendChild(b);
    }
    wireRadioKeys(this.modeCards);
    this.modeHint = h('div', { class: 'co-seg-note' });
    // `co-effort-note` keeps it visible in the narrow layout, which hides the other notes.
    this.planNote = h('div', { class: 'co-seg-note co-effort-note co-plan-note', role: 'status' });
    this.optsNote = h('div', { class: 'co-seg-note' });
    this.advSummary = h('summary', { text: 'Approvals' });
    this.adv = h('details', { class: 'co-adv' }, this.advSummary,
      h('div', { class: 'co-adv-body' }, h('div', null, this.modeCards, this.modeHint)));
    const options = h('div', { class: 'co-memo-opts' },
      h('div', { class: 'co-orow' }, h('div', { class: 'co-adv-label', id: 'co-memo-model-l', text: 'Model' }), this.modelSeg),
      h('div', { class: 'co-orow' }, h('div', { class: 'co-adv-label', id: 'co-memo-effort-l', text: 'Effort' }), this.effortGroup, this.effortNote),
      this.optsNote);

    this.summaryText = h('span');
    this.errEl = h('div', { class: 'co-memo-err', role: 'alert' });
    this.errEl.hidden = true;
    this.hint = h('span', { class: 'co-hint' });
    this.sendBtn = button([h('span', { text: 'Send memo' }), h('span', { class: 'co-kbd', text: sendKeyLabel() })], 'co-btn co-primary', () => this.send());

    const close = button('×', 'co-icon-btn', () => this.close(), { 'aria-label': 'Close memo (Esc)', title: 'Close (Esc)' });
    this.paper = h('div', { class: 'co-memo', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Assignment memo', tabindex: '-1' },
      h('div', { class: 'co-memo-left' },
        this.letterhead,
        h('hr', { class: 'co-letter-rule' }),
        h('div', { class: 'co-memo-kicker' }, h('span', { text: 'INTEROFFICE MEMO' }), this.dateEl),
        h('div', { class: 'co-mrow' }, h('div', { class: 'co-mlabel', id: 'co-memo-to', text: 'TO:' }), this.toEl),
        h('div', { class: 'co-mrow' }, h('div', { class: 'co-mlabel', text: 'FROM:' }), this.fromEl),
        h('div', { class: 'co-mrow' }, h('label', { class: 'co-mlabel', for: 'co-memo-project', text: 'RE:' }),
          h('div', { class: 'co-mval co-pick-wrap' }, this.pickBtn, this.list))),
      h('div', { class: 'co-memo-right' },
        h('div', { class: 'co-memo-task' }, h('label', { for: 'co-memo-task', text: 'TASK:' }), this.task, this.counter),
        options,
        this.adv,
        this.planNote, // outside the (usually closed) Approvals section, so the cost warning is seen
        h('div', { class: 'co-summary', 'aria-live': 'polite' }, pixelIcon('clipboard', 16), this.summaryText),
        // The error sits in the sticky foot, so it is seen even when the memo scrolls.
        h('div', { class: 'co-memo-foot' }, this.errEl, this.hint,
          h('div', { class: 'co-actions' }, button('Cancel', 'co-btn co-ghost', () => this.close(true), { title: 'Throw this memo away' }), this.sendBtn))),
      // Last in the tab order (it sits in the corner): Tab from the task box reaches Send first.
      close);
    this.paper.addEventListener('keydown', (e) => this.onKey(e));
    // Any new choice means the last error no longer applies.
    this.paper.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.co-seg button, .co-effort button, .co-list-opt, .co-opt') && !this.sending) this.errEl.hidden = true;
    });
    this.back.appendChild(this.paper);
    parent.appendChild(this.back);
    document.addEventListener('pointerdown', (e) => {
      if (!this.list.hidden && !this.list.contains(e.target as Node) && !this.pickBtn.contains(e.target as Node)) this.closeList(false);
    });
  }

  get isOpen(): boolean {
    return !this.back.hidden;
  }

  /**
   * Opens the memo; `fromAgentId` preselects that worker's project, or `projectPath` that folder directly.
   * A `prefill` also fills the task, picks the assignee and options (see `applyPrefill`); it never sends.
   */
  open(fromAgentId: string | null = null, projectPath?: string, prefill?: MemoPrefill): void {
    const from = fromAgentId ? this.deps.workers().find((w) => w.id === fromAgentId) : undefined;
    const target = prefill?.sessionId ? this.deps.workers().find((w) => w.sessionId === prefill.sessionId) : undefined;
    this.preferPath = projectPath ?? prefill?.projectPath ?? from?.cwd ?? target?.cwd;
    this.prefillNote = '';
    this.pendingPrefill = prefill ?? null;
    if (!this.isOpen) this.returnFocus = document.activeElement;
    this.back.hidden = false;
    this.errEl.hidden = true;
    this.assigneeId = null;
    if (this.preferPath && this.projects?.some((p) => p.path === this.preferPath && p.exists)) this.projectPath = this.preferPath;
    if (prefill) {
      if (prefill.prompt !== undefined) this.task.value = prefill.prompt;
      if (this.projects) this.runPrefill(prefill);
    }
    this.awaiting = 'list';
    this.deps.post({ type: 'listProjects' });
    this.renderLetterhead();
    this.dateEl.textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    this.render();
    requestAnimationFrame(() => {
      this.task.focus();
      autoGrow(this.task, 320);
      if (prefill?.prompt) this.task.setSelectionRange(this.task.value.length, this.task.value.length);
    });
  }

  /** Applies the prefill's project, assignee and options to the form (the task text is set once, in `open`). */
  private runPrefill(prefill: MemoPrefill): void {
    const r = applyPrefill(this.state(), { ...prefill, prompt: undefined }, this.deps.workers(), this.projects ?? [], this.defaults());
    this.projectPath = r.state.project?.path ?? this.projectPath;
    this.assigneeId = r.state.assignee.kind === 'worker' ? r.state.assignee.worker.id : null;
    this.model = r.state.model;
    this.effort = r.state.effort ?? null;
    this.mode = r.state.mode;
    this.prefillNote = r.note;
    this.clampNote = r.effortNote;
  }

  /** Closes the memo. `discard` clears the task text (Cancel); otherwise it is kept for next time. */
  close(discard = false): void {
    if (!this.isOpen) return;
    this.closeList(false);
    this.back.hidden = true;
    if (discard) this.task.value = '';
    this.sending = null;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  }

  /** Handles host messages for the memo; returns true when consumed. */
  handle(msg: HostToWebview): boolean {
    if (msg.type === 'claudeDefaults') {
      this.lastDefaults = msg.defaults && typeof msg.defaults === 'object' ? msg.defaults : null;
      this.applyDefaults();
      return false; // others may want it too
    }
    if (msg.type === 'projects') {
      const list = orderProjects(Array.isArray(msg.projects) ? msg.projects.slice(0, LIMITS.projects) : []);
      this.projects = list;
      const has = (p: string | null | undefined): boolean => !!p && list.some((x) => x.path === p && x.exists);
      if (this.awaiting === 'browse' && has(msg.defaultPath)) this.projectPath = msg.defaultPath!;
      else if (this.awaiting === 'list' || !has(this.projectPath)) this.projectPath = defaultProject(list, msg.defaultPath, this.preferPath);
      this.awaiting = null;
      if (this.pendingPrefill) { this.runPrefill(this.pendingPrefill); this.pendingPrefill = null; }
      if (this.isOpen) this.render();
      return true;
    }
    if (msg.type === 'taskStarted') {
      if (!this.inFlight.has(msg.nonce)) return false;
      this.inFlight.delete(msg.nonce);
      if (this.sending === msg.nonce) {
        this.sending = null;
        this.task.value = '';
        this.close();
      }
      this.deps.openCase(msg.agentId);
      return true;
    }
    if (msg.type === 'error' && msg.nonce && this.inFlight.has(msg.nonce)) {
      this.inFlight.delete(msg.nonce);
      if (this.sending === msg.nonce) this.sending = null;
      if (!this.isOpen) {
        this.back.hidden = false;
      }
      this.errEl.textContent = `Couldn’t send the memo: ${String(msg.message ?? 'unknown error').slice(0, LIMITS.errorChars)}`;
      this.errEl.hidden = false;
      this.render();
      return true;
    }
    return false;
  }

  /** Re-renders the worker choices when the office changes (cheap when nothing changed). */
  refresh(): void {
    if (!this.isOpen) return;
    const key = JSON.stringify(this.candidates().map((w) => [w.id, w.title, w.control, w.busy]));
    if (key !== this.workersKey) this.render();
    this.renderLetterhead();
  }

  // -------------------------------------------------------------------------

  private project(): ProjectOption | null {
    return this.projects?.find((p) => p.path === this.projectPath) ?? null;
  }

  private candidates(): WorkerInfo[] {
    return assignableWorkers(this.deps.workers(), this.projectPath);
  }

  private state(): MemoState {
    const worker = this.assigneeId ? this.candidates().find((w) => w.id === this.assigneeId) : undefined;
    const assignee: Assignee = worker ? { kind: 'worker', worker } : { kind: 'new' };
    return { project: this.project(), assignee, model: this.model, effort: this.effort, mode: this.mode, prompt: this.task.value };
  }

  private defaults(): ClaudeDefaults | null {
    return this.deps.defaults?.() ?? this.lastDefaults;
  }

  /** New defaults (or model list): relabel the Model row and keep the chosen effort within what the model supports. */
  private applyDefaults(): void {
    const c = clampEffort(this.defaults(), this.model, this.effort);
    if (c.effort !== this.effort) {
      this.effort = c.effort;
      this.clampNote = c.note ?? '';
    }
    this.renderModelSeg();
    this.update();
  }

  private renderModelSeg(): void {
    const d = this.defaults();
    const choices = modelChoices(d);
    if (this.model && !choices.some((c) => c.value === this.model)) this.model = '';
    const key = JSON.stringify([choices, defaultModelLabel(d)]);
    if (key === this.modelKey) return;
    this.modelKey = key;
    const kids = choices.map((m) => {
      const label = m.value ? m.label : defaultModelLabel(d);
      const title = m.value ? `${m.label}: ${m.hint}` : `${defaultLabel(d)}: ${m.hint}`;
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', title, 'data-v': m.value }, h('span', { text: label }));
      b.addEventListener('click', () => this.pickModel(m.value));
      return b;
    });
    this.modelSeg.replaceChildren(...kids);
  }

  private pickModel(value: string): void {
    this.model = value;
    const c = clampEffort(this.defaults(), value, this.effort);
    this.effort = c.effort;
    this.clampNote = c.note ?? '';
    this.update();
  }

  private pickEffort(level: EffortLevel | null): void {
    this.effort = level;
    this.clampNote = '';
    this.update();
  }

  private renderLetterhead(): void {
    const s = this.deps.settings();
    const company = (s.companyName || 'Middle Management').toUpperCase();
    const branch = s.branchName || '';
    // The ink follows the theme's letterhead colour (white in high contrast, where the navy would vanish on black).
    const cs = getComputedStyle(document.body);
    const ink = cs.getPropertyValue('--co-letterhead').trim() || '#23395b';
    const inkDim = cs.getPropertyValue('--co-ink-dim').trim() || '#6d6252';
    const key = `${company}|${branch}|${ink}|${inkDim}`;
    if (key === this.letterKey) return;
    this.letterKey = key;
    const make = (text: string, scale: number, color: string, shadow?: string): HTMLCanvasElement => {
      const m = measurePixelText(text);
      const c = document.createElement('canvas');
      c.width = Math.max(1, m.w + 1);
      c.height = m.h + 1;
      c.style.width = `${c.width * scale}px`;
      const ctx = c.getContext('2d');
      if (ctx) drawPixelText(ctx, text, 0, 0, color, 1, shadow);
      c.setAttribute('aria-hidden', 'true');
      return c;
    };
    const hc = document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');
    const kids: Node[] = [make(company, 4, ink, hc ? undefined : 'rgba(35,57,91,0.25)')];
    if (branch) kids.push(make(branch, 2, inkDim));
    this.letterhead.replaceChildren(...kids);
    this.letterhead.setAttribute('aria-label', branch ? `${s.companyName} — ${branch}` : s.companyName);
  }

  private render(): void {
    this.renderModelSeg();
    const s = this.deps.settings();
    this.fromEl.replaceChildren(h('span', { class: 'co-sign', text: s.managerName || 'You' }), h('em', { text: `, ${this.deps.managerTitle?.() || 'Regional Manager'}` }));
    this.renderPicker();
    this.renderTo();
    this.update();
  }

  private renderTo(): void {
    const workers = this.candidates();
    this.workersKey = JSON.stringify(workers.map((w) => [w.id, w.title, w.control, w.busy]));
    if (this.assigneeId && !workers.some((w) => w.id === this.assigneeId)) this.assigneeId = null;
    const seg = h('div', { class: 'co-seg', role: 'radiogroup', 'aria-labelledby': 'co-memo-to' });
    const chip = (id: string | null, kids: (Node | string)[], title: string): void => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(this.assigneeId === id), title }, ...kids);
      b.addEventListener('click', () => { this.assigneeId = id; this.prefillNote = ''; this.renderTo(); this.update(); b.focus(); });
      seg.appendChild(b);
    };
    chip(null, [h('span', { text: '+ New hire' })], 'Start a fresh session for this task');
    for (const w of workers) {
      const look = this.deps.lookOf(w.id);
      const how = w.control === 'office' ? (w.busy ? 'Office-run, busy: reads it after the current step' : 'Office-run: gets it right away') : 'Free: picks it up in their own session';
      chip(w.id, [portrait(look, 18), h('span', { text: w.title }), w.control === 'office' ? sprite('memo', 1) : ''], `${w.title}\n${how}`);
    }
    const kids: Node[] = [seg];
    if (this.projectPath && !workers.length && !this.prefillNote) kids.push(h('div', { class: 'co-seg-note', text: 'Nobody on this project can take it right now, so it goes to a new hire.' }));
    if (this.prefillNote) kids.push(h('div', { class: 'co-seg-note co-prefill-note', role: 'status', text: this.prefillNote }));
    this.toEl.replaceChildren(...kids);
  }

  private renderPicker(): void {
    const p = this.project();
    const kids: Node[] = [];
    if (this.awaiting === 'browse') {
      kids.push(h('span', { class: 'co-pick-name' }, h('span', { text: 'Choose a folder in the dialog…' })));
    } else if (!this.projects) {
      kids.push(h('span', { class: 'co-pick-name' }, h('span', { text: 'Loading projects…' })));
    } else if (!p) {
      kids.push(h('span', { class: 'co-pick-name' }, h('span', { text: 'Pick a project folder…' })));
    } else {
      kids.push(h('span', { class: 'co-pick-name' }, h('span', { text: p.name }), branchChip(p.gitBranch),
        p.source === 'workspace' ? h('span', { class: 'co-chip co-ctl', text: 'this window' }) : null));
      kids.push(h('span', { class: 'co-pick-path', text: shortPath(p.path), title: p.path }));
    }
    kids.push(h('span', { class: 'co-pick-caret', 'aria-hidden': 'true', text: '▼' }));
    this.pickBtn.replaceChildren(...kids);
    this.pickBtn.disabled = this.sending !== null;
    this.pickBtn.title = p ? p.path : 'Choose the project folder';
  }

  private buildList(): void {
    const opts: Node[] = [];
    let group = '';
    for (const p of this.projects ?? []) {
      if (p.source !== group) {
        group = p.source;
        opts.push(h('div', { class: 'co-list-group', text: SOURCE_LABEL[p.source] ?? p.source }));
      }
      const b = h('button', {
        type: 'button', class: 'co-list-opt', role: 'option', 'aria-selected': String(p.path === this.projectPath), disabled: !p.exists,
        title: p.exists ? p.path : `${p.path} (missing)`,
      }, h('span', { class: 'co-pick-name' }, h('span', { text: p.name }), branchChip(p.gitBranch),
        p.source === 'workspace' ? h('span', { class: 'co-chip co-ctl', text: 'this window' }) : null,
        !p.exists ? h('span', { class: 'co-chip co-ctl', text: 'missing' }) : null),
      h('span', { class: 'co-pick-path', text: shortPath(p.path) }));
      b.addEventListener('click', () => {
        this.projectPath = p.path;
        this.closeList(true);
        this.render();
      });
      opts.push(b);
    }
    if (opts.length) opts.push(h('div', { class: 'co-list-sep' }));
    const browse = h('button', { type: 'button', class: 'co-list-opt', role: 'option', 'aria-selected': 'false' },
      h('span', { class: 'co-pick-name' }, pixelIcon('folder', 14), h('span', { text: 'Browse…' })), h('span', { class: 'co-pick-path', text: 'Pick any folder on this machine' }));
    browse.addEventListener('click', () => {
      this.awaiting = 'browse';
      this.deps.post({ type: 'browseProject' });
      this.closeList(true);
      this.render();
    });
    opts.push(browse);
    this.list.replaceChildren(...opts);
  }

  private toggleList(open?: boolean): void {
    const show = open ?? this.list.hidden;
    if (!show) { this.closeList(true); return; }
    this.buildList();
    this.list.hidden = false;
    this.pickBtn.setAttribute('aria-expanded', 'true');
    const sel = this.list.querySelector<HTMLButtonElement>('.co-list-opt[aria-selected="true"]') ?? this.list.querySelector<HTMLButtonElement>('.co-list-opt:not(:disabled)');
    sel?.focus();
    sel?.scrollIntoView({ block: 'nearest' });
  }

  private closeList(focusButton: boolean): void {
    if (this.list.hidden) return;
    this.list.hidden = true;
    this.pickBtn.setAttribute('aria-expanded', 'false');
    if (focusButton) this.pickBtn.focus();
  }

  private listKey(e: KeyboardEvent): void {
    const opts = Array.from(this.list.querySelectorAll<HTMLButtonElement>('.co-list-opt:not(:disabled)'));
    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = opts.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length : 0;
      opts[n]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? opts[0] : opts[opts.length - 1])?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeList(true);
    } else if (e.key === 'Tab') {
      this.closeList(false);
    }
  }

  /** Updates everything that depends on the form's values (cheap). */
  private update(): void {
    const st = this.state();
    const sending = this.sending !== null;
    const office = st.assignee.kind === 'worker' && st.assignee.worker.control === 'office';
    const locked = office || sending;
    const d = this.defaults();
    for (const b of Array.from(this.modelSeg.querySelectorAll('button'))) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-v') === this.model));
      b.disabled = locked;
    }
    rove(this.modelSeg);
    // Effort: Default plus the pips for the chosen model.
    const pips = effortPips(d, this.model, this.effort);
    const defLabel = this.effortDefault.firstElementChild;
    if (defLabel) defLabel.textContent = defaultEffortLabel(d, this.model);
    this.effortDefault.title = 'Use the effort level from your Claude Code settings';
    this.effortDefault.setAttribute('aria-checked', String(!this.effort));
    this.effortDefault.disabled = locked;
    pips.forEach((p, i) => {
      const b = this.pipButtons[i]!;
      b.setAttribute('aria-checked', String(p.checked));
      b.dataset['fill'] = p.fill;
      b.title = p.title;
      b.disabled = locked;
      if (p.enabled) b.removeAttribute('aria-disabled');
      else b.setAttribute('aria-disabled', 'true');
    });
    rove(this.effortGroup);
    const note = this.clampNote || noEffortNote(d, this.model) || '';
    if (this.effortNote.textContent !== note) this.effortNote.textContent = note;
    for (const b of Array.from(this.modeCards.querySelectorAll('button'))) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-v') === this.mode));
      b.disabled = locked;
    }
    rove(this.modeCards);
    this.optsNote.textContent = office ? 'They keep their current model, effort and approval settings.' : '';
    this.modeHint.textContent = office ? '' : APPROVAL_CHOICES.find((c) => c.value === this.mode)?.hint ?? '';
    this.planNote.textContent = office ? '' : planHaikuNote(this.model, this.mode) ?? '';
    const modeLabel = APPROVAL_CHOICES.find((c) => c.value === this.mode)?.label ?? '';
    this.advSummary.textContent = office ? 'Approvals: they keep theirs' : `Approvals: ${modeLabel}`;
    const len = this.task.value.length;
    this.counter.textContent = counterText(len);
    this.counter.classList.toggle('over', len > LIMITS.promptChars);
    this.summaryText.textContent = memoSummary(st);
    const problem = memoProblem(st);
    // The Send button already shows its shortcut; the hint is only for what's missing.
    this.hint.textContent = sending ? 'Sending…' : problem && this.task.value.trim() ? problem : '';
    this.sendBtn.disabled = sending || problem !== null || this.awaiting === 'browse';
    const label = this.sendBtn.firstElementChild;
    if (label) label.textContent = sending ? 'Sending…' : office ? 'Send to them' : 'Send memo';
    this.task.disabled = sending;
    this.pickBtn.disabled = sending;
  }

  private send(): void {
    if (this.sending) return;
    const st = this.state();
    const nonce = newNonce();
    const msg = memoMessage(st, nonce);
    if (!msg) { this.update(); return; }
    this.errEl.hidden = true;
    this.deps.post(msg);
    if (msg.type === 'reply' && st.assignee.kind === 'worker') {
      const id = st.assignee.worker.id;
      this.task.value = '';
      this.close();
      this.deps.openCase(id);
      return;
    }
    this.sending = nonce;
    this.inFlight.add(nonce);
    this.update();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.list.hidden) this.closeList(true);
      else this.close();
      return;
    }
    if (isSendKey(e)) {
      e.preventDefault();
      this.send();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the memo.
      const f = Array.from(this.paper.querySelectorAll<HTMLElement>('button, textarea, input, summary, [tabindex="0"]'))
        .filter((x) => !(x as HTMLButtonElement).disabled && x.tabIndex >= 0 && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
}
