import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { defer } from "./domain.mjs";

export class RpcError extends Error {
  constructor(message, kind = "transport") {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
  }
}

export class LFDecoder {
  constructor(maxRecordBytes = 8388608) {
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.maxRecordBytes = maxRecordBytes;
  }
  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines = [];
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxRecordBytes) throw new RpcError("RPC record exceeds the byte limit", "protocol");
      if (line) lines.push(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxRecordBytes) throw new RpcError("Unterminated RPC record exceeds the byte limit", "protocol");
    return lines;
  }
  finish() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new RpcError("RPC stdout ended with an incomplete JSONL record", "protocol");
  }
}

export function childEnvironment(source = process.env) {
  const env = { ...source, RPC_SUBAGENTS_CHILD: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_") || key.startsWith("PI_SUBAGENTS_") || key.startsWith("SUBAGENT_")) delete env[key];
  }
  return env;
}

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function beforeDeadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

export class RpcTransport {
  constructor(options) {
    this.options = options;
    this.pending = new Map();
    this.closed = defer();
    this.writeTail = Promise.resolve();
    this.writes = new Set();
    this.failure = undefined;
    this.closing = false;
  }

  start() {
    if (this.child) throw new RpcError("RPC transport already started");
    const o = this.options;
    try {
      this.child = (o.spawnImpl ?? spawn)(process.execPath, [o.cliPath, "--mode", "rpc", ...o.args], {
        cwd: o.cwd,
        env: childEnvironment(o.env),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.fail(new RpcError(`RPC spawn failed: ${error.message}`, "spawn"));
      this.closed.resolve();
      return;
    }
    const child = this.child;
    child.once("error", (error) => {
      this.fail(new RpcError(`RPC process error: ${error.message}`, "spawn"));
      if (!child.pid) this.closed.resolve();
    });
    child.stdin.on("error", (error) => { if (!this.closing) this.fail(new RpcError(`RPC stdin error: ${error.message}`)); });
    this.stdoutDone = this.readStdout(child.stdout).catch((error) => this.fail(error));
    child.once("close", (code, signal) => {
      this.closed.resolve();
      this.stdoutDone.then(() => {
        if (!this.closing) this.fail(new RpcError(`RPC exited unexpectedly (${signal ?? code})`, "exit"));
        this.rejectPending(new RpcError("RPC process closed", "exit"));
        this.rejectWrites(new RpcError("RPC process closed", "exit"));
      });
    });
    this.readStderr(child.stderr).catch((error) => { if (!this.closing) this.fail(error); });
  }

  async readStdout(stdout) {
    const decoder = new LFDecoder(this.options.maxRecordBytes);
    for await (const chunk of stdout) {
      for (const line of decoder.push(chunk)) {
        let record;
        try { record = JSON.parse(line); } catch { throw new RpcError("Invalid JSON on RPC stdout", "protocol"); }
        if (!record || typeof record.type !== "string") throw new RpcError("Invalid RPC record", "protocol");
        await this.options.onRecord?.(record);
        if (record.type !== "response") continue;
        const request = this.pending.get(record.id);
        if (!request) continue;
        this.pending.delete(record.id);
        clearTimeout(request.timer);
        if (record.command !== request.command) request.reject(new RpcError("RPC response command does not match request ID", "protocol"));
        else if (record.success === true) request.resolve(record.data);
        else request.reject(new RpcError(record.error ?? `RPC ${request.command} rejected`, "command"));
      }
    }
    decoder.finish();
  }

  async readStderr(stderr) {
    const decoder = new StringDecoder("utf8");
    for await (const chunk of stderr) await this.options.onStderr?.(decoder.write(chunk));
    const tail = decoder.end();
    if (tail) await this.options.onStderr?.(tail);
  }

  fail(error) {
    if (this.failure || this.closing) return;
    this.failure = error instanceof RpcError ? error : new RpcError(error.message ?? String(error));
    this.rejectPending(this.failure);
    this.rejectWrites(this.failure);
    Promise.resolve(this.options.onFailure?.(this.failure)).catch(() => {});
  }

  rejectPending(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  rejectWrites(error) {
    for (const finish of this.writes) finish(error);
  }

  send(record) {
    const line = JSON.stringify(record) + "\n";
    const timeoutMs = this.options.writeTimeoutMs ?? 1000;
    const previous = this.writeTail;
    const write = new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.writes.delete(finish);
        error ? reject(error) : resolve();
      };
      this.writes.add(finish);
      timer = setTimeout(() => {
        const error = new RpcError(`RPC stdin write timed out after ${timeoutMs}ms`, "timeout");
        finish(error);
        this.fail(error);
      }, timeoutMs);
      previous.then(() => {
        if (settled) return;
        if (this.failure) { finish(this.failure); return; }
        if (!this.child || this.child.stdin.destroyed || this.closing) { finish(new RpcError("RPC stdin is closed")); return; }
        try { this.child.stdin.write(line, "utf8", (error) => { finish(error); if (error) this.fail(error); }); } catch (error) { finish(error); this.fail(error); }
      });
    });
    this.writeTail = write.catch(() => {});
    return write;
  }

  request(command, data = {}, { timeoutMs = this.options.commandTimeoutMs ?? 30000 } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child || this.closing) return Promise.reject(new RpcError("RPC is not running"));
    if (this.pending.size >= 64) return Promise.reject(new RpcError("Too many outstanding RPC commands"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`RPC ${command} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      this.send({ ...data, type: command, id }).catch((error) => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  respond(id, response) { return this.send({ type: "extension_ui_response", id, ...response }); }

  cancel() {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelPromise = (async () => {
      const timeoutMs = this.options.cancelCommandTimeoutMs ?? 1000;
      try { await this.request("clear_queue", {}, { timeoutMs }); } catch {}
      try { await this.request("abort", {}, { timeoutMs }); } catch {}
      await this.close();
    })();
    return this.cancelPromise;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closing = true;
      const error = new RpcError("RPC transport is closing");
      this.rejectPending(error);
      this.rejectWrites(error);
      if (!this.child) return;
      try { this.child.stdin.end(); } catch {}
      const signal = this.options.signalGroup ?? signalProcessGroup;
      const graceMs = this.options.closeGraceMs ?? 500;
      const termMs = this.options.termGraceMs ?? 750;
      if (!(await beforeDeadline(this.closed.promise, graceMs))) {
        signal(this.child, "SIGTERM");
        if (!(await beforeDeadline(this.closed.promise, termMs))) {
          signal(this.child, "SIGKILL");
          if (!(await beforeDeadline(this.closed.promise, termMs))) throw new RpcError("RPC process did not close after SIGKILL");
        }
      }
      if (process.platform !== "win32" && this.child.pid) signal(this.child, "SIGKILL");
    })();
    return this.closePromise;
  }
}
