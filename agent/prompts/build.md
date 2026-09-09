---
description: Implement the next planned task; add auto or all to run the remaining tasks in order
argument-hint: "[auto|all]"
---

Use `incremental-implementation`, `test-driven-development`, and `git-workflow-and-versioning` guidance only when a needed practice is missing. Keep this template focused; do not reproduce a generic skill's full workflow.

Mode: ${1:-single}

- `/build` completes the next pending task and stops.
- `/build auto` and `/build all` complete every pending task serially in dependency order.

## Authority and delegation

The parent owns requirements, approval, scope, authorization, and final acceptance. It may work directly or delegate according to task size and risk.

When delegating, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded stage; use one top-level `workflowScript` with stable keys and `async: true` only for genuinely multi-stage work. Provide a cold-start packet with cwd/ref, specification and plan paths, exact scope, allowed and forbidden files, acceptance criteria, validation commands, RED/GREEN expectations where relevant, commit authority, output format, and escalation rules. Keep one writer in a shared cwd at a time; delegated children do not launch nested agents. Use read-only context or validation help only when it adds value.

A child reports evidence or a blocker to the parent. The parent resolves it within the existing authorization; only the parent asks the user when no safe, reversible next step exists. Respect an explicit request to discuss before changing anything.

## Execution

1. Use the current request, available specification/plan, and repository evidence. Validate evidence against the current HEAD, working tree, configuration, and environment rather than trusting HEAD or stale summaries. Reuse existing data and record reasonable assumptions instead of repeating questions. For `auto`/`all`, reuse an approved plan when available; if none exists, derive a bounded plan from available inputs and seek approval only when execution would broaden the authorized scope.
2. Inspect status and preserve unrelated user changes. Treat a dirty tree as input: isolate this task in the diff and do not overwrite, commit, or stash other work.
3. Implement the smallest in-scope change. Local code changes in sensitive modules may proceed under the authorization; obtain explicit authorization before push, deploy, or any other external, irreversible, or hard-to-revert effect. Running `/build` alone does not grant that authority.
4. Validate changed behavior with focused checks first. Integrate the full suite and applicable build, typecheck, or lint checks at risk-based integration points rather than after every small step. A failed check is evidence to diagnose and repair, narrow, or report; continue only when the remaining path is safe and acceptance is still supported.
5. Update only the task status and planning artifacts required by the existing workflow. Do not create a commit by default. An explicit commit request grants task-scoped commit authority; report the commit and keep unrelated changes untouched.

Report completed tasks, changed files, RED/GREEN evidence, commands and results, omitted full-suite or relevant checks with reasons and residual risks, commits (if explicitly authorized), remaining work, assumptions, and risks. For `auto`/`all`, process all pending tasks in order and report any task that remains incomplete.
