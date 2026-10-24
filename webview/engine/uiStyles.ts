/**
 * Styles for the Manager Mode UI (case-file drawer, pending cards, memo).
 * VS Code theme variables with fallbacks; memo "paper" has its own colours so
 * it reads the same in light and dark themes. Injected once as a <style>.
 */

import { TIER_COLOURS, TIERS } from './modelTier.ts';

const TIP_CHIPS = TIERS.map((t) => `.tt-chip-${t} { background: ${TIER_COLOURS[t].bg}; color: ${TIER_COLOURS[t].fg}; }`).join('\n');

const CSS = `
:root {
  --co-paper: #f7f1e1; --co-paper-2: #efe6cf; --co-paper-edge: #d9cba9; --co-ink: #2b2620; --co-ink-dim: #6d6252;
  --co-letterhead: #23395b; --co-rule: #c4b28c; --co-field: #fffdf6;
  --co-warn: var(--vscode-editorWarning-foreground, #cca700);
  --co-err: var(--vscode-errorForeground, #f48771);
  --co-ok: var(--vscode-testing-iconPassed, #73c991);
  /* Amber and green as text: pulled towards the foreground so they stay readable on light themes too. */
  --co-warn-text: color-mix(in srgb, var(--co-warn) 68%, var(--co-fg));
  --co-ok-text: color-mix(in srgb, var(--co-ok) 70%, var(--co-fg));
  --co-fg: var(--vscode-foreground, #cccccc);
  --co-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --co-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f));
  --co-border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
  --co-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14));
  --co-mono: var(--vscode-editor-font-family, ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace);
  --co-font: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
}
body.vscode-dark { --co-paper: #ebe3cc; --co-paper-2: #e2d8bd; --co-field: #f6f0de; }
body.vscode-high-contrast, body.vscode-high-contrast-light {
  --co-paper: var(--vscode-editor-background, #000); --co-paper-2: var(--vscode-editor-background, #000); --co-ink: var(--vscode-foreground, #fff);
  --co-ink-dim: var(--vscode-foreground, #fff); --co-letterhead: var(--vscode-foreground, #fff); --co-field: var(--vscode-input-background, #000);
  --co-rule: var(--vscode-contrastBorder, #6fc3df); --co-paper-edge: var(--vscode-contrastBorder, #6fc3df);
}

.co-px { image-rendering: pixelated; image-rendering: crisp-edges; flex: none; }
.co-ui, .co-ui * { box-sizing: border-box; }
.co-ui { font-family: var(--co-font); font-size: 13px; line-height: 1.45; color: var(--co-fg); }
.co-ui button { font: inherit; }
.co-ui [hidden], .co-ui[hidden] { display: none !important; }

/* Buttons */
.co-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 26px; padding: 3px 11px; border-radius: 3px;
  border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; white-space: nowrap; font-size: 12.5px; line-height: 18px; }
.co-btn:disabled { opacity: 0.5; cursor: default; }
.co-btn:focus-visible, .co-icon-btn:focus-visible, .co-opt:focus-visible, .co-tool-head:focus-visible, .co-link:focus-visible, .co-pick:focus-visible, .co-seg button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
.co-primary:not(:disabled):hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.co-secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.co-secondary:not(:disabled):hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.co-ghost { background: transparent; color: var(--co-fg); border-color: var(--co-border); }
.co-ghost:not(:disabled):hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-danger { background: transparent; color: var(--co-err); border-color: color-mix(in srgb, var(--co-err) 55%, transparent); }
.co-danger:not(:disabled):hover { background: color-mix(in srgb, var(--co-err) 14%, transparent); }
.co-small { min-height: 22px; padding: 1px 8px; font-size: 12px; }
/* Where a panel parks keyboard focus while the control it was on is rebuilt (keepFocus in dom.ts): a quiet ring, never <body>. */
.co-focus-park:focus { outline: none; }
.co-focus-park:focus-visible { outline: 1px dashed var(--vscode-focusBorder, #007fd4); outline-offset: 3px; border-radius: 2px; }
.co-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 4px; border: 0; padding: 0;
  background: transparent; color: var(--co-fg); cursor: pointer; font-size: 18px; line-height: 1; }
.co-icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-link { border: 0; background: none; padding: 0; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.co-link:hover { color: var(--vscode-textLink-activeForeground, #4daafc); }
.co-kbd { opacity: 0.7; font-size: 11px; font-weight: normal; }
.co-ext { opacity: 0.75; }
.co-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Chips */
.co-chip { display: inline-block; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 9px; font-size: 11px; line-height: 17px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.co-chip > .co-px { vertical-align: -1px; margin-right: 1px; }
.co-branch { background: color-mix(in srgb, var(--co-ok) 16%, transparent); color: var(--co-fg); border: 1px solid color-mix(in srgb, var(--co-ok) 40%, transparent); }
.co-branch-glyph { color: var(--co-ok); font-weight: 700; }
.co-ctl { background: var(--vscode-badge-background, rgba(128,128,128,0.25)); color: var(--vscode-badge-foreground, var(--co-fg)); }

/* ---------------------------------------------------------------- Drawer */
.co-case { position: fixed; top: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-direction: column; min-width: 0;
  background: var(--co-bg); border-left: 1px solid var(--co-border); }
.co-case.overlay { box-shadow: -8px 0 24px rgba(0,0,0,0.35); }
.co-case[hidden] { display: none; }
.co-case:focus { outline: none; }
/* Focus moved here by the keyboard (a panel opened with Enter): an inset ring, like a focused VS Code view. */
.co-case:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.co-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 2; }
.co-resize:hover, .co-resize.drag { background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 60%, transparent); }

.co-case-head { flex: none; position: relative; padding: 10px 10px 8px 12px; border-bottom: 1px solid var(--co-border);
  background: color-mix(in srgb, var(--co-bg) 92%, var(--co-fg) 8%); }
.co-case-head > .co-icon-btn { position: absolute; top: 6px; right: 6px; }
.co-case-head > .co-case-back { margin: 0 34px 8px 0; max-width: calc(100% - 40px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-case-head > .co-case-back[hidden] { display: none; }
.co-head-top { padding-right: 26px; }
.co-head-top { display: flex; align-items: flex-start; gap: 10px; }
.co-head-face { flex: none; width: 44px; height: 44px; border-radius: 4px; image-rendering: pixelated; position: relative;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.16)); border: 1px solid var(--co-border); }
.co-head-text { flex: 1; min-width: 0; }
.co-head-title { font-size: 14px; font-weight: 600; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.co-head-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 3px; font-size: 12px; min-width: 0; }
.co-head-project { flex: 0 1 auto; min-width: 40px; color: var(--co-fg); font-weight: 500; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
.co-head-meta > .co-chip { flex: 0 3 auto; min-width: 30px; }
.co-head-status { margin-top: 3px; color: var(--co-dim); font-size: 12px; overflow-wrap: anywhere; text-wrap: pretty; }
.co-head-status .co-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; background: var(--co-dim); }
.co-head-status.busy .co-dot { background: var(--co-ok); animation: co-pulse 1.4s ease-in-out infinite; }
.co-head-status.needs .co-dot { background: var(--co-warn); animation: co-pulse 1s ease-in-out infinite; }
.co-head-status.needs { color: var(--co-warn-text); font-weight: 600; }
.co-head-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.co-head-actions:empty { display: none; }

.co-case-main { position: relative; flex: 1 1 0; min-height: 72px; display: flex; flex-direction: column; }
.co-case-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 12px 14px 16px; scrollbar-width: thin; overscroll-behavior: contain; }
.co-new-pill { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 1; border-radius: 12px; padding: 2px 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
.co-new-pill[hidden] { display: none; }

.co-empty { margin: 28px 8px; text-align: center; color: var(--co-dim); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.co-earlier { margin: 0 0 12px; text-align: center; font-size: 11.5px; color: var(--co-dim); border-bottom: 1px dashed var(--co-border); padding-bottom: 8px;
  display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 6px; }
.co-earlier .co-link { font-size: inherit; }
.co-empty-detail { font-size: 12px; max-width: 320px; overflow-wrap: anywhere; }
.co-load-err strong { color: var(--co-fg); font-weight: 600; }
.co-banner { margin: 0 0 12px; padding: 7px 10px; border-radius: 4px; font-size: 12px; background: color-mix(in srgb, var(--co-warn) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--co-warn) 40%, transparent); }

.co-banner.co-inline-err { margin: 0 8px 8px; color: var(--co-err); background: color-mix(in srgb, var(--co-err) 12%, transparent); border-color: color-mix(in srgb, var(--co-err) 45%, transparent); overflow-wrap: anywhere; }
.co-banner.co-inline-err[hidden] { display: none; }

.co-item { margin: 0 0 12px; min-width: 0; }
.co-item.co-tool + .co-item.co-tool { margin-top: -9px; }

/* Your memos */
.co-slip { margin-left: 28px; background: var(--co-paper); color: var(--co-ink); border-radius: 2px; padding: 7px 11px 6px; position: relative;
  box-shadow: 0 1px 0 var(--co-paper-edge), 0 2px 6px rgba(0,0,0,0.22); border-top: 3px solid var(--co-letterhead); }
.co-slip-kicker { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--co-ink-dim); margin-bottom: 3px; font-weight: 600; }
.co-slip-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.co-slip-sign { text-align: right; font-style: italic; color: var(--co-ink-dim); font-size: 12px; margin-top: 2px; font-family: Georgia, "Times New Roman", serif; }

/* Their replies (markdown-lite) */
.co-reply { overflow-wrap: anywhere; }
.co-md > :first-child { margin-top: 0; }
.co-md > :last-child { margin-bottom: 0; }
.co-md p { margin: 0 0 8px; }
.co-md h3, .co-md h4 { margin: 12px 0 6px; font-size: 13.5px; }
.co-md h4 { font-size: 13px; }
.co-md ul, .co-md ol { margin: 0 0 8px; padding-left: 20px; }
.co-md li { margin: 2px 0; }
.co-md li.co-d1 { margin-left: 16px; } .co-md li.co-d2 { margin-left: 32px; } .co-md li.co-d3 { margin-left: 48px; }
.co-md code { font-family: var(--co-mono); font-size: 0.92em; background: var(--co-code-bg); padding: 0 4px; border-radius: 3px; }
.co-md pre { margin: 0 0 8px; padding: 8px 10px; background: var(--co-code-bg); border-radius: 4px; overflow-x: auto; font-size: 12px; line-height: 1.45;
  position: relative; scrollbar-width: thin; }
.co-md pre[data-lang] { padding-top: 18px; }
.co-md pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 3px; left: 10px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--co-dim); font-family: var(--co-font); }
.co-md pre code { background: none; padding: 0; font-size: inherit; white-space: pre; }
.co-md blockquote { margin: 0 0 8px; padding: 2px 10px; border-left: 3px solid var(--co-border); color: var(--co-dim); }
.co-md hr { border: 0; border-top: 1px solid var(--co-border); margin: 10px 0; }
.co-streaming .co-md > :is(p, h3, h4, blockquote):last-child::after, .co-streaming .co-md > :is(ul, ol):last-child > li:last-child::after,
.co-streaming .co-md > pre:last-child > code::after, .co-streaming .co-md:empty::after {
  content: ''; display: inline-block; width: 7px; height: 13px; margin-left: 2px; vertical-align: -2px; background: var(--co-fg); animation: co-blink 1s steps(1) infinite; }
.co-cut { color: var(--co-dim); font-size: 11.5px; font-style: italic; margin-top: 2px; }

/* Tool steps */
.co-tool-head { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 24px; padding: 2px 6px; border: 0; border-radius: 3px;
  background: transparent; color: var(--co-fg); text-align: left; cursor: pointer; }
.co-tool-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14)); }
.co-tool-head[aria-disabled="true"] { cursor: default; }
.co-tool-head[aria-disabled="true"]:hover { background: transparent; }
.co-tool-sum { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; color: var(--co-fg); opacity: 0.92; }
.co-tool-state { flex: none; font-size: 11px; color: var(--co-dim); }
.co-tool-chev { flex: none; width: 10px; color: var(--co-dim); font-size: 10px; transition: transform 0.12s; }
.co-tool.open .co-tool-chev { transform: rotate(90deg); }
.co-tool.sub { margin-left: 14px; border-left: 2px solid var(--co-border); padding-left: 2px; }
.co-tool.error .co-tool-state, .co-tool.error .co-tool-sum { color: var(--co-err); }
.co-tool.denied .co-tool-sum { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--co-fg) 50%, transparent); opacity: 0.7; }
.co-tool.denied .co-tool-state { color: var(--co-warn-text); }
.co-tag { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; line-height: 16px; font-weight: 600; }
.co-tool.error .co-tag { background: color-mix(in srgb, var(--co-err) 18%, transparent); }
.co-tool.denied .co-tag { background: color-mix(in srgb, var(--co-warn) 18%, transparent); }
.co-dots { display: inline-flex; gap: 3px; align-items: center; }
.co-dots i { width: 4px; height: 4px; background: var(--co-ok); animation: co-hop 1s ease-in-out infinite; }
.co-dots i:nth-child(2) { animation-delay: 0.15s; } .co-dots i:nth-child(3) { animation-delay: 0.3s; }
.co-tool-detail { margin: 2px 0 6px 30px; display: grid; gap: 4px; }
.co-tool-detail[hidden] { display: none; }
.co-tool-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--co-dim); }
.co-pre { margin: 0; padding: 6px 8px; max-height: 220px; overflow: auto; font-family: var(--co-mono); font-size: 11.5px; line-height: 1.45;
  background: var(--co-code-bg); border-radius: 3px; white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-width: thin; }
.co-tool.error .co-pre.out { border-left: 2px solid var(--co-err); }

.co-thinking { display: inline-block; font-size: 11.5px; font-style: italic; color: var(--co-dim); padding: 0 8px; border-radius: 9px;
  border: 1px dashed var(--co-border); }
.co-notice { text-align: center; font-size: 11.5px; color: var(--co-dim); display: flex; align-items: center; gap: 8px; }
.co-notice::before, .co-notice::after { content: ''; flex: 1; border-top: 1px dashed var(--co-border); }
.co-notice.info { color: var(--co-dim); }
.co-notice.interrupted { color: var(--co-warn-text); }
.co-notice.error { color: var(--co-err); }
.co-notice.error::before, .co-notice.error::after { border-color: color-mix(in srgb, var(--co-err) 50%, transparent); }

/* Pending card */
.co-pending { --co-pend-bg: color-mix(in srgb, var(--co-warn) 9%, var(--co-bg)); flex: 0 1 auto; min-height: 0; max-height: 66%; overflow-y: auto; scrollbar-width: thin;
  padding: 10px 14px 0; border-top: 3px solid var(--co-warn); background: var(--co-pend-bg); }
.co-card-foot { position: sticky; bottom: 0; z-index: 1; margin: 8px -14px 0; padding: 8px 14px 10px; background: var(--co-pend-bg);
  border-top: 1px solid color-mix(in srgb, var(--co-warn) 30%, transparent); }
.co-pending[hidden] { display: none; }
.co-pending:focus { outline: none; }
.co-pending.flash { animation: co-flash 0.9s ease-out 2; }
.co-knock { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--co-warn-text); }
.co-knock .co-px { animation: co-bob 1.2s steps(2) infinite; }
.co-card-title { font-size: 14px; font-weight: 600; margin: 4px 0 8px; overflow-wrap: anywhere; line-height: 1.35; }
.co-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin: 0 0 8px; font-size: 12.5px; align-items: baseline; }
.co-fields dt { color: var(--co-dim); font-size: 11.5px; }
.co-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.co-fields .co-pre { max-height: 160px; }
.co-diff { display: grid; gap: 4px; margin: 0 0 8px; }
.co-diff .co-pre.old { border-left: 3px solid color-mix(in srgb, var(--co-err) 70%, transparent); background: color-mix(in srgb, var(--co-err) 8%, var(--co-code-bg)); }
.co-diff .co-pre.new { border-left: 3px solid color-mix(in srgb, var(--co-ok) 70%, transparent); background: color-mix(in srgb, var(--co-ok) 8%, var(--co-code-bg)); }
.co-diff-label { font-size: 11px; color: var(--co-dim); }
.co-reason { font-size: 12px; color: var(--co-dim); font-style: italic; margin: 0 0 8px; }
.co-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.co-caption { font-size: 11.5px; color: var(--co-dim); margin-top: 5px; overflow-wrap: anywhere; }
.co-sent { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--co-dim); margin-top: 6px; }
.co-feedback { margin-top: 8px; display: grid; gap: 6px; }
.co-feedback[hidden] { display: none; }

.co-q { margin: 0 0 12px; }
.co-q-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.co-q-chip { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; padding: 0 6px; border-radius: 3px;
  background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.co-q-text { font-weight: 600; overflow-wrap: anywhere; }
.co-q-hint { font-size: 11px; color: var(--co-dim); }
.co-opts { display: grid; gap: 4px; }
.co-opt { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 2px 8px; align-items: start; width: 100%; text-align: left; padding: 6px 8px; border-radius: 4px;
  cursor: pointer; color: var(--co-fg); background: var(--vscode-input-background, rgba(128,128,128,0.08)); border: 1px solid var(--co-border); }
.co-opt:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.co-opt[aria-checked="true"] { border-color: var(--vscode-focusBorder, #007fd4); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 16%, var(--vscode-input-background, transparent)); }
.co-mark { width: 14px; height: 14px; margin-top: 2px; border: 1.5px solid var(--co-dim); background: var(--co-bg); position: relative; }
.co-mark.radio { border-radius: 50%; }
.co-mark.check { border-radius: 2px; }
.co-opt[aria-checked="true"] .co-mark { border-color: var(--vscode-focusBorder, #007fd4); }
.co-opt[aria-checked="true"] .co-mark.radio::after { content: ''; position: absolute; inset: 2.5px; border-radius: 50%; background: var(--vscode-focusBorder, #007fd4); }
.co-opt[aria-checked="true"] .co-mark.check::after { content: ''; position: absolute; left: 3.5px; top: 0.5px; width: 4px; height: 8px;
  border: solid var(--vscode-focusBorder, #007fd4); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.co-opt-label { font-weight: 600; font-size: 12.5px; }
.co-opt-desc { grid-column: 2; font-size: 12px; color: var(--co-dim); }
.co-opt-preview { grid-column: 1 / -1; margin-top: 4px; }
.co-other-input { margin-top: 4px; }

.co-plan-paper { background: var(--co-paper); color: var(--co-ink); border-radius: 2px; padding: 10px 14px; max-height: 300px; overflow-y: auto; margin: 0 0 8px;
  box-shadow: inset 0 0 0 1px var(--co-paper-edge), 0 2px 6px rgba(0,0,0,0.2); scrollbar-width: thin;
  background-image: repeating-linear-gradient(to bottom, transparent 0, transparent 21px, color-mix(in srgb, var(--co-rule) 35%, transparent) 21px, color-mix(in srgb, var(--co-rule) 35%, transparent) 22px); }
.co-plan-paper.co-md code, .co-plan-paper.co-md pre { background: color-mix(in srgb, var(--co-ink) 8%, transparent); color: var(--co-ink); }
.co-plan-paper.co-md pre code { background: none; }
.co-plan-paper.co-md pre[data-lang]::before { color: var(--co-ink-dim); }
.co-plan-paper.co-md blockquote { color: var(--co-ink-dim); border-color: var(--co-rule); }
.co-plan-paper.co-md hr { border-color: var(--co-rule); }
.co-plan-paper:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-plan-path { font-size: 11.5px; color: var(--co-dim); margin: -4px 0 8px; overflow-wrap: anywhere; }
/* The pending plan card when the plan itself is in the history above: just the decision. */
.co-plan-card.compact .co-plan-paper { display: none; }
.co-plan-card:not(.compact) .co-plan-above { display: none; }
.co-plan-card .co-card-title .co-link { font-size: 12px; font-weight: normal; white-space: nowrap; }

/* Model / effort / approvals chips in the case header */
.co-head-opts { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 8px; }
.co-head-opts:empty { display: none; }
.co-optchip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; min-height: 24px; padding: 1px 8px 1px 9px; border-radius: 12px;
  font-size: 12px; line-height: 18px; cursor: pointer; color: var(--co-fg); background: var(--vscode-input-background, rgba(128,128,128,0.1));
  border: 1px solid var(--vscode-input-border, var(--co-border)); }
.co-optchip:not(.ro):hover { border-color: var(--vscode-focusBorder, #007fd4); }
.co-optchip[aria-expanded="true"] { border-color: var(--vscode-focusBorder, #007fd4);
  background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 14%, var(--vscode-input-background, transparent)); }
.co-optchip:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-optchip-k { flex: none; color: var(--co-dim); font-size: 11px; }
.co-optchip-v { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co-optchip-next { flex: none; font-size: 11px; line-height: 15px; padding: 0 5px; border-radius: 8px; white-space: nowrap; font-weight: 600;
  color: var(--co-warn-text); background: color-mix(in srgb, var(--co-warn) 15%, transparent); border: 1px solid color-mix(in srgb, var(--co-warn) 35%, transparent); }
.co-optchip-caret { flex: none; font-size: 9px; color: var(--co-dim); margin-left: 1px; }
.co-optchip-mark { flex: none; font-size: 11px; font-weight: 700; }
.co-optchip-mark.ok { color: var(--co-ok-text); }
.co-optchip-mark.err { color: var(--co-err); }
.co-optchip.pending { border-color: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 70%, transparent); }
.co-optchip.applied { border-color: color-mix(in srgb, var(--co-ok) 70%, transparent); }
.co-optchip.failed { border-color: color-mix(in srgb, var(--co-err) 70%, transparent); }
.co-optchip.ro { cursor: default; background: transparent; border-style: dashed; }
.co-optchip.ro .co-optchip-v { font-weight: 500; }
.co-optchip.ro > .co-px { opacity: 0.8; }
.co-opt-hint { margin-top: 5px; font-size: 11.5px; color: var(--co-dim); overflow-wrap: anywhere; }

/* Plan items in the history */
.co-planitem { --co-tone: var(--co-dim); border: 1px solid var(--co-border); border-left: 3px solid var(--co-tone); border-radius: 4px; padding: 7px 10px 8px;
  background: color-mix(in srgb, var(--co-tone) 5%, transparent); }
.co-planitem.warn { --co-tone: var(--co-warn); }
.co-planitem.ok { --co-tone: var(--co-ok); }
.co-planitem.err { --co-tone: var(--co-err); }
.co-planitem-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; min-width: 0; }
.co-planitem-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--co-dim); }
.co-planitem-time { color: var(--co-dim); }
.co-badge { margin-left: auto; padding: 0 7px; border-radius: 9px; font-size: 11px; line-height: 17px; font-weight: 600; white-space: nowrap;
  color: var(--co-fg); background: color-mix(in srgb, var(--co-tone, var(--co-dim)) 18%, transparent); border: 1px solid color-mix(in srgb, var(--co-tone, var(--co-dim)) 50%, transparent); }
.co-badge.warn { color: var(--co-warn-text); }
.co-badge.ok { color: var(--co-ok-text); }
.co-badge.err { color: var(--co-err); }
.co-planitem-paper { max-height: none; margin: 0 0 4px; }
.co-planitem-paper.folded { max-height: 138px; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent); mask-image: linear-gradient(to bottom, #000 55%, transparent); }
.co-planitem[data-status="superseded"] .co-planitem-paper { opacity: 0.72; }
.co-plan-more { font-size: 12px; }
.co-plan-fb { margin-top: 6px; padding: 4px 8px; display: grid; gap: 1px; font-size: 12.5px; overflow-wrap: anywhere; border-radius: 0 3px 3px 0;
  background: var(--co-code-bg); border-left: 3px solid color-mix(in srgb, var(--co-err) 60%, transparent); }
.co-plan-fb-k { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--co-dim); }
.co-plan-signoff { margin-top: 4px; font-size: 12px; }

/* Popover menu (model, effort, approvals) */
.co-pop { position: fixed; z-index: 45; min-width: 210px; max-width: min(320px, calc(100vw - 16px)); overflow-y: auto; padding: 4px; border-radius: 5px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--co-bg)));
  color: var(--vscode-menu-foreground, var(--co-fg));
  border: 1px solid var(--vscode-menu-border, var(--vscode-editorHoverWidget-border, var(--co-border))); box-shadow: 0 4px 18px rgba(0,0,0,0.34); scrollbar-width: thin; }
.co-pop:focus { outline: none; }
.co-pop-title { padding: 3px 8px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--co-dim); }
.co-pop-item { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: center; gap: 0 8px; width: 100%; padding: 4px 8px; border: 0;
  border-radius: 3px; text-align: left; background: transparent; color: inherit; cursor: pointer; }
.co-pop-item:focus, .co-pop-item:hover { outline: none;
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, var(--vscode-button-background, #0e639c)));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground, #ffffff))); }
.co-pop-item[aria-disabled="true"] { cursor: not-allowed; }
.co-pop-item[aria-disabled="true"] .co-pop-text, .co-pop-item[aria-disabled="true"] .co-meter { opacity: 0.5; }
.co-pop-item[aria-disabled="true"]:hover:not(:focus) { background: transparent; color: inherit; }
.co-pop-tick { font-size: 12px; text-align: center; }
.co-pop-text { display: flex; flex-direction: column; min-width: 0; }
.co-pop-label { font-size: 12.5px; line-height: 17px; }
.co-pop-item.checked .co-pop-label { font-weight: 600; }
.co-pop-detail { font-size: 11px; line-height: 15px; opacity: 0.78; }
.co-pop-note { margin: 4px 4px 0; padding: 5px 4px 2px; font-size: 11px; color: var(--co-dim);
  border-top: 1px solid var(--vscode-menu-separatorBackground, var(--co-border)); }
.co-meter { display: inline-flex; align-items: flex-end; gap: 2px; height: 13px; }
.co-meter i { width: 4px; border-radius: 1px; background: currentColor; opacity: 0.25; }
.co-meter i.on { opacity: 0.95; }
body.vscode-high-contrast .co-pop-item:focus, body.vscode-high-contrast-light .co-pop-item:focus,
body.vscode-high-contrast .co-pop-item:hover, body.vscode-high-contrast-light .co-pop-item:hover {
  outline: 1px dashed var(--vscode-contrastActiveBorder, #f38518); outline-offset: -1px; }

/* Text inputs (theme) */
.co-input, .co-textarea { width: 100%; font: inherit; font-size: 13px; color: var(--vscode-input-foreground, var(--co-fg));
  background: var(--vscode-input-background, rgba(128,128,128,0.12)); border: 1px solid var(--vscode-input-border, var(--co-border)); border-radius: 3px; padding: 5px 8px; }
.co-textarea { resize: none; min-height: 34px; line-height: 1.4; display: block; scrollbar-width: thin; }
.co-input:focus, .co-textarea:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; border-color: transparent; }
.co-input::placeholder, .co-textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--co-dim)); }
.co-textarea:disabled { opacity: 0.55; cursor: not-allowed; }

/* Footer */
.co-footer { flex: none; padding: 8px 12px 10px; border-top: 1px solid var(--co-border); display: grid; gap: 6px; }
.co-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.co-hint { font-size: 11.5px; color: var(--co-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-hint.queued { color: var(--co-warn-text); }
.co-footer .co-hint { white-space: normal; overflow: visible; text-wrap: pretty; }
.co-hint.sent { color: var(--co-ok-text); }
.co-footer-note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--co-dim); }

/* Short panels: keep the essentials visible */
@media (max-height: 420px) {
  .co-case-head { padding: 6px 6px 6px 10px; display: flex; align-items: center; gap: 8px; }
  .co-case-head > .co-icon-btn { position: static; flex: none; }
  .co-case-head > .co-case-back { margin: 0; flex: none; max-width: 30%; }
  .co-head-top { flex: 1; min-width: 0; padding-right: 0; align-items: center; }
  .co-head-face { width: 30px; height: 30px; }
  .co-head-title { -webkit-line-clamp: 1; font-size: 13px; }
  .co-head-meta { flex-wrap: nowrap; overflow: hidden; }
  .co-head-actions { margin-top: 0; flex-wrap: nowrap; flex: none; }
  .co-head-actions .co-btn { padding: 1px 7px; }
  .co-head-status { display: none; }
  .co-case.knocking .co-footer { display: none; }
  .co-head-actions .co-long, .co-head-meta .co-ctl { display: none; }
  .co-pending { max-height: none; flex: 1 1 auto; padding: 8px 12px 0; }
  .co-card-foot { margin: 6px -12px 0; padding: 6px 12px 8px; }
  .co-case-main.squeezed { flex: 0 0 0; min-height: 0; display: none; }
  .co-footer { padding: 6px 10px; }
  .co-plan-paper { max-height: 120px; }
  .co-plan-card.compact .co-plan-paper { display: block; }
  .co-plan-card .co-plan-above { display: none; }
  .co-head-opts, .co-opt-hint { display: none; }
}

/* ------------------------------------------------------------------ Memo */
.co-memo-back { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 12px;
  background: rgba(10, 8, 14, 0.45); }
.co-memo-back[hidden] { display: none; }
.co-memo { --co-memo-pb: 16px; position: relative; width: min(540px, 100%); max-height: 100%; overflow-y: auto; scrollbar-width: thin; color: var(--co-ink); background: var(--co-paper);
  border-radius: 2px; padding: 16px 22px var(--co-memo-pb); box-shadow: 0 1px 0 var(--co-paper-edge), 0 14px 40px rgba(0,0,0,0.45); font-size: 13px; }
.co-memo::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: var(--co-letterhead); }
.co-memo:focus { outline: none; }
.co-memo .co-icon-btn { position: absolute; top: 8px; right: 8px; color: var(--co-ink-dim); }
/* A firmer focus ring on the paper (a 1px line gets lost against the cream and the navy chips). */
.co-memo :is(button, summary):focus-visible, .co-tip .co-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-memo .co-icon-btn:hover { background: color-mix(in srgb, var(--co-ink) 10%, transparent); }
.co-letterhead { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0 8px; }
.co-letterhead canvas { image-rendering: pixelated; max-width: 100%; height: auto; }
.co-letter-rule { border: 0; border-top: 3px double var(--co-rule); margin: 4px 0 8px; }
.co-memo-kicker { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; color: var(--co-ink-dim); margin-bottom: 8px; }
.co-memo-kicker span:last-child { letter-spacing: 0.04em; font-weight: 500; }
.co-mrow { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px; align-items: start; padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, var(--co-rule) 55%, transparent); }
.co-mlabel { font-family: "Courier New", Courier, var(--co-mono); font-weight: 700; font-size: 12.5px; padding-top: 4px; color: var(--co-ink); }
.co-mval { min-width: 0; }
.co-from { padding-top: 3px; }
.co-from em { color: var(--co-ink-dim); }

.co-seg { display: flex; flex-wrap: wrap; gap: 5px; }
.co-seg button { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 9px; border-radius: 14px; cursor: pointer; font-size: 12.5px;
  color: var(--co-ink); background: var(--co-field); border: 1px solid var(--co-rule); min-height: 26px; }
.co-seg button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-seg button:not(:disabled):hover { border-color: var(--co-letterhead); }
.co-seg button:disabled { opacity: 0.5; cursor: default; }
.co-seg button[aria-checked="true"] { background: var(--co-letterhead); color: #fff; border-color: var(--co-letterhead); }
body.vscode-high-contrast .co-memo :is(.co-seg button, .co-effort-def)[aria-checked="true"], body.vscode-high-contrast-light .co-memo :is(.co-seg button, .co-effort-def)[aria-checked="true"] {
  color: var(--vscode-editor-background, #000); }
.co-seg .co-face { width: 18px; height: 18px; border-radius: 3px; background: rgba(0,0,0,0.08); image-rendering: pixelated; }
.co-seg-note { font-size: 11.5px; color: var(--co-ink-dim); margin-top: 4px; }
.co-seg-note:empty { display: none; }

.co-pick { position: relative; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 8px; align-items: center; text-align: left;
  padding: 4px 8px; border-radius: 3px; cursor: pointer; color: var(--co-ink); background: var(--co-field); border: 1px solid var(--co-rule); }
.co-pick:hover { border-color: var(--co-letterhead); }
/* The branch and "this window" chips wrap under the name when the memo is narrow, rather than shrinking to "…". */
.co-pick-name { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 6px; min-width: 0; font-weight: 600; }
.co-pick-name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; max-width: 100%; }
.co-pick-name > .co-chip { flex: 0 1 auto; min-width: 0; max-width: 100%; }
.co-pick-path { grid-column: 1; font-size: 11.5px; color: var(--co-ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
.co-pick-caret { grid-column: 2; grid-row: 1 / span 2; color: var(--co-ink-dim); font-size: 11px; }
.co-memo .co-branch { color: var(--co-ink); background: color-mix(in srgb, #3d8a3a 14%, transparent); border-color: color-mix(in srgb, #3d8a3a 45%, transparent); }
.co-memo .co-branch-glyph { color: #3d8a3a; }
.co-memo .co-ctl { background: color-mix(in srgb, var(--co-letterhead) 13%, transparent); color: var(--co-letterhead); font-weight: 600; }
.co-list { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 3; max-height: 260px; overflow-y: auto; scrollbar-width: thin;
  background: var(--co-field); border: 1px solid var(--co-letterhead); border-radius: 3px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); padding: 3px; }
.co-list[hidden] { display: none; }
.co-list-group { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--co-ink-dim); padding: 6px 7px 2px; }
.co-list-opt { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; width: 100%; text-align: left; padding: 4px 7px; border: 0; border-radius: 2px;
  background: transparent; color: var(--co-ink); cursor: pointer; }
.co-list-opt:hover, .co-list-opt:focus { background: color-mix(in srgb, var(--co-letterhead) 14%, transparent); outline: none; }
.co-list-opt[aria-selected="true"] { background: color-mix(in srgb, var(--co-letterhead) 22%, transparent); }
.co-list-opt:disabled { opacity: 0.5; cursor: not-allowed; }
.co-list-opt .co-pick-path { grid-column: 1 / -1; }
.co-list-sep { border-top: 1px solid color-mix(in srgb, var(--co-rule) 60%, transparent); margin: 3px 0; }
.co-pick-wrap { position: relative; }

.co-memo-task { margin-top: 10px; }
.co-memo-task label { display: block; font-family: "Courier New", Courier, var(--co-mono); font-weight: 700; font-size: 12.5px; margin-bottom: 4px; }
.co-memo textarea, .co-memo .co-input { width: 100%; color: var(--co-ink); background: var(--co-field); border: 1px solid var(--co-rule); border-radius: 3px; font-size: 13px; }
.co-memo textarea { font-family: var(--co-mono); line-height: 1.5; padding: 7px 9px; min-height: 96px; resize: vertical; display: block; }
.co-memo textarea::placeholder { color: var(--co-ink-dim); opacity: 1; }
.co-memo textarea:focus, .co-memo .co-input:focus { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.co-counter { text-align: right; font-size: 11px; color: var(--co-ink-dim); min-height: 14px; margin-top: 2px; }
.co-counter.over { color: #b3261e; font-weight: 700; }
.co-adv { margin-top: 4px; border-top: 1px solid color-mix(in srgb, var(--co-rule) 55%, transparent); padding-top: 6px; }
.co-adv summary { cursor: pointer; font-size: 12px; color: var(--co-ink-dim); font-weight: 600; user-select: none; }
.co-adv summary:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
.co-adv[open] summary { margin-bottom: 6px; }
.co-adv-body { display: grid; gap: 10px; }
.co-adv-label { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--co-ink-dim); margin-bottom: 4px; }
.co-cards { display: grid; gap: 4px; }
/* Model and effort, in the memo's main body */
.co-memo-opts { display: grid; gap: 8px; margin-top: 6px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--co-rule) 55%, transparent); }
.co-orow > .co-adv-label { margin-bottom: 4px; }
.co-effort { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.co-effort-def { display: inline-flex; align-items: center; max-width: 100%; min-height: 26px; padding: 3px 10px; border-radius: 14px; cursor: pointer; font-size: 12.5px;
  color: var(--co-ink); background: var(--co-field); border: 1px solid var(--co-rule); }
.co-effort-def > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-effort-def:not(:disabled):hover { border-color: var(--co-letterhead); }
.co-effort-def[aria-checked="true"] { background: var(--co-letterhead); color: #fff; border-color: var(--co-letterhead); }
.co-effort-def:disabled { opacity: 0.5; cursor: default; }
.co-pips { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--co-rule); border-radius: 4px; background: var(--co-field); }
.co-pip { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 3px; width: 46px; min-height: 42px; padding: 4px 2px 3px;
  border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--co-ink); cursor: pointer; font-size: 11px; line-height: 13px; }
.co-pip-bar { display: block; width: 14px; border-radius: 1px; background: color-mix(in srgb, var(--co-ink) 10%, transparent); border: 1px solid color-mix(in srgb, var(--co-ink) 32%, transparent); }
.co-pip:nth-child(1) .co-pip-bar { height: 6px; } .co-pip:nth-child(2) .co-pip-bar { height: 9px; } .co-pip:nth-child(3) .co-pip-bar { height: 12px; }
.co-pip:nth-child(4) .co-pip-bar { height: 15px; } .co-pip:nth-child(5) .co-pip-bar { height: 18px; }
.co-pip[data-fill="on"] .co-pip-bar { background: var(--co-letterhead); border-color: var(--co-letterhead); }
.co-pip[data-fill="ghost"] .co-pip-bar { background: color-mix(in srgb, var(--co-letterhead) 30%, transparent); border-color: color-mix(in srgb, var(--co-letterhead) 55%, transparent); }
.co-pip:not(:disabled):not([aria-disabled="true"]):hover { background: color-mix(in srgb, var(--co-letterhead) 8%, transparent); }
.co-pip[aria-checked="true"] { font-weight: 700; background: color-mix(in srgb, var(--co-letterhead) 12%, transparent); border-color: color-mix(in srgb, var(--co-letterhead) 45%, transparent); }
.co-pip[aria-disabled="true"] { cursor: not-allowed; color: var(--co-ink-dim); }
.co-pip[aria-disabled="true"] .co-pip-bar { background: none; border-style: dashed; opacity: 0.6; }
.co-pip[aria-disabled="true"] .co-pip-label { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--co-ink-dim) 70%, transparent); opacity: 0.75; }
.co-pip:disabled { opacity: 0.5; cursor: default; }
.co-effort-note { color: var(--co-letterhead); }
.co-memo .co-opt { color: var(--co-ink); background: var(--co-field); border-color: var(--co-rule); padding: 5px 8px; }
.co-memo .co-opt[aria-checked="true"] { border-color: var(--co-letterhead); background: color-mix(in srgb, var(--co-letterhead) 10%, var(--co-field)); }
.co-memo .co-opt .co-mark { background: var(--co-field); border-color: var(--co-ink-dim); }
.co-memo .co-opt[aria-checked="true"] .co-mark { border-color: var(--co-letterhead); }
.co-memo .co-opt[aria-checked="true"] .co-mark.radio::after { background: var(--co-letterhead); }
.co-memo .co-opt-desc { color: var(--co-ink-dim); }
.co-summary { margin-top: 10px; padding: 7px 10px; border: 1px dashed var(--co-rule); border-radius: 3px; font-size: 12.5px; line-height: 1.45;
  background: color-mix(in srgb, var(--co-paper-2) 70%, transparent); display: flex; gap: 8px; align-items: flex-start; }
.co-summary .co-px { margin-top: 2px; }
.co-memo-err { flex: 1 0 100%; margin: 0; padding: 6px 10px; border-radius: 3px; color: #8c1d18; background: #f9dedc; border: 1px solid #e8a6a1; font-size: 12.5px; overflow-wrap: anywhere; }
.co-memo-err[hidden] { display: none; }
.co-memo-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
  /* Cancel and Send stay in view however long the memo gets. */
  position: sticky; bottom: calc(-1 * var(--co-memo-pb)); z-index: 2; margin: 4px 0 calc(-1 * var(--co-memo-pb)); padding: 8px 0 var(--co-memo-pb);
  background: var(--co-paper); }
.co-memo-foot .co-hint { color: var(--co-ink-dim); }
.co-memo .co-ghost { color: var(--co-ink); border-color: var(--co-rule); background: transparent; }
.co-memo .co-ghost:not(:disabled):hover { background: color-mix(in srgb, var(--co-ink) 8%, transparent); }
.co-sign { font-family: Georgia, "Times New Roman", serif; font-style: italic; }
.co-loading { font-size: 12px; color: var(--co-ink-dim); padding: 4px 0; }

/* Short, wide panels: the memo goes side by side so Send stays in view */
@media (max-height: 520px) and (min-width: 760px) {
  .co-memo { --co-memo-pb: 12px; width: min(940px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); column-gap: 24px; align-items: start; padding: 12px 20px; }
  .co-memo-right .co-memo-task { margin-top: 0; }
  .co-memo textarea { min-height: 56px; max-height: 76px; }
  .co-letterhead { padding: 2px 0 4px; gap: 3px; }
  .co-letterhead canvas:first-child { width: auto !important; height: 21px; }
  .co-letterhead canvas + canvas { width: auto !important; height: 10px; }
  .co-letter-rule { margin: 2px 0 6px; }
  .co-memo-kicker { margin-bottom: 4px; }
  .co-mrow { padding: 3px 0; }
  .co-summary { margin-top: 6px; padding: 5px 8px; }
  .co-memo-foot { padding-top: 6px; }
}
@media (max-height: 360px) and (min-width: 760px) {
  .co-memo .co-letter-rule, .co-memo .co-memo-kicker { display: none; }
  .co-memo .co-seg-note:not(.co-effort-note) { display: none; }
}
/* A very wide, short top panel (task 10.1: at 2000 x 333 the side-by-side memo scrolled and Approvals and the summary sat under
   the sticky Send row): three columns, the header | the task and its summary | the choices and Send, so it all fits. */
@media (max-height: 440px) and (min-width: 1500px) {
  .co-memo { width: min(1440px, 100%); grid-template-columns: minmax(0, 0.72fr) minmax(0, 2fr); }
  .co-memo-right { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 24px; align-items: start; }
  .co-memo-right > .co-memo-task { grid-column: 1; grid-row: 1 / 4; }
  .co-memo-right > .co-summary { grid-column: 1; grid-row: 4; margin-top: 6px; }
  .co-memo-right > .co-memo-opts { grid-column: 2; grid-row: 1; }
  .co-memo-right > .co-adv { grid-column: 2; grid-row: 2; }
  .co-memo-right > .co-plan-note { grid-column: 2; grid-row: 3; }
  .co-memo-right > .co-memo-foot { grid-column: 2; grid-row: 4; align-self: end; }
  .co-memo textarea { min-height: 96px; max-height: 150px; }
}

/* First-run tip pinned under the manager */
.co-tip { position: fixed; z-index: 6; width: max-content; max-width: min(300px, calc(100vw - 16px)); display: flex; align-items: flex-end; gap: 10px;
  padding: 8px 10px; color: var(--co-ink); background: var(--co-paper); border: 2px solid #3a3340; box-shadow: 3px 3px 0 rgba(0,0,0,0.35);
  font-size: 12.5px; line-height: 1.4; }
.co-tip[hidden] { display: none; }
.co-tip::before, .co-tip::after { content: ''; position: absolute; left: calc(var(--co-tip-ax, 24px) - 7px); border: 7px solid transparent; border-top: 0; }
.co-tip::before { top: -9px; border-bottom: 8px solid #3a3340; }
.co-tip::after { top: -5px; border-bottom: 7px solid var(--co-paper); left: calc(var(--co-tip-ax, 24px) - 7px); }
.co-tip strong { color: var(--co-letterhead); }
.co-tip .co-btn { flex: none; }

/* Keyboard stops over the props that open a panel (main.ts): invisible, the pointer goes through to the canvas; a ring on focus. */
.co-propstop { position: fixed; z-index: 3; margin: 0; padding: 0; border: 0; border-radius: 3px; background: transparent; pointer-events: none; }
.co-propstop[hidden] { display: none; }
.co-propstop:focus { outline: none; }
.co-propstop:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }

/* Floating "New task" when the roster is hidden */
.co-fab { position: fixed; z-index: 5; top: 6px; padding: 2px 9px; border-radius: 12px; font-size: 11.5px; opacity: 0.85; }
.co-fab:hover { opacity: 1; }
.co-fab[hidden] { display: none; }

@keyframes co-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes co-blink { 50% { opacity: 0; } }
@keyframes co-hop { 0%, 100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes co-bob { 0% { transform: translateY(0); } 100% { transform: translateY(-2px); } }
@keyframes co-flash { 0% { box-shadow: inset 0 0 0 2px var(--co-warn); } 100% { box-shadow: inset 0 0 0 2px transparent; } }
@media (prefers-reduced-motion: reduce) {
  .co-dots i, .co-knock .co-px, .co-head-status .co-dot, .co-pending.flash, .co-streaming .co-md *::after, .co-streaming .co-md:empty::after { animation: none !important; }
}
/* Hover tooltip: model chip + effort meter. Pips use currentColor so they follow the theme (and forced-colors). */
.tt-badge-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 2px 0 3px; }
.tt-chip { display: inline-block; max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 700; line-height: 1.4; white-space: nowrap; }
${TIP_CHIPS}
.tt-chip-other { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #ffffff); }
/* High contrast themes set contrastBorder (others don't): outline the chips there, as VS Code does its badges (the unknown-model chip is black on black otherwise). */
.tt-chip { box-shadow: inset 0 0 0 1px var(--vscode-contrastBorder, transparent); }
.tt-effort { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; }
.tt-effort > span:last-child { margin-left: 4px; }
.tt-pip { width: 6px; height: 6px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 1px; opacity: 0.45; }
.tt-pip-on { background: currentColor; opacity: 1; }
@media (forced-colors: active) { .tt-chip { border: 1px solid CanvasText; } }
`;

let injected = false;

/** Adds the Manager Mode stylesheet to the document (once). */
export function injectUiStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}
