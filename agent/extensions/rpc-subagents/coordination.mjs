import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export const PARENT_TOOL_NAME = "rpc_subagents_parent";
export const BOOTSTRAP_COMMAND_NAME = "rpc-subagents-bootstrap";
export const BOOTSTRAP_PROMPT = `/${BOOTSTRAP_COMMAND_NAME}`;
export const COORDINATION_PREFIX = "rpc-subagents-coordination:";
export const COORDINATION_VERSION = 1;
export const DEFAULT_EXECUTION_TOOLS = Object.freeze(["read", "write", "edit", "bash", "codemode"]);
export const COORDINATION_LIMITS = Object.freeze({
  maxTools: 64,
  maxToolNameChars: 160,
  maxTextChars: 8192,
  maxAnswerChars: 65536,
  maxPendingRequests: 16,
  maxReports: 64,
  maxPendingLimit: 64,
  minAskTimeoutMs: 1000,
  maxAskTimeoutMs: 120000,
  defaultAskTimeoutMs: 120000,
  maxIdentityChars: 160,
  maxSessionReferenceChars: 4096,
  maxWebTools: 16,
  maxInventoryTools: 81,
  maxEnvelopeChars: 65536,
});

const toolNamePattern = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const exposures = new Set(["direct", "model-only", "codemode", "deferred", "hidden"]);
const closedReasons = new Set(["answered", "cancelled", "timeout", "aborted", "failed"]);
const messageFields = {
  inventory: ["inventory"],
  ask: ["requestId", "question", "expiresAt"],
  report: ["messageId", "message"],
  ask_closed: ["requestId", "reason"],
};

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${name} has unsupported fields`);
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function string(value, name, max, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || value.includes("\0")) {
    throw new Error(`${name} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${max} characters without NUL`);
  }
  return value;
}

function identity(value, name) {
  const result = string(value, name, COORDINATION_LIMITS.maxIdentityChars);
  if (!identityPattern.test(result)) throw new Error(`${name} must be a literal identity`);
  return result;
}

function requestId(value) {
  const result = identity(value, "requestId");
  if (!/^ask-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new Error("requestId must use the ask- namespace");
  return result;
}

function toolName(value, name) {
  const result = string(value, name, COORDINATION_LIMITS.maxToolNameChars);
  if (!toolNamePattern.test(result)) throw new Error(`${name} must be a literal tool name`);
  return result;
}

function names(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} names`);
  const result = [];
  const seen = new Set();
  for (const valueName of value) {
    const item = toolName(valueName, name);
    if (seen.has(item)) throw new Error(`${name} contains duplicate tool ${item}`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function normalizeTools(value = DEFAULT_EXECUTION_TOOLS) {
  const result = names(value, "tools", COORDINATION_LIMITS.maxTools);
  if (result.some((name) => name.startsWith("rpc_subagents_") || name === BOOTSTRAP_COMMAND_NAME)) {
    throw new Error("tools must not include reserved fleet control names");
  }
  return result;
}

export function normalizeSessionReference(value) {
  const result = string(value, "session", COORDINATION_LIMITS.maxSessionReferenceChars);
  if (result.trim() !== result || /[\u0000-\u001f\u007f*?\[\]{}]/.test(result)) throw new Error("session must be a literal identity or absolute .jsonl path");
  if (result.length <= COORDINATION_LIMITS.maxIdentityChars && identityPattern.test(result)) return result;
  if (isAbsolute(result) && result.endsWith(".jsonl")) return result;
  throw new Error("session must be a literal identity or absolute .jsonl path");
}

export function normalizeCoordinationText(value, name = "message") {
  return string(value, name, COORDINATION_LIMITS.maxTextChars);
}

export function normalizeParentCall(value) {
  object(value, "parent call");
  if (value.kind === "ask") {
    exactKeys(value, ["kind", "question", "timeoutMs"], "parent call");
    return { kind: "ask", question: normalizeCoordinationText(value.question, "question"),
      timeoutMs: integer(value.timeoutMs === undefined ? COORDINATION_LIMITS.defaultAskTimeoutMs : value.timeoutMs,
        "timeoutMs", COORDINATION_LIMITS.minAskTimeoutMs, COORDINATION_LIMITS.maxAskTimeoutMs) };
  }
  if (value.kind === "report") {
    exactKeys(value, ["kind", "message"], "parent call");
    return { kind: "report", message: normalizeCoordinationText(value.message) };
  }
  throw new Error("parent call kind must be ask or report");
}

export function normalizeParentAnswer(value) {
  object(value, "answer");
  if (Object.hasOwn(value, "cancelled")) {
    exactKeys(value, ["cancelled"], "answer");
    if (value.cancelled !== true) throw new Error("answer.cancelled must be true");
    return { cancelled: true };
  }
  exactKeys(value, ["value"], "answer");
  return { value: string(value.value, "answer.value", COORDINATION_LIMITS.maxAnswerChars, true) };
}

export function normalizePendingOptions(value = {}) {
  exactKeys(value, ["after", "limit"], "pending options");
  return { after: integer(value.after === undefined ? 0 : value.after, "after", 0, Number.MAX_SAFE_INTEGER),
    limit: integer(value.limit === undefined ? 32 : value.limit, "limit", 1, COORDINATION_LIMITS.maxPendingLimit) };
}

export function createCoordinationRequestId() {
  return `ask-${randomUUID()}`;
}

export function validateToolInventory(value) {
  exactKeys(value, ["registered", "active", "declared", "callable", "exposures", "webTools"], "inventory");
  const registered = names(value.registered, "inventory.registered", COORDINATION_LIMITS.maxInventoryTools);
  const active = names(value.active, "inventory.active", COORDINATION_LIMITS.maxInventoryTools);
  const declared = names(value.declared, "inventory.declared", COORDINATION_LIMITS.maxInventoryTools);
  const callable = names(value.callable, "inventory.callable", COORDINATION_LIMITS.maxInventoryTools);
  const rawExposures = object(value.exposures, "inventory.exposures");
  const exposureNames = names(Object.keys(rawExposures), "inventory.exposures", COORDINATION_LIMITS.maxInventoryTools);
  const registeredSet = new Set(registered);
  const activeSet = new Set(active);
  const declaredSet = new Set(declared);
  const callableSet = new Set(callable);
  for (const name of [...active, ...declared, ...callable, ...exposureNames]) {
    if (!registeredSet.has(name)) throw new Error(`Inventory tool ${name} is not registered`);
  }
  if (active.length !== declared.length || active.some((name) => !declaredSet.has(name))) throw new Error("Inventory active and declared tools must match");
  const entries = registered.map((name) => {
    if (!Object.hasOwn(rawExposures, name) || !exposures.has(rawExposures[name])) throw new Error(`Missing or invalid exposure for ${name}`);
    const exposure = rawExposures[name];
    if (exposure === "hidden" && activeSet.has(name)) throw new Error(`Hidden tool ${name} cannot be declared`);
    const expectedCallable = exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && activeSet.has(name));
    if (expectedCallable !== callableSet.has(name)) throw new Error(`Callable inventory disagrees with exposure for ${name}`);
    return [name, exposure];
  });
  const webTools = value.webTools === undefined ? undefined : names(value.webTools, "inventory.webTools", COORDINATION_LIMITS.maxWebTools);
  if (webTools?.some((name) => !registeredSet.has(name))) throw new Error("Web inventory must be a subset of registered tools");
  return { registered, active, declared, callable, exposures: Object.fromEntries(entries),
    ...(webTools === undefined ? {} : { webTools }) };
}

export function verifyCapabilities(requested, inventory, webAccess = false, approvedWebTools) {
  const tools = normalizeTools(requested);
  const normalized = validateToolInventory(inventory);
  const reachable = [...new Set([...normalized.declared, ...normalized.callable])].sort();
  const reachableSet = new Set(reachable);
  const webTools = normalized.webTools ?? [];
  if (!webAccess && webTools.length) throw new Error("Unexpected web capability when webAccess is disabled");
  if (webAccess) {
    if (webTools.some((name) => normalized.exposures[name] !== "direct")) throw new Error("Web tools must retain direct exposure");
    if (!webTools.length) throw new Error("Web access requested but no installed web tools were captured");
    const reserved = new Set([...DEFAULT_EXECUTION_TOOLS, "grep", "find", "ls", ...tools, PARENT_TOOL_NAME, BOOTSTRAP_COMMAND_NAME]);
    if (webTools.some((name) => reserved.has(name) || name.startsWith("rpc_subagents_"))) throw new Error("Web tool collision with requested or reserved tools");
    if (approvedWebTools && (webTools.length !== approvedWebTools.length || webTools.some((name) => !approvedWebTools.includes(name)))) {
      throw new Error("Web tool family changed after bootstrap");
    }
    if (!webTools.some((name) => reachableSet.has(name))) throw new Error("Web access has no reachable loader or eager tools");
  }
  const expected = new Set([...tools, PARENT_TOOL_NAME]);
  const allowed = new Set([...expected, ...(webAccess ? webTools : [])]);
  const missing = [...expected].filter((name) => !reachableSet.has(name)).sort();
  const unexpected = [...new Set([...reachable, ...(webAccess ? normalized.registered : [])])].filter((name) => !allowed.has(name)).sort();
  if (missing.length || unexpected.length) throw new Error(`Capability mismatch: missing [${missing.join(", ")}]; unexpected [${unexpected.join(", ")}]`);
  if (normalized.exposures[PARENT_TOOL_NAME] !== "model-only" || !normalized.declared.includes(PARENT_TOOL_NAME)) {
    throw new Error(`${PARENT_TOOL_NAME} must be declared with model-only exposure`);
  }
  return { requested: tools, ...normalized, reachable };
}

function binding(value) {
  exactKeys(value, ["taskId", "ownerId", "nonce"], "launch binding");
  return { taskId: identity(value.taskId, "taskId"), ownerId: identity(value.ownerId, "ownerId"), nonce: identity(value.nonce, "nonce") };
}

function message(value) {
  object(value, "coordination message");
  if (!Object.hasOwn(messageFields, value.kind)) throw new Error("Unknown coordination kind");
  exactKeys(value, ["kind", ...messageFields[value.kind]], "coordination message");
  switch (value.kind) {
    case "inventory": return { kind: "inventory", inventory: validateToolInventory(value.inventory) };
    case "ask": return { kind: "ask", requestId: requestId(value.requestId), question: normalizeCoordinationText(value.question, "question"),
      expiresAt: integer(value.expiresAt, "expiresAt", 1, Number.MAX_SAFE_INTEGER) };
    case "report": return { kind: "report", messageId: identity(value.messageId, "messageId"), message: normalizeCoordinationText(value.message) };
    case "ask_closed":
      if (!closedReasons.has(value.reason)) throw new Error("Invalid ask_closed reason");
      return { kind: "ask_closed", requestId: requestId(value.requestId), reason: value.reason };
  }
}

export function encodeCoordinationEnvelope(launchBinding, coordinationMessage) {
  const envelope = { version: COORDINATION_VERSION, ...binding(launchBinding), ...message(coordinationMessage) };
  const encoded = COORDINATION_PREFIX + JSON.stringify(envelope);
  if (encoded.length > COORDINATION_LIMITS.maxEnvelopeChars) throw new Error("Coordination envelope exceeds character limit");
  return encoded;
}

export function decodeCoordinationEnvelope(value, launchBinding) {
  const expected = binding(launchBinding);
  if (typeof value !== "string" || !value.startsWith(COORDINATION_PREFIX)) return null;
  if (value.length > COORDINATION_LIMITS.maxEnvelopeChars) throw new Error("Coordination envelope exceeds character limit");
  let envelope;
  try { envelope = JSON.parse(value.slice(COORDINATION_PREFIX.length)); }
  catch { throw new Error("Invalid coordination JSON"); }
  if (!envelope || envelope.version !== COORDINATION_VERSION || !Object.hasOwn(messageFields, envelope.kind)) return null;
  if (envelope.taskId !== expected.taskId || envelope.ownerId !== expected.ownerId || envelope.nonce !== expected.nonce) return null;
  exactKeys(envelope, ["version", "taskId", "ownerId", "nonce", "kind", ...messageFields[envelope.kind]], "coordination envelope");
  const rawMessage = Object.fromEntries(["kind", ...messageFields[envelope.kind]].map((key) => [key, envelope[key]]));
  return { version: COORDINATION_VERSION, ...expected, ...message(rawMessage) };
}

export function parseCoordinationRecord(record, launchBinding) {
  if (!record || record.type !== "extension_ui_request" || !["notify", "input"].includes(record.method)) return null;
  const envelope = decodeCoordinationEnvelope(record.method === "notify" ? record.message : record.title, launchBinding);
  if (!envelope) return null;
  if (record.method === "notify") {
    if (envelope.kind === "ask") throw new Error("Coordination ask requires input transport");
    return { method: "notify", envelope };
  }
  if (envelope.kind !== "ask") throw new Error("Only coordination ask may use input transport");
  const nativeDialogId = identity(record.id, "nativeDialogId");
  if (nativeDialogId === envelope.requestId) throw new Error("Coordination requestId must differ from native dialog ID");
  return { method: "input", nativeDialogId, envelope };
}
