# Claude transcript fixtures

Synthetic `~/.claude` layout for testing the extension's transcript parser. The shapes
mirror real Claude Code 2.1.x files; every value (paths, prompts, commands, ids) is invented.

```
claude/
  projects/
    -home-user-demo-project/           <- encoded cwd /home/user/demo-project
      aaaa000N-0000-4000-8000-00000000000N.jsonl
      aaaa0005-0000-4000-8000-000000000005/subagents/agent-<id>.jsonl + .meta.json
    C--Users-alice-work-proj/          <- encoded Windows cwd
  sessions/
    1001.json  1002.json  1003.json    <- live status files
```

The `pid`s in `sessions/` are fake. No process with those ids is alive, so a consumer must treat them as stale.

## Files and expected parser state

Titles are the `ai-title` entry (`aiTitle`). "Expected" is the state a correct parser should derive from the file.

| File | Scenario | Expected final state | Notes |
|---|---|---|---|
| `projects/-home-user-demo-project/aaaa0001-…-000000000001.jsonl` | `tour` | idle after `end_turn` (last turn `turn_duration` 61250 ms) | Title "Walkthrough of every tool". Covers every tool in order: Read, Grep, Glob, WebSearch, WebFetch, Edit (.ts), Write (.svg), Bash `npm test`, Bash `npm run build` (result 45 s after the call), TodoWrite, Skill, `mcp__claude-in-chrome__navigate`, then text with `end_turn`. Ends with `cost-state` and `last-prompt`. |
| `…-000000000002.jsonl` | `ask` | needs you: `AskUserQuestion` open (no result) | Title "Choosing a framework". Last entry is the open tool_use. |
| `…-000000000003.jsonl` | `running` | running Bash `npm test` since `2026-10-18T10:00:10.000Z` | Title "Running the test suite". Ends with an open Bash tool_use. |
| `…-000000000004.jsonl` | `thinking` | thinking (request sent, no reply yet) | Title "Reviewing the entry file". Ends with a tool_result followed by an `api-request`. |
| `…-000000000005.jsonl` | `subagents` (parent) | parent idle after `end_turn`; agent 1 finished (notification at 10:01:17); agent 2 still researching | Title "Parallel review with two agents". Two `Agent` tool_uses, both `async_launched`. One `queue-operation` with a `<task-notification>` for agent 1 only. |
| `…/subagents/agent-a5ca1e00000000001.jsonl` | agent 1 | finished | Read, Grep, then `SubagentHandback` tool_use. Meta `finished: true`. |
| `…/subagents/agent-a5ca1e00000000002.jsonl` | agent 2 | researching: open `WebSearch` tool_use | Read, then an open WebSearch. Meta `finished: false`. |
| `…-000000000006.jsonl` | `compact` | compacting (last entry is `system` `compact_boundary`) | Title "Long session, compacted". |
| `…-000000000007.jsonl` | `interrupted` | interrupted: tool stopped by the user, turn ended, not running | Title "Build interrupted". Bash `npm run build` tool_use, then a user text entry `[Request interrupted by user for tool use]`. No tool_result for that call. |
| `…-000000000008.jsonl` | `partial` | thinking (last complete state). The final line is ignored | Title "Partially written file". 8 valid lines, then a 9th line cut off mid-JSON with **no trailing newline**. A tail reader must skip it, not throw. |
| `projects/C--Users-alice-work-proj/aaaa0009-…-000000000009.jsonl` | `windows` | idle after `end_turn` | Title "Windows project check". `cwd` is `C:\Users\alice\work\proj`, escaped in JSON. |

Subagent meta files:

| Meta file | `toolUseId` (parent Agent tool_use) | `finished` |
|---|---|---|
| `agent-a5ca1e00000000001.meta.json` | `toolu_01aa000501…` (Review router) | true |
| `agent-a5ca1e00000000002.meta.json` | `toolu_01aa000502…` (Research bundlers) | false |

## Live status files (`sessions/`)

| File | status | waitingFor | Points at session | Expected state |
|---|---|---|---|---|
| `1001.json` | busy | (absent) | `aaaa0003-…` (running) | running Bash `npm test` |
| `1002.json` | waiting | "input needed" | `aaaa0002-…` (ask) | needs you: AskUserQuestion |
| `1003.json` | idle | (absent) | `aaaa0001-…` (tour) | idle |

`waitingFor` is not present in the real files. It is included here because the spec asked for it. Real status values seen so far are `busy` and `idle`. `waiting` is taken from the spec and is unverified.

## Validation

The fixtures were generated and validated with one-off scripts that are not part of the repository. The checks below are what they verified:
- every line of every `.jsonl` parses, except the deliberate cut-off last line of `aaaa0008`;
- every `tool_result.tool_use_id` matches an earlier `tool_use.id` in the same file;
- every `meta.json` `toolUseId` matches a parent Agent tool_use, and each agent's `async_launched` agentId matches its file name.

The generator was also a one-off script, so the fixtures cannot be regenerated from this repository.
