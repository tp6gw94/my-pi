import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../manager.mjs";
import { RpcTransport } from "../transport.mjs";
import { ScheduleManager, parseTrigger, nextTrigger, loadCron } from "../schedules.mjs";
import { captureBranch, writeChildSession } from "../snapshot.mjs";
import { FakeRpcProcess, eventually, tick } from "./fake-rpc.mjs";

class Clock {
  time = Date.parse("2026-03-01T00:00:00Z");
  timers = new Map();
  delays = [];
  now = () => this.time;
  setTimer = (callback, delay) => { const token = {}; this.timers.set(token, { callback, at: this.time + delay }); this.delays.push(delay); return token; };
  clearTimer = (token) => this.timers.delete(token);
  advance(ms) {
    this.time += ms;
    for (let count = 0; count < 1000; count++) {
      const ready = [...this.timers].find(([, value]) => value.at <= this.time);
      if (!ready) return;
      this.timers.delete(ready[0]); ready[1].callback();
    }
    throw new Error("Clock timer loop");
  }
}
const spec = (extra = {}) => ({ webAccess: false, prompt: "scheduled", name: "scheduled task", cwd: process.cwd(), model: { provider: "test", id: "model" }, thinking: "off", context: "fresh", async: true, timeoutMs: 86400000, ...extra });

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-schedules-"));
  const clock = new Clock(); const children = []; const sessions = new Map();
  const fleet = new FleetManager({ root: directory, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    prepare: async (task, { taskId, ownerId, nonce, template, session }) => {
      const sessionFile = session.sessionFile;
      let sessionId;
      if (session.kind === "resume") sessionId = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]).id;
      else ({ sessionId } = await writeChildSession(sessionFile, { cwd: task.cwd, template }));
      sessions.set(taskId, { sessionFile, sessionId });
      return { cliPath: "/pi", cwd: task.cwd, args: [], sessionFile, binding: { taskId, ownerId, nonce } };
    },
    transportFactory: (options) => {
      const identity = sessions.get(options.binding.taskId);
      const child = new FakeRpcProcess({ sessionFile: identity.sessionFile, sessionId: identity.sessionId, binding: options.binding, tools: options.tools });
      children.push(child);
      return new RpcTransport({ ...options, spawnImpl: () => child, signalGroup: (process, signal) => process.kill(signal), commandTimeoutMs: 100,
        cancelCommandTimeoutMs: 10, closeGraceMs: 10, termGraceMs: 10 });
    },
  });
  const managers = [];
  const make = (extra = {}) => {
    const manager = new ScheduleManager({ directory: join(directory, "project"), cwd: process.cwd(), fleet,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options, ...extra });
    managers.push(manager); return manager;
  };
  const schedules = make();
  t.after(async () => { const stop = fleet.shutdown(); await Promise.all(managers.map((manager) => manager.shutdown({ beforeRelease: stop }))); await stop; await rm(directory, { recursive: true, force: true }); });
  await schedules.start();
  return { directory, clock, fleet, children, schedules, make };
}

async function prompt(children, index) { await eventually(() => children[index]?.prompt, "scheduled RPC prompt"); }

async function idleHistory(schedules, id, expected) { await eventually(() => schedules.get(id).history.filter((run) => run.taskId).length === expected); }

test("one-shot schedules persist private state, fire once, and become completed", async (t) => {
  const { schedules, clock, children, directory } = await setup(t);
  const schedule = await schedules.create({ task: spec(), trigger: { type: "at", at: "+1s" } });
  const persisted = JSON.parse(await readFile(join(directory, "project", "schedules.json"), "utf8"));
  assert.equal(persisted.schedules[0].scheduleId, schedule.scheduleId);
  clock.advance(1000); await prompt(children, 0);
  assert.equal(schedules.get(schedule.scheduleId).activeTaskIds.length, 1);
  children[0].settle("one shot"); await idleHistory(schedules, schedule.scheduleId, 1);
  assert.equal(schedules.get(schedule.scheduleId).state.status, "completed");
  clock.advance(10000); await tick(); assert.equal(children.length, 1);
});

