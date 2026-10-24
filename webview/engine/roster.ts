/**
 * The staff roster: an HTML list beside (or below) the office when the panel
 * has room to spare. One row per agent with a mini portrait, the session
 * title and what they're doing in words; agents waiting for you stand out.
 * Hovering a row highlights that character in the office, and hovering a
 * character highlights its row. Uses VS Code theme colours.
 *
 * Task 10.1: a very wide strip gives the list the width the map cannot use, so it lays its rows out in columns (`cols`) and each
 * row gets a detail line (model, effort, context, cost: `RosterEntry.meta`) when the columns are wide enough (`detail`).
 *
 * v0.5: in a wide, short view (`layoutLogic.ts`) it is the `strip` column on the right, full height, with a sticky header (the
 * count and "+ New task"). Every layout: a row whose case is open in an editor tab carries an "In tab" mark (`setTabs`, from
 * the host's `caseTabs`); a knocking worker's portrait gets a "!" badge; an idle main worker's row has an x that sends them
 * home (`onSendHome`; the host checks again). The x is a separate button beside the row (never inside it), shown on hover and
 * on keyboard focus.
 */
import { getLook } from '../art/index.ts';
import type { RosterEntry } from './tooltip.ts';
import { FACE_H, FACE_W, h, paintPortrait, pixelIcon, sprite } from './dom.ts';
import { controlBadge } from './caseLogic.ts';
import { BELOW_COL_GAP, BELOW_COL_MIN_W } from './layoutLogic.ts';

/** Room the roster needs beside the office (CSS px) before it is shown. */
export const ROSTER_SIDE_MIN_W = 220;
export const ROSTER_SIDE_MAX_W = 340;
/** Room the roster needs below the office (CSS px) before it is shown there. */
export const ROSTER_BELOW_MIN_H = 110;
export const ROSTER_GAP = 12;
/** A strip list narrower than this (CSS px) leaves the branch out of its rows (it stays in the row's tooltip). */
export const ROSTER_STRIP_BRANCH_W = 320;

export interface RosterRect {
  x: number; y: number; w: number; h: number; mode: 'side' | 'below' | 'strip';
  /** Task 10.1: a strip's columns of rows and whether a column is too narrow for the branch (`stripListColumns`); whether each row shows its detail line (strip or below). */
  cols?: number;
  detail?: boolean;
  narrow?: boolean;
}


