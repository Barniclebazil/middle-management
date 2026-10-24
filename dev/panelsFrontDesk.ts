// Front desk playground pieces for dev/panels.ts: a FrontDeskCtx mock around the real panel (webview/engine/frontDeskPanel.ts),
// answered by the mock host in dev/frontDeskMock.ts (a fake FrontDeskState per source, delayed replies, a conflict on demand,
// `settings` / `frontDesk` pushes after saves; the real-webview harness, dev/harness.ts, shares it).
//
// URL params (with ?panel=frontdesk):
//   tab=theme|settings|staff|colours   first tab
//   fd=builtin|preset|file|workspace|notObject|conflict|errors   what the host reports (default builtin)
//        workspace = the theme path is set by the workspace (read-only) and the workspace overrides some settings
//        notObject = the file is not a JSON object (read-only, using the last good theme)
//        conflict  = the first Save finds the file changed on disk
//        errors    = a file with problems; the office shows the last good theme
//   lag=<ms>        delay of every host reply (default 350)
//   savelag=<ms>   delay of the replies to saveTheme / saveThemeAs only (to see "Saving…")
//   fail=theme|save|setting   the host answers that call with an error
//   dialog=cancel   file dialogs are dismissed (cancelled)
//   diskchange=<ms> the file changes on disk this long after the first state (shows "changed on disk")
//   person=<slot>   with tab=staff: open that person's page (sign, manager, receptionist, staff-0..7, temp-0..5); in a narrow
//                   drawer it is pushed as a sub-view, as a click on the list would
//   set=<path>=<value>,...   edits made as soon as the panel is built, e.g. set=colors.signText=#34465f (a hard-to-read sign)
//                   or set=staff-2.look.outfit=suit,staff-2.name=Marta Quill (values with commas are not supported)
//   autoedit=1|bad  shorthand for set=company=Pennywhistle Paper Co (bad: also colors.wall=mauve, an invalid colour)
//   dw=<px>         drawer width (320-640, as if dragged), e.g. dw=640 shows the Staff tab's list beside the page
//   keep=1          the unsaved draft survives a page reload in sessionStorage (like the real webview's savedState)
//   askclose=<ms>   calls the panel's beforeClose() after that long, as the drawer does on Close or Esc (shows the prompt)
//   click=<css>;<css>   clicks those elements one after another (for screenshots), starting 1.2 s in
//   log=0           hide the little message log at the top left
import type { FrontDeskCtx, PanelContext, PanelView } from '../src/shared/panels.ts';
import { MockHost } from './frontDeskMock.ts';
import { createFrontDeskPanel, registerFrontDeskTab } from '../webview/engine/frontDeskPanel.ts';
import type { FrontDeskPanelView } from '../webview/engine/frontDeskPanel.ts';
import { isFrontDeskTab } from '../webview/engine/frontDeskView.ts';
import { createStaffTab, openStaffSlot } from '../webview/engine/frontDeskStaff.ts';
import '../webview/engine/frontDeskColours.ts';
import { h } from '../webview/engine/dom.ts';

