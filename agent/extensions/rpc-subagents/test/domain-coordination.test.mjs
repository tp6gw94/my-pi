import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTaskSpec, normalizeTools, normalizeSessionReference, assertTransition, boundedText, textContent } from "../domain.mjs";
import { parseToolExpression, resolveTaskCapabilities } from "../capability.mjs";
import { readWebCatalog } from "../web-policy.mjs";
import {
  normalizeCoordinationText, normalizeParentCall, normalizeParentAnswer, normalizePendingOptions,
  createCoordinationRequestId, encodeCoordinationEnvelope, decodeCoordinationEnvelope,
  parseCoordinationRecord, validateToolInventory, verifyCapabilities,
} from "../coordination.mjs";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "rpc-subagents-domain-missing-config");
const defaultFamily = ["web_search", "source_check", "fetch_content", "get_search_content"];
const defaultSlots = { web_search: "webSearch", source_check: "sourceCheck", fetch_content: "fetchContent", get_search_content: "getSearchContent" };

const defaults = { cwd: "/project", model: { provider: "test", id: "model" } };
const launch = { taskId: "task-1", ownerId: "owner-1", nonce: "launch-1" };
const wire = (envelope) => "rpc-subagents-coordination:" + JSON.stringify(envelope);
const privateEnvelope = (message, extra = {}) => ({ version: 1, ...launch, ...message, ...extra });
const inventory = (extra = {}) => ({
  registered: ["read", "rpc_subagents_parent"], active: ["read", "rpc_subagents_parent"],
  declared: ["read", "rpc_subagents_parent"], callable: ["read"],
  exposures: { read: "direct", rpc_subagents_parent: "model-only" }, ...extra,
});
const ask = { kind: "ask", requestId: "ask-request-1", question: "May I continue?", expiresAt: 1700000001000 };

test("legacy and persisted task specs gain the exact execution defaults without changing fresh/fork behavior", () => {
  assert.deepEqual(normalizeTaskSpec({ prompt: "Inspect" }, defaults), {
    prompt: "Inspect", name: "RPC task", cwd: "/project", model: { provider: "test", id: "model" },
    webAccess: true, webTools: defaultFamily, webToolSlots: defaultSlots, thinking: "off", context: "fresh", tools: ["read", "write", "edit", "bash", "codemode"], async: false, timeoutMs: 1800000,
  });
  const persisted = { prompt: "Inspect", name: "Saved", cwd: "/project", model: { provider: "test", id: "model" },
    thinking: "high", context: "fork", async: true, timeoutMs: 1000 };
  const normalized = normalizeTaskSpec(persisted);
  assert.deepEqual(normalized, { ...persisted, webAccess: true, webTools: defaultFamily, webToolSlots: defaultSlots, tools: ["read", "write", "edit", "bash", "codemode"] });
  assert.deepEqual(normalizeTaskSpec(normalized), { ...persisted, webAccess: true, webTools: defaultFamily, webToolSlots: defaultSlots, tools: ["read", "write", "edit", "bash", "codemode"] });
  assert.equal(Object.hasOwn(persisted, "tools"), false);
});

test("signed adjustments fold onto the fixed execution defaults in order and partition web selections", () => {
  const inspect = (tools, extra = {}) => normalizeTaskSpec({ prompt: "Inspect", tools, ...extra }, defaults);
  assert.deepEqual(inspect(["+bash", "-codemode", "+web_search"]).tools, ["read", "write", "edit", "bash"]);
  assert.deepEqual(inspect(["+bash", "-codemode", "+web_search"]).webTools, ["web_search"]);
  assert.deepEqual(inspect(["-read", "+read", "+read", "-absent"]).tools, ["write", "edit", "bash", "codemode", "read"]);
  assert.deepEqual(inspect(["+fetch_content", "-fetch_content"]).webTools, []);
  assert.equal(inspect(["+fetch_content", "-fetch_content"]).webAccess, false);
  assert.deepEqual(inspect(["+fetch_content"]).webTools, ["fetch_content"]);
  assert.deepEqual(inspect(["+fetch_content"]).tools, ["read", "write", "edit", "bash", "codemode"]);
  assert.deepEqual(inspect(["read", "fetch_content"]).tools, ["read"]);
  assert.deepEqual(inspect(["read", "fetch_content"]).webTools, ["fetch_content"]);
  assert.equal(inspect(["read"]).webAccess, false);
  assert.deepEqual(inspect(["read"], { webAccess: false }).webTools, []);
  assert.deepEqual(inspect(["read"], { webAccess: true }).webTools, defaultFamily);
  assert.deepEqual(inspect(undefined, { webAccess: false }).webTools, []);
  assert.deepEqual(inspect([], { webAccess: true }).webTools, defaultFamily);
  assert.deepEqual(inspect([], { webAccess: true }).tools, []);
  assert.deepEqual(inspect(["+web_search", "+source_check", "+fetch_content", "+get_search_content"], { webAccess: true }).webTools, defaultFamily);
  assert.throws(() => inspect(["+web_search", "+fetch_content"], { webAccess: true }), /contradicts/);
});

