/**
 * The File room (the filing cabinets): breadcrumbs, listing order, the preview decision and the hand-over prefill. Pure
 * (no DOM). Paths here are the relative ones the host uses (`relPath`, '' = the root); no absolute path is built or shown
 * except `FileRoot.display`, which the host sends ready to show.
 */
import type { DirEntry, FileRoot, FileRootKind, HostToWebview } from '../../src/shared/protocol.ts';
import type { MemoPrefill } from '../../src/shared/panels.ts';
import { clockText } from './usageLogic.ts';

export interface Crumb {
  label: string;
  /** The folder this crumb opens ('' = the root). */
  relPath: string;
}

/** "Root / src / engine" as crumbs; the first is always the root, labelled `rootLabel`. */
export function breadcrumbs(rootLabel: string, relPath: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootLabel, relPath: '' }];
  let at = '';
  for (const seg of relPath.split('/')) {
    if (!seg) continue;
    at = at ? `${at}/${seg}` : seg;
    crumbs.push({ label: seg, relPath: at });
  }
  return crumbs;
}

/** The folder above `relPath`; '' for a top-level item; null at the root itself (nowhere to go up to). */
export function parentPath(relPath: string): string | null {
  if (!relPath) return null;
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

/** `name` inside the folder `relPath`. */
export function childPath(relPath: string, name: string): string {
  return relPath ? `${relPath}/${name}` : name;
}

const byName = (a: string, b: string): number => {
  const c = a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  return c || (a < b ? -1 : a > b ? 1 : 0);
};

const KIND_RANK: Record<DirEntry['kind'], number> = { dir: 0, file: 1, other: 2 };

/** Folders first, then files, then things that cannot be opened; each by name (numbers in order, case ignored). */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || byName(a.name, b.name));
}

export interface EntryGroups {
  folders: DirEntry[];
  files: DirEntry[];
  /** Sockets, devices, broken links and links that leave the root: listed, not openable. */
  others: DirEntry[];
}

/** The sorted entries split by kind. */
export function groupEntries(entries: readonly DirEntry[]): EntryGroups {
  const g: EntryGroups = { folders: [], files: [], others: [] };
  for (const e of sortEntries(entries)) (e.kind === 'dir' ? g.folders : e.kind === 'file' ? g.files : g.others).push(e);
  return g;
}

/** Whether the entry can be opened (folders descend, files preview). */
export function isOpenable(e: Pick<DirEntry, 'kind'>): boolean {
  return e.kind !== 'other';
}

