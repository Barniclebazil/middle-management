import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../webview/engine/office.ts';
import { overlayUnits } from '../webview/engine/camera.ts';
import { collectBubbles, layoutBubbles } from '../webview/engine/bubbles.ts';
import type { Placed, Sized } from '../webview/engine/bubbles.ts';
import { rosterEntries } from '../webview/engine/tooltip.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

// overlay.ts and the art use DOM types the root tsconfig lacks: imported through computed specifiers (see engine-world.ts).
const OVERLAY_SPEC: string = new URL('../webview/engine/overlay.ts', import.meta.url).href;
const ART_SPEC: string = new URL('../webview/art/index.ts', import.meta.url).href;
const { DETAIL_BUBBLE_MAX_LINES, SPEECH_BUBBLE_MAX_LINES, TEXT_BUBBLE_MAX_W, wrapText } = await import(OVERLAY_SPEC) as {
  DETAIL_BUBBLE_MAX_LINES: number; SPEECH_BUBBLE_MAX_LINES: number; TEXT_BUBBLE_MAX_W: number;
  wrapText: (text: string, maxW: number, maxLines: number) => string[];
};
const { FONT_LINE_HEIGHT } = await import(ART_SPEC) as { FONT_LINE_HEIGHT: number };

const world = await loadWorld();

function run(o: Office, t0: number, ms: number): number {
  let t = t0;
  for (let e = 0; e < ms; e += 33) {
    t += 33;
    o.update(t, 33, HOST0 + t);
  }
  return t;
}

test('overlay UI scale: text never below 2 CSS px, icons follow the office', () => {
  // Bottom panel at 1x: text doubled, icons stay in proportion with the people.
  assert.deepEqual(overlayUnits(1, 1), { text: 2, icon: 1 });
  // Same panel on a HiDPI screen: the same CSS size, in device px.
  assert.deepEqual(overlayUnits(1, 2), { text: 4, icon: 2 });
  // A big office: everything follows the office scale.
  assert.deepEqual(overlayUnits(2.57, 1), { text: 3, icon: 3 });
  assert.deepEqual(overlayUnits(1.63, 2), { text: 4, icon: 3 });
  // Always whole device pixels, never zero.
  for (const [s, d] of [[0.4, 1], [0.52, 1.25], [1.1, 1.5], [3.3, 2]] as const) {
    const u = overlayUnits(s, d);
    assert.ok(Number.isInteger(u.text) && Number.isInteger(u.icon) && u.icon >= 1 && u.text >= 2, `${s}@${d}`);
  }
});

test('screen-space layout keeps scaled bubbles apart and inside an offset view', () => {
  const step = 3;
  const bounds = { x: 100, y: 50, w: 400, h: 300 };
  // Three people side by side near the left edge of the view.
  const boxes: Sized[] = [0, 1, 2].map((i) => ({
    key: `k${i}`, charId: `c${i}`, type: 'icon', icon: 'page', style: 'speech', ax: 104 + i * 12, ay: 250, side: 'above',
    fixed: false, priority: 1, w: 14 * step, h: 14 * step, tail: 3 * step,
  }));
  const placed = layoutBubbles(boxes, bounds, new Map(), step);
  for (const p of placed) {
    assert.ok(p.x >= bounds.x && p.x + p.w <= bounds.x + bounds.w, `${p.key} x inside`);
    assert.ok(p.y >= bounds.y && p.y + p.h <= bounds.y + bounds.h, `${p.key} y inside`);
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]!;
      const q = placed[j]!;
      const sep = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
      assert.ok(sep, `${p.key} overlaps ${q.key}`);
    }
  }
});

test('labels above sit on the anchor; bubbles over a label are lifted by its height', () => {
  const label: Sized = { key: 'l', charId: 'm', type: 'label', text: 'You', style: 'speech', ax: 200, ay: 100, side: 'above', fixed: true, priority: 100, w: 30, h: 16, tail: 0 };
  const say: Sized = {
    key: 's', charId: 'm', type: 'text', text: 'Hi', style: 'speech', ax: 200, ay: 100, side: 'above', fixed: false, priority: 90,
    w: 40, h: 20, tail: 6, overLabel: true, labelH: 18,
  };
  const placed = layoutBubbles([label, say], { w: 800, h: 600 }, new Map(), 2);
  const l = placed.find((p) => p.key === 'l')!;
  const s = placed.find((p) => p.key === 's')!;
  assert.equal(l.y + l.h, 100, 'label bottom on the anchor');
  assert.equal(s.y + s.h + s.tail, 100 - 18, 'bubble tail tip above the label');
  assert.equal(s.lift, 0, 'no stem needed');
});