test("selection syntax rejects mixed, empty, wildcard, reserved, duplicate and contradictory inputs", () => {
  const inspect = (tools, extra = {}) => normalizeTaskSpec({ prompt: "Inspect", tools, ...extra }, defaults);
  for (const tools of [["+read", "bash"], ["+read", "-"], ["+"], ["*"], ["read*"], ["+*"], ["read", "read"], ["rpc_subagents_parent"], ["+rpc_subagents_reply"], ["web_enable"], ["+web_enable"]]) {
    assert.throws(() => inspect(tools), /tools|web_enable|duplicate|reserved|literal|wildcard/i, JSON.stringify(tools));
  }
  assert.throws(() => inspect(["read"], { webAccess: "yes" }), /webAccess must be boolean/);
  assert.throws(() => inspect(["read", "fetch_content"], { webAccess: false }), /contradicts/);
  assert.throws(() => inspect(["read", "fetch_content"], { webAccess: true }), /contradicts/);
  assert.throws(() => inspect(["fetch_content"], { webAccess: true }), /contradicts/);
  assert.deepEqual(inspect(["read", "web_search", "source_check", "fetch_content", "get_search_content"], { webAccess: true }).webTools, defaultFamily);
  const canonical = { prompt: "Inspect", tools: ["read"], webTools: ["web_search"], webAccess: true, cwd: "/project", model: { provider: "test", id: "model" } };
  assert.deepEqual(normalizeTaskSpec(canonical), { ...canonical, webToolSlots: { web_search: "webSearch" }, thinking: "off", name: "RPC task", context: "fresh", async: false, timeoutMs: 1800000 });
  assert.throws(() => normalizeTaskSpec({ ...canonical, webAccess: false }), /contradicts/);
  assert.throws(() => normalizeTaskSpec({ ...canonical, tools: undefined }), /explicit tools/);
  assert.throws(() => normalizeTaskSpec({ ...canonical, webTools: ["web_enable"], webAccess: true, tools: [] }), /machinery/);
});

