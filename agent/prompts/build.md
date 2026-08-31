---
description: Use one worker to implement, test, verify, and commit incrementally; add auto to execute the full plan
argument-hint: "[auto]"
---

Apply the `incremental-implementation`, `test-driven-development`, and `git-workflow-and-versioning` skills.

Mode: ${1:-single}

- `/build` completes the next pending task and stops.
- `/build auto` (`all` is an alias) completes every pending task in dependency order after plan approval.

## Shared subagent rules

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. The parent retains requirements, approval, scope, and final acceptance. Delegate implementation to one asynchronous `worker` with the required skills. Never run a second writer in the same cwd, and do not allow the child to launch subagents.
3. The worker's cold-start packet must include the cwd/ref, specification and plan paths, exact task scope, allowed and forbidden files, acceptance criteria, RED/GREEN/REFACTOR expectations, repository-specific validation commands, commit authority, output format, and stop conditions.
4. For each task, the worker reads the acceptance criteria, writes and confirms a failing test, makes the minimum implementation pass, runs focused tests, then the full suite and applicable build/typecheck/lint commands. It updates task status, stages only files from that task plus its status update, and creates one descriptive commit.
5. The worker reports completed tasks, changed files, RED/GREEN evidence, commands and results, commits, remaining work, and risks. The parent inspects git status, the final diff, and the evidence before declaring completion.

## `/build`

After the parent confirms that unrelated working-tree changes cannot be absorbed into the commit, launch one asynchronous `worker` for the next pending task. Stop when that task is complete.

## `/build auto`

1. Require a specification at `SPEC.md`, `docs/SPEC.md`, or under `spec/*`. If none exists, stop and ask the user to run `/spec`.
2. Run `git status --porcelain`. If uncommitted changes exist outside expected specification or planning artifacts, ask the user whether to commit, stash, or otherwise handle them.
3. If `tasks/plan.md` is missing, generate it through the `/planning` subagent workflow.
4. Present the complete plan and obtain one explicit approval. Do not launch the implementation worker before approval.
5. After approval, launch one asynchronous `worker`. If this run created or changed planning files, the worker first commits only those artifacts as a preparatory commit, then executes pending tasks serially. Never fan out writers. Keep independent validation and one commit per task.
6. The worker must stop and ask the parent when tests or builds cannot pass, the specification is ambiguous, or work reaches authentication, payments, destructive migrations, deletion, deployment, secrets, or another high-risk or irreversible action. Resume from the next pending task after the decision.

Use a direct child call for one implementation task. If one wave genuinely requires multiple coordinated stages, use exactly one top-level `workflowScript` with stable keys and `async: true`, while keeping writers serialized.
