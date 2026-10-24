import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrontDeskController } from '../webview/engine/frontDeskController.ts';
import type { ChangeReason, ControllerHost } from '../webview/engine/frontDeskController.ts';
import { serializeDraft } from '../webview/engine/frontDeskLogic.ts';
import type { FrontDeskSetting, FrontDeskSource, FrontDeskState, HostToWebview, WebviewToHost } from '../src/shared/protocol.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';

const SETTINGS = Object.fromEntries(['mode', 'companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks'].map((k) => [k, { value: '', source: 'default', workspaceWins: false } satisfies FrontDeskSetting]));
const file = (over: Partial<FrontDeskSource> = {}): FrontDeskSource => ({ kind: 'file', label: 'office.json', path: '~/office.json', fromWorkspace: false, exists: true, editable: true, rev: 'aaaaaaaaaaaaaaaa', errors: [], usingLastGood: false, ...over });
const builtin: FrontDeskSource = { kind: 'builtin', label: 'Built-in office', fromWorkspace: false, exists: true, editable: false, readOnly: 'builtin', errors: [], usingLastGood: false };
const stateOf = (source: FrontDeskSource): FrontDeskState => ({ source, presets: [], settings: SETTINGS as FrontDeskState['settings'] });

interface Rig {
  c: FrontDeskController;
  posted: WebviewToHost[];
  previews: (OfficeTheme | null)[];
  saved: (string | null)[];
  host: { theme: OfficeTheme | null; stored: unknown };
  timers: { fn: () => void; ms: number; id: number }[];
  fire(): void;
  feed(msg: HostToWebview): void;
  reasons: ChangeReason[];
}

function rig(theme: OfficeTheme | null = { company: 'Acme' }, stored: unknown = null): Rig {
  const posted: WebviewToHost[] = [];
  const previews: (OfficeTheme | null)[] = [];
  const saved: (string | null)[] = [];
  const timers: Rig['timers'] = [];
  const host = { theme, stored };
  let id = 0;
  const h: ControllerHost = {
    hostTheme: () => host.theme,
    post: (m) => { posted.push(m); },
    preview: (t) => { previews.push(t); },
    loadState: () => host.stored,
    saveState: (t) => { saved.push(t); },
    setTimer: (fn, ms) => { const t = { fn, ms, id: ++id }; timers.push(t); return t.id; },
    clearTimer: (hnd) => { const i = timers.findIndex((t) => t.id === hnd); if (i >= 0) timers.splice(i, 1); },
  };
  const c = new FrontDeskController(h);
  const reasons: ChangeReason[] = [];
  c.onChange((r) => reasons.push(r));
  return {
    c, posted, previews, saved, host, timers, reasons,
    fire() { const t = timers.shift(); t?.fn(); },
    feed(msg) { c.receive(msg); },
  };
}

function load(r: Rig, source: FrontDeskSource): void {
  r.c.start();
  const req = r.posted.at(-1) as { type: 'getFrontDesk'; reqId: string };
  assert.equal(req.type, 'getFrontDesk');
  r.feed({ type: 'frontDesk', state: stateOf(source), reqId: req.reqId });
  r.feed({ type: 'frontDeskDone', reqId: req.reqId, ok: true });
}

function lastSave(r: Rig): Extract<WebviewToHost, { type: 'saveTheme' | 'saveThemeAs' }> {
  const m = r.posted.at(-1)!;
  assert.ok(m.type === 'saveTheme' || m.type === 'saveThemeAs', m.type);
  return m as never;
}

test('first state: the draft starts from the host theme and stays clean', () => {
  const r = rig({ company: 'Acme' });
  load(r, file());
  assert.deepEqual(r.c.draft(), { company: 'Acme' });
  assert.equal(r.c.editor.status, 'clean');
  assert.equal(r.c.editor.rev, 'aaaaaaaaaaaaaaaa');
  assert.equal(r.c.beforeClose(), true);
});

test('edit: dirty at once, preview debounced 120 ms, draft persisted', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Pennywhistle');
  assert.equal(r.c.editor.status, 'dirty');
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]!.ms, 120);
  r.c.edit('company', 'Pennywhistle Paper');
  assert.equal(r.timers.length, 1); // coalesced
  assert.equal(r.previews.length, 0);
  r.fire();
  assert.deepEqual(r.previews, [{ company: 'Pennywhistle Paper' }]);
  const saved = r.saved.at(-1);
  assert.equal(typeof saved, 'string');
  assert.equal(JSON.parse(saved!).draft.company, 'Pennywhistle Paper');
});

test('editing back to the host theme makes it clean and clears the preview', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'X');
  r.c.edit('company', 'Acme');
  assert.equal(r.c.editor.status, 'clean');
  r.fire();
  assert.deepEqual(r.previews, [null]);
  assert.equal(r.saved.at(-1), null);
});

test('discard adopts the host theme and clears the preview', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'X');
  r.c.discard();
  assert.deepEqual(r.c.draft(), { company: 'Acme' });
  assert.equal(r.c.editor.status, 'clean');
  assert.equal(r.previews.at(-1), null);
  assert.equal(r.timers.length, 0);
});

