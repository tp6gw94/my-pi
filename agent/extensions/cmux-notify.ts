import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
    if (text.trim()) return text.trim();
  }
  return "Ready for input";
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function sanitizeOSC(str: string): string {
  return str.replace(/[\x00-\x1f\x7f]/g, "").replace(/;/g, ", ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${sanitizeOSC(title)};${sanitizeOSC(body)}\x07`);
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    try {
      const workspace = ctx?.cwd ? path.basename(ctx.cwd) : "Pi";
      const body = truncate(getLastAssistantText(event.messages), 120);
      notifyOSC777(workspace, body);
    } catch (err) {
      console.error("cmux-notify failed:", err);
    }
  });
}

if (process.env.CMUX_NOTIFY_SELF_TEST) {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "This is the final answer." }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "OK" }],
    },
  ];
  const text = getLastAssistantText(messages);
  if (text !== "This is the final answer.") {
    throw new Error(`Expected final answer, got: ${text}`);
  }
  if (truncate("short", 10) !== "short") {
    throw new Error("truncate failed on short string");
  }
  if (truncate("a".repeat(200), 120).length !== 120) {
    throw new Error("truncate failed on long string");
  }
  const sanitized = sanitizeOSC("hello;world\x07\x1b");
  if (sanitized !== "hello, world") {
    throw new Error(`sanitizeOSC failed: ${sanitized}`);
  }
  console.log("self-test passed");
}
