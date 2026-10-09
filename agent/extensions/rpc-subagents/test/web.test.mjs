import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWebFactory } from "../web.ts";
import registerChildBridge from "../child.ts";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, resolveWebEntrypoint, WEB_SOURCE_ENV, CHILD_BINDING_ENV } from "../runtime.mjs";
import { readWebCatalog, webConfigPath, WEB_APPROVED_ENV, WEB_SLOTS } from "../web-policy.mjs";
import { verifyCapabilities, validateToolInventory, decodeCoordinationEnvelope, BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME } from "../coordination.mjs";
import { ScheduleManager } from "../schedules.mjs";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "rpc-subagents-web-missing-config");
const model = { provider: "test", id: "model" };
const binding = { taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" };
const defaultFamily = ["web_search", "source_check", "fetch_content", "get_search_content"];
const spec = (input) => normalizeTaskSpec({ prompt: "Inspect", cwd: "/tmp", model, ...input });
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fakePi() {
  const tools = new Map([["read", { name: "read", exposure: "direct" }], ["rpc_subagents_parent", { name: "rpc_subagents_parent", exposure: "model-only" }]]);
  let active = ["read", "rpc_subagents_parent"];
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    events: new EventEmitter(), commands,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    getAllTools() { return [...tools.values()].map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct" })); },
    getActiveTools() { return active; },
    setActiveTools(names) { active = names; },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
    async fire(name, ctx) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
  };
  return pi;
}
function stockFactory(names, mode = "dynamic") {
  return (pi) => {
    for (const name of names) pi.registerTool({ name, promptSnippet: `Use ${name} for external evidence`, parameters: {}, execute: async () => ({ content: [], details: undefined }) });
    if (mode !== "eager") {
      pi.registerTool({ name: "web_enable", label: "Enable Web Access", promptSnippet: `If tools for ${names.join(", ")} are not available`, parameters: {}, async execute() {
        const registered = new Set(pi.getAllTools().map((tool) => tool.name));
        const unavailable = names.filter((name) => !registered.has(name));
        if (unavailable.length) return { isError: true, content: [{ type: "text", text: `Cannot enable unavailable tools: ${unavailable.join(", ")}.` }], details: { unavailable } };
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
        const active = new Set(pi.getActiveTools());
        const missing = names.filter((name) => !active.has(name));
        return missing.length ? { isError: true, content: [{ type: "text", text: `Tools still inactive after activation: ${missing.join(", ")}.` }], details: { missing } }
          : { content: [{ type: "text", text: `Enabled: ${names.join(", ")}.` }], details: { enabled: names } };
      } });
      pi.on("session_start", () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...(mode === "auto-eager" ? names : ["web_enable"])])]));
    }
  };
}
function selection(functional, family, loader) {
  const keys = { renamed_fetch: "fetchContent", web_search: "webSearch", source_check: "sourceCheck", fetch_content: "fetchContent", get_search_content: "getSearchContent" };
  const labels = { renamed_fetch: "content fetching", web_search: "web search", source_check: "source checking", fetch_content: "content fetching", get_search_content: "stored-result retrieval" };
  return { functional: functional.map((name) => ({ key: keys[name] ?? "webSearch", name, label: labels[name] ?? "web research" })), family, loader };
}

test("legacy tools plus webAccess compile once into canonical execution tools and web tools", () => {
  for (const [input, tools, webTools, webAccess] of [
    [{}, ["read", "write", "edit", "bash", "codemode"], defaultFamily, true],
    [{ webAccess: false }, ["read", "write", "edit", "bash", "codemode"], [], false],
    [{ tools: [] }, [], [], false],
    [{ tools: ["read"] }, ["read"], [], false],
    [{ tools: [], webAccess: true }, [], defaultFamily, true],
    [{ tools: ["+bash", "-edit", "-codemode"] }, ["read", "write", "bash"], [], false],
    [{ tools: ["+fetch_content", "+web_search"] }, ["read", "write", "edit", "bash", "codemode"], ["web_search", "fetch_content"], true],
    [{ tools: ["+fetch_content", "-fetch_content"] }, ["read", "write", "edit", "bash", "codemode"], [], false],
    [{ tools: ["read", "fetch_content"] }, ["read"], ["fetch_content"], true],
  ]) {
    const result = spec(input);
    assert.deepEqual(result.tools, tools);
    assert.deepEqual(result.webTools, webTools);
    assert.equal(result.webAccess, webAccess);
    assert.deepEqual(spec(result), result);
  }
  for (const [input, pattern] of [[{ tools: ["+read", "bash"] }, /mixed/], [{ tools: ["+fetch_content"], webAccess: false }, /contradicts/],
    [{ tools: ["read", "fetch_content"], webAccess: true }, /contradicts/], [{ tools: ["web_enable"] }, /machinery/], [{ tools: ["+web_enable"] }, /machinery/]]) {
    assert.throws(() => spec(input), pattern, JSON.stringify(input));
  }
});

