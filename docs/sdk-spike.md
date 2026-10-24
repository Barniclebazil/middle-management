# Claude Agent SDK spike (Manager Mode, plan row 6.2)

Facts about `@anthropic-ai/claude-agent-sdk@0.3.302` driving the Claude Code 2.1.302 binary that the Claude Code VS Code
extension already ships. Everything below was observed in real runs on Linux (openSUSE, Node 24, Haiku 5.5, subscription
login, no `ANTHROPIC_API_KEY`), except where marked "source" (read from the SDK's minified JS) or "untested".

Code: `dev/sdk-spike.ts` (scenarios), `dev/sdk-bundle-check.ts` + `dev/sdk-bundle-check.mjs` (bundling).
Run a scenario with `node dev/sdk-spike.ts <new|new-write|ask|plan|interrupt|resume|partial>`; the scratch project,
logs and raw JSONL (`out/<scenario>.jsonl`) live under `$SPIKE_ROOT` (defaults to the session scratchpad).

## 1. Setup facts

- Dependency: `"@anthropic-ai/claude-agent-sdk": "0.3.302"` (exact pin) in `dependencies`. `npm install` also pulled its
  peer dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) and all eight platform binary packages
  as optional deps; only the host's (`-linux-x64`, 273 MB) is unpacked into `node_modules`. esbuild's own platform
  package is untouched, so do not use `--omit=optional`. `npm run build`, `npm test` (135 pass) and `npm run typecheck`
  still pass.
- The vsix is unaffected: `.vscodeignore` is a whitelist (`**` then `!dist/*.js` ...), so `node_modules` never ships
  (`vsce ls --no-dependencies` lists 6 files, none from `node_modules`). Once the SDK is bundled it adds about 1 MB to
  `dist/extension.js` (section 8).
- `sdk.mjs` is self-contained (zod, ajv, MCP client are inlined). Its only bare imports are Node built-ins. The peer
  deps matter only for the `.d.ts` types.

## 2. Recommended `query()` options

```ts
query({
  prompt: inputQueue,                       // AsyncIterable<SDKUserMessage>, see section 4
  options: {
    cwd,
    pathToClaudeCodeExecutable: claudeBin,  // the Claude Code extension's native-binary/claude(.exe)
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'default',              // ALWAYS pass it, see warning below
    model: 'haiku',                         // alias works; init reports the full id (claude-haiku-5-5)
    includePartialMessages: true,           // only if the UI shows live text
    canUseTool,
    abortController,
    maxBudgetUsd, maxTurns,                 // optional guard rails
    env: cleanEnv(),                        // a FULL environment, see below
    resume: sessionId,                      // only when resuming
  },
});
```

- **Always pass `permissionMode` explicitly.** When omitted, the CLI uses `permissions.defaultMode` from the loaded
  settings. This machine's `~/.claude/settings.json` has `defaultMode: "plan"`, and a probe confirmed that with
  `settingSources: ['user', ...]` and no `permissionMode` the session starts in `plan`; with `settingSources: []` it
  starts in `default`. The `.d.ts` also says it may pick `'auto'` where that exists.
- **`env` replaces the environment, it is not merged** (source: `Ct = v ? {...v} : {...process.env}`). Passing
  `{ FOO: '1' }` would drop `PATH`/`HOME`. Always spread `process.env`. The SDK then adds
  `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_AGENT_SDK_VERSION` only if unset, sets `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`,
  and deletes `NODE_OPTIONS` and `DEBUG` from the child's env.
- **Strip inherited Claude Code markers** from that env (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_VERSION`,
  `CLAUDE_PID`). The spike runs inside a Claude Code session whose env holds `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SESSION_ID`, a messaging socket and token; leaking those into a child makes it look like a nested child
  session. A real extension host normally has none of them, but the cleanup is cheap.
- **Custom entrypoint works** (tested): with `env.CLAUDE_CODE_ENTRYPOINT = 'claude-office'`, both the
  `~/.claude/sessions/<pid>.json` file and every transcript record carry `entrypoint: "claude-office"`. That is the
  clean way for the existing watcher to recognise sessions the extension itself started.
- Auth: nothing to do. `system/init` reports `apiKeySource: "none"` and the subscription login is used.
- Note `settingSources` includes the user's own `permissions.allow` rules and hooks; see "auto-allowed tools" below.

## 3. Message stream (what every scenario shows)

Types seen on the generator, in the usual order for a turn:

| type / subtype | when | useful keys |
| --- | --- | --- |
| `system/init` | start of **every turn** (streaming input emits a new one per user message) | `session_id`, `model` (full id), `permissionMode`, `tools[]` (28 first turn, 243 on the next turn), `mcp_servers[{name,status,source}]` (status `pending` at first), `slash_commands`, `apiKeySource`, `claude_code_version`, `memory_paths`, `messaging_socket_path`, `capabilities` |
| `rate_limit_event` | early in a turn | `rate_limit_info.{status,rateLimitType,unifiedWindows.five_hour.utilization,...}` |
| `system/commands_changed` | early | `commands` |
| `system/thinking_tokens` | while Haiku thinks | `estimated_tokens`, `estimated_tokens_delta` |
| `system/status` | status change | `status` (`"requesting"` or `null`), `permissionMode` (present after a mode change) |
| `assistant` | each model message | `message.content[]` blocks: `thinking`, `text`, `tool_use{id,name,input}`; also `parent_tool_use_id`, `uuid`, `timestamp`, `request_id`, `wire_tool_inputs` |
| `user` | tool results (echoed by the CLI) | `message.content[] {type:'tool_result', tool_use_id, content, is_error?}`, `tool_use_result` (structured), `tool_result_meta[].permission_decision` |
| `stream_event` | only with `includePartialMessages` | section 9 |
| `result/success` or `result/error_during_execution` | end of a turn | section 10 |

`tool_result_meta[].permission_decision` says how a tool was permitted: `{decision:'accept', source:'config'}` (auto,
rule or mode), `source:'user_temporary'` (our `canUseTool` allowed it), `{decision:'reject', source:'user_reject'}`.
That is how to tell "auto-allowed" from "the user approved" when rendering history.

## 4. Streaming input

```ts
{ type: 'user', message: { role: 'user', content: 'text' }, parent_tool_use_id: null }
```

`dev/sdk-spike.ts` has a small `InputQueue` (an `AsyncIterable` with `push(text)` / `end()`). Facts:

- The generator does **not** finish on a `result`; it stays open (session file `status: "idle"`) until the input
  iterable ends. Call `end()` on the queue (or `q.close()` / abort) when the worker is done.
- Each pushed message produces a new `system/init` ... `result` turn on the same `session_id`.
- One `result` per user message. There is no separate "idle" message; use the `result` message.

## 5. Scenario results

### a. new (streaming input, Bash approve/deny)

- **The prompt exactly as given never reaches `canUseTool`.** `Read notes.txt` (inside cwd) is auto-allowed
  (`source:"config"`), and `echo office-ok` and `ls -la` are read-only commands that Claude Code allows without a
  prompt. `toolsAsked: []`, 4 turns, `DONE`, `permission_denials: 0`. Run: `node dev/sdk-spike.ts new`.
- To exercise the callback, variant `new-write` uses `echo office-ok > marker.txt` then `ls -la > listing.txt`. Both
  Bash calls reached `canUseTool` (redirects are not read-only). First allowed, second denied with a message.
- Deny effect: the SDK sends a `tool_result` with `is_error: true` and `content` equal to our `message`; the model then
  replied "DONE ... The `ls -la > listing.txt` command was declined, so `listing.txt` was not created. I did not retry it."
  The result message lists the denial: `permission_denials: [{tool_name, tool_use_id, tool_input}]`. The model does not
  retry on its own when the message tells it not to; it carried on to the final answer.
- A command with an unresolvable variable (`for i in $(seq ...)`) is also asked, with
  `decisionReason: "A variable in this command can't be checked before it runs"` and `suggestions: []`.
- `session_id` is on every message (and on `system/init`); capture it from the first one.

`canUseTool` call, as logged:

```json
{ "toolName": "Bash",
  "input": { "command": "echo office-ok > marker.txt", "description": "Write office-ok to marker.txt" },
  "options": {
    "toolUseID": "toolu_01Gzxf...",
    "suggestions": [
      { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "echo office-ok *" }],
        "behavior": "allow", "destination": "localSettings" },
      { "type": "addDirectories", "directories": ["<cwd>"], "destination": "session" } ],
    "blockedPath": "<cwd>/marker.txt",
    "optionKeys": "signal,suggestions,blockedPath,decisionReason,title,displayName,description,defaultToNo,suppressAlwaysAllowRule,toolUseID,agentID,requestId" } }
