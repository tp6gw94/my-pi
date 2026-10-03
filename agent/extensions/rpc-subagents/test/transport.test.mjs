import test from "node:test";
import assert from "node:assert/strict";
import { LFDecoder, RpcTransport, childEnvironment } from "../transport.mjs";
import { FakeRpcProcess, eventually } from "./fake-rpc.mjs";

function client(child, overrides = {}) {
  return new RpcTransport({ cliPath: "/installed/pi/dist/bundle/cli.js", cwd: "/project", args: ["--no-extensions"],
    spawnImpl: () => child, signalGroup: (process, signal) => process.kill(signal), commandTimeoutMs: 100,
    closeGraceMs: 10, termGraceMs: 10, cancelCommandTimeoutMs: 10, ...overrides });
}

test("LF framing preserves U+2028/U+2029 and UTF-8 split at every byte", () => {
  const decoder = new LFDecoder();
  const bytes = Buffer.from('{"type":"event","text":"繁體\u2028文字\u2029😀"}\r\n{"type":"next"}\n');
  const records = [];
  for (const byte of bytes) records.push(...decoder.push(Buffer.from([byte])));
  decoder.finish();
  assert.deepEqual(records.map(JSON.parse), [{ type: "event", text: "繁體\u2028文字\u2029😀" }, { type: "next" }]);
});

test("RPC requests correlate IDs rather than response order and stderr is never protocol", async () => {
  const child = new FakeRpcProcess({ onCommand: (command) => ["first", "second"].includes(command.type) });
  const events = []; const diagnostics = [];
  const transport = client(child, { onRecord: (event) => events.push(event), onStderr: (text) => diagnostics.push(text) });
  transport.start();
  const first = transport.request("first"); const second = transport.request("second");
  await eventually(() => child.commands.length === 2);
  child.stderr.write('{"type":"response","success":true,"data":"not a response"}\n');
  child.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "繁\u2028體\u2029" } });
  child.respond(child.commands[1], "second result"); child.respond(child.commands[0], "first result");
  assert.deepEqual(await Promise.all([first, second]), ["first result", "second result"]);
  assert.equal(events[0].assistantMessageEvent.delta, "繁\u2028體\u2029");
  assert.equal(diagnostics.join(""), '{"type":"response","success":true,"data":"not a response"}\n');
  await transport.close();
});

test("commands honor Writable backpressure and the record reader awaits the event sink", async () => {
  const child = new FakeRpcProcess();
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const events = [];
  const transport = client(child, { onRecord: async (event) => { events.push(event.type); if (event.type === "blocked") await blocked; } });
  transport.start();
  child.record({ type: "blocked" }); child.record({ type: "next" });
  await eventually(() => events.length === 1);
  assert.deepEqual(events, ["blocked"]);
  unblock(); await eventually(() => events.length === 2);
  assert.deepEqual(events, ["blocked", "next"]);
  await transport.close();
});

test("spawn failures and command rejections retain distinct error kinds", async () => {
  const failed = new RpcTransport({ cliPath: "/missing", cwd: "/project", args: [], spawnImpl: () => { throw new Error("ENOENT"); } });
  failed.start();
  await assert.rejects(failed.request("get_state"), { kind: "spawn", message: "RPC spawn failed: ENOENT" });
  await failed.close();
  const child = new FakeRpcProcess({ onCommand(command, process) { process.respond(command, undefined, "model unavailable"); return true; } });
  const transport = client(child); transport.start();
  await assert.rejects(transport.request("set_model"), { kind: "command", message: "model unavailable" });
  await transport.close();
});