test("catalogue renames select the current name and fail closed on renamed-away or disabled names", () => {
  const catalog = readWebCatalog({ PI_CODING_AGENT_DIR: join(tmpdir(), "rpc-subagents-domain-missing-config") }, tmpdir());
  const renamed = { ...catalog, slots: catalog.slots.map((slot) => slot.key === "fetchContent" ? { ...slot, name: "get_page" } : slot),
    enabled: catalog.enabled.map((name) => name === "fetch_content" ? "get_page" : name),
    reserved: new Set([...catalog.reserved, "get_page"]) };
  assert.deepEqual(resolveTaskCapabilities({ tools: ["+get_page"] }, () => renamed).webTools, ["get_page"]);
  assert.throws(() => resolveTaskCapabilities({ tools: ["+fetch_content"] }, () => renamed), /disabled or renamed/);
  assert.deepEqual(resolveTaskCapabilities({ tools: ["+read", "-fetch_content"] }, () => renamed).webTools, []);
  const disabled = { ...catalog, enabled: catalog.enabled.filter((name) => name !== "source_check") };
  assert.throws(() => resolveTaskCapabilities({ tools: ["+source_check"] }, () => disabled), /disabled or renamed/);
  assert.throws(() => resolveTaskCapabilities({ tools: ["+source_check"] }, () => ({ ...catalog, enabled: [] })), /disabled or renamed/);
  assert.throws(() => resolveTaskCapabilities({ tools: undefined, webAccess: true }, () => ({ ...catalog, enabled: [] })), /all installed web tools are disabled/);
  const never = () => { throw new Error("web configuration must not be read"); };
  for (const input of [{ tools: [] }, { tools: [], webAccess: false }, { tools: ["read"] }, { tools: ["+bash", "-edit", "-codemode"] }]) {
    const resolved = resolveTaskCapabilities(input, never);
    assert.deepEqual(resolved.webTools, []);
    assert.equal(resolved.webAccess, false);
  }
  assert.throws(() => resolveTaskCapabilities({ tools: ["+get_page"] }, never), /must not be read/);
  const bound = resolveTaskCapabilities({ tools: ["+get_page"] }, () => renamed);
  assert.deepEqual(bound.webToolSlots, { get_page: "fetchContent" });
  assert.deepEqual(resolveTaskCapabilities({ tools: ["read"], webTools: ["get_page"], webToolSlots: bound.webToolSlots }, () => renamed).webToolSlots, { get_page: "fetchContent" });
  const reassigned = { ...renamed, slots: renamed.slots.map((slot) => slot.name === "get_page" ? { ...slot, key: "webSearch" } : slot) };
  assert.throws(() => resolveTaskCapabilities({ tools: ["read"], webTools: ["get_page"], webToolSlots: bound.webToolSlots }, () => reassigned), /rename or reassignment/);
  assert.throws(() => resolveTaskCapabilities({ tools: ["read"], webTools: ["get_page"], webToolSlots: { get_page: "fetchContent", extra: "webSearch" } }, () => renamed), /exactly match/);
  const expression = parseToolExpression(["+read", "-bash"]);
  assert.deepEqual(expression.ops.map((op) => [op.op, op.name]), [["add", "read"], ["remove", "bash"]]);
  assert.equal(parseToolExpression(undefined).form, "omitted");
  assert.deepEqual(parseToolExpression([]), { form: "replace", names: [] });
});

test("custom execution tools replace defaults, preserve ordering and empty arrays, and are copied", () => {
  const requested = ["custom.inspect", "mcp__project_read", "codemode"];
  const spec = normalizeTaskSpec({ prompt: "Inspect", tools: requested }, defaults);
  requested.push("write");
  assert.deepEqual(spec.tools, ["custom.inspect", "mcp__project_read", "codemode"]);
  assert.deepEqual(normalizeTaskSpec({ prompt: "Inspect", tools: [] }, defaults).tools, []);
  const firstDefault = normalizeTools();
  firstDefault.push("extra");
  assert.deepEqual(normalizeTools(), ["read", "write", "edit", "bash", "codemode"]);
});

test("tool normalization accepts bounded extension names and rejects malformed, reserved and duplicate loadouts", () => {
  assert.deepEqual(normalizeTools(["namespace:inspect", "tool-v2", "_private", "A".repeat(160)]),
    ["namespace:inspect", "tool-v2", "_private", "A".repeat(160)]);
  assert.equal(normalizeTools(Array.from({ length: 64 }, (_, index) => `tool_${index}`)).length, 64);
  for (const name of ["", " ", " read", "read ", "read,write", "read\0", "read*", "read?", "[read]", "{read}", "a/b", "a\nb", "x".repeat(161)]) {
    assert.throws(() => normalizeTools([name]), /tools/, JSON.stringify(name));
  }
  for (const name of ["rpc_subagents_parent", "rpc_subagents_reply", "rpc_subagents_pending", "rpc_subagents_steer", "rpc_subagents_run", "rpc-subagents-bootstrap"]) {
    assert.throws(() => normalizeTools([name]), /reserved/);
  }
  assert.throws(() => normalizeTools(["read", "read"]), /duplicate/);
  assert.throws(() => normalizeTools(Array.from({ length: 65 }, (_, index) => `tool_${index}`)), /at most 64/);
  for (const value of [null, "read", {}, [3]]) assert.throws(() => normalizeTools(value), /tools/);
});