test("pause/resume/cancel are persistent and idempotent; cancelled schedules never revive", async (t) => {
  const { schedules, clock, children, make } = await setup(t);
  const schedule = await schedules.create({ task: spec(), trigger: { type: "interval", every: "1s" } });
  await schedules.pause(schedule.scheduleId); await schedules.pause(schedule.scheduleId);
  clock.advance(5000); await tick(); assert.equal(children.length, 0);
  await schedules.shutdown();
  const restored = make(); await restored.start();
  assert.equal(restored.get(schedule.scheduleId).state.status, "paused");
  const resumed = await restored.resume(schedule.scheduleId);
  assert.equal(resumed.state.status, "active"); assert.equal(resumed.nextAt, clock.now() + 1000);
  clock.advance(1000); await prompt(children, 0); children[0].settle("resumed");
  await idleHistory(restored, schedule.scheduleId, 1);
  await restored.cancel(schedule.scheduleId); await restored.cancel(schedule.scheduleId);
  assert.equal((await restored.resume(schedule.scheduleId)).state.status, "cancelled");
  clock.advance(10000); await tick(); assert.equal(children.length, 1);
});

test("reload never catches up recurring triggers and marks expired one-shots missed", async (t) => {
  const { schedules, clock, children, make } = await setup(t);
  const recurring = await schedules.create({ task: spec(), trigger: { type: "interval", every: "1s" } });
  const once = await schedules.create({ task: spec(), trigger: { type: "at", at: "+2s" } });
  await schedules.shutdown(); clock.advance(10000);
  const restored = make(); await restored.start();
  assert.equal(children.length, 0);
  assert.equal(restored.get(once.scheduleId).state.status, "missed");
  assert.equal(restored.get(recurring.scheduleId).nextAt, clock.now() + 1000);
  clock.advance(1000); await prompt(children, 0); children[0].settle("future only");
  await idleHistory(restored, recurring.scheduleId, 1);
  assert.equal(children.length, 1);
});

test("recurring schedules skip overlap while their own task remains active", async (t) => {
  const { schedules, clock, children } = await setup(t);
  const schedule = await schedules.create({ task: spec(), trigger: { type: "interval", every: "1s" } });
  clock.advance(1000); await prompt(children, 0);
  clock.advance(1000); await eventually(() => schedules.get(schedule.scheduleId).history.some((run) => run.status === "skipped_overlap"));
  assert.equal(children.length, 1);
  assert.equal(schedules.get(schedule.scheduleId).nextAt, clock.now() + 1000);
  children[0].settle("first"); await idleHistory(schedules, schedule.scheduleId, 1);
  clock.advance(1000); await prompt(children, 1); children[1].settle("second");
  await idleHistory(schedules, schedule.scheduleId, 2);
  assert.deepEqual(schedules.get(schedule.scheduleId).history.map((run) => run.status), ["skipped_overlap", "completed", "completed"]);
});

test("cancel fences a due callback while immutable-template preparation is awaiting", async (t) => {
  let release; let preparing = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { schedules, clock, children } = await setup(t, { prepareTemplate: async () => { preparing = true; await blocked; } });
  const schedule = await schedules.create({ task: spec(), trigger: { type: "at", at: "+1s" } });
  clock.advance(1000); await eventually(() => preparing);
  await schedules.cancel(schedule.scheduleId);
  release(); await tick(); await tick();
  assert.equal(children.length, 0); assert.equal(schedules.get(schedule.scheduleId).state.status, "cancelled");
});

test("abortRunning cancels only task IDs owned by the cancelled schedule", async (t) => {
  const { schedules, clock, fleet, children } = await setup(t);
  const unrelated = await fleet.run(spec({ name: "unrelated" })); await prompt(children, 0);
  const a = await schedules.create({ task: spec({ name: "A" }), trigger: { type: "interval", every: "1s" } });
  const b = await schedules.create({ task: spec({ name: "B" }), trigger: { type: "interval", every: "1s" } });
  clock.advance(1000); await prompt(children, 1); await prompt(children, 2);
  const aId = schedules.get(a.scheduleId).activeTaskIds[0]; const bId = schedules.get(b.scheduleId).activeTaskIds[0];
  await schedules.cancel(a.scheduleId, { abortRunning: true });
  assert.equal((await fleet.result(aId)).status, "cancelled");
  assert.equal((await fleet.status(bId)).status, "running"); assert.equal((await fleet.status(unrelated.taskId)).status, "running");
  children[0].settle("unrelated done"); children[2].settle("B done");
});

