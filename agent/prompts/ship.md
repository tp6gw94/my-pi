---
description: Use parallel specialist reviewers to produce a launch GO/NO-GO decision and rollback plan
argument-hint: "[diff, commit, or release scope]"
---

Apply the `shipping-and-launch` skill.

Launch scope: ${ARGUMENTS:-Use the current staged and unstaged diff; if empty, use recent commits}

`/ship` is a read-only pre-launch gate. It must not deploy, push, merge, release, or modify project files without separate explicit user authorization.

## Phase A - Subagent fan-out

1. Call `subagent({ action: "list" })` and use only executable, enabled agents.
2. The parent identifies the exact ref/diff, specification, changed files, deployment target, and available validation commands.
3. Use one top-level `workflowScript`, `runs.all(...)`, and `async: true` to launch three fresh-context `reviewer` agents in parallel with distinct specialist contracts:
   - `code-quality`: correctness, readability, architecture, performance, and regressions
   - `security`: threat model, OWASP risks, auth/authz, secrets, data boundaries, and dependency risk
   - `test-operability`: coverage, failure paths, migrations, config/env, observability, rollout, and rollback gaps
4. Every child task must be cold-start complete: cwd/ref, read-only authority, relevant specification and files, evidence bar, completion criteria, output format, and stop rules. Reviewers may not modify files or launch subagents. Findings require `file:line` or verifiable configuration or command evidence.

Skip fan-out only when all conditions hold: no more than two changed files, fewer than 50 changed lines, and no authentication, payments, data access, migration, or config/env changes. In that case, the parent performs the same checklist directly.

## Phase B - Parent validation and synthesis

The parent inspects specialist evidence and runs the repository's actual tests, build, typecheck, lint, or focused checks. Child claims do not prove that commands passed. Also verify accessibility, env and migrations, monitoring, feature flags, documentation, and exact-head status. Deduplicate findings against current HEAD. Critical or high-severity security and data-integrity issues are blockers by default.

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
- [commands and results; skipped checks]

### Rollback plan
- Trigger conditions: [...]
- Procedure: [...]
- Recovery time objective: [...]

### Specialist summaries
- [three summaries]
```

A GO decision requires an executable rollback plan. Any Critical finding defaults to NO-GO unless the user explicitly accepts the risk. Reviews and checks provide evidence, not launch authority.
