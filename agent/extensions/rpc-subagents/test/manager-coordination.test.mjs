import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../manager.mjs";
import { RpcTransport } from "../transport.mjs";
import { writeChildSession } from "../snapshot.mjs";
import { BOOTSTRAP_PROMPT } from "../coordination.mjs";
import { FakeRpcProcess, eventually, tick } from "./fake-rpc.mjs";

const taskCwd = process.cwd();
const taskSpec = (extra = {}) => {
  const base = { webAccess: false, prompt: "Test task", name: "test", cwd: taskCwd, model: { provider: "test", id: "model" }, thinking: "off", async: true, timeoutMs: 10000 };
  return { ...base, ...(extra.session === undefined ? { context: "fresh" } : {}), ...extra };
};

async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "rpc-subagents-coordination-"));
  const children = [];
  const sessions = new Map();
  const basePrepare = async (spec, { taskId, ownerId, nonce, template, session }) => {
    const sessionFile = session.sessionFile;
    let sessionId;
    if (session.kind === "resume") sessionId = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]).id;
    else ({ sessionId } = await writeChildSession(sessionFile, { cwd: spec.cwd, template }));
    sessions.set(taskId, { sessionFile, sessionId });
    return { cliPath: "/installed/pi", args: [], cwd: spec.cwd, sessionFile, binding: { taskId, ownerId, nonce } };
  };
  const { prepare: providedPrepare, fakeOptions, transportOptions, ...managerOptions } = overrides;
  const prepare = providedPrepare ? (spec, context) => providedPrepare(spec, context, basePrepare) : basePrepare;
  const transportFactory = (options) => {
    const identity = sessions.get(options.binding.taskId);
    const child = new FakeRpcProcess({ sessionFile: identity.sessionFile, sessionId: identity.sessionId, binding: options.binding, tools: options.tools, ...fakeOptions });
    children.push(child);
    return new RpcTransport({ ...options, spawnImpl: () => child, signalGroup: (process, signal) => process.kill(signal), commandTimeoutMs: 200,
      cancelCommandTimeoutMs: 10, closeGraceMs: 10, termGraceMs: 10, ...transportOptions });
  };
  const fleet = new FleetManager({ root, prepare, transportFactory, ...managerOptions });
  t.after(async () => { await fleet.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { fleet, children, root, sessions };
}

async function running(fleet, taskId) { await eventually(async () => (await fleet.status(taskId)).status === "running", "RPC prompt acceptance"); }
async function pendingWithRequest(fleet, taskId) {
  let value;
  await eventually(async () => {
    value = await fleet.pending(taskId);
    return value.requests.length === 1 && (await fleet.status(taskId)).status === "waiting_input";
  }, "pending coordination request");
  return value;
}

function fakeClock(start = 1000000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, ms) { const id = nextId++; timers.set(id, { callback, at: current + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    set(ms) { current = ms; },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > current) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

test("bootstrap verifies capability inventory and session identity before the user prompt", async (t) => {
  const { fleet, children, root, sessions } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const child = children[0];
  assert.deepEqual(child.commands.map((command) => command.type === "prompt" ? `prompt:${command.message}` : command.type),
    ["get_state", "get_available_thinking_levels", "set_thinking_level", `prompt:${BOOTSTRAP_PROMPT}`, "prompt:Test task"]);
  const identity = sessions.get(accepted.taskId);
  const live = await fleet.status(accepted.taskId);
  assert.equal(live.sessionFile, identity.sessionFile);
  assert.equal(live.sessionId, identity.sessionId);
  assert.equal(live.sessionReusable, undefined);
  assert.deepEqual(live.capabilities.requested, ["read", "write", "edit", "bash", "codemode"]);
  assert.deepEqual(live.capabilities.reachable, ["bash", "codemode", "edit", "read", "rpc_subagents_parent", "write"]);
  child.settle("bootstrap done");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.sessionReusable, true);
  assert.equal(result.sessionFile, identity.sessionFile);
  assert.equal(result.sessionId, identity.sessionId);
  assert.deepEqual(await readdir(join(root, "session-leases")), []);
});

test("missing bootstrap inventory fails before the user prompt", async (t) => {
  const { fleet, children } = await setup(t, { bootstrapTimeoutMs: 50, fakeOptions: { onBootstrap(command, child) { child.respond(command, { disposition: "handled" }); return true; } } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /inventory was not received/);
  assert.equal(children[0].prompt, undefined);
  assert.equal(children[0].commands.some((command) => command.message === "Test task"), false);
  assert.equal(children[0].exited, true);
});

test("a bootstrap that is not handled never becomes user acceptance", async (t) => {
  const { fleet, children } = await setup(t, { bootstrapTimeoutMs: 50, fakeOptions: { onBootstrap(command, child) { child.respond(command, { disposition: "started" }); child.notifyInventory(); return true; } } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /Bootstrap command was not handled/);
  assert.equal(children[0].prompt, undefined);
});

test("a bootstrap receipt withheld past the deadline cannot be rescued by a late receipt or inventory", async (t) => {
  const clock = fakeClock();
  let held;
  const { fleet, children } = await setup(t, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, bootstrapTimeoutMs: 50,
    transportOptions: { commandTimeoutMs: 1000 },
    fakeOptions: { onBootstrap(command) { held = command; return true; } } });
  const accepted = await fleet.run(taskSpec());
  await eventually(() => held, "withheld bootstrap receipt");
  clock.advance(51);
  children[0].notifyInventory();
  children[0].respond(held, { disposition: "handled" });
  await eventually(async () => (await fleet.status(accepted.taskId)).status === "failed", "bootstrap deadline failure");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "failed");
  assert.match(result.error, /inventory was not received before the handshake deadline/);
  assert.equal(children[0].prompt, undefined);
  assert.equal(children[0].commands.some((command) => command.message === "Test task"), false);
  assert.equal(clock.pending(), 0);
});

test("a capability mismatch fails before the user prompt", async (t) => {
  const { fleet, children } = await setup(t, { fakeOptions: { tools: ["read"] } });
  const result = await fleet.run(taskSpec({ async: false }));
  assert.equal(result.status, "failed");
  assert.match(result.error, /Capability mismatch/);
  assert.equal(children[0].prompt, undefined);
  assert.equal(children[0].exited, true);
});

test("a coordination ask appears in pending, and only reply answers it", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Which database should run?");
  const pending = await pendingWithRequest(fleet, accepted.taskId);
  assert.deepEqual(Object.keys(pending.requests[0]).sort(), ["expiresAt", "question", "requestId"]);
  assert.equal(pending.requests[0].requestId, ask.requestId);
  assert.equal(pending.requests[0].question, "Which database should run?");
  assert.ok(pending.requests[0].expiresAt <= ask.expiresAt);
  assert.equal(JSON.stringify(pending).includes(ask.nativeId), false);
  assert.equal(JSON.stringify(pending).includes("nonce"), false);
  const waiting = await fleet.status(accepted.taskId);
  assert.equal(waiting.status, "waiting_input");
  assert.deepEqual(waiting.state.requests.map((request) => request.requestId), [ask.requestId]);
  await assert.rejects(fleet.respond(accepted.taskId, ask.requestId, { value: "sqlite" }), /coordination reply/);
  await assert.rejects(fleet.respond(accepted.taskId, ask.nativeId, { value: "sqlite" }), /private/);
  await assert.rejects(fleet.reply(accepted.taskId, "ask-other", { value: "sqlite" }), /No matching pending/);
  const replied = await fleet.reply(accepted.taskId, ask.requestId, { value: "sqlite" });
  assert.equal(replied.status, "running");
  assert.deepEqual(children[0].responses.at(-1), { type: "extension_ui_response", id: ask.nativeId, value: "sqlite" });
  await eventually(async () => (await fleet.pending(accepted.taskId)).requests.length === 0, "answered request cleared");
  children[0].settle("replied");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("coordination requests and ordinary UI dialogs use separate maps", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Pick one");
  await pendingWithRequest(fleet, accepted.taskId);
  children[0].record({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Permission?" });
  await eventually(async () => (await fleet.status(accepted.taskId)).state.dialogs?.length === 1, "ordinary dialog");
  const state = await fleet.status(accepted.taskId);
  assert.deepEqual(state.state.dialogs.map((dialog) => dialog.id), ["confirm-1"]);
  assert.deepEqual(state.state.requests.map((request) => request.requestId), [ask.requestId]);
  await assert.rejects(fleet.reply(accepted.taskId, "confirm-1", { value: "x" }), /No matching pending/);
  await fleet.respond(accepted.taskId, "confirm-1", { confirmed: true });
  assert.deepEqual(children[0].responses.at(-1), { type: "extension_ui_response", id: "confirm-1", confirmed: true });
  await fleet.reply(accepted.taskId, ask.requestId, { value: "sqlite" });
  children[0].settle("separated");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("replies require the exact normalized shape and are claimed synchronously", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Shape?");
  await pendingWithRequest(fleet, accepted.taskId);
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { value: 7 }), /answer.value/);
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { cancelled: false }), /cancelled/);
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { value: "x", cancelled: true }), /unsupported fields/);
  assert.equal((await fleet.pending(accepted.taskId)).requests.length, 1);
  const first = fleet.reply(accepted.taskId, ask.requestId, { value: "one" });
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { value: "two" }), /No matching pending/);
  await first;
  children[0].settle("shaped");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("expiry closes an unanswered request and refuses a late reply", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Quick?", { timeoutMs: 60 });
  await pendingWithRequest(fleet, accepted.taskId);
  await eventually(() => children[0].responses.some((response) => response.id === ask.nativeId && response.cancelled === true), "expired request refusal");
  assert.equal((await fleet.pending(accepted.taskId)).requests.length, 0);
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { value: "late" }), /No matching pending/);
  children[0].settle("expired ok");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("a reply that observes expiry restores state before rejecting and tolerates a late ask_closed", async (t) => {
  const clock = fakeClock();
  const { fleet, children } = await setup(t, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Too late?");
  const pending = await pendingWithRequest(fleet, accepted.taskId);
  clock.set(pending.requests[0].expiresAt + 1);
  await assert.rejects(fleet.reply(accepted.taskId, ask.requestId, { value: "late" }), /expired before the reply/);
  const state = await fleet.status(accepted.taskId);
  assert.equal(state.status, "running");
  assert.equal(state.state.requests, undefined);
  assert.deepEqual((await fleet.pending(accepted.taskId)).requests, []);
  children[0].askClosed(ask.requestId, "timeout");
  await tick();
  assert.equal((await fleet.status(accepted.taskId)).status, "running");
  children[0].settle("late reply refused");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
  assert.equal(clock.pending(), 0);
});

test("duplicate coordination request IDs fail the task visibly", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("First?");
  await pendingWithRequest(fleet, accepted.taskId);
  children[0].ask("Second?", { requestId: ask.requestId, nativeId: "dialog-duplicate" });
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Duplicate coordination request ID/);
  assert.equal(children[0].exited, true);
});

