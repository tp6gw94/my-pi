import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSanitizer, replayAndFollow } from "../viewer.mjs";
import { HerdrOpener, viewerCommand, splitDirection, shellQuote, currentPaneSplitArguments, createHerdrCliAdapter, layoutGeometry } from "../herdr.mjs";
import { eventually } from "./fake-rpc.mjs";

const line = (source, event) => JSON.stringify({ version: 1, seq: 1, at: 0, taskId: "task", source, event }) + "\n";

function stubHerdrExec(errors = {}) {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "caller" };
  const calls = []; const live = new Set(["caller", "user-pane"]); let created = 0;
  const run = async (_binary, args, options) => {
    calls.push({ args, options });
    if (errors[args[1]]) throw errors[args[1]];
    if (args[1] === "get") {
      if (!live.has(args[2])) throw Object.assign(new Error("Pane not found"), { code: "pane_not_found" });
      return { stdout: JSON.stringify({ result: { pane: { pane_id: args[2] } } }) };
    }
    if (args[1] === "layout") return { stdout: JSON.stringify({ result: { layout: { panes: [{ pane_id: args[3], rect: { width: 97, height: 51 } }] } } }) };
    if (args[1] === "split") {
      const paneId = `owned-${++created}`; live.add(paneId);
      return { stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) };
    }
    if (args[1] === "close") live.delete(args[2]);
    assert.ok(["run", "close"].includes(args[1]));
    return { stdout: "", stderr: "" };
  };
  return { env, calls, live, run, adapter: createHerdrCliAdapter({ env, currentEnv: () => env, run }) };
}

test("terminal sanitization strips fragmented CSI, OSC clipboard, DCS, C1, and control characters", () => {
  const sanitizer = new TerminalSanitizer();
  const chunks = ["safe\x1b[", "31mred\x1b]52;c;", "secret\x1b", "\\visible\x1bPprivate", "\x1b\\\u009b2J繁\u2028體\u2029\r\b\u202eend"];
  assert.equal(chunks.map((text) => sanitizer.push(text)).join(""), "saferedvisible繁\u2028體\u2029end");
});

test("viewer replays and follows the exact log, showing task/model/tools/text/result without model execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-viewer-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  await writeFile(file, line("fleet", { type: "task_created", task: { taskId: "task", name: "review", model: { provider: "test", id: "model" }, status: "queued" } }) +
    line("rpc", { type: "message_start", message: { role: "assistant" } }) +
    line("rpc", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello\x1b[" } }));
  let output = "";
  const following = replayAndFollow(file, { pollMs: 5, write: async (text) => { output += text; } });
  await eventually(() => output.includes("Hello"));
  await appendFile(file, line("rpc", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "31m world\u2028繁體" } }) +
    line("rpc", { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "file" } }) +
    line("rpc", { type: "tool_execution_end", toolCallId: "call", toolName: "read", result: { content: [{ type: "text", text: "output" }] }, isError: false }) +
    line("fleet", { type: "task_result", task: { status: "completed", text: "final\x1b]52;c;clipboard\x07answer", state: { status: "completed" } } }));
  await following;
  assert.match(output, /任務 task  review/); assert.match(output, /模型 test\/model/);
  assert.match(output, /Hello world\u2028繁體/); assert.match(output, /工具 read call/); assert.match(output, /工具完成 read/);
  assert.match(output, /結果 completed\nfinalanswer/); assert.equal(output.includes("\x1b"), false); assert.equal(output.includes("clipboard"), false);
});

test("viewer bounds replay and reports omitted history while decoding partial live JSONL chunks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-viewer-tail-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  const old = line("stderr", { type: "stderr", text: "omitted old text".repeat(100) });
  const pending = line("fleet", { type: "task_state", state: { status: "waiting_input" } });
  await writeFile(file, old + pending);
  let output = "";
  const controller = new AbortController();
  const tail = replayAndFollow(file, { pollMs: 5, signal: controller.signal, maxReplayBytes: Buffer.byteLength(pending) + 1, write: async (text) => { output += text; } });
  await eventually(() => output.includes("waiting_input"));
  assert.match(output, /已略過較早/); assert.equal(output.includes("omitted old text"), false);
  const next = line("stderr", { type: "stderr", text: "chunked 繁體" }); const bytes = Buffer.from(next);
  await appendFile(file, bytes.subarray(0, bytes.length - 4));
  await appendFile(file, bytes.subarray(bytes.length - 4));
  await eventually(() => output.includes("chunked 繁體"));
  controller.abort(); await tail;
  assert.equal(output.match(/chunked 繁體/g).length, 1);
});

