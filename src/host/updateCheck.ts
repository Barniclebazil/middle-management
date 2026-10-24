// The pure parts of the built-in update check: version comparison, the stored state, reading GitHub's latest-release JSON,
// and which download URLs are trusted. No `vscode` import; the network, the timers and the install live elsewhere.

/** globalState key for the stored `UpdateState`. */
export const UPDATE_STATE_KEY = 'claudeOffice.update';
export const RELEASES_LATEST_URL = 'https://api.github.com/repos/Barniclebazil/middle-management/releases/latest';
/** How often the check runs. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long "Later" hides the notice. */
export const LATER_MS = 3 * 24 * 60 * 60 * 1000;
/** Delay before the first check after activation. */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export const UPDATE_ERROR_OFFLINE = "Couldn't reach GitHub to check for updates.";
export const UPDATE_ERROR_DOWNLOAD = "The download didn't finish. Try again later.";
export const UPDATE_ERROR_SIZE = "The download wasn't the expected size, so it wasn't installed.";
export const UPDATE_ERROR_INSTALL = "VS Code couldn't install the update. See the Middle Management output for details.";
export const UPDATE_NONE_PUBLISHED = 'No releases have been published yet.';
export const UPDATE_RATE_LIMITED = 'GitHub is limiting requests. The office will try again later.';

const REPO_PATH = '/Barniclebazil/middle-management/';
const NOTES_PREFIX = `https://github.com${REPO_PATH}`;
const DOWNLOAD_PATH_PREFIX = `${REPO_PATH}releases/download/`;
const REDIRECT_HOSTS: readonly string[] = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** The `claudeOffice.updateChecks` setting: anything but `'off'` means `'auto'`. */
export type UpdateChecks = 'auto' | 'off';

export function parseUpdateChecks(v: unknown): UpdateChecks {
  return v === 'off' ? 'off' : 'auto';
}

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The pre-release tag (`beta.1` in `1.2.3-beta.1`), when there is one. */
  pre?: string;
}

/** `1.2.3`, `v1.2.3` or `1.2.3-beta.1`; anything else gives undefined. */
export function parseVersion(s: string | undefined): Version | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(s);
  if (!m) return undefined;
  const v: Version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (m[4] !== undefined) v.pre = m[4];
  return v;
}

/** True only when both parse, the candidate is a stable release, and it is above `current` (a pre-release of the same numbers counts as below). */
export function isNewer(candidate: string | undefined, current: string | undefined): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b || a.pre !== undefined) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  return b.pre !== undefined;
}

/** True for an http URL on 127.0.0.1 or localhost with an explicit port (the dev-only mock feed); never true in production. */
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port !== '' && u.username === '' && u.password === '';
}

/** The feed address: always the real releases URL, or a loopback address when `allowLoopback` (development only). */
export function isAllowedFeedUrl(url: string, allowLoopback: boolean): boolean {
  return url === RELEASES_LATEST_URL || (allowLoopback && isLoopbackUrl(url));
}

/**
 * True for an https URL on github.com under this repo's release downloads, or on one of GitHub's redirect hosts.
 * With `allowLoopback` (development only) a loopback address passes too.
 */
