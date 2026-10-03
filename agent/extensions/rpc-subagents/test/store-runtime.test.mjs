import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atomicJSON, ProjectLock, TaskJournal } from "../store.mjs";
import { CHILD_BINDING_ENV, createTaskPreparer, resolveCliEntrypoint, providerExtensionPaths } from "../runtime.mjs";
import { childEnvironment } from "../transport.mjs";
import { normalizeTaskSpec } from "../domain.mjs";

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-store-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function prepareFixture(t) {
  const directory = await temporary(t);
  const agentDir = join(directory, "agent");
  const extensionDir = join(agentDir, "extensions", "rpc-subagents");
  const providerDir = join(agentDir, "extensions", "deepinfra-provider");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(providerDir, { recursive: true });
  await writeFile(join(extensionDir, "child.ts"), "export default function () {}\n");
  const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath: "/pi", config: { commandTimeoutMs: 45000 } });
  return { directory, extensionDir, providerDir: realpathSync(providerDir), taskDirectory: join(directory, "tasks", "task-1"), prepare };
}

function taskSpec(directory, overrides = {}) {
  return normalizeTaskSpec({ prompt: "Do the work", name: "Task", cwd: directory,
    model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, thinking: "high", webAccess: false, ...overrides });
}

function expectedArgs({ sessionFile, directory, tools, bridge, provider, codemode }) {
  return ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "high",
    "--session", sessionFile, "--session-dir", directory, "--name", "Task",
    "--tools", tools,
    ...(codemode ? ["--extension", "builtin:codemode"] : []),
    "--extension", bridge, "--extension", provider];
}

test("atomic stores and task journals are private, replayable, and event sinks are bounded", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "project", "state.json");
  await atomicJSON(file, { state: "paused" }); await atomicJSON(file, { state: "cancelled" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { state: "cancelled" });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const journal = await TaskJournal.open(join(directory, "task"), "id", { maxBytes: 512, now: () => 123 });
  await journal.append("rpc", { type: "message_update", text: "first" });
  await journal.append("rpc", { type: "message_update", text: "second" });
  await assert.rejects(journal.append("rpc", { type: "large", text: "x".repeat(512) }), /byte limit/);
  await journal.append("fleet", { type: "task_result", task: { status: "failed" } });
  await journal.close();
  const records = (await readFile(journal.eventFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((record) => record.event.type), ["message_update", "message_update", "task_result"]);
  assert.equal(records[0].at, 123);
  assert.equal((await stat(journal.eventFile)).mode & 0o777, 0o600);
});

test("owner locks recover a dead PID safely and release only their own token", async (t) => {
  const directory = await temporary(t); const path = join(directory, "owner.lock");
  await mkdir(path); await writeFile(join(path, "owner.json"), JSON.stringify({ token: "dead", pid: 12345 }));
  const live = new Set([99999]);
  const lock = new ProjectLock(path, { cwd: "/project", pid: 99999, isAlive: (pid) => live.has(pid) });
  lock.acquire(); lock.acquire();
  const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  assert.equal(owner.pid, 99999); assert.notEqual(owner.token, "dead");
  const other = new ProjectLock(path, { cwd: "/project", pid: 88888, isAlive: (pid) => live.has(pid) });
  assert.throws(() => other.acquire(), /already owned/);
  other.release();
  assert.equal(JSON.parse(await readFile(join(path, "owner.json"), "utf8")).token, owner.token);
  await writeFile(join(path, "owner.json"), JSON.stringify({ ...owner, token: "changed" }));
  assert.throws(() => lock.release(), /refusing to release/);
  assert.equal(JSON.parse(await readFile(join(path, "owner.json"), "utf8")).token, "changed");
  await writeFile(join(path, "owner.json"), JSON.stringify(owner)); lock.release(); lock.release();
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("incomplete owner creation is an explicit blocker rather than unsafe stale deletion", async (t) => {
  const directory = await temporary(t); const path = join(directory, "owner.lock");
  await mkdir(path);
  assert.throws(() => new ProjectLock(path, { cwd: "/project" }).acquire(), /no valid owner/);
  await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 999999, token: "dead" }));
  await writeFile(join(path, "reaper.json"), JSON.stringify({ pid: 999998, token: "prior-reaper" }));
  assert.throws(() => new ProjectLock(path, { cwd: "/project", isAlive: () => false }).acquire(), /recovery is already in progress/);
});

