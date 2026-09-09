---
description: Explicitly check your understanding of a change using the package-managed do-i-understand skill
argument-hint: "[PR, diff, branch, or commit]"
---

The user explicitly requests an understanding review. Read `~/.agents/skills/do-i-understand/SKILL.md` and use it to explore the user's understanding of this change:

${ARGUMENTS:-the concrete change discussed in the current conversation}

Limit the workflow to this change. If no concrete change is identifiable, ask for the target rather than selecting unrelated work. Ask one question at a time and respect a request to end the review. This is a read-only conversation about understanding, not authorization to edit, commit, publish, or merge. Do not post or save an attestation without an explicit request.
