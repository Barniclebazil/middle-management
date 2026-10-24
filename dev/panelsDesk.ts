// Mock host for the Round B "desk" panels in the panel playground (dev/panels.html): Phone, Office handbook and Temp agency.
// They are registered with `createDeskPanels(params)`; each is wrapped so its `getCatalog` requests are answered here
// (and `openConfigFile` is only logged), exactly as the real host's `catalog` and `error` replies would arrive: the panel's
// own `handle` is called with the reply. Open them with `?panel=phone|handbook|agency` (add `&rounds=B` for the Directory entries).
//
// Params (all optional):
//   desk=error     every getCatalog fails (the demo-mode refusal, or a read error)
//   desk=loading   no getCatalog is ever answered
//   desk=slow      answers after 12 s (shows "Still waiting..." and Try again)
//   desk=empty     every list is empty
//   desk=small     handbook: one file, two memories, three rules (every section starts open); agency: five types; phone: three lines
//   desk=big       handbook: 60 memories and 140 rules; agency: 100 types; phone: 100 lines (the host's limits), and the lists are marked cut short
//   desk=settled   phone: all statuses are final at once (no "Connecting..." sequence)
//   delay=<ms>     time to the first reply (default 500)
// The phone's default is the slow sequence: first reply has two lines still "Connecting...", the same request is answered
// again after 1.5 s (one connected, one failed) and once more after 3 s (the last one needs sign-in), as the host's poll does.
import type { PanelContext, PanelView } from '../src/shared/panels.ts';
import type {
  AgentTypeItem, HandbookFile, HostToWebview, McpServerItem, MemoryEntry, PermissionRuleItem, WebviewToHost,
} from '../src/shared/protocol.ts';
import { createAgencyPanel } from '../webview/engine/agencyPanel.ts';
import { createHandbookPanel } from '../webview/engine/handbookPanel.ts';
import { createPhonePanel } from '../webview/engine/phonePanel.ts';

type GetCatalog = Extract<WebviewToHost, { type: 'getCatalog' }>;
export type Reply = (msg: HostToWebview, afterMs?: number) => void;

// ---------------------------------------------------------------------------
// Phone: MCP servers (names are invented; the item type has no command, URL or env)

const srv = (name: string, scope: McpServerItem['scope'], transport: McpServerItem['transport'], status: McpServerItem['status'], tools?: number): McpServerItem =>
  (tools === undefined ? { name, scope, transport, status } : { name, scope, transport, status, tools });

/** Every status, scope and transport at least once. `step` 0 is the first reply, 1 and 2 are the poll's later answers. */
export function mcpServers(step: 0 | 1 | 2): McpServerItem[] {
  return [
    srv('ledger-tools', 'user', 'stdio', 'connected', 14),
    srv('docs-search', 'project', 'http', 'connected', 3),
    srv('ticket-desk', 'cloud', 'http', step >= 2 ? 'needsAuth' : 'pending'),
    srv('build-cache', 'local', 'sse', step === 0 ? 'pending' : 'failed'),
    srv('browser-bridge', 'plugin', 'ws', step === 0 ? 'pending' : 'connected', 21),
    srv('org-policy-gateway', 'managed', 'http', 'connected', 1),
    srv('sdk-local', 'user', 'sdk', 'connected', 0),
    srv('weather-lookup', 'user', 'stdio', 'disabled', 2),
    srv('calendar-sync', 'project', 'sse', 'needsAuth'),
    srv('mystery-line', 'unknown', 'unknown', 'unknown'),
    srv('a-line-with-a-very-long-name-that-has-to-wrap-onto-more-than-one-row-in-a-narrow-drawer', 'plugin', 'stdio', 'failed', 7),
  ];
}

