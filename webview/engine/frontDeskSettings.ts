/**
 * The Front desk's Settings tab (task 3.10): company, branch and manager name, speech bubbles, boss quotes, which sessions
 * appear and usage checks, from `settingsView(state)`. Changes save straight to the user's settings (`setSetting`), with no
 * draft: toggles and selects on change, text on blur or Enter after `validateSettingInput`. A badge says when a
 * workspace setting overrides the user's, or when the theme sets a name that wins. Text nodes only.
 */
import type { FrontDeskSettingKey, FrontDeskSettingValue, FrontDeskState } from '../../src/shared/protocol.ts';
import type { ChangeReason } from './frontDeskController.ts';
import type { FrontDeskTabApi, FrontDeskTabView } from './frontDeskPanel.ts';
import { settingsView } from './frontDeskLogic.ts';
import type { SettingRow } from './frontDeskLogic.ts';
import { editableValue, settingBadges, textCommit } from './frontDeskView.ts';
import { button, h } from './dom.ts';

const STYLE = `
.co-fd-set { display: flex; flex-direction: column; gap: 12px; }
.co-fd-set-intro { margin: 0; }
.co-fd-fields { display: flex; flex-direction: column; padding: 0; gap: 0; }
.co-fd-field { display: flex; flex-direction: column; gap: 5px; padding: 11px 12px; min-width: 0; }
.co-fd-field + .co-fd-field { border-top: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)))); }
.co-fd-field-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.co-fd-label { font-weight: 600; font-size: 12.5px; min-width: 0; overflow-wrap: anywhere; }
.co-fd-field-status { flex: none; font-size: 11.5px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-field-status.ok { color: var(--co-ok-text, var(--vscode-testing-iconPassed, #73c991)); }
.co-fd-field-status.error { color: var(--vscode-errorForeground, #f48771); }
.co-fd-toggle { flex: none; width: 16px; height: 16px; margin: 0; cursor: pointer; accent-color: var(--vscode-focusBorder, #007fd4); }
.co-fd-toggle:focus-visible, .co-fd-select:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-fd-select { width: 100%; min-height: 28px; padding: 4px 6px; font: inherit; font-size: 13px; border-radius: 3px;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #cccccc)); background: var(--vscode-dropdown-background, rgba(128,128,128,0.12));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-contrastBorder, rgba(128,128,128,0.4))); }
.co-fd-input[aria-invalid="true"] { border-color: var(--vscode-errorForeground, #f48771); }
.co-fd-dyn { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.co-fd-dyn:empty { display: none; }
.co-fd-badge { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; max-width: 100%; font-size: 12px; }
.co-fd-badge-tag { display: inline-block; padding: 0 7px; border-radius: 9px; font-size: 11px; line-height: 17px; font-weight: 600;
  color: var(--vscode-foreground, #cccccc);
  background: color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 55%, var(--vscode-contrastBorder, transparent)); }
.co-fd-badge.theme .co-fd-badge-tag { background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 18%, transparent);
  border-color: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 55%, var(--vscode-contrastBorder, transparent)); }
.co-fd-badge-note { color: var(--vscode-descriptionForeground, #9d9d9d); overflow-wrap: anywhere; }
.co-fd-badge-quiet { font-size: 12px; font-style: italic; }
.co-fd-dyn .co-link { font-size: 12px; text-align: left; }
.co-fd-inline-err { margin: 0; font-size: 12px; color: var(--vscode-errorForeground, #f48771); overflow-wrap: anywhere; }
.co-fd-inline-err:empty { display: none; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

interface RowCtl {
  key: FrontDeskSettingKey;
  el: HTMLElement;
  apply(row: SettingRow, state: FrontDeskState): void;
}

type Status = { kind: 'saving' | 'ok' | 'error'; text: string };

function showValue(row: SettingRow, v: FrontDeskSettingValue): string {
  if (row.control === 'toggle') return v === true ? 'on' : 'off';
  if (row.control === 'select') return row.options?.find((o) => o.value === v)?.label ?? String(v);
  return v === '' ? '(empty)' : `“${String(v)}”`;
}

/** Builds the Settings tab. Registered in `frontDeskPanel.ts`. */
export function createSettingsTab(api: FrontDeskTabApi): FrontDeskTabView {
  injectCss();
  let dead = false;
  const status = new Map<FrontDeskSettingKey, Status>();
  /** Latest request id and the value it sent, per key; a control keeps what the user chose until the reply. */
  const sending = new Map<FrontDeskSettingKey, { reqId: string; value: FrontDeskSettingValue | null }>();
  const timers = new Set<number>();
  const rows = new Map<FrontDeskSettingKey, RowCtl>();
  const statusEls = new Map<FrontDeskSettingKey, HTMLElement>();

  function renderStatus(key: FrontDeskSettingKey): void {
    const el = statusEls.get(key);
    if (!el) return;
    const s = status.get(key);
    el.className = `co-fd-field-status ${s?.kind ?? ''}`;
    el.textContent = s?.text ?? '';
  }

  function applyRow(key: FrontDeskSettingKey): void {
    const state = api.hostState();
    const row = settingsView(state).find((r) => r.key === key);
    if (row) rows.get(key)?.apply(row, state);
  }

  function send(key: FrontDeskSettingKey, value: FrontDeskSettingValue | null): void {
    status.set(key, { kind: 'saving', text: 'Saving…' });
    renderStatus(key);
    const reqId = api.request(
      (id) => ({ type: 'setSetting', reqId: id, key, value }),
      (r) => {
        if (dead) return;
        const mine = sending.get(key)?.reqId === reqId;
        if (mine) sending.delete(key);
        if (!mine) return; // a newer change is on its way and will report
        if (r.ok) {
          status.set(key, { kind: 'ok', text: 'Saved' });
          const t = window.setTimeout(() => {
            timers.delete(t);
            if (!dead && status.get(key)?.kind === 'ok') { status.delete(key); renderStatus(key); }
          }, 2500);
          timers.add(t);
        } else {
          status.set(key, { kind: 'error', text: r.message ?? 'Could not save.' });
        }
        renderStatus(key);
        applyRow(key); // shows the host's value (a failed change goes back)
      },
    );
    sending.set(key, { reqId, value });
  }

  function dynamic(row: SettingRow): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const b of settingBadges(row)) {
      const el = h('div', { class: `co-fd-badge ${b.kind}` }, h('span', { class: 'co-fd-badge-tag', text: b.text }));
      if (b.kind === 'workspace') {
        el.append(h('span', { class: 'co-fd-badge-note', text: `The office uses the workspace value: ${showValue(row, row.value)}.` }),
          button(b.linkLabel ?? 'Open workspace settings', 'co-link', () => { api.ctx.post({ type: 'openSettingsUi', key: row.key, target: 'workspace' }); }, { 'data-k': `ws-${row.key}` }));
      } else if (b.note !== undefined) {
        el.append(h('span', { class: 'co-fd-badge-note', text: b.note }));
        if (b.extra !== undefined) el.append(h('span', { class: 'co-fd-badge-note co-fd-badge-quiet', text: b.extra }));
      }
      out.push(el);
    }
    if (row.canReset) {
      out.push(button('Reset to default', 'co-link', () => { send(row.key, null); }, { 'data-k': `reset-${row.key}`, 'aria-label': `Reset ${row.label} to its default` }));
    }
    return out;
  }

  function buildRow(row: SettingRow): RowCtl {
    const key = row.key;
    const id = `co-fd-set-${key}`;
    const statusEl = h('span', { class: 'co-fd-field-status', role: 'status', 'aria-live': 'polite' });
    statusEls.set(key, statusEl);
    const dyn = h('div', { class: 'co-fd-dyn' });
    const err = h('p', { class: 'co-fd-inline-err', id: `${id}-err`, role: 'alert' });
    const hint = h('p', { class: 'co-fd-hint', id: `${id}-hint`, text: row.hint });
    const label = h('label', { class: 'co-fd-label', for: id, text: row.label });
    const head = h('div', { class: 'co-fd-field-head' }, label);
    const el = h('div', { class: 'co-fd-field', 'data-setting': key });
    let applyControl: (v: FrontDeskSettingValue, pending: boolean) => void;

    if (row.control === 'toggle') {
      const box = h('input', { type: 'checkbox', id, class: 'co-fd-toggle', 'aria-describedby': `${id}-hint ${id}-err` });
      box.addEventListener('change', () => { send(key, box.checked); });
      head.append(statusEl, box);
      el.append(head, hint, dyn, err);
      applyControl = (v, pending) => { if (!pending) box.checked = v === true; };
    } else if (row.control === 'select') {
      const sel = h('select', { id, class: 'co-fd-select', 'aria-describedby': `${id}-hint ${id}-err` });
      for (const o of row.options ?? []) sel.append(h('option', { value: o.value, text: o.label }));
      sel.addEventListener('change', () => { send(key, sel.value); });
      head.append(statusEl);
      el.append(head, hint, sel, dyn, err);
      applyControl = (v, pending) => { if (!pending) sel.value = String(v); };
    } else {
      const input = h('input', { type: 'text', id, class: 'co-input co-fd-input', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-hint ${id}-err` });
      let committed = '';
      const commit = (): void => {
        if (dead) return;
        const current = sending.get(key)?.value;
        const r = textCommit(key, input.value, typeof current === 'string' ? current : committed);
        if (r.kind === 'invalid') {
          err.textContent = r.error;
          input.setAttribute('aria-invalid', 'true');
          return;
        }
        err.textContent = '';
        input.removeAttribute('aria-invalid');
        if (r.kind === 'send') send(key, r.value);
        else input.value = typeof current === 'string' ? current : committed; // shows the trimmed text
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape' && (input.value !== committed || err.textContent !== '')) {
          // Escape reverts the typing; the drawer must not also close.
          e.stopPropagation();
          input.value = committed;
          err.textContent = '';
          input.removeAttribute('aria-invalid');
        }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('input', () => {
        if (err.textContent !== '') { err.textContent = ''; input.removeAttribute('aria-invalid'); }
      });
      head.append(statusEl);
      el.append(head, hint, input, dyn, err);
      applyControl = (v, pending) => {
        committed = String(v);
        if (!pending && document.activeElement !== input) input.value = committed;
      };
    }

    return {
      key, el,
      apply(r, state) {
        const pending = sending.has(key);
        applyControl(editableValue(state, key, r), pending);
        keepFocusIn(dyn, () => { dyn.replaceChildren(...dynamic(r)); });
        renderStatus(key);
      },
    };
  }

  function keepFocusIn(container: HTMLElement, rebuild: () => void): void {
    const active = document.activeElement;
    const k = active instanceof HTMLElement && container.contains(active) ? active.dataset['k'] : undefined;
    rebuild();
    if (k !== undefined) container.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
  }

  const fields = h('div', { class: 'co-fd-card co-fd-fields' });
  for (const row of settingsView(api.hostState())) {
    const ctl = buildRow(row);
    rows.set(row.key, ctl);
    fields.append(ctl.el);
  }
  const root = h('div', { class: 'co-fd-set' },
    h('p', { class: 'co-fd-hint co-fd-set-intro', text: 'Changes here are saved to your user settings straight away.' }), fields);

  function applyAll(): void {
    const state = api.hostState();
    for (const row of settingsView(state)) rows.get(row.key)?.apply(row, state);
  }
  applyAll();

  return {
    el: root,
    refresh(reason: ChangeReason | 'show') {
      if (reason === 'draft') return;
      applyAll();
    },
    unmount() {
      dead = true;
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    },
  };
}
