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
const nativeEditorApi = packageDir ? await import(pathToFileURL(join(packageDir, "dist/modes/interactive/components/custom-editor.js")).href) : undefined;
const nativeKeybindingsApi = packageDir ? await import(pathToFileURL(join(packageDir, "dist/core/keybindings.js")).href) : undefined;
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
  const timers = new Set(); const listeners = new Set(); let renders = 0; let toolsExpanded = false;
  const getToolsExpanded = () => toolsExpanded;
  const setToolsExpanded = (expanded) => { toolsExpanded = expanded; };
  const code = runInNewContext(source, { ...tuiApi, safeText, singleLineText, Date,
    setInterval: (callback) => { timers.add(callback); return callback; }, clearInterval: (id) => timers.delete(id) });
  const model = { tasks: () => [task], schedules: () => [schedule], subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const tui = { requestRender: () => { renders++; }, terminal: { rows: 20 } };
  const widths = (lines, width) => {
    for (const line of lines) { assert.equal(/[\n\r\u2028\u2029]/.test(line), false, `multiline render row: ${line}`); assert.ok(tuiApi.visibleWidth(line) <= width, `render row exceeds ${width}: ${line}`); }
  };
  return { code, model, timers, listeners, getToolsExpanded, setToolsExpanded, tui, widths, renders: () => renders };
}

test("widget single-line fields stay within actual Pi TUI widths and dispose subscriptions/timers", options, () => {
  const { code, model, timers, listeners, getToolsExpanded, tui, widths, renders } = setup();
  let widget;
  code.installFleetWidget({ mode: "tui", ui: { getToolsExpanded, setWidget: (_name, factory) => { widget = factory(tui, theme); } } }, model);
  for (const width of [1, 7, 20, 80]) widths(widget.render(width), width);
  assert.ok(widget.render(80).some((line) => line.includes("a b")));
  assert.ok(widget.render(200)[0].startsWith("RPC subagents  \uf0ae 1  "));
  assert.equal(widget.render(200)[0].includes("個任務"), false);
  for (const listener of listeners) listener();
  assert.equal(renders(), 1); assert.equal(timers.size, 1);
  widget.dispose(); widget.dispose();
  assert.equal(listeners.size, 0); assert.equal(timers.size, 0);
});

function mountWidget(harness, mode = "tui") {
  let widget;
  const controller = harness.code.installFleetWidget({ mode, ui: { getToolsExpanded: harness.getToolsExpanded, setWidget: (_name, factory) => {
    widget = factory(harness.tui, theme);
  } } }, harness.model);
  return { controller, widget };
}

const statusIcons = [
  ["queued", "\uf017"], ["starting", "\uf135"], ["running", "\uf04b"], ["waiting_input", "\uf075"], ["cancelling", "\uf110"],
  ["completed", "\uf00c"], ["failed", "\uf057"], ["cancelled", "\uf05e"], ["interrupted", "\uf04d"],
  ["active", "\uf205"], ["paused", "\uf04c"], ["missed", "\uf071"],
];

for (const [status, icon] of statusIcons) {
  test(`status ${status} renders its Nerd Font icon in list, detail, and history`, options, async () => {
    const harness = setup();
    const isTask = !["active", "paused", "missed"].includes(status);
    harness.model.tasks = () => [{ ...task, name: "scout", status, state: { status, dialogs: [], requests: [] } }];
    harness.model.schedules = () => [{ ...schedule, name: "daily", state: { status }, history: [{ at: 0, status, taskId: "history-task" }] }];
    const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
      const component = factory(harness.tui, theme, {}, resolve);
      try {
        if (!isTask) component.handleInput("\t");
        assert.ok(component.render(200)[1].includes(` ${icon} `));
        for (const width of [1, 7, 20, 80]) harness.widths(component.render(width), width);
        component.handleInput("\r");
        const detail = component.render(200).join("\n");
        assert.ok(detail.includes(isTask ? `\n${icon} ` : `\n${icon}\n`));
        for (const width of [1, 7, 20, 80]) harness.widths(component.render(width), width);
        if (isTask) {
          component.handleInput("\x1b");
          component.handleInput("\t");
          component.handleInput("\r");
        }
        assert.ok(component.render(200).join("\n").includes(` ${icon} history-task`));
        component.handleInput("\x1b");
        component.handleInput("\x1b");
      } finally { component.dispose(); }
    }) } };
    await harness.code.showFleetScreen(ctx, harness.model, {});
    if (isTask) {
      harness.model.schedules = () => [];
      const { widget, controller } = mountWidget(harness);
      try {
        const terminalStatus = ["completed", "failed", "cancelled", "interrupted"].includes(status);
        if (!terminalStatus) assert.ok(widget.render(200)[1].includes(` ${icon} `));
        controller.toggle();
        assert.ok(widget.render(200).join("\n").includes(` 輸出 ${icon}`));
        for (const width of [1, 7, 20, 80]) harness.widths(widget.render(width), width);
      } finally { widget.dispose(); }
    }
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.timers.size, 0);
  });
}

