import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { COORDINATION_LIMITS } from "../coordination.mjs";
import { safeText } from "../viewer.mjs";
import { projectKey } from "../store.mjs";
import { resolveDataRoot } from "../runtime.mjs";

const schema = {
  String: (options = {}) => ({ type: "string", ...options }), Number: () => ({ type: "number" }), Integer: (options = {}) => ({ type: "integer", ...options }),
  Boolean: () => ({ type: "boolean" }), Null: () => ({ type: "null" }), Literal: (value) => ({ const: value }),
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }), Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }), Optional: (value) => value, Record: (key, value) => ({ type: "object", key, additionalProperties: value }),
};
const moduleUrl = new URL("../index.ts", import.meta.url).href;
const source = stripTypeScriptTypes(await readFile(new URL(moduleUrl), "utf8"));
const factorySource = source.replace(/^import .*?;\s*$/gm, "").replace("export default function rpcSubagents", "function rpcSubagents").replaceAll("import.meta.url", "moduleUrl") + "\nrpcSubagents";

async function temporary(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function load({ extensionDir, calls, fleetOptions, scheduleOptions }) {
  const tools = []; const commands = []; const events = []; const handlers = new Map();
  const track = (name, fn) => (...args) => { calls.push(name); return fn(...args); };
  const factory = runInNewContext(factorySource, { process: { env: {} }, Type: schema, dirname: () => extensionDir, join, fileURLToPath, moduleUrl,
    COORDINATION_LIMITS, safeText, resolveDataRoot: track("resolveDataRoot", resolveDataRoot),
    loadLocalConfig: track("loadLocalConfig", async () => ({})), getPackageDir: track("getPackageDir", () => extensionDir),
    getAgentDir: track("getAgentDir", () => extensionDir), resolveCliEntrypoint: track("resolveCliEntrypoint", () => "/pi"),
    createTaskPreparer: track("createTaskPreparer", () => async () => ({})),
    FleetManager: class { constructor(options) { fleetOptions.push(options); } subscribe() { return () => {}; } list() { return []; } shutdown() { return Promise.resolve(); } },
    ScheduleManager: class { constructor(options) { scheduleOptions.push(options); } subscribe() { return () => {}; } async start() {} list() { return []; } },
    readSchedules: track("readSchedules", () => []), HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey,
    installFleetWidget: () => {}, showFleetScreen: async () => {},
    setTimeout: () => { throw new Error("Factory started a timer"); }, setInterval: () => { throw new Error("Factory started a timer"); } });
  factory({ registerTool: (tool) => tools.push(tool), registerCommand: (name) => commands.push(name), on: (name, handler) => { events.push(name); handlers.set(name, handler); } });
  return { tools, commands, events, handlers };
}

function sessionContext(directory) {
  return { mode: "print", hasUI: false, cwd: directory, ui: { notify() {} } };
}

test("initialize prefers the existing sibling rpc-fleet/data root for existing managed state", async (t) => {
  const base = await temporary(t, "rpc-subagents-migration-legacy-");
  const extensionDir = join(base, "extensions", "rpc-subagents");
  const legacyRoot = join(base, "extensions", "rpc-fleet", "data");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });
  const calls = []; const fleetOptions = []; const scheduleOptions = [];
  const registry = load({ extensionDir, calls, fleetOptions, scheduleOptions });
  assert.deepEqual(calls, [], "factory must not resolve the data root or other runtime resources");
  assert.equal(registry.tools.length, 15);
  assert.deepEqual(registry.commands, ["rpc-subagents", "rpc-subagents-output", "rpc-subagents-view"]);
  assert.deepEqual(registry.events, ["resources_discover", "session_start", "session_shutdown"]);
  await registry.handlers.get("session_start")({ type: "session_start" }, sessionContext(base));
  assert.equal(calls[0], "resolveDataRoot");
  assert.equal(fleetOptions.length, 1);
  assert.equal(fleetOptions[0].root, legacyRoot);
  assert.notEqual(fleetOptions[0].root, join(extensionDir, "data"));
  assert.equal(scheduleOptions.length, 1);
  assert.equal(scheduleOptions[0].directory, join(legacyRoot, "projects", projectKey(await realpath(base))));
});

test("initialize uses rpc-subagents/data when no legacy sibling exists", async (t) => {
  const base = await temporary(t, "rpc-subagents-migration-clean-");
  const extensionDir = join(base, "extensions", "rpc-subagents");
  await mkdir(extensionDir, { recursive: true });
  const calls = []; const fleetOptions = []; const scheduleOptions = [];
  const registry = load({ extensionDir, calls, fleetOptions, scheduleOptions });
  await registry.handlers.get("session_start")({ type: "session_start" }, sessionContext(base));
  assert.equal(fleetOptions.length, 1);
  assert.equal(fleetOptions[0].root, join(extensionDir, "data"));
  assert.equal(scheduleOptions.length, 1);
  assert.equal(scheduleOptions[0].directory, join(extensionDir, "data", "projects", projectKey(await realpath(base))));
});

test("ordinary factory registration and resource discovery stay lazy", async (t) => {
  const base = await temporary(t, "rpc-subagents-migration-lazy-");
  const extensionDir = join(base, "extensions", "rpc-subagents");
  await mkdir(extensionDir, { recursive: true });
  const calls = []; const fleetOptions = []; const scheduleOptions = [];
  const registry = load({ extensionDir, calls, fleetOptions, scheduleOptions });
  const discovered = await registry.handlers.get("resources_discover")({ type: "resources_discover", cwd: base, reason: "startup" }, {});
  assert.deepEqual([...discovered.skillPaths], [join(extensionDir, "skills", "rpc-subagents", "SKILL.md")]);
  assert.deepEqual(calls, [], "registration and resource discovery must not touch runtime resources");
  assert.equal(fleetOptions.length, 0);
  assert.equal(scheduleOptions.length, 0);
});
