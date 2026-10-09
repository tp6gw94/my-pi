import { isAbsolute, resolve } from "node:path";
import { normalizeTools, normalizeSessionReference } from "./coordination.mjs";
import { readWebCatalog } from "./web-policy.mjs";
import { resolveTaskCapabilities } from "./capability.mjs";

export { normalizeTools, normalizeSessionReference } from "./coordination.mjs";

export const terminalTaskStates = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const terminalScheduleStates = new Set(["cancelled", "completed", "missed"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const transitions = {
  queued: new Set(["starting", "cancelling", "failed"]),
  starting: new Set(["running", "waiting_input", "cancelling", "completed", "failed", "cancelled"]),
  running: new Set(["waiting_input", "cancelling", "completed", "failed", "cancelled"]),
  waiting_input: new Set(["waiting_input", "starting", "running", "cancelling", "completed", "failed", "cancelled"]),
  cancelling: new Set(["cancelled", "interrupted", "failed"]),
};

export function assertTransition(previous, next) {
  if (previous === next) return;
  if (!transitions[previous]?.has(next)) throw new Error(`Invalid task transition: ${previous} -> ${next}`);
}

export function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}

export function nonempty(value, name, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

export function normalizeTaskSpec(input, defaults = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task spec must be an object");
  if (input.session !== undefined && input.context !== undefined) throw new Error("session and context are mutually exclusive");
  const session = input.session === undefined ? undefined : normalizeSessionReference(input.session);
  const model = input.model ?? defaults.model;
  if (!model) throw new Error("No current model. Specify model.provider and model.id explicitly.");
  const context = input.context ?? "fresh";
  if (context !== "fresh" && context !== "fork") throw new Error("context must be fresh or fork");
  const thinking = input.thinking ?? defaults.thinking ?? "off";
  if (!thinkingLevels.has(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
  const cwd = nonempty(input.cwd ?? defaults.cwd, "cwd");
  const asynchronous = input.async ?? false;
  if (typeof asynchronous !== "boolean") throw new Error("async must be boolean");
  const resolved = resolveTaskCapabilities({ tools: input.tools, webAccess: input.webAccess, webTools: input.webTools, webToolSlots: input.webToolSlots },
    () => readWebCatalog());
  return {
    webAccess: resolved.webAccess,
    webTools: resolved.webTools,
    ...(resolved.webToolSlots === undefined ? {} : { webToolSlots: resolved.webToolSlots }),
    prompt: nonempty(input.prompt, "prompt", 262144),
    name: nonempty(input.name ?? "RPC task", "name", 160),
    cwd: isAbsolute(cwd) ? resolve(cwd) : resolve(defaults.cwd ?? process.cwd(), cwd),
    model: { provider: nonempty(model.provider, "model.provider", 160), id: nonempty(model.id, "model.id", 512) },
    thinking,
    ...(session === undefined ? { context } : { session }),
    tools: resolved.tools,
    async: asynchronous,
    timeoutMs: boundedInteger(input.timeoutMs ?? defaults.timeoutMs ?? 1800000, "timeoutMs", 100, 86400000),
  };
}

export function defer() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

export function abortError(reason = "Operation cancelled") {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

export function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

export function boundedText(text, limit = 65536) {
  return { text: String(text).slice(0, limit), truncated: String(text).length > limit };
}
