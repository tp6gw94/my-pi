import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type {
	ExtensionAPI,
	ExtensionContext,
	ReplacedSessionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"

const RUN_STATE_TYPE = "ralph:run-state"
const RUN_STATE_VERSION = 1
const COMPLETION_MARKER = "<ralph-done>"
const SKILLS_DIR = fileURLToPath(new URL("./skills", import.meta.url))

type RunStatus = "pending" | "running" | "done" | "max" | "error" | "cancelled" | "session-shutdown"

export interface RalphArgs {
	maxIterations: number
	task: string
}

export interface RalphRunState {
	version: typeof RUN_STATE_VERSION
	runId: string
	maxIterations: number
	iteration: number
	task: string
	active: boolean
	status: RunStatus
}

type IterationResult =
	| { kind: "ok"; text: string }
	| { kind: "missing-assistant" }
	| { kind: "unexpected-input" }

interface SessionStateWriter {
	appendCustomEntry(customType: string, data?: unknown): string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRunStatus(value: unknown): value is RunStatus {
	return value === "pending" || value === "running" || value === "done" || value === "max" || value === "error" ||
		value === "cancelled" || value === "session-shutdown"
}

function parseRunState(data: unknown): RalphRunState | undefined {
	if (!isRecord(data)) return undefined
	if (
		data.version !== RUN_STATE_VERSION ||
		typeof data.runId !== "string" ||
		typeof data.maxIterations !== "number" ||
		!Number.isSafeInteger(data.maxIterations) ||
		data.maxIterations < 1 ||
		typeof data.iteration !== "number" ||
		!Number.isSafeInteger(data.iteration) ||
		data.iteration < 0 ||
		typeof data.task !== "string" ||
		typeof data.active !== "boolean" ||
		!isRunStatus(data.status)
	) {
		return undefined
	}
	return {
		version: RUN_STATE_VERSION,
		runId: data.runId,
		maxIterations: data.maxIterations,
		iteration: data.iteration,
		task: data.task,
		active: data.active,
		status: data.status,
	}
}

export function parseRalphArgs(args: string): RalphArgs | undefined {
	const input = args.trim()
	const separator = input.search(/\s/)
	if (separator < 1) return undefined

	const maxText = input.slice(0, separator)
	const task = input.slice(separator).trim()
	if (!/^[1-9]\d*$/.test(maxText) || !task) return undefined

	const maxIterations = Number(maxText)
	if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) return undefined
	return { maxIterations, task }
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block): block is { type: "text"; text: string } =>
			isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("")
}

function entryMessage(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined
	return entry.message
}

function entriesAfter(entries: readonly SessionEntry[], parentId: string | null): readonly SessionEntry[] {
	if (!parentId) return entries
	const parentIndex = entries.findIndex((entry) => entry.id === parentId)
	return parentIndex < 0 ? entries : entries.slice(parentIndex + 1)
}

export function extractTerminalAssistantText(
	entries: readonly SessionEntry[],
	parentId: string | null,
): string | undefined {
	const assistants = entriesAfter(entries, parentId)
		.map((entry) => entryMessage(entry))
		.filter((message): message is Record<string, unknown> => message?.role === "assistant")
	if (assistants.length === 0) return undefined
	return contentText(assistants[assistants.length - 1].content)
}

function inspectIteration(
	entries: readonly SessionEntry[],
	parentId: string | null,
	kickoff: string,
): IterationResult {
	const afterKickoffParent = entriesAfter(entries, parentId)
	const messages = afterKickoffParent
		.map((entry) => ({ entry, message: entryMessage(entry) }))
		.filter((item): item is { entry: SessionEntry; message: Record<string, unknown> } => !!item.message)
	const users = messages.filter(({ message }) => message.role === "user")
	if (users.length !== 1 || contentText(users[0]?.message.content) !== kickoff) {
		return { kind: "unexpected-input" }
	}

	const kickoffIndex = afterKickoffParent.findIndex((entry) => entry.id === users[0].entry.id)
	const terminalText = extractTerminalAssistantText(afterKickoffParent.slice(kickoffIndex), null)
	return terminalText === undefined ? { kind: "missing-assistant" } : { kind: "ok", text: terminalText }
}

let reconstructedState: RalphRunState | undefined

function latestRunState(ctx: Pick<ExtensionContext, "sessionManager">): RalphRunState | undefined {
	let latest: RalphRunState | undefined
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== RUN_STATE_TYPE) continue
		const state = parseRunState(entry.data)
		if (state) latest = state
	}
	reconstructedState = latest
	return reconstructedState
}

function appendRunState(sessionManager: SessionStateWriter, state: RalphRunState): void {
	sessionManager.appendCustomEntry(RUN_STATE_TYPE, state)
}

function appendRunStateToContext(ctx: Pick<ExtensionContext, "sessionManager">, state: RalphRunState): void {
	appendRunState(ctx.sessionManager as unknown as SessionStateWriter, state)
}

function pendingState(state: RalphRunState): RalphRunState {
	return { ...state, active: false, status: "pending" }
}

function tryAppendRunStateToContext(ctx: Pick<ExtensionContext, "sessionManager">, state: RalphRunState): void {
	try {
		appendRunStateToContext(ctx, state)
	} catch {
		// The context may have been invalidated by session replacement.
	}
}

function tryNotify(
	ctx: Pick<ExtensionContext, "ui">,
	message: string,
	level: "info" | "warning" | "error",
): void {
	try {
		notify(ctx, message, level)
	} catch {
		// The context may have been invalidated by session replacement.
	}
}