test("ask_closed clears the request idempotently and restores running", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Still there?");
  await pendingWithRequest(fleet, accepted.taskId);
  children[0].askClosed(ask.requestId, "timeout");
  await eventually(async () => (await fleet.status(accepted.taskId)).status === "running", "running after ask_closed");
  children[0].askClosed(ask.requestId, "timeout");
  await tick();
  assert.equal((await fleet.pending(accepted.taskId)).requests.length, 0);
  assert.equal((await fleet.status(accepted.taskId)).status, "running");
  children[0].settle("closed");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("cancellation refuses pending asks and clears them", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const ask = children[0].ask("Blocked?");
  await pendingWithRequest(fleet, accepted.taskId);
  const result = await fleet.cancel(accepted.taskId);
  assert.equal(result.status, "cancelled");
  assert.equal((await fleet.pending(accepted.taskId)).requests.length, 0);
  assert.equal(children[0].responses.some((response) => response.id === ask.nativeId && response.cancelled === true), true);
});

test("native steer returns only the RPC receipt and validates its input", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  assert.deepEqual(await fleet.steer(accepted.taskId, "Change direction"), { taskId: accepted.taskId, disposition: "queued" });
  children[0].steerDisposition = "handled";
  assert.deepEqual(await fleet.steer(accepted.taskId, "Handle this"), { taskId: accepted.taskId, disposition: "handled" });
  assert.deepEqual(children[0].commands.filter((command) => command.type === "steer").map((command) => command.message), ["Change direction", "Handle this"]);
  await assert.rejects(fleet.steer(accepted.taskId, "x".repeat(8193)), /8192/);
  await assert.rejects(fleet.steer(accepted.taskId, "   "), /nonempty/);
  children[0].settle("steered");
  await fleet.wait(accepted.taskId);
});

