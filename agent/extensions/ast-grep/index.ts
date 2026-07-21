// Thin AST-grep extension for pi — AST-structured code search/rewrite.
// Requires: sg on PATH (brew install ast-grep).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type, type Static, type TSchema } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

// ── Constants ───────────────────────────────────────────────────────────────

export const CLI_LANGUAGES = [
	"bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html",
	"java", "javascript", "json", "kotlin", "lua", "nix", "php", "python",
	"ruby", "rust", "scala", "solidity", "swift", "typescript", "tsx", "yaml",
] as const

const TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 1_024_000
const MAX_MATCHES = 500

const INSTALL_HINT = [
	"ast-grep (sg) binary not found.",
	"",
	"Install options:",
	"  brew install ast-grep",
	"  npm install -g @ast-grep/cli",
	"  cargo install ast-grep --locked",
].join("\n")

// ── Types ───────────────────────────────────────────────────────────────────

export type CliLanguage = (typeof CLI_LANGUAGES)[number]

export interface Position {
	line: number
	column: number
}

export interface Range {
	start: Position
	end: Position
}

export interface CliMatch {
	text: string
	range: Range & { byteOffset: { start: number; end: number } }
	file: string
	lines: string
	charCount: { leading: number; trailing: number }
	language: string
}

export type SgTruncationReason = "max_matches" | "max_output_bytes" | "timeout"

export interface SgResult {
	matches: CliMatch[]
	totalMatches: number
	truncated: boolean
	truncatedReason?: SgTruncationReason
	error?: string
}

export interface RunSgOptions {
	pattern: string
	lang: CliLanguage
	paths?: string[]
	globs?: string[]
	rewrite?: string
	context?: number
	updateAll?: boolean
}

// ── Binary probe ────────────────────────────────────────────────────────────

export function findSgPath(): string | null {
	const pathEnv = process.env.PATH ?? ""
	for (const dir of pathEnv.split(path.delimiter)) {
		const candidate = path.join(dir, "sg")
		if (existsSync(candidate)) return candidate
	}
	for (const p of ["/opt/homebrew/bin/sg", "/usr/local/bin/sg"]) {
		if (existsSync(p)) return p
	}
	return null
}

// ── CLI args builder ────────────────────────────────────────────────────────

export function buildSgArgs(options: RunSgOptions, includeUpdateAll: boolean): string[] {
	const isWritePass = options.updateAll === true && !includeUpdateAll
	const args = ["run", "-p", options.pattern, "--lang", options.lang]

	if (!isWritePass) {
		args.push("--json=compact")
	}

	if (options.rewrite) {
		args.push("-r", options.rewrite)
		if (includeUpdateAll) {
			args.push("--update-all")
		}
	}

	if (options.context && options.context > 0) {
		args.push("-C", String(options.context))
	}

	if (options.globs) {
		for (const glob of options.globs) {
			args.push("--globs", glob)
		}
	}

	const paths = options.paths && options.paths.length > 0 ? options.paths : ["."]
	args.push(...paths)

	return args
}

// ── Process runner ──────────────────────────────────────────────────────────

interface ProcessOutput {
	stdout: string
	stderr: string
	exitCode: number
}

async function collectOutput(proc: ChildProcess, timeoutMs: number): Promise<ProcessOutput> {
	let stdout = ""
	let stderr = ""

	proc.stdout?.setEncoding("utf-8")
	proc.stderr?.setEncoding("utf-8")

	proc.stdout?.on("data", (chunk: string) => { stdout += chunk })
	proc.stderr?.on("data", (chunk: string) => { stderr += chunk })

	const exitCode = await new Promise<number>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null

		timer = setTimeout(() => {
			proc.kill("SIGTERM")
			setTimeout(() => {
				if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL")
			}, 1000)
			reject(new Error(`Timeout after ${timeoutMs}ms`))
		}, timeoutMs)

		proc.once("close", (code) => {
			if (timer) clearTimeout(timer)
			resolve(code ?? 0)
		})
		proc.once("error", (err) => {
			if (timer) clearTimeout(timer)
			reject(err)
		})
	})

	return { stdout, stderr, exitCode }
}