test("a fork schedule captures once and gives each fire a new independent mutable child session", async (t) => {
  const { schedules, clock, children, fleet } = await setup(t);
  const branch = [{ type: "message", id: "history", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "original parent" } }];
  const template = captureBranch({ getBranch: () => branch, getSessionFile: () => "/parent.jsonl" }, { provider: "test", id: "model" });
  const schedule = await schedules.create({ task: spec({ context: "fork", tools: ["read", "bash"] }), trigger: { type: "interval", every: "1s" } }, { template });
  template.entries[0].message.content = "mutated template input"; branch[0].message.content = "new parent context";
  clock.advance(1000); await prompt(children, 0);
  const firstId = schedules.get(schedule.scheduleId).activeTaskIds[0]; const first = await fleet.status(firstId);
  assert.deepEqual(first.capabilities.requested, ["read", "bash"]);
  const firstFile = (await readFile(first.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(firstFile[1].message.content, "original parent");
  await writeFile(first.sessionFile, JSON.stringify(firstFile[0]) + "\n");
  children[0].settle("first"); await idleHistory(schedules, schedule.scheduleId, 1);
  clock.advance(1000); await prompt(children, 1);
  const secondId = schedules.get(schedule.scheduleId).activeTaskIds[0]; const second = await fleet.status(secondId);
  const secondFile = (await readFile(second.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(secondFile[1].message.content, "original parent");
  assert.notEqual(firstFile[0].id, secondFile[0].id); assert.notEqual(first.sessionFile, second.sessionFile);
  children[1].settle("second");
});

test("large timers rearm without overflow or early execution", async (t) => {
  const { schedules, clock, children } = await setup(t);
  await schedules.create({ task: spec(), trigger: { type: "at", at: "+90d" } });
  assert.equal(clock.delays.at(-1), 2147483647);
  clock.advance(2147483647); await tick(); assert.equal(children.length, 0);
  clock.advance(90 * 86400000 - 2147483647); await prompt(children, 0);
  assert.equal(children.length, 1); children[0].settle("long timer");
});

test("single project owner lock prevents duplicate schedule fires", async (t) => {
  const { schedules, make, clock, children } = await setup(t);
  await schedules.create({ task: spec(), trigger: { type: "at", at: "+1s" } });
  const other = make(); await assert.rejects(other.start(), /already owned/);
  clock.advance(1000); await prompt(children, 0); children[0].settle("single owner");
  assert.equal(children.length, 1);
});

test("cron is an explicit dependency blocker, never an incomplete custom parser", async (t) => {
  const { schedules } = await setup(t, { cronLoader: async () => { throw new Error("croner@9.1.0 is missing"); } });
  await assert.rejects(schedules.create({ task: spec(), trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Taipei" } }), /croner@9.1.0 is missing/);
  assert.deepEqual(schedules.list(), []);
  assert.throws(() => parseTrigger({ type: "cron", expression: "0 0 9 * * *", timezone: "Asia/Taipei" }, 0), /five fields/);
  assert.throws(() => parseTrigger({ type: "at", at: "2026-01-01T10:00:00" }, 0), /explicit Z/);
});

let Cron;
try { Cron = await loadCron(); } catch {}
test("pinned cron timezone computation crosses spring and autumn DST with strictly future triggers", { skip: !Cron && "croner@9.1.0 not installed in this writing role" }, () => {
  const trigger = { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" };
  assert.equal(new Date(nextTrigger(trigger, Date.parse("2026-03-07T14:00:00Z"), Cron)).toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(new Date(nextTrigger(trigger, Date.parse("2026-10-31T13:00:00Z"), Cron)).toISOString(), "2026-11-01T14:00:00.000Z");
});

test("shutdown fences preparations and retains ownership until child cleanup completes", async (t) => {
  const { schedules, make } = await setup(t);
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const stopping = schedules.shutdown({ beforeRelease: cleanup });
  const contender = make(); await assert.rejects(contender.start(), /already owned/);
  release(); await stopping;
  const nextOwner = make(); await nextOwner.start();
  assert.deepEqual(nextOwner.list(), []);
});

test("schedule run history is bounded and persists the interrupted shutdown result", async (t) => {
  const { schedules, clock, children, fleet, make } = await setup(t, { historyLimit: 2 });
  const schedule = await schedules.create({ task: spec(), trigger: { type: "interval", every: "1s" } });
  for (let i = 0; i < 3; i++) {
    clock.advance(1000); await prompt(children, i); children[i].settle(`run ${i}`);
    await eventually(() => schedules.get(schedule.scheduleId).activeTaskIds.length === 0);
  }
  assert.deepEqual(schedules.get(schedule.scheduleId).history.map((run) => run.status), ["completed", "completed"]);
  clock.advance(1000); await prompt(children, 3);
  const stopping = fleet.shutdown(); await schedules.shutdown({ beforeRelease: stopping });
  const restored = make(); await restored.start();
  assert.deepEqual(restored.get(schedule.scheduleId).history.map((run) => run.status), ["completed", "interrupted"]);
  assert.deepEqual(restored.get(schedule.scheduleId).activeTaskIds, []);
  assert.equal(restored.get(schedule.scheduleId).nextAt, clock.now() + 1000);
});

test("custom and empty child tool lists persist across restore and fire", async (t) => {
  const { schedules, clock, children, fleet, make, directory } = await setup(t);
  const custom = await schedules.create({ task: spec({ name: "custom tools", tools: ["read", "bash"] }), trigger: { type: "at", at: "+1s" } });
  const empty = await schedules.create({ task: spec({ name: "no tools", tools: [] }), trigger: { type: "at", at: "+1s" } });
  const saved = JSON.parse(await readFile(join(directory, "project", "schedules.json"), "utf8"));
  assert.deepEqual(saved.schedules.map((record) => record.task.tools), [["read", "bash"], []]);
  await schedules.shutdown();
  const restored = make(); await restored.start();
  assert.deepEqual(restored.get(custom.scheduleId).task.tools, ["read", "bash"]);
  assert.deepEqual(restored.get(empty.scheduleId).task.tools, []);
  clock.advance(1000); await prompt(children, 0); await prompt(children, 1);
  const tasks = await fleet.list();
  assert.deepEqual(tasks.find((task) => task.name === "custom tools").capabilities.requested, ["read", "bash"]);
  assert.deepEqual(tasks.find((task) => task.name === "no tools").capabilities.requested, []);
  children[0].settle("custom"); children[1].settle("empty");
  await idleHistory(restored, custom.scheduleId, 1);
  await idleHistory(restored, empty.scheduleId, 1);
});

test("schedules reject session continuation at creation and fail closed on a persisted one", async (t) => {
  const { schedules, directory, make } = await setup(t);
  await assert.rejects(schedules.create({ task: spec({ context: undefined, session: "/tmp/owned-session.jsonl" }), trigger: { type: "at", at: "+1s" } }),
    /Schedules cannot continue an existing session/);
  assert.deepEqual(schedules.list(), []);
  const schedule = await schedules.create({ task: spec(), trigger: { type: "interval", every: "1s" } });
  await schedules.shutdown();
  const file = join(directory, "project", "schedules.json");
  const original = await readFile(file, "utf8");
  const saved = JSON.parse(original);
  assert.equal(saved.schedules.length, 1);
  saved.schedules[0].task = { ...saved.schedules[0].task, session: "/tmp/owned-session.jsonl" };
  delete saved.schedules[0].task.context;
  await writeFile(file, JSON.stringify(saved) + "\n");
  const contender = make();
  await assert.rejects(contender.start(), /Persisted schedule session continuation/);
  await writeFile(file, original);
  const next = make(); await next.start();
  assert.equal(next.list().length, 1);
  assert.equal(next.get(schedule.scheduleId).state.status, "active");
  assert.deepEqual(next.get(schedule.scheduleId).task.tools, ["read", "write", "edit", "bash", "codemode"]);
});