test("the catalogue owns configured names, enabled state and activation mode", async (t) => {
  const missing = join(tmpdir(), "rpc-subagents-web-missing-config");
  const catalog = readWebCatalog({ PI_CODING_AGENT_DIR: missing }, tmpdir());
  assert.equal(catalog.mode, "auto");
  assert.deepEqual(catalog.enabled, defaultFamily);
  assert.equal(catalog.reserved.has("fetch_content"), true);
  assert.equal(webConfigPath({ PI_CODING_AGENT_DIR: "/config" }, tmpdir()), join("/config", "web-search.json"));
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-catalog-")));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const write = async (config) => {
    await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
    return { PI_CODING_AGENT_DIR: configDir };
  };
  const renamed = readWebCatalog(await write({ toolActivation: "eager", toolNames: { fetchContent: "get_page" },
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }), tmpdir());
  assert.equal(renamed.mode, "eager");
  assert.deepEqual(renamed.enabled, ["get_page"]);
  assert.deepEqual(renamed.slots.find((slot) => slot.key === "fetchContent").name, "get_page");
  assert.equal(renamed.reserved.has("fetch_content"), true);
  assert.deepEqual(renamed.reserved.has("get_page"), true);
  assert.equal(readWebCatalog(await write({ webSearch: { enabled: false }, tools: { webSearch: { enabled: true } } }), tmpdir()).enabled.length, 3);
  for (const config of [{ toolActivation: "sometimes" }, { toolNames: { fetchContent: "read" } }, { toolNames: { fetchContent: "rpc_subagents_parent" } },
    { toolNames: { fetchContent: "web_search" } }, { toolNames: { fetchContent: "web_enable" } }, { toolNames: { fetchContent: "Bad Name" } }]) {
    const env = await write(config);
    assert.throws(() => readWebCatalog(env, tmpdir()), /pi-web-access|reserved|Duplicate|collides/, JSON.stringify(config));
  }
});

test("each dynamic, auto-eager and eager mode registers and activates only the approved subset", async () => {
  for (const mode of ["dynamic", "auto-eager", "eager"]) {
    const pi = fakePi();
    const family = ["renamed_fetch", "source_check"];
    const chosen = selection(["renamed_fetch"], family, mode !== "eager");
    await registerWebFactory(pi, stockFactory(family, mode), chosen);
    registerChildBridge(pi, { [CHILD_BINDING_ENV.flag]: "1", [CHILD_BINDING_ENV.async]: "1", [CHILD_BINDING_ENV.taskId]: binding.taskId,
      [CHILD_BINDING_ENV.ownerId]: binding.ownerId, [CHILD_BINDING_ENV.nonce]: binding.nonce, [WEB_SOURCE_ENV]: "/trusted/web.js" });
    const notifications = [];
    const ctx = { ui: { notify: (message) => notifications.push(message) } };
    await pi.fire("session_start", ctx);
    await pi.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", ctx);
    const initial = decodeCoordinationEnvelope(notifications.at(-1), binding).inventory;
    assert.equal(initial.webTools.includes("source_check"), false);
    assert.deepEqual(initial.webTools, [...chosen.functional.map((entry) => entry.name), ...(chosen.loader ? ["web_enable"] : [])]);
    assert.equal(pi.getActiveTools().includes("source_check"), false);
    assert.equal(pi.getActiveTools().includes("read"), true);
    assert.equal(pi.getActiveTools().includes(PARENT_TOOL_NAME), true);
    const capabilities = verifyCapabilities(["read"], ["renamed_fetch"], initial, initial.webTools);
    assert.equal(capabilities.reachable.includes("renamed_fetch"), mode === "eager" || mode === "auto-eager");
    const enabled = await pi.getAllTools().find((tool) => tool.name === "web_enable")?.execute?.();
    if (mode === "eager") {
      assert.equal(pi.getAllTools().some((tool) => tool.name === "web_enable"), false);
    } else {
      assert.deepEqual(enabled.details.enabled, ["renamed_fetch"]);
      assert.equal(pi.getActiveTools().includes("renamed_fetch"), true);
      assert.equal(pi.getActiveTools().includes("source_check"), false);
      assert.equal(pi.getActiveTools().includes("read"), true);
      const active = pi.getActiveTools();
      const refreshed = { registered: pi.getAllTools().map((tool) => tool.name), active, declared: active,
        callable: active.filter((name) => name !== PARENT_TOOL_NAME),
        exposures: Object.fromEntries(pi.getAllTools().map((tool) => [tool.name, tool.name === PARENT_TOOL_NAME ? "model-only" : "direct"])), webTools: initial.webTools };
      assert.ok(verifyCapabilities(["read"], ["renamed_fetch"], refreshed, initial.webTools).reachable.includes("renamed_fetch"));
    }
    const loader = pi.getAllTools().find((tool) => tool.name === "web_enable");
    if (loader) {
      assert.equal(loader.promptSnippet.includes("source_check"), false);
      assert.equal(loader.promptSnippet.includes("content fetching"), true);
    }
    assert.equal(pi.getAllTools().some((tool) => tool.name === "source_check"), false);
  }
});

