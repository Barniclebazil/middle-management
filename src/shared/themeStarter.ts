/**
 * The starter theme file written by "Create Theme File": the built-in office with every field shown, so a user can
 * edit it in place. Pure text, no vscode. Must stay in step with `webview/art/looks.ts`, `webview/art/palette.ts` and
 * `webview/engine/lines.ts` (the data is copied, not imported, because the host never loads webview code): every look
 * equals `specOfLook` of its built-in and the colours equal `BASE_C` (checked by test/engine-looks.test.ts).
 */
import { IT_SUPPORT_ROLE } from './itSupport.ts';
import type { LookSpec } from './theme.ts';

const BOSS_LINES = [
  'Make it happen!',
  'I need this yesterday.',
  "You're killing it!",
  'Synergy!',
  'Big things. Huge.',
  'Proud of you. Mostly.',
  'Think outside the box!',
  'Is that done yet?',
  'Team player!',
  'Love the hustle!',
  'Circle back to me.',
  'This is your moment.',
  'Do it for the branch!',
  'Numbers! Love them!',
  'I believe in you.',
  "Let's crush it!",
  'Best. Team. Ever.',
  'Make me look good.',
  'Bold move. I like it.',
  'Paper is the future!',
  'Leverage that!',
  "Let's take this offline.",
  'Move the needle!',
  'Run it up the flagpole!',
  'Low-hanging fruit. Pick it!',
  'Blue-sky thinking. Go!',
  'Great work. What is it?',
  "Let's action that.",
  'Win-win-win!',
  'Bandwidth! Do we have it?',
  'Paradigm. Shifted.',
  'Touch base! Gently.',
  'Deep dive! Bring snacks.',
  'Going forward, go forward!',
  'Ten out of ten. Probably.',
  'Disrupt something! Nicely.',
  'Holistic! Very holistic.',
  'My door is always open.',
  'Quick win! My favourite.',
  'Is this agile? Love it.',
];

const SMALL_TALK: [string, string][] = [
  ['Did you see that?', 'Do not ask.'],
  ['Is it Friday yet?', "It's Tuesday."],
  ['Who took my yogurt?', 'No idea. Yum though.'],
  ['Nice tie.', "It's a clip-on."],
  ['Big meeting later?', 'Only in my head.'],
  ['Copier jammed again.', 'Classic copier.'],
  ['Cake in the kitchen?', 'Whose birthday?'],
  ['How was your weekend?', 'Too short.'],
  ['Saw the new memo?', 'I shredded it.'],
  ['Coffee tastes weird.', "That's the tea."],
  ['Sales are up!', 'Says who?'],
  ['Any gossip?', 'You first.'],
  ['Long day, huh?', "It's 10 am."],
  ['Fire drill today?', 'Please, no.'],
  ['Want to grab lunch?', 'Already ate. Twice.'],
  ['My stapler moved.', "It's been promoted."],
];

