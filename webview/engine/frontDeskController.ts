/**
 * The Front desk panel's state (task 3.10), without a DOM: the draft, the editor state machine, the host's state, the
 * debounced preview, the draft's persistence and the request bookkeeping. `frontDeskPanel.ts` renders it; tests drive it with a
 * fake host (`test/engine-frontDeskController.test.ts`).
 *
 * The controller lives as long as the `PanelView` (the drawer unmounts and re-mounts a view, for example while a detail
 * view is pushed on top), so the draft survives that. Wiring, after `docs/manager-mode.md` section 17:
 *   - `start()` on every mount asks the host for the state (`getFrontDesk`);
 *   - every host message goes to `receive(msg)`: `frontDesk` (reply or push), `frontDeskDone` (matched by `reqId`) and
 *     `settings` (a clean draft follows the host's theme);
 *   - a source change (`sourceKey` differs) or the editor's `'adopt'` effect resets the draft from `host.hostTheme()` and
 *     clears the preview.
 */
import type { FrontDeskState, HostToWebview, WebviewToHost } from '../../src/shared/protocol.ts';
import type { OfficeTheme } from '../../src/shared/theme.ts';
import {
  canClose, draftChanged, draftErrors, draftFrom, editorStep, initialEditorState, previewTheme, restoreDraft, saveChoices, saveMessage,
  serializeDraft, setField, sourceKey, toThemeJson,
} from './frontDeskLogic.ts';
import type { Draft, EditorEvent, EditorState, FieldValue, SaveChoice } from './frontDeskLogic.ts';
import { RequestTracker, dropLinesFor, reqIdFactory } from './frontDeskView.ts';
import type { DoneResult } from './frontDeskView.ts';

/** What the controller needs from outside. All of it is injected so the controller runs in Node. */
export interface ControllerHost {
  /** The theme the host last sent, or null for the built-in office (`FrontDeskCtx.hostTheme`). */
  hostTheme(): OfficeTheme | null;
  post(msg: WebviewToHost): void;
  /** Show a draft in the office, or `null` to go back to the host's theme (`FrontDeskCtx.preview`). */
  preview(theme: OfficeTheme | null): void;
  /** The saved draft text from the webview's saved state (read once, when the first state arrives). */
  loadState(): unknown;
  /** Keep (text) or drop (null) the draft in the webview's saved state. */
  saveState(text: string | null): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Preview debounce. Default 120 ms. */
  previewDelayMs?: number;
  /** Request id factory. Default `fd1`, `fd2`, ... */
  nextReqId?(): string;
}

/** Why listeners are called. `draft` = an edit, `state` = a new host state, `adopt` = the draft was replaced, `editor` = status, banner, footer or prompt changed. */
export type ChangeReason = 'draft' | 'state' | 'adopt' | 'editor';

/** A save waiting for the user to confirm what it would drop. */
export interface PendingConfirm {
  choice: SaveChoice;
  lines: string[];
}

/** The smaller surface tabs get (see `FrontDeskTabApi` in `frontDeskPanel.ts`). */
export interface TabApi {
  /** The draft as it is now. Never mutate it; use `edit` or `update`. */
  draft(): Draft;
  /** Sets one field (`setField` paths: `company`, `colors.wall`, `staff-2.look.hair`, ...). Empty text and null clear it. */
  edit(path: string, value: FieldValue): void;
  /** Replaces the draft with `fn(draft)` (for `resetLook`, `resetColors`, `clearField`). Returning the same object is a no-op. */
  update(fn: (draft: Draft) => Draft): void;
  /** The newest state from the host. */
  hostState(): FrontDeskState;
  /** The theme the host last sent (null = built-in office). */
  hostTheme(): OfficeTheme | null;
  /** True while there are unsaved edits (dirty, saving, conflict or error). */
  isDirty(): boolean;
  /** Sends a request built with a fresh `reqId`; `onDone` gets the matching `frontDeskDone`. Returns the `reqId`. */
  request(build: (reqId: string) => WebviewToHost, onDone?: (r: DoneResult) => void): string;
}

