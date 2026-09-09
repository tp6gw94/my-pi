---
description: Explicitly start a requirements interview using the package-managed interview-me skill
argument-hint: "[topic or requirements]"
---

The user explicitly requests a requirements interview. Read `~/.agents/skills/interview-me/SKILL.md` and use its interviewing methods to clarify this topic:

${ARGUMENTS:-the requirements in the current conversation}

Limit the workflow to this interview. Accept clear approval, delegation, or a request to end the interview without requiring a particular "yes" phrase or repeated confirmation. Ending the interview does not authorize implementation or external actions that the user has not requested.
