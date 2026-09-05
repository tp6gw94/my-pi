import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ralph, {
	buildRalphPrompt,
	extractTerminalAssistantText,
	parseRalphArgs,
} from "../index.ts"

class FakeSession {
	id: string
	entries: any[] = []
	nextEntry = 0
	invalidated = false

	constructor(id: string) {
		this.id = id
	}

	private assertLive(): void {
		if (this.invalidated) throw new Error("stale session context")
	}

	appendCustomEntry(customType: string, data: unknown): string {
		this.assertLive()
		const id = `${this.id}-entry-${this.nextEntry++}`
		this.entries.push({ type: "custom", id, customType, data })
		return id
	}

	getBranch(): any[] {
		this.assertLive()
		return this.entries.slice()
	}

	getLeafId(): string | null {
		this.assertLive()
		return this.entries.at(-1)?.id ?? null
	}
}

function message(id: string, role: string, content: unknown): any {
	return { type: "message", id, message: { role, content } }
}

function loopHarness(
	outputs: (string | undefined)[],
	options: { rejectSessionIds?: string[]; invalidateBeforeFailureSessionIds?: string[]; mode?: string; hasUI?: boolean; emitSessionLifecycle?: boolean } = {},
) {
	const sessions = [new FakeSession("base")]
	const contexts = new Map<string, any>()
	const replacements: string[] = []
	const prompts: { sessionId: string; text: string }[] = []
	const notifications: { message: string; level: string }[] = []
	const statusCalls: { sessionId: string; key: string; text: string | undefined }[] = []
	let beforeAssistant: ((ctx: any) => Promise<void> | void) | undefined
	const rejectedSessionIds = new Set(options.rejectSessionIds ?? [])
	const invalidateBeforeFailureSessionIds = new Set(options.invalidateBeforeFailureSessionIds ?? [])
	let outputIndex = 0
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined
	let stopCommand: { handler: (args: string, ctx: any) => Promise<void> } | undefined
	let reportTool: any
	let inputHandler: ((event: any, ctx: any) => Promise<any>) | undefined
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined
	let sessionShutdownHandler: ((event: any, ctx: any) => void) | undefined
	let resourceHandler: (() => { skillPaths: string[] }) | undefined

	function context(session: FakeSession): any {
		const value = {
			mode: options.mode ?? "tui",
			hasUI: options.hasUI ?? true,
			ui: {
				notify(messageText: string, level: string) {
					if (session.invalidated) throw new Error("stale UI context")
					notifications.push({ message: messageText, level })
				},
				setStatus(key: string, text: string | undefined) {
					if (session.invalidated) throw new Error("stale UI context")
					statusCalls.push({ sessionId: session.id, key, text })
				},
			},
			sessionManager: session,
			async sendUserMessage(text: string) {
				assert.equal(session.invalidated, false)
				prompts.push({ sessionId: session.id, text })
				session.entries.push(message(`${session.id}-user`, "user", text))
				await beforeAssistant?.(value)
				const output = outputs[outputIndex++]
				if (output !== undefined) session.entries.push(message(`${session.id}-assistant`, "assistant", output))
			},
			async waitForIdle() {},
			async newSession(sessionOptions: any) {
				assert.equal(session.invalidated, false)
				replacements.push(session.id)
				if (rejectedSessionIds.has(session.id)) throw new Error("replacement rejected")
				const next = new FakeSession(`replacement-${sessions.length}`)
				sessions.push(next)
				contexts.set(next.id, context(next))
				await sessionOptions.setup(next)
				if (options.emitSessionLifecycle) {
					await sessionShutdownHandler?.({}, value)
					await sessionStartHandler?.({}, contexts.get(next.id))
				}
				if (invalidateBeforeFailureSessionIds.has(session.id)) {
					session.invalidated = true
					throw new Error("replacement failed after teardown")
				}
				await sessionOptions.withSession(contexts.get(next.id))
				return { cancelled: false }
			},
		}
		contexts.set(session.id, value)
		return value
	}

	const baseContext = context(sessions[0])

	const base = baseContext
	const pi: any = {
		appendEntry(customType: string, data: unknown) {
			sessions[0].appendCustomEntry(customType, data)
		},
		on(eventName: string, handler: any) {
			if (eventName === "input") inputHandler = handler
			if (eventName === "session_start") sessionStartHandler = handler
			if (eventName === "session_shutdown") sessionShutdownHandler = handler
			if (eventName === "resources_discover") resourceHandler = handler
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
			if (name === "ralph") command = definition
			if (name === "ralph-stop") stopCommand = definition
		},
		registerTool(definition: any) {
			reportTool = definition
		},
	}
	ralph(pi)
	assert.ok(command)
	assert.ok(resourceHandler)

	return {
		base,
		contexts,
		command: command!,
		stopCommand,
		reportTool,
		inputHandler: inputHandler!,
		sessionStartHandler: sessionStartHandler!,
		sessionShutdownHandler: sessionShutdownHandler!,
		notifications,
		statusCalls,
		prompts,
		setBeforeAssistant(handler: (ctx: any) => Promise<void> | void) {
			beforeAssistant = handler
		},
		replacements,
		resourceHandler: resourceHandler!,
		sessions,
	}
}

