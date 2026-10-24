import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  CUE_FIRST_SAY_MS, CUE_IDLE, CUE_REPEAT_MS, CUE_VISIBLE_DELAY_MS, CUE_VISIBLE_GAP_MS, DEFAULT_MEMO_INK, DEFAULT_SIGN, ENVELOPE_PAPER, GRAPHIC_MIN, TEXT_MIN,
  badgeTooltip, chroma, cueClick, cueOnVisible, cueTick, inRect, inkOn, memoAccent, memoAfterUpdate, peekPlacement, postColours, receptionistCueTooltip,
} from '../webview/engine/updateCueLogic.ts';
import type { CueClock, CueTarget } from '../webview/engine/updateCueLogic.ts';
import { contrastRatio } from '../webview/engine/frontDeskLogic.ts';
import { updateMemo } from '../webview/engine/updateLogic.ts';
import type { UpdateInfo, UpdateStatus } from '../src/shared/protocol.ts';
import { UPDATE_STATUSES } from '../src/shared/protocol.ts';

const LINE = 'Post from head office!';

/** Runs `cueTick` over frames from `from` to `to` (step ms) and returns the times she spoke. */
function run(clock: CueClock, line: string | undefined, from: number, to: number, step = 100, busy: (t: number) => boolean = () => false): { clock: CueClock; said: number[] } {
  const said: number[] = [];
  let c = clock;
  for (let t = from; t <= to; t += step) {
    const r = cueTick(c, line, t, busy(t));
    c = r.clock;
    if (r.say) said.push(t);
  }
  return { clock: c, said };
}

test('cue timing: first line a moment after the cue appears, then every repeat interval', () => {
  const { said } = run(CUE_IDLE, LINE, 10_000, 10_000 + 2 * CUE_REPEAT_MS + 5_000);
  assert.deepEqual(said, [10_000 + CUE_FIRST_SAY_MS, 10_000 + CUE_FIRST_SAY_MS + CUE_REPEAT_MS, 10_000 + CUE_FIRST_SAY_MS + 2 * CUE_REPEAT_MS]);
});

test('cue timing: nothing without a line, and the clock resets so a new cue starts fresh', () => {
  assert.deepEqual(run(CUE_IDLE, undefined, 0, 200_000, 1000).said, []);
  const a = run(CUE_IDLE, LINE, 0, 3_000);
  assert.equal(a.said.length, 1);
  const off = cueTick(a.clock, undefined, 4_000, false);
  assert.equal(off.clock.line, null);
  assert.equal(off.clock.dueAt, Infinity);
  assert.equal(off.clock.lastSaidAt, a.said[0]);
  // Back on later: the first line comes after the short delay again, not a whole repeat interval.
  const b = run(off.clock, LINE, 50_000, 60_000);
  assert.deepEqual(b.said, [50_000 + CUE_FIRST_SAY_MS]);
});

test('cue timing: a busy receptionist delays the line instead of dropping it', () => {
  const busyUntil = CUE_FIRST_SAY_MS + 5_000;
  const { said } = run(CUE_IDLE, LINE, 0, 20_000, 100, (t) => t < busyUntil);
  assert.deepEqual(said, [busyUntil]);
});

test('cue timing: a new line (installed) is said soon, without waiting for the repeat', () => {
  const a = run(CUE_IDLE, LINE, 0, 10_000);
  assert.equal(a.said.length, 1);
  const b = run(a.clock, 'Reload to finish!', 10_100, 20_000);
  assert.deepEqual(b.said, [10_100 + CUE_FIRST_SAY_MS]);
});

