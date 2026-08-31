---
description: Use a subagent to turn a specification into ordered, verifiable tasks
---

Apply the `planning-and-task-breakdown` skill.

## Subagent workflow

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. The parent identifies the specification (`SPEC.md`, `docs/SPEC.md`, `spec/*`, or a user-supplied path) and planning scope. If no specification exists or a material requirement remains ambiguous, stop and ask the user.
3. Launch one asynchronous `worker` with the `planning-and-task-breakdown` skill as the sole writer. Its cold-start packet must include the cwd/ref, specification path, relevant source files, project rules, permission to modify planning artifacts only, and a ban on implementation, commits, pushes, and nested subagents. It must stop for unapproved decisions.
4. The worker reads the specification and necessary code, then:
   - maps component dependencies and implementation order
   - creates verifiable vertical slices
   - gives every task acceptance criteria, validation, dependencies, and likely files
   - splits tasks that would touch more than about five files
   - adds a checkpoint after every two or three tasks
   - writes `tasks/plan.md` and `tasks/todo.md`; if project rules require an external tracker, uses it and leaves an index in the plan
5. The worker reports changed files, dependency order, risks, safe parallel work, validation, and open questions. The parent inspects the diff and completeness, then presents the plan for human review. Implementation must not begin before approval.

This is normally one bounded writer task: use a direct child call with `async: true`. Use one top-level `workflowScript` only when a real multi-step flow such as scout -> writer is necessary. Never run parallel writers in one cwd.