test("steer rejects queued, idle, and terminal tasks without sending a native command", async (t) => {
  const { fleet, children } = await setup(t, { concurrency: 1 });
  const active = await fleet.run(taskSpec());
  const queued = await fleet.run(taskSpec({ name: "queued" }));
  await assert.rejects(fleet.steer(queued.taskId, "too early"), /accepted, live RPC task/);
  await running(fleet, active.taskId);
  children[0].isStreaming = false;
  await assert.rejects(fleet.steer(active.taskId, "idle child"), /not streaming/);
  children[0].isStreaming = true;
  children[0].settle("done");
  await fleet.wait(active.taskId);
  await assert.rejects(fleet.steer(active.taskId, "after settle"), /accepted, live RPC task/);
  assert.equal(children[0].commands.filter((command) => command.type === "steer").length, 0);
});

test("steer fences after the state query when the task stops first", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const child = children[0];
  let held;
  child.onCommand = (command) => { if (command.type === "get_state") { held = command; return true; } };
  const steering = fleet.steer(accepted.taskId, "race");
  await eventually(() => held, "held steer state query");
  const stopping = fleet.cancel(accepted.taskId);
  await tick();
  child.respond(held, { model: child.model, isStreaming: true, sessionFile: child.sessionFile, sessionId: child.sessionId });
  await assert.rejects(steering);
  await stopping;
  assert.equal(child.commands.some((command) => command.type === "steer"), false);
});

