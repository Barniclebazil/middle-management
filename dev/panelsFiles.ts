// File room and Training library playground pieces for dev/panels.ts: the real panels (webview/engine/fileRoomPanel.ts and
// libraryPanel.ts) wrapped so their `post` is answered by a mock host (a fake file tree, fake skills and commands, delayed replies).
// Nothing here is used in production. The playground needs ?rounds=B to show the Round B entries in the Directory;
// the panels open with ?panel=files and ?panel=library either way.
//
// URL params (with ?panel=files):
//   fr=<list>     comma-separated: error | empty | one | hang-roots | hang-dirs | hang-files | push
//                 error = getFileRoots fails; empty = no folders; one = a single folder; hang-* = that request is never answered;
//                 push = after 2.5 s the host pushes a fileRoots list with one more folder (no reqId)
//   frlag=<ms>    delay of every reply (default 300)
//   fclick=<a>|<b>|...   after the roots arrive, click the rows (data-key) or crumbs (data-crumb="<relPath>" written as crumb:<relPath>) one
//                 after another, 700 ms apart; a row key is a root id (r1...) or a file or folder name, e.g. fclick=r1|src|engine|scene.ts
// URL params (with ?panel=library):
//   lib=<list>    comma-separated: empty | few | big | error | hang | slowfail | later
//                 empty = no skills and no commands; few = two of each; big = the list is reported as cut; error = every request fails;
//                 hang = never answered; slowfail = the first answer is the list, every later request fails; later = answers after 4 s
//   liblag=<ms>   delay of every reply (default 300)
//   libq=<text>   type that into the search box once the list is there
//   libclick=<button text>|...   click those buttons (exact text) one after another, 700 ms apart, starting once the list is there
import type { PanelContext, PanelView } from '../src/shared/panels.ts';
import type { CommandItem, DirEntry, FileRoot, HostToWebview, SkillItem, WebviewToHost } from '../src/shared/protocol.ts';
import { LIMITS } from '../src/shared/protocol.ts';
import { createFileRoomPanel } from '../webview/engine/fileRoomPanel.ts';
import { createLibraryPanel } from '../webview/engine/libraryPanel.ts';

export type Deliver = (msg: HostToWebview) => void;
export type Answer = (msg: WebviewToHost, deliver: Deliver) => void;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Wraps a panel (and every sub-view it pushes) so that what it posts is answered by `answer`, after the usual log line. */
function wrapView(view: PanelView<HTMLElement>, answer: Answer, afterMount?: (body: HTMLElement) => void): PanelView<HTMLElement> {
  let live = false;
  const wrapped: PanelView<HTMLElement> = {
    id: view.id,
    title: view.title,
    icon: view.icon,
    mount(body, ctx) {
      live = true;
      const c: PanelContext<HTMLElement> = {
        ...ctx,
        post: (msg) => {
          ctx.post(msg);
          answer(msg, (reply) => { if (live) view.handle?.(reply); });
        },
        push: (v) => ctx.push(wrapView(v, answer)),
      };
      view.mount(body, c);
      afterMount?.(body);
    },
    handle: (msg) => { view.handle?.(msg); },
    unmount() {
      live = false;
      view.unmount?.();
    },
  };
  if (view.refresh) wrapped.refresh = () => { view.refresh?.(); };
  return wrapped;
}