const STAFF_LOOKS: { role: string; look: LookSpec }[] = [
  {
    role: 'Deputy Vice Associate',
    look: { head: 'assistant', skin: 'rosy', build: 'normal', outfit: 'shirtTie', hair: '#6e4b2c', shirt: '#cfa53a', tie: '#5b3b26', collar: '#dcb655', pants: '#4d453a', shoes: '#2a221c', glasses: '#4a3a2c', skirt: false, shortSleeves: true, belt: true },
  },
  {
    role: 'Salesman',
    look: { head: 'prankster', skin: 'fair', build: 'tall', outfit: 'looseTie', hair: '#7d5232', shirt: '#b3cbe3', outer: '#5c6578', tie: '#2f3654', pants: '#474c58', shoes: '#2b2622', skirt: false, shortSleeves: false, belt: false },
  },
  {
    role: 'IT Help Desk',
    look: { head: 'headset', skin: 'olive', build: 'normal', outfit: 'polo', hair: '#5b3a26', shirt: '#34587f', collar: '#4d74a0', accent: '#c4453b', accent2: '#eef0ea', pants: '#9a8862', shoes: '#3a2c22', bow: '#2c2b31', skirt: false, shortSleeves: true, belt: true },
  },
  {
    role: 'Accountant (crosswords)',
    look: { head: 'crossword', skin: 'deep', build: 'normal', outfit: 'vest', hair: '#8f8a86', facialHair: '#6f6a66', shirt: '#dfe5ec', outer: '#7c4a3a', sleeve: '#dfe5ec', tie: '#3d4f7c', pants: '#45454c', shoes: '#22201f', glasses: '#4a3a2a', skirt: false, shortSleeves: false, belt: true },
  },
  {
    role: 'Accountant (cats)',
    look: { head: 'cat', skin: 'fair', build: 'small', outfit: 'buttonCardigan', hair: '#e3c376', hairHighlight: '#f4dea0', shirt: '#f4f0e6', outer: '#b6a3cc', collar: '#f7f4ec', pants: '#5e4c6b', shoes: '#3a2a30', legs: '#e9cdb4', bow: '#c9a75a', skirt: true, shortSleeves: false, belt: false },
  },
  {
    role: 'Accountant (chili)',
    look: { head: 'chili', skin: 'rosy', build: 'big', outfit: 'shirtTie', hair: '#8a6a4c', shirt: '#9fb2d2', tie: '#7a3846', pants: '#8b7b5f', shoes: '#3a2c22', skirt: false, shortSleeves: false, belt: true },
  },
  {
    role: 'Saleswoman (knitting)',
    look: { head: 'knitting', skin: 'fair', build: 'normal', outfit: 'floral', hair: '#cbbb98', hairHighlight: '#e2d6b8', shirt: '#7d9b6c', accent: '#f0c2cf', accent2: '#f6e7a6', pants: '#58644f', shoes: '#4a3a2c', legs: '#e0b896', skirt: true, shortSleeves: false, belt: false },
  },
  {
    role: 'HR Representative',
    look: { head: 'hr', skin: 'fair', build: 'normal', outfit: 'openCardigan', hair: '#5e4e42', facialHair: '#7a6656', shirt: '#cdd8e3', outer: '#c4b08a', pants: '#5b5650', shoes: '#33291f', skirt: false, shortSleeves: false, belt: false },
  },
];

const MANAGER_LOOK: LookSpec = { head: 'boss', skin: 'fair', build: 'normal', outfit: 'suit', hair: '#3a2a24', shirt: '#eeeee8', outer: '#353a4a', tie: '#9a2f3c', pants: '#353a4a', shoes: '#1f1c22', skirt: false, shortSleeves: false, belt: false };

const RECEPTIONIST_LOOK: LookSpec = { head: 'receptionist', skin: 'warm', build: 'normal', outfit: 'openCardigan', hair: '#a65334', hairHighlight: '#c8714a', shirt: '#efe6d3', outer: '#c4899b', pants: '#5a5d70', shoes: '#4a2f24', legs: '#d5a585', skirt: true, shortSleeves: false, belt: false };

/** Today's built-in environment colours (webview/art/palette.ts `C` and the sign in office-map.ts). */
const DEFAULT_COLORS = {
  wall: '#d9c9a4',
  trim: '#5f5040',
  ceiling: '#e4e0d4',
  carpet: '#66748a',
  lobbyFloor: '#bfb196',
  kitchenFloor: '#ddd5bf',
  conferenceFloor: '#5f6c7f',
  managerFloor: '#7a6d5b',
  annexFloor: '#6d7488',
  rug: '#7d3b37',
  rugBorder: '#b88a4b',
  deskChairs: '#2f7b83',
  kitchenChairs: '#c9773b',
  managerChair: '#2b2830',
  signPlate: '#2d3d57',
  signText: '#fff4d0',
  signBranch: '#b9b7a6',
  desks: '#c2ab84',
  deskPanels: '#8d939b',
  wood: '#b0804c',
  darkWood: '#6f4528',
  metal: '#9aa2ab',
  computers: '#d8cfb4',
  screens: '#1f2a2c',
  plants: '#4f8a3c',
  plantPots: '#b5643c',
  glass: '#bfe0ee',
  glassFrames: '#8f9aa3',
  blinds: '#ebe6da',
  windowFrames: '#f0ede4',
  sky: '#9fc3db',
  skyline: '#7e8f9e',
  ceilingLights: '#f7fbff',
  outside: '#2a2430',
};

