import { access, constants } from "node:fs/promises";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	type InputEventResult,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	SelectList,
	isKeyRelease,
	isKeyRepeat,
	type AutocompleteProvider,
	type EditorTheme,
	type Keybinding,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

type Skill = Readonly<{ name: string; path: string; description?: string }>;
type Token = Readonly<{ start: number; end: number; query: string }>;
type Reference = Readonly<{ name: string; path: string; spelling: string; start: number; end: number }>;
type Ticket = Readonly<{
	submitted: string;
	editorText: string;
	restoreText: string;
	references: readonly Reference[];
	revision: number;
	generation: number;
}>;
type Notify = (message: string, level: "info" | "warning" | "error") => void;

const OPAQUE_ACTIONS: readonly Keybinding[] = [
	"tui.editor.undo",
	"tui.editor.historyPrevious",
	"tui.editor.historyNext",
	"tui.editor.yank",
	"tui.editor.yankPop",
];

const BACKSPACE_CONFLICTS: readonly Keybinding[] = [
	"tui.input.tab",
	"tui.editor.deleteToLineEnd",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
];

function offsetFrom(lines: readonly string[], line: number, col: number): number {
	let offset = 0;
	for (let index = 0; index < line && index < lines.length; index++) {
		offset += (lines[index] ?? "").length + 1;
	}

	return offset + col;
}

function escapeAttribute(value: string): string {
	const escapedAmpersands = value.replaceAll("&", "&amp;");
	const escapedQuotes = escapedAmpersands.replaceAll('"', "&quot;");
	return escapedQuotes.replaceAll("<", "&lt;");
}

class InlineSkillsSession {
	editor: InlineSkillsEditor | null = null;
	notify: Notify = () => {};
	generation = 0;
	private tickets: Ticket[] = [];

	registerEditor(editor: InlineSkillsEditor): void {
		this.editor = editor;
	}

	capture(ticket: Ticket): Ticket {
		this.tickets.push(ticket);
		return ticket;
	}

	remove(ticket: Ticket): void {
		const index = this.tickets.indexOf(ticket);
		if (index >= 0) {
			this.tickets.splice(index, 1);
		}
	}

	take(text: string): { kind: "match" | "mismatch"; ticket: Ticket } | { kind: "none" } {
		const index = this.tickets.findIndex((ticket) => ticket.submitted === text);
		if (index >= 0) {
			const ticket = this.tickets[index]!;
			this.tickets.splice(index, 1);
			return { kind: "match", ticket };
		}

		const pendingIndex = this.tickets.findIndex((ticket) => ticket.references.length > 0);
		if (pendingIndex >= 0) {
			const ticket = this.tickets[pendingIndex]!;
			this.tickets.splice(pendingIndex, 1);
			return { kind: "mismatch", ticket };
		}

		return { kind: "none" };
	}

	restore(ticket: Ticket, editor: InlineSkillsEditor | null): void {
		if (ticket.generation !== this.generation) return;
		if (!editor || this.editor !== editor) {
			this.notify("inline-skills：草稿已更換，未覆蓋；請重新輸入。", "warning");
			return;
		}

		if (editor.restoreDraft(ticket)) return;
		this.notify("inline-skills：草稿已有新內容，未覆蓋；請重新輸入。", "warning");
	}

	dispose(): void {
		this.editor = null;
		this.tickets = [];
		this.generation++;
	}
}