export function isAllowedDownloadUrl(url: string, allowLoopback = false): boolean {
  if (allowLoopback && isLoopbackUrl(url)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  if (u.hostname === 'github.com') return u.pathname.startsWith(DOWNLOAD_PATH_PREFIX) && u.pathname.length > DOWNLOAD_PATH_PREFIX.length;
  return REDIRECT_HOSTS.includes(u.hostname);
}

/** True for a release-notes link on this repo's github.com pages. */
export function isAllowedNotesUrl(url: string): boolean {
  return url.startsWith(NOTES_PREFIX);
}

export interface UpdateState {
  v: 1;
  lastChecked?: number;
  latest?: string;
  notesUrl?: string;
  vsixUrl?: string;
  size?: number;
  skipped?: string;
  laterUntil?: number;
}

function isTime(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Whatever globalState returned, made into a valid state. Bad fields are dropped one by one; a wrong shape gives `{ v: 1 }`. */
export function readUpdateState(raw: unknown, allowLoopback = false): UpdateState {
  const state: UpdateState = { v: 1 };
  if (typeof raw !== 'object' || raw === null) return state;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return state;
  if (isTime(r['lastChecked'])) state.lastChecked = r['lastChecked'];
  if (typeof r['latest'] === 'string' && parseVersion(r['latest'])) state.latest = r['latest'];
  if (typeof r['notesUrl'] === 'string' && isAllowedNotesUrl(r['notesUrl'])) state.notesUrl = r['notesUrl'];
  if (typeof r['vsixUrl'] === 'string' && isAllowedDownloadUrl(r['vsixUrl'], allowLoopback)) state.vsixUrl = r['vsixUrl'];
  if (typeof r['size'] === 'number' && Number.isInteger(r['size']) && r['size'] > 0) state.size = r['size'];
  if (typeof r['skipped'] === 'string') state.skipped = r['skipped'];
  if (isTime(r['laterUntil'])) state.laterUntil = r['laterUntil'];
  return state;
}

/** Whether a check is due: never when off; otherwise when never run, a day old, or stamped in the future (the clock moved). */
export function shouldCheck(state: UpdateState, now: number, setting: UpdateChecks): boolean {
  if (setting === 'off') return false;
  if (state.lastChecked === undefined) return true;
  if (state.lastChecked > now) return true;
  return now - state.lastChecked >= CHECK_INTERVAL_MS;
}

export interface ReleaseInfo {
  version: string;
  notesUrl: string;
  vsixUrl: string;
  size: number;
}

export type ParsedRelease = { ok: true; release: ReleaseInfo } | { ok: false; reason: string };

function fail(reason: string): ParsedRelease {
  return { ok: false, reason };
}

/** Reads GitHub's `releases/latest` JSON into the one release this extension would install, or says why not. */
export function parseRelease(json: unknown, allowLoopback = false): ParsedRelease {
  if (typeof json !== 'object' || json === null) return fail('The response was not an object.');
  const j = json as Record<string, unknown>;
  if (j['draft'] === true) return fail('The release is a draft.');
  if (j['prerelease'] === true) return fail('The release is a pre-release.');
  const tag = j['tag_name'];
  if (typeof tag !== 'string') return fail('The release has no tag.');
  const parsed = parseVersion(tag);
  if (!parsed) return fail('The release tag is not a version.');
  if (parsed.pre !== undefined) return fail('The release tag has a pre-release part.');
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const notesUrl = j['html_url'];
  if (typeof notesUrl !== 'string' || !isAllowedNotesUrl(notesUrl)) return fail('The release page is not on the expected repository.');
  if (!Array.isArray(j['assets'])) return fail('The release has no assets.');
  const wanted = `middle-management-${version}.vsix`;
  const asset = (j['assets'] as unknown[]).find(
    (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && (a as Record<string, unknown>)['name'] === wanted,
  );
  if (!asset) return fail(`The release has no ${wanted} file.`);
  const size = asset['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return fail('The file has no valid size.');
  const url = asset['browser_download_url'];
  if (typeof url !== 'string' || !isAllowedDownloadUrl(url, allowLoopback)) return fail('The download address is not trusted.');
  return { ok: true, release: { version, notesUrl, vsixUrl: url, size } };
}

/** True while the notice should stay quiet: this version was skipped, or "Later" has not run out. */
export function noticeHidden(state: UpdateState, version: string, now: number): boolean {
  return state.skipped === version || (state.laterUntil !== undefined && state.laterUntil > now);
}

export function afterLater(state: UpdateState, now: number): UpdateState {
  return { ...state, laterUntil: now + LATER_MS };
}

/** Skips `version` for good (until a newer one) and clears any "Later" delay. */
export function afterSkip(state: UpdateState, version: string): UpdateState {
  const { laterUntil: _dropped, ...rest } = state;
  return { ...rest, skipped: version };
}

/** Records a finished check; the release fields are stored, or cleared when there is no release to offer. */
export function afterCheck(state: UpdateState, now: number, release: ReleaseInfo | undefined): UpdateState {
  const { latest: _l, notesUrl: _n, vsixUrl: _v, size: _s, ...rest } = state;
  const next: UpdateState = { ...rest, lastChecked: now };
  if (release) {
    next.latest = release.version;
    next.notesUrl = release.notesUrl;
    next.vsixUrl = release.vsixUrl;
    next.size = release.size;
  }
  return next;
}

export function availableMessage(latest: string, current: string): string {
  return `Middle Management ${latest} is out. You have ${current}.`;
}
