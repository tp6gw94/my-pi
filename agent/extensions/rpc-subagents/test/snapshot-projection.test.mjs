import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { captureBranch } from "../snapshot.mjs";

const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const core = packageDir ? await import(pathToFileURL(join(packageDir, "dist/core/session-manager.js")).href) : undefined;
const options = { skip: !core && "Set RPC_SUBAGENTS_PI_PACKAGE to check actual Pi context projection" };
const entry = (id, type, fields = {}) => ({ id, parentId: null, timestamp: "2026-01-01T00:00:00Z", type, ...fields });
const user = (id) => entry(id, "message", { message: { role: "user", content: id } });
const call = (id) => ({ type: "toolCall", id, name: "read", arguments: {} });
const assistant = (id, content, stopReason = "stop") => entry(id, "message", { message: { role: "assistant", provider: "test", model: "model", content, stopReason } });
const edit = (id, targetId, replacement) => entry(id, "context_edit", { targetId, replacement });
const capture = (entries) => captureBranch({ getBranch: () => entries, getSessionFile: () => "/parent" }, { provider: "test", id: "model" }, core.buildSessionProjection);
const unresolved = (entries) => {
  const messages = core.buildSessionContext(entries).messages;
  const results = new Set(messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
  return messages.filter((message) => message.role === "assistant").flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === "toolCall" && !results.has(block.id));
};

test("actual Pi projection preserves later dialogue after aborted/error historical missing results", options, () => {
  for (const reason of ["aborted", "error"]) {
    const branch = [user("old"), assistant("broken", [{ type: "text", text: "partial" }, call("missing")], reason), user("later"), assistant("answer", [{ type: "text", text: "valid answer" }])];
    const captured = capture(branch);
    assert.deepEqual(captured.entries.map((entry) => entry.id), ["old", "broken", "later", "answer"]);
    assert.equal(captured.entries[1].message.content[0].text, "partial");
    assert.deepEqual(unresolved(captured.entries), []);
    assert.equal(branch[1].message.content.length, 2);
  }
});

test("actual Pi compaction summary keeps provenance and later dialogue without trimming summarized missing call", options, () => {
  const branch = [user("old"), assistant("summarized", [call("old-call")]), user("kept"),
    entry("compact", "compaction", { firstKeptEntryId: "kept", summary: "summarized previous round", tokensBefore: 99 }),
    assistant("answer", [{ type: "text", text: "after compact" }])];
  const captured = capture(branch);
  assert.equal(captured.entries.length, branch.length);
  assert.equal(captured.entries[1].message.content[0].type, "toolCall");
  assert.equal(captured.entries[3].summary, "summarized previous round");
  const messages = core.buildSessionContext(captured.entries).messages;
  assert.equal(messages.some((message) => message.role === "compactionSummary"), true);
  assert.equal(messages.at(-1).content[0].text, "after compact");
  assert.deepEqual(unresolved(captured.entries), []);
});

test("a compaction checkpoint after a retained missing-result assistant is not mistaken for the current launcher", options, () => {
  const branch = [user("before"), assistant("retained", [{ type: "text", text: "partial" }, call("missing")]),
    entry("compact", "compaction", { firstKeptEntryId: "retained", summary: "checkpoint", tokensBefore: 99 })];
  const captured = capture(branch);
  assert.deepEqual(captured.entries.map((entry) => entry.id), ["before", "retained", "compact"]);
  assert.equal(captured.entries.at(-1).summary, "checkpoint");
  assert.deepEqual(unresolved(captured.entries), []);
});

test("actual Pi context_edit removal of a historical call preserves the edit and later dialogue", options, () => {
  const branch = [assistant("removed", [call("old-call")]), edit("removal", "removed", null), user("later"), assistant("answer", [{ type: "text", text: "kept" }])];
  const captured = capture(branch);
  assert.deepEqual(captured.entries.map((entry) => entry.id), ["removed", "removal", "later", "answer"]);
  assert.equal(captured.entries[1].replacement, null);
  assert.deepEqual(unresolved(captured.entries), []);
});

test("actual Pi projection cuts only the current incomplete launcher and partial sibling results", options, () => {
  const branch = [assistant("historical", [call("aborted")], "aborted"), user("launch"), assistant("launcher", [call("fleet"), call("sibling")], "toolUse"),
    entry("partial-result", "message", { message: { role: "toolResult", toolCallId: "sibling", content: [{ type: "text", text: "done" }] } })];
  const captured = capture(branch);
  assert.deepEqual(captured.entries.map((entry) => entry.id), ["historical", "launch"]);
  assert.deepEqual(unresolved(captured.entries), []);
});

test("projected replacement calls with matching results do not become unresolved through orphan cleanup", options, () => {
  const branch = [assistant("old", [{ type: "text", text: "original" }]), edit("injection", "old", { content: [call("injected")] }),
    entry("result", "message", { message: { role: "toolResult", toolCallId: "injected", content: [{ type: "text", text: "done" }] } }), user("later"), assistant("answer", [{ type: "text", text: "valid" }])];
  const captured = capture(branch);
  assert.deepEqual(captured.entries.map((entry) => entry.id), branch.map((entry) => entry.id));
  assert.deepEqual(unresolved(captured.entries), []);
});

test("actual Pi replacements injecting unresolved calls are sanitized without discarding later history or provenance", options, () => {
  const branch = [assistant("old", [{ type: "text", text: "original" }]), user("later"), assistant("answer", [{ type: "text", text: "valid" }]),
    edit("injection", "old", { content: [{ type: "text", text: "edited" }, call("injected")] })];
  const captured = capture(branch);
  assert.deepEqual(captured.entries.map((entry) => entry.id), ["old", "later", "answer", "injection"]);
  assert.deepEqual(captured.entries.at(-1).replacement.content, [{ type: "text", text: "edited" }]);
  assert.deepEqual(unresolved(captured.entries), []);
});
