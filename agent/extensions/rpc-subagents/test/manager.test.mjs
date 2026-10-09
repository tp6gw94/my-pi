import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../manager.mjs";
import { RpcTransport } from "../transport.mjs";
import { writeChildSession } from "../snapshot.mjs";
import { replayAndFollow } from "../viewer.mjs";
import { FakeRpcProcess, eventually, tick } from "./fake-rpc.mjs";

const taskCwd = process.cwd();
const taskSpec = (extra = {}) => {
  const base = { webAccess: false, prompt: "Test task", name: "test", cwd: taskCwd, model: { provider: "test", id: "model" }, thinking: "off", async: true, timeoutMs: 10000 };
  return { ...base, ...(extra.session === undefined ? { context: "fresh" } : {}), ...extra };
};

async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "rpc-subagents-manager-"));
  const children = [];
  const sessions = new Map();
  const prepare = async (spec, { taskId, ownerId, nonce, template, session }) => {
    const sessionFile = session.sessionFile;
    let sessionId;
    if (session.kind === "resume") sessionId = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]).id;
    else ({ sessionId } = await writeChildSession(sessionFile, { cwd: spec.cwd, template }));
    sessions.set(taskId, { sessionFile, sessionId });
    return { cliPath: "/installed/pi", args: [], cwd: spec.cwd, sessionFile, binding: { taskId, ownerId, nonce } };
  };
  const transportFactory = (options) => {
    const identity = sessions.get(options.binding.taskId);
    const child = new FakeRpcProcess({ sessionFile: identity.sessionFile, sessionId: identity.sessionId, binding: options.binding, tools: options.tools, ...overrides.fakeOptions });
    children.push(child);
    return new RpcTransport({ ...options, spawnImpl: () => child, signalGroup: (process, signal) => process.kill(signal), commandTimeoutMs: 200,
      cancelCommandTimeoutMs: 10, closeGraceMs: 10, termGraceMs: 10 });
  };
  const fleet = new FleetManager({ root, prepare, transportFactory, ...overrides });
  t.after(async () => { await fleet.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { fleet, children, root, sessions };
}

async function running(fleet, taskId) { await eventually(async () => (await fleet.status(taskId)).status === "running", "RPC prompt acceptance"); }

const assistantStart = () => ({ type: "message_start", message: { role: "assistant", content: [] } });
const textDelta = (delta) => ({ type: "text_delta", delta });
const assistantUpdate = (assistantMessageEvent, usage) => ({ type: "message_update", ...(usage === undefined ? {} : { usage }), assistantMessageEvent });
const assistantEnd = (text, usage) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...(usage === undefined ? {} : { usage }) } });
const settleWith = (child, text, usage) => { child.record(assistantEnd(text, usage)); child.record({ type: "agent_settled" }); };

test("async returns an ID promptly, acceptance is not completion, and wait/result expose settled text", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  assert.equal(accepted.status, "queued");
  assert.match(accepted.taskId, /^[0-9a-f-]{36}$/);
  await running(fleet, accepted.taskId);
  children[0].assistant("first turn"); children[0].record({ type: "agent_end", willRetry: true, messages: [] });
  const beforeSettled = await fleet.wait(accepted.taskId, { timeoutMs: 10 });
  assert.equal(beforeSettled.status, "running");
  children[0].settle("final answer");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "completed"); assert.equal(result.text, "final answer");
  assert.equal((await fleet.result(accepted.taskId)).text, "final answer");
  const records = (await readFile(result.eventFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.some((entry) => entry.source === "rpc" && entry.event.type === "agent_settled"), true);
  assert.equal(records.find((record) => record.event.type === "task_result").event.task.status, "completed");
  assert.deepEqual(records.at(-1).event, { type: "task_terminal", status: "completed" });
});

