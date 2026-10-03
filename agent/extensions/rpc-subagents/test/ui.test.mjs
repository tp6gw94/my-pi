import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { safeText, singleLineText } from "../viewer.mjs";

const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const tuiApi = packageDir ? await import(pathToFileURL(join(packageDir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href) : undefined;
const options = { skip: !tuiApi && "Set RPC_SUBAGENTS_PI_PACKAGE to test installed Pi TUI rendering" };
const source = stripTypeScriptTypes(await readFile(new URL("../ui.ts", import.meta.url), "utf8"))
  .replace(/^import .*?;\s*$/gm, "").replace(/^export /gm, "") + "\n({ installFleetWidget, showFleetScreen })";
const task = { taskId: "task-id-123", name: "a\nb 繁體😀\u2028c", model: { provider: "provider\nline", id: "模型\n😀" }, cwd: "/project\npath", status: "running", state: { status: "running" },
  currentTools: ["read\nwrite", "工具😀"], text: "first line\n繁體😀second line", createdAt: Date.now() };
const schedule = { scheduleId: "schedule-id-123", name: "排程\n😀", state: { status: "active" }, nextAt: Date.now() + 1000, trigger: { type: "at", at: Date.now() + 1000 }, activeTaskIds: [], history: [] };
const theme = { fg: (_color, text) => text };

const askTask = {
  ...task, taskId: "task-ask-1", name: "ask task", model: { provider: "provider", id: "model" }, cwd: "/project", currentTools: ["read"], text: "waiting for the parent",
  status: "waiting_input", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-1", question: "approve?\u001b[31mred\n\u2028next", expiresAt: Date.now() + 1000 }] },
  capabilities: { requested: ["read"], reachable: ["read", "rpc_subagents_parent"] }, sessionId: "session-1", sessionReusable: true,
};

function setup() {
  const timers = new Set(); const listeners = new Set(); let renders = 0;
  const code = runInNewContext(source, { ...tuiApi, safeText, singleLineText, Date,
    setInterval: (callback) => { timers.add(callback); return callback; }, clearInterval: (id) => timers.delete(id) });
  const model = { tasks: () => [task], schedules: () => [schedule], subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const tui = { requestRender: () => { renders++; }, terminal: { rows: 20 } };
  const widths = (lines, width) => {
    for (const line of lines) { assert.equal(/[\n\r\u2028\u2029]/.test(line), false, `multiline render row: ${line}`); assert.ok(tuiApi.visibleWidth(line) <= width, `render row exceeds ${width}: ${line}`); }
  };
  return { code, model, timers, listeners, tui, widths, renders: () => renders };
}

test("widget single-line fields stay within actual Pi TUI widths and dispose subscriptions/timers", options, () => {
  const { code, model, timers, listeners, tui, widths, renders } = setup();
  let widget;
  code.installFleetWidget({ mode: "tui", ui: { setWidget: (_name, factory) => { widget = factory(tui, theme); } } }, model);
  for (const width of [1, 7, 20, 80]) widths(widget.render(width), width);
  assert.ok(widget.render(80).some((line) => line.includes("a b")));
  for (const listener of listeners) listener();
  assert.equal(renders(), 1); assert.equal(timers.size, 1);
  widget.dispose(); widget.dispose();
  assert.equal(listeners.size, 0); assert.equal(timers.size, 0);
});

for (const [name, fields, thinking, timeout] of [
  ["high", { thinking: "high", timeoutMs: 300000 }, "high", " timeout=300s"],
  ["off", { thinking: "off", timeoutMs: 150 }, "off", " timeout=0.15s"],
  ["default", { thinking: "off", timeoutMs: 1800000 }, "off", " timeout=1800s"],
  ["legacy", {}, "unknown", ""],
  ["escaped", { thinking: "high\n\u001b[31mlevel", timeoutMs: 300000 }, "high level", " timeout=300s"],
]) {
  test(`widget and task list/detail display thinking and timeout consistently for ${name}`, options, async () => {
    const { code, model, timers, listeners, tui, widths } = setup();
    model.tasks = () => [{
      ...task, ...fields, taskId: "96cde265-task", name: "scout",
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, currentTools: [],
    }];
    model.schedules = () => [];
    let widget;
    code.installFleetWidget({ mode: "tui", ui: { setWidget: (_name, factory) => { widget = factory(tui, theme); } } }, model);
    try {
      const widgetRow = widget.render(200)[1];
      assert.ok(widgetRow.startsWith(`96cde265 scout opencode-go/deepseek-v4.1-flash ${thinking} 執行中 `));
      assert.match(widgetRow, new RegExp(`執行中 \\d+s${timeout.replace(".", "\\.")} $`));
      if (!timeout) assert.equal(widgetRow.includes("timeout="), false);
      for (const width of [1, 7, 20, 80, 200]) widths(widget.render(width), width);
    } finally { widget.dispose(); }
    const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      try {
        const listRow = component.render(200)[1];
        assert.match(listRow, new RegExp(`^> 96cde265 scout 執行中 \\d+s${timeout.replace(".", "\\.")} deepseek-v4\\.1-flash ${thinking}$`));
        for (const width of [1, 7, 20, 80, 200]) widths(component.render(width), width);
        component.handleInput("\r");
        const detail = component.render(200).join("\n");
        assert.ok(detail.includes(`模型 opencode-go/deepseek-v4.1-flash ${thinking}\n`));
        assert.match(detail, new RegExp(`執行中 \\d+s${timeout.replace(".", "\\.")}\\n`));
        if (!timeout) assert.equal(detail.includes("timeout="), false);
        for (const width of [1, 7, 20, 80, 200]) widths(component.render(width), width);
        component.handleInput("\x1b");
        component.handleInput("\x1b");
      } finally { component.dispose(); }
    }) } };
    await code.showFleetScreen(ctx, model, {});
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
  });
}

