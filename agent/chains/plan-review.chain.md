---
name: plan-review
description: Planner writes a plan (write-plan format) from the .explore/ documents, oracle reviews it for problems
---

## planner
phase: Planning
label: Draft plan
as: plan
output: plan.md
skills: write-plan
progress: true

Write a decision-complete execution plan for: {task}

Before writing anything, read the write-plan SKILL.md in full and follow its plan output format exactly. Also read every file under `.explore/` as gathered context; skip grill-me. Derive a slug and write `.plan/<slug>/task.md` in the required format (User Request, Key Context, Execution Plan waves with sub-task tables, Files, Risks and Assumptions). Do not write source code.

Return the absolute path of task.md and a one-sentence plan summary.

## oracle
phase: Review
label: Review plan
progress: true

Review this plan for: {task}

Planner handoff:
{outputs.plan}

Read the actual `.plan/<slug>/task.md` at the path in the handoff. Challenge assumptions, find gaps, risks, missing edge cases, wrong wave sequencing, and sub-tasks without checkable completion criteria. Report concrete problems and the safest next move. Advisory only, do not edit files.
