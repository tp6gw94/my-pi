---
description: Use reviewer -> worker -> reviewer to simplify recent changes without changing behavior
argument-hint: "[scope]"
---

Apply the `code-simplification` and `ponytail` skills.

Scope: ${ARGUMENTS:-Use recent changes}

## Subagent workflow

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. Use one top-level `workflowScript` with stable stage keys and `async: true`, in this order:
   - `inspect`: a fresh-context, read-only `reviewer` inspects the target diff, AGENTS.md, callers, boundaries, and tests. It proposes only simplifications that can preserve behavior, or returns no-change when the code is already simple.
   - `simplify`: the sole `worker`, using the simplification skills, applies only evidence-backed in-scope changes. It runs focused tests incrementally, then the full suite and applicable build/typecheck/lint commands. It must not change tests to hide behavior changes.
   - `validate`: a second fresh-context, read-only `reviewer` checks the final diff for behavior, error-handling, convention, and scope regressions.
3. Every child task must include the cwd/ref, exact scope, authority boundary, relevant files and evidence, success criteria, validation, output format, and stop rules. Children may not launch subagents.
4. Only the `simplify` worker may write in the cwd. The inspect and validate stages are read-only. If inspect finds no safe simplification, skip the worker and return no-change.
5. Prefer deleting ineffective abstractions, reusing existing helpers or the standard library, and reducing nesting or duplication. Avoid adjacent cleanup, speculative abstractions, and weakened validation or error handling.
6. If a test fails or behavior equivalence cannot be established, stop with evidence instead of guessing. The parent inspects the final diff, validation results, and reviewer findings, then reports changed files, reduced complexity, and residual risks.