test("resume preserves an exact identity or path and stays idempotent without synthesizing context", () => {
  const result = normalizeTaskSpec({ prompt: "Continue", session: "session-1", tools: [], async: true }, defaults);
  assert.deepEqual(result, {
    prompt: "Continue", name: "RPC task", cwd: "/project", model: { provider: "test", id: "model" },
    webAccess: false, webTools: [], thinking: "off", session: "session-1", tools: [], async: true, timeoutMs: 1800000,
  });
  assert.deepEqual(normalizeTaskSpec(result), result);
  assert.equal(Object.hasOwn(result, "context"), false);
  assert.equal(normalizeTaskSpec({ prompt: "Continue", session: "/fleet/space dir/../session.jsonl" }, defaults).session,
    "/fleet/space dir/../session.jsonl");
  for (const context of ["fresh", "fork", null, "invalid"]) {
    assert.throws(() => normalizeTaskSpec({ prompt: "Continue", session: "session-1", context }, defaults), /mutually exclusive/);
  }
});

test("session references are bounded positive literal identities or absolute jsonl paths", () => {
  assert.equal(normalizeSessionReference("abc123"), "abc123");
  assert.equal(normalizeSessionReference("s".repeat(160)).length, 160);
  assert.equal(normalizeSessionReference("/fleet/中文/session.jsonl"), "/fleet/中文/session.jsonl");
  assert.equal(normalizeSessionReference("/" + "x".repeat(4089) + ".jsonl").length, 4096);
  for (const reference of [null, {}, [], 1, "", " ", ".", "..", "s".repeat(161), "session.jsonl", "./session.jsonl",
    "~/session.jsonl", "file:///fleet/session.jsonl", "session-1 ", "/fleet/session", "/fleet/*.jsonl", "/fleet/[a].jsonl",
    "/fleet/a\0.jsonl", "/fleet/a\n.jsonl", "/" + "x".repeat(4090) + ".jsonl"]) {
    assert.throws(() => normalizeSessionReference(reference), /session/);
  }
  assert.throws(() => normalizeTaskSpec({ prompt: "Continue", session: null }, defaults), /session/);
});

test("existing normalized task fields, domain helpers and input errors remain observable", () => {
  assert.deepEqual(normalizeTaskSpec({ prompt: "Inspect", cwd: "child", thinking: "max", context: "fork", timeoutMs: 100, tools: ["read"] }, defaults), {
    prompt: "Inspect", name: "RPC task", cwd: "/project/child", model: { provider: "test", id: "model" },
    webAccess: false, webTools: [], thinking: "max", context: "fork", tools: ["read"], async: false, timeoutMs: 100,
  });
  for (const bad of [{ async: "true" }, { thinking: "unlimited" }, { timeoutMs: 99 }, { context: "resume" }, { prompt: "" }]) {
    assert.throws(() => normalizeTaskSpec({ prompt: "Inspect", ...bad }, defaults));
  }
  assert.throws(() => normalizeTaskSpec(null, defaults), /object/);
  assert.throws(() => normalizeTaskSpec({ prompt: "Inspect", cwd: "/project" }), /No current model/);
  assertTransition("queued", "starting");
  assert.throws(() => assertTransition("completed", "running"), /Invalid task transition/);
  assert.equal(textContent([{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }]), "one\ntwo");
  assert.deepEqual(boundedText("abcdef", 3), { text: "abc", truncated: true });
});

test("parent calls normalize ask deadlines and reports without exposing routing fields", () => {
  assert.deepEqual(normalizeParentCall({ kind: "ask", question: "Choose A or B?" }),
    { kind: "ask", question: "Choose A or B?", timeoutMs: 120000 });
  assert.deepEqual(normalizeParentCall({ kind: "ask", question: "Choose A?", timeoutMs: 1000 }),
    { kind: "ask", question: "Choose A?", timeoutMs: 1000 });
  assert.deepEqual(normalizeParentCall({ kind: "report", message: "Inspection complete." }), { kind: "report", message: "Inspection complete." });
  for (const timeoutMs of [999, 120001, 1000.5, null, "1000"]) {
    assert.throws(() => normalizeParentCall({ kind: "ask", question: "Choose?", timeoutMs }), /timeoutMs/);
  }
  for (const field of ["destination", "childId", "taskId", "ownerId", "nonce"]) {
    assert.throws(() => normalizeParentCall({ kind: "ask", question: "Choose?", [field]: "other" }), /unsupported fields/);
    assert.throws(() => normalizeParentCall({ kind: "report", message: "Done", [field]: "other" }), /unsupported fields/);
  }
  assert.throws(() => normalizeParentCall({ kind: "report", message: "Done", timeoutMs: 1000 }), /unsupported/);
  assert.throws(() => normalizeParentCall({ kind: "steer", message: "Done" }), /kind/);
});

