import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function projectKey(cwd) { return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24); }

export async function atomicJSON(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export class ProjectLock {
  constructor(directory, { cwd, isAlive = isProcessAlive, pid = process.pid } = {}) {
    this.directory = directory;
    this.cwd = cwd;
    this.isAlive = isAlive;
    this.pid = pid;
    this.token = randomUUID();
  }

  acquire() {
    if (this.owned) return;
    mkdirSync(dirname(this.directory), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(this.directory, { mode: 0o700 });
        writeFileSync(join(this.directory, "owner.json"), JSON.stringify({ token: this.token, pid: this.pid, cwd: this.cwd }), { flag: "wx", mode: 0o600 });
        this.owned = true;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let owner;
      try { owner = JSON.parse(readFileSync(join(this.directory, "owner.json"), "utf8")); }
      catch { throw new Error(`Schedule lock has no valid owner. Verify before manually removing ${this.directory}`); }
      if (this.isAlive(owner.pid)) throw new Error(`Schedules already owned by Pi process ${owner.pid} for ${this.cwd}`);
      const reaperPath = join(this.directory, "reaper.json");
      let fd;
      try {
        fd = openSync(reaperPath, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ token: this.token, pid: this.pid }));
        closeSync(fd);
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        if (error.code === "ENOENT") continue;
        throw new Error(`Schedule lock recovery is already in progress. Verify ${this.directory} before retrying.`);
      }
      const current = JSON.parse(readFileSync(join(this.directory, "owner.json"), "utf8"));
      if (current.token !== owner.token || this.isAlive(current.pid)) {
        const reaper = JSON.parse(readFileSync(reaperPath, "utf8"));
        if (reaper.token === this.token) rmSync(reaperPath);
        continue;
      }
      const retired = `${this.directory}.retired-${this.token}`;
      renameSync(this.directory, retired);
      rmSync(retired, { recursive: true, force: true });
    }
    throw new Error("Could not acquire schedule ownership after concurrent recovery");
  }

  release() {
    if (!this.owned) return;
    const owner = JSON.parse(readFileSync(join(this.directory, "owner.json"), "utf8"));
    if (owner.token !== this.token) throw new Error("Schedule lock ownership changed; refusing to release another owner's lock");
    const retired = `${this.directory}.released-${this.token}`;
    renameSync(this.directory, retired);
    this.owned = false;
    rmSync(retired, { recursive: true, force: true });
  }
}

export class TaskJournal {
  static async open(directory, taskId, { maxBytes = 67108864, now = Date.now } = {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const eventFile = join(directory, "events.jsonl");
    const handle = await open(eventFile, "wx", 0o600);
    return new TaskJournal({ directory, eventFile, handle, taskId, maxBytes, now });
  }
  constructor(options) {
    Object.assign(this, options);
    this.seq = 0;
    this.bytes = 0;
    this.tail = Promise.resolve();
  }
  append(source, event) {
    const line = JSON.stringify({ version: 1, seq: ++this.seq, at: this.now(), taskId: this.taskId, source, event }) + "\n";
    const bytes = Buffer.byteLength(line);
    const terminal = source === "fleet" && event.type === "task_terminal";
    if (terminal && (bytes > 1024 || this.terminalWritten)) return Promise.reject(new Error("Invalid or duplicate terminal task marker"));
    const limit = this.maxBytes + (source === "fleet" ? 131072 : 0) + (terminal ? 1024 : 0);
    if (bytes > 8388608 || this.bytes + bytes > limit) return Promise.reject(new Error("Task event log reached its byte limit"));
    this.bytes += bytes;
    if (terminal) this.terminalWritten = true;
    const write = this.tail.then(() => this.handle.writeFile(line, "utf8"));
    this.tail = write.catch(() => {});
    return write;
  }
  snapshot(task) {
    const copy = structuredClone(task);
    const write = this.tail.then(() => atomicJSON(join(this.directory, "state.json"), copy));
    this.tail = write.catch(() => {});
    return write;
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => { await this.tail; await this.handle.close(); })();
    return this.closePromise;
  }
}

export async function fileSize(file) { return (await stat(file)).size; }
