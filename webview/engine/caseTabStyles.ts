/**
 * Styles for a case tab (v0.5): the case file in `page` layout, filling its own editor tab like the Claude Code chat. A header
 * across the top, the conversation in a centred reading column, the knock card inline at the end of the thread, and a rounded
 * reply box pinned at the bottom.
 *
 * Layered over `uiStyles.ts` (inject that first): every rule here is scoped to `.co-case.co-page` (or the tab's own body and
 * boot-error classes), so the office drawer is untouched. Colours come from the same tokens (`--co-fg`, `--co-dim`, `--co-border`,
 * `--co-warn`…) and VS Code theme variables, with fallbacks, so dark, light and high contrast all hold.
 */

const CSS = `
body.co-tab-body { margin: 0; padding: 0; height: 100vh; overflow: hidden; background: var(--vscode-editor-background, #1f1f1f); }

.co-case.co-page {
  --co-page-bg: var(--vscode-editor-background, #1f1f1f);
  --co-bg: var(--co-page-bg);
  --co-page-w: 820px;
  --co-page-pad: 28px;
  --co-soft-border: color-mix(in srgb, var(--co-border) 70%, transparent);
  --co-user-bg: var(--vscode-input-background, color-mix(in srgb, var(--co-fg) 6%, var(--co-page-bg)));
  --co-user-border: var(--vscode-contrastBorder, var(--vscode-input-border, var(--co-border)));
  position: fixed; inset: 0; width: auto; z-index: auto; border-left: 0; box-shadow: none; background: var(--co-page-bg);
  font-size: var(--vscode-font-size, 13px);
}
.co-case.co-page:focus, .co-case.co-page:focus-visible { outline: none; }

/* The reading column, shared by the header, the thread and the reply dock so their edges line up at any width. */
.co-case.co-page .co-page-col { width: 100%; max-width: var(--co-page-w); margin: 0 auto; padding: 0 var(--co-page-pad); }

/* ---------------------------------------------------------------- Header */
.co-case.co-page .co-case-head { flex: none; position: relative; padding: 12px 0 10px; background: var(--co-page-bg); border-bottom: 1px solid var(--co-soft-border); }
.co-case.co-page .co-page-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 14px; align-items: start; }
.co-case.co-page .co-page-head > .co-head-top { grid-column: 1; grid-row: 1; padding-right: 0; gap: 12px; align-items: center; min-width: 0; }
.co-case.co-page .co-page-head > .co-head-actions { grid-column: 2; grid-row: 1; margin-top: 2px; flex-wrap: nowrap; }
.co-case.co-page .co-page-head > .co-head-opts, .co-case.co-page .co-page-head > .co-opt-hint { grid-column: 1 / -1; padding-left: 52px; }
.co-case.co-page .co-page-head > .co-head-opts { margin-top: 8px; }
.co-case.co-page .co-head-face { width: 40px; height: 40px; border-radius: 6px; }
.co-case.co-page .co-head-title { font-size: 15px; line-height: 1.3; -webkit-line-clamp: 1; }
.co-case.co-page .co-head-meta { margin-top: 2px; }
.co-case.co-page .co-head-status { margin-top: 2px; }

/* ---------------------------------------------------------------- Thread */
.co-case.co-page .co-case-main { flex: 1 1 0; min-height: 0; }
.co-case.co-page .co-page-scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; scrollbar-gutter: stable both-edges;
  overscroll-behavior: contain; }
.co-case.co-page .co-page-thread { padding-top: 22px; padding-bottom: 30px; }
.co-case.co-page .co-case-body { flex: none; overflow: visible; padding: 0; }
.co-case.co-page .co-new-pill { bottom: 14px; }

.co-case.co-page .co-item { margin: 0 0 18px; }
.co-case.co-page .co-item.co-tool { margin-bottom: 14px; }
.co-case.co-page .co-item.co-tool + .co-item.co-tool { margin-top: -12px; }
.co-case.co-page .co-item.co-reply + .co-item.co-tool, .co-case.co-page .co-item.co-tool + .co-item.co-reply { margin-top: -4px; }

/* Their replies: plain text at a comfortable reading size, like the Claude Code chat. */
.co-case.co-page .co-reply { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
.co-case.co-page .co-md p { margin: 0 0 10px; }
.co-case.co-page .co-md h3 { font-size: 1.12em; margin: 18px 0 8px; line-height: 1.35; }
.co-case.co-page .co-md h4 { font-size: 1.02em; margin: 14px 0 6px; }
.co-case.co-page .co-md ul, .co-case.co-page .co-md ol { margin: 0 0 10px; padding-left: 22px; }
.co-case.co-page .co-md li { margin: 3px 0; }
.co-case.co-page .co-md pre { margin: 4px 0 12px; padding: 10px 12px; border-radius: 6px; font-size: 12.5px; line-height: 1.5; border: 1px solid var(--co-soft-border); }
.co-case.co-page .co-md pre[data-lang] { padding-top: 22px; }
.co-case.co-page .co-md pre[data-lang]::before { top: 5px; left: 12px; }
.co-case.co-page .co-md blockquote { margin: 0 0 10px; padding: 2px 12px; }

/* Your messages: a rounded box, as in the Claude Code chat. The memo kicker stays (small); the signature is the drawer's. */
.co-case.co-page .co-slip { margin-left: 0; padding: 9px 14px 10px; border-radius: 8px; border: 1px solid var(--co-user-border); border-top-width: 1px;
  background: var(--co-user-bg); color: var(--vscode-input-foreground, var(--co-fg)); box-shadow: none; }
.co-case.co-page .co-slip-kicker { color: var(--co-dim); font-size: 10.5px; letter-spacing: 0.08em; margin-bottom: 4px; }
.co-case.co-page .co-slip-text { font-size: var(--vscode-font-size, 13px); line-height: 1.55; }
.co-case.co-page .co-slip-sign { display: none; }

/* Tool steps: one quiet line each, the detail indented under the icon. */
.co-case.co-page .co-tool-head { width: auto; max-width: 100%; min-height: 26px; padding: 3px 10px 3px 8px; gap: 9px; border-radius: 4px; }
.co-case.co-page .co-tool-sum { flex: 0 1 auto; font-size: 12.5px; color: var(--co-fg); opacity: 0.85; }
.co-case.co-page .co-tool-detail { margin: 4px 0 8px 35px; gap: 5px; }
.co-case.co-page .co-pre { font-size: 12px; max-height: 320px; padding: 8px 10px; border-radius: 4px; }
.co-case.co-page .co-tool.sub { margin-left: 18px; }

.co-case.co-page .co-notice { margin: 4px 0 18px; }
.co-case.co-page .co-planitem { padding: 9px 12px 10px; border-radius: 6px; }
.co-case.co-page .co-plan-paper { padding: 12px 16px; }
.co-case.co-page .co-empty { margin: 16vh auto 0; max-width: 420px; }
.co-case.co-page .co-banner { border-radius: 6px; padding: 8px 12px; }
.co-case.co-page .co-banner .co-link { font-size: inherit; }

/* ---------------------------------------------------------------- Knock card, inline at the end of the thread */
.co-case.co-page .co-pending { max-height: none; overflow: visible; margin: 6px 0 4px; padding: 14px 16px 0; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--co-warn) 45%, var(--co-border)); border-top: 3px solid var(--co-warn); }
/* A card taller than the tab keeps its buttons in view: the foot sticks to the bottom of the thread. */
.co-case.co-page .co-card-foot { position: sticky; bottom: 0; margin: 12px -16px 0; padding: 10px 16px 14px; border-radius: 0 0 7px 7px; }
.co-case.co-page .co-card-title { font-size: 15px; margin: 6px 0 10px; }
.co-case.co-page .co-pending .co-knock { margin-bottom: 8px; }
.co-case.co-page .co-pending .co-knock + .co-card-title { margin-top: -2px; }
.co-case.co-page .co-pending .co-plan-paper { max-height: min(56vh, 560px); }
.co-case.co-page .co-opt { padding: 8px 10px; border-radius: 6px; }
.co-case.co-page .co-opts { gap: 6px; }
.co-case.co-page .co-q { margin: 0 0 14px; }
.co-case.co-page .co-fields { gap: 6px 14px; }

/* ---------------------------------------------------------------- The pinned reply dock */
.co-case.co-page .co-footer.co-page-dock { flex: none; display: block; position: relative; padding: 0 0 14px; border-top: 0; background: var(--co-page-bg); }
/* The thread fades under the dock instead of stopping at a hard line. */
.co-case.co-page .co-page-dock::before { content: ''; position: absolute; left: 0; right: 0; top: -16px; height: 16px; pointer-events: none;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--co-page-bg) 0%, transparent), var(--co-page-bg)); }
.co-case.co-page .co-page-dock > .co-page-col { display: grid; gap: 8px; }
.co-case.co-page .co-page-slot { display: grid; gap: 8px; min-width: 0; }
.co-case.co-page .co-banner.co-inline-err { margin: 0; }

.co-case.co-page .co-page-working { display: flex; align-items: center; gap: 8px; min-height: 18px; padding: 0 2px; font-size: 12px; color: var(--co-dim); }
.co-case.co-page .co-page-working[hidden] { display: none; }
.co-case.co-page .co-page-working .co-dots i { background: var(--co-warn); }

.co-case.co-page .co-composer { display: flex; flex-direction: column; min-width: 0; padding: 8px 8px 6px 12px; border-radius: 8px; cursor: text;
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-input-border, var(--co-border))); background: var(--vscode-input-background, rgba(128,128,128,0.1));
  box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
.co-case.co-page .co-composer:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
.co-case.co-page .co-composer .co-textarea { min-height: 44px; padding: 3px 4px 3px 0; border: 0; border-radius: 0; background: transparent; outline: none; box-shadow: none;
  font-size: var(--vscode-font-size, 13px); line-height: 1.5; }
.co-case.co-page .co-composer .co-textarea:focus { outline: none; }
.co-case.co-page .co-composer.knocking .co-textarea { min-height: 24px; }
.co-case.co-page .co-composer.disabled { cursor: not-allowed; opacity: 0.75; box-shadow: none; }
.co-case.co-page .co-composer.disabled .co-textarea { min-height: 24px; opacity: 1; }
.co-case.co-page .co-composer-bar { display: flex; align-items: center; gap: 10px; min-height: 28px; margin-top: 4px; }
.co-case.co-page .co-composer-bar .co-hint { flex: 1 1 auto; min-width: 0; font-size: 11.5px; line-height: 1.35; cursor: text;
  white-space: normal; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.co-case.co-page .co-composer-actions { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.co-case.co-page .co-composer-actions .co-btn { min-height: 26px; border-radius: 5px; }
.co-case.co-page .co-stop-sq { display: inline-block; width: 8px; height: 8px; border-radius: 1px; background: currentColor; }
.co-case.co-page .co-stop { color: var(--co-fg); background: transparent; border-color: var(--vscode-contrastBorder, var(--co-border)); }
.co-case.co-page .co-stop:not(:disabled):hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-case.co-page .co-footer-note { justify-content: center; text-align: center; padding: 10px 14px; border: 1px dashed var(--co-border); border-radius: 8px; }
.co-case.co-page .co-composer.disabled + .co-footer-note { border: 0; padding: 0 4px; }

/* ---------------------------------------------------------------- Widths */
@media (max-width: 640px) {
  .co-case.co-page { --co-page-pad: 16px; }
  .co-case.co-page .co-page-head > .co-head-opts, .co-case.co-page .co-page-head > .co-opt-hint { padding-left: 0; }
  .co-case.co-page .co-head-actions .co-long { display: none; }
}
@media (max-width: 480px) {
  .co-case.co-page { --co-page-pad: 12px; }
  .co-case.co-page .co-head-face { width: 32px; height: 32px; }
  .co-case.co-page .co-composer-actions .co-kbd { display: none; }
}

/* Short tabs: a one-line header (uiStyles' short-panel rules are written for the drawer; these put the page back together). */
@media (max-height: 420px) {
  .co-case.co-page .co-case-head { display: block; padding: 6px 0; }
  .co-case.co-page .co-head-top { flex: 1; }
  .co-case.co-page .co-head-face { width: 26px; height: 26px; }
  .co-case.co-page .co-head-meta { display: none; }
  .co-case.co-page .co-head-opts { margin-top: 4px; }
  .co-case.co-page .co-case-main.squeezed { display: flex; flex: 1 1 0; }
  .co-case.co-page.knocking .co-footer { display: block; }
  .co-case.co-page .co-pending { max-height: none; flex: none; padding: 10px 12px 0; }
  .co-case.co-page .co-card-foot { margin: 8px -12px 0; padding: 8px 12px 10px; }
  .co-case.co-page .co-plan-card.compact .co-plan-paper { display: none; }
  .co-case.co-page .co-plan-card.compact .co-plan-above { display: inline; }
  .co-case.co-page .co-composer .co-textarea { min-height: 24px; }
}

/* ---------------------------------------------------------------- High contrast */
body.vscode-high-contrast .co-case.co-page .co-composer:focus-within, body.vscode-high-contrast-light .co-case.co-page .co-composer:focus-within {
  outline: 1px solid var(--vscode-focusBorder, #f38518); outline-offset: 1px; }
body.vscode-high-contrast .co-case.co-page .co-pending, body.vscode-high-contrast-light .co-case.co-page .co-pending { border-color: var(--co-warn); }

/* ---------------------------------------------------------------- Outside the case: toast and the lost-worker state */
.co-tab-toast { position: fixed; left: 50%; bottom: 112px; transform: translateX(-50%); z-index: 40; max-width: min(520px, calc(100vw - 24px)); padding: 7px 12px;
  border-radius: 6px; font-size: 12.5px; overflow-wrap: anywhere; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground, #cccccc));
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); }
.co-tab-toast[hidden] { display: none; }
.co-tab-lost { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px;
  text-align: center; color: var(--co-dim); background: var(--vscode-editor-background, #1f1f1f); }
.co-tab-lost strong { color: var(--co-fg); font-size: 15px; font-weight: 600; }
.co-tab-lost span { max-width: 380px; font-size: 12.5px; }
`;

let injected = false;

/** Adds the case tab stylesheet (once). Call after `injectUiStyles()` so these rules win over the drawer's. */
export function injectCaseTabStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}
