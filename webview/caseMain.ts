/**
 * Entry point of a case tab (v0.5, `dist/case.js`): one worker's case file in its own editor tab, laid out like the Claude
 * Code chat. See docs/manager-mode.md section 18.
 *
 * - Boot: the host puts `<script type="application/json" id="mm-boot">{"mode":"case","agentId":"…"}</script>` in the tab's
 *   HTML (plus an optional `look`). Missing or invalid, the tab shows "This tab lost its worker" and does nothing else (no `ready`).
 * - Then it posts `ready` (the host answers with the cached `agents`, `settings`, `usage` and `claudeDefaults`) and
 *   `openCase{agentId}` for its own worker (the host answers `caseFile`, then streams `caseAppend`).
 * - Every host message goes through `claimForTab` (`forAnotherCase`, the same rule the host uses): another worker's,
 *   session's or request's messages and the office's own state are ignored.
 * - No office here: no canvas, roster, icon bar, drawer or memo. The portrait's look is the one the office gave this worker:
 *   the boot's `look` (sent with `openCaseTab`), or a later `caseLook` when the tab was already open. If it is missing or the
 *   art does not know it, the tab falls back to its own Assigner guess (staff slots in start order, pins from the theme).
 *   The theme's look overrides apply on top either way (`tabLook` in caseLogic.ts decides).
 * - "New task" is not offered (a tab may not send `newTask`; the office's memo does that).
 */
import type { ClaudeDefaults, HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';
import { CASE_TAB_BOOT_ELEMENT_ID } from '../src/shared/protocol.ts';
import { STAFF_SLOT_IDS, TEMP_SLOT_IDS, getLook } from './art/index.ts';
import { Assigner } from './engine/assign.ts';
import { CaseFile } from './engine/caseFile.ts';
import { claimForTab, readCaseTabBoot, tabLook } from './engine/caseLogic.ts';
import { injectCaseTabStyles } from './engine/caseTabStyles.ts';
import { h, pixelIcon } from './engine/dom.ts';
import { tierOf } from './engine/modelTier.ts';
import { normalizeAgent } from './engine/targets.ts';
import type { AgentView } from './engine/targets.ts';
import type { SlotInfo } from './engine/theme.ts';
import { ThemeApplier } from './engine/themeApply.ts';
import type { ThemeTarget } from './engine/themeApply.ts';
import { artPort } from './engine/themeArt.ts';
import { injectUiStyles } from './engine/uiStyles.ts';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void; getState?(): unknown; setState?(s: unknown): void };

injectUiStyles();
injectCaseTabStyles();
document.body.classList.add('co-tab-body');

const boot = readCaseTabBoot(document.getElementById(CASE_TAB_BOOT_ELEMENT_ID)?.textContent ?? null);

if (!boot) {
  // Nothing to show and nobody to ask: say so, quietly, and stop.
  document.body.appendChild(h('div', { class: 'co-tab-lost co-ui', role: 'alert' },
    pixelIcon('alert', 30),
    h('strong', { text: 'This tab lost its worker' }),
    h('span', { text: 'Close it, then click the worker in the office to open their file again.' })));
} else {
  start(boot.agentId, boot.look);
}

