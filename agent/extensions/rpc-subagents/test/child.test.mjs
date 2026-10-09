import test from "node:test";
import assert from "node:assert/strict";
import registerChildBridge, { collectToolInventory, readLaunchBinding } from "../child.ts";
import { BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME, decodeCoordinationEnvelope, verifyCapabilities } from "../coordination.mjs";
import { CHILD_BINDING_ENV } from "../runtime.mjs";

const binding = { taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" };
const launchEnv = (overrides = {}) => ({
  [CHILD_BINDING_ENV.flag]: "1",
  [CHILD_BINDING_ENV.taskId]: binding.taskId,
  [CHILD_BINDING_ENV.ownerId]: binding.ownerId,
  [CHILD_BINDING_ENV.nonce]: binding.nonce,
  [CHILD_BINDING_ENV.async]: "1",
  ...overrides,
});

const toolInventory = [
  { name: "read", exposure: "direct" },
  { name: "bash", exposure: "direct" },
  { name: "grep", exposure: "direct" },
  { name: "codemode", exposure: "model-only" },
  { name: "internal", exposure: "hidden" },
  { name: PARENT_TOOL_NAME, exposure: "model-only" },
];
const activeTools = ["read", "bash", "codemode", PARENT_TOOL_NAME];

function fakePi() {
  const state = { tools: new Map(), commands: new Map(), events: [], allTools: toolInventory, active: activeTools };
  return {
    state,
    registerTool(definition) { state.tools.set(definition.name, definition); },
    registerCommand(name, definition) { state.commands.set(name, definition); },
    on(event) { state.events.push(event); return () => {}; },
    getAllTools() { return state.allTools; },
    getActiveTools() { return state.active; },
  };
}

function fakeContext() {
  const notifications = [];
  const inputs = [];
  return {
    notifications,
    inputs,
    ui: {
      notify(message) { notifications.push(message); },
      input(title, placeholder, options) {
        const record = { title, placeholder, options };
        inputs.push(record);
        return new Promise((resolve) => {
          record.resolve = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
      },
    },
  };
}

function bridge(env = launchEnv()) {
  const pi = fakePi();
  registerChildBridge(pi, env);
  return pi;
}

const parentTool = (pi) => pi.state.tools.get(PARENT_TOOL_NAME);

test("the bridge registers only under a complete explicit child launch binding", () => {
  const plain = fakePi();
  registerChildBridge(plain, {});
  registerChildBridge(plain, { ...launchEnv(), [CHILD_BINDING_ENV.flag]: "0" });
  registerChildBridge(plain, launchEnv({ [CHILD_BINDING_ENV.async]: "" }));
  assert.equal(plain.state.tools.size, 0);
  assert.equal(plain.state.commands.size, 0);

  const bound = fakePi();
  registerChildBridge(bound, launchEnv());
  assert.equal(parentTool(bound).exposure, "model-only");
  assert.deepEqual(parentTool(bound).parameters.properties.kind.enum, ["ask", "report"]);
  assert.ok(bound.state.commands.has(BOOTSTRAP_COMMAND_NAME));
  assert.deepEqual(bound.state.events, []);

  assert.deepEqual(readLaunchBinding(launchEnv()), { binding, asynchronous: true });
  assert.equal(readLaunchBinding(launchEnv({ [CHILD_BINDING_ENV.async]: "0" })).asynchronous, false);
  assert.equal(readLaunchBinding({}), undefined);
  assert.equal(readLaunchBinding(launchEnv({ [CHILD_BINDING_ENV.nonce]: "" })), undefined);
});

test("the bootstrap command emits a verifiable inventory without a model call or session_start", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  await pi.state.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", ctx);
  assert.equal(ctx.inputs.length, 0);
  assert.equal(ctx.notifications.length, 1);
  const envelope = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(envelope.kind, "inventory");
  assert.deepEqual(envelope.inventory.registered, toolInventory.map((tool) => tool.name));
  assert.deepEqual(envelope.inventory.active, activeTools);
  assert.deepEqual(envelope.inventory.declared, activeTools);
  assert.deepEqual(envelope.inventory.callable, ["read", "bash"]);
  assert.equal(collectToolInventory(pi).exposures.codemode, "model-only");
  assert.deepEqual(verifyCapabilities(["read", "bash", "codemode"], [], envelope.inventory).reachable, ["bash", "codemode", "read", PARENT_TOOL_NAME]);
  assert.throws(() => verifyCapabilities(["read", "bash"], [], envelope.inventory), /unexpected \[codemode\]/);
  assert.deepEqual(pi.state.events, []);
});

test("report emits one report envelope and returns after emission", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "report", message: "Half done." }, undefined, undefined, ctx);
  assert.equal(ctx.inputs.length, 0);
  assert.equal(ctx.notifications.length, 1);
  const envelope = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(envelope.kind, "report");
  assert.equal(envelope.message, "Half done.");
  assert.deepEqual(result.details, { status: "reported", messageId: envelope.messageId });
  assert.equal(result.content[0].text, JSON.stringify(result.details));
});

