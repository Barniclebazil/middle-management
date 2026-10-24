/**
 * A large animated preview of one look (task 3.11), for the Front desk's Staff tab: a pixel-crisp canvas at 4x that shows
 * the look standing, walking, typing at a desk and on the phone, in front of the office's own wall and carpet colours.
 *
 * The caller builds the look (`buildLook(LOOK_PREVIEW_ID, spec, builtIn)`) and hands it to `setLook`; the preview
 * registers it under its id (`registerLook` drops the id's cached frames) and redraws. It redraws only when the look
 * changes or the next animation frame is due (a timer to that moment, no rAF loop), stops while it is off screen, starts
 * paused when the user prefers reduced motion, and stops its timer on `unmount`. Text nodes only.
 */
import { C, CHAR_ANCHOR_Y, CHAR_H, CHAR_W, POSES, frameAt, getCharacterFrame, poseCycleMs, registerLook } from '../art/index.ts';
import type { Dir, LookDef, Pose } from '../art/index.ts';
import { button, h } from './dom.ts';

/** The look id the preview registers its look under. */
export const LOOK_PREVIEW_ID = '__preview__';

/** Logical stage size in sprite pixels; the canvas is this times `scale`. */
const STAGE_W = 40;
const STAGE_H = 32;
/** Where the feet stand (frame bottom-centre), in stage pixels. */
const FEET_X = 20;
const FEET_Y = 29;
/** First stage row of the floor. */
const FLOOR_Y = 19;

interface Step {
  pose: Pose;
  dir: Dir;
  ms: number;
  label: string;
}

/** The poses the preview cycles through. Lengths are whole cycles of each pose (the stand includes one blink). */
const STEPS: readonly Step[] = [
  { pose: 'stand', dir: 'down', ms: 2900, label: 'Standing' },
  { pose: 'walk', dir: 'down', ms: 2240, label: 'Walking' },
  { pose: 'walk', dir: 'right', ms: 2240, label: 'Walking' },
  { pose: 'sitType', dir: 'down', ms: 2520, label: 'Typing' },
  { pose: 'sitPhone', dir: 'down', ms: poseCycleMs('sitPhone'), label: 'On the phone' },
  { pose: 'walk', dir: 'left', ms: 2240, label: 'Walking' },
];

