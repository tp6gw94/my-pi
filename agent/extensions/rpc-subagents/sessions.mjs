import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { abortError, nonempty, normalizeSessionReference, terminalTaskStates } from "./domain.mjs";
import { atomicJSON, isProcessAlive } from "./store.mjs";
import { LFDecoder } from "./transport.mjs";

function identity(value, name) {
  const result = normalizeSessionReference(value);
  if (isAbsolute(result)) throw new Error(`${name} must be a literal identity`);
  return result;
}
function selectedModel(value) {
  return { provider: nonempty(value?.provider, "model.provider", 160), id: nonempty(value?.id, "model.id", 512) };
}
function sameModel(a, b) { return a.provider === b.provider && a.id === b.id; }
function key(file) { return createHash("sha256").update(file).digest("hex"); }
function fileIdentity(info) { return { dev: String(info.dev), ino: String(info.ino) }; }
function sameFile(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function checkAbort(signal) { if (signal?.aborted) throw abortError(signal.reason); }
async function canonicalCwd(cwd) {
  const canonical = await realpath(nonempty(cwd, "cwd"));
  if (!(await stat(canonical)).isDirectory()) throw new Error("Session cwd must be an existing directory");
  return canonical;
}
async function readDocument(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular metadata file: ${file}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

// Pi session lines can embed resized images (up to 4.5 MiB base64 each), so the record bound stays generous but finite.
const SESSION_RECORD_BYTES = 64 * 1024 * 1024;

// Pi writes session JSONL with "\n" only; raw U+2028/U+2029 inside JSON strings are valid content, not line breaks.
async function* lfLines(stream, maxRecordBytes) {
  const decoder = new LFDecoder(maxRecordBytes);
  for await (const chunk of stream) {
    let lines;
    try { lines = decoder.push(chunk); }
    catch (error) { throw new Error("Managed session transcript record exceeds the byte limit", { cause: error }); }
    yield* lines;
  }
  try { decoder.finish(); }
  catch (error) { throw new Error("Managed session transcript ends with an incomplete LF-delimited record", { cause: error }); }
}

export class SessionRegistry {
  #paths;
  #owned = new Map();

  constructor({ root, ownerId, ownerPid = process.pid }) {
    this.root = resolve(nonempty(root, "fleet root"));
    this.ownerId = identity(ownerId, "ownerId");
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("ownerPid must be a positive integer");
    this.ownerPid = ownerPid;
  }

  async #directories() {
    this.#paths ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const root = await realpath(this.root);
      const paths = { root, tasks: join(root, "tasks"), catalog: join(root, "session-catalog"), leases: join(root, "session-leases") };
      for (const directory of [paths.tasks, paths.catalog, paths.leases]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (await realpath(directory) !== directory) throw new Error("Fleet session directories must not redirect outside their canonical layout");
      }
      return paths;
    })();
    return this.#paths;
  }

  #managedPath(file, paths) {
    const parts = relative(paths.tasks, file).split(sep);
    if (!isAbsolute(file) || parts.length !== 2 || parts[1] !== "session.jsonl" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(parts[0])) {
      throw new Error("Session file is not a fleet-managed session under the private fleet root");
    }
  }

  async #catalog(file, paths, optional = false) {
    this.#managedPath(file, paths);
    let value;
    try { value = await readDocument(join(paths.catalog, `${key(file)}.json`)); }
    catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
    if (value?.version !== 1 || value.canonicalPath !== file || !isAbsolute(value.cwd ?? "") || typeof value.sessionReusable !== "boolean" ||
        !["preparing", "running", ...terminalTaskStates].includes(value.status)) throw new Error("Invalid fleet session catalog metadata");
    identity(value.latestTaskId, "latestTaskId");
    selectedModel(value.model);
    if (value.sessionId !== undefined) identity(value.sessionId, "sessionId");
    if (value.sessionReusable && (value.status !== "completed" || !value.sessionId || !value.fileIdentity)) throw new Error("Invalid reusable session catalog metadata");
    return value;
  }

  async #resolve(reference, paths) {
    const normalized = normalizeSessionReference(reference);
    if (isAbsolute(normalized)) {
      let file;
      try { file = await realpath(normalized); }
      catch (error) { throw new Error("Unknown fleet-managed session file", { cause: error }); }
      this.#managedPath(file, paths);
      const metadata = await this.#catalog(file, paths, true);
      if (!metadata?.sessionId) throw new Error("Unknown fleet-managed session file");
      return metadata;
    }
    const matches = [];
    for (const name of await readdir(paths.catalog)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = await readDocument(join(paths.catalog, name));
      if (name !== `${key(value?.canonicalPath ?? "")}.json`) throw new Error("Invalid fleet session catalog identity");
      const metadata = await this.#catalog(value.canonicalPath, paths);
      if (metadata.sessionId === normalized) matches.push(metadata);
    }
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous fleet session ID" : "Unknown fleet session ID; use an exact reported ID or file");
    return matches[0];
  }

  async #owner(record) {
    const owner = await readDocument(join(record.leaseDirectory, "owner.json"));
    if (owner?.version !== 1 || owner.canonicalPath !== record.descriptor.sessionFile ||
        !Number.isInteger(owner.ownerPid) || owner.ownerPid <= 0 ||
        (owner.childPid !== undefined && (!Number.isInteger(owner.childPid) || owner.childPid <= 0))) throw new Error("Invalid session lease owner");
    identity(owner.token, "lease token");
    identity(owner.ownerId, "ownerId");
    identity(owner.taskId, "taskId");
    return owner;
  }

  async #blocked(record) {
    let owner;
    try { owner = await this.#owner(record); }
    catch { throw new Error(`Session lease is incomplete or invalid. Verify process closure and catalog before manual recovery of ${record.leaseDirectory}`); }
    const child = owner.childPid === undefined ? "" : `, child PID ${owner.childPid}`;
    const reason = owner.uncertainty ? "cleanup is uncertain" : isProcessAlive(owner.ownerPid) ? `has a live owner PID ${owner.ownerPid}` : `has a dead owner PID ${owner.ownerPid}, but closure and finalization are unproven`;
    throw new Error(`Session lease ${reason}${child}. Verify through its owner or inspect closure and catalog before manual recovery of ${record.leaseDirectory}`);
  }

  async #take(file, taskId, kind, paths) {
    const token = randomUUID();
    const descriptor = Object.freeze({ kind, taskId, sessionFile: file, token });
    const record = {
      descriptor, leaseDirectory: join(paths.leases, key(file)), catalogFile: join(paths.catalog, `${key(file)}.json`),
      owner: { version: 1, canonicalPath: file, token, ownerId: this.ownerId, ownerPid: this.ownerPid, taskId },
      tail: Promise.resolve(), launched: false, observed: false, finalized: false, clean: false, uncertain: false, catalogWritten: false,
    };
    try { await mkdir(record.leaseDirectory, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") return this.#blocked(record); throw error; }
    let handle;
    try {
      handle = await open(join(record.leaseDirectory, "owner.json"), "wx", 0o600);
      await handle.writeFile(JSON.stringify(record.owner) + "\n");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => {});
      throw new Error(`Session lease ownership persistence failed; lease retained. Verify ${record.leaseDirectory}`, { cause: error });
    }
    this.#owned.set(token, record);
    return record;
  }

  async #saveCatalog(record, metadata) {
    record.metadata = metadata;
    try {
      await atomicJSON(record.catalogFile, metadata);
      record.catalogWritten = true;
    } catch (error) {
      record.uncertain = true;
      record.clean = false;
      record.metadata.sessionReusable = false;
      record.owner.uncertainty = "Session catalog persistence failed";
      await atomicJSON(join(record.leaseDirectory, "owner.json"), record.owner).catch(() => {});
      throw new Error(`Session catalog persistence failed; lease retained. Verify ${record.leaseDirectory}`, { cause: error });
    }
  }

  async #retain(record, reason) {
    record.uncertain = true;
    record.clean = false;
    record.owner.uncertainty = String(reason);
    if (record.metadata) await this.#saveCatalog(record, { ...record.metadata, sessionReusable: false });
    try { await atomicJSON(join(record.leaseDirectory, "owner.json"), record.owner); }
    catch (error) { throw new Error(`Session cleanup persistence is uncertain; lease retained. Verify ${record.leaseDirectory}`, { cause: error }); }
  }

  #outcome(record, reusable = record.metadata?.sessionReusable === true) {
    const { sessionFile, sessionId, continuedFromTaskId } = record.descriptor;
    return { sessionFile, ...(sessionId === undefined ? {} : { sessionId }), ...(continuedFromTaskId === undefined ? {} : { continuedFromTaskId }), sessionReusable: reusable };
  }

  #withLease(lease, action) {
    const record = this.#owned.get(lease?.token);
    if (!record || lease.taskId !== record.descriptor.taskId || lease.sessionFile !== record.descriptor.sessionFile) return Promise.reject(new Error("Session lease token or ownership does not match"));
    const operation = record.tail.then(async () => {
      if (!this.#owned.has(lease.token)) throw new Error("Session lease ownership was already released");
      let owner;
      try { owner = await this.#owner(record); }
      catch (error) { throw new Error("Session lease ownership cannot be verified", { cause: error }); }
      if (owner.token !== lease.token || owner.ownerId !== this.ownerId || owner.taskId !== lease.taskId) throw new Error("Session lease ownership changed; refusing another owner's token");
      return action(record);
    });
    record.tail = operation.catch(() => {});
    return operation;
  }

  async #inspect(record, expectedId) {
    const file = record.descriptor.sessionFile;
    if (await realpath(file) !== file) throw new Error("Session canonical file identity changed");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const fingerprint = fileIdentity(info);
      if (!info.isFile() || info.nlink !== 1 || (record.metadata.fileIdentity && !sameFile(fingerprint, record.metadata.fileIdentity))) throw new Error("Session file identity changed or has hard-link aliases");
      const input = handle.createReadStream({ autoClose: false });
      let header;
      const messageModels = new Map();
      const thinkingModel = (content, source) => {
        if (Array.isArray(content) && content.some((block) => ["thinking", "redacted_thinking"].includes(block?.type)) &&
            (!source || source.provider !== record.metadata.model.provider || source.model !== record.metadata.model.id)) throw new Error("Retained thinking must use the same selected provider/model");
      };
      try {
        for await (const line of lfLines(input, SESSION_RECORD_BYTES)) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (!header) {
            header = entry;
            if (header?.type !== "session" || header.version !== 3) throw new Error("Invalid managed session header");
            identity(header.id, "session header ID");
            if (expectedId !== undefined && header.id !== expectedId) throw new Error("Session header ID does not match the catalog or reported session ID");
            if (await canonicalCwd(header.cwd) !== record.metadata.cwd) throw new Error("Session header must use the same cwd");
          } else if (entry?.type === "message") {
            messageModels.set(entry.id, { provider: entry.message?.provider, model: entry.message?.model });
            thinkingModel(entry.message?.content, entry.message);
          } else if (entry?.type === "context_edit" && entry.replacement !== null) {
            thinkingModel(entry.replacement?.content, messageModels.get(entry.targetId));
          }
        }
      } finally { input.destroy(); }
      if (!header) throw new Error("Missing managed session header");
      if (await realpath(file) !== file || !sameFile(fingerprint, fileIdentity(await stat(file)))) throw new Error("Session file identity changed during validation");
      return { sessionId: header.id, fileIdentity: fingerprint };
    } finally { await handle.close(); }
  }

  async acquireFresh({ taskId, directory, cwd, model, signal }) {
    checkAbort(signal);
    taskId = identity(taskId, "taskId");
    const paths = await this.#directories();
    const taskDirectory = join(paths.tasks, taskId);
    const requested = resolve(nonempty(directory, "task directory"));
    if (await realpath(dirname(requested)) !== paths.tasks || basename(requested) !== taskId) throw new Error("Fresh session must use its new task directory under the private fleet root");
    await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
    if (await realpath(taskDirectory) !== taskDirectory) throw new Error("Fresh task directory must be canonical");
    const canonical = await canonicalCwd(cwd);
    const selected = selectedModel(model);
    checkAbort(signal);
    const file = join(taskDirectory, "session.jsonl");
    const record = await this.#take(file, taskId, "fresh", paths);
    try {
      record.previous = await this.#catalog(file, paths, true);
      if (record.previous) throw new Error("Fresh session path was already cataloged");
      try { await lstat(file); throw new Error("Fresh session file already exists; runtime must create it exclusively"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      checkAbort(signal);
      await this.#saveCatalog(record, { version: 1, canonicalPath: file, cwd: canonical, model: selected, latestTaskId: taskId, status: "preparing", sessionReusable: false });
      checkAbort(signal);
      return record.descriptor;
    } catch (error) {
      if (!record.uncertain) await this.release(record.descriptor, { neverLaunched: true });
      throw error;
    }
  }

  async acquireResume({ taskId, session, cwd, model, signal }) {
    checkAbort(signal);
    taskId = identity(taskId, "taskId");
    const paths = await this.#directories();
    const canonical = await canonicalCwd(cwd);
    const selected = selectedModel(model);
    const resolved = await this.#resolve(session, paths);
    checkAbort(signal);
    const record = await this.#take(resolved.canonicalPath, taskId, "resume", paths);
    try {
      const previous = await this.#catalog(resolved.canonicalPath, paths);
      record.previous = previous;
      record.metadata = previous;
      if (previous.sessionId !== resolved.sessionId) throw new Error("Session catalog identity changed during acquisition");
      if (previous.status !== "completed" || previous.sessionReusable !== true) throw new Error("Resume requires the latest writer to be completed and reusable");
      if (previous.latestTaskId === taskId) throw new Error("Resume requires a new task ID");
      if (previous.cwd !== canonical) throw new Error("Resume requires the same canonical cwd");
      if (!sameModel(previous.model, selected)) throw new Error("Resume requires the same selected provider/model");
      await this.#inspect(record, previous.sessionId);
      checkAbort(signal);
      record.descriptor = Object.freeze({ ...record.descriptor, sessionId: previous.sessionId, continuedFromTaskId: previous.latestTaskId });
      await this.#saveCatalog(record, { ...previous, latestTaskId: taskId, continuedFromTaskId: previous.latestTaskId, status: "preparing", sessionReusable: false });
      checkAbort(signal);
      return record.descriptor;
    } catch (error) {
      if (!record.uncertain) await this.release(record.descriptor, { neverLaunched: true });
      throw error;
    }
  }

  attach(lease, { childPid }) {
    return this.#withLease(lease, async (record) => {
      if (!Number.isInteger(childPid) || childPid <= 0) throw new Error("childPid must be a positive integer");
      if (record.launched || record.finalized || record.uncertain) throw new Error("Session child was already attached or finalized");
      record.launched = true;
      record.owner.childPid = childPid;
      try { await atomicJSON(join(record.leaseDirectory, "owner.json"), record.owner); }
      catch (error) { await this.#retain(record, "Child PID persistence failed"); throw error; }
    });
  }

  observe(lease, { sessionId, sessionFile, model }) {
    return this.#withLease(lease, async (record) => {
      if (!record.launched || record.finalized || record.uncertain) throw new Error("Observe requires an attached, nonterminal session child");
      sessionId = identity(sessionId, "reported session ID");
      if (!sameModel(selectedModel(model), record.metadata.model)) throw new Error("Reported session model does not match the selected model");
      let actual;
      try { actual = await realpath(normalizeSessionReference(sessionFile)); }
      catch (error) { throw new Error("Reported session file does not match the leased file", { cause: error }); }
      if (actual !== record.descriptor.sessionFile) throw new Error("Reported session file does not match the leased file");
      if (record.descriptor.sessionId !== undefined && record.descriptor.sessionId !== sessionId) throw new Error("Reported session ID does not match the leased session ID");
      const inspected = await this.#inspect(record, sessionId);
      record.descriptor = Object.freeze({ ...record.descriptor, sessionId });
      await this.#saveCatalog(record, { ...record.metadata, ...inspected, status: "running", sessionReusable: false });
      record.observed = true;
      return record.descriptor;
    });
  }

  finalize(lease, { status, processClosed, cleanupError, persistenceError }) {
    return this.#withLease(lease, async (record) => {
      if (!terminalTaskStates.has(status)) throw new Error("Session finalization requires a terminal task status");
      record.finalized = true;
      record.clean = processClosed === true && !cleanupError && !persistenceError && !record.uncertain;
      const reusable = record.clean && record.observed && status === "completed";
      if (reusable) {
        try { await this.#inspect(record, record.descriptor.sessionId); }
        catch (error) { await this.#retain(record, `Final session validation failed: ${error.message}`); throw error; }
      }
      await this.#saveCatalog(record, { ...record.metadata, status, sessionReusable: reusable });
      if (!record.clean) await this.#retain(record, cleanupError || persistenceError || "Process closure or finalization is uncertain");
      return this.#outcome(record);
    });
  }

  release(lease, { neverLaunched = false } = {}) {
    return this.#withLease(lease, async (record) => {
      if (record.uncertain) throw new Error(`Session cleanup is uncertain; lease retained. Verify ${record.leaseDirectory}`);
      if (neverLaunched && record.launched) throw new Error("Session child was launched; positive closure and finalization are required");
      if (neverLaunched) {
        if (record.catalogWritten) await this.#saveCatalog(record, record.previous ?? { ...record.metadata, status: "cancelled", sessionReusable: false });
      } else if (!record.finalized || !record.clean) throw new Error("Release requires finalization and positively observed process closure");
      const result = this.#outcome(record, neverLaunched ? false : record.metadata?.sessionReusable === true);
      try {
        await unlink(join(record.leaseDirectory, "owner.json"));
        await rmdir(record.leaseDirectory);
      } catch (error) {
        await this.#retain(record, `Lease removal failed: ${error.message}`);
        throw new Error(`Session cleanup is uncertain; lease retained. Verify ${record.leaseDirectory}`, { cause: error });
      }
      this.#owned.delete(record.descriptor.token);
      return result;
    });
  }
}
