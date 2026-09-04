import assert from "node:assert/strict"
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
	outputs: string[],
	options: { rejectSessionIds?: string[]; invalidateBeforeFailureSessionIds?: string[] } = {},
) {
	const sessions = [new FakeSession("base")]
	const contexts = new Map<string, any>()
	const replacements: string[] = []
	const prompts: { sessionId: string; text: string }[] = []
	const notifications: { message: string; level: string }[] = []
	const rejectedSessionIds = new Set(options.rejectSessionIds ?? [])
	const invalidateBeforeFailureSessionIds = new Set(options.invalidateBeforeFailureSessionIds ?? [])
	let outputIndex = 0
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined
	let inputHandler: ((event: any, ctx: any) => Promise<any>) | undefined
	let resourceHandler: (() => { skillPaths: string[] }) | undefined

	function context(session: FakeSession): any {
		const value = {
			hasUI: true,
			ui: {
				notify(messageText: string, level: string) {
					if (session.invalidated) throw new Error("stale UI context")
					notifications.push({ message: messageText, level })
				},
			},
			sessionManager: session,
			async sendUserMessage(text: string) {
				assert.equal(session.invalidated, false)
				prompts.push({ sessionId: session.id, text })
				session.entries.push(message(`${session.id}-user`, "user", text))
				const output = outputs[outputIndex++]
				assert.notEqual(output, undefined)
				session.entries.push(message(`${session.id}-assistant`, "assistant", output))
			},
			async waitForIdle() {},
			async newSession(options: any) {
				assert.equal(session.invalidated, false)
				replacements.push(session.id)
				if (rejectedSessionIds.has(session.id)) throw new Error("replacement rejected")
				const next = new FakeSession(`replacement-${sessions.length}`)
				sessions.push(next)
				contexts.set(next.id, context(next))
				await options.setup(next)
				if (invalidateBeforeFailureSessionIds.has(session.id)) {
					session.invalidated = true
					throw new Error("replacement failed after teardown")
				}
				await options.withSession(contexts.get(next.id))
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
			if (eventName === "resources_discover") resourceHandler = handler
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
			assert.equal(name, "ralph")
			command = definition
		},
	}
	ralph(pi)
	assert.ok(command)
	assert.ok(resourceHandler)

	return {
		base,
		contexts,
		command: command!,
		inputHandler: inputHandler!,
		notifications,
		prompts,
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

test("discovers the bundled completion skill", () => {
	const { skillPaths } = loopHarness([]).resourceHandler()
	assert.equal(skillPaths.length, 1)
	assert.match(skillPaths[0] ?? "", /ralph\/skills$/)
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
