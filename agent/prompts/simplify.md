---
description: Simplify recent changes without changing behavior
argument-hint: "[scope]"
---

Use `code-simplification` and `ponytail` guidance only when a needed practice is missing. Keep this template focused; do not reproduce a generic skill's full workflow.

Scope: ${ARGUMENTS:-Use recent changes}

The parent may simplify directly or delegate according to scope and risk. If delegation adds value, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded stage; use one top-level `workflowScript` with stable keys and `async: true` only for genuinely distinct serialized stages. Provide a cold-start packet with cwd/ref, exact diff and scope, allowed and forbidden files, behavior and acceptance criteria, validation commands, output format, and escalation rules, and keep one writer in a shared cwd at a time. Read-only inspection and validation are optional. Delegated children do not launch nested agents.

A child reports evidence or a blocker to the parent. The parent resolves it within the existing authorization; ask the user only when no safe, behavior-preserving next step exists. Honor an explicit request to discuss before making changes.

## Simplification steps

1. Identify the exact target diff or scope and establish the behavior contract from the current HEAD, working tree, configuration, environment, callers, boundaries, and tests. Existing evidence is useful only when it matches those inputs; do not trust HEAD alone.
2. Inspect every caller when a shared helper or contract is involved so the simplification fixes the cause rather than one path. Preserve user changes outside the target.
3. Apply only evidence-backed simplifications: prefer deletion, existing helpers, and standard-library facilities; keep validation, error handling, security, and observable behavior intact. Local changes in sensitive modules may proceed under the authorization, while external, irreversible, or hard-to-revert effects require explicit authorization.
4. Run focused checks for the changed behavior first, then broader tests and applicable build, typecheck, or lint checks at risk-based integration points. When a check fails, diagnose and repair, narrow the change, or report the evidence; continue safe independent checks instead of abandoning the task on the first failure.
5. Recheck behavior equivalence and scope. Do not change tests to conceal a behavior change, and do not create commits or other external effects unless explicitly authorized.

Report changed files, the simplification made (or a justified no-change result), behavior-equivalence evidence, commands and results, omitted full-suite or relevant checks with reasons, remaining work, assumptions, and residual risks.
