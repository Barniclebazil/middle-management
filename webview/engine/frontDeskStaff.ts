/**
 * The Front desk's Staff tab (task 3.11): everyone in the office, with a page each where you dress them up.
 *
 * - The list (from `slotList`): the office sign, the Manager, the Receptionist, Staff 1-8 (with their desk) and Temps 1-6,
 *   each with a portrait of the look as it is in the draft, its name, and "custom" / "unsaved" marks. Arrow keys, Home,
 *   End, PageUp and PageDown move between rows; Enter or a click opens one.
 * - A person's page: a large animated preview (`lookPreview.ts`), name and role (inherited values show as dimmed
 *   placeholders marked "built-in", with a clear button), lines, a pin, and the look editor: head, build, outfit and
 *   skin as picture choices drawn with the person's own colours, colour rows (picker plus a hex field), the on/off
 *   options, "More" for fields that don't show on this look (`lookFieldUse`), per-field resets and "Reset to built-in look".
 * - The office sign's page: company and branch, a sign preview, and a way to the sign colours on the Colours tab.
 * - Layout: from 420 px wide the list sits beside the page; below that the list pushes the page as a drawer sub-view
 *   (`ctx.push`), whose back button (or Escape) returns to the list.
 *
 * Edits go through `api.edit` / `api.update`; the shell previews, persists and shows the footer. Registers itself with
 * `registerFrontDeskTab('staff', ...)` when imported. Text nodes only.
 */
import {
  CHAR_HEADROOM, LOOKS, buildLook, builtinLookIdOf, builtinSpecOf, getCharacterFrame, lookFieldUse, registerLook,
} from '../art/index.ts';
import type { LookDef, LookSpecLike } from '../art/index.ts';
import type { PanelContext, PanelView } from '../../src/shared/panels.ts';
import type { LookSpec, OfficeTheme } from '../../src/shared/theme.ts';
import { THEME_LIMITS } from '../../src/shared/theme.ts';
import type { ChangeReason } from './frontDeskController.ts';
import { DEFAULT_BUILTIN_TEXT, LOOK_FIELDS, inheritedLook, inheritedText, parseSlotId, previewTheme, resetLook, slotList } from './frontDeskLogic.ts';
import type { Draft, FieldValue, SlotEntry, SlotId } from './frontDeskLogic.ts';
import { registerFrontDeskTab } from './frontDeskPanel.ts';
import type { FrontDeskTabApi, FrontDeskTabView } from './frontDeskPanel.ts';
import {
  LOOK_FIELD_HINTS, LOOK_FIELD_PAL_KEY, editLines, effectiveColours, hasOwnLook, linesCount, listMove, lookFieldModels, lookLayoutKey,
  lookSections, optionLabel, rawLines, rawText, slotFeatures, slotLookOf, staffLayout,
} from './frontDeskStaffView.ts';
import type { LookFieldModel, LookSections, StaffLayout } from './frontDeskStaffView.ts';
import { BUILTIN_COLOURS, colourRow, drawSignPreview, injectColourCss, signCanvas, signWords } from './frontDeskColours.ts';
import type { ColourRow } from './frontDeskColours.ts';
import { createLookPreview, LOOK_PREVIEW_ID } from './lookPreview.ts';
import type { LookPreview } from './lookPreview.ts';
import { FACE_H, FACE_W, button, h, paintPortrait } from './dom.ts';

// ---------------------------------------------------------------------------------------------------------------------
// CSS

