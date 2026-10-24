/**
 * Pure logic behind the assignment memo: project ordering and defaults, who a
 * task can go to, the live "what will happen" line, and the message to post.
 * DOM-free so it can be unit-tested with plain Node.
 */
import { LIMITS } from '../../src/shared/protocol.ts';
import type { AgentControl, AgentStatus, EffortLevel, PermissionMode, ProjectOption, WebviewToHost } from '../../src/shared/protocol.ts';
import { prettyModel, shortPath } from './caseLogic.ts';
import { EFFORT_LABELS, clampEffort } from './optionsLogic.ts';
import type { ClaudeDefaults } from '../../src/shared/protocol.ts';
import type { MemoPrefill } from '../../src/shared/panels.ts';

export { APPROVAL_CHOICES, MODEL_CHOICES } from './optionsLogic.ts';

/** Projects in memo order: this window's folders, then recent, then browsed (stable within each group). */
export function orderProjects(projects: readonly ProjectOption[]): ProjectOption[] {
  const rank = { workspace: 0, recent: 1, browsed: 2 } as const;
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (rank[a.p.source] ?? 3) - (rank[b.p.source] ?? 3) || a.i - b.i)
    .map((x) => x.p);
}

/** The project to preselect: the clicked worker's folder, else the host's default, else the first that exists. */
export function defaultProject(projects: readonly ProjectOption[], defaultPath: string | undefined, preferPath: string | undefined): string | null {
  const ok = (path: string | undefined): boolean => !!path && projects.some((p) => p.path === path && p.exists);
  if (ok(preferPath)) return preferPath!;
  if (ok(defaultPath)) return defaultPath!;
  return orderProjects(projects).find((p) => p.exists)?.path ?? null;
}

/** What the memo needs to know about a worker. */
export interface WorkerInfo {
  id: string;
  kind: 'main' | 'temp';
  title: string;
  status: AgentStatus;
  cwd?: string;
  sessionId?: string;
  control?: AgentControl;
  /** Busy right now (an office run in the middle of a turn). */
  busy?: boolean;
}

/** Workers a task for `projectPath` can go to: mains in that folder that take orders here (free or office-run). */
export function assignableWorkers(workers: readonly WorkerInfo[], projectPath: string | null): WorkerInfo[] {
  if (!projectPath) return [];
  return workers.filter((w) => w.kind === 'main' && w.status !== 'done' && !!w.sessionId && w.cwd === projectPath && (w.control === 'free' || w.control === 'office'));
}

/** Who the memo goes to. */
export type Assignee = { kind: 'new' } | { kind: 'worker'; worker: WorkerInfo };

export interface MemoState {
  project: ProjectOption | null;
  assignee: Assignee;
  /** '' = the user's default model. */
  model: string;
  /** Absent or null = the default effort for that model. */
  effort?: EffortLevel | null;
  mode: PermissionMode;
  prompt: string;
}

/** Why the memo can't be sent yet, or null when it can. */
export function memoProblem(s: MemoState): string | null {
  if (!s.project) return 'Pick a project folder.';
  if (!s.project.exists) return 'That folder no longer exists.';
  if (!s.prompt.trim()) return 'Write the task first.';
  if (s.prompt.length > LIMITS.promptChars) return `The task is ${(s.prompt.length - LIMITS.promptChars).toLocaleString('en-US')} characters too long.`;
  return null;
}

const MODE_SENTENCE: Readonly<Record<PermissionMode, string>> = {
  default: 'They’ll knock at your door when they need an OK.',
  acceptEdits: 'File edits in the project are auto-approved. Commands, web access and anything outside the project still knock.',
  plan: 'They’ll plan first and bring you the plan to sign off.',
};

