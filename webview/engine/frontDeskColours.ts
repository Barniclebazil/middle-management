/**
 * The Front desk's Colours tab (task 3.11): the 17 office colours in five groups (walls and ceiling, floors, rug, chairs,
 * sign), each with a swatch (the native colour picker), a hex field as the fallback, "built-in" when the theme doesn't set
 * it, and a per-row reset; "Reset all"; a live sign preview and a contrast warning (with a one-click fix) when the sign
 * lettering is hard to read.
 *
 * Also exports the colour control and the sign preview the Staff tab reuses. Edits go through `api.edit('colors.<key>')`;
 * picker drags are throttled a little above the shell's 120 ms preview debounce. Registers itself with
 * `registerFrontDeskTab('colours', ...)` when imported. Text nodes only.
 */
import { BASE_C, OFFICE_COLOR_SHADES, drawPixelText, fitPixelText, measurePixelText, shadeLike, signRect, signTextRect } from '../art/index.ts';
import { OFFICE_COLOR_KEYS } from '../../src/shared/theme.ts';
import type { OfficeColorKey } from '../../src/shared/theme.ts';
import type { ChangeReason } from './frontDeskController.ts';
import { resetColors } from './frontDeskLogic.ts';
import { registerFrontDeskTab } from './frontDeskPanel.ts';
import type { FrontDeskTabApi, FrontDeskTabView } from './frontDeskPanel.ts';
import { colourGroups, effectiveColours, parseHex, signFix, signWarning, throttle } from './frontDeskStaffView.ts';
import type { ColourRowModel } from './frontDeskStaffView.ts';
import { button, h } from './dom.ts';

/** The built-in colour of every theme colour key (`BASE_C` through the shade table's first key). */
export const BUILTIN_COLOURS: Readonly<Record<OfficeColorKey, string>> = Object.freeze(
  Object.fromEntries(OFFICE_COLOR_KEYS.map((k) => [k, BASE_C[OFFICE_COLOR_SHADES[k][0]!]])) as Record<OfficeColorKey, string>,
);

/** Picker drags send at most one edit per this many ms (a little over the shell's 120 ms preview debounce). */
const DRAG_MS = 150;

const STYLE = `
.co-fd-cols { display: flex; flex-direction: column; gap: 12px; }
.co-fd-cols-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.co-fd-cols-top .co-fd-hint { flex: 1 1 180px; }
.co-fd-ghead { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 18px; }
.co-fd-count { font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); white-space: nowrap; }
.co-fd-rows { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }

/* One colour row: swatch | label | hex | reset */
.co-fd-crow { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 0; }
.co-fd-crow-label { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.co-fd-crow-name { font-size: 12.5px; overflow-wrap: anywhere; }
.co-fd-crow-tag { font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-crow-tag:empty { display: none; }
.co-fd-crow[data-src="builtin"] .co-fd-hex, .co-fd-crow[data-src="auto"] .co-fd-hex { color: var(--vscode-descriptionForeground, #9d9d9d); font-style: italic; }
.co-fd-crow[data-used="false"] { opacity: 0.62; }
.co-fd-crow[data-used="false"]:focus-within { opacity: 1; }
.co-fd-swatch { flex: none; position: relative; width: 34px; height: 26px; border-radius: 4px; overflow: hidden;
  border: 1px solid var(--vscode-contrastBorder, rgba(128,128,128,0.55)); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12); }
.co-fd-crow[data-src="builtin"] .co-fd-swatch, .co-fd-crow[data-src="auto"] .co-fd-swatch { border-style: dashed; }
.co-fd-swatch:focus-within { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-fd-swatch input { position: absolute; inset: -6px; width: calc(100% + 12px); height: calc(100% + 12px); padding: 0; margin: 0; border: 0; cursor: pointer; background: transparent; opacity: 0; }
.co-fd-swatch-fill { position: absolute; inset: 0; pointer-events: none; }
.co-fd-hex.co-input { flex: none; width: 82px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; }
.co-fd-hex[aria-invalid="true"] { border-color: var(--vscode-errorForeground, #f48771); outline-color: var(--vscode-errorForeground, #f48771); }
.co-fd-reset { flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 4px;
  cursor: pointer; font: inherit; font-size: 14px; line-height: 1; color: var(--vscode-foreground, #cccccc); background: transparent; }
.co-fd-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-fd-reset:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 0; }
.co-fd-reset[aria-hidden="true"] { visibility: hidden; }
.co-fd-err { margin: -1px 0 3px 42px; font-size: 11.5px; color: var(--vscode-errorForeground, #f48771); }
.co-fd-err:empty { display: none; }

.co-fd-sign { display: block; width: min(100%, 252px); height: auto; aspect-ratio: 84 / 28; margin: 2px auto 4px; image-rendering: pixelated; image-rendering: crisp-edges;
  border-radius: 3px; border: 1px solid var(--vscode-contrastBorder, rgba(128,128,128,0.35)); }
.co-fd-warn { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; padding: 8px 10px; border-radius: 4px; font-size: 12px;
  background: color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)) 50%, transparent); }
.co-fd-warn[hidden] { display: none; }
.co-fd-warn-t { margin: 0; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.co-fd-warn-t::before { content: "!"; display: inline-flex; align-items: center; justify-content: center; flex: none; width: 15px; height: 15px; border-radius: 50%;
  font-size: 11px; font-weight: 700; color: var(--vscode-editor-background, #1f1f1f); background: var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-warn p { margin: 0; overflow-wrap: anywhere; }
.co-fd-warn .co-btn { align-self: flex-start; }
`;