// ── JSON parsing ────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isNumberPair(v: unknown): v is { start: number; end: number } {
	return isRecord(v) && typeof v.start === "number" && typeof v.end === "number"
}

function isPosition(v: unknown): v is { line: number; column: number } {
	return isRecord(v) && typeof v.line === "number" && typeof v.column === "number"
}

function isCliMatch(v: unknown): v is CliMatch {
	if (!isRecord(v)) return false
	const range = v.range
	const charCount = v.charCount
	if (!isRecord(range) || !isRecord(charCount)) return false
	const byteOffset = range.byteOffset
	return (
		typeof v.text === "string" &&
		typeof v.file === "string" &&
		typeof v.lines === "string" &&
		typeof charCount.leading === "number" &&
		typeof charCount.trailing === "number" &&
		typeof v.language === "string" &&
		isRecord(byteOffset) &&
		isNumberPair(byteOffset) &&
		isPosition(range.start) &&
		isPosition(range.end)
	)
}

function parseSgJson(stdout: string): SgResult {
	if (!stdout.trim()) {
		return { matches: [], totalMatches: 0, truncated: false }
	}

	const outputTruncated = stdout.length >= MAX_OUTPUT_BYTES
	const toParse = outputTruncated ? stdout.slice(0, MAX_OUTPUT_BYTES) : stdout

	let matches: CliMatch[] = []
	try {
		const parsed: unknown = JSON.parse(toParse)
		if (Array.isArray(parsed)) {
			matches = parsed.filter(isCliMatch)
		}
	} catch {
		return {
			matches: [],
			totalMatches: 0,
			truncated: outputTruncated,
			truncatedReason: outputTruncated ? "max_output_bytes" : undefined,
			error: outputTruncated ? "Output too large and could not be parsed" : undefined,
		}
	}

	const totalMatches = matches.length
	const matchesTruncated = totalMatches > MAX_MATCHES
	const finalMatches = matchesTruncated ? matches.slice(0, MAX_MATCHES) : matches

	const truncatedReason = outputTruncated ? "max_output_bytes" : matchesTruncated ? "max_matches" : undefined

	return {
		matches: finalMatches,
		totalMatches,
		truncated: outputTruncated || matchesTruncated,
		...(truncatedReason ? { truncatedReason } : {}),
	}
}

// ── Run SG ──────────────────────────────────────────────────────────────────

