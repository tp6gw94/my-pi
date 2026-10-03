import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { textContent, terminalTaskStates } from "./domain.mjs";

export class TerminalSanitizer {
  constructor() { this.state = "text"; }
  push(text) {
    let output = "";
    for (const char of String(text)) {
      const code = char.codePointAt(0);
      if (this.state === "text") {
        if (code === 0x1b) this.state = "escape";
        else if (code === 0x9b) this.state = "csi";
        else if (code === 0x9d) this.state = "osc";
        else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) this.state = "string";
        else if (char === "\n" || char === "\t" || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069))) output += char;
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if (char === "]") this.state = "osc";
        else if (["P", "X", "^", "_"].includes(char)) this.state = "string";
        else if (code >= 0x30 && code <= 0x7e) this.state = "text";
      } else if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 0x1b) this.state = "escape";
      } else if (this.state === "osc" || this.state === "string") {
        if (code === 0x9c || (this.state === "osc" && code === 7)) this.state = "text";
        else if (code === 0x1b) { this.previous = this.state; this.state = "string_escape"; }
      } else if (this.state === "string_escape") {
        this.state = char === "\\" ? "text" : this.previous;
      }
    }
    return output;
  }
}

export function safeText(value, max = 8192) { return new TerminalSanitizer().push(String(value ?? "").slice(0, max)); }
export function singleLineText(value, max = 8192) { return safeText(value, max).replace(/[\n\t\u2028\u2029]/g, " "); }

export class EventRenderer {
  constructor() { this.streams = new Map(); this.terminal = false; }
  render(record) {
    const event = record.event;
    if (!event) return "";
    if (record.source === "fleet") {
      if (event.type === "task_created") {
        const task = event.task;
        return `任務 ${safeText(task.taskId)}  ${safeText(task.name)}\n模型 ${safeText(task.model.provider)}/${safeText(task.model.id)}\n狀態 ${safeText(task.status)}\n`;
      }
      if (event.type === "task_state") return `\n狀態 ${safeText(event.state.status)}${event.state.status === "waiting_input" ? "，等待明確回應" : ""}\n`;
      if (event.type === "task_terminal") {
        if (this.terminal) return "";
        this.terminal = true;
        return `\n結果 ${safeText(event.status)}\n`;
      }
      if (event.type === "task_result") {
        this.terminal = true;
        const task = event.task;
        return `\n結果 ${safeText(task.status)}\n${safeText(task.text, 65536)}${task.truncated ? "\n[輸出已截短，完整事件保留於記錄檔]" : ""}${task.error ? `\n錯誤 ${safeText(task.error)}` : ""}${task.state.reason ? `\n原因 ${safeText(task.state.reason)}` : ""}\n`;
      }
      if (event.type === "dialog_responded") return `\n對話 ${safeText(event.dialogId)} 已${event.cancelled ? "取消" : "回應"}\n`;
      return "";
    }
    if (record.source === "stderr") return `\n診斷 ${safeText(event.text)}\n`;
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.streams.clear();
      return "\n輸出\n";
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent;
      if (!this.streams.has(delta.contentIndex)) this.streams.set(delta.contentIndex, new TerminalSanitizer());
      return this.streams.get(delta.contentIndex).push(delta.delta);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.streams.clear();
      return event.message.errorMessage ? `\n模型錯誤 ${safeText(event.message.errorMessage)}\n` : "\n";
    }
    if (event.type === "tool_execution_start") return `\n工具 ${safeText(event.toolName)} ${safeText(event.toolCallId)}\n${safeText(JSON.stringify(event.args), 2048)}\n`;
    if (event.type === "tool_execution_update") return `工具進度 ${safeText(event.toolName)}\n${safeText(textContent(event.partialResult?.content), 4096)}\n`;
    if (event.type === "tool_execution_end") return `工具${event.isError ? "失敗" : "完成"} ${safeText(event.toolName)}\n${safeText(textContent(event.result?.content), 4096)}\n`;
    if (event.type === "extension_ui_request") return `\n子程序介面 ${safeText(event.method)} ${safeText(event.title ?? event.message)}\n`;
    if (event.type === "auto_retry_start") return `\n重試 ${safeText(event.attempt)} ${safeText(event.errorMessage)}\n`;
    if (event.type === "auto_retry_end" && !event.success) return `\n重試失敗 ${safeText(event.finalError)}\n`;
    if (event.type === "response" && event.success === false) return `\nRPC 失敗 ${safeText(event.command)} ${safeText(event.error)}\n`;
    if (event.type === "extension_error") return `\n擴充錯誤 ${safeText(event.error)}\n`;
    return "";
  }
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function replayAndFollow(file, { write, signal, maxReplayBytes = 1048576, pollMs = 250, follow = true } = {}) {
  const handle = await open(file, "r");
  const renderer = new EventRenderer();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let offset;
  let discard;
  try {
    const size = (await handle.stat()).size;
    offset = Math.max(0, size - maxReplayBytes);
    discard = offset > 0;
    if (discard) await write(`[已略過較早的 ${offset} bytes，僅重播記錄檔尾段]\n`);
    const bytes = Buffer.alloc(65536);
    while (!signal?.aborted) {
      const read = await handle.read(bytes, 0, bytes.length, offset);
      if (!read.bytesRead) {
        if (!renderer.terminal) {
          let saved;
          try { saved = JSON.parse(await readFile(join(dirname(file), "state.json"), "utf8")); } catch {}
          if (terminalTaskStates.has(saved?.status)) {
            await write(renderer.render({ source: "fleet", event: { type: "task_result", task: saved } }));
          }
        }
        if (!follow || renderer.terminal) return;
        await sleep(pollMs, signal);
        continue;
      }
      offset += read.bytesRead;
      buffer += decoder.write(bytes.subarray(0, read.bytesRead));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (discard) { discard = false; continue; }
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { await write("[無法解析的事件已略過]\n"); continue; }
        const text = renderer.render(record);
        if (text) await write(text);
      }
      if (Buffer.byteLength(buffer) > 8388608) {
        buffer = "";
        discard = true;
        await write("[事件超出大小限制，已略過]\n");
      }
    }
  } finally { await handle.close(); }
}

async function main() {
  const index = process.argv.indexOf("--events");
  if (index < 0 || !process.argv[index + 1]) throw new Error("用法：node viewer.mjs --events /absolute/path/events.jsonl");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await replayAndFollow(process.argv[index + 1], {
      signal: controller.signal,
      write: (text) => new Promise((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve())),
    });
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(safeText(error.message) + "\n"); process.exitCode = 1; });
}