export class FrontDeskController implements TabApi {
  private readonly host: ControllerHost;
  private readonly tracker = new RequestTracker();
  private readonly nextReqId: () => string;
  private readonly listeners = new Set<(reason: ChangeReason) => void>();
  private readonly confirmed = new Set<string>();
  private previewTimer: unknown = null;
  private draftNow: Draft = {};
  private stateNow: FrontDeskState | null = null;

  /** The editor state machine's state. Read-only for the panel; change it with the methods below. */
  editor: EditorState = initialEditorState();
  /** Set while a save waits for the "this will be dropped" confirmation. */
  confirming: PendingConfirm | null = null;
  /** A failure that happened before anything was sent (for example a theme too big to save). */
  notice: string | null = null;
  /** True while the inline "Keep editing / Discard" prompt is shown. */
  closePrompt = false;
  /** The failure text when `getFrontDesk` failed and no state has arrived. */
  loadError: string | null = null;

  constructor(host: ControllerHost) {
    this.host = host;
    this.nextReqId = host.nextReqId ?? reqIdFactory();
  }

  // -- Reading -----------------------------------------------------------------

  draft(): Draft {
    return this.draftNow;
  }

  /** The host's state, or null before the first `frontDesk`. */
  state(): FrontDeskState | null {
    return this.stateNow;
  }

  hostState(): FrontDeskState {
    if (this.stateNow === null) throw new Error('Front desk state has not arrived yet');
    return this.stateNow;
  }

  hostTheme(): OfficeTheme | null {
    return this.host.hostTheme();
  }

  isDirty(): boolean {
    return this.editor.status !== 'clean';
  }

  /** `draftErrors` of the current draft (what blocks Save). */
  errors(): string[] {
    return draftErrors(this.draftNow);
  }

