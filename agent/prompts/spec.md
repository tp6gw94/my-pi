---
description: Turn requirements and available evidence into a structured specification
argument-hint: "[requirements]"
---

Use `spec-driven-development` guidance only when a needed specification practice is missing. Keep this template focused; do not reproduce a generic skill's full workflow.

Requirements: ${ARGUMENTS:-Use the requirements from the current conversation}

This is a specification-only command. Produce or update `SPEC.md`, `docs/SPEC.md`, or the project's established specification files; do not modify implementation, tests, planning, configuration, or release artifacts. The parent may write the specification directly or delegate according to scope and risk.

When delegating, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded stage; use one top-level `workflowScript` with stable keys and `async: true` only for genuinely multi-stage work. Provide a cold-start packet with cwd/ref, requirements and project-rule sources, relevant files and evidence, exact writable scope, decisions, success criteria, validation, output format, and escalation rules. Keep one writer for specification files at a time and do not allow nested agents. Read-only context gathering is optional when it adds value, not a mandatory role or count.

The child reports evidence or blockers to the parent. The parent resolves them within the existing authorization; ask the user only when no safe specification can be produced. Existing requirements and specification data are inputs, not reasons to repeat questions. Record reasonable assumptions and provide a useful draft for non-blocking uncertainty. Honor an explicit request to discuss before making changes.

## Specification steps

1. Gather the goal, users, observable behavior, constraints, boundaries, and available architectural evidence from the current conversation and relevant files. Validate evidence against the current HEAD, working tree, configuration, and environment rather than trusting HEAD or stale summaries. Expand inspection when a root cause or shared contract materially affects scope.
2. Define testable success criteria, interfaces and data, error behavior, security and operational constraints, and applicable non-functional requirements. Keep implementation choices subordinate to the approved need.
3. Cover the six required sections of the applicable specification guidance. For independently testable capabilities, add a capability map or module-specific specification files only when useful and in scope.
4. Write only the specification artifacts. Separate assumptions and unresolved decisions from requirements, and make each criterion verifiable.
5. Check that the specification covers the requested scope without silently granting external, irreversible, or hard-to-revert actions. Local work in sensitive modules may be specified; external effects still require explicit authorization.

Report specification files changed, coverage of the six required sections, testable success criteria, assumptions, open questions, and skipped validation. The parent inspects the specification and obtains approval before implementation when approval is required.