test('highlighting someone gives them a name label; the roster lists staff with their temps', () => {
  const o = new Office(world, { seed: 3 });
  o.applySnapshot([
    agent('a', { title: 'Fix the build', startedAt: HOST0 - 90_000 }),
    agent('b', { title: 'Write docs', startedAt: HOST0 - 80_000, activity: 'needsYou', status: 'waiting' }),
    agent('t1', { kind: 'temp', parentId: 'a', title: 'Explore', startedAt: HOST0 - 10_000, activity: 'searching' }),
  ], 0, HOST0);
  run(o, 0, 500);
  const reqs = collectBubbles([...o.chars.values()], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss', highlightId: 'a' }, 500);
  const lab = reqs.find((r) => r.charId === 'a' && r.type === 'label');
  assert.ok(lab && lab.text === 'Fix the build' && lab.highlight, 'highlighted label');
  const own = reqs.find((r) => r.charId === 'a' && r.type !== 'label');
  if (own) assert.ok(own.overLabel, 'their bubble goes above the label');

  const rows = rosterEntries(o, HOST0 + 500);
  assert.deepEqual(rows.map((r) => r.id), ['a', 't1', 'b']);
  assert.equal(rows[1]!.parentId, 'a');
  assert.equal(rows[1]!.temp, true);
  assert.equal(rows[2]!.needsYou, true);
  assert.equal(rows[2]!.doing, 'Needs you');
  assert.equal(rows[0]!.needsYou, false);
});

test('with speech bubbles off the sulking manager still gets his storm cloud; a line he says replaces it', () => {
  const o = new Office(world, { seed: 3 });
  const m = o.manager;
  m.moodIcon = 'stormcloud';
  const chars = [...o.chars.values()];
  const quiet = collectBubbles(chars, m, o.queueIds, { speechBubbles: false, managerName: 'Boss' }, 500);
  assert.ok(quiet.some((r) => r.key === 'mgr:mood' && r.icon === 'stormcloud'), 'cloud collected with bubbles off');

  m.say = { text: 'Fine.', until: 1000 };
  const talking = collectBubbles(chars, m, o.queueIds, { speechBubbles: false, managerName: 'Boss' }, 500);
  assert.ok(talking.some((r) => r.key === 'mgr:say' && r.text === 'Fine.'), 'his line shows regardless of speech bubbles');
  assert.ok(!talking.some((r) => r.key === 'mgr:mood'), 'the line replaces the cloud while he talks');
});

test('bubbles keep clear of obstacles such as the "BACK" card, and are unchanged without them (task 4.2)', () => {
  const say: Sized = { key: 's', charId: 'a', type: 'text', text: 'Hi', style: 'speech', ax: 200, ay: 100, side: 'above', fixed: false, priority: 50, w: 40, h: 20, tail: 4 };
  const free = layoutBubbles([say], { w: 800, h: 600 }, new Map(), 1)[0]!;
  // A card right where the bubble would naturally go.
  const card = { x: free.x - 2, y: free.y - 2, w: free.w + 4, h: free.h + 4 };
  const moved = layoutBubbles([say], { w: 800, h: 600 }, new Map(), 1, [card])[0]!;
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(overlaps(free, card), 'the natural spot is under the card');
  assert.ok(!overlaps(moved, card), `moved clear of the card: ${JSON.stringify(moved)}`);
  assert.deepEqual(layoutBubbles([say], { w: 800, h: 600 }, new Map(), 1, [])[0], free);
});

test('speech bubbles wrap to 3 rows, detail bubbles stay at 2', () => {
  assert.equal(SPEECH_BUBBLE_MAX_LINES, 3);
  assert.equal(DETAIL_BUBBLE_MAX_LINES, 2);
  const sixty = 'I swear the printer jams whenever somebody walks past';
  const three = wrapText(sixty, TEXT_BUBBLE_MAX_W, SPEECH_BUBBLE_MAX_LINES);
  assert.equal(three.length, 3, `rows: ${JSON.stringify(three)}`);
  assert.ok(!three.some((l) => l.endsWith('..')), 'not cut');
  assert.equal(three.join(' '), sixty);
  // Longer than three rows: cut with "..".
  const long = 'the quarterly all hands meeting has been moved to the other room again because the projector keeps overheating and nobody can fix it';
  const cut = wrapText(long, TEXT_BUBBLE_MAX_W, SPEECH_BUBBLE_MAX_LINES);
  assert.equal(cut.length, 3);
  assert.ok(cut[2]!.endsWith('..'), 'cut with ..');
  // Detail text is still cut at two rows.
  const detail = wrapText(sixty, TEXT_BUBBLE_MAX_W, DETAIL_BUBBLE_MAX_LINES);
  assert.equal(detail.length, 2);
  assert.ok(detail[1]!.endsWith('..'));
});

test('only activity details are flagged as detail bubbles; spoken lines are not', () => {
  const o = new Office(world, { seed: 5 });
  o.applySnapshot([agent('a')], 0, HOST0);
  const c = [...o.chars.values()].find((x) => x.agent);
  assert.ok(c, 'a worker with an agent');
  c.say = null;
  c.detailText = 'src/some/long/path/file.ts';
  c.detailUntil = 1000;
  const det = collectBubbles([c], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss' }, 500).find((r) => r.key === `${c.id}:detail`);
  assert.ok(det?.detail, 'detail bubble flagged');
  c.say = { text: 'Did you see that?', until: 1000 };
  const said = collectBubbles([c], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss' }, 500).find((r) => r.key === `${c.id}:say`);
  assert.ok(said && !said.detail, 'say bubble is speech');
  o.manager.say = { text: 'Fine.', until: 1000 };
  const mgr = collectBubbles([], o.manager, o.queueIds, { speechBubbles: true, managerName: 'Boss' }, 500).find((r) => r.key === 'mgr:say');
  assert.ok(mgr && !mgr.detail, 'manager line is speech');
});

test('a 3-row bubble keeps its real height in the layout, clear of others and inside the top edge', () => {
  const step = 3;
  const h = (3 * FONT_LINE_HEIGHT - 1 + 5) * step;
  const mk = (key: string, ax: number): Sized => ({
    key, charId: key, type: 'text', text: 'x', style: 'speech', ax, ay: 200, side: 'above', fixed: false, priority: 1, w: 90 * step, h, tail: 3 * step,
  });
  const bounds = { x: 0, y: 0, w: 800, h: 400 };
  const placed = layoutBubbles([mk('a', 300), mk('b', 330)], bounds, new Map(), step);
  for (const p of placed) {
    assert.equal(p.h, h, 'height is carried through');
    assert.ok(p.y >= bounds.y + step, `${p.key} clamped inside the top edge`);
  }
  // Near the top edge the tall bubble is clamped on screen.
  const top = layoutBubbles([{ ...mk('t', 300), ay: 20 }], bounds, new Map(), step)[0]!;
  assert.ok(top.y >= bounds.y + step, 'clamped inside the top edge');
  const [p, q] = placed as [typeof placed[0], typeof placed[0]];
  assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, 'no overlap');
});

test('bubbles near the top wall slide sideways instead of overlapping, never sinking onto the head', () => {
  for (const step of [1, 2, 3]) {
    const h3 = (3 * FONT_LINE_HEIGHT - 1 + 5) * step;
    const h2 = (2 * FONT_LINE_HEIGHT - 1 + 5) * step;
    const mk = (key: string, ax: number, ay: number, priority: number, h = h3): Sized => ({
      key, charId: key, type: 'text', text: 'x', style: 'speech', ax: ax * step, ay: ay * step, side: 'above', fixed: false, priority, w: 90 * step, h, tail: 3 * step,
    });
    const bounds = { x: 0, y: 0, w: 400 * step, h: 272 * step };
    const clear = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
      a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    const check = (label: string, items: Sized[]): void => {
      const placed = layoutBubbles(items, bounds, new Map(), step);
      assert.equal(placed.length, items.length);
      for (const p of placed) {
        assert.ok(p.x >= step && p.x + p.w <= bounds.w - step && p.y >= step, `${label} step ${step}: ${p.key} inside`);
        assert.ok(p.y + p.h <= p.ay, `${label} step ${step}: ${p.key} not sunk over its person's head`);
        assert.ok(Math.abs(p.x + p.w / 2 - p.ax) <= p.w, `${label} step ${step}: ${p.key} stays near its person`);
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) assert.ok(clear(placed[i]!, placed[j]!), `${label} step ${step}: ${placed[i]!.key} / ${placed[j]!.key} overlap`);
      }
    };
    // Two tall speech bubbles over people ~50 px apart, right under the top wall.
    // Real bubbles are much wider than the gap between neighbours: the slide goes well past the speaker's own width.
    check('wide pair', [{ ...mk('a', 150, 30, 2), w: 150 * step }, { ...mk('b', 190, 30, 1), w: 150 * step }]);
    check('two close', [mk('a', 200, 30, 2), mk('b', 250, 30, 1)]);
    check('two close, reversed', [mk('a', 250, 30, 2), mk('b', 200, 30, 1)]);
    // A tall speech bubble beside a neighbour's 2-row detail bubble (a person never has both), near the top.
    check('speech and detail', [mk('say', 200, 30, 2), mk('det', 250, 30, 1, h2)]);
    check('detail and speech', [mk('say', 200, 30, 1), mk('det', 250, 30, 2, h2)]);
    check('speech right of detail', [mk('say', 250, 30, 1), mk('det', 200, 30, 2, h2)]);
  }
});

test('a bubble that fits above stays put, and a slid bubble keeps its place between frames', () => {
  const step = 1;
  const h3 = 3 * FONT_LINE_HEIGHT - 1 + 5;
  const mk = (key: string, ax: number, priority: number): Sized => ({
    key, charId: key, type: 'text', text: 'x', style: 'speech', ax, ay: 30, side: 'above', fixed: false, priority, w: 90, h: h3, tail: 3,
  });
  const bounds = { w: 400, h: 272 };
  const prev = new Map<string, { dx: number; dy: number }>();
  const first = layoutBubbles([mk('a', 200, 2), mk('b', 250, 1)], bounds, prev, step);
  const again = layoutBubbles([mk('a', 200, 2), mk('b', 250, 1)], bounds, prev, step);
  assert.deepEqual(again, first, 'same inputs, same layout');
  const lone = layoutBubbles([mk('a', 200, 2)], bounds, new Map(), step)[0]!;
  assert.equal(first.find((p) => p.key === 'a')!.x, lone.x, 'higher priority keeps its spot');
  assert.equal(first.find((p) => p.key === 'a')!.y, lone.y, 'higher priority keeps its spot');
});

test('in a view too narrow to slide, a lower bubble sinks just clear of the one above rather than overlapping it', () => {
  for (const step of [1, 2]) {
    const h = (3 * FONT_LINE_HEIGHT - 1 + 5) * step;
    const mk = (key: string, ax: number, ay: number, priority: number): Sized => ({
      key, charId: key, type: 'text', text: 'x', style: 'speech', ax: ax * step, ay: ay * step, side: 'above', fixed: false, priority, w: 260 * step, h, tail: 3 * step,
    });
    // The upper speaker's bubble wins; the lower one's natural spot overlaps its last row.
    const [a, b] = layoutBubbles([mk('a', 150, 120, 2), mk('b', 200, 132, 1)], { w: 400 * step, h: 272 * step }, new Map(), step)
      .sort((p, q) => p.ay - q.ay) as [Placed, Placed];
    assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x, `step ${step}: no overlap`);
    assert.ok(b.y + b.h - b.ay <= 24 * step, `step ${step}: sinks only a little`);
  }
});

