import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBranch, writeChildSession } from "../snapshot.mjs";

const target = { provider: "test", id: "model" };
const entry = (id, type, fields = {}) => ({ id, parentId: null, timestamp: "2026-01-01T00:00:00Z", type, ...fields });
const assistant = (id, content) => entry(id, "message", { message: { role: "assistant", provider: "test", model: "model", content, stopReason: "stop" } });
const tool = (id, call) => entry(id, "message", { message: { role: "toolResult", toolCallId: call, content: [{ type: "text", text: "done" }] } });
const manager = (branch) => ({ getBranch: () => branch, getSessionFile: () => "/parent/session.jsonl" });

test("fork keeps completed history and compaction/context_edit provenance, but drops the launching incomplete round", () => {
  const branch = [
    entry("u1", "message", { message: { role: "user", content: "first" } }),
    assistant("a1", [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }]),
    tool("r1", "old-call"),
    entry("compaction", "compaction", { firstKeptEntryId: "a1", summary: "summary", tokensBefore: 50 }),
    entry("edit", "context_edit", { targetId: "r1", replacement: { content: [{ type: "text", text: "edited output" }] } }),
    assistant("a2", [{ type: "text", text: "completed" }]),
    entry("u2", "message", { message: { role: "user", content: "launch a fork" } }),
    assistant("launcher", [{ type: "text", text: "must not leak" }, { type: "toolCall", id: "fleet", name: "rpc_subagents_run", arguments: {} }, { type: "toolCall", id: "sibling", name: "read", arguments: {} }]),
    tool("sibling-result", "sibling"),
  ];
  const original = structuredClone(branch);
  const snapshot = captureBranch(manager(branch), target);
  assert.deepEqual(snapshot.entries.map((value) => value.id), ["u1", "a1", "r1", "compaction", "edit", "a2", "u2"]);
  assert.equal(snapshot.entries[3].firstKeptEntryId, "a1");
  assert.deepEqual(snapshot.entries[4].replacement, { content: [{ type: "text", text: "edited output" }] });
  assert.equal(snapshot.droppedEntries, 2);
  assert.equal(JSON.stringify(snapshot).includes("must not leak"), false);
  assert.deepEqual(branch, original);
  snapshot.entries[0].message.content = "changed child";
  assert.equal(branch[0].message.content, "first");
  for (let index = 0; index < snapshot.entries.length; index++) assert.equal(snapshot.entries[index].parentId, index === 0 ? null : snapshot.entries[index - 1].id);
});

test("orphan results are removed and parent links plus compaction retained ID stay valid", () => {
  const branch = [tool("orphan", "never-called"), entry("u", "message", { message: { role: "user", content: "kept" } }), entry("compact", "compaction", { firstKeptEntryId: "orphan", summary: "prior", tokensBefore: 9 })];
  const snapshot = captureBranch(manager(branch), target);
  assert.deepEqual(snapshot.entries.map((value) => [value.id, value.parentId]), [["u", null], ["compact", "u"]]);
  assert.equal(snapshot.entries[1].firstKeptEntryId, "u");
  assert.equal(snapshot.droppedEntries, 1);
});

test("signed/redacted thinking is stripped from raw assistants and context_edit replacements", () => {
  const unsafe = [{ type: "thinking", thinking: "signed", thinkingSignature: "private" }, { type: "redacted_thinking", data: "encrypted" }, { type: "thinking", thinking: "plain" }, { type: "text", text: "visible", textSignature: "opaque" }];
  const branch = [assistant("a", unsafe), entry("e", "context_edit", { targetId: "a", replacement: { content: unsafe } })];
  const sameModel = captureBranch(manager(branch), target);
  assert.deepEqual(sameModel.entries[0].message.content, [{ type: "thinking", thinking: "plain" }, { type: "text", text: "visible" }]);
  assert.deepEqual(sameModel.entries[1].replacement.content, [{ type: "thinking", thinking: "plain" }, { type: "text", text: "visible" }]);
  const switched = captureBranch(manager(branch), { provider: "other", id: "model" });
  assert.deepEqual(switched.entries[0].message.content, [{ type: "text", text: "visible" }]);
  assert.deepEqual(switched.entries[1].replacement.content, [{ type: "text", text: "visible" }]);
});

test("context edits cannot inject an incomplete tool call into a child", () => {
  const branch = [assistant("a", [{ type: "text", text: "completed" }]), entry("e", "context_edit", { targetId: "a", replacement: { content: [{ type: "toolCall", id: "injected", name: "bash", arguments: {} }] } })];
  const snapshot = captureBranch(manager(branch), target);
  assert.deepEqual(snapshot.entries.map((value) => value.id), ["a", "e"]);
  assert.equal(snapshot.entries[0].message.content[0].text, "completed");
  assert.deepEqual(snapshot.entries[1].replacement.content, []);
});

test("each fork file has a unique v3 header, parent reference, and independent mutable history; fresh has no parent data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rpc-subagents-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const branch = [assistant("a", [{ type: "text", text: "captured" }])];
  const template = captureBranch(manager(branch), target);
  branch[0].message.content[0].text = "parent changed after invocation";
  const first = join(directory, "one.jsonl"); const second = join(directory, "two.jsonl"); const fresh = join(directory, "fresh.jsonl");
  await writeChildSession(first, { cwd: "/project", template });
  await writeChildSession(second, { cwd: "/project", template });
  await writeChildSession(fresh, { cwd: "/project" });
  const parse = async (path) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  const a = await parse(first); const b = await parse(second); const c = await parse(fresh);
  assert.equal(a[0].version, 3); assert.notEqual(a[0].id, b[0].id);
  assert.equal(a[0].parentSession, "/parent/session.jsonl");
  assert.equal(a[1].message.content[0].text, "captured");
  assert.equal(b[1].message.content[0].text, "captured");
  assert.deepEqual(Object.keys(c[0]).sort(), ["cwd", "id", "timestamp", "type", "version"]); assert.equal(c.length, 1);
  await assert.rejects(writeChildSession(first, { cwd: "/project", template }), { code: "EEXIST" });
});