/** Two sample lines from each built-in pool (one where the pool has one); pairs pools get two pairs. Copied from `LINE_POOLS` in webview/engine/lines.ts. */
const SAMPLE_LINES = {
  bossVisit: ['Make it happen!', 'I need this yesterday.'],
  bossSnack: ['Carrot cake is one of my five a day.', "A doughnut has a hole. That's half the calories."],
  bossSnoop: ["Don't make mistakes."],
  bossSulkStart: ['Oh, by all means, take my office.', 'Fine. FINE.'],
  bossSulk: ["It's not even that nice an office.", 'I was going to redecorate anyway.'],
  bossSulkEnd: ["Right. Spell's over. OUT.", "I'll be taking my chair back now."],
  deskBumped: ['Moving desks, apparently.', "Guess I'm not senior enough."],
  deskMoveUp: ['Ooh, better chair.', "Don't mind if I do."],
  chatReplies: ['Ha. Fair.', 'Tell me about it.'],
  receptionPhone: ['Front desk, how can I help?', 'Front desk. One moment, please.'],
  receptionGreeting: ['Good morning!', 'Welcome in!'],
  receptionIdle: ['Filing is a lifestyle.', 'Who keeps taking the good pens?'],
  receptionAttending: ['What can I change for you?'],
  cleanerMutters: ['Crumbs. Always crumbs.', 'Another mug ring. Like a tree, but sadder.'],
  cartCalls: ["Trolley's here!", 'Tea, coffee, cake! Come and get it!'],
  itFix: ['Have you tried turning it off and on again?'],
  itVerdicts: ['There. Fixed.', 'It was the cable. It is always the cable.'],
  itGiveUps: ["Oh, don't mind me, then.", "Fine. I'll just leave it booting."],
  itSneers: ['An em dash. And another. And another.', 'It said "delve". Nobody delves. Nobody!'],
  itComebacks: ['That was my context window.', 'I was mid-thought.'],
  itFixerMutters: ['Another day, another cable.', 'Should have stayed in the basement.'],
  itCriticMutters: ['Fourteen tickets. All marked urgent. Oh dear.', 'I alphabetised the spare cables. Twice.'],
  itTalkReplies: ['Sorry?', 'Oh. Right.'],
  itFixerTalk: [['Nice weather. For a server room.', "It's colder in there. I like cold."], ['Busy? Me neither.', "I've been not busy since nine."]],
  itCriticTalk: [['The gaffer has lost the dressing room.', 'Has anyone checked behind the radiator?'], ['They parked the bus again. Shocking.', 'On a double yellow, I assume. Shocking.']],
  bossPlanApproved: [['Love this plan. Visionary.', "Didn't read it, obviously."], ['Phase three is genius.', 'Is there a phase three?']],
  bossCommandApproved: [['Run it! I trust you.', 'What does rm do again?'], ['Approved. No notes.', 'No reading either.']],
  bossEditApproved: [['Edit away! Love the diff.', "Didn't open the diff."], ['Lovely edit. So green.', "Red bits? Didn't look."]],
};