export async function runSg(options: RunSgOptions): Promise<SgResult> {
	const sgPath = findSgPath()
	if (!sgPath) {
		return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT }
	}

	const shouldSeparateWritePass = !!(options.rewrite && options.updateAll)
	const readOptions = shouldSeparateWritePass ? { ...options, updateAll: false } : options
	const args = buildSgArgs(readOptions, !shouldSeparateWritePass)

	let stdout: string
	let stderr: string
	let exitCode: number

	try {
		const output = await collectOutput(spawn(sgPath, args, { stdio: ["ignore", "pipe", "pipe"] }), TIMEOUT_MS)
		stdout = output.stdout
		stderr = output.stderr
		exitCode = output.exitCode
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("timeout") || msg.includes("Timeout")) {
			return { matches: [], totalMatches: 0, truncated: true, truncatedReason: "timeout", error: msg }
		}
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT }
		}
		return { matches: [], totalMatches: 0, truncated: false, error: `Failed to spawn ast-grep: ${msg}` }
	}

	if (exitCode !== 0 && stdout.trim() === "") {
		if (stderr.includes("No files found")) {
			return { matches: [], totalMatches: 0, truncated: false }
		}
		if (stderr.trim()) {
			return { matches: [], totalMatches: 0, truncated: false, error: stderr.trim() }
		}
		return { matches: [], totalMatches: 0, truncated: false }
	}

	const jsonResult = parseSgJson(stdout)

	if (shouldSeparateWritePass && jsonResult.matches.length > 0) {
		const writeArgs = buildSgArgs(options, false)
		writeArgs.push("--update-all")

		try {
			const writeOutput = await collectOutput(
				spawn(sgPath, writeArgs, { stdio: ["ignore", "pipe", "pipe"] }),
				TIMEOUT_MS,
			)
			if (writeOutput.exitCode !== 0) {
				const errDetail = writeOutput.stderr.trim() || `ast-grep exited with code ${writeOutput.exitCode}`
				return { ...jsonResult, error: `Replace failed: ${errDetail}` }
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return { ...jsonResult, error: `Replace failed: ${msg}` }
		}
	}

	return jsonResult
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSearchResult(result: SgResult): string {
	if (result.error) return `Error: ${result.error}`
	if (result.matches.length === 0) return "No matches found"

	const lines: string[] = []

	if (result.truncated) {
		const why = result.truncatedReason === "max_matches"
			? `showing first ${result.matches.length} of ${result.totalMatches}`
			: result.truncatedReason === "max_output_bytes"
				? "output exceeded 1MB limit"
				: "search timed out"
		lines.push(`[TRUNCATED] Results truncated (${why})\n`)
	}

	lines.push(`Found ${result.matches.length} match(es)${result.truncated ? ` (truncated from ${result.totalMatches})` : ""}:\n`)

	for (const match of result.matches) {
		const loc = `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
		lines.push(`${loc}`)
		lines.push(`  ${match.lines.trim()}`)
		lines.push("")
	}

	return lines.join("\n")
}

export function formatReplaceResult(result: SgResult, isDryRun: boolean): string {
	if (result.error) return `Error: ${result.error}`
	if (result.matches.length === 0) return "No matches found to replace"

	const prefix = isDryRun ? "[DRY RUN] " : ""
	const lines: string[] = []

	if (result.truncated) {
		const why = result.truncatedReason === "max_matches"
			? `showing first ${result.matches.length} of ${result.totalMatches}`
			: result.truncatedReason === "max_output_bytes"
				? "output exceeded 1MB limit"
				: "search timed out"
		lines.push(`[TRUNCATED] Results truncated (${why})\n`)
	}

	lines.push(`${prefix}${result.matches.length} replacement(s):\n`)

	for (const match of result.matches) {
		const loc = `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
		lines.push(`${loc}`)
		lines.push(`  ${match.text}`)
		lines.push("")
	}

	if (isDryRun) lines.push("Use dryRun=false to apply changes")

	return lines.join("\n")
}

// ── Tool definitions ────────────────────────────────────────────────────────

function isCliLanguage(value: unknown): value is CliLanguage {
	return typeof value === "string" && CLI_LANGUAGES.includes(value as CliLanguage)
}

const SearchParams = Type.Object({
	pattern: Type.String({
		description: "AST pattern with meta-variables ($VAR, $$$). Must be a complete AST node.",
	}),
	lang: StringEnum(CLI_LANGUAGES, { description: "Target language" }),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Paths to search (default: current working directory)",
		}),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Include/exclude globs (prefix ! to exclude)",
		}),
	),
	context: Type.Optional(Type.Number({ description: "Number of context lines around each match" })),
})

const ReplaceParams = Type.Object({
	pattern: Type.String({ description: "AST pattern to match" }),
	rewrite: Type.String({ description: "Replacement pattern (use $VAR from pattern)" }),
	lang: StringEnum(CLI_LANGUAGES, { description: "Target language" }),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to search" })),
	globs: Type.Optional(Type.Array(Type.String(), { description: "Include/exclude globs" })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without applying (default: true)" })),
})

const ast_grep_search = defineTool({
	name: "ast_grep_search",
	label: "AST Grep Search",
	description:
		"Search code patterns across the filesystem using AST-aware matching. " +
		"Use meta-variables: $VAR (single node), $$$ (multiple nodes). " +
		"Patterns must be complete AST nodes (valid code). " +
		"Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'function $NAME($$$) { $$$ }'.",
	promptSnippet: "Search code by AST structure across 25 languages using $VAR and $$$ meta-variables (NOT regex).",
	promptGuidelines: [
		"Use ast_grep_search instead of grep when the pattern depends on code structure (function/class/import/call shape).",
		"Use grep instead of ast_grep_search for plain text or cross-language regex search.",
		"Run multiple ast_grep_search calls in parallel when checking different patterns.",
	],
	parameters: SearchParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!isCliLanguage(params.lang)) {
			return {
				content: [{ type: "text", text: `Unsupported language: ${String(params.lang)}` }],
				details: undefined,
			}
		}

		const paths = params.paths && params.paths.length > 0 ? params.paths : [ctx.cwd]
		const options: RunSgOptions = { pattern: params.pattern, lang: params.lang, paths }
		if (params.globs !== undefined) options.globs = params.globs
		if (params.context !== undefined) options.context = params.context
		const result = await runSg(options)

		return {
			content: [{ type: "text", text: formatSearchResult(result) }],
			details: {
				pattern: params.pattern,
				lang: params.lang,
				paths,
				globs: params.globs,
				matches: result.matches,
				totalMatches: result.totalMatches,
				truncated: result.truncated,
				truncatedReason: result.truncatedReason,
				error: result.error,
			},
		}
	},
})