```

`title`, `displayName`, `description` and `decisionReason` were keys but `undefined` in all these runs, so build prompt
text from `toolName` + `input` (and `blockedPath`), with the optional fields as an improvement when present.
`suggestions` is what an "always allow" button should return as `updatedPermissions` (e.g. a `Write` ask offered
`[{type:'setMode', mode:'acceptEdits', destination:'session'}]`).

### b. ask (AskUserQuestion)

Arrives in `canUseTool` with `toolName: "AskUserQuestion"`, `input` keys `[questions]`, `suggestions: null`, and the
extra option key `requiresUserInteraction`. Exact input:

```json
{ "questions": [ { "question": "Which colour do you pick: Red or Green?", "header": "Colour",
    "options": [ { "label": "Red", "description": "Pick red" }, { "label": "Green", "description": "Pick green" } ],
    "multiSelect": false } ] }
```

Answer (works as documented):

```ts
return { behavior: 'allow', updatedInput: { questions: input.questions, answers: { [q.question]: 'Green' } } };
```

The CLI turned it into the tool result `Your questions have been answered: "Which colour ...?"="Green". You can now
continue ...`, and the final reply was `You picked **Green**.` Confirmed in two runs. Notes: for `multiSelect` the
answer is presumably a comma-joined label string (untested); free-text "Other" answers are just any string (untested);
on one run Haiku called `ToolSearch` first to load the deferred `AskUserQuestion` tool, so a `ToolSearch` tool_use can
precede it. Match on `toolName`, never on position.

### c. plan (`permissionMode: 'plan'`, ExitPlanMode)

- `system/init` reports `permissionMode: "plan"`.
- In plan mode the model wrote its plan file with `Write` to `~/.claude/plans/<slug>.md` **without** asking
  `canUseTool` (auto-allowed). Side effect: that file is created in the user's real `~/.claude/plans/` (the spike
  deleted its own).
- `ExitPlanMode` reaches `canUseTool` with `input` = `{ plan: "<markdown>", planFilePath: "/home/user/.claude/plans/<slug>.md" }`
  (full plan text, so the UI can show it), `suggestions: null`, `requiresUserInteraction` option key.
- Allowing it (`behavior:'allow'`, `updatedInput: input`) made the CLI emit `system/status` with
  `permissionMode: "default"` (it returns to the pre-plan mode, here `default`), and the tool result text
  `User has approved your plan. You can now start coding. ... ## Approved Plan: ...`.
- The next `Write` of `hello.txt` then went through `canUseTool` (mode is `default`; suggestion offered was
  `setMode acceptEdits`); allowing it created `hello.txt` containing `hi\n`. Outcome: plan, approve, mode switch,
  file created. Result `num_turns: 6`.