/** The plain-language line under the memo that says exactly what Send will do. */
export function memoSummary(s: MemoState): string {
  if (!s.project) return 'Pick a project folder to see who will start where.';
  const where = `${shortPath(s.project.path)}${s.project.gitBranch ? ` on ${s.project.gitBranch}` : ''}`;
  const model = (s.model ? ` Model: ${prettyModel(s.model)}.` : '') + (s.effort ? ` Effort: ${EFFORT_LABELS[s.effort]}.` : '');
  if (s.assignee.kind === 'worker') {
    const w = s.assignee.worker;
    if (w.control === 'office') {
      return w.busy
        ? `“${w.title}” gets this as a note and reads it after their current step. Counts toward your Claude usage.`
        : `“${w.title}” gets this right away, in their current session. Counts toward your Claude usage.`;
    }
    return `“${w.title}” picks this up in their own session, in ${where}. ${MODE_SENTENCE[s.mode]}${model} Counts toward your Claude usage.`;
  }
  return `A new hire will start in ${where}. ${MODE_SENTENCE[s.mode]}${model} Counts toward your Claude usage.`;
}

/** The character counter, shown only near the limit ('' otherwise). */
export function counterText(len: number, limit: number = LIMITS.promptChars): string {
  if (len < limit * 0.8) return '';
  return `${len.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}`;
}

/**
 * The message Send posts. A new hire or a free worker gets `newTask`; an
 * office-run worker already has a live session, so the memo goes to them as a
 * `reply` (the host only resumes free sessions with `newTask`).
 */
export function memoMessage(s: MemoState, nonce: string): WebviewToHost | null {
  if (memoProblem(s) !== null || !s.project) return null;
  if (s.assignee.kind === 'worker' && s.assignee.worker.control === 'office' && s.assignee.worker.sessionId) {
    return { type: 'reply', sessionId: s.assignee.worker.sessionId, text: s.prompt };
  }
  const msg: WebviewToHost = {
    type: 'newTask',
    nonce,
    projectPath: s.project.path,
    prompt: s.prompt,
    assignTo: s.assignee.kind === 'worker' && s.assignee.worker.sessionId ? { kind: 'existing', sessionId: s.assignee.worker.sessionId } : { kind: 'new' },
    permissionMode: s.mode,
  };
  if (s.model) msg.model = s.model;
  if (s.effort) msg.effort = s.effort;
  return msg;
}

/** What `applyPrefill` decided. `note` goes under "To:"; `effortNote` explains an effort that was clamped. */
export interface PrefillResult {
  state: MemoState;
  note: string;
  effortNote: string;
}

/**
 * Applies a panel's prefill to the memo state; never sends anything. Fields not given keep `state`'s values.
 *  - `prompt` replaces the task text.
 *  - Project: `projectPath` if it is a known folder that exists, else the prefilled worker's folder, else unchanged.
 *  - `sessionId` picks that worker if it is assignable (free or office-run, same project); otherwise a new hire,
 *    with a note saying why.
 *  - `options` set model, effort (clamped for that model like a manual choice) and approvals.
 */
export function applyPrefill(
  state: MemoState,
  prefill: MemoPrefill | undefined,
  workers: readonly WorkerInfo[],
  projects: readonly ProjectOption[],
  defaults: ClaudeDefaults | null | undefined,
): PrefillResult {
  const out: MemoState = { ...state };
  let note = '';
  let effortNote = '';
  if (!prefill) return { state: out, note, effortNote };
  const target = prefill.sessionId ? workers.find((w) => w.kind === 'main' && w.sessionId === prefill.sessionId) : undefined;
  const known = (path: string | undefined): ProjectOption | null => (path ? projects.find((p) => p.path === path && p.exists) ?? null : null);
  const project = known(prefill.projectPath) ?? known(target?.cwd);
  if (project) out.project = project;
  if (prefill.prompt !== undefined) out.prompt = prefill.prompt;
  if (prefill.sessionId) {
    const w = assignableWorkers(workers, out.project?.path ?? null).find((x) => x.sessionId === prefill.sessionId);
    if (w) out.assignee = { kind: 'worker', worker: w };
    else {
      out.assignee = { kind: 'new' };
      note = target ? `${target.title} is busy, so this goes to a new hire.` : 'That worker is not available, so this goes to a new hire.';
    }
  }
  const o = prefill.options;
  if (o) {
    if (o.model !== undefined) out.model = o.model ?? '';
    if (o.permissionMode) out.mode = o.permissionMode;
    if (o.effort !== undefined || o.model !== undefined) {
      const c = clampEffort(defaults, out.model, o.effort !== undefined ? o.effort : out.effort);
      out.effort = c.effort;
      effortNote = c.note ?? '';
    }
  }
  return { state: out, note, effortNote };
}
