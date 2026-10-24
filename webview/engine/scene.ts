/**
 * Draws the office at 1x into an offscreen canvas: background, sign and
 * clock, then one depth-sorted list of furniture and characters (with desk
 * screens drawn right after their desk tops). Bubbles and labels are drawn
 * afterwards in screen space (`overlay.ts`).
 */
import {
  BACK_SIGN_SORT_Y, CABINET_DRAWER_MS_PER_PX, CABINET_DRAWER_STEPS, DEFAULT_HOVER_CABINET, IN_TRAY_BADGE_SORT_Y, MAP_PX_W, MAP_PX_H, PROP_ANCHORS, PROP_HIGHLIGHT, SCREEN_FOR_ACTIVITY,
  deskPileAnchors, desks, drawBackSign, drawCalendar, drawClockHands, drawDeskPile, drawInTray, drawPhoneLights,
  drawPlanNotes, drawPropOutline, drawScreen, drawSignText, drawUsageRing,
  CHAR_ANCHOR_Y, bookshelfFor, cabinetAjarSprite, easelCanvasRect, frameAt, getCharacterFrame, getFurniture, renderBackground, whiteboardRect,
  POST_SORT_Y, drawHeadOfficePost, foodCartPlacement, foodCartSprite,
} from '../art/index.ts';
import type { CartFacing, Desk, Dir, FurnitureItem, PlanNoteCounts, Pose, PropId, ScreenKind, UsageLevel } from '../art/index.ts';
import type { McpStatus, OfficeSettings } from '../../src/shared/protocol.ts';
import type { Office } from './office.ts';
import type { Char } from './characters.ts';
import { WALK_ANIM_RATE } from './characters.ts';
import { sipFrameElapsed } from './coffeeLogic.ts';

/** Outline colour around the highlighted character (props use the same colour). */
const HIGHLIGHT = PROP_HIGHLIGHT;

/** The cart swings round over this long when the vendor turns (it sits ahead of them, so a turn would otherwise jump it across). */
const CART_TURN_MS = 180;

/** Furniture id of the bookshelf (its sprite follows `SceneExtras.shelfCount`). */
const BOOKSHELF = 'bookshelf';

/** Furniture id of the front desk's top (its `phoneOff` variant shows the receiver off the cradle). */
const RECEPTION_DESK_TOP = 'desk-receptionist-top';

interface DrawEntry { sortY: number; order: number; draw: () => void }

/**
 * Live state for the office-tool props. Every field is optional; leave one
 * out and that prop draws in its plain, static form (no ring, empty tray,
 * blank calendar week, no piles or notes, phone lights off, the classic full
 * bookshelf, cabinet drawers shut).
 * Percentages are 0-100, like the protocol's `UsageWindow.pct`.
 */
export interface SceneExtras {
  /** The 5-hour window: a ring round the wall clock. `back` (e.g. "17:30") hangs a "BACK 17:30" card under it. */
  usage?: { pct: number | null; level: UsageLevel; back?: string | null };
  /** The weekly window: the wall calendar's current week fills to `pct`. */
  week?: { pct: number | null; level: UsageLevel };
  /** The manager's in-tray: papers stack with `count`, badge red and pulsing when `urgent`. */
  inTray?: { count: number; urgent: boolean };
  /** Paper piles on desks, keyed by agent id (= character id): 0-4 sheets, `warn` from 90% context. */
  piles?: Readonly<Record<string, { sheets: number; warn: boolean }>>;
  /** Plan notes on the conference whiteboard. */
  planNotes?: PlanNoteCounts;
  /**
   * Desk phone line lights, one per MCP server, in order: connected green, pending amber (blinks slowly), failed red,
   * needsAuth blue, unknown dim, disabled off. Four fit; with more, a "+" in the phone's corner takes the colour of the
   * most pressing hidden one. Empty or left out: all lights off, as drawn.
   */
  phoneLights?: readonly McpStatus[];
  /**
   * Skills and commands in the training library: the bookshelf shows that many books (0 = empty shelves, full from
   * `BOOKSHELF_SLOTS`, about 30). The same count always draws the same books. Left out: the classic full shelf.
   */
  shelfCount?: number;
  /**
   * The filing cabinets are hovered: a top drawer slides out a few pixels (about 45 ms a pixel) and slides back when
   * this goes false. `true` (or any other string) opens the middle cabinet; a filing-cabinet furniture id
   * (`filing-21`, `filing-22`, `filing-23`) opens that one. A cabinet someone is rummaging in shows its `open`
   * sprite instead.
   */
  cabinetHover?: string | boolean | null;
  /** Prop under the pointer (or focused in the icon bar): outlined like a hovered worker. */
  hoverProp?: PropId | null;
  /**
   * Post from head office (an update is waiting): an envelope on the reception counter and an envelope badge over it, in
   * the given plate and rim colours; `bright` is the badge's slow pulse. Left out: no post.
   */
  post?: { plate: string; rim: string; bright: boolean } | null;
}

