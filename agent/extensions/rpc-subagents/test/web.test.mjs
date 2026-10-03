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
import { resolveWebTools, webConfigPath, WEB_APPROVED_ENV } from "../web-policy.mjs";
import { verifyCapabilities, validateToolInventory, decodeCoordinationEnvelope, BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME } from "../coordination.mjs";
import { ScheduleManager } from "../schedules.mjs";

const model = { provider: "test", id: "model" };
const binding = { taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" };
const launch = { [CHILD_BINDING_ENV.flag]: "1", [CHILD_BINDING_ENV.async]: "1", [CHILD_BINDING_ENV.taskId]: binding.taskId,
  [CHILD_BINDING_ENV.ownerId]: binding.ownerId, [CHILD_BINDING_ENV.nonce]: binding.nonce, [WEB_SOURCE_ENV]: "/trusted/web.js" };
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fakePi() {
  const tools = new Map([["read", { name: "read", exposure: "direct" }]]);
  let active = ["read"];
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
function webFactory(names, mode = "dynamic") {
  return (pi) => {
    for (const name of names) pi.registerTool({ name, promptSnippet: `Use ${name} for external evidence`, execute: async () => ({ content: [], details: undefined }) });
    if (mode !== "eager") {
      pi.registerTool({ name: "web_enable", promptSnippet: "Call web_enable before research", execute: async () => {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
        return { content: [], details: { enabled: names } };
      } });
      pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), ...(mode === "auto-eager" ? names : ["web_enable"])]));
    }
  };
}

test("webAccess defaults independently of the unchanged five execution tools and stays idempotent", () => {
  for (const [input, expected] of [[{}, true], [{ tools: [] }, false], [{ tools: ["read"] }, false], [{ tools: [], webAccess: true }, true], [{ webAccess: false }, false]]) {
    const spec = normalizeTaskSpec({ prompt: "Inspect", cwd: "/tmp", model, ...input });
    assert.equal(spec.webAccess, expected);
    assert.deepEqual(normalizeTaskSpec(spec), spec);
    if (!Object.hasOwn(input, "tools")) assert.deepEqual(spec.tools, ["read", "write", "edit", "bash", "codemode"]);
  }
  for (const value of [null, 1, "true"]) assert.throws(() => normalizeTaskSpec({ prompt: "Inspect", cwd: "/tmp", model, webAccess: value }), /webAccess/);
});