function latestState(session: FakeSession): any {
	return session.entries
		.filter((entry) => entry.type === "custom" && entry.customType === "ralph:run-state")
		.at(-1)?.data
}

function activeState(): any {
	return {
		version: 1,
		runId: "existing-run",
		maxIterations: 2,
		iteration: 1,
		task: "existing task",
		active: true,
		status: "running",
	}
}

function assertNoTerminalControls(value: string): void {
	assert.doesNotMatch(value, /[\u0000-\u001F\u007F-\u009F]/u)
}

test("discovers the bundled completion skill", () => {
	const { skillPaths } = loopHarness([]).resourceHandler()
	assert.equal(skillPaths.length, 1)
	assert.match(skillPaths[0] ?? "", /ralph\/skills$/)
})

test("repaints a pending state in the fixed TUI status format", () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
		iteration: 10,
		maxIterations: 50,
		task: "login feature",
	})

	harness.sessionStartHandler({}, harness.base)

	assert.deepEqual(harness.statusCalls.at(-1), {
		sessionId: "base",
		key: "ralph",
		text: "Ralph 10/50 · login feature",
	})
})

test("updates the TUI status synchronously when an iteration starts", async () => {
	const harness = loopHarness(["<ralph-done>"])
	await harness.command.handler("2 finish it", harness.base)

	assert.ok(harness.statusCalls.some((call) =>
		call.sessionId === "replacement-1" && call.key === "ralph" && call.text === "Ralph 1/2 · finish it",
	))
})

test("rebuilds fallback and reported stages from durable state", () => {
	const fallback = loopHarness([])
	fallback.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
		task: "  focus\tchanges\nnow  ",
	})
	fallback.sessionStartHandler({}, fallback.base)
	assert.equal(fallback.statusCalls.at(-1)?.text, "Ralph 1/2 · focus changes now")

	const reported = loopHarness([])
	reported.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
		task: "fallback task",
		stage: "reported stage",
	})
	reported.sessionStartHandler({}, reported.base)
	assert.equal(reported.statusCalls.at(-1)?.text, "Ralph 1/2 · reported stage")
})

test("clears stale TUI status when session starts without Ralph state", () => {
	const harness = loopHarness([])

	assert.doesNotThrow(() => harness.sessionStartHandler({}, harness.base))
	assert.deepEqual(harness.statusCalls, [{ sessionId: "base", key: "ralph", text: undefined }])
})

test("does not write status for non-TUI session repaint", () => {
	const harness = loopHarness([], { mode: "rpc", hasUI: true })
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
	})
	harness.sessionStartHandler({}, harness.base)
	assert.equal(harness.statusCalls.length, 0)
})

