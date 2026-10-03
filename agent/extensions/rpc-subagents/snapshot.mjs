import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function sanitizeContent(content, message, target) {
  if (!Array.isArray(content)) return content;
  const sameModel = message?.provider === target.provider && message?.model === target.id;
  return content.filter((block) => {
    if (block?.type === "redacted_thinking") return false;
    if (block?.type !== "thinking") return true;
    return sameModel && !block.redacted && !block.thinkingSignature && !block.signature;
  }).map((block) => {
    const clean = { ...block };
    delete clean.textSignature;
    delete clean.thoughtSignature;
    return clean;
  });
}

function projectedContent(entry, edits) {
  const edit = edits.get(entry.id);
  if (edit?.replacement === null) return [];
  return edit ? edit.replacement.content : entry.message?.content;
}

function activeEntries(entries) {
  const index = entries.findLastIndex((entry) => entry.type === "compaction");
  if (index < 0) return entries;
  const compaction = entries[index];
  const kept = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  return [compaction, ...(kept >= 0 && kept < index ? entries.slice(kept, index).filter((entry) => entry.type !== "message" || entry.message.role !== "system") : []), ...entries.slice(index + 1)];
}

function editsFor(entries) {
  return new Map(entries.filter((entry) => entry.type === "context_edit").map((entry) => [entry.targetId, entry]));
}

function projectBranch(entries) {
  const active = activeEntries(entries);
  const edits = editsFor(active);
  return { entries: active.map((sourceEntry) => ({ sourceEntry, messages: sourceEntry.type === "message" && edits.get(sourceEntry.id)?.replacement !== null
    ? [{ ...sourceEntry.message, content: projectedContent(sourceEntry, edits) }] : [] })) };
}

function toolCalls(content) { return Array.isArray(content) ? content.filter((block) => block.type === "toolCall") : []; }

export function captureBranch(sessionManager, target, buildProjection = projectBranch) {
  const source = structuredClone(sessionManager.getBranch());
  let entries = source;
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error("Branch snapshot contains missing or duplicate entry IDs");
    ids.add(entry.id);
  }
  let parent = null;
  for (const entry of entries) { entry.parentId = parent; parent = entry.id; }
  let projection = buildProjection(entries).entries;
  const messages = projection.flatMap(({ sourceEntry, messages }) => messages.map((message) => ({ entry: sourceEntry, message })));
  const results = new Set(messages.filter(({ message }) => message.role === "toolResult").map(({ message }) => message.toolCallId));
  const tail = messages.findLast(({ message }) => ["user", "assistant", "custom", "branchSummary"].includes(message.role));
  const checkpoint = entries.findLastIndex((entry) => ["compaction", "branch_summary"].includes(entry.type));
  if (tail?.message.role === "assistant" && entries.indexOf(tail.entry) > checkpoint && !["error", "aborted"].includes(tail.message.stopReason)) {
    const rawCalls = new Set(toolCalls(tail.entry.message.content).map((block) => block.id));
    if (toolCalls(tail.message.content).some((block) => rawCalls.has(block.id) && !results.has(block.id))) {
      entries = entries.slice(0, entries.findIndex((entry) => entry.id === tail.entry.id));
    }
  }

  projection = buildProjection(entries).entries;
  const retainedResults = new Set(projection.flatMap(({ messages }) => messages).filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
  const edits = editsFor(projection.map(({ sourceEntry }) => sourceEntry));
  for (const { sourceEntry, messages } of projection) {
    if (sourceEntry.type !== "message" || sourceEntry.message.role !== "assistant") continue;
    const unresolved = new Set(messages.flatMap((message) => toolCalls(message.content)).filter((block) => !retainedResults.has(block.id)).map((block) => block.id));
    const strip = (content) => Array.isArray(content) ? content.filter((block) => block.type !== "toolCall" || !unresolved.has(block.id)) : content;
    sourceEntry.message.content = strip(sourceEntry.message.content);
    const edit = edits.get(sourceEntry.id);
    if (edit?.replacement) edit.replacement.content = strip(edit.replacement.content);
  }

  const calls = new Set();
  const activeCalls = new Set();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (block.type === "toolCall") calls.add(block.id);
    }
  }
  projection = buildProjection(entries).entries;
  const active = new Set(projection.map(({ sourceEntry }) => sourceEntry.id));
  for (const { messages } of projection) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of toolCalls(message.content)) activeCalls.add(block.id);
    }
  }
  entries = entries.filter((entry) => entry.type !== "message" || entry.message.role !== "toolResult" ||
    (active.has(entry.id) ? activeCalls.has(entry.message.toolCallId) : calls.has(entry.message.toolCallId)));

  const retained = new Set(entries.map((entry) => entry.id));
  entries = entries.filter((entry) => !["context_edit", "label"].includes(entry.type) || retained.has(entry.targetId));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let parentId = null;
  for (const entry of entries) {
    entry.parentId = parentId;
    parentId = entry.id;
    if (entry.type === "compaction" && !byId.has(entry.firstKeptEntryId)) {
      const oldIndex = source.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
      entry.firstKeptEntryId = source.slice(Math.max(0, oldIndex)).find((candidate) => byId.has(candidate.id))?.id ?? entry.id;
    }
    if (entry.type === "message") entry.message.content = sanitizeContent(entry.message.content, entry.message, target);
    if (entry.type === "context_edit" && entry.replacement !== null) {
      const original = byId.get(entry.targetId);
      entry.replacement.content = sanitizeContent(entry.replacement.content, original?.message, target);
    }
  }
  return {
    version: 1,
    parentSession: sessionManager.getSessionFile() ?? undefined,
    entries,
    droppedEntries: source.length - entries.length,
  };
}

export async function writeChildSession(filePath, { cwd, template, now = Date.now() }) {
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date(now).toISOString(), cwd };
  if (template?.parentSession) header.parentSession = template.parentSession;
  const entries = template ? structuredClone(template.entries) : [];
  const jsonl = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, jsonl, { flag: "wx", mode: 0o600 });
  return { filePath, sessionId: header.id, entryCount: entries.length };
}