test("coordination text and explicit answers retain Unicode, empty answers and cancellation with bounded payloads", () => {
  assert.equal(normalizeCoordinationText("中文\nDone"), "中文\nDone");
  assert.equal(normalizeCoordinationText("x".repeat(8192)).length, 8192);
  assert.deepEqual(normalizeParentAnswer({ value: "" }), { value: "" });
  assert.deepEqual(normalizeParentAnswer({ value: "Use A." }), { value: "Use A." });
  assert.deepEqual(normalizeParentAnswer({ cancelled: true }), { cancelled: true });
  assert.equal(normalizeParentAnswer({ value: "x".repeat(65536) }).value.length, 65536);
  for (const message of ["", " ", "x\0y", "x".repeat(8193), 3]) {
    assert.throws(() => normalizeParentCall({ kind: "report", message }), /message/);
    assert.throws(() => normalizeParentCall({ kind: "ask", question: message }), /question/);
  }
  for (const answer of [{}, { confirmed: true }, { cancelled: false }, { value: "yes", cancelled: true },
    { value: null }, { value: "x\0y" }, { value: "x".repeat(65537) }, { value: "yes", destination: "other" }]) {
    assert.throws(() => normalizeParentAnswer(answer), /answer/);
  }
});

test("pending cursors and limits are bounded with deterministic defaults", () => {
  assert.deepEqual(normalizePendingOptions(), { after: 0, limit: 32 });
  assert.deepEqual(normalizePendingOptions({ after: 12, limit: 64 }), { after: 12, limit: 64 });
  assert.deepEqual(normalizePendingOptions({ after: 0, limit: 1 }), { after: 0, limit: 1 });
  for (const options of [{ after: -1 }, { after: 0.5 }, { after: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 65 }, { limit: "32" }, { after: null }, { taskId: "other" }, null]) {
    assert.throws(() => normalizePendingOptions(options), /pending options|after|limit/);
  }
});

test("reports encode into a private versioned envelope bound to a single launch", () => {
  const encoded = encodeCoordinationEnvelope(launch, { kind: "report", messageId: "report-1", message: "Done." });
  assert.equal(encoded, 'rpc-subagents-coordination:{"version":1,"taskId":"task-1","ownerId":"owner-1","nonce":"launch-1","kind":"report","messageId":"report-1","message":"Done."}');
  assert.deepEqual(decodeCoordinationEnvelope(encoded, launch), {
    version: 1, taskId: "task-1", ownerId: "owner-1", nonce: "launch-1", kind: "report", messageId: "report-1", message: "Done.",
  });
  for (const field of ["taskId", "ownerId", "nonce"]) {
    assert.equal(decodeCoordinationEnvelope(encoded, { ...launch, [field]: "different" }), null);
  }
});

test("all coordination kinds round-trip through only their supported RPC UI methods", () => {
  assert.deepEqual(parseCoordinationRecord({ type: "extension_ui_request", method: "input", id: "native-dialog-1",
    title: encodeCoordinationEnvelope(launch, ask) }, launch), {
    method: "input", nativeDialogId: "native-dialog-1", envelope: {
      version: 1, taskId: "task-1", ownerId: "owner-1", nonce: "launch-1", kind: "ask", requestId: "ask-request-1",
      question: "May I continue?", expiresAt: 1700000001000,
    },
  });
  for (const reason of ["answered", "cancelled", "timeout", "aborted", "failed"]) {
    const closed = { kind: "ask_closed", requestId: "ask-request-1", reason };
    const parsed = parseCoordinationRecord({ type: "extension_ui_request", method: "notify", id: "native-notify-1",
      message: encodeCoordinationEnvelope(launch, closed) }, launch);
    assert.deepEqual(parsed, { method: "notify", envelope: privateEnvelope(closed) });
  }
  const report = { kind: "report", messageId: "report-1", message: "Progress" };
  assert.deepEqual(parseCoordinationRecord({ type: "extension_ui_request", method: "notify",
    message: encodeCoordinationEnvelope(launch, report) }, launch), { method: "notify", envelope: privateEnvelope(report) });
  assert.deepEqual(parseCoordinationRecord({ type: "extension_ui_request", method: "notify",
    message: encodeCoordinationEnvelope(launch, { kind: "inventory", inventory: inventory() }) }, launch), {
    method: "notify", envelope: { version: 1, taskId: "task-1", ownerId: "owner-1", nonce: "launch-1", kind: "inventory",
      inventory: { registered: ["read", "rpc_subagents_parent"], active: ["read", "rpc_subagents_parent"], declared: ["read", "rpc_subagents_parent"],
        callable: ["read"], exposures: { read: "direct", rpc_subagents_parent: "model-only" } } },
  });
});