const CSS = `
.co-roster { --co-roster-bg: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e)); position: fixed; box-sizing: border-box; overflow-x: hidden; overflow-y: auto; display: none;
  font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12px; line-height: 15px;
  color: var(--vscode-foreground, #cccccc); user-select: none; scrollbar-width: thin; }
.co-roster-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 0 6px 4px;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-roster-head .co-alert { color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 68%, var(--vscode-foreground, #cccccc)); font-weight: 600; }
.co-roster-head .co-head-left { display: flex; gap: 10px; align-items: baseline; min-width: 0; }
.co-roster-new { font: inherit; font-size: 11px; text-transform: none; letter-spacing: 0; padding: 1px 8px; border-radius: 10px; cursor: pointer;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #cccccc)); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
  border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent)); white-space: nowrap; }
.co-roster-new:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
.co-roster-new:focus-visible, .co-row:focus-visible, .co-row-x:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.co-roster-list { display: grid; grid-template-columns: 1fr; gap: 0; }
.co-roster.below .co-roster-list { grid-template-columns: repeat(auto-fill, minmax(${BELOW_COL_MIN_W}px, 1fr)); column-gap: ${BELOW_COL_GAP}px; row-gap: 4px; align-items: start; }
.co-group { min-width: 0; }
.co-rowwrap { position: relative; min-width: 0; }
/* The x sits over the right end of the row (the time and branch) and only shows on hover or keyboard focus, so it costs no width. */
.co-row-x { position: absolute; right: 4px; top: 50%; margin-top: -11px; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 4px; color: var(--vscode-foreground, #cccccc); font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
  opacity: 0; pointer-events: none; background: var(--co-roster-bg, var(--vscode-editor-background, #1e1e1e));
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.45))); }
.co-row-x[hidden] { display: none; }
.co-rowwrap:hover .co-row-x, .co-rowwrap:focus-within .co-row-x { opacity: 1; pointer-events: auto; }
.co-row-x:hover, .co-row-x:focus-visible { color: var(--vscode-errorForeground, #f48771); border-color: var(--vscode-contrastActiveBorder, var(--vscode-errorForeground, #f48771)); }
.co-facewrap { position: relative; flex: none; display: inline-flex; }
.co-rknock { position: absolute; top: -3px; right: -3px; width: 14px; height: 14px; box-sizing: border-box; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 3px; background: #ffffff; border: 1px solid #3a3340; box-shadow: 1px 1px 0 rgba(0,0,0,0.35); }
.co-rknock canvas { width: 10px; height: 10px; image-rendering: pixelated; }
.co-rknock[hidden] { display: none; }
.co-tabmark { flex: none; font-size: 9.5px; line-height: 13px; padding: 0 5px; border-radius: 7px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; white-space: nowrap; color: var(--vscode-foreground, #cccccc);
  border: 1px solid var(--vscode-focusBorder, #007fd4); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 18%, transparent); }
.co-tabmark[hidden] { display: none; }
.co-row.tabbed { border-left-color: var(--vscode-focusBorder, #007fd4); }
.co-row.tabbed.needs { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
/* The strip: a full-height staff column on the right of a wide, short view. */
.co-roster.strip { --co-roster-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)); padding: 0 0 6px; background: var(--co-roster-bg);
  border-left: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
.co-roster.strip .co-roster-head { position: sticky; top: 0; z-index: 1; align-items: center; padding: 7px 8px 6px 10px; margin-bottom: 2px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
  border-bottom: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.25))); }
.co-roster.strip .co-roster-new { padding: 2px 10px; font-size: 11.5px; }
.co-roster.strip .co-row { padding-top: 4px; padding-bottom: 4px; padding-left: 8px; border-radius: 0; }
.co-roster.strip .co-row.temp { padding-left: 24px; }
.co-roster.strip .co-row-x { right: 6px; }
/* A narrow strip list keeps the titles readable: the branch moves to the row's tooltip. */
.co-roster.strip.narrow .co-rbranch { display: none; }
.co-roster.strip.narrow .co-side { justify-content: flex-start; }
/* A wide strip list (the width a very wide panel's map cannot use, task 10.1): rows in columns, each with a detail line. */
.co-roster.strip.cols .co-roster-list { grid-template-columns: repeat(var(--co-cols, 1), minmax(0, 1fr)); column-gap: 6px; row-gap: 2px; padding: 0 6px; align-items: start; }
.co-roster.strip.cols .co-row { border-radius: 3px; }
.co-meta { display: none; font-size: 11px; line-height: 15px; color: var(--vscode-descriptionForeground, #9d9d9d); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co-roster.detail .co-meta:not(:empty) { display: block; }
.co-roster.detail .co-row { padding-top: 6px; padding-bottom: 6px; }
.co-roster.detail .co-face { width: 32px; height: 32px; }
.co-roster-empty { padding: 8px 10px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; line-height: 17px; }
.co-roster-empty[hidden] { display: none; }
.co-row { display: flex; align-items: center; gap: 7px; padding: 1px 6px 1px 4px; border-radius: 3px; min-width: 0; width: 100%;
  border: 0; border-left: 2px solid transparent; cursor: pointer; font: inherit; color: inherit; background: transparent; text-align: left; }
.co-title-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.co-title-line .co-title { flex: 0 1 auto; min-width: 0; }
.co-badge { flex: none; display: inline-flex; image-rendering: pixelated; opacity: 0.9; }
.co-side { flex: none; align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 1px; max-width: 34%; min-width: 0; }
.co-rbranch { font-size: 10px; line-height: 13px; color: var(--vscode-descriptionForeground, #9d9d9d); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.co-row:hover, .co-row.hl { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.16)); }
.co-row.temp { padding-left: 16px; }
.co-row.needs { border-left-color: var(--vscode-editorWarning-foreground, #cca700);
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 14%, transparent); }
.co-row.needs:hover, .co-row.needs.hl { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 24%, transparent); }
.co-row.gone { opacity: 0.55; }
.co-row.open, .co-row.open:hover { background: var(--vscode-list-inactiveSelectionBackground, rgba(0,122,204,0.25)); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, rgba(0,127,212,0.6)); }
.co-face { flex: none; width: 28px; height: 28px; image-rendering: pixelated; border-radius: 3px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.12)); }
.co-row.temp .co-face { width: 22px; height: 22px; }
.co-text { flex: 1; min-width: 0; display: block; }
.co-doing { display: block; }
.co-role { flex: 0 1 auto; min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co-title, .co-doing { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co-title { font-weight: 600; }
.co-row.temp .co-title { font-weight: normal; }
.co-doing { color: var(--vscode-descriptionForeground, #9d9d9d); }
.co-row.needs .co-doing { color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 68%, var(--vscode-foreground, #cccccc)); font-weight: 600; }
.co-since { flex: none; align-self: flex-start; font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); font-variant-numeric: tabular-nums; }
`;

