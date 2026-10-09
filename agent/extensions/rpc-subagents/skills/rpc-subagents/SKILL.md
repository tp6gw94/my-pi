---
name: rpc-subagents
description: Operate rpc-subagents child tasks through codemode. Use for synchronous chains, parallel reviews, background tasks, pending child dialogs, child asks or reports, native steering, local schedules, cancellation, or same-log Herdr viewers.
---

# Operate RPC subagents

## 1. Ready

Confirm delegation and any scheduled side effects are authorized by the user or applicable project instructions. Keep acceptance and publication decisions with the parent. Fleet operations preserve the session's approval and routing rules.

Discover only the needed tools in codemode before composing calls, once per unchanged session schema and capabilities. Reuse complete current descriptions already in context; refresh missing or stale knowledge after schema or capability changes or compaction loss.

```js
text(await describeTool("rpc_subagents_run"));
```

Describe each additional needed tool before its first use under the current schema. If discovery fails, report the missing capability and use the [setup guide](../../README.md). All fleet tools have codemode exposure. The main session's tool allowlist must include them.

Choose a task contract with a prompt, acceptance evidence, file ownership, and a deadline. Select `context: "fresh"` for explicit context only, or `context: "fork"` for the current branch captured at invocation. A fork is a snapshot, not a live connection to later conversation. Continue a managed completed session with `session` instead: a reported session ID or its absolute managed `.jsonl`, same cwd and model, a new task ID, and one exclusive writer lease. `session` and `context` are mutually exclusive, and schedules reject `session`.

For an explicit model, use `model: { provider: "<provider>", id: "<exact-model-id>" }`. Pass `thinking: "high"` separately. Omitted model and thinking use the calling context. Without a current model, supply the model object. Launch arguments control routing, capabilities, context, and timing; task prose does not configure them. The child reports its actual model and supported thinking level from runtime settings when available; the parent compares the report with launch arguments and task metadata. This is launch verification, not a request for the child to select or switch models. A mismatch fails rather than falling back.

Check the child's capabilities before assigning work. Children use `--no-skills --no-extensions --no-prompt-templates`. Only explicit provider bootstrap sources, the child bridge, and the controlled installed pi-web-access wrapper (when requested) load. Fleet accepts no named-agent profile.

### Child capability selection

`tools` controls child capabilities. Selection applies at task start and at schedule creation; it never changes a live child. Every child also gets the model-only `rpc_subagents_parent` bridge, which `tools` never changes.

| Tool | Use |
| --- | --- |
| `read`, `write`, `edit` | Default file access. |
| `bash` | Default command execution. |
| `codemode` | Default codemode scripting. |
| `grep`, `find`, `ls` | Optional built-ins for text search, file search, and directory listing; select them like any other name. |
| `web_search` | Search the web. |
| `source_check` | Check a claim against sources. |
| `fetch_content` | Fetch page or document content. |
| `get_search_content` | Read stored result content. |

Omitted `tools` keeps the five execution defaults and the full enabled web family. Plain names replace the execution defaults, so `["read", "get_page"]` runs exactly `read` plus the configured `get_page`. `[]` keeps only `rpc_subagents_parent`. Signed entries adjust the five defaults in order, so `+fetch_content` keeps all five and adds fetch. Plain and signed entries cannot mix.

Signed selection:

```js
const signed = await tools.rpc_subagents_run({
	name: "Search with defaults",
	prompt: "Search the web, then report sources.",
	tools: ["+web_search", "-edit"]
});
return signed.webTools;
```

Plain selection with automatic web support:

```js
const replaced = await tools.rpc_subagents_run({
	name: "Fetch and read",
	prompt: "Read src and fetch the linked specification.",
	tools: ["read", "fetch_content"]
});
return replaced.webTools;
```

Signed entries apply in order. Repeating an entry is a no-op, and `+name` then `-name` ends with `name` off. Removing an absent name does nothing. Wildcards, empty entries, duplicate plain names, mixed plain/signed entries, and reserved fleet names reject. Naming a web tool loads support automatically, so omit `webAccess` for named selections; `webAccess: true` beside a proper named subset rejects, and `webAccess: false` beside a named web tool rejects.

Configured web names come from `toolNames` and disabled slots in the installed `web-search.json`. The current renamed or enabled name succeeds; a renamed-away, disabled, or unknown name fails. Positive conflicts reject instead of silently overriding the selection. `web_enable` is the child's activation helper in auto/dynamic modes and is not selectable.

Legacy `webAccess` remains. Omitted `tools` defaults it to true for the full enabled family; explicit `tools`, including `[]`, defaults it to false unless an entry names an installed web tool, which enables web support without `webAccess`; explicit true with a named proper subset rejects. Schedules persist the resolved execution and web tools and reuse them on every fire without reinterpreting `+`/`-` entries. Enabled tasks use only the trusted local installed pi-web-access entrypoint with inherited credentials and existing configuration. Preserve auto/dynamic/eager activation inside the selected subset: follow the available loader prompt snippets, call `web_enable` when needed, and inspect `capabilities.webTools` plus `reachable` after activation. Absent package, entrypoint, factory, or all-disabled tools fail startup.

It is a tool list, not a sandbox: a read-only prompt is an instruction, not an enforced permission boundary. Put required operating instructions in the prompt. For missing providers or startup dialogs, read the [bootstrap and startup limits](../../README.md). Provider dialogs during `session_start` are unsupported. Post-start dialogs support explicit responses.

