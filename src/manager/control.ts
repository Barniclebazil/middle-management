// Who takes orders for an agent (docs/manager-mode.md section 3). Pure apart from `liveSessionIdsFromDisk`.
// No `vscode` import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentControl } from '../shared/protocol.ts';
import { claudeHome, sessionsDir } from '../claude/paths.ts';
import { PROBE_ENTRYPOINT, defaultIsPidAlive, isLiveStatusFileName } from '../claude/sessions.ts';

/** The parts of an agent the rules need. A main agent's id equals its sessionId. */
export interface ControlAgent {
  id: string;
  kind: 'main' | 'temp';
  sessionId?: string;
}

/**
 * 1. temp -> 'none'. 2. a runner in this extension holds the session -> 'office'. 3. a live
 * `~/.claude/sessions/<pid>.json` names the session -> 'elsewhere'. 4. otherwise 'free'.
 * The runner map beats the sessions file: an office run has a live file of its own.
 */
export function controlFor(agent: ControlAgent, liveSessionIds: ReadonlySet<string>, runnerIds: ReadonlySet<string>): AgentControl {
  if (agent.kind === 'temp') return 'none';
  const sid = agent.sessionId ?? agent.id;
  if (runnerIds.has(sid)) return 'office';
  if (liveSessionIds.has(sid)) return 'elsewhere';
  return 'free';
}

export type ResumeCheck = { ok: true } | { ok: false; control: AgentControl; message: string };

/** The synchronous re-check before a resume: only a 'free' session may be started. Pass a FRESH live set. */
export function checkResume(sessionId: string, liveSessionIds: ReadonlySet<string>, runnerIds: ReadonlySet<string>): ResumeCheck {
  const c = controlFor({ id: sessionId, kind: 'main', sessionId }, liveSessionIds, runnerIds);
  if (c === 'free') return { ok: true };
  return {
    ok: false,
    control: c,
    message:
      c === 'office'
        ? 'This worker is already running in the office.'
        : 'This session is running in another Claude Code window or terminal. Open it there, or end it first.',
  };
}

export class ResumeRefused extends Error {
  readonly control: AgentControl;
  constructor(control: AgentControl, message: string) {
    super(message);
    this.name = 'ResumeRefused';
    this.control = control;
  }
}

/** Throwing form of `checkResume`. */
export function assertCanResume(sessionId: string, liveSessionIds: ReadonlySet<string>, runnerIds: ReadonlySet<string>): void {
  const r = checkResume(sessionId, liveSessionIds, runnerIds);
  if (!r.ok) throw new ResumeRefused(r.control, r.message);
}

export interface LiveFs {
  readdir: (dir: string) => string[];
  readFile: (file: string) => string;
}

const nodeLiveFs: LiveFs = {
  readdir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
};

/**
 * Session ids held by a running process, read synchronously from `<claudeHome>/sessions/<digits>.json` (never the
 * `*.key` files). A file counts when its pid exists. Never throws.
 */
export function liveSessionIdsFromDisk(
  opts: { home?: string; fs?: LiveFs; isPidAlive?: (pid: number) => boolean } = {},
): Set<string> {
  const out = new Set<string>();
  const dir = sessionsDir(opts.home ?? claudeHome());
  const io = opts.fs ?? nodeLiveFs;
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  let names: string[];
  try {
    names = io.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!isLiveStatusFileName(name)) continue;
    try {
      const raw: unknown = JSON.parse(io.readFile(path.join(dir, name)));
      if (typeof raw !== 'object' || raw === null) continue;
      const o = raw as Record<string, unknown>;
      if (o['entrypoint'] === PROBE_ENTRYPOINT) continue; // the usage probe is not a session anyone could be running
      const sid = o['sessionId'];
      if (typeof sid !== 'string' || sid === '') continue;
      const pid = typeof o['pid'] === 'number' && Number.isInteger(o['pid']) ? o['pid'] : Number.parseInt(name, 10);
      if (alive(pid)) out.add(sid);
    } catch {
      // half-written or vanished: skip
    }
  }
  return out;
}
