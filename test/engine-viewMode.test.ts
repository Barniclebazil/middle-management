import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_CLICKABLE_PROPS, VIEW_EMPTY_NOTE, VIEW_EMPTY_NOTE_LINES, VIEW_KNOCK_ELSEWHERE, VIEW_KNOCK_OFFICE, VIEW_PANELS, VIEW_TIP, VIEW_TIP_WITH_POST,
  VIEW_TIP_DONE_KEY, VIEW_TOOLTIP_PROPS, bootMode, viewAgentTooltip, viewTipText, viewHotspots, viewManagerTooltip, viewPropTooltip, viewSceneExtras,
} from '../webview/engine/viewModeLogic.ts';
import { PROP_IDS, buildHotspots, propTooltip } from '../webview/engine/hotspots.ts';
import type { PropAnchors } from '../webview/engine/hotspots.ts';
import { agentTooltip, managerTooltip, receptionistTooltip } from '../webview/engine/tooltip.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import type { AgentSnapshot } from '../src/shared/protocol.ts';
import type { ExtrasData } from '../webview/engine/panelsWiring.ts';
import { readFileSync } from 'node:fs';
import { HOST0, agent } from './engine-world.ts';

const view = (over: Partial<AgentSnapshot> = {}) => normalizeAgent(agent('a', over), HOST0)!;
const AB = new Set(['A', 'B'] as const);
const rect = { x: 10, y: 10, w: 8, h: 8 };
const anchors: PropAnchors = Object.fromEntries(PROP_IDS.map((id, i) => [id, { ...rect, x: i * 20 }]));
const joined = (t: { title: string; lines: string[]; hint?: string }) => [t.title, ...t.lines, t.hint ?? ''].join('\n');

test('boot mode reads the body dataset', () => {
  assert.equal(bootMode({ officeMode: 'view' }), 'view');
  assert.equal(bootMode({ officeMode: 'manager' }), 'manager');
  assert.equal(bootMode({}), 'manager');
  assert.equal(bootMode(undefined), 'manager');
  assert.equal(bootMode({ officeMode: 'VIEW' }), 'manager');
  assert.equal(bootMode({ officeMode: 'junk' }), 'manager');
});

test('view mode registers only the Front desk', () => {
  assert.deepEqual([...VIEW_PANELS], ['frontdesk']);
  assert.deepEqual([...VIEW_CLICKABLE_PROPS], ['frontDesk']);
  assert.deepEqual([...VIEW_TOOLTIP_PROPS].sort(), ['calendar', 'clock', 'frontDesk']);
});

test('hotspot filter keeps the front desk, clock and calendar; only the front desk has an action', () => {
  const all = buildHotspots(anchors, AB);
  assert.equal(all.length, 11);
  const kept = viewHotspots(all);
  assert.deepEqual(kept.map((h) => h.id), ['clock', 'calendar', 'frontDesk']);
  assert.deepEqual(kept.map((h) => h.action), [false, false, true]);
  assert.deepEqual(kept[2]!.rect, all.find((h) => h.id === 'frontDesk')!.rect);
  assert.deepEqual(viewHotspots([]), []);
});

test('agent tooltip keeps the facts and drops every click hint', () => {
  const a = view({ model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 124_000, max: 200_000, pct: 62 }, gitBranch: 'main' });
  const normal = agentTooltip(a, 'Developer', null, HOST0, false);
  assert.ok(normal.hint);
  const tip = viewAgentTooltip(a, 'Developer', null, HOST0, false);
  assert.equal(tip.hint, undefined);
  assert.deepEqual(tip.lines, normal.lines);
  assert.equal(tip.title, normal.title);
  assert.ok(tip.lines.includes('context 62% (124k / 200k)'));
  assert.deepEqual(tip.badge, { tier: 'opus', label: 'Opus 5.5', effort: 'xhigh' }, 'the badge shows in view mode too');
  assert.ok(!joined(tip).includes('Click to'));
});

test('named agent and leaving agent keep their words', () => {
  const a = view({});
  const named = viewAgentTooltip(a, 'Developer', null, HOST0, false, 0, 'Sam');
  assert.equal(named.title, 'Sam — Developer');
  assert.deepEqual(named.lines, agentTooltip(a, 'Developer', null, HOST0, false, 0, 'Sam').lines);
  const gone = viewAgentTooltip(a, 'Developer', null, HOST0, true);
  assert.ok(gone.lines.some((l) => l.startsWith('Gone for the day')));
  assert.equal(gone.hint, undefined);
});