test("resume reuses the original session file and identity with a new task ID", async (t) => {
  const { fleet, children, sessions } = await setup(t);
  const first = await fleet.run(taskSpec());
  await running(fleet, first.taskId);
  const identity = sessions.get(first.taskId);
  children[0].settle("first answer");
  const firstResult = await fleet.wait(first.taskId);
  assert.equal(firstResult.sessionReusable, true);
  const second = await fleet.run(taskSpec({ session: firstResult.sessionId }));
  await running(fleet, second.taskId);
  const secondIdentity = sessions.get(second.taskId);
  assert.equal(secondIdentity.sessionFile, identity.sessionFile);
  assert.equal(secondIdentity.sessionId, identity.sessionId);
  children[1].settle("second answer");
  const secondResult = await fleet.wait(second.taskId);
  assert.equal(secondResult.status, "completed");
  assert.equal(secondResult.sessionFile, identity.sessionFile);
  assert.equal(secondResult.sessionId, identity.sessionId);
  assert.equal(secondResult.continuedFromTaskId, first.taskId);
  assert.notEqual(second.taskId, first.taskId);
  const header = JSON.parse((await readFile(identity.sessionFile, "utf8")).split("\n")[0]);
  assert.equal(header.id, identity.sessionId);
});

test("a live lease excludes a second resume of the same session file", async (t) => {
  const { fleet, children, sessions } = await setup(t);
  const first = await fleet.run(taskSpec());
  await running(fleet, first.taskId);
  const identity = sessions.get(first.taskId);
  const blocked = await fleet.run(taskSpec({ session: identity.sessionId, async: false }));
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error, /Session lease/i);
  assert.equal(children.length, 1);
  children[0].settle("only child");
  assert.equal((await fleet.wait(first.taskId)).status, "completed");
});

