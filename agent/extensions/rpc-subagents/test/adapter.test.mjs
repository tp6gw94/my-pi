import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readSchedules, ScheduleManager } from "../schedules.mjs";
import { COORDINATION_LIMITS } from "../coordination.mjs";
import { safeText } from "../viewer.mjs";
import { projectKey } from "../store.mjs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const schema = {
  String: (options = {}) => ({ type: "string", ...options }), Number: () => ({ type: "number" }), Integer: (options = {}) => ({ type: "integer", ...options }),
  Boolean: () => ({ type: "boolean" }), Null: () => ({ type: "null" }), Literal: (value) => ({ const: value }),
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }), Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }), Optional: (value) => value, Record: (key, value) => ({ type: "object", key, additionalProperties: value }),
};
const moduleUrl = new URL("../index.ts", import.meta.url).href;
const source = stripTypeScriptTypes(await readFile(new URL(moduleUrl), "utf8"));
const factorySource = source.replace(/^import .*?;\s*$/gm, "").replace("export default function rpcSubagents", "function rpcSubagents").replaceAll("import.meta.url", "moduleUrl") + "\nrpcSubagents";

function load(env, context = {}, api = {}) {
  const tools = []; const commands = []; const events = []; const handlers = new Map();
  const forbidden = () => { throw new Error("Factory attempted to initialize runtime resources"); };
  const factory = runInNewContext(factorySource, { process: { env }, Type: schema, dirname, join, fileURLToPath, moduleUrl, COORDINATION_LIMITS, safeText,
    getPackageDir: forbidden, getAgentDir: forbidden, loadLocalConfig: forbidden, resolveDataRoot: forbidden, setTimeout: forbidden, setInterval: forbidden, ...context });
  factory({ registerTool: (tool) => tools.push(tool), registerCommand: (name) => commands.push(name),
    on: (name, handler) => { events.push(name); handlers.set(name, handler); }, ...api });
  return { tools, commands, events, handlers };
}

test("adapter factory registers unique codemode tools with directly accessible structured result declarations but starts no resources", () => {
  const registry = load({});
  assert.deepEqual(registry.tools.map((tool) => tool.name), ["rpc_subagents_run", "rpc_subagents_status", "rpc_subagents_result", "rpc_subagents_wait", "rpc_subagents_cancel", "rpc_subagents_respond", "rpc_subagents_pending", "rpc_subagents_reply", "rpc_subagents_steer", "rpc_subagents_view", "rpc_subagents_schedule_create", "rpc_subagents_schedule_list", "rpc_subagents_schedule_pause", "rpc_subagents_schedule_resume", "rpc_subagents_schedule_cancel"]);
  const run = registry.tools[0];
  assert.equal(run.exposure, "codemode");
  assert.equal(run.outputSchema.properties.taskId.type, "string");
  assert.equal(run.outputSchema.properties.text.type, "string");
  assert.deepEqual(Array.from(run.outputSchema.properties.thinking.anyOf, (value) => value.const), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(run.outputSchema.properties.timeoutMs.type, "integer");
  assert.equal(run.outputSchema.properties.status.anyOf.some((value) => value.const === "completed"), true);
  assert.equal(run.parameters.properties.tools.maxItems, 64);
  assert.equal(run.parameters.properties.session.maxLength, 4096);
  assert.equal(run.outputSchema.properties.sessionReusable.type, "boolean");
  assert.equal(run.parameters.properties.webAccess.type, "boolean");
  assert.equal(run.outputSchema.properties.webAccess.type, "boolean");
  assert.equal(run.outputSchema.properties.capabilities.properties.webTools.maxItems, 16);
  assert.equal(run.outputSchema.properties.capabilities.properties.reachable.type, "array");
  assert.equal(run.outputSchema.properties.capabilities.properties.exposures.additionalProperties.anyOf.some((value) => value.const === "model-only"), true);
  assert.equal(run.outputSchema.properties.reports.items.properties.seq.type, "integer");
  assert.equal(run.outputSchema.properties.requests.items.properties.requestId.type, "string");
  assert.equal(registry.tools.every((tool) => tool.exposure === "codemode" && tool.namespace.name === "rpc_subagents"), true);
  const pending = registry.tools.find((tool) => tool.name === "rpc_subagents_pending");
  assert.equal(pending.annotations.readOnlyHint, true);
  assert.equal(pending.parameters.properties.limit.maximum, 64);
  assert.equal(pending.outputSchema.properties.nextAfter.type, "integer");
  const reply = registry.tools.find((tool) => tool.name === "rpc_subagents_reply");
  assert.equal(reply.annotations.readOnlyHint, false);
  assert.equal(reply.parameters.properties.value.maxLength, 65536);
  assert.equal(Object.hasOwn(reply.parameters.properties, "confirmed"), false);
  const steer = registry.tools.find((tool) => tool.name === "rpc_subagents_steer");
  assert.equal(steer.parameters.properties.message.maxLength, 8192);
  assert.equal(steer.outputSchema.properties.disposition.anyOf.some((value) => value.const === "queued"), true);
  assert.deepEqual(registry.commands, ["rpc-subagents", "rpc-subagents-view"]);
  assert.deepEqual(registry.events, ["resources_discover", "session_start", "session_shutdown"]);
});

test("task output schema accepts new metadata and legacy results without it", {
  skip: !process.env.RPC_SUBAGENTS_PI_PACKAGE && "Set RPC_SUBAGENTS_PI_PACKAGE to validate the installed TypeBox schema",
}, async () => {
  const build = join(process.env.RPC_SUBAGENTS_PI_PACKAGE, "node_modules", "typebox", "build");
  const { Type } = await import(pathToFileURL(join(build, "index.mjs")).href);
  const { Check } = await import(pathToFileURL(join(build, "value", "index.mjs")).href);
  const outputSchema = load({}, { Type }).tools.find((tool) => tool.name === "rpc_subagents_result").outputSchema;
  const legacy = { taskId: "task-1", name: "legacy", model: { provider: "test", id: "model" }, cwd: "/project",
    status: "completed", state: { status: "completed" }, text: "done", truncated: false, createdAt: 0,
    currentTools: [], eventFile: "/events.jsonl", ownerId: "owner-1", ownerPid: 1 };
  assert.equal(Check(outputSchema, legacy), true);
  for (const thinking of ["high", "off"]) assert.equal(Check(outputSchema, { ...legacy, thinking, timeoutMs: 150 }), true);
  assert.equal(Check(outputSchema, { ...legacy, thinking: "unknown" }), false);
});

test("README startup allowlist preserves all fifteen registered codemode tools", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const names = readme.match(/^pi --tools (.+)$/m)[1].split(",");
  assert.ok(names.includes("codemode"));
  for (const tool of load({}).tools) assert.ok(names.includes(tool.name), `${tool.name} is missing from the documented allowlist`);
});