function phoneServers(mode: string): McpServerItem[] {
  if (mode === 'empty') return [];
  if (mode === 'small') return [srv('ledger-tools', 'user', 'stdio', 'connected', 14), srv('docs-search', 'project', 'http', 'needsAuth'), srv('sdk-local', 'user', 'sdk', 'disabled', 0)];
  if (mode === 'big') {
    const scopes: McpServerItem['scope'][] = ['user', 'project', 'local', 'plugin', 'managed', 'cloud', 'unknown'];
    const transports: McpServerItem['transport'][] = ['stdio', 'http', 'sse', 'ws', 'sdk', 'unknown'];
    const statuses: McpServerItem['status'][] = ['connected', 'connected', 'connected', 'failed', 'needsAuth', 'pending', 'disabled', 'unknown'];
    return Array.from({ length: 100 }, (_, i) => srv(`line-${String(i + 1).padStart(3, '0')}`, scopes[i % scopes.length]!, transports[i % transports.length]!, statuses[i % statuses.length]!, i % 5 === 4 ? undefined : (i * 7) % 40));
  }
  return mcpServers(0);
}

function answerPhone(msg: GetCatalog, mode: string, delay: number, reply: Reply): void {
  const mk = (servers: McpServerItem[]): HostToWebview => ({ type: 'catalog', reqId: msg.reqId, section: 'mcp', servers, truncated: mode === 'big' });
  if (mode === 'empty' || mode === 'small' || mode === 'big' || mode === 'settled') {
    reply(mk(mode === 'settled' ? mcpServers(2) : phoneServers(mode)), delay);
    return;
  }
  reply(mk(mcpServers(0)), delay);
  reply(mk(mcpServers(1)), delay + 1500);
  reply(mk(mcpServers(2)), delay + 3000);
}

// ---------------------------------------------------------------------------
// Handbook

const file = (fileId: string, scope: HandbookFile['scope'], label: string, display: string, bytes?: number): HandbookFile =>
  (bytes === undefined ? { fileId, scope, label, display } : { fileId, scope, label, display, bytes });

const MEMORY_TITLES: [string, string, MemoryEntry['type']][] = [
  ['Prefers short answers', 'Keep replies brief; skip the recap at the end.', 'user'],
  ['Do not mock the database in tests', 'Integration tests hit a real database; a mock hid a broken migration last quarter.', 'feedback'],
  ['Release freeze starts on the 24th', 'No merges to main after the 24th; the mobile build is cut that day.', 'project'],
  ['Where the dashboards live', 'Latency and error budgets are on the Grafana board named "api-health".', 'reference'],
  ['Spelling: British English', 'Use "colour" and "organisation" in text the user will read.', 'feedback'],
  ['Why the billing queue exists', 'Invoices are batched overnight so the ledger never sees a partial day.', 'project'],
  ['Old note with no type', 'Written before notes had types.', undefined],
];

function memories(n: number): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const [title, hook, type] = MEMORY_TITLES[i % MEMORY_TITLES.length]!;
    const e: MemoryEntry = { fileId: `m${i + 1}`, file: `note_${i + 1}.md`, title: i < MEMORY_TITLES.length ? title : `${title} (${Math.floor(i / MEMORY_TITLES.length) + 1})` };
    if (i % 6 !== 5) e.hook = hook;
    if (type) e.type = type;
    return e;
  });
}

const RULE_BASE: [PermissionRuleItem['behavior'], string, PermissionRuleItem['scope'], string][] = [
  ['deny', 'Bash(rm -rf:*)', 'managed', 's-managed'],
  ['deny', 'Read(./.env)', 'managed', 's-managed'],
  ['deny', 'Bash(git push --force:*)', 'user', 's-user'],
  ['deny', 'WebFetch(domain:internal.example.test)', 'project', 's-project'],
  ['ask', 'Bash(git push:*)', 'user', 's-user'],
  ['ask', 'Edit(./migrations/**)', 'project', 's-project'],
  ['ask', 'mcp__ticket-desk__close_ticket', 'local', 's-local'],
  ['allow', 'Bash(npm run test:*)', 'user', 's-user'],
  ['allow', 'Bash(npm run lint)', 'user', 's-user'],
  ['allow', 'Read(~/Projects/**)', 'user', 's-user'],
  ['allow', 'Bash(git status)', 'project', 's-project'],
  ['allow', 'Bash(git diff:*)', 'project', 's-project'],
  ['allow', 'Bash(git log:*)', 'project', 's-project'],
  ['allow', 'mcp__docs-search', 'project', 's-project'],
  ['allow', 'WebSearch', 'local', 's-local'],
  ['allow', 'Bash(node scripts/very-long-script-name-that-goes-on-and-on.mjs --flag-one --flag-two --flag-three:*)', 'local', 's-local'],
];