test("ask-only waiting state replies through the coordination path with escaped text and cancel", options, async () => {
  const { code, timers, listeners, tui, widths } = setup();
  const actions = []; const inputs = []; let screens = 0;
  const model = { tasks: () => [askTask], schedules: () => [], subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const ctx = { mode: "tui", ui: {
    notify() {},
    input: (title, placeholder) => { inputs.push([title, placeholder]); return Promise.resolve(screens === 1 ? undefined : "yes, proceed"); },
    custom: (factory) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      screens++;
      for (const width of [1, 7, 20, 80]) widths(component.render(width), width);
      if (screens === 1) {
        component.handleInput("\r");
        for (const width of [1, 7, 20, 80]) widths(component.render(width), width);
        const detail = component.render(120).join("\n");
        assert.ok(detail.includes("待回覆請求") && detail.includes("ask-1"), "requests render separately in the detail view");
        assert.ok(detail.includes("能力 read, rpc_subagents_parent"), "capabilities render apart from currentTools");
        assert.ok(detail.includes("工作階段 session-1 可續用"), "session identity renders in the detail view");
        component.handleInput("\x1b");
        component.handleInput("r");
      } else if (screens === 2) component.handleInput("r");
      else component.handleInput("\x1b");
      component.dispose();
    }) } };
  await code.showFleetScreen(ctx, model, { reply: async (...args) => actions.push(["reply", ...args]) });
  assert.equal(screens, 3);
  assert.equal(actions.length, 2);
  assert.equal(actions[0][0], "reply");
  assert.equal(actions[0][1], askTask.taskId);
  assert.equal(actions[0][2], "ask-1");
  assert.equal(actions[0][3].cancelled, true);
  assert.equal(actions[1][3].value, "yes, proceed");
  assert.equal(inputs.length, 2);
  for (const [title, placeholder] of inputs) {
    assert.equal(/[\u001b\n\r\u2028\u2029]/.test(title + placeholder), false, `unescaped ask text: ${title} ${placeholder}`);
    assert.ok(placeholder.includes("approve?") && placeholder.includes("next"));
  }
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
});

test("screen rows sanitize newlines, detail wraps Unicode, keys choose actions, and every exit disposes", options, async () => {
  const { code, model, timers, listeners, tui, widths } = setup();
  const actions = []; let screens = 0;
  const ctx = { mode: "tui", ui: { notify() {}, custom: (factory) => new Promise((resolve) => {
    const component = factory(tui, theme, {}, resolve);
    screens++;
    for (const width of [1, 7, 20, 80]) widths(component.render(width), width);
    if (screens === 1) {
      component.handleInput("\r");
      for (const width of [1, 7, 20, 80]) widths(component.render(width), width);
      assert.ok(component.render(80).some((line) => line.includes("first line")));
      component.handleInput("\x1b");
      component.handleInput("\x1b[B");
      component.handleInput("c");
    } else if (screens === 2) {
      component.handleInput("\t");
      for (const width of [1, 7, 20, 80]) widths(component.render(width), width);
      component.handleInput("p");
    } else component.handleInput("\x1b");
    component.dispose();
  }) } };
  await code.showFleetScreen(ctx, model, { cancelTask: async (id) => actions.push(["cancel", id]), pauseSchedule: async (id) => actions.push(["pause", id]) });
  assert.deepEqual(actions, [["cancel", task.taskId], ["pause", schedule.scheduleId]]);
  assert.equal(screens, 3); assert.equal(listeners.size, 0); assert.equal(timers.size, 0);
});