test("cancelling a resume before launch releases its lease and restores the prior catalog", async (t) => {
  let hold = false;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { fleet, children, sessions } = await setup(t, { prepare: async (spec, context, base) => { if (hold) await blocked; return base(spec, context); } });
  const first = await fleet.run(taskSpec());
  await running(fleet, first.taskId);
  const identity = sessions.get(first.taskId);
  children[0].settle("done");
  const firstResult = await fleet.wait(first.taskId);
  hold = true;
  const second = await fleet.run(taskSpec({ session: firstResult.sessionId }));
  await eventually(async () => (await fleet.status(second.taskId)).status === "starting", "blocked resume preparation");
  assert.equal((await fleet.cancel(second.taskId)).status, "cancelled");
  release();
  await tick();
  assert.equal(children.length, 1);
  hold = false;
  const third = await fleet.run(taskSpec({ session: firstResult.sessionId }));
  await running(fleet, third.taskId);
  assert.equal(children.length, 2);
  children[1].settle("resumed after cancel");
  const thirdResult = await fleet.wait(third.taskId);
  assert.equal(thirdResult.status, "completed");
  assert.equal(thirdResult.sessionFile, identity.sessionFile);
});

test("uncertain terminal persistence retains the lease and blocks reuse", async (t) => {
  const { fleet, children, root } = await setup(t);
  const first = await fleet.run(taskSpec());
  await running(fleet, first.taskId);
  children[0].settle("done");
  const firstResult = await fleet.wait(first.taskId);
  assert.equal(firstResult.sessionReusable, true);
  const second = await fleet.run(taskSpec({ session: firstResult.sessionId }));
  await running(fleet, second.taskId);
  const journal = fleet.tasks.get(second.taskId).journal;
  const snapshot = journal.snapshot.bind(journal);
  journal.snapshot = (value) => value.status === "completed" ? Promise.reject(new Error("mock terminal snapshot failure")) : snapshot(value);
  children[1].settle("second");
  const secondResult = await fleet.wait(second.taskId);
  assert.equal(secondResult.status, "completed");
  assert.equal(secondResult.persistenceError, "mock terminal snapshot failure");
  assert.equal(secondResult.sessionReusable, false);
  assert.equal((await readdir(join(root, "session-leases"))).length, 1);
  const third = await fleet.run(taskSpec({ session: firstResult.sessionId, async: false }));
  assert.equal(third.status, "failed");
  assert.match(third.error, /Session lease/i);
  assert.equal(children.length, 2);
});

test("uncertain child closure retains the lease and never reports reuse", async (t) => {
  const { fleet, children, root } = await setup(t);
  const first = await fleet.run(taskSpec());
  await running(fleet, first.taskId);
  children[0].settle("done");
  const firstResult = await fleet.wait(first.taskId);
  const second = await fleet.run(taskSpec({ session: firstResult.sessionId }));
  await running(fleet, second.taskId);
  children[1].stubborn = true;
  children[1].settle("second");
  const secondResult = await fleet.wait(second.taskId);
  assert.equal(secondResult.status, "completed");
  assert.match(secondResult.state.cleanupError, /did not close/);
  assert.equal(secondResult.sessionReusable, false);
  assert.equal((await readdir(join(root, "session-leases"))).length, 1);
  const third = await fleet.run(taskSpec({ session: firstResult.sessionId, async: false }));
  assert.equal(third.status, "failed");
  assert.match(third.error, /Session lease/i);
});

test("reports stream through a bounded ring with sequence and a terminal tail", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  for (let index = 1; index <= 70; index++) children[0].report(`report ${index}`, { messageId: `msg-${index}` });
  await eventually(async () => (await fleet.pending(accepted.taskId, { limit: 64 })).nextAfter === 70, "all reports received");
  const pending = await fleet.pending(accepted.taskId, { limit: 64 });
  assert.equal(pending.reports.length, 64);
  assert.equal(pending.reports[0].seq, 7);
  assert.equal(pending.droppedThrough, 6);
  assert.equal(pending.nextAfter, 70);
  const tail = await fleet.pending(accepted.taskId, { after: 65, limit: 3 });
  assert.deepEqual(tail.reports.map((report) => report.seq), [66, 67, 68]);
  assert.equal(tail.nextAfter, 68);
  children[0].settle("reported");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.reports.length, 64);
  assert.equal(result.droppedReportsThrough, 6);
  const terminal = await fleet.pending(accepted.taskId);
  assert.equal(terminal.requests.length, 0);
  assert.equal(terminal.reports.length, 32);
  assert.equal(terminal.nextAfter, 38);
});

