/**
 * The Front desk's Theme tab (task 3.10): the current theme source (Built-in office, a ready-made office or your file) with its
 * path, status and problems, and the actions that fit that source. Each action posts `themeAction` and shows pending,
 * done or the host's error from `frontDeskDone`. Switching theme drops unsaved edits, so it asks first when there are
 * some. It also has the "Make one with Claude" card (teach Claude the theme skill, or copy a prompt) and the "Your offices"
 * group of the user's own themes. Text nodes only.
 */
import type { FrontDeskTabApi, FrontDeskTabView } from './frontDeskPanel.ts';
import type { ChangeReason } from './frontDeskController.ts';
import { GROUP_HEADINGS, changesSource, doneText, makeView, pendingText, resultSlot, skillSummary, sourceView, themeActions, userThemesEmptyText, workspaceThemeLine } from './frontDeskView.ts';
import type { MakeView, StatusLine, ThemeActionSpec } from './frontDeskView.ts';
import type { ThemeActionKind, ThemeSkillStatus } from '../../src/shared/protocol.ts';
import { button, h } from './dom.ts';

const STYLE = `
.co-fd-theme { display: flex; flex-direction: column; gap: 14px; }
.co-fd-src-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.co-fd-src-title { margin: 0; min-width: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.co-fd-path { margin: 0; padding: 3px 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace); font-size: 11.5px;
  overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14)); }
.co-fd-status { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.co-fd-status li { display: flex; gap: 7px; align-items: baseline; font-size: 12.5px; overflow-wrap: anywhere; }
.co-fd-status .mark { flex: none; width: 14px; text-align: center; font-weight: 700; }
.co-fd-status .ok .mark { color: var(--co-ok-text, var(--vscode-testing-iconPassed, #73c991)); }
.co-fd-status .warn .mark { color: var(--co-warn-text, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-status .error .mark { color: var(--vscode-errorForeground, #f48771); }
/* A ringed "i", so the info mark reads as an icon and not as a stray letter. */
.co-fd-status .info .mark { color: var(--vscode-descriptionForeground, #9d9d9d); width: 12px; height: 12px; margin: 0 1px; box-sizing: border-box; align-self: center;
  display: inline-flex; align-items: center; justify-content: center; border: 1px solid currentColor; border-radius: 50%; font: 700 9px/1 var(--vscode-font-family, sans-serif); }
.co-fd-ro { margin: 0; padding: 6px 9px; border-radius: 4px; font-size: 12px; overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--vscode-foreground, #cccccc) 7%, transparent);
  border-left: 3px solid var(--vscode-contrastBorder, var(--vscode-descriptionForeground, #9d9d9d)); }
.co-fd-probs-h { margin: 2px 0 0; font-size: 12px; font-weight: 600; color: var(--co-warn-text, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-probs { margin: 0; padding: 0 0 0 18px; max-height: 168px; overflow-y: auto; font-size: 12px; overflow-wrap: anywhere; scrollbar-width: thin; }
.co-fd-probs li + li { margin-top: 2px; }
.co-fd-acts { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.co-fd-group { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.co-fd-group-h { margin: 4px 0 0; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-group-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr)); gap: 8px 10px; margin: 0; padding: 0; list-style: none; }
.co-fd-act { display: flex: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.co-fd-act .co-btn { max-width: 100%; white-space: normal; text-align: left; }
.co-fd-act-hint { margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); overflow-wrap: anywhere; }
.co-fd-result { margin: 0; min-height: 18px; font-size: 12.5px; overflow-wrap: anywhere; }
.co-fd-result.pending { color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-result.ok { color: var(--co-ok-text, var(--vscode-testing-iconPassed, #73c991)); }
.co-fd-result.error { color: var(--vscode-errorForeground, #f48771); }
.co-fd-result.in-card { min-height: 0; }
.co-fd-result.in-card:empty { display: none; }
.co-fd-act-warn { margin: 0; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; color: var(--co-warn-text, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-make-status { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-switch { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 4px; font-size: 12.5px;
  background: color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 45%, transparent); }
.co-fd-switch p { margin: 0; }
.co-fd-switch-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.co-fd-make > summary { cursor: pointer; border-radius: 3px; }
.co-fd-make > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-fd-make[open] > summary { margin-bottom: 4px; }
.co-fd-make-body { display: flex; flex-direction: column; gap: 10px; }
.co-fd-make-body p { margin: 0; font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; }
.co-fd-quote { margin: 0; padding: 6px 10px; border-radius: 4px; font-size: 12.5px; font-style: italic; line-height: 1.4; overflow-wrap: anywhere;
  background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.14));
  border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-contrastBorder, var(--vscode-descriptionForeground, #9d9d9d))); }
.co-fd-steps { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0 0 0 20px; font-size: 12.5px; }
.co-fd-steps > li { padding-left: 2px; overflow-wrap: anywhere; }
.co-fd-steps > li::marker { font-weight: 600; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-step-body { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 4px; }
.co-fd-step-body .co-fd-switch { align-self: stretch; }
.co-fd-step-btns { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.co-fd-make-ok { color: var(--co-ok-text, var(--vscode-testing-iconPassed, #73c991)); font-weight: 600; }
.co-fd-make-foot { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3))); }
.co-fd-make-foot .co-fd-act-hint { margin: 0; }
`;