test("viewer shell command quotes spaces, apostrophes, dollar signs, and command substitutions literally", async () => {
  const args = ["a b", "quote'file", "$(touch should-not-exist)", "semi;colon", "繁體"];
  const command = `printf '%s\\n' ${args.map(shellQuote).join(" ")}`;
  const result = await promisify(execFile)("/bin/sh", ["-c", command]);
  assert.deepEqual(result.stdout.trim().split("\n"), args);
  const viewer = viewerCommand({ nodePath: "/node path", viewerPath: "/viewer'file.mjs", eventFile: "/events $path" });
  assert.equal(viewer, "'/node path' '/viewer'\\''file.mjs' '--events' '/events $path'");
});

test("Herdr opener targets the caller, chooses geometry, uses no focus, and reuses only owned live panes", async () => {
  const calls = [];
  const live = new Set(["caller", "unrelated"]);
  let created = 0;
  const adapter = {
    async inspect(id) { return live.has(id) ? { paneId: id, geometry: { width: 180, height: 40 } } : undefined; },
    async create(input) { calls.push(input); const id = `owned-${++created}`; live.add(id); return { result: { pane: { pane_id: id } } }; },
    async run(id, command) { calls.push({ id, command }); },
  };
  const opener = new HerdrOpener({ adapter, viewerPath: "/viewer path.mjs", env: { HERDR_ENV: "1" } });
  const task = { taskId: "task", eventFile: "/events.jsonl", cwd: "/project" };
  const opened = await opener.open(task, { callerPaneId: "caller" });
  assert.equal(opened.paneId, "owned-1");
  assert.deepEqual(calls[0], { callerPaneId: "caller", direction: "right", cwd: "/project", focus: false });
  assert.equal((await opener.open(task, { callerPaneId: "caller" })).reused, true); assert.equal(calls.length, 2);
  live.delete("owned-1");
  const replacement = await opener.open(task, { callerPaneId: "caller", direction: "down" });
  assert.equal(replacement.paneId, "owned-2"); assert.equal(calls[2].direction, "down");
  assert.equal(splitDirection({ width: 80, height: 40 }), "down");
  await assert.rejects(opener.open({ ...task, taskId: "other" }, {}), /callerPaneId/);
  await assert.rejects(new HerdrOpener({ adapter, viewerPath: "/viewer", env: {} }).open(task, { callerPaneId: "caller" }), /HERDR_ENV/);
});

test("actual Herdr result.layout.panes.rect drives a no-focus current-pane viewer split", async () => {
  const sample = { result: { layout: { focused_pane_id: "w1:pB", panes: [{ pane_id: "w1:pB", rect: { height: 51, width: 97, x: 97, y: 0 } }], tab_id: "w1:t5", workspace_id: "w1" }, type: "pane_layout" } };
  assert.deepEqual(layoutGeometry(sample, "w1:pB"), { width: 97, height: 51 });
  assert.deepEqual(layoutGeometry(sample.result, "w1:pB"), { width: 97, height: 51 });
  assert.equal(layoutGeometry(sample, "other"), undefined);
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:pB" }; const calls = [];
  const adapter = createHerdrCliAdapter({ env, currentEnv: () => env, run: async (_binary, args) => {
    calls.push(args);
    return { stdout: JSON.stringify(args[1] === "layout" ? sample : { result: { pane: { pane_id: args[1] === "get" ? "w1:pB" : "owned" } } }) };
  } });
  const opened = await new HerdrOpener({ adapter, viewerPath: "/viewer.mjs", env }).open({ taskId: "task", eventFile: "/events", cwd: "/project" }, { callerPaneId: "w1:pB" });
  assert.equal(opened.paneId, "owned");
  assert.deepEqual(calls[2], ["pane", "split", "--current", "--direction", "down", "--cwd", "/project", "--no-focus"]);
});

test("viewer EOF uses terminal snapshot when tail replay skips a giant legacy terminal record", { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-viewer-final-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  const task = { status: "failed", state: { status: "failed" }, text: "saved final answer", error: "錯誤😀".repeat(200000) };
  await writeFile(file, line("fleet", { type: "task_result", task }));
  await writeFile(join(directory, "state.json"), JSON.stringify(task));
  let output = "";
  await replayAndFollow(file, { pollMs: 5, write: async (text) => { output += text; } });
  assert.match(output, /已略過較早/);
  assert.match(output, /結果 failed\nsaved final answer/);
});

