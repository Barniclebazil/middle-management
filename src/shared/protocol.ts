import type { OfficeTheme } from './theme.ts';
import { OFFICE_MODES } from './officeMode.ts';

/** What an agent is visibly doing in the office. */
export type Activity = 'reading' | 'searching' | 'researching' | 'writing' | 'drawing' | 'running' | 'copier' | 'planning' | 'delegating' | 'thinking' | 'needsYou' | 'shredding' | 'idle';

/** Every Activity value, for iteration and tests. */
export const ACTIVITIES: readonly Activity[] = ['reading', 'searching', 'researching', 'writing', 'drawing', 'running', 'copier', 'planning', 'delegating', 'thinking', 'needsYou', 'shredding', 'idle'];

/** Coarse session status. */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'done';

/** One agent as the webview sees it. All times are epoch milliseconds. */
export interface AgentSnapshot {
  id: string;
  parentId?: string;
  kind: 'main' | 'temp';
  title: string;
  project: string;
  activity: Activity;
  detail?: string;
  status: AgentStatus;
  /** When the current activity began. */
  since: number;
  /** When the agent first appeared; used to hand out archetypes. */
  startedAt: number;
  /** Time of the last human prompt, if any. */
  lastPromptAt?: number;
  /** The newest permission prompt the user approved by hand (not auto-allowed by config), and what it was for. */
  lastApproval?: { at: number; kind: ApprovalKind };
  /** Claude Code session id (main agents; temps carry their parent's). Joins agents to office runs. */
  sessionId?: string;
  /** Absolute working directory of the session. */
  cwd?: string;
  /** Git branch recorded in the transcript, if any. */
  gitBranch?: string;
  /** Who takes orders for this agent. Absent means unknown; treat as 'none'. */
  control?: AgentControl;
  /** An open permission/question/plan request from an office-run session. Forces the needsYou activity. */
  pending?: { requestId: string; kind: PendingKind };
  /**
   * Cumulative cost in USD of the session. Since Round A it comes from the transcript's `cost-state` records for every
   * session; an office run's own figure (from the SDK result messages) overrides it while that run is live.
   */
  costUsd?: number;
  /** Model of the latest assistant turn (full id from the transcript, `<synthetic>` skipped). */
  model?: string;
  /** Effort level recorded in the transcript (or requested by an office run). Absent when unknown. */
  effort?: EffortLevel;
  /** Context window use of the latest turn. `approx` = the window size is a guess (200k default), not reported. */
  context?: { tokens: number; max: number; pct: number; approx?: boolean };
  /** The final text of the latest finished turn, at most LIMITS.reportChars (`truncated` when cut). */
  lastReport?: { at: number; text: string; truncated?: boolean };
  /** Recent plans (ExitPlanMode), oldest first, at most LIMITS.plansPerAgent. Full text comes from `getPlan`. */
  plans?: PlanRef[];
}

/** Effort level of a session (the SDK's `effort` option / `effortLevel` setting). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every EffortLevel, lowest first, for iteration and validation. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Lifecycle of a plan: waiting for sign-off, decided, or replaced by a newer plan before a decision. */
export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/** A plan an agent proposed (one ExitPlanMode tool_use). `id` is that tool_use id. */
export interface PlanRef {
  id: string;
  /** Epoch ms when the plan was proposed. */
  at: number;
  /** First heading or line of the plan, at most LIMITS.planTitleChars. */
  title: string;
  status: PlanStatus;
  /** Length of the full plan text, so lists can say "4,200 chars" without loading it. */
  chars: number;
  /** Epoch ms when it was approved or rejected. */
  decidedAt?: number;
}

/**
 * Options of a running or resumable session. `model` / `effort` of `null` mean "reset to the default" (the user's Claude
 * Code settings); absent means "leave as is". There is deliberately no way to express `bypassPermissions`.
 */
export interface SessionOptions {
  model?: string | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
}

/** User-facing settings forwarded to the webview. */
export interface OfficeSettings {
  companyName: string;
  branchName: string;
  speechBubbles: boolean;
  managerName: string;
  bossQuotes: boolean;
  /** Parsed theme file, when one is configured and valid. */
  theme?: OfficeTheme;
}

// ---------------------------------------------------------------------------
// Manager Mode contract. See docs/manager-mode.md.
// ---------------------------------------------------------------------------

/**
 * Who takes orders for an agent.
 * 'office': started by this extension and running in it. 'free': a main session with no live process anywhere, so the
 * office may resume it. 'elsewhere': live in another process (Claude Code panel or terminal): read-only plus "Open in
 * Claude Code". 'none': temps (subagents) cannot be driven directly.
 */
export type AgentControl = 'office' | 'free' | 'elsewhere' | 'none';

/** Every AgentControl value, for iteration and validation. */
export const AGENT_CONTROLS: readonly AgentControl[] = ['office', 'free', 'elsewhere', 'none'];

/** What a hand-approved permission prompt was for: a plan, a shell command or an edit. */
export type ApprovalKind = 'plan' | 'command' | 'edit';

/** Kind of request a worker can be blocked on (all come from the SDK's canUseTool). */
export type PendingKind = 'permission' | 'question' | 'plan';

/** Every PendingKind value. */
export const PENDING_KINDS: readonly PendingKind[] = ['permission', 'question', 'plan'];

