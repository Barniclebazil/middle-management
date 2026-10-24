/**
 * The Front desk's About tab: the version, when the last update check ran, what the check found and the buttons that go with it,
 * all from `aboutView(getUpdate(), ...)`. The Check button and the install buttons post `updateAction` to the host (which owns
 * the update); the tab re-renders when the update store changes and each time it is shown (so "3 minutes ago" stays honest).
 * The Release notes link posts `updateAction{notes}`: the webview cannot open a URL and never sends one, the host opens the stored page.
 * Text nodes only.
 */
import type { FrontDeskTabApi, FrontDeskTabView } from './frontDeskPanel.ts';
import { aboutView, type MemoButton } from './updateLogic.ts';
import { getUpdate, onUpdate } from './updateStore.ts';
import { button, h } from './dom.ts';

const STYLE = `
.co-fd-about { display: flex; flex-direction: column; gap: 12px; }
.co-fd-about-card { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px 12px; }
.co-fd-about-version { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.co-fd-about-line { margin: 0; font-size: 12.5px; overflow-wrap: anywhere; }
.co-fd-about-line:empty { display: none; }
.co-fd-about-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.co-fd-about-auto { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.co-fd-about-auto .co-link { font-size: 12px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const KIND_CLASS = { primary: 'co-primary', secondary: 'co-secondary', ghost: 'co-ghost' } as const;

function post(api: FrontDeskTabApi, action: Exclude<MemoButton['action'], 'close'>): void {
  api.ctx.post({ type: 'updateAction', action });
}

/** Builds the About tab. Registered in `frontDeskPanel.ts`. */
export function createAboutTab(api: FrontDeskTabApi): FrontDeskTabView {
  injectCss();
  const root = h('div', { class: 'co-fd-about' });

  function render(): void {
    const v = aboutView(getUpdate(), Date.now(), '');
    const active = document.activeElement;
    const key = active instanceof HTMLElement && root.contains(active) ? active.dataset['k'] : undefined;
    const buttons = v.buttons.filter((b) => b.action !== 'close').map((b) => {
      const act = b.action;
      if (act === 'close') return button(b.label, 'co-link', () => {});
      const el = button(b.label, b.kind === 'link' ? 'co-link' : `co-btn ${KIND_CLASS[b.kind]}`, () => post(api, act), { 'data-k': `act-${act}` });
      if (b.action === 'check' && v.checking) el.disabled = true;
      return el;
    });
    root.replaceChildren(
      h('div', { class: 'co-fd-card co-fd-about-card' },
        h('p', { class: 'co-fd-about-version', text: v.versionLine }),
        h('p', { class: 'co-fd-hint co-fd-about-line', text: `Last checked: ${v.lastChecked}` }),
        h('p', { class: 'co-fd-about-line', role: 'status', 'aria-live': 'polite', text: v.statusLine }),
        h('div', { class: 'co-fd-about-btns' }, ...buttons),
        h('div', { class: 'co-fd-about-auto' },
          h('span', { class: 'co-fd-hint', text: v.autoLine }),
          button('Change in Settings', 'co-link', () => { api.openTab('settings'); }, { 'data-k': 'to-settings' }))),
    );
    if (key !== undefined) root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  render();
  const off = onUpdate(render);
  return {
    el: root,
    refresh(reason) { if (reason === 'show' || reason === 'state') render(); },
    unmount() { off(); },
  };
}
