import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../sessions.mjs";

const model = { provider: "test-provider", id: "test-model" };
const moduleURL = new URL("../sessions.mjs", import.meta.url).href;

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "rpc-subagents-sessions-"));
  const root = join(temporary, "fleet");
  const cwd = join(temporary, "project");
  await mkdir(cwd);
  const children = new Set();
  t.after(async () => {
    for (const child of children) await closeChild(child);
    await rm(temporary, { recursive: true, force: true });
  });
  function registry(ownerId = "owner-one") { return new SessionRegistry({ root, ownerId }); }
  function fresh(taskId = "task-one", selected = model) {
    return { taskId, directory: join(root, "tasks", taskId), cwd, model: selected };
  }
  async function child() {
    const process = spawn(globalThis.process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.add(process);
    await once(process, "spawn");
    return process;
  }
  async function writeSession(lease, sessionId = "session-one", entries = [], headerCwd = cwd) {
    const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: headerCwd };
    await writeFile(lease.sessionFile, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  }
  async function completed(taskId = "task-one", sessionId = "session-one") {
    const owner = registry();
    const lease = await owner.acquireFresh(fresh(taskId));
    await writeSession(lease, sessionId);
    const process = await child();
    await owner.attach(lease, { childPid: process.pid });
    await owner.observe(lease, { sessionId, sessionFile: lease.sessionFile, model });
    await closeChild(process);
    const result = await owner.finalize(lease, { status: "completed", processClosed: true });
    assert.equal(result.sessionReusable, true);
    await owner.release(lease);
    return lease.sessionFile;
  }
  return { temporary, root, cwd, children, registry, fresh, child, writeSession, completed };
}

async function closeChild(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill(signal);
  await closed;
}