test("ordinary notifications, dialogs, unrelated kinds, versions and nonces remain ordinary", () => {
  assert.deepEqual(decodeCoordinationEnvelope(encodeCoordinationEnvelope(launch, ask), launch), privateEnvelope(ask));
  for (const value of [undefined, "Permission?", JSON.stringify(privateEnvelope(ask)), "text " + wire(privateEnvelope(ask)),
    wire(privateEnvelope(ask, { version: 2 })), wire(privateEnvelope(ask, { version: "1" })),
    wire(privateEnvelope(ask, { kind: "other" })), wire(privateEnvelope(ask, { kind: "__proto__" })),
    wire(privateEnvelope(ask, { nonce: "old-launch" }))]) {
    assert.equal(decodeCoordinationEnvelope(value, launch), null);
  }
  for (const record of [{ type: "message_end", method: "input", title: wire(privateEnvelope(ask)) },
    { type: "extension_ui_request", method: "select", title: wire(privateEnvelope(ask)) },
    { type: "extension_ui_request", method: "confirm", title: "Permission?" },
    { type: "extension_ui_request", method: "input", title: "Permission?" },
    { type: "extension_ui_request", method: "notify", message: "Progress" }]) {
    assert.equal(parseCoordinationRecord(record, launch), null);
  }
});