const ast_grep_replace = defineTool({
	name: "ast_grep_replace",
	label: "AST Grep Replace",
	description:
		"Replace code patterns across the filesystem with AST-aware rewriting. " +
		"Dry-run by default. Use meta-variables in `rewrite` to preserve matched content. " +
		"Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'.",
	promptSnippet: "Rewrite code by AST pattern across 25 languages. Dry-run by default; pass dryRun=false to apply.",
	promptGuidelines: [
		"Use ast_grep_replace dryRun=true first to preview changes; only set dryRun=false after confirming match list.",
		"Use ast_grep_replace instead of edit when the rewrite spans many files with the same structural pattern.",
	],
	parameters: ReplaceParams,
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!isCliLanguage(params.lang)) {
			return {
				content: [{ type: "text", text: `Unsupported language: ${String(params.lang)}` }],
				details: undefined,
			}
		}

		const paths = params.paths && params.paths.length > 0 ? params.paths : [ctx.cwd]
		const dryRun = params.dryRun !== false
		const options: RunSgOptions = {
			pattern: params.pattern,
			rewrite: params.rewrite,
			lang: params.lang,
			paths,
			updateAll: !dryRun,
		}
		if (params.globs !== undefined) options.globs = params.globs
		const result = await runSg(options)

		return {
			content: [{ type: "text", text: formatReplaceResult(result, dryRun) }],
			details: {
				pattern: params.pattern,
				rewrite: params.rewrite,
				lang: params.lang,
				paths,
				globs: params.globs,
				dryRun,
				matches: result.matches,
				totalMatches: result.totalMatches,
				truncated: result.truncated,
				truncatedReason: result.truncatedReason,
				error: result.error,
			},
		}
	},
})

// ── Default export ──────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const sgPath = findSgPath()
	if (!sgPath) {
		console.warn("[ast-grep] sg binary not found on PATH — extension disabled")
		return
	}

	try {
		const ver = await pi.exec(sgPath, ["--version"], { timeout: 5_000 })
		if (ver.code !== 0) {
			console.warn("[ast-grep] sg binary at", sgPath, "failed version check — extension disabled")
			return
		}
		console.log("[ast-grep] sg detected:", ver.stdout.trim())
	} catch {
		console.warn("[ast-grep] sg binary at", sgPath, "failed to execute — extension disabled")
		return
	}

	pi.registerTool(ast_grep_search)
	pi.registerTool(ast_grep_replace)
}

// ── Self-test ───────────────────────────────────────────────────────────────

if (process.env.AST_GREP_SELF_TEST) {
	const sgPath = findSgPath()
	console.log("findSgPath:", sgPath)
	if (sgPath) {
		const args = buildSgArgs({ pattern: "console.log($MSG)", lang: "javascript", paths: [import.meta.dirname ?? "."] }, true)
		console.log("buildSgArgs:", args.join(" "))
		runSg({ pattern: "console.log($MSG)", lang: "javascript", paths: [import.meta.dirname ?? "."] }).then((r) => {
			console.log("runSg result matches:", r.matches.length, "error:", r.error)
		})
	}
}