test("unknown status remains sanitized text in task detail and schedule history", options, async () => {
  const harness = setup();
  const status = "future\n\u001b[31mstate\u001b[0m";
  harness.model.tasks = () => [{ ...task, status, state: { status } }];
  harness.model.schedules = () => [{ ...schedule, state: { status }, history: [{ at: 0, status, taskId: "history-task" }] }];
  const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
    const component = factory(harness.tui, theme, {}, resolve);
    try {
      assert.ok(component.render(200)[1].includes(" future state "));
      component.handleInput("\r");
      assert.ok(component.render(200).join("\n").includes("\nfuture state "));
      component.handleInput("\x1b");
      component.handleInput("\t");
      assert.ok(component.render(200)[1].includes(" future state "));
      component.handleInput("\r");
      const detail = component.render(200).join("\n");
      assert.ok(detail.includes("\nfuture state\n"));
      assert.ok(detail.includes(" future state history-task"));
      assert.equal(detail.includes("\u001b"), false);
      component.handleInput("\x1b");
      component.handleInput("\x1b");
    } finally { component.dispose(); }
  }) } };
  await harness.code.showFleetScreen(ctx, harness.model, {});
});

test("output preview starts folded, preserves summary rows, toggles immediately, and redraws current text", options, () => {
  const harness = setup();
  let current = { ...task, text: "private-live-output" };
  harness.model.tasks = () => [current];
  const { widget, controller } = mountWidget(harness);
  try {
    const folded = widget.render(200);
    assert.ok(folded[0].includes("\uf054 收合 Ctrl+O"));
    assert.ok(folded[0].includes("/rpc-subagents"));
    assert.equal(folded.length, 3);
    assert.ok(folded[1].startsWith("task a b"));
    assert.ok(folded[2].startsWith("下次排程 sche "));
    assert.equal(folded.join("\n").includes(current.text), false);
    current = { ...current, get text() { throw new Error("Folded output must not read task text"); } };
    assert.equal(widget.render(200).length, 3);
    current = { ...task, text: "private-live-output" };
    controller.toggle();
    assert.equal(harness.renders(), 1);
    const expanded = widget.render(200);
    assert.ok(expanded[0].includes("\uf078 展開"));
    assert.deepEqual(Array.from(expanded.slice(1, 3)), Array.from(folded.slice(1, 3)));
    assert.ok(expanded.join("\n").includes("task 輸出 \uf04b \uf0e7 — tok/s"));
    assert.ok(expanded.includes("private-live-output"));
    current = { ...current, text: "updated-stream-tail" };
    for (const listener of harness.listeners) listener();
    assert.equal(harness.renders(), 2);
    assert.ok(widget.render(200).includes("updated-stream-tail"));
    assert.equal(widget.render(200).includes("private-live-output"), false);
    controller.toggle();
    assert.equal(harness.renders(), 3);
    assert.deepEqual(Array.from(widget.render(200)), Array.from(folded));
  } finally { widget.dispose(); }
});