/**
 * Permission style chosen on the memo. Always passed explicitly to the SDK (the user's own default may be 'plan').
 * 'default' = knock at the door (normal Claude Code rules), 'acceptEdits' = auto-accept edits, 'plan' = plan first.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

/** Every PermissionMode value. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** Limits shared by host and webview. Lengths are in UTF-16 code units (JS string length). */
export const LIMITS = {
  /** Max characters of a task prompt or reply. */
  promptChars: 20000,
  /** Max characters of a tool input or output preview in a ConversationItem. */
  toolPreviewChars: 2000,
  /** Max characters of a one-line tool step summary. */
  toolSummaryChars: 200,
  /** Max characters of assistant text kept in one item (longer text is cut and `truncated` set). */
  assistantTextChars: 20000,
  /** Max conversation items in a case file (the most recent ones are kept). */
  caseItems: 300,
  /** Max characters of a plan shown on a plan card. */
  planChars: 40000,
  /** Max characters of one value in a permission card field. */
  fieldChars: 2000,
  /** Max fields on a permission card. */
  fields: 12,
  /** Max questions in one question card. */
  questions: 8,
  /** Max options per question. */
  options: 12,
  /** Max projects in a `projects` message. */
  projects: 50,
  /** Max characters of a path. */
  pathChars: 4096,
  /** Max characters of an id (agentId, sessionId, requestId, nonce). */
  idChars: 200,
  /** Max characters of a model name. */
  modelChars: 100,
  /** Max characters of a deny message, plan feedback, or one free-text answer. */
  feedbackChars: 2000,
  /** Max characters of a question text used as an answers key. */
  questionChars: 1000,
  /** Max characters of an option label. */
  labelChars: 500,
  /** Max labels in one multi-select answer. */
  multiAnswers: 20,
  /** Max error message characters sent to the webview. */
  errorChars: 1000,
  /** Max characters of `AgentSnapshot.lastReport.text`. */
  reportChars: 1000,
  /** Max plans kept per agent in `AgentSnapshot.plans`. */
  plansPerAgent: 5,
  /** Max characters of a plan title. */
  planTitleChars: 120,
  /** Max items in a `turn` reply. */
  turnItems: 80,
  /** Max windows in a `UsageSnapshot`. */
  usageWindows: 8,
  /** Max entries in `ClaudeDefaults.models`. */
  models: 20,
  /** Max characters of a theme file's JSON in a `saveTheme` / `saveThemeAs` message. */
  themeJsonChars: 524288,
  /** Max characters of a text setting value (company, branch and manager name). */
  settingChars: 100,
  /** Max entries in `FrontDeskState.source.errors`. */
  themeErrors: 50,
  /** Max characters of one theme error line. */
  themeErrorChars: 300,
  /** Max entries in `FrontDeskState.presets`. */
  presets: 10,
  /** Max entries in `FrontDeskState.userThemes` (more sets `userThemesTruncated`). */
  userThemes: 50,
  /** Max characters of a `themeAction.themeId` (a theme file name in the themes folder). */
  themeIdChars: 120,
  /** Max characters of a relative path (`relPath`) in a file room request. */
  relPathChars: 1024,
  /** Max entries in one `dirListing` (more sets `truncated`). */
  dirEntries: 500,
  /** Max bytes of file text in a `fileText` preview (a larger file is cut and `truncated` set). */
  previewBytes: 262144,
  /** Files larger than this many bytes are not read at all for a preview (`tooLarge`). */
  previewMaxFileBytes: 4194304,
  /** Max entries in `fileRoots`. */
  fileRoots: 100,
  /** Max characters of a file or folder name, a root label, or a catalog name (skill, command, server, agent type, memory file). */
  nameChars: 255,
  /** Max characters of a catalog description or memory hook line. */
  descriptionChars: 300,
  /** Max skills in a `skills` catalog. */
  catalogSkills: 300,
  /** Max slash commands in a `skills` catalog. */
  catalogCommands: 300,
  /** Max servers in an `mcp` catalog. */
  mcpServers: 100,
  /** Max subagent types in an `agents` catalog. */
  agentTypes: 100,
  /** Max CLAUDE.md files (the chain, plus rules files) in a `handbook` catalog. */
  handbookFiles: 50,
  /** Max memory entries in a `handbook` catalog. */
  memoryEntries: 200,
  /** Max permission rules in a `handbook` catalog, over all three behaviours. */
  permissionRules: 500,
  /** Max characters of one permission rule, for example `Bash(npm run test:*)`. */
  ruleChars: 300,
  /** Max tool names listed on one subagent type. */
  toolsPerAgent: 60,
  /** Max characters of one tool name. */
  toolNameChars: 100,
  /** Max case tabs open at once (v0.5). A further `openCaseTab` is refused with an `error`; the oldest tab is never closed for it. */
  caseTabs: 20,
} as const;

/** A project folder offered on the assignment memo. */
export interface ProjectOption {
  /** Absolute path. */
  path: string;
  /** Short display name (folder name). */
  name: string;
  /** Current git branch from .git/HEAD (worktree-aware), if the folder is a repo. */
  gitBranch?: string;
  /** Whether the folder currently exists on disk. Non-existent entries cannot be chosen. */
  exists: boolean;
  /** Where it came from, in list order: workspace folders, then recent cwds, then browsed. */
  source: 'workspace' | 'recent' | 'browsed';
}

/** Who a new task goes to. */
export type AssignTarget = { kind: 'new' } | { kind: 'existing'; sessionId: string };

/** Status of a tool step. 'denied' = the user (or a rule) refused it. */
export type ToolStepState = 'running' | 'done' | 'error' | 'denied';

/** Kind of a notice row. */
export type NoticeKind = 'interrupted' | 'error' | 'cost' | 'info';

/**
 * One row of a case file. `id` is stable (for example the transcript uuid, the tool_use id, or
 * `<apiMessageId>:<blockIndex>` while streaming), so a later item with the same id replaces the earlier one.
 * `at` is epoch ms when known.
 */
export type ConversationItem =
  /** Something the user typed (office memo, reply, or typed in Claude Code). */
  | { kind: 'prompt'; id: string; at?: number; text: string; truncated?: boolean }
  /** Assistant text. While `streaming` is true the text is the concatenated text_delta so far. */
  | { kind: 'assistant'; id: string; at?: number; text: string; streaming?: boolean; truncated?: boolean }
  /** A tool_use with its result. */
  | {
      kind: 'tool';
      id: string;
      at?: number;
      /** Tool name, e.g. 'Bash', 'Read', 'mcp__server__tool'. */
      name: string;
      state: ToolStepState;
      /** One line, at most LIMITS.toolSummaryChars, e.g. 'Read app.ts', 'Ran npm test'. */
      summary: string;
      /** Truncated input preview (at most LIMITS.toolPreviewChars). */
      input?: string;
      /** Truncated result or error text (at most LIMITS.toolPreviewChars). */
      output?: string;
      /** Set on subagent steps: the tool_use id of the parent Task. */
      parentToolUseId?: string;
    }
  /** Thinking happened; content is deliberately not carried. */
  | { kind: 'thinking'; id: string; at?: number }
  /** Interrupted, error, or per-turn cost. `costUsd` is that turn's cost for notice 'cost'. */
  | { kind: 'notice'; id: string; at?: number; notice: NoticeKind; text: string; costUsd?: number }
  /**
   * A plan the worker proposed (ExitPlanMode). It stays in the history after the decision. `id` is the tool_use id (the
   * `planId` of `getPlan`). `text` is cut at LIMITS.planChars (`truncated`). `feedback` is the user's reason on reject.
   */
  | { kind: 'plan'; id: string; at?: number; text: string; truncated?: boolean; status: PlanStatus; planFilePath?: string; feedback?: string };

/** One label/value line on a permission card. */
export interface PendingField {
  /** e.g. 'Command', 'File', 'Old', 'New', 'URL'. */
  label: string;
  /** Text, at most LIMITS.fieldChars (cut with an ellipsis). Render as a text node. */
  value: string;
  /** Render in monospace. */
  code?: boolean;
}

/** One option of a question. */
export interface QuestionOption { label: string; description: string; preview?: string }