test('cue timing: coming back into view brings the line forward unless she just spoke', () => {
  const a = run(CUE_IDLE, LINE, 0, 3_000);
  const spokeAt = a.said[0]!;
  // Shown again soon after she spoke: no change.
  assert.deepEqual(cueOnVisible(a.clock, spokeAt + CUE_VISIBLE_GAP_MS - 1), a.clock);
  // Later: due a beat after it is shown.
  const shownAt = spokeAt + CUE_VISIBLE_GAP_MS + 5_000;
  const v = cueOnVisible(a.clock, shownAt);
  assert.equal(v.dueAt, shownAt + CUE_VISIBLE_DELAY_MS);
  assert.deepEqual(run(v, LINE, shownAt, shownAt + 3_000).said, [shownAt + CUE_VISIBLE_DELAY_MS]);
  // No cue: nothing to bring forward.
  assert.deepEqual(cueOnVisible(CUE_IDLE, 1e9), CUE_IDLE);
  // Never later than it already was.
  const soon = { ...a.clock, dueAt: shownAt + 100 };
  assert.equal(cueOnVisible(soon, shownAt).dueAt, shownAt + 100);
});

test('clicks: the receptionist and the badge open the memo only while the cue is on; the counter keeps the Front desk', () => {
  const targets: CueTarget[] = ['badge', 'receptionist', 'counter', 'other'];
  for (const t of targets) {
    assert.equal(cueClick(true, t), t === 'badge' || t === 'receptionist' ? 'memo' : 'pass', t);
    assert.equal(cueClick(false, t), 'pass', t);
  }
});

test('inRect: left and top edges in, right and bottom out', () => {
  const r = { x: 10, y: 20, w: 5, h: 4 };
  assert.equal(inRect(10, 20, r), true);
  assert.equal(inRect(14.9, 23.9, r), true);
  assert.equal(inRect(15, 20, r), false);
  assert.equal(inRect(10, 24, r), false);
  assert.equal(inRect(9.9, 21, r), false);
});

const info = (status: UpdateStatus, extra: Partial<UpdateInfo> = {}): UpdateInfo => ({ status, current: '0.5.0', latest: '0.6.0', auto: true, ...extra });
const names = { company: 'Acme', branch: 'Riverside Branch' };

test('memo after an update: re-render while there is something to say, close when put off or done', () => {
  const after = (u: UpdateInfo | undefined): string => memoAfterUpdate(u, !!(u && updateMemo(u, names)));
  assert.equal(after(info('available')), 'render');
  assert.equal(after(info('available', { hidden: true })), 'close');
  assert.equal(after(info('downloading')), 'render');
  assert.equal(after(info('installed')), 'render');
  assert.equal(after(info('installed', { hidden: true })), 'render');
  assert.equal(after(info('error', { message: 'x' })), 'render');
  assert.equal(after(info('checking')), 'render');
  assert.equal(after(info('upToDate')), 'close');
  assert.equal(after(info('idle')), 'close');
  assert.equal(after(undefined), 'close');
  for (const s of UPDATE_STATUSES) assert.ok(['render', 'close'].includes(after(info(s))));
});