test("clears the TUI status on session shutdown", () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())

	harness.sessionShutdownHandler({}, harness.base)

	assert.deepEqual(harness.statusCalls.at(-1), {
		sessionId: "base",
		key: "ralph",
		text: undefined,
	})
	assert.equal(latestState(harness.base.sessionManager).status, "session-shutdown")
	assert.equal(latestState(harness.base.sessionManager).active, false)
	assert.equal(latestState(harness.base.sessionManager).stopRequested, false)
})

test("clears the fixed TUI status after every terminal transition", async () => {
	const cases: { output: string | undefined; max: string; status: string; stop?: boolean }[] = [
		{ output: "<ralph-done>", max: "2", status: "done" },
		{ output: "still working", max: "1", status: "max" },
		{ output: undefined, max: "2", status: "error" },
		{ output: "still working", max: "2", status: "cancelled", stop: true },
	]

	for (const scenario of cases) {
		const harness = loopHarness([scenario.output])
		if (scenario.stop) {
			harness.setBeforeAssistant(async (ctx) => {
				await harness.stopCommand?.handler("", ctx)
			})
		}
		await harness.command.handler(`${scenario.max} finish it`, harness.base)

		assert.equal(latestState(harness.sessions.at(-1)!).status, scenario.status)
		assert.deepEqual(harness.statusCalls.at(-1), {
			sessionId: harness.sessions.at(-1)!.id,
			key: "ralph",
			text: undefined,
		})
	}
})

test("repaints the latest reported stage after replacement and clears the old session", async () => {
	const harness = loopHarness(["still working", "<ralph-done>"], { emitSessionLifecycle: true })
	harness.setBeforeAssistant(async (ctx) => {
		await harness.reportTool.execute("report", { stage: "focus changed" }, undefined, undefined, ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.equal(latestState(harness.sessions.at(-1)!).stage, "focus changed")
	assert.ok(harness.statusCalls.some((call) =>
		call.sessionId === "replacement-2" && call.text === "Ralph 2/2 · focus changed",
	))
	assert.ok(harness.statusCalls.some((call) =>
		call.sessionId === "replacement-1" && call.text === undefined,
	))
})

test("keeps terminal status writes at zero for RPC, json, and print modes", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const harness = loopHarness(["<ralph-done>"], { mode, hasUI: true })
		await harness.command.handler("2 finish it", harness.base)
		assert.equal(harness.statusCalls.length, 0, mode)
	}
})

test("keeps report status writes at zero for every non-TUI mode", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const harness = loopHarness([], { mode, hasUI: true })
		harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
		await harness.reportTool.execute("report", { stage: `${mode} stage` }, undefined, undefined, harness.base)
		assert.equal(harness.statusCalls.length, 0, mode)
		assert.equal(latestState(harness.base.sessionManager).stage, `${mode} stage`)
	}
})

test("registers the progress report tool with a required stage schema", () => {
	const harness = loopHarness([])
	assert.ok(harness.reportTool)
	assert.equal(harness.reportTool.name, "ralph_report")
	assert.deepEqual(harness.reportTool.parameters, {
		type: "object",
		required: ["stage"],
		properties: {
			stage: { type: "string", minLength: 1, pattern: "\\S" },
		},
	})
})

test("rejects invalid progress reports without state or status side effects", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	const entryCount = harness.base.sessionManager.entries.length
	const statusCount = harness.statusCalls.length

	for (const params of [
		undefined,
		{},
		{ stage: 1 },
		{ stage: "" },
		{ stage: " \t\n" },
		{ stage: "\u0000\u0007\u001b\u007f\u009b" },
		{ stage: " \u0000\u0007\n\u001b\t\u007f\u009b " },
	]) {
		const result = await harness.reportTool.execute("report", params, undefined, undefined, harness.base)
		assert.match(result.content[0].text, /rejected/i)
	}

	assert.equal(harness.base.sessionManager.entries.length, entryCount)
	assert.equal(harness.statusCalls.length, statusCount)
	assert.equal(harness.replacements.length, 0)
})