class InlineSkillsEditor extends CustomEditor {
	private readonly pi: ExtensionAPI;
	private readonly session: InlineSkillsSession;
	private readonly kb: KeybindingsManager;
	private readonly listTheme: SelectListTheme;
	private readonly blockingProvider: AutocompleteProvider = {
		triggerCharacters: [],
		shouldTriggerFileCompletion: () => false,
		getSuggestions: () => Promise.resolve(null),
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	};
	private refs: Reference[] = [];
	private token: Token | null = null;
	private list: SelectList | null = null;
	private suppressedKey: string | null = null;
	private accepting = false;
	private restoring = false;
	private knownClear = false;
	private pasteActive = false;
	private revision = 0;
	private recovery: { text: string; references: readonly Reference[]; revision: number } | null = null;
	private activeSnapshot: {
		editorText: string;
		restoreText: string;
		references: readonly Reference[];
		revision: number;
		generation: number;
		usedRecovery: boolean;
	} | null = null;
	private lastCaptured: Ticket | null = null;
	private capturedRecovery = false;
	private submitArmed = false;
	private suppressSubmitCapture = false;
	private submitCaptured = false;
	private nativeProvider: AutocompleteProvider | null = null;
	private providerBlocked = false;
	private warnedNoTransport = false;
	private lastText: string;
	private lastPos: number;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		kb: KeybindingsManager,
		pi: ExtensionAPI,
		session: InlineSkillsSession,
	) {
		super(tui, theme, kb);
		this.pi = pi;
		this.session = session;
		this.kb = kb;
		this.listTheme = theme.selectList;
		this.lastText = this.getText();
		const cursor = this.getCursor();
		this.lastPos = offsetFrom(this.getLines(), cursor.line, cursor.col);
	}

	private catalog(): Map<string, Skill> {
		const catalog = new Map<string, Skill>();
		for (const command of this.pi.getCommands()) {
			if (command.source !== "skill") continue;
			const path = command.sourceInfo?.path;
			if (!path) continue;
			const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
			catalog.set(name, { name, path, description: command.description });
		}
		return catalog;
	}

	private tokenAt(): Token | null {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const text = lines.join("\n");
		if (/^\s*[/!]/.test(text)) {
			const nativeSkillName = /^\/skill:([^ \t\r\n]+) /.exec(text)?.[1];
			if (!nativeSkillName || !this.catalog().has(nativeSkillName)) return null;
		}
		const pos = offsetFrom(lines, cursor.line, cursor.col);
		if (pos > text.length) return null;

		let start = pos;
		while (start > 0 && !/\s/.test(text[start - 1]!)) {
			start--;
		}

		const raw = text.slice(start, pos);
		if (!raw.startsWith("/")) return null;
		if (raw.length > 1 && !/^[A-Za-z0-9-]+$/.test(raw.slice(1))) return null;
		if (raw.startsWith("/skill:")) return null;

		const next = text[pos];
		if (next !== undefined && !/\s/.test(next)) return null;
		if (start === text.search(/\S/)) return null;

		return { start, end: pos, query: raw.slice(1) };
	}

	private tokenKey(token: Token): string {
		return `${token.start}:${token.end}:${token.query}`;
	}

	private acceptTransport(): boolean {
		return this.kb.getKeys("tui.input.tab").length > 0 || this.kb.getKeys("tui.input.submit").length > 0;
	}

	private refreshItems(): void {
		const token = this.token;
		if (!token) {
			this.list = null;
			return;
		}

		const query = token.query.toLowerCase();
		const skills = [...this.catalog().values()]
			.filter((skill) => skill.name.toLowerCase().includes(query))
			.sort((a, b) => {
				const aPrefix = a.name.toLowerCase().startsWith(query) ? 0 : 1;
				const bPrefix = b.name.toLowerCase().startsWith(query) ? 0 : 1;
				return aPrefix - bPrefix || a.name.localeCompare(b.name);
			});
		if (skills.length === 0) {
			this.list = null;
			return;
		}

		const previous = this.list?.getSelectedItem()?.value;
		const items = skills.map((skill) => ({
			value: skill.name,
			label: skill.name,
			description: skill.description,
		}));
		const list = new SelectList(items, 6, this.listTheme);
		const index = previous ? items.findIndex((item) => item.value === previous) : -1;
		if (index >= 0) {
			list.setSelectedIndex(index);
		}

		this.list = list;
	}

	private syncProvider(): void {
		const blocked = this.token !== null;
		if (blocked === this.providerBlocked) return;
		const provider = this.nativeProvider;
		if (!provider) return;
		this.providerBlocked = blocked;
		super.setAutocompleteProvider(blocked ? this.blockingProvider : provider);
	}

	private sync(): void {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const text = lines.join("\n");
		const pos = offsetFrom(lines, cursor.line, cursor.col);
		if (text === this.lastText && pos === this.lastPos) return;

		this.lastText = text;
		this.lastPos = pos;
		const token = this.tokenAt();
		this.token = token;
		if (!token) {
			this.list = null;
			this.suppressedKey = null;
			this.syncProvider();
			return;
		}

		const key = this.tokenKey(token);
		if (this.suppressedKey === key) {
			this.list = null;
			this.syncProvider();
			return;
		}

		this.suppressedKey = null;
		if (!this.acceptTransport()) {
			this.list = null;
			if (!this.warnedNoTransport) {
				this.warnedNoTransport = true;
				this.session.notify("inline-skills：Tab 與 Enter 皆未綁定接受動作，行內技能候選停用。", "warning");
			}
			this.syncProvider();
			return;
		}

		this.refreshItems();
		this.syncProvider();
	}

	private dismiss(): void {
		if (this.token) {
			this.suppressedKey = this.tokenKey(this.token);
		}

		this.list = null;
	}

	private acceptKey(data: string): boolean {
		return this.kb.matches(data, "tui.input.tab") || this.kb.matches(data, "tui.input.submit");
	}

	private safeBackspace(): string | null {
		for (const candidate of ["\x7f", "\x08"]) {
			if (!this.kb.matches(candidate, "tui.editor.deleteCharBackward")) continue;
			if (BACKSPACE_CONFLICTS.some((action) => this.kb.matches(candidate, action))) continue;
			return candidate;
		}
		return null;
	}

	private accept(): void {
		const token = this.token;
		const list = this.list;
		if (!token || !list) return;

		const selected = list.getSelectedItem();
		const skill = selected ? this.catalog().get(selected.value) : undefined;
		if (!skill) {
			this.dismiss();
			return;
		}
		if (this.isShowingAutocomplete()) {
			this.dismiss();
			this.session.notify("inline-skills：原生候選清單開啟中，未接受行內技能。", "warning");
			return;
		}

		const cursor = this.getCursor();
		if (offsetFrom(this.getLines(), cursor.line, cursor.col) !== token.end) {
			this.dismiss();
			return;
		}

		const backspace = this.safeBackspace();
		if (!backspace) {
			this.session.notify("inline-skills：接受鍵與其他文字操作衝突，未插入技能引用。", "error");
			return;
		}

		const before = this.getText();
		const spelling = `/skill:${skill.name}`;
		const expected = before.slice(0, token.start) + spelling + " " + before.slice(token.end);
		this.accepting = true;
		try {
			for (let index = 0; index < token.end - token.start; index++) {
				Editor.prototype.handleInput.call(this, backspace);
			}
			this.insertTextAtCursor(`${spelling} `);
		} finally {
			this.accepting = false;
		}

		const after = this.getText();
		const afterCursor = this.getCursor();
		const expectedCursor = token.start + spelling.length + 1;
		if (after !== expected || offsetFrom(this.getLines(), afterCursor.line, afterCursor.col) !== expectedCursor) {
			this.refs = [];
			this.token = null;
			this.list = null;
			this.lastText = "\u0000";
			this.lastPos = -1;
			this.session.notify("inline-skills：接受替換未產生預期文字，已撤銷行內引用。", "error");
			return;
		}

		const delta = spelling.length + 1 - (token.end - token.start);
		const nextRefs: Reference[] = [];
		for (const reference of this.refs) {
			if (reference.end <= token.start) {
				nextRefs.push(reference);
				continue;
			}
			if (reference.start >= token.end) {
				const shifted = { ...reference, start: reference.start + delta, end: reference.end + delta };
				if (after.slice(shifted.start, shifted.end) === shifted.spelling) {
					nextRefs.push(shifted);
				}
			}
		}

		nextRefs.push({
			name: skill.name,
			path: skill.path,
			spelling,
			start: token.start,
			end: token.start + spelling.length,
		});
		this.refs = nextRefs;
		this.token = null;
		this.list = null;
		this.suppressedKey = null;
		this.lastText = after;
		this.lastPos = expectedCursor;
		this.syncProvider();
	}

	private bumpRevision(): void {
		this.revision++;
		this.recovery = null;
	}

	private makeSnapshot(): NonNullable<InlineSkillsEditor["activeSnapshot"]> {
		const editorText = this.getText();
		const restoreText = this.getExpandedText();
		const recovery = this.recovery;
		const usedRecovery =
			recovery !== null && recovery.revision === this.revision && restoreText === recovery.text;
		const references = usedRecovery
			? recovery.references
			: this.refs.filter((reference) => editorText.slice(reference.start, reference.end) === reference.spelling);
		return {
			editorText,
			restoreText,
			references,
			revision: this.revision,
			generation: this.session.generation,
			usedRecovery,
		};
	}

	armSubmitCapture(): void {
		const native = this.onSubmit;
		if (!native || this.submitArmed) return;
		this.submitArmed = true;
		this.onSubmit = (text: string) => {
			this.captureSubmitted(text);
			native(text);
		};
	}

	private captureSubmitted(text: string): void {
		if (this.suppressSubmitCapture) return;
		const snapshot = this.activeSnapshot;
		if (!snapshot) return;
		if (text.trim() === "" && snapshot.references.length === 0) return;
		this.lastCaptured = this.session.capture({
			submitted: text,
			editorText: snapshot.editorText,
			restoreText: snapshot.restoreText,
			references: snapshot.references,
			revision: snapshot.revision,
			generation: snapshot.generation,
		});
		this.capturedRecovery = snapshot.usedRecovery;
		this.submitCaptured = true;
	}

	private captureFollowUp(): { ticket: Ticket; usedRecovery: boolean } | null {
		const snapshot = this.makeSnapshot();
		const submitted = snapshot.restoreText.trim();
		if (submitted === "" && snapshot.references.length === 0) return null;
		return {
			ticket: this.session.capture({
				submitted,
				editorText: snapshot.editorText,
				restoreText: snapshot.restoreText,
				references: snapshot.references,
				revision: snapshot.revision,
				generation: snapshot.generation,
			}),
			usedRecovery: snapshot.usedRecovery,
		};
	}

	private nativePriority(data: string): boolean {
		if (this.onExtensionShortcut?.(data)) return true;

		if (this.kb.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}

		if (this.kb.matches(data, "app.interrupt")) {
			if (this.list && this.token) {
				this.dismiss();
				return true;
			}
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
				return false;
			}
			Editor.prototype.handleInput.call(this, data);
			return true;
		}

		if (this.kb.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return true;
			}
		}

		if (this.kb.matches(data, "tui.editor.historyPrevious") || this.kb.matches(data, "tui.editor.historyNext")) {
			this.refs = [];
			this.dismiss();
			Editor.prototype.handleInput.call(this, data);
			this.bumpRevision();
			return true;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action === "app.interrupt" || action === "app.exit") continue;
			if (!this.kb.matches(data, action)) continue;
			const followUp = action === "app.message.followUp";
			const captured = followUp ? this.captureFollowUp() : null;
			if (followUp) {
				this.knownClear = true;
				this.suppressSubmitCapture = true;
			}
			try {
				handler();
			} finally {
				if (followUp) {
					this.knownClear = false;
					this.suppressSubmitCapture = false;
				}
			}
			if (captured && this.getText() !== "") {
				this.session.remove(captured.ticket);
			} else if (captured?.usedRecovery) {
				this.recovery = null;
			}
			return true;
		}

		return false;
	}

	private reconcile(before: string, beforeOffset: number, after: string, afterOffset: number): void {
		if (this.refs.length === 0 || before === after) return;

		const delta = after.length - before.length;
		let start = -1;
		let end = -1;
		if (delta > 0) {
			const candidate = beforeOffset;
			if (before.slice(0, candidate) === after.slice(0, candidate) && before.slice(candidate) === after.slice(candidate + delta)) {
				start = candidate;
				end = candidate;
			}
		} else if (delta < 0) {
			const candidate = afterOffset;
			const removed = -delta;
			if (
				before.slice(0, candidate) === after.slice(0, candidate) &&
				before.slice(candidate + removed) === after.slice(candidate)
			) {
				start = candidate;
				end = candidate + removed;
			}
		}

		if (start < 0) {
			this.refs = [];
			this.dismiss();
			return;
		}

		const next: Reference[] = [];
		for (const reference of this.refs) {
			if (reference.end <= start) {
				next.push(reference);
				continue;
			}
			if (reference.start >= end) {
				const shifted = { ...reference, start: reference.start + delta, end: reference.end + delta };
				if (after.slice(shifted.start, shifted.end) === shifted.spelling) {
					next.push(shifted);
				}
			}
		}

		this.refs = next;
	}

	override handleInput(data: string): void {
		this.sync();
		if (this.nativePriority(data)) return;

		const release = isKeyRelease(data);
		const repeat = isKeyRepeat(data);
		const pasting = this.pasteActive || data.includes("\x1b[200~");
		const beforeLines = this.getLines();
		const cursorBefore = this.getCursor();
		const before = beforeLines.join("\n");
		const beforeOffset = offsetFrom(beforeLines, cursorBefore.line, cursorBefore.col);

		if (this.list && this.token && !pasting) {
			if (this.acceptKey(data)) {
				if (!release && !repeat) {
					this.accept();
				}
				return;
			}
			if (this.kb.matches(data, "tui.select.cancel")) {
				this.dismiss();
				return;
			}
			if (
				this.kb.matches(data, "tui.select.up") ||
				this.kb.matches(data, "tui.select.down") ||
				this.kb.matches(data, "tui.select.pageUp") ||
				this.kb.matches(data, "tui.select.pageDown")
			) {
				this.list.handleInput(data);
				this.tui.requestRender();
				return;
			}
			if (data === " ") {
				this.dismiss();
			}
		}

		const opaque =
			pasting ||
			data.includes("\x1b[201~") ||
			OPAQUE_ACTIONS.some((action) => this.kb.matches(data, action));
		const historyCandidate =
			(this.kb.matches(data, "tui.editor.cursorUp") && cursorBefore.line === 0) ||
			(this.kb.matches(data, "tui.editor.cursorDown") && cursorBefore.line === beforeLines.length - 1);

		this.activeSnapshot = this.makeSnapshot();
		this.submitCaptured = false;
		this.lastCaptured = null;
		this.capturedRecovery = false;
		Editor.prototype.handleInput.call(this, data);
		this.activeSnapshot = null;
		if (data.includes("\x1b[200~")) this.pasteActive = true;
		if (data.includes("\x1b[201~")) this.pasteActive = false;

		if (this.submitCaptured && this.getText() !== "") {
			if (this.lastCaptured) this.session.remove(this.lastCaptured);
			this.submitCaptured = false;
		}

		const afterLines = this.getLines();
		const cursorAfter = this.getCursor();
		const after = afterLines.join("\n");
		const afterOffset = offsetFrom(afterLines, cursorAfter.line, cursorAfter.col);

		if (opaque || historyCandidate) {
			this.refs = [];
			this.dismiss();
		} else if (after !== before) {
			this.reconcile(before, beforeOffset, after, afterOffset);
		}

		const submitClear = this.submitCaptured && after === "" && after !== before;
		if (submitClear && this.capturedRecovery) this.recovery = null;
		if ((after !== before || opaque || historyCandidate) && !submitClear) {
			this.bumpRevision();
		}
		this.submitCaptured = false;
		this.lastCaptured = null;
		this.capturedRecovery = false;

		this.sync();
	}

	override setText(text: string): void {
		if (!this.restoring) {
			this.refs = [];
			this.dismiss();
		}

		super.setText(text);
		if (!this.knownClear && !this.restoring) {
			this.bumpRevision();
		}
	}

	override insertTextAtCursor(text: string): void {
		const before = this.getText();
		if (!this.accepting && !this.restoring) {
			this.refs = [];
		}

		super.insertTextAtCursor(text);
		if (!this.accepting && !this.restoring && this.getText() !== before) {
			this.bumpRevision();
		}
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.nativeProvider = provider;
		this.providerBlocked = false;
		super.setAutocompleteProvider(provider);
		this.syncProvider();
	}

	override render(width: number): string[] {
		this.sync();
		const lines = super.render(width);
		if (this.list) {
			lines.push(...this.list.render(width));
		}

		return lines;
	}

	restoreDraft(ticket: Ticket): boolean {
		if (this.revision !== ticket.revision) return false;
		if (this.getText() !== "") return false;

		this.restoring = true;
		try {
			super.setText(ticket.restoreText);
		} finally {
			this.restoring = false;
		}

		this.refs = [];
		this.recovery = { text: ticket.restoreText, references: ticket.references, revision: this.revision };
		this.token = null;
		this.list = null;
		this.suppressedKey = null;
		this.lastText = "\u0000";
		this.lastPos = -1;
		this.syncProvider();
		return true;
	}
}