test('the IT pair\'s lines become bubbles keyed by id, and follow the speech-bubble setting', () => {
  const o = new Office(world, { seed: 3 });
  o.dez.say = { text: 'Have you tried it?', until: 1000 };
  o.fenwick.say = { text: 'Hmph.', until: 1000 };
  const pair = [o.dez, o.fenwick];
  const on = collectBubbles([], o.manager, [], { speechBubbles: true, managerName: 'Boss' }, 500, undefined, undefined, undefined, pair);
  for (const c of pair) assert.ok(on.some((r) => r.key === `${c.id}:say` && r.charId === c.id && r.text === c.say!.text && r.priority === 72), `${c.id} bubble`);
  const off = collectBubbles([], o.manager, [], { speechBubbles: false, managerName: 'Boss' }, 500, undefined, undefined, undefined, pair);
  assert.ok(!off.some((r) => r.key.endsWith(':say') && r.charId !== o.manager.id), 'none with bubbles off');
  const late = collectBubbles([], o.manager, [], { speechBubbles: true, managerName: 'Boss' }, 1500, undefined, undefined, undefined, pair);
  assert.ok(!late.some((r) => r.charId === o.dez.id), 'expired line is dropped');
  const none = collectBubbles([], o.manager, [], { speechBubbles: true, managerName: 'Boss' }, 500);
  assert.ok(!none.some((r) => r.charId === o.dez.id), 'not passed in: no bubble');
});