test("command timeout and cancellation have finite deadlines with queue clearing and signal escalation", async () => {
  const child = new FakeRpcProcess({ closeOnEnd: false, onCommand: () => true });
  const signals = [];
  const transport = client(child, { signalGroup: (process, signal) => { signals.push(signal); if (signal === "SIGKILL") process.exit(null, signal); } });
  transport.start();
  await assert.rejects(transport.request("get_state", {}, { timeoutMs: 10 }), { kind: "timeout" });
  await transport.cancel(); await transport.cancel();
  assert.deepEqual(child.commands.map((command) => command.type), ["get_state", "clear_queue", "abort"]);
  assert.deepEqual(signals, process.platform === "win32" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM", "SIGKILL", "SIGKILL"]);
});

test("child environment drops parent Herdr pane and subagent identities", () => {
  assert.deepEqual(childEnvironment({ PATH: "/bin", HERDR_ENV: "1", HERDR_PANE_ID: "parent", HERDR_SOCKET_PATH: "/socket", PI_SUBAGENTS_RUN_ID: "parent-run", SUBAGENT_TASK: "old" }), { PATH: "/bin", RPC_SUBAGENTS_CHILD: "1" });
});

test("transport rejects oversized, malformed, and incomplete stdout records", async () => {
  assert.throws(() => new LFDecoder(2).push(Buffer.from("abc")), /byte limit/);
  const decoder = new LFDecoder(); decoder.push(Buffer.from('{"type":'));
  assert.throws(() => decoder.finish(), /incomplete JSONL/);
  const child = new FakeRpcProcess();
  let failure;
  const transport = client(child, { onFailure: (error) => { failure = error; } });
  transport.start(); child.stdout.write("not json\n");
  await eventually(() => failure);
  assert.equal(failure.kind, "protocol");
  assert.equal(failure.message, "Invalid JSON on RPC stdout");
  await transport.close();
});

test("stdin writes wait for stream callbacks instead of filling an unbounded command buffer", async () => {
  const child = new FakeRpcProcess();
  let release;
  let firstWrite = true;
  const originalWrite = child.stdin._write;
  child.stdin._write = function (chunk, encoding, callback) {
    if (firstWrite) { firstWrite = false; release = () => originalWrite.call(this, chunk, encoding, callback); }
    else originalWrite.call(this, chunk, encoding, callback);
  };
  const transport = client(child); transport.start();
  const first = transport.request("first"); const second = transport.request("second");
  await eventually(() => release !== undefined);
  assert.deepEqual(child.commands, []);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{}, {}]);
  assert.deepEqual(child.commands.map((command) => command.type), ["first", "second"]);
  await transport.close();
});

test("stdin write and queued responses fail finitely when Writable never invokes its callback", async () => {
  const child = new FakeRpcProcess({ closeOnEnd: false });
  child.stdin._write = () => {};
  const transport = client(child, { writeTimeoutMs: 15 }); transport.start();
  const first = transport.respond("dialog-1", { cancelled: true });
  const queued = transport.respond("dialog-2", { cancelled: true });
  await Promise.all([assert.rejects(first, { kind: "timeout" }), assert.rejects(queued, { kind: "timeout" })]);
  await transport.writeTail;
  assert.equal(transport.writes.size, 0);
  await transport.cancel();
  assert.equal(child.exited, true);
  assert.equal(transport.pending.size, 0);
});

test("closing transport rejects stalled and queued writes and clears their deadline timers", async () => {
  const child = new FakeRpcProcess({ closeOnEnd: false }); child.stdin._write = () => {};
  const transport = client(child, { writeTimeoutMs: 10000 }); transport.start();
  const first = transport.respond("dialog", { cancelled: true });
  const queued = transport.send({ type: "abort" });
  const assertions = Promise.all([assert.rejects(first, /closing/), assert.rejects(queued, /closing/)]);
  await transport.close(); await assertions; await transport.writeTail;
  assert.equal(transport.writes.size, 0);
  assert.equal(child.exited, true);
});

test("child close is checked after trailing stdout events drain through a slow journal", async () => {
  const child = new FakeRpcProcess();
  const events = [];
  const transport = client(child, { onRecord: async (record) => { await new Promise((resolve) => setTimeout(resolve, 5)); events.push(record.type); } });
  transport.start();
  const request = transport.request("get_state");
  await eventually(() => child.commands.length === 1);
  child.record({ type: "agent_settled" }); child.exit(0);
  assert.equal((await request).model.id, "model");
  await eventually(() => events.includes("agent_settled"));
  assert.deepEqual(events, ["response", "agent_settled"]);
  await transport.close();
});