function rules(n: number): PermissionRuleItem[] {
  const out: PermissionRuleItem[] = RULE_BASE.slice(0, n).map(([behavior, rule, scope, fileId]) => ({ behavior, rule, scope, fileId }));
  for (let i = out.length; i < n; i++) {
    out.push({ behavior: i % 7 === 0 ? 'ask' : 'allow', rule: `Bash(tool-${i}:*)`, scope: i % 2 ? 'user' : 'project', fileId: i % 2 ? 's-user' : 's-project' });
  }
  // A rule without a file id (the host could not open its file) in the largest group.
  if (n >= 16) out[9] = { behavior: 'allow', rule: 'Read(~/Projects/**)', scope: 'user' };
  return out;
}

function handbookReply(reqId: string, mode: string): HostToWebview {
  const full: HandbookFile[] = [
    file('f1', 'managed', 'CLAUDE.md', '/etc/claude-code/CLAUDE.md', 1_450),
    file('f2', 'user', 'CLAUDE.md', '~/.claude/CLAUDE.md', 3_900),
    file('f3', 'user', 'rules/testing.md', '~/.claude/rules/testing.md', 820),
    file('f4', 'project', 'CLAUDE.md', '~/Projects/ledger-app/CLAUDE.md', 12_480),
    file('f5', 'project', 'rules/api.md', '~/Projects/ledger-app/.claude/rules/api.md', 2_050),
    file('f6', 'local', 'CLAUDE.local.md', '~/Projects/ledger-app/CLAUDE.local.md', 96),
  ];
  if (mode === 'empty') return { type: 'catalog', reqId, section: 'handbook', instructions: [], memory: [], rules: [], truncated: false };
  if (mode === 'small') {
    return { type: 'catalog', reqId, section: 'handbook', instructions: [full[3]!], memoryIndex: file('mi', 'user', 'MEMORY.md', '~/.claude/projects/ledger-app/memory/MEMORY.md', 300), memory: memories(2), rules: rules(3), truncated: false };
  }
  const big = mode === 'big';
  return {
    type: 'catalog', reqId, section: 'handbook', instructions: big ? full.concat(Array.from({ length: 10 }, (_, i) => file(`fx${i}`, 'project', `rules/area-${i + 1}.md`, `~/Projects/ledger-app/.claude/rules/area-${i + 1}.md`, 400 + i * 50))) : full,
    memoryIndex: file('mi', 'user', 'MEMORY.md', '~/.claude/projects/ledger-app/memory/MEMORY.md', 1_100),
    memory: memories(big ? 60 : 7), rules: rules(big ? 140 : 16), truncated: big,
  };
}

// ---------------------------------------------------------------------------
// Agency

const type = (name: string, source: AgentTypeItem['source'], description: string, over: Partial<AgentTypeItem> = {}): AgentTypeItem => ({ name, source, description, ...over });