  onChange(listener: (reason: ChangeReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(reason: ChangeReason): void {
    if (this.editor.status === 'clean') this.closePrompt = false;
    for (const l of [...this.listeners]) l(reason);
  }

  // -- Requests ----------------------------------------------------------------

  request(build: (reqId: string) => WebviewToHost, onDone?: (r: DoneResult) => void): string {
    const reqId = this.nextReqId();
    if (onDone !== undefined) this.tracker.register(reqId, onDone);
    this.host.post(build(reqId));
    return reqId;
  }

  /** Called on every mount: asks the host for the state. A clean draft is re-read from the host's theme first. */
  start(): void {
    if (this.stateNow !== null && this.editor.status === 'clean') this.adopt('adopt');
    this.loadError = null;
    this.request((reqId) => ({ type: 'getFrontDesk', reqId }), (r) => {
      if (!r.ok) {
        this.loadError = r.message ?? 'Could not load the Front desk.';
        this.emit('editor');
      }
    });
  }

  /** Retry after `loadError`. */
  retry(): void {
    this.start();
    this.emit('editor');
  }

  // -- Host messages -----------------------------------------------------------

  /** Feed every host message here; those the Front desk does not care about are ignored. */
  receive(msg: HostToWebview): void {
    if (msg.type === 'frontDesk') {
      this.applyState(msg.state);
    } else if (msg.type === 'frontDeskDone') {
      const r: DoneResult = { ok: msg.ok };
      if (msg.message !== undefined) r.message = msg.message;
      if (msg.conflict === true) r.conflict = true;
      if (msg.cancelled === true) r.cancelled = true;
      this.tracker.resolve(msg.reqId, r);
    } else if (msg.type === 'settings') {
      // A clean draft is just the host's theme: follow it (the file may have changed, or a save finished).
      if (this.stateNow !== null && this.editor.status === 'clean' && draftChanged(this.draftNow, this.host.hostTheme())) this.adopt('adopt');
    }
  }

  private applyState(next: FrontDeskState): void {
    const prev = this.stateNow;
    this.stateNow = next;
    this.loadError = null;
    const rev = next.source.rev;
    if (prev === null) {
      this.draftNow = draftFrom(this.host.hostTheme());
      this.editor = initialEditorState(rev);
      this.restoreSaved(next, rev);
      this.emit('adopt');
      return;
    }
    const sourceChanged = sourceKey(prev.source) !== sourceKey(next.source);
    if (sourceChanged) this.confirmed.clear();
    const step = editorStep(this.editor, sourceChanged ? { type: 'sourceChanged', ...(rev !== undefined ? { rev } : {}) } : { type: 'hostTheme', ...(rev !== undefined ? { rev } : {}) });
    const before = this.editor;
    this.editor = step.state;
    if (step.effect === 'adopt') {
      this.confirming = null;
      this.notice = null;
      this.adopt('adopt');
    } else {
      if (before.status !== this.editor.status || before.hostRev !== this.editor.hostRev || before.keepMine !== this.editor.keepMine) this.confirming = null;
      this.emit('state');
    }
  }

  /** The draft saved by an earlier session of the webview, when it belongs to this source and differs from the host's theme. */
  private restoreSaved(next: FrontDeskState, rev: string | undefined): void {
    const raw = this.host.loadState();
    const saved = restoreDraft(raw, sourceKey(next.source));
    if (saved === null || !draftChanged(saved.draft, this.host.hostTheme())) {
      // A saved draft that is not coming back (another theme source, too big, junk, or the same as the host's theme) is dropped
      // now, so it does not sit in the webview's saved state.
      if (raw !== undefined && raw !== null) this.host.saveState(null);
      return;
    }
    this.draftNow = saved.draft;
    let ed = editorStep(initialEditorState(saved.rev), { type: 'edit' }).state;
    ed = editorStep(ed, { type: 'hostTheme', ...(rev !== undefined ? { rev } : {}) }).state;
    this.editor = ed;
    this.schedulePreview();
  }

  // -- Editing -----------------------------------------------------------------

  edit(path: string, value: FieldValue): void {
    this.update((d) => setField(d, path, value));
  }

  update(fn: (draft: Draft) => Draft): void {
    if (this.stateNow === null) return;
    const next = fn(this.draftNow);
    if (next === this.draftNow) return;
    this.draftNow = next;
    // Setting a field to the value it already has (a blur that changed nothing) is not an edit: no "Unsaved changes", nothing to keep.
    if (this.editor.status === 'clean' && !draftChanged(next, this.host.hostTheme())) return;
    this.confirming = null;
    this.notice = null;
    this.stepEditor({ type: 'edit', matchesHost: !draftChanged(next, this.host.hostTheme()) });
    this.schedulePreview();
    this.persist();
    this.emit('draft');
  }

  private stepEditor(ev: EditorEvent): void {
    const step = editorStep(this.editor, ev);
    this.editor = step.state;
    if (step.effect === 'adopt') this.adopt('adopt');
  }

  /** Replaces the draft with the host's theme and clears the preview. */
  private adopt(reason: ChangeReason): void {
    this.draftNow = draftFrom(this.host.hostTheme());
    this.clearPreviewTimer();
    this.host.preview(null);
    this.host.saveState(null);
    this.emit(reason);
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer !== null) {
      this.host.clearTimer(this.previewTimer);
      this.previewTimer = null;
    }
  }

  private schedulePreview(): void {
    this.clearPreviewTimer();
    this.previewTimer = this.host.setTimer(() => {
      this.previewTimer = null;
      this.applyPreview();
    }, this.host.previewDelayMs ?? 120);
  }

  private applyPreview(): void {
    this.host.preview(draftChanged(this.draftNow, this.host.hostTheme()) ? previewTheme(this.draftNow) : null);
  }

  /** Applies a waiting preview now (the panel is unmounting but the draft stays). */
  flush(): void {
    if (this.previewTimer === null) return;
    this.clearPreviewTimer();
    this.applyPreview();
  }

  private persist(): void {
    if (this.editor.status === 'clean' || this.stateNow === null) {
      this.host.saveState(null);
      return;
    }
    this.host.saveState(serializeDraft(this.draftNow, sourceKey(this.stateNow.source), this.editor.rev));
  }

  // -- Banner and footer actions --------------------------------------------------

  /** "Load it": replace the draft with the file's current version. */
  loadIt(): void {
    this.confirming = null;
    this.notice = null;
    this.stepEditor({ type: 'loadIt' });
    this.emit('editor');
  }

  /** "Keep mine": keep editing; the next save is Overwrite anyway or Save as. */
  keepMine(): void {
    this.stepEditor({ type: 'keepMine' });
    this.persist();
    this.emit('editor');
  }

  /** "Discard": drop the edits and show the host's theme again. */
  discard(): void {
    if (this.editor.status === 'saving') return;
    this.confirming = null;
    this.notice = null;
    this.stepEditor({ type: 'discard' });
    this.closePrompt = false;
    this.emit('editor');
  }

  dismissError(): void {
    this.stepEditor({ type: 'dismissError' });
    this.emit('editor');
  }

  // -- Saving ------------------------------------------------------------------

  /** The save buttons now (same as `saveChoices`). */
  choices(): SaveChoice[] {
    return this.stateNow === null ? [] : saveChoices(this.editor, this.stateNow.source);
  }

  /**
   * Save with `choice` (default: the first button). Returns what happened: `'posted'` (sent), `'confirm'` (the drop list is
   * waiting for a yes: see `confirming`), `'invalid'` (the draft has problems) or `'ignored'` (nothing to save, or
   * the choice is not on offer).
   */
  save(choice?: SaveChoice): 'posted' | 'confirm' | 'invalid' | 'ignored' {
    const state = this.stateNow;
    if (state === null || (this.editor.status !== 'dirty' && this.editor.status !== 'error')) return 'ignored';
    const choices = saveChoices(this.editor, state.source);
    const pick = choice ?? choices[0];
    if (pick === undefined || !choices.includes(pick)) return 'ignored';
    if (draftErrors(this.draftNow).length > 0) return 'invalid';
    const json = toThemeJson(this.draftNow);
    if (!json.ok) {
      this.notice = json.error;
      this.emit('editor');
      return 'invalid';
    }
    const lines = dropLinesFor(pick, state.source, this.draftNow);
    if (lines.length > 0 && !this.confirmed.has(sourceKey(state.source))) {
      this.confirming = { choice: pick, lines };
      this.emit('editor');
      return 'confirm';
    }
    return this.post(pick, json.json);
  }

  /** The user said yes to the drop list. */
  confirmSave(): void {
    const c = this.confirming;
    if (c === null || this.stateNow === null) return;
    this.confirmed.add(sourceKey(this.stateNow.source));
    this.confirming = null;
    this.save(c.choice);
  }

  cancelConfirm(): void {
    if (this.confirming === null) return;
    this.confirming = null;
    this.emit('editor');
  }

  private post(choice: SaveChoice, themeJson: string): 'posted' | 'invalid' {
    const reqId = this.nextReqId();
    const msg = saveMessage(this.editor, choice, reqId, themeJson);
    if (msg === null) {
      this.notice = 'There is no saved version to compare with yet. Reload the theme and try again.';
      this.emit('editor');
      return 'invalid';
    }
    this.notice = null;
    this.stepEditor({ type: 'saveRequested', choice });
    this.tracker.register(reqId, (r) => {
      const ev: EditorEvent = { type: 'done', ok: r.ok };
      if (r.message !== undefined) ev.message = r.message;
      if (r.conflict === true) ev.conflict = true;
      if (r.cancelled === true) ev.cancelled = true;
      this.stepEditor(ev);
      this.persist();
      this.emit('editor');
    });
    this.host.post(msg);
    this.emit('editor');
    return 'posted';
  }

  // -- Closing -----------------------------------------------------------------

  /** `PanelView.beforeClose`: true when nothing is unsaved; otherwise shows the prompt and vetoes. */
  beforeClose(): boolean {
    if (canClose(this.editor)) return true;
    this.closePrompt = true;
    this.emit('editor');
    return false;
  }

  /** "Keep editing" on the close prompt. */
  keepEditing(): void {
    this.closePrompt = false;
    this.emit('editor');
  }

  /** "Discard" on the close prompt. Returns true when the panel may close now (false while a save runs). */
  discardForClose(): boolean {
    if (this.editor.status === 'saving') return false;
    this.discard();
    this.closePrompt = false;
    this.host.saveState(null);
    return canClose(this.editor);
  }
}