test("malformed matching envelopes fail closed, including unbounded fields and extra routing data", () => {
  assert.throws(() => decodeCoordinationEnvelope("rpc-subagents-coordination:{", launch), /Invalid coordination JSON/);
  assert.throws(() => decodeCoordinationEnvelope("rpc-subagents-coordination:" + "x".repeat(65536), launch), /character limit/);
  for (const extra of [{ question: "" }, { question: "x".repeat(8193) }, { requestId: "native-dialog-1" },
    { requestId: "ask-" }, { expiresAt: 0 }, { expiresAt: 1.5 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { destination: "other" }, { childId: "other" }]) {
    assert.throws(() => decodeCoordinationEnvelope(wire(privateEnvelope(ask, extra)), launch));
  }
  for (const field of ["taskId", "ownerId", "nonce"]) {
    assert.throws(() => encodeCoordinationEnvelope({ ...launch, [field]: "x".repeat(161) }, ask), /at most 160/);
    assert.throws(() => encodeCoordinationEnvelope({ ...launch, [field]: "has space" }, ask), /literal identity/);
  }
  assert.throws(() => encodeCoordinationEnvelope(launch, { ...ask, taskId: "spoofed" }), /unsupported fields/);
  assert.throws(() => encodeCoordinationEnvelope(launch, { kind: "report", messageId: "report-1", message: "x".repeat(8193) }), /message/);
  assert.throws(() => encodeCoordinationEnvelope(launch, { kind: "report", messageId: "x".repeat(161), message: "Done" }), /messageId/);
  assert.throws(() => encodeCoordinationEnvelope(launch, { kind: "ask_closed", requestId: "ask-request-1", reason: "approved" }), /reason/);
});

test("coordination IDs cannot alias native dialog IDs or change transport kind", () => {
  assert.match(createCoordinationRequestId(), /^ask-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const askWire = encodeCoordinationEnvelope(launch, ask);
  assert.throws(() => parseCoordinationRecord({ type: "extension_ui_request", method: "input", id: "ask-request-1", title: askWire }, launch), /must differ/);
  assert.throws(() => parseCoordinationRecord({ type: "extension_ui_request", method: "input", id: "x".repeat(161), title: askWire }, launch), /nativeDialogId/);
  assert.throws(() => parseCoordinationRecord({ type: "extension_ui_request", method: "notify", message: askWire }, launch), /requires input/);
  const reportWire = encodeCoordinationEnvelope(launch, { kind: "report", messageId: "report-1", message: "Done" });
  assert.throws(() => parseCoordinationRecord({ type: "extension_ui_request", method: "input", id: "native-1", title: reportWire }, launch), /Only coordination ask/);
});

test("maximum text survives JSON escaping within the envelope bound", () => {
  const encoded = encodeCoordinationEnvelope(launch, { ...ask, question: "\u0001".repeat(8192) });
  const decoded = decodeCoordinationEnvelope(encoded, launch);
  assert.equal(decoded.question.length, 8192);
  assert.equal(decoded.question.charCodeAt(8191), 1);
  assert.equal(decoded.kind, "ask");
});

test("exact capability verification keeps the reserved parent control separate from requested execution tools", () => {
  assert.deepEqual(verifyCapabilities(["read"], [], inventory()), {
    requested: ["read"], registered: ["read", "rpc_subagents_parent"], active: ["read", "rpc_subagents_parent"],
    declared: ["read", "rpc_subagents_parent"], callable: ["read"], exposures: { read: "direct", rpc_subagents_parent: "model-only" },
    reachable: ["read", "rpc_subagents_parent"],
  });
  assert.deepEqual(verifyCapabilities([], [], { registered: ["rpc_subagents_parent"], active: ["rpc_subagents_parent"], declared: ["rpc_subagents_parent"],
    callable: [], exposures: { rpc_subagents_parent: "model-only" } }), {
    requested: [], registered: ["rpc_subagents_parent"], active: ["rpc_subagents_parent"], declared: ["rpc_subagents_parent"], callable: [],
    exposures: { rpc_subagents_parent: "model-only" }, reachable: ["rpc_subagents_parent"],
  });
});

test("the exact default tools are verified against inventory, not a built-in-only name enum", () => {
  assert.deepEqual(verifyCapabilities(undefined, [], {
    registered: ["read", "write", "edit", "bash", "codemode", "rpc_subagents_parent"],
    active: ["read", "write", "edit", "bash", "codemode", "rpc_subagents_parent"],
    declared: ["read", "write", "edit", "bash", "codemode", "rpc_subagents_parent"], callable: ["read", "write", "edit", "bash", "codemode"],
    exposures: { read: "direct", write: "direct", edit: "direct", bash: "direct", codemode: "direct", rpc_subagents_parent: "model-only" },
  }).reachable, ["bash", "codemode", "edit", "read", "rpc_subagents_parent", "write"]);
  assert.deepEqual(verifyCapabilities(["custom.inspect"], [], {
    registered: ["custom.inspect", "rpc_subagents_parent", "inactive", "hidden"], active: ["rpc_subagents_parent"], declared: ["rpc_subagents_parent"],
    callable: ["custom.inspect"], exposures: { "custom.inspect": "deferred", rpc_subagents_parent: "model-only", inactive: "direct", hidden: "hidden" },
  }).reachable, ["custom.inspect", "rpc_subagents_parent"]);
});

test("missing, extra callable and extra model-only tools reject even when the requested tool is present", () => {
  assert.throws(() => verifyCapabilities(["write"], [], inventory()), /missing \[write\]; unexpected \[read\]/);
  assert.throws(() => verifyCapabilities([], [], inventory()), /unexpected \[read\]/);
  assert.throws(() => verifyCapabilities(["read"], [], inventory({ registered: ["read", "rpc_subagents_parent", "extra"], callable: ["read", "extra"],
    exposures: { read: "direct", rpc_subagents_parent: "model-only", extra: "codemode" } })), /unexpected \[extra\]/);
  assert.throws(() => verifyCapabilities(["read"], [], inventory({ registered: ["read", "rpc_subagents_parent", "extra"],
    active: ["read", "rpc_subagents_parent", "extra"], declared: ["read", "rpc_subagents_parent", "extra"],
    exposures: { read: "direct", rpc_subagents_parent: "model-only", extra: "model-only" } })), /unexpected \[extra\]/);
  assert.throws(() => verifyCapabilities(["read"], [], { registered: ["read"], active: ["read"], declared: ["read"], callable: ["read"], exposures: { read: "direct" } }),
    /missing \[rpc_subagents_parent\]/);
  assert.throws(() => verifyCapabilities(["read"], [], inventory({ callable: ["read", "rpc_subagents_parent"],
    exposures: { read: "direct", rpc_subagents_parent: "direct" } })), /must be declared with model-only/);
});

test("inventory consistency catches omitted codemode/deferred reachability and unsupported exposure metadata", () => {
  assert.deepEqual(validateToolInventory(inventory({ active: ["rpc_subagents_parent", "read"] })).active, ["rpc_subagents_parent", "read"]);
  for (const exposure of ["codemode", "deferred"]) {
    assert.throws(() => validateToolInventory(inventory({ registered: ["read", "rpc_subagents_parent", "omitted"],
      exposures: { read: "direct", rpc_subagents_parent: "model-only", omitted: exposure } })), /Callable inventory disagrees.*omitted/);
  }
  const invalid = [
    inventory({ declared: ["rpc_subagents_parent"] }), inventory({ callable: [] }), inventory({ callable: ["read", "rpc_subagents_parent"] }),
    inventory({ registered: ["rpc_subagents_parent"] }), inventory({ active: ["read", "rpc_subagents_parent", "unknown"] }),
    inventory({ registered: ["read", "read", "rpc_subagents_parent"] }), inventory({ active: ["read", "read", "rpc_subagents_parent"] }),
    inventory({ declared: ["read", "read", "rpc_subagents_parent"] }), inventory({ callable: ["read", "read"] }),
    inventory({ exposures: { rpc_subagents_parent: "model-only" } }), inventory({ exposures: { read: "unknown", rpc_subagents_parent: "model-only" } }),
    inventory({ exposures: { read: "hidden", rpc_subagents_parent: "model-only" } }),
    inventory({ exposures: { read: "direct", rpc_subagents_parent: "model-only", unknown: "hidden" } }),
    inventory({ destination: "other" }), inventory({ callable: ["read*"] }), inventory({ registered: ["x".repeat(161)] }),
  ];
  for (const value of invalid) assert.throws(() => validateToolInventory(value), /[Ii]nventory|exposure|tool|at most/);
});

test("inventory lists and metadata reject oversized input while the maximum execution loadout fits its envelope", () => {
  const requested = Array.from({ length: 64 }, (_, index) => `tool_${index}_`.padEnd(160, "x"));
  const registered = [...requested, "rpc_subagents_parent"];
  const maximum = { registered, active: registered, declared: registered, callable: requested,
    exposures: Object.fromEntries([...requested.map((name) => [name, "direct"]), ["rpc_subagents_parent", "model-only"]]) };
  assert.equal(verifyCapabilities(requested, [], maximum).reachable.length, 65);
  const decoded = decodeCoordinationEnvelope(encodeCoordinationEnvelope(launch, { kind: "inventory", inventory: maximum }), launch);
  assert.equal(decoded.inventory.registered.length, 65);
  assert.equal(decoded.inventory.exposures.rpc_subagents_parent, "model-only");
  const tooMany = Array.from({ length: 82 }, (_, index) => `tool_${index}`);
  for (const field of ["registered", "active", "declared", "callable"]) {
    assert.throws(() => validateToolInventory(inventory({ [field]: tooMany })), /at most 81/);
  }
  assert.throws(() => validateToolInventory(inventory({ exposures: Object.fromEntries(tooMany.map((name) => [name, "hidden"])) })), /at most 81/);
});

test("capability copies and exposure records do not inherit tool names as object behavior", () => {
  const source = inventory();
  const capabilities = verifyCapabilities(["read"], [], source);
  source.callable.push("extra");
  source.exposures.read = "hidden";
  assert.deepEqual(capabilities.callable, ["read"]);
  assert.equal(capabilities.exposures.read, "direct");
  const special = verifyCapabilities(["__proto__"], [], {
    registered: ["__proto__", "rpc_subagents_parent"], active: ["__proto__", "rpc_subagents_parent"], declared: ["__proto__", "rpc_subagents_parent"],
    callable: ["__proto__"], exposures: Object.fromEntries([["__proto__", "direct"], ["rpc_subagents_parent", "model-only"]]),
  });
  assert.deepEqual(special.reachable, ["__proto__", "rpc_subagents_parent"]);
  assert.equal(Object.getPrototypeOf(special.exposures), Object.prototype);
  assert.equal(Object.hasOwn(special.exposures, "__proto__"), true);
});