test("does not report progress when no active Ralph loop exists", async () => {
	const harness = loopHarness([])
	const entryCount = harness.base.sessionManager.entries.length
	const result = await harness.reportTool.execute("report", { stage: "waiting" }, undefined, undefined, harness.base)

	assert.match(result.content[0].text, /no active Ralph loop/i)
	assert.equal(harness.base.sessionManager.entries.length, entryCount)
	assert.equal(harness.statusCalls.length, 0)
	assert.equal(harness.replacements.length, 0)
})

test("persists a sanitized active progress report and refreshes TUI status", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	const before = latestState(harness.base.sessionManager)
	const result = await harness.reportTool.execute(
		"report",
		{ stage: "  build\tphase\nready\u2028now 😀😀😀 " },
		undefined,
		undefined,
		harness.base,
	)

	assert.match(result.content[0].text, /stage updated/i)
	const after = latestState(harness.base.sessionManager)
	assert.equal(after.stage, "build phase ready now 😀😀😀")
	assert.equal(after.runId, before.runId)
	assert.equal(after.iteration, before.iteration)
	assert.equal(after.maxIterations, before.maxIterations)
	assert.equal(after.task, before.task)
	assert.equal(after.active, before.active)
	assert.equal(after.status, before.status)
	assert.equal(after.stopRequested, false)
	assert.deepEqual(harness.statusCalls.at(-1), {
		sessionId: "base",
		key: "ralph",
		text: "Ralph 1/2 · build phase ready now 😀😀😀",
	})
})

test("strips terminal controls from persisted report, tool result, and TUI status", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	const stage = "\u0000build\u0007\tphase\u001b ready\u007f\u009bdone 😀"

	const result = await harness.reportTool.execute("report", { stage }, undefined, undefined, harness.base)
	const persisted = latestState(harness.base.sessionManager).stage
	const status = harness.statusCalls.at(-1)?.text ?? ""

	assert.equal(persisted, "build phase readydone 😀")
	assert.equal(result.content[0].text, "Ralph stage updated: build phase readydone 😀")
	assert.equal(status, "Ralph 1/2 · build phase readydone 😀")
	assertNoTerminalControls(persisted)
	assertNoTerminalControls(result.content[0].text)
	assertNoTerminalControls(status)
})

test("strips terminal controls from fallback and reconstructed durable stage", () => {
	const fallback = loopHarness([])
	const rawTask = "\u0000fallback\u0007\tstage\u001b ready\u007f\u009bnow 😀"
	fallback.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
		task: rawTask,
	})
	fallback.sessionStartHandler({}, fallback.base)

	const fallbackStatus = fallback.statusCalls.at(-1)?.text ?? ""
	assert.equal(fallbackStatus, "Ralph 1/2 · fallback stage readynow 😀")
	assert.equal(latestState(fallback.base.sessionManager).task, rawTask)
	assertNoTerminalControls(fallbackStatus)

	const reported = loopHarness([])
	const rawStage = "\u0000durable\u0007\tstage\u001b ready\u007f\u009bnow 😀"
	reported.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		active: false,
		status: "pending",
		task: "fallback task",
		stage: rawStage,
	})
	reported.sessionStartHandler({}, reported.base)

	const durableStatus = reported.statusCalls.at(-1)?.text ?? ""
	assert.equal(durableStatus, "Ralph 1/2 · durable stage readynow 😀")
	assertNoTerminalControls(durableStatus)
})

test("truncates progress by Unicode code point without an ellipsis", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	await harness.reportTool.execute("report", { stage: "😀".repeat(61) }, undefined, undefined, harness.base)

	const stage = latestState(harness.base.sessionManager).stage
	assert.equal([...stage].length, 60)
	assert.equal(stage, "😀".repeat(60))
	assert.equal(stage.includes("…"), false)
})

