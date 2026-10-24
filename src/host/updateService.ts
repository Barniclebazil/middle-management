// The update service: once a day asks GitHub for the latest release, keeps the result in globalState (shared by every window,
// so it is always re-read before deciding) and, when the user agrees, downloads the .vsix and hands it to VS Code to install.
//
// Schedule: `start()` posts the current info, arms one check after `FIRST_CHECK_DELAY_MS` when a check is due, and an hourly
// tick that checks whenever one is due (a day since the last recorded check, setting `auto`). A forced check (the user asked)
// ignores the limit and clears "Later" and "Skip". A network failure on an automatic check records nothing, so the next hourly
// tick tries again; a rate limit or "no release yet" records the check, so the next try is a day away.
//
// No `vscode` import. The network, the clock, the timers, the storage and the file system are all injected. Logs carry error
// names and states only, never messages (they may carry paths).
import type { HostToWebview, UpdateAction, UpdateInfo, UpdateStatus } from '../shared/protocol.ts';
import {
  FIRST_CHECK_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  UPDATE_ERROR_DOWNLOAD,
  UPDATE_ERROR_INSTALL,
  UPDATE_ERROR_OFFLINE,
  UPDATE_ERROR_SIZE,
  UPDATE_NONE_PUBLISHED,
  UPDATE_RATE_LIMITED,
  UPDATE_STATE_KEY,
  afterCheck,
  afterLater,
  afterSkip,
  isAllowedDownloadUrl,
  isAllowedFeedUrl,
  isAllowedNotesUrl,
  isNewer,
  noticeHidden,
  parseRelease,
  readUpdateState,
  shouldCheck,
} from './updateCheck.ts';
import type { UpdateChecks, UpdateState } from './updateCheck.ts';

/** How often the service looks again whether a check is due. */
export const RECHECK_TICK_MS = 60 * 60 * 1000;
/** The largest .vsix the service will download. */
export const MAX_VSIX_BYTES = 100 * 1024 * 1024;
/** How long a download may take. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** The part of a `fetch` Response the service uses. */
export interface UpdateResponse {
  ok: boolean;
  status: number;
  /** The final address, after redirects. */
  url: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type UpdateFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<UpdateResponse>;

export interface UpdateServiceDeps {
  /** The running extension version, e.g. "0.5.0". */
  currentVersion: string;
  /** Normally `RELEASES_LATEST_URL`; a loopback address only with `allowLoopback`. */
  feedUrl: string;
  /** Development only: the feed and the download may be `http://127.0.0.1:<port>` or `http://localhost:<port>`. */
  allowLoopback: boolean;
  fetch: UpdateFetch;
  now: () => number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** globalState (`get` / `update`). */
  storage: { get(key: string): unknown; set(key: string, value: unknown): Thenable<void> | void };
  /** The `claudeOffice.updateChecks` setting. */
  readSetting: () => UpdateChecks;
  post: (msg: HostToWebview) => void;
  log: (line: string) => void;
  /** Writes the file under the extension's `updates/` folder and returns the full path. */
  writeFile(name: string, data: Uint8Array): Promise<string>;
  deleteFile(path: string): Promise<void>;
  /** Installs the .vsix at `path` (`workbench.extensions.installExtension`). */
  install(path: string): Promise<void>;
  /** Reloads the window (after an install). */
  reload(): void;
  /** Opens an address in the user's browser. Only ever called with the stored, allow-listed release page. */
  openExternal(url: string): void;
}

type Transient = Extract<UpdateStatus, 'checking' | 'downloading' | 'installed' | 'error'>;

/** A failure with the text the user sees. */
class Failure extends Error {
  readonly shown: string;
  constructor(shown: string, why: string) {
    super(why);
    this.shown = shown;
  }
}

export class UpdateService {
  readonly #d: UpdateServiceDeps;
  #started = false;
  #disposed = false;
  #firstTimer: unknown;
  #tickTimer: unknown;
  /** True while a feed request is in flight. */
  #checking = false;
  /** True when the user asked for the check in flight (so its result is shown even if it began automatically). */
  #forced = false;
  #installing = false;
  #transient: Transient | undefined;
  #message: string | undefined;
  /** The last check found no release at all (404). Not stored; after a restart the office just says "up to date". */
  #noReleases = false;
  #loggedNone = false;
  #lastPosted: string | undefined;

