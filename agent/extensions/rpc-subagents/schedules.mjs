import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ProjectLock, atomicJSON, readJSON } from "./store.mjs";
import { normalizeTaskSpec, terminalScheduleStates, nonempty } from "./domain.mjs";

const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  const duration = match ? Number(match[1]) * units[match[2]] : NaN;
  if (!Number.isSafeInteger(duration) || duration < 100 || duration > 315360000000) throw new Error("Duration must be 100ms..10 years, such as 10m or 2h");
  return duration;
}

export function parseTrigger(input, now) {
  if (!input || typeof input !== "object") throw new Error("Exactly one schedule trigger is required");
  if (input.type === "at") {
    let at;
    if (typeof input.at !== "string") throw new Error("at must be a zoned ISO timestamp or +duration");
    if (input.at.startsWith("+")) at = now + parseDuration(input.at.slice(1));
    else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new Error("at requires an ISO timestamp with an explicit Z or UTC offset");
      at = Date.parse(input.at);
    }
    if (!Number.isFinite(at) || at <= now) throw new Error("One-shot schedules must be in the future");
    return { type: "at", at };
  }
  if (input.type === "interval") return { type: "interval", intervalMs: parseDuration(input.every), anchor: now };
  if (input.type === "cron") {
    if (typeof input.expression !== "string" || input.expression.trim().split(/\s+/).length !== 5) throw new Error("cron requires exactly five fields");
    if (typeof input.timezone !== "string" || !input.timezone) throw new Error("cron requires an explicit IANA timezone");
    try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch { throw new Error(`Invalid IANA timezone: ${input.timezone}`); }
    return { type: "cron", expression: input.expression.trim(), timezone: input.timezone };
  }
  throw new Error("Schedule trigger must be at, interval, or cron");
}

export async function loadCron() {
  try { return (await import("croner")).Cron; }
  catch { throw new Error("Cron schedules require the pinned croner@9.1.0 dependency. Install dependencies in the rpc-subagents extension directory; no custom cron fallback is provided."); }
}

export function nextTrigger(trigger, after, Cron) {
  if (trigger.type === "at") return trigger.at > after ? trigger.at : null;
  if (trigger.type === "interval") return trigger.anchor + (Math.floor((after - trigger.anchor) / trigger.intervalMs) + 1) * trigger.intervalMs;
  if (!Cron) throw new Error("Cron dependency is unavailable");
  const job = new Cron(trigger.expression, { timezone: trigger.timezone, paused: true });
  try {
    const date = job.nextRun(new Date(after));
    if (!date || date.getTime() <= after) throw new Error("Cron expression has no future occurrence");
    return date.getTime();
  } finally { job.stop(); }
}

export async function readSchedules(directory, cwd) {
  const saved = await readJSON(join(directory, "schedules.json"), { version: 1, cwd, schedules: [] });
  if (saved.version !== 1 || saved.cwd !== cwd || !Array.isArray(saved.schedules) || saved.schedules.length > 1000 ||
    saved.schedules.some((record) => record.cwd !== cwd || record.task?.cwd !== cwd)) throw new Error("Invalid schedule store or project owner");
  return saved.schedules;
}

export class ScheduleManager {
  constructor({ directory, cwd, fleet, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    lock = undefined, cronLoader = loadCron, prepareTemplate = undefined, historyLimit = 50, maxSchedules = 1000 }) {
    Object.assign(this, { directory, cwd, fleet, now, setTimer, clearTimer, cronLoader, historyLimit, maxSchedules });
    this.lock = lock ?? new ProjectLock(join(directory, "owner.lock"), { cwd });
    this.prepareTemplate = prepareTemplate ?? (async (record) => record.templatePath ? readJSON(record.templatePath) : undefined);
    this.records = new Map();
    this.timers = new Map();
    this.flights = new Map();
    this.listeners = new Set();
    this.writeTail = Promise.resolve();
    this.stopped = false;
    this.ownsStore = false;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }

  start() {
    if (this.stopped) return Promise.reject(new Error("Schedule manager is shutting down"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.restore();
    return this.startPromise;
  }

  async restore() {
    this.lock.acquire();
    this.ownsStore = true;
    try {
      const saved = await readJSON(join(this.directory, "schedules.json"), { version: 1, cwd: this.cwd, schedules: [] });
      if (saved.version !== 1 || saved.cwd !== this.cwd || !Array.isArray(saved.schedules) || saved.schedules.length > this.maxSchedules) throw new Error("Invalid schedule store or project owner");
      for (const original of saved.schedules) {
        if (original.cwd !== this.cwd || original.task?.cwd !== this.cwd) throw new Error("Schedule cwd does not match its project owner");
        const record = structuredClone(original);
        if (!/^[0-9a-f-]{36}$/i.test(record.scheduleId) || this.records.has(record.scheduleId) ||
          !["active", "paused", "cancelled", "completed", "missed"].includes(record.state?.status) ||
          !Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.history) ||
          !Array.isArray(record.activeTaskIds) || record.activeTaskIds.length > 1) throw new Error("Invalid persisted schedule record");
        if (record.templatePath && record.templatePath !== join(this.directory, "templates", `${record.scheduleId}.json`)) throw new Error("Schedule template is outside its owner's template directory");
        record.task = normalizeTaskSpec({ ...record.task, async: true });
        if (record.task.session !== undefined) throw new Error("Persisted schedule session continuation is not supported; recreate the schedule as fresh or fork");
        if (record.task.context === "fork" && !record.templatePath) throw new Error("Fork schedule has no immutable template");
        const trigger = record.trigger;
        if (!trigger || (trigger.type === "at" && !Number.isFinite(trigger.at)) ||
          (trigger.type === "interval" && (!Number.isSafeInteger(trigger.intervalMs) || trigger.intervalMs < 100 || !Number.isFinite(trigger.anchor))) ||
          !["at", "interval", "cron"].includes(trigger.type)) throw new Error("Invalid persisted schedule trigger");
        if (trigger.type === "cron") parseTrigger(trigger, this.now());
        record.history = record.history.slice(-this.historyLimit);
        for (const taskId of record.activeTaskIds ?? []) this.history(record, { taskId, at: this.now(), status: "interrupted" });
        record.activeTaskIds = [];
        this.records.set(record.scheduleId, record);
        if (record.state.status !== "active") continue;
        if (record.trigger.type === "at" && record.trigger.at <= this.now()) {
          record.state = { status: "missed" };
          record.nextAt = null;
          continue;
        }
        try {
          await this.ensureCron(record.trigger);
          record.nextAt = nextTrigger(record.trigger, this.now(), this.Cron);
          delete record.error;
        } catch (error) {
          record.error = error.message;
          record.nextAt = null;
        }
      }
      await this.persist();
      this.started = true;
      if (!this.stopped) for (const record of this.records.values()) this.arm(record);
      this.notify();
    } catch (error) {
      await this.writeTail;
      this.ownsStore = false;
      this.lock.release();
      throw error;
    }
  }

  assertWritable(allowStopped = false) {
    if (!this.ownsStore || (this.stopped && !allowStopped)) throw new Error("Schedule manager is stopped or does not own its store");
  }

  async ensureCron(trigger) {
    if (trigger.type === "cron" && !this.Cron) this.Cron = await this.cronLoader();
  }

  list() { return [...this.records.values()].map((record) => structuredClone(record)); }

  async create({ name, task, trigger }, { template } = {}) {
    const capturedTemplate = template ? structuredClone(template) : undefined;
    const normalizedTask = normalizeTaskSpec({ ...task, async: true });
    if (normalizedTask.session !== undefined) throw new Error("Schedules cannot continue an existing session; use context fresh or fork");
    if (normalizedTask.cwd !== this.cwd) throw new Error("A schedule must belong to the task's cwd owner");
    if (normalizedTask.context === "fork" && !capturedTemplate) throw new Error("Fork schedules require a creation-time branch snapshot");
    const parsed = parseTrigger(trigger, this.now());
    await this.start();
    if (this.stopped) throw new Error("Schedule manager is shutting down");
    if (this.records.size >= this.maxSchedules) throw new Error(`Schedule record limit reached (${this.maxSchedules})`);
    await this.ensureCron(parsed);
    this.assertWritable();
    const scheduleId = randomUUID();
    const record = {
      scheduleId, name: nonempty(name ?? normalizedTask.name, "schedule name", 160), cwd: this.cwd, task: normalizedTask, trigger: parsed,
      state: { status: "active" }, revision: 0, createdAt: this.now(), nextAt: nextTrigger(parsed, this.now(), this.Cron),
      activeTaskIds: [], history: [],
    };
    if (capturedTemplate) {
      record.templatePath = join(this.directory, "templates", `${scheduleId}.json`);
      await this.writeOwned(async () => {
        await mkdir(join(this.directory, "templates"), { recursive: true, mode: 0o700 });
        await writeFile(record.templatePath, JSON.stringify(capturedTemplate) + "\n", { flag: "wx", mode: 0o600 });
      });
    }
    if (this.stopped) throw new Error("Schedule manager shut down during creation");
    if (this.records.size >= this.maxSchedules) throw new Error(`Schedule record limit reached (${this.maxSchedules})`);
    if (record.trigger.type === "at" && record.trigger.at <= this.now()) { record.state = { status: "missed" }; record.nextAt = null; }
    this.records.set(scheduleId, record);
    try { await this.persist(); } catch (error) { this.records.delete(scheduleId); throw error; }
    this.arm(record);
    this.notify();
    return structuredClone(record);
  }

  get(scheduleId) {
    const record = this.records.get(scheduleId);
    if (!record) throw new Error("Unknown schedule ID for this cwd");
    return record;
  }

  async pause(scheduleId) {
    this.assertWritable();
    const record = this.get(scheduleId);
    if (record.state.status !== "active") return structuredClone(record);
    record.state = { status: "paused" };
    record.revision++;
    this.disarm(scheduleId);
    await this.persist();
    this.notify();
    return structuredClone(record);
  }

  async resume(scheduleId) {
    this.assertWritable();
    const record = this.get(scheduleId);
    if (record.state.status !== "paused") return structuredClone(record);
    const revision = ++record.revision;
    await this.ensureCron(record.trigger);
    this.assertWritable();
    if (record.revision !== revision || record.state.status !== "paused") return structuredClone(record);
    record.nextAt = nextTrigger(record.trigger, this.now(), this.Cron);
    record.state = { status: record.nextAt === null ? "missed" : "active" };
    delete record.error;
    await this.persist();
    this.arm(record);
    this.notify();
    return structuredClone(record);
  }

  async cancel(scheduleId, { abortRunning = false } = {}) {
    this.assertWritable();
    const record = this.get(scheduleId);
    if (!terminalScheduleStates.has(record.state.status)) {
      record.state = { status: "cancelled" };
      record.revision++;
      record.nextAt = null;
      this.disarm(scheduleId);
      await this.persist();
    }
    if (abortRunning) await Promise.all(record.activeTaskIds.map((id) => this.fleet.cancel(id, `Schedule ${scheduleId} cancelled`)));
    this.notify();
    return structuredClone(record);
  }

  writeOwned(operation, allowStopped = false) {
    try { this.assertWritable(allowStopped); } catch (error) { return Promise.reject(error); }
    const write = this.writeTail.then(() => {
      this.assertWritable(allowStopped);
      return operation();
    });
    this.writeTail = write.catch(() => {});
    return write;
  }

  persist(allowStopped = false) {
    const snapshot = { version: 1, cwd: this.cwd, schedules: this.list() };
    return this.writeOwned(() => atomicJSON(join(this.directory, "schedules.json"), snapshot), allowStopped);
  }

  history(record, item) {
    record.history.push(item);
    if (record.history.length > this.historyLimit) record.history.splice(0, record.history.length - this.historyLimit);
  }

  disarm(scheduleId) { this.clearTimer(this.timers.get(scheduleId)); this.timers.delete(scheduleId); }

  arm(record) {
    this.disarm(record.scheduleId);
    if (this.stopped || record.state.status !== "active" || record.nextAt === null || record.error) return;
    const delay = Math.min(2147483647, Math.max(0, record.nextAt - this.now()));
    this.timers.set(record.scheduleId, this.setTimer(() => {
      this.timers.delete(record.scheduleId);
      if (record.nextAt > this.now()) { this.arm(record); return; }
      const revision = record.revision;
      this.fire(record.scheduleId).catch((error) => {
        if (this.stopped || !this.ownsStore || record.revision !== revision || record.state.status !== "active") return;
        record.error = error.message;
        this.disarm(record.scheduleId);
        this.persist().catch(() => {});
        this.notify();
      });
    }, delay));
  }

  async fire(scheduleId) {
    const record = this.get(scheduleId);
    if (this.stopped || record.state.status !== "active" || record.nextAt === null || record.nextAt > this.now()) return;
    const due = record.nextAt;
    record.nextAt = record.trigger.type === "at" ? null : nextTrigger(record.trigger, this.now(), this.Cron);
    this.arm(record);
    if (this.flights.has(scheduleId) || record.activeTaskIds.length) {
      this.history(record, { at: due, status: "skipped_overlap" });
      await this.persist();
      return;
    }
    const token = { revision: record.revision };
    this.flights.set(scheduleId, token);
    try {
      await this.persist();
      let template;
      try { template = await this.prepareTemplate(structuredClone(record)); }
      catch (error) {
        if (this.stopped || !this.ownsStore || record.state.status !== "active" || record.revision !== token.revision) return;
        throw error;
      }
      if (this.stopped || !this.ownsStore || record.state.status !== "active" || record.revision !== token.revision) return;
      const taskId = this.fleet.submit(record.task, { template, scheduleId });
      record.activeTaskIds.push(taskId);
      this.fleet.wait(taskId).then((result) => this.finished(record, result), (error) => this.finished(record, { taskId, status: "failed", error: error.message })).catch((error) => {
        if (this.stopped || !this.ownsStore || record.revision !== token.revision) return;
        record.error = error.message;
        this.notify();
      });
      await this.persist();
    } finally {
      if (this.flights.get(scheduleId) === token) this.flights.delete(scheduleId);
      this.notify();
    }
  }

  async finished(record, result) {
    if (!this.ownsStore) return;
    record.activeTaskIds = record.activeTaskIds.filter((id) => id !== result.taskId);
    this.history(record, { taskId: result.taskId, at: this.now(), status: result.status, ...(result.error ? { error: result.error } : {}) });
    if (record.trigger.type === "at" && !terminalScheduleStates.has(record.state.status)) record.state = { status: "completed" };
    if (!this.stopped) await this.persist();
    this.notify();
  }

  shutdown({ beforeRelease } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    for (const id of this.timers.keys()) this.disarm(id);
    for (const record of this.records.values()) record.revision++;
    this.shutdownPromise = (async () => {
      try {
        try { await this.startPromise; } catch {}
        await beforeRelease;
        await this.writeTail;
        if (this.started) await this.persist(true);
      } finally {
        await this.writeTail;
        this.ownsStore = false;
        this.lock.release();
        this.listeners.clear();
      }
    })();
    return this.shutdownPromise;
  }
}