test("CLI selection follows the current installed manifest, never a PATH shim or arbitrary argv entry", async (t) => {
  const directory = await temporary(t); const packageDir = join(directory, "package");
  await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }));
  const entrypoint = join(packageDir, "dist", "bundle", "cli.js"); await writeFile(entrypoint, "");
  const oldShim = join(directory, "old-pi"); await writeFile(oldShim, "exec /old/pi");
  assert.equal(resolveCliEntrypoint(packageDir, oldShim), entrypoint);
  assert.equal(resolveCliEntrypoint(packageDir, entrypoint), entrypoint);
  await rm(entrypoint);
  await assert.rejects(Promise.resolve().then(() => resolveCliEntrypoint(packageDir, oldShim)), /unavailable/);
  await symlink(oldShim, entrypoint);
  assert.throws(() => resolveCliEntrypoint(packageDir, oldShim), /outside/);
});

test("provider bootstrapping includes only present known providers and explicit project allowlist sources", async (t) => {
  const directory = await temporary(t); const agentDir = join(directory, "agent"); const extensionDir = join(agentDir, "extensions", "rpc-subagents");
  const deepinfra = join(agentDir, "extensions", "deepinfra-provider"); const arbitrary = join(agentDir, "extensions", "arbitrary-extension"); const additional = join(directory, "extra-provider.ts");
  await mkdir(extensionDir, { recursive: true }); await mkdir(deepinfra); await mkdir(arbitrary); await writeFile(additional, "");
  assert.deepEqual(providerExtensionPaths({ extensionDir, agentDir, cwd: "/project", config: { projects: { "/project": { providerSources: [additional] } } } }), [deepinfra, additional]);
  assert.deepEqual(providerExtensionPaths({ extensionDir, agentDir, cwd: "/other", config: {} }), [deepinfra]);
  assert.throws(() => providerExtensionPaths({ extensionDir, agentDir, cwd: "/project", config: { projects: { "/project": { providerSources: ["/missing"] } } } }), /does not exist/);
});