/** The built-in job titles, as the tooltips show them (looks.ts roles, `vendorTooltip`'s default and `IT_SUPPORT_ROLE`). */
const DEFAULT_TITLES = {
  manager: 'Regional Manager',
  receptionist: 'Receptionist',
  cleaner: 'Cleaner',
  temp: 'Temp',
  vendor: 'Food cart',
  itSupport: IT_SUPPORT_ROLE,
};

const TEMP_LOOKS: LookSpec[] = [
  { head: 'short', skin: 'warm', build: 'normal', outfit: 'polo', hair: '#5b3a22', shirt: '#4f8f6a', collar: '#6aa985', pants: '#8f7e60', shoes: '#3a2c22', skirt: false, shortSleeves: true, belt: true },
  { head: 'ponytail', skin: 'olive', build: 'normal', outfit: 'blouse', hair: '#231c22', shirt: '#eceae2', pants: '#2f3a5a', shoes: '#1f1c22', legs: '#c28f62', bow: '#7a3a52', skirt: true, shortSleeves: false, belt: false },
  { head: 'short', skin: 'deep', build: 'normal', outfit: 'shirtTie', hair: '#1e1719', shirt: '#93b6da', tie: '#a8432f', pants: '#43464f', shoes: '#1f1c22', skirt: false, shortSleeves: false, belt: true },
  { head: 'curly', skin: 'fair', build: 'normal', outfit: 'plain', hair: '#b14f2c', hairHighlight: '#d06c42', shirt: '#3f8c8d', pants: '#3a3540', shoes: '#2b2226', skirt: false, shortSleeves: false, belt: false },
  { head: 'spiky', skin: 'rosy', build: 'normal', outfit: 'plain', hair: '#d9b85a', hairHighlight: '#f0d889', shirt: '#b5653d', pants: '#4a4f5c', shoes: '#2b2622', skirt: false, shortSleeves: false, belt: false },
  { head: 'bob', skin: 'brown', build: 'small', outfit: 'blouse', hair: '#3a2420', shirt: '#7d5ba6', pants: '#4b4b55', shoes: '#22202a', legs: '#8f5b3a', skirt: false, shortSleeves: false, belt: false },
];

/**
 * The starter theme as a plain object: the built-in office with every field shown. Key order here is not canonical and
 * empty `lines` arrays are present, so write it through the host's `serializeTheme` (which parses it and emits the same
 * bytes a no-change Save would). Pins are left out on purpose: the docs cover them.
 */
export function starterThemeObject(): Record<string, unknown> {
  return {
    name: 'My office',
    description: 'A starting point: rename people, rewrite what they say and recolour the office.',
    lineMode: 'add',
    company: 'Middle Management',
    branch: 'Riverside Branch',
    manager: {
      name: 'You',
      look: MANAGER_LOOK,
      lines: BOSS_LINES,
    },
    receptionist: {
      name: 'Receptionist',
      look: RECEPTIONIST_LOOK,
      lines: [] as string[],
    },
    colors: DEFAULT_COLORS,
    smallTalk: SMALL_TALK,
    staff: STAFF_LOOKS.map((s, i) => ({ name: i === 2 ? 'IT Help Desk' : `Staff ${i + 1}`, role: s.role, look: s.look, lines: [] as string[] })),
    temps: TEMP_LOOKS.map((look) => ({ look })),
    titles: DEFAULT_TITLES,
    lines: SAMPLE_LINES,
    // the built-in names of the IT pair (webview/engine/itCrew.ts); the cleaner and the vendor have none, so they are left out
    itFixer: { name: 'Dez' },
    itCritic: { name: 'Fenwick' },
  };
}

/** The starter as plain JSON text, optionally with a `$schema`. Not canonical (see `starterThemeObject`): files are written via `serializeTheme`. */
export function starterTheme(schemaPath?: string): string {
  const theme = schemaPath === undefined ? starterThemeObject() : { $schema: schemaPath, ...starterThemeObject() };
  return JSON.stringify(theme, null, 2) + '\n';
}