/** Milliseconds from `t` (into the pose) until its frame changes. */
function untilNextFrame(pose: Pose, t: number): number {
  const d = POSES[pose].durations;
  const total = poseCycleMs(pose);
  let r = ((t % total) + total) % total;
  for (const ms of d) {
    if (r < ms) return ms - r;
    r -= ms;
  }
  return d[0] ?? 100;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const STYLE = `
.co-lp { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: none; }
.co-lp-stage { display: block; border-radius: 4px; image-rendering: pixelated; image-rendering: crisp-edges;
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
.co-lp-bar { display: flex; align-items: center; gap: 4px; min-height: 24px; }
.co-lp-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; padding: 0; border-radius: 3px; cursor: pointer;
  font: inherit; font-size: 11px; line-height: 1; color: var(--vscode-foreground, #cccccc); background: transparent;
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))); }
.co-lp-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
.co-lp-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.co-lp-cap { min-width: 82px; font-size: 11.5px; text-align: center; color: var(--vscode-descriptionForeground, #9d9d9d); }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export interface LookPreviewOptions {
  /** CSS pixels per sprite pixel (default 4). */
  scale?: number;
  /** The id to register the look under (default `LOOK_PREVIEW_ID`). */
  id?: string;
  /** Accessible name of the canvas, e.g. "Preview of Marta Quill". */
  label?: string;
}

export interface LookPreview {
  readonly el: HTMLElement;
  /** Shows `def` (registered under the preview id). `key` identifies the look: the same key again does nothing. */
  setLook(def: LookDef, key: string): void;
  /** Updates the canvas's accessible name. */
  setLabel(label: string): void;
  /** Redraws now (e.g. after the office colours changed: the stage uses them). */
  redraw(): void;
  /** Stops the timer and observers. */
  unmount(): void;
}

/** Builds a preview. Append `el`, then call `setLook`. */
export function createLookPreview(opts: LookPreviewOptions = {}): LookPreview {
  injectCss();
  const scale = Math.max(1, Math.round(opts.scale ?? 4));
  const id = opts.id ?? LOOK_PREVIEW_ID;
  const canvas = h('canvas', { class: 'co-lp-stage co-px', role: 'img', 'aria-label': opts.label ?? 'Look preview' });
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;
  canvas.style.width = `${STAGE_W * scale}px`;
  canvas.style.height = `${STAGE_H * scale}px`;
  const ctx = canvas.getContext('2d');

  let step = 0;
  /** Time into the current step (ms) when paused; while playing, derived from `stepStart`. */
  let stepStart = performance.now();
  let pausedAt: number | null = reducedMotion() ? 0 : null;
  let timer: number | null = null;
  let visible = true;
  let dead = false;
  let lookKey: string | null = null;

  const caption = h('span', { class: 'co-lp-cap', 'aria-live': 'off' });
  const playBtn = button('', 'co-lp-btn', () => { togglePause(); }, { 'data-k': 'lp-play' });
  const nextBtn = button(h('span', { 'aria-hidden': 'true', text: '»' }), 'co-lp-btn', () => { nextStep(); }, { 'data-k': 'lp-next', 'aria-label': 'Next pose', title: 'Next pose' });
  const el = h('div', { class: 'co-lp' }, canvas, h('div', { class: 'co-lp-bar' }, playBtn, caption, nextBtn));

  function elapsed(now: number): number {
    return pausedAt !== null ? pausedAt : now - stepStart;
  }

  function renderBar(): void {
    const playing = pausedAt === null;
    playBtn.replaceChildren(h('span', { 'aria-hidden': 'true', text: playing ? '❚❚' : '▶' }));
    playBtn.setAttribute('aria-label', playing ? 'Pause the animation' : 'Play the animation');
    playBtn.title = playing ? 'Pause' : 'Play';
    caption.textContent = STEPS[step]!.label;
  }

  function drawStage(g: CanvasRenderingContext2D, seated: boolean): void {
    // Wall, skirting and the office carpet, in the office's current colours.
    g.fillStyle = C.wall;
    g.fillRect(0, 0, STAGE_W, FLOOR_Y);
    g.fillStyle = C.wallShade;
    g.fillRect(0, FLOOR_Y - 4, STAGE_W, 1);
    g.fillStyle = C.baseboard;
    g.fillRect(0, FLOOR_Y - 2, STAGE_W, 2);
    g.fillStyle = C.baseboardLight;
    g.fillRect(0, FLOOR_Y - 2, STAGE_W, 1);
    g.fillStyle = C.carpet;
    g.fillRect(0, FLOOR_Y, STAGE_W, STAGE_H - FLOOR_Y);
    g.fillStyle = C.carpetAlt;
    for (let y = FLOOR_Y; y < STAGE_H; y += 4) {
      for (let x = ((y - FLOOR_Y) / 4) % 2 === 0 ? 0 : 4; x < STAGE_W; x += 8) g.fillRect(x, y, 4, 4);
    }
    if (seated) {
      // The chair back behind the sitter.
      g.fillStyle = C.tealDark;
      g.fillRect(FEET_X - 6, FEET_Y - 19, 12, 13);
      g.fillStyle = C.teal;
      g.fillRect(FEET_X - 5, FEET_Y - 18, 10, 11);
    } else {
      // A soft shadow under the feet.
      g.fillStyle = 'rgba(20, 12, 24, 0.28)';
      g.fillRect(FEET_X - 5, FEET_Y - 1, 10, 2);
      g.fillRect(FEET_X - 4, FEET_Y + 1, 8, 1);
    }
  }

  function drawDesk(g: CanvasRenderingContext2D): void {
    // A plain desk in front of a seated pose: the top at the frame's cut row, a modesty panel below.
    const top = FEET_Y - CHAR_H + 19;
    const x0 = FEET_X - 15;
    const w = 30;
    g.fillStyle = C.deskEdge;
    g.fillRect(x0, top - 1, w, 1);
    g.fillStyle = C.deskLight;
    g.fillRect(x0, top, w, 1);
    g.fillStyle = C.desk;
    g.fillRect(x0, top + 1, w, 3);
    g.fillStyle = C.deskEdge;
    g.fillRect(x0, top + 4, w, 1);
    g.fillStyle = C.deskPanel;
    g.fillRect(x0 + 2, top + 5, w - 4, STAGE_H - top - 5);
    g.fillStyle = C.deskPanelLight;
    g.fillRect(x0 + 2, top + 5, w - 4, 1);
    g.fillStyle = C.deskPanelDark;
    g.fillRect(x0 + 2, top + 5, 1, STAGE_H - top - 5);
    g.fillRect(x0 + w - 3, top + 5, 1, STAGE_H - top - 5);
  }

  function draw(now: number): void {
    if (!ctx || lookKey === null) return;
    const s = STEPS[step]!;
    const seated = POSES[s.pose].seated;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);
    drawStage(ctx, seated);
    const frame = getCharacterFrame(id, s.pose, s.dir, frameAt(s.pose, elapsed(now)));
    ctx.drawImage(frame, FEET_X - CHAR_W / 2, FEET_Y - CHAR_ANCHOR_Y);
    if (seated) drawDesk(ctx);
  }

  function clearTimer(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    clearTimer();
    if (dead || pausedAt !== null || !visible || lookKey === null) return;
    const now = performance.now();
    const s = STEPS[step]!;
    const t = now - stepStart;
    const wait = Math.max(16, Math.min(s.ms - t, untilNextFrame(s.pose, t)));
    timer = window.setTimeout(tick, wait);
  }

  function tick(): void {
    timer = null;
    if (dead) return;
    const now = performance.now();
    if (pausedAt === null && now - stepStart >= STEPS[step]!.ms) {
      step = (step + 1) % STEPS.length;
      stepStart = now;
      renderBar();
    }
    draw(now);
    schedule();
  }

  function togglePause(): void {
    const now = performance.now();
    if (pausedAt === null) {
      pausedAt = now - stepStart;
    } else {
      stepStart = now - pausedAt;
      pausedAt = null;
    }
    renderBar();
    draw(now);
    schedule();
  }

  function nextStep(): void {
    step = (step + 1) % STEPS.length;
    const now = performance.now();
    stepStart = now;
    if (pausedAt !== null) pausedAt = 0;
    renderBar();
    draw(now);
    schedule();
  }

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was) {
        draw(performance.now());
        schedule();
      } else if (!visible) clearTimer();
    });
    io.observe(canvas);
  }

  renderBar();

  return {
    el,
    setLook(def, key) {
      if (dead || key === lookKey) return;
      lookKey = key;
      registerLook(def.id === id ? def : { ...def, id });
      draw(performance.now());
      schedule();
    },
    setLabel(label) {
      canvas.setAttribute('aria-label', label);
    },
    redraw() {
      draw(performance.now());
    },
    unmount() {
      dead = true;
      clearTimer();
      io?.disconnect();
      io = null;
    },
  };
}
