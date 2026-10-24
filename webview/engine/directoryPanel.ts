/**
 * The Directory panel: the lobby board in list form. One button per entry (icon, label, a line of hint) that opens
 * the matching panel or the new-task memo. The entries come from a provider function (`directoryEntries(rounds)` in
 * `hotspots.ts`), so Round B entries appear without this file changing. Hovering or focusing an entry calls `onHover`
 * with its prop, like the icon bar does.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import { NEW_TASK, entriesKey } from './directoryLogic.ts';
import type { DirectoryEntryLike } from './directoryLogic.ts';
import { h } from './dom.ts';

export type { DirectoryEntryLike } from './directoryLogic.ts';

export interface DirectoryDeps {
  /** The current entries (called on mount and on every refresh). */
  entries(): readonly DirectoryEntryLike[];
  /** Open a panel by id. Not called for 'newTask'. An id with no registered panel should be ignored by the caller. */
  openPanel(panel: string): void;
  /** Icon factory (`pixelIcon` in the webview). */
  icon(name: string): HTMLElement;
  /** An entry with a prop was hovered or focused (its prop id), or the pointer or focus left (null). */
  onHover?(prop: string | null): void;
}

const CSS = `
.co-dir { display: flex; flex-direction: column; gap: 10px; }
.co-dir-intro { margin: 0; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
.co-dir-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.co-dir-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; min-height: 48px; text-align: left; cursor: pointer;
  font: inherit; color: var(--vscode-foreground, #cccccc); background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)))); border-radius: 5px; }
.co-dir-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.18)); border-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, rgba(0,127,212,0.6))); }
.co-dir-item:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-dir-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-foreground, #cccccc) 8%, transparent); }
.co-dir-icon canvas { image-rendering: pixelated; }
.co-dir-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.co-dir-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-dir-hint { font-size: 12px; line-height: 16px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-dir-go { flex: none; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 16px; line-height: 1; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Builds the Directory panel. Register it under id `directory`. */
export function createDirectoryPanel(deps: DirectoryDeps): PanelView<HTMLElement> {
  let list: HTMLUListElement | null = null;
  let ctx: PanelContext<HTMLElement> | null = null;
  let shown = '';

  function render(): void {
    if (!list) return;
    const entries = deps.entries();
    const key = entriesKey(entries);
    if (key === shown) return;
    shown = key;
    const activeKey = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['entry'] : undefined;
    const items = entries.map((e) => {
      const btn = h('button', { type: 'button', class: 'co-dir-item', 'data-entry': e.panel },
        h('span', { class: 'co-dir-icon' }, deps.icon(e.icon)),
        h('span', { class: 'co-dir-text' }, h('span', { class: 'co-dir-label', text: e.label }), h('span', { class: 'co-dir-hint', text: e.hint })),
        h('span', { class: 'co-dir-go', 'aria-hidden': 'true', text: '›' }));
      btn.addEventListener('click', () => {
        if (e.panel === NEW_TASK) ctx?.openMemo();
        else deps.openPanel(e.panel);
      });
      const on = (): void => deps.onHover?.(e.prop ?? null);
      btn.addEventListener('mouseenter', on);
      btn.addEventListener('focus', on);
      btn.addEventListener('mouseleave', () => deps.onHover?.(null));
      btn.addEventListener('blur', () => deps.onHover?.(null));
      return h('li', null, btn);
    });
    list.replaceChildren(...items);
    if (activeKey !== undefined) list.querySelector<HTMLElement>(`[data-entry="${attrEscape(activeKey)}"]`)?.focus({ preventScroll: true });
  }

  return {
    id: 'directory',
    title: 'Directory',
    icon: 'directory',
    mount(body, c) {
      injectCss();
      ctx = c;
      shown = '';
      list = h('ul', { class: 'co-dir-list' });
      body.appendChild(h('div', { class: 'co-dir' }, h('p', { class: 'co-dir-intro', text: 'Everything in the office, in one place.' }), list));
      render();
    },
    refresh() {
      render();
    },
    unmount() {
      deps.onHover?.(null);
      list = null;
      ctx = null;
      shown = '';
    },
  };
}

/** Escapes a value for use inside a double-quoted attribute selector. */
function attrEscape(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}
