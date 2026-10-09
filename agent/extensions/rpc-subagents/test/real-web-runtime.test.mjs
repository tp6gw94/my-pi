import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, resolveCliEntrypoint, resolveWebEntrypoint, CHILD_BINDING_ENV, WEB_SOURCE_ENV } from "../runtime.mjs";
import { childEnvironment } from "../transport.mjs";
import { WEB_APPROVED_ENV } from "../web-policy.mjs";
import { decodeCoordinationEnvelope, verifyCapabilities, BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME } from "../coordination.mjs";

const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const agentDir = process.env.RPC_SUBAGENTS_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = packageDir ? resolveCliEntrypoint(packageDir) : undefined;
const webInstalled = existsSync(join(agentDir, "npm", "node_modules", "pi-web-access", "dist", "index.js"));
const skip = !packageDir ? "Set RPC_SUBAGENTS_PI_PACKAGE to the installed @earendil-works/pi-coding-agent package directory"
  : !webInstalled ? `Install pi-web-access under ${agentDir} to run the real Pi RPC web runtime check` : false;

const executionTools = ["read", "write", "edit", "bash", "codemode"];
const binding = { taskId: "real-web-task", ownerId: "real-web-owner", nonce: "real-web-nonce" };
const webSearchConfig = {
  toolActivation: "dynamic",
  toolNames: { fetchContent: "get_page" },
  tools: { sourceCheck: { enabled: false }, getSearchContent: { enabled: false } },
};

function modelsConfig(port) {
  return {
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "mock-key",
        models: [{ id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  };
}

function startProvider(script) {
  const requests = [];
  let step = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      requests.push({ url: request.url, body });
      const action = script[step] ?? { text: `unexpected request ${step + 1}` };
      step += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: `chatcmpl-${step}`, object: "chat.completion.chunk", created: 0, model: "mock-model" };
      if (action.tool) {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null,
          tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args ?? {}) } }] }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: action.text }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return { server, requests, listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    port: () => server.address().port };
}