test("expanded preview shows newest wrapped tail at real TUI widths after sanitizing the whole retained text", options, () => {
  const harness = setup();
  const long = "OLD-MARKER" + "繁體😀e\u0301 tail ".repeat(100) + "latest-😀-Z";
  let current = { ...task, text: "first\u2028second\u2029third\n" + long };
  harness.model.tasks = () => [current];
  harness.model.schedules = () => [];
  harness.tui.terminal.rows = 40;
  const { widget, controller } = mountWidget(harness);
  try {
    controller.toggle();
    for (const width of [1, 7, 20, 80]) {
      const lines = widget.render(width);
      harness.widths(lines, width);
      const expected = tuiApi.wrapTextWithAnsi(long, width).slice(-4).map((line) => tuiApi.truncateToWidth(line, width));
      assert.deepEqual(Array.from(lines.slice(3)), expected);
      assert.ok(lines.at(-1).endsWith("Z"));
      assert.equal(lines.join("\n").includes("OLD-MARKER"), false);
    }
    current = { ...current, text: "OLD-MARKER" + "繁體😀e\u0301 tail ".repeat(3000) + "latest-😀-Z" };
    for (const width of [1, 7, 20, 80]) {
      const lines = widget.render(width);
      harness.widths(lines, width);
      assert.ok(lines.at(-1).endsWith("Z"));
      assert.equal(lines.join("\n").includes("OLD-MARKER"), false);
      assert.equal(lines.slice(3).length, 4);
    }
    current = { ...current, text: "old\u2028new\u2029tabs\there\n\u001b]0;" + "OSC-SECRET".repeat(1000) + "\u0007latest\u001b[31m-visible\u001b[0m" };
    const lines = widget.render(80);
    assert.deepEqual(Array.from(lines.slice(3)), ["old", "new", "tabs here", "latest-visible"]);
    assert.equal(/[\u0007\t]/.test(lines.join("")), false);
    assert.equal(/\u001b(?!\[0m)/.test(lines.join("")), false);
    current = { ...current, text: "safe\n\u001b]0;" + "UNTERMINATED-SECRET".repeat(500) };
    assert.equal(widget.render(80).join("\n").includes("UNTERMINATED-SECRET"), false);
  } finally { widget.dispose(); }
});

test("empty output and an empty latest-message reset show a placeholder without stale cached text", options, () => {
  const harness = setup();
  let current = { ...task, text: "" };
  harness.model.tasks = () => [current];
  harness.model.schedules = () => [];
  const { widget, controller } = mountWidget(harness);
  try {
    controller.toggle();
    assert.ok(widget.render(80).includes("（尚無輸出）"));
    current = { ...current, text: "previous-message" };
    for (const listener of harness.listeners) listener();
    assert.ok(widget.render(80).includes("previous-message"));
    current = { ...current, text: "" };
    for (const listener of harness.listeners) listener();
    assert.equal(harness.renders(), 3);
    assert.ok(widget.render(80).includes("（尚無輸出）"));
    assert.equal(widget.render(80).includes("previous-message"), false);
    for (const width of [1, 7, 20, 80]) harness.widths(widget.render(width), width);
  } finally { widget.dispose(); }
});

test("only expanded output retains the latest finished result and active tasks take precedence", options, () => {
  const harness = setup();
  let tasks = [{ ...task, text: "streaming-result" }];
  harness.model.tasks = () => tasks;
  harness.model.schedules = () => [];
  const { widget, controller } = mountWidget(harness);
  try {
    controller.toggle();
    tasks = [
      { ...task, taskId: "new-done-task", status: "completed", finishedAt: 300, text: "latest-finished" },
      { ...task, taskId: "old-done-task", status: "completed", finishedAt: 100, text: "older-finished" },
    ];
    for (const listener of harness.listeners) listener();
    const completed = widget.render(120).join("\n");
    assert.ok(completed.includes("new- 輸出 \uf00c \uf0e7 — tok/s"));
    assert.ok(completed.includes("latest-finished"));
    assert.equal(completed.includes("older-finished"), false);
    controller.toggle();
    assert.equal(widget.render(120).length, 0);
    controller.toggle();
    assert.ok(widget.render(120).includes("latest-finished"));
    tasks.push({ ...task, text: "new-active" });
    for (const listener of harness.listeners) listener();
    assert.ok(widget.render(120).includes("new-active"));
    assert.equal(widget.render(120).includes("latest-finished"), false);
    tasks = [];
    assert.equal(widget.render(120).length, 0);
  } finally { widget.dispose(); }
});

test("expanded widget caps total height, reserves editor space, previews three tasks, and marks retained truncation", options, () => {
  const harness = setup();
  harness.model.tasks = () => Array.from({ length: 5 }, (_, index) => ({ ...task,
    taskId: `active-${index}-task`, text: `output-${index}\n` + "abcdefgh ".repeat(100), truncated: index === 0,
  }));
  const { widget, controller } = mountWidget(harness);
  try {
    controller.toggle();
    harness.tui.terminal.rows = 60;
    const full = widget.render(120);
    assert.equal(full.filter((line) => line.includes(" 輸出 ")).length, 3);
    assert.ok(full.some((line) => line.includes("保留內容已截短")));
    assert.equal(full.some((line) => line.startsWith("active-3") || line.startsWith("active-4")), false);
    assert.ok(full.some((line) => line.includes("另有 2 個任務")));
    for (const rows of [8, 9, 12, 20, 30, 50]) {
      harness.tui.terminal.rows = rows;
      for (const width of [1, 7, 20, 80]) {
        const lines = widget.render(width);
        assert.ok(lines.length <= Math.min(20, rows - 8), `widget consumes editor space at ${rows} rows`);
        harness.widths(lines, width);
      }
    }
  } finally { widget.dispose(); }
});

test("native tool expansion toggles preview once and remains stable across streaming redraws", options, () => {
  const harness = setup();
  const { widget, controller } = mountWidget(harness);
  try {
    const folded = Array.from(widget.render(200));
    harness.setToolsExpanded(true);
    const expanded = Array.from(widget.render(200));
    assert.ok(expanded.includes("first line"));
    for (const timer of harness.timers) timer();
    for (const listener of harness.listeners) listener();
    for (let index = 0; index < 5; index++) assert.deepEqual(Array.from(widget.render(200)), expanded);
    harness.setToolsExpanded(false);
    assert.deepEqual(Array.from(widget.render(200)), folded);
    controller.toggle();
    assert.ok(widget.render(200).includes("first line"));
    assert.equal(harness.getToolsExpanded(), false);
    harness.setToolsExpanded(true);
    assert.deepEqual(Array.from(widget.render(200)), folded);
  } finally { widget.dispose(); }
});

test("installed Pi editor drives preview using native Ctrl+O and remapped tool-expansion bindings", options, () => {
  for (const [bindings, key] of [[{}, "\x0f"], [{ "app.tools.expand": "ctrl+alt+o" }, "\x1b[111;7u"]]) {
    const harness = setup();
    const { widget } = mountWidget(harness);
    const editor = new nativeEditorApi.CustomEditor(harness.tui, { borderColor: (text) => text }, new nativeKeybindingsApi.KeybindingsManager(bindings));
    editor.onAction("app.tools.expand", () => {
      harness.setToolsExpanded(!harness.getToolsExpanded());
      harness.tui.requestRender();
    });
    try {
      assert.equal(widget.render(200).includes("first line"), false);
      editor.handleInput(key);
      assert.equal(harness.getToolsExpanded(), true);
      assert.ok(widget.render(200).includes("first line"));
      assert.ok(widget.render(200).includes("first line"));
      editor.handleInput(key);
      assert.equal(harness.getToolsExpanded(), false);
      assert.equal(widget.render(200).includes("first line"), false);
    } finally { widget.dispose(); }
  }
});

test("preview starts folded even when native tools start expanded and handles the first native toggle", options, () => {
  const harness = setup();
  harness.setToolsExpanded(true);
  const { widget } = mountWidget(harness);
  try {
    assert.equal(widget.render(200).includes("first line"), false);
    harness.setToolsExpanded(false);
    assert.ok(widget.render(200).includes("first line"));
    for (const width of [1, 7, 20, 80]) harness.widths(widget.render(width), width);
    assert.ok(widget.render(200).includes("first line"));
    harness.setToolsExpanded(true);
    assert.equal(widget.render(200).includes("first line"), false);
  } finally { widget.dispose(); }
});

test("widget disposal makes old toggles inert, reinstall resets expansion, and non-TUI installs do nothing", options, () => {
  const harness = setup();
  const first = mountWidget(harness);
  first.controller.toggle();
  assert.ok(first.widget.render(120).join("\n").includes("first line"));
  first.widget.dispose();
  first.widget.dispose();
  const renders = harness.renders();
  first.controller.toggle();
  assert.equal(harness.renders(), renders);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.setToolsExpanded(true);
  const second = mountWidget(harness);
  try {
    assert.ok(second.widget.render(120)[0].includes("\uf054 收合"));
    assert.equal(second.widget.render(120).join("\n").includes("first line"), false);
    first.controller.toggle();
    assert.equal(second.widget.render(120).join("\n").includes("first line"), false);
    harness.setToolsExpanded(false);
    assert.ok(second.widget.render(120).includes("first line"));
  } finally { second.widget.dispose(); }
  for (const mode of ["rpc", "json", "print"]) {
    const installed = mountWidget(harness, mode);
    assert.equal(installed.controller, undefined);
    assert.equal(installed.widget, undefined);
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.timers.size, 0);
  }
});