test("a synchronous task returns requires_async without opening a dialog", async () => {
  const pi = bridge(launchEnv({ [CHILD_BINDING_ENV.async]: "0" }));
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "ask", question: "Which approach?" }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { status: "requires_async" });
  assert.equal(ctx.inputs.length, 0);
  assert.deepEqual(ctx.notifications, []);
});

test("an async ask carries its envelope on the RPC input dialog and resolves the answer", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Which approach?", timeoutMs: 2000 }, undefined, undefined, ctx);
  assert.equal(ctx.inputs.length, 1);
  const dialog = ctx.inputs[0];
  assert.equal(dialog.placeholder, "Answer for the blocked child task");
  assert.ok(dialog.options.timeout > 1500 && dialog.options.timeout <= 2000);
  assert.ok(dialog.options.signal instanceof AbortSignal);
  const ask = decodeCoordinationEnvelope(dialog.title, binding);
  assert.equal(ask.kind, "ask");
  assert.equal(ask.question, "Which approach?");
  assert.match(ask.requestId, /^ask-[0-9a-f-]{36}$/);
  assert.ok(ask.expiresAt > Date.now() && ask.expiresAt <= Date.now() + 2000);
  assert.equal(ctx.notifications.length, 0);
  dialog.resolve("Use approach A.");
  const result = await pending;
  assert.deepEqual(result.details, { status: "answered", value: "Use approach A." });
  const closed = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(closed.kind, "ask_closed");
  assert.equal(closed.requestId, ask.requestId);
  assert.equal(closed.reason, "answered");
});

test("a dismissed ask reports cancelled and closes the request", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Continue?" }, undefined, undefined, ctx);
  const ask = decodeCoordinationEnvelope(ctx.inputs[0].title, binding);
  ctx.inputs[0].resolve(undefined);
  const result = await pending;
  assert.deepEqual(result.details, { status: "cancelled" });
  const closed = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.deepEqual({ requestId: closed.requestId, reason: closed.reason }, { requestId: ask.requestId, reason: "cancelled" });
});

test("an aborted turn dismisses the ask and closes it as aborted", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const controller = new AbortController();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Continue?" }, controller.signal, undefined, ctx);
  assert.equal(ctx.inputs.length, 1);
  controller.abort();
  const result = await pending;
  assert.deepEqual(result.details, { status: "cancelled" });
  assert.equal(decodeCoordinationEnvelope(ctx.notifications[0], binding).reason, "aborted");
});

test("an unanswered ask expires as a timeout rather than as authorization", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "ask", question: "Anyone there?", timeoutMs: 1000 }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { status: "cancelled" });
  assert.equal(decodeCoordinationEnvelope(ctx.notifications[0], binding).reason, "timeout");
});