test("task preparation builds exact argv for default, custom, and empty tool sets", async (t) => {
  const f = await prepareFixture(t);
  const sessionFile = join(f.taskDirectory, "session.jsonl");
  const launch = { directory: f.taskDirectory, taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1", session: { kind: "fresh", sessionFile } };
  const bridge = join(f.extensionDir, "child.ts");

  const defaults = await f.prepare(taskSpec(f.directory), launch);
  assert.deepEqual(defaults.args, expectedArgs({ sessionFile, directory: f.taskDirectory, tools: "read,write,edit,bash,codemode,rpc_subagents_parent", codemode: true, bridge, provider: f.providerDir }));
  assert.equal(defaults.sessionFile, sessionFile);
  assert.equal(defaults.cwd, f.directory);
  assert.equal(defaults.commandTimeoutMs, 45000);

  const customDirectory = join(f.directory, "tasks", "task-2");
  const custom = await f.prepare(taskSpec(f.directory, { tools: ["bash", "read"] }), { ...launch, directory: customDirectory, taskId: "task-2", session: { kind: "fresh", sessionFile: join(customDirectory, "session.jsonl") } });
  assert.deepEqual(custom.args, expectedArgs({ sessionFile: join(customDirectory, "session.jsonl"), directory: customDirectory, tools: "bash,read,rpc_subagents_parent", codemode: false, bridge, provider: f.providerDir }));

  const emptyDirectory = join(f.directory, "tasks", "task-3");
  const empty = await f.prepare(taskSpec(f.directory, { tools: [] }), { ...launch, directory: emptyDirectory, taskId: "task-3", session: { kind: "fresh", sessionFile: join(emptyDirectory, "session.jsonl") } });
  assert.deepEqual(empty.args, expectedArgs({ sessionFile: join(emptyDirectory, "session.jsonl"), directory: emptyDirectory, tools: "rpc_subagents_parent", codemode: false, bridge, provider: f.providerDir }));
});

test("task preparation binds launch identity into an inherited child environment", async (t) => {
  const f = await prepareFixture(t);
  process.env.RPC_SUBAGENTS_TEST_MARKER = "inherited";
  t.after(() => { delete process.env.RPC_SUBAGENTS_TEST_MARKER; });
  const prepared = await f.prepare(taskSpec(f.directory, { async: true, tools: ["read"] }), { directory: f.taskDirectory, taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" });
  assert.equal(prepared.env.RPC_SUBAGENTS_TEST_MARKER, undefined);
  assert.deepEqual(prepared.binding, { taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" });
  assert.equal(prepared.env[CHILD_BINDING_ENV.taskId], "task-1");
  assert.equal(prepared.env[CHILD_BINDING_ENV.ownerId], "owner-1");
  assert.equal(prepared.env[CHILD_BINDING_ENV.nonce], "nonce-1");
  assert.equal(prepared.env[CHILD_BINDING_ENV.async], "1");
  assert.equal(process.env[CHILD_BINDING_ENV.taskId], undefined);
  assert.equal(process.env[CHILD_BINDING_ENV.ownerId], undefined);
  assert.equal(process.env[CHILD_BINDING_ENV.nonce], undefined);
  assert.equal(process.env[CHILD_BINDING_ENV.async], undefined);
  const merged = childEnvironment(prepared.env);
  assert.equal(merged[CHILD_BINDING_ENV.flag], "1");
  assert.equal(merged[CHILD_BINDING_ENV.taskId], "task-1");
  assert.equal(merged[CHILD_BINDING_ENV.async], "1");
  assert.equal(merged.RPC_SUBAGENTS_TEST_MARKER, undefined);

  const sync = await f.prepare(taskSpec(f.directory, { tools: [] }), { directory: join(f.directory, "tasks", "task-2"), taskId: "task-2", ownerId: "owner-1", nonce: "nonce-2" });
  assert.equal(sync.env[CHILD_BINDING_ENV.async], "0");
});

test("partial launch binding, missing ownership, and source mismatch fail closed", async (t) => {
  const f = await prepareFixture(t);
  await assert.rejects(f.prepare(taskSpec(f.directory), { directory: f.taskDirectory, taskId: "task-1" }), /Launch binding requires/);
  const priorFile = join(f.directory, "prior", "session.jsonl");
  await mkdir(dirname(priorFile), { recursive: true });
  await writeFile(priorFile, JSON.stringify({ type: "session", version: 3, id: "prior-session", cwd: f.directory }) + "\n");
  const resumeSpec = normalizeTaskSpec({ prompt: "Continue", session: priorFile, cwd: f.directory, model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, thinking: "high", tools: ["read"] });
  const owned = { directory: join(f.directory, "tasks", "task-2"), taskId: "task-2", ownerId: "owner-1", nonce: "nonce-2" };
  await assert.rejects(f.prepare(resumeSpec, owned), /exact owned session file/);
  await assert.rejects(f.prepare(taskSpec(f.directory), { ...owned, session: { kind: "resume", sessionFile: priorFile } }), /kind does not match/);
  const missing = join(f.directory, "prior", "absent.jsonl");
  await assert.rejects(f.prepare(resumeSpec, { ...owned, session: { kind: "resume", sessionFile: missing } }), /unavailable/);
});

test("resume reuses the exact owned session file while fresh and fork write a new one", async (t) => {
  const f = await prepareFixture(t);
  const priorFile = join(f.directory, "prior", "session.jsonl");
  await mkdir(dirname(priorFile), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "prior-session", cwd: f.directory }) + "\n";
  await writeFile(priorFile, header);
  const resumeSpec = normalizeTaskSpec({ prompt: "Continue", session: priorFile, cwd: f.directory, model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, thinking: "high", tools: ["read"] });
  const resumed = await f.prepare(resumeSpec, { directory: f.taskDirectory, taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1", session: { kind: "resume", sessionFile: priorFile } });
  assert.equal(resumed.sessionFile, priorFile);
  assert.deepEqual(resumed.args.slice(resumed.args.indexOf("--session"), resumed.args.indexOf("--session") + 2), ["--session", priorFile]);
  assert.equal(await readFile(priorFile, "utf8"), header);
  await assert.rejects(stat(join(f.taskDirectory, "session.jsonl")), { code: "ENOENT" });

  const forkDirectory = join(f.directory, "tasks", "task-2");
  const forked = await f.prepare(taskSpec(f.directory, { context: "fork", tools: ["read"] }), { directory: forkDirectory, taskId: "task-2", ownerId: "owner-1", nonce: "nonce-2", template: { parentSession: priorFile, entries: [] } });
  const forkHeader = JSON.parse((await readFile(forked.sessionFile, "utf8")).split("\n")[0]);
  assert.equal(forkHeader.parentSession, priorFile);
  assert.equal(forkHeader.cwd, f.directory);
});

test("task preparation without a launch binding stays compatible with existing callers", async (t) => {
  const f = await prepareFixture(t);
  const prepared = await f.prepare(taskSpec(f.directory), { directory: f.taskDirectory });
  assert.equal(prepared.sessionFile, join(f.taskDirectory, "session.jsonl"));
  assert.equal(prepared.binding, undefined);
  assert.equal(prepared.env[CHILD_BINDING_ENV.taskId], undefined);
  assert.equal(prepared.env[CHILD_BINDING_ENV.async], undefined);
  assert.deepEqual(Object.keys(prepared).sort(), ["args", "binding", "cliPath", "commandTimeoutMs", "cwd", "env", "sessionFile", "webTools"]);
  assert.equal(prepared.args[prepared.args.indexOf("--tools") + 1], "read,write,edit,bash,codemode,rpc_subagents_parent");
});
