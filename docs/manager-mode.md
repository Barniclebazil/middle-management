# Manager Mode build guide

Contract for the four parallel build tasks (7.1 to 7.4) and the integration task (8.1). The types live in `src/shared/protocol.ts`; untrusted webview messages are checked by `parseWebviewMessage` in `src/shared/validate.ts`. SDK facts come from `docs/sdk-spike.md`. Design: the approved plan (Experience and Architecture sections).

Conventions (CONTRIBUTING.md): erasable TypeScript only, `.ts` import extensions, `import type`. `src/shared`, `src/model` and `src/claude` never import `vscode`. No runtime dependencies other than the bundled SDK.

## 1. Vocabulary

- **Agent**: one character in the office (`AgentSnapshot`). A main agent is one Claude Code session; a temp is a subagent.
- **Office run**: a session started by this extension through the SDK, held in `src/manager/sessionRunner.ts`.
- **Case file**: the drawer showing one agent's conversation (`caseFile` / `caseAppend`).
- **Pending request**: a `canUseTool` call waiting for the user (`PendingRequest`).
- **Memo**: the new-task form.

## 2. Contract summary

Existing messages are unchanged. New ones:

| Direction | Message | Meaning |
| --- | --- | --- |
| webview to host | `openCase {agentId}` | open the case file for an agent |
| | `closeCase` | stop streaming the open case |
| | `listProjects` | request the project list |
| | `browseProject` | open the folder dialog |
| | `newTask {nonce, projectPath, prompt, assignTo, permissionMode, model?}` | hire or resume |
| | `reply {sessionId, text}` | message to an office-run or free session |
| | `decide {requestId, decision}` | answer a pending request |
| | `interrupt {sessionId}` | end the current turn |
| | `openInClaudeCode {sessionId}` | jump to the Claude Code panel |
| host to webview | `projects {projects, defaultPath?}` | project list |
| | `caseFile {agentId, header, items, pending, truncated}` | full snapshot |
| | `caseAppend {agentId, items, pending?, header?}` | incremental update |
| | `caseClosed {agentId, reason}` | host closed the case |
| | `taskStarted {nonce, sessionId, agentId}` | newTask accepted |
| | `error {nonce?, sessionId?, requestId?, message}` | failure; `sessionId` / `requestId` are set where known |
| | `openMemo {projectPath?}` | open the new-task memo (the `Middle Management: New Task` command) |

Rules every module follows:

- `AgentSnapshot` additions (`sessionId`, `cwd`, `gitBranch`, `control`, `pending`, `costUsd`) are optional. A missing `control` means `'none'`.
- Times are epoch milliseconds. Character limits are the `LIMITS` constants (prompt 20,000; tool preview 2,000; summary 200; 300 items; plan 40,000; and so on). Hosts cut with a trailing `...` and set `truncated` where the type has it.
- `ConversationItem.id` is stable. A `caseAppend` item whose id already exists replaces that item in place; a new id appends. Streaming assistant text uses one id (`<apiMessageId>:<blockIndex>`), `streaming: true` until the full `assistant` message arrives, which carries the same id with `streaming` absent.
- `caseAppend.pending`: `undefined` (key absent) leaves the current request, `null` clears it, an object replaces it. `caseAppend.header` is a partial merge.
- `NoticeKind` is `'interrupted' | 'error' | 'cost' | 'info'`. `info` is a neutral row (for example "Conversation compacted" on a `compact_boundary`); the webview renders it dimmed, without the warning or error colours.
- The webview only ever sees `canAlwaysAllow` and `alwaysLabel`. The host keeps the raw SDK `suggestions`, keyed by `requestId`.
- Webview text is rendered with text nodes. Never `innerHTML`.
- Validation: the host runs every inbound message through `parseWebviewMessage`; `undefined` means drop and (optionally) log. The host then does the checks the validator cannot (path exists, session is in the right state, request exists, kind matches).

## 3. How `control` is computed (7.1, `control.ts`)

Per agent, recomputed on every feed update and right before any action:

1. `kind === 'temp'` -> `'none'`.
2. The `sessionId` is held by a live runner in this extension -> `'office'`.
3. A live `~/.claude/sessions/<pid>.json` has this `sessionId` and the pid is alive -> `'elsewhere'`. This includes a session this extension started in a previous window that is still running, and any `entrypoint`; the tag does not grant control, only the runner map does.
4. Otherwise -> `'free'`.

Notes:

- "Alive" means the pid exists (`process.kill(pid, 0)`) and the file is not stale; reuse the existing liveness logic in `src/claude/sessions.ts`.
- The runner map beats the sessions file: an office run also has a live `sessions/<pid>.json` (its `entrypoint` is `claude-office`) and must still be `'office'`.
- Before a resume (`newTask` with `assignTo: existing`, or `reply` to a `free` session) re-check step 3 synchronously. If now live, reply with `error` and do not start anything.
- A finished office run (generator closed) drops out of the map and becomes `'free'`.
- The model (7.4) copies `control` from a host-supplied lookup; it does not compute it. See section 11.

## 4. The env tag and the join key (7.1, 7.4)

- Every office run is spawned with `CLAUDE_CODE_ENTRYPOINT=claude-office`. The value appears as `entrypoint` in `~/.claude/sessions/<pid>.json` and on transcript records. It is used for display ("started here") and diagnostics, never for authority.
- Join key is `sessionId`. The runner learns the id from the first SDK message (`session_id` on every message; on resume it is the id passed in). Agents are matched to runs by `AgentSnapshot.sessionId`, so the watcher's character and the run are one worker. Never create a second character for an office run.
- A `taskStarted` is sent as soon as the `sessionId` is known. `agentId` is the id the agent has in the `agents` message: the host looks it up by `sessionId` in the latest snapshot list. If the character has not appeared yet (the watcher sees the transcript within about a second), the host waits for the next feed update that contains the `sessionId` (timeout 5 s, then send `taskStarted` with the best known id and keep waiting for the case to open by `sessionId`). The webview then sends `openCase` with that `agentId`.

## 5. SDK `query()` options (7.1, `sessionRunner.ts`)

```ts
query({
  prompt: inputQueue,                         // AsyncIterable<SDKUserMessage>, streaming input
  options: {
    cwd: projectPath,                         // must exist and be a directory
    pathToClaudeCodeExecutable: claudeBin,    // section 6
    settingSources: ['user', 'project', 'local'],
    permissionMode,                           // ALWAYS explicit: 'default' | 'acceptEdits' | 'plan'
    model,                                    // only when the memo set one; omit otherwise (user's default, currently opus)
    includePartialMessages: true,
    canUseTool,
    abortController,
    resume: sessionId,                        // only for existing/free sessions
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-office' },
    stderr: (s) => log(s),
  },
});
```