test('knocking line: office-run agents say to switch mode, others say to use their window', () => {
  const office = view({ pending: { requestId: 'r', kind: 'permission' }, control: 'office' });
  const t1 = viewAgentTooltip(office, 'Developer', null, HOST0, false);
  assert.ok(t1.lines.includes(VIEW_KNOCK_OFFICE));
  assert.equal(VIEW_KNOCK_OFFICE, 'Switch to manager mode to answer');
  assert.ok(!joined(t1).includes('Knocking'));
  for (const control of ['elsewhere', undefined] as const) {
    for (const kind of ['permission', 'question', 'plan'] as const) {
      const t = viewAgentTooltip(view({ pending: { requestId: 'r', kind }, ...(control ? { control } : {}) }), 'Developer', null, HOST0, false);
      assert.ok(t.lines.includes(VIEW_KNOCK_ELSEWHERE), `${control} ${kind}`);
      assert.ok(!joined(t).includes('Knocking'));
    }
  }
  assert.equal(VIEW_KNOCK_ELSEWHERE, 'Waiting for you in their Claude Code window');
});

test('the read-only "open in another window" line goes', () => {
  const a = view({ control: 'elsewhere' });
  assert.ok(agentTooltip(a, 'Developer', null, HOST0, false).lines.includes('Open in another window (read-only here)'));
  const t = viewAgentTooltip(a, 'Developer', null, HOST0, false);
  assert.ok(!joined(t).includes('another window'));
});

test('a detail line stays when nothing is knocking', () => {
  const t = viewAgentTooltip(view({ detail: 'Editing app.ts' }), 'Developer', null, HOST0, false);
  assert.ok(t.lines.includes('Editing app.ts'));
});

test('manager tooltip loses its hint', () => {
  const m = managerTooltip('Pat');
  assert.ok(m.hint);
  const t = viewManagerTooltip(m);
  assert.equal(t.hint, undefined);
  assert.equal(t.title, m.title);
  assert.deepEqual(t.lines, m.lines);
});

test('prop tooltips: usage props read only, front desk keeps its hint, the rest show nothing', () => {
  for (const id of PROP_IDS) {
    const base = propTooltip(id);
    const t = viewPropTooltip(id, base);
    if (id === 'clock' || id === 'calendar') {
      assert.ok(t, id);
      assert.equal(t!.hint, undefined);
      assert.deepEqual(t!.lines, base.lines);
      assert.ok(!joined(t!).includes('Click to'));
    } else if (id === 'frontDesk') assert.equal(t!.hint, 'Click to open the Front desk');
    else assert.equal(t, null, id);
  }
  assert.equal(receptionistTooltip('Jo').hint, 'Click to open the Front desk');
});

test('scene extras keep only the usage ring and the week fill', () => {
  const full: ExtrasData & { phoneLights: ['connected']; cabinetHover: boolean; hoverProp: string } = {
    usage: { pct: 42, level: 'ok', back: '17:30' },
    week: { pct: 10, level: 'ok' },
    inTray: { count: 3, urgent: true },
    piles: { a: { sheets: 2, warn: false } },
    planNotes: { pending: 1, approved: 0, rejected: 0 },
    phoneLights: ['connected'],
    shelfCount: 5,
    cabinetHover: true,
    hoverProp: 'frontDesk',
  };
  const out = viewSceneExtras(full);
  assert.deepEqual(Object.keys(out).sort(), ['usage', 'week']);
  assert.deepEqual(out.usage, { pct: 42, level: 'ok' });
  assert.deepEqual(out.week, { pct: 10, level: 'ok' });
  assert.deepEqual(viewSceneExtras({}), {});
  assert.deepEqual(viewSceneExtras({}), {});
  assert.equal(full.usage!.back, '17:30', 'input is not changed');
});

test('texts', () => {
  assert.equal(VIEW_TIP, "Just watching. Hover a worker to see what they're doing. Click the receptionist to change how the office looks.");
  assert.equal(viewTipText(false), VIEW_TIP);
  assert.equal(viewTipText(true), VIEW_TIP_WITH_POST);
  assert.ok(VIEW_TIP_WITH_POST.includes('post from head office') && !VIEW_TIP_WITH_POST.includes('receptionist to change'), 'while post waits, the receptionist is not said to open the Front desk');
  assert.ok(VIEW_EMPTY_NOTE.startsWith("No Claude Code sessions yet. Start one and they'll walk in."));
  assert.ok(VIEW_EMPTY_NOTE.includes("'Middle Management: Toggle Demo'"));
  assert.ok(VIEW_EMPTY_NOTE_LINES.join(' ').replace(/\s+/g, ' ').includes('Toggle Demo'));
  assert.ok(!VIEW_EMPTY_NOTE_LINES.join(' ').includes('New task'));
  assert.notEqual(VIEW_TIP_DONE_KEY, 'tipDone');
});

test('the empty note repeats the demo hint of the manager note (overlay.ts cannot load here, so the source is read)', () => {
  const src = readFileSync(new URL('../webview/engine/overlay.ts', import.meta.url), 'utf8');
  for (const line of VIEW_EMPTY_NOTE_LINES.slice(3)) assert.ok(src.includes(line), line);
});