test("pending limit bounds pending requests as well as reports", async (t) => {
  const { fleet, children } = await setup(t);
  const accepted = await fleet.run(taskSpec());
  await running(fleet, accepted.taskId);
  const first = children[0].ask("First?");
  children[0].ask("Second?");
  await eventually(async () => (await fleet.pending(accepted.taskId)).requests.length === 2, "two pending requests");
  const bounded = await fleet.pending(accepted.taskId, { limit: 1 });
  assert.deepEqual(bounded.requests.map((request) => request.requestId), [first.requestId]);
  assert.equal(bounded.reports.length, 0);
  assert.equal((await fleet.pending(accepted.taskId)).requests.length, 2);
  children[0].settle("bounded");
  assert.equal((await fleet.wait(accepted.taskId)).status, "completed");
});

test("controlled web activation refreshes the public and persisted capability snapshot", async (t) => {
  const registered = ["read", "fetch_page", "web_enable", "rpc_subagents_parent"];
  const active = ["read", "web_enable", "rpc_subagents_parent"];
  const inventory = { registered, active, declared: active, callable: ["read", "web_enable"],
    exposures: { read: "direct", fetch_page: "direct", web_enable: "direct", rpc_subagents_parent: "model-only" },
    webTools: ["fetch_page", "web_enable"] };
  const { fleet, children } = await setup(t, { fakeOptions: { inventory } });
  const accepted = await fleet.run(taskSpec({ tools: ["read"], webAccess: true }));
  await running(fleet, accepted.taskId);
  assert.equal((await fleet.status(accepted.taskId)).capabilities.reachable.includes("fetch_page"), false);
  const enabled = { ...inventory, active: registered, declared: registered, callable: ["read", "fetch_page", "web_enable"] };
  children[0].notifyInventory(enabled);
  await eventually(async () => (await fleet.status(accepted.taskId)).capabilities.reachable.includes("fetch_page"), "enabled public capability");
  children[0].settle("Enabled web access");
  const result = await fleet.wait(accepted.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.webAccess, true);
  assert.ok(result.capabilities.reachable.includes("fetch_page"));
  assert.deepEqual((await fleet.result(accepted.taskId)).capabilities.webTools, ["fetch_page", "web_enable"]);
});

test("web refresh rejects a substituted family or an unrelated reachable tool", async (t) => {
  const inventory = { registered: ["read", "fetch_page", "rpc_subagents_parent"],
    active: ["read", "fetch_page", "rpc_subagents_parent"], declared: ["read", "fetch_page", "rpc_subagents_parent"],
    callable: ["read", "fetch_page"], exposures: { read: "direct", fetch_page: "direct", rpc_subagents_parent: "model-only" },
    webTools: ["fetch_page"] };
  for (const familyChanged of [false, true]) {
    const { fleet, children } = await setup(t, { fakeOptions: { inventory } });
    const accepted = await fleet.run(taskSpec({ tools: ["read"], webAccess: true }));
    await running(fleet, accepted.taskId);
    const updated = { ...inventory, registered: [...inventory.registered, "unrelated"],
      active: [...inventory.active, "unrelated"], declared: [...inventory.declared, "unrelated"],
      callable: [...inventory.callable, "unrelated"], exposures: { ...inventory.exposures, unrelated: "direct" },
      webTools: familyChanged ? [...inventory.webTools, "unrelated"] : inventory.webTools };
    children[0].notifyInventory(updated);
    const result = await fleet.wait(accepted.taskId);
    assert.equal(result.status, "failed");
    assert.match(result.error, familyChanged ? /family changed/ : /unexpected \[unrelated\]/);
  }
});

test("pending validates task IDs and options", async (t) => {
  const { fleet } = await setup(t);
  await assert.rejects(fleet.pending("not-a-task"), /Invalid task ID/);
  await assert.rejects(fleet.pending(randomUUID(), { limit: 999 }), /limit/);
  await assert.rejects(fleet.pending(randomUUID(), { after: -1 }), /after/);
  await assert.rejects(fleet.reply(randomUUID(), "ask-x", { value: "x" }), /No live task/);
  await assert.rejects(fleet.steer(randomUUID(), "hello"), /No live task/);
});