- Never pass `bypassPermissions` or `allowDangerouslySkipPermissions`; `PermissionMode` cannot express it and the validator rejects it.
- No `maxBudgetUsd` and no `maxTurns` by default.
- `env` replaces the child environment, so always spread `process.env`. Delete inherited markers other than the tag: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_PID`, and other `CLAUDE_CODE_*` keys, then set the entrypoint.
- Input messages: `{ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }`. The generator stays open after each `result`; end the input queue (or abort) to finish a worker.
- A `result` with any subtype ends a turn, not the query. `subtype !== 'success'` yields a `notice` item (`error`, or `interrupted` for `error_during_execution` after an interrupt).
- Cost: `result.total_cost_usd` is per turn. The runner sums it into `costUsd`, adds a `notice` item `{notice:'cost', costUsd: <turn>}` per result, and puts the running sum in `header.costUsd`.
- Model: show `system/init.model` (the full id) in `header.model`. Plan mode may run on a different model than requested (spike section 5c): update `header.model` from each `assistant` message's `message.model`, and mention in the memo's plan-first option that plan mode can cost much more.
- Permission mode: `header.permissionMode` follows `system/status.permissionMode` (approving a plan changes it).
- Hold the raw `suggestions` per `requestId`. "Always allow" returns `{ behavior:'allow', updatedInput: input, updatedPermissions: suggestions }`.
- Always return an object from `canUseTool`. Resolve every outstanding pending promise (deny) when its `signal` aborts, the run stops, or the extension deactivates.

### Pending requests from `canUseTool` (7.1)

`requestId`: the SDK's `toolUseID` prefixed with the sessionId, or a counter, as long as it is unique per request.

- **permission** (any tool except the two below). `summary` is one line; `fields` come from the input:
  - Bash: `Command` (`command`, code), `Description` (`description`)
  - Edit / MultiEdit: `File` (`file_path`), `Old` (`old_string`, code), `New` (`new_string`, code)
  - Write: `File`, `Content` (first `LIMITS.fieldChars` chars, code)
  - Read / Glob / Grep / LS / NotebookEdit: the path or pattern fields
  - WebFetch: `URL` (`url`), `Prompt`; WebSearch: `Query`
  - anything else (including MCP tools): up to `LIMITS.fields` top-level input keys, string values cut, non-strings as compact JSON
  - add `blockedPath` as `Path` when present; `reason` = `decisionReason`/`description`/`title` when provided
  - `canAlwaysAllow` is `suggestions.length > 0`. `alwaysLabel` is built from the first `addRules` suggestion (`Always allow "echo office-ok *"`), `setMode` as "Auto-accept file edits this session", else "Always allow".
- **question** (`AskUserQuestion`): map `input.questions[]` to `QuestionSpec[]` (clamp to `LIMITS.questions`/`LIMITS.options`). The decision `answer` maps to `updatedInput: { questions: input.questions, answers }` where each value is a string; for `multiSelect` join labels with `, `. If `other[question]` is set, a single-select answer becomes that text; a multi-select answer gets it appended.
- **plan** (`ExitPlanMode`): `plan` and `planFilePath` from the input. Approve -> `{ behavior:'allow', updatedInput: input }`. Reject -> `{ behavior:'deny', message: feedback ?? 'Keep planning.' }`.
- Decision kind must match the request kind; a mismatch is an `error` and the request stays pending. One exception: `{kind:'deny', message?}` is also valid for a **question** ("Skip question"), and maps to `{ behavior:'deny', message: message ?? 'The user chose not to answer. Continue without this information, or make a reasonable assumption.' }` (no `interrupt`). A plan accepts only `plan`; a permission accepts `allow` and `deny`. `deny` on a permission request is `{ behavior:'deny', message: message ?? 'The user declined.' }` (no `interrupt: true`).

## 6. Claude binary lookup (7.1, `claudeBinary.ts`)

First hit that exists as a file wins. Do not run `.cmd`/`.bat` shims: the SDK spawns without a shell. On `win32` use `claude.exe` only; elsewhere `claude`.

1. Setting `claudeOffice.claudePath` (if non-empty and it exists).
2. The Claude Code extension: `vscode.extensions.getExtension('anthropic.claude-code')`, then `<extensionPath>/resources/native-binary/claude[.exe]`. If `getExtension` returns nothing, scan `vscode.extensions.all` for an entry whose id is `publisher.name` with publisher `anthropic` and name `claude-code` (case-insensitive) and use its `extensionPath`. Keep the `vscode` access behind a small injected interface so the lookup is unit-testable.
3. `~/.local/bin/claude[.exe]`.
4. Search `PATH` for `claude` (`claude.exe` on win32 only).

If nothing is found, send `error` with a message that names the setting and says to install the Claude Code extension. Check the binary version (`claude --version`, cached) against the pinned SDK (0.3.302 pairs with CLI 2.1.302) and warn, without blocking, on a mismatch.

## 7. esbuild recipe (8.1, `esbuild.mjs`)

The SDK (`@anthropic-ai/claude-agent-sdk`, exactly 0.3.302) is bundled into `dist/extension.js`; no platform binaries ship in the vsix. Its one `import.meta.url` use must be defined away, or the bundle crashes at load:

```js
await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'],
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
});
```

Keep the existing extension build flags; add `define` and `banner` to that entry only (not the webview bundle). Import the SDK in one file only (`sessionRunner.ts`), behind an injectable `queryFn` so tests use a fake. No top-level await.

## 8. Message flows

Notation: W = webview, H = host, SDK = Agent SDK query. Every inbound message is first run through `parseWebviewMessage`.

### 8.1 New task, new hire

1. W: `listProjects`. H: `projects {projects, defaultPath}` (workspace folders first, then recent cwds from transcripts/live files, then browsed; each with `gitBranch`, `exists`).
2. User fills the memo. W: `newTask {nonce, projectPath, prompt, assignTo:{kind:'new'}, permissionMode, model?}`.
3. H: validate; `projectPath` must be an existing directory (else `error {nonce}`); the binary must be found (else `error {nonce}`).
4. H: create a runner (`cwd`, `permissionMode`, `model`, env tag), push the prompt, start consuming messages.
5. First SDK message gives `session_id`. H: `taskStarted {nonce, sessionId, agentId}` (section 4).
6. Watcher sees the transcript; the character appears in `agents` with `sessionId`, `control:'office'`, `costUsd`.
7. W: walks the new hire in, then `openCase {agentId}` (flow 8.9). Any failure before step 5: `error {nonce, message}` and nothing is left running.

### 8.2 New task to an existing free worker (resume)

1. W: `newTask {..., assignTo:{kind:'existing', sessionId}}`; `projectPath` is that session's `cwd`.
2. H: re-check `control` for `sessionId` (section 3). If not `'free'` -> `error {nonce, message}`. Also reject if `sessionId` is an unknown main session.
3. H: runner with `resume: sessionId` and the same `cwd`; the prompt is the first input message.
4. `taskStarted {nonce, sessionId, agentId}` immediately (the id is known). The same transcript file continues; the agent flips to `control:'office'`.
5. If the case for this agent is open, H sends a `caseAppend` with `header {control:'office', busy:true, ...}` and switches the case source from the transcript tail to the runner (section 8.9).

When no model is chosen, a resumed session continues on the model it last used: the model this window's runner last reported, else the last assistant record's model in the transcript tail. An explicit model from the memo always wins.

### 8.3 Reply to an office-run worker (send now or queue)

1. W: `reply {sessionId, text}` from the case footer.
2. H: the runner for `sessionId` must exist (else `error`). If the agent is `free` the reply behaves as 8.2 without a nonce, on a `reply`-started runner (permission mode: the last one used for that session, else `'default'`).
3. H pushes the text onto the runner's input queue. This is the same call whether idle ("send now") or busy ("queue"): the SDK processes it after the current turn. The webview's wording differs only by `header.busy`.
4. H echoes immediately: `caseAppend {items:[{kind:'prompt', id, text}]}` (the id is the id the transcript will later use, or a local id replaced when the transcript record arrives; do not show duplicates).
5. Turn output streams as `assistant` items (flow 8.9); a `result` adds the cost `notice` and `header {busy:false, costUsd}`.

### 8.4 Approval (permission request)

1. SDK calls `canUseTool(toolName, input, opts)` for a non-question, non-plan tool. H registers a pending entry (promise, raw suggestions) under a new `requestId`, and the agent snapshot gets `pending {requestId, kind:'permission'}`, which forces activity `needsYou` (7.4).
2. H, if that agent's case is open: `caseAppend {pending: <PendingRequest>}`.
3. User clicks the worker (or roster row), W: `openCase`. The case file carries `pending`; W shows the approval card.
4. W: `decide {requestId, decision:{kind:'allow'}}`, `{kind:'allow', always:true}` (only when `canAlwaysAllow`) or `{kind:'deny', message?}`.
5. H resolves the promise, deletes the entry, publishes `caseAppend {pending:null}` and a fresh `agents` (the `pending` is gone, worker returns to its desk).
6. Unknown, already-answered, or mismatched `requestId`: `error {message, requestId?, sessionId?}`, no state change. A second decision for the same id is ignored.

### 8.5 Question (AskUserQuestion)

As 8.4 but `pending.kind === 'question'` with `questions`. W: `decide {requestId, decision:{kind:'answer', answers:{[questionText]: label | label[]}, other?:{[questionText]: text}}}`, or `{kind:'deny', message?}` from the card's "Skip question" button (the worker is told the user chose not to answer and carries on). The host verifies every question text in `answers` belongs to the request and each label is one of its options (or has an `other` entry); otherwise `error` and the request stays pending.

### 8.6 Plan (ExitPlanMode)

As 8.4 but `pending.kind === 'plan'`. W: `decide {requestId, decision:{kind:'plan', approve:true}}` or `{approve:false, feedback?}`. On approve the SDK leaves plan mode itself; H updates `header.permissionMode` from `system/status`.

### 8.7 Interrupt / stop

1. W: `interrupt {sessionId}`.
2. H: runner must exist (else `error`). H aborts any pending requests of that run (deny with the message "Interrupted") and calls `await query.interrupt()`.
3. SDK emits `result/error_during_execution`. H adds `notice {notice:'interrupted'}` plus the cost notice, `header {busy:false}`, `pending:null`.
4. The session is still alive; the next `reply` continues it. A session is ended only by deactivate or by the runner finishing (input queue closed); there is no separate "end session" message in this version.

### 8.8 Open in Claude Code

1. W: `openInClaudeCode {sessionId}` (case header button; always available for main agents).
2. H: executes `claude-vscode.editor.open` with the session id (command registered by the Claude Code extension). If that command is missing, fall back to opening the URI `vscode://anthropic.claude-code/open?session=<id>`; if that fails too, `error {message}`.
3. No state change in the office. For an `'elsewhere'` agent this is the only way to act.

### 8.9 Case file: open, snapshot, appends, close

1. W: `openCase {agentId}`. H: look up the agent; unknown -> `error`. Only one case is open per webview; opening another implicitly closes the previous (H sends `caseClosed {agentId: previous, reason:'replaced'}` only if it considers the first still shown; W may ignore it).
2. H builds items:
   - `control === 'office'`: from the runner's retained message history (SDK messages) plus the transcript for turns before this run (resumed sessions);
   - otherwise: from the transcript tail (`transcriptReader.ts` reads the end of `<session>.jsonl`, at most `LIMITS.caseItems` items, `truncated` true if older ones were dropped).
   Temps: items from their sidechain transcript, read-only.
3. H sends `caseFile {agentId, header, items, pending, truncated}`; `pending` is the current request of an office run or `null`.
4. While open: for office runs every SDK message is converted (`conversation.ts`) and sent as `caseAppend`; for other sessions the watcher's batches for that transcript are converted. Batch appends: at most 4 per second, merged.
5. Duplicates: the transcript of an office run also contains its records. While the runner is the source, ignore transcript batches for that session. When the runner ends the host does one final transcript-based refresh only if the ids differ (same ids upsert harmlessly).
6. `control` changes (free -> office after a resume, office -> free after the run ends, elsewhere -> free when the other process exits) are sent as `caseAppend {header:{control}}`.
7. W: `closeCase` (or Esc, or opening another case): H stops streaming and drops the case state. H closes on its own with `caseClosed {agentId, reason}`: `'agentGone'` when the agent leaves the roster, `'error'` if the transcript is unreadable.
8. Reconnect: when the webview becomes visible again after being hidden, H re-sends `projects` on demand only; if a case was open it re-sends `caseFile`.

## 9. Safety rules

- Never `bypassPermissions`; `permissionMode` is always one of the three explicit values.
- Every webview message goes through `parseWebviewMessage`; then host-side checks (project path exists and is a directory, `sessionId` known, `requestId` pending, decision kind matches, `always` only with `canAlwaysAllow`).
- Never resume a session whose live pid is alive (`control !== 'free'`), re-checked immediately before spawning.
- Never read `~/.claude/sessions/*.key` (only `<digits>.json`).
- One runner per `sessionId`; a second `newTask`/`reply` to the same session reuses it or errors; never two.
- All pending promises are resolved (deny) on interrupt, run end, abort `signal`, and deactivate. No promise is left dangling.
- Stop button = `interrupt()`. On deactivate: deny all pending, `interrupt()` every runner, end the input queues, abort, wait briefly (at most 3 s) for exit.
- No tool output or prompt goes to logs by default; log lengths and ids only.
- The webview renders with text nodes only.
- Real SDK runs in tests and spikes use Haiku in the scratchpad.

## 10. Reload caveat

Office-run workers are child processes of the extension host. Reloading the window (or closing it) stops them, the same as the Claude Code panel. They then appear as `'free'` workers and can be continued with `reply` or a new task (resume). Warn in the README and in the first-run text; never reload automatically.

## 11. Module ownership

Each task edits only its own files. Cross-module hooks are defined here so the tasks can be built and tested separately.

| Task | Owner of | Notes |
| --- | --- | --- |
| 6.3 (this contract) | `src/shared/*`, `docs/manager-mode.md`, `test/shared-validate.test.ts` | done |
| 7.1 Host manager | `src/manager/*` except the two below: `claudeBinary.ts`, `projects.ts`, `sessionRunner.ts`, `control.ts`, `pending.ts` (registry), `managerHost.ts` (message handler: routes validated `WebviewToHost`, emits `HostToWebview`), `index.ts`, with tests `test/manager-*.test.ts` | Exports for 8.1: `createManagerHost(deps)` with `handle(msg)`, `onAgents(snapshots)`, `dispose()`; `deps` injects `post(msg)`, `getAgents()`, `readCase`, `queryFn`, binary lookup, vscode adapters. Exports `controlFor(agent, liveSessions, runnerIds)` and `getOfficeInfo(sessionId)` -> `{ pending?, costUsd? }` for the model hook |
| 7.2 Conversation reader | `src/manager/conversation.ts`, `src/manager/transcriptReader.ts`, tests `test/manager-conversation.test.ts`, fixtures | Pure functions: `itemsFromTranscript(records)`, `itemsFromSdkMessage(msg, state)`, `readTail(file, maxItems)`; applies `LIMITS`; no `vscode`. Tool summaries: 'Read app.ts', 'Ran npm test', 'Edited x.ts', 'Searched for "foo"' and so on |
| 7.3 Webview | `webview/*`, `dev/harness*` | Drawer, memo, cards, click handling, mock host with fake conversations/requests. Consumes only `src/shared/protocol.ts`. Posts only the messages in section 2 |
| 7.4 Model | `src/model/*`, tests `test/model-*.test.ts` | `AgentState` takes an optional lookup `officeInfo(sessionId)` to set `pending` (forces `needsYou` immediately, no 4 s/15 s guessing) and `costUsd`; carries `sessionId`, `cwd`, `gitBranch` from transcript records; `control` is supplied by a lookup `controlOf(agent)` from 7.1 (default `'none'` for temps, `'free'` for mains when absent) |
| 8.1 Integration (done, see section 12) | `src/extension.ts`, `src/view/officeView.ts`, `src/host/officeFeed.ts`, `esbuild.mjs`, `package.json` (command `claudeOffice.newTask`, setting `claudeOffice.claudePath`) | Wires the manager host: inbound webview messages -> `parseWebviewMessage` -> `host.handle`; `host.onAgents` on every feed publish; `post` for new HostToWebview types (officeView.post must only cache `agents`/`settings`); esbuild recipe (section 7); deactivate path (section 9) |

`src/view/officeView.ts` was minimally touched by 6.3 only to keep the `post` type narrowing compiling (`else if (msg.type === 'settings')`); 8.1 owns it from here.

## 12. Integration (8.1)

Wiring, in the order a message travels:

