/**
 * The Phone panel (the phone on the desk): the MCP servers Claude Code knows about, one "line" each, with a status light,
 * its scope and kind and how many tools it offers. Display logic is in phoneLogic.ts.
 *
 * It asks the host for the `mcp` section of the catalog (`getCatalog`) every time it is opened and when Refresh is pressed.
 * A status can be `pending` at first: the host keeps polling until the lines settle and answers the same `reqId` again, so
 * every `catalog` reply for the current request replaces the list. A reply or error for an older request is ignored.
 *
 * The type carries no command, URL or environment, so there is nothing here that could show one. Signing in is done in
 * Claude Code (`/mcp`); the panel only says so. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { HostToWebview, McpServerItem } from '../../src/shared/protocol.ts';
import { button, h, keepFocus, pixelIcon } from './dom.ts';
import {
  EMPTY_LINES, PHONE_INITIAL, codeParts, connectingNote, phoneHandle, phoneRequested, serverMeta, sortServers, statusLabel, statusTone, summaryLine,
} from './phoneLogic.ts';
import type { PhoneState } from './phoneLogic.ts';

export interface PhoneDeps {
  /** The file room root whose project's servers to list (`getCatalog.rootId`). Leave out for the active workspace folder. */
  rootId?(): string | undefined;
}

// ---------------------------------------------------------------------------
// Styles

const CSS = `
.co-phone { --ph-fg: var(--vscode-foreground, #cccccc); --ph-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --ph-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --ph-focus: var(--vscode-focusBorder, #007fd4); --ph-card: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
  --ph-err: var(--vscode-errorForeground, #f48771); --ph-warn: var(--vscode-editorWarning-foreground, #cca700);
  --ph-ok: var(--vscode-testing-iconPassed, var(--ph-ok-fb, #388a34)); --ph-busy: var(--vscode-charts-blue, var(--vscode-focusBorder, #3794ff));
  display: flex; flex-direction: column; gap: 10px; }
body.vscode-dark .co-phone { --ph-ok-fb: #73c991; }
body.vscode-high-contrast .co-phone { --ph-ok-fb: #89d185; }
.co-phone-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.co-phone-summary { margin: 0; font-size: 12px; color: var(--ph-dim); min-width: 0; overflow-wrap: anywhere; }
.co-phone .co-btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.co-phone-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-phone-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--ph-card); border: 1px solid var(--ph-border);
  border-left-width: 4px; border-radius: 5px; min-width: 0; }
.co-phone-row[data-tone="err"] { border-left-color: var(--ph-err); }
.co-phone-row[data-tone="warn"] { border-left-color: var(--ph-warn); }
.co-phone-row[data-tone="ok"], .co-phone-row[data-tone="busy"] { border-left-color: color-mix(in srgb, var(--ph-fg) 25%, transparent); }
.co-phone-row[data-tone="off"] .co-phone-name { color: var(--ph-dim); }
.co-phone-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
.co-phone-name { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.co-phone-status { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ph-fg); white-space: nowrap; }
.co-phone-light { flex: none; width: 10px; height: 10px; box-sizing: border-box; background: var(--c, var(--ph-dim)); }
.co-phone-light[data-tone="ok"] { --c: var(--ph-ok); border-radius: 50%; }
.co-phone-light[data-tone="err"] { --c: var(--ph-err); transform: rotate(45deg) scale(0.85); }
.co-phone-light[data-tone="warn"] { --c: var(--ph-warn); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.co-phone-light[data-tone="busy"] { background: transparent; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--ph-busy) 30%, transparent);
  border-top-color: var(--ph-busy); animation: co-phone-spin 0.9s linear infinite; }
.co-phone-light[data-tone="off"] { background: transparent; border-radius: 50%; border: 1.5px solid var(--ph-dim); }
.co-phone-light[data-tone="dim"] { background: transparent; border-radius: 50%; border: 1.5px dashed var(--ph-dim); }
@keyframes co-phone-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .co-phone-light[data-tone="busy"] { animation: none; border-style: dotted; border-color: var(--ph-busy); } }
.co-phone-meta { font-size: 12px; color: var(--ph-dim); overflow-wrap: anywhere; }
.co-phone-hint { margin: 3px 0 0; font-size: 12px; color: var(--ph-fg); overflow-wrap: anywhere; }
.co-phone code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; padding: 0 4px; border-radius: 3px; background: color-mix(in srgb, var(--ph-fg) 12%, transparent); }
.co-phone-note { margin: 0; font-size: 11.5px; font-style: italic; color: var(--ph-dim); }
.co-phone-empty { margin: 24px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--ph-dim); overflow-wrap: anywhere; }
.co-phone-empty strong { color: var(--ph-fg); font-size: 13.5px; }
.co-phone-load { display: flex; align-items: center; gap: 8px; color: var(--ph-dim); margin: 8px 0; }
.co-phone-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--ph-fg) 25%, transparent); border-top-color: var(--ph-fg); animation: co-phone-spin 0.8s linear infinite; flex: none; }
@media (prefers-reduced-motion: reduce) { .co-phone-spin { animation: none; border-top-style: dotted; } }
.co-phone-err { padding: 8px 10px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--ph-err) 55%, transparent); background: color-mix(in srgb, var(--ph-err) 11%, transparent);
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; overflow-wrap: anywhere; }
.co-phone-err strong { color: var(--ph-fg); }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** After this long without an answer the panel says so and offers a retry. */
const SLOW_MS = 10_000;

let reqCounter = 0;
function nextReqId(): string {
  reqCounter += 1;
  return `mcp-${reqCounter}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// The panel