export class Scene {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly furniture: readonly FurnitureItem[];
  private readonly bg: HTMLCanvasElement;
  private readonly deskById = new Map<string, Desk>();
  /** Scratch canvas for the highlight silhouette. */
  private readonly sil: HTMLCanvasElement;
  private highlightId: string | null = null;
  private extras: SceneExtras | undefined;
  /** Desk id -> pile, rebuilt each frame from `extras.piles`. */
  private readonly pileByDesk = new Map<string, { sheets: number; warn: boolean }>();
  /** Desks whose owner is sipping this frame: the top is drawn without the mug. */
  private sipDesks: ReadonlySet<string> = new Set();
  /** Furniture ids of the filing cabinets (valid `cabinetHover` targets). */
  private readonly cabinetIds = new Set<string>();
  /** The hover drawer: which cabinet, how far out (px, fractional), and the clock of the last step. */
  private readonly drawer: { id: string | null; pos: number; lastT: number | null } = { id: null, pos: 0, lastT: null };
  /** The way the cart pointed last frame, and the offset it is still swinging out of (see `CART_TURN_MS`). */
  private cartFace: CartFacing | null = null;
  private cartSwing = { dx: 0, dy: 0, at: 0 };

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_PX_W;
    this.canvas.height = MAP_PX_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.furniture = getFurniture();
    this.bg = renderBackground();
    for (const d of desks) this.deskById.set(d.id, d);
    for (const f of this.furniture) if (f.kind === 'filingCabinet') this.cabinetIds.add(f.id);
    this.sil = document.createElement('canvas');
  }

  /**
   * Draws the world. `highlightId` gets a yellow outline (hovered here or in
   * the roster). `extras` drives the office-tool props; without it the
   * office draws its static decoration only.
   */
  render(office: Office, settings: OfficeSettings, t: number, highlightId: string | null = null, extras?: SceneExtras): void {
    const ctx = this.ctx;
    this.highlightId = highlightId;
    this.extras = extras;
    this.stepDrawer(extras?.cabinetHover, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0);
    drawSignText(ctx, settings.companyName || 'Middle Management', settings.branchName);
    if (extras?.week) drawCalendar(ctx, 0, 0, extras.week.pct, extras.week.level);
    if (extras?.usage) drawUsageRing(ctx, 0, 0, extras.usage.pct, extras.usage.level);
    drawClockHands(ctx, new Date());
    this.drawBoards(office, t);
    if (extras?.planNotes) drawPlanNotes(ctx, 0, 0, extras.planNotes);

    this.pileByDesk.clear();
    if (extras?.piles) {
      for (const c of office.allChars()) {
        const p = extras.piles[c.id];
        if (p && c.seat && !c.removed) this.pileByDesk.set(c.seat.deskId, p);
      }
    }

    const active = office.activeProps();
    this.sipDesks = office.sippingDesks(t);
    const entries: DrawEntry[] = [];
    for (const item of this.furniture) {
      entries.push({ sortY: item.sortY, order: 0, draw: () => this.drawFurniture(item, active, office, t) });
    }
    for (const c of office.allChars()) {
      if (c.removed) continue;
      entries.push({ sortY: c.y, order: 1, draw: () => this.drawChar(c, t, office) });
    }
    // The food cart goes wherever the vendor does: ahead of them (the way they face), sorted by its own floor line.
    if (office.vendorOnStage && !office.vendor.removed) {
      const v = office.vendor;
      const face = v.dir as CartFacing;
      const fx = Math.round(v.x);
      const fy = Math.round(v.y);
      const cart = foodCartPlacement(face, fx, fy);
      const k = Math.max(0, 1 - (t - this.cartSwing.at) / CART_TURN_MS);
      if (this.cartFace !== null && this.cartFace !== face) {
        // Turned: start from where the cart was drawn and slide to its new place.
        const was = foodCartPlacement(this.cartFace, fx, fy);
        this.cartSwing = { dx: was.x + this.cartSwing.dx * k - cart.x, dy: was.y + this.cartSwing.dy * k - cart.y, at: t };
      }
      this.cartFace = face;
      const s = Math.max(0, 1 - (t - this.cartSwing.at) / CART_TURN_MS);
      const cx = cart.x + Math.round(this.cartSwing.dx * s);
      const cy = cart.y + Math.round(this.cartSwing.dy * s);
      entries.push({ sortY: cart.sortY, order: 1, draw: () => this.ctx.drawImage(foodCartSprite(face), cx, cy) });
    } else {
      this.cartFace = null;
      this.cartSwing = { dx: 0, dy: 0, at: 0 };
    }
    const back = extras?.usage?.back;
    if (back) entries.push({ sortY: BACK_SIGN_SORT_Y, order: 0.5, draw: () => drawBackSign(ctx, 0, 0, `BACK ${back}`) });
    const tray = extras?.inTray;
    if (tray && tray.count > 0) entries.push({ sortY: IN_TRAY_BADGE_SORT_Y, order: 0.5, draw: () => drawInTray(ctx, 0, 0, tray.count, tray.urgent, t, 'badge') });
    const post = extras?.post;
    if (post) entries.push({ sortY: POST_SORT_Y, order: 0.5, draw: () => drawHeadOfficePost(ctx, 0, 0, post, post.bright) });
    entries.sort((a, b) => (a.sortY - b.sortY) || (a.order - b.order));
    for (const e of entries) e.draw();

    const hover = extras?.hoverProp;
    if (hover && PROP_ANCHORS[hover]) drawPropOutline(ctx, 0, 0, PROP_ANCHORS[hover]);
  }

  private drawFurniture(item: FurnitureItem, active: Set<string>, office: Office, t: number): void {
    let sprite = item.sprite;
    const shelf = this.extras?.shelfCount;
    if (item.id === BOOKSHELF && shelf !== undefined) sprite = bookshelfFor(shelf);
    if (active.has(item.id)) sprite = item.variants['open'] ?? item.variants['active'] ?? sprite;
    else if (item.id === this.drawer.id && Math.round(this.drawer.pos) > 0) sprite = cabinetAjarSprite(Math.round(this.drawer.pos));
    // The front desk's phone: the receiver leaves its cradle while the receptionist is on a call.
    if (item.id === RECEPTION_DESK_TOP && office.receptionOnPhone()) sprite = item.variants['phoneOff'] ?? sprite;
    // A worker drinking from the desk mug (`deskSip`): the desk shows no mug meanwhile.
    if (item.kind === 'deskTop' && item.deskId && this.sipDesks.has(item.deskId)) sprite = item.variants['noMug'] ?? sprite;
    this.ctx.drawImage(sprite, item.x, item.y);
    if (item.kind === 'deskTop' && item.deskId) {
      const desk = this.deskById.get(item.deskId);
      if (!desk) return;
      const st = office.deskScreen(desk.id);
      let kind: ScreenKind;
      if (st.mode === 'off') kind = 'off';
      else if (st.mode === 'idle') kind = 'idle';
      else if (st.mode === 'kind') kind = (st.value as ScreenKind) ?? 'idle';
      else kind = SCREEN_FOR_ACTIVITY[st.value ?? ''] ?? 'code';
      // A screen with a start time (the IT crew's boot) runs its animation from 0.
      drawScreen(this.ctx, desk.screen, kind, st.since !== undefined ? t - st.since : t, 0, 0, kind === 'off' ? undefined : desk.glow);
      this.drawDeskExtras(desk, t);
    }
  }

  /** Office-tool props that sit on a desk top: paper piles, and the manager's in-tray and phone lights. */
  private drawDeskExtras(desk: Desk, t: number): void {
    const x = this.extras;
    if (!x) return;
    if (desk.kind === 'manager') {
      if (x.inTray) drawInTray(this.ctx, 0, 0, x.inTray.count, x.inTray.urgent, t, 'tray');
      if (x.phoneLights?.length) drawPhoneLights(this.ctx, 0, 0, x.phoneLights, t);
      return;
    }
    const pile = this.pileByDesk.get(desk.id);
    const at = deskPileAnchors[desk.id];
    if (pile && at && pile.sheets > 0) drawDeskPile(this.ctx, at.x, at.y, pile.sheets, pile.warn);
  }

  /** Slides the hover drawer towards open (hovered) or shut by the time since the last frame. */
  private stepDrawer(hover: string | boolean | null | undefined, t: number): void {
    const d = this.drawer;
    let want: string | null = null;
    if (hover === true || (typeof hover === 'string' && hover !== '')) {
      want = typeof hover === 'string' && this.cabinetIds.has(hover) ? hover : DEFAULT_HOVER_CABINET;
    }
    const dt = d.lastT === null ? 0 : Math.max(0, t - d.lastT);
    d.lastT = t;
    if (want && want !== d.id) { d.id = want; d.pos = 0; }
    const step = dt / CABINET_DRAWER_MS_PER_PX;
    if (want) d.pos = Math.min(CABINET_DRAWER_STEPS, d.pos + step);
    else {
      d.pos = Math.max(0, d.pos - step);
      if (d.pos === 0) d.id = null;
    }
  }

  private drawChar(c: Char, t: number, office: Office): void {
    // A sip replaces the work pose for a moment (faster at higher effort); the character's own pose and goal are untouched.
    const sip = office.sipOf(c, t);
    const pose = sip ? 'deskSip' : c.pose as Pose;
    const walking = pose === 'walk' || pose === 'pushCart';
    const rate = walking ? WALK_ANIM_RATE : 1;
    // Offset each character's animation a little so idle blinks aren't in sync.
    const phase = (hashStr(c.id) % 997) * (walking || sip ? 0 : 1);
    const frame = sip ? frameAt('deskSip', sipFrameElapsed(sip.elapsedMs, sip.effort)) : frameAt(pose, (t - c.poseStart) * rate + phase);
    const img = getCharacterFrame(c.look, pose, sip ? 'down' : c.dir as Dir, frame, c.goal?.food);
    const x = Math.round(c.x) - 8;
    const y = Math.round(c.y) - CHAR_ANCHOR_Y;
    if (c.id === this.highlightId) {
      const sil = this.sil;
      if (sil.width !== img.width || sil.height !== img.height) { sil.width = img.width; sil.height = img.height; }
      const sc = sil.getContext('2d');
      if (sc) {
        sc.globalCompositeOperation = 'source-over';
        sc.clearRect(0, 0, sil.width, sil.height);
        sc.drawImage(img, 0, 0);
        sc.globalCompositeOperation = 'source-in';
        sc.fillStyle = HIGHLIGHT;
        sc.fillRect(0, 0, sil.width, sil.height);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) this.ctx.drawImage(sil, x + dx, y + dy);
      }
    }
    this.ctx.drawImage(img, x, y);
  }

  /** Scribbles on the whiteboard and a painting on the easel while someone works there. */
  private drawBoards(office: Office, t: number): void {
    const ctx = this.ctx;
    for (const c of office.chars.values()) {
      if (!c.arrived || !c.goal) continue;
      const elapsed = (t - c.arrivedAt) / 1000;
      if (c.goal.key === 'whiteboard') {
        const r = whiteboardRect;
        const colors = ['#2f5fb3', '#c23b3b', '#2a2a2a', '#2f8a4a'];
        const cycle = elapsed % 24;
        const total = Math.floor(cycle * 6);
        let drawn = 0;
        for (let row = 0; row < 4 && drawn < total; row++) {
          const len = [30, 22, 38, 16][row]!;
          const n = Math.min(len, total - drawn);
          ctx.fillStyle = colors[row]!;
          ctx.fillRect(r.x + 4, r.y + 3 + row * 4, n, 1);
          if (row === 1 && n > 4) ctx.fillRect(r.x + 4 + n + 2, r.y + 2 + row * 4, 3, 3);
          drawn += len;
        }
        if (total > 60) { ctx.fillStyle = '#c23b3b'; ctx.fillRect(r.x + 44, r.y + 4, 8, 1); ctx.fillRect(r.x + 44, r.y + 9, 8, 1); ctx.fillRect(r.x + 44, r.y + 4, 1, 6); ctx.fillRect(r.x + 51, r.y + 4, 1, 6); }
      } else if (c.goal.key === 'easel') {
        const r = easelCanvasRect;
        const strokes = Math.min(10, Math.floor((elapsed % 30) * 0.8));
        const cols = ['#e2833a', '#4a8fd8', '#e8c547', '#6ab04c', '#c0547a'];
        for (let i = 0; i < strokes; i++) {
          const h = hashStr(`${c.id}${i}`);
          ctx.fillStyle = cols[i % cols.length]!;
          ctx.fillRect(r.x + 1 + (h % Math.max(1, r.w - 3)), r.y + 1 + ((h >> 4) % Math.max(1, r.h - 3)), 2, 1 + ((h >> 8) % 2));
        }
      }
    }
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