test('beforeClose vetoes while dirty, shows the prompt, discardForClose lets it close', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'X');
  assert.equal(r.c.beforeClose(), false);
  assert.equal(r.c.closePrompt, true);
  r.c.keepEditing();
  assert.equal(r.c.closePrompt, false);
  assert.equal(r.c.editor.status, 'dirty');
  r.c.beforeClose();
  assert.equal(r.c.discardForClose(), true);
  assert.equal(r.c.closePrompt, false);
  assert.equal(r.c.beforeClose(), true);
  assert.equal(r.saved.at(-1), null);
});

test('save over a file: confirm the drop list first, then post saveTheme and finish clean', () => {
  const r = rig();
  load(r, file({ rawText: '{"company":"Acme","mood":"x"}' }));
  r.c.edit('company', 'Pennywhistle');
  assert.equal(r.c.save(), 'confirm');
  assert.ok(r.c.confirming!.lines.some((l) => /mood/.test(l)));
  r.c.cancelConfirm();
  assert.equal(r.c.confirming, null);
  assert.equal(r.c.save(), 'confirm');
  r.c.confirmSave();
  const m = lastSave(r);
  assert.equal(m.type, 'saveTheme');
  assert.equal((m as { rev: string }).rev, 'aaaaaaaaaaaaaaaa');
  assert.equal(JSON.parse(m.themeJson).company, 'Pennywhistle');
  assert.equal(r.c.editor.status, 'saving');
  // host order after a save: settings, frontDesk (new rev), done
  r.host.theme = { company: 'Pennywhistle' };
  r.feed({ type: 'settings', settings: { companyName: '', branchName: '', speechBubbles: true, managerName: '', bossQuotes: true } });
  r.feed({ type: 'frontDesk', state: stateOf(file({ rev: 'bbbbbbbbbbbbbbbb', rawText: m.themeJson })), reqId: m.reqId });
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: true });
  assert.equal(r.c.editor.status, 'clean');
  assert.equal(r.c.editor.rev, 'bbbbbbbbbbbbbbbb');
  // asked once only: the next save goes straight out
  r.c.edit('company', 'Again');
  assert.equal(r.c.save(), 'posted');
});

test('no drop list (nothing to lose) posts at once; no rawText never asks', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Pennywhistle');
  assert.equal(r.c.save(), 'posted');
  const r2 = rig();
  load(r2, file({ rawText: '{\n  "company": "Acme"\n}\n' }));
  r2.c.edit('company', 'Pennywhistle');
  assert.equal(r2.c.save(), 'posted');
});

test('built-in office: Save is Save as; the saveThemeAs reply switches source and adopts', () => {
  const r = rig(null);
  load(r, builtin);
  r.c.edit('company', 'Mine');
  assert.deepEqual(r.c.choices(), ['saveAs']);
  assert.equal(r.c.save(), 'posted');
  const m = lastSave(r);
  assert.equal(m.type, 'saveThemeAs');
  r.host.theme = { company: 'Mine' };
  r.feed({ type: 'settings', settings: { companyName: '', branchName: '', speechBubbles: true, managerName: '', bossQuotes: true } });
  r.feed({ type: 'frontDesk', state: stateOf(file({ label: 'new.json', path: '~/new.json', rev: 'cccccccccccccccc' })), reqId: m.reqId });
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: true });
  assert.equal(r.c.editor.status, 'clean');
  assert.deepEqual(r.c.draft(), { company: 'Mine' });
  assert.equal(r.previews.at(-1), null);
});

test('saveThemeAs cancelled goes back to dirty', () => {
  const r = rig(null);
  load(r, builtin);
  r.c.edit('company', 'Mine');
  r.c.save();
  const m = lastSave(r);
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: true, cancelled: true });
  assert.equal(r.c.editor.status, 'dirty');
});

test('a draft with problems cannot be saved', () => {
  const r = rig();
  load(r, file());
  r.c.edit('colors.wall', 'mauve');
  assert.ok(r.c.errors().length > 0);
  const before = r.posted.length;
  assert.equal(r.c.save(), 'invalid');
  assert.equal(r.posted.length, before);
});

test('conflict: Keep mine then Overwrite anyway sends the newest rev with force', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.c.save();
  const m = lastSave(r);
  r.host.theme = { company: 'Theirs' };
  r.feed({ type: 'frontDesk', state: stateOf(file({ rev: 'bbbbbbbbbbbbbbbb' })), reqId: m.reqId });
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: false, conflict: true });
  assert.equal(r.c.editor.status, 'conflict');
  assert.deepEqual(r.c.choices().length > 0, true);
  r.c.keepMine();
  assert.deepEqual(r.c.choices(), ['overwrite', 'saveAs']);
  assert.equal(r.c.save('overwrite'), 'posted');
  const f = lastSave(r) as { rev: string; force?: true };
  assert.equal(f.rev, 'bbbbbbbbbbbbbbbb');
  assert.equal(f.force, true);
  assert.equal(r.c.draft().company, 'Mine');
});

