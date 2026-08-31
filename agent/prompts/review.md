---
description: Use parallel fresh-context reviewers for a five-axis code review
argument-hint: "[diff, commit, or scope]"
---

Apply the `code-review-and-quality` skill, plus the relevant security or performance skill when those risks exist.

Review target: ${ARGUMENTS:-Use the current staged and unstaged diff; if empty, use recent commits}

## Subagent workflow

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. The parent identifies the exact diff/ref, specification or task contract, and changed files.
3. Use one top-level `workflowScript`, `runs.all(...)`, and `async: true` to launch three fresh-context `reviewer` agents in parallel:
   - `correctness-tests`: correctness, boundaries, error paths, regressions, and test effectiveness
   - `architecture-simplicity`: readability, project conventions, architecture boundaries, duplication, and over-engineering
   - `security-performance`: trust boundaries, auth/authz, secrets, injection, dependency risk, N+1 behavior, and unbounded work
4. Every reviewer must inspect the target diff and source directly. Each task must include the cwd/ref, read-only authority, relevant specification, evidence bar, output format, and stop rules. Reviewers may not modify files, launch subagents, or promote speculation to a blocker.
5. Report only concrete, currently reachable issues caused or exposed by the change. Include `file:line`, evidence, the smallest safe fix, and P0/P1/P2 severity. End every report with `Merge verdict: BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`.
6. The parent deduplicates findings and classifies each against current HEAD as valid blocker, valid non-blocker, stale, invalid, out-of-scope, or speculative. A child verdict is evidence, not merge authority.
7. Return a structured review ordered by severity, including performed and skipped validation plus the final recommendation. This command is review-only unless the user explicitly asks for fixes.
