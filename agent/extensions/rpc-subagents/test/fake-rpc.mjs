import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { LFDecoder } from "../transport.mjs";
import { BOOTSTRAP_PROMPT, DEFAULT_EXECUTION_TOOLS, PARENT_TOOL_NAME, createCoordinationRequestId, encodeCoordinationEnvelope } from "../coordination.mjs";

export function toolInventory(tools = DEFAULT_EXECUTION_TOOLS) {
  const callable = [...tools];
  const exposures = Object.fromEntries(callable.map((name) => [name, "codemode"]));
  exposures[PARENT_TOOL_NAME] = "model-only";
  const registered = [...callable, PARENT_TOOL_NAME];
  return { registered, active: [...registered], declared: [...registered], callable, exposures };
}

export class FakeRpcProcess extends EventEmitter {
  constructor({ model = { provider: "test", id: "model" }, disposition = "started", onCommand, onBootstrap, closeOnEnd = true,
    sessionFile, sessionId, isStreaming = true, tools = DEFAULT_EXECUTION_TOOLS, binding, inventory, bootstrapDisposition = "handled",
    steerDisposition = "queued", errors = {}, stubborn = false } = {}) {
    super();
    this.pid = 987654;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.commands = [];
    this.responses = [];
    this.model = model;
    this.disposition = disposition;
    this.onCommand = onCommand;
    this.onBootstrap = onBootstrap;
    this.sessionFile = sessionFile;
    this.sessionId = sessionId;
    this.isStreaming = isStreaming;
    this.tools = tools;
    this.binding = binding;
    this.inventory = inventory;
    this.bootstrapDisposition = bootstrapDisposition;
    this.steerDisposition = steerDisposition;
    this.errors = errors;
    this.stubborn = stubborn;
    this.signals = [];
    this.prompt = undefined;
    this.notifications = 0;
    this.dialogCounter = 0;
    this.pendingAsks = new Map();
    const decoder = new LFDecoder();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of decoder.push(chunk)) this.command(JSON.parse(line));
        callback();
      },
    });
    this.stdin.on("finish", () => { if (closeOnEnd && !this.stubborn) this.exit(0); });
  }
  command(command) {
    this.commands.push(command);
    const injected = this.errors[command.type];
    if (injected) { this.respond(command, undefined, injected); return; }
    if (command.type === "prompt" && command.message === BOOTSTRAP_PROMPT) { this.bootstrap(command); return; }
    if (this.onCommand?.(command, this) === true) return;
    if (command.type === "get_state") {
      this.respond(command, { model: this.model, isStreaming: this.isStreaming,
        ...(this.sessionFile === undefined ? {} : { sessionFile: this.sessionFile }),
        ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }) });
    } else if (command.type === "get_available_thinking_levels") this.respond(command, { levels: ["off", "high"] });
    else if (command.type === "prompt") { this.prompt = command; this.respond(command, { disposition: this.disposition }); }
    else if (command.type === "steer") this.respond(command, { disposition: this.steerDisposition });
    else if (command.type === "extension_ui_response") {
      this.responses.push(command);
      const requestId = this.pendingAsks.get(command.id);
      if (requestId) {
        this.pendingAsks.delete(command.id);
        this.askClosed(requestId, command.cancelled === true ? "cancelled" : "answered");
      }
    } else this.respond(command, {});
  }
  bootstrap(command) {
    if (this.onBootstrap?.(command, this) === true) return;
    this.respond(command, { disposition: this.bootstrapDisposition });
    if (this.inventory !== false) this.notifyInventory(this.inventory ?? toolInventory(this.tools));
  }
  notifyInventory(inventory = this.inventory ?? toolInventory(this.tools)) {
    this.notifications++;
    this.record({ type: "extension_ui_request", id: `notify-${this.notifications}`, method: "notify",
      message: encodeCoordinationEnvelope(this.binding, { kind: "inventory", inventory }) });
  }
  ask(question, { requestId = createCoordinationRequestId(), timeoutMs = 60000, nativeId = `dialog-${++this.dialogCounter}` } = {}) {
    const expiresAt = Date.now() + timeoutMs;
    this.pendingAsks.set(nativeId, requestId);
    this.record({ type: "extension_ui_request", id: nativeId, method: "input",
      title: encodeCoordinationEnvelope(this.binding, { kind: "ask", requestId, question, expiresAt }) });
    return { requestId, nativeId, expiresAt };
  }
  askClosed(requestId, reason = "cancelled") {
    this.notifications++;
    this.record({ type: "extension_ui_request", id: `notify-${this.notifications}`, method: "notify",
      message: encodeCoordinationEnvelope(this.binding, { kind: "ask_closed", requestId, reason }) });
  }
  report(message, { messageId = `msg-${++this.dialogCounter}` } = {}) {
    this.notifications++;
    this.record({ type: "extension_ui_request", id: `notify-${this.notifications}`, method: "notify",
      message: encodeCoordinationEnvelope(this.binding, { kind: "report", messageId, message }) });
    return messageId;
  }
  respond(command, data, error) {
    this.record({ type: "response", command: command.type, id: command.id, success: error === undefined, ...(error === undefined ? { data } : { error }) });
  }
  record(record) { this.stdout.write(JSON.stringify(record) + "\n"); }
  assistant(text = "finished", stopReason = "stop", errorMessage) {
    this.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } });
  }
  settle(text = "finished", stopReason = "stop", errorMessage) {
    this.assistant(text, stopReason, errorMessage);
    this.record({ type: "agent_end", willRetry: false, messages: [] });
    this.record({ type: "agent_settled" });
  }
  exit(code = 0, signal) {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end(); this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  kill(signal) { this.signals.push(signal); if (this.stubborn) return true; this.exit(null, signal); return true; }
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
export async function eventually(check, label = "observable condition") {
  for (let i = 0; i < 200; i++) { if (await check()) return; await tick(); }
  throw new Error(`Timed out waiting for ${label}`);
}