test('conflict: Load it takes the file version', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.c.save();
  const m = lastSave(r);
  r.host.theme = { company: 'Theirs' };
  r.feed({ type: 'frontDesk', state: stateOf(file({ rev: 'bbbbbbbbbbbbbbbb' })), reqId: m.reqId });
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: false, conflict: true });
  r.c.loadIt();
  assert.equal(r.c.editor.status, 'clean');
  assert.equal(r.c.draft().company, 'Theirs');
  assert.equal(r.previews.at(-1), null);
});

test('a push while dirty shows "changed on disk" without touching the draft; clean follows the host', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.host.theme = { company: 'Disk' };
  r.feed({ type: 'frontDesk', state: stateOf(file({ rev: 'bbbbbbbbbbbbbbbb' })) });
  assert.equal(r.c.editor.status, 'dirty');
  assert.notEqual(r.c.editor.hostRev, r.c.editor.rev);
  assert.equal(r.c.draft().company, 'Mine');
  const r2 = rig();
  load(r2, file());
  r2.host.theme = { company: 'Disk' };
  r2.feed({ type: 'frontDesk', state: stateOf(file({ rev: 'bbbbbbbbbbbbbbbb' })) });
  assert.equal(r2.c.draft().company, 'Disk');
});

test('a source change drops the draft', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.host.theme = null;
  r.feed({ type: 'frontDesk', state: stateOf(builtin) });
  assert.equal(r.c.editor.status, 'clean');
  assert.deepEqual(r.c.draft(), {});
  assert.equal(r.previews.at(-1), null);
});

test('a failed save shows the message and can be retried or dismissed', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.c.save();
  const m = lastSave(r);
  r.feed({ type: 'frontDeskDone', reqId: m.reqId, ok: false, message: 'Disk full' });
  assert.equal(r.c.editor.status, 'error');
  assert.equal(r.c.editor.message, 'Disk full');
  assert.equal(r.c.beforeClose(), false);
  assert.equal(r.c.save(), 'posted');
});

test('discardForClose refuses while a save runs', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'Mine');
  r.c.save();
  assert.equal(r.c.beforeClose(), false);
  assert.equal(r.c.discardForClose(), false);
  assert.equal(r.c.editor.status, 'saving');
});

test('request: replies are matched by reqId; getFrontDesk failure is kept for the retry button', () => {
  const r = rig();
  let got: boolean | null = null;
  const id = r.c.request((reqId) => ({ type: 'setSetting', reqId, key: 'scope', value: 'all' }), (d) => { got = d.ok; });
  r.feed({ type: 'frontDeskDone', reqId: 'other', ok: false });
  assert.equal(got, null);
  r.feed({ type: 'frontDeskDone', reqId: id, ok: true });
  assert.equal(got, true);
  r.c.start();
  const req = r.posted.at(-1) as { reqId: string };
  r.feed({ type: 'frontDeskDone', reqId: req.reqId, ok: false, message: 'Host is busy' });
  assert.equal(r.c.loadError, 'Host is busy');
  r.c.retry();
  assert.equal(r.c.loadError, null);
});

test('restores a saved draft for the same source; keeps "changed on disk" when the rev moved', () => {
  const stored = serializeDraft({ company: 'Unsaved' }, 'file||~/office.json', 'aaaaaaaaaaaaaaaa');
  const r = rig({ company: 'Acme' }, stored);
  load(r, file());
  assert.equal(r.c.editor.status, 'dirty');
  assert.equal(r.c.draft().company, 'Unsaved');
  assert.equal(r.timers.length, 1); // the preview is shown again
  const r2 = rig({ company: 'Acme' }, stored);
  load(r2, file({ rev: 'bbbbbbbbbbbbbbbb' }));
  assert.equal(r2.c.editor.status, 'dirty');
  assert.notEqual(r2.c.editor.hostRev, r2.c.editor.rev);
  const other = rig({ company: 'Acme' }, serializeDraft({ company: 'Unsaved' }, 'file||~/other.json', 'aaaaaaaaaaaaaaaa'));
  load(other, file());
  assert.equal(other.c.editor.status, 'clean');
  assert.equal(other.c.draft().company, 'Acme');
});

test('flush applies a waiting preview now', () => {
  const r = rig();
  load(r, file());
  r.c.edit('company', 'X');
  r.c.flush();
  assert.equal(r.timers.length, 0);
  assert.deepEqual(r.previews, [{ company: 'X' }]);
});

test('setting a field to the value it already has is not an edit (no unsaved changes, nothing kept, no preview)', () => {
  const r = rig({ company: 'Acme' });
  load(r, file());
  r.c.edit('company', 'Acme');
  assert.equal(r.c.isDirty(), false);
  assert.equal(r.timers.length, 0);
  assert.deepEqual(r.saved, []);
  r.c.edit('company', 'Pennywhistle');
  assert.equal(r.c.isDirty(), true);
});