for (const [name, input, thinking, timeoutMs] of [
  ["high", { thinking: "high", timeoutMs: 300000 }, "high", 300000],
  ["off", { thinking: "off" }, "off", 10000],
  ["defaults", { thinking: undefined, timeoutMs: undefined }, "off", 1800000],
]) {
  test(`task results expose thinking and enforced timeout for ${name} through completion and persisted reads`, async (t) => {
    const { fleet, children, root } = await setup(t, { maxRetained: 0 });
    const accepted = await fleet.run(taskSpec(input));
    assert.equal(accepted.thinking, thinking);
    assert.equal(accepted.timeoutMs, timeoutMs);
    await running(fleet, accepted.taskId);
    const status = await fleet.status(accepted.taskId);
    assert.equal(status.thinking, thinking);
    assert.equal(status.timeoutMs, timeoutMs);
    assert.equal(fleet.list()[0].thinking, thinking);
    assert.equal(fleet.list()[0].timeoutMs, timeoutMs);
    children[0].settle("done");
    const result = await fleet.wait(accepted.taskId);
    assert.equal(result.status, "completed");
    assert.equal(result.thinking, thinking);
    assert.equal(result.timeoutMs, timeoutMs);
    const restarted = new FleetManager({ root, prepare() { throw new Error("No launch allowed"); } });
    t.after(() => restarted.shutdown());
    const saved = await restarted.result(accepted.taskId);
    assert.equal(saved.thinking, thinking);
    assert.equal(saved.timeoutMs, timeoutMs);
    assert.equal(saved.text, "done");
  });
}

test("legacy persisted results remain readable without inventing thinking or timeout", async (t) => {
  const { fleet, children, root } = await setup(t, { maxRetained: 0 });
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  children[0].settle("legacy result");
  await fleet.wait(accepted.taskId);
  const stateFile = join(root, "tasks", accepted.taskId, "state.json");
  const legacy = JSON.parse(await readFile(stateFile, "utf8"));
  delete legacy.thinking;
  delete legacy.timeoutMs;
  const content = JSON.stringify(legacy);
  await writeFile(stateFile, content);
  const restarted = new FleetManager({ root, prepare() { throw new Error("No launch allowed"); } });
  t.after(() => restarted.shutdown());
  const saved = await restarted.status(accepted.taskId);
  assert.equal(saved.status, "completed");
  assert.equal(saved.text, "legacy result");
  assert.equal(Object.hasOwn(saved, "thinking"), false);
  assert.equal(Object.hasOwn(saved, "timeoutMs"), false);
  assert.equal(await readFile(stateFile, "utf8"), content);
});

test("sync chains wait for final results and Promise.all observes independent concurrent runs", async (t) => {
  const { fleet, children } = await setup(t);
  const first = fleet.run(taskSpec({ async: false }));
  await eventually(() => children[0]?.prompt);
  children[0].settle("A");
  const result = await first;
  assert.equal(result.text, "A");
  const chained = fleet.run(taskSpec({ async: false, prompt: `Use ${result.text}` }));
  const parallel = fleet.run(taskSpec({ async: false, name: "parallel" }));
  await eventually(() => children[1]?.prompt && children[2]?.prompt);
  const chainedChild = children.slice(1).find((child) => child.prompt.message === "Use A");
  const parallelChild = children.slice(1).find((child) => child.prompt.message === "Test task");
  assert.equal(chainedChild.prompt.message, "Use A");
  chainedChild.settle("B"); parallelChild.settle("C");
  assert.deepEqual((await Promise.all([chained, parallel])).map((value) => [value.status, value.text]), [["completed", "B"], ["completed", "C"]]);
});

