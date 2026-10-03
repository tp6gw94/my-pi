import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleManager, readSchedules } from "../schedules.mjs";
import { eventually } from "./fake-rpc.mjs";

const task = { prompt: "scheduled", name: "test", cwd: "/project", model: { provider: "test", id: "model" }, context: "fresh" };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-owner-fence-"));
  let time = 100000;
  const timers = new Map();
  const managers = [];
  const make = (extra = {}) => {
    const manager = new ScheduleManager({ directory, cwd: "/project", fleet: { submit() { throw new Error("Unexpected launch"); } }, now: () => time,
      setTimer: (callback) => { const id = {}; timers.set(id, callback); return id; }, clearTimer: (id) => timers.delete(id), ...extra });
    managers.push(manager); return manager;
  };
  t.after(async () => { await Promise.all(managers.map((manager) => manager.shutdown())); await rm(directory, { recursive: true, force: true }); });
  return { directory, timers, managers, make, due: () => { time += 1000; const [id, callback] = [...timers][0]; timers.delete(id); callback(); } };
}

test("late rejected preparation cannot write an old store after shutdown and new owner mutation", async (t) => {
  const { directory, make, due, timers } = await setup(t);
  let rejectPreparation;
  let preparing = false;
  const preparation = new Promise((_, reject) => { rejectPreparation = reject; });
  const old = make({ prepareTemplate: async () => { preparing = true; return preparation; } });
  await old.create({ task, trigger: { type: "interval", every: "1s" } });
  due(); await eventually(() => preparing);
  await old.shutdown();
  assert.equal(timers.size, 0);
  const next = make();
  const added = await next.create({ task: { ...task, name: "new owner" }, trigger: { type: "at", at: "+1h" } });
  await next.cancel(added.scheduleId);
  const current = await readFile(join(directory, "schedules.json"), "utf8");
  rejectPreparation(new Error("late old preparation failure"));
  await eventually(() => old.flights.size === 0);
  await old.writeTail;
  assert.equal(await readFile(join(directory, "schedules.json"), "utf8"), current);
  assert.equal(old.list().some((record) => record.error), false);
  await assert.rejects(old.create({ task, trigger: { type: "at", at: "+1h" } }), /shutting down/);
  await assert.rejects(old.cancel(old.list()[0].scheduleId), /stopped|own/);
  await assert.rejects(old.persist(), /stopped|own/);
  await assert.rejects(old.persist(true), /stopped|own/);
});

test("queued writes are rejected once shutdown fences mutations, before lock release", async (t) => {
  const { directory, make } = await setup(t);
  const manager = make(); await manager.start();
  let release;
  manager.writeTail = new Promise((resolve) => { release = resolve; });
  const queued = manager.persist();
  const rejected = assert.rejects(queued, /stopped|own/);
  const stopping = manager.shutdown();
  assert.equal(manager.ownsStore, true);
  release(); await rejected; await stopping;
  assert.equal(manager.ownsStore, false);
  const next = make(); await next.start();
  const before = await readFile(join(directory, "schedules.json"), "utf8");
  await assert.rejects(manager.persist(), /stopped|own/);
  assert.equal(await readFile(join(directory, "schedules.json"), "utf8"), before);
});

test("rejected child cleanup still drains an in-flight owned write before releasing its lock", async (t) => {
  const { make, managers } = await setup(t);
  const manager = make(); await manager.start();
  let release; let writing = false; let written = false;
  const write = manager.writeOwned(async () => { writing = true; await new Promise((resolve) => { release = resolve; }); written = true; });
  await eventually(() => writing);
  const cleanup = Promise.reject(new Error("child cleanup failed"));
  const stopping = manager.shutdown({ beforeRelease: cleanup });
  const rejection = assert.rejects(stopping, /child cleanup failed/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.ownsStore, true); assert.equal(written, false);
  release(); await write; await rejection;
  assert.equal(manager.ownsStore, false); assert.equal(written, true);
  const next = make(); await next.start();
  managers.splice(managers.indexOf(manager), 1);
});

test("preparation rejection after cancel is fenced without resurrecting error or timer", async (t) => {
  const { make, due, timers } = await setup(t);
  let rejectPreparation; let preparing = false;
  const manager = make({ prepareTemplate: () => { preparing = true; return new Promise((_, reject) => { rejectPreparation = reject; }); } });
  const record = await manager.create({ task, trigger: { type: "interval", every: "1s" } });
  due(); await eventually(() => preparing); await manager.cancel(record.scheduleId);
  rejectPreparation(new Error("late failure")); await eventually(() => manager.flights.size === 0);
  assert.equal(manager.get(record.scheduleId).error, undefined);
  assert.equal(timers.size, 0);
});

test("readSchedules leaves active persisted data untouched and never acquires an owner", async (t) => {
  const { directory, make } = await setup(t);
  const manager = make();
  await manager.create({ task, trigger: { type: "interval", every: "1s" } }); await manager.shutdown();
  const before = await readFile(join(directory, "schedules.json"), "utf8");
  const entries = await readdir(directory);
  const records = await readSchedules(directory, "/project");
  assert.equal(records[0].state.status, "active");
  assert.equal(await readFile(join(directory, "schedules.json"), "utf8"), before);
  assert.deepEqual(await readdir(directory), entries);
  const missing = join(directory, "missing");
  assert.deepEqual(await readSchedules(missing, "/project"), []);
  await assert.rejects(readdir(missing), { code: "ENOENT" });
});