test("viewer sees the bounded terminal marker even when its oversized task_result was skipped", { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-viewer-marker-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  await writeFile(file, line("fleet", { type: "task_result", task: { status: "failed", state: { status: "failed" }, error: "繁體".repeat(300000) } }) + line("fleet", { type: "task_terminal", status: "failed" }));
  let output = "";
  await replayAndFollow(file, { write: async (text) => { output += text; } });
  assert.match(output, /結果 failed/);
});

test("verified Herdr current-pane split refuses changed caller identity and never follows UI focus", async () => {
  const saved = { HERDR_ENV: "1", HERDR_PANE_ID: "saved-caller" };
  const input = { callerPaneId: "saved-caller", direction: "down", cwd: "/path with spaces" };
  assert.deepEqual(currentPaneSplitArguments(input, saved, saved), ["pane", "split", "--current", "--direction", "down", "--cwd", "/path with spaces", "--no-focus"]);
  assert.throws(() => currentPaneSplitArguments({ ...input, callerPaneId: "other" }, saved, saved), /unchanged originating/);
  assert.throws(() => currentPaneSplitArguments(input, saved, { ...saved, HERDR_PANE_ID: "focused-other" }), /unchanged originating/);
  const calls = [];
  const adapter = createHerdrCliAdapter({ env: saved, currentEnv: () => saved, run: async (_binary, args, options) => {
    calls.push({ args, shell: options.shell });
    return { stdout: JSON.stringify({ result: args[1] === "layout" ? { pane: { pane_id: "saved-caller", geometry: { width: 80, height: 40 } } } : { pane: { pane_id: args[1] === "split" ? "new" : "saved-caller" } } }) };
  } });
  assert.deepEqual(await adapter.inspect("saved-caller"), { paneId: "saved-caller", geometry: { width: 80, height: 40 } });
  await adapter.create(input);
  await adapter.run("new", "quoted viewer command");
  assert.deepEqual(calls.map((call) => call.args), [["pane", "get", "saved-caller"], ["pane", "layout", "--pane", "saved-caller"], ["pane", "split", "--current", "--direction", "down", "--cwd", "/path with spaces", "--no-focus"], ["pane", "run", "new", "quoted viewer command"]]);
  assert.equal(calls.every((call) => call.shell === false), true);
});

test("Herdr exit-zero empty run acknowledgement opens and reuses the same owned pane without another split", async () => {
  const { adapter, env, calls } = stubHerdrExec();
  const opener = new HerdrOpener({ adapter, viewerPath: "/viewer.mjs", env });
  const task = { taskId: "task", eventFile: "/events", cwd: "/project" };
  const opened = await opener.open(task, { callerPaneId: "caller" });
  assert.equal(opened.paneId, "owned-1"); assert.equal(opened.reused, false);
  const reopened = await opener.open(task, { callerPaneId: "caller" });
  assert.equal(reopened.paneId, opened.paneId); assert.equal(reopened.reused, true);
  assert.equal(calls.filter(({ args }) => args[1] === "split").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "run").length, 1);
  assert.deepEqual(calls.find(({ args }) => args[1] === "split").args, ["pane", "split", "--current", "--direction", "down", "--cwd", "/project", "--no-focus"]);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
});

test("Herdr discovery commands reject empty, malformed, and wrong-shape JSON instead of treating it as acknowledgement", async () => {
  for (const action of ["get", "layout", "split"]) {
    for (const stdout of ["", " \n", "{", "null", "42", "[]", "{}", '{"result":{}}']) {
      const { env, run } = stubHerdrExec();
      const adapter = createHerdrCliAdapter({ env, currentEnv: () => env, run: (binary, args, options) => args[1] === action ? Promise.resolve({ stdout }) : run(binary, args, options) });
      await assert.rejects(action === "split" ? adapter.create({ callerPaneId: "caller", direction: "down", cwd: "/project" }) : adapter.inspect("caller"), undefined, `${action}: ${JSON.stringify(stdout)}`);
    }
  }
});

