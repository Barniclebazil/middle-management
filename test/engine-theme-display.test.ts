import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../webview/engine/office.ts';
import { normalizeAgent } from '../webview/engine/targets.ts';
import { agentTooltip, rosterEntries } from '../webview/engine/tooltip.ts';
import { collectBubbles } from '../webview/engine/bubbles.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import { BOSS_LINES, CHAT_REPLIES, SMALL_TALK } from '../webview/engine/lines.ts';
import { themeState } from '../webview/engine/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();

function run(o: Office, t0: number, ms: number): number {
  let t = t0;
  for (let e = 0; e < ms; e += 33) {
    t += 33;
    o.update(t, 33, HOST0 + t);
  }
  return t;
}

const THEME: OfficeTheme = {
  staff: [{ name: 'Ann', role: 'Head of Sales', lines: ['LINE-ANN'] }, { name: 'Bo' }],
  temps: [{ name: 'Tess' }],
};
const state = themeState(THEME, world.staffSlots, world.tempSlots);

test('a named slot leads its tooltip with "Name — Role" and keeps the session title as its own line', () => {
  const v = normalizeAgent(agent('a', { title: 'Fix the login bug', project: 'web-app', gitBranch: 'main' }), HOST0)!;
  const tip = agentTooltip(v, 'Head of Sales', null, HOST0, false, 0, 'Ann');
  assert.equal(tip.title, 'Ann — Head of Sales');
  assert.deepEqual(tip.lines.slice(0, 2), ['Fix the login bug', 'web-app · ⎇ main']);
  assert.ok(!tip.lines.includes('Head of Sales'), 'the role is in the title, not repeated');
  assert.equal(tip.hint, 'Click to open their case file');
});

test('without a name the tooltip is exactly as before', () => {
  const v = normalizeAgent(agent('a', { title: 'Fix the login bug', project: 'web-app', gitBranch: 'main' }), HOST0)!;
  for (const tip of [agentTooltip(v, 'Staff', null, HOST0, false), agentTooltip(v, 'Staff', null, HOST0, false, 0, undefined), agentTooltip(v, 'Staff', null, HOST0, false, 0, '  ')]) {
    assert.equal(tip.title, 'Fix the login bug');
    assert.deepEqual(tip.lines.slice(0, 2), ['web-app · ⎇ main', 'Staff']);
  }
});

test('roster entries and hover labels use the themed name; unthemed slots keep the session title', () => {
  const o = new Office(world, { seed: 3 });
  o.setTheme(state);
  o.applySnapshot([agent('a', { startedAt: 1, title: 'Task A' }), agent('b', { startedAt: 2, title: 'Task B' }), agent('c', { startedAt: 3, title: 'Task C' })], 0, HOST0);
  const rows = new Map(rosterEntries(o, HOST0).map((r) => [r.id, r]));
  assert.equal(rows.get('a')!.name, 'Ann');
  assert.equal(rows.get('a')!.role, 'Head of Sales');
  assert.equal(rows.get('b')!.name, 'Bo');
  assert.equal(rows.get('b')!.role, '', 'no themed role: the roster falls back to the look role');
  assert.equal(rows.get('c')!.name, '');
  assert.equal(rows.get('a')!.title, 'Task A', 'the session title is still there');
  const chars = [...o.chars.values()];
  const labels = collectBubbles(chars, o.manager, [], { speechBubbles: true, managerName: 'You', highlightId: 'a', theme: state }, 0).filter((r) => r.type === 'label');
  assert.equal(labels.find((l) => l.charId === 'a')!.text, 'Ann');
  const plain = collectBubbles(chars, o.manager, [], { speechBubbles: true, managerName: 'You', highlightId: 'a' }, 0).filter((r) => r.type === 'label');
  assert.equal(plain.find((l) => l.charId === 'a')!.text, 'Task A');
  const c = collectBubbles(chars, o.manager, [], { speechBubbles: true, managerName: 'You', highlightId: 'c', theme: state }, 0).filter((r) => r.type === 'label');
  assert.equal(c.find((l) => l.charId === 'c')!.text, 'Task C');
});

test('pins decide which slot a new agent sits in', () => {
  const o = new Office(world, { seed: 3 });
  o.setTheme(themeState({ staff: [{ name: 'Ann', pin: { project: 'reports' } }, { name: 'Bo' }] }, world.staffSlots, world.tempSlots));
  o.applySnapshot([agent('a', { startedAt: 1, project: 'web' }), agent('b', { startedAt: 2, project: 'reports' })], 0, HOST0);
  assert.equal(o.chars.get('b')!.look, 'staff-0');
  assert.equal(o.chars.get('a')!.look, 'staff-1');
});

