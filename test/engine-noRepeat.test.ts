import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Office } from '../webview/engine/office.ts';
import { themeState } from '../webview/engine/theme.ts';
import { IDLE_WANDER_AFTER_MS } from '../webview/engine/targets.ts';
import {
  BOSS_SNACK_LINES, CART_CALLS, CHAT_REPLIES, CLEANER_MUTTERS, IT_COMEBACKS, IT_DEZ_MUTTERS, IT_FENWICK_MUTTERS, IT_FIX_LINE, IT_FOOTBALL_TALK,
  IT_GIVE_UPS, IT_SMALL_TALK, IT_SMALL_TALK_REPLIES, IT_SNEERS, IT_VERDICTS, RECEPTION_IDLE_LINES, RECEPTION_PHONE_LINES, SMALL_TALK,
} from '../webview/engine/lines.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';
import { HOST0, agent, loadWorld } from './engine-world.ts';

const world = await loadWorld();

// Two simulated hours per run at the real 33 ms frame step. The whole file runs in a few seconds, so no coarser step is needed.
const STEP = 33;
const TWO_HOURS = 2 * 3_600_000;
const SEEDS = [1, 2, 3];

const PRESET = JSON.parse(readFileSync(new URL('../media/themes/steampunk.theme.json', import.meta.url), 'utf8')) as OfficeTheme & {
  smallTalk?: [string, string][]; receptionist?: { lines?: string[] }; staff?: { lines?: string[] }[];
};

interface Counts { chats: number; exchanges: number; own: number; phone: number; idle: number; replies: number; other: string[] }

function simulate(agents: number, seed: number, theme: OfficeTheme | undefined, stepMs = STEP): { c: Counts; lines: Map<string, string[]> } {
  const o = new Office(world, { seed });
  const st = theme ? themeState(theme, world.staffSlots, world.tempSlots) : undefined;
  o.setTheme(st);
  const idle = (n: number) => agent(`a${n}`, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });
  o.applySnapshot(Array.from({ length: agents }, (_, i) => idle(i + 1)), 0, HOST0);

  const ownText = new Set((theme as typeof PRESET | undefined)?.staff?.flatMap((s) => s.lines ?? []) ?? []);
  const pairs: (readonly [string, string])[] = [...SMALL_TALK, ...((theme as typeof PRESET | undefined)?.smallTalk ?? [])];
  const openers = new Set(pairs.map((p) => p[0]));
  const pairReplies = new Set(pairs.map((p) => p[1]));
  const replies = new Set<string>(CHAT_REPLIES);
  // The IT pair's own pools (Dez fixes and chats, Fenwick sneers and talks football), and the answers they draw from others.
  const dezLines = new Set<string>([...IT_VERDICTS, ...IT_GIVE_UPS, ...IT_DEZ_MUTTERS, ...IT_SMALL_TALK.flat()]);
  const fenLines = new Set<string>([...IT_SNEERS, ...IT_FENWICK_MUTTERS, ...IT_FOOTBALL_TALK.flat()]);
  const itReplies = new Set<string>(IT_SMALL_TALK_REPLIES);
  const itComebacks = new Set<string>(IT_COMEBACKS);
  const recLines = new Set<string>([...RECEPTION_PHONE_LINES, ...RECEPTION_IDLE_LINES, ...((theme as typeof PRESET | undefined)?.receptionist?.lines ?? [])]);

  // Every distinct say object, by class of line.
  const said = new Map<string, string[]>([['opener', []], ['pairReply', []], ['own', []], ['reply', []], ['phone', []], ['idle', []], ['cleaner', []], ['vendor', []], ['snack', []], ['dez', []], ['fenwick', []], ['fix', []], ['itReply', []], ['comeback', []]]);
  const c: Counts = { chats: 0, exchanges: 0, own: 0, phone: 0, idle: 0, replies: 0, other: [] };
  const prev = new Map<string, unknown>();
  let wasChatting = false;
  let expectReply = false;
  for (let t = 0; t < TWO_HOURS; ) {
    t += stepMs;
    o.update(t, stepMs, HOST0 + t);
    const chatting = o.chatIds().length > 0;
    if (chatting && !wasChatting) { c.chats++; expectReply = false; }
    wasChatting = chatting;
    for (const ch of o.allChars()) {
      const s = ch.say;
      if (!s || prev.get(ch.id) === s) continue;
      prev.set(ch.id, s);
      const text = s.text;
      // What the IT pair draw out of others (an agent, the boss or the receptionist): told apart by text, which is unique across pools.
      const itAnswer = (): boolean => {
        if (itReplies.has(text)) said.get('itReply')!.push(text);
        else if (itComebacks.has(text)) said.get('comeback')!.push(text);
        else return false;
        return true;
      };
      if (ch.id === o.dez.id) {
        // Dez says the same fix line on every fix; the rest come from his decks.
        if (text === IT_FIX_LINE) said.get('fix')!.push(text);
        else if (dezLines.has(text)) said.get('dez')!.push(text);
        else c.other.push(text);
      } else if (ch.id === o.fenwick.id) {
        if (fenLines.has(text)) said.get('fenwick')!.push(text);
        else c.other.push(text);
      } else if (ch.id === o.cleaner.id) {
        // The cleaner mutters on their rounds, from their own deck.
        if (CLEANER_MUTTERS.includes(text)) said.get('cleaner')!.push(text);
        else c.other.push(text);
      } else if (ch.id === o.vendor.id) {
        // The vendor calls out while the cart is parked, from their own deck.
        if (CART_CALLS.includes(text)) said.get('vendor')!.push(text);
        else c.other.push(text);
      } else if (ch.id === o.manager.id) {
        // The boss justifies his snack at the cart, from his own deck.
        if (itAnswer()) continue;
        if (BOSS_SNACK_LINES.includes(text)) said.get('snack')!.push(text);
        else c.other.push(text);
      } else if (ch.id === o.receptionist.id) {
        if (itAnswer()) continue;
        // On the phone or not at the moment she speaks tells the two decks apart (themed lines go into both).
        if (!recLines.has(text)) { c.other.push(text); continue; }
        if (o.receptionOnPhone()) { c.phone++; said.get('phone')!.push(text); }
        else { c.idle++; said.get('idle')!.push(text); }
      } else if (itAnswer()) {
        // An idle agent's answer to the IT pair: not part of a water-cooler exchange.
      } else if (expectReply) {
        // A line is a reply when it follows an opener: a text can be an opener in one pair and a reply in another.
        expectReply = false;
        if (!(replies.has(text) || pairReplies.has(text))) c.other.push(text);
        else if (replies.has(text) && !pairReplies.has(text)) { c.replies++; said.get('reply')!.push(text); }
        else said.get('pairReply')!.push(text);
      } else if (ownText.has(text)) { c.own++; c.exchanges++; said.get('own')!.push(text); expectReply = true; }
      else if (openers.has(text)) { c.exchanges++; said.get('opener')!.push(text); expectReply = true; }
      else c.other.push(text);
    }
  }
  return { c, lines: said };
}