function agentTypes(mode: string): AgentTypeItem[] {
  const all: AgentTypeItem[] = [
    type('general-purpose', 'builtin', 'General-purpose agent for researching complex questions, searching for code and running multi-step tasks.'),
    type('Explore', 'builtin', 'Read-only search agent for quickly finding files and answering questions about a codebase.', { model: 'haiku', tools: ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Bash'] }),
    type('Plan', 'builtin', 'Software architect agent for designing an implementation plan before any code is written.', { model: 'inherit', tools: ['Glob', 'Grep', 'Read'] }),
    type('migration-reviewer', 'project', 'Reviews a database migration for locks, rollbacks and data loss before it is merged.', { fileId: 'a1', model: 'opus', tools: ['Read', 'Grep', 'Glob'] }),
    type('test-writer', 'project', 'Writes focused unit tests for the file it is pointed at, in the project’s own style.', { fileId: 'a2' }),
    type('release-notes', 'user', 'Drafts release notes from merged pull requests, dry in tone, grouped by area.', { fileId: 'a3', model: 'claude-sonnet-4-5', tools: ['Read', 'Grep', 'Bash', 'WebFetch', 'Write'] }),
    type('security-scan', 'user', 'Looks for secrets and unsafe patterns. Cannot change anything.', { fileId: 'a4', model: 'inherit', tools: [] }),
    type('docs-helper', 'plugin', 'Keeps the docs folder in step with the code: finds stale pages and proposes edits.', { plugin: 'office-kit', model: 'sonnet', tools: ['Read', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'Bash'] }),
    type('a-very-long-agent-type-name-that-needs-to-wrap-in-a-narrow-drawer', 'plugin', 'x'.repeat(40) + ' A long description that should wrap and never push the card wider than the drawer, even with unbroken text: ' + 'abcdefghij'.repeat(12), { plugin: 'office-kit-with-a-long-plugin-name', fileId: 'a5', model: 'claude-opus-4-1' }),
  ];
  if (mode === 'empty') return [];
  if (mode === 'small') return all.slice(0, 5);
  if (mode === 'big') {
    const sources: AgentTypeItem['source'][] = ['builtin', 'project', 'user', 'plugin'];
    return Array.from({ length: 100 }, (_, i) => type(`worker-${String(i + 1).padStart(3, '0')}`, sources[i % 4]!, `Does job number ${i + 1}.`, { ...(i % 3 ? { fileId: `ab${i}` } : {}), ...(i % 4 === 3 ? { plugin: 'office-kit' } : {}) }));
  }
  return all;
}

// ---------------------------------------------------------------------------
// The wrapper: answers getCatalog for one section, logs the rest through the playground's post

/**
 * Answers one getCatalog for the phone (`mcp`), the handbook or the agency (`agents`) from the `desk` and `delay` params (see the
 * header). Shared with the harness, which sends the replies to the whole webview.
 */
export function answerCatalog(msg: GetCatalog, params: URLSearchParams, reply: Reply): void {
  const mode = params.get('desk') ?? '';
  const delayParam = params.get('delay');
  const delay = delayParam !== null && Number(delayParam) >= 0 ? Number(delayParam) : 500;
  if (mode === 'loading') return;
  if (mode === 'error') {
    reply({ type: 'error', reqId: msg.reqId, message: 'This is not available in the demo office.' }, delay);
    return;
  }
  const after = mode === 'slow' ? 12_000 : delay;
  if (msg.section === 'mcp') answerPhone(msg, mode, after, reply);
  else if (msg.section === 'handbook') reply(handbookReply(msg.reqId, mode), after);
  else if (msg.section === 'agents') reply({ type: 'catalog', reqId: msg.reqId, section: 'agents', agents: agentTypes(mode), truncated: mode === 'big' }, after);
}

function withMockHost(view: PanelView<HTMLElement>, section: GetCatalog['section'], params: URLSearchParams): PanelView<HTMLElement> {
  const reply: Reply = (msg, after = 0) => { setTimeout(() => { view.handle?.(msg); }, after); };
  return {
    ...view,
    mount(body, c) {
      const mocked: PanelContext<HTMLElement> = {
        ...c,
        post(msg) {
          c.post(msg);
          if (msg.type !== 'getCatalog' || msg.section !== section) return;
          answerCatalog(msg, params, reply);
        },
      };
      view.mount(body, mocked);
    },
  };
}

/** The three panels, each wrapped with its mock host. Register every one with `registerPanel`. */
export function createDeskPanels(params: URLSearchParams): PanelView<HTMLElement>[] {
  return [
    withMockHost(createPhonePanel(), 'mcp', params),
    withMockHost(createHandbookPanel(), 'handbook', params),
    withMockHost(createAgencyPanel(), 'agents', params),
  ];
}