1. `OfficeView` (`src/view/officeView.ts`) runs every inbound webview message through `parseWebviewMessage`. An invalid one is dropped and logged (type name only). `ready` replays the cached `agents` and `settings` to that webview, flushes a queued `openMemo`, and is also handed to the host (which re-sends the open case). Everything else goes to the extension's `onMessage` hook. `post()` broadcasts every `HostToWebview` message but caches only `agents` and `settings`.
2. `extension.ts` builds the manager host from `src/host/managerAdapters.ts` (the only place that maps VS Code APIs to `ManagerHostDeps`: binary lookup with the `claudeOffice.claudePath` setting and every `anthropic.claude-code` extension path, `readCaseFor` with a transcript locator over the feed's latest sessions, folder dialog, `executeCommand`, `openUri` using `vscode.env.uriScheme`, `statSync` checks, `refreshAgents`). The `AgentTracker` gets `officeInfo: sid => host.getOfficeInfo(sid)` and `controlOf: a => host.controlFor(a)`. Every `agents` publish also calls `host.onAgents(snapshots)`. `deactivate` awaits `host.dispose()`.
3. `OfficeFeed.refreshNow()` publishes a changed snapshot immediately, skipping the 250 ms throttle gap. The host calls it (through `refreshAgents`) when a request is raised or answered, on cost changes and when a run starts or ends, so a knocking worker shows at once. `OfficeFeed.latestSessions()` is the watcher's latest session set, used by `src/host/transcriptLocator.ts` (a main agent maps to `SessionInfo.transcriptPath`, a temp `<sessionId>/<agentId>` to the matching subagent file).
4. Demo mode: demo agents are not real. While `feed.isDemo()`, `openCase`, `newTask`, `reply`, `decide`, `interrupt` and `openInClaudeCode` are answered with `error "Demo workers can't take orders. Turn off demo mode to manage real sessions."` (`src/host/demoGuard.ts`) and never reach the host. Demo snapshots are not passed to `host.onAgents`; turning demo on tells the host the roster is empty, which closes any open case.
5. `claudeOffice.newTask` ("Middle Management: New Task") picks the active editor's workspace folder (else the first), and calls `OfficeView.showMemo(path)`. If no office is visible it focuses the office view first (editor tab as a fallback). The `openMemo {projectPath}` message is held until a webview has sent `ready`, so it is not lost on a freshly created view.
6. Errors: the host sets `sessionId` / `requestId` where it knows them. The webview shows an `error` in the open case (an inline banner under the conversation) when its `sessionId` matches the open case's session or its `requestId` matches the shown request, else as the toast. An `error` with a `nonce` goes to the memo first.

Build: `esbuild.mjs` bundles the SDK into `dist/extension.js` only (recipe in section 7), and bakes the SDK's version and its `claudeCodeVersion` into the bundle (`__SDK_VERSION__`, `__SDK_CLAUDE_CODE_VERSION__`) for the version check. The vsix contains no SDK platform binary and no `node_modules` (`.vscodeignore` is a whitelist).

Version sanity (log only): at activation the output channel gets a line naming the Claude Code extension version that supplies the binary (its `package.json`, else its folder name) and the SDK version with the Claude Code version it was built for. A `WARNING:` line is logged when the two differ in major.minor. A binary that does not come from the extension (setting, `~/.local/bin`, PATH) is not run at startup; the line says so. It never blocks anything.

Verification scripts: `node dev/bundle-smoke.cjs` loads `dist/extension.js` in plain node with a stub `vscode` (needs `npm run build`; no API calls, it points the binary at `/bin/false` to prove the SDK chunk loads), and `node dev/manager-e2e.ts` is the real end-to-end run on Haiku in a scratch project (a few cents; see the header of the file).

## 13. Round A messages and fields (task 1.2)

The Round A contract lives in `src/shared/protocol.ts` (types, `LIMITS`) and `src/shared/validate.ts` (`parseWebviewMessage`). Design: the "Office tools" plan. Epoch times are milliseconds. Strings the host sends are capped by the `LIMITS` named below.

### Types

| Type | What it is |
| --- | --- |
| `EffortLevel`, `EFFORT_LEVELS` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, lowest first |
| `SessionOptions` | `{ model?: string \| null; effort?: EffortLevel \| null; permissionMode?: PermissionMode }`. `null` = reset to the default; absent = leave as is. `bypassPermissions` cannot be expressed (it is not a `PermissionMode`) |
| `PlanStatus`, `PlanRef` | `'pending' \| 'approved' \| 'rejected' \| 'superseded'`; `{ id (tool_use id), at, title, status, chars, decidedAt? }` |
| `UsageSnapshot`, `UsageWindow`, `UsageExtra`, `UsageSource`, `ProbeState` | see below |
| `ClaudeDefaults`, `ModelChoice` | the user's defaults and the model list, see below |

### Fields on existing types

| Field | Filled by |
| --- | --- |
| `AgentSnapshot.model` | model layer (`agentState.ts`, task 2.2): latest assistant `message.model` in the transcript, `<synthetic>` skipped |
| `AgentSnapshot.effort` | model layer: `effort` recorded in the transcript; an office run's requested effort while live. Unknown values are dropped |
| `AgentSnapshot.context` | model layer (`contextWindow.ts`): `{ tokens, max, pct, approx? }` from the latest `message.usage`. `max` is a window a run reported, 1,000,000 for a `[1m]` model, else 200,000 with `approx: true` |
| `AgentSnapshot.lastReport` | model layer: the final assistant text when a turn ends, at most `LIMITS.reportChars`, `truncated` when cut |
| `AgentSnapshot.plans` | model layer (`planIndex.ts`): an `ExitPlanMode` tool_use opens a plan, its `tool_result` closes it. At most `LIMITS.plansPerAgent`, oldest first, titles at most `LIMITS.planTitleChars`. Text is fetched with `getPlan` |
| `AgentSnapshot.costUsd` | now from the transcript's `cost-state` for every session; an office run's own figure overrides it while that run is live (`getOfficeInfo`, cost tracker) |
| `CaseHeader.effort` | manager host `headerFor` (task 2.7) |
| `CaseHeader.canSetOptions` | manager host: true for `control` 'office' (applies now) and 'free' (applies to the next message), else false/absent (read-only chips, "use /model or /effort in Claude Code") |
| `CaseHeader.next` | manager host: options stored in `nextOptions` for a free session. As a `caseAppend` header merge, `{}` means "nothing stored" |
| `ConversationItem` `{ kind: 'plan' }` | conversation reader (`conversation.ts`, task 2.5): `id` is the ExitPlanMode tool_use id, `text` at most `LIMITS.planChars`, `status` follows the plan's life, `planFilePath` and `feedback` when known. It replaces the old plan card text in the history, so a decided plan stays visible |
| `error.reqId` | manager host: ties a failure to a `getPlan` / `getTurn` call |
| `newTask.effort` | webview memo; the host passes it to the SDK's `Options.effort` |

### Usage

```ts
interface UsageSnapshot {
  kind: 'plan' | 'apiKey' | 'unknown';   // apiKey: no windows, the panel shows estimated cost "≈ at API prices"
  windows: UsageWindow[];                // at most LIMITS.usageWindows
  extra?: UsageExtra;                    // { enabled, usedUsd?, limitUsd?, currency?, pct? }
  plan?: string;                         // 'Max', 'Pro' ... display only
  source: 'probe' | 'cache' | 'event' | 'mixed' | 'none';
  asOf?: number;                         // newest reading of any window
  probe: ProbeState;
  nextAt?: number;                       // next scheduled probe
}
interface UsageWindow {
  id: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
  pct: number | null;                    // 0..100, normalised by the host
  resetsAt?: number;                     // epoch ms; a passed reset counts as reset
  asOf: number;
  state?: 'warning' | 'blocked';         // from rate-limit events
}
```

`UsageExtra` money is in major units of `currency` (ISO 4217 code such as `GBP`, upper case; the cache and the probe both report it in `extra_usage.currency`, and the parsers keep it only when it is exactly three letters). When `currency` is absent the amounts are assumed USD. The field names `usedUsd` / `limitUsd` are historic and kept for compatibility; they are not necessarily dollars.

`ProbeState`: `idle` (no probe yet or none due), `running` (in flight), `ok` (last probe worked), `failed` (retrying with 5, 10, 20, 30 min backoff), `unsupported` (this SDK or Claude Code has no usage call; probing stops, cache and events still feed the snapshot), `signedOut` (waits for a manual refresh), `off` (the `claudeOffice.usageChecks` setting is `off`).

The snapshot never carries account identity (no email, account id or `oauthAccount`). The host (`usageService.ts`, task 2.6) normalises units and scales, so the webview never guesses.

### Claude defaults

`ClaudeDefaults { model?, effort?, effortByModel: Record<string, EffortLevel>, models?: ModelChoice[] }` and `ModelChoice { value, label, resolved?, efforts? }` (`efforts` absent means unknown: offer every level). At most `LIMITS.models` models. Filled by `claudeConfig.ts` (`parseClaudeDefaults`, `parseInitInfo`, task 2.3) and sent by the wiring (task 2.8).

### Host to webview

| Message | Fields | Who fills it |
| --- | --- | --- |
| `usage` | `usage: UsageSnapshot` | `usageService.ts` via the wiring. **Cached by `officeView` and replayed on `ready`**, like `agents` and `settings` |
| `claudeDefaults` | `defaults: ClaudeDefaults` | wiring (`claudeConfig.ts` + the probe's init info). **Cached and replayed on `ready`** |
| `sessionOptions` | `nonce, sessionId, applied: SessionOptions, deferred: SessionOptions` | manager host: reply to `setSessionOptions`. `applied` = took effect now (office run); `deferred` = stored for the next message (free session). Both `{}` when nothing changed. A failure is an `error` with the same `nonce` and `sessionId` |
| `planText` | `reqId, agentId, planId, text, truncated?, status, planFilePath?, feedback?` | manager host: reply to `getPlan`, text at most `LIMITS.planChars`. A failure is an `error` with the same `reqId` |
| `turn` | `reqId, agentId, items: ConversationItem[], truncated` | manager host: reply to `getTurn`, the latest turn, at most `LIMITS.turnItems` items; `truncated` when earlier items were left out |

### Webview to host

| Message | Fields | Validation |
| --- | --- | --- |
| `newTask` | `+ effort?: EffortLevel` | `effortLevel`: one of `EFFORT_LEVELS`, else the whole message is rejected |
| `setSessionOptions` | `nonce, sessionId, options` | `options` allows only `model`, `effort`, `permissionMode`, needs at least one, and rejects any other key (so a smuggled `bypassPermissions` fails). `model` and `effort` may be `null` (reset); `permissionMode` may not. `model` goes through `modelName` (at most `LIMITS.modelChars`, letters, digits and `. _ : [ ] -`). Host-side: `sessionId` known and `control` 'office' or 'free' |
| `refreshUsage` | none | the host debounces to once every 60 s |
| `updateAction` | `action` | one of `UPDATE_ACTIONS` (see the webview-to-host table in section 17) |
| `getPlan` | `reqId, agentId, planId` | `planId` is a tool_use id: 1 to 128 characters of letters, digits and `. _ : -` |
| `getTurn` | `reqId, agentId` | ids as elsewhere (`LIMITS.idChars`, no control characters) |

As everywhere, extra top-level keys are dropped, and the demo guard answers `setSessionOptions`, `getPlan` and `getTurn` with the demo error (task 2.8).

### New limits

`LIMITS.reportChars` 1000, `plansPerAgent` 5, `planTitleChars` 120, `turnItems` 80, `usageWindows` 8, `models` 20.

## 14. Panel interface: `PanelView` and `PanelContext` (task 1.2)

Defined in **`src/shared/panels.ts`** (types only). It is separate from `protocol.ts` because the root tsconfig has no DOM lib; the file stays DOM-free by taking the mount element as a type parameter, and the webview uses `PanelView<HTMLElement>`. The webview tsconfig already includes `src/shared/**`.

```ts
interface PanelView<Body = unknown> {
  id: string;                    // 'inbox' | 'plans' | 'usage' | 'directory' | ...
  title: string;                 // drawer header, icon-bar tooltip, back button
  icon: string;                  // name of an 8x8 pixel icon
  mount(body: Body, ctx: PanelContext<Body>): void;   // text nodes only
  refresh?(): void;              // agents, usage, defaults or inbox read marks changed
  handle?(msg: HostToWebview): void;  // every host message while mounted (planText, turn, error with reqId ...)
  unmount?(): void;              // remove listeners and timers
  beforeClose?(): boolean;       // false = veto; the panel asks the user and closes itself
}

interface PanelContext<Body = unknown> {
  post(msg: WebviewToHost): void;
  openCase(agentId: string): void;                       // case drawer shows "← <panel title>"
  openMemo(opts?: { prefill?: MemoPrefill }): void;      // MemoPrefill { prompt?, projectPath?, sessionId?, options? }
  push(view: PanelView<Body>): void;                     // show on top; back() returns
  back(): void;
  agents(): readonly AgentSnapshot[];
  usage(): UsageSnapshot | null;
  defaults(): ClaudeDefaults | null;
  now(): number;                                         // injectable clock
  inbox: InboxReadStore;
}

interface InboxReadStore {
  readAt(key: string): number | undefined;
  markRead(key: string, at?: number): void;
  markUnread(key: string): void;
  all(): Readonly<Record<string, number>>;
  subscribe(listener: () => void): () => void;           // returns unsubscribe
}
```

Rules:
- Panels talk to the rest of the webview only through `PanelContext`; they never import `main.ts`.
- Data accessors are functions, so a panel reads the current value on every `refresh()`.
- Only one drawer is open at a time. Escape closes the popover first, then the memo, then the drawer, then the case.
- `beforeClose` is added now as an optional hook so the Front desk panel (task 1.4, which documents `FrontDeskTab` and `FrontDeskCtx` in section 17) needs no change here. The drawer shell (task 3.3) calls it before closing or switching.
- Inbox keys are stable item ids. In v0.3 the read marks are per webview view (kept in saved state); moving them to host storage later does not change `InboxReadStore`.

## 15. Module ownership for Round A

Each task edits only its own files. The file lists come from the Office tools plan, Phases 2 to 4 (the Front desk rows are included because they share files). Task 1.2 (this contract) owns `src/shared/protocol.ts`, `src/shared/validate.ts`, `src/shared/panels.ts`, `test/shared-validate.test.ts` and this document; task 1.4 adds the Front desk contract to the same files afterwards.

### Phase 2: host

| Task | Owner of |
| --- | --- |
| 2.1 Runner controls, SDK wrapper forwarding, `cost.ts` tracker | `src/manager/sessionRunner.ts`, `src/manager/index.ts`, `src/manager/cost.ts`, `test/manager-sessionRunner.test.ts`, `test/manager-fakes.ts` |
| 2.2 Model layer | `src/model/agentState.ts`, `src/model/planIndex.ts`, `src/model/contextWindow.ts`, `test/model-*.test.ts` |
| 2.3 Parsers and poller | `src/claude/claudeConfig.ts` (with the sentinel-secret test), `src/claude/paths.ts` (`claudeConfigJsonPath`), `src/host/filePoller.ts`, tests |
| 2.4 Gate | theme plan Phase 3 done, `npm run typecheck && npm test` green, theming work committed (done: `d2339da`) |
| 2.5 Plan items and cost notices | `src/manager/conversation.ts`, `test/manager-conversation.test.ts`, fixtures |
| 2.6 Usage probe and service | `src/manager/usageProbe.ts`, `src/host/usageService.ts`, tests (fake timers) |
| 2.7 Manager host | `src/manager/managerHost.ts` (`setSessionOptions`, `nextOptions`, `getPlan`, `getTurn`, `headerFor`, `getOfficeInfo`, learned context windows), `test/manager-host.test.ts` |
| 2.8 Wiring | `src/extension.ts`, `src/host/managerAdapters.ts`, `src/view/officeView.ts` (caches and replays `usage` and `claudeDefaults`), `src/host/officeFeed.ts`, `src/host/demoGuard.ts`, `package.json` (`claudeOffice.usageChecks`), host tests |
| 2.9 Live e2e | `dev/manager-e2e.ts`, `dev/bundle-smoke.cjs` |
| 2.10 Theme source and writer | `src/host/themeSource.ts`, `src/host/themeWriter.ts`, `src/host/themeLoader.ts` (`reloadNow`, `rev`), `media/themes/example.theme.json`, tests |
| 2.11 Front desk host | `src/host/frontDesk.ts`, `src/host/frontDeskAdapters.ts`, `test/host-frontDesk.test.ts` |
| 2.12 Front desk wiring | `src/extension.ts`, `src/view/officeView.ts` (`openFrontDesk` queue), `package.json` (`claudeOffice.openFrontDesk`), demo-guard test |

### Phase 3: webview (after gate 2.4)

| Task | Owner of |
| --- | --- |
| 3.1 Pure logic | `webview/engine/hotspots.ts`, `inboxLogic.ts`, `usageLogic.ts`, `plansLogic.ts`, `targets.ts` (`normalizeAgent`), `tooltip.ts`; `test/engine-{hotspots,inbox,usage,plans}.test.ts` |
| 3.2 All Round A art | `webview/art/*`, `webview/engine/scene.ts`, `dev/gallery.ts`, `dev/sprites.html` (usage ring, BACK plate, calendar, in-tray, desk piles, plan notes, bookshelf, phone, temp-agency sign, directory board, prop outlines, 8x8 icons, `PROP_ANCHORS`, `Scene.render` extras) |
| 3.3 Drawer shell, icon bar, directory | `webview/engine/drawer.ts` (`PanelDrawer`), `iconBar.ts`, `directoryPanel.ts` |
| 3.4 Memo, case header chips, plan items, popover | `webview/engine/memo.ts`, `memoLogic.ts`, `caseFile.ts`, `caseLogic.ts`, `optionsLogic.ts`, `popover.ts`; tests |
| 3.5 Panels | `webview/engine/inboxPanel.ts`, `plansPanel.ts`, `usagePanel.ts` |
| 3.7 Front desk art | `webview/art/*` (after 3.2), `media/themes` starter sync in `src/shared/themeStarter.ts`; `engine-assign`, `engine-looks`, `engine-palette` tests |
| 3.8 Receptionist and theme applier | `webview/engine/reception.ts`, `office.ts`, `characters.ts`, `types.ts`, `bubbles.ts`, `lines.ts`, `theme.ts`, `themeApply.ts`; tests |
| 3.9 Front desk logic | `webview/engine/frontDeskLogic.ts`, tests |
| 3.10 Front desk shell, Theme and Settings tabs | `frontDeskPanel.ts`, `frontDeskTheme.ts`, `frontDeskSettings.ts` |
| 3.11 Staff editor and Colours tab | `frontDeskStaff.ts`, `frontDeskColours.ts`, `lookPreview.ts` |

### Phase 4: integration

| Task | Owner of |
| --- | --- |
| 4.1 Integration | `webview/main.ts`, `webview/engine/panels.ts`, `dev/harness.ts`, `dev/harness.html` (URL params `?panel=`, `?usage=`, `?hover=prop:`, `?inbox=`, `?ctx=`, `?defaults=`, `?chips=`, and mock replies). Leaves `applySettings` alone |
| 4.7 Front desk integration | `webview/main.ts` (`ThemeApplier`, art reset, receptionist, counter hotspot, Escape order, saved draft, `openFrontDesk`), `dev/harness.ts`/`.html` (`?panel=frontdesk`, `?fd=...`) |

Cross-module rules:
- The contract files (`protocol.ts`, `validate.ts`, `panels.ts`) change only in a contract task (1.2, 1.4, 5.1). A task that needs a new field asks for it there instead of editing them.
- New message types and optional fields are ignored by code that does not know them yet, so host and webview tasks can land in any order.
- The webview consumes only `src/shared/*`; the host never imports from `webview/*`.

## 16. Round B contract (task 5.1)

Round B (v0.4) makes the filing cabinets, bookshelf, phone, notice board and temp-agency sign clickable. The contract lives in `src/shared/protocol.ts` (types, `LIMITS`), `src/shared/validate.ts` (`parseWebviewMessage`, the exported `relPath`) and the tests in `test/shared-roundB.test.ts`. `panels.ts` is unchanged: `MemoPrefill` already carries everything the "hand to a worker", "Use this" and "Hire for a task" actions need (see Prefills). Epoch times are milliseconds; lengths are UTF-16 code units, except `previewBytes`.

**Two rules hold for the whole round.**
- The webview names things only by opaque ids. `rootId` (a file room root) plus a relative path (`relPath`) addresses a file; `fileId` addresses a config file (skill, command, agent, CLAUDE.md, memory entry, settings file). No inbound message carries an absolute path, and extra keys such as `path` or `file` are dropped like any other extra key.
- The host-to-webview types are closed. The MCP item has no field that could hold a command, arguments, environment, headers or a URL, so the host cannot send one by accident.

### Types

```ts
type FileRootKind = 'workspace' | 'agent' | 'project';
interface FileRoot {
  rootId: string;          // opaque
  label: string;           // <= nameChars
  kind: FileRootKind;
  display: string;         // ~-shortened path, display only
  projectPath: string;     // absolute, only to preselect the project on the memo; no request accepts it
}
interface DirEntry {
  name: string;            // one segment, never contains '/'
  kind: 'file' | 'dir' | 'other';   // 'other': socket, device, broken link, or a link leaving the root (listed, not openable)
  size?: number; mtime?: number;    // files; epoch ms
  link?: true;             // a symlink that resolves inside the root
  secret?: true;           // name looks like a secret file: editor only
}

type CatalogSection = 'skills' | 'mcp' | 'handbook' | 'agents';     // CATALOG_SECTIONS

interface SkillItem   { name; invoke; description; source: 'user'|'synced'|'project'|'plugin'; plugin?; fileId?; uses?; lastUsedAt? }
interface CommandItem { name; invoke; description; source: 'builtin'|'user'|'project'|'plugin'; plugin?; argumentHint?; fileId? }
interface McpServerItem {
  name: string;                                          // the only free text
  scope: 'user'|'project'|'local'|'plugin'|'managed'|'cloud'|'unknown';
  transport: 'stdio'|'http'|'sse'|'ws'|'sdk'|'unknown';  // the kind only, never where or how
  status: 'connected'|'failed'|'needsAuth'|'pending'|'disabled'|'unknown';
  tools?: number;                                        // count only
}
interface HandbookFile { fileId; scope: 'managed'|'user'|'project'|'local'; label; display; bytes? }
interface MemoryEntry  { fileId; file; title; hook?; type?: 'user'|'feedback'|'project'|'reference' }
interface PermissionRuleItem { behavior: 'allow'|'deny'|'ask'; rule: string; scope: ConfigScope; fileId? }
interface AgentTypeItem { name; description; source: 'builtin'|'user'|'project'|'plugin'; plugin?; model?; tools?: string[] /* absent = all tools */; fileId? }

type CatalogReply =
  | { section: 'skills';   skills: SkillItem[]; commands: CommandItem[]; truncated: boolean }
  | { section: 'mcp';      servers: McpServerItem[]; truncated: boolean }
  | { section: 'handbook'; instructions: HandbookFile[]; memoryIndex?: HandbookFile; memory: MemoryEntry[]; rules: PermissionRuleItem[]; truncated: boolean }
  | { section: 'agents';   agents: AgentTypeItem[]; truncated: boolean };
```

Also exported as arrays for iteration and validation: `FILE_ROOT_KINDS`, `CATALOG_SECTIONS`, `SKILL_SOURCES`, `COMMAND_SOURCES`, `MCP_SCOPES`, `MCP_TRANSPORTS`, `MCP_STATUSES`, `CONFIG_SCOPES`, `MEMORY_TYPES`, `RULE_BEHAVIORS`, `AGENT_TYPE_SOURCES`, and `MCP_SERVER_ITEM_KEYS` (every key of `McpServerItem`; a test fails when the interface and the list disagree, so a new field cannot slip in unreviewed).

Notes on the item types:
- `invoke` is what follows the `/`: `name` for a user or project skill, `plugin:name` for a plugin's. "Use this" prefills `/<invoke> `.
- Only files that exist are listed in `instructions`, and only files that can be opened carry a `fileId`. Built-in commands and agent types have no `fileId`.
- `handbook.instructions` is the CLAUDE.md chain then rules files, in the order Claude Code loads them. `rules` lists allow, then ask, then deny, each in file order. Only the three rule lists are forwarded: `defaultMode`, `additionalDirectories`, `env`, hooks and every other settings key stay on the host. This also keeps `bypassPermissions` out of the webview's reach.
- Which project the project-scoped items belong to: `getCatalog.rootId` when given (the root's folder), else the active workspace folder.

### Messages

| Direction | Message | Fields |
| --- | --- | --- |
| host to webview | `fileRoots` | `roots: FileRoot[]` (at most `LIMITS.fileRoots`), `reqId?`. With a `reqId` it answers `getFileRoots`; without one it is a push (an agent started, a project was browsed). The host may cache and replay it on `ready` |
| host to webview | `dirListing` | `reqId, rootId, relPath, entries: DirEntry[], truncated`. Folders first, then files, each by name; at most `LIMITS.dirEntries`; `truncated` = more exist |
| host to webview | `fileText` | `reqId, rootId, relPath, size, text?, truncated?, binary?, secret?, tooLarge?, markdown?` (flags are the literal `true` or absent) |
| host to webview | `catalog` | `reqId` plus a `CatalogReply` (so `section` and that section's lists) |
| webview to host | `getFileRoots` | `reqId` |
| webview to host | `listDir` | `reqId, rootId, relPath` (`''` = the root) |
| webview to host | `readFile` | `reqId, rootId, relPath` |
| webview to host | `openFile` | `rootId, relPath`. Fire and forget |
| webview to host | `openDiff` | `rootId, relPath`. Fire and forget |
| webview to host | `getCatalog` | `reqId, section, rootId?, refresh?` (`refresh: true` only from a panel's explicit Refresh or Try again press: the host skips its caches, 60 s for the catalog and 30 s for MCP statuses; opening a panel never sets it) |
| webview to host | `openConfigFile` | `fileId`. Fire and forget |

Replies and errors follow the `getPlan` / `getTurn` pattern: the reply carries the request's `reqId`, and a failure is `error{reqId, message}` (message at most `LIMITS.errorChars`; the webview shows it in the panel that sent the `reqId`). `openFile`, `openDiff` and `openConfigFile` have no reply; a failure is an `error` without ids, which the webview shows as a toast. `getFileRoots` is the one addition to the lists in the plan: the plan named only the `fileRoots` reply, and a panel needs a way to ask for it.

`fileText` flags:

| Field | Meaning |
| --- | --- |
| `size` | the file's size in bytes, always present |
| `text` | present only when the file was previewed: at most `LIMITS.previewBytes` bytes of UTF-8 decoded text |
| `truncated` | the file is larger than `previewBytes` and `text` is its first part |
| `binary` | the file is not text (a NUL byte in the first 8 KB, or invalid UTF-8 beyond a few stray bytes); no `text` |
| `secret` | the name looks like a secret file; no `text`, whatever the content. The panel offers Open in editor only |
| `tooLarge` | larger than `LIMITS.previewMaxFileBytes`; the host did not read it; no `text` |
| `markdown` | `.md` or `.markdown`: render `text` with `renderMarkdown`. Only with `text` |

At most one of `binary`, `secret`, `tooLarge` is set, checked in the order `secret`, `tooLarge`, `binary`. `secret` is decided from the name before the file is opened.

### Validation (`parseWebviewMessage`)

- `reqId`, `rootId`, `fileId` go through the existing `id()` validator: a non-empty string of at most `LIMITS.idChars` with no control characters. The host issues them, so it should use short, unguessable-enough tokens (for example `r1`, `f7`); an unknown id is refused at the host.
- `relPath` is the exported validator `relPath(v)` in `validate.ts`. It returns the string unchanged, or `undefined`. It accepts `''` and relative POSIX paths, and rejects:

  | Rejected | Examples |
  | --- | --- |
  | non-strings | `5`, `null`, `['a']` |
  | more than `LIMITS.relPathChars` (1024) | |
  | control characters U+0000 to U+001F and U+007F | `a\0b`, `a\nb`, `a\tb` |
  | a backslash anywhere | `a\b`, `C:\x`, `\\server\share` |
  | a leading `/` (absolute and UNC-style) | `/etc/passwd`, `//server/share` |
  | a leading drive letter | `C:`, `C:/x`, `c:/x` |
  | a trailing `/` | `a/` |
  | an empty segment | `a//b` |
  | a segment made only of dots and spaces | `.`, `..`, `...`, `a/../b`, `../x`, `a/./b` (Windows folds `...` and `.. ` into `..`) |

  Accepted: `''`, `README.md`, `.github/x`, `.env`, `a.b/c..d`, `..x/y`, names with spaces, unicode names, a colon inside a name (`notes/a:b.txt`).
- `getCatalog.section` must be one of `CATALOG_SECTIONS`; anything else (including `__proto__`) rejects the message. `getCatalog.rootId` is optional; present and invalid rejects the message. `getCatalog.refresh` is optional and may only be the literal `true`; any other value rejects the message, and the router passes `{ force: true }` to `officeRequests.handle` only for it.
- All eight messages build a fresh object, so extra keys are dropped. None has a `permissionMode` or `options` field, and the validator for `setSessionOptions` is unchanged, so `bypassPermissions` is still impossible to express.
- `relPath` is the first line of defence only. The host must still resolve and check (below).

### New limits

`LIMITS.relPathChars` 1024, `dirEntries` 500, `previewBytes` 262144, `previewMaxFileBytes` 4194304, `fileRoots` 100, `nameChars` 255, `descriptionChars` 300, `catalogSkills` 300, `catalogCommands` 300, `mcpServers` 100, `agentTypes` 100, `handbookFiles` 50, `memoryEntries` 200, `permissionRules` 500, `ruleChars` 300, `toolsPerAgent` 60, `toolNameChars` 100.

### Prefills (webview only)

"Hand to a worker", "Use this" and "Hire for a task" are webview actions that call `PanelContext.openMemo({ prefill })`. `MemoPrefill` already fits:

| Action | Prefill |
| --- | --- |
| Hand to a worker (file) | `prompt`: the `relPath` (for a folder, `relPath + '/'`), `projectPath`: `FileRoot.projectPath` |
| Use this (skill or command) | `prompt`: `'/' + invoke + ' '` |
| Hire for a task (agent type) | `prompt`: `'Use the ' + name + ' subagent to '` |

No message is sent until the user submits the memo (`newTask`, as before).

### Routing and demo mode

`getFileRoots`, `listDir`, `readFile`, `openFile`, `openDiff`, `getCatalog` and `openConfigFile` are handled by `src/host/officeRequests.ts`, not the manager host. Unlike the Front desk messages, they go **through the demo guard**, which refuses them in demo mode: the demo office has no real folders or config, and these requests read the user's disk. The refusal is the usual demo `error`, carrying the `reqId` when the request had one (a fire-and-forget request gets an id-less `error`, shown as a toast). The webview has no demo flag, so it finds out from the refusal: each Round B panel is wrapped (`withDemoNotice` in `webview/engine/panels.ts`) and, when its request comes back refused, shows a friendly "Not available in the demo" note instead of the raw error (nothing is hidden: the props and icon-bar buttons stay, and turning demo mode off needs nothing because the next open asks again). The scene stays classic in demo mode (no phone lights, the full shelf) since no catalog reply ever arrives. Panels must not mock data in production code (the dev harness has its own mock replies).

### The host's safety duties

The webview is untrusted. Everything below is enforced by the host, and each point has a test in its task.

**Roots and ids.**
- A root is allowed only if it is a workspace folder, the `cwd` of a known agent, or a project the user browsed to. The host keeps `rootId -> real path` and `fileId -> real path`. An unknown or stale id is refused with a short error, never guessed from.
- Ids are issued per host process and not persisted. A `fileId` is issued only for files the host itself found while building a catalog: a skill's SKILL.md, a command or agent file, a CLAUDE.md, a rules file, a memory entry or MEMORY.md, a settings file. Nothing else is ever opened by `openConfigFile`.

**Path checks, on every file room request** (`listDir`, `readFile`, `openFile`, `openDiff`).
1. `parseWebviewMessage` has already applied `relPath`.
2. Join the root's real path and `relPath`, call `fs.realpath` on the result, and require `isInsideDir(real, rootRealPath)` (`src/claude/paths.ts`). A symlink that escapes the root is refused (a listing shows it as `kind: 'other'`).
3. Use the resolved path for every later step (stat, read, open); never re-join the string.
4. A missing file, a dangling link, or a path that stops being inside the root between the check and the read is an error. `openFile` and `openDiff` must not open a folder.

**Secret files.** A name is `secret` when its basename matches any of: `.env` and `.env.*` (except `.env.example`, `.env.sample` and `.env.template`), `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.p8`, `*.pk8`, `*.ppk`, `*.kdbx`, `*.kdb`, `*.keychain`, `*.keychain-db`, `id_*` (except `*.pub`), `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `.dockercfg`, `.s3cfg`, `.boto`, `credentials`, `credentials*.json`, `.credentials.json`, `service-account*.json`, `serviceaccount*.json`, `client_secret*.json`, `secrets.*`, `*.secret`, `*.secrets`, `*.tfvars`, `*.tfstate`, `*.tfstate.*`, Ansible vault password files (`vault_pass`, `vault-pass` and `.vault_pass`), or when it sits inside `.ssh`, `.aws`, `.gnupg`, `.kube` or `.docker`. The list is case-insensitive and lives in one place in `fileRoom.ts`. `readFile` of a secret file returns `fileText{secret:true}` **without opening it**; the listing marks it `secret`. Open in editor stays available, because that is the user's own editor, not the webview. Separately, the host never lists or opens, in any root: `~/.claude/.credentials.json`, `sessions/*.key`, `session-env`, `paste-cache`, `file-history` or `history.jsonl` (a root that is `~/.claude` hides them; `openFile` on them is refused).

**Previews.** Read at most `previewBytes + 1` bytes, never the whole file. Decide `binary` from the bytes read (NUL in the first 8 KB, or a high share of invalid UTF-8). Decode with replacement characters. `tooLarge` is decided from `stat.size` before any read. Listings stop at `dirEntries` and set `truncated`; the host sorts first, then cuts. Entry names are sent as they are, as text; the webview renders them as text nodes.

**MCP: fields never forwarded.** `mcpConfig.ts` reads the MCP sections of `~/.claude.json`, `.mcp.json`, settings files and plugins only inside the module, and builds each `McpServerItem` with explicit assignments of `name`, `scope`, `transport` and `status` (and `tools`). It never spreads or copies a config object. The command, args, env, headers, URL, OAuth data and any error text are not read into the output at all. A status that cannot be named is `'unknown'`, never an error string. The sentinel-secret test of task 2.3 is repeated here: planted values in `command`, `args`, `env`, `headers` and `url` must appear nowhere in the serialised reply or in a log line.

**Catalog text.** Descriptions, rules, hooks and tool names are cut to their `LIMITS` entry. `skillUsage` is read from `~/.claude.json` through `claudeConfig.ts`'s whitelist (counts and last-used times only).

**Diff.** `openDiff` uses the git extension API (`toGitUri` plus `vscode.diff`, no git process of our own) against HEAD. If the folder is not in a repository, or the file is untracked, the host answers with an id-less `error`.

**Logging.** The host logs request kinds, `reqId`s, `rootId`/`fileId` values, counts, byte sizes and flags only (for example `readFile req=r9 root=r1 bytes=4210 truncated`). Never paths, file names, file text, rule text, descriptions, skill names, or MCP server names.

### Module ownership for Round B

Each task edits only its own files. The contract files (`protocol.ts`, `validate.ts`, `panels.ts`) change only in a contract task; a task that needs a new field asks for it there.

| Task | Owner of |
| --- | --- |
| 5.1 This contract | `src/shared/protocol.ts`, `src/shared/validate.ts`, `test/shared-roundB.test.ts`, this document |
| 5.3 File room host | `src/host/fileRoom.ts` (root registry and ids, `realpath` plus `isInsideDir`, listing, preview, binary and secret detection, `openFile`/`openDiff` helpers behind injected adapters), `test/host-fileRoom.test.ts` |
| 5.4 Catalog readers | `src/claude/catalog.ts` (skills, commands, agent types, `skillUsage` merge), `src/claude/handbook.ts` (CLAUDE.md chain, memory index and entries, permission rules), tests with fixtures |
| 5.5 MCP | `src/claude/mcpConfig.ts` (the closed `McpServerItem` builder, status mapping, sentinel-secret test) |
| 5.6 Request router and wiring | `src/host/officeRequests.ts` (the `reqId` router, the `fileId` map, `openFile`/`openDiff`/`openConfigFile`, the demo guard entries in `src/host/demoGuard.ts`, `fileRoots` push), `src/extension.ts`, `src/view/officeView.ts` (cache and replay of `fileRoots`), `src/host/managerAdapters.ts` if needed, host tests |
| 6.1 Pure logic | `webview/engine/` pure modules and tests: file room state (breadcrumbs, sorting hints, flags to view state), library/phone/handbook/agency view models, prefill builders, hotspots for the five props |
| 6.2 File room and library panels | `webview/engine/fileRoomPanel.ts`, `libraryPanel.ts` |
| 6.3 Phone, handbook and agency panels | `webview/engine/phonePanel.ts`, `handbookPanel.ts`, `agencyPanel.ts` |
| 6.4 Art hookups | `webview/art/*`, `webview/engine/scene.ts` (clickable props, phone lights from the MCP statuses, outlines) |
| 6.5 Integration | `webview/main.ts`, `webview/engine/panels.ts`, `dev/harness.ts`, `dev/harness.html` (URL params and mock replies for the new messages) |

The webview consumes only `src/shared/*`; the host never imports from `webview/*`.

## 17. Front desk (task 1.4)

(Section 16 is the Round B contract.) The Front desk is a drawer panel (id `frontdesk`) opened by clicking the receptionist or the reception counter, the bell in the icon bar, the Directory, or the command `Middle Management: Open Front Desk`. It changes the theme source, a few user settings, the staff and the office colours. The contract lives in `src/shared/protocol.ts` (types, `LIMITS`), `src/shared/validate.ts` (`parseWebviewMessage`) and `src/shared/panels.ts` (`FrontDeskCtx`). The host side is tasks 2.10 to 2.12, the webview tasks 3.9 to 3.11 and 4.7.

### Types

```ts
const FRONT_DESK_SETTINGS = ['companyName', 'branchName', 'managerName', 'speechBubbles', 'bossQuotes', 'scope', 'usageChecks', 'updateChecks'] as const;
type FrontDeskSettingKey = typeof FRONT_DESK_SETTINGS[number];   // the part after `claudeOffice.`
type FrontDeskTab = 'theme' | 'settings' | 'staff' | 'colours';  // also exported from panels.ts

interface FrontDeskState {
  source: {
    kind: 'builtin' | 'preset' | 'file';
    presetId?: string;            // kind 'preset'
    label: string;                // 'Built-in office', 'Example office', or the file name
    path?: string;                // ~-shortened, display only; never sent back
    fromWorkspace: boolean;       // the path comes from a workspace setting
    exists: boolean;
    editable: boolean;            // Save may write it (no readOnly reason)
    readOnly?: 'builtin' | 'preset' | 'workspace' | 'notJson' | 'missing' | 'notObject';   // 'notObject': the file is broken JSON or not a JSON object
    rev?: string;                 // 16 hex chars of the file text as last read; needed by saveTheme
    rawText?: string;             // the file's raw text as last read, so the panel can show what a save would drop; only kind 'file' whose last load read it and at most LIMITS.themeJsonChars long (never for builtin, preset, missing, unreadable or oversized); never logged
    errors: string[];             // at most LIMITS.themeErrors lines of LIMITS.themeErrorChars
    usingLastGood: boolean;       // the file is broken and the office shows the last good theme
  };
  presets: { id: string; label: string; description: string }[];   // at most LIMITS.presets
  settings: Record<FrontDeskSettingKey, {
    value: string | boolean;      // effective value
    source: 'default' | 'user' | 'workspace';
    userValue?: string | boolean; // the user's own value, when set
    workspaceWins: boolean;       // a workspace value overrides the user's
    themeValue?: string;          // a name the theme sets that wins over the setting
  }>;
}
```

### Messages

| Direction | Message | Fields |
| --- | --- | --- |
| host to webview | `frontDesk` | `state: FrontDeskState`, `reqId?`. With a `reqId` it answers that call; without it is a push (the theme file or a setting changed). Not cached by `officeView` |
| host to webview | `frontDeskDone` | `reqId, ok, message?, conflict?, cancelled?`. The final answer to a call. `ok` false carries a short `message` (at most `LIMITS.errorChars`). `conflict` = the file changed on disk since `rev`. `cancelled` = the user dismissed a dialog (not an error) |
| host to webview | `update` | `update: UpdateInfo` (`status`, `current`, `latest?`, `notesUrl?`, `checkedAt?`, `hidden?`, `message?`, `auto`; defined in `src/shared/protocol.ts`). Drives the Front desk badge, the Head Office memo and the About tab |
| host to webview | `openFrontDesk` | `tab?: FrontDeskTab`. Queued by `officeView` like `openMemo` until the webview is ready |
| webview to host | `getFrontDesk` | `reqId` |
| webview to host | `themeAction` | `reqId, action, presetId?, themeId?`. `action`: `create` (make a theme file from the starter, via a Save dialog), `choose` (Open dialog), `open` (open the file in the editor), `reload`, `useBuiltin`, `usePreset`, `copyPreset` (an editable copy of a preset, via a Save dialog), `useUserTheme` (switch to a theme file from the themes folder, named by `themeId`), `openThemesFolder` (reveal `~/.middle-management/themes/`), `installSkill` and `removeSkill` (the "Teach Claude" skill), `copyPrompt` (copy the starter prompt to the clipboard). The last four have no id |
| webview to host | `setSetting` | `reqId, key, value: string \| boolean \| null`. `null` resets the user value to the default |
| webview to host | `saveTheme` | `reqId, rev, themeJson, force?: true` |
| webview to host | `saveThemeAs` | `reqId, themeJson` |
| webview to host | `openSettingsUi` | `key, target: 'user' \| 'workspace'`. Fire and forget; no reply |
| webview to host | `updateAction` | `action`: `check` (manual check, also from the About tab), `install`, `later`, `skip` or `reload` or `notes` (opens the release page the host stored, only if it is on the project's GitHub repository; the webview never sends an address). Only these six are accepted (`UPDATE_ACTIONS`). Allowed in view mode |

`LIMITS` gains `themeJsonChars` 524288, `settingChars` 100, `themeErrors` 50, `themeErrorChars` 300, `presets` 10, `userThemes` 50, `themeIdChars` 120.

`FrontDeskState` also carries three optional fields for the "Make your own" part of the Theme tab (absent until the host has listed the themes folder):

| Field | Meaning |
| --- | --- |
| `userThemes?: FrontDeskUserTheme[]` | The theme files in `~/.middle-management/themes/`, at most `LIMITS.userThemes`. Each is `{ id, label, description?, current, problems }`: `id` is the file name (`pirate-ship.theme.json`) and is sent back as `themeAction.themeId`; `current` = it is the theme in use; `problems` = the file is not valid JSON or has errors |
| `userThemesTruncated?: boolean` | `true` when the folder holds more than `LIMITS.userThemes` theme files |
| `make?: FrontDeskMakeState` | `{ themesFolder, skillFolder, skill }`. Both folders are `~`-shortened, for display only (at most `LIMITS.pathChars`), never sent back. `skill` is a `ThemeSkillStatus`: `missing`, `installed`, `outdated` (older than this build), `modified` (edited by the user), `foreign` (a skill of that name that is not ours) or `unknown` (could not be read) |

### Validation (`parseWebviewMessage`)

- `reqId` is an id as elsewhere (`LIMITS.idChars`, no control characters).
- `setSetting.key` must be one of `FRONT_DESK_SETTINGS`. Anything else rejects the message, including `claudePath`, `themeFile`, the prefixed form (`claudeOffice.scope`) and unknown or prototype names. `openSettingsUi.key` follows the same allowlist, and its `target` is `user` or `workspace`.
- `setSetting.value` is checked per key:

  | Key | Accepts |
  | --- | --- |
  | `companyName`, `branchName`, `managerName` | text with no control characters (C0, DEL, C1, U+2028/2029, so no tab or newline). It is trimmed, and at most `LIMITS.settingChars` after trimming. The empty string is allowed (an empty branch name gives a one-line sign) |
  | `speechBubbles`, `bossQuotes` | `true` or `false` only (not `"true"`, not 0 or 1) |
  | `scope` | `'all'` or `'workspace'` |
  | `usageChecks` | `'auto'` or `'off'` |
  | `updateChecks` | `'auto'` or `'off'` (`auto` = at most one check a day, about 30 s after start; `off` = no automatic checks, the About tab's button still works) |
  | any of them | `null` = reset to the default |

- `themeAction.presetId` must match `^[a-z0-9-]{1,40}$`. It is **required** for `usePreset` and `copyPreset` and **forbidden** for the other five actions (present means rejected, even when empty or null).
- `themeAction.themeId` is **required** for `useUserTheme` and **forbidden** for every other action (present means rejected, even when empty or null). It is a string of at most `LIMITS.themeIdChars` that ends in `.theme.json`, contains no `/` or `\`, no control characters (C0, DEL, C1, U+2028/2029) and no `..`, and does not start with `.`. It names a file in the themes folder; the host joins it to that folder itself. `useUserTheme` also rejects a `presetId`.
- `saveTheme.rev` must match `^[0-9a-f]{16}$` (lowercase only).
- `themeJson` (`saveTheme`, `saveThemeAs`) is a string of at most `LIMITS.themeJsonChars`. It is not parsed here: the host re-parses it with `parseTheme` and writes only the re-serialised result.
- `force` is only the literal `true`; `false`, `"true"`, 1 and null reject the message. Absent means not forced.
- **No message ever carries a path.** No field names a file: the host shows its own Open and Save dialogs, and the theme file is always the one the host already knows. Extra keys such as `path`, `file` or `themeFile` are dropped like any other extra key, because the validator builds a fresh object.

### Flows

**Open.** The webview opens the panel (a click, the bell, the Directory, or `openFrontDesk{tab?}` from the command). On mount it sends `getFrontDesk{reqId}`. The host answers `frontDesk{state, reqId}` and then `frontDeskDone{reqId, ok:true}`. Later `frontDesk` pushes without a `reqId` arrive when the theme file changes on disk or a setting changes. The panel keeps the latest state itself; it is not on the context.

**Theme actions.** `themeAction{reqId, action}`. The host does the action (dialog, switch of source, reload, open in the editor), then replies `frontDesk{state, reqId}` and `frontDeskDone`. A dismissed dialog gives `frontDeskDone{ok:true, cancelled:true}` and no state change. `usePreset` stores the setting value `preset:<id>` (the extension's install path is never stored). `copyPreset` and `create` write a new file after a Save dialog and switch to it.

**setSetting.** `setSetting{reqId, key, value}` writes to the **user** settings (`ConfigurationTarget.Global`), never the workspace's. The host then sends `settings` (the usual `OfficeSettings`), `frontDesk{state, reqId}` and `frontDeskDone{reqId, ok:true}`. When a workspace value wins, the write still happens and the new state shows `workspaceWins: true`, so the panel can explain why nothing changed in the office. `openSettingsUi{key, target}` opens VS Code's Settings editor on that setting, for changing the workspace value.

**Save.** `saveTheme{reqId, rev, themeJson}`:
1. The host checks the write guards (below), then re-reads the file and compares its revision with `rev`.
2. A match: it writes atomically, then sends **`settings`, then `frontDesk{state, reqId}`, then `frontDeskDone{reqId, ok:true}`**, in that order, so that when the panel gets `frontDeskDone` the office already shows the saved theme and the state's `rev` is the new one.
3. A mismatch: `frontDeskDone{reqId, ok:false, conflict:true}` (preceded by a `frontDesk{state, reqId}` with the file's current `rev`). The panel offers Load it / Keep mine. Keeping the draft then offers **Overwrite anyway**, which sends the same `saveTheme` with the new `rev` and `force:true`, or Save as.
4. Any other failure: `frontDeskDone{ok:false, message}` with no write.

`saveThemeAs{reqId, themeJson}` is used when the source is built-in or a preset (Save becomes Save as...) and for "Save as..." after a conflict. The host shows a Save dialog, writes the new file, switches `claudeOffice.themeFile` to it, and answers in the same order as a save: `settings`, `frontDesk`, `frontDeskDone`. A dismissed dialog is `frontDeskDone{ok:true, cancelled:true}`.

### Routing and demo mode

`extension.ts` handles the six Front desk messages **before** the demo guard, so the panel works in demo mode (it changes only the user's own settings and theme file, never a session). They are not sent to the manager host.

### About tab and update checks

The Front desk has a fifth tab, **About**: the version, `UpdateInfo.checkedAt`, a **Check for updates** button (`updateAction{action:'check'}`, which checks even when `updateChecks` is `off`) and the automatic-check setting. The Settings tab has the same setting as a "Check for updates" row (Daily / Off). `update` pushes keep the Front desk badge, the Head Office memo and the About tab in step. The memo's **Install now**, **Remind me later** and **Skip this version** send `updateAction` with `install`, `later` and `skip`; **Reload now** sends `reload`. The command `Middle Management: Check for Updates` runs the same check as the button.

### Write guards (the host's job)

The webview is untrusted, so the host writes the theme file only when all of these hold: the source is a file; the path ends in `.json`; the last load was a JSON object; `claudeOffice.themeFile` is **not** set in the workspace (otherwise a cloned repo could aim Save at any file); `parseTheme` reports zero errors; and `rev` matches a fresh read, or `force` is set. It writes only the re-parsed theme, as pretty JSON in a fixed key order, through a temp file next to the real target (symlinks resolved) and a rename. `source.readOnly` tells the panel which guard blocks Save.

### Panel interface additions

- **`PanelView.beforeClose?(): boolean`** (section 14). The drawer calls it before it closes or switches panel. The Front desk returns false while the draft has unsaved edits, asks "Keep editing / Discard", and closes the drawer itself after Discard.
- **`FrontDeskTab`**: `'theme' | 'settings' | 'staff' | 'colours'`, in `FRONT_DESK_TABS` order. It is defined in `protocol.ts` (for `openFrontDesk`) and re-exported from `panels.ts`.
- **`FrontDeskCtx`** (`panels.ts`) extends `PanelContext` with:

  ```ts
  hostTheme(): OfficeTheme | null;            // the theme the host last sent, without any preview; null = built-in
  hostSettings(): OfficeSettings | null;      // the settings the host last sent; null before the first one
  preview(theme: OfficeTheme | null): void;   // show a draft in the office at once; null reverts to the host's theme
  onHost(listener: (msg: HostToWebview) => void): () => void;   // returns the unsubscribe function
  ```

  `preview` writes nothing; only Save does. `onHost` delivers every host message to the listener, so the panel sees `frontDesk`, `frontDeskDone`, `settings` and `openFrontDesk` even while it is not the one receiving `handle`. The webview (task 4.7) builds the context; the panel uses only this interface.

### Logging

The host logs only reqIds, action names, setting keys' names and lengths (for example `saveTheme req=r7 chars=4210`). It never logs theme text, setting values, names or paths.

## 18. Case tabs and sending workers home (v0.5)

(Section 17 is the Front desk.) v0.5 changes where the office lives and where a worker's conversation opens. The office is a `WebviewView` in the panel, moved to the top once, laid out as a vertical icon rail, then the map, then the staff list. When the office view is wide, clicking a worker opens a **case tab**: a separate editor tab (a `WebviewPanel` with its own bundle `dist/case.js`, laid out like the Claude Code chat) that shows that worker's case file. Several tabs can be open at once. The drawer is unchanged and is still used in a narrow sidebar: the webview chooses by its own width, and there is **no setting** for tabs versus drawer. Closing an idle worker's tab, or the x on their staff row, **sends the worker home**. The contract lives in `src/shared/protocol.ts` (types, `LIMITS.caseTabs`, `forAnotherCase`, `sendHomeAfterMs`), `src/shared/validate.ts` (`parseWebviewMessage`, `parseCaseTabBoot`) and `package.json` (the setting and the command). Tests: `test/shared-v05.test.ts`.

### Messages and fields

| Direction | Message | Fields |
| --- | --- | --- |
| webview to host | `openCaseTab` | `agentId`, optional `look`. Open that worker's tab, or focus it when it is open. Fire and forget; a failure is an `error` with `agentId` |
| webview to host | `sendHome` | `agentId`. The x on a staff row. Fire and forget; a refusal is an `error` with `agentId` |
| host to webview | `caseTabs` | `agentIds: string[]`, in the order the tabs were opened, at most `LIMITS.caseTabs` (20). Office view only; cached and replayed on `ready`; re-sent whenever a tab opens or closes. The staff list marks those rows (click = focus the tab) |
| host to webview | `error` (changed) | gains `agentId?`: the worker the failure concerns, when the host can tell |

Nothing else is new on the wire. The tab needs no extra boot message (see Boot), and sending home needs no host-to-webview message: a sent-home worker simply leaves `agents`, and the office already walks a removed worker out of the door.

**Validation (`parseWebviewMessage`).** `openCaseTab` and `sendHome` take `agentId` through the existing `id()` rule (1 to `LIMITS.idChars` characters, no control characters). A missing, empty, non-string, over-long or control-character id rejects the message. The validator builds a fresh object, so extra keys (`sessionId`, `path`, `permissionMode`, anything) are dropped. Neither message can carry options, so `bypassPermissions` is still impossible to express.

**Addressing: what each message already carries, and the one gap.**

| Message | Address it carries |
| --- | --- |
| `caseFile`, `caseAppend`, `caseClosed` | `agentId` |
| `planText`, `turn` | `agentId` (and `reqId`) |
| `sessionOptions` | `sessionId` (and `nonce`) |
| `taskStarted` | `nonce`, `sessionId`, `agentId` |
| `error` | `nonce`, `sessionId`, `requestId`, `reqId`, and now `agentId` |
| `agents`, `settings`, `usage`, `claudeDefaults`, `caseTabs`, `projects`, `fileRoots` | none (shared state) |

Only `error` lacked a worker address, and that is what made routing ambiguous: a failed `openCase` came back id-less, and the drawer guessed that it was its own ("still loading, host says no"). With two or more cases open, that guess is wrong. So `error.agentId` is added and is **always** set for a failed `openCase`, `openCaseTab` and `sendHome`, and for any other failure whose worker the host can name (for example a failed `reply` also keeps its `sessionId`). The case messages needed nothing: they already carry `agentId`. The rest of the webview-to-host messages (`reply`, `decide`, `interrupt`, `setSessionOptions`) keep `sessionId` / `requestId`, which the host already maps to a worker. `closeCase` stays without fields: each webview has at most one case, and the host knows the sender. Old fields and the drawer's behaviour are unchanged; `agentId` on `error` is optional.

`forAnotherCase(msg, own: {agentId, sessionId?, requestId?})` (`protocol.ts`) is the one rule both sides use. It is true only when a message **explicitly** addresses a different worker, session or request: `caseFile`, `caseAppend`, `caseClosed`, `planText` and `turn` by `agentId`; `sessionOptions` by `sessionId`; `error` by `agentId`, else `sessionId`, else `requestId` (the first one present decides). It is lenient on purpose: a message with no address, or only the tab's own `nonce` or `reqId`, is not "for another case", and shared-state types always return false. A tab that does not yet know its own `sessionId` or `requestId` cannot rule a message out by them.

### Boot (how a tab learns its worker)

`ready` is enough; no new boot message. The host puts the binding in the panel's HTML as JSON in `<script type="application/json" id="mm-boot">` (`CASE_TAB_BOOT_ELEMENT_ID`), not as inline code, so the CSP stays strict. `CaseTabBoot` is `{ mode: 'case', agentId, look? }`. The tab reads the element, runs `parseCaseTabBoot` (a fresh `{mode, agentId, look?}`, extra keys dropped, anything else undefined) and, if it is undefined, shows "This tab lost its worker" and does nothing. The office views have no boot element and run as before. A tab is bound to **one worker for its whole life**; there is no re-binding. The tab then posts `ready`, and the host answers with the cached `agents`, `settings`, `usage` and `claudeDefaults` and the `caseFile` for the bound worker (as for the drawer on `ready`, section 8.9 step 8). It does not send a tab `caseTabs`, `projects`, `fileRoots`, `openMemo` or `openFrontDesk`.

What a tab may send: `ready`, `openCase` (only for its own `agentId`, to reload after a hiccup; anything else is dropped), `reply`, `decide`, `interrupt`, `openInClaudeCode`, `setSessionOptions`, `getPlan`, `getTurn`. The host drops every other type from a tab (no `newTask`, no file room, no `sendHome`).

### Portrait look hand-off (v0.5.x)

The office is the authority on who looks like what: its Assigner has history (arrival order, who left, seats) that a tab, which only sees the snapshots it is sent, cannot rebuild. So `openCaseTab` carries an optional `look` (`lookOf(id)` in `webview/main.ts`: `manager`, `receptionist` or the character's look; the key is left out when there is none). `LOOK_ID_PATTERN` is `^[a-z0-9][a-z0-9_-]{0,39}$`; every built-in id (`staff-0`..`staff-7`, `temp0`..`temp5`, the archetypes, `manager`, `receptionist`) matches. `parseWebviewMessage` drops a bad `look` (too long, uppercase, a path, not a string, markup) and still lets the rest of the message through; extra keys are dropped as before. The host passes the look through `routeWebviewMessage` -> the extension's `openCaseTab` hook -> `OfficeView.openCaseTab(agentId, look?)`, and writes it into the boot (`CaseTabBoot.look`, validated again by `parseCaseTabBoot`; a bad one is dropped, the boot stays valid).

**Tab already open.** The boot cannot change, so when the office asks again with a look (a click on the worker, or their marked row) the host posts `caseLook {agentId, look}` to that tab. `caseLook` is in `CASE_TAB_TYPES` and in `forAnotherCase` (by `agentId`), so a tab ignores it for another worker. The tab repaints the portrait if the look differs. A theme change alone does not push a look to an open tab (the office does not re-send until the user clicks again); the tab's own theme overrides still apply to whichever look it holds.

**Tab side.** `tabLook(handed, known, guess)` (`caseLogic.ts`, pure): a handed look the art knows (`getLook`) wins; a missing or unknown one falls back to the tab's own Assigner guess. The theme's look overrides and the repaint path (`refreshLooks`) are unchanged. Logs carry ids and counts only.

### Routing rules

`officeView.post()` no longer broadcasts everything to every webview. Each host-to-webview message belongs to one of three classes:

1. **Shared state.** `agents`, `settings`, `usage`, `claudeDefaults`: to the office view and **every** tab (cached and replayed on `ready`, as now). `caseTabs`, `projects`, `fileRoots`, `openMemo`, `openFrontDesk`, `frontDesk`, `frontDeskDone`, `dirListing`, `fileText`, `catalog`, `taskStarted`: **office view only**.
2. **Streams of a case.** `caseFile`, `caseAppend`, `caseClosed`: to every webview that currently has that worker's case open, and to nobody else. The drawer and a tab may show the same worker at the same time; each gets the stream. The host keeps the case state **per webview** (a `Map` keyed by the webview, one case each), where `managerHost.ts` kept a single `c` before. The append batching (at most 4 appends a second, merged, section 8.9 step 4) is per case, not per webview, so two views of one worker share one converter.
3. **Replies and errors.** A reply to a request (`planText`, `turn`, `sessionOptions`, `projects`, `taskStarted`, an `error` caused by a message) goes to the **sender of that request only**. An `error` with no sender (a background failure, for example a run that died) goes to the webviews that have that `agentId` or `sessionId` open, or to the office view as a toast when none does.

**How a tab claims messages.** Routing on the host is the first filter; the tab is the second. The tab runs `forAnotherCase(msg, own)` on everything it receives and ignores a true. The host uses the same function to choose recipients of unsolicited `error`s. A tab shows an `error` inline when it is not "for another case" and it matches the tab's own request (`nonce`, `requestId`, `sessionId`) or its `agentId`; an id-less error that reaches a tab (sent to it as the caller) becomes a toast in the tab. The drawer keeps its current logic but now also tests `error.agentId` first.

### Lifecycle

**Tab open.** `openCaseTab{agentId}` from the office view. The host looks the worker up: unknown, or demo mode: `error{agentId}`. Already open: reveal that tab (focus), no new tab. Otherwise, if `LIMITS.caseTabs` tabs are already open: `error{agentId, message}` ("Close a tab first"); nothing is closed for the user. Otherwise it creates a `WebviewPanel` (title is the worker's title, kept in step with `agents`; `retainContextWhenHidden` is false, because the host replays the `caseFile` on `ready` and when a hidden tab becomes visible; the column is the group of the most recent case tab, else the active editor group), with the boot element for that worker. Then `caseTabs` is re-sent. Tabs are not restored after a window reload (no panel serializer in v0.5).

**Focus.** Clicking the worker again, or their marked row, sends `openCaseTab` again and the host calls `reveal()`. Focus never creates a second tab for a worker.

**Close.** The user closes the tab (the panel's dispose that did not come from the host itself):
- the host drops that tab's case state and re-sends `caseTabs`;
- **idle worker, the tab only is the trigger: send the worker home** (below);
- **busy worker** (a turn is running, or `status` is `working` or `waiting`, or a request is pending): only the tab closes. The worker stays at their desk, and the run, if any, goes on.

Closing that is **not** the user's (the host disposing a tab because the worker was sent home with the x, the extension deactivating, or a window reload) never sends anyone home: the host sets a flag before it disposes a panel itself and checks it in the dispose handler.

**Worker leaves.** When the worker leaves `agents` for any reason (session ended, sent home), their tab gets `caseClosed{agentId, reason:'agentGone'}` and becomes the read-only "left the office" file, as the drawer does today; no new `CaseClosedReason` is added. A tab for a worker who was sent home **with the x** is closed by the host.

### Send home

`sendHome{agentId}`, or the close of an idle worker's tab. The rules, all checked on the host (the webview is untrusted):

- the worker must exist, be `kind: 'main'` (a temp leaves with its parent; `error{agentId}` otherwise);
- **idle**: `status` is `idle` or `done`, there is no `pending`, `activity` is not `needsYou`, and, for an office run, no turn is running (`CaseHeader.busy` false). Anything else: `error{agentId, message}` ("They are still working"). The webview should not offer the x on a busy row, but the host decides;
- the `agents` the host publishes no longer list the worker (nor their temps). The office walks them out and the worker's case, if open anywhere, closes with `agentGone`;
- nothing about the Claude Code session is touched, except the office-run rule below. A worker who is `elsewhere` (live in a Claude Code panel or terminal) is just hidden; the other process is not touched.

**The record.** `src/host/sentHome.ts` keeps `agentId -> { at, mtime }` where `mtime` is the transcript's modified time (epoch ms) when the worker was sent. It is persisted in the extension's global state so a window reload does not bring everyone back, and entries are dropped when the session's transcript is gone or after 30 days.

**The office-run rule.** If the worker is an office run (`control: 'office'`) with an **idle** run, the run is stopped as part of sending home (the SDK query is closed and the run is removed; the session can be resumed later as a free session, as in section 8.7). A run with a pending request or a running turn is **never** stopped: the send-home is refused as above. The check and the stop happen with no await in between, and a reply that arrives while the run is stopping gets an `error` with the worker's `sessionId`.

**Return on activity.** A sent-home worker comes back (the record is deleted and the worker appears in `agents` again, so the office walks them in) when any of these is true for their session:
1. the transcript's modified time is **newer than `mtime` by more than 2 s** (`MTIME_SLOP_MS`), unless the write belongs to the send-home. A write whose own modified time is no later than `at + 15 s` (`SETTLE_MS`) is only **absorbed**: the record's `mtime` moves up to it and is saved, and the worker stays home. This covers the write made by stopping an office run and a cached session list older than the send. It is judged by when the write happened, not when it was first seen, so a refresh long after the send-home (the office was hidden) does not bounce the worker. Later writes use the 2 s rule from the absorbed `mtime`;
2. the snapshot's `status` is `working` (also right after sending);
3. the worker is **knocking**: `status` `waiting`, a `pending` request, or `activity` `needsYou`.

The host must evaluate this against the **unfiltered** list, so the pipeline is: watcher -> `sentHome.ts` (records, return test, `filter()`) -> filtered `agents` to the office view, every tab and `managerHost`. A task the user starts on a free session of a worker that is home (`newTask` to an existing session, `taskStarted`) returns the worker through rule 2 or 1 within a tick. A worker who has not returned is never offered in the memo's "existing worker" list (it uses `agents`).

### Auto send-home

`claudeOffice.sendHomeAfter`: hours, default `8`, minimum `0`, maximum `720`, `0` = never. Read through `sendHomeAfterMs(value)` (`protocol.ts`): `0` gives 0 (off); a fraction such as `0.5` is allowed; a missing, negative, non-number or non-finite value gives the default 8 hours; more than 720 is clamped to 720. `sentHome.ts` checks on every `agents` update and on a 60 second timer: a main worker who is **idle by the rule above**, whose `since` is at least that many milliseconds ago, and who has **no open case tab** (the user is looking at it), is sent home. Setting changes apply live (`onDidChangeConfiguration`). Auto send-home uses the same code path, record and office-run rule as `sendHome`.

### Placement

On the first open of the office the host moves the view container to the top of the window once, then stores `claudeOffice.placedOnTop` in global state so it never moves it again by itself. The command `claudeOffice.placeOnTop` ("Middle Management: Put the office on top", declared in `package.json`) redoes it on demand. Implementation is task 8.5, in the launcher and `extension.ts`; if the placement commands of VS Code or VSCodium are missing the command shows a short information message and does nothing else.

### Demo mode

Both new messages go **through the demo guard** (`needsRealSession` returns true for them) and are refused with the usual demo `error`, carrying the `agentId`:

- **`openCaseTab`: refused.** A demo worker has no session and no transcript, so a tab would be an empty shell, and `openCase` is already refused for them (section 16: panels do not mock data in production code). The webview shows the refusal as it does for `openCase` today (inline in the drawer, else a toast).
- **`sendHome`: refused.** The demo feed owns the demo roster and would simply bring the workers back; a local fake would need demo state in the webview, which has no demo flag. The refusal is the same friendly error.

The demo guard's refusal for `openCase` also carries `agentId` from now on, so a tab or drawer can tell it is theirs. `claudeOffice.sendHomeAfter` does nothing in demo mode (the send-home timer ignores demo workers). `caseTabs` is `[]` while demoing. The icon rail, the staff list and the placement command work in demo mode.

### Module ownership for the next tasks

Each task edits only its own files. The contract files (`protocol.ts`, `validate.ts`, `panels.ts`) change only in a contract task.

| Task | Owner of |
| --- | --- |
| 8.1 This contract | `src/shared/protocol.ts`, `src/shared/validate.ts`, `package.json` (the setting and the command), `test/shared-v05.test.ts`, this section |
| 8.2 View and wiring | `src/view/officeView.ts` (per-webview routing per the rules above, the case tab panels, boot element, `caseTabs` cache and replay, close handling and the host-dispose flag), `src/extension.ts` (message routing for the two new messages, the demo guard entries in `src/host/demoGuard.ts` with `agentId` on the refusals, wiring of `sentHome` and the tab close callback) |
| 8.3 Manager host | `src/manager/managerHost.ts` (case state per webview instead of the single `c`, a stream per case, `error.agentId`, the idle test and `stopIdleRun`, the send-home refusal reasons) |
| 8.4 Sent-home records | `src/host/sentHome.ts` (records and persistence, the return test, `filter()`, the auto timer and `sendHomeAfter` reading), host tests |
| 8.5 Placement | the launcher view and `src/extension.ts` (move to the top once, the `claudeOffice.placeOnTop` command) |
| 9.1 Case tab webview | `webview/caseMain.ts` (reads the boot element, `ready`, `forAnotherCase`, the tab layout) and `webview/engine/caseFile.ts` (accept `error.agentId`; render a case in a wide tab layout; the drawer keeps working), the `dist/case.js` entry in `esbuild.mjs` |
| 9.2 Office strip | `webview/main.ts` (width decision: `openCaseTab` when wide, drawer when narrow; `sendHome` from the staff x; `caseTabs` state), `webview/engine/iconBar*` (the vertical rail), `webview/engine/roster.ts` (the x on idle rows, the open-tab mark, click to focus) |

The webview consumes only `src/shared/*`; the host never imports from `webview/*`.


## 19. View mode

(Section 18 is v0.5.) View mode is an office that only shows the agents walking around. The user can still change how it looks through the Front desk, and nothing else. The contract is `src/shared/officeMode.ts` (`OFFICE_MODES`, `OfficeMode`, `DEFAULT_OFFICE_MODE`, `parseOfficeMode`, `VIEW_MODE_ALLOWED`), `src/host/viewGuard.ts` and `package.json` (the setting and the command). Tests: `test/shared-officeMode.test.ts`, `test/host-viewGuard.test.ts`, `test/engine-viewMode.test.ts`.

### The setting and the command

`claudeOffice.mode`: `"manager"` (the default) or `"view"`. It is a Front desk setting (`mode` is the first entry of `FRONT_DESK_SETTINGS` and has an entry in `FRONT_DESK_ENUM_VALUES`), so the Settings tab shows it as a select labelled "Office mode", and `setSetting` and `openSettingsUi` accept the key `mode`. Anything but `manager` or `view` is refused. `parseOfficeMode` reads the raw value: exactly `"view"` gives view, anything else gives manager.

The setting is read at boot. The host renders the office HTML with `<body data-office-mode="view|manager">`, and the webview reads that attribute to decide what to build.

The command `claudeOffice.toggleMode` ("Middle Management: Switch Between View and Manager Mode", declared in `package.json`) flips the setting.

### Switching

When the setting changes (`onDidChangeConfiguration`), the host sets the HTML of the office webviews again (the panel view and the editor-tab office) with the new `data-office-mode`, closes any open case tabs, and replays the cached agents, settings and usage when the new page sends `ready`.

### Routing

Front desk messages are routed first, in both modes, so the Front desk always works. After that the view guard (`src/host/viewGuard.ts`) lets only `VIEW_MODE_ALLOWED` through: `ready`, `refreshUsage`, `closeCase` and `updateAction` (switching to view mode closes every case tab, each close sends a synthetic `closeCase`, and the manager host must still forget those cases; it only releases state). Everything else gets `error{message: VIEW_REFUSAL}`, with the same id echo as the demo refusals (`agentId` when the message had one). Because this is an allowlist, a message type added later is refused in view mode until it is listed.

### What the webview shows

- No icon bar or rail, no staff list and no New-task button.
- The only panel is the Front desk, opened from the receptionist or the counter.
- `clock` and `calendar` are tooltip-only (no click).
- Worker tooltips have no "Click to" hints. A knocking worker reads "Waiting for you in their Claude Code window", or "Switch to manager mode to answer" for an office-run worker.
- Scene extras are usage-only.

### Host behaviour

- No `fileRoots` pushes.
- The New Task command explains that it is unavailable in view mode and offers to switch.
- When switching to view while office-run workers are live, a toast says they keep running and offers "Switch back". The host does not stop any process.
- The usage meter and the usage probe follow `usageChecks` as before.

### The toggle command and the Front desk row

The toggle command writes to the scope that currently decides the value: the workspace folder, then the workspace, then global. The Front desk row writes to global like the other settings, so a workspace value can still win; the row's usual "Workspace overrides this" badge shows it.