  constructor(deps: UpdateServiceDeps) {
    this.#d = deps;
  }

  // --- public API -----------------------------------------------------------------------------------------------------

  /** Post the current info and arm the first check and the hourly tick. */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#post();
    this.#armFirst();
    this.#armTick();
  }

  /** What the office shows now, built from the stored state and the transient status. */
  info(): UpdateInfo {
    const state = this.#read();
    const now = this.#d.now();
    const current = this.#d.currentVersion;
    const newer = state.latest !== undefined && isNewer(state.latest, current);
    let status: UpdateStatus;
    if (this.#transient !== undefined) status = this.#transient;
    else if (newer) status = 'available';
    else if (state.lastChecked !== undefined && !this.#noReleases) status = 'upToDate';
    else status = 'idle';
    const out: UpdateInfo = { status, current, auto: this.#d.readSetting() === 'auto' };
    if (state.latest !== undefined) out.latest = state.latest;
    if (state.notesUrl !== undefined) out.notesUrl = state.notesUrl;
    if (state.lastChecked !== undefined) out.checkedAt = state.lastChecked;
    if (newer && state.latest !== undefined) out.hidden = noticeHidden(state, state.latest, now);
    if (this.#transient === 'error' && this.#message !== undefined) out.message = this.#message;
    else if (status === 'idle' && this.#noReleases) out.message = UPDATE_NONE_PUBLISHED;
    return out;
  }

  /** Ask GitHub for the latest release. `force` is a user request: it shows progress and the result, and clears Later and Skip. */
  async check(force: boolean): Promise<void> {
    if (this.#disposed || this.#installing || this.#transient === 'installed') return;
    if (this.#checking) {
      // One request at a time. A user request that arrives during an automatic one takes it over: it shows progress and its result.
      if (force && !this.#forced) {
        this.#forced = true;
        await this.#clearHiding();
        this.#transient = 'checking';
        this.#post();
      }
      return;
    }
    this.#checking = true;
    this.#forced = force;
    try {
      if (force) {
        await this.#clearHiding();
        this.#transient = 'checking';
        this.#message = undefined;
        this.#post();
      }
      await this.#runCheck();
    } finally {
      this.#checking = false;
      this.#forced = false;
    }
  }

  /** The webview's `updateAction`. */
  async handle(action: UpdateAction): Promise<void> {
    if (this.#disposed) return;
    switch (action) {
      case 'check':
        await this.check(true);
        return;
      case 'install':
        await this.install();
        return;
      case 'later': {
        await this.#save(afterLater(this.#read(), this.#d.now()));
        this.#post();
        return;
      }
      case 'skip': {
        const state = this.#read();
        if (state.latest === undefined) return;
        await this.#save(afterSkip(state, state.latest));
        this.#post();
        return;
      }
      case 'reload':
        if (this.#transient === 'installed') this.#d.reload();
        return;
      case 'notes': {
        // The webview never sends an address: the host opens the one it stored, and only if it is on the expected repository.
        const url = this.#read().notesUrl;
        if (url === undefined || !isAllowedNotesUrl(url)) return;
        try {
          this.#d.openExternal(url);
        } catch (e) {
          this.#d.log(`update: opening the release notes failed (${e instanceof Error ? e.name : 'error'})`);
        }
        return;
      }
    }
  }

  /** Download the newer .vsix and install it. Only while an update is available (or after a failed try at one). */
  async install(): Promise<void> {
    if (this.#disposed || this.#installing || this.#checking) return;
    if (this.#transient !== undefined && this.#transient !== 'error') return;
    const state = this.#read();
    if (state.latest === undefined || state.vsixUrl === undefined || state.size === undefined) return;
    if (!isNewer(state.latest, this.#d.currentVersion)) return;
    const { latest, vsixUrl, size } = state;
    this.#installing = true;
    this.#transient = 'downloading';
    this.#message = undefined;
    this.#post();
    let path: string | undefined;
    try {
      if (size > MAX_VSIX_BYTES) throw new Failure(UPDATE_ERROR_SIZE, 'size above the limit');
      let res: UpdateResponse;
      try {
        res = await this.#d.fetch(vsixUrl, {
          headers: { Accept: 'application/octet-stream', 'User-Agent': `middle-management/${this.#d.currentVersion}` },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (e) {
        throw new Failure(UPDATE_ERROR_DOWNLOAD, `download request failed (${errName(e)})`);
      }
      if (!isAllowedDownloadUrl(res.url, this.#d.allowLoopback)) throw new Failure(UPDATE_ERROR_DOWNLOAD, 'final address not trusted');
      if (!res.ok) throw new Failure(UPDATE_ERROR_DOWNLOAD, `download status ${res.status}`);
      let buf: ArrayBuffer;
      try {
        buf = await res.arrayBuffer();
      } catch (e) {
        throw new Failure(UPDATE_ERROR_DOWNLOAD, `download body failed (${errName(e)})`);
      }
      if (buf.byteLength !== size || buf.byteLength > MAX_VSIX_BYTES) throw new Failure(UPDATE_ERROR_SIZE, 'size mismatch');
      if (this.#disposed) return;
      try {
        path = await this.#d.writeFile(`middle-management-${latest}.vsix`, new Uint8Array(buf));
      } catch (e) {
        throw new Failure(UPDATE_ERROR_DOWNLOAD, `saving the file failed (${errName(e)})`);
      }
      if (this.#disposed) return;
      try {
        await this.#d.install(path);
      } catch (e) {
        throw new Failure(UPDATE_ERROR_INSTALL, `install failed (${errName(e)})`);
      }
      this.#d.log(`update: ${latest} installed`);
      this.#transient = 'installed';
      this.#message = undefined;
      this.#post();
    } catch (e) {
      const shown = e instanceof Failure ? e.shown : UPDATE_ERROR_DOWNLOAD;
      this.#d.log(`update: install failed: ${e instanceof Failure ? e.message : errName(e)}`);
      this.#transient = 'error';
      this.#message = shown;
      this.#post();
    } finally {
      this.#installing = false;
      if (path !== undefined) {
        try {
          await this.#d.deleteFile(path);
        } catch (e) {
          this.#d.log(`update: deleting the download failed (${errName(e)})`);
        }
      }
    }
  }

  /** The `claudeOffice.updateChecks` setting changed. */
  settingChanged(): void {
    if (this.#disposed) return;
    this.#post();
    if (this.#started && this.#due()) this.#armFirst();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clear(this.#firstTimer);
    this.#clear(this.#tickTimer);
    this.#firstTimer = undefined;
    this.#tickTimer = undefined;
  }

  // --- checking -------------------------------------------------------------------------------------------------------

  async #runCheck(): Promise<void> {
    const d = this.#d;
    if (!isAllowedFeedUrl(d.feedUrl, d.allowLoopback)) {
      d.log('update: the feed address is not trusted, so no check was made');
      this.#failedCheck(UPDATE_ERROR_OFFLINE);
      return;
    }
    let res: UpdateResponse;
    let body: unknown;
    try {
      res = await d.fetch(d.feedUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `middle-management/${d.currentVersion}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      body = res.ok ? await res.json() : undefined;
    } catch (e) {
      d.log(`update: check failed (${errName(e)})`);
      if (!this.#disposed) this.#failedCheck(UPDATE_ERROR_OFFLINE);
      return;
    }
    if (this.#disposed) return;
    const now = d.now();
    if (res.ok && res.status === 200) {
      const parsed = parseRelease(body, d.allowLoopback);
      if (parsed.ok) {
        await this.#save(afterCheck(this.#read(), now, parsed.release));
        d.log(`update: latest is ${parsed.release.version}`);
      } else {
        d.log(`update: release not usable: ${parsed.reason}`);
        await this.#save(afterCheck(this.#read(), now, undefined));
      }
      this.#noReleases = false;
      this.#finishCheck();
      return;
    }
    if (res.status === 404) {
      await this.#save(afterCheck(this.#read(), now, undefined));
      this.#noReleases = true;
      if (!this.#loggedNone) {
        this.#loggedNone = true;
        d.log('update: no release published yet');
      }
      this.#finishCheck();
      return;
    }
    if (res.status === 403 || res.status === 429) {
      d.log(`update: rate limited (${res.status})`);
      await this.#save({ ...this.#read(), lastChecked: now });
      if (this.#forced) this.#failedCheck(UPDATE_RATE_LIMITED);
      else this.#post();
      return;
    }
    d.log(`update: check got status ${res.status}`);
    this.#failedCheck(UPDATE_ERROR_OFFLINE);
  }

  /** A check that ended with a result: the transient state goes, and the new info is posted. */
  #finishCheck(): void {
    this.#transient = undefined;
    this.#message = undefined;
    this.#post();
  }

  /** A check that failed. Forced: shown as an error. Automatic: quiet, and the previous info stays. */
  #failedCheck(text: string): void {
    if (this.#forced) {
      this.#transient = 'error';
      this.#message = text;
    } else if (this.#transient === 'checking') {
      this.#transient = undefined;
    }
    this.#post();
  }

  async #clearHiding(): Promise<void> {
    const { skipped: _s, laterUntil: _l, ...rest } = this.#read();
    await this.#save(rest);
  }

  // --- timers ---------------------------------------------------------------------------------------------------------

  #due(): boolean {
    return shouldCheck(this.#read(), this.#d.now(), this.#d.readSetting());
  }

  #armFirst(): void {
    this.#clear(this.#firstTimer);
    this.#firstTimer = undefined;
    if (this.#disposed || !this.#due()) return;
    this.#firstTimer = this.#d.timers.setTimeout(() => {
      this.#firstTimer = undefined;
      this.#checkIfDue();
    }, FIRST_CHECK_DELAY_MS);
  }

  #armTick(): void {
    if (this.#disposed) return;
    this.#tickTimer = this.#d.timers.setTimeout(() => {
      this.#tickTimer = undefined;
      this.#checkIfDue();
      this.#armTick();
    }, RECHECK_TICK_MS);
  }

  /** The state is read afresh each time: another window may have checked since. */
  #checkIfDue(): void {
    if (this.#disposed || !this.#due()) return;
    void this.check(false);
  }

  #clear(handle: unknown): void {
    if (handle !== undefined) this.#d.timers.clearTimeout(handle);
  }

  // --- state ----------------------------------------------------------------------------------------------------------

  #read(): UpdateState {
    return readUpdateState(this.#d.storage.get(UPDATE_STATE_KEY), this.#d.allowLoopback);
  }

  async #save(state: UpdateState): Promise<void> {
    try {
      await this.#d.storage.set(UPDATE_STATE_KEY, state);
    } catch (e) {
      this.#d.log(`update: saving the state failed (${errName(e)})`);
    }
  }

  #post(): void {
    if (this.#disposed) return;
    const info = this.info();
    const key = JSON.stringify(info);
    if (key === this.#lastPosted) return;
    this.#lastPosted = key;
    try {
      this.#d.post({ type: 'update', update: info });
    } catch (e) {
      this.#d.log(`update: post failed (${errName(e)})`);
    }
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'error';
}