for (const [name, fields, thinking, timeout] of [
  ["high", { thinking: "high", timeoutMs: 300000 }, "high", " \uf252300s"],
  ["off", { thinking: "off", timeoutMs: 150 }, "off", " \uf2520.15s"],
  ["default", { thinking: "off", timeoutMs: 1800000 }, "off", " \uf2521800s"],
  ["legacy", {}, "unknown", ""],
  ["escaped", { thinking: "high\n\u001b[31mlevel", timeoutMs: 300000 }, "high level", " \uf252300s"],
]) {
  test(`widget and task list/detail display running and timeout icons with thinking consistently for ${name}`, options, async () => {
    const { code, model, timers, listeners, getToolsExpanded, tui, widths } = setup();
    model.tasks = () => [{
      ...task, ...fields, taskId: "96cde265-task", name: "scout",
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, currentTools: [],
    }];
    model.schedules = () => [];
    let widget;
    code.installFleetWidget({ mode: "tui", ui: { getToolsExpanded, setWidget: (_name, factory) => { widget = factory(tui, theme); } } }, model);
    try {
      const widgetRow = widget.render(200)[1];
      assert.ok(widgetRow.startsWith(`96cd scout opencode-go/deepseek-v4.1-flash ${thinking} \uf04b `));
      assert.match(widgetRow, new RegExp(`\uf04b \\d+s${timeout.replace(".", "\\.")} .* \uf0e7 — tok/s$`));
      assert.equal(widgetRow.includes("執行中"), false);
      assert.equal(widgetRow.includes("timeout="), false);
      if (!timeout) assert.equal(widgetRow.includes("\uf252"), false);
      for (const width of [1, 7, 20, 80, 200]) widths(widget.render(width), width);
    } finally { widget.dispose(); }
    const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      try {
        const listRow = component.render(200)[1];
        assert.match(listRow, new RegExp(`^> 96cd scout \uf04b \\d+s${timeout.replace(".", "\\.")} deepseek-v4\\.1-flash ${thinking} \uf0e7 — tok/s$`));
        assert.equal(listRow.includes("執行中"), false);
        assert.equal(listRow.includes("timeout="), false);
        if (!timeout) assert.equal(listRow.includes("\uf252"), false);
        for (const width of [1, 7, 20, 80, 200]) widths(component.render(width), width);
        component.handleInput("\r");
        const detail = component.render(200).join("\n");
        assert.ok(detail.includes("\n96cde265-task 最新回應觀測視窗 \uf0e7 — tok/s\n"));
        assert.ok(detail.includes(`模型 opencode-go/deepseek-v4.1-flash ${thinking}\n`));
        assert.match(detail, new RegExp(`\uf04b \\d+s${timeout.replace(".", "\\.")}\\n`));
        assert.equal(detail.includes("執行中"), false);
        assert.equal(detail.includes("timeout="), false);
        if (!timeout) assert.equal(detail.includes("\uf252"), false);
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

for (const [status, stateLabel] of [["active", "\uf205"], ["paused", "\uf04c"]]) {
  test(`schedule detail displays the running icon for active tasks and preserves the ${status} state label`, options, async () => {
    const { code, model, timers, listeners, tui, widths } = setup();
    model.schedules = () => [{ ...schedule, state: { status }, activeTaskIds: ["96cde265-task", "12345678-task"] }];
    const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      try {
        component.handleInput("\t");
        assert.ok(component.render(200)[1].startsWith("> sche "));
        assert.ok(component.render(200)[1].includes(` ${stateLabel} `));
        for (const width of [1, 7, 20, 80, 200]) widths(component.render(width), width);
        component.handleInput("\r");
        const detail = component.render(200).join("\n");
        assert.ok(detail.includes(`\n${stateLabel}\n`));
        assert.ok(detail.includes("\n\uf04b 96cde265-task, 12345678-task\n"));
        assert.equal(detail.includes("執行中"), false);
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

test("TPS is the final suffix on summary rows while details keep full IDs", options, async () => {
  const harness = setup();
  const known = { ...task, taskId: "tps-known-123456", name: "a very long task name that keeps going and going".repeat(4), model: { provider: "provider-name-that-is-very-long", id: "model-name-that-is-also-very-long" }, tps: 12.5, truncated: true };
  const unknown = { ...task, taskId: "tps-unknown-9", name: "missing usage", tps: undefined };
  harness.model.tasks = () => [unknown, known];
  harness.model.schedules = () => [];
  const ctx = { mode: "tui", ui: { notify() {}, custom: (factory) => new Promise((resolve) => {
    const component = factory(harness.tui, theme, {}, resolve);
    try {
      const list = component.render(400);
      assert.ok(list.some((line) => line.startsWith("> tps- a very long task name") && line.endsWith("\uf0e7 12.5 tok/s")), "list known TPS is the final suffix");
      assert.ok(list.some((line) => line.startsWith("  tps- missing usage") && line.endsWith("\uf0e7 — tok/s")), "list unknown TPS is the final suffix");
      assert.equal(list.join("\n").includes("tps-known-123456"), false, "list summary rows keep the four-character prefix");
      for (const width of [80, 120]) harness.widths(component.render(width), width);
      component.handleInput("\r");
      const detail = component.render(400).join("\n");
      assert.ok(detail.includes("\ntps-known-123456 最新回應觀測視窗 \uf0e7 12.5 tok/s\n"), "detail first line keeps the full ID and ends with TPS");
      for (const width of [80, 120]) harness.widths(component.render(width), width);
      component.handleInput("\x1b");
      component.handleInput("\x1b");
    } finally { component.dispose(); }
  }) } };
  await harness.code.showFleetScreen(ctx, harness.model, {});
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.model.tasks = () => [known];
  const { widget, controller } = mountWidget(harness);
  try {
    const widgetRow = widget.render(400).find((line) => line.startsWith("tps- "));
    assert.ok(widgetRow.startsWith("tps- a very long task name"), "widget keeps the four-character prefix");
    assert.ok(widgetRow.endsWith("\uf0e7 12.5 tok/s"), "widget TPS is the final suffix");
    assert.equal(widgetRow.includes("tps-known-123456"), false, "widget summary keeps only the four-character prefix");
    controller.toggle();
    const preview = widget.render(400).find((line) => line.includes(" 輸出 "));
    assert.ok(preview.includes("（保留內容已截短） \uf0e7 12.5 tok/s"), "preview header keeps the retention marker before the TPS suffix");
    assert.ok(preview.endsWith("\uf0e7 12.5 tok/s"), "preview header TPS is the final suffix");
    for (const width of [80, 120]) harness.widths(widget.render(width), width);
  } finally { widget.dispose(); }
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
});

test("colliding four-character prefixes keep list rows abbreviated while actions dispatch the full task ID", options, async () => {
  const harness = setup();
  const first = { ...task, taskId: "coll-aaaa-task", name: "first", tps: 1.5 };
  const second = { ...task, taskId: "coll-bbbb-task", name: "second", tps: 2.5 };
  harness.model.tasks = () => [first, second];
  harness.model.schedules = () => [];
  const actions = []; let screens = 0;
  const ctx = { mode: "tui", ui: { notify() {}, custom: (factory) => new Promise((resolve) => {
    const component = factory(harness.tui, theme, {}, resolve);
    screens++;
    try {
      if (screens === 1) {
        const rows = component.render(200).filter((line) => line.includes("coll "));
        assert.equal(rows.length, 2);
        assert.ok(rows.every((line) => !line.includes("coll-aaaa-task") && !line.includes("coll-bbbb-task")), "summary rows display only the four-character prefix");
        assert.ok(rows[0].startsWith("> coll second"), "rows are ordered newest first with the four-character prefix");
        component.handleInput("\x1b[B");
        component.handleInput("c");
      } else component.handleInput("\x1b");
    } finally { component.dispose(); }
  }) } };
  await harness.code.showFleetScreen(ctx, harness.model, { cancelTask: async (id) => actions.push(id) });
  assert.equal(screens, 2);
  assert.deepEqual(actions, ["coll-aaaa-task"], "selection dispatches the complete task ID");
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
});

test("nonfinite and negative TPS values render the placeholder", options, () => {
  const harness = setup();
  harness.model.tasks = () => [
    { ...task, taskId: "tps-negative", name: "negative", tps: -4.2 },
    { ...task, taskId: "tps-nonfinite", name: "nonfinite", tps: Number.NaN },
  ];
  harness.model.schedules = () => [];
  const { widget } = mountWidget(harness);
  try {
    const rendered = widget.render(200);
    assert.ok(rendered[1].startsWith("tps- negative ") && rendered[1].endsWith("\uf0e7 — tok/s"));
    assert.ok(rendered[2].startsWith("tps- nonfinite ") && rendered[2].endsWith("\uf0e7 — tok/s"));
  } finally { widget.dispose(); }
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