function remoteOwner(f, session) {
  const script = `
    import { SessionRegistry } from ${JSON.stringify(moduleURL)};
    const registry = new SessionRegistry({ root: ${JSON.stringify(f.root)}, ownerId: "remote-owner" });
    const lease = await registry.acquireResume({ taskId: "remote-task", session: ${JSON.stringify(session)}, cwd: ${JSON.stringify(f.cwd)}, model: ${JSON.stringify(model)} });
    process.on("message", async (message) => {
      if (message === "release") {
        await registry.release(lease, { neverLaunched: true });
        process.send({ released: true }, () => process.exit(0));
      }
    });
    process.send({ sessionFile: lease.sessionFile });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  f.children.add(child);
  return child;
}

async function ready(child) {
  return Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`Lease worker exited before ready: ${code}`); }),
  ]);
}

test("fresh acquisition leases the prospective file without creating a session", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  assert.equal(lease.kind, "fresh");
  assert.equal(lease.sessionFile, join(await realpath(f.root), "tasks", "task-one", "session.jsonl"));
  await assert.rejects(lstat(lease.sessionFile), { code: "ENOENT" });
  await assert.rejects(f.registry("owner-two").acquireFresh(f.fresh()), /lease.*live/i);
  await registry.release(lease, { neverLaunched: true });
  await assert.rejects(f.registry("owner-two").acquireResume({ taskId: "task-two", session: lease.sessionFile, cwd: f.cwd, model }), /unknown|not.*managed/i);
});

test("continuation appends to the same file and keeps the original session identity", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const original = await readFile(file, "utf8");
  const identity = await stat(file);
  const registry = f.registry("owner-two");
  const lease = await registry.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model });
  assert.deepEqual({ kind: lease.kind, sessionFile: lease.sessionFile, sessionId: lease.sessionId, continuedFromTaskId: lease.continuedFromTaskId }, {
    kind: "resume", sessionFile: file, sessionId: "session-one", continuedFromTaskId: "task-one",
  });
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  await registry.observe(lease, { sessionId: "session-one", sessionFile: file, model });
  const entry = { type: "message", id: "reply-two", message: { role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text: "continued" }] } };
  await appendFile(file, JSON.stringify(entry) + "\n");
  await closeChild(child);
  assert.deepEqual(await registry.finalize(lease, { status: "completed", processClosed: true }), {
    sessionFile: file, sessionId: "session-one", continuedFromTaskId: "task-one", sessionReusable: true,
  });
  await registry.release(lease);
  assert.equal(await readFile(file, "utf8"), original + JSON.stringify(entry) + "\n");
  assert.equal((await stat(file)).ino, identity.ino);
  const next = await registry.acquireResume({ taskId: "task-three", session: file, cwd: f.cwd, model });
  assert.equal(next.continuedFromTaskId, "task-two");
  await registry.release(next, { neverLaunched: true });
});

test("catalog keeps independent sessions and resolves only exact reported identities", async (t) => {
  const f = await fixture(t);
  const first = await f.completed();
  const second = await f.completed("other-task", "other-session");
  const registry = f.registry();
  await assert.rejects(registry.acquireResume({ taskId: "task-two", session: "session", cwd: f.cwd, model }), /unknown/i);
  const a = await registry.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model });
  const b = await registry.acquireResume({ taskId: "other-next", session: "other-session", cwd: f.cwd, model });
  assert.deepEqual([a.sessionFile, b.sessionFile], [first, second]);
  await registry.release(a, { neverLaunched: true });
  await registry.release(b, { neverLaunched: true });
});

test("session and cwd symlink aliases share one canonical lease", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const alias = join(f.temporary, "alias.jsonl");
  const cwdAlias = join(f.temporary, "project-alias");
  await symlink(file, alias);
  await symlink(f.cwd, cwdAlias);
  const registry = f.registry();
  const lease = await registry.acquireResume({ taskId: "task-two", session: alias, cwd: cwdAlias, model });
  assert.equal(lease.sessionFile, file);
  await assert.rejects(f.registry("owner-two").acquireResume({ taskId: "task-three", session: "session-one", cwd: f.cwd, model }), /lease.*live/i);
  await registry.release(lease, { neverLaunched: true });
});

test("resume rejects changed model, cwd, or reuse of the latest writer task ID", async (t) => {
  const f = await fixture(t);
  await f.completed();
  const registry = f.registry();
  const resume = { taskId: "task-two", session: "session-one", cwd: f.cwd, model };
  await assert.rejects(registry.acquireResume({ ...resume, model: { ...model, id: "different-model" } }), /same.*model/i);
  await assert.rejects(registry.acquireResume({ ...resume, cwd: f.temporary }), /same.*cwd/i);
  await assert.rejects(registry.acquireResume({ ...resume, taskId: "task-one" }), /new task ID/i);
  const lease = await registry.acquireResume(resume);
  assert.equal(lease.sessionId, "session-one");
  await registry.release(lease, { neverLaunched: true });
});

test("unknown external files are rejected before their contents are read", async (t) => {
  const f = await fixture(t);
  const external = join(f.temporary, "external.jsonl");
  await writeFile(external, "not valid JSON");
  await assert.rejects(f.registry().acquireResume({ taskId: "task-one", session: external, cwd: f.cwd, model }), /not.*fleet-managed/i);
  assert.equal(await readFile(external, "utf8"), "not valid JSON");
});

test("header, inode replacement, and cross-model thinking fail closed while leased", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const registry = f.registry();
  const resume = { taskId: "task-two", session: "session-one", cwd: f.cwd, model };
  const original = await readFile(file, "utf8");
  const wrongHeader = JSON.parse(original.trim());
  wrongHeader.id = "wrong-session";
  await writeFile(file, JSON.stringify(wrongHeader) + "\n");
  await assert.rejects(registry.acquireResume(resume), /header.*ID/i);
  await writeFile(file, original);
  const thinking = { type: "message", id: "old-thinking", message: { role: "assistant", provider: "other-provider", model: model.id, content: [{ type: "thinking", thinking: "private reasoning" }] } };
  await appendFile(file, JSON.stringify(thinking) + "\n");
  await assert.rejects(registry.acquireResume(resume), /thinking.*model/i);
  await writeFile(file, original);
  const lease = await registry.acquireResume(resume);
  assert.equal(lease.sessionId, "session-one");
  await registry.release(lease, { neverLaunched: true });
  await rename(file, `${file}.original`);
  await writeFile(file, original);
  await assert.rejects(registry.acquireResume(resume), /file identity/i);
});

test("session inspection frames lines by LF only and tolerates split UTF-8 chunks", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const header = { type: "session", version: 3, id: "session-one", timestamp: "2026-01-01T00:00:00.000Z", cwd: f.cwd };
  const separator = { type: "message", id: "separators", message: { role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text: "a\u2028b\u2029c\ud83d\ude00" }] } };
  const long = '{"type":"message","id":"chunk-boundary","message":{"role":"assistant","provider":"test-provider","model":"test-model","content":[{"type":"text","text":"';
  const splitByte = 64 * 1024 - 1;
  const prefixBytes = Buffer.byteLength(JSON.stringify(header)) + 1 + Buffer.byteLength(JSON.stringify(separator)) + 1 + Buffer.byteLength(long);
  assert.ok(prefixBytes < splitByte, "fixture prefix must stay ahead of the read chunk boundary");
  const longEntry = long + "x".repeat(splitByte - prefixBytes) + "\u7e41\u2028\u9ad4\u2029\ud83d\ude00" + '"}]}}';
  await writeFile(file, [JSON.stringify(header), JSON.stringify(separator), longEntry].join("\n") + "\n");
  const chunks = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk);
  assert.equal(chunks[0].length, 64 * 1024, "fixture must fill the first read chunk");
  assert.ok(chunks[0][chunks[0].length - 1] >= 0x80, "fixture must split a UTF-8 sequence at the read chunk boundary");
  const registry = f.registry();
  const lease = await registry.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model });
  assert.equal(lease.sessionId, "session-one");
  await registry.release(lease, { neverLaunched: true });
  const hidden = { type: "message", id: "hidden-thinking", message: { role: "assistant", provider: "other-provider", model: model.id, content: [{ type: "thinking", thinking: "before\u2028after" }] } };
  await writeFile(file, [JSON.stringify(header), JSON.stringify(hidden)].join("\n") + "\n");
  await assert.rejects(registry.acquireResume({ taskId: "task-three", session: "session-one", cwd: f.cwd, model }), /thinking.*model/i);
});

test("observe requires the actual session ID, file and selected model", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  await f.writeSession(lease);
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  const state = { sessionId: "session-one", sessionFile: lease.sessionFile, model };
  await assert.rejects(registry.observe(lease, { ...state, sessionId: "wrong-session" }), /session ID/i);
  await assert.rejects(registry.observe(lease, { ...state, sessionFile: join(f.temporary, "absent.jsonl") }), /session file/i);
  await assert.rejects(registry.observe(lease, { ...state, model: { ...model, provider: "other-provider" } }), /model/i);
  const observed = await registry.observe(lease, state);
  assert.equal(observed.sessionId, "session-one");
  await closeChild(child);
  assert.equal((await registry.finalize(lease, { status: "completed", processClosed: true })).sessionReusable, true);
  await registry.release(lease);
});

test("release requires a matching token and finalized, positively closed process", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  await f.writeSession(lease);
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  await registry.observe(lease, { sessionId: "session-one", sessionFile: lease.sessionFile, model });
  await assert.rejects(registry.release({ ...lease, token: "wrong-token" }), /token|ownership/i);
  await assert.rejects(registry.release(lease), /finaliz|closure/i);
  await assert.rejects(registry.release(lease, { neverLaunched: true }), /launched/i);
  await closeChild(child);
  const result = await registry.finalize(lease, { status: "completed", processClosed: true });
  assert.equal(result.sessionReusable, true);
  await assert.rejects(f.registry("owner-two").acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model }), /lease.*live/i);
  await registry.release(lease);
  const nextOwner = f.registry("owner-two");
  const resumed = await nextOwner.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model });
  assert.equal(resumed.sessionId, "session-one");
  await assert.rejects(f.registry("owner-three").acquireResume({ taskId: "task-three", session: "session-one", cwd: f.cwd, model }), /lease.*live/i);
  await nextOwner.release(resumed, { neverLaunched: true });
});

test("failed writers and completed but unobserved sessions are not reusable", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  await f.writeSession(lease);
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  await registry.observe(lease, { sessionId: "session-one", sessionFile: lease.sessionFile, model });
  await closeChild(child);
  assert.equal((await registry.finalize(lease, { status: "failed", processClosed: true })).sessionReusable, false);
  await registry.release(lease);
  await assert.rejects(registry.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model }), /completed.*reusable/i);
  const unobserved = await registry.acquireFresh(f.fresh("unobserved-task"));
  await f.writeSession(unobserved, "unobserved-session");
  const other = await f.child();
  await registry.attach(unobserved, { childPid: other.pid });
  await closeChild(other);
  assert.equal((await registry.finalize(unobserved, { status: "completed", processClosed: true })).sessionReusable, false);
  await registry.release(unobserved);
});

test("never-launched resume cancellation restores the prior completed writer", async (t) => {
  const f = await fixture(t);
  await f.completed();
  const registry = f.registry();
  const lease = await registry.acquireResume({ taskId: "cancelled-preparation", session: "session-one", cwd: f.cwd, model });
  await registry.release(lease, { neverLaunched: true });
  const next = await registry.acquireResume({ taskId: "next-task", session: "session-one", cwd: f.cwd, model });
  assert.equal(next.continuedFromTaskId, "task-one");
  await registry.release(next, { neverLaunched: true });
});

test("abort before or during prospective acquisition leaves no late lease", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const cancelled = new AbortController();
  cancelled.abort("cancelled before acquire");
  await assert.rejects(registry.acquireFresh({ ...f.fresh(), signal: cancelled.signal }), { name: "AbortError" });
  const seed = await registry.acquireFresh(f.fresh("seed-task"));
  await registry.release(seed, { neverLaunched: true });
  const canonicalFile = join(await realpath(f.root), "tasks", "task-one", "session.jsonl");
  const key = createHash("sha256").update(canonicalFile).digest("hex");
  const signal = {
    get aborted() { return existsSync(join(f.root, "session-leases", key, "owner.json")); },
    reason: "cancelled during acquire",
  };
  await assert.rejects(registry.acquireFresh({ ...f.fresh(), signal }), { name: "AbortError" });
  await assert.rejects(lstat(canonicalFile), { code: "ENOENT" });
  const next = await registry.acquireFresh(f.fresh("next-task"));
  assert.equal(next.kind, "fresh");
  await registry.release(next, { neverLaunched: true });
  assert.deepEqual(await readdir(join(f.root, "session-leases")), []);
});

test("uncertain closure or terminal persistence retains the lease and reports unreusable", async (t) => {
  const f = await fixture(t);
  await f.completed();
  const registry = f.registry();
  const lease = await registry.acquireResume({ taskId: "task-two", session: "session-one", cwd: f.cwd, model });
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  await registry.observe(lease, { sessionId: "session-one", sessionFile: lease.sessionFile, model });
  const uncertain = await registry.finalize(lease, { status: "completed", processClosed: false, cleanupError: "No close event" });
  assert.equal(uncertain.sessionReusable, false);
  await assert.rejects(registry.release(lease), /uncertain.*retained/i);
  await closeChild(child);
  const later = await registry.finalize(lease, { status: "completed", processClosed: true, persistenceError: "Terminal snapshot failed" });
  assert.equal(later.sessionReusable, false);
  await assert.rejects(f.registry("owner-two").acquireResume({ taskId: "task-three", session: "session-one", cwd: f.cwd, model }), /uncertain.*verify/i);
});

test("catalog write failure never releases ownership", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  await f.writeSession(lease);
  const child = await f.child();
  await registry.attach(lease, { childPid: child.pid });
  await registry.observe(lease, { sessionId: "session-one", sessionFile: lease.sessionFile, model });
  await closeChild(child);
  const catalog = join(f.root, "session-catalog");
  const [name] = (await readdir(catalog)).filter((name) => name.endsWith(".json"));
  await rename(join(catalog, name), join(catalog, `${name}.backup`));
  await mkdir(join(catalog, name));
  await assert.rejects(registry.finalize(lease, { status: "completed", processClosed: true }), /persistence.*lease retained/i);
  await assert.rejects(registry.release(lease), /uncertain.*retained/i);
  await assert.rejects(f.registry("owner-two").acquireFresh(f.fresh()), /lease.*uncertain/i);
});

test("incomplete leases block instead of guessing stale ownership", async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  const lease = await registry.acquireFresh(f.fresh());
  await rm(join(f.root, "session-leases", createHash("sha256").update(lease.sessionFile).digest("hex"), "owner.json"));
  await assert.rejects(f.registry("owner-two").acquireFresh(f.fresh()), /incomplete.*verify/i);
  await assert.rejects(registry.release(lease, { neverLaunched: true }), /ownership/i);
});

test("a separate Fleet process excludes canonical aliases until its token is released", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const remote = remoteOwner(f, "session-one");
  assert.deepEqual(await ready(remote), { sessionFile: file });
  const alias = join(f.temporary, "cross-process-alias.jsonl");
  await symlink(file, alias);
  const registry = f.registry();
  const resume = { taskId: "parent-task", session: alias, cwd: f.cwd, model };
  await assert.rejects(registry.acquireResume(resume), /lease.*live/i);
  const released = once(remote, "message");
  const closed = once(remote, "close");
  remote.send("release");
  assert.deepEqual((await released)[0], { released: true });
  await closed;
  const lease = await registry.acquireResume(resume);
  assert.equal(lease.continuedFromTaskId, "task-one");
  await registry.release(lease, { neverLaunched: true });
});

test("a dead lease owner is not sufficient authority to steal the session", async (t) => {
  const f = await fixture(t);
  const file = await f.completed();
  const remote = remoteOwner(f, file);
  assert.deepEqual(await ready(remote), { sessionFile: file });
  await closeChild(remote, "SIGKILL");
  await assert.rejects(f.registry().acquireResume({ taskId: "parent-task", session: "session-one", cwd: f.cwd, model }), /dead owner.*verify/i);
  assert.equal((await readdir(join(f.root, "session-leases"))).length, 1);
});
