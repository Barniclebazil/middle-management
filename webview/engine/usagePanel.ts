/**
 * The Usage panel (the wall clock): one horizontal bar per rate-limit window, the extra (pay-as-you-go) usage, how fresh
 * the reading is and a Refresh button. API-key users have no windows and see an estimated cost instead.
 *
 * The bars follow the dataviz rules: one thin bar per window with a 4px rounded data end, the fill carries the level and
 * the track is a lighter step of the same colour; the level is also written out (number plus words plus a shape) so colour
 * is never the only signal; the blocked state adds a diagonal texture. Colours are VS Code theme tokens, so dark, light and
 * high-contrast themes each get their own. Text nodes only.
 */
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { UsageSnapshot } from '../../src/shared/protocol.ts';
import { formatCost } from './caseLogic.ts';
import { button, h, pixelIcon } from './dom.ts';
import {
  costRows, extraRow, nextCheckText, probeNoteFor, refreshButtonState, REFRESH_COOLDOWN_MS, staleNote, usageBarRows,
} from './panelsLogic.ts';
import type { UsageLevel } from './usageLogic.ts';
import { costText, emptyUsageView, updatedText, windowTooltip } from './usageLogic.ts';

const CSS = `
.co-usage { --us-fg: var(--vscode-foreground, #cccccc); --us-dim: var(--vscode-descriptionForeground, #9d9d9d);
  --us-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
  --us-focus: var(--vscode-focusBorder, #007fd4);
  --us-ok: var(--vscode-charts-blue, #3794ff); --us-warn: var(--vscode-editorWarning-foreground, #cca700); --us-danger: var(--vscode-errorForeground, #f48771);
  --us-unknown: var(--vscode-descriptionForeground, #9d9d9d);
  display: flex; flex-direction: column; gap: 14px; }
.co-usage-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.co-usage-who { min-width: 0; display: flex; flex-direction: column; }
.co-usage-plan { font-weight: 600; font-size: 14px; }
.co-usage-updated { font-size: 12px; color: var(--us-dim); }
.co-usage-notes { display: flex; flex-direction: column; gap: 6px; }
.co-usage-notes:empty { display: none; }
.co-usage-note { margin: 0; padding: 6px 10px; font-size: 12px; border-radius: 4px; border: 1px solid var(--us-border); background: color-mix(in srgb, var(--us-fg) 6%, transparent); overflow-wrap: anywhere; }
.co-usage-note.warn { border-color: color-mix(in srgb, var(--us-warn) 55%, transparent); background: color-mix(in srgb, var(--us-warn) 11%, transparent); }
.co-usage-sec { display: flex; flex-direction: column; gap: 14px; }
.co-usage-h { margin: 0 0 -4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--us-dim); }
.co-usage-win { display: flex; flex-direction: column; gap: 5px; }
.co-usage-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.co-usage-label { font-size: 13px; }
.co-usage-pct { font-size: 18px; font-weight: 600; line-height: 1.1; }
.co-usage-big { font-size: 16px; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; text-align: right; }
.co-usage-bar { --u: var(--us-ok); position: relative; height: 10px; border-radius: 4px; overflow: hidden;
  background: color-mix(in srgb, var(--u) 24%, transparent); outline: 1px solid var(--vscode-contrastBorder, transparent); outline-offset: 0; }
.co-usage-bar[data-level="warn"] { --u: var(--us-warn); }
.co-usage-bar[data-level="danger"] { --u: var(--us-danger); }
.co-usage-bar[data-level="unknown"] { --u: var(--us-unknown); }
.co-usage-fill { height: 100%; width: calc(var(--f, 0) * 100%); min-width: 0; border-radius: 0 4px 4px 0; background: var(--u); }
.co-usage-bar[data-has="1"] .co-usage-fill { min-width: 3px; }
.co-usage-bar[data-blocked="1"] .co-usage-fill { background: repeating-linear-gradient(45deg, var(--u) 0 5px, color-mix(in srgb, var(--u) 55%, var(--vscode-sideBar-background, #1f1f1f)) 5px 9px); }
.co-usage-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 12px; color: var(--us-dim); }
.co-usage-level { display: inline-flex; align-items: center; gap: 5px; color: var(--us-fg); font-weight: 600; }
.co-usage-glyph { width: 8px; height: 8px; flex: none; background: var(--u, var(--us-ok)); }
.co-usage-glyph[data-level="ok"] { border-radius: 50%; --u: var(--us-ok); }
.co-usage-glyph[data-level="warn"] { clip-path: polygon(50% 0, 100% 100%, 0 100%); --u: var(--us-warn); }
.co-usage-glyph[data-level="danger"] { --u: var(--us-danger); }
.co-usage-glyph[data-level="unknown"] { border-radius: 50%; background: transparent; border: 1.5px solid var(--us-unknown); }
.co-usage-back { color: var(--us-fg); font-weight: 600; }
.co-usage-cost { display: flex; flex-direction: column; gap: 8px; }
.co-usage-cost-total { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.co-usage-rows { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.co-usage-rows li { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.co-usage-rows li span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-usage-rows li span:last-child { flex: none; color: var(--us-dim); font-variant-numeric: tabular-nums; }
.co-usage-foot { margin: 0; font-size: 11.5px; color: var(--us-dim); }
.co-usage-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 16px 8px; text-align: center; color: var(--us-dim); }
.co-usage-empty strong { color: var(--us-fg); font-size: 13.5px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** The countdown ("in 2h 10m") and "Updated 2 min ago" re-render this often. */
const TICK_MS = 30_000;

interface BarOpts {
  label: string;
  /** Large text at the right of the label line (a percentage or an amount). */
  big: string;
  fraction: number | null;
  level: UsageLevel;
  levelText: string;
  blocked?: boolean;
  /** Extra small texts after the level words. */
  subs: (string | HTMLElement)[];
  title?: string;
  bigClass?: string;
}

function bar(o: BarOpts): HTMLElement {
  const f = o.fraction === null ? 0 : Math.max(0, Math.min(1, o.fraction));
  const track = h('div', {
    class: 'co-usage-bar', role: 'meter', 'aria-label': `${o.label}: ${o.big}, ${o.levelText}`, 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': o.fraction === null ? null : String(Math.round(f * 100)), 'data-level': o.level, 'data-blocked': o.blocked ? '1' : null, 'data-has': f > 0 ? '1' : null,
    title: o.title ?? null,
  }, h('div', { class: 'co-usage-fill', style: `--f:${f}` }));
  return h('div', { class: 'co-usage-win' },
    h('div', { class: 'co-usage-line' }, h('span', { class: 'co-usage-label', text: o.label }), h('span', { class: o.bigClass ?? 'co-usage-pct', text: o.big })),
    track,
    h('div', { class: 'co-usage-sub' },
      h('span', { class: 'co-usage-level' }, h('span', { class: 'co-usage-glyph', 'data-level': o.level, 'aria-hidden': 'true' }), h('span', { text: o.levelText })),
      ...o.subs.map((s) => (typeof s === 'string' ? h('span', { text: s }) : s))));
}

/** Builds the Usage panel. Register it under id `usage`. */
export function createUsagePanel(): PanelView<HTMLElement> {
  let ctx: PanelContext<HTMLElement> | null = null;
  let topWho: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let notesEl: HTMLElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let cooldown: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock ms of the last Refresh click (a UI debounce, so real time, not `ctx.now()`). */
  let clickedAt: number | null = null;

  function updateButton(): void {
    if (!refreshBtn || !ctx) return;
    const s = refreshButtonState(ctx.usage()?.probe, clickedAt, Date.now());
    refreshBtn.textContent = s.label;
    refreshBtn.disabled = s.disabled;
    refreshBtn.title = s.title;
    refreshBtn.setAttribute('aria-busy', String(ctx.usage()?.probe === 'running'));
  }

  function render(): void {
    const c = ctx;
    if (!c || !topWho || !notesEl || !bodyEl) return;
    const snap: UsageSnapshot | null = c.usage();
    const now = c.now();

    topWho.replaceChildren(
      h('span', { class: 'co-usage-plan', text: snap?.plan ? `${snap.plan} plan` : snap?.kind === 'apiKey' ? 'API key' : 'Claude usage' }),
      h('span', { class: 'co-usage-updated', text: updatedText(snap, now) || 'Not read yet' }));
    updateButton();

    const notes: HTMLElement[] = [];
    const probe = probeNoteFor(snap);
    // With no bars and no cost view, the empty state below says it; a second note would repeat it.
    const noReading = !(snap && snap.kind === 'apiKey') && usageBarRows(snap, now).length === 0;
    if (probe && !noReading) notes.push(h('p', { class: 'co-usage-note warn', role: 'status', text: probe }));
    const stale = staleNote(snap, now);
    if (stale) notes.push(h('p', { class: 'co-usage-note', text: stale }));
    notesEl.replaceChildren(...notes);

    const sections: HTMLElement[] = [];
    if (snap && snap.kind === 'apiKey') {
      const { rows, total } = costRows(c.agents());
      sections.push(h('section', { class: 'co-usage-sec' }, h('h3', { class: 'co-usage-h', text: 'Estimated cost' }),
        h('div', { class: 'co-usage-cost' },
          h('div', { class: 'co-usage-cost-total' }, h('span', { text: 'All staff' }), h('span', { class: 'co-usage-big', text: costText(snap, total) || '≈ $0.00 at API prices' })),
          rows.length ? h('ul', { class: 'co-usage-rows' }, ...rows.slice(0, 6).map((r) => h('li', null, h('span', { text: r.title }), h('span', { text: `≈ ${formatCost(r.usd)}` })))) : null,
          h('p', { class: 'co-usage-foot', text: 'API-key billing has no usage windows. These figures are estimates from token counts, not a bill.' }))));
    } else {
      const rows = usageBarRows(snap, now);
      if (rows.length) {
        sections.push(h('section', { class: 'co-usage-sec' }, ...rows.map((r) => bar({
          label: r.label, big: r.pctText, fraction: r.fraction, level: r.level, levelText: r.levelText, blocked: r.blocked,
          title: windowTooltip(snap, r.id, now),
          subs: [r.blocked && r.backLine ? h('span', { class: 'co-usage-back', text: r.backLine }) : '', r.resetLine].filter((x): x is string | HTMLElement => x !== ''),
        }))));
      } else {
        const e = emptyUsageView(probe);
        sections.push(h('div', { class: 'co-usage-empty', role: 'status' }, pixelIcon('usage', 32), h('strong', { text: e.title }), e.hint ? h('span', { text: e.hint }) : null));
      }
    }
    const extra = extraRow(snap?.extra);
    if (extra) {
      sections.push(h('section', { class: 'co-usage-sec' }, h('h3', { class: 'co-usage-h', text: 'Extra usage' }), bar({
        label: 'This month', big: extra.usedText || '–', bigClass: 'co-usage-pct', fraction: extra.fraction, level: extra.level, levelText: extra.levelText,
        subs: [`of ${extra.limitText}${extra.pctText ? ` (${extra.pctText})` : ''}`],
      })));
    }
    const next = nextCheckText(snap, now);
    if (next) sections.push(h('p', { class: 'co-usage-foot', text: next }));
    bodyEl.replaceChildren(...sections);
  }

  return {
    id: 'usage',
    title: 'Usage',
    icon: 'usage',
    mount(body, c) {
      injectCss();
      ctx = c;
      topWho = h('div', { class: 'co-usage-who' });
      refreshBtn = button('Refresh', 'co-btn co-secondary co-small', () => {
        if (!ctx || (refreshBtn && refreshBtn.disabled)) return;
        ctx.post({ type: 'refreshUsage' });
        clickedAt = Date.now();
        if (cooldown !== null) clearTimeout(cooldown);
        cooldown = setTimeout(updateButton, REFRESH_COOLDOWN_MS + 50);
        updateButton();
      });
      notesEl = h('div', { class: 'co-usage-notes' });
      bodyEl = h('div', { class: 'co-usage-body', style: 'display:flex;flex-direction:column;gap:18px' });
      body.appendChild(h('div', { class: 'co-usage' }, h('div', { class: 'co-usage-top' }, topWho, refreshBtn), notesEl, bodyEl));
      render();
      tick = setInterval(render, TICK_MS);
      // Re-arm the button when the panel is reopened inside a cooldown.
      if (clickedAt !== null) {
        const left = REFRESH_COOLDOWN_MS - (Date.now() - clickedAt);
        if (left > 0) cooldown = setTimeout(updateButton, left + 50);
      }
    },
    refresh() {
      render();
    },
    unmount() {
      if (tick !== null) clearInterval(tick);
      if (cooldown !== null) clearTimeout(cooldown);
      tick = null;
      cooldown = null;
      ctx = null;
      topWho = null;
      refreshBtn = null;
      notesEl = null;
      bodyEl = null;
    },
  };
}