/** The `set=` (and `autoedit=`) edits, as [path, value] pairs. */
function startEdits(params: URLSearchParams): [string, string][] {
  const out: [string, string][] = [];
  const auto = params.get('autoedit');
  if (auto === 'bad') out.push(['colors.wall', 'mauve']);
  if (auto !== null) out.push(['company', 'Pennywhistle Paper Co']);
  for (const part of (params.get('set') ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.push([part.slice(0, eq).trim(), part.slice(eq + 1)]);
  }
  return out;
}

/** Wraps the real Staff tab so the `set=` edits are made once, as soon as the tabs are built. */
function registerStartEdits(params: URLSearchParams): void {
  const edits = startEdits(params);
  if (edits.length === 0) return;
  let done = false;
  registerFrontDeskTab('staff', (api) => {
    if (!done) {
      done = true;
      queueMicrotask(() => {
        for (const [path, value] of edits) api.edit(path, value === 'true' ? true : value === 'false' ? false : value);
      });
    }
    return createStaffTab(api);
  });
}

const logLines: string[] = [];
let logEl: HTMLElement | null = null;
/** A tiny message log (top left), because dev/panels.ts keeps its own log private. */
function mockLog(line: string, enabled: boolean): void {
  if (!enabled) return;
  logLines.push(line.length > 100 ? `${line.slice(0, 100)}…` : line);
  if (logLines.length > 5) logLines.shift();
  if (!logEl) {
    logEl = h('pre', { 'aria-hidden': 'true', style: 'position:fixed;left:8px;top:6px;margin:0;max-width:50%;z-index:5;pointer-events:none;white-space:pre-wrap;font:10.5px/13px ui-monospace,monospace;color:var(--vscode-descriptionForeground)' });
    document.body.appendChild(logEl);
  }
  logEl.textContent = logLines.join('\n');
}

export interface FrontDeskMockPanel extends PanelView<HTMLElement> {
  openTab(tab: string): void;
  host: MockHost;
}

/**
 * The real Front desk panel wrapped for the playground: its context gets the FrontDeskCtx members from the mock host, and every
 * message the panel posts is shown in the log and answered by the mock host.
 */
export function createFrontDeskMock(params: URLSearchParams): FrontDeskMockPanel {
  registerStartEdits(params);
  const person = params.get('person');
  const logOn = params.get('log') !== '0';
  const log = (l: string): void => { mockLog(l, logOn); };
  const host = new MockHost(params, log);
  const saveKey = 'co-fd-draft';
  const persist = params.get('keep') === '1';
  let saved: string | null = null;
  try { saved = persist ? sessionStorage.getItem(saveKey) : null; } catch { saved = null; }
  const tab = params.get('tab');
  let personAsked = false;
  const inner: FrontDeskPanelView = createFrontDeskPanel({
    loadState: () => saved,
    saveState: (text) => {
      saved = text;
      if (!persist) return;
      try {
        if (text === null) sessionStorage.removeItem(saveKey);
        else sessionStorage.setItem(saveKey, text);
      } catch { /* storage may be blocked */ }
    },
    ...(isFrontDeskTab(tab) ? { initialTab: tab } : {}),
  });
  const fdCtx = (c: PanelContext<HTMLElement>): FrontDeskCtx<HTMLElement> => ({
    ...c,
    post: (m) => { log(`post ${m.type}${'reqId' in m ? ` ${m.reqId}` : ''}${m.type === 'saveTheme' ? `${m.force ? ' force' : ''} rev=${m.rev}` : ''}`); host.handle(m); },
    hostTheme: () => host.theme,
    hostSettings: () => host.officeSettings(),
    preview: (t) => { log(t === null ? 'preview: off' : `preview: ${JSON.stringify(t).slice(0, 70)}`); },
    onHost: (l) => host.listen(l),
  });
  return {
    id: inner.id,
    title: inner.title,
    icon: inner.icon,
    host,
    mount(body, c) {
      inner.mount(body, fdCtx(c));
      const dw = Number(params.get('dw'));
      if (dw > 0 && !document.getElementById('pg-dw')) {
        // A stylesheet rule, so the drawer's own width updates (resize, viewport) don't undo it.
        const st = h('style', { id: 'pg-dw' });
        st.textContent = `.co-drawer:not(.overlay) { width: ${Math.max(320, Math.min(640, Math.round(dw)))}px !important; }`;
        document.head.append(st);
      }
      // Asked a little after the mock host's first reply, once the page has its final size (headless Chromium starts wider).
      if (person !== null && !personAsked) {
        personAsked = true;
        window.setTimeout(() => { openStaffSlot(person); }, 800);
      }
      const ask = Number(params.get('askclose'));
      if (ask > 0) window.setTimeout(() => { inner.beforeClose?.(); }, ask);
      const clicks = (params.get('click') ?? '').split(';').filter((x) => x !== '');
      clicks.forEach((sel, i) => {
        window.setTimeout(() => { document.querySelector<HTMLElement>(sel)?.click(); }, 1200 + i * 700);
      });
    },
    unmount() { inner.unmount?.(); },
    beforeClose() { return inner.beforeClose?.() ?? true; },
    openTab(t) { if (isFrontDeskTab(t)) inner.openTab(t); },
  };
}