/** One question of an AskUserQuestion call. */
export interface QuestionSpec {
  /** Full question text; it is also the key of `answers` in the decision. */
  question: string;
  /** Short chip title. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Fields common to every pending request. */
export interface PendingBase {
  /** Unique per request; the key for `decide`. */
  requestId: string;
  sessionId: string;
  /** Epoch ms when the request was raised. */
  at: number;
}

/** A request the worker is blocked on, with everything the card needs. */
export type PendingRequest =
  | (PendingBase & {
      kind: 'permission';
      toolName: string;
      /** One-line summary, e.g. the Bash description or command. */
      summary: string;
      /** Detail lines built from the tool input (Bash command/description; Edit file_path/old_string/new_string; Write file_path + content preview; WebFetch url; ...). */
      fields: PendingField[];
      /** Why the SDK asked (decisionReason), if provided. */
      reason?: string;
      /** True when the SDK passed `suggestions`, so "Always allow" can be offered. The host keeps the raw suggestions. */
      canAlwaysAllow: boolean;
      /** Human label for the always-allow button, e.g. 'Always allow "echo office-ok *"' (only with canAlwaysAllow). */
      alwaysLabel?: string;
    })
  | (PendingBase & { kind: 'question'; questions: QuestionSpec[] })
  | (PendingBase & {
      kind: 'plan';
      /** Markdown plan text, at most LIMITS.planChars. */
      plan: string;
      /** Where Claude saved the plan, if known. */
      planFilePath?: string;
    });

/** The user's answer to a pending request. The kind must match the request's kind (allow/deny: permission; deny also declines a question; plan: plan). */
export type DecisionPayload =
  /** Permission allow. `always` also applies the SDK's suggestions (needs canAlwaysAllow). */
  | { kind: 'allow'; always?: boolean }
  /** Permission deny, or "Skip question" on a question card, with an optional reason that is shown to the model. */
  | { kind: 'deny'; message?: string }
  /**
   * Question answers keyed by question text: one label, or labels for multiSelect. `other` holds free text per
   * question text; it replaces (single) or is appended to (multi) the chosen labels.
   */
  | { kind: 'answer'; answers: Record<string, string | string[]>; other?: Record<string, string> }
  /** Plan decision. `feedback` is sent to the model on reject. */
  | { kind: 'plan'; approve: boolean; feedback?: string };

/** Why a usage reading is missing or stale: where the probe is in its life. */
export type ProbeState =
  /** No probe has run yet, or none is due (the office is hidden). */
  | 'idle'
  /** A probe is in flight right now. */
  | 'running'
  /** The last probe succeeded. */
  | 'ok'
  /** The last probe failed (timeout, process error); the host retries with backoff (5, 10, 20, 30 min). */
  | 'failed'
  /** This Claude Code / SDK build has no usage call. The host stops probing; cache and rate-limit events still feed `usage`. */
  | 'unsupported'
  /** Not signed in to a Claude account; probing waits for a manual refresh. */
  | 'signedOut'
  /** Switched off with the `claudeOffice.usageChecks` setting (`off`). */
  | 'off';

/** Every ProbeState value. */
export const PROBE_STATES: readonly ProbeState[] = ['idle', 'running', 'ok', 'failed', 'unsupported', 'signedOut', 'off'];

/** Id of a usage window: the 5-hour window, the weekly one, and the per-model weekly ones. */
export type UsageWindowId = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';

/** Every UsageWindowId value. */
export const USAGE_WINDOW_IDS: readonly UsageWindowId[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** One rate-limit window. The host normalises units, so the webview never guesses. */
export interface UsageWindow {
  id: UsageWindowId;
  /** Percent used, 0 to 100 (the host converts any 0..1 scale), or null when the window is known but has no reading. */
  pct: number | null;
  /** Epoch ms when the window resets. Absent when unknown. A window whose reset time has passed is reported as reset (pct 0). */
  resetsAt?: number;
  /** Epoch ms of the reading this window is based on (the newest reading per window wins). */
  asOf: number;
  /** From rate-limit events: 'warning' near the limit, 'blocked' when the limit is hit (shows the BACK plate). */
  state?: 'warning' | 'blocked';
}

/**
 * Extra (pay-as-you-go) usage beyond the plan, when the account has it. Money is in `currency` (ISO 4217, e.g. 'GBP');
 * when `currency` is absent the amounts are assumed USD. The `...Usd` field names are historic: they hold major units of
 * `currency`, not necessarily dollars.
 */
export interface UsageExtra {
  enabled: boolean;
  /** Used so far this period, in major units of `currency`. */
  usedUsd?: number;
  /** Monthly limit, in major units of `currency`. */
  limitUsd?: number;
  /** ISO 4217 code of the amounts ('GBP', 'USD', ...), upper case. Absent when the source did not say. */
  currency?: string;
  /** Percent of the extra limit used, 0 to 100, or null. */
  pct?: number | null;
}

/** Where the headline numbers of a UsageSnapshot came from. 'mixed' = different windows from different sources. */
export type UsageSource = 'probe' | 'cache' | 'event' | 'mixed' | 'none';

/**
 * What the usage clock, calendar and Usage panel show. Built by the host's usage service from the probe, the
 * `~/.claude.json` cache and rate-limit events. Carries no account identity: no email, no ids.
 * Cached by the officeView and replayed on `ready`.
 */
export interface UsageSnapshot {
  /** 'plan' = subscription windows; 'apiKey' = API-key billing (no windows; show estimated cost); 'unknown' = not determined yet. */
  kind: 'plan' | 'apiKey' | 'unknown';
  /** At most LIMITS.usageWindows. */
  windows: UsageWindow[];
  extra?: UsageExtra;
  /** Subscription plan label, e.g. 'Max' or 'Pro' (short, display only). */
  plan?: string;
  source: UsageSource;
  /** Epoch ms of the newest reading of any window. */
  asOf?: number;
  probe: ProbeState;
  /** Epoch ms of the next scheduled probe, when one is scheduled (drives "Updated 2 min ago" / retry text). */
  nextAt?: number;
}

/** One model offered by Claude Code (from the SDK's supportedModels). */
export interface ModelChoice {
  /** The value to pass as `model` (alias or full id). */
  value: string;
  /** Display name. */
  label: string;
  /** The full model id this alias currently resolves to, when known. */
  resolved?: string;
  /** Effort levels this model supports. Absent = unknown (offer all). */
  efforts?: EffortLevel[];
}

/**
 * The user's own Claude Code defaults, for "Default (Opus · xhigh)" on the memo and the effort pip rules.
 * Read from `~/.claude/settings.json` (whitelisted keys only) and the init info. Cached by the officeView and replayed on `ready`.
 */
export interface ClaudeDefaults {
  /** The default model from the user's settings, when set. */
  model?: string;
  /** The default effort level, when set. */
  effort?: EffortLevel;
  /** Per-model default effort (`modelSettings.<model>.effortLevel`), keyed by model value. */
  effortByModel: Record<string, EffortLevel>;
  /** At most LIMITS.models. Absent until the host has asked the SDK. */
  models?: ModelChoice[];
}

/** Header of the open case file. */
export interface CaseHeader {
  agentId: string;
  sessionId?: string;
  /** Session title. */
  title: string;
  /** Project name. */
  project: string;
  cwd?: string;
  gitBranch?: string;
  activity: Activity;
  status: AgentStatus;
  control: AgentControl;
  /** Model in use (the full id when known, else the requested alias). */
  model?: string;
  /** Effort level in use, when known. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** Cumulative cost in USD (see AgentSnapshot.costUsd). */
  costUsd?: number;
  /** True while a turn is running in an office run (reply is queued, Stop is enabled). */
  busy?: boolean;
  /**
   * True when `setSessionOptions` would work: an office run (applies now) or a free session (applies to the next
   * message). False or absent for 'elsewhere' and 'none': the chips are read-only ("use /model or /effort in Claude Code").
   */
  canSetOptions?: boolean;
  /**
   * Options stored for a free session's next message. Sent as a partial header merge, so an empty object `{}` means
   * "nothing stored" (undefined cannot travel in a merge).
   */
  next?: SessionOptions;
}

/** Why a case file closed on the host's initiative. */
export type CaseClosedReason = 'agentGone' | 'replaced' | 'error';

/** The settings the Front desk may read and change. `claudePath` and `themeFile` are deliberately not here. */
export const FRONT_DESK_SETTINGS = ['mode', 'companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks'] as const;

/** Key of a Front desk setting (the part after `claudeOffice.`). */
export type FrontDeskSettingKey = (typeof FRONT_DESK_SETTINGS)[number];

/** Settings that hold trimmed text (at most LIMITS.settingChars, no control characters). */
export const FRONT_DESK_TEXT_SETTINGS = ['companyName', 'branchName', 'managerName'] as const;

/** Settings that hold a boolean. */
export const FRONT_DESK_BOOLEAN_SETTINGS = ['speechBubbles', 'bossQuotes'] as const;

/** Allowed values of the enum settings. */
export const FRONT_DESK_ENUM_VALUES = {
  mode: OFFICE_MODES,
  scope: ['all', 'workspace'],
  usageChecks: ['auto', 'off'],
  updateChecks: ['auto', 'off'],
} as const satisfies Partial<Record<FrontDeskSettingKey, readonly string[]>>;

/** Value of one Front desk setting: text, a switch, or an enum string. */
export type FrontDeskSettingValue = string | boolean;

/** Where a setting's effective value comes from. */
export type FrontDeskSettingSource = 'default' | 'user' | 'workspace';

/** One setting as the Front desk shows it. */
export interface FrontDeskSetting {
  /** The effective value (what VS Code resolves: workspace over user over default). */
  value: FrontDeskSettingValue;
  source: FrontDeskSettingSource;
  /** The user's own value, when set (what a reset removes and a change writes). Absent = not set by the user. */
  userValue?: FrontDeskSettingValue;
  /** True when a workspace value overrides the user's, so editing the user value shows no effect here. */
  workspaceWins: boolean;
  /** The value the theme file sets for this (a name that wins over the setting), when it does. */
  themeValue?: string;
}

/** A built-in example theme the user can switch to or copy. */
export interface FrontDeskPreset {
  /** `^[a-z0-9-]{1,40}$`; stored as the setting value `preset:<id>`. */
  id: string;
  label: string;
  description: string;
}

/** Why the current theme source cannot be saved over. Absent = it can. */
export type FrontDeskReadOnly = 'builtin' | 'preset' | 'workspace' | 'notJson' | 'missing' | 'notObject';

/** Where the office's theme comes from and its health. */
export interface FrontDeskSource {
  kind: 'builtin' | 'preset' | 'file';
  /** Set when kind is 'preset'. */
  presetId?: string;
  /** Short name for display, e.g. 'Built-in office', 'Example office' or the file name. */
  label: string;
  /** A `~`-shortened path of the theme file, for display only. Never sent back to the host. */
  path?: string;
  /** True when the path comes from a workspace setting (so Save is refused: a cloned repo must not aim it). */
  fromWorkspace: boolean;
  /** Whether the file exists (always true for builtin and preset). */
  exists: boolean;
  /** True when Save may write this source (no `readOnly` reason). */
  editable: boolean;
  readOnly?: FrontDeskReadOnly;
  /** Revision of the file text as last read: 16 lowercase hex characters. Needed by `saveTheme`. */
  rev?: string;
  /**
   * The theme file's raw text as last read, so the panel can show what a save would drop (unknown keys, invalid values,
   * formatting). Only for `kind: 'file'` whose last load read the file, and only when at most `LIMITS.themeJsonChars`
   * long; absent for the built-in office, a preset, a missing or unreadable file, or an oversized one.
   */
  rawText?: string;
  /** Problems found in the theme, at most LIMITS.themeErrors lines of at most LIMITS.themeErrorChars. */
  errors: string[];
  /** True when the file is broken and the office keeps showing the last good theme. */
  usingLastGood: boolean;
}

/** One theme file in the user's themes folder (`~/.middle-management/themes/`). */
export interface FrontDeskUserTheme {
  /** The file name, e.g. `pirate-ship.theme.json`; sent back as `themeAction.themeId`. At most LIMITS.themeIdChars. */
  id: string;
  /** Short name for display, at most LIMITS.nameChars. */
  label: string;
  /** At most LIMITS.descriptionChars. */
  description?: string;
  /** True when this is the theme in use. */
  current: boolean;
  /** True when the file is not valid JSON or has errors. */
  problems: boolean;
}

/** State of the "Teach Claude" skill install: not there, current, older than this build, edited by the user, or someone else's. */
export type ThemeSkillStatus = 'missing' | 'installed' | 'outdated' | 'modified' | 'foreign' | 'unknown';

/** What the "Make your own" part of the Theme tab shows. */
export interface FrontDeskMakeState {
  /** The themes folder with the home folder shortened to `~`, for display only (at most LIMITS.pathChars). Never sent back. */
  themesFolder: string;
  /** The skill's folder with the home folder shortened to `~`, for display only (at most LIMITS.pathChars). Never sent back. */
  skillFolder: string;
  skill: ThemeSkillStatus;
}

/** Everything the Front desk panel shows. Built by the host; carries no file system access. */
export interface FrontDeskState {
  source: FrontDeskSource;
  /** At most LIMITS.presets. */
  presets: FrontDeskPreset[];
  /** The theme files in the themes folder, at most LIMITS.userThemes. Absent until the host has listed the folder. */
  userThemes?: FrontDeskUserTheme[];
  /** True when the folder holds more than LIMITS.userThemes theme files. */
  userThemesTruncated?: boolean;
  make?: FrontDeskMakeState;
  settings: Record<FrontDeskSettingKey, FrontDeskSetting>;
}

/** Tabs of the Front desk panel. */
export type FrontDeskTab = 'theme' | 'settings' | 'staff' | 'colours' | 'about';

/** Every FrontDeskTab, in tab order. */
export const FRONT_DESK_TABS: readonly FrontDeskTab[] = ['theme', 'settings', 'staff', 'colours', 'about'];

/**
 * What a `themeAction` does. 'usePreset' and 'copyPreset' need a `presetId`, 'useUserTheme' needs a `themeId`; the others
 * must have neither.
 */
export type ThemeActionKind =
  | 'create'
  | 'choose'
  | 'open'
  | 'reload'
  | 'useBuiltin'
  | 'usePreset'
  | 'copyPreset'
  | 'useUserTheme'
  | 'openThemesFolder'
  | 'installSkill'
  | 'removeSkill'
  | 'copyPrompt';

/** Every ThemeActionKind. */
export const THEME_ACTIONS: readonly ThemeActionKind[] = [
  'create',
  'choose',
  'open',
  'reload',
  'useBuiltin',
  'usePreset',
  'copyPreset',
  'useUserTheme',
  'openThemesFolder',
  'installSkill',
  'removeSkill',
  'copyPrompt',
];

/** What `openSettingsUi` can open: a Front desk setting, or `themeFile` (the theme path, which the Theme tab shows). */
export type SettingsUiKey = FrontDeskSettingKey | 'themeFile';

/** Where `openSettingsUi` opens the Settings editor: the user's or the workspace's settings. */
export type SettingsTarget = 'user' | 'workspace';

// ---------------------------------------------------------------------------
// Round B contract: file room and catalogs. See docs/manager-mode.md section 16.
// ---------------------------------------------------------------------------

/** Where a file room root comes from: a workspace folder, an agent's working directory, or a project the user browsed to. */
export type FileRootKind = 'workspace' | 'agent' | 'project';

/** Every FileRootKind value. */
export const FILE_ROOT_KINDS: readonly FileRootKind[] = ['workspace', 'agent', 'project'];

/**
 * A folder the file room may browse. The webview refers to it only by `rootId`, which is opaque (the host keeps the map
 * to the real path). Requests carry `rootId` plus a relative path (`relPath`), never an absolute path.
 */
export interface FileRoot {
  /** Opaque, stable for the life of the host. The key of every file room request. */
  rootId: string;
  /** Short name, at most LIMITS.nameChars (folder name, or the agent's title). */
  label: string;
  kind: FileRootKind;
  /** The root's path with the home folder shortened to `~`, for display only (at most LIMITS.pathChars). Never sent back. */
  display: string;
  /**
   * The root's absolute path, so "Hand to a worker" can preselect the project on the memo (`MemoPrefill.projectPath`).
   * For display and prefill only; no request accepts it.
   */
  projectPath: string;
}

/** Kind of a folder entry. 'other' = a socket, device, broken link, or a link that leaves the root (listed, not openable). */
export type DirEntryKind = 'file' | 'dir' | 'other';

/** One entry of a `dirListing`. `name` is one path segment (never contains `/`). */
export interface DirEntry {
  name: string;
  kind: DirEntryKind;
  /** Size in bytes (files only). */
  size?: number;
  /** Modified time, epoch ms. */
  mtime?: number;
  /** True for a symbolic link that resolves inside the root (shown with a link badge). */
  link?: true;
  /** True when the name looks like a secret file (see the secret rules in section 16): it can be opened in the editor, never previewed. */
  secret?: true;
}

/** Sections of the catalog. */
export type CatalogSection = 'skills' | 'mcp' | 'handbook' | 'agents';

/** Every CatalogSection value. */
export const CATALOG_SECTIONS: readonly CatalogSection[] = ['skills', 'mcp', 'handbook', 'agents'];

/** Where a skill lives: the user's, synced from the account, the project's, or from a plugin. */
export type SkillSource = 'user' | 'synced' | 'project' | 'plugin';

/** Every SkillSource value. */
export const SKILL_SOURCES: readonly SkillSource[] = ['user', 'synced', 'project', 'plugin'];

/** One skill in the training library. */
export interface SkillItem {
  /** The skill's name, at most LIMITS.nameChars. */
  name: string;
  /** What to type after `/` (for a plugin skill `plugin:name`). "Use this" prefills the memo with `/<invoke> `. */
  invoke: string;
  /** From the skill's front matter, at most LIMITS.descriptionChars. Empty when it has none. */
  description: string;
  source: SkillSource;
  /** Plugin name, when `source` is 'plugin'. */
  plugin?: string;
  /** Opaque id for `openConfigFile` (the SKILL.md). Absent when the file cannot be opened. */
  fileId?: string;
  /** Times it was used, from Claude Code's `skillUsage` counters. Absent = no record. */
  uses?: number;
  /** Epoch ms of the last use, when recorded. */
  lastUsedAt?: number;
}

/** Where a slash command lives. 'builtin' = part of Claude Code itself. */
export type CommandSource = 'builtin' | 'user' | 'project' | 'plugin';

/** Every CommandSource value. */
export const COMMAND_SOURCES: readonly CommandSource[] = ['builtin', 'user', 'project', 'plugin'];

/** One slash command in the training library. */
export interface CommandItem {
  name: string;
  /** What to type after `/` (for a plugin command `plugin:name`). */
  invoke: string;
  /** At most LIMITS.descriptionChars. */
  description: string;
  source: CommandSource;
  plugin?: string;
  /** Hint such as `[issue number]`, at most LIMITS.nameChars. */
  argumentHint?: string;
  /** Opaque id for `openConfigFile` (the command's .md file). Absent for built-in commands. */
  fileId?: string;
}

/** Scope an MCP server is configured in. 'cloud' = connectors from the user's account. */
export type McpScope = 'user' | 'project' | 'local' | 'plugin' | 'managed' | 'cloud' | 'unknown';

/** Every McpScope value. */
export const MCP_SCOPES: readonly McpScope[] = ['user', 'project', 'local', 'plugin', 'managed', 'cloud', 'unknown'];

/** How the server is reached. Only the kind of transport; never where or how. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'sdk' | 'unknown';

/** Every McpTransport value. */
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse', 'ws', 'sdk', 'unknown'];

/** The phone's light: 'needsAuth' = needs sign-in. */
export type McpStatus = 'connected' | 'failed' | 'needsAuth' | 'pending' | 'disabled' | 'unknown';

/** Every McpStatus value. */
export const MCP_STATUSES: readonly McpStatus[] = ['connected', 'failed', 'needsAuth', 'pending', 'disabled', 'unknown'];

/**
 * One MCP server on the phone. Deliberately closed: the only free text is `name`, and there is no field for a command,
 * arguments, environment, headers, URL, error text or tool list, so none of them can be sent by accident. The host builds
 * it field by field (`MCP_SERVER_ITEM_KEYS` lists every key, and a test pins it).
 */
export interface McpServerItem {
  /** The name the user gave the server, at most LIMITS.nameChars. */
  name: string;
  scope: McpScope;
  transport: McpTransport;
  status: McpStatus;
  /** How many tools the server offers, when it is connected and the count is known. */
  tools?: number;
}

/** Every key of McpServerItem. A test fails when the interface and this list disagree. */
export const MCP_SERVER_ITEM_KEYS = ['name', 'scope', 'transport', 'status', 'tools'] as const satisfies readonly (keyof McpServerItem)[];

/** Scope of an instruction file (CLAUDE.md) or a settings file. 'managed' = set by an administrator. */
export type ConfigScope = 'managed' | 'user' | 'project' | 'local';

/** Every ConfigScope value. */
export const CONFIG_SCOPES: readonly ConfigScope[] = ['managed', 'user', 'project', 'local'];

/** One file on the notice board (a CLAUDE.md or a rules file). Only files that exist are listed. */
export interface HandbookFile {
  /** Opaque id for `openConfigFile`. */
  fileId: string;
  scope: ConfigScope;
  /** Short name, for example `CLAUDE.md`, `CLAUDE.local.md` or `rules/testing.md`, at most LIMITS.nameChars. */
  label: string;
  /** The file's path with the home folder shortened to `~`, for display only (at most LIMITS.pathChars). Never sent back. */
  display: string;
  /** Size in bytes, when known. */
  bytes?: number;
}

/** Type of a memory entry, from its front matter. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** Every MemoryType value. */
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** One entry of the project's memory (a file linked from `memory/MEMORY.md`). */
export interface MemoryEntry {
  /** Opaque id for `openConfigFile`. */
  fileId: string;
  /** File name, for example `no-tv-show-names.md`, at most LIMITS.nameChars. */
  file: string;
  /** The link text in MEMORY.md, at most LIMITS.nameChars. */
  title: string;
  /** The one-line hook after the link, at most LIMITS.descriptionChars. */
  hook?: string;
  type?: MemoryType;
}

/** What a permission rule does. */
export type RuleBehavior = 'allow' | 'deny' | 'ask';

/** Every RuleBehavior value. */
export const RULE_BEHAVIORS: readonly RuleBehavior[] = ['allow', 'deny', 'ask'];

/**
 * One permission rule from a settings file, for example `Bash(npm run test:*)`. Only the rule lists are forwarded:
 * `defaultMode`, `additionalDirectories` and every other settings key stay on the host.
 */
export interface PermissionRuleItem {
  behavior: RuleBehavior;
  /** The rule text, at most LIMITS.ruleChars. Render as a text node. */
  rule: string;
  /** Which settings file it comes from. */
  scope: ConfigScope;
  /** Opaque id of that settings file for `openConfigFile`. */
  fileId?: string;
}

/** Where a subagent type is defined. 'builtin' = part of Claude Code itself. */
export type AgentTypeSource = 'builtin' | 'user' | 'project' | 'plugin';

/** Every AgentTypeSource value. */
export const AGENT_TYPE_SOURCES: readonly AgentTypeSource[] = ['builtin', 'user', 'project', 'plugin'];

/** One subagent type in the temp agency. */
export interface AgentTypeItem {
  /** The `subagent_type` name, at most LIMITS.nameChars. */
  name: string;
  /** At most LIMITS.descriptionChars. */
  description: string;
  source: AgentTypeSource;
  plugin?: string;
  /** Model alias or id from the agent's front matter (`inherit` when it says so). Absent = not set. */
  model?: string;
  /** Tool names, at most LIMITS.toolsPerAgent of LIMITS.toolNameChars. Absent = all tools (inherits). */
  tools?: string[];
  /** Opaque id for `openConfigFile`. Absent for built-in types. */
  fileId?: string;
}

/**
 * The payload of a `catalog` reply, one shape per section. `truncated` = at least one list was cut at its LIMITS entry.
 * Every list is already sorted by the host (the webview does not need to sort to be stable).
 */
export type CatalogReply =
  | { section: 'skills'; skills: SkillItem[]; commands: CommandItem[]; truncated: boolean }
  | { section: 'mcp'; servers: McpServerItem[]; truncated: boolean }
  | {
      section: 'handbook';
      /** The CLAUDE.md chain, then rules files, in the order Claude Code loads them. */
      instructions: HandbookFile[];
      /** The project's `memory/MEMORY.md`, when it exists. */
      memoryIndex?: HandbookFile;
      memory: MemoryEntry[];
      /** Allow rules first, then ask, then deny; each group in file order. */
      rules: PermissionRuleItem[];
      truncated: boolean;
    }
  | { section: 'agents'; agents: AgentTypeItem[]; truncated: boolean };

/** Where an update check or install stands. */
export const UPDATE_STATUSES = ['idle', 'checking', 'upToDate', 'available', 'downloading', 'installed', 'error'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** What the user can do about an update: check now, install it, put it off for now, skip that version, or reload the window after installing. */
export const UPDATE_ACTIONS = ['check', 'install', 'later', 'skip', 'reload', 'notes'] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];

/** What the office knows about updates. */
export interface UpdateInfo {
  status: UpdateStatus;
  /** The running version, e.g. "0.5.0". */
  current: string;
  /** Newest published version, when known. */
  latest?: string;
  /** GitHub release page for `latest`. */
  notesUrl?: string;
  /** When the last check finished (ms since epoch). */
  checkedAt?: number;
  /** True when the user put this version off (later or skip): no in-office cue, but the About tab still shows it. */
  hidden?: boolean;
  /** Short plain reason, for status 'error' (or a quiet note such as "No releases have been published yet."). */
  message?: string;
  /** Whether automatic daily checks are on (setting claudeOffice.updateChecks). */
  auto: boolean;
}

/** Messages from the extension host to the webview. */
export type HostToWebview =
  | { type: 'agents'; agents: AgentSnapshot[] }
  | { type: 'settings'; settings: OfficeSettings }
  /** Reply to listProjects/browseProject. `defaultPath` is the preselected project (clicked worker's, else active workspace folder, else a just-browsed one). */
  | { type: 'projects'; projects: ProjectOption[]; defaultPath?: string }
  /** Full case file, sent after openCase. `truncated` = older items were omitted (LIMITS.caseItems). */
  | { type: 'caseFile'; agentId: string; header: CaseHeader; items: ConversationItem[]; pending: PendingRequest | null; truncated: boolean }
  /** Incremental update. `items` upsert by id (append when new, keep order). `pending`: undefined = unchanged, null = cleared, object = full replacement. `header` is a partial merge. */
  | { type: 'caseAppend'; agentId: string; items: ConversationItem[]; pending?: PendingRequest | null; header?: Partial<CaseHeader> }
  | { type: 'caseClosed'; agentId: string; reason: CaseClosedReason }
  /** To a case tab that is already open: the office now shows this worker with `look` (sent when the office asks to open the tab again). Addressed by `agentId`; the tab ignores it for another worker. */
  | { type: 'caseLook'; agentId: string; look: string }
  /** A newTask was accepted. `agentId` is the id the agent will have in `agents`. */
  | { type: 'taskStarted'; nonce: string; sessionId: string; agentId: string }
  /**
   * A failure. `nonce` ties it to a newTask; `reqId` ties it to a getPlan/getTurn call; `sessionId` / `requestId` tie
   * it to a session or a pending request when known (the webview shows it inline in the open case if it matches, else as a toast). Text is at most LIMITS.errorChars.
   * Since v0.5 `agentId` names the worker the failure concerns, when the host can tell (a failed openCase, openCaseTab or
   * sendHome always carries it), so a case tab can tell its own errors from another worker's. See docs/manager-mode.md section 18.
   */
  | { type: 'error'; nonce?: string; sessionId?: string; requestId?: string; reqId?: string; agentId?: string; message: string }
  /** Open the new-task memo (the `Middle Management: New Task` command). `projectPath` is the preselected project. */
  | { type: 'openMemo'; projectPath?: string }
  /** Plan usage. Cached by the officeView and replayed on `ready`, like `agents` and `settings`. */
  | { type: 'usage'; usage: UsageSnapshot }
  /** The user's Claude Code defaults and the model list. Cached by the officeView and replayed on `ready`. */
  | { type: 'claudeDefaults'; defaults: ClaudeDefaults }
  /**
   * Reply to setSessionOptions. `applied` = what took effect now (an office run); `deferred` = what was stored for the
   * session's next message (a free session). Both are empty objects when nothing changed. A failure arrives as `error`
   * with the same `nonce` and `sessionId`.
   */
  | { type: 'sessionOptions'; nonce: string; sessionId: string; applied: SessionOptions; deferred: SessionOptions }
  /** Reply to getPlan: one plan in full (at most LIMITS.planChars). A failure arrives as `error` with the same `reqId`. */
  | { type: 'planText'; reqId: string; agentId: string; planId: string; text: string; truncated?: boolean; status: PlanStatus; planFilePath?: string; feedback?: string }
  /** Reply to getTurn: the items of the latest turn (at most LIMITS.turnItems; `truncated` = earlier items omitted). */
  | { type: 'turn'; reqId: string; agentId: string; items: ConversationItem[]; truncated: boolean }
  /**
   * The Front desk's state. A reply to getFrontDesk / themeAction / setSetting / save carries that call's `reqId`; a
   * `frontDesk` without one is a push (the theme file or a setting changed). Not cached by the officeView.
   */
  | { type: 'frontDesk'; state: FrontDeskState; reqId?: string }
  /**
   * Final answer to a getFrontDesk / themeAction / setSetting / saveTheme / saveThemeAs call. `ok` false carries a
   * short `message` (at most LIMITS.errorChars). `conflict` = the file changed on disk since `rev` (offer Load it / Keep
   * mine). `cancelled` = the user dismissed a dialog (not an error). After a save the order is `settings`, `frontDesk`,
   * `frontDeskDone`.
   */
  | { type: 'frontDeskDone'; reqId: string; ok: boolean; message?: string; conflict?: boolean; cancelled?: boolean }
  /** Open the Front desk panel (the `Middle Management: Open Front Desk` command), optionally on a tab. Queued like `openMemo`. */
  | { type: 'openFrontDesk'; tab?: FrontDeskTab }
  /**
   * The folders the file room may browse (at most LIMITS.fileRoots). With a `reqId` it answers `getFileRoots`; without
   * one it is a push (an agent started, a project was browsed). May be cached and replayed on `ready`.
   */
  | { type: 'fileRoots'; roots: FileRoot[]; reqId?: string }
  /**
   * Reply to listDir: folders first, then files, each group by name, at most LIMITS.dirEntries. `truncated` = more entries
   * exist. `rootId` and `relPath` echo the request. A failure arrives as `error` with the same `reqId`.
   */
  | { type: 'dirListing'; reqId: string; rootId: string; relPath: string; entries: DirEntry[]; truncated: boolean }
  /**
   * Reply to readFile. `size` is the file's size in bytes. `text` is present only when the file was previewed, and is at
   * most LIMITS.previewBytes (`truncated` = the file is larger and was cut). It is absent, with the matching flag set,
   * when the file is `binary` (not text), `secret` (looks like a secret file: editor only) or `tooLarge` (over
   * LIMITS.previewMaxFileBytes, not read). `markdown` = render the text as markdown. A failure arrives as `error` with the same `reqId`.
   */
  | { type: 'fileText'; reqId: string; rootId: string; relPath: string; size: number; text?: string; truncated?: true; binary?: true; secret?: true; tooLarge?: true; markdown?: true }
  /** Reply to getCatalog: one section's items (see CatalogReply). A failure arrives as `error` with the same `reqId`. */
  | ({ type: 'catalog'; reqId: string } & CatalogReply)
  /**
   * The workers that have an open case tab, in the order the tabs were opened (at most LIMITS.caseTabs). Sent to the office
   * view only (a case tab ignores it), cached by the officeView and replayed on `ready`, and re-sent whenever a tab opens or
   * closes. The staff list uses it to mark those rows.
   */
  | { type: 'caseTabs'; agentIds: string[] }
  /** What the office knows about updates (the daily check, or a check the user asked for). Cached by the officeView and replayed on `ready`. */
  | { type: 'update'; update: UpdateInfo };

/** Messages from the webview to the extension host. All are validated by parseWebviewMessage. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'openCase'; agentId: string }
  | { type: 'closeCase' }
  | { type: 'listProjects' }
  /** Host shows a folder dialog and replies with `projects` (browsed folder included, as defaultPath). */
  | { type: 'browseProject' }
  | { type: 'newTask'; nonce: string; projectPath: string; prompt: string; assignTo: AssignTarget; permissionMode: PermissionMode; model?: string; effort?: EffortLevel }
  | { type: 'reply'; sessionId: string; text: string }
  | { type: 'decide'; requestId: string; decision: DecisionPayload }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'openInClaudeCode'; sessionId: string }
  /** Change model, effort or approvals. `options` has at least one key; `null` resets model/effort to the default. Answered by `sessionOptions`. */
  | { type: 'setSessionOptions'; nonce: string; sessionId: string; options: SessionOptions }
  /** Ask for a fresh usage reading (the host debounces to once every 60 s). The answer is a `usage` message. */
  | { type: 'refreshUsage' }
  /** Ask for one plan in full. `planId` is the plan's tool_use id. Answered by `planText`. */
  | { type: 'getPlan'; reqId: string; agentId: string; planId: string }
  /** Ask for the latest turn of an agent (for the in-tray report view). Answered by `turn`. */
  | { type: 'getTurn'; reqId: string; agentId: string }
  /** Ask for the Front desk state. Answered by `frontDesk` (same `reqId`) then `frontDeskDone`. */
  | { type: 'getFrontDesk'; reqId: string }
  /** A theme source action. `presetId` only with usePreset and copyPreset. Answered by `frontDesk` and `frontDeskDone`. No message carries a path: the host shows its own file dialogs. */
  | { type: 'themeAction'; reqId: string; action: ThemeActionKind; presetId?: string; themeId?: string }
  /** Change a user setting (written to the user's settings, never the workspace's). `null` resets it to the default. */
  | { type: 'setSetting'; reqId: string; key: FrontDeskSettingKey; value: string | boolean | null }
  /** Save the theme file. `rev` is `FrontDeskState.source.rev`; a mismatch answers `conflict` unless `force` is true. */
  | { type: 'saveTheme'; reqId: string; rev: string; themeJson: string; force?: true }
  /** Save as a new file (the host shows a Save dialog), then switch to it. */
  | { type: 'saveThemeAs'; reqId: string; themeJson: string }
  /** Open VS Code's Settings editor on one of the Front desk's settings, or on the theme file path. */
  | { type: 'openSettingsUi'; key: SettingsUiKey; target: SettingsTarget }
  /** Ask for the file room's roots. Answered by `fileRoots` with the same `reqId`. */
  | { type: 'getFileRoots'; reqId: string }
  /** List a folder (`relPath` '' = the root itself). Answered by `dirListing`. */
  | { type: 'listDir'; reqId: string; rootId: string; relPath: string }
  /** Preview a file. Answered by `fileText`. */
  | { type: 'readFile'; reqId: string; rootId: string; relPath: string }
  /** Open a file in the editor. Fire and forget; a failure arrives as an `error` without ids (a toast). */
  | { type: 'openFile'; rootId: string; relPath: string }
  /** Open the editor's diff of a file against git HEAD. Fire and forget, like openFile. */
  | { type: 'openDiff'; rootId: string; relPath: string }
  /**
   * Ask for one catalog section. `rootId` picks the project the project-scoped items come from (default: the active workspace folder).
   * `refresh: true` (only the panels' explicit Refresh and Try again buttons set it) bypasses the host's caches (60 s for the
   * catalog, 30 s for the MCP statuses); opening a panel never sets it. Answered by `catalog`.
   */
  | { type: 'getCatalog'; reqId: string; section: CatalogSection; rootId?: string; refresh?: true }
  /** Open a config file the catalog listed (skill, command, agent, CLAUDE.md, memory, settings) in the editor. `fileId` comes from a `catalog`. Fire and forget. */
  | { type: 'openConfigFile'; fileId: string }
  /**
   * Open that worker's case tab, or focus it when it is already open. Sent by the office view when it is wide (the drawer
   * stays for a narrow sidebar). Fire and forget: success is seen as `caseTabs`; a failure arrives as an `error` with `agentId`.
   */
  | { type: 'openCaseTab'; agentId: string; look?: string }
  /**
   * Send an idle worker home (the x on a staff row). Fire and forget: success is seen as the worker leaving `agents`; a
   * refusal (not idle, not a main worker, unknown) arrives as an `error` with `agentId`.
   */
  | { type: 'sendHome'; agentId: string }
  /** Act on the update offer (or ask for a check). Touches no Claude session, so it is allowed in view mode. Answered by `update` messages. */
  | { type: 'updateAction'; action: UpdateAction };

// ---------------------------------------------------------------------------
// v0.5 contract: case tabs and sending workers home. See docs/manager-mode.md section 18.
// ---------------------------------------------------------------------------

/**
 * What the host tells a case tab at boot, as JSON in `<script type="application/json" id="mm-boot">` in the panel's HTML
 * (no inline code, so the CSP stays strict). The tab reads it with `parseCaseTabBoot`. The office views have no boot data.
 * A tab is bound to one worker for its whole life.
 */
export interface CaseTabBoot {
  mode: 'case';
  /** The worker this tab shows. */
  agentId: string;
  /** The look the office gave this worker (v0.5.x), so the portrait matches. Optional; the tab falls back to its own guess when absent or unknown. */
  look?: string;
}

/** Shape of a look id on the wire (`openCaseTab.look`, `CaseTabBoot.look`, `caseLook.look`). Every built-in id (`staff-0`, `temp3`, `manager`, `receptionist`, the archetypes) fits. */
export const LOOK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Id of the `<script type="application/json">` element that carries a `CaseTabBoot`. */
export const CASE_TAB_BOOT_ELEMENT_ID = 'mm-boot';

/** What a case tab knows about its own case, for `forAnotherCase`. `sessionId` and `requestId` are absent until the header and a pending request exist. */
export interface CaseAddress {
  agentId: string;
  sessionId?: string;
  requestId?: string;
}

/**
 * True when a host message explicitly addresses a different worker, session or request than `own`, so a case tab (and the
 * host, when it decides who gets an unsolicited message) can ignore it. It is deliberately lenient: a message with no
 * address at all, or only a `nonce` / `reqId` (answers to the tab's own calls, which the host sends to the caller only),
 * is NOT for another case. Only these types carry an address: `caseFile`, `caseAppend`, `caseClosed`, `planText` and
 * `turn` (by `agentId`), `sessionOptions` (by `sessionId`) and `error` (by `agentId`, else `sessionId`, else `requestId`).
 * Every other type (shared state such as `agents` and `settings`) returns false.
 */
export function forAnotherCase(msg: HostToWebview, own: CaseAddress): boolean {
  switch (msg.type) {
    case 'caseFile':
    case 'caseAppend':
    case 'caseClosed':
    case 'caseLook':
    case 'planText':
    case 'turn':
      return msg.agentId !== own.agentId;
    case 'sessionOptions':
      return own.sessionId !== undefined && msg.sessionId !== own.sessionId;
    case 'error':
      if (msg.agentId !== undefined) return msg.agentId !== own.agentId;
      if (msg.sessionId !== undefined) return own.sessionId !== undefined && msg.sessionId !== own.sessionId;
      if (msg.requestId !== undefined) return own.requestId !== undefined && msg.requestId !== own.requestId;
      return false;
    default:
      return false;
  }
}

/** Default of `claudeOffice.sendHomeAfter`, in hours. */
export const SEND_HOME_AFTER_DEFAULT_HOURS = 8;

/** Largest accepted `claudeOffice.sendHomeAfter`, in hours (30 days). */
export const SEND_HOME_AFTER_MAX_HOURS = 720;

/**
 * Reads `claudeOffice.sendHomeAfter` (hours) into milliseconds. `0` = never (returns 0). A finite number from 0 up is
 * clamped to SEND_HOME_AFTER_MAX_HOURS (fractions allowed: 0.5 is thirty minutes). Anything else (missing, a string,
 * negative, NaN, Infinity) gives the default (8 hours). Callers treat 0 as "off".
 */
export function sendHomeAfterMs(v: unknown): number {
  const hours = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, SEND_HOME_AFTER_MAX_HOURS) : SEND_HOME_AFTER_DEFAULT_HOURS;
  return Math.round(hours * 3_600_000);
}