let cssInjected = false;
/** Injects the colour control's and the Colours tab's CSS (the Staff tab calls it too). */
export function injectColourCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------------------------------------------------
// The colour control (shared with the Staff tab)

export interface ColourRowState {
  /** The colour to show (own, built-in or worked out). */
  shown: string;
  /** Where it comes from: the theme ('own'), the built-in office or look ('builtin'), or worked out by the look ('auto'). */
  source: 'own' | 'builtin' | 'auto';
  /** The theme's own text when it is not a colour. */
  invalid?: string;
  /** False dims the row (a look colour that doesn't show on this look). */
  used?: boolean;
}

export interface ColourRow {
  el: HTMLElement;
  update(s: ColourRowState): void;
  unmount(): void;
}

export interface ColourRowOptions {
  /** Unique `data-k` stem for focus keeping, e.g. `col-wall` or `look-hair`. */
  k: string;
  label: string;
  /** An optional line under the label. */
  hint?: string;
  /** Sends a colour (`#rrggbb`) or null to clear it (back to the built-in). */
  send(hex: string | null): void;
  /** Tag text for the inherited states (default: "built-in" and "automatic"). */
  tags?: { builtin?: string; auto?: string };
}

/** A colour row: swatch (native picker), label with its built-in tag, hex field and reset. */
export function colourRow(opts: ColourRowOptions): ColourRow {
  injectColourCss();
  let state: ColourRowState = { shown: '#000000', source: 'builtin' };
  const fill = h('span', { class: 'co-fd-swatch-fill', 'aria-hidden': 'true' });
  const picker = h('input', { type: 'color', 'data-k': `${opts.k}-pick`, 'aria-label': `${opts.label} colour`, title: `Pick a colour for ${opts.label}` });
  const swatch = h('span', { class: 'co-fd-swatch' }, fill, picker);
  const tag = h('span', { class: 'co-fd-crow-tag' });
  const name = h('span', { class: 'co-fd-crow-name', text: opts.label });
  const label = h('span', { class: 'co-fd-crow-label' }, name, tag);
  const hex = h('input', {
    type: 'text', class: 'co-input co-fd-hex', 'data-k': `${opts.k}-hex`, maxlength: '7', spellcheck: 'false', autocomplete: 'off',
    'aria-label': `${opts.label}, hex colour`, placeholder: '#rrggbb',
  });
  const reset = button(h('span', { 'aria-hidden': 'true', text: '↺' }), 'co-fd-reset', () => {
    opts.send(null);
    hex.focus({ preventScroll: true });
  }, { 'data-k': `${opts.k}-reset`, 'aria-label': `Reset ${opts.label} to built-in`, title: 'Back to the built-in colour' });
  const err = h('p', { class: 'co-fd-err', role: 'alert' });
  const row = h('div', { class: 'co-fd-crow' }, swatch, label, hex, reset);
  const el = h('li', { class: 'co-fd-crow-wrap' }, row, err);
  if (opts.hint !== undefined) label.append(h('span', { class: 'co-fd-crow-tag co-fd-crow-hint', text: opts.hint }));

  const drag = throttle<string>((v) => { opts.send(v); }, DRAG_MS, {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (t) => { window.clearTimeout(t as number); },
    now: () => performance.now(),
  });

  function setError(text: string): void {
    err.textContent = text;
    if (text === '') hex.removeAttribute('aria-invalid');
    else hex.setAttribute('aria-invalid', 'true');
  }

  function showText(): string {
    return state.invalid ?? state.shown;
  }

  picker.addEventListener('input', () => {
    const v = picker.value.toLowerCase();
    fill.style.background = v;
    if (document.activeElement !== hex) hex.value = v;
    setError('');
    drag.push(v);
  });
  picker.addEventListener('change', () => { drag.flush(); });

  hex.addEventListener('input', () => {
    // Live while typing only once all six digits are there; "#abc" waits for Enter or blur.
    const r = /^\s*#?[0-9a-f]{6}\s*$/i.test(hex.value) ? parseHex(hex.value) : { kind: 'partial' as const };
    if (r.kind === 'ok') {
      setError('');
      fill.style.background = r.hex;
      picker.value = r.hex;
      if (r.hex !== state.shown || state.source !== 'own') opts.send(r.hex);
    } else if (err.textContent !== '') {
      setError('');
    }
  });
  const commit = (): void => {
    const r = parseHex(hex.value);
    if (r.kind === 'empty') {
      setError('');
      if (state.source === 'own') opts.send(null);
      hex.value = showText();
    } else if (r.kind === 'invalid') {
      setError('Use a colour like #a1b2c3 (or leave it empty for the built-in colour).');
    } else {
      setError('');
      hex.value = r.hex;
      if (r.hex !== state.shown || state.source !== 'own') opts.send(r.hex);
    }
  };
  hex.addEventListener('blur', commit);
  hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && (hex.value !== showText() || err.textContent !== '')) {
      // Escape puts the text back; it must not also close the drawer.
      e.stopPropagation();
      e.preventDefault();
      hex.value = showText();
      setError('');
    }
  });

  return {
    el,
    update(s) {
      state = s;
      row.dataset['src'] = s.source;
      row.dataset['used'] = String(s.used !== false);
      tag.textContent = s.invalid !== undefined ? 'not a colour: the office ignores it' : s.source === 'builtin' ? (opts.tags?.builtin ?? 'built-in') : s.source === 'auto' ? (opts.tags?.auto ?? 'automatic') : '';
      fill.style.background = s.shown;
      if (document.activeElement !== picker) picker.value = s.shown;
      if (document.activeElement !== hex) {
        hex.value = showText();
        if (s.invalid === undefined) setError('');
      }
      const own = s.source === 'own';
      reset.setAttribute('aria-hidden', String(!own));
      reset.tabIndex = own ? 0 : -1;
    },
    unmount() {
      drag.flush();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The sign preview (shared with the Staff tab's office sign page)

/** Canvas size of the sign preview, in sprite pixels: the plate with a little wall round it. */
export const SIGN_PREVIEW_W = 84;
export const SIGN_PREVIEW_H = 28;

/** A canvas for `drawSignPreview`. */
export function signCanvas(label = 'Preview of the office sign'): HTMLCanvasElement {
  injectColourCss();
  const c = h('canvas', { class: 'co-fd-sign co-px', role: 'img', 'aria-label': label });
  c.width = SIGN_PREVIEW_W;
  c.height = SIGN_PREVIEW_H;
  return c;
}

/** Draws the office sign as it will look: plate, bolts and lettering in `colours`, on a strip of wall. */
export function drawSignPreview(canvas: HTMLCanvasElement, colours: Readonly<Record<OfficeColorKey, string>>, company: string, branch: string): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  const W = SIGN_PREVIEW_W;
  const H = SIGN_PREVIEW_H;
  const wall = colours.wall;
  g.fillStyle = wall;
  g.fillRect(0, 0, W, H);
  g.fillStyle = shadeLike(wall, BASE_C.wall, BASE_C.wallShade);
  g.fillRect(0, H - 2, W, 2);
  const r = { x: Math.floor((W - signRect.w) / 2), y: 3, w: signRect.w, h: signRect.h };
  const plate = colours.signPlate;
  g.fillStyle = 'rgba(29, 21, 32, 0.3)';
  g.fillRect(r.x + 1, r.y + r.h, r.w, 1);
  g.fillStyle = shadeLike(plate, BASE_C.signPlate, BASE_C.signPlateEdge);
  g.fillRect(r.x, r.y, r.w, r.h);
  g.fillStyle = plate;
  g.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  g.fillStyle = shadeLike(plate, BASE_C.signPlate, BASE_C.signPlateLight);
  g.fillRect(r.x + 1, r.y + 1, r.w - 2, 1);
  g.fillStyle = shadeLike(plate, BASE_C.signPlate, BASE_C.signPlateShade);
  g.fillRect(r.x + 2, r.y + r.h - 2, r.w - 4, 1);
  g.fillStyle = BASE_C.metalLight;
  for (const bx of [r.x + 2, r.x + r.w - 3]) g.fillRect(bx, r.y + 2, 1, 1);
  const shadow = shadeLike(plate, BASE_C.signPlate, BASE_C.signTextShadow);
  const tx = r.x + (signTextRect.x - signRect.x);
  const ty = r.y + (signTextRect.y - signRect.y);
  const line = (text: string, y: number, col: string): void => {
    const t = fitPixelText(text, signTextRect.w);
    const m = measurePixelText(t);
    drawPixelText(g, t, tx + Math.floor((signTextRect.w - m.w) / 2), y, col, 1, shadow);
  };
  if (branch.trim() !== '') {
    line(company, ty + 1, colours.signText);
    line(branch, ty + 8, colours.signBranch);
  } else {
    line(company, ty + Math.floor((signTextRect.h - 5) / 2), colours.signText);
  }
}

/** The company and branch the sign shows: the draft's, else the user's settings. */
export function signWords(api: FrontDeskTabApi): { company: string; branch: string } {
  const d = api.draft();
  const s = api.hostState().settings;
  const company = (typeof d.company === 'string' && d.company.trim() !== '' ? d.company : String(s.companyName.value)).trim();
  const branch = (typeof d.branch === 'string' && d.branch.trim() !== '' ? d.branch : String(s.branchName.value)).trim();
  return { company, branch };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tab

function rowState(r: ColourRowModel): ColourRowState {
  const s: ColourRowState = { shown: r.value, source: r.inherited ? 'builtin' : 'own' };
  if (r.invalid !== undefined) s.invalid = r.invalid;
  return s;
}

/** Builds the Colours tab. Registered below with `registerFrontDeskTab('colours', ...)`. */
export function createColoursTab(api: FrontDeskTabApi): FrontDeskTabView {
  injectColourCss();
  const rows = new Map<OfficeColorKey, ColourRow>();
  const counts = new Map<string, HTMLElement>();
  const send = (key: OfficeColorKey) => (hex: string | null): void => { api.edit(`colors.${key}`, hex); };

  const resetAll = button('Reset all', 'co-btn co-secondary co-small', () => {
    api.update(resetColors);
    resetAll.blur();
    (root.querySelector<HTMLElement>('.co-fd-hex') ?? root).focus({ preventScroll: true });
  }, { 'data-k': 'reset-all', title: 'Every colour back to the built-in office' });
  const summary = h('span', { class: 'co-fd-count', role: 'status' });
  const top = h('section', { class: 'co-fd-card', 'aria-label': 'Office colours' },
    h('div', { class: 'co-fd-cols-top' },
      h('p', { class: 'co-fd-hint', text: 'Changes show in the office straight away; Save keeps them. A dashed swatch is the built-in colour.' }),
      h('div', { class: 'co-fd-ghead' }, summary, resetAll)));

  const sign = signCanvas();
  const warnTitle = h('p', { class: 'co-fd-warn-t' });
  const warnText = h('p');
  const fixBtn = button('Fix it', 'co-btn co-secondary co-small', () => {
    const fix = signFix(api.draft().colors, BUILTIN_COLOURS);
    if (fix === null) return;
    api.update((d) => {
      let next = d;
      for (const [k, v] of Object.entries(fix)) next = { ...next, colors: { ...(next.colors ?? {}), [k]: v } };
      return next;
    });
    rows.get('signText')?.el.querySelector<HTMLElement>('.co-fd-hex')?.focus({ preventScroll: true });
  }, { 'data-k': 'sign-fix' });
  const warn = h('div', { class: 'co-fd-warn', role: 'status' }, warnTitle, warnText, fixBtn);
  warn.hidden = true;

  const sections: HTMLElement[] = [];
  for (const g of colourGroups(api.draft().colors, BUILTIN_COLOURS)) {
    const list = h('ul', { class: 'co-fd-rows' });
    for (const r of g.rows) {
      const row = colourRow({ k: `col-${r.key}`, label: r.label, send: send(r.key) });
      rows.set(r.key, row);
      list.append(row.el);
    }
    const count = h('span', { class: 'co-fd-count' });
    counts.set(g.id, count);
    const sec = h('section', { class: 'co-fd-card', 'aria-labelledby': `co-fd-cg-${g.id}` },
      h('div', { class: 'co-fd-ghead' }, h('h3', { class: 'co-fd-h', id: `co-fd-cg-${g.id}`, text: g.title }), count));
    if (g.hint !== undefined) sec.append(h('p', { class: 'co-fd-hint', text: g.hint }));
    if (g.id === 'sign') sec.append(sign);
    sec.append(list);
    if (g.id === 'sign') sec.append(warn);
    sections.push(sec);
  }
  const root = h('div', { class: 'co-fd-cols' }, top, ...sections);

  function render(): void {
    const colors = api.draft().colors;
    const groups = colourGroups(colors, BUILTIN_COLOURS);
    let total = 0;
    for (const g of groups) {
      total += g.customised;
      const c = counts.get(g.id);
      if (c) c.textContent = g.customised === 0 ? 'built-in' : `${g.customised} of ${g.rows.length} changed`;
      for (const r of g.rows) rows.get(r.key)?.update(rowState(r));
    }
    summary.textContent = total === 0 ? 'All built-in' : `${total} of ${OFFICE_COLOR_KEYS.length} set`;
    resetAll.disabled = colors === undefined || Object.keys(colors).length === 0;
    const w = signWarning(colors, BUILTIN_COLOURS);
    warn.hidden = w === null;
    if (w !== null) {
      warnTitle.textContent = w.title;
      warnText.textContent = w.detail;
      fixBtn.textContent = w.direction === 'lighter' ? 'Use lighter lettering' : 'Use darker lettering';
    }
    const words = signWords(api);
    drawSignPreview(sign, effectiveColours(colors, BUILTIN_COLOURS), words.company, words.branch);
  }

  render();

  return {
    el: root,
    refresh(reason: ChangeReason | 'show') {
      if (reason === 'editor') return;
      render();
    },
    unmount() {
      for (const r of rows.values()) r.unmount();
    },
  };
}

registerFrontDeskTab('colours', createColoursTab);