const STYLE = `
.co-fd-staff { min-width: 0; container: fdstaff / inline-size; }
.co-fd-staff-in[data-layout="split"] { display: grid; grid-template-columns: minmax(160px, 34%) minmax(0, 1fr); gap: 12px; align-items: start; }
.co-fd-staff-in[data-layout="stack"] .co-fd-detail { display: none; }
.co-fd-slotnav { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.co-fd-staff-in[data-layout="split"] .co-fd-slotnav { position: sticky; top: 0; max-height: calc(100vh - 150px); overflow-y: auto; scrollbar-width: thin; padding-right: 2px; }
.co-fd-slotgroup { margin: 10px 2px 3px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-slotgroup:first-child { margin-top: 0; }
.co-fd-slots { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
.co-fd-slot { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 4px 8px 4px 5px; border-radius: 5px; cursor: pointer; text-align: left;
  font: inherit; color: var(--vscode-foreground, #cccccc); background: transparent; border: 1px solid transparent; }
.co-fd-slot:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
.co-fd-slot:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: -2px; }
.co-fd-slot[aria-current="true"] { background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.22));
  border-color: var(--vscode-contrastActiveBorder, transparent); }
.co-fd-slot-face { flex: none; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
  background: color-mix(in srgb, var(--vscode-foreground, #cccccc) 8%, transparent); border: 1px solid var(--vscode-contrastBorder, transparent); }
.co-fd-slot-face canvas { width: 28px; height: 28px; image-rendering: pixelated; image-rendering: crisp-edges; }
.co-fd-slot-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.co-fd-slot-name, .co-fd-slot-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-fd-slot-name { font-size: 13px; font-weight: 600; }
.co-fd-slot-name.inherited { font-weight: 400; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-slot-label { font-size: 11.5px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-slot-marks { flex: none; display: inline-flex; align-items: center; gap: 5px; }
.co-fd-mark-custom { padding: 0 5px; border-radius: 8px; font-size: 10.5px; line-height: 15px; color: var(--vscode-foreground, #cccccc);
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 60%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 14%, transparent); }
.co-fd-mark-changed { width: 8px; height: 8px; border-radius: 50%; background: var(--co-warn, var(--vscode-editorWarning-foreground, #cca700)); }
.co-fd-slot-chev { flex: none; font-size: 15px; line-height: 1; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-staff-in[data-layout="split"] .co-fd-slot-chev { display: none; }
.co-fd-staff-in[data-layout="split"] .co-fd-mark-custom { display: none; }
.co-fd-staff-intro { margin: 0 2px 8px; }
.co-fd-staff-in[data-layout="split"] .co-fd-staff-intro { display: none; }

.co-fd-detail { min-width: 0; }
.co-fd-page { display: flex; flex-direction: column; gap: 12px; min-width: 0; container: fdpage / inline-size; }
/* Between 420 and 580 px the list beside the page is a rail of portraits (names stay for screen readers and tooltips). */
@container fdstaff (max-width: 579px) {
  .co-fd-staff-in[data-layout="split"] { grid-template-columns: 48px minmax(0, 1fr); gap: 10px; }
  .co-fd-staff-in[data-layout="split"] .co-fd-slot { position: relative; justify-content: center; padding: 3px; }
  .co-fd-staff-in[data-layout="split"] .co-fd-slot-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .co-fd-staff-in[data-layout="split"] .co-fd-slot-marks { position: absolute; top: 2px; right: 2px; }
  .co-fd-staff-in[data-layout="split"] .co-fd-slotgroup { height: 1px; margin: 7px 6px; overflow: hidden; color: transparent;
    background: var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
  .co-fd-staff-in[data-layout="split"] .co-fd-staff-intro + .co-fd-slotgroup { display: none; }
}
@container fdpage (max-width: 300px) {
  .co-fd-crow-hint { display: none; }
  .co-fd-hex.co-input { width: 72px; }
}
.co-fd-page:focus { outline: none; }
.co-fd-hero { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 14px; }
.co-fd-hero-text { flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.co-fd-kicker { margin: 0; font-size: 11.5px; color: var(--vscode-descriptionForeground, #9d9d9d); overflow-wrap: anywhere; }
.co-fd-pname { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
.co-fd-pname:focus, .co-fd-pname:focus-visible { outline: none; }
.co-fd-pchips { display: flex; flex-wrap: wrap; gap: 5px; }
.co-fd-pchip { padding: 0 7px; border-radius: 9px; font-size: 11px; line-height: 17px; white-space: nowrap; color: var(--vscode-foreground, #cccccc);
  border: 1px solid var(--vscode-contrastBorder, rgba(128,128,128,0.4)); }
.co-fd-pchip.custom { border-color: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 60%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 14%, transparent); }
.co-fd-pchip.changed { border-color: color-mix(in srgb, var(--co-warn, #cca700) 60%, transparent); background: color-mix(in srgb, var(--co-warn, #cca700) 16%, transparent); }
.co-fd-hero .co-fd-sign { margin: 0; flex: 1 1 200px; width: 100%; max-width: 336px; }

.co-fd-sechead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.co-fd-tf { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.co-fd-tf + .co-fd-tf { margin-top: 6px; }
.co-fd-tf-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.co-fd-tf-head label { font-weight: 600; font-size: 12.5px; }
.co-fd-tag { font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-tag:empty { display: none; }
.co-fd-tag.builtin::before { content: "• "; }
.co-fd-tf-row { display: flex; align-items: center; gap: 4px; }
.co-fd-tf-row .co-input { flex: 1 1 auto; min-width: 0; }

.co-fd-look-body { display: flex; flex-direction: column; gap: 12px; }
.co-fd-sub { margin: 4px 0 0; font-size: 11.5px; font-weight: 600; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-field-h { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; margin-bottom: 5px; }
.co-fd-field-h .lbl { font-weight: 600; font-size: 12.5px; }
.co-fd-field-h .val { font-size: 12px; }
.co-fd-field-h .co-link { font-size: 11.5px; }
.co-fd-pick { display: flex; flex-wrap: wrap; gap: 4px; }
.co-fd-pick-opt { position: relative; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 2px; min-width: 34px;
  border-radius: 6px; cursor: pointer; font: inherit; font-size: 10.5px; color: var(--vscode-foreground, #cccccc);
  background: color-mix(in srgb, var(--vscode-foreground, #cccccc) 5%, transparent);
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))); }
.co-fd-pick-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16)); }
.co-fd-pick-opt[aria-checked="true"] { border-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007fd4));
  box-shadow: inset 0 0 0 1px var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007fd4));
  background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 16%, transparent); }
.co-fd-pick-opt:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-fd-pick-opt canvas { image-rendering: pixelated; image-rendering: crisp-edges; display: block; border-radius: 3px; background: #ddd4bf; }
.co-fd-pick-opt.builtin::after { content: ""; position: absolute; top: 3px; right: 3px; width: 5px; height: 5px; border-radius: 50%;
  background: var(--vscode-descriptionForeground, #9d9d9d); }
.co-fd-pick.text .co-fd-pick-opt { padding: 4px 9px; font-size: 12px; }
.co-fd-skin { width: 30px; height: 30px; padding: 3px; }
.co-fd-skin span { display: block; width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.25); }
.co-fd-opts { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.co-fd-optrow { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.co-fd-optrow label { flex: 1 1 auto; display: inline-flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; font-size: 12.5px; }
.co-fd-optrow input { width: 16px; height: 16px; margin: 0; accent-color: var(--vscode-focusBorder, #007fd4); }
.co-fd-optrow input:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-fd-optrow[data-used="false"] { opacity: 0.62; }
.co-fd-more { border-top: 1px dashed var(--vscode-contrastBorder, rgba(128,128,128,0.35)); padding-top: 8px; }
.co-fd-more > summary { cursor: pointer; font-size: 12.5px; color: var(--vscode-textLink-foreground, #3794ff); list-style-position: inside; border-radius: 3px; }
.co-fd-more > summary:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
.co-fd-more > .co-fd-hint { margin: 6px 0; }
.co-fd-crow-hint { font-style: normal; }

.co-fd-lines { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.co-fd-line { display: flex; align-items: center; gap: 4px; }
.co-fd-line .co-input { flex: 1 1 auto; min-width: 0; }
.co-fd-line-n { flex: none; width: 20px; text-align: right; font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); font-variant-numeric: tabular-nums; }
.co-fd-lines-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

.co-fd-subbody { padding-bottom: 0 !important; }
.co-fd-subbar { position: sticky; bottom: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  margin: 12px -12px 0; padding: 8px 12px 10px; font-size: 12.5px; font-weight: 600;
  border-top: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)) 94%, var(--vscode-foreground, #cccccc) 6%); }
.co-fd-subbar[hidden] { display: none; }
.co-fd-subbar span { display: inline-flex; align-items: center; gap: 7px; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------------------------------------------------
// Looks for portraits and picture choices

/** The built-in look a slot starts from. */
function baseLookOf(slot: SlotId): LookDef {
  return LOOKS[builtinLookIdOf(slot) ?? 'temp0'] ?? LOOKS['temp0']!;
}

const lookCache = new Map<string, { key: string; def: LookDef }>();

/** Builds (and registers, under `id`) a look; does nothing when the same spec was registered last time. */
function ensureLook(id: string, spec: LookSpecLike, base: LookDef): { def: LookDef; changed: boolean } {
  const key = `${base.id}|${JSON.stringify(spec)}`;
  const hit = lookCache.get(id);
  if (hit !== undefined && hit.key === key) return { def: hit.def, changed: false };
  const def = buildLook(id, spec, base);
  registerLook(def);
  lookCache.set(id, { key, def });
  return { def, changed: true };
}

let themeMemo: { draft: Draft; theme: OfficeTheme } | null = null;

/** The draft as the office shows it (invalid values left out), memoised per draft object (drafts are never mutated). */
function shownTheme(draft: Draft): OfficeTheme {
  if (themeMemo !== null && themeMemo.draft === draft) return themeMemo.theme;
  const theme = previewTheme(draft);
  themeMemo = { draft, theme };
  return theme;
}

/** The look spec a slot has in the draft (valid fields only). */
function lookSpecOf(draft: Draft, slot: SlotId): LookSpec {
  return slotLookOf(shownTheme(draft), slot) ?? {};
}

function faceCanvas(): HTMLCanvasElement {
  const c = h('canvas', { class: 'co-px', 'aria-hidden': 'true' });
  c.width = FACE_W;
  c.height = FACE_H;
  return c;
}

/** A tiny sign plate for the list row of the office sign. */
function paintSignIcon(c: HTMLCanvasElement, draft: Draft): void {
  const g = c.getContext('2d');
  if (!g) return;
  const col = effectiveColours(draft.colors, BUILTIN_COLOURS);
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#1d1520';
  g.fillRect(0, 3, 14, 9);
  g.fillStyle = col.signPlate;
  g.fillRect(1, 4, 12, 7);
  g.fillStyle = col.signText;
  g.fillRect(3, 6, 8, 1);
  g.fillStyle = col.signBranch;
  g.fillRect(4, 8, 6, 1);
  g.fillStyle = 'rgba(29,21,32,0.35)';
  g.fillRect(1, 12, 13, 1);
}

// ---------------------------------------------------------------------------------------------------------------------
// Module state: what each Staff tab remembers across remounts, and "open this person" requests

interface StaffMemory {
  /** The person shown (split) or last opened (stack). */
  slot: SlotId;
  /** Row to focus when the tab comes back from a person's sub-view. */
  returnTo: SlotId | null;
  /** "More" is open in the look editor. */
  moreOpen: boolean;
  /**
   * The person whose page a close attempt popped (narrow layout: the unsaved-changes prompt lives on the root view). "Keep
   * editing" reopens it, so the user is back where they were instead of on the list.
   */
  reopen: SlotId | null;
}

const memories = new WeakMap<object, StaffMemory>();
function memoryOf(api: FrontDeskTabApi): StaffMemory {
  let m = memories.get(api);
  if (m === undefined) {
    m = { slot: 'manager', returnTo: null, moreOpen: false, reopen: null };
    memories.set(api, m);
  }
  return m;
}

let pendingOpen: SlotId | null = null;
const openers = new Set<() => void>();

/**
 * Asks the Staff tab to open a person's page (`'sign'`, `'manager'`, `'staff-2'`, ...): at once when a Staff tab is
 * showing, else when it is next built. The caller switches to the Staff tab itself (`openTab('staff')`).
 */
export function openStaffSlot(slot: SlotId): void {
  if (parseSlotId(slot) === null) return;
  pendingOpen = slot;
  for (const f of [...openers]) f();
}

function shortLabel(e: SlotEntry): string {
  return e.label.split(' · ')[0] ?? e.label;
}

/** The title of a person's page (and of the sub-view's drawer header). */
function pageTitle(e: SlotEntry): string {
  if (e.group === 'sign') return 'Office sign';
  return e.named ? e.name : shortLabel(e);
}

function entryOf(api: FrontDeskTabApi, slot: SlotId): SlotEntry {
  const e = slotList(api.draft(), api.hostTheme()).find((x) => x.id === slot);
  return e ?? { id: slot, group: 'temp', label: slot, name: slot, named: false, customised: false, changed: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// A person's page

interface PageEnv {
  /** True inside the pushed sub-view: no shell refresh comes after an edit, so the page refreshes itself. */
  sub: boolean;
  /** Go back to the list (sub-view only). */
  back?: () => void;
  /** Called after each edit the page makes (the sub-view updates its "Unsaved changes" bar). */
  afterChange?: () => void;
}

interface SlotPage {
  el: HTMLElement;
  refresh(): void;
  /** Focuses the page heading (for screen readers and so Tab continues into the page). */
  focusHeading(): void;
  unmount(): void;
}

interface TextFieldOpts {
  k: string;
  label: string;
  path: string;
  max: number;
  read: () => string;
  /** What shows when it is empty (the built-in or settings value), and the tag that says where it comes from. */
  fallback: () => { text: string; tag: string };
  hint?: string;
}

function createSlotPage(api: FrontDeskTabApi, slot: SlotId, env: PageEnv): SlotPage {
  injectCss();
  injectColourCss();
  const features = slotFeatures(slot);
  const parsed = parseSlotId(slot);
  const base = baseLookOf(slot);
  const updaters: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  let dead = false;

  const edit = (path: string, value: FieldValue): void => {
    if (dead) return;
    api.edit(path, value);
    if (env.sub) refresh();
    env.afterChange?.();
  };
  const update = (fn: (d: Draft) => Draft): void => {
    if (dead) return;
    api.update(fn);
    if (env.sub) refresh();
    env.afterChange?.();
  };

  // ---- Hero
  const kicker = h('p', { class: 'co-fd-kicker' });
  const title = h('h3', { class: 'co-fd-pname', tabindex: '-1' });
  const chips = h('div', { class: 'co-fd-pchips' });
  const heroText = h('div', { class: 'co-fd-hero-text' }, kicker, title, chips);
  const hero = h('section', { class: 'co-fd-card co-fd-hero', 'aria-label': 'Preview' });
  let preview: LookPreview | null = null;
  let sign: HTMLCanvasElement | null = null;
  if (features.sign) {
    sign = signCanvas();
    hero.append(heroText, sign);
  } else {
    preview = createLookPreview({ id: LOOK_PREVIEW_ID });
    cleanups.push(() => { preview?.unmount(); });
    hero.append(preview.el, heroText);
  }
  if (parsed?.group === 'staff') heroText.append(h('p', { class: 'co-fd-hint', text: `Sits at the ${DEFAULT_BUILTIN_TEXT.desk!(parsed.index!)} desk.` }));
  if (parsed?.group === 'temp') heroText.append(h('p', { class: 'co-fd-hint', text: 'Temps step in when all eight desks are taken, in turn.' }));

  updaters.push(() => {
    const e = entryOf(api, slot);
    title.textContent = pageTitle(e);
    kicker.textContent = e.group === 'sign' ? 'Above the lobby' : e.label === title.textContent ? 'No name yet' : e.label;
    const c: HTMLElement[] = [];
    if (features.look) c.push(h('span', { class: `co-fd-pchip${hasOwnLook(api.draft(), slot) ? ' custom' : ''}`, text: hasOwnLook(api.draft(), slot) ? 'Own look' : 'Built-in look' }));
    else c.push(h('span', { class: `co-fd-pchip${e.customised ? ' custom' : ''}`, text: e.customised ? 'Customised' : 'Built-in' }));
    if (e.changed) c.push(h('span', { class: 'co-fd-pchip changed', text: 'Unsaved changes' }));
    chips.replaceChildren(...c);
    preview?.setLabel(`${pageTitle(e)}, animated preview`);
    if (sign) {
      const w = signWords(api);
      drawSignPreview(sign, effectiveColours(api.draft().colors, BUILTIN_COLOURS), w.company, w.branch);
    }
  });

  // ---- Text fields
  function textField(o: TextFieldOpts): HTMLElement {
    const id = `co-fd-${o.k}`;
    const input = h('input', { type: 'text', id, class: 'co-input', 'data-k': o.k, maxlength: String(o.max), autocomplete: 'off', spellcheck: 'false' });
    const tag = h('span', { class: 'co-fd-tag' });
    const clear = button(h('span', { 'aria-hidden': 'true', text: '×' }), 'co-fd-reset', () => {
      edit(o.path, null);
      input.value = '';
      input.focus({ preventScroll: true });
    }, { 'data-k': `${o.k}-clear`, 'aria-label': `Clear ${o.label}`, title: 'Clear (use the built-in value)' });
    input.addEventListener('input', () => { edit(o.path, input.value); });
    const el = h('div', { class: 'co-fd-tf' },
      h('div', { class: 'co-fd-tf-head' }, h('label', { for: id, text: o.label }), tag),
      h('div', { class: 'co-fd-tf-row' }, input, clear));
    if (o.hint !== undefined) el.append(h('p', { class: 'co-fd-hint', id: `${id}-hint`, text: o.hint }));
    if (o.hint !== undefined) input.setAttribute('aria-describedby', `${id}-hint`);
    updaters.push(() => {
      const v = o.read();
      if (document.activeElement !== input) input.value = v;
      const fb = o.fallback();
      input.placeholder = fb.text;
      const own = v.trim() !== '';
      tag.className = `co-fd-tag${own ? '' : ' builtin'}`;
      tag.textContent = own ? '' : fb.tag;
      clear.setAttribute('aria-hidden', String(!own));
      clear.tabIndex = own ? 0 : -1;
    });
    return el;
  }

  const sections: HTMLElement[] = [hero];
  const settings = (): Record<string, { value: unknown }> => api.hostState().settings as unknown as Record<string, { value: unknown }>;

  if (features.sign) {
    sections.push(h('section', { class: 'co-fd-card', 'aria-label': 'Sign text' },
      h('h3', { class: 'co-fd-h', text: 'Sign' }),
      textField({
        k: 'sign-company', label: 'Company', path: 'company', max: THEME_LIMITS.name, read: () => (typeof api.draft().company === 'string' ? api.draft().company! : ''),
        fallback: () => ({ text: String(settings()['companyName']?.value ?? ''), tag: 'from Settings' }), hint: 'Empty uses the company name from Settings.',
      }),
      textField({
        k: 'sign-branch', label: 'Branch', path: 'branch', max: THEME_LIMITS.name, read: () => (typeof api.draft().branch === 'string' ? api.draft().branch! : ''),
        fallback: () => {
          const b = String(settings()['branchName']?.value ?? '');
          return { text: b === '' ? 'No branch line' : b, tag: b === '' ? '' : 'from Settings' };
        },
      })));
    sections.push(h('section', { class: 'co-fd-card', 'aria-label': 'Sign colours' },
      h('h3', { class: 'co-fd-h', text: 'Colours' }),
      h('p', { class: 'co-fd-hint', text: 'The plate and lettering colours are with the other office colours, along with a check that the sign stays readable.' }),
      h('div', null, button('Sign colours…', 'co-btn co-secondary co-small', () => {
        api.openTab('colours');
        if (env.sub) env.back?.();
      }, { 'data-k': 'to-colours' }))));
  } else {
    // ---- Name and role
    const nameCard = h('section', { class: 'co-fd-card', 'aria-label': 'Name' }, h('h3', { class: 'co-fd-h', text: features.role ? 'Name and role' : 'Name' }));
    nameCard.append(textField({
      k: `${slot}-name`, label: 'Name', path: `${slot}.name`, max: THEME_LIMITS.name, read: () => rawText(api.draft(), slot, 'name'),
      fallback: () => {
        if (slot === 'manager') return { text: String(settings()['managerName']?.value ?? 'You'), tag: 'from Settings' };
        const t = inheritedText(slot, 'name', api.draft());
        if (t.value !== '') return { text: t.value, tag: 'built-in' };
        return { text: features.role ? 'No name: their role shows instead' : 'No name', tag: '' };
      },
      ...(slot === 'manager' ? { hint: 'While this theme is in use it wins over the manager name in Settings.' } : {}),
    }));
    if (features.role) {
      nameCard.append(textField({
        k: `${slot}-role`, label: 'Role', path: `${slot}.role`, max: THEME_LIMITS.role, read: () => rawText(api.draft(), slot, 'role'),
        fallback: () => ({ text: DEFAULT_BUILTIN_TEXT.role(slot), tag: 'built-in' }),
      }));
    }
    sections.push(nameCard);

    // ---- Look
    sections.push(lookSection());

    // ---- Lines
    if (features.lines) sections.push(linesSection());

    // ---- Pin
    if (features.pin) {
      sections.push(h('section', { class: 'co-fd-card', 'aria-label': 'Pin' },
        h('h3', { class: 'co-fd-h', text: 'Pin a project' }),
        h('p', { class: 'co-fd-hint', text: 'A new session whose project folder or title contains this text gets this desk first (both must match when both are filled; case is ignored).' }),
        textField({ k: `${slot}-pin-project`, label: 'Project folder contains', path: `${slot}.pin.project`, max: THEME_LIMITS.pin, read: () => rawText(api.draft(), slot, 'pin.project'), fallback: () => ({ text: 'e.g. website', tag: '' }) }),
        textField({ k: `${slot}-pin-title`, label: 'Session title contains', path: `${slot}.pin.title`, max: THEME_LIMITS.pin, read: () => rawText(api.draft(), slot, 'pin.title'), fallback: () => ({ text: 'e.g. refactor', tag: '' }) })));
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The look editor

  function lookSection(): HTMLElement {
    const resetBtn = button('Reset to built-in look', 'co-btn co-secondary co-small', () => {
      update((d) => resetLook(d, slot));
      title.focus({ preventScroll: true });
    }, { 'data-k': `${slot}-reset-look`, title: 'Forget this person’s own look' });
    const body = h('div', { class: 'co-fd-look-body' });
    const card = h('section', { class: 'co-fd-card', 'aria-label': 'Look' },
      h('div', { class: 'co-fd-sechead' }, h('h3', { class: 'co-fd-h', text: 'Look' }), resetBtn),
      body);

    let layoutKey = '';
    let controls: { update(s: LookSections, def: LookDef, spec: LookSpec): void; unmount(): void }[] = [];
    let thumbTimer: number | null = null;
    let lastThumbKey = '';
    const thumbJobs: ((spec: LookSpec) => void)[] = [];

    function sectionsNow(): { s: LookSections; def: LookDef; spec: LookSpec } {
      const draft = api.draft();
      const spec = lookSpecOf(draft, slot);
      const def = buildLook(LOOK_PREVIEW_ID, spec, base);
      const used = lookFieldUse(def);
      const pal = def.pal as Readonly<Record<string, string>>;
      const models = lookFieldModels(inheritedLook(slot, draft, builtinSpecOf), used, (f) => {
        const k = LOOK_FIELD_PAL_KEY[f];
        return k === undefined ? undefined : pal[k];
      });
      return { s: lookSections(models), def, spec };
    }

    function rebuild(s: LookSections): void {
      for (const c of controls) c.unmount();
      controls = [];
      thumbJobs.length = 0;
      lastThumbKey = '';
      const kids: HTMLElement[] = [];
      // Shape: picture choices.
      for (const m of s.shape) {
        const p = pickerControl(m.field as 'head' | 'build' | 'outfit' | 'skin');
        controls.push(p);
        kids.push(p.el);
      }
      // Colours, in groups.
      for (const g of s.colours) {
        kids.push(h('p', { class: 'co-fd-sub', text: g.title }));
        const ul = h('ul', { class: 'co-fd-rows' });
        for (const m of g.rows) {
          const c = colourControl(m);
          controls.push(c);
          ul.append(c.el);
        }
        kids.push(ul);
      }
      if (s.options.length > 0) {
        kids.push(h('p', { class: 'co-fd-sub', text: 'Options' }));
        const ul = h('ul', { class: 'co-fd-opts' });
        for (const m of s.options) {
          const c = optionControl(m);
          controls.push(c);
          ul.append(c.el);
        }
        kids.push(ul);
      }
      if (s.more.length > 0) {
        const mem = memoryOf(api);
        const more = h('details', { class: 'co-fd-more' });
        more.open = mem.moreOpen;
        more.addEventListener('toggle', () => { mem.moreOpen = more.open; });
        const summary = h('summary', { 'data-k': `${slot}-more` });
        more.append(summary, h('p', { class: 'co-fd-hint', text: 'These don’t change this look right now (a tie on an outfit without one, glasses on a head without them). They apply if you change the head or outfit.' }));
        const ul = h('ul', { class: 'co-fd-rows' });
        for (const m of s.more) {
          const c = m.kind === 'colour' ? colourControl(m) : optionControl(m);
          controls.push(c);
          ul.append(c.el);
        }
        more.append(ul);
        controls.push({
          update(ss) {
            const set = ss.more.filter((m) => !m.inherited).length;
            summary.textContent = `More (${ss.more.length} that don’t show${set > 0 ? `, ${set} set` : ''})`;
          },
          unmount() { /* nothing */ },
        });
        kids.push(more);
      }
      body.replaceChildren(...kids);
    }

    function render(): void {
      const { s, def, spec } = sectionsNow();
      const key = lookLayoutKey(s);
      if (key !== layoutKey) {
        layoutKey = key;
        keepFocus(body, () => { rebuild(s); });
      }
      for (const c of controls) c.update(s, def, spec);
      resetBtn.disabled = !hasOwnLook(api.draft(), slot);
      preview?.setLook(def, `${base.id}|${JSON.stringify(spec)}`);
      scheduleThumbs(spec);
    }

    /** Picture choices are redrawn a moment after the look settles (they are 30 small looks). */
    function scheduleThumbs(spec: LookSpec): void {
      const key = JSON.stringify(spec);
      if (key === lastThumbKey) return;
      if (thumbTimer !== null) window.clearTimeout(thumbTimer);
      const first = lastThumbKey === '';
      const run = (): void => {
        thumbTimer = null;
        if (dead) return;
        lastThumbKey = key;
        for (const job of thumbJobs) job(spec);
      };
      if (first) run();
      else thumbTimer = window.setTimeout(run, 90);
    }
    cleanups.push(() => { if (thumbTimer !== null) window.clearTimeout(thumbTimer); });

    // ---- One enum field as picture choices (a radio group with arrow keys)
    function pickerControl(field: 'head' | 'build' | 'outfit' | 'skin'): { el: HTMLElement; update(s: LookSections): void; unmount(): void } {
      const info = LOOK_FIELD_LABEL_INFO[field];
      const options = LOOK_FIELDS.find((f) => f.key === field)?.options ?? [];
      const valEl = h('span', { class: 'val' });
      const tagEl = h('span', { class: 'co-fd-tag' });
      const resetEl = button('Reset', 'co-link', () => { edit(`${slot}.look.${field}`, null); }, { 'data-k': `${slot}-${field}-reset`, 'aria-label': `Reset ${info.label} to built-in` });
      const labelId = `co-fd-${slot}-${field}-lbl`;
      const group = h('div', { class: 'co-fd-pick', role: 'radiogroup', 'aria-labelledby': labelId });
      const btns: HTMLButtonElement[] = [];
      for (const v of options) {
        const b = h('button', { type: 'button', class: field === 'skin' ? 'co-fd-pick-opt co-fd-skin' : 'co-fd-pick-opt', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-k': `${slot}-${field}-${v}`, title: optionLabel(field, v), 'aria-label': optionLabel(field, v) });
        b.dataset['v'] = v;
        if (field === 'skin') {
          const dot = h('span', { 'aria-hidden': 'true' });
          dot.style.background = buildLook('__fd_skin__', { skin: v }, base).pal['s'] ?? '#cccccc';
          b.append(dot);
        } else {
          const c = h('canvas', { class: 'co-px', 'aria-hidden': 'true' });
          if (field === 'head') {
            c.width = FACE_W;
            c.height = FACE_H;
            c.style.width = `${FACE_W * 2}px`;
            c.style.height = `${FACE_H * 2}px`;
          } else {
            c.width = 16;
            c.height = 24;
            c.style.width = '32px';
            c.style.height = '48px';
          }
          b.append(c);
          if (field === 'build') b.append(h('span', { text: optionLabel(field, v), 'aria-hidden': 'true' }));
          thumbJobs.push((spec) => {
            const id = `__fd_${field}_${v}`;
            const { changed } = ensureLook(id, { ...spec, [field]: v }, base);
            if (!changed && c.dataset['drawn'] === '1') return;
            c.dataset['drawn'] = '1';
            if (field === 'head') {
              paintPortrait(c, id);
            } else {
              const g = c.getContext('2d');
              if (!g) return;
              g.imageSmoothingEnabled = false;
              g.clearRect(0, 0, c.width, c.height);
              g.drawImage(getCharacterFrame(id, 'stand', 'down', 0), 0, -CHAR_HEADROOM);
            }
          });
        }
        b.addEventListener('click', () => { choose(v); });
        btns.push(b);
        group.append(b);
      }
      let current = '';
      function choose(v: string): void {
        if (v !== current) edit(`${slot}.look.${field}`, v);
      }
      group.addEventListener('keydown', (e) => {
        const i = btns.findIndex((b) => b === document.activeElement);
        if (i < 0) return;
        let j: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % btns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + btns.length) % btns.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = btns.length - 1;
        if (j === null) return;
        e.preventDefault();
        const b = btns[j]!;
        for (const x of btns) x.tabIndex = x === b ? 0 : -1;
        b.focus();
        choose(b.dataset['v']!);
      });
      const el = h('div', { class: 'co-fd-pickfield' },
        h('div', { class: 'co-fd-field-h' }, h('span', { class: 'lbl', id: labelId, text: info.label }), valEl, tagEl, resetEl),
        group);
      return {
        el,
        update(s) {
          const m = s.shape.find((x) => x.field === field);
          if (!m) return;
          current = typeof m.value === 'string' ? m.value : '';
          const builtin = String((builtinSpecOf(slot) as Record<string, unknown>)[field] ?? '');
          valEl.textContent = current === '' ? '' : optionLabel(field, current);
          tagEl.className = `co-fd-tag${m.inherited ? ' builtin' : ''}`;
          tagEl.textContent = m.inherited ? 'built-in' : '';
          resetEl.hidden = m.inherited;
          const focusInside = btns.includes(document.activeElement as HTMLButtonElement);
          for (const b of btns) {
            const on = b.dataset['v'] === current;
            b.setAttribute('aria-checked', String(on));
            b.classList.toggle('builtin', b.dataset['v'] === builtin && !on);
            if (!focusInside) b.tabIndex = on ? 0 : -1;
          }
          if (!btns.some((b) => b.tabIndex === 0) && btns[0]) btns[0].tabIndex = 0;
        },
        unmount() { /* nothing */ },
      };
    }

    // ---- One colour field
    function colourControl(m0: LookFieldModel): { el: HTMLElement; update(s: LookSections): void; unmount(): void } {
      const field = m0.field;
      const hint = LOOK_FIELD_HINTS[field];
      const row: ColourRow = colourRow({
        k: `${slot}-${field}`, label: m0.label, ...(hint !== undefined ? { hint } : {}),
        send: (hex) => { edit(`${slot}.look.${field}`, hex); },
      });
      return {
        el: row.el,
        update(s) {
          const m = [...s.colours.flatMap((g) => g.rows), ...s.more].find((x) => x.field === field);
          if (!m) return;
          row.update({ shown: m.shown ?? '#000000', source: m.source, used: m.used, ...(m.invalid ? { invalid: String(m.value) } : {}) });
        },
        unmount() { row.unmount(); },
      };
    }

    // ---- One on/off field
    function optionControl(m0: LookFieldModel): { el: HTMLElement; update(s: LookSections): void; unmount(): void } {
      const field = m0.field;
      const id = `co-fd-${slot}-${field}`;
      const box = h('input', { type: 'checkbox', id, 'data-k': `${slot}-${field}` });
      const tag = h('span', { class: 'co-fd-tag' });
      const reset = button(h('span', { 'aria-hidden': 'true', text: '↺' }), 'co-fd-reset', () => {
        edit(`${slot}.look.${field}`, null);
        box.focus({ preventScroll: true });
      }, { 'data-k': `${slot}-${field}-reset`, 'aria-label': `Reset ${m0.label} to built-in`, title: 'Back to the built-in choice' });
      box.addEventListener('change', () => { edit(`${slot}.look.${field}`, box.checked); });
      const el = h('li', { class: 'co-fd-optrow' }, h('label', { for: id }, box, h('span', { text: m0.label }), tag), reset);
      return {
        el,
        update(s) {
          const m = [...s.options, ...s.more].find((x) => x.field === field);
          if (!m) return;
          box.checked = m.value === true;
          el.dataset['used'] = String(m.used);
          tag.className = `co-fd-tag${m.inherited ? ' builtin' : ''}`;
          tag.textContent = m.inherited ? 'built-in' : '';
          reset.setAttribute('aria-hidden', String(m.inherited));
          reset.tabIndex = m.inherited ? -1 : 0;
        },
        unmount() { /* nothing */ },
      };
    }

    updaters.push(render);
    cleanups.push(() => { for (const c of controls) c.unmount(); });
    return card;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Lines

  function linesSection(): HTMLElement {
    const list = h('ol', { class: 'co-fd-lines', 'aria-label': 'Lines' });
    const count = h('span', { class: 'co-fd-count' });
    const add = button('Add a line', 'co-btn co-secondary co-small', () => { apply({ op: 'add' }); }, { 'data-k': `${slot}-line-add` });
    const card = h('section', { class: 'co-fd-card', 'aria-label': 'Lines' },
      h('div', { class: 'co-fd-sechead' }, h('h3', { class: 'co-fd-h', text: 'Lines' }), count),
      h('p', { class: 'co-fd-hint', text: slot === 'manager'
        ? 'What the manager says in speech bubbles, one per line. With none, the built-in boss lines are used.'
        : 'What they say in speech bubbles, one per line (up to 80 characters). With none, the built-in lines are used.' }),
      list,
      h('div', { class: 'co-fd-lines-foot' }, add));
    let shownCount = -1;

    function apply(op: Parameters<typeof editLines>[1]): void {
      const r = editLines(rawLines(api.draft(), slot), op);
      edit(`${slot}.lines`, r.lines);
      render();
      const target = r.focus === null ? add : list.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(`${slot}-line-${r.focus}`)}"]`);
      target?.focus({ preventScroll: false });
    }

    function row(i: number): HTMLElement {
      const input = h('input', { type: 'text', class: 'co-input', 'data-k': `${slot}-line-${i}`, maxlength: String(THEME_LIMITS.line), 'aria-label': `Line ${i + 1}`, spellcheck: 'true', autocomplete: 'off' });
      input.addEventListener('input', () => { edit(`${slot}.lines`, editLines(rawLines(api.draft(), slot), { op: 'set', index: i, text: input.value }).lines); });
      input.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text') ?? '';
        if (!/[\r\n]/.test(text)) return;
        e.preventDefault();
        const s = input.selectionStart ?? input.value.length;
        const en = input.selectionEnd ?? s;
        apply({ op: 'paste', index: i, text: input.value.slice(0, s) + text + input.value.slice(en) });
      });
      input.addEventListener('keydown', (e) => {
        const n = rawLines(api.draft(), slot).length;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i === n - 1) apply({ op: 'add' });
          else list.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(`${slot}-line-${i + 1}`)}"]`)?.focus();
        } else if (e.key === 'Backspace' && input.value === '' && n > 0) {
          e.preventDefault();
          apply({ op: 'remove', index: i });
          if (i > 0) list.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(`${slot}-line-${i - 1}`)}"]`)?.focus();
        }
      });
      const remove = button(h('span', { 'aria-hidden': 'true', text: '×' }), 'co-fd-reset', () => { apply({ op: 'remove', index: i }); },
        { 'data-k': `${slot}-line-${i}-x`, 'aria-label': `Remove line ${i + 1}`, title: 'Remove this line' });
      return h('li', { class: 'co-fd-line' }, h('span', { class: 'co-fd-line-n', 'aria-hidden': 'true', text: String(i + 1) }), input, remove);
    }

    function render(): void {
      const lines = rawLines(api.draft(), slot);
      if (lines.length !== shownCount) {
        shownCount = lines.length;
        keepFocus(list, () => { list.replaceChildren(...lines.map((_, i) => row(i))); });
      }
      lines.forEach((l, i) => {
        const input = list.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(`${slot}-line-${i}`)}"]`);
        if (input && document.activeElement !== input) input.value = l;
      });
      count.textContent = linesCount(lines.filter((l) => l.trim() !== '').length);
      add.disabled = lines.length >= THEME_LIMITS.lines;
    }
    updaters.push(render);
    return card;
  }

  // -------------------------------------------------------------------------------------------------------------------

  const el = h('div', { class: 'co-fd-page', 'data-slot': slot }, ...sections);

  function refresh(): void {
    if (dead) return;
    for (const u of updaters) u();
  }
  refresh();

  return {
    el,
    refresh,
    focusHeading() { title.focus({ preventScroll: true }); },
    unmount() {
      dead = true;
      for (const c of cleanups) c();
    },
  };
}