export function buildRalphPrompt(task: string, iteration: number, maxIterations: number): string {
	return [
		`Ralph iteration ${iteration} of ${maxIterations}.`,
		"Work on the task below.",
		"",
		"Inspect the durable workspace, plan files, and git state before acting.",
		"Treat those files as the only memory from earlier iterations; do not rely on prior conversation.",
		"Implement one focused increment, validate it, and leave durable progress for the next iteration.",
		`When the task is fully complete, output exactly ${COMPLETION_MARKER} as your entire final response. Do not include any other text with that marker.`,
		"Otherwise, report concise progress without using that marker as the entire response.",
		"",
		"Task:",
		task,
	].join("\n")
}

function inactiveState(state: RalphRunState, status: Exclude<RunStatus, "running">): RalphRunState {
	return { ...state, active: false, status }
}

function notify(ctx: Pick<ExtensionContext, "ui">, message: string, level: "info" | "warning" | "error"): void {
	ctx.ui.notify(message, level)
}

async function runFreshIteration(
	ctx: ReplacedSessionContext,
	state: RalphRunState,
	iteration: number,
): Promise<void> {
	const active = { ...state, iteration, active: true, status: "running" as const }
	try {
		appendRunStateToContext(ctx, active)
		await runIteration(ctx, active, iteration)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		tryAppendRunStateToContext(ctx, inactiveState(active, "error"))
		tryNotify(ctx, `Ralph stopped: ${message}`, "error")
	}
}

async function runIteration(
	ctx: ReplacedSessionContext,
	state: RalphRunState,
	iteration: number,
): Promise<void> {
	const kickoff = buildRalphPrompt(state.task, iteration, state.maxIterations)
	const parentId = ctx.sessionManager.getLeafId()

	try {
		await ctx.sendUserMessage(kickoff)
		await ctx.waitForIdle()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "error"))
		notify(ctx, `Ralph stopped: ${message}`, "error")
		return
	}

	const result = inspectIteration(ctx.sessionManager.getBranch(), parentId, kickoff)
	if (result.kind === "unexpected-input") {
		appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "error"))
		notify(ctx, "Ralph stopped: an unexpected same-session input was detected.", "error")
		return
	}
	if (result.kind === "missing-assistant") {
		appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "error"))
		notify(ctx, "Ralph stopped: no terminal assistant response was recorded.", "error")
		return
	}

	if (result.text === COMPLETION_MARKER) {
		appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "done"))
		notify(ctx, `Ralph completed at iteration ${iteration}/${state.maxIterations}.`, "info")
		return
	}
	if (iteration >= state.maxIterations) {
		appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "max"))
		notify(ctx, `Ralph reached the maximum of ${state.maxIterations} iterations.`, "info")
		return
	}

	const nextState = pendingState({ ...state, iteration: iteration + 1 })
	appendRunStateToContext(ctx, nextState)
	try {
		const replacement = await ctx.newSession({
			setup: async (sessionManager) => {
				appendRunState(sessionManager, nextState)
			},
			withSession: async (nextCtx) => {
				await runFreshIteration(nextCtx, nextState, iteration + 1)
			},
		})
		if (replacement.cancelled) {
			appendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "cancelled"))
			notify(ctx, "Ralph stopped: the next session replacement was cancelled.", "error")
		}
	} catch {
		tryAppendRunStateToContext(ctx, inactiveState({ ...state, iteration }, "error"))
		tryNotify(ctx, "Ralph stopped: session replacement failed.", "error")
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }))

	pi.on("session_start", (_event, ctx) => {
		latestRunState(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		const state = latestRunState(ctx)
		if (!state?.active) return
		pi.appendEntry(RUN_STATE_TYPE, inactiveState(state, "session-shutdown"))
	})

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !latestRunState(ctx)?.active) {
			return { action: "continue" as const }
		}
		if (ctx.hasUI) notify(ctx, "Ralph is running; input was ignored.", "warning")
		return { action: "handled" as const }
	})

	pi.registerCommand("ralph", {
		description: "Run a bounded Ralph loop in fresh Pi sessions",
		handler: async (args, ctx) => {
			const parsed = parseRalphArgs(args)
			if (!parsed) {
				notify(ctx, "Usage: /ralph <positive-integer> <task>", "warning")
				return
			}

			const existing = latestRunState(ctx)
			if (existing?.active) {
				notify(ctx, "A Ralph loop is already running.", "warning")
				return
			}

			const state: RalphRunState = {
				version: RUN_STATE_VERSION,
				runId: randomUUID(),
				maxIterations: parsed.maxIterations,
				iteration: 0,
				task: parsed.task,
				active: false,
				status: "pending",
			}
			appendRunStateToContext(ctx, state)
			notify(ctx, `Ralph started: up to ${state.maxIterations} fresh sessions.`, "info")

			const firstState = pendingState({ ...state, iteration: 1 })
			try {
				const replacement = await ctx.newSession({
					setup: async (sessionManager) => {
						appendRunState(sessionManager, firstState)
					},
					withSession: async (nextCtx) => {
						await runFreshIteration(nextCtx, firstState, 1)
					},
				})
				if (replacement.cancelled) {
					appendRunStateToContext(ctx, inactiveState(state, "cancelled"))
					notify(ctx, "Ralph stopped: the first session replacement was cancelled.", "error")
				}
			} catch {
				tryAppendRunStateToContext(ctx, inactiveState(state, "error"))
				tryNotify(ctx, "Ralph stopped: session replacement failed.", "error")
			}
		},
	})
}