function sayings(o: Office, ms: number, pick: (o: Office) => (string | undefined)[]): Set<string> {
  const seen = new Set<string>();
  let now = 0;
  for (let i = 0; i < ms / 33; i++) {
    now = run(o, now, 33);
    for (const s of pick(o)) if (s) seen.add(s);
  }
  return seen;
}

test('the manager says the themed boss lines, or the built-in ones without a theme', () => {
  const cases: [string[] | undefined, readonly string[]][] = [[['ONLY-BOSS-LINE'], ['ONLY-BOSS-LINE']], [undefined, BOSS_LINES]];
  for (const [lines, pool] of cases) {
    const o = new Office(world, { seed: 7 });
    o.setTheme(lines ? themeState({ lineMode: 'replace', manager: { lines } }, world.staffSlots, world.tempSlots) : undefined);
    o.applySnapshot([agent('a', { lastPromptAt: HOST0 - 50_000 })], 0, HOST0);
    run(o, 0, 500);
    o.applySnapshot([agent('a', { lastPromptAt: HOST0 + 900 })], 500, HOST0 + 500);
    const said = sayings(o, 30_000, (x) => [x.manager.say?.text]);
    assert.ok(said.size > 0, 'the manager said something');
    for (const s of said) assert.ok(pool.includes(s), `unexpected boss line ${s}`);
  }
});

test('water cooler: themed pairs are mixed in with the built-in ones, and a person with own lines opens with one first', () => {
  const o = new Office(world, { seed: 6, itCrew: false });
  const themed = Array.from({ length: 100 }, (_, i) => [`PAIR-OPENER-${i}`, `PAIR-REPLY-${i}`] as [string, string]);
  o.setTheme(themeState({ ...THEME, smallTalk: themed }, world.staffSlots, world.tempSlots));
  const idle = (id: string, n: number) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });
  o.applySnapshot([idle('a', 1), idle('b', 2)], 0, HOST0);
  const said = sayings(o, 40 * 60_000, (x) => [x.chars.get('a')?.say?.text, x.chars.get('b')?.say?.text]);
  assert.ok(said.has('LINE-ANN'), "Ann's own line opens a chat");
  const pool = new Set([...SMALL_TALK, ...themed].flat());
  assert.ok([...said].some((s) => s.startsWith('PAIR-')), 'themed pairs are said');
  assert.ok([...said].some((s) => SMALL_TALK.flat().includes(s)), 'built-in pairs are still said');
  for (const s of said) assert.ok(pool.has(s) || s === 'LINE-ANN' || CHAT_REPLIES.includes(s), `unexpected line ${s}`);
});

test('water cooler without a theme uses the built-in small talk', () => {
  const o = new Office(world, { seed: 6 });
  const idle = (id: string, n: number) => agent(id, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });
  o.applySnapshot([idle('a', 1), idle('b', 2)], 0, HOST0);
  const said = sayings(o, 60_000, (x) => [x.chars.get('a')?.say?.text, x.chars.get('b')?.say?.text]);
  const all = new Set(SMALL_TALK.flat());
  assert.ok(said.size > 0);
  for (const s of said) assert.ok(all.has(s), `unexpected line ${s}`);
});

test('the temp title shows on the roster for temps without a role of their own; the receptionist title labels her', () => {
  const t = themeState({ titles: { temp: 'Casual Hand', receptionist: 'Gatekeeper' }, temps: [{ name: 'Tess' }] }, world.staffSlots, world.tempSlots);
  const o = new Office(world, { seed: 3 });
  o.setTheme(t);
  o.applySnapshot([agent('a', { startedAt: 1 }), agent('t', { startedAt: 2, kind: 'temp', parentId: 'a' })], 0, HOST0);
  const rows = new Map(rosterEntries(o, HOST0).map((r) => [r.id, r]));
  assert.equal(rows.get('t')!.role, 'Casual Hand');
  assert.equal(rows.get('a')!.role, '', 'staff keep the look role');
  o.setTheme(themeState({ temps: [{ name: 'Tess' }] }, world.staffSlots, world.tempSlots));
  assert.equal(new Map(rosterEntries(o, HOST0).map((r) => [r.id, r])).get('t')!.role, '', 'no title: the look role');
  const label = (theme: typeof t | undefined): string | undefined =>
    collectBubbles([...o.chars.values()], o.manager, [], { speechBubbles: true, managerName: 'You', highlightId: o.receptionist.id, theme }, 0, o.receptionist)
      .find((r) => r.key === 'rec:label')?.text;
  assert.equal(label(t), 'Gatekeeper');
  assert.equal(label(themeState({ titles: { receptionist: 'Gatekeeper' }, receptionist: { name: 'Mara Quill' } }, world.staffSlots, world.tempSlots)), 'Mara Quill', 'a name beats the title');
  assert.equal(label(undefined), 'Receptionist');
});