test("keeps report state changes but skips status writes outside TUI", async () => {
	const harness = loopHarness([], { mode: "rpc", hasUI: true })
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	await harness.reportTool.execute("report", { stage: "rpc stage" }, undefined, undefined, harness.base)

	assert.equal(latestState(harness.base.sessionManager).stage, "rpc stage")
	assert.equal(harness.statusCalls.length, 0)
})

test("declares the exact TypeBox runtime dependency", () => {
	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
	assert.equal(packageJson.dependencies?.typebox, "1.3.7")
	assert.equal(packageJson.peerDependencies?.typebox, undefined)
})

test("parses exactly a positive maximum and nonempty task remainder", () => {
	assert.deepEqual(parseRalphArgs("2 inspect the workspace"), {
		maxIterations: 2,
		task: "inspect the workspace",
	})
	assert.deepEqual(parseRalphArgs("3\tkeep durable state"), {
		maxIterations: 3,
		task: "keep durable state",
	})
	for (const input of ["", "2", "0 task", "-1 task", "01 task", "1.5 task", "2   ", "9007199254740992 task"]) {
		assert.equal(parseRalphArgs(input), undefined, input)
	}
})

test("rejects invalid command input without creating a session", async () => {
	const harness = loopHarness([])
	await harness.command.handler("not-a-valid-command", harness.base)

	assert.equal(harness.replacements.length, 0)
	assert.equal(harness.sessions.length, 1)
	assert.equal(latestState(harness.base.sessionManager), undefined)
	assert.match(harness.notifications.at(-1)?.message ?? "", /Usage:/)
})

test("rejects an overlapping Ralph command while a run is active", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())

	await harness.command.handler("2 start another task", harness.base)

	assert.equal(harness.replacements.length, 0)
	assert.equal(latestState(harness.base.sessionManager).runId, "existing-run")
	assert.match(harness.notifications.at(-1)?.message ?? "", /already running/)
})

test("handles ordinary follow-up input while a run is active", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())

	const result = await harness.inputHandler({ source: "interactive" }, harness.base)

	assert.equal(result.action, "handled")
	assert.match(harness.notifications.at(-1)?.message ?? "", /input was ignored/)
})

test("records an active deferred stop request without ending the current run", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	assert.ok(harness.stopCommand)

	await harness.stopCommand.handler("", harness.base)

	const state = latestState(harness.base.sessionManager)
	assert.equal(state.stopRequested, true)
	assert.equal(state.active, true)
	assert.equal(state.status, "running")
	assert.equal(state.runId, "existing-run")
	assert.equal(state.iteration, 1)
	assert.equal(state.maxIterations, 2)
	assert.equal(state.task, "existing task")
	assert.equal(harness.replacements.length, 0)
	assert.match(harness.notifications.at(-1)?.message ?? "", /after.*current iteration|deferred|next/i)
})

