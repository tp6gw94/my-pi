---
description: Review a diff for concrete correctness, quality, security, and regression risks
argument-hint: "[diff, commit, or scope]"
---

Use `code-review-and-quality` guidance, plus security or performance guidance when the reviewed scope needs it. Read only the relevant guidance that is missing; keep this template focused.

Review target: ${ARGUMENTS:-Use the current staged and unstaged diff; if empty, use recent commits}

This command is read-only. Inspect and report; do not edit, write, stage, commit, push, change configuration, or create project artifacts. The parent may review directly or choose a risk-proportional set of read-only reviewers. When delegating, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded review; use one top-level `workflowScript` with `runs.all(...)` and `async: true` for multiple independent read-only checks only when useful. Provide a cold-start packet with cwd/ref, exact target and files, specification or task contract, evidence bar, output format, and escalation rules. Use one writer in the shared cwd at a time if another operation is separately authorized; reviewers themselves remain read-only and do not launch nested agents.

Review evidence must identify the exact current HEAD and compare it with the actual working tree, configuration, and environment. Validate claims against source and the target diff rather than trusting stale HEAD or inherited summaries. Inspect callers and shared contracts when the change can affect them.

Run tests, builds, typechecks, or lint only when they remain within the read-only boundary. If a check writes project files, isolate it in a temporary directory or disposable worktree, or label it as not run; do not call a write-producing check fully read-only. A failed check is evidence to investigate and report; continue safe independent checks when useful rather than stopping at the first failure.

Report only concrete, currently reachable issues caused or exposed by the target. Include severity P0/P1/P2, `file:line` or verifiable configuration/command evidence, impact, and the smallest safe fix. Do not apply fixes or promote speculation to a blocker. The parent deduplicates findings and classifies them against the exact current state. A child reports to the parent; only the parent asks the user when no safe review path exists. Honor an explicit request to discuss before making changes.

End with `Merge verdict: BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`. Return a structured review ordered by severity, followed by performed validation, omitted full-suite or relevant checks with reasons and residual risks, and the final recommendation.