test("schedule_list on a new cwd reads an unchanged snapshot without constructing an owner or timer", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-list-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "data", "projects", projectKey(directory));
  const manager = new ScheduleManager({ directory: store, cwd: directory, fleet: {}, now: () => 100000,
    setTimer() { return {}; }, clearTimer() {} });
  await manager.create({ task: { prompt: "read only", cwd: directory, model: { provider: "test", id: "model" } }, trigger: { type: "at", at: "+1h" } });
  await manager.shutdown();
  const before = await readFile(join(store, "schedules.json"), "utf8");
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), resolveDataRoot: () => join(directory, "data"), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: class { subscribe() { return () => {}; } list() { return []; } },
    ScheduleManager: class { constructor() { throw new Error("Read-only list tried to create an owner"); } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules });
  const tool = registry.tools.find((tool) => tool.name === "rpc_subagents_schedule_list");
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await tool.execute("list", { cwd: directory }, undefined, undefined, { cwd: directory });
  assert.equal(result.structuredContent.schedules.length, 1);
  assert.equal(result.structuredContent.schedules[0].state.status, "active");
  assert.equal(await readFile(join(store, "schedules.json"), "utf8"), before);
  assert.deepEqual(await readdir(store), ["schedules.json"]);
});

test("RPC_SUBAGENTS_CHILD prevents all tool, command, and lifecycle registration", () => {
  assert.equal(load({}).tools.length, 15);
  const child = load({ RPC_SUBAGENTS_CHILD: "1" });
  assert.deepEqual(child.tools, []);
  assert.deepEqual(child.commands, []);
  assert.deepEqual(child.events, []);
});

test("schedule_create rejects session continuation before acquiring a schedule owner", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-schedule-session-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: class { subscribe() { return () => {}; } list() { return []; } },
    ScheduleManager: class { constructor() { throw new Error("Schedule owner was created before the session rejection"); } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules });
  const tool = registry.tools.find((tool) => tool.name === "rpc_subagents_schedule_create");
  await assert.rejects(tool.execute("create", { task: { prompt: "resume", session: "/tmp/owned.jsonl" }, trigger: { type: "at", at: "+10m" } }, undefined, undefined, { cwd: directory }),
    /Schedules cannot continue an existing session/);
});