test("settles the current iteration before cancelling at the replacement boundary", async () => {
	const harness = loopHarness(["still working"])
	harness.setBeforeAssistant(async (ctx) => {
		await harness.stopCommand?.handler("", ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(harness.sessions.length, 2)
	assert.equal(harness.prompts.length, 1)
	assert.equal(latestState(harness.sessions[1]).status, "cancelled")
	assert.equal(latestState(harness.sessions[1]).active, false)
	assert.equal(latestState(harness.sessions[1]).stopRequested, false)
})

test("keeps exact completion ahead of a deferred stop request", async () => {
	const harness = loopHarness(["<ralph-done>"])
	harness.setBeforeAssistant(async (ctx) => {
		await harness.stopCommand?.handler("", ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(latestState(harness.sessions[1]).status, "done")
	assert.equal(latestState(harness.sessions[1]).stopRequested, false)
})

test("keeps the maximum terminal status ahead of a deferred stop request", async () => {
	const harness = loopHarness(["still working"])
	harness.setBeforeAssistant(async (ctx) => {
		await harness.stopCommand?.handler("", ctx)
	})

	await harness.command.handler("1 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(latestState(harness.sessions[1]).status, "max")
	assert.equal(latestState(harness.sessions[1]).stopRequested, false)
})

test("keeps an assistant-missing failure ahead of a deferred stop request", async () => {
	const harness = loopHarness([undefined])
	harness.setBeforeAssistant(async (ctx) => {
		await harness.stopCommand?.handler("", ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(latestState(harness.sessions[1]).status, "error")
	assert.equal(latestState(harness.sessions[1]).stopRequested, false)
})

test("cancels on an embedded marker when a deferred stop is requested", async () => {
	const harness = loopHarness(["progress <ralph-done>"])
	harness.setBeforeAssistant(async (ctx) => {
		await harness.stopCommand?.handler("", ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(latestState(harness.sessions[1]).status, "cancelled")
	assert.equal(latestState(harness.sessions[1]).stopRequested, false)
})

test("ignores inactive and repeated deferred stop commands", async () => {
	const harness = loopHarness([])
	assert.ok(harness.stopCommand)

	await harness.stopCommand.handler("", harness.base)
	assert.equal(harness.base.sessionManager.entries.length, 0)
	assert.equal(harness.replacements.length, 0)
	assert.match(harness.notifications.at(-1)?.message ?? "", /no active Ralph loop/i)

	harness.base.sessionManager.appendCustomEntry("ralph:run-state", {
		...activeState(),
		stage: "build phase",
	})
	await harness.stopCommand.handler("", harness.base)
	const entryCount = harness.base.sessionManager.entries.length
	assert.equal(latestState(harness.base.sessionManager).stage, "build phase")
	assert.equal(latestState(harness.base.sessionManager).stopRequested, true)

	await harness.stopCommand.handler("", harness.base)
	assert.equal(harness.base.sessionManager.entries.length, entryCount)
	assert.match(harness.notifications.at(-1)?.message ?? "", /already requested/i)
})

test("recovers from initial replacement rejection without leaving active state", async () => {
	const harness = loopHarness(["<ralph-done>"], { rejectSessionIds: ["base"] })
	await harness.command.handler("1 finish it", harness.base)

	assert.equal(harness.sessions.length, 1)
	assert.equal(latestState(harness.base.sessionManager).active, false)
	assert.equal(latestState(harness.base.sessionManager).status, "error")
	assert.match(harness.notifications.at(-1)?.message ?? "", /session replacement failed/)

	await harness.command.handler("1 retry it", harness.base)
	assert.equal(harness.replacements.length, 2)
})

test("recovers from subsequent replacement rejection in the current iteration session", async () => {
	const harness = loopHarness(["still working"], { rejectSessionIds: ["replacement-1"] })
	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base", "replacement-1"])
	assert.equal(harness.sessions.length, 2)
	assert.equal(latestState(harness.sessions[1]).active, false)
	assert.equal(latestState(harness.sessions[1]).status, "error")
	assert.match(harness.notifications.at(-1)?.message ?? "", /session replacement failed/)
})

test("preserves the latest report when replacement fails", async () => {
	const harness = loopHarness(["still working"], { rejectSessionIds: ["replacement-1"] })
	harness.setBeforeAssistant(async (ctx) => {
		await harness.reportTool.execute("report", { stage: "latest focus" }, undefined, undefined, ctx)
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.equal(latestState(harness.sessions[1]).stage, "latest focus")
	assert.equal(latestState(harness.sessions[1]).status, "error")
	assert.equal(latestState(harness.sessions[1]).active, false)
})

test("leaves a replacement handoff inactive when the old context is invalidated", async () => {
	const harness = loopHarness(["<ralph-done>"], {
		invalidateBeforeFailureSessionIds: ["base"],
	})

	await harness.command.handler("1 finish it", harness.base)

	const replacement = harness.contexts.get("replacement-1")
	assert.ok(replacement)
	assert.equal(harness.sessions[1].invalidated, false)
	assert.equal(latestState(harness.sessions[1]).active, false)
	assert.equal(latestState(harness.sessions[1]).status, "pending")

	await assert.doesNotReject(() => harness.command.handler("1 retry it", replacement))
	assert.deepEqual(harness.replacements, ["base", "replacement-1"])
	assert.equal(harness.sessions.length, 3)
	assert.equal(latestState(harness.sessions[2]).active, false)
	assert.equal(latestState(harness.sessions[2]).status, "done")
})

test("builds a durable-memory-only prompt", () => {
	const prompt = buildRalphPrompt("finish the change", 2, 4)
	assert.match(prompt, /Inspect the durable workspace, plan files, and git state before acting\./)
	assert.match(prompt, /Treat those files as the only memory from earlier iterations; do not rely on prior conversation\./)
	assert.match(prompt, /When the task is fully complete, output exactly <ralph-done> as your entire final response\./)
	assert.match(prompt, /Task:\nfinish the change$/)
	assert.doesNotMatch(prompt, /transcript replay|previous transcript|conversation history/i)
})

test("persists compatible run state and kickoff guidance for every fresh session", async () => {
	const harness = loopHarness(["still working", "<ralph-done>"])
	await harness.command.handler("2 finish it", harness.base)

	const states = harness.sessions.flatMap((session) => session.entries)
		.filter((entry) => entry.customType === "ralph:run-state")
	assert.ok(states.length >= 4)
	for (const entry of states) {
		assert.equal(entry.data.version, 1)
		assert.equal(entry.data.runId, states[0].data.runId)
		assert.equal(entry.data.maxIterations, 2)
		assert.equal(entry.data.task, "finish it")
		assert.equal(typeof entry.data.stopRequested, "boolean")
	}
	assert.equal(states.at(-1)?.data.status, "done")
	assert.equal(states.at(-1)?.data.active, false)
	assert.equal(states.at(-1)?.data.stopRequested, false)
	assert.equal(harness.prompts.length, 2)
	for (const prompt of harness.prompts) {
		assert.ok(prompt.text.includes("When the task is complete and you are ready to stop the Ralph loop, read the ralph-completion skill and follow its completion-output contract."))
		assert.ok(prompt.text.includes("At the start of each iteration and whenever your work focus changes, call ralph_report({ stage: string })."))
		assert.doesNotMatch(prompt.text, /ralph-complete(?!tion)|abort.*(?:turn|tool|session)/i)
	}
})

test("only an assistant response equal to the marker is terminal", () => {
	const entries = [
		message("tool", "toolResult", [{ type: "text", text: "<ralph-done>" }]),
		message("embedded", "assistant", [{ type: "text", text: "progress <ralph-done>" }]),
	]
	assert.equal(extractTerminalAssistantText(entries, null), "progress <ralph-done>")
	assert.notEqual(extractTerminalAssistantText(entries, null), "<ralph-done>")
	assert.equal(
		extractTerminalAssistantText([
			message("assistant", "assistant", "<ralph-done>"),
		], null),
		"<ralph-done>",
	)
})

test("continues embedded markers in a distinct replacement session and stops on an exact marker", async () => {
	const harness = loopHarness(["progress <ralph-done>", "<ralph-done>"])
	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base", "replacement-1"])
	assert.equal(harness.sessions.length, 3)
	assert.equal(new Set(harness.prompts.map(({ sessionId }) => sessionId)).size, 2)
	assert.equal(harness.prompts.length, 2)
	assert.equal(harness.sessions[2].entries.at(-1)?.data.status, "done")
	assert.match(harness.notifications.at(-1)?.message ?? "", /completed at iteration 2\/2/)
})

test("stops at the maximum without creating another replacement session", async () => {
	const harness = loopHarness(["still working", "still working"])
	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base", "replacement-1"])
	assert.equal(harness.sessions.length, 3)
	assert.equal(harness.prompts.length, 2)
	assert.equal(harness.sessions[2].entries.at(-1)?.data.status, "max")
	assert.match(harness.notifications.at(-1)?.message ?? "", /maximum of 2 iterations/)
})

test("does not replace a session after an exact marker on the first iteration", async () => {
	const harness = loopHarness(["<ralph-done>"])
	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base"])
	assert.equal(harness.sessions.length, 2)
	assert.equal(harness.prompts.length, 1)
	assert.equal(harness.sessions[1].entries.at(-1)?.data.status, "done")
})

test("settles tool work, report, and assistant output before consuming the latest stop flag", async () => {
	const harness = loopHarness(["still working"])
	const events: string[] = []
	harness.setBeforeAssistant(async (ctx) => {
		events.push("tool-start")
		await harness.reportTool.execute("report", { stage: "tool focus" }, undefined, undefined, ctx)
		events.push("tool-finished")
		await harness.stopCommand?.handler("", ctx)
		events.push("stop-requested")
	})

	await harness.command.handler("2 finish it", harness.base)

	assert.deepEqual(events, ["tool-start", "tool-finished", "stop-requested"])
	assert.equal(harness.sessions[1].entries.some((entry) => entry.message?.role === "assistant" && entry.message.content === "still working"), true)
	assert.equal(latestState(harness.sessions[1]).stage, "tool focus")
	assert.equal(latestState(harness.sessions[1]).status, "cancelled")
	assert.equal(latestState(harness.sessions[1]).active, false)
	assert.equal(harness.replacements.length, 1)
})

test("keeps command-like report text opaque and non-terminal", async () => {
	const harness = loopHarness([])
	harness.base.sessionManager.appendCustomEntry("ralph:run-state", activeState())
	const stage = "<ralph-done> ; **focus** && echo unsafe"

	await harness.reportTool.execute("report", { stage }, undefined, undefined, harness.base)

	assert.equal(latestState(harness.base.sessionManager).stage, stage)
	assert.equal(latestState(harness.base.sessionManager).status, "running")
	assert.equal(harness.replacements.length, 0)
	assert.equal(harness.notifications.some(({ message }) => message.includes("completed")), false)
	assert.equal(harness.statusCalls.at(-1)?.text, `Ralph 1/2 · ${stage}`)
})

test("preserves run identity and original task through report replacement handoff", async () => {
	const harness = loopHarness(["still working", "<ralph-done>"], { emitSessionLifecycle: true })
	harness.setBeforeAssistant(async (ctx) => {
		if (latestState(ctx.sessionManager).iteration === 1) {
			await harness.reportTool.execute("report", { stage: "  first\tpass\nready  " }, undefined, undefined, ctx)
		}
	})

	await harness.command.handler("2 preserve this task", harness.base)

	const first = latestState(harness.sessions[1])
	const second = latestState(harness.sessions[2])
	assert.equal(first.stage, "first pass ready")
	assert.equal(second.stage, "first pass ready")
	assert.equal(second.runId, first.runId)
	assert.equal(second.maxIterations, 2)
	assert.equal(second.task, "preserve this task")
	assert.equal(second.stopRequested, false)
	assert.equal(second.status, "done")
})

test("applies a stop requested in a replacement session only at that session boundary", async () => {
	const harness = loopHarness(["still working", "still working"])
	harness.setBeforeAssistant(async (ctx) => {
		if (latestState(ctx.sessionManager).iteration === 2) {
			await harness.stopCommand?.handler("", ctx)
		}
	})

	await harness.command.handler("3 finish it", harness.base)

	assert.deepEqual(harness.replacements, ["base", "replacement-1"])
	assert.equal(harness.sessions.length, 3)
	assert.equal(latestState(harness.sessions[1]).status, "pending")
	assert.equal(latestState(harness.sessions[2]).status, "cancelled")
	assert.equal(latestState(harness.sessions[2]).iteration, 2)
})