/** Builds the Phone panel. Register it under id `phone`. */
export function createPhonePanel(deps: PhoneDeps = {}): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let summaryEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let contentEl: HTMLElement | null = null;
  let state: PhoneState = PHONE_INITIAL;
  let reqId = '';
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSlow(): void {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
  }

  /** `force` = an explicit Refresh or Try again press: the host skips its caches. Opening the panel never forces. */
  function request(force = false): void {
    if (!ctx) return;
    reqId = nextReqId();
    state = phoneRequested(state);
    slow = false;
    clearSlow();
    slowTimer = setTimeout(() => { if (state.loading) { slow = true; render(); } }, SLOW_MS);
    const rootId = deps.rootId?.();
    ctx.post({ type: 'getCatalog', reqId, section: 'mcp', ...(rootId ? { rootId } : {}), ...(force ? { refresh: true as const } : {}) });
    render();
  }

  function row(s: McpServerItem): HTMLElement {
    const tone = statusTone(s.status);
    const label = statusLabel(s.status);
    return h('li', { class: 'co-phone-row', 'data-tone': tone, 'data-status': s.status },
      h('div', { class: 'co-phone-line' },
        h('span', { class: 'co-phone-name', text: s.name }),
        h('span', { class: 'co-phone-status' }, h('span', { class: 'co-phone-light', 'data-tone': tone, 'aria-hidden': 'true' }), h('span', { text: label }))),
      h('div', { class: 'co-phone-meta', text: serverMeta(s) }),
      s.status === 'needsAuth'
        ? h('p', { class: 'co-phone-hint' }, 'Sign in through Claude Code: type ', h('code', { text: '/mcp' }), ' in a session.')
        : null);
  }

  function emptyState(): HTMLElement {
    return h('div', { class: 'co-phone-empty', role: 'status' }, pixelIcon('phone', 32), h('strong', { text: 'No lines on the phone' }),
      h('span', null, ...codeParts(EMPTY_LINES).map((p) => (p.code ? h('code', { text: p.text }) : p.text))));
  }

  function render(): void {
    if (!contentEl || !summaryEl || !refreshBtn) return;
    const servers = state.servers;
    // The summary is a live region: only touch it when the words change. While the first list loads the line below says so.
    let summary = '';
    if (servers) summary = [summaryLine(servers), connectingNote(servers)].filter(Boolean).join(' · ');
    if (summaryEl.textContent !== summary) summaryEl.textContent = summary;
    refreshBtn.textContent = state.loading && servers !== null ? 'Refreshing…' : 'Refresh';
    refreshBtn.setAttribute('aria-disabled', String(state.loading));
    refreshBtn.setAttribute('aria-busy', String(state.loading));

    const nodes: Node[] = [];
    if (state.error) {
      nodes.push(h('div', { class: 'co-phone-err', role: 'alert' },
        h('span', null, h('strong', { text: 'Couldn’t read the lines. ' }), state.error),
        button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' })));
    }
    if (servers === null) {
      if (state.loading) {
        nodes.push(h('div', { class: 'co-phone-load', role: 'status' }, h('span', { class: 'co-phone-spin', 'aria-hidden': 'true' }),
          h('span', { text: slow ? 'Still waiting for an answer…' : 'Checking the lines…' })));
        if (slow) nodes.push(button('Try again', 'co-btn co-secondary co-small', () => request(true), { 'data-fk': 'retry' }));
      }
    } else if (servers.length === 0) {
      if (!state.error) nodes.push(emptyState());
    } else {
      nodes.push(h('ul', { class: 'co-phone-list' }, ...sortServers(servers).map(row)));
      if (state.truncated) nodes.push(h('p', { class: 'co-phone-note', text: 'Only the first lines are shown.' }));
    }
    const restore = keepFocus(contentEl);
    contentEl.replaceChildren(...nodes);
    restore();
  }

  return {
    id: 'phone',
    title: 'Phone',
    icon: 'phone',
    mount(body, c) {
      injectCss();
      ctx = c;
      state = PHONE_INITIAL;
      summaryEl = h('p', { class: 'co-phone-summary', role: 'status' });
      refreshBtn = button('Refresh', 'co-btn co-secondary co-small', () => { if (!state.loading) request(true); }, { title: 'Ask Claude Code for the latest status' });
      contentEl = h('div', { class: 'co-phone-content co-focus-park', tabindex: '-1', style: 'display:flex;flex-direction:column;gap:10px' });
      body.appendChild(h('div', { class: 'co-phone' }, h('div', { class: 'co-phone-top' }, summaryEl, refreshBtn), contentEl));
      request();
    },
    handle(msg: HostToWebview) {
      const next = phoneHandle(state, msg, reqId);
      if (!next) return;
      state = next;
      if (!state.loading) { clearSlow(); slow = false; }
      render();
    },
    unmount() {
      clearSlow();
      reqId = '';
      ctx = null;
      summaryEl = null;
      refreshBtn = null;
      contentEl = null;
    },
  };
}