async function expandInput(
	event: InputEvent,
	ctx: ExtensionContext,
	session: InlineSkillsSession,
): Promise<InputEventResult> {
	if (event.source !== "interactive") return { action: "continue" };

	const editor = session.editor;
	const generation = session.generation;
	const taken = session.take(event.text);
	if (taken.kind === "none") return { action: "continue" };
	if (taken.kind === "mismatch") {
		ctx.ui.notify("inline-skills：提交內容與已選技能不符，已阻擋送出。", "error");
		session.restore(taken.ticket, editor);
		return { action: "handled" };
	}

	const ticket = taken.ticket;
	if (ticket.references.length === 0) return { action: "continue" };

	try {
		const seen = new Set<string>();
		if (event.text.startsWith("/skill:")) {
			const nativeSkillSpace = event.text.indexOf(" ");
			if (nativeSkillSpace !== -1) seen.add(event.text.slice("/skill:".length, nativeSkillSpace));
		}
		const entries: string[] = [];
		for (const reference of ticket.references) {
			if (seen.has(reference.name)) continue;
			seen.add(reference.name);
			await access(reference.path, constants.R_OK);
			if (session.generation !== generation) return { action: "handled" };
			entries.push(`<skill name="${escapeAttribute(reference.name)}" location="${escapeAttribute(reference.path)}" />`);
		}

		if (session.generation !== generation) return { action: "handled" };
		if (entries.length === 0) return { action: "continue" };
		const block = [
			"<selected_skills>",
			"The user selected these skills for this message. Before acting, use the read tool to load each skill file, and resolve relative paths in a skill against its directory.",
			...entries,
			"</selected_skills>",
		].join("\n");
		return { action: "transform", text: `${event.text}\n\n${block}` };
	} catch (error) {
		if (session.generation !== generation) return { action: "handled" };
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`inline-skills：讀取技能失敗（${message}），已阻擋送出。`, "error");
		session.restore(ticket, editor);
		return { action: "handled" };
	}
}

export default function inlineSkills(pi: ExtensionAPI): void {
	const session = new InlineSkillsSession();
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (ctx.ui.getEditorComponent()) {
			ctx.ui.notify("inline-skills：已有其他 extension 設定編輯器，未安裝。", "warning");
			return;
		}

		session.notify = (message, level) => ctx.ui.notify(message, level);
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new InlineSkillsEditor(tui, theme, kb, pi, session);
			session.registerEditor(editor);
			return editor;
		});
		session.editor?.armSubmitCapture();
	});

	pi.on("input", (event, ctx) => expandInput(event, ctx, session));
	pi.on("session_shutdown", () => session.dispose());
}