test("the factory boundary rejects unconfigured registrations and inventory drift", async () => {
  assert.rejects(registerWebFactory(fakePi(), undefined, selection(["renamed_fetch"], ["renamed_fetch"], true)), /factory/);
  await assert.rejects(registerWebFactory(fakePi(), stockFactory(["unexpected"]), selection(["renamed_fetch"], ["renamed_fetch"], true)), /unconfigured/);
  await assert.rejects(registerWebFactory(fakePi(), stockFactory(["renamed_fetch", "source_check"], "eager"), selection(["renamed_fetch"], ["renamed_fetch", "source_check"], true)), /disagrees/);
  await assert.rejects(registerWebFactory(fakePi(), stockFactory(["renamed_fetch"], "eager"), selection(["renamed_fetch"], ["renamed_fetch"], true)), /disagrees/);
});

test("trusted local installed source and exact argv carry execution, parent and the approved web subset", async (t) => {
  const root = await temporary(t);
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extension");
  const installed = join(agentDir, "npm", "node_modules", "pi-web-access");
  await mkdir(join(installed, "dist"), { recursive: true });
  await mkdir(extensionDir);
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-web-access", pi: { extensions: ["./dist"] } }));
  await writeFile(join(installed, "dist", "index.js"), "export default function () {}\n");
  await writeFile(join(extensionDir, "child.ts"), "");
  const configDir = join(root, "config"); await mkdir(configDir);
  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ toolActivation: "dynamic", toolNames: { fetchContent: "renamed_fetch" },
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [WEB_SOURCE_ENV]: process.env[WEB_SOURCE_ENV], [WEB_APPROVED_ENV]: process.env[WEB_APPROVED_ENV] };
  process.env.PI_CODING_AGENT_DIR = configDir; process.env[WEB_SOURCE_ENV] = "/untrusted/inherited"; process.env[WEB_APPROVED_ENV] = '["untrusted"]';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath: "/installed/pi", config: {} });
  assert.equal(resolveWebEntrypoint(agentDir), join(installed, "dist", "index.js"));
  for (const [i, input] of [{}, { webAccess: false }, { tools: [] }, { tools: ["read"] }, { tools: [], webAccess: true }, { tools: ["+renamed_fetch"] }].entries()) {
    const normalized = normalizeTaskSpec({ prompt: "Inspect", cwd: root, model, ...input });
    const prepared = await prepare(normalized, { directory: join(root, `task${i}`) });
    const allowlist = prepared.args[prepared.args.indexOf("--tools") + 1].split(",");
    assert.deepEqual(allowlist, [...normalized.tools, PARENT_TOOL_NAME, ...(normalized.webTools.length ? ["renamed_fetch", "web_enable"] : [])]);
    assert.equal(prepared.args.includes(join(extensionDir, "web.ts")), normalized.webTools.length > 0);
    assert.equal(prepared.args.includes("*"), false);
    assert.equal(prepared.env[WEB_SOURCE_ENV], normalized.webTools.length ? join(installed, "dist", "index.js") : undefined);
    if (normalized.webTools.length) {
      assert.deepEqual(JSON.parse(prepared.env[WEB_APPROVED_ENV]), { functional: [{ key: "fetchContent", name: "renamed_fetch", label: "content fetching" }], family: ["renamed_fetch"], loader: true });
      assert.deepEqual(prepared.webTools, ["renamed_fetch", "web_enable"]);
    } else {
      assert.equal(prepared.env[WEB_APPROVED_ENV], undefined);
      assert.deepEqual(prepared.webTools, []);
    }
    assert.deepEqual(prepared.webTools, normalized.webTools.length ? [normalized.webTools[0], "web_enable"] : []);
  }
  await assert.rejects(async () => prepare(spec({ tools: ["+fetch_content"] }), { directory: join(root, "renamed") }), /disabled or renamed/);
  await rm(join(installed, "dist", "index.js"));
  assert.throws(() => resolveWebEntrypoint(agentDir), /trusted installed/);
  await assert.rejects(prepare(spec({}), { directory: join(root, "missing") }), /trusted installed/);
  const noWeb = await prepare(normalizeTaskSpec({ prompt: "Inspect", cwd: root, model, tools: ["read"] }), { directory: join(root, "noweb") });
  assert.deepEqual(noWeb.webTools, []);
  assert.equal(noWeb.env[WEB_SOURCE_ENV], undefined);
  assert.equal(noWeb.env[WEB_APPROVED_ENV], undefined);
  assert.equal(noWeb.args.includes(join(extensionDir, "web.ts")), false);
  await writeFile(join(configDir, "web-search.json"), "{invalid json");
  for (const [index, input] of [{ tools: [] }, { tools: ["read"] }, { tools: ["+bash", "-edit", "-codemode"] }, { tools: [], webAccess: false }].entries()) {
    const malformed = normalizeTaskSpec({ prompt: "Inspect", cwd: root, model, ...input });
    assert.deepEqual(malformed.webTools, []);
    assert.equal(malformed.webAccess, false);
    const preparedNoWeb = await prepare(malformed, { directory: join(root, `noweb-${index}`) });
    assert.deepEqual(preparedNoWeb.webTools, []);
    assert.equal(preparedNoWeb.env[WEB_SOURCE_ENV], undefined);
  }
  assert.throws(() => spec({ tools: ["+renamed_fetch"] }), /Cannot parse/);
});

