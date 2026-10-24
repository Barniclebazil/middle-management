/**
 * The in-office update cue, wired: while `showUpdateCue(getUpdate())` holds, the receptionist mentions the post from head office
 * now and then (`cueTick`), an envelope sits on her counter and an envelope badge pulses over it (the scene's `post` extra, in
 * the theme's sign colours via `postColours`), and a click on her, the badge or the envelope opens the head office memo
 * (`cueClick`). The counter itself still opens the Front desk. A keyboard stop over the badge does the same for the keyboard.
 * `main.ts` calls `tick` every frame, `targetAt` / `click` on a click, `hovering` / `badgeTip` / `receptionistTip` for the
 * tooltip and `place` after every view change; everything it decides is in `updateCueLogic.ts`.
 */
import { POST_BADGE_RECT, POST_ENVELOPE_RECT, postBadgeSprite, signColours } from '../art/index.ts';
import type { Office } from './office.ts';
import type { Char } from './characters.ts';
import { button, h } from './dom.ts';
import { SAY_MS } from './reception.ts';
import { CUE_IDLE, badgeTooltip, cueClick, cueOnVisible, cueTick, inRect, peekPlacement, postColours, receptionistCueTooltip } from './updateCueLogic.ts';
import type { CueClock, CueTarget } from './updateCueLogic.ts';
import { receptionistUpdateLine, showUpdateCue } from './updateLogic.ts';
import { getUpdate, onUpdate } from './updateStore.ts';
import type { UpdateMemoView } from './updateMemoView.ts';
import type { TooltipContent } from './tooltip.ts';

/** Half a pulse of the badge's rim (calmer than the in-tray's urgent 600 ms blink). */
const PULSE_HALF_MS = 900;
/** The edge pointer's badge, CSS px (the 13 px sprite at 2x), and the pointer's whole collapsed size. */
const PEEK_ICON = 26;
const PEEK_SIZE = 36;