test("configured web family retains renamed and enabled tools, with no nonexistent eager loader", () => {
  assert.deepEqual(resolveWebTools({}), ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"]);
  assert.deepEqual(resolveWebTools({ toolActivation: "eager", webSearch: { enabled: false }, toolNames: { fetchContent: "get_page" }, tools: { getSearchContent: { enabled: false } } }), ["get_page"]);
  assert.deepEqual(resolveWebTools({ webSearch: { enabled: false }, tools: { webSearch: { enabled: true } } }), ["web_search", "fetch_content", "get_search_content", "web_enable"]);
  for (const config of [{ toolNames: { fetchContent: "read" } }, { toolNames: { fetchContent: "rpc_subagents_parent" } }, { toolNames: { fetchContent: "web_search" } }, { toolNames: { fetchContent: "web_enable" } }]) assert.throws(() => resolveWebTools(config), /collision|reserved|duplicate/);
  assert.throws(() => resolveWebTools({ toolNames: { fetchContent: "custom" } }, ["custom"]), /collision/);
  assert.throws(() => resolveWebTools({ tools: Object.fromEntries(["webSearch", "sourceCheck", "fetchContent", "getSearchContent"].map((name) => [name, { enabled: false }])) }), /all.*disabled/);
});

for (const mode of ["dynamic", "auto-eager", "eager"]) test(`${mode} preserves handlers and prompt snippets and refreshes actual reachable web capabilities`, async () => {
  const pi = fakePi();
  const family = mode === "eager" ? ["renamed_fetch"] : ["renamed_fetch", "web_enable"];
  await registerWebFactory(pi, webFactory(["renamed_fetch"], mode), family);
  registerChildBridge(pi, launch);
  pi.setActiveTools([...pi.getActiveTools(), PARENT_TOOL_NAME]);
  const notifications = [];
  const ctx = { ui: { notify: (message) => notifications.push(message) } };
  await pi.fire("session_start", ctx);
  await pi.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", ctx);
  const initial = decodeCoordinationEnvelope(notifications.at(-1), binding).inventory;
  const capabilities = verifyCapabilities(["read"], initial, true, family);
  assert.deepEqual(capabilities.webTools, family);
  assert.equal(capabilities.reachable.includes("renamed_fetch"), mode !== "dynamic");
  assert.equal(pi.getAllTools().find((tool) => tool.name === "renamed_fetch").promptSnippet, "Use renamed_fetch for external evidence");
  if (mode === "dynamic") {
    const result = await pi.getAllTools().find((tool) => tool.name === "web_enable").execute();
    assert.deepEqual(result.details.enabled, ["renamed_fetch"]);
    await pi.fire("tool_result", ctx);
    assert.equal(notifications.length, 2);
    const updated = decodeCoordinationEnvelope(notifications.at(-1), binding).inventory;
    assert.ok(verifyCapabilities(["read"], updated, true, family).reachable.includes("renamed_fetch"));
    await pi.fire("before_agent_start", ctx);
    assert.equal(notifications.length, 2);
  }
  assert.throws(() => verifyCapabilities(["read"], initial, false), /Unexpected web/);
  const unrelated = { ...initial, registered: [...initial.registered, "extra"], active: [...initial.active, "extra"], declared: [...initial.declared, "extra"], callable: [...initial.callable, "extra"], exposures: { ...initial.exposures, extra: "direct" } };
  assert.throws(() => verifyCapabilities(["read"], unrelated, true, family), /unexpected \[extra\]/);
  const hiddenExtra = { ...initial, registered: [...initial.registered, "extra"], exposures: { ...initial.exposures, extra: "hidden" } };
  assert.throws(() => verifyCapabilities(["read"], hiddenExtra, true, family), /unexpected \[extra\]/);
  assert.throws(() => verifyCapabilities(["read"], { ...initial, webTools: ["read"] }, true), /collision/);
  assert.throws(() => verifyCapabilities(["read"], initial, true, ["other"]), /family changed/);
  assert.throws(() => verifyCapabilities(["read"], { ...initial, exposures: { ...initial.exposures, renamed_fetch: "codemode" }, callable: [...new Set([...initial.callable, "renamed_fetch"])] }, true, family), /direct exposure/);
  assert.throws(() => validateToolInventory({ ...initial, webTools: ["missing"] }), /subset/);
  assert.throws(() => validateToolInventory({ ...initial, webTools: Array.from({ length: 17 }, (_, i) => `tool${i}`) }), /at most 16/);
});

test("wrapper rejects missing factory, all disabled tools and a changed approved family", async () => {
  await assert.rejects(registerWebFactory(fakePi(), undefined), /factory/);
  await assert.rejects(registerWebFactory(fakePi(), () => {}), /all.*disabled/);
  await assert.rejects(registerWebFactory(fakePi(), webFactory(["read"])), /collision/);
  await assert.rejects(registerWebFactory(fakePi(), webFactory(["renamed"]), ["unexpected"]), /unapproved/);
});

test("trusted local installed source and complete exact argv are selected only for enabled web access", async (t) => {
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
  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ toolActivation: "eager", toolNames: { fetchContent: "renamed_fetch" }, tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [WEB_SOURCE_ENV]: process.env[WEB_SOURCE_ENV], [WEB_APPROVED_ENV]: process.env[WEB_APPROVED_ENV] };
  process.env.PI_CODING_AGENT_DIR = configDir; process.env[WEB_SOURCE_ENV] = "/untrusted/inherited"; process.env[WEB_APPROVED_ENV] = '["untrusted"]';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath: "/installed/pi", config: {} });
  assert.equal(resolveWebEntrypoint(agentDir), join(installed, "dist", "index.js"));
  for (const [i, input] of [{}, { webAccess: false }, { tools: [] }, { tools: ["read"] }, { tools: [], webAccess: true }].entries()) {
    const spec = normalizeTaskSpec({ prompt: "Inspect", cwd: root, model, ...input });
    const prepared = await prepare(spec, { directory: join(root, `task${i}`) });
    const allowlist = prepared.args[prepared.args.indexOf("--tools") + 1].split(",");
    assert.deepEqual(allowlist, [...spec.tools, PARENT_TOOL_NAME, ...(spec.webAccess ? ["renamed_fetch"] : [])]);
    assert.equal(prepared.args.includes(join(extensionDir, "web.ts")), spec.webAccess);
    assert.equal(prepared.args.includes("*"), false);
    assert.equal(prepared.env[WEB_SOURCE_ENV], spec.webAccess ? join(installed, "dist", "index.js") : undefined);
    assert.equal(prepared.env[WEB_APPROVED_ENV], spec.webAccess ? '["renamed_fetch"]' : undefined);
    assert.ok(prepared.args.includes("--no-extensions"));
  }
  await rm(join(installed, "dist", "index.js"));
  assert.throws(() => resolveWebEntrypoint(agentDir), /trusted installed/);
  await assert.rejects(prepare(normalizeTaskSpec({ prompt: "Inspect", cwd: root, model }), { directory: join(root, "missing") }), /trusted installed/);
  assert.equal(webConfigPath({ PI_CODING_AGENT_DIR: configDir }, root), join(configDir, "web-search.json"));
});

test("schedules persist independent webAccess and legacy explicit tools remain disabled", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-schedules-")));
  const manager = new ScheduleManager({ directory: root, cwd: root, fleet: {}, now: () => 100000, setTimer: () => ({}), clearTimer() {} });
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  for (const input of [{}, { tools: [] }, { tools: ["read"], webAccess: true }, { webAccess: false }]) {
    const record = await manager.create({ task: { prompt: "Inspect", cwd: root, model, ...input }, trigger: { type: "at", at: "+1h" } });
    assert.equal(record.task.webAccess, input.webAccess ?? (input.tools === undefined));
  }
  const persisted = JSON.parse(await readFile(join(root, "schedules.json"), "utf8"));
  assert.ok(JSON.stringify(persisted).includes('"webAccess":true'));
  assert.equal(normalizeTaskSpec({ prompt: "Legacy", cwd: root, model, tools: ["read", "write", "edit", "bash", "codemode"] }).webAccess, false);
});