test("Herdr nonzero exits and JSON errors still reject, including no-payload run and close", async () => {
  for (const action of ["get", "layout", "split", "run", "close"]) {
    const failure = Object.assign(new Error("CLI exit 1"), { code: 1, stdout: "", stderr: "failed" });
    const { adapter } = stubHerdrExec({ [action]: failure });
    const operation = action === "split" ? adapter.create({ callerPaneId: "caller", direction: "down", cwd: "/project" }) : action === "run" ? adapter.run("owned", "viewer") : action === "close" ? adapter.close("owned") : adapter.inspect("caller");
    await assert.rejects(operation, (error) => error === failure);
  }
  for (const action of ["run", "close"]) {
    const adapter = createHerdrCliAdapter({ run: async () => ({ stdout: '{"error":{"message":"Denied","code":"permission_denied"}}' }) });
    await assert.rejects(adapter[action]("owned", "viewer"), { message: "Denied", code: "permission_denied" });
  }
});

test("Herdr failed run closes exactly the newly created owned pane and permits a clean retry", async () => {
  const errors = { run: new Error("launch failed") };
  const { adapter, env, calls, live } = stubHerdrExec(errors);
  const opener = new HerdrOpener({ adapter, viewerPath: "/viewer.mjs", env });
  const task = { taskId: "task", eventFile: "/events", cwd: "/project" };
  await assert.rejects(opener.open(task, { callerPaneId: "caller" }), /acknowledgement failed.*owned-1.*launch failed.*created pane was closed/);
  assert.deepEqual(calls.filter(({ args }) => args[1] === "close").map(({ args }) => args), [["pane", "close", "owned-1"]]);
  assert.equal(opener.bindings.has(task.taskId), false);
  assert.deepEqual([...live], ["caller", "user-pane"]);
  delete errors.run;
  const opened = await opener.open(task, { callerPaneId: "caller" });
  assert.equal(opened.paneId, "owned-2");
  await opener.open(task, { callerPaneId: "caller" });
  assert.equal(calls.filter(({ args }) => args[1] === "close").length, 1);
});

test("Herdr cleanup failure retains the owned ID and uncertain launch error, blocking duplicates until that pane is gone", async () => {
  const errors = { run: new Error("launch failed"), close: new Error("close failed") };
  const { adapter, env, calls, live } = stubHerdrExec(errors);
  const opener = new HerdrOpener({ adapter, viewerPath: "/viewer.mjs", env });
  const task = { taskId: "task", eventFile: "/events", cwd: "/project" };
  await assert.rejects(opener.open(task, { callerPaneId: "caller" }), /owned-1.*cleanup failed: close failed.*start is unconfirmed.*owned pane owned-1 is retained.*Close it before retrying/);
  assert.equal(opener.bindings.get(task.taskId).paneId, "owned-1");
  assert.ok(opener.bindings.get(task.taskId).launchError instanceof Error);
  await assert.rejects(opener.open(task, { callerPaneId: "caller" }), /owned pane owned-1 is retained/);
  errors.get = new Error("inspection failed");
  await assert.rejects(opener.open(task, { callerPaneId: "caller" }), /owned-1.*owned pane inspection failed: inspection failed/);
  assert.equal(calls.filter(({ args }) => args[1] === "split").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "run").length, 1);
  assert.deepEqual(calls.filter(({ args }) => args[1] === "close").map(({ args }) => args), [["pane", "close", "owned-1"]]);
  assert.ok(live.has("caller") && live.has("user-pane"));
  delete errors.get; delete errors.run; delete errors.close; live.delete("owned-1");
  assert.equal((await opener.open(task, { callerPaneId: "caller" })).paneId, "owned-2");
});

test("Herdr cleanup never adopts or closes a caller or an existing bound pane returned by a bad split", async () => {
  for (const paneId of ["caller", "already-owned"]) {
    const calls = [];
    const adapter = {
      async inspect(id) { return { paneId: id, geometry: { width: 97, height: 51 } }; },
      async create() { return { pane: { pane_id: paneId } }; },
      async run(id) { calls.push(["run", id]); throw new Error("launch failed"); },
      async close(id) { calls.push(["close", id]); },
    };
    const opener = new HerdrOpener({ adapter, viewerPath: "/viewer.mjs", env: { HERDR_ENV: "1" } });
    opener.bindings.set("existing-task", { taskId: "existing-task", paneId: "already-owned", callerPaneId: "caller" });
    await assert.rejects(opener.open({ taskId: "task", eventFile: "/events", cwd: "/project" }, { callerPaneId: "caller" }), /caller or already-bound pane ID/);
    assert.deepEqual(calls, []); assert.equal(opener.bindings.get("existing-task").paneId, "already-owned");
    assert.equal(opener.bindings.has("task"), false);
  }
});
