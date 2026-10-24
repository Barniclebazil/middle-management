/**
 * Update notice: what the in-office "new version available" cue, the interoffice memo and the Front desk About tab show.
 * Pure helpers (no DOM); the host owns the facts (`UpdateInfo`), this only turns them into words and buttons.
 */
import type { UpdateAction, UpdateInfo } from '../../src/shared/protocol.ts';

/** True while the office should hint at an update: a new version that was not put off, or an install waiting for a reload. */
export function showUpdateCue(u: UpdateInfo | undefined): boolean {
  if (!u) return false;
  if (u.status === 'installed') return true;
  return u.status === 'available' && !u.hidden;
}

/** What the receptionist says while the cue is on (kept short, like the lines in lines.ts). */
export function receptionistUpdateLine(u: UpdateInfo | undefined): string | undefined {
  if (!showUpdateCue(u)) return undefined;
  return u?.status === 'installed' ? 'Reload to finish!' : 'Post from head office!';
}

export interface MemoButton {
  action: UpdateAction | 'close';
  label: string;
  /** `link` is a quiet text link (the release notes), not a button. */
  kind: 'primary' | 'secondary' | 'ghost' | 'link';
}

/** The release-notes link: the host opens the address it stored, the webview never sees or sends one. */
const NOTES_LINK: MemoButton = { action: 'notes', label: 'Release notes', kind: 'link' };

export interface UpdateMemo {
  heading: string;
  from: string;
  to: string;
  subject: string;
  paragraphs: string[];
  buttons: MemoButton[];
  /** True while the install runs: the view shows the memo without action buttons. */
  busy: boolean;
  notesUrl?: string;
}

/** The memo for the current status, or undefined when there is nothing to say. `names.company` is not used in the text yet. */
export function updateMemo(u: UpdateInfo, names: { company: string; branch: string }): UpdateMemo | undefined {
  const branch = names.branch.trim();
  const base = {
    heading: 'INTEROFFICE MEMO',
    from: 'Head Office',
    to: branch ? `All staff, ${branch}` : 'All staff',
  };
  const latest = u.latest || 'the newest version';
  switch (u.status) {
    case 'available': {
      const memo: UpdateMemo = {
        ...base,
        subject: 'New version of the office',
        paragraphs: [
          `Head office has sent over a new version of the office: ${latest} is out, and you have ${u.current}.`,
          'Installing takes a moment and the window reloads afterwards. Nothing about your work changes.',
        ],
        buttons: [
          { action: 'install', label: 'Install now', kind: 'primary' },
          { action: 'later', label: 'Remind me later', kind: 'secondary' },
          { action: 'skip', label: 'Skip this version', kind: 'ghost' },
        ],
        busy: false,
      };
      if (u.notesUrl) {
        memo.notesUrl = u.notesUrl;
        memo.buttons.push(NOTES_LINK);
      }
      return memo;
    }
    case 'downloading':
      return {
        ...base,
        subject: 'New version of the office',
        paragraphs: [`Downloading version ${latest}…`],
        buttons: [],
        busy: true,
      };
    case 'installed':
      return {
        ...base,
        subject: 'New version installed',
        paragraphs: [`Version ${latest} is installed. Reload the window to start using it.`],
        buttons: [
          { action: 'reload', label: 'Reload now', kind: 'primary' },
          { action: 'close', label: 'Not now', kind: 'ghost' },
        ],
        busy: false,
      };
    case 'checking':
      // Only seen in the memo after its "Try again": it stays open, without buttons, until the check answers.
      return {
        ...base,
        subject: 'New version of the office',
        paragraphs: ['Checking with head office…'],
        buttons: [],
        busy: true,
      };
    case 'error':
      return {
        ...base,
        subject: 'The update did not go through',
        paragraphs: [u.message || 'Something went wrong while updating. Please try again.'],
        buttons: [
          { action: 'check', label: 'Try again', kind: 'secondary' },
          { action: 'close', label: 'Close', kind: 'ghost' },
        ],
        busy: false,
      };
    default:
      return undefined;
  }
}

export interface AboutView {
  versionLine: string;
  lastChecked: string;
  statusLine: string;
  buttons: MemoButton[];
  checking: boolean;
  autoLine: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "2 weeks ago", "3 months ago". */
export function relativeTime(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'just now';
  if (d < HOUR) {
    const m = Math.floor(d / MIN);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  const days = Math.floor(d / DAY);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`;
}

/** The Front desk About tab. `currentFallback` is the version to show before the host has sent any update info. */
export function aboutView(u: UpdateInfo | undefined, now: number, currentFallback: string): AboutView {
  const current = u?.current || currentFallback;
  const buttons: MemoButton[] = [{ action: 'check', label: 'Check for updates', kind: 'secondary' }];
  const latest = u?.latest || 'the newest version';
  let statusLine = '';
  switch (u?.status) {
    case 'checking':
      statusLine = 'Checking GitHub…';
      break;
    case 'upToDate':
      statusLine = 'You have the latest version.';
      break;
    case 'available':
      statusLine = `Version ${latest} is available.`;
      buttons.push({ action: 'install', label: `Install ${latest}`, kind: 'primary' });
      if (u.notesUrl) buttons.push(NOTES_LINK);
      break;
    case 'downloading':
      statusLine = `Downloading version ${latest}…`;
      break;
    case 'installed':
      statusLine = `Version ${latest} is installed. Reload to finish.`;
      buttons.push({ action: 'reload', label: 'Reload', kind: 'primary' });
      break;
    case 'error':
    case 'idle':
      statusLine = u.message || '';
      break;
    default:
      break;
  }
  return {
    versionLine: `Middle Management ${current}`,
    lastChecked: u?.checkedAt === undefined ? 'never' : relativeTime(u.checkedAt, now),
    statusLine,
    buttons,
    checking: u?.status === 'checking',
    autoLine: u?.auto === false ? 'Automatic checks are off.' : 'Checks GitHub once a day.',
  };
}
