/** The parts of ~/.claude/sessions/<pid>.json we use. Never read the *.key files next to them. */
export interface LiveStatus {
  pid: number;
  /** True when the process with this pid is still running (see ClaudeWatcher's `isPidAlive`). A false value means the file is stale. */
  alive: boolean;
  /** Whatever string the file holds: `busy` and `idle` are seen in real files, `waiting` may appear. */
  status: string;
  name?: string;
  statusUpdatedAt?: number;
}

/** The meta.json written next to a subagent transcript. */
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  finished?: boolean;
}

export interface SubagentInfo {
  agentId: string;
  /** Absolute path of the subagent transcript. */
  path: string;
  mtimeMs: number;
  meta?: SubagentMeta;
}

/** One Claude Code session the watcher currently considers relevant. */
export interface SessionInfo {
  sessionId: string;
  /** Absolute path of the main transcript. */
  transcriptPath: string;
  /** Absolute path of the project folder (`<claudeHome>/projects/<encoded cwd>`). */
  projectDir: string;
  cwd?: string;
  mtimeMs: number;
  live?: LiveStatus;
  subagents: SubagentInfo[];
}

/** New transcript lines for one file. reset=true means the file was first seen or rewritten: drop earlier state for it and rebuild from these records. */
export interface RecordBatch {
  sessionId: string;
  agentId?: string;
  reset: boolean;
  records: unknown[];
}

/** Result of one poll. `sessions` is the complete current set (sessions absent from it are gone). */
export interface WatchUpdate {
  sessions: SessionInfo[];
  batches: RecordBatch[];
}