test("captured web bindings reject slot reassignment, rename and disable under a later configuration", async (t) => {
  const root = await temporary(t);
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extension");
  const installed = join(agentDir, "npm", "node_modules", "pi-web-access");
  await mkdir(join(installed, "dist"), { recursive: true });
  await mkdir(extensionDir);
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-web-access", pi: { extensions: ["./dist"] } }));
  await writeFile(join(installed, "dist", "index.js"), "export default function () {}\n");
  await writeFile(join(extensionDir, "child.ts"), "");
  const configDir = join(root, "config"); await mkdir(configDir);
  const configPath = join(configDir, "web-search.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(configPath, JSON.stringify({ toolActivation: "dynamic", toolNames: { webSearch: "get_page", fetchContent: "get_page" },
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  const captured = spec({ tools: ["get_page"] });
  assert.deepEqual(captured.webToolSlots, { get_page: "fetchContent" });
  const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath: "/installed/pi", config: {} });
  const prepared = await prepare(captured, { directory: join(root, "task") });
  assert.deepEqual(prepared.webTools, ["get_page", "web_enable"]);
  await writeFile(configPath, JSON.stringify({ toolActivation: "dynamic", toolNames: { webSearch: "get_page", fetchContent: "get_page" },
    tools: { fetchContent: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  await assert.rejects(prepare(captured, { directory: join(root, "task-2") }), /rename or reassignment/);
  const legacyRecompiled = spec({ tools: ["get_page"] });
  assert.deepEqual(legacyRecompiled.webToolSlots, { get_page: "webSearch" });
  const rebound = await prepare(legacyRecompiled, { directory: join(root, "task-3") });
  assert.deepEqual(rebound.webTools, ["get_page", "web_enable"]);
  await writeFile(configPath, JSON.stringify({ toolActivation: "dynamic", toolNames: { fetchContent: "get_page" },
    tools: { fetchContent: { enabled: false }, webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  await assert.rejects(prepare(captured, { directory: join(root, "task-4") }), /disabled or renamed|all installed web tools are disabled/);
});

test("fail-closed inventory rejects hidden registrations and codemode web exposure", () => {
  const hidden = { registered: ["read", "fetch_page", "web_enable", "rpc_subagents_parent", "sneaky"],
    active: ["read", "web_enable", "rpc_subagents_parent"], declared: ["read", "web_enable", "rpc_subagents_parent"], callable: ["read", "web_enable"],
    exposures: { read: "direct", fetch_page: "direct", web_enable: "direct", rpc_subagents_parent: "model-only", sneaky: "hidden" }, webTools: ["fetch_page", "web_enable"] };
  assert.throws(() => verifyCapabilities(["read"], ["fetch_page"], hidden, ["fetch_page", "web_enable"]), /unexpected \[sneaky\]/);
  const codemode = { registered: ["read", "fetch_page", "web_enable", "rpc_subagents_parent"],
    active: ["read", "web_enable", "rpc_subagents_parent"], declared: ["read", "web_enable", "rpc_subagents_parent"],
    callable: ["read", "web_enable", "fetch_page"],
    exposures: { read: "direct", fetch_page: "codemode", web_enable: "direct", rpc_subagents_parent: "model-only" }, webTools: ["fetch_page", "web_enable"] };
  assert.throws(() => verifyCapabilities(["read"], ["fetch_page"], codemode, ["fetch_page", "web_enable"]), /direct exposure/);
});

test("schedules persist the resolved selection and repeated normalization is identity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-schedules-")));
  const storeA = join(root, "a"); await mkdir(storeA);
  const manager = new ScheduleManager({ directory: storeA, cwd: root, fleet: {}, now: () => 100000, setTimer: () => ({}), clearTimer() {} });
  let restored;
  const record = await manager.create({ task: { prompt: "Inspect", cwd: root, model, tools: ["+fetch_content"] }, trigger: { type: "at", at: "+1h" } });
  assert.deepEqual(record.task.tools, ["read", "write", "edit", "bash", "codemode"]);
  assert.deepEqual(record.task.webTools, ["fetch_content"]);
  assert.equal(record.task.webAccess, true);
  const persisted = JSON.parse(await readFile(join(storeA, "schedules.json"), "utf8"));
  assert.equal(JSON.stringify(persisted).includes('"+fetch_content"'), false);
  assert.deepEqual(persisted.schedules[0].task.webTools, ["fetch_content"]);
  assert.deepEqual(normalizeTaskSpec({ ...persisted.schedules[0].task, async: true }), record.task);
  const legacy = await manager.create({ task: { prompt: "Inspect", cwd: root, model, tools: ["read"], webAccess: true }, trigger: { type: "at", at: "+1h" } });
  assert.deepEqual(legacy.task.webTools, defaultFamily);
  await manager.shutdown();
  const storeB = join(root, "b"); await mkdir(storeB);
  await writeFile(join(storeB, "schedules.json"), await readFile(join(storeA, "schedules.json")));
  restored = new ScheduleManager({ directory: storeB, cwd: root, fleet: {}, now: () => 100000, setTimer: () => ({}), clearTimer() {} });
  await restored.start();
  t.after(async () => { await restored.shutdown(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(restored.get(record.scheduleId).task.webTools, ["fetch_content"]);
  assert.deepEqual(restored.get(legacy.scheduleId).task.webTools, defaultFamily);
});

test("inventory validation keeps web tools a direct registered subset", () => {
  const inventory = { registered: ["read", "fetch_page", "web_enable", "rpc_subagents_parent"],
    active: ["read", "web_enable", "rpc_subagents_parent"], declared: ["read", "web_enable", "rpc_subagents_parent"], callable: ["read", "web_enable"],
    exposures: { read: "direct", fetch_page: "direct", web_enable: "direct", rpc_subagents_parent: "model-only" }, webTools: ["fetch_page", "web_enable"] };
  assert.deepEqual(verifyCapabilities(["read"], ["fetch_page"], inventory, ["fetch_page", "web_enable"]).webTools, ["fetch_page", "web_enable"]);
  assert.throws(() => verifyCapabilities(["read"], [], inventory, []), /Unexpected web/);
  assert.throws(() => verifyCapabilities(["read"], ["fetch_page"], { ...inventory, webTools: ["fetch_page"] }, ["fetch_page", "web_enable"]), /family changed/);
  assert.throws(() => verifyCapabilities(["read"], ["fetch_page"], inventory, ["other"]), /Approved web tools/);
  assert.throws(() => verifyCapabilities(["read"], ["web_enable"], inventory, ["web_enable"]), /machinery/);
  assert.throws(() => verifyCapabilities(["read"], ["fetch_page"], inventory, undefined), /approved resolved web tools/);
  assert.throws(() => validateToolInventory({ ...inventory, webTools: ["missing"] }), /subset/);
  assert.throws(() => validateToolInventory({ ...inventory, webTools: Array.from({ length: 17 }, (_, i) => `tool${i}`) }), /at most 16/);
});