- **Surprise, model switch:** with `model: 'haiku'`, the plan-mode turns ran on `claude-sonnet-5-5`
  (the `assistant` messages' `message.model`), then Haiku again after approval. Cost: `$0.127`, of which Sonnet was
  `$0.122` (a fresh 1h cache write of about 29k tokens), versus about `$0.004` for a Haiku scenario. The `result.modelUsage`
  map shows it. Plan mode is about 30x more expensive than the requested model and uses a model the caller did not pick.
  Untested: whether another `model` or a setting changes this.
- Untested: denying ExitPlanMode (expected: model stays in plan mode and revises), and approving with
  `updatedPermissions: [{type:'setMode', mode:'acceptEdits', destination:'session'}]` to land in `acceptEdits`.
  `q.setPermissionMode()` is the alternative.

### d. interrupt

- A bare `sleep 30` is refused by Claude Code itself ("standalone sleep blocked"); the model just answers. It never
  reaches `canUseTool`. Use a loop such as `for i in $(seq 1 30); do echo tick $i; sleep 1; done` (that was asked via
  `canUseTool` and approved).
- `await q.interrupt()` 3 s later resolved immediately. The stream then emitted: a `user` `tool_result` for the Bash,
  a `user` message with text `[Request interrupted by user for tool use]`, then
  `result/error_during_execution` with `is_error: true`, `stop_reason: "tool_use"`, `num_turns: 3`, no `result` string,
  and an `errors` array key.
- **The query does not end.** Pushing a new message on the same input stream worked: a new `system/init`, then
  `READY`, then `result/success` (`num_turns: 1`). The session keeps its context. `interrupt()` also accepts
  `{ cancelQueued: true }` (source) to drop queued user messages.
- Treat `result` with `subtype !== 'success'` as "turn ended", not "query ended".

### e. resume

- New query, `resume: <session_id>`, string prompt. Asked "What did you echo earlier?" it answered
  "I echoed `office-ok` into `marker.txt`." Remembers.
- The **same `session_id` and the same transcript file** (`<session_id>.jsonl`) are reused: no new file appeared in the
  project folder; the file grew from 52 to 68 lines, with an extra `{"type":"mode","mode":"normal"}` record.
  (`forkSession: true` is the option for a new id; untested.)
- A new `~/.claude/sessions/<newpid>.json` appeared for the resumed process, with the **original** `sessionId`.
- The resumed `system/init` came before any API call. The turn cost `$0.0044`.

### f. partial (`includePartialMessages: true`)

`stream_event` messages: `{ type:'stream_event', event, session_id, parent_tool_use_id, uuid, api_message_id }`
(the first also has `ttft_ms`). `event` is the raw Anthropic streaming event. Sequence for a text-only reply:

```json
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_...","role":"assistant","content":[],"usage":{...}}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fluor"}}}
... 15 text_delta events ...
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn",...},"usage":{...}}}
{"type":"stream_event","event":{"type":"message_stop"}}
```

Live text = concatenate `event.delta.text` for `content_block_delta` + `text_delta`, keyed by `api_message_id` and
`event.index`. The concatenation equalled the final `result.result` exactly. The full `assistant` message arrives
after the last delta and before `message_delta`/`message_stop` (the complete block replaces the partial text).
Thinking and tool input use the same events with `thinking_delta` / `input_json_delta` (not exercised here).
Subagent output carries a non-null `parent_tool_use_id`.

## 6. Sessions file and transcript

`~/.claude/sessions/<pid>.json` (only `<digits>.json` files opened; no `*.key` file was touched):

- An SDK-driven session **does** create one, about 0.4 s after spawn, and deletes it when the query ends (about
  0.3 s after the last `result`; for a streaming query that is after the input iterable ends).
- Keys: `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint, pidDomain,
  messagingSocketPath, name, nameSource, nameSince`, plus `status, updatedAt, statusUpdatedAt` once status is set.
- Values observed: `kind: "interactive"` (not a special "sdk" kind), `entrypoint: "sdk-ts"` (or whatever
  `CLAUDE_CODE_ENTRYPOINT` is), `version: "2.1.302"`, `status`: `idle` (waiting for input, streaming mode) then `busy`
  while a turn runs then `idle` again. `waiting` was never seen (pending `canUseTool` calls did not change it
  during the short windows tested).
- Consequence: Middle Management's existing watcher will already see these sessions as ordinary workers. Manager Mode must
  join them to its own bookkeeping by `sessionId` (and/or a custom entrypoint) rather than creating duplicates.
  The `pid` is the `claude` binary's pid, not the host's.

Transcript: `~/.claude/projects/<cwd with every non-alphanumeric char replaced by "-">/<session_id>.jsonl`
(scratch path became `-tmp-claude-1000--home-kaba-...-scratchpad-sdk-proj`). Same layout as interactive sessions.

- Record `type`s: `queue-operation`, `user`, `attachment`, `atis-latch`, `api-request-shape`, `api-request-blob`,
  `api-request`, `last-prompt`, `ai-title`, `assistant`, `cost-state`, `mode` (after a resume).
- `user`, `assistant` and `attachment` records carry `entrypoint` (`sdk-ts`), `version` (`2.1.302`), `userType`
  (`external`), `sessionId`, `cwd`, `gitBranch`, `isSidechain`. SDK-sent prompts have `promptSource: "sdk"`,
  `turnOrigin: "sdk"` and `turnPosition`. Records such as `cost-state`, `mode`, `ai-title` have none of those.
- The first record is `queue-operation` `enqueue` with the prompt text.

## 7. Costs (list price; the login is a subscription, nothing was billed)

| run | `total_cost_usd` |
| --- | --- |
| a `new` (read-only commands, no prompts) | 0.0061 |
| a `new-write` (approve + deny) | 0.0039 |
| b `ask` (two runs) | 0.0033, 0.0038 |
| c `plan` (Sonnet inside) | **0.1272** |
| d `interrupt` (final run; an earlier `sleep 30` attempt 0.0035) | 0.0053 |
| e `resume` | 0.0044 |
| f `partial` | 0.0019 |
| bundle check (cold, warm), `entrypoint` probe | 0.0031, 0.0003, 0.0058 |

Total about `$0.17`, of which `$0.12` was the plan-mode Sonnet turn. A cold Haiku turn is mostly a 1h cache write of
about 14k tokens of Claude Code's system prompt/tools (cache reads make follow-up turns cheaper). The `result` message
has `total_cost_usd`, `usage`, `modelUsage` (per model, with `costUSD`), `num_turns`, `duration_ms`, `permission_denials`,
`stop_reason`, `terminal_reason`.

## 8. Bundling

SDK facts (source): `sdk.mjs` is 1.29 MB minified ESM. It is bundlable: its only dependencies are Node built-ins, and
its single use of `import.meta` is `createRequire(import.meta.url)` at module top level (used to locate the optional
platform binary when no `pathToClaudeCodeExecutable` is given).

Recipe (`dev/sdk-bundle-check.mjs`, same flags as the extension build: platform node, format cjs, target node18):

```js
await build({
  entryPoints: ['dev/sdk-bundle-check.ts'], outfile, bundle: true,
  platform: 'node', format: 'cjs', target: 'node18',
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
});
```

- Result: **0 warnings; 1255 KiB** unminified, **981 KiB** with `minify: true` (SDK contributes 1260 KiB of input, our
  entry 2 KiB). The bundled file ran with plain `node` and returned `"pong"` (cost `$0.003`, then `$0.0003` warm).
- Without the `define`, esbuild builds with only a "1.2mb" warning marker and the bundle **crashes at load**:
  `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object ... Received undefined` (from
  `createRequire(undefined)`). The `define` plus banner is required. (Inside the extension host `__filename` is the
  bundled `extension.js`, which is fine because nothing is resolved from it when the binary path is explicit.)
- Top-level `await` cannot be used in a cjs entry (esbuild error); wrap in an async function.
- The external-package alternative was not needed. If ever required: mark `@anthropic-ai/claude-agent-sdk` external and
  ship `sdk.mjs` plus `package.json`; the trade-off is a runtime ESM `import()` from CJS and shipping about 1.3 MB of
  loose files in the vsix (`.vscodeignore` whitelist change), for no benefit over bundling.
- Nothing else is loaded at runtime from the package when `pathToClaudeCodeExecutable` is set (no `manifest.json`,
  no `core*.mjs`; those belong to other entry points such as `/core` and `/bridge`).

## 9. How the SDK spawns the binary (source)

- `pathToClaudeCodeExecutable` is read in `query()` (`hy = options.pathToClaudeCodeExecutable`). If unset, it resolves
  `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe]` via `createRequire(import.meta.url).resolve` and throws
  "Native CLI binary for ... not found. Reinstall ... without --omit=optional, or set options.pathToClaudeCodeExecutable"
  when missing.
- If the path ends in `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx` it is run through `options.executable` (`node`, or `bun` under
  bun) as `executable [executableArgs] path args...`. **Any other path is spawned directly** as the command. (In an
  Electron extension host, `node` would have to be a real Node on PATH; avoid this branch.)
- Spawn: `child_process.spawn(command, args, { cwd, stdio: ['pipe','pipe','pipe'], signal, env, windowsHide: true })`.
  **No `shell` option** (so `false`), arguments are passed as an array (paths with spaces are fine), and `windowsHide`
  is on. `stderr` is buffered (last 2 KiB) for error messages; pass `stderr: (s) => ...` or set
  `DEBUG_CLAUDE_AGENT_SDK` to stream it.
- Fixed arguments: `--output-format stream-json --verbose --input-format stream-json` (always streaming JSON on both
  sides, even for a string prompt). Then, from options: `--permission-prompt-tool=stdio` when `canUseTool` is set (so it
  cannot be combined with `permissionPromptToolName`), `--permission-mode`, `--model`, `--max-turns`, `--max-budget-usd`,
  `--resume`, `--fork-session`, `--setting-sources user,project,local`, `--include-partial-messages`, `--add-dir`,
  `--allowedTools`, `--disallowedTools`, `--no-session-persistence` (`persistSession: false`), `--session-id`.
- Errors: `ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`/`ELOOP`/... on spawn become `ReferenceError("Claude Code native binary not
  found at <path>. ...")` or "exists but failed to launch" (the latter mentions the musl vs glibc mismatch). Non-zero
  exit becomes `Error("Claude Code process exited with code N. stderr: ...")` thrown from the generator.
- Lifecycle: abort or `close()` sends SIGTERM (Windows: ends stdin), escalating to SIGKILL after a few seconds if it has not exited; a process-exit
  hook kills any tracked children. `q.interrupt()` and `q.setPermissionMode()` are control requests, not signals.

## 10. Result message

```json
{ "type":"result", "subtype":"success", "is_error":false, "stop_reason":"end_turn", "terminal_reason":"completed",
  "num_turns":4, "duration_ms":4840, "duration_api_ms":6176, "total_cost_usd":0.00393495,
  "usage":{ "input_tokens":6, "cache_creation_input_tokens":14397, "cache_read_input_tokens":59005, "output_tokens":668, "...":"..." },
  "modelUsage":{ "claude-haiku-5-5":{ "inputTokens":1225, "outputTokens":686, "costUSD":0.0039, "contextWindow":1000000 } },
  "permission_denials":[ { "tool_name":"Bash", "tool_use_id":"toolu_...", "tool_input":{ } } ],
  "result":"DONE ...", "session_id":"c91aa617-...", "uuid":"..." }
```

**Correction (section 14a):** `total_cost_usd` and `modelUsage` are RUNNING session totals (also across resume); only `usage`
tokens, `duration_ms` and `num_turns` are per turn. In the interrupt run the two results (`0.0020`, then `0.0033`) were the
session total after the first and the second result, not two separate turn costs. Take deltas per worker in the host.
`subtype` seen: `success`, `error_during_execution`. Others in the types: `error_max_turns`, `error_max_budget_usd`, ...

## 11. Handling recipes

**canUseTool**

```ts
const canUseTool: CanUseTool = async (toolName, input, { signal, suggestions, toolUseID, blockedPath }) => {
  if (toolName === 'AskUserQuestion') return askUser(input);      // below
  if (toolName === 'ExitPlanMode')    return approvePlan(input);  // below
  const choice = await ui.askPermission({ toolName, input, suggestions, toolUseID, blockedPath }, signal);
  if (choice.kind === 'allow') return { behavior: 'allow', updatedInput: input };            // updatedInput is what runs
  if (choice.kind === 'always') return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
  return { behavior: 'deny', message: choice.reason ?? 'The user declined.' };               // interrupt: true to stop the turn
};
```

- The callback may take as long as it likes: there is no timeout (per the `.d.ts`, "permission prompts have no park
  deadline") and the turn simply waits, so map each pending call to a worker's "waiting for you" state and key it by
  `toolUseID`. `signal` aborts when the turn is interrupted or closed; resolve/clean up then.
- Always return an object; `null`/`undefined` leaves the tool blocked forever.
- Do not rely on which tools get asked: allow rules in the user's settings, read-only Bash, in-cwd reads, plan files and
  the current mode all skip the callback. A host that must see every tool call should read `assistant` `tool_use`
  blocks and `tool_result_meta.permission_decision` instead.

**AskUserQuestion**: render `input.questions[]` (`question`, `header`, `options[{label,description}]`, `multiSelect`),
collect one label (string) per `question` text, and return
`{ behavior:'allow', updatedInput: { questions: input.questions, answers: { [question]: label } } }`.

**ExitPlanMode**: show `input.plan` (markdown; `input.planFilePath` is the saved copy). Approve with
`{ behavior:'allow', updatedInput: input }`; the session leaves plan mode itself (expect `system/status` with the new
`permissionMode`). Deny with a message to keep planning (untested).

**Interrupt**: `await q.interrupt()` then wait for the `result` (`error_during_execution`); keep feeding the same input
queue for the next instruction. **Resume**: new `query({ options: { resume: sessionId, ...same options } })` with the
same `cwd` (the transcript folder is derived from `cwd`); the id and transcript file stay the same.

## 12. Windows notes

Not tested (no Windows machine). From the source and Node's behaviour:

- The default binary lookup appends `.exe` on `win32`; the Claude Code VS Code extension should ship
  `resources/native-binary/claude.exe` (verify the actual folder name on a Windows install).
- The SDK spawns without a shell. A `.cmd`/`.bat` shim as `pathToClaudeCodeExecutable` will therefore fail: current
  Node versions (security fix for CVE-2024-27980) reject spawning `.cmd`/`.bat` without `shell: true` with `EINVAL`,
  which the SDK's error mapping does not list, so the user would see "Failed to spawn Claude Code process: spawn EINVAL".
  Resolve to the real `.exe` (and never to `claude.cmd` from `PATH`).
- A path ending in `.js` would be run with `node` from `PATH`; not applicable to the native binary.
- `windowsHide: true` stops a console window flashing. On abort the SDK ends stdin (no SIGTERM on Windows).
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is handled by the SDK on Windows when a config dir override is used.
- Path-to-project-folder encoding on Windows (drive letters, backslashes) should follow the same "non-alphanumeric to
  `-`" rule seen here, but check against the watcher's existing `projectDirName`.

## 13. Risks and open questions

1. **Plan mode silently switches to Sonnet** (about 30x the cost of Haiku for the same task). Decide whether Manager Mode
   offers plan mode, warns, or implements its own plan step.
2. **Default permission mode comes from the user's settings** (this user: `plan`). Always pass `permissionMode`.
3. **`canUseTool` is not called for everything** (read-only Bash, in-cwd reads, allow rules, plan files). The UI cannot
   assume it sees every tool; use stream messages for display, `canUseTool` for decisions only.
4. **`env` is not merged**; forgetting `...process.env` breaks the child. Strip inherited `CLAUDE_CODE_*` markers.
5. **Sessions show up twice in the office** unless Manager Mode joins by `sessionId` (or sets its own
   `CLAUDE_CODE_ENTRYPOINT`, which works). The session file disappears when the query ends, even though the transcript
   remains resumable.
6. **Binary lookup**: the Claude Code extension's folder name includes version and platform
   (`anthropic.claude-code-2.1.302-linux-x64`). The SDK pin (0.3.302) and the CLI (2.1.302) match today; a newer or older
   extension may speak a different control protocol. Needs a version check at startup and a graceful "update the Claude
   Code extension" message. Untested: running SDK 0.3.302 against a different CLI version.
7. **Permission prompt timeouts / disconnects**: if the webview closes mid-prompt the callback still waits. Decide on
   auto-deny, and always resolve pending callbacks when a worker is closed (abort controller).
8. **Windows** untested (section 12).
9. **Untested**: `forkSession`, ExitPlanMode deny, `setPermissionMode` mid-turn, multiSelect answers, MCP servers and
   hooks from the user's settings (this machine's MCP servers showed `status: "pending"` at init and added 1 to 2
   entries, they did not block the first turn), subagent (`Task`) messages and their `parent_tool_use_id`, a permission
   prompt left pending while `interrupt()` is called.
10. **Peer dependencies**: `npm install` added `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` plus
    transitive packages (84 added, lockfile +1.2k lines) only to satisfy peer ranges. They are not needed at runtime
    after bundling; if the lockfile growth bothers us, install with `--legacy-peer-deps` and accept `any`-typed SDK
    references (the `.d.ts` imports types from them; `skipLibCheck` is on).

## 14. Office tools spike (cost, rate limits, usage probe, live controls, config path)

Task 1.1 of the "Office tools" plan. Code: `dev/options-spike.ts`, run with `node dev/options-spike.ts <cost|probe|live|config>`
(scratch cwd and raw JSONL under `$SPIKE_ROOT`, default the session scratchpad `.../options-spike/`; the binary is found with
`src/manager/claudeBinary.ts`'s `findClaudeBinary`, `CLAUDE_BIN` overrides). Observed 2026-10-19, SDK 0.3.302, CLI 2.1.302,
Haiku 5.5 (one turn also on Haiku 4.5), subscription login (Max), Linux. All runs used `settingSources: []`, `tools: []`,
`permissionMode: 'default'`, one-word prompts. Account email/org/ids are never printed or written here (`<redacted>`).
Total spend of every run about **$0.009** (list price; subscription, nothing billed): `cost` runs 0.0015 + 0.0010, `live` 0.0061,
`probe`/`config` 0.

### a. Cost: `total_cost_usd` is a RUNNING session total (this corrects section 10)

Run 2, one streaming session, three turns, then `resume: <sessionId>` with a string prompt:

| result | `total_cost_usd` | `usage` cache write / read (tokens) | `duration_ms` / `duration_api_ms` |
| --- | --- | --- | --- |
| turn 0 | 0.000371 | 1709 / 2643 | 0.8 s / 0.8 s |
| turn 1 | 0.000829 | 1517 / 2903 | 2.0 s / 4.2 s |
| turn 2 | 0.000900 | 121 / 4367 | 0.7 s / 4.8 s |
| resumed turn (new CLI process) | 0.000984 | 187 / 4435 | 0.7 s / 5.5 s |

(The first run showed the same: 0.000311, 0.001199, 0.001413, then 0.001484 after resume.)

- **Cumulative, never per turn.** The values only grow. Proof from run 1: the `usage.cache_creation_input_tokens` of the
  three turns (924 + 4425 + 878 = 6227) equals the cumulative `modelUsage[model].cacheCreationInputTokens` of the last result and of
  the transcript's `cost-state`, and `cost-state.totalCostUSD` equals the last result's `total_cost_usd` to the last digit.
- Per result, **cumulative**: `total_cost_usd`, `duration_api_ms`, all of `modelUsage.<model>` (`inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, `thinkingTokens`, `webSearchRequests`, `costUSD`; also `contextWindow`,
  `maxOutputTokens`, `canonicalModel`, `provider: "firstParty"`, `costBasis: "list"`). **Per turn**: `usage.*` tokens,
  `duration_ms`, `num_turns`, `ttft_ms`. (`modelUsage` is keyed by model id, so a mid-session `setModel` adds a key, see d.)
- **Resume continues, it does not restart.** The resumed process kept `session_id` (same id, no fork) and its first result
  was 0.000900 + 0.000084 = 0.000984: the CLI restores the totals from the transcript's `cost-state`. So the first result after a
  resume is NOT a "turn cost"; the turn cost is `result.total_cost_usd - previousTotal`.
- Transcript `cost-state` record (no `entrypoint`/`version`; written when the CLI process ends, so **one per process run, not per
  turn**: 1 record after the 3-turn run, a 2nd appended after the resume):
  `{type:"cost-state", sessionId, totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration,
  totalLinesAdded, totalLinesRemoved, totalDuration, startTime (ms epoch), modelUsage:{<model>:{inputTokens, outputTokens,
  thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD}}, hasUnknownModelCost}`.
  The last one in a transcript is the session's lifetime cost, usable to seed a baseline or to price a session never seen live.
- The earlier numbers in section 7 that were "summed per worker" (interrupt run) over-count: those results were running totals.

### b. `rate_limit_event`

- Arrives on the generator as `{ type:'rate_limit_event', rate_limit_info, uuid, session_id }`, **once per CLI process start**,
  about 0.5 s after `system/init` (turn 0 only; turns 1 and 2 of the same session had none; the resume process got its own).
  Seen in every real run; nothing is emitted while idle. Treat it as "latest known", not a stream.
- Shape observed (subscription login, `status: "allowed"`):

```json
{ "status":"allowed", "resetsAt":1792448400, "rateLimitType":"five_hour",
  "overageStatus":"allowed", "overageResetsAt":1793491200, "isUsingOverage":false,
  "unifiedWindows":{ "five_hour":{"utilization":0.45,"resetsAt":1792448400},
                     "seven_day":{"utilization":0.18,"resetsAt":1792872000} } }
```

- **Utilization is 0..1** (0.45 = 45%) and **`resetsAt` is epoch SECONDS** (1792448400 = 2026-10-19T22:20:00Z; `overageResetsAt`
  likewise). No ms, no ISO. The top-level `utilization` of the typed `SDKRateLimitInfo` was absent; the numbers live in
  `unifiedWindows` (runtime-only, **not in the `.d.ts`**: cast it). Only `five_hour` and `seven_day` windows were present, no
  `seven_day_opus`/`sonnet`. The top-level `rateLimitType` names the window that is the binding one (`five_hour` here).
  `allowed_warning`/`rejected` were not provoked.
- Compare the usage method (c): there utilization is **0..100** and `resets_at` is an **ISO 8601 string** with microseconds.
  Same numbers (45 and 0.45), different scales: normalise at the boundary.

### c. No-prompt usage probe

Options: `prompt: <InputQueue never pushed to>`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `tools: []`,
`allowedTools: []`, `persistSession: false`, `model: 'haiku'`, `env` with `CLAUDE_CODE_ENTRYPOINT=claude-office-probe`
(otherwise the `buildRunnerEnv` recipe). `tools: []` is the SDK's way to disable all built-ins; `persistSession` exists
(`false` = nothing saved).

- **It works with no message ever sent.** The generator yields nothing (0 messages). `await q.initializationResult()` resolved
  in **450 ms** (cold, includes the CLI start; 150 ms in a later run). `await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors:true })`
  took **535-593 ms**, so about 1.6 s from `query()` to rate limits. A second `usage` call returned in 1 ms (cached somewhere),
  so a probe that stays open must re-`reinitialize`/re-spawn for fresh numbers; a throwaway probe per refresh is the safe pattern.
- `usage` top-level keys: `session, subscription_type, rate_limits_available, rate_limits, behaviors`.
  - `session`: `{ total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: <ms alive>, total_lines_added: 0,
    total_lines_removed: 0, model_usage: {} }` (**no tokens used, cost 0**).
  - `subscription_type: "max"` (lower-case; `null` for API key/3P), `rate_limits_available: true`, `behaviors: null` (as documented for
    `skipBehaviors`).
  - `rate_limits` is an object whose documented windows are `five_hour` and `seven_day` (also `seven_day_opus`,
    `seven_day_sonnet`, `seven_day_oauth_apps`, all `null` here). Each window:
    `{ utilization: 45, resets_at: "2026-10-19T22:20:00.423667+00:00", limit_dollars: null, used_dollars: null,
    remaining_dollars: null, locked_reason: null }`. `utilization` is **percent 0-100 (integer)**, `resets_at` **ISO 8601**.
  - It also carries about 25 further keys at runtime: codename keys that were `null` (one non-null, a dollar-capped window
    with `limit_dollars`/`used_dollars`: ignore), `extra_usage` (`is_enabled, monthly_limit, used_credits, currency,
    decimal_places, ...`: account money, do not display), `limits[]` (`{ kind: 'session'|'weekly_all'|'weekly_scoped', group,
    percent, severity: 'normal', resets_at, scope, is_active }`: a clean list of the same windows plus scoped ones), `spend`,
    `seven_day_breakdown` (`{ as_of, window_started_at, rows:[{key, display_name, percent}] }`, per product share of the week),
    `model_scoped[]` (`{ display_name, utilization, resets_at }`), `weekly_scoped_shares[]`, `member_dashboard_available`.
    Rely only on `five_hour` and `seven_day`; read the rest defensively (the method name says it can change).
- `initializationResult()` top-level keys: `commands, agents, output_style, available_output_styles, user_output_styles_dir,
  models, account, pid, claude_code_version, current_permission_mode, feedback_mode, analytics_disabled,
  remote_control_*, ide_rc_auto_enable_gate, fast_mode_state, fast_mode_disabled_reason, session_state, capabilities`.
  `claude_code_version: "2.1.302"`, `pid` is the CLI's pid (matches the sessions file name).
- **Subscription type field**: `account.subscriptionType` (display text, here `"Claude Max"`) in `initializationResult`, and
  `subscription_type` (`"max"`) in `usage`. Other `account` keys: `email` and `organization` (`<redacted>`, never keep or log
  them), `tokenSource`, `apiProvider: "firstParty"`, `apiKeySource`.
- **Models** (`initializationResult().models`, 14 rows; `ModelInfo` keys `value, resolvedModel, displayName, description,
  supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode?, supportsAutoMode, supportsThinkingOff`):

| `value` | `resolvedModel` | name | `supportedEffortLevels` |
| --- | --- | --- | --- |
| `default` | claude-sonnet-5-5 | Default (recommended) | low, medium, high, xhigh, max |
| `opus` | claude-opus-5-5 | Opus 5.5 (fast mode) | low, medium, high, xhigh, max |
| `fable` | claude-fable-5-1 | Fable 5.1 | low, medium, high, xhigh, max |
| `sonnet` | claude-sonnet-5-5 | Sonnet 5.5 | low, medium, high, xhigh, max |
| `haiku` | claude-haiku-5-5 | Haiku 5.5 | low, medium, high, xhigh, max |
| `claude-haiku-4-5-20251001` | same | Haiku 4.5 | none (`supportsEffort` absent) |
| `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5` | same | Sonnet 5, Opus 5, Fable 5 | low, medium, high, xhigh, max |
| `claude-opus-4-8`, `claude-opus-4-7` | same | Opus 4.8 (fast), Opus 4.7 | low, medium, high, xhigh, max |
| `claude-opus-4-6`, `claude-sonnet-4-6` | same | Opus 4.6, Sonnet 4.6 | low, medium, high, **max (no xhigh)** |

  The list depends on the account and on the CLI version, so read it at runtime; do not hard-code effort lists.
- **Sessions file**: a `~/.claude/sessions/<pid>.json` appears about **0.3 s after spawn** (no `status` yet), gets
  `status: "idle"` at 0.45 s, has `entrypoint: "claude-office-probe"` and `kind: "interactive"`, and is **removed by the time
  `close()` returns** (about 20 ms after the call). So a probe **is visible to the existing watcher** for its lifetime
  (about 1-3 s) as an idle worker with entrypoint `claude-office-probe`; the watcher must ignore that entrypoint.
- **No transcript**: with `persistSession: false` the project's transcript folder gained no file (before 0, after 0 in the scratch
  project dir). **No tokens used**: `session.total_cost_usd` 0, `model_usage` empty, no `result`/`assistant` message ever emitted.
- `q.close()` ended the generator cleanly in 200-700 ms with no error; the pending `for await` just finished.

### d. Live controls on a running streaming session (`live` scenario, Haiku 5.5, then Haiku 4.5)

All three work, between and during turns, and the SDK resolves each promise quickly. **A change made during a turn never
alters that turn; it is applied from the next turn.**

| call | between turns | during a turn (right after `system/init`) | visible effect |
| --- | --- | --- | --- |
| `applyFlagSettings({ effortLevel:'high' })` | resolved 5 ms | `{effortLevel:'medium'}` resolved 10 ms | next turn's assistant records: `effort`/`perTurnEffort` = `high` / `medium`; request `output_config.effort` the same |
| `setPermissionMode('acceptEdits')` | resolved ~0 ms | resolved 10 ms | emits `system/status {status:null, permissionMode:'acceptEdits'}` at once; next `system/init.permissionMode` = `acceptEdits` |
| `setModel('claude-haiku-4-5-20251001')` | resolved **580 ms** (slowest; validates the model) | `setModel('haiku')` resolved 10 ms | next `system/init.model` and every following `assistant.message.model` follow; result `modelUsage` gets a second key |

- Turn sequence observed (init model / permission mode): t0 `claude-haiku-5-5` / `default` (started with `Options.effort:'low'`);
  after effort+mode change, t1 `claude-haiku-5-5` / `acceptEdits`; after `setModel(4.5)`, t2 `claude-haiku-4-5-20251001`
  (the during-turn `setModel('haiku')` etc. did not change t2); t3 back on `claude-haiku-5-5`, effort `medium`.
- The during-turn calls resolved (10 ms) **before** the turn's `result`; no error, no queueing behind the turn.
- Model change mid-session loses nothing in cost accounting but **breaks the prompt cache** (t2 on Haiku 4.5 wrote 0 cache and
  billed 4050 input tokens + 203 output = $0.0051 vs $0.0004 for the Haiku 5.5 turns): a model switch is not free.
- Transcript `assistant` records carry top-level `effort` (string) and `perTurnEffort` (string, `null` on a model without effort,
  e.g. Haiku 4.5; there `effort` is absent), `requestedModel`, `message.model`.
- **Methods on the `Query` object** (enumerated at runtime, 0.3.302; the typed ones in `sdk.d.ts` are `interrupt, setPermissionMode, setModel,
  setMaxThinkingTokens (deprecated), applyFlagSettings, updateSettings, initializationResult, reinitialize, supportedCommands,
  supportedModels, supportedAgents, mcpServerStatus, getContextUsage, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET,
  readFile, reloadPlugins, setMcpPermissionModeOverride`; also present at runtime: `setMcpServers, toggleMcpServer,
  reconnectMcpServer, rewindFiles, stopTask, close, streamInput`, and untested internals: `getSettings, getStatus, getPlan,
  askSideQuestion, setCwd, cancelAsyncMessage, renameSession, generateSessionTitle, exportConversation, listPermissionRules,
  reloadSkills, reloadOutputStyles, accountInfo, backgroundTasks, enableRemoteControl`. `setModel`/`setPermissionMode`/
  `applyFlagSettings` need streaming input (a string prompt has no control channel).

### e. `Options.effort` at start

`query({ options: { effort: 'low' } })` works: the first turn's transcript `assistant` records have `effort: "low"` and
`perTurnEffort: "low"`, and the API request has `output_config.effort: "low"` (transcript `api-request` records,
`params.output_config.effort`). The **`system/init` message does NOT carry the effort level** (no `effort` key); it only has a boolean
`per_turn_effort_active` (true on Haiku 5.5, false on Haiku 4.5) and `fast_mode_state: "off"`. To show the live effort, remember
what you set (or read the transcript afterwards; `q.getSettings()` exists at runtime but was not tried); the init message cannot tell you. The typed `effort?` on the init
type is only populated by Remote Control bridge frames.

### f. `getContextUsage`

Signature is an options object, not a string: `await q.getContextUsage({ detail: 'summary' })` (default `'full'`). It needs
streaming input and returned in **7-8 ms** (summary answers locally from the last response's usage). Result keys:
`categories, totalTokens, maxTokens, rawMaxTokens, autocompactSource, percentage, gridRows, model, memoryFiles, mcpTools, agents,
autoCompactThreshold, isAutoCompactEnabled, messageBreakdown, apiUsage`. Observed after turn 0:
`totalTokens: 3247`, `maxTokens: 1000000`, `rawMaxTokens: 1000000`, `percentage: 0` (a number, percent-ish; 3247/1M rounds to 0),
`model: "claude-haiku-5-5"`, `autoCompactThreshold: 967000`, `isAutoCompactEnabled: true`,
`apiUsage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` (last response),
`messageBreakdown: {toolCallTokens, toolResultTokens, attachmentTokens, assistantMessageTokens, userMessageTokens, ...,
toolCallsByType[], attachmentsByType[]}`, and `categories: [{name, tokens, color, kind:'used'|'free'|'buffer'|'deferred', isDeferred?}]`
(here "MCP tools" 2616, "MCP server instructions" 631, "Autocompact buffer" 33000, "Free space" 963753).
**The JSON is big (26 KB) because of `gridRows`** (the picture grid): drop it, keep `totalTokens`, `maxTokens`, `percentage`,
`categories`. Use `totalTokens/maxTokens` for a context meter; do not parse `percentage` without checking its scale.

### g. `.claude.json` location

- No `CLAUDE_CONFIG_DIR`: the CLI uses **`~/.claude.json`** (`$HOME`, not inside `~/.claude/`; `~/.claude/.claude.json` does not exist).
  Top-level key names on this machine (values never read): `numStartups, installMethod, autoUpdates, firstStartTime, machineID,
  userID, hasCompletedOnboarding, projects, oauthAccount, mcpServers, skillUsage, tipsHistory, cachedGrowthBookFeatures,
  cachedExperimentFeatures, cachedUsageUtilization, additionalModelOptionsCache, modelAccessCache, cachedArtifactRoster,
  githubRepoPaths, agentLastUsed, pluginUsage, ...` (78 keys, mostly feature-flag and UI caches). `oauthAccount` holds
  account info: never read or log it. `cachedUsageUtilization` suggests the CLI caches the usage numbers there (untested,
  shape not inspected).
- `CLAUDE_CONFIG_DIR=<dir>` set: the CLI uses **`<dir>/.claude.json`** instead (live test with an empty `<dir>`: it created
  `<dir>/.claude.json` (852 bytes; keys `firstStartTime, firstStartVersion, machineID, userID, migrationVersion, ...`),
  `<dir>/backups/.claude.json.backup.<ms>` and `<dir>/sessions/`; `~/.claude.json` was untouched). The binary's strings
  confirm the code path ("Watching ~/.claude.json ... through the storage interface").
- Consequences of a custom `CLAUDE_CONFIG_DIR`: everything moves with it. It has **no login** (`account: { tokenSource:'none',
  apiProvider:'firstParty' }`, so no plan limits), its **sessions files go to `<dir>/sessions/`** (not seen by a watcher on
  `~/.claude/sessions`), and transcripts to `<dir>/projects/`. If the user has `CLAUDE_CONFIG_DIR` set, the extension's
  watcher, probe and `.claude.json` readers must all resolve it the same way: `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` for the
  folder and `process.env.CLAUDE_CONFIG_DIR ? join(dir, '.claude.json') : join(home, '.claude.json')` for the file.

### Implications for the plan

1. **Cost tracker takes deltas.** `total_cost_usd` and `modelUsage` are running session totals (and survive resume); `usage`
   tokens and `duration_ms` are per turn. Keep `lastTotal` per `sessionId`; turn cost = `total - lastTotal`. On a resume with no
   history, seed `lastTotal` from the transcript's last `cost-state.totalCostUSD` (or accept that the first delta is the lifetime
   total and drop it). Office-wide spend = sum over sessions of their latest total, so duplicates/re-emits cannot double count.
   Fix the section 7 style "sum per worker" in any code that follows it.
2. **Usage probe is cheap and silent**: `persistSession:false`, no prompt, no tokens, no transcript; about 1.6 s end to end; a
   `<pid>.json` shows for 1-3 s with entrypoint `claude-office-probe` (filter it in the watcher). Do not keep a probe open and
   re-ask (the second `usage` call is a 1 ms cache hit); spawn a new one per refresh, at most every few minutes.
   Normalise the scales: `usage()` is percent 0-100 with ISO `resets_at`; `rate_limit_event` is 0-1 with epoch-seconds `resetsAt`.
3. **`rate_limit_event` is a free usage tick** once per process start (turn 0 of each runner): update the usage meter from it when a
   worker starts or resumes, use the probe for a fresh number when idle. Read `unifiedWindows` untyped.
4. **Live controls need no restart**: `setModel`, `applyFlagSettings({effortLevel})`, `setPermissionMode` all apply from the next
   turn, even if called mid-turn; the UI should show "applies next turn" if a turn is running. A model switch busts the cache
   (cost bump); Haiku 4.5 has no effort. Read the `models` list from `initializationResult()` (also supplies per-model effort
   lists) instead of hard-coding it. (Per-turn `duration_api_ms` is also cumulative, like cost.)
5. **Show effort from your own state**: `system/init` has no `effort` (only `per_turn_effort_active`); the transcript's
   `effort`/`perTurnEffort` is the post-hoc truth.
6. **Context meter**: `getContextUsage({detail:'summary'})` is a 7 ms local call; strip `gridRows` before sending to the webview.
7. **Config dir**: resolve `CLAUDE_CONFIG_DIR` everywhere (sessions dir, projects dir, `.claude.json`); default is `~/.claude` and
   `~/.claude.json`. A worker/probe launched with a different dir loses the login.
8. Surprise: `tools: []` + `settingSources: []` still loaded one MCP server and about 2.6k tokens of MCP tools after turn 0 (the
   account's claude.ai connectors). Add `strictMcpConfig: true, mcpServers: {}` to any cheap or utility session.

## 15. Catalog spike (skills, commands, MCP servers, agents, handbook sources)

Task 5.2 of the "Office tools" plan. Code: `dev/catalog-spike.ts`, run with `node dev/catalog-spike.ts [cwd]` (default cwd is a scratch
project under `$SPIKE_ROOT/catalog-5.2/`; `SPIKE_PLUGIN=<dir>` also loads one local plugin; `CLAUDE_BIN` overrides the binary). It
starts a no-prompt query like the usage probe (`persistSession:false`, entrypoint `claude-office-probe`, model `haiku`) but with
`settingSources: ['user','project','local']` and **no** `strictMcpConfig`/`mcpServers`, so the user's real servers report. It prints
shapes only: string values are shown just for server, skill, command and agent names, status, scope, source and transport type;
server configs (command, args, env, url, headers) are reduced to key names plus `type`. Observed 2026-10-20, SDK 0.3.302, CLI
2.1.302, Linux, subscription login. Runs: scratch cwd, the project cwd, a scratch fixture project (invented project skill,
command, agent and `.mcp.json`), and the fixture plus an invented local plugin. **Cost: $0** (no prompt, no tokens), each run about
1.5 s; no process was left behind (checked by environment tag after the last run). No MCP tool was called.

### a. SDK methods (all on `Query`)

```ts
// initializationResult(): keys only. Its `commands` and `agents` are the same lists as supportedCommands()/supportedAgents().
// There is NO skills, plugins or mcp_servers key.
type Init = { commands: SlashCommand[]; agents: AgentInfo[]; output_style: string; available_output_styles: string[];
  user_output_styles_dir: string; models: ModelInfo[]; account: {...}; pid: number; claude_code_version: string;
  current_permission_mode: string; session_state: string; capabilities: ...; /* feedback/remote-control/fast-mode flags */ };

// supportedCommands(): skills AND slash commands in one list. There is no supportedSkills(); a `reloadSkills()` and a
// `getSkillsDialog()` exist on the object but return the same SlashCommand rows (reloadSkills) or dialog data (not inspected).
type SlashCommand = { name: string;            // no leading slash; plugin items are "<plugin>:<name>"
  description: string; argumentHint: string;   // "" when none (always present)
  builtin?: boolean;                           // true = shipped with Claude Code; ABSENT (not false) for user/project/plugin/synced items
  aliases?: string[] };                        // e.g. ["anthropic-skills:built-in-browser"]

// supportedAgents()
type AgentInfo = { name: string; description: string; model?: string };   // model: alias | "inherit" | absent

// mcpServerStatus()
type McpServerStatus = { name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';  // seen: connected, pending, failed
  scope?: string; source?: string;             // seen: user | project | claudeai (equal in every row seen)
  config?: { type?: 'stdio' | 'sse' | 'http' | 'sdk' | 'claudeai-proxy'; /* + command,args,env | url,headers | id */ };  // SECRET BEARING
  serverInfo?: { name: string; version: string };  // only when connected
  error?: string;                              // only when failed (may contain paths or command text: do not forward)
  tools?: { name: string; description?: string; annotations?: {...}; _meta?: {...} }[] };  // only when connected; 207 rows for one server
```

Redacted examples (invented names):

```
mcpServerStatus  name="srv-a" status="connected" serverInfo={name,version} config={keys:[type,command,args] type:"stdio"} scope="user" source="user" tools=array(207)
                 name="srv-b" status="failed" error=string(17) config={keys:[type,command,args] type:"stdio"} scope="project" source="project"
                 name="claude.ai X" status="connected" config={keys:[type,url,id] type:"claudeai-proxy"} scope="claudeai" source="claudeai" tools=array(8)
supportedCommands name="orchestrate" description=string(556) argumentHint=string(0)                 (user skill, no builtin key)
                 name="built-in-browser" aliases=["anthropic-skills:built-in-browser"]               (synced skill)
                 name="dataviz" builtin=true                                                         (bundled skill: still a "skill" to the user)
                 name="plug:plug-skill"                                                              (plugin skill or command)
supportedAgents  name="Explore" description=string(605) model="inherit"
```

Timing (identical in every cwd):

| call | when ready | notes |
| --- | --- | --- |
| `initializationResult()` | 0.40-0.45 s after `query()` | the first await; commands and agents are already complete in it |
| `supportedCommands()`, `supportedAgents()` | 0-1 ms after init | cached; same lists as in init. Filesystem scan is done by then (project items appeared at once) |
| `mcpServerStatus()` | 0-2 ms after init, **but incomplete** | first read: every server `pending`, and **the list itself grows**: user servers appear first, the `claudeai` connectors a moment later (0.5 s), and a failing project server shows `failed` at once. All settled `connected` after about 1.05 s |

Status values seen: `connected`, `pending`, `failed`. `needs-auth` and `disabled` are typed but did not occur (no OAuth server here;
`toggleMcpServer`/`mcpAuthenticate`/`reconnectMcpServer` exist on the Query for later).

### b. Scope, transport, plugin marking

- **MCP scope/transport**: `scope` and `source` are separate fields but were equal in every row (`user`, `project`, `claudeai`). The
  type says `source` can also be `plugin`, `sdk`, `dynamic`, `managed`, `enterprise`, `agent`, and that trust should key on `source`. Transport
  is `config.type` (`stdio`, `claudeai-proxy`; typed `sse`, `http`, `sdk`). **`config.type` can be absent for stdio** (typed optional): treat missing
  as stdio when `command` is present. `claudeai-proxy` rows are the account's claude.ai connectors (also listed in `~/.claude.json`
  `claudeAiMcpEverConnected: string[]`).
- **Skills/commands**: no scope or source field at all. A project skill (`.claude/skills/x/SKILL.md`), a project command
  (`.claude/commands/x.md`) and a user skill are indistinguishable in the list. Only `builtin` (and a plugin's `<plugin>:` name prefix) is a marker.
  Project items showed up in the list when cwd held them and were absent from the others, so the list is cwd-specific.
- **Plugin items**: skills, commands and agents of a plugin are named `<plugin-name>:<item>` (`demo-plug:plug-skill`, `demo-plug:plug-cmd`,
  agent `demo-plug:plug-agent`). The prefix is the marker, but `aliases` can also carry a `prefix:name` form for synced
  claude.ai skills (name `built-in-browser`, alias `anthropic-skills:built-in-browser`), and one synced skill's own *name* carried
  the prefix. So: a colon in `name` or an alias with a colon means "from a plugin or synced bundle", not a certain plugin.
- **Plugin MCP servers**: a plugin's own `.mcp.json` server did **not** show up in `mcpServerStatus()` for the local `plugins:[{type:'local'}]` test
  (neither connected nor failed within 20 s). Do not promise plugin servers on the phone from the SDK alone; fall back to reading them from disk.
- **Duplicates**: no duplicate names in any run. Rows can share a name by design (type docs: a `builtin` row wins over an unmarked row of the same name), so key by `name` plus `builtin`
  and render one light per MCP `name` (a user and a project server of the same name would both be listed; the CLI resolves by scope precedence).

What the lists contained here (names are the user's, counts are what matters): 73 commands (58 `builtin`, 15 not: 2 user skills, 13 synced
claude.ai skills incl. one `anthropic-skills:` prefixed, and nothing project-scoped), 6 agents (`claude`, `claude-code-guide`, `Explore`,
`general-purpose`, `Plan`, `statusline-setup`; `model` present on 4), 2 MCP servers (`rea` user/stdio,
`claude.ai Claude Docs` claudeai/claudeai-proxy). Builtin entries include real slash commands (`clear`, `compact`, `model`) and
bundled skills (`dataviz`, `update-config`, `claude-api`), so "builtin" does not mean "not a skill". The fixture added 2 commands
(skill and command), 1 agent and 1 failed `project` server; the plugin added 2 commands, 1 agent and no server.

### c. Filesystem layout (names and key names only)

```
~/.claude/
  CLAUDE.md                          user instructions (contents never read here)
  settings.json                      keys here: env, permissions{defaultMode}, model, modelSettings, theme
  skills/<skill>/SKILL.md            user skills; frontmatter keys seen: name, description, metadata  (+ references/, scripts/, assets/)
  skills/synced/<org>_<id>/<skill>/SKILL.md   claude.ai-synced skills; frontmatter: name, description, license, compatibility
  commands/*.md  agents/*.md         NOT PRESENT on this machine (standard locations; user-level commands and agents)
  plugins/known_marketplaces.json    { "<marketplace>": { source:object, installLocation:string, lastUpdated:string } }
  plugins/marketplaces/<mkt>/.claude-plugin/marketplace.json   { $schema, name, description, owner, renames, plugins: [{name, description, author, category, source, homepage}] }
  plugins/marketplaces/<mkt>/plugins/<plugin>/                 a catalogue copy, NOT an install (40 plugin folders here)
  plugins/store/*.json, plugins/synced/<org>_<id>/             builtin-plugin store ({open:boolean}) and the sync bucket marker files
  plugins/installed_plugins.json     ABSENT here (nothing installed). Standard shape: { version, plugins: { "<plugin>@<mkt>": [{ scope, installPath, version, installedAt, lastUpdated }] } }  (from memory; unverified)
  plugins/cache/<mkt>/<plugin>/<version>/   ABSENT here; where an installed plugin's files live (unverified)
  projects/<cwd with / and . turned into ->/memory/MEMORY.md   index (one "- [Title](file.md) - hook" line each) + one <topic>.md per memory
~/.claude.json                       64+ top-level keys; relevant: mcpServers, projects, skillUsage, pluginUsage, agentLastUsed, claudeAiMcpEverConnected
<project>/CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md          project handbook files (also each parent dir up to the root)
<project>/.claude/skills/<s>/SKILL.md, commands/*.md, agents/*.md, settings.json, settings.local.json
<project>/.mcp.json                  { mcpServers: { "<name>": { type?, command?, args?, env? | url?, headers? } } }
```

Inside a plugin (`<root>/` is its folder; checked on 40 catalogue plugins): `.claude-plugin/plugin.json` (`name, description, author`; also
`version` for versioned ones), `skills/<s>/SKILL.md`, `commands/*.md`, `agents/*.md`, `hooks/`, `.mcp.json`, `README.md`, `LICENSE`, plus
scripts and assets. 14 of them ship a `.mcp.json`; two shapes: `{mcpServers:{<name>:{type,url}}}` and `{mcpServers:{<name>:{command,args}}}`.

Frontmatter keys seen (counts across the catalogue plugins):
- **Skill**: `name`, `description` (always), `allowed-tools`, `disallowed-tools`, `tools`, `user-invocable`, `argument-hint`, `version`, `license`, `disable-model-invocation`, `compatibility`, `metadata`.
- **Command**: `description` (always), `argument-hint`, `allowed-tools`, `arguments`, `disable-model-invocation`, `hide-from-slash-command-tool`. No `name`: the file name is the command.
- **Agent**: `name`, `description` (always), `model` (28/36), `tools` (27/36; comma string), `color`, `effort`, `maxTurns`, `initialPrompt`.
  Fixture proved `name`, `description`, `model` reach `supportedAgents()`; `tools` does not.

`~/.claude.json` shapes:

```ts
skillUsage: Record<string /* skill name, no plugin prefix seen */, { usageCount: number; lastUsedAt: number /* epoch ms, 13 digits */ }>
pluginUsage: Record<string /* "<plugin>@<marketplace>", e.g. "x@builtin" */, { usageCount; lastUsedAt; lastUsedNumStartups: number }>
agentLastUsed: Record<string, number /* epoch ms */>            // only "bg" here: not a per-agent-type usage count
claudeAiMcpEverConnected: string[]                               // claude.ai connector names
mcpServers: Record<string, { /* keys: command, args (+ type, env, url, headers) */ }>   // user scope; read names + type only
projects: Record<string /* absolute cwd */, { allowedTools: string[]; mcpContextUris: string[]; mcpServers: Record<string, {...}>;
  enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[]; hasTrustDialogAccepted: boolean; last*: cost/token/session stats }>
```

`skillUsage` here had 9 entries, mixing bundled skills (`init`, `claude-api`, `update-config`), a user skill and names that are no longer installed (invented-looking project skills
from other folders), so **a usage row can exist for a name that is not in `supportedCommands()`, and a listed skill can have no row (count 0)**. Only
skills invoked through the Skill tool/slash command since tracking began are counted; commands (plain `.md`) are not tracked
separately as far as seen. Local-scope MCP servers are `projects[cwd].mcpServers` (empty on every project here).

Permissions: `settings.json` / `settings.local.json` `permissions` is `{ allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: string; additionalDirectories?: string[] }`.
Here: user file has only `defaultMode`; the project's `settings.local.json` has `allow` with 4 rules (counts only, bodies not copied). Rule form is
`Tool` or `Tool(specifier)`, e.g. the invented `Bash(npm run build:*)`. Managed policy would sit in `/etc/claude-code/managed-settings.json` (absent here).

### d. Which source for which panel

| Panel | Use | Why |
| --- | --- | --- |
| Training library (skills and commands) | SDK `supportedCommands()` for the **set** (it is exactly what the user can type, cwd-aware, covers builtin/plugin/synced) + filesystem **only to classify the source** + `skillUsage` for counts | The SDK row has no scope. Scan `~/.claude/skills`, `~/.claude/skills/synced`, `<cwd>/.claude/skills`, `<cwd>/.claude/commands` (and `~/.claude/commands`) for names to tag user / project / synced / command; `builtin` -> bundled; a `plugin:` prefix -> plugin; else unknown. `skillUsage[name].usageCount` joins on bare `name` (strip `plugin:`). |
| Phone (one light per MCP server) | SDK `mcpServerStatus()` for status, polled; names, scope, transport from the same rows | Only the SDK knows live state. Config files give names/scope/transport but never connected/failed. Use config-only (task 5.5) as the offline/first-paint fallback. |
| Office handbook | Filesystem only | No SDK call returns CLAUDE.md, memory or rules. (`getContextUsage` lists memory files with token counts, but only inside a live session; not tested here.) |
| Temp agency (subagent types) | SDK `supportedAgents()` for names/description/model; filesystem frontmatter (`tools`, `color`, `effort`) only if the panel needs them | The SDK list includes built-in agents (`Explore`, `Plan`...) and plugin agents that no folder scan finds. `agentLastUsed` is not usable for counts. |

The probe is the only way to get these without a live session: it costs nothing, takes about 1.5 s, and one probe gives
commands, agents and settled MCP status together. Run it once per cwd, cache, refresh on demand (not on a timer) and after a
`reloadSkills`/file change. Do not reuse the usage probe's `strictMcpConfig` options, which hide every server.

### e. Pitfalls

1. **MCP list is incomplete at first read.** All `pending`, and the claude.ai connectors are not in the array yet. Poll every
   ~500 ms until no row is `pending` (about 1 s here), with a cap (20 s) and keep unknowns `pending` on timeout. A slow stdio server can stay `pending` much longer.
2. **Never forward `config` or `error`.** `config` carries `command/args/env/url/headers` (secrets); `error` can carry command text. Map to `{ name, status, scope, transport }` in the host.
   `tools` is large (207 rows for one server): count it and drop it.
3. **`builtin` is absent, not `false`**, for non-builtin rows. Test `c.builtin === true`.
4. **Scope is not on commands or skills.** Do not guess it from the name; classify by path.
5. **Colon names.** Plugin items are `plugin:name`; claude.ai synced skills can have both a bare name and a `bundle:name` alias. Normalise before joining to `skillUsage`.
6. **`skillUsage` is sparse and can name missing skills.** A missing key means count 0. Counts are per-user, not per-project.
7. **Project `.mcp.json` servers started without any approval prompt** in the SDK probe (a failing `/bin/false` server showed `failed`
   at once under `project`), unlike the interactive CLI. The `enabledMcpjsonServers` / `disabledMcpjsonServers` arrays in `~/.claude.json` `projects[cwd]` were empty here, so their precedence is untested.
8. **Plugin MCP servers did not report** for a local plugin; installed plugins (cache layout above) were not available to test.
9. **Probe side effects**: it starts the user's stdio MCP servers for about a second, so tag it (`claude-office-probe`) and keep it off a timer.
10. `__remote-workflow`, `workflow-launch-exec` and similar `builtin` rows are internal; filter names starting `__` from the library.
11. `~/.claude.json` is ~100 KB here but rewritten often by running sessions; read with a size cap (32 MB), tolerate a torn read (retry once), never log `oauthAccount`.

### f. Recommendations for the host tasks

**5.4 `catalog.ts` + `handbook.ts`**
- `catalog.ts` exposes `readCatalog(cwd)` that runs one probe (reuse `usageProbe`'s query plumbing; options as in `dev/catalog-spike.ts`; model `haiku`;
  `settingSources` user, project, local; no strict MCP) and returns `{ skills, commands, agents, mcp }` already redacted. Shape suggestions:
  `Skill { name; description(<=200 chars); argumentHint?; kind: 'builtin'|'user'|'project'|'synced'|'plugin'|'command'; plugin?; uses: number; lastUsedAt?: number }`,
  `Agent { name; description; model?; plugin? }`.
- Classification is done by listing directory names only (`readdir` for `SKILL.md` folders and `*.md` commands, cwd-limited, no content reads except frontmatter `name`/`description` if the SDK description is missing).
- Join usage from `~/.claude.json` `skillUsage` through a pure parser (`parseSkillUsage(raw: unknown)` tolerant of non-object, non-number counts; ms timestamps).
  Resolve `CLAUDE_CONFIG_DIR` as in section 14.
- `handbook.ts` is pure filesystem: walk from `cwd` to the root collecting `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, plus `~/.claude/CLAUDE.md`;
  list memory from `<configDir>/projects/<mangled cwd>/memory/` (index lines of `MEMORY.md`, frontmatter `name`/`description` of each file; the folder name is the cwd with `/` and `.` replaced by `-`);
  rules as **counts and per-file lists** from the three `settings*.json` (`permissions.allow|deny|ask` lengths, `defaultMode`). Send file *paths and sizes* by default; content only on an explicit open action, and never rule bodies in logs.
- Both need injectable `readdir`/`readFile` and a size cap so tests can use temp dirs. Treat every missing file as empty, not an error.

**5.5 `mcpConfig.ts` (names, scope, transport, live status)**
- Offline map from files, names and kinds only: user `~/.claude.json` `mcpServers`, local `projects[cwd].mcpServers`, project `<cwd>/.mcp.json` (and parents), plugin `.mcp.json` from installed plugins (best effort), managed (absent). Output `{ name; scope: 'user'|'project'|'local'|'plugin'|'managed'|'claudeai'; transport: 'stdio'|'http'|'sse'|'claudeai-proxy'|'sdk'; status: 'unknown' }`. Missing `type` with a `command` is `stdio`; with a `url` and no type, treat as `http`.
- Live overlay from the probe's `mcpServerStatus()` by `name` (poll until no `pending`, cap 20 s): set `status` to `connected | pending | failed | needs-auth | disabled`; add rows only the SDK knows (the `claudeai` connectors).
- When a name exists in both, the SDK row wins for scope/transport; on a name collision across scopes keep both rows and label by scope.
- Whitelist fields; do not copy `config`/`error`/`tools`. A `failed` light may show a generic "failed to start" line.
- Phone light mapping: `connected` green, `pending` amber (blinking), `failed` red, `needs-auth` yellow with a lock, `disabled` grey, `unknown` (offline file only) dim.