test("pending child asks wake the parent exactly once, forward explicit replies, and dispose on shutdown", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-notify-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const calls = []; const messages = []; const notices = [];
  let attempts = 0; let failNext = false;
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    status(taskId) { return structuredClone(tasks.find((task) => task.taskId === taskId)); }
    pending(taskId, options) { calls.push(["pending", taskId, options]); return Promise.resolve({ requests: [], reports: [], nextAfter: 0, droppedThrough: 0 }); }
    reply(taskId, requestId, answer) { calls.push(["reply", taskId, requestId, answer]); return Promise.resolve({ taskId }); }
    steer(taskId, message) { calls.push(["steer", taskId, message]); return Promise.resolve({ taskId, disposition: "queued" }); }
    shutdown() { return Promise.resolve(); }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), resolveDataRoot: () => join(directory, "data"), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules },
    { sendMessage: (message, options) => { attempts++; if (failNext) throw new Error("session is closing"); messages.push({ message, options }); } });
  const ctx = { mode: "print", hasUI: true, cwd: directory, ui: { notify: (message, type) => notices.push([message, type]) } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  assert.equal(listeners.size, 2);
  const tick = () => { for (const listener of [...listeners]) listener(); };
  tasks.push({ taskId: "task-1", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-1", question: "Approve?", expiresAt: 5 }] } });
  tick(); tick();
  assert.equal(messages.length, 1);
  assert.equal(attempts, 1);
  assert.equal(messages[0].options.deliverAs, "followUp");
  assert.equal(messages[0].options.triggerTurn, true);
  assert.ok(messages[0].message.content.includes("task-1") && messages[0].message.content.includes("ask-1"));
  assert.equal(messages[0].message.details.taskId, "task-1");
  assert.equal(messages[0].message.details.requestId, "ask-1");
  tasks[0].state.requests.push({ requestId: "ask-2", question: "And?", expiresAt: 5 });
  tick();
  assert.equal(messages.length, 2);
  tasks.push({ taskId: "task-2", state: { status: "waiting_input", dialogs: [], requests: [] } });
  tick();
  assert.equal(messages.length, 2);
  failNext = true;
  tasks.push({ taskId: "task-3", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-9", question: "Retry?", expiresAt: 5 }] } });
  tick(); tick();
  assert.equal(messages.length, 2);
  assert.equal(attempts, 4);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], "warning");
  failNext = false;
  tick();
  assert.equal(messages.length, 3);
  assert.equal(attempts, 5);
  tick();
  assert.equal(messages.length, 3);
  tasks.splice(tasks.findIndex((task) => task.taskId === "task-3"), 1);
  tick();
  tasks.push({ taskId: "task-3", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-9", question: "Retry?", expiresAt: 5 }] } });
  tick();
  assert.equal(messages.length, 4);
  assert.equal(calls.length, 0);
  const reply = registry.tools.find((tool) => tool.name === "rpc_subagents_reply");
  await reply.execute("reply", { taskId: "task-1", requestId: "ask-1", value: "yes" }, undefined, undefined, ctx);
  await reply.execute("reply", { taskId: "task-1", requestId: "ask-1", cancelled: true }, undefined, undefined, ctx);
  const steer = registry.tools.find((tool) => tool.name === "rpc_subagents_steer");
  await steer.execute("steer", { taskId: "task-1", message: "keep going" }, undefined, undefined, ctx);
  const pending = registry.tools.find((tool) => tool.name === "rpc_subagents_pending");
  await pending.execute("pending", { taskId: "task-1", after: 3, limit: 5 }, undefined, undefined, ctx);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call[0]), ["reply", "reply", "steer", "pending"]);
  assert.equal(calls[0][1], "task-1");
  assert.equal(calls[0][2], "ask-1");
  assert.equal(calls[0][3].value, "yes");
  assert.equal(calls[1][3].cancelled, true);
  assert.equal(calls[2][1], "task-1");
  assert.equal(calls[2][2], "keep going");
  assert.equal(calls[3][1], "task-1");
  assert.equal(calls[3][2].after, 3);
  assert.equal(calls[3][2].limit, 5);
  await registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(listeners.size, 0);
});

test("wake bookkeeping follows currently pending request keys on a retained task", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-notify-prune-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const messages = [];
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    status() { return undefined; }
    pending() { return Promise.resolve({ requests: [], reports: [], nextAfter: 0, droppedThrough: 0 }); }
    reply() { return Promise.resolve({}); }
    steer() { return Promise.resolve({}); }
    shutdown() { return Promise.resolve(); }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), resolveDataRoot: () => join(directory, "data"), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules },
    { sendMessage: (message) => messages.push(message) });
  const ctx = { mode: "print", hasUI: true, cwd: directory, ui: { notify: () => {} } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  const tick = () => { for (const listener of [...listeners]) listener(); };
  const waiting = (requestId, question) => ({ taskId: "task-1", state: { status: "waiting_input", dialogs: [], requests: [{ requestId, question, expiresAt: 5 }] } });
  const idle = { taskId: "task-1", state: { status: "running", disposition: "started", dialogs: [], requests: [] } };
  tasks.push(waiting("ask-1", "First?"));
  tick(); tick();
  assert.equal(messages.length, 1);
  tasks[0] = idle;
  tick();
  tasks[0] = waiting("ask-2", "Second?");
  tick(); tick();
  assert.equal(messages.length, 2);
  tasks[0] = idle;
  tick();
  tasks[0] = waiting("ask-1", "Reused?");
  tick(); tick();
  assert.deepEqual(messages.map((message) => message.details.requestId), ["ask-1", "ask-2", "ask-1"]);
  tick(); tick();
  assert.equal(messages.length, 3);
  await registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(listeners.size, 0);
});