interface RowEls {
  wrap: HTMLDivElement; row: HTMLButtonElement; x: HTMLButtonElement; face: HTMLCanvasElement; knock: HTMLSpanElement; title: HTMLSpanElement; role: HTMLSpanElement;
  badge: HTMLSpanElement; tab: HTMLSpanElement; doing: HTMLSpanElement; meta: HTMLSpanElement; since: HTMLSpanElement; branch: HTMLSpanElement; look: string; key: string;
}

export class Roster {
  readonly el: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly headCount: HTMLSpanElement;
  private readonly headAlert: HTMLSpanElement;
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly rows = new Map<string, RowEls>();
  private readonly groups = new Map<string, HTMLDivElement>();
  private order = '';
  private highlighted: string | null = null;
  private openId: string | null = null;
  /** Workers whose case is open in an editor tab (`setTabs`). */
  private tabs = new Set<string>();
  private mode: RosterRect['mode'] | null = null;
  /** Called with the hovered row's id (null when the pointer leaves). */
  onHover: (id: string | null) => void = () => {};
  /** Called when a row is clicked (or activated with the keyboard). */
  onOpen: (id: string) => void = () => {};
  /** Called by the "New task" button. */
  onNewTask: () => void = () => {};
  /** Called by a row's x (send the worker home). */
  onSendHome: (id: string) => void = () => {};
  /** Whether a row offers the x (an idle main worker; `canSendHome` in layoutLogic.ts). Asked on every update. */
  canSendHome: (id: string) => boolean = () => false;

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.className = 'co-roster';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Staff');
    this.head = document.createElement('div');
    this.head.className = 'co-roster-head';
    this.headCount = document.createElement('span');
    this.headAlert = document.createElement('span');
    this.headAlert.className = 'co-alert';
    const newTask = h('button', { type: 'button', class: 'co-roster-new', title: 'Write an assignment memo for a new or existing worker', text: '+ New task' });
    newTask.addEventListener('click', () => this.onNewTask());
    this.head.append(h('span', { class: 'co-head-left' }, this.headCount, this.headAlert), newTask);
    this.list = document.createElement('div');
    this.list.className = 'co-roster-list';
    this.list.setAttribute('role', 'list');
    this.list.setAttribute('aria-label', 'Staff');
    this.empty = h('div', { class: 'co-roster-empty', text: 'Hand out a task and a new hire takes a desk.' });
    this.empty.hidden = true;
    this.el.append(this.head, this.list, this.empty);
    this.el.addEventListener('mouseleave', () => this.onHover(null));
    parent.appendChild(this.el);
  }

  /** Shows the roster in `rect` (CSS px), or hides it. */
  place(rect: RosterRect | null): void {
    const s = this.el.style;
    if (!rect) {
      if (s.display !== 'none') s.display = 'none';
      return;
    }
    s.display = 'block';
    s.left = `${Math.round(rect.x)}px`;
    s.top = `${Math.round(rect.y)}px`;
    s.width = `${Math.round(rect.w)}px`;
    s.height = `${Math.round(rect.h)}px`;
    this.el.classList.toggle('below', rect.mode === 'below');
    this.el.classList.toggle('strip', rect.mode === 'strip');
    this.el.classList.toggle('narrow', rect.mode === 'strip' && (rect.narrow ?? rect.w < ROSTER_STRIP_BRANCH_W));
    const cols = rect.mode === 'strip' ? Math.max(1, Math.floor(rect.cols ?? 1)) : 1;
    this.el.classList.toggle('cols', cols > 1);
    this.el.classList.toggle('detail', rect.mode !== 'side' && rect.detail === true);
    if (s.getPropertyValue('--co-cols') !== String(cols)) s.setProperty('--co-cols', String(cols));
    if (this.mode !== rect.mode) {
      this.mode = rect.mode;
      // The click hint differs (an editor tab in a strip).
      for (const r of this.rows.values()) r.key = '';
    }
  }

  /** The layout last placed in (null while hidden or before the first placement). */
  get placedMode(): RosterRect['mode'] | null {
    return this.visible ? this.mode : null;
  }

  /** Marks the rows whose case is open in an editor tab (the host's `caseTabs`). */
  setTabs(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.tabs.size && [...next].every((id) => this.tabs.has(id))) return;
    this.tabs = next;
    for (const [id, r] of this.rows) {
      const on = next.has(id);
      r.row.classList.toggle('tabbed', on);
      r.tab.hidden = !on;
      r.key = '';
    }
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  /** Highlights a row (the character hovered in the office). */
  setHighlight(id: string | null): void {
    if (id === this.highlighted) return;
    if (this.highlighted) this.rows.get(this.highlighted)?.row.classList.remove('hl');
    this.highlighted = id;
    if (id) this.rows.get(id)?.row.classList.add('hl');
  }

  /** Marks the row whose case file is open. */
  setOpen(id: string | null): void {
    if (id === this.openId) return;
    if (this.openId) this.rows.get(this.openId)?.row.classList.remove('open');
    this.openId = id;
    if (id) this.rows.get(id)?.row.classList.add('open');
  }

  /** Repaints every portrait on the next update (after a theme changed the looks behind the same slot ids). */
  invalidateFaces(): void {
    for (const r of this.rows.values()) { r.look = ''; r.key = ''; }
    this.order = '';
  }

  /** Brings the rows up to date (cheap when nothing changed). */
  update(entries: readonly RosterEntry[]): void {
    const staff = entries.filter((e) => !e.temp).length;
    const temps = entries.length - staff;
    const count = entries.length === 0 ? 'Nobody in yet' : `${staff} staff${temps ? ` · ${temps} temp${temps === 1 ? '' : 's'}` : ''}`;
    if (this.headCount.textContent !== count) this.headCount.textContent = count;
    const waiting = entries.filter((e) => e.needsYou).length;
    const alert = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : '';
    if (this.headAlert.textContent !== alert) this.headAlert.textContent = alert;
    if (this.empty.hidden !== (entries.length > 0)) this.empty.hidden = entries.length > 0;

    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.id);
      let r = this.rows.get(e.id);
      if (!r) {
        r = this.makeRow(e.id);
        this.rows.set(e.id, r);
      }
      if (r.look !== e.look) { this.paintFace(r.face, e.look); r.look = e.look; }
      const sendable = !e.temp && this.canSendHome(e.id);
      const key = `${e.title}|${e.name}|${e.role}|${e.doing}|${e.detail}|${e.since}|${e.needsYou}|${e.gone}|${e.temp}|${e.branch}|${e.control ?? ''}|${e.pending ?? ''}|${sendable}|${e.meta ?? ''}`;
      if (key === r.key) continue;
      r.key = key;
      const role = e.role || (getLook(e.look)?.role ?? (e.temp ? 'Temp' : 'Staff'));
      // A named person leads with their name, the role beside it; the session title then moves to the second line.
      r.title.textContent = e.name || e.title;
      r.role.textContent = e.name ? role : '';
      r.role.style.display = e.name ? '' : 'none';
      const doing = e.detail ? `${e.doing} · ${e.detail}` : e.doing;
      r.doing.textContent = e.name ? `${e.title} · ${doing}` : doing;
      r.since.textContent = e.gone ? '' : e.since;
      r.meta.textContent = e.gone ? '' : e.meta ?? '';
      r.row.classList.toggle('needs', e.needsYou);
      r.row.classList.toggle('gone', e.gone);
      r.row.classList.toggle('temp', e.temp);
      r.knock.hidden = !e.needsYou;
      const tabbed = this.tabs.has(e.id);
      const hint = tabbed ? 'Click to go to their tab' : e.pending ? 'Click to answer' : this.mode === 'strip' ? 'Click to open their case in a tab' : 'Click to open their case file';
      r.row.title = `${e.name ? `${e.name} \u2014 ${role}\n` : ''}${e.title}${e.name ? '' : `\n${role}`}${e.branch ? `\nBranch: ${e.branch}` : ''}\n${hint}`;
      r.x.hidden = !sendable;
      const who = e.name || e.title;
      r.x.setAttribute('aria-label', `Send ${who} home`);
      r.x.title = `Send ${who} home (they come back when the session is active again)`;
      r.branch.textContent = e.branch ? `\u2387 ${e.branch}` : '';
      r.branch.title = e.branch;
      const badge = controlBadge(e.control);
      const badgeKey = badge?.icon ?? '';
      if (r.badge.dataset['k'] !== badgeKey) {
        r.badge.dataset['k'] = badgeKey;
        r.badge.replaceChildren(...(badge ? [sprite(badge.icon, 2)] : []));
        r.badge.title = badge ? badge.title : '';
        r.badge.setAttribute('aria-label', badge ? badge.label : '');
        r.badge.style.display = badge ? '' : 'none';
      }
    }
    for (const [id, r] of this.rows) {
      if (!seen.has(id)) {
        r.wrap.remove();
        this.rows.delete(id);
        if (this.highlighted === id) this.highlighted = null;
        if (this.openId === id) this.openId = null;
      }
    }
    // Each staff member and their temps form one group, so a temp never
    // wraps away from its boss in the multi-column layout.
    const order = entries.map((e) => `${e.id}>${e.parentId ?? ''}`).join('|');
    if (order !== this.order) {
      this.order = order;
      const groups: HTMLDivElement[] = [];
      const byLead = new Map<string, HTMLDivElement>();
      for (const e of entries) {
        const lead = e.parentId && byLead.has(e.parentId) ? e.parentId : e.id;
        let g = byLead.get(lead);
        if (!g) {
          g = this.groups.get(lead) ?? document.createElement('div');
          g.className = 'co-group';
          this.groups.set(lead, g);
          byLead.set(lead, g);
          g.replaceChildren();
          groups.push(g);
        }
        g.appendChild(this.rows.get(e.id)!.wrap);
      }
      for (const id of [...this.groups.keys()]) if (!byLead.has(id)) this.groups.delete(id);
      this.list.replaceChildren(...groups);
    }
  }

  private makeRow(id: string): RowEls {
    const row = h('button', { type: 'button', class: 'co-row' });
    const face = document.createElement('canvas');
    face.className = 'co-face';
    face.width = FACE_W;
    face.height = FACE_H;
    // The same "!" the office shows over a knocking worker (the words are on the line below).
    const knock = h('span', { class: 'co-rknock', 'aria-hidden': 'true' }, pixelIcon('alert', 10));
    knock.hidden = true;
    const title = h('span', { class: 'co-title' });
    const badge = h('span', { class: 'co-badge' });
    badge.style.display = 'none';
    const role = h('span', { class: 'co-role' });
    role.style.display = 'none';
    const tab = h('span', { class: 'co-tabmark', text: 'In tab', title: 'Their case is open in an editor tab' });
    tab.hidden = !this.tabs.has(id);
    const doing = h('span', { class: 'co-doing' });
    // The detail line (model, effort, context, cost): only shown where the list has room (`.detail`).
    const meta = h('span', { class: 'co-meta' });
    const text = h('span', { class: 'co-text' }, h('span', { class: 'co-title-line' }, title, role, badge, tab), doing, meta);
    const since = h('span', { class: 'co-since' });
    const branch = h('span', { class: 'co-rbranch' });
    row.append(h('span', { class: 'co-facewrap' }, face, knock), text, h('span', { class: 'co-side' }, since, branch));
    row.addEventListener('mouseenter', () => this.onHover(id));
    row.addEventListener('focus', () => this.onHover(id));
    row.addEventListener('blur', () => this.onHover(null));
    row.addEventListener('click', () => this.onOpen(id));
    const x = h('button', { type: 'button', class: 'co-row-x', 'aria-label': 'Send home', text: '\u00d7' });
    x.hidden = true;
    x.addEventListener('click', (ev) => { ev.stopPropagation(); this.onSendHome(id); });
    const wrap = h('div', { class: 'co-rowwrap', role: 'listitem', 'data-agent': id }, row, x);
    if (id === this.highlighted) row.classList.add('hl');
    if (id === this.openId) row.classList.add('open');
    if (this.tabs.has(id)) row.classList.add('tabbed');
    return { wrap, row, x, face, knock, title, role, badge, tab, doing, meta, since, branch, look: '', key: '' };
  }

  private paintFace(face: HTMLCanvasElement, look: string): void {
    paintPortrait(face, look);
  }
}