test('tooltips: the badge says what a click does; the receptionist keeps her title and points at the counter', () => {
  const a = badgeTooltip(false);
  assert.equal(a.title, 'Post from head office');
  assert.match(a.hint ?? '', /^Click to/);
  assert.notDeepEqual(badgeTooltip(true).lines, a.lines);
  const r = receptionistCueTooltip({ title: 'Sam — Receptionist', lines: ['Theme, names, colours and settings'], hint: 'Click to open the Front desk' });
  assert.equal(r.title, 'Sam — Receptionist');
  assert.match(r.hint ?? '', /memo/);
  assert.match(r.hint ?? '', /Front desk/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Theme colours, checked against every built-in preset

interface Sign { plate?: string; text?: string; branch?: string }
const PRESETS: { name: string; sign: Sign }[] = readdirSync(new URL('../media/themes/', import.meta.url))
  .filter((f) => f.endsWith('.theme.json'))
  .map((f) => {
    const t = JSON.parse(readFileSync(new URL(`../media/themes/${f}`, import.meta.url), 'utf8')) as { colors?: Record<string, string> };
    return { name: f, sign: { plate: t.colors?.['signPlate'], text: t.colors?.['signText'], branch: t.colors?.['signBranch'] } };
  });
const ALL_SIGNS: { name: string; sign: Sign }[] = [{ name: 'built-in', sign: { plate: DEFAULT_SIGN.plate, text: DEFAULT_SIGN.text } }, ...PRESETS];
/** The memo's paper in VS Code light and dark themes (`uiStyles.ts`). */
const PAPERS = ['#f7f1e1', '#ebe3cc'];

test('presets are there to check', () => {
  assert.ok(PRESETS.length >= 5, `found ${PRESETS.length}`);
});

test('badge colours: the envelope and the rim stand out from the plate on every preset', () => {
  for (const { name, sign } of ALL_SIGNS) {
    const c = postColours(sign.plate, sign.text);
    assert.ok(contrastRatio(ENVELOPE_PAPER, c.plate) >= GRAPHIC_MIN, `${name}: envelope on plate ${c.plate}`);
    assert.ok(contrastRatio(c.rim, c.plate) >= GRAPHIC_MIN, `${name}: rim ${c.rim} on plate ${c.plate}`);
    // Always one of the theme's own sign colours (or the built-in sign).
    assert.ok([sign.plate, sign.text, DEFAULT_SIGN.plate, DEFAULT_SIGN.text].map((x) => x?.toLowerCase()).includes(c.plate), `${name}: plate from the sign`);
  }
});

test('badge colours: the sign plate when it works, the lettering when the plate is too light, the built-in sign otherwise', () => {
  assert.deepEqual(postColours(DEFAULT_SIGN.plate, DEFAULT_SIGN.text), { plate: DEFAULT_SIGN.plate, rim: DEFAULT_SIGN.text });
  // A yellow plate with black lettering (the construction preset): the badge goes black with a yellow rim.
  assert.deepEqual(postColours('#f2c12e', '#141414'), { plate: '#141414', rim: '#f2c12e' });
  // Both too light for the envelope: the built-in navy sign.
  assert.deepEqual(postColours('#ffffff', '#fff8e0'), { plate: DEFAULT_SIGN.plate, rim: '#fff8e0' });
  // Nothing usable: the built-in sign.
  assert.deepEqual(postColours(undefined, 'nope'), { plate: DEFAULT_SIGN.plate, rim: DEFAULT_SIGN.text });
  // A plate the rim cannot stand out from falls back to the built-in cream.
  const c = postColours('#202020', '#262626');
  assert.equal(c.plate, '#202020');
  assert.ok(contrastRatio(c.rim, c.plate) >= GRAPHIC_MIN);
});

test('memo accent: the stamp ink reads as text (4.5:1) on the paper in light and dark VS Code themes, for every preset', () => {
  for (const { name, sign } of ALL_SIGNS) {
    for (const paper of PAPERS) {
      const a = memoAccent(sign, paper, false);
      assert.ok(a, name);
      assert.ok(contrastRatio(a.ink, paper) >= TEXT_MIN, `${name} on ${paper}: ink ${a.ink} = ${contrastRatio(a.ink, paper).toFixed(2)}`);
      assert.equal(a.band, (sign.plate ?? DEFAULT_SIGN.plate).toLowerCase(), `${name}: band is the sign plate`);
    }
  }
});

test('memo accent: keeps the theme hue (plate, or the colourful lettering when the plate is nearly grey)', () => {
  // Built-in: the navy plate itself (already dark enough).
  assert.deepEqual(memoAccent({ plate: DEFAULT_SIGN.plate, text: DEFAULT_SIGN.text }, PAPERS[0]!, false), { band: DEFAULT_SIGN.plate, stripe: DEFAULT_SIGN.plate, ink: DEFAULT_SIGN.plate });
  // Near-black plate with pink lettering and a cyan branch line: the lettering wins (it is the sign's main colour).
  const cyber = memoAccent({ plate: '#120c1e', text: '#ff5ad8', branch: '#3ff0ff' }, PAPERS[0]!, false)!;
  assert.equal(cyber.stripe, '#ff5ad8');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(cyber.ink.slice(i, i + 2), 16)) as [number, number, number];
  assert.ok(r > g && b > g, `pinkish ink ${cyber.ink}`);
  // Near-black plate with cream lettering and an orange branch: the branch is clearly more colourful.
  assert.equal(memoAccent({ plate: '#1a1816', text: '#f2e3c2', branch: '#e8913e' }, PAPERS[0]!, false)!.stripe, '#e8913e');
  // A light, colourful plate (yellow) stays the pick and is darkened until it reads.
  const yellow = memoAccent({ plate: '#f2c12e', text: '#141414' }, PAPERS[0]!, false)!;
  assert.equal(yellow.stripe, '#f2c12e');
  assert.notEqual(yellow.ink, '#f2c12e');
  assert.ok(contrastRatio(yellow.ink, PAPERS[0]!) >= TEXT_MIN);
});

test('memo accent: high contrast keeps the built-in look; bad input falls back', () => {
  assert.equal(memoAccent({ plate: '#f2c12e' }, '#000000', true), null);
  const a = memoAccent({ plate: 'red' }, 'var(--x)', false)!;
  assert.equal(a.band, DEFAULT_SIGN.plate);
  assert.ok(contrastRatio(a.ink, '#f7f1e1') >= TEXT_MIN);
  // A paper so dark nothing reaches 4.5:1 by darkening: the built-in memo ink.
  assert.equal(memoAccent({ plate: '#ff0000' }, '#333333', false)!.ink, DEFAULT_MEMO_INK);
});

test('inkOn and chroma', () => {
  assert.equal(inkOn('#23395b', '#f7f1e1', TEXT_MIN), '#23395b');
  const d = inkOn('#ffcc00', '#ffffff', TEXT_MIN)!;
  assert.ok(contrastRatio(d, '#ffffff') >= TEXT_MIN);
  assert.equal(inkOn('#ffffff', '#808080', 21), null);
  assert.equal(inkOn('nope', '#ffffff', 3), null);
  assert.equal(chroma('#808080'), 0);
  assert.equal(chroma('#ff0000'), 1);
});

test('peek: none while the badge is in view; pinned to the nearest edge, level with it, otherwise', () => {
  const region = { x: 0, y: 0, w: 340, h: 700 };
  const size = { w: 36, h: 36 };
  assert.equal(peekPlacement({ x: 10, y: 100, w: 26, h: 26 }, region, size), null);
  // Off to the left (the narrow sidebar's camera): left edge, same height.
  assert.deepEqual(peekPlacement({ x: -400, y: 100, w: 26, h: 26 }, region, size), { x: 6, y: 95, side: 'left' });
  // Partly out on the left counts as out.
  assert.equal(peekPlacement({ x: -5, y: 100, w: 26, h: 26 }, region, size)?.side, 'left');
  // Off to the right, and clamped into the region vertically.
  assert.deepEqual(peekPlacement({ x: 900, y: -300, w: 26, h: 26 }, region, size), { x: 298, y: 6, side: 'right' });
  // Above (zoomed in): top edge, level with it horizontally.
  assert.deepEqual(peekPlacement({ x: 100, y: -50, w: 26, h: 26 }, region, size), { x: 95, y: 6, side: 'top' });
  assert.deepEqual(peekPlacement({ x: 100, y: 900, w: 26, h: 26 }, region, size), { x: 95, y: 658, side: 'bottom' });
  // A strip's map column starts further in.
  assert.deepEqual(peekPlacement({ x: 10, y: 100, w: 26, h: 26 }, { x: 52, y: 0, w: 600, h: 300 }, size), { x: 58, y: 95, side: 'left' });
});