/** The user's open or closed choice for the "Make one with Claude" card; null until they make one. Survives re-renders. */
let makeOpen: boolean | null = null;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const MARKS: Record<StatusLine['tone'], string> = { ok: '✓', warn: '!', error: '✕', info: 'i' };

type Result = { kind: 'pending' | 'ok' | 'error'; text: string; action: ThemeActionKind } | null;

/** Builds the Theme tab. Registered in `frontDeskPanel.ts`. */
export function createThemeTab(api: FrontDeskTabApi): FrontDeskTabView {
  injectCss();
  const root = h('div', { class: 'co-fd-theme' });
  let result: Result = null;
  /** Set when a result was just set, so the next render scrolls its line into view once. */
  let scrollResult = false;
  /** The running action's request id; actions are disabled while it waits. */
  let running: string | null = null;
  /** A source-changing action waiting for "Switch anyway" because of unsaved edits. */
  let asking: ThemeActionSpec | null = null;
  let dead = false;

  function run(spec: ThemeActionSpec): void {
    asking = null;
    result = { kind: 'pending', text: pendingText(spec.action), action: spec.action };
    const reqId = api.request(
      (id) => ({
        type: 'themeAction', reqId: id, action: spec.action,
        ...(spec.presetId !== undefined ? { presetId: spec.presetId } : {}),
        ...(spec.themeId !== undefined ? { themeId: spec.themeId } : {}),
      }),
      (r) => {
        if (dead) return;
        if (running !== reqId) return;
        running = null;
        if (r.cancelled === true) result = null;
        else {
          result = r.ok ? { kind: 'ok', text: doneText(spec.action), action: spec.action } : { kind: 'error', text: r.message ?? 'That did not work.', action: spec.action };
          scrollResult = true;
        }
        render();
      },
    );
    running = reqId;
    render();
  }

  function choose(spec: ThemeActionSpec): void {
    if (running !== null) return;
    if (spec.confirm !== undefined || (changesSource(spec.action) && api.isDirty())) {
      asking = spec;
      result = null;
      render();
      return;
    }
    run(spec);
  }

  /** The "are you sure" block for a source switch with unsaved edits, or for a spec with its own `confirm` text. */
  function confirmBlock(spec: ThemeActionSpec): HTMLElement {
    const plain = spec.label.replace(/…$/, '');
    return h('div', { class: 'co-fd-switch', role: 'alertdialog', 'aria-label': spec.confirm !== undefined ? `${plain}?` : 'Discard unsaved changes?' },
      h('p', { text: spec.confirm ?? 'You have unsaved changes. Switching theme discards them.' }),
      h('div', { class: 'co-fd-switch-btns' },
        button(`${plain} anyway`, 'co-btn co-danger co-small', () => { run(spec); }, { 'data-k': 'switch-anyway' }),
        button('Cancel', 'co-btn co-secondary co-small', () => { asking = null; render(); }, { 'data-k': 'switch-cancel' })));
  }

  /** The result line for one slot: filled only when the last action's result belongs there. */
  function resultLine(slot: ReturnType<typeof resultSlot>): HTMLElement {
    const mine = result !== null && resultSlot(result.action) === slot ? result : null;
    return h('p', {
      class: `co-fd-result ${mine?.kind ?? ''}${slot === 'bottom' ? '' : ' in-card'}`, 'data-slot': slot,
      role: mine?.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite', text: mine?.text ?? '',
    });
  }

  /** The "Make one with Claude" card. Open until the skill is installed or there is a theme of your own, unless the user chose. */
  function makeCard(skill: ThemeSkillStatus, make: MakeView, userCount: number, specButton: (a: ThemeActionSpec, onClick?: () => void) => HTMLButtonElement): HTMLElement {
    const wanted = makeOpen ?? (skill !== 'installed' && userCount === 0);
    const details = h('details', { class: 'co-fd-card co-fd-make', ...(wanted ? { open: true } : {}) });
    // Setting `open` fires `toggle` too; only a change from what was drawn is the user's.
    details.addEventListener('toggle', () => { if (details.open !== wanted) makeOpen = details.open; });
    // The card must not close under the click that fixes the thing it was open for.
    const act = (a: ThemeActionSpec) => (): void => { if (makeOpen === null) makeOpen = wanted; choose(a); };
    const stepOne = h('div', { class: 'co-fd-step-body' });
    if (make.text !== undefined) stepOne.append(h('p', { class: skill === 'installed' ? 'co-fd-make-ok' : '', text: make.text }));
    if (make.buttons.length > 0) stepOne.append(h('div', { class: 'co-fd-step-btns' }, ...make.buttons.map((b) => specButton(b, act(b)))));
    stepOne.append(resultLine('step'));
    if (asking?.confirm !== undefined) stepOne.append(confirmBlock(asking));
    if (make.hint !== undefined) stepOne.append(h('p', { class: 'co-fd-act-hint', text: make.hint }));
    stepOne.append(h('p', { class: 'co-fd-path', title: make.skillFolder, text: make.skillFolder }));
    const summary = skillSummary(skill);
    const copy: ThemeActionSpec = { id: 'copy-prompt', label: 'Copy a prompt', action: 'copyPrompt', variant: 'secondary' };
    details.append(
      h('summary', { class: 'co-fd-h' }, 'Make one with Claude', summary !== undefined ? h('span', { class: 'co-fd-make-status', text: summary }) : null),
      h('div', { class: 'co-fd-make-body' },
        h('p', { text: 'Describe the office you want and Claude Code writes the theme: names, job titles, everything people say, their looks and the colours of the rooms and furniture.' }),
        h('p', { class: 'co-fd-quote', text: '“Make me a Middle Management theme set on a pirate ship where everyone talks like a pirate.”' }),
        h('ol', { class: 'co-fd-steps' },
          h('li', null, 'Teach Claude how, once.', stepOne),
          h('li', { text: 'Say it in any Claude Code chat, in your own words.' }),
          h('li', { text: 'Pick it under Your offices below. It shows up as soon as Claude saves it.' })),
        h('div', { class: 'co-fd-make-foot' },
          h('p', { text: 'Rather not add a skill?' }),
          specButton(copy, act(copy)),
          resultLine('foot'),
          h('p', { class: 'co-fd-act-hint', text: 'Copies a full prompt with everything Claude needs. Paste it into Claude and add your idea.' }))));
    return details;
  }

  function render(): void {
    if (dead) return;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && root.contains(active) ? active.dataset['k'] : undefined;
    const state = api.hostState();
    const src = sourceView(state.source);

    const card = h('section', { class: 'co-fd-card', 'aria-label': 'Current theme' },
      h('div', { class: 'co-fd-src-head' }, h('h3', { class: 'co-fd-src-title', text: src.title }), h('span', { class: 'co-fd-chip', text: src.kindLabel })));
    if (src.path !== undefined) card.append(h('p', { class: 'co-fd-path', title: src.path, text: src.path }));
    card.append(h('ul', { class: 'co-fd-status' }, ...src.statusLines.map((l) =>
      h('li', { class: l.tone }, h('span', { class: 'mark', 'aria-hidden': 'true', text: MARKS[l.tone] }), h('span', { text: l.text })))));
    if (src.readOnlyNote !== undefined) card.append(h('p', { class: 'co-fd-ro', text: src.readOnlyNote }));
    if (src.errors.length > 0) {
      card.append(h('p', { class: 'co-fd-probs-h', text: src.errors.length === 1 ? '1 problem' : `${src.errors.length} problems` }),
        h('ul', { class: 'co-fd-probs', tabindex: '0', 'aria-label': 'Problems in the theme file' }, ...src.errors.map((e) => h('li', { text: e }))));
    }

    const busy = running !== null;
    const actions = themeActions(state.source, state.presets, state);
    const make = state.make !== undefined ? makeView(state.make) : null;
    // A skill question about buttons that are no longer there (the skill changed under it) is dropped.
    if (asking?.confirm !== undefined && !(make?.buttons ?? []).some((b) => b.id === asking?.id)) asking = null;
    const specButton = (a: ThemeActionSpec, onClick: () => void = () => { choose(a); }): HTMLButtonElement => {
      const cls = `co-btn ${a.variant === 'primary' ? 'co-primary' : a.variant === 'secondary' ? 'co-secondary' : 'co-ghost'}`;
      const btn = button(a.label, cls, onClick, { 'data-k': a.id });
      if (a.ariaLabel !== undefined) btn.setAttribute('aria-label', a.ariaLabel);
      btn.disabled = busy || a.disabled !== undefined;
      if (a.disabled !== undefined) btn.title = a.disabled;
      return btn;
    };
    const item = (a: ThemeActionSpec): HTMLElement => {
      const hint = a.disabled ?? a.hint;
      return h('li', { class: 'co-fd-act' }, specButton(a), hint !== undefined ? h('p', { class: 'co-fd-act-hint', text: hint }) : null,
        a.warn !== undefined ? h('p', { class: 'co-fd-act-warn', text: a.warn }) : null);
    };
    const emptyText = userThemesEmptyText(state);
    // Consecutive actions of one group share a sub-heading and a grid; the rest are a plain column.
    const blocks: HTMLElement[] = [];
    for (let i = 0; i < actions.length;) {
      const g = actions[i]!.group;
      let j = i + 1;
      if (g !== undefined) while (j < actions.length && actions[j]!.group === g) j++;
      const chunk = actions.slice(i, j);
      if (g === undefined) blocks.push(h('ul', { class: 'co-fd-acts' }, ...chunk.map(item)));
      else blocks.push(h('div', { class: 'co-fd-group', role: 'group', 'aria-label': GROUP_HEADINGS[g] },
        h('h4', { class: 'co-fd-group-h', text: GROUP_HEADINGS[g] }),
        g === 'mine' && emptyText !== undefined ? h('p', { class: 'co-fd-act-hint', text: emptyText }) : null,
        h('ul', { class: 'co-fd-group-list' }, ...chunk.map(item))));
      i = j;
    }
    const list = h('div', { class: 'co-fd-acts' }, ...blocks);

    const wsLine = workspaceThemeLine(state.source);
    const kids: (HTMLElement | null)[] = [
      card,
      make !== null && state.make !== undefined ? makeCard(state.make.skill, make, state.userThemes?.length ?? 0, specButton) : null,
      h('section', { 'aria-label': 'Change theme', class: 'co-fd-card' }, h('h3', { class: 'co-fd-h', text: state.source.kind === 'file' ? 'Your theme file' : 'Pick a theme' }), list,
        wsLine !== undefined ? h('div', { class: 'co-fd-act' },
          h('p', { class: 'co-fd-act-hint', text: wsLine }),
          button('Open workspace settings', 'co-btn co-secondary', () => { api.ctx.post({ type: 'openSettingsUi', key: 'themeFile', target: 'workspace' }); }, { 'data-k': 'ws-themeFile' })) : null),
    ];
    // A skill question sits in the Make card, next to its buttons; the unsaved-edits one comes after the theme list.
    if (asking !== null && asking.confirm === undefined) kids.push(confirmBlock(asking));
    kids.push(resultLine('bottom'));

    root.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    if (scrollResult) {
      scrollResult = false;
      // The line may sit below the fold of a short panel; the test DOM has no scrolling.
      const line = result !== null ? root.querySelector<HTMLElement>(`[data-slot="${resultSlot(result.action)}"]`) : null;
      if (line !== null && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'nearest' });
    }
    if (focusKey !== undefined) root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  render();

  return {
    el: root,
    refresh(reason: ChangeReason | 'show') {
      // A new source makes a question about the old one pointless.
      if (reason === 'adopt' || reason === 'state') {
        if (asking !== null && asking.confirm === undefined && !api.isDirty()) asking = null;
      }
      if (reason !== 'draft') render();
    },
    unmount() {
      dead = true;
    },
  };
}
