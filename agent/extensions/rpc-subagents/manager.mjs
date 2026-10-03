import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { abortError, assertTransition, boundedInteger, boundedText, defer, normalizeTaskSpec, terminalTaskStates, textContent } from "./domain.mjs";
import { TaskJournal, readJSON, isProcessAlive } from "./store.mjs";
import { RpcTransport } from "./transport.mjs";
import { SessionRegistry } from "./sessions.mjs";
import { BOOTSTRAP_PROMPT, COORDINATION_LIMITS, normalizeCoordinationText, normalizeParentAnswer, normalizePendingOptions,
  parseCoordinationRecord, verifyCapabilities } from "./coordination.mjs";

export class FleetManager {
  constructor({ root, prepare, concurrency = 4, maxQueued = 100, maxRetained = 200, journalOptions = {}, transportFactory = undefined, now = Date.now,
    dialogTimeoutMs = 120000, bootstrapTimeoutMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.root = root;
    this.ownerId = randomUUID();
    this.sessions = new SessionRegistry({ root, ownerId: this.ownerId });
    this.prepare = prepare;
    this.concurrency = boundedInteger(concurrency, "concurrency", 1, 32);
    this.maxQueued = maxQueued;
    this.maxRetained = maxRetained;
    this.journalOptions = journalOptions;
    this.transportFactory = transportFactory ?? ((options) => new RpcTransport(options));
    this.now = now;
    this.dialogTimeoutMs = dialogTimeoutMs;
    this.bootstrapTimeoutMs = boundedInteger(bootstrapTimeoutMs, "bootstrapTimeoutMs", 1, 600000);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    this.listeners = new Set();
    this.stopped = false;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }

  submit(input, { template, scheduleId } = {}) {
    if (this.stopped) throw new Error("RPC subagents is shutting down");
    const spec = normalizeTaskSpec(input);
    if (spec.context === "fork" && !template) throw new Error("Fork tasks require an invocation-time branch snapshot");
    if (this.queue.length >= this.maxQueued) throw new Error("RPC subagents queue is full");
    const taskId = randomUUID();
    const directory = join(this.root, "tasks", taskId);
    const task = {
      taskId, spec: structuredClone(spec), template: template ? structuredClone(template) : undefined, directory,
      binding: { taskId, ownerId: this.ownerId, nonce: randomUUID() },
      abort: new AbortController(),
      state: { status: "queued" }, text: "", truncated: false, createdAt: this.now(), currentTools: new Map(),
      done: defer(), dialogs: new Map(), requests: new Map(), reports: [], reportSeq: 0, droppedThrough: 0,
      scheduleId, eventFile: join(directory, "events.jsonl"),
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    task.timeout = this.setTimer(() => { this.stopTask(task, "failed", `Task deadline exceeded (${spec.timeoutMs}ms)`).catch(() => {}); }, spec.timeoutMs);
    task.initialization = this.initialize(task);
    task.initialization.catch((error) => {
      if (task.stopPromise || task.finishing || task.state.status === "cancelling") return;
      return this.stopTask(task, "failed", error.message).catch(() => {});
    });
    this.notify();
    queueMicrotask(() => this.drain());
    return taskId;
  }

  async initialize(task) {
    task.journal = await TaskJournal.open(task.directory, task.taskId, { ...this.journalOptions, now: this.now });
    await task.journal.append("fleet", { type: "task_created", task: this.publicTask(task) });
    await task.journal.snapshot(this.publicTask(task));
    await this.acquireLease(task);
  }

  async acquireLease(task) {
    const input = { taskId: task.taskId, cwd: task.spec.cwd, model: task.spec.model, signal: task.abort.signal };
    task.lease = task.spec.session === undefined
      ? await this.sessions.acquireFresh({ ...input, directory: task.directory })
      : await this.sessions.acquireResume({ ...input, session: task.spec.session });
    if (task.lease.sessionId !== undefined) task.sessionId = task.lease.sessionId;
    if (task.lease.continuedFromTaskId !== undefined) task.continuedFromTaskId = task.lease.continuedFromTaskId;
    task.sessionFile = task.lease.sessionFile;
    await task.journal.append("fleet", { type: "session_acquired", kind: task.lease.kind, sessionFile: task.lease.sessionFile });
  }

  async run(spec, { template, signal, scheduleId } = {}) {
    if (!spec.async && signal?.aborted) throw abortError(signal.reason);
    const taskId = this.submit(spec, { template, scheduleId });
    if (spec.async) return this.status(taskId);
    return this.wait(taskId, { signal, cancelOnAbort: true });
  }

  publicTask(task) {
    const result = {
      taskId: task.taskId, name: task.spec.name, model: task.spec.model, webAccess: task.spec.webAccess, thinking: task.spec.thinking, timeoutMs: task.spec.timeoutMs, cwd: task.spec.cwd,
      status: task.state.status, state: structuredClone(task.state), text: task.text, truncated: task.truncated,
      createdAt: task.createdAt, currentTools: [...task.currentTools.values()], eventFile: task.eventFile,
      ownerId: this.ownerId, ownerPid: process.pid,
    };
    for (const key of ["startedAt", "finishedAt", "sessionFile", "scheduleId"]) if (task[key] !== undefined) result[key] = task[key];
    if (task.sessionId !== undefined) result.sessionId = task.sessionId;
    if (task.sessionReusable !== undefined) result.sessionReusable = task.sessionReusable;
    if (task.continuedFromTaskId !== undefined) result.continuedFromTaskId = task.continuedFromTaskId;
    if (task.capabilities !== undefined) result.capabilities = structuredClone(task.capabilities);
    if (task.reports.length) result.reports = task.reports.map((report) => ({ ...report }));
    if (task.requests.size) result.requests = this.publicRequests(task);
    if (task.droppedThrough) result.droppedReportsThrough = task.droppedThrough;
    if (task.state.status === "failed") result.error = task.state.error;
    if (task.persistenceError) result.persistenceError = task.persistenceError;
    return result;
  }

  publicRequests(task) {
    return [...task.requests.values()].map((entry) => ({ ...entry.request }));
  }

  restingState(task) {
    const dialogs = [...task.dialogs.values()].map((entry) => entry.dialog);
    const requests = this.publicRequests(task);
    if (dialogs.length || requests.length) return { status: "waiting_input", dialogs, ...(requests.length ? { requests } : {}) };
    return task.accepted ? { status: "running", disposition: task.accepted } : { status: "starting" };
  }

  alive(task) {
    return !task.finishing && !task.stopPromise && task.state.status !== "cancelling" && !terminalTaskStates.has(task.state.status);
  }

  list() { return [...this.tasks.values()].map((task) => this.publicTask(task)); }

  async status(taskId) {
    const task = this.tasks.get(taskId);
    if (task) return this.publicTask(task);
    this.validateTaskId(taskId);
    const saved = await readJSON(join(this.root, "tasks", taskId, "state.json"));
    if (!terminalTaskStates.has(saved.status)) {
      if (saved.ownerPid !== undefined && saved.ownerPid !== process.pid && isProcessAlive(saved.ownerPid)) throw new Error("Task belongs to another live Pi owner. Wait or cancel through that owner; live tasks are not adopted.");
      return { ...saved, status: "interrupted", state: { status: "interrupted", reason: "Previous owner exited; live tasks are not recovered" }, currentTools: [] };
    }
    return saved;
  }

  validateTaskId(taskId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("Invalid task ID");
  }

  async result(taskId) { return this.status(taskId); }

  /** @param {string} taskId @param {{ signal?: AbortSignal, timeoutMs?: number, cancelOnAbort?: boolean }} [options] */
  wait(taskId, { signal, timeoutMs, cancelOnAbort = false } = {}) {
    if (timeoutMs !== undefined) boundedInteger(timeoutMs, "wait timeoutMs", 1, 86400000);
    const task = this.tasks.get(taskId);
    if (!task) return this.status(taskId);
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      let aborting = false;
      const cleanup = () => { this.clearTimer(timer); signal?.removeEventListener("abort", onAbort); };
      const complete = (result, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve(result);
      };
      const onAbort = () => {
        if (cancelOnAbort) {
          aborting = true;
          this.cancel(taskId, String(signal.reason ?? "Synchronous caller cancelled")).then(
            () => complete(undefined, abortError(signal.reason)), (error) => complete(undefined, error));
        } else complete(undefined, abortError(signal.reason));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timer = this.setTimer(() => complete(this.publicTask(task)), timeoutMs);
      task.done.promise.then((result) => { if (!aborting) complete(result); });
    });
  }

  drain() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency && this.queue.length) {
      const task = this.tasks.get(this.queue.shift());
      if (!task || task.state.status !== "queued") continue;
      this.running.add(task.taskId);
      this.launch(task).catch((error) => {
        if (!terminalTaskStates.has(task.state.status) && task.state.status !== "cancelling") {
          this.stopTask(task, "failed", error.message).catch(() => {});
        }
      });
    }
  }

  async transition(task, state) {
    if (terminalTaskStates.has(task.state.status)) return;
    assertTransition(task.state.status, state.status);
    task.state = state;
    this.notify();
    if (task.journal) {
      await task.journal.append("fleet", { type: "task_state", state });
      await task.journal.snapshot(this.publicTask(task));
    }
  }

  async launch(task) {
    await task.initialization;
    if (task.state.status !== "queued") return;
    await this.transition(task, { status: "starting" });
    if (!this.alive(task)) return;
    const lease = task.lease;
    const prepared = await this.prepare(task.spec, {
      taskId: task.taskId, ownerId: this.ownerId, nonce: task.binding.nonce,
      directory: task.directory, template: task.template, session: lease,
    });
    task.template = undefined;
    if (!this.alive(task)) return;
    if (!prepared || prepared.sessionFile !== lease.sessionFile) throw new Error("Prepared session file does not match the owned session lease");
    if (prepared.binding && (prepared.binding.taskId !== task.binding.taskId || prepared.binding.ownerId !== task.binding.ownerId || prepared.binding.nonce !== task.binding.nonce)) {
      throw new Error("Prepared launch binding does not match the owned task");
    }
    task.approvedWebTools = prepared.webTools;
    task.sessionFile = lease.sessionFile;
    if (Number.isFinite(prepared.commandTimeoutMs)) task.commandTimeoutMs = prepared.commandTimeoutMs;
    task.transport = this.transportFactory({ ...prepared,
      binding: prepared.binding ?? task.binding,
      tools: task.spec.tools,
      webAccess: task.spec.webAccess,
      onRecord: (record) => this.record(task, record),
      onStderr: async (text) => { if (!task.finishing) await task.journal.append("stderr", { type: "stderr", text }); },
      onFailure: (error) => { if (!task.finishing) return this.stopTask(task, "failed", error.message); },
    });
    task.transport.start();
    task.spawned = task.transport.child !== undefined;
    if (task.spawned) {
      if (!task.transport.child.pid) throw new Error("RPC child has no process ID; the session lease cannot be attached");
      task.attach = this.sessions.attach(lease, { childPid: task.transport.child.pid });
      await task.attach;
      task.attached = true;
    }
    if (!this.alive(task)) return;
    const state = await task.transport.request("get_state");
    if (!this.alive(task)) return;
    if (state?.model?.provider !== task.spec.model.provider || state?.model?.id !== task.spec.model.id) {
      throw new Error(`Requested model is unavailable in RPC child: ${task.spec.model.provider}/${task.spec.model.id}. No fallback is allowed.`);
    }
    if (typeof state?.sessionFile !== "string" || typeof state?.sessionId !== "string") {
      throw new Error("RPC child get_state must report sessionFile and sessionId for lease verification");
    }
    await this.sessions.observe(lease, { sessionId: state.sessionId, sessionFile: state.sessionFile, model: state.model });
    task.sessionId = state.sessionId;
    if (!this.alive(task)) return;
    const levels = await task.transport.request("get_available_thinking_levels");
    if (!levels?.levels?.includes(task.spec.thinking)) throw new Error(`Thinking level ${task.spec.thinking} is unavailable for the requested model`);
    if (!this.alive(task)) return;
    await task.transport.request("set_thinking_level", { level: task.spec.thinking });
    if (!this.alive(task)) return;
    task.phase = "bootstrap";
    const inventory = await this.bootstrap(task);
    if (!this.alive(task)) return;
    task.capabilities = verifyCapabilities(task.spec.tools, inventory, task.spec.webAccess, task.approvedWebTools);
    task.phase = "user";
    task.startedAt = this.now();
    const accepted = await task.transport.request("prompt", { message: task.spec.prompt });
    if (!this.alive(task)) return;
    if (!["started", "queued", "handled"].includes(accepted?.disposition)) throw new Error("RPC prompt response has no valid disposition");
    task.accepted = accepted.disposition;
    if (accepted.disposition === "handled") {
      await this.finish(task, { status: "completed", disposition: "handled" });
    } else if (task.settled) {
      await this.settleTask(task);
    } else if (!task.dialogs.size && !task.requests.size) {
      await this.transition(task, { status: "running", disposition: accepted.disposition });
    }
  }

  async bootstrap(task) {
    const remaining = Math.max(1, task.spec.timeoutMs - (this.now() - task.createdAt));
    const bound = Math.max(1, Math.min(this.bootstrapTimeoutMs, task.commandTimeoutMs ?? this.bootstrapTimeoutMs, remaining));
    task.bootstrap = defer();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = this.setTimer(() => reject(new Error("Bootstrap tool inventory was not received before the handshake deadline")), bound);
    });
    const handshake = (async () => {
      const accepted = await task.transport.request("prompt", { message: BOOTSTRAP_PROMPT });
      if (accepted?.disposition !== "handled") throw new Error(`Bootstrap command was not handled (disposition: ${accepted?.disposition ?? "missing"})`);
      return await task.bootstrap.promise;
    })();
    try { return await Promise.race([handshake, deadline]); }
    finally { this.clearTimer(timer); }
  }

  async record(task, record) {
    if (task.finishing) return;
    await task.journal.append("rpc", record);
    if (record.type === "message_end" && record.message?.role === "assistant") {
      task.assistant = { stopReason: record.message.stopReason, errorMessage: record.message.errorMessage };
      Object.assign(task, boundedText(textContent(record.message.content)));
      task.truncated ||= task.assistant.stopReason === "length";
      if (!["error", "aborted"].includes(task.assistant.stopReason)) task.retryError = undefined;
      await task.journal.snapshot(this.publicTask(task));
    } else if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
      const next = boundedText(task.text + record.assistantMessageEvent.delta);
      task.text = next.text;
      task.truncated ||= next.truncated;
    } else if (record.type === "message_start" && record.message?.role === "assistant") {
      task.text = "";
      task.truncated = false;
    } else if (record.type === "tool_execution_start") {
      if (task.currentTools.size < 64) task.currentTools.set(record.toolCallId, record.toolName);
    } else if (record.type === "tool_execution_end") {
      task.currentTools.delete(record.toolCallId);
    } else if (record.type === "auto_retry_end" && record.success === false) {
      task.retryError = record.finalError ?? "Automatic retry failed";
    } else if (record.type === "compaction_end" && record.errorMessage && !record.willRetry && !record.aborted) {
      task.retryError = record.errorMessage;
    } else if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor", "notify"].includes(record.method)) {
      await this.uiRequest(task, record);
    } else if (record.type === "agent_settled") {
      task.settled = true;
      if (task.accepted) this.settleTask(task).catch((error) => this.stopTask(task, "failed", error.message).catch(() => {}));
    }
    this.notify();
  }

  async uiRequest(task, record) {
    let parsed;
    try { parsed = parseCoordinationRecord(record, task.binding); }
    catch (error) { throw new Error(`Invalid coordination envelope from RPC child: ${error.message}`); }
    if (parsed) {
      if (parsed.method === "input") { await this.addRequest(task, parsed); return; }
      await this.coordinationNotify(task, parsed.envelope);
      return;
    }
    if (record.method === "notify") return;
    await this.addDialog(task, record);
  }

  async coordinationNotify(task, envelope) {
    if (envelope.kind === "inventory") { await this.receiveInventory(task, envelope.inventory); return; }
    if (envelope.kind === "report") { await this.addReport(task, envelope); return; }
    await this.closeRequest(task, envelope.requestId);
  }

  async receiveInventory(task, inventory) {
    if (task.phase === "user" && task.spec.webAccess && task.capabilities) {
      task.capabilities = verifyCapabilities(task.spec.tools, inventory, true, task.capabilities.webTools);
      task.inventory = inventory;
      await task.journal.snapshot(this.publicTask(task));
      this.notify();
      return;
    }
    if (task.phase !== "bootstrap" || task.inventory !== undefined) throw new Error("Unexpected bootstrap inventory from RPC child");
    task.inventory = inventory;
    task.bootstrap.resolve(inventory);
  }

  async addReport(task, envelope) {
    const report = { messageId: envelope.messageId, seq: ++task.reportSeq, at: this.now(), message: envelope.message };
    task.reports.push(report);
    if (task.reports.length > COORDINATION_LIMITS.maxReports) {
      const dropped = task.reports.shift();
      task.droppedThrough = Math.max(task.droppedThrough, dropped.seq);
    }
    await task.journal.append("fleet", { type: "coordination_report", report });
  }

  async addRequest(task, parsed) {
    const { envelope, nativeDialogId } = parsed;
    if (task.requests.has(envelope.requestId)) throw new Error(`Duplicate coordination request ID from RPC child: ${envelope.requestId}`);
    if (task.requests.size >= COORDINATION_LIMITS.maxPendingRequests) throw new Error("Too many pending coordination requests");
    const remaining = Math.max(1, task.spec.timeoutMs - (this.now() - task.createdAt));
    const childWindow = Math.max(1, envelope.expiresAt - this.now());
    const duration = Math.max(1, Math.min(childWindow, this.dialogTimeoutMs, remaining));
    const request = { requestId: envelope.requestId, question: envelope.question, expiresAt: this.now() + duration };
    const entry = { request, nativeDialogId };
    entry.timer = this.setTimer(() => { this.expireRequest(task.taskId, request.requestId).catch((error) => this.stopTask(task, "failed", error.message).catch(() => {})); }, duration);
    task.requests.set(request.requestId, entry);
    await task.journal.append("fleet", { type: "coordination_request", request });
    if (this.alive(task)) await this.transition(task, this.restingState(task));
  }

  async expireRequest(taskId, requestId) {
    const task = this.tasks.get(taskId);
    const entry = task?.requests.get(requestId);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    task.requests.delete(requestId);
    try { await task.transport?.respond(entry.nativeDialogId, { cancelled: true }); } catch {}
    try { await task.journal?.append("fleet", { type: "coordination_request_closed", requestId, reason: "expired" }); } catch {}
    if (this.alive(task) && task.state.status === "waiting_input") await this.transition(task, this.restingState(task));
    return true;
  }

  async closeRequest(task, requestId) {
    const entry = task.requests.get(requestId);
    if (!entry) return;
    this.clearTimer(entry.timer);
    task.requests.delete(requestId);
    if (this.alive(task) && task.state.status === "waiting_input") await this.transition(task, this.restingState(task));
  }

  async addDialog(task, record) {
    if (task.state.status === "cancelling") { await task.transport.respond(record.id, { cancelled: true }); return; }
    if (task.dialogs.size >= 16 || typeof record.id !== "string" || record.id.length > 256 || task.dialogs.has(record.id) || task.requests.has(record.id)) {
      throw new Error("Invalid or excessive RPC UI dialogs");
    }
    const duration = Math.min(Number.isFinite(record.timeout) && record.timeout > 0 ? record.timeout : this.dialogTimeoutMs, this.dialogTimeoutMs);
    const dialog = { id: record.id, method: record.method, expiresAt: this.now() + duration };
    for (const key of ["title", "message", "placeholder", "prefill"]) {
      if (record[key] === undefined) continue;
      if (typeof record[key] !== "string" || record[key].length > 65536) {
        await task.transport.respond(record.id, { cancelled: true });
        throw new Error("RPC UI dialog exceeds the text limit");
      }
      dialog[key] = record[key];
    }
    if (record.method === "select") {
      if (!Array.isArray(record.options) || record.options.length > 128 || record.options.some((value) => typeof value !== "string" || value.length > 2048)) {
        await task.transport.respond(record.id, { cancelled: true });
        throw new Error("RPC UI dialog exceeds the option limit");
      }
      dialog.options = record.options.slice();
    }
    const timer = this.setTimer(() => { this.respond(task.taskId, record.id, { cancelled: true }).catch((error) => this.stopTask(task, "failed", error.message).catch(() => {})); }, duration);
    task.dialogs.set(record.id, { dialog, timer });
    await this.transition(task, this.restingState(task));
  }

  async respond(taskId, dialogId, response) {
    const task = this.tasks.get(taskId);
    if (task?.requests.has(dialogId)) throw new Error("Coordination requests require a coordination reply, not a dialog response");
    if (task && [...task.requests.values()].some((entry) => entry.nativeDialogId === dialogId)) throw new Error("Native coordination dialog IDs are private");
    const entry = task?.dialogs.get(dialogId);
    if (!entry || task.finishing || task.state.status !== "waiting_input") throw new Error("No matching pending RPC dialog");
    const dialog = entry.dialog;
    let answer;
    if (response.cancelled === true) answer = { cancelled: true };
    else if (dialog.method === "confirm" && typeof response.confirmed === "boolean") answer = { confirmed: response.confirmed };
    else if (dialog.method !== "confirm" && typeof response.value === "string" && response.value.length <= 65536) {
      if (dialog.method === "select" && !dialog.options?.includes(response.value)) throw new Error("Value is not an offered dialog option");
      answer = { value: response.value };
    } else throw new Error("Dialog response requires cancelled, confirmed, or value matching the pending method");
    this.clearTimer(entry.timer);
    task.dialogs.delete(dialogId);
    await task.transport.respond(dialogId, answer);
    await task.journal.append("fleet", { type: "dialog_responded", dialogId, cancelled: answer.cancelled === true });
    if (this.alive(task)) await this.transition(task, this.restingState(task));
    return this.publicTask(task);
  }

  async pending(taskId, options = {}) {
    const { after, limit } = normalizePendingOptions(options);
    this.validateTaskId(taskId);
    const task = this.tasks.get(taskId);
    if (task) {
      const reports = task.reports.filter((report) => report.seq > after).slice(0, limit);
      return {
        requests: this.publicRequests(task).slice(0, limit),
        reports,
        nextAfter: reports.length ? reports.at(-1).seq : after,
        droppedThrough: task.droppedThrough,
      };
    }
    const saved = await this.status(taskId);
    const all = Array.isArray(saved.reports) ? saved.reports : [];
    const reports = all.filter((report) => report.seq > after).slice(0, limit);
    return { requests: [], reports, nextAfter: reports.length ? reports.at(-1).seq : after, droppedThrough: saved.droppedReportsThrough ?? 0 };
  }

  reply(taskId, requestId, answer) {
    this.validateTaskId(taskId);
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error("No live task owns this task ID"));
    if (!this.alive(task)) return Promise.reject(new Error("Task is not accepting coordination replies"));
    const entry = task.requests.get(requestId);
    if (!entry) return Promise.reject(new Error("No matching pending coordination request"));
    let normalized;
    try { normalized = normalizeParentAnswer(answer); }
    catch (error) { return Promise.reject(error); }
    if (this.now() >= entry.request.expiresAt) {
      return (async () => {
        await this.expireRequest(task.taskId, requestId);
        throw new Error("Coordination request expired before the reply");
      })();
    }
    this.clearTimer(entry.timer);
    task.requests.delete(requestId);
    const nativeDialogId = entry.nativeDialogId;
    return (async () => {
      try { await task.transport.respond(nativeDialogId, normalized); }
      catch (error) {
        const message = `Coordination reply could not reach the RPC child: ${error.message}`;
        await this.stopTask(task, "failed", message).catch(() => {});
        throw new Error(message);
      }
      await task.journal.append("fleet", { type: "coordination_replied", requestId, cancelled: normalized.cancelled === true });
      if (this.alive(task)) await this.transition(task, this.restingState(task));
      return this.publicTask(task);
    })();
  }

  async steer(taskId, message) {
    this.validateTaskId(taskId);
    const text = normalizeCoordinationText(message, "steer message");
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("No live task owns this task ID");
    if (!task.accepted || !this.alive(task)) throw new Error("Native steer requires an accepted, live RPC task");
    const state = await task.transport.request("get_state");
    if (!this.alive(task)) throw new Error("Task stopped before the steer could be sent");
    if (state?.isStreaming !== true) throw new Error("RPC child is not streaming; native steer is unavailable");
    const receipt = await task.transport.request("steer", { message: text });
    if (!["handled", "queued"].includes(receipt?.disposition)) throw new Error("RPC steer response has no valid disposition");
    return { taskId, disposition: receipt.disposition };
  }

  async finalizeLease(task, state, persistenceError) {
    const lease = task.lease;
    if (!lease) return { none: true };
    if (task.attach) { try { await task.attach; } catch {} }
    try {
      if (task.attached || task.spawned) {
        if (task.spawned && !task.attached && task.childClosed !== true) return { retained: true, reason: "Process closure is unproven" };
        const outcome = await this.sessions.finalize(lease, { status: state.status, processClosed: task.childClosed === true, cleanupError: state.cleanupError, persistenceError });
        if (persistenceError) return { outcome: { ...outcome, sessionReusable: false }, retained: true, reason: persistenceError };
        return { outcome };
      }
      return { outcome: { sessionFile: lease.sessionFile, sessionReusable: false }, neverLaunched: true };
    } catch (error) {
      task.leaseError = error.message;
      return { retained: true, reason: error.message };
    }
  }

  applyLeaseOutcome(task, outcome) {
    if (!outcome) return;
    task.sessionFile = outcome.sessionFile;
    if (outcome.sessionId !== undefined) task.sessionId = outcome.sessionId;
    if (outcome.continuedFromTaskId !== undefined) task.continuedFromTaskId = outcome.continuedFromTaskId;
    task.sessionReusable = outcome.sessionReusable;
  }

  async releaseLease(task, state, postError) {
    const lease = task.lease;
    if (!lease) return;
    const retain = async (reason) => {
      if (reason) task.leaseError ??= reason;
      if (task.attached || task.spawned) {
        await this.sessions.finalize(lease, { status: state.status, processClosed: task.childClosed === true, cleanupError: state.cleanupError,
          persistenceError: reason ?? task.leaseError ?? "Terminal persistence is uncertain" }).catch(() => {});
      }
      task.sessionReusable = false;
      try { await task.journal?.snapshot(this.publicTask(task)); } catch {}
    };
    if (postError) { await retain(postError.message); return; }
    if (task.leaseRetained || !task.leaseOutcome) { await retain(undefined); return; }
    try {
      const outcome = task.leaseNeverLaunched ? await this.sessions.release(lease, { neverLaunched: true }) : await this.sessions.release(lease);
      this.applyLeaseOutcome(task, outcome);
    } catch (error) { await retain(error.message); }
  }

  cancel(taskId, reason = "User cancelled") {
    const task = this.tasks.get(taskId);
    if (!task) return this.status(taskId);
    if (task.stopPromise) return task.stopPromise;
    if (terminalTaskStates.has(task.state.status)) return Promise.resolve(this.publicTask(task));
    return this.stopTask(task, "cancelled", reason);
  }

  stopTask(task, outcome, reason) {
    if (task.stopPromise) return task.stopPromise;
    if (task.finishing || terminalTaskStates.has(task.state.status)) return task.done.promise;
    task.abort.abort(reason);
    const transition = this.transition(task, { status: "cancelling", outcome, reason });
    transition.catch(() => {});
    task.stopPromise = (async () => {
      let cleanupError;
      try { await task.initialization; } catch (error) { cleanupError = error.message; }
      try { await transition; } catch (error) { cleanupError = error.message; }
      for (const [id, entry] of task.dialogs) {
        this.clearTimer(entry.timer);
        try { Promise.resolve(task.transport?.respond(id, { cancelled: true })).catch(() => {}); } catch {}
      }
      task.dialogs.clear();
      for (const entry of task.requests.values()) {
        this.clearTimer(entry.timer);
        try { Promise.resolve(task.transport?.respond(entry.nativeDialogId, { cancelled: true })).catch(() => {}); } catch {}
      }
      task.requests.clear();
      try { await task.transport?.cancel(); } catch (error) { cleanupError = error.message; }
      const state = outcome === "failed" ? { status: "failed", error: reason } : { status: outcome, reason };
      if (cleanupError) state.cleanupError = cleanupError;
      return this.finish(task, state);
    })();
    return task.stopPromise;
  }

  finish(task, state) {
    if (task.finishPromise) return task.finishPromise;
    task.finishing = true;
    task.finishPromise = (async () => {
      this.clearTimer(task.timeout);
      for (const entry of task.dialogs.values()) this.clearTimer(entry.timer);
      task.dialogs.clear();
      for (const entry of task.requests.values()) this.clearTimer(entry.timer);
      task.requests.clear();
      try { await task.transport?.close(); task.childClosed = true; }
      catch (error) { task.childClosed = false; state.cleanupError = error.message; }
      task.currentTools.clear();
      task.template = undefined;
      task.finishedAt = this.now();
      assertTransition(task.state.status, state.status);
      task.state = state;
      const result = this.publicTask(task);
      const persistenceFailure = (error) => { task.persistenceError ??= error.message; };
      try { await task.initialization; } catch (error) { persistenceFailure(error); }
      if (task.journal) {
        try { await task.journal.append("fleet", { type: "task_result", task: result }); } catch (error) { persistenceFailure(error); }
        try { await task.journal.snapshot(result); } catch (error) { persistenceFailure(error); }
      }
      const finalized = await this.finalizeLease(task, state, task.persistenceError);
      if (finalized.outcome) this.applyLeaseOutcome(task, finalized.outcome);
      task.leaseRetained = finalized.retained === true;
      task.leaseNeverLaunched = finalized.neverLaunched === true;
      task.leaseOutcome = finalized.outcome !== undefined;
      const finalResult = this.publicTask(task);
      let postError;
      if (task.journal) {
        try { await task.journal.snapshot(finalResult); } catch (error) { postError = error; }
        try { await task.journal.append("fleet", { type: "task_terminal", status: state.status }); } catch (error) { postError ??= error; }
        try { await task.journal.close(); } catch (error) { postError ??= error; }
      }
      if (postError) persistenceFailure(postError);
      await this.releaseLease(task, state, postError);
      const settled = this.publicTask(task);
      task.done.resolve(settled);
      this.running.delete(task.taskId);
      this.queue = this.queue.filter((id) => id !== task.taskId);
      this.notify();
      this.evict();
      queueMicrotask(() => this.drain());
      return settled;
    })();
    return task.finishPromise;
  }

  settleTask(task) {
    if (task.state.status === "cancelling" || task.finishing) return Promise.resolve();
    if (task.retryError || task.assistant?.stopReason === "error") {
      return this.stopTask(task, "failed", task.retryError ?? task.assistant.errorMessage ?? "Provider runtime error");
    }
    if (task.assistant?.stopReason === "aborted") return this.stopTask(task, "cancelled", task.assistant.errorMessage ?? "RPC child aborted");
    if (!task.assistant || !["stop", "length", "toolUse"].includes(task.assistant.stopReason)) return this.stopTask(task, "failed", "RPC settled without a final assistant response");
    return this.finish(task, { status: "completed" });
  }

  evict() {
    const terminal = [...this.tasks.values()].filter((task) => terminalTaskStates.has(task.state.status));
    while (terminal.length > this.maxRetained) this.tasks.delete(terminal.shift().taskId);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownPromise = (async () => {
      await Promise.all([...this.tasks.values()].filter((task) => !terminalTaskStates.has(task.state.status)).map((task) => this.stopTask(task, "interrupted", "Main Pi session shut down")));
      this.listeners.clear();
    })();
    return this.shutdownPromise;
  }
}