/** "0 B", "512 B", "1.5 KB", "12 KB", "3.2 MB"; '' for a missing or invalid size. Binary units, short labels. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const text = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${text} ${units[u]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05" today, "3 Mar" this year, "3 Mar 2024" otherwise; '' when unknown. */
export function formatDate(mtime: number | undefined, now: number): string {
  if (mtime === undefined || !Number.isFinite(mtime)) return '';
  const d = new Date(mtime);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clockText(mtime);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The small print under a row: "1.5 KB · 3 Mar", "Link", "Secret", "Cannot be opened". Folders have none. */
export function entryMeta(e: DirEntry, now: number): string {
  if (e.kind === 'other') return 'Cannot be opened';
  const parts: string[] = [];
  if (e.kind === 'file') {
    const size = formatSize(e.size);
    const date = formatDate(e.mtime, now);
    if (size) parts.push(size);
    if (date) parts.push(date);
  }
  if (e.link) parts.push('Link');
  if (e.secret) parts.push('Secret');
  return parts.join(' · ');
}

/** "Empty folder", or the note shown when a listing was cut at the host's limit. */
export const EMPTY_FOLDER = 'This folder is empty.';
export function truncatedNote(shown: number, truncated: boolean): string {
  return truncated ? `Showing the first ${shown} items. Open the folder in your editor to see the rest.` : '';
}

export type PreviewKind = 'text' | 'markdown' | 'binary' | 'secret' | 'tooLarge' | 'truncated';

export interface PreviewDecision {
  kind: PreviewKind;
  /** The text to show, when there is some. */
  text?: string;
  /** Render `text` as markdown (also set for a cut markdown file, which the panel may show as plain text). */
  markdown: boolean;
  /** What to say instead of (or above) the text. */
  message: string;
  /** Whether the panel should offer only "Open in editor". */
  openOnly: boolean;
}

type FileTextReply = Extract<HostToWebview, { type: 'fileText' }>;
export type FileTextFields = Pick<FileTextReply, 'size' | 'text' | 'truncated' | 'binary' | 'secret' | 'tooLarge' | 'markdown'>;

/** Decides how to show a `fileText` reply. The host guarantees at most one of secret, tooLarge and binary; they are checked in that order. */
export function previewDecision(r: FileTextFields): PreviewDecision {
  const none = { markdown: false, openOnly: true };
  if (r.secret) return { kind: 'secret', ...none, message: 'This looks like a secret file, so it is not shown here. You can open it in your editor.' };
  if (r.tooLarge) return { kind: 'tooLarge', ...none, message: `This file is too large to preview (${formatSize(r.size)}). You can open it in your editor.` };
  if (r.binary) return { kind: 'binary', ...none, message: 'This is not a text file, so there is nothing to preview. You can open it in your editor.' };
  if (r.text === undefined) return { kind: 'binary', ...none, message: 'There is no preview for this file. You can open it in your editor.' };
  const markdown = r.markdown === true;
  if (r.truncated) {
    const shown = formatSize(new TextEncoder().encode(r.text).length);
    return { kind: 'truncated', text: r.text, markdown, openOnly: false, message: `Showing the first ${shown} of ${formatSize(r.size)}. Open it in your editor for the rest.` };
  }
  return { kind: markdown ? 'markdown' : 'text', text: r.text, markdown, openOnly: false, message: r.text === '' ? 'This file is empty.' : '' };
}

/** "Hand to a worker": the path as the task text (a folder ends in '/'), and the root's project preselected. */
export function handPrefill(root: Pick<FileRoot, 'projectPath'>, relPath: string, isDir: boolean): MemoPrefill {
  const prefill: MemoPrefill = { projectPath: root.projectPath };
  if (relPath) prefill.prompt = isDir ? `${relPath}/` : relPath;
  return prefill;
}

export const ROOT_KIND_ORDER: readonly FileRootKind[] = ['workspace', 'agent', 'project'];

export const ROOT_KIND_TITLES: Readonly<Record<FileRootKind, string>> = {
  workspace: 'Open folders',
  agent: 'Where workers are',
  project: 'Other projects',
};

export interface RootGroup {
  kind: FileRootKind;
  title: string;
  roots: FileRoot[];
}

/** The root picker: groups in a fixed order, empty groups left out, each by label. */
export function rootGroups(roots: readonly FileRoot[]): RootGroup[] {
  const out: RootGroup[] = [];
  for (const kind of ROOT_KIND_ORDER) {
    const list = roots.filter((r) => r.kind === kind).sort((a, b) => byName(a.label, b.label) || byName(a.display, b.display));
    if (list.length) out.push({ kind, title: ROOT_KIND_TITLES[kind], roots: list });
  }
  return out;
}

export const NO_ROOTS = 'No folders to browse yet. Open a folder in your editor or start a worker.';

/** The accessible name of a folder or file row: "src, folder", "notes.md, 2.1 KB, 3 Mar", "a.env, secret". */
export function entryLabel(e: DirEntry, meta: string, chips: readonly string[]): string {
  const bits = [e.kind === 'dir' ? 'folder' : '', meta, ...chips.map((c) => c.toLowerCase())].filter(Boolean);
  return bits.length ? `${e.name}, ${bits.join(', ')}` : e.name;
}

/** "2.1 KB · 3 Mar" for a file; nothing for a folder; "Cannot be opened" for the rest. (`Link` and `Secret` are chips.) */
export function entryDetail(e: DirEntry, now: number): string {
  if (e.kind === 'other') return 'Cannot be opened';
  if (e.kind !== 'file') return '';
  return [formatSize(e.size), formatDate(e.mtime, now)].filter(Boolean).join(' · ');
}

export function entryChips(e: DirEntry): string[] {
  const chips: string[] = [];
  if (e.link) chips.push('Link');
  if (e.secret) chips.push('Secret');
  return chips;
}

/** The segment of `current` just below `ancestor` ('' = the root): the folder you came out of when you go up to `ancestor`. */
export function childBelow(ancestor: string, current: string): string | undefined {
  const rest = ancestor ? current.slice(ancestor.length + 1) : current;
  return rest.split('/')[0] || undefined;
}
