---
name: ralph-completion
description: Stop an active Ralph loop when its task is fully complete. Use during a Ralph iteration to learn the exact terminal response.
---

# Ralph completion

When the Ralph task is fully complete, make the entire final assistant response exactly:

```text
<ralph-done>
```

Include no whitespace, Markdown fence, explanation, or other text around the marker.

When the task is incomplete, report concise progress without making the entire response that marker.

The marker stops the loop after the current agent run settles; it does not interrupt a running tool call or turn.