export function flags(params: URLSearchParams, name: string): Set<string> {
  return new Set((params.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function lagOf(params: URLSearchParams, name: string): number {
  const v = params.get(name);
  return v !== null && Number(v) >= 0 ? Number(v) : 300;
}

// ---------------------------------------------------------------------------
// File room

const ROOTS: FileRoot[] = [
  { rootId: 'r1', label: 'Pennywhistle site', kind: 'workspace', display: '~/Projects/pennywhistle-site', projectPath: '/home/alex/Projects/pennywhistle-site' },
  { rootId: 'r2', label: 'Harbour Branch notes', kind: 'workspace', display: '~/Projects/harbour-branch-notes', projectPath: '/home/alex/Projects/harbour-branch-notes' },
  { rootId: 'r3', label: 'quarterly-report', kind: 'agent', display: '~/Work/finance/quarterly-report', projectPath: '/home/alex/Work/finance/quarterly-report' },
  { rootId: 'r4', label: 'pricing-tool', kind: 'agent', display: '~/Work/pricing-tool', projectPath: '/home/alex/Work/pricing-tool' },
  { rootId: 'r5', label: 'Mercer archive', kind: 'project', display: '~/Documents/archives/odette-marsh/mercer-archive-2019-to-2024', projectPath: '/home/alex/Documents/archives/odette-marsh/mercer-archive-2019-to-2024' },
];
const PUSHED_ROOT: FileRoot = { rootId: 'r6', label: 'label-printer', kind: 'agent', display: '~/Work/label-printer', projectPath: '/home/alex/Work/label-printer' };

type FileFields = Omit<Extract<HostToWebview, { type: 'fileText' }>, 'type' | 'reqId' | 'rootId' | 'relPath'>;

interface FakeTree {
  dirs: Map<string, DirEntry[]>;
  files: Map<string, FileFields>;
  /** Directories and files whose request fails, with the message. */
  broken: Map<string, string>;
}

const README = [
  '# Pennywhistle site',
  '',
  'The public site for **Pennywhistle Paper Co**. It is built with a small static generator.',
  '',
  '## Getting started',
  '',
  '1. Install the packages with `npm install`.',
  '2. Start the preview with `npm run dev`.',
  '3. Open the address it prints.',
  '',
  '## Folders',
  '',
  '- `src/` the pages and the components',
  '- `docs/` notes for whoever looks after the site next',
  '- `public/` images and fonts, copied as they are',
  '',
  '> Harbour Branch keeps its own copy of the price list. Do not edit it here.',
  '',
  '```sh',
  'npm run build && npm run check-links',
  '```',
].join('\n');

const NOTES = [
  '# Handover notes',
  '',
  'Written by Alex Mercer for Odette Marsh.',
  '',
  '## Open items',
  '',
  '- The order form still posts to the old address.',
  '- The **spring** catalogue needs new photos.',
  '- Check the `redirects.json` file before the next release.',
  '',
  '---',
  '',
  'Nothing else is waiting.',
].join('\n');

const CHANGELOG_HEAD = [
  '# Changelog',
  '',
  '## 2.4.0',
  '',
  '- New order form',
  '- Faster image loading',
  '- Fixed the footer on small screens',
  '',
  '## 2.3.2',
  '',
  '- Corrected the opening hours',
];

function sampleCode(name: string, lines: number): string {
  const out = [`// ${name}`, "import { render } from './render.ts';", ''];
  for (let i = 1; i <= lines; i++) {
    out.push(i % 7 === 0 ? `export function step${i}(input: string): string {` : `  const value${i} = input.trim().toLowerCase() + '-${i}';`);
    if (i % 7 === 0) out.push('  return render(input);', '}', '');
  }
  return out.join('\n');
}

function buildTree(): FakeTree {
  const NOW = Number(new URLSearchParams(location.search).get('now')) || Date.now();
  const dir = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, kind: 'dir', ...extra });
  const file = (name: string, size: number, ago: number, extra: Partial<DirEntry> = {}): DirEntry => ({ name, kind: 'file', size, mtime: NOW - ago, ...extra });
  const other = (name: string): DirEntry => ({ name, kind: 'other' });
  const dirs = new Map<string, DirEntry[]>();
  const files = new Map<string, FileFields>();
  const broken = new Map<string, string>();

  const many: DirEntry[] = [];
  for (let i = 1; i <= 40; i++) many.push(dir(`batch-${String(i).padStart(2, '0')}`));
  for (let i = 1; i <= 660; i++) many.push(file(`report-${String(i).padStart(3, '0')}.txt`, 900 + i * 13, (i % 90) * DAY + 5 * MIN));

  dirs.set('r1:', [
    dir('src'), dir('docs'), dir('public'), dir('releases'), dir('many'), dir('empty-dir'), dir('no-access'), dir('current', { link: true }),
    file('README.md', 1_240, 20 * MIN), file('CHANGELOG.md', 410_000, 3 * DAY), file('package.json', 880, 40 * DAY), file('.env', 128, 90 * DAY, { secret: true }),
    file('.env.example', 96, 90 * DAY), file('logo.png', 4_821, 400 * DAY), file('huge.log', 12_582_912, 2 * DAY), file('big-file.txt', 912_345, 6 * HOUR),
    file('empty.txt', 0, 50 * DAY), file('broken.txt', 1_000, 1 * DAY), file('latest.md', 2_048, 3 * DAY, { link: true }),
    other('deploy.sock'), other('old-link'),
    file('a very long file name that keeps going and going to see how narrow drawers cope with it.txt', 1_500, 12 * DAY),
  ]);
  dirs.set('r1:src', [dir('engine'), dir('components'), file('index.ts', 2_300, 1 * HOUR), file('util.ts', 1_100, 9 * DAY), file('notes.md', 1_900, 14 * DAY), file('server.ts', 7_800, 30 * DAY)]);
  dirs.set('r1:src/engine', [file('scene.ts', 18_400, 5 * HOUR), file('loop.ts', 3_200, 20 * DAY), file('camera.ts', 5_100, 20 * DAY), file('input.ts', 2_700, 100 * DAY)]);
  dirs.set('r1:src/components', [file('Header.tsx', 1_400, 8 * DAY), file('Footer.tsx', 1_200, 8 * DAY), file('OrderForm.tsx', 6_100, 2 * DAY)]);
  dirs.set('r1:docs', [dir('images'), file('guide.md', 5_400, 11 * DAY), file('notes.md', 1_200, 4 * DAY)]);
  dirs.set('r1:docs/images', []);
  dirs.set('r1:public', [file('favicon.ico', 1_150, 400 * DAY), file('logo.png', 4_821, 400 * DAY), file('fonts.woff2', 36_400, 300 * DAY)]);
  dirs.set('r1:releases', [dir('2.3.2'), dir('2.4')]);
  dirs.set('r1:releases/2.4', [file('build.txt', 640, 3 * DAY)]);
  dirs.set('r1:releases/2.3.2', [file('build.txt', 600, 40 * DAY)]);
  dirs.set('r1:current', [file('build.txt', 640, 3 * DAY)]);
  dirs.set('r1:empty-dir', []);
  dirs.set('r1:many', many);
  broken.set('r1:no-access', 'That folder cannot be read. Permission was refused.');
  broken.set('r1:broken.txt', 'The file changed while it was being read. Try again.');

  files.set('r1:README.md', { size: 1_240, text: README, markdown: true });
  files.set('r1:docs/guide.md', { size: 5_400, text: `${NOTES}\n\n${README}`, markdown: true });
  files.set('r1:docs/notes.md', { size: 1_200, text: NOTES, markdown: true });
  files.set('r1:src/notes.md', { size: 1_900, text: NOTES, markdown: true });
  files.set('r1:latest.md', { size: 2_048, text: NOTES, markdown: true });
  files.set('r1:CHANGELOG.md', { size: 410_000, text: `${CHANGELOG_HEAD.join('\n')}\n\n## 2.3.1\n\n- Fixed the sitem`, markdown: true, truncated: true });
  files.set('r1:.env', { size: 128, secret: true });
  files.set('r1:logo.png', { size: 4_821, binary: true });
  files.set('r1:public/logo.png', { size: 4_821, binary: true });
  files.set('r1:public/favicon.ico', { size: 1_150, binary: true });
  files.set('r1:public/fonts.woff2', { size: 36_400, binary: true });
  files.set('r1:huge.log', { size: 12_582_912, tooLarge: true });
  files.set('r1:big-file.txt', { size: 912_345, text: sampleCode('big-file.txt', 420), truncated: true });
  files.set('r1:empty.txt', { size: 0, text: '' });
  files.set('r1:package.json', { size: 880, text: '{\n  "name": "pennywhistle-site",\n  "version": "2.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "site dev",\n    "build": "site build"\n  }\n}\n' });
  files.set('r1:releases/2.4/build.txt', { size: 640, text: 'Built on the 14th.\nPages: 212\nImages: 380\nWarnings: 0\n' });
  files.set('r1:src/index.ts', { size: 2_300, text: sampleCode('index.ts', 21) });
  files.set('r1:src/engine/scene.ts', { size: 18_400, text: sampleCode('scene.ts', 140) });
  files.set('r1:a very long file name that keeps going and going to see how narrow drawers cope with it.txt', {
    size: 1_500, text: `${'A very long line with no breaks that goes on and on and on '.repeat(6)}\nshort\n${'x'.repeat(160)}\n`,
  });

  // The other folders are small.
  dirs.set('r2:', [dir('2024'), dir('2025'), file('index.md', 900, 2 * DAY), file('todo.txt', 300, 40 * MIN)]);
  dirs.set('r2:2024', [file('march.md', 2_100, 400 * DAY), file('april.md', 1_800, 380 * DAY)]);
  dirs.set('r2:2025', [file('january.md', 2_600, 120 * DAY)]);
  files.set('r2:index.md', { size: 900, text: '# Harbour Branch notes\n\nOne page per month.\n', markdown: true });
  files.set('r2:todo.txt', { size: 300, text: 'Book the van\nCall Odette Marsh about the stock count\nPrint the new labels\n' });
  dirs.set('r3:', [dir('figures'), file('summary.md', 3_300, 3 * HOUR), file('model.csv', 88_000, 3 * HOUR)]);
  dirs.set('r3:figures', [file('q1.png', 52_000, 30 * DAY), file('q2.png', 49_000, 30 * DAY)]);
  files.set('r3:summary.md', { size: 3_300, text: '# Quarterly report\n\n**Revenue** is up on last quarter.\n\n- Harbour Branch: +4%\n- Online: +11%\n', markdown: true });
  files.set('r3:model.csv', { size: 88_000, text: 'month,revenue,cost\nJan,1200,800\nFeb,1350,820\nMar,1410,900\n' });
  dirs.set('r4:', []);
  dirs.set('r5:', [dir('2019'), dir('2020'), dir('2021'), file('index.txt', 700, 600 * DAY)]);
  for (const y of ['2019', '2020', '2021']) dirs.set(`r5:${y}`, [file('ledger.csv', 12_000, 500 * DAY)]);
  files.set('r5:index.txt', { size: 700, text: 'Archive of the Mercer account books.\n' });
  dirs.set('r6:', [file('labels.csv', 5_000, 1 * DAY)]);
  return { dirs, files, broken };
}

/** The fake host behind the File room: answers getFileRoots, listDir and readFile (see the header for the `fr` params). Shared with the harness. */
export function fileRoomAnswer(params: URLSearchParams): Answer {
  const fr = flags(params, 'fr');
  const lag = lagOf(params, 'frlag');
  const tree = buildTree();
  let pushed = false;
  const roots = (): FileRoot[] => (fr.has('empty') ? [] : fr.has('one') ? ROOTS.slice(0, 1) : pushed ? [...ROOTS, PUSHED_ROOT] : ROOTS);

  return (msg, deliver) => {
    const later = (reply: HostToWebview, ms = lag): void => { setTimeout(() => deliver(reply), ms); };
    if (msg.type === 'getFileRoots') {
      if (fr.has('hang-roots')) return;
      if (fr.has('error')) { later({ type: 'error', reqId: msg.reqId, message: 'The folders could not be listed. Is a folder open in your editor?' }); return; }
      later({ type: 'fileRoots', reqId: msg.reqId, roots: roots() });
      if (fr.has('push') && !pushed) setTimeout(() => { pushed = true; deliver({ type: 'fileRoots', roots: roots() }); }, 2_500);
    } else if (msg.type === 'listDir') {
      if (fr.has('hang-dirs')) return;
      const key = `${msg.rootId}:${msg.relPath}`;
      const bad = tree.broken.get(key);
      if (bad) { later({ type: 'error', reqId: msg.reqId, message: bad }); return; }
      const all = tree.dirs.get(key);
      if (!all) { later({ type: 'error', reqId: msg.reqId, message: 'That folder is no longer there.' }); return; }
      const entries = all.slice(0, LIMITS.dirEntries);
      later({ type: 'dirListing', reqId: msg.reqId, rootId: msg.rootId, relPath: msg.relPath, entries, truncated: all.length > entries.length });
    } else if (msg.type === 'readFile') {
      if (fr.has('hang-files')) return;
      const key = `${msg.rootId}:${msg.relPath}`;
      const bad = tree.broken.get(key);
      if (bad) { later({ type: 'error', reqId: msg.reqId, message: bad }); return; }
      const f = tree.files.get(key);
      const name = msg.relPath.split('/').pop() ?? msg.relPath;
      const fields: FileFields = f ?? { size: 640, text: sampleCode(name, 12) };
      later({ type: 'fileText', reqId: msg.reqId, rootId: msg.rootId, relPath: msg.relPath, ...fields });
    }
  };
}

/** The File room panel with a fake host behind it (see the header for the params). */
export function createFileRoomMock(params: URLSearchParams): PanelView<HTMLElement> {
  const lag = lagOf(params, 'frlag');
  const answer = fileRoomAnswer(params);
  // fclick: after the roots arrive, click rows and crumbs one by one.
  const steps = (params.get('fclick') ?? '').split('|').filter(Boolean);
  let clicked = false;
  const afterMount = (): void => {
    if (clicked || steps.length === 0) return;
    clicked = true;
    steps.forEach((step, i) => {
      setTimeout(() => {
        const sel = step.startsWith('crumb:') ? `[data-crumb="${step.slice(6)}"]` : `.co-fr-row[data-key="${step.replace(/["\\]/g, '\\$&')}"]`;
        document.querySelector<HTMLElement>(sel)?.click();
      }, lag + 600 + i * (lag + 500));
    });
  };
  return wrapView(createFileRoomPanel(), answer, afterMount);
}

// ---------------------------------------------------------------------------
// Training library

function skill(name: string, source: SkillItem['source'], description: string, extra: Partial<SkillItem> = {}): SkillItem {
  const plugin = extra.plugin;
  return { name, invoke: source === 'plugin' && plugin ? `${plugin}:${name}` : name, description, source, ...extra };
}

function command(name: string, source: CommandItem['source'], description: string, extra: Partial<CommandItem> = {}): CommandItem {
  const plugin = extra.plugin;
  return { name, invoke: source === 'plugin' && plugin ? `${plugin}:${name}` : name, description, source, ...extra };
}

function buildSkills(now: number): SkillItem[] {
  return [
    skill('release-notes', 'project', 'Draft release notes from the merged pull requests since the last tag, in the house tone.', { fileId: 'f1', uses: 14, lastUsedAt: now - 2 * DAY }),
    skill('invoice-check', 'project', 'Check an invoice export against the price list and report anything that does not add up.', { fileId: 'f2', uses: 3, lastUsedAt: now - 20 * DAY }),
    skill('brand-voice', 'project', '', { fileId: 'f3' }),
    skill('tidy-imports', 'user', 'Sort and merge the import lines in the files I name, and leave everything else alone.', { fileId: 'f4', uses: 41, lastUsedAt: now - 3 * HOUR }),
    skill('changelog', 'user', 'Add an entry to CHANGELOG.md in the Keep a Changelog format.', { fileId: 'f5', uses: 1, lastUsedAt: now - 70 * DAY }),
    skill('explain-diff', 'user', 'Explain what a diff does in plain words, for someone who has not seen the code. Say what could go wrong, and what to test, and keep it short enough to read on a phone while standing in a queue.', { fileId: 'f6', uses: 8, lastUsedAt: now - 1 * DAY }),
    skill('spelling-uk', 'user', 'Check spelling and punctuation in British English.', { fileId: 'f7', uses: 22, lastUsedAt: now - 5 * MIN }),
    skill('stock-count', 'user', 'Turn a list of counted items into the stock count sheet.', { fileId: 'f8', uses: 0 }),
    skill('rota', 'synced', 'Build next week’s rota from the shifts people asked for.', { uses: 5, lastUsedAt: now - 9 * DAY }),
    skill('label-sheet', 'synced', 'Lay out shipping labels, eight to a sheet.'),
    skill('order-email', 'synced', 'Write the order confirmation email.', { fileId: 'f9', uses: 2, lastUsedAt: now - 400 * DAY }),
    skill('commit', 'plugin', 'Write a commit message from the staged changes.', { plugin: 'git-tools', fileId: 'f10', uses: 60, lastUsedAt: now - 1 * HOUR }),
    skill('review-pr', 'plugin', 'Review a pull request and list the problems by how much they matter.', { plugin: 'git-tools', fileId: 'f11', uses: 12, lastUsedAt: now - 6 * DAY }),
    skill('release', 'plugin', 'Tag, build and publish a release.', { plugin: 'ship-it' }),
    skill('rollback', 'plugin', 'Roll the last release back and say what was undone.', { plugin: 'ship-it', fileId: 'f12', uses: 1, lastUsedAt: now - 200 * DAY }),
  ];
}

function buildCommands(): CommandItem[] {
  const builtin: [string, string][] = [
    ['clear', 'Clear the conversation and start again'], ['compact', 'Summarise the conversation to save room'], ['config', 'Open the settings'], ['cost', 'Show what this session has cost'],
    ['help', 'Show the help and the commands'], ['init', 'Write a CLAUDE.md for this project'], ['memory', 'Edit the memory files'], ['model', 'Change the model'],
    ['review', 'Review a pull request'], ['status', 'Show the version, model and account'],
  ];
  return [
    ...builtin.map(([n, d]) => command(n, 'builtin', d)),
    command('deploy', 'project', 'Deploy the site to the staging server.', { fileId: 'c1', argumentHint: '[environment]' }),
    command('fix-issue', 'project', 'Find the cause of an issue and fix it.', { fileId: 'c2', argumentHint: '[issue number]' }),
    command('standup', 'user', 'Write my stand-up note from yesterday’s commits.', { fileId: 'c3' }),
    command('tidy', 'user', '', { fileId: 'c4' }),
    command('translate', 'user', 'Translate a file into the language I give, keeping the formatting.', { fileId: 'c5', argumentHint: '[file] [language]' }),
    command('pr', 'plugin', 'Open a pull request for the current branch.', { plugin: 'git-tools', fileId: 'c6', argumentHint: '[title]' }),
    command('squash', 'plugin', 'Squash the commits on this branch.', { plugin: 'git-tools', fileId: 'c7' }),
    command('ship', 'plugin', 'Run the release checks and ship.', { plugin: 'ship-it' }),
  ];
}

/** The fake host behind the Training library: answers getCatalog for `skills` (see the header for the `lib` params). Shared with the harness. */
export function libraryAnswer(params: URLSearchParams): Answer {
  const lib = flags(params, 'lib');
  const lag = lagOf(params, 'liblag');
  const NOW = Number(params.get('now')) || Date.now();
  let asked = 0;
  return (msg, deliver) => {
    if (msg.type !== 'getCatalog') return;
    asked += 1;
    if (lib.has('hang')) return;
    const delay = lib.has('later') ? 4_000 : lag;
    setTimeout(() => {
      if (lib.has('error') || (lib.has('slowfail') && asked > 1)) { deliver({ type: 'error', reqId: msg.reqId, message: 'The skills folder could not be read.' }); return; }
      let skills = buildSkills(NOW);
      let commands = buildCommands();
      if (lib.has('empty')) { skills = []; commands = []; }
      if (lib.has('few')) { skills = skills.slice(0, 2); commands = commands.slice(0, 2); }
      deliver({ type: 'catalog', reqId: msg.reqId, section: 'skills', skills, commands, truncated: lib.has('big') });
    }, delay);
  };
}

/** The Training library panel with a fake host behind it (see the header for the params). */
export function createLibraryMock(params: URLSearchParams): PanelView<HTMLElement> {
  const lib = flags(params, 'lib');
  const lag = lagOf(params, 'liblag');
  const answer = libraryAnswer(params);
  const query = params.get('libq');
  const steps = (params.get('libclick') ?? '').split('|').filter(Boolean);
  let done = false;
  const afterMount = (): void => {
    if (done) return;
    done = true;
    const start = (lib.has('later') ? 4_000 : lag) + 500;
    if (query) {
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('.co-lib-search');
        if (!input) return;
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, start);
    }
    steps.forEach((label, i) => {
      setTimeout(() => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('.co-lib button')).find((b) => (b.textContent ?? '').trim() === label)?.click();
      }, start + 300 + i * 700);
    });
  };
  return wrapView(createLibraryPanel(), answer, afterMount);
}