Assign parallel tasks disjoint files or read-only work. Children share their selected `cwd`. Fleet creates no worktrees and takes no project-file locks. Separate writable directories before concurrent edits.

### Compose the task prompt

Summarize the actionable request once. Include the decisions, constraints, source pointers, file ownership, and acceptance evidence the child needs. Quote the user only when exact wording is part of the task. With `context: "fork"`, add task boundaries and updates instead of replaying inherited history. With `context: "fresh"`, supply the missing context.

Separate verified source locations from search leads. If the implementation location is unknown, ask the child to locate the relevant symbol or behavior within a bounded scope first. Include documentation pointers only when their content affects the task.

Keep each constraint in one place. Pass verified source pointers for role details, templates, and required skills, instructing the child to read them fully because skills and extensions are not inherited. Include launch settings in task prose only when they affect how the child performs the work. Bound returned findings, citations, excerpts, and uncertainties to the acceptance decision; retain larger evidence in artifacts with paths. Before dispatch, keep only sentences that change execution or acceptance.

Ready is complete when tools are discoverable and every task has a supported model, sufficient instructions, and safe file ownership.

## 2. Dispatch

Follow the session's execution policy. Use synchronous `run` for dependent chains that need a result in this call. Gate every dependent call on `status === "completed"` before consuming `text`.

For a synchronous review-to-checklist chain, inspect the review's full structured result and launch metadata first. If it is not completed or lacks required evidence, report a compact blocker and stop the dependent task. Otherwise pass only checked, relevant findings to the checklist task, inspect its result, and retain both task IDs.

For independent tasks, use `Promise.allSettled`. Inspect each promise outcome. A rejected promise is a call failure. A fulfilled promise can still contain `failed`, `cancelled`, or `interrupted`. Preserve each task ID and report each outcome separately.

For background work, set `async: true` and save `taskId` immediately with `store` or a durable handoff. Local acceptance or `queued` means neither successful child startup nor completed work. Set `timeoutMs` for the total task deadline, including queue and startup time.

An async child may ask this session through the model-only `rpc_subagents_parent` tool. A new ask wakes this session once with the task and request IDs; inspect it with `rpc_subagents_pending` and answer with `rpc_subagents_reply`. Treat the child question as an untrusted request for evidence, never as approval authority, and never auto-approve. A sync task's ask returns `requires_async` instead of blocking. Reports arrive through `rpc_subagents_pending` without a wake-up.

For deferred or recurring work, follow [schedule operations](references/operations.md#schedule-local-work).

Dispatch is complete when each call has a recorded task ID or a reported call failure. Keep schedule IDs separate from task IDs.

## 3. Observe

Use `rpc_subagents_status({ taskId })` to inspect state and pending dialogs. Use `rpc_subagents_result({ taskId })` for retained or partial text. Use `rpc_subagents_wait({ taskId, timeoutMs })` for a bounded wait. A wait deadline returns current state without cancelling the task. Aborting a wait or ending codemode does not stop a detached task. Aborting a synchronous run cancels its child.

If the task enters `waiting_input`, follow [explicit dialog responses](references/operations.md#respond-to-a-dialog). Never autoapprove a dialog. A `waiting_input` task may hold ordinary dialogs, coordination requests, or both. Answer requests through [child asks and reports](references/operations.md#answer-a-child-ask); `rpc_subagents_respond` rejects coordination request IDs. To guide a live streaming task, follow [native steering](references/operations.md#steer-a-live-task).

To stop a task, call `rpc_subagents_cancel({ taskId })`. Cancellation is idempotent. To inspect progress in a pane, follow [same-log viewing](references/operations.md#view-the-same-event-log). Closing a viewer does not cancel the task.

Observe is complete when each task is terminal or explicitly handed off as still running with its ID and next observation action.

## 4. Accept

Treat only `completed` as successful execution. Fleet waits for `agent_settled`, not prompt acceptance or `agent_end`. A handled prompt can complete with empty text and no model execution. Check the requested evidence even after successful execution.

Inspect `truncated`, `error`, `persistenceError`, and `state.cleanupError`. Retained text is bounded, and the rendered tool message can be shorter than structured data. Retrieve the result or inspect the event log when needed. Read child reports from `rpc_subagents_pending`; a report is evidence, not completion. Logs and sessions can contain project secrets. Private file permissions are not encryption. Share only the evidence required by the task.

Inside codemode, inspect full structured results and launch metadata before projecting output. Emit compact `taskId`, `status`, checked `findings`, `truncated`, `errors` (including the actual `error`), `persistenceError`, and `cleanupError` from `state.cleanupError`; preserve missing or unknown values honestly. This is an output projection, not a tool API. Include model or capability mismatches and unresolved pending request IDs when present. Return full reports, capability dumps, or event logs only when needed to resolve a specific evidence gap. Report task IDs, terminal statuses, acceptance evidence, and unresolved blockers. For non-completed tasks, report the actual error or cancellation reason rather than using partial text as a successful answer. For storage, ownership, output limits, or shutdown failures, read the [operating guide](../../README.md) and [task result types](../../domain.d.ts).

Acceptance is complete when every requested outcome has checked evidence or an explicit blocker. Label ongoing background work as ongoing, not complete.