function start(agentId: string, bootLook: string | undefined): void {
  /** The look the office handed over: the boot's, replaced by a later `caseLook` for this worker. */
  let handedLook = bootLook;
  const vscode = acquireVsCodeApi();
  const post = (msg: WebviewToHost): void => vscode.postMessage(msg);

  /** Host clock. The dev harness can supply a scripted clock (`__harnessClock`); in VS Code it's Date.now(). */
  const hostNow = (): number => {
    const c = (window as unknown as { __harnessClock?: () => number }).__harnessClock;
    return typeof c === 'function' ? c() : Date.now();
  };

  // Who is who, as the office decides it: an Assigner over the same snapshots (seats don't matter here), with the theme's pins.
  const assigner = new Assigner(STAFF_SLOT_IDS, TEMP_SLOT_IDS, []);
  const themeTarget: ThemeTarget = {
    setTheme(state) {
      const pins = new Map<string, SlotInfo['pin']>();
      if (state) for (const [slot, info] of state.staff) if (info.pin) pins.set(slot, info.pin);
      assigner.setPins(pins);
    },
    bossQuotes: true,
    speechBubbles: true,
  };
  const applier = new ThemeApplier({ art: artPort, office: themeTarget, staffSlots: STAFF_SLOT_IDS, tempSlots: TEMP_SLOT_IDS });

  /** The latest snapshot, by id. */
  const agents = new Map<string, AgentView>();
  let latestDefaults: ClaudeDefaults | null = null;

  const caseFile = new CaseFile(document.body, {
    layout: 'page',
    post,
    agent: (id) => agents.get(id) ?? null,
    lookOf: (id) => tabLook(id === agentId ? handedLook : undefined, (l) => getLook(l) !== undefined, assigner.get(id)?.look ?? null),
    managerName: () => applier.settings.managerName || 'You',
    defaults: () => latestDefaults,
  });

  // Toast for host errors that reach the tab but aren't the case's own (an id-less reply to something it sent).
  const toast = h('div', { class: 'co-tab-toast co-ui', role: 'alert' });
  toast.hidden = true;
  document.body.appendChild(toast);
  let toastTimer = 0;
  const showToast = (text: string): void => {
    toast.textContent = text;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 7000);
  };

  function applyAgents(raw: readonly unknown[]): void {
    const now = hostNow();
    const list = raw.map((a) => normalizeAgent(a, now)).filter((a): a is AgentView => a !== null);
    const seen = new Set<string>();
    agents.clear();
    for (const a of list) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      agents.set(a.id, a);
    }
    // Same rule as the office: a temp that is already done never gets a desk; someone who left frees their look.
    assigner.assign(list
      .filter((a) => !(a.kind === 'temp' && a.status === 'done') && !assigner.get(a.id))
      .map((a) => ({ id: a.id, kind: a.kind, startedAt: a.startedAt, tier: tierOf(a.model), project: a.project, title: a.title })));
    for (const id of assigner.ids()) if (!seen.has(id)) assigner.release(id);
  }

  window.addEventListener('message', (ev: MessageEvent<unknown>) => {
    const own = caseFile.address() ?? { agentId };
    const msg = ev.data;
    if (!claimForTab(msg, own)) return;
    handle(msg);
  });

  function handle(msg: HostToWebview): void {
    switch (msg.type) {
      case 'agents':
        applyAgents(Array.isArray(msg.agents) ? msg.agents : []);
        caseFile.refresh();
        break;
      case 'settings': {
        if (!msg.settings) break;
        applier.setHost(msg.settings);
        const r = applier.apply();
        if (r.looksChanged.length > 0 || r.artReset) caseFile.refreshLooks();
        else caseFile.refresh();
        break;
      }
      case 'claudeDefaults':
        latestDefaults = msg.defaults && typeof msg.defaults === 'object' ? msg.defaults : null;
        caseFile.handle(msg);
        break;
      case 'caseLook':
        if (msg.agentId === agentId && msg.look !== handedLook) {
          handedLook = msg.look;
          caseFile.refreshLooks();
        }
        break;
      case 'sessionOptions':
      case 'caseFile':
      case 'caseAppend':
      case 'caseClosed':
        caseFile.handle(msg);
        break;
      case 'error':
        if (!caseFile.showError(msg)) showToast(String(msg.message ?? 'Something went wrong.'));
        break;
      default:
        // `usage`: nothing in a case tab shows it yet.
        break;
    }
  }

  // `ready` first (the shared state comes back), then this worker's file. Replies arrive as events, after both.
  post({ type: 'ready' });
  caseFile.open(agentId);
}
