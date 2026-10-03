import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const options = { skip: !packageDir && "Set RPC_SUBAGENTS_PI_PACKAGE to validate skill discovery with installed Pi" };

test("fleet advertises a model-invoked skill on startup and reload, but not in children", options, async () => {
  const { loadExtensions } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")).href);
  const { loadSkills, formatSkillsForPrompt } = await import(pathToFileURL(join(packageDir, "dist/core/skills.js")).href);
  const previous = process.env.RPC_SUBAGENTS_CHILD;
  try {
    delete process.env.RPC_SUBAGENTS_CHILD;
    const loaded = await loadExtensions([join(root, "index.ts")], root);
    assert.deepEqual(loaded.errors, []);
    const handlers = loaded.extensions[0].handlers.get("resources_discover") ?? [];
    assert.equal(handlers.length, 1);
    for (const reason of ["startup", "reload"]) {
      const discovered = await handlers[0]({ type: "resources_discover", cwd: root, reason }, {});
      assert.deepEqual(discovered.skillPaths, [join(root, "skills/rpc-subagents/SKILL.md")]);
      const result = loadSkills({ cwd: root, agentDir: root, skillPaths: discovered.skillPaths, includeDefaults: false });
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.skills.length, 1);
      assert.equal(result.skills[0].name, "rpc-subagents");
      assert.equal(result.skills[0].disableModelInvocation, false);
      assert.ok(formatSkillsForPrompt(result.skills).includes("<name>rpc-subagents</name>"));
    }
    process.env.RPC_SUBAGENTS_CHILD = "1";
    const child = await loadExtensions([join(root, "index.ts")], root);
    assert.deepEqual(child.errors, []);
    assert.equal(child.extensions[0].handlers.has("resources_discover"), false);
  } finally {
    if (previous === undefined) delete process.env.RPC_SUBAGENTS_CHILD;
    else process.env.RPC_SUBAGENTS_CHILD = previous;
  }
});

test("skill links resolve and JavaScript examples parse without running tasks", async () => {
  const skillDir = join(root, "skills/rpc-subagents");
  const visited = new Set();
  const pending = [join(skillDir, "SKILL.md")];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let examples = 0;
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:\/\//i.test(target)) continue;
      const resolved = resolve(dirname(path), target);
      await access(resolved);
      if (resolved.startsWith(skillDir + "/") && resolved.endsWith(".md")) pending.push(resolved);
    }
    for (const match of source.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)) {
      assert.doesNotThrow(() => new AsyncFunction(match[1]), `Invalid example in ${path}`);
      examples++;
    }
  }
  assert.ok(examples > 0, "Include at least one executable codemode example");
});
