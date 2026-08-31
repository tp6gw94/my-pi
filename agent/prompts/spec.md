---
description: Use subagents to gather context and write a structured specification
argument-hint: "[requirements]"
---

Apply the `spec-driven-development` skill.

Requirements: ${ARGUMENTS:-Use the requirements from the current conversation}

## Subagent workflow

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. Launch one asynchronous, read-only `scout` with a cold-start packet covering the goal, cwd, project rules, relevant files, existing architecture, actual build/test/lint commands, constraints, evidence locations, and unresolved questions. It must not modify project files.
3. From the scout's evidence, the parent lists assumptions and asks the user one focused set of questions about target users, observable acceptance criteria, technical constraints, and Always / Ask first / Never boundaries.
4. If the request contains independently testable capabilities, ask a read-only `reviewer` to propose a capability map with stable module IDs, dependency direction, and build order. The parent must obtain user approval before proceeding.
5. Once requirements are clear, launch one `worker` with the `spec-driven-development` skill to write `SPEC.md`. For a multi-module initiative, write the approved capability map and `SPEC-<module-id>.md` files. The worker may modify specification files only; it may not write implementation code, commit, push, or launch subagents.
6. The worker reports changed files, coverage of the six required sections, testable success criteria, open questions, and skipped validation. The parent inspects the diff, presents it for user approval, and stops.

Every child task must include the objective, cwd/ref, authority boundary, relevant files and decisions, success criteria, validation, output format, and stop/escalation rules. Use a direct child call for one bounded task. For a multi-step or fan-out phase, use exactly one top-level `workflowScript` with `async: true`.