test("handled prompt disposition finishes without waiting for an absent agent_settled", async (t) => {
  const { fleet } = await setup(t, { fakeOptions: { disposition: "handled" } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "completed");
  assert.equal(result.state.disposition, "handled"); assert.equal(result.text, "");
});

test("fast settled events before the prompt response are retained", async (t) => {
  const { fleet } = await setup(t, { fakeOptions: { onCommand(command, process) {
    if (command.type !== "prompt") return;
    process.settle("fast"); process.respond(command, { disposition: "started" }); return true;
  } } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "completed"); assert.equal(result.text, "fast");
});

test("provider errors, retry failure, child abort, and child exit are not false successes", async (t) => {
  const { fleet, children } = await setup(t);
  const error = await fleet.run(taskSpec()); await running(fleet, error.taskId);
  children[0].settle("", "error", "provider denied");
  assert.equal((await fleet.wait(error.taskId)).error, "provider denied");
  const retry = await fleet.run(taskSpec()); await running(fleet, retry.taskId);
  children[1].assistant("", "error", "temporary");
  children[1].record({ type: "auto_retry_end", success: false, finalError: "retry exhausted" });
  children[1].record({ type: "agent_settled" });
  assert.equal((await fleet.wait(retry.taskId)).error, "retry exhausted");
  const abort = await fleet.run(taskSpec()); await running(fleet, abort.taskId);
  children[2].settle("partial", "aborted", "provider aborted");
  assert.equal((await fleet.wait(abort.taskId)).status, "cancelled");
  const exited = await fleet.run(taskSpec()); await running(fleet, exited.taskId);
  children[3].exit(9);
  assert.equal((await fleet.wait(exited.taskId)).status, "failed");
  assert.match((await fleet.result(exited.taskId)).error, /exited unexpectedly/);
});

test("retry success replaces the prior failed assistant", async (t) => {
  const { fleet, children } = await setup(t);
  const run = await fleet.run(taskSpec()); await running(fleet, run.taskId);
  children[0].assistant("bad", "error", "overloaded");
  children[0].record({ type: "auto_retry_start", attempt: 1 });
  children[0].settle("recovered");
  assert.deepEqual([(await fleet.wait(run.taskId)).status, (await fleet.result(run.taskId)).text], ["completed", "recovered"]);
});

test("concurrency limits queue tasks and cancellation of a queued task never launches it", async (t) => {
  const { fleet, children } = await setup(t, { concurrency: 1 });
  const first = await fleet.run(taskSpec()); const queued = await fleet.run(taskSpec({ name: "queued" }));
  const third = await fleet.run(taskSpec({ name: "third" }));
  await running(fleet, first.taskId);
  assert.equal((await fleet.status(queued.taskId)).status, "queued");
  assert.equal((await fleet.cancel(queued.taskId)).status, "cancelled");
  assert.equal(children.length, 1);
  children[0].settle("first"); await fleet.wait(first.taskId);
  await running(fleet, third.taskId);
  assert.equal(children.length, 2);
  children[1].settle("third");
  assert.equal((await fleet.wait(third.taskId)).text, "third");
});

test("cancellation fences an asynchronous preparation before a subprocess can launch", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { fleet, children } = await setup(t, { prepare: async () => { await blocked; return { cliPath: "/pi", cwd: taskCwd, args: [] }; } });
  const task = await fleet.run(taskSpec());
  await eventually(async () => (await fleet.status(task.taskId)).status === "starting");
  assert.equal((await fleet.cancel(task.taskId)).status, "cancelled");
  release(); await tick();
  assert.equal(children.length, 0);
  assert.equal((await fleet.status(task.taskId)).status, "cancelled");
});

test("running cancellation is idempotent and clears queued RPC work before abort", async (t) => {
  const { fleet, children } = await setup(t);
  const task = await fleet.run(taskSpec()); await running(fleet, task.taskId);
  const [a, b] = await Promise.all([fleet.cancel(task.taskId), fleet.cancel(task.taskId)]);
  assert.deepEqual([a.status, b.status], ["cancelled", "cancelled"]);
  assert.deepEqual(children[0].commands.slice(-2).map((command) => command.type), ["clear_queue", "abort"]);
  assert.equal(children[0].exited, true);
});

test("codemode cancellation cleans sync calls but does not kill intentionally detached async work", async (t) => {
  const { fleet, children } = await setup(t);
  const asyncAbort = new AbortController();
  const detached = await fleet.run(taskSpec(), { signal: asyncAbort.signal });
  asyncAbort.abort("script finished"); await running(fleet, detached.taskId);
  assert.equal((await fleet.status(detached.taskId)).status, "running");
  const waitAbort = new AbortController();
  const waiting = fleet.wait(detached.taskId, { signal: waitAbort.signal });
  waitAbort.abort("wait cancelled");
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal((await fleet.status(detached.taskId)).status, "running");
  const syncAbort = new AbortController();
  const sync = fleet.run(taskSpec({ async: false }), { signal: syncAbort.signal });
  await eventually(() => children[1]?.prompt);
  syncAbort.abort("script deadline");
  const syncResult = await sync.catch((error) => error);
  assert.equal(children[1].exited, true);
  assert.equal(syncResult.name, "AbortError");
  children[0].settle("detached done");
  assert.equal((await fleet.wait(detached.taskId)).status, "completed");
});

test("RPC dialogs wait for an explicit matching response and unanswered confirmations are refused", async (t) => {
  const { fleet, children } = await setup(t, { dialogTimeoutMs: 30 });
  const task = await fleet.run(taskSpec()); await running(fleet, task.taskId);
  children[0].record({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Permission?" });
  await eventually(async () => (await fleet.status(task.taskId)).status === "waiting_input");
  assert.equal((await fleet.status(task.taskId)).state.dialogs[0].id, "confirm-1");
  await assert.rejects(fleet.respond(task.taskId, "different-id", { confirmed: true }), /matching pending/);
  await eventually(() => children[0].commands.some((command) => command.type === "extension_ui_response"));
  assert.deepEqual(children[0].commands.find((command) => command.type === "extension_ui_response"), { type: "extension_ui_response", id: "confirm-1", cancelled: true });
  children[0].record({ type: "extension_ui_request", id: "input-1", method: "input", title: "Value?" });
  await eventually(async () => (await fleet.status(task.taskId)).state.dialogs?.[0]?.id === "input-1");
  assert.equal((await fleet.respond(task.taskId, "input-1", { value: "explicit" })).status, "running");
  assert.deepEqual(children[0].commands.at(-1), { type: "extension_ui_response", id: "input-1", value: "explicit" });
  children[0].settle("approved input"); assert.equal((await fleet.wait(task.taskId)).text, "approved input");
});

test("shutdown interrupts all owned tasks and releases resources without launching the queue", async (t) => {
  const { fleet, children } = await setup(t, { concurrency: 1 });
  const first = await fleet.run(taskSpec()); const queued = await fleet.run(taskSpec()); await running(fleet, first.taskId);
  await fleet.shutdown(); await fleet.shutdown();
  assert.deepEqual([(await fleet.status(first.taskId)).status, (await fleet.status(queued.taskId)).status], ["interrupted", "interrupted"]);
  assert.equal(children.length, 1); assert.equal(children[0].exited, true);
  assert.throws(() => fleet.submit(taskSpec()), /shutting down/);
});

test("unavailable child model fails clearly instead of silently accepting a fallback", async (t) => {
  const { fleet } = await setup(t, { fakeOptions: { model: { provider: "test", id: "fallback" } } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed"); assert.match(result.error, /No fallback is allowed/);
});

test("cancellation during the RPC startup handshake terminates the owned process", async (t) => {
  const { fleet, children } = await setup(t, { fakeOptions: { onCommand: (command) => command.type === "get_state" } });
  const task = await fleet.run(taskSpec());
  await eventually(() => children[0]?.commands.some((command) => command.type === "get_state"));
  const result = await fleet.cancel(task.taskId);
  assert.equal(result.status, "cancelled"); assert.equal(children[0].exited, true);
  assert.deepEqual(children[0].commands.map((command) => command.type), ["get_state", "clear_queue", "abort"]);
});

test("total task deadlines include queue time without starting an expired task", async (t) => {
  const { fleet, children } = await setup(t, { concurrency: 1 });
  const active = await fleet.run(taskSpec()); await running(fleet, active.taskId);
  const queued = await fleet.run(taskSpec({ timeoutMs: 100 }));
  const result = await fleet.wait(queued.taskId);
  assert.equal(result.status, "failed"); assert.equal(result.error, "Task deadline exceeded (100ms)");
  assert.equal(children.length, 1); assert.equal((await fleet.status(active.taskId)).status, "running");
});

test("event log overflow fails visibly and still cleans up the RPC child", async (t) => {
  const { fleet, children } = await setup(t, { journalOptions: { maxBytes: 256 } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed"); assert.match(result.error, /event log reached/);
  assert.equal(children[0].exited, true);
  assert.equal((await fleet.result(result.taskId)).status, "failed");
});

test("retention evicts only memory while old terminal results remain independently readable", async (t) => {
  const { fleet, children } = await setup(t, { maxRetained: 2 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const task = await fleet.run(taskSpec()); ids.push(task.taskId); await running(fleet, task.taskId);
    children[i].settle(`result ${i}`); await fleet.wait(task.taskId);
  }
  assert.deepEqual(fleet.list().map((task) => task.taskId), ids.slice(1));
  assert.equal((await fleet.result(ids[0])).text, "result 0");
});

test("pending dialog cancellation and shutdown escalate even if stdin never calls back", { timeout: 5000 }, async (t) => {
  for (const shutdown of [false, true]) {
    const { fleet, children } = await setup(t);
    const task = await fleet.run(taskSpec()); await running(fleet, task.taskId);
    children[0].record({ type: "extension_ui_request", id: "blocked", method: "confirm", title: "Permission?" });
    await eventually(async () => (await fleet.status(task.taskId)).status === "waiting_input");
    children[0].stdin._write = () => {};
    const transport = fleet.tasks.get(task.taskId).transport;
    transport.options.writeTimeoutMs = 10000;
    const started = Date.now();
    if (shutdown) await fleet.shutdown(); else await fleet.cancel(task.taskId);
    assert.ok(Date.now() - started < 1000, "dialog refusal did not delay cancellation");
    assert.equal((await fleet.status(task.taskId)).status, shutdown ? "interrupted" : "cancelled");
    assert.equal(children[0].exited, true);
    assert.equal(fleet.tasks.get(task.taskId).dialogs.size, 0);
    assert.equal(transport.writes.size, 0);
    assert.equal(transport.pending.size, 0);
  }
});

test("unsupported provider startup dialog cannot hang handshake or autoapprove", async (t) => {
  const { fleet, children } = await setup(t, { fakeOptions: { onCommand(command, child) {
    if (command.type === "get_state") {
      child.record({ type: "extension_ui_request", id: "startup", method: "confirm", title: "Startup permission" });
      return true;
    }
  } } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /get_state timed out/);
  assert.equal(children[0].exited, true);
  assert.equal(children[0].commands.some((command) => command.type === "extension_ui_response" && command.confirmed === true), false);
});

test("terminal snapshot survives failed append and eviction with Unicode output and exhausted journal", async (t) => {
  const { fleet, children } = await setup(t, { maxRetained: 0 });
  const accepted = await fleet.run(taskSpec()); await running(fleet, accepted.taskId);
  const task = fleet.tasks.get(accepted.taskId);
  task.text = "繁體😀".repeat(16000);
  task.journal.maxBytes = task.journal.bytes;
  await task.journal.append("fleet", { type: "padding", text: "x".repeat(130900) });
  const result = await fleet.stopTask(task, "failed", "多位元組錯誤😀".repeat(100000));
  assert.equal(result.status, "failed");
  assert.match(result.persistenceError, /byte limit/);
  assert.equal(fleet.tasks.has(result.taskId), false);
  const saved = await fleet.result(result.taskId);
  assert.equal(saved.status, "failed"); assert.equal(saved.text, task.text); assert.equal(saved.error, result.error);
  const restarted = new FleetManager({ root: fleet.root, prepare() { throw new Error("No launch allowed"); } });
  assert.equal((await restarted.result(result.taskId)).status, "failed");
  const records = (await readFile(result.eventFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.at(-1).event, { type: "task_terminal", status: "failed" });
  assert.ok(Buffer.byteLength(JSON.stringify(records.at(-1))) < 1024);
  assert.equal(children[0].exited, true);
  let output = "";
  await replayAndFollow(result.eventFile, { maxReplayBytes: 4096, pollMs: 5, write: async (text) => { output += text; } });
  assert.match(output, /結果 failed/);
});

test("terminal state snapshot is attempted independently of a non-capacity append failure", async (t) => {
  const { fleet, children } = await setup(t, { maxRetained: 0 });
  const accepted = await fleet.run(taskSpec()); await running(fleet, accepted.taskId);
  const task = fleet.tasks.get(accepted.taskId);
  const append = task.journal.append.bind(task.journal);
  task.journal.append = (source, event) => event.type === "task_result" ? Promise.reject(new Error("mock disk append failure")) : append(source, event);
  children[0].settle("繁體 final");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "completed");
  assert.equal((await fleet.result(result.taskId)).text, "繁體 final");
  assert.equal((await fleet.result(result.taskId)).persistenceError, "mock disk append failure");
});

test("settled without an authoritative terminal assistant is a failure, not a completion", async (t) => {
  const { fleet, children } = await setup(t);
  const task = await fleet.run(taskSpec()); await running(fleet, task.taskId);
  children[0].record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  children[0].record({ type: "agent_settled" });
  const result = await fleet.wait(task.taskId);
  assert.equal(result.status, "failed"); assert.equal(result.error, "RPC settled without a final assistant response");
});

test("per-response TPS exposes a live paired sample and reconciles final usage against the observed window", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  assert.equal(fleet.list().find((task) => task.taskId === run.taskId).tps, 12.5);
  clock = 9000;
  child.record(assistantEnd("ab", { output: 40 }));
  child.record(assistantEnd("ab", { output: 100 }));
  child.record(assistantUpdate(textDelta("x")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "abx");
  assert.equal((await fleet.status(run.taskId)).tps, 20);
  child.record({ type: "agent_settled" });
  const result = await fleet.wait(run.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.tps, 20);
});

test("thinking, toolcall, and usage-only updates advance trusted accounting against existing delta endpoints", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate({ type: "thinking_delta", delta: "think" }, { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  clock = 5000;
  child.record(assistantUpdate({ type: "toolcall_delta", delta: "{}" }, { output: 40 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 10);
  clock = 9000;
  child.record(assistantUpdate({ type: "text_end" }, { output: 45 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 11.25);
});

test("a later delta without trusted usage keeps the paired sample and a missing final usage is unknown", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  clock = 6000;
  child.record(assistantUpdate(textDelta("c")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "abc");
  assert.equal((await fleet.status(run.taskId)).tps, 12.5);
  settleWith(child, "abc");
  const result = await fleet.wait(run.taskId);
  assert.equal(result.status, "completed");
  assert.equal(Object.hasOwn(result, "tps"), false);
});

test("final-only usage reconciles after the response and untrusted counts never produce TPS", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "ab");
  assert.equal((await fleet.status(run.taskId)).tps, undefined);
  settleWith(child, "ab", { output: 25 });
  const result = await fleet.wait(run.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.tps, 12.5);

  let secondClock = 20000;
  const second = await setup(t, { monotonic: () => secondClock });
  const secondRun = await second.fleet.run(taskSpec());
  await running(second.fleet, secondRun.taskId);
  const secondChild = second.children[0];
  secondChild.record(assistantStart());
  secondChild.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await second.fleet.status(secondRun.taskId)).text === "a");
  secondClock = 22000;
  for (const output of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) secondChild.record(assistantUpdate(textDelta("b"), { output }));
  await eventually(async () => (await second.fleet.status(secondRun.taskId)).text === "abbbb");
  assert.equal((await second.fleet.status(secondRun.taskId)).tps, undefined);
  settleWith(secondChild, "abbbb", { output: 0 });
  const secondResult = await second.fleet.wait(secondRun.taskId);
  assert.equal(secondResult.status, "completed");
  assert.equal(Object.hasOwn(secondResult, "tps"), false);
});

test("a new assistant response resets TPS instead of reusing the previous window", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  child.record(assistantEnd("ab", { output: 40 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 20);
  child.record(assistantStart());
  clock = 10000;
  child.record(assistantUpdate(textDelta("c")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "c");
  assert.equal((await fleet.status(run.taskId)).tps, undefined);
  clock = 13000;
  child.record(assistantUpdate(textDelta("d"), { output: 30 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 10);
  settleWith(child, "cd", { output: 45 });
  const result = await fleet.wait(run.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.tps, 15);
});

test("bootstrap assistant output never establishes a task TPS", async (t) => {
  let clock = 1000;
  const { fleet } = await setup(t, { monotonic: () => clock, fakeOptions: { onBootstrap(command, child) {
    child.record(assistantStart());
    clock = 5000;
    child.record(assistantUpdate(textDelta("bootstrap"), { output: 50 }));
    child.record(assistantEnd("bootstrap", { output: 50 }));
    child.respond(command, { disposition: "handled" });
    child.notifyInventory();
    return true;
  } } });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  assert.equal((await fleet.status(run.taskId)).tps, undefined);
});

test("stop freezes the paired sample and a late final end reconciles only against frozen endpoints", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  const task = fleet.tasks.get(run.taskId);
  let releaseCancel;
  const realCancel = task.transport.cancel.bind(task.transport);
  task.transport.cancel = () => new Promise((resolve) => { releaseCancel = () => realCancel().then(resolve); });
  const cancelling = fleet.cancel(run.taskId);
  assert.equal(fleet.publicTask(task).tps, 12.5);
  clock = 9000;
  child.record(assistantUpdate(textDelta("late")));
  child.record(assistantEnd("ab", { output: 40 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 20);
  releaseCancel();
  const result = await cancelling;
  assert.equal(result.status, "cancelled");
  assert.equal(result.tps, 20);
});

test("a record admitted before stop cannot extend a frozen window after its journal append resolves", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  const task = fleet.tasks.get(run.taskId);
  const append = task.journal.append.bind(task.journal);
  let release;
  let blocked;
  task.journal.append = (source, event) => {
    if (source === "rpc" && event.type === "message_update") {
      blocked = new Promise((resolve) => { release = resolve; });
      return blocked.then(() => append(source, event));
    }
    return append(source, event);
  };
  clock = 9000;
  child.record(assistantUpdate(textDelta("late"), { output: 40 }));
  await eventually(() => blocked !== undefined);
  const cancelling = fleet.cancel(run.taskId);
  release();
  const result = await cancelling;
  assert.equal(result.status, "cancelled");
  assert.equal(result.tps, 12.5);
});

test("legacy terminal snapshots remain readable and nonterminal restores omit stale TPS", async (t) => {
  let clock = 1000;
  const { fleet, children, root } = await setup(t, { monotonic: () => clock, maxRetained: 0 });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  const task = fleet.tasks.get(run.taskId);
  await task.journal.snapshot(fleet.publicTask(task));
  const stateFile = join(root, "tasks", run.taskId, "state.json");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tps, 12.5);
  const restarted = new FleetManager({ root, prepare() { throw new Error("No launch allowed"); } });
  t.after(() => restarted.shutdown());
  const orphan = await restarted.status(run.taskId);
  assert.equal(orphan.status, "interrupted");
  assert.equal(Object.hasOwn(orphan, "tps"), false);
  settleWith(child, "ab", { output: 40 });
  const completed = await fleet.wait(run.taskId);
  assert.equal(completed.tps, 20);
  const terminal = JSON.parse(await readFile(stateFile, "utf8"));
  delete terminal.tps;
  await writeFile(stateFile, JSON.stringify(terminal));
  const legacy = await restarted.status(run.taskId);
  assert.equal(legacy.status, "completed");
  assert.equal(Object.hasOwn(legacy, "tps"), false);
});

test("overflowing TPS arithmetic yields an omitted value instead of Infinity", async (t) => {
  let clock = 1000;
  const { fleet, children } = await setup(t, { monotonic: () => clock });
  const run = await fleet.run(taskSpec());
  await running(fleet, run.taskId);
  const child = children[0];
  child.record(assistantStart());
  child.record(assistantUpdate(textDelta("a")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "a");
  clock = 3000;
  child.record(assistantUpdate(textDelta("b"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).tps === 12.5);
  child.record(assistantEnd("ab", { output: 25 }));
  child.record(assistantStart());
  clock = 0;
  child.record(assistantUpdate(textDelta("c")));
  await eventually(async () => (await fleet.status(run.taskId)).text === "c");
  clock = 1e-310;
  child.record(assistantUpdate(textDelta("d"), { output: 25 }));
  await eventually(async () => (await fleet.status(run.taskId)).text === "cd");
  assert.equal(Object.hasOwn(await fleet.status(run.taskId), "tps"), false);
});