function startRpc(args, cwd, env) {
  const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...args], { cwd, env: childEnvironment(env), shell: false,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  const stderr = [];
  const waiters = [];
  let buffer = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      records.push(record);
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const diagnostics = () => `spawnError=${spawnError?.message} stderr=${stderr.join("").slice(-3000)} recent=${JSON.stringify(records.slice(-6)).slice(0, 3000)}`;
  const waitFor = (check, label, timeoutMs = 30000) => {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = () => { if (check()) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${label}. ${diagnostics()}`)); }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    try { child.stdin.end(); } catch {}
    const kill = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 1000);
    kill.unref?.();
    return new Promise((resolve) => child.once("close", () => { clearTimeout(kill); resolve(); }));
  };
  return { child, records, waitFor, send, stop, diagnostics };
}

async function scenario(t, { config, input, script, sessionFile }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-runtime-")));
  const configDir = join(root, "config");
  const taskDirectory = join(root, "tasks", "task-1");
  await mkdir(configDir, { recursive: true });
  const provider = startProvider(script);
  await provider.listen();
  await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
  await writeFile(join(configDir, "models.json"), JSON.stringify(modelsConfig(provider.port())));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  let prepared;
  try {
    const spec = normalizeTaskSpec({ prompt: "Run the real web activation check", name: "real-web", cwd: root,
      model: { provider: "mock", id: "mock-model" }, ...input });
    const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath, config: { commandTimeoutMs: 30000 } });
    prepared = await prepare(spec, { directory: taskDirectory, ...binding, ...(sessionFile ? { session: { kind: "resume", sessionFile } } : {}) });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const rpc = startRpc(prepared.args, root, { ...prepared.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
  t.after(async () => {
    await rpc.stop();
    try { provider.server.closeAllConnections?.(); } catch {}
    await new Promise((resolve) => provider.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const envelopes = () => rpc.records
    .filter((record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string")
    .map((record) => decodeCoordinationEnvelope(record.message, binding))
    .filter((envelope) => envelope?.kind === "inventory");
  const waitInventory = async (count, timeoutMs = 30000) => {
    await rpc.waitFor(() => envelopes().length >= count, `${count} inventory envelopes`, timeoutMs);
    return envelopes()[count - 1].inventory;
  };
  const toolNames = (index) => (provider.requests[index]?.body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort();
  const bootstrap = async () => {
    rpc.send({ id: "bootstrap", type: "prompt", message: `/${BOOTSTRAP_COMMAND_NAME}` });
    return waitInventory(1);
  };
  const run = async () => {
    rpc.send({ id: "run", type: "prompt", message: "Use web research for the answer" });
    await rpc.waitFor(() => rpc.records.some((record) => record.type === "agent_settled"), "agent_settled", 60000);
  };
  return { prepared, provider, rpc, bootstrap, run, waitInventory, envelopes, toolNames };
}

function assertNoUnselected(inventory, unselected) {
  for (const name of unselected) {
    assert.equal(inventory.registered.includes(name), false, `registered must exclude ${name}: ${JSON.stringify(inventory.registered)}`);
    assert.equal(inventory.declared.includes(name), false, `declared must exclude ${name}: ${JSON.stringify(inventory.declared)}`);
    assert.equal(inventory.callable.includes(name), false, `callable must exclude ${name}: ${JSON.stringify(inventory.callable)}`);
  }
}

test("real Pi RPC signed selection auto loads the package and enables only web_search through the adapted loader", { skip }, async (t) => {
  const s = await scenario(t, { config: webSearchConfig, input: { tools: ["+web_search"] },
    script: [{ tool: "web_enable" }, { tool: "get_page", args: { url: "http://127.0.0.1/" } }, { text: "done" }] });

  const allowlist = s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(",");
  assert.deepEqual(allowlist, [...executionTools, PARENT_TOOL_NAME, "web_search", "web_enable"]);
  const extensions = s.prepared.args.flatMap((value, index) => value === "--extension" ? [s.prepared.args[index + 1]] : []);
  assert.equal(extensions[0], "builtin:codemode");
  assert.equal(extensions[1], join(extensionDir, "web.ts"));
  assert.equal(extensions[2], join(extensionDir, "child.ts"));
  assert.equal(s.prepared.env[WEB_SOURCE_ENV], resolveWebEntrypoint(agentDir));
  assert.deepEqual(JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    { functional: [{ key: "webSearch", name: "web_search", label: "web search" }], family: ["web_search", "get_page"], loader: true });
  assert.equal(s.prepared.env[CHILD_BINDING_ENV.taskId], binding.taskId);

  s.rpc.send({ id: "state", type: "get_state" });
  await s.rpc.waitFor(() => s.rpc.records.some((record) => record.type === "response" && record.id === "state"), "get_state response");
  const state = s.rpc.records.find((record) => record.type === "response" && record.id === "state").data;
  assert.equal(state.model.provider, "mock");
  assert.equal(state.model.id, "mock-model");
  assert.equal(state.sessionFile, s.prepared.sessionFile);

  const initial = await s.bootstrap();
  assert.deepEqual(initial.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], initial, ["web_search", "web_enable"]);
  assert.equal(initial.registered.includes("web_search"), true);
  assert.equal(initial.registered.includes("web_enable"), true);
  assertNoUnselected(initial, ["source_check", "get_search_content", "fetch_content", "get_page"]);
  assert.equal(initial.declared.includes("web_enable"), true, JSON.stringify(initial.declared));
  assert.equal(initial.callable.includes("web_enable"), true);
  assert.equal(initial.declared.includes("web_search"), false);
  assert.equal(initial.callable.includes("web_search"), false);
  assert.equal(initial.exposures[PARENT_TOOL_NAME], "model-only");

  await s.run();
  await s.waitInventory(2);

  const loaderEnd = s.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
  assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
  assert.deepEqual(loaderEnd.result.details, { enabled: ["web_search"] });
  assert.equal(loaderEnd.result.content[0].text, "Enabled: web_search.");

  const activated = s.envelopes().at(-1).inventory;
  assert.deepEqual(activated.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], activated, ["web_search", "web_enable"]);
  assert.equal(activated.declared.includes("web_search"), true);
  assert.equal(activated.callable.includes("web_search"), true);
  assert.equal(activated.declared.includes("web_enable"), true);
  for (const name of [...executionTools, PARENT_TOOL_NAME]) assert.equal(activated.declared.includes(name), true, JSON.stringify(activated.declared));
  assertNoUnselected(activated, ["source_check", "get_search_content", "fetch_content", "get_page"]);

  assert.equal(s.provider.requests.length, 3);
  assert.deepEqual(s.toolNames(0), [...executionTools, PARENT_TOOL_NAME, "web_enable"].sort());
  assert.equal(s.toolNames(1).includes("web_search"), true);
  assert.equal(s.toolNames(1).includes("web_enable"), true);
  assert.equal(s.toolNames(2).includes("web_search"), true);
  assert.equal(s.toolNames(2).includes("get_page"), false);
  for (const index of [0, 1, 2]) assertNoUnselected({ registered: s.toolNames(index), declared: s.toolNames(index), callable: s.toolNames(index) },
    ["source_check", "get_search_content", "fetch_content", "get_page"]);

  const rejected = s.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "get_page");
  assert.equal(rejected?.isError, true, JSON.stringify(rejected));
  assert.match(rejected.result.content[0].text, /Tool get_page not found/);
  const toolResult = s.provider.requests[2].body.messages.find((message) => message.role === "tool" && JSON.stringify(message).includes("get_page"));
  assert.match(JSON.stringify(toolResult), /Tool get_page not found/);

  const finalText = s.rpc.records.filter((record) => record.type === "message_end" && record.message?.role === "assistant")
    .flatMap((record) => record.message.content).find((block) => block.type === "text" && block.text === "done");
  assert.equal(finalText?.text, "done");
  t.diagnostic(JSON.stringify({ check: "signed-dynamic", argvTools: allowlist, approved: JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    webSource: s.prepared.env[WEB_SOURCE_ENV],
    initial: { registered: initial.registered, active: initial.active, declared: initial.declared, callable: initial.callable, webTools: initial.webTools },
    loader: { isError: loaderEnd.isError, text: loaderEnd.result.content[0].text, details: loaderEnd.result.details },
    activated: { active: activated.active, declared: activated.declared, callable: activated.callable, webTools: activated.webTools },
    providerTools: [s.toolNames(0), s.toolNames(1), s.toolNames(2)],
    rejected: { isError: rejected.isError, text: rejected.result.content[0].text } }));
});

test("real Pi RPC replacement selection enables a renamed configured web tool and nothing else", { skip }, async (t) => {
  const s = await scenario(t, { config: webSearchConfig, input: { tools: ["read", "bash", "get_page"] },
    script: [{ tool: "web_enable" }, { text: "done" }] });

  const allowlist = s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(",");
  assert.deepEqual(allowlist, ["read", "bash", PARENT_TOOL_NAME, "get_page", "web_enable"]);
  assert.deepEqual(JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    { functional: [{ key: "fetchContent", name: "get_page", label: "content fetching" }], family: ["web_search", "get_page"], loader: true });

  const initial = await s.bootstrap();
  assert.deepEqual(initial.webTools, ["get_page", "web_enable"]);
  verifyCapabilities(["read", "bash"], ["get_page"], initial, ["get_page", "web_enable"]);
  assert.equal(initial.registered.includes("get_page"), true);
  assertNoUnselected(initial, ["web_search", "source_check", "get_search_content", "fetch_content"]);
  assert.equal(initial.declared.includes("get_page"), false);
  assert.equal(initial.declared.includes("web_enable"), true);

  await s.run();
  await s.waitInventory(2);

  const loaderEnd = s.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
  assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
  assert.deepEqual(loaderEnd.result.details, { enabled: ["get_page"] });
  assert.equal(loaderEnd.result.content[0].text, "Enabled: get_page.");

  const activated = s.envelopes().at(-1).inventory;
  assert.deepEqual(activated.webTools, ["get_page", "web_enable"]);
  verifyCapabilities(["read", "bash"], ["get_page"], activated, ["get_page", "web_enable"]);
  assert.equal(activated.declared.includes("get_page"), true);
  assert.equal(activated.callable.includes("get_page"), true);
  assert.equal(activated.declared.includes("read"), true);
  assert.equal(activated.declared.includes("bash"), true);
  assert.equal(activated.declared.includes(PARENT_TOOL_NAME), true);
  assertNoUnselected(activated, ["web_search", "source_check", "get_search_content", "fetch_content"]);

  assert.equal(s.provider.requests.length, 2);
  assert.deepEqual(s.toolNames(0), ["read", "bash", PARENT_TOOL_NAME, "web_enable"].sort());
  assert.equal(s.toolNames(1).includes("get_page"), true);
  assert.equal(s.toolNames(1).includes("web_search"), false);
  t.diagnostic(JSON.stringify({ check: "replace-renamed", argvTools: allowlist, approved: JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    initial: { registered: initial.registered, active: initial.active, declared: initial.declared, callable: initial.callable, webTools: initial.webTools },
    loader: { isError: loaderEnd.isError, text: loaderEnd.result.content[0].text, details: loaderEnd.result.details },
    activated: { active: activated.active, declared: activated.declared, callable: activated.callable, webTools: activated.webTools },
    providerTools: [s.toolNames(0), s.toolNames(1)] }));
});

test("real Pi RPC auto mode falls back to eager selected tools for a model without mid-conversation tool additions", { skip }, async (t) => {
  const s = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: ["+web_search"] },
    script: [{ text: "done" }] });

  assert.equal(s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(",").includes("web_enable"), true);
  assert.equal(s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(",").includes("web_search"), true);

  const initial = await s.bootstrap();
  assert.deepEqual(initial.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], initial, ["web_search", "web_enable"]);
  assert.equal(initial.declared.includes("web_search"), true, JSON.stringify(initial.declared));
  assert.equal(initial.callable.includes("web_search"), true);
  assert.equal(initial.registered.includes("web_enable"), true);
  assert.equal(initial.declared.includes("web_enable"), false, JSON.stringify(initial.declared));
  assertNoUnselected(initial, ["source_check", "get_search_content", "fetch_content", "get_page"]);

  await s.run();
  assert.equal(s.provider.requests.length, 1);
  assert.equal(s.toolNames(0).includes("web_search"), true, JSON.stringify(s.toolNames(0)));
  assert.equal(s.toolNames(0).includes("web_enable"), false);
  assertNoUnselected({ registered: s.toolNames(0), declared: s.toolNames(0), callable: s.toolNames(0) },
    ["source_check", "get_search_content", "fetch_content", "get_page"]);
  t.diagnostic(JSON.stringify({ check: "auto-eager", argvTools: s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(","),
    approved: JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    initial: { registered: initial.registered, active: initial.active, declared: initial.declared, callable: initial.callable, webTools: initial.webTools },
    providerTools: [s.toolNames(0)] }));
});

test("real Pi RPC eager mode carries no loader and registers only the selected functional tool", { skip }, async (t) => {
  const s = await scenario(t, { config: { ...webSearchConfig, toolActivation: "eager" }, input: { tools: ["+web_search"] },
    script: [{ text: "done" }] });

  const allowlist = s.prepared.args[s.prepared.args.indexOf("--tools") + 1].split(",");
  assert.deepEqual(allowlist, [...executionTools, PARENT_TOOL_NAME, "web_search"]);
  assert.deepEqual(JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    { functional: [{ key: "webSearch", name: "web_search", label: "web search" }], family: ["web_search", "get_page"], loader: false });

  const initial = await s.bootstrap();
  assert.deepEqual(initial.webTools, ["web_search"]);
  verifyCapabilities(executionTools, ["web_search"], initial, ["web_search"]);
  assert.equal(initial.declared.includes("web_search"), true, JSON.stringify(initial.declared));
  assert.equal(initial.registered.includes("web_enable"), false, JSON.stringify(initial.registered));
  assertNoUnselected(initial, ["web_enable", "source_check", "get_search_content", "fetch_content", "get_page"]);

  await s.run();
  assert.equal(s.provider.requests.length, 1);
  assert.equal(s.toolNames(0).includes("web_search"), true, JSON.stringify(s.toolNames(0)));
  assert.equal(s.toolNames(0).includes("web_enable"), false);
  assert.equal(s.toolNames(0).includes("get_page"), false);
  t.diagnostic(JSON.stringify({ check: "eager", argvTools: allowlist, approved: JSON.parse(s.prepared.env[WEB_APPROVED_ENV]),
    initial: { registered: initial.registered, active: initial.active, declared: initial.declared, callable: initial.callable, webTools: initial.webTools },
    providerTools: [s.toolNames(0)] }));
});

test("real Pi RPC continuation restores the new resolved subset after stock transcript selection", { skip }, async (t) => {
  const first = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: ["get_page"] }, script: [{ text: "first" }] });
  const firstInitial = await first.bootstrap();
  assert.equal(firstInitial.declared.includes("get_page"), true, JSON.stringify(firstInitial.declared));
  await first.run();
  const sessionFile = first.prepared.sessionFile;

  const second = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: ["+web_search"], session: sessionFile },
    script: [{ tool: "web_enable" }, { text: "second" }], sessionFile });
  const before = await second.bootstrap();
  assert.deepEqual(before.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], before, ["web_search", "web_enable"]);
  assert.equal(before.registered.includes("web_search"), true);
  assert.equal(before.registered.includes("get_page"), false, JSON.stringify(before.registered));
  assert.equal(before.declared.includes("get_page"), false, JSON.stringify(before.declared));
  assertNoUnselected(before, ["source_check", "get_search_content", "fetch_content", "get_page"]);

  await second.run();
  await second.waitInventory(2);
  const loaderEnd = second.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
  assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
  assert.deepEqual(loaderEnd.result.details, { enabled: ["web_search"] });
  const activated = second.envelopes().at(-1).inventory;
  assert.deepEqual(activated.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], activated, ["web_search", "web_enable"]);
  assert.equal(activated.declared.includes("web_search"), true, JSON.stringify(activated.declared));
  const lastTools = second.toolNames(second.provider.requests.length - 1);
  assert.equal(lastTools.includes("web_search"), true, JSON.stringify(lastTools));
  assert.equal(lastTools.includes("get_page"), false);
  t.diagnostic(JSON.stringify({ check: "continuation", sessionFile,
    first: { declared: firstInitial.declared, active: firstInitial.active },
    before: { active: before.active, declared: before.declared, webTools: before.webTools },
    loader: { isError: loaderEnd.isError, details: loaderEnd.result.details },
    activated: { declared: activated.declared, active: activated.active, webTools: activated.webTools },
    providerTools: second.provider.requests.map((_, index) => second.toolNames(index)) }));
});

test("real Pi RPC partial-overlap continuation reaches the added web function and the loader reveals both", { skip }, async (t) => {
  const first = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: ["+web_search"] }, script: [{ text: "first" }] });
  const firstInitial = await first.bootstrap();
  assert.deepEqual(firstInitial.webTools, ["web_search", "web_enable"]);
  assert.equal(firstInitial.declared.includes("web_search"), true, JSON.stringify(firstInitial.declared));
  assert.equal(firstInitial.declared.includes("web_enable"), false, JSON.stringify(firstInitial.declared));
  assert.equal(firstInitial.declared.includes("get_page"), false, JSON.stringify(firstInitial.declared));
  await first.run();

  const script = [{ text: "second" }];
  const second = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" },
    input: { tools: ["+web_search", "+get_page"], session: first.prepared.sessionFile },
    script, sessionFile: first.prepared.sessionFile });
  const before = await second.bootstrap();
  assert.deepEqual(before.webTools, ["web_search", "get_page", "web_enable"]);
  assert.equal(before.declared.includes("web_search"), true, JSON.stringify(before.declared));
  assert.equal(before.declared.includes("web_enable") || before.declared.includes("get_page"), true,
    `added get_page unreachable after partial-overlap continuation: ${JSON.stringify({ active: before.active, declared: before.declared, registered: before.registered })}`);
  assertNoUnselected(before, ["source_check", "get_search_content", "fetch_content"]);

  if (before.declared.includes("get_page")) {
    await second.run();
    const tools = second.toolNames(second.provider.requests.length - 1);
    for (const name of ["web_search", "get_page", PARENT_TOOL_NAME]) assert.equal(tools.includes(name), true, `${name} missing: ${JSON.stringify(tools)}`);
    assertNoUnselected({ registered: tools, declared: tools, callable: tools }, ["source_check", "get_search_content", "fetch_content"]);
  } else {
    script[0] = { tool: "web_enable" };
    script.push({ text: "second" });
    await second.run();
    await second.waitInventory(2);
    const loaderEnd = second.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
    assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
    assert.deepEqual(loaderEnd.result.details, { enabled: ["web_search", "get_page"] });
    assert.equal(loaderEnd.result.content[0].text, "Enabled: web_search, get_page.");
    const activated = second.envelopes().at(-1).inventory;
    assert.deepEqual(activated.webTools, ["web_search", "get_page", "web_enable"]);
    for (const name of ["web_search", "get_page", PARENT_TOOL_NAME, ...executionTools]) {
      assert.equal(activated.declared.includes(name), true, `${name} missing after loader: ${JSON.stringify(activated.declared)}`);
    }
    assertNoUnselected(activated, ["source_check", "get_search_content", "fetch_content"]);
    const lastTools = second.toolNames(second.provider.requests.length - 1);
    for (const name of ["web_search", "get_page", PARENT_TOOL_NAME, ...executionTools]) {
      assert.equal(lastTools.includes(name), true, `${name} missing from provider tools: ${JSON.stringify(lastTools)}`);
    }
    assertNoUnselected({ registered: lastTools, declared: lastTools, callable: lastTools }, ["source_check", "get_search_content", "fetch_content"]);
  }

  t.diagnostic(JSON.stringify({ check: "partial-overlap", sessionFile: second.prepared.sessionFile,
    first: { declared: firstInitial.declared, active: firstInitial.active },
    before: { active: before.active, declared: before.declared, webTools: before.webTools },
    providerTools: second.provider.requests.map((_, index) => second.toolNames(index)) }));
});

test("real Pi RPC none-to-web continuation reaches the selected subset", { skip }, async (t) => {
  const first = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: [] }, script: [{ text: "first" }] });
  await first.bootstrap();
  await first.run();
  const second = await scenario(t, { config: { ...webSearchConfig, toolActivation: "auto" }, input: { tools: ["+web_search"], session: first.prepared.sessionFile },
    script: [{ tool: "web_enable" }, { text: "second" }], sessionFile: first.prepared.sessionFile });
  const before = await second.bootstrap();
  assert.deepEqual(before.webTools, ["web_search", "web_enable"]);
  verifyCapabilities(executionTools, ["web_search"], before, ["web_search", "web_enable"]);
  assertNoUnselected(before, ["source_check", "get_search_content", "fetch_content", "get_page"]);
  await second.run();
  await second.waitInventory(2);
  const activated = second.envelopes().at(-1).inventory;
  assert.deepEqual(activated.webTools, ["web_search", "web_enable"]);
  assert.equal(activated.declared.includes("web_search"), true, JSON.stringify(activated.declared));
  assert.equal(second.prepared.args.includes(join(extensionDir, "web.ts")), true);
  t.diagnostic(JSON.stringify({ check: "none-to-web", before: { active: before.active, declared: before.declared, webTools: before.webTools },
    activated: { declared: activated.declared, webTools: activated.webTools } }));
});

test("real Pi RPC selected-only metadata avoids unselected web tool names", { skip }, async (t) => {
  const stored = await scenario(t, { config: { toolActivation: "eager" }, input: { tools: ["+get_search_content"] }, script: [{ text: "done" }] });
  const initial = await stored.bootstrap();
  assert.deepEqual(initial.webTools, ["get_search_content"]);
  verifyCapabilities(executionTools, ["get_search_content"], initial, ["get_search_content"]);
  assertNoUnselected(initial, ["web_search", "source_check", "fetch_content", "web_enable"]);
  await stored.run();
  const body = JSON.stringify(stored.provider.requests[0].body);
  for (const name of ["web_search", "source_check", "fetch_content"]) assert.equal(body.includes(name), false, `${name} leaked into ${body.slice(0, 1500)}`);

  const fetching = await scenario(t, { config: { toolActivation: "eager" }, input: { tools: ["web_search", "fetch_content"] }, script: [{ text: "done" }] });
  await fetching.bootstrap();
  await fetching.run();
  const definitions = fetching.provider.requests[0].body.tools;
  const fetchDefinition = definitions.find((tool) => (tool.function?.name ?? tool.name) === "fetch_content");
  assert.ok(fetchDefinition, JSON.stringify(definitions.map((tool) => tool.function?.name ?? tool.name)));
  const fetchDescription = fetchDefinition.function?.description ?? fetchDefinition.description;
  assert.equal(fetchDescription.includes("get_search_content"), false, fetchDescription);
  assert.match(fetchDescription, /retrieval tool is not registered/);
  t.diagnostic(JSON.stringify({ check: "selected-only-metadata", storedTools: stored.toolNames(0), fetchDescription }));
});
