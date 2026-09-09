---
description: Run a read-only prelaunch gate with a GO/NO-GO decision and rollback plan
argument-hint: "[diff, commit, or release scope]"
---

Use `shipping-and-launch` guidance only when a needed launch-gate practice is missing. Keep this template focused; do not reproduce a generic skill's full workflow.

Launch scope: ${ARGUMENTS:-Use the current staged and unstaged diff; if empty, use recent commits}

`/ship` is a read-only prelaunch gate. It gathers evidence, reports GO or NO-GO, and proposes rollback; it never deploys, pushes, merges, releases, or modifies project files. Those actions require a separate command and explicit authorization outside this gate.

The parent may run the gate directly or delegate risk-proportional read-only work. When delegating, first call the actual `subagent({ action: "list" })` contract and select only executable, enabled agents. Use a direct child call with `async: true` for one bounded check; use one top-level `workflowScript` with `runs.all(...)` and `async: true` for multiple independent read-only checks only when useful. Provide each task with cwd/ref, exact diff or release scope, specification, changed files, deployment target, available commands, evidence bar, output format, and escalation rules. Keep one writer in a shared cwd at a time; all gate participants are read-only and do not launch nested agents. Use only the specialist coverage justified by the scope and risk.

A child reports findings to the parent. The parent resolves them within the existing authorization; ask the user only when no safe read-only path exists. Local review of sensitive modules is not an automatic stop; any attempted external, irreversible, or hard-to-revert effect still needs explicit authorization. Honor an explicit request to discuss before making changes.

## Phase A - Evidence and review

Identify the exact current HEAD and working-tree diff, specification, changed files, deployment target, configuration, environment, validation commands, and rollback inputs. Choose direct checks or delegated read-only specialists according to scale and risk. Every finding needs a file and line, verifiable configuration, or command evidence; report uncertainty as a risk, not a blocker without proof.

## Phase B - Parent validation

The parent inspects the current source and evidence, then runs the repository's actual tests, build, typecheck, lint, migration, accessibility, observability, and configuration checks that are relevant. Existing evidence counts only when it matches the exact HEAD, working tree, configuration, and environment. Checks that write project artifacts are isolated in a temporary directory or disposable worktree, or clearly marked outside the read-only gate and not run. A failed check is investigated and reported; safe independent checks may continue, but unresolved failures affect the decision.

Deduplicate findings against current state. Critical or high-severity security and data-integrity issues are blockers unless the user explicitly accepts the risk.

## Phase C - Decision

Return:

```markdown
## Ship Decision: GO | NO-GO

### Blockers
- [source: issue, evidence, location]

### Recommended fixes
- [issue and smallest safe fix]

### Acknowledged risks
- [risk and mitigation]

### Verification
- [commands and results; omitted full-suite or relevant checks, reasons, and residual risks]

### Rollback plan
- Trigger conditions: [...]
- Procedure: [...]
- Recovery time objective: [...]

### Specialist summaries
- [one entry per specialist used, or state that the parent ran the checklist directly]
```

A GO decision requires an executable rollback plan. Reviews and checks provide evidence, not launch authority.