function dupes(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x) ? true : (seen.add(x), false)));
}

const cases: { name: string; theme: OfficeTheme | undefined }[] = [{ name: 'no theme', theme: undefined }, { name: 'steampunk preset', theme: PRESET }];

for (const { name, theme } of cases) {
  for (const agents of [2, 4]) {
    test(`2 hours, ${agents} idle agents, ${name}: no line repeats`, (t) => {
      const chatPairs: number[] = [];
      for (const seed of SEEDS) {
        const { c, lines } = simulate(agents, seed, theme);
        const msg = `${name}, ${agents} agents, seed ${seed}: chats ${c.chats}, exchanges ${c.exchanges}, own-line exchanges ${c.own}, chat replies ${c.replies}, phone lines ${c.phone}, idle lines ${c.idle}, cart calls ${lines.get('vendor')!.length}, snack lines ${lines.get('snack')!.length}, IT fixes ${lines.get('fix')!.length}, IT replies ${lines.get('itReply')!.length}, comebacks ${lines.get('comeback')!.length}`;
        t.diagnostic(msg);
        console.log(msg);
        chatPairs.push(c.chats);
        assert.ok(c.exchanges > 0, `${msg}: people chatted`);
        assert.ok(c.phone > 0 && c.idle > 0, `${msg}: the receptionist called and remarked`);
        assert.deepEqual(c.other, [], 'every line belongs to a known pool');
        assert.deepEqual(dupes(lines.get('opener')!), [], 'small-talk opener repeated');
        assert.deepEqual(dupes(lines.get('own')!), [], 'own line repeated');
        assert.deepEqual(dupes(lines.get('reply')!), [], 'CHAT_REPLIES line repeated');
        assert.deepEqual(dupes(lines.get('phone')!), [], 'receptionist phone line repeated');
        assert.deepEqual(dupes(lines.get('idle')!), [], 'receptionist idle line repeated');
        assert.deepEqual(dupes(lines.get('cleaner')!), [], 'cleaner mutter repeated');
        assert.ok(lines.get('vendor')!.length > 0 && lines.get('snack')!.length > 0, `${msg}: the cart came and the boss went`);
        assert.deepEqual(dupes(lines.get('vendor')!), [], 'cart call repeated');
        assert.deepEqual(dupes(lines.get('snack')!), [], 'snack line repeated');
        assert.ok(lines.get('fix')!.length >= 1, `${msg}: the IT pair fixed a desk at least once`);
        assert.deepEqual(dupes(lines.get('dez')!), [], "Dez's line repeated");
        assert.deepEqual(dupes(lines.get('fenwick')!), [], "Fenwick's line repeated");
        assert.deepEqual(dupes(lines.get('itReply')!), [], 'IT small-talk reply repeated');
        assert.deepEqual(dupes(lines.get('comeback')!), [], 'IT comeback repeated');
      }
      if (agents === 4) assert.ok(chatPairs.every((n) => n > 1), `more than one chat per run: ${chatPairs.join(', ')}`);
    });
  }
}

test('4 idle agents: more than one pair of workers chatted', () => {
  const o = new Office(world, { seed: 1 });
  const idle = (n: number) => agent(`a${n}`, { activity: 'idle', status: 'idle', since: HOST0 - IDLE_WANDER_AFTER_MS - 1000, startedAt: n });
  o.applySnapshot([1, 2, 3, 4].map(idle), 0, HOST0);
  const pairsSeen = new Set<string>();
  for (let t = 0; t < TWO_HOURS; ) {
    t += STEP;
    o.update(t, STEP, HOST0 + t);
    if (o.chatIds().length === 2) pairsSeen.add([...o.chatIds()].sort().join('+'));
  }
  assert.ok(pairsSeen.size > 1, `pairs that chatted: ${[...pairsSeen].join(', ')}`);
});
