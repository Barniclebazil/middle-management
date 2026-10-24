import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lines from '../webview/engine/lines.ts';
import { starterThemeObject } from '../src/shared/themeStarter.ts';

// lineCheck.ts pulls in overlay.ts and the art, which use DOM types the root tsconfig lacks: computed specifier (see engine-world.ts).
const CHECK_SPEC: string = new URL('../dev/lineCheck.ts', import.meta.url).href;
const { checkPools, toPool } = await import(CHECK_SPEC) as {
  checkPools: (pools: unknown[]) => { severity: string; pool: string; index: number; text: string; message: string }[];
  toPool: (name: string, value: unknown) => { name: string; kind: string; lines: string[]; pairs: [string, string][] } | null;
};

const pools = Object.entries(lines as Record<string, unknown>).flatMap(([name, v]) => {
  const p = toPool(name, v);
  return p ? [p] : [];
});

test('every line pool passes the checker with no errors (warnings are allowed)', () => {
  assert.ok(pools.length >= 11, `found ${pools.length} pools`);
  const errors = checkPools(pools).filter((f) => f.severity === 'error');
  assert.deepEqual(errors.map((f) => `${f.pool}[${f.index}] "${f.text}": ${f.message}`), []);
});

test('pools are at least the planned sizes', () => {
  const min: Record<string, number> = {
    SMALL_TALK: 800, BOSS_LINES: 40, BUMP_LINES: 12, MOVE_UP_LINES: 12, SULK_START_LINES: 8, SULK_LINES: 12, SULK_END_LINES: 8,
    RECEPTION_PHONE_LINES: 50, RECEPTION_GREETINGS: 20, RECEPTION_IDLE_LINES: 50, CHAT_REPLIES: 30,
    CLEANER_MUTTERS: 55, CART_CALLS: 34, BOSS_SNACK_LINES: 36,
    IT_VERDICTS: 14, IT_GIVE_UPS: 8, IT_SNEERS: 16, IT_COMEBACKS: 12, IT_DEZ_MUTTERS: 24, IT_FENWICK_MUTTERS: 24,
    IT_SMALL_TALK: 12, IT_FOOTBALL_TALK: 10, IT_SMALL_TALK_REPLIES: 16,
  };
  const size = new Map(pools.map((p) => [p.name, p.kind === 'pairs' ? p.pairs.length : p.lines.length]));
  for (const [name, n] of Object.entries(min)) assert.ok((size.get(name) ?? 0) >= n, `${name}: ${size.get(name)} < ${n}`);
});

test('the snooping boss says exactly the one line, and it fits a bubble without clashing with any pool', () => {
  assert.equal(lines.SNOOP_LINE, "Don't make mistakes.");
  const errors = checkPools([...pools, toPool('SNOOP_LINE', [lines.SNOOP_LINE])!]).filter((f) => f.severity === 'error');
  assert.deepEqual(errors.map((f) => `${f.pool}[${f.index}] "${f.text}": ${f.message}`), []);
});

test('the IT fix line fits a bubble, is plain ASCII and clashes with nothing', () => {
  assert.ok(/^[\x20-\x7e]+$/.test(lines.IT_FIX_LINE), 'IT_FIX_LINE is not plain ASCII');
  const errors = checkPools([...pools, toPool('IT_FIX_LINE', [lines.IT_FIX_LINE])!]).filter((f) => f.severity === 'error');
  assert.deepEqual(errors.map((f) => `${f.pool}[${f.index}] "${f.text}": ${f.message}`), []);
});

test("the user's signed-off IT lines are present word for word", () => {
  assert.equal(lines.IT_FIX_LINE, 'Have you tried turning it off and on again?');
  assert.ok(lines.IT_DEZ_MUTTERS.includes('People. What a bunch of bastards.'));
  assert.ok(lines.IT_FENWICK_MUTTERS.includes("Vista?! We're all going to die."));
  assert.deepEqual(lines.IT_FOOTBALL_TALK[0], ['Did you see that ludicrous display last night?', 'The thing with Arsenal is, they always try to walk it in.']);
});

test('no IT line contains "slop"', () => {
  const all: string[] = [lines.IT_FIX_LINE];
  for (const [name, v] of Object.entries(lines as Record<string, unknown>)) {
    if (name.startsWith('IT_') && Array.isArray(v)) all.push(...(v as (string | string[])[]).flat());
  }
  assert.ok(all.length > 100, `only ${all.length} IT lines found`);
  assert.deepEqual(all.filter((l) => /slop/i.test(l)), []);
});

test("the theme starter's lines are copies of the built-in pools", () => {
  const t = starterThemeObject() as { smallTalk: [string, string][]; manager: { lines: string[] } };
  const pairs = new Set(lines.SMALL_TALK.map(([a, b]) => `${a}\n${b}`));
  assert.ok(t.smallTalk.length > 0 && t.manager.lines.length > 0);
  for (const [a, b] of t.smallTalk) assert.ok(pairs.has(`${a}\n${b}`), `starter pair not in SMALL_TALK: ${a}`);
  for (const l of t.manager.lines) assert.ok(lines.BOSS_LINES.includes(l), `starter boss line not in BOSS_LINES: ${l}`);
});

test('the checker flags the same text used twice anywhere, across pools and roles; the real pools have none', () => {
  const made = [
    toPool('PAIRS', [['Hello there.', 'Hi.'], ['Lovely day.', 'Hello there!']])!,
    toPool('LINES', ['Hi', 'Something else.'])!,
    toPool('MORE', ['Lovely day'])!,
  ];
  const dup = checkPools(made).filter((f) => f.message.startsWith('duplicate'));
  // Reply "Hello there!" = opener "Hello there."; line "Hi" = reply "Hi."; line "Lovely day" = opener "Lovely day.".
  assert.deepEqual(dup.map((f) => `${f.pool}[${f.index}]`).sort(), ['LINES[0]', 'MORE[0]', 'PAIRS[1]']);
  assert.ok(dup.every((f) => f.severity === 'error'));
  assert.equal(checkPools([toPool('A', ['x y', 'X, Y!'])!]).filter((f) => f.message.startsWith('duplicate')).length, 1);
  assert.deepEqual(checkPools(pools).filter((f) => f.message.startsWith('duplicate')), []);
});