const CSS = `
.co-hq-peek { position: fixed; z-index: 4; display: inline-flex; align-items: center; gap: 6px; height: ${PEEK_SIZE}px; min-width: ${PEEK_SIZE}px;
  padding: 0 5px; margin: 0; border: 2px solid #3a3340; border-radius: 2px; background: var(--co-paper); color: var(--co-ink); cursor: pointer;
  box-shadow: 2px 2px 0 rgba(0,0,0,0.35); font: 600 12px/1 var(--co-font); white-space: nowrap; }
.co-hq-peek[hidden] { display: none; }
.co-hq-peek canvas { width: ${PEEK_ICON}px; height: ${PEEK_ICON}px; image-rendering: pixelated; flex: none; }
.co-hq-peek .co-hq-peek-label { display: none; }
.co-hq-peek.saying .co-hq-peek-label, .co-hq-peek:hover .co-hq-peek-label, .co-hq-peek:focus-visible .co-hq-peek-label { display: inline; }
.co-hq-peek[data-side="right"] { flex-direction: row-reverse; }
/* A notch pointing the way to the front desk. */
.co-hq-peek::before { content: ''; position: absolute; top: 50%; margin-top: -5px; border: 5px solid transparent; }
.co-hq-peek[data-side="left"]::before { left: -9px; border-right: 5px solid #3a3340; border-left: 0; }
.co-hq-peek[data-side="right"]::before { right: -9px; border-left: 5px solid #3a3340; border-right: 0; }
.co-hq-peek[data-side="top"]::before { display: none; }
.co-hq-peek[data-side="bottom"]::before { display: none; }
.co-hq-peek:focus { outline: none; }
.co-hq-peek:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
body.vscode-high-contrast .co-hq-peek, body.vscode-high-contrast-light .co-hq-peek { border-color: var(--vscode-contrastBorder, #6fc3df); box-shadow: none; }
`;
let stylesIn = false;
function injectStyles(): void {
  if (stylesIn) return;
  stylesIn = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface UpdateCueDeps {
  office: Office;
  memo: UpdateMemoView;
  /** Redraw soon (the cue appeared or went). */
  requestFrame(): void;
  /** The keyboard stop goes right after this element in the Tab order (the props' stops). */
  stopAfter: HTMLElement;
}

export interface ScreenView { ox: number; oy: number; scale: number }
export interface ScreenRect { x: number; y: number; w: number; h: number }

export class UpdateCue {
  private readonly deps: UpdateCueDeps;
  private clock: CueClock = CUE_IDLE;
  private readonly stop: HTMLButtonElement;
  private readonly reduced: MediaQueryList | null;
  private lastNow = 0;
  private lastPlace: { view: ScreenView; region: ScreenRect } | null = null;
  /** The pointer at the edge of a panned view while the badge is out of sight (the narrow sidebar starts far from the front desk). */
  private readonly peek: HTMLButtonElement;
  private readonly peekIcon: HTMLCanvasElement;
  private peekKey = '';

  constructor(deps: UpdateCueDeps) {
    this.deps = deps;
    this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    // Same look and behaviour as the props' keyboard stops; its own group so `updateInert` covers it too.
    this.stop = button([], 'co-propstop', () => { this.deps.memo.open(); }, { 'aria-label': 'Post from head office: read the memo' });
    this.stop.hidden = true;
    const group = h('div', { class: 'co-propstops co-ui', role: 'group', 'aria-label': 'Post from head office' }, this.stop);
    deps.stopAfter.after(group);
    injectStyles();
    this.peekIcon = h('canvas', { width: '13', height: '13', 'aria-hidden': 'true' });
    this.peek = button([this.peekIcon, h('span', { class: 'co-hq-peek-label', text: 'Post from head office' })], 'co-hq-peek co-ui', () => { this.deps.memo.open(); }, {
      'aria-label': 'Post from head office at the front desk: read the memo', title: 'Post from head office (at the front desk): click to read the memo',
    });
    this.peek.hidden = true;
    group.appendChild(this.peek);
    onUpdate(() => {
      deps.requestFrame();
      if (this.lastPlace) this.place(this.lastPlace.view, this.lastPlace.region);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.clock = cueOnVisible(this.clock, this.lastNow);
    });
  }

  /** True while the post is waiting. */
  get on(): boolean {
    return showUpdateCue(getUpdate());
  }

  /**
   * One frame (`now`: the office's local clock, as passed to `office.update`): lets the receptionist say her line when it is
   * due, and returns what the scene draws (null: no post).
   */
  tick(now: number): { plate: string; rim: string; bright: boolean } | null {
    // A long gap means the webview was hidden (frames stop): treat it as coming back into view.
    if (now - this.lastNow > 5_000 && this.lastNow > 0) this.clock = cueOnVisible(this.clock, now);
    this.lastNow = now;
    const u = getUpdate();
    const { office } = this.deps;
    const r = office.receptionist;
    const busy = !office.speechBubbles || office.receptionOnPhone() || office.reception.isAttending() || r.say !== null;
    const step = cueTick(this.clock, receptionistUpdateLine(u), now, busy);
    this.clock = step.clock;
    if (step.say) r.say = { text: step.say, until: now + SAY_MS };
    if (!showUpdateCue(u)) return null;
    const sign = signColours();
    const bright = this.reduced?.matches ? true : Math.floor(now / PULSE_HALF_MS) % 2 === 0;
    const colours = postColours(sign.plate, sign.text);
    if (!this.peek.hidden) {
      // The edge pointer pulses with the badge, and shows her line while she says it (she is out of view).
      const key = `${colours.plate}|${colours.rim}|${bright}`;
      if (key !== this.peekKey) {
        this.peekKey = key;
        const ctx = this.peekIcon.getContext('2d');
        if (ctx) { ctx.clearRect(0, 0, 13, 13); ctx.drawImage(postBadgeSprite(colours, bright), 0, 0); }
      }
      const line = receptionistUpdateLine(u);
      const saying = !!line && r.say?.text === line;
      if (this.peek.classList.contains('saying') !== saying) this.peek.classList.toggle('saying', saying);
      const label = this.peek.lastElementChild;
      if (label && line && label.textContent !== line) label.textContent = line;
    }
    return { ...colours, bright };
  }

  /** What the notice makes of a map point: the badge or the counter envelope, the receptionist, the counter, or anything else. */
  targetAt(mapX: number, mapY: number, char: Char | null, counter: ScreenRect): CueTarget {
    if (!this.on) return 'other';
    if (char) return char.kind === 'receptionist' ? 'receptionist' : 'other';
    if (inRect(mapX, mapY, POST_BADGE_RECT) || inRect(mapX, mapY, POST_ENVELOPE_RECT)) return 'badge';
    return inRect(mapX, mapY, counter) ? 'counter' : 'other';
  }

  /** A click on `target`: opens the memo and returns true when the notice takes it. */
  click(target: CueTarget): boolean {
    if (cueClick(this.on, target) !== 'memo') return false;
    return this.deps.memo.open();
  }

  /** True when the pointer (map px) is over the badge or the counter envelope while the post waits. */
  hovering(mapX: number, mapY: number): boolean {
    return this.on && (inRect(mapX, mapY, POST_BADGE_RECT) || inRect(mapX, mapY, POST_ENVELOPE_RECT));
  }

  badgeTip(): TooltipContent {
    return badgeTooltip(getUpdate()?.status === 'installed');
  }

  /** The receptionist's tooltip: the post replaces her usual hint while it waits. */
  receptionistTip(base: TooltipContent): TooltipContent {
    return this.on ? receptionistCueTooltip(base) : base;
  }

  /** Puts the keyboard stop over the badge (CSS px); hidden while there is no post or the badge is outside `region`. */
  place(view: ScreenView, region: ScreenRect): void {
    this.lastPlace = { view: { ox: view.ox, oy: view.oy, scale: view.scale }, region: { ...region } };
    const r = POST_BADGE_RECT;
    const x = view.ox + r.x * view.scale;
    const y = view.oy + r.y * view.scale;
    const w = r.w * view.scale;
    const hgt = r.h * view.scale;
    const peek = this.on ? peekPlacement({ x, y, w, h: hgt }, region, { w: PEEK_SIZE, h: PEEK_SIZE }) : null;
    const showPeek = this.on && peek !== null && region.w >= PEEK_SIZE * 3;
    if (this.peek.hidden === showPeek) { this.peek.hidden = !showPeek; this.peekKey = ''; }
    if (showPeek && peek) {
      this.peek.dataset['side'] = peek.side;
      if (peek.side === 'right') { this.peek.style.left = ''; this.peek.style.right = `${Math.round(window.innerWidth - (peek.x + PEEK_SIZE))}px`; }
      else { this.peek.style.right = ''; this.peek.style.left = `${peek.x}px`; }
      this.peek.style.top = `${peek.y}px`;
    }
    const show = this.on && peek === null;
    if (this.stop.hidden === show) this.stop.hidden = !show;
    if (!show) return;
    this.stop.style.left = `${x}px`;
    this.stop.style.top = `${y}px`;
    this.stop.style.width = `${w}px`;
    this.stop.style.height = `${hgt}px`;
  }
}
