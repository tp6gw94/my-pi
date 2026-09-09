---
description: Turn available requirements into an ordered, verifiable plan
---

Use `planning-and-task-breakdown` guidance only when a needed planning practice is missing. Keep this template focused; do not reproduce a generic skill's full workflow.

This is a planning-only command. Produce or update `tasks/plan.md` and `tasks/todo.md` (or the project's established planning artifacts) and do not modify implementation, tests, configuration, or release artifacts. The parent may plan directly or delegate according to scope and risk.

When delegating, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded stage; use one top-level `workflowScript` with stable keys and `async: true` only for genuinely multi-stage work. Provide a cold-start packet with cwd/ref, specification and planning paths, relevant source and project rules, exact writable scope, acceptance criteria, validation, output format, and escalation rules. Keep one writer for planning artifacts at a time and do not allow nested agents. Read-only discovery is optional when it adds value, not a mandatory role or count.

The child reports evidence or blockers to the parent. The parent resolves them within the existing authorization; ask the user only when no safe plan can be produced. Honor an explicit request to discuss before making changes.

## Planning steps

1. Read the current request, available specification, existing plan/task data, project rules, and only the source context needed to understand dependencies. Validate evidence against the current HEAD, working tree, configuration, and environment rather than trusting HEAD or stale summaries. Use existing information instead of repeating questions.
2. If a specification is absent, derive a bounded plan from the request and available evidence. Record reasonable assumptions and non-blocking open questions in the plan; a missing file alone is not a blocker.
3. Map dependencies, implementation order, vertical slices, acceptance criteria, likely files, and validation commands. Split work that is too broad to verify safely and add checkpoints where dependency or risk justifies them.
4. Write only the planning artifacts. Include task-level acceptance, dependencies, validation, risks, and any safe parallel work, assigning only roles that the plan actually needs.
5. Confirm that every requirement is covered by an observable task and that the plan's scope matches the current authorization. Do not begin implementation in this command.

Report the planning artifacts changed, dependency order, acceptance and validation coverage, assumptions, risks, safe parallelism, and open questions. The parent inspects the result and presents the plan for approval before implementation when approval is required.