const LOOK_FIELD_LABEL_INFO: Readonly<Record<'head' | 'build' | 'outfit' | 'skin', { label: string }>> = {
  head: { label: 'Head' }, build: { label: 'Build' }, outfit: { label: 'Outfit' }, skin: { label: 'Skin' },
};

/** Rebuilds `container` and puts the focus back on the element with the same `data-k` (and its caret, for a text field). */
function keepFocus(container: HTMLElement, rebuild: () => void): void {
  const active = document.activeElement;
  const k = active instanceof HTMLElement && container.contains(active) ? active.dataset['k'] : undefined;
  const caret = active instanceof HTMLInputElement && active.type === 'text' ? [active.selectionStart, active.selectionEnd] as const : null;
  rebuild();
  if (k === undefined) return;
  const next = container.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`);
  next?.focus({ preventScroll: true });
  if (caret && next instanceof HTMLInputElement && caret[0] !== null && caret[1] !== null) next.setSelectionRange(caret[0], caret[1]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The sub-view for narrow panels

function personSubView(api: FrontDeskTabApi, slot: SlotId): PanelView<HTMLElement> {
  let page: SlotPage | null = null;
  let body: HTMLElement | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  const e = entryOf(api, slot);
  return {
    id: 'frontdesk-person',
    title: pageTitle(e),
    icon: 'bell',
    mount(el: HTMLElement, ctx: PanelContext<HTMLElement>) {
      injectCss();
      body = el;
      el.classList.add('co-fd-subbody');
      const bar = h('div', { class: 'co-fd-subbar', role: 'status' },
        h('span', null, h('span', { class: 'co-fd-dot', 'aria-hidden': 'true' }), 'Unsaved changes'),
        button('Back to save', 'co-btn co-primary co-small', () => { ctx.back(); }, { 'data-k': 'sub-back-save' }));
      const sync = (): void => { bar.hidden = !api.isDirty(); };
      page = createSlotPage(api, slot, {
        sub: true,
        back: () => { ctx.back(); },
        afterChange: sync,
      });
      sync();
      el.append(page.el, bar);
      // Escape goes back to the list (where the Front desk's own close prompt lives) instead of closing the drawer.
      onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || ev.defaultPrevented) return;
        ev.preventDefault();
        ev.stopPropagation();
        ctx.back();
      };
      el.addEventListener('keydown', onKey);
      window.setTimeout(() => { if (page !== null) page.focusHeading(); }, 0);
    },
    unmount() {
      if (body && onKey) body.removeEventListener('keydown', onKey);
      body?.classList.remove('co-fd-subbody');
      page?.unmount();
      page = null;
      body = null;
    },
    beforeClose() {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tab

interface RowCtl {
  btn: HTMLButtonElement;
  face: HTMLCanvasElement;
  name: HTMLElement;
  label: HTMLElement;
  marks: HTMLElement;
  sr: HTMLElement;
}

/** Builds the Staff tab. Registered below with `registerFrontDeskTab('staff', ...)`. */
export function createStaffTab(api: FrontDeskTabApi): FrontDeskTabView {
  injectCss();
  injectColourCss();
  const mem = memoryOf(api);
  let layout: StaffLayout = 'stack';
  let page: SlotPage | null = null;
  let pageSlot: SlotId | null = null;
  let dead = false;
  const rows = new Map<SlotId, RowCtl>();
  const timers = new Set<number>();

  const later = (fn: () => void, ms = 0): void => {
    const t = window.setTimeout(() => { timers.delete(t); if (!dead) fn(); }, ms);
    timers.add(t);
  };

  // ---- The list
  const nav = h('nav', { class: 'co-fd-slotnav', 'aria-label': 'People in the office' });
  const intro = h('p', { class: 'co-fd-hint co-fd-staff-intro', text: 'Pick someone to change their name, lines and look.' });
  nav.append(intro);
  const groups: [string, string][] = [['office', 'Office'], ['staff', 'Staff desks'], ['temp', 'Temps']];
  const lists = new Map<string, HTMLElement>();
  for (const [id, title] of groups) {
    const hid = `co-fd-slotgroup-${id}`;
    const ul = h('ul', { class: 'co-fd-slots', 'aria-labelledby': hid });
    lists.set(id, ul);
    nav.append(h('h4', { class: 'co-fd-slotgroup', id: hid, text: title }), ul);
  }
  for (const e of slotList(api.draft(), api.hostTheme())) {
    const face = faceCanvas();
    const name = h('span', { class: 'co-fd-slot-name' });
    const label = h('span', { class: 'co-fd-slot-label' });
    const marks = h('span', { class: 'co-fd-slot-marks', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'co-sr' });
    const btn = h('button', { type: 'button', class: 'co-fd-slot', 'data-k': `slot-${e.id}`, tabindex: '-1' },
      h('span', { class: 'co-fd-slot-face' }, face),
      h('span', { class: 'co-fd-slot-text' }, name, label),
      marks, sr,
      h('span', { class: 'co-fd-slot-chev', 'aria-hidden': 'true', text: '›' }));
    btn.dataset['slot'] = e.id;
    btn.addEventListener('click', () => { openSlot(e.id, false); });
    rows.set(e.id, { btn, face, name, label, marks, sr });
    const list = lists.get(e.group === 'staff' ? 'staff' : e.group === 'temp' ? 'temp' : 'office')!;
    list.append(h('li', null, btn));
  }
  nav.addEventListener('keydown', (ev) => {
    const all = [...rows.values()].map((r) => r.btn);
    const i = all.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    const j = listMove(ev.key, i, all.length);
    if (j === null) return;
    ev.preventDefault();
    focusRow(all[j]!.dataset['slot']!);
  });

  function focusRow(slot: SlotId): void {
    for (const [id, r] of rows) r.btn.tabIndex = id === slot ? 0 : -1;
    rows.get(slot)?.btn.focus();
  }

  const detail = h('div', { class: 'co-fd-detail' });
  const inner = h('div', { class: 'co-fd-staff-in', 'data-layout': layout }, nav, detail);
  const root = h('div', { class: 'co-fd-staff' }, inner);

  // ---- Rendering
  function renderList(): void {
    const draft = api.draft();
    for (const e of slotList(draft, api.hostTheme())) {
      const r = rows.get(e.id);
      if (!r) continue;
      // An unnamed person shows the built-in role, which is also their desk's name: the second line is then just the slot.
      r.name.textContent = e.group === 'sign' ? signWords(api).company || 'Office sign' : e.group === 'temp' && !e.named ? shortLabel(e) : e.name;
      r.name.className = `co-fd-slot-name${e.named || e.group === 'sign' ? '' : ' inherited'}`;
      r.label.textContent = e.named || e.group === 'sign' ? e.label : e.group === 'temp' ? 'Built-in temp' : shortLabel(e);
      const m: HTMLElement[] = [];
      if (e.customised) m.push(h('span', { class: 'co-fd-mark-custom', title: 'Customised in this theme', text: 'custom' }));
      if (e.changed) m.push(h('span', { class: 'co-fd-mark-changed', title: 'Unsaved changes' }));
      r.marks.replaceChildren(...m);
      r.sr.textContent = `${e.customised ? ', customised' : ''}${e.changed ? ', unsaved changes' : ''}`;
      r.btn.title = `${r.name.textContent} · ${e.label}`;
      const current = layout === 'split' && e.id === mem.slot;
      if (current) r.btn.setAttribute('aria-current', 'true');
      else r.btn.removeAttribute('aria-current');
      if (e.group === 'sign') paintSignIcon(r.face, draft);
      else {
        const { changed } = ensureLook(`__fd_slot_${e.id}`, lookSpecOf(draft, e.id), baseLookOf(e.id));
        if (changed || r.face.dataset['drawn'] !== '1') {
          r.face.dataset['drawn'] = '1';
          paintPortrait(r.face, `__fd_slot_${e.id}`);
        }
      }
    }
    if (![...rows.values()].some((r) => r.btn.tabIndex === 0)) rows.get(mem.slot)?.btn.setAttribute('tabindex', '0');
  }

  function showPage(slot: SlotId): void {
    if (page !== null && pageSlot === slot) {
      page.refresh();
      return;
    }
    page?.unmount();
    page = createSlotPage(api, slot, { sub: false });
    pageSlot = slot;
    detail.replaceChildren(page.el);
  }

  function dropPage(): void {
    page?.unmount();
    page = null;
    pageSlot = null;
    detail.replaceChildren();
  }

  /** Opens a person: in the split layout shows their page; in the stack layout pushes it as a sub-view. */
  function openSlot(slot: SlotId, fromRequest: boolean): void {
    mem.slot = slot;
    for (const [id, r] of rows) r.btn.tabIndex = id === slot ? 0 : -1;
    if (layout === 'split') {
      showPage(slot);
      renderList();
      if (fromRequest) rows.get(slot)?.btn.scrollIntoView({ block: 'nearest' });
      return;
    }
    mem.returnTo = slot;
    // Never push from inside the shell's own build or refresh: the push unmounts this panel.
    later(() => { api.ctx.push(personSubView(api, slot)); });
  }

  function measure(): void {
    const content = root.closest('.co-fd-content');
    const w = content instanceof HTMLElement ? content.clientWidth : root.clientWidth + 24;
    const next = staffLayout(w, layout);
    if (next === layout && inner.dataset['layout'] === next) return;
    layout = next;
    inner.dataset['layout'] = next;
    if (layout === 'split') showPage(mem.slot);
    else dropPage();
    renderList();
  }

  function takePending(): void {
    if (pendingOpen === null || root.offsetParent === null) return;
    const slot = pendingOpen;
    pendingOpen = null;
    openSlot(slot, true);
  }

  const opener = (): void => { measure(); takePending(); };
  openers.add(opener);

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!dead) { measure(); takePending(); } });
    ro.observe(root);
  }

  renderList();

  /** The Front desk's unsaved-changes prompt is showing (it has the focus, and must keep it). */
  const promptUp = (): boolean => !!root.closest('.co-drawer')?.querySelector('.co-fd-prompt');

  // Coming back from a person's sub-view: focus their row once the drawer has settled. When a close attempt popped the page
  // to ask about unsaved changes, leave the focus on the prompt and remember the page for "Keep editing".
  if (mem.returnTo !== null) {
    const back = mem.returnTo;
    mem.returnTo = null;
    later(() => {
      if (root.offsetParent === null) return;
      if (promptUp()) mem.reopen = back;
      else focusRow(back);
    });
  }

  return {
    el: root,
    refresh(reason: ChangeReason | 'show') {
      // The prompt is gone ("Keep editing" refreshes the tab): back to the page the close attempt popped.
      if (mem.reopen !== null && !promptUp()) {
        const slot = mem.reopen;
        mem.reopen = null;
        later(() => { if (!dead && root.offsetParent !== null && !promptUp()) openSlot(slot, false); });
      }
      if (reason === 'editor') return;
      if (reason === 'show') {
        measure();
        takePending();
      }
      renderList();
      page?.refresh();
    },
    unmount() {
      dead = true;
      openers.delete(opener);
      ro?.disconnect();
      ro = null;
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
      page?.unmount();
      page = null;
    },
  };
}

registerFrontDeskTab('staff', createStaffTab);
