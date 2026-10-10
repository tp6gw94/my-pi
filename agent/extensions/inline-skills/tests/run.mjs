import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const EVIDENCE = process.env.EVIDENCE ?? "/tmp/pi-inline-skills-20261008/evidence/implementation";
const PI_ROOT = process.env.PI_ROOT ?? "/Users/todd/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/1.1.0/lib/node_modules/@earendil-works/pi-coding-agent";
const TUI_PATH = join(PI_ROOT, "node_modules/@earendil-works/pi-tui/dist/index.js");
const PKG_PATH = join(PI_ROOT, "dist/index.js");
const KEYBINDINGS_PATH = join(PI_ROOT, "dist/core/keybindings.js");

const tui = await import(TUI_PATH);
const core = await import(PKG_PATH);
const coreKeybindings = await import(KEYBINDINGS_PATH);
const require = createRequire(join(PI_ROOT, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
	virtualModules: {
		"@earendil-works/pi-tui": tui,
		"@earendil-works/pi-coding-agent": core,
	},
});
const extension = await jiti.import(join(ROOT, "index.ts"));

const failures = [];
function check(name, condition, detail = "") {
	if (condition) {
		console.log(`ok - ${name}`);
		return;
	}
	failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
	console.log(`not ok - ${name}${detail ? ` :: ${detail}` : ""}`);
}

const HOW_PATH = join(EVIDENCE, "fixtures/how/SKILL.md");
const WHY_PATH = join(EVIDENCE, "fixtures/why/SKILL.md");

function fixtures() {
	mkdirSync(join(EVIDENCE, "fixtures/how"), { recursive: true });
	mkdirSync(join(EVIDENCE, "fixtures/why"), { recursive: true });
	writeFileSync(
		join(EVIDENCE, "fixtures/how/SKILL.md"),
		"---\nname: how\ndescription: how fixture\n---\n\nHOW-BODY\n",
	);
	writeFileSync(
		join(EVIDENCE, "fixtures/why/SKILL.md"),
		"---\nname: why\ndescription: why fixture\n---\n\nWHY-BODY\n",
	);
	return [
		{ name: "skill:how", description: "how fixture", source: "skill", sourceInfo: { path: join(EVIDENCE, "fixtures/how/SKILL.md") } },
		{ name: "skill:why", description: "why fixture", source: "skill", sourceInfo: { path: join(EVIDENCE, "fixtures/why/SKILL.md") } },
		{ name: "skill:missing", description: "missing fixture", source: "skill", sourceInfo: { path: join(EVIDENCE, "fixtures/missing/SKILL.md") } },
		{ name: "reload", description: "builtin", source: "extension", sourceInfo: { path: "builtin:reload" } },
	];
}

function harness(commands) {
	const handlers = {};
	const notifications = [];
	const submits = [];
	let editor;
	let restoreOnSubmit = false;
	const kb = coreKeybindings.KeybindingsManager.create(join(EVIDENCE, "no-config"));
	tui.setKeybindings(kb);
	const theme = {
		borderColor: (value) => value,
		selectList: {
			selectedPrefix: (value) => value,
			selectedText: (value) => value,
			description: (value) => value,
			scrollInfo: (value) => value,
			noMatch: (value) => value,
		},
	};
	const fakeTui = { requestRender: () => {}, setFocus: () => {}, terminal: { rows: 40, columns: 120 } };
	const pi = {
		on(event, handler) {
			handlers[event] = handler;
			return () => {};
		},
		getCommands: () => commands,
	};
	extension.default(pi);
	const ctx = {
		mode: "tui",
		ui: {
			getEditorComponent: () => undefined,
			setEditorComponent: (factory) => {
				editor = factory(fakeTui, theme, kb);
				editor.onSubmit = (text) => {
					submits.push(text);
					if (restoreOnSubmit) editor.setText(text);
				};
			},
			notify: (message, level) => notifications.push([message, level]),
		},
	};
	handlers.session_start({ type: "session_start" }, ctx);
	const runInput = async (text, streamingBehavior) =>
		handlers.input({ type: "input", text, source: "interactive", streamingBehavior }, ctx);
	return {
		handlers,
		notifications,
		editor,
		submits,
		runInput,
		kb,
		setRestoreOnSubmit: (value) => {
			restoreOnSubmit = value;
		},
	};
}

const commands = fixtures();
const app = harness(commands);
const editor = app.editor;

editor.setText("請用 /ho");
const popupLines = editor.render(80);
check("popup lists matching skill", popupLines.some((line) => line.includes("how fixture")));
check("popup filters out non-matching skill", !popupLines.some((line) => line.includes("why fixture")));

editor.handleInput("w");
check("typing filters inline query", editor.getText() === "請用 /how");
check("filtered popup still visible", editor.render(80).some((line) => line.includes("how fixture")));

editor.handleInput("\x1b");
check("escape dismisses popup without changing text", editor.getText() === "請用 /how");
check("escape leaves no popup", !editor.render(80).some((line) => line.includes("how fixture")));

editor.handleInput(" ");
check("space dismisses popup and types space", editor.getText() === "請用 /how ");
check("space leaves no popup", !editor.render(80).some((line) => line.includes("how fixture")));

editor.setText("hi /zzz");
check("no match hides popup", !editor.render(80).some((line) => line.includes("how fixture")));

editor.setText("hi /how");
editor.handleInput("\t");
check("tab accepts without submit", app.submits.length === 0, JSON.stringify(app.submits));
check("tab inserts skill spelling with trailing space", editor.getText() === "hi /skill:how ", JSON.stringify(editor.getText()));
check("tab closes popup", !editor.render(80).some((line) => line.includes("why fixture")));

editor.setText("先 /wh");
editor.handleInput("\r");
check("enter accepts without submit", app.submits.length === 0);
check("enter inserts skill spelling", editor.getText() === "先 /skill:why ", JSON.stringify(editor.getText()));

editor.setText("中文😀 /ho");
editor.handleInput("\t");
check("unicode and mid-sentence text preserved on accept", editor.getText() === "中文😀 /skill:how ", JSON.stringify(editor.getText()));

editor.setText("before /how after");
editor.handleInput("\x01");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
editor.handleInput("\x1b[C");
check("cursor move into token dismisses popup", !editor.render(80).some((line) => line.includes("how fixture")));

const expansionApp = harness(commands);
const expansionEditor = expansionApp.editor;
expansionEditor.setText("請用 /how");
expansionEditor.handleInput("\t");
expansionEditor.handleInput("再 ");
expansionEditor.handleInput("/why");
expansionEditor.handleInput("\t");
expansionEditor.handleInput("\r");
const submitted = expansionApp.submits.at(-1);
check("submit captured full text", submitted === "請用 /skill:how 再 /skill:why", JSON.stringify(submitted));
const transformed = await expansionApp.runInput(submitted);
check("selected references expand to transform", transformed.action === "transform", JSON.stringify(transformed));
const text = transformed.text ?? "";
check("expansion keeps original sentence", text.startsWith("請用 /skill:how 再 /skill:why"));
check("expansion lists how skill path", text.includes(`<skill name="how" location="${HOW_PATH}" />`), text);
check("expansion lists why skill path", text.includes(`<skill name="why" location="${WHY_PATH}" />`), text);
check("expansion omits skill bodies", !text.includes("HOW-BODY") && !text.includes("WHY-BODY") && !text.includes("name: how"), text);
check("expansion asks agent to read skill files", text.includes("<selected_skills>") && text.includes("use the read tool"), text);
check("expansion appends exactly one entry per selected skill", text.split("<skill name=").length - 1 === 2);

const dedupeApp = harness(commands);
const dedupeEditor = dedupeApp.editor;
dedupeEditor.setText("a /how");
dedupeEditor.handleInput("\t");
dedupeEditor.handleInput("b /how");
dedupeEditor.handleInput("\t");
dedupeEditor.handleInput("\r");
const dedupeText = (await dedupeApp.runInput(dedupeApp.submits.at(-1))).text ?? "";
check("duplicate skill instruction deduplicated by name", dedupeText.split("<skill name=\"how\"").length - 1 === 1);

const literalApp = harness(commands);
const literalEditor = literalApp.editor;
literalEditor.setText("keep /how literal");
literalEditor.handleInput("\r");
const literalResult = await literalApp.runInput(literalApp.submits.at(-1));
check("unselected keyword stays literal", literalResult.action === "continue", JSON.stringify(literalResult));

const urlApp = harness(commands);
const urlEditor = urlApp.editor;
urlEditor.setText("see https://host/how");
check("url is not treated as inline token", !urlEditor.render(120).some((line) => line.includes("how fixture")));
urlEditor.setText("open /tmp/how");
check("path is not treated as inline token", !urlEditor.render(120).some((line) => line.includes("how fixture")));

const leadingApp = harness(commands);
const leadingEditor = leadingApp.editor;
leadingEditor.setText("/how");
check("leading slash stays native", !leadingEditor.render(120).some((line) => line.includes("how fixture")));

const leadingNativeApp = harness(commands);
const leadingNativeEditor = leadingNativeApp.editor;
leadingNativeEditor.setText("/skill:how use /wh");
const leadingNativePopup = leadingNativeEditor.render(120).some((line) => line.includes("why fixture"));
check("known leading native skill permits later inline suggestions", leadingNativePopup);
if (leadingNativePopup) {
	leadingNativeEditor.handleInput("\t");
	check("leading native skill accepts later skill without submitting", leadingNativeApp.submits.length === 0);
	leadingNativeEditor.handleInput("\n");
	leadingNativeEditor.handleInput("and /ho");
	check("later inline suggestions work on another line", leadingNativeEditor.render(120).some((line) => line.includes("how fixture")));
	leadingNativeEditor.handleInput("\t");
	leadingNativeEditor.handleInput("\r");
	const leadingNativeResult = await leadingNativeApp.runInput(leadingNativeApp.submits.at(-1));
	const nativeSkills = ["how", "why"].map((name) => ({
		name,
		filePath: join(EVIDENCE, `fixtures/${name}/SKILL.md`),
		baseDir: join(EVIDENCE, `fixtures/${name}`),
	}));
	const nativeExpanded = core.AgentSession.prototype._expandSkillCommand.call(
		{ resourceLoader: { getSkills: () => ({ skills: nativeSkills }) } },
		leadingNativeResult.text ?? "",
	);
	check(
		"native expansion loads leading skill body once and lists later skill path",
		nativeExpanded.split("HOW-BODY").length - 1 === 1 && !nativeExpanded.includes("WHY-BODY") && nativeExpanded.split(`location="${WHY_PATH}" />`).length - 1 === 1,
		nativeExpanded,
	);
	leadingNativeEditor.setText("new draft /wh");
	check("new draft shows inline suggestions after native skill", leadingNativeEditor.render(120).some((line) => line.includes("why fixture")));
}

const duplicateNativeApp = harness(commands);
const duplicateNativeEditor = duplicateNativeApp.editor;
duplicateNativeEditor.setText("/skill:how use /ho");
const duplicateNativePopup = duplicateNativeEditor.render(120).some((line) => line.includes("how fixture"));
check("repeated native skill shows later inline popup", duplicateNativePopup);
if (duplicateNativePopup) {
	duplicateNativeEditor.handleInput("\t");
	duplicateNativeEditor.handleInput("and /ho");
	check("repeated native skill shows duplicate inline popup", duplicateNativeEditor.render(120).some((line) => line.includes("how fixture")));
	duplicateNativeEditor.handleInput("\t");
	duplicateNativeEditor.handleInput("\r");
	const duplicateNativeSubmitted = duplicateNativeApp.submits.at(-1) ?? "";
	const duplicateNativeResult = await duplicateNativeApp.runInput(duplicateNativeSubmitted);
	const duplicateNativeExpanded = core.AgentSession.prototype._expandSkillCommand.call(
		{ resourceLoader: { getSkills: () => ({ skills: [{ name: "how", filePath: join(EVIDENCE, "fixtures/how/SKILL.md"), baseDir: join(EVIDENCE, "fixtures/how") }] }) } },
		duplicateNativeSubmitted,
	);
	check(
		"all inline duplicates leave native input untouched",
		duplicateNativeResult.action === "continue" && duplicateNativeResult.text === undefined && duplicateNativeSubmitted === "/skill:how use /skill:how and /skill:how",
		JSON.stringify({ result: duplicateNativeResult, submitted: duplicateNativeSubmitted }),
	);
	check(
		"native expansion loads repeated leading skill once",
		duplicateNativeExpanded.split("HOW-BODY").length - 1 === 1 && duplicateNativeExpanded.endsWith("use /skill:how and /skill:how"),
		duplicateNativeExpanded,
	);
}

const unreadableNativePath = join(EVIDENCE, "fixtures/missing/SKILL.md");
rmSync(unreadableNativePath, { force: true });
const unreadableNativeApp = harness(commands);
const unreadableNativeEditor = unreadableNativeApp.editor;
unreadableNativeEditor.setText("/skill:missing use /mis");
const unreadableNativePopup = unreadableNativeEditor.render(120).some((line) => line.includes("missing fixture"));
check("unreadable native skill permits matching inline popup", unreadableNativePopup);
if (unreadableNativePopup) {
	unreadableNativeEditor.handleInput("\t");
	unreadableNativeEditor.handleInput("\r");
}
const unreadableNativeSubmitted = unreadableNativeApp.submits.at(-1) ?? "";
const unreadableNativeResult = await unreadableNativeApp.runInput(unreadableNativeSubmitted);
const nativeErrors = [];
const nativeFallback = core.AgentSession.prototype._expandSkillCommand.call(
	{
		resourceLoader: { getSkills: () => ({ skills: [{ name: "missing", filePath: unreadableNativePath, baseDir: dirname(unreadableNativePath) }] }) },
		_extensionRunner: { emitError: (error) => nativeErrors.push(error) },
	},
	unreadableNativeSubmitted,
);
check(
	"unreadable native prefix stays Pi-owned",
	unreadableNativeResult.action === "continue" && unreadableNativeResult.text === undefined && !unreadableNativeApp.notifications.some(([message]) => message.includes("讀取技能失敗")),
	JSON.stringify({ result: unreadableNativeResult, notifications: unreadableNativeApp.notifications }),
);
check(
	"Pi native unreadable-skill fallback preserves original input",
	nativeFallback === unreadableNativeSubmitted && nativeErrors.some((error) => error.event === "skill_expansion"),
	JSON.stringify({ nativeFallback, nativeErrors }),
);

const revokeApp = harness(commands);
const revokeEditor = revokeApp.editor;
revokeEditor.setText("x /how");
revokeEditor.handleInput("\t");
revokeEditor.handleInput("y");
revokeEditor.handleInput("\r");
const shifted = await revokeApp.runInput(revokeApp.submits.at(-1));
check("reference survives harmless surrounding edit", shifted.action === "transform", JSON.stringify(shifted));

const undoApp = harness(commands);
const undoEditor = undoApp.editor;
undoEditor.setText("x /how");
undoEditor.handleInput("\t");
const undoData = ["\x1a", "\x1f", "\x1b[45;5u"].find((candidate) => undoApp.kb.matches(candidate, "tui.editor.undo"));
if (undoData) {
	undoEditor.handleInput(undoData);
} else {
	undoEditor.handleInput("\x1b[200~opaque\x1b[201~");
}
undoEditor.handleInput("\r");
const undone = await undoApp.runInput(undoApp.submits.at(-1));
check("undo or paste revokes references", undone.action === "continue", JSON.stringify(undone));

const externalApp = harness(commands);
const externalEditor = externalApp.editor;
externalEditor.setText("x /how");
externalEditor.handleInput("\t");
externalEditor.setText("x /skill:how ");
externalEditor.handleInput("\r");
const external = await externalApp.runInput(externalApp.submits.at(-1));
check("external setText revokes references", external.action === "continue", JSON.stringify(external));

const missingApp = harness(commands);
const missingEditor = missingApp.editor;
missingEditor.setText("x /missing");
missingEditor.handleInput("\t");
missingEditor.handleInput("\r");
const missing = await missingApp.runInput(missingApp.submits.at(-1));
check("read failure blocks submission", missing.action === "handled", JSON.stringify(missing));
check("read failure notifies visibly", missingApp.notifications.some(([message]) => message.includes("讀取技能失敗")));
check("read failure restores draft", missingEditor.getText() === "x /skill:missing ", JSON.stringify(missingEditor.getText()));
missingEditor.handleInput("\r");
check("retry captures a fresh ticket", missingApp.submits.length === 2);

const noRefsApp = harness(commands);
const noRefsResult = await noRefsApp.runInput("ordinary message");
check("input without ticket continues", noRefsResult.action === "continue", JSON.stringify(noRefsResult));
noRefsApp.handlers.session_shutdown({ type: "session_shutdown" }, {});
const afterShutdown = await noRefsApp.runInput("ordinary message");
check("input after shutdown continues", afterShutdown.action === "continue");

const plainApp = harness(commands);
plainApp.editor.setText("plain message");
plainApp.editor.handleInput("\r");
const plainResult = await plainApp.runInput(plainApp.submits.at(-1));
check("zero-reference ticket consumes and continues", plainResult.action === "continue", JSON.stringify(plainResult));

const noAutoApp = harness(commands);
noAutoApp.editor.setText("hi /ho");
noAutoApp.editor.handleInput("w");
check("ordinary typing never applies suggestion", noAutoApp.editor.getText() === "hi /how" && noAutoApp.submits.length === 0);
check("ordinary typing never inserts skill spelling", !noAutoApp.editor.getText().includes("/skill:"));

const midApp = harness(commands);
const midEditor = midApp.editor;
midEditor.setText("X /how");
midEditor.handleInput("\t");
midEditor.handleInput("\x01");
midEditor.handleInput("line1 /why");
midEditor.handleInput("\x1b[13;2~");
midEditor.handleInput("\x1b[D");
midEditor.handleInput("\t");
check(
	"midcursor accept shifts trailing reference",
	midEditor.getText() === "line1 /skill:why \nX /skill:how ",
	JSON.stringify(midEditor.getText()),
);
midEditor.handleInput("\r");
const midText = (await midApp.runInput(midApp.submits.at(-1))).text ?? "";
check("shifted trailing reference still expands", midText.includes(HOW_PATH) && midText.includes(WHY_PATH), midText);
check("midcursor accept keeps surrounding text", midText.split("\n")[0] === "line1 /skill:why " && midText.split("\n")[1].startsWith("X /skill:how"), JSON.stringify(midText));

const ctrlCApp = harness(commands);
ctrlCApp.editor.setText("hi /ho");
check("popup visible before ctrl+c", ctrlCApp.editor.render(80).some((line) => line.includes("how fixture")));
ctrlCApp.editor.handleInput("\x03");
check("ctrl+c leaves inline text untouched", ctrlCApp.editor.getText() === "hi /ho", JSON.stringify(ctrlCApp.editor.getText()));

const nativeApp = harness(commands);
nativeApp.editor.setText("x /how");
nativeApp.editor.isShowingAutocomplete = () => true;
nativeApp.editor.handleInput("\t");
check("native popup blocks inline accept", nativeApp.editor.getText() === "x /how", JSON.stringify(nativeApp.editor.getText()));
check("native popup refusal is visible", nativeApp.notifications.some(([message]) => message.includes("原生候選")));
delete nativeApp.editor.isShowingAutocomplete;

const followApp = harness(commands);
followApp.editor.onAction("app.message.followUp", () => {
	followApp.submits.push(followApp.editor.getExpandedText().trim());
	followApp.editor.setText("");
});
followApp.editor.setText("queue /how");
followApp.editor.handleInput("\t");
followApp.editor.handleInput("\x1b\r");
check("follow-up capture matches expanded text", followApp.submits.at(-1) === "queue /skill:how", JSON.stringify(followApp.submits));
const followResult = await followApp.runInput(followApp.submits.at(-1), "followUp");
check("follow-up submission expands selected skill", (followResult.text ?? "").includes(HOW_PATH), JSON.stringify(followResult));

const disabledApp = harness(commands);
disabledApp.editor.setText("x /how");
disabledApp.editor.handleInput("\t");
disabledApp.editor.disableSubmit = true;
disabledApp.editor.handleInput("\r");
check("disableSubmit leaves draft intact", disabledApp.editor.getText() === "x /skill:how ", JSON.stringify(disabledApp.editor.getText()));
const abortedResult = await disabledApp.runInput("unrelated later message");
check("aborted capture does not block later input", abortedResult.action === "continue", JSON.stringify(abortedResult));
disabledApp.editor.disableSubmit = false;
disabledApp.editor.handleInput("\r");
const reEnabled = await disabledApp.runInput(disabledApp.submits.at(-1));
check("submit after disableSubmit re-enables expansion", reEnabled.action === "transform", JSON.stringify(reEnabled));

const mismatchApp = harness(commands);
mismatchApp.editor.setText("x /how");
mismatchApp.editor.handleInput("\t");
mismatchApp.editor.handleInput("\r");
const mismatchResult = await mismatchApp.runInput("something else");
check("mismatched submission blocks visibly", mismatchResult.action === "handled", JSON.stringify(mismatchResult));
check("mismatch notification visible", mismatchApp.notifications.some(([message]) => message.includes("不符")));
const afterMismatch = await mismatchApp.runInput("later message");
check("mismatch ticket is consumed once", afterMismatch.action === "continue", JSON.stringify(afterMismatch));

const historyRevoke = harness(commands);
historyRevoke.editor.setText("x /how");
historyRevoke.editor.handleInput("\t");
historyRevoke.editor.addToHistory("x /skill:how OLD-LITERAL");
historyRevoke.editor.handleInput("\x01");
historyRevoke.editor.handleInput("\x1b[A");
check("up history replaces draft", historyRevoke.editor.getText() === "x /skill:how OLD-LITERAL", JSON.stringify(historyRevoke.editor.getText()));
historyRevoke.editor.handleInput("\r");
const historyRevokeResult = await historyRevoke.runInput(historyRevoke.submits.at(-1));
check("up history revokes selected reference", historyRevokeResult.action === "continue" && !(historyRevokeResult.text ?? "").includes(HOW_PATH), JSON.stringify(historyRevokeResult));

const sameTextHistory = harness(commands);
sameTextHistory.editor.setText("x /how");
sameTextHistory.editor.handleInput("\t");
sameTextHistory.editor.handleInput("\x7f");
sameTextHistory.editor.addToHistory("x /skill:how");
sameTextHistory.editor.handleInput("\x01");
sameTextHistory.editor.handleInput("\x1b[A");
check("same-text history keeps draft", sameTextHistory.editor.getText() === "x /skill:how", JSON.stringify(sameTextHistory.editor.getText()));
sameTextHistory.editor.handleInput("\r");
const sameTextResult = await sameTextHistory.runInput(sameTextHistory.submits.at(-1));
check("same-text history revokes selected reference", sameTextResult.action === "continue", JSON.stringify(sameTextResult));

const repeatTab = harness(commands);
repeatTab.editor.setText("x /how");
repeatTab.editor.handleInput("\x1b[9;1:2u");
check("repeat tab does not insert", repeatTab.editor.getText() === "x /how", JSON.stringify(repeatTab.editor.getText()));
repeatTab.editor.handleInput("\x1b");
repeatTab.editor.handleInput("\r");
const repeatTabResult = await repeatTab.runInput(repeatTab.submits.at(-1));
check("repeat tab does not authorize", repeatTabResult.action === "continue", JSON.stringify(repeatTabResult));

const releaseTab = harness(commands);
releaseTab.editor.setText("x /how");
releaseTab.editor.handleInput("\x1b[9;1:3u");
check("release tab does not insert", releaseTab.editor.getText() === "x /how", JSON.stringify(releaseTab.editor.getText()));
releaseTab.editor.handleInput("\x1b");
releaseTab.editor.handleInput("\r");
const releaseTabResult = await releaseTab.runInput(releaseTab.submits.at(-1));
check("release tab does not authorize", releaseTabResult.action === "continue", JSON.stringify(releaseTabResult));

const escapePriority = harness(commands);
let escapeCalls = 0;
escapePriority.editor.onExtensionShortcut = (data) => {
	if (tui.matchesKey(data, "escape")) {
		escapeCalls++;
		return true;
	}
	return false;
};
escapePriority.editor.setText("x /how");
escapePriority.editor.handleInput("\x1b");
check("extension escape shortcut runs once", escapeCalls === 1, JSON.stringify(escapeCalls));
check("extension escape shortcut keeps draft", escapePriority.editor.getText() === "x /how", JSON.stringify(escapePriority.editor.getText()));

const actionPriority = harness(commands);
actionPriority.kb.setUserBindings({ "tui.input.tab": "tab", "app.model.select": "tab" });
let modelCalls = 0;
actionPriority.editor.onAction("app.model.select", () => modelCalls++);
actionPriority.editor.setText("x /how");
actionPriority.editor.handleInput("\t");
check("conflicting app action runs once", modelCalls === 1, JSON.stringify(modelCalls));
check("conflicting app action wins over inline accept", actionPriority.editor.getText() === "x /how", JSON.stringify(actionPriority.editor.getText()));

actionPriority.editor.handleInput("\x1b");
actionPriority.editor.handleInput("\r");
const actionPriorityResult = await actionPriority.runInput(actionPriority.submits.at(-1));
check("conflicting app action leaves token literal", actionPriorityResult.action === "continue", JSON.stringify(actionPriorityResult));

const ambiguity = harness(commands);
ambiguity.editor.setText("x /how");
ambiguity.editor.handleInput("\t");
ambiguity.editor.handleInput("\x01");
ambiguity.editor.handleInput("\x1b[C");
ambiguity.editor.handleInput("\x1b[C");
ambiguity.editor.handleInput("/skill:how ");
ambiguity.editor.handleInput("\x05");
ambiguity.editor.handleInput("\x17");
check("ambiguous insert keeps expected draft", ambiguity.editor.getText() === "x /skill:how /skill:", JSON.stringify(ambiguity.editor.getText()));
ambiguity.editor.handleInput("\r");
const ambiguityResult = await ambiguity.runInput(ambiguity.submits.at(-1));
check("ambiguous insert does not authorize inserted copy", ambiguityResult.action === "continue", JSON.stringify(ambiguityResult));

const overflow = harness(commands);
overflow.editor.setText("selected /how");
overflow.editor.handleInput("\t");
overflow.editor.handleInput("\r");
const selectedText = overflow.submits.at(-1);
for (let index = 0; index < 16; index++) {
	overflow.editor.setText(`plain ${index}`);
	overflow.editor.handleInput("\r");
}
const overflowResult = await overflow.runInput(selectedText);
check("queued selected submission is not evicted", overflowResult.action === "transform" && (overflowResult.text ?? "").includes(HOW_PATH), JSON.stringify(overflowResult));

const pasteRestore = harness(commands);
pasteRestore.editor.handleInput("\x1b[200~" + "PAD\n".repeat(12) + "\x1b[201~");
pasteRestore.editor.handleInput(" suffix /missing");
pasteRestore.editor.handleInput("\t");
const originalExpanded = pasteRestore.editor.getExpandedText();
pasteRestore.editor.handleInput("\r");
const pasteRestoreResult = await pasteRestore.runInput(pasteRestore.submits.at(-1));
check("paste read failure restores expanded draft", pasteRestoreResult.action === "handled" && pasteRestore.editor.getExpandedText() === originalExpanded, JSON.stringify(pasteRestore.editor.getExpandedText()));

const shutdownRead = harness(commands);
shutdownRead.editor.setText("x /how");
shutdownRead.editor.handleInput("\t");
shutdownRead.editor.handleInput("\r");
const shutdownReading = shutdownRead.runInput(shutdownRead.submits.at(-1));
shutdownRead.handlers.session_shutdown({ type: "session_shutdown" }, {});
const shutdownResult = await shutdownReading;
check("shutdown invalidates in-flight transform", shutdownResult.action === "handled" && !(shutdownResult.text ?? "").includes(HOW_PATH), JSON.stringify(shutdownResult));

const clearedDraft = harness(commands);
clearedDraft.editor.setText("x /missing");
clearedDraft.editor.handleInput("\t");
clearedDraft.editor.handleInput("\r");
const clearedReading = clearedDraft.runInput(clearedDraft.submits.at(-1));
clearedDraft.editor.handleInput("new draft");
clearedDraft.editor.handleInput("\x15");
const clearedResult = await clearedReading;
check("cleared new draft is not overwritten on read failure", clearedDraft.editor.getText() === "" && clearedResult.action === "handled", JSON.stringify(clearedDraft.editor.getText()));

const conflictApp = harness(commands);
conflictApp.kb.setUserBindings({ "tui.editor.deleteToLineStart": "backspace" });
conflictApp.editor.setText("must-preserve /how");
conflictApp.editor.handleInput("\t");
check("conflicting backspace refuses without destroying text", conflictApp.editor.getText() === "must-preserve /how", JSON.stringify(conflictApp.editor.getText()));
check("conflicting backspace refusal is visible", conflictApp.notifications.some(([message]) => message.includes("衝突")), JSON.stringify(conflictApp.notifications));

const newlineRef = harness(commands);
newlineRef.editor.setText("x /how");
newlineRef.editor.handleInput("\t");
newlineRef.editor.handleInput("\n");
newlineRef.editor.handleInput("new line");
newlineRef.editor.handleInput("\r");
const newlineResult = await newlineRef.runInput(newlineRef.submits.at(-1));
check("ctrl+j newline preserves selected reference", newlineResult.action === "transform" && (newlineResult.text ?? "").includes(HOW_PATH), JSON.stringify(newlineResult));

const backslashSubmit = harness(commands);
backslashSubmit.kb.setUserBindings({ "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
const nativeSubmitKeys = tui.getKeybindings().getKeys("tui.input.submit");
const nativeWouldSubmit =
	tui.getKeybindings() === backslashSubmit.kb &&
	(nativeSubmitKeys.includes("shift+enter") || nativeSubmitKeys.includes("shift+return")) &&
	tui.matchesKey("\r", "enter");
check("backslash harness shares native keybindings", nativeWouldSubmit, JSON.stringify(nativeSubmitKeys));
if (nativeWouldSubmit) {
	backslashSubmit.editor.setText("x /how");
	backslashSubmit.editor.handleInput("\t");
	backslashSubmit.editor.handleInput("\\");
	backslashSubmit.editor.handleInput("\r");
	const backslashText = backslashSubmit.submits.at(-1);
	check("backslash enter route submits", backslashText === "x /skill:how", JSON.stringify(backslashSubmit.submits));
	const backslashResult = await backslashSubmit.runInput(backslashText ?? "");
	check(
		"backslash submit expands selected reference",
		backslashResult.action === "transform" && (backslashResult.text ?? "").includes(HOW_PATH) && !(backslashResult.text ?? "").includes("\\"),
		JSON.stringify(backslashResult),
	);
}

const ownedEscape = harness(commands);
let ownedEscapeCalls = 0;
ownedEscape.editor.onEscape = () => {
	ownedEscapeCalls++;
};
ownedEscape.editor.setText("x /how");
check("popup visible before owned escape", ownedEscape.editor.render(80).some((line) => line.includes("how fixture")));
ownedEscape.editor.handleInput("\x1b");
check(
	"owned list escape dismisses before onEscape",
	ownedEscapeCalls === 0 &&
		ownedEscape.editor.getText() === "x /how" &&
		!ownedEscape.editor.render(80).some((line) => line.includes("how fixture")),
	JSON.stringify({ calls: ownedEscapeCalls, text: ownedEscape.editor.getText() }),
);
ownedEscape.editor.handleInput("\x1b");
check("default onEscape runs after popup dismissed", ownedEscapeCalls === 1, JSON.stringify(ownedEscapeCalls));

const pasteRetry = harness(commands);
pasteRetry.editor.handleInput("\x1b[200~" + "PAD\n".repeat(12) + "\x1b[201~");
pasteRetry.editor.handleInput(" suffix /missing");
pasteRetry.editor.handleInput("\t");
const pasteRetryExpanded = pasteRetry.editor.getExpandedText();
pasteRetry.editor.handleInput("\r");
const pasteRetryFailed = await pasteRetry.runInput(pasteRetry.submits.at(-1));
check(
	"collapsed paste failure retains full expanded draft",
	pasteRetryFailed.action === "handled" && pasteRetry.editor.getExpandedText() === pasteRetryExpanded,
	JSON.stringify(pasteRetry.editor.getExpandedText()),
);
const missingFixture = join(EVIDENCE, "fixtures/missing/SKILL.md");
mkdirSync(dirname(missingFixture), { recursive: true });
writeFileSync(missingFixture, "---\nname: missing\ndescription: temp\n---\n\nMISSING-BODY\n");
try {
	pasteRetry.editor.handleInput("\r");
	const pasteRetryResult = await pasteRetry.runInput(pasteRetry.submits.at(-1));
	const pasteRetryText = pasteRetryResult.text ?? "";
	check(
		"unchanged paste retry loads chosen skill",
		pasteRetryResult.action === "transform" && pasteRetryText.includes(missingFixture) && pasteRetryText.includes("PAD"),
		JSON.stringify(pasteRetryResult),
	);
} finally {
	rmSync(missingFixture, { force: true });
}

const externalClear = harness(commands);
externalClear.editor.setText("x /missing");
externalClear.editor.handleInput("\t");
externalClear.editor.handleInput("\r");
const externalReading = externalClear.runInput(externalClear.submits.at(-1));
externalClear.editor.setText("replacement");
externalClear.editor.setText("");
const externalClearResult = await externalReading;
check(
	"external setText clear does not resurrect draft",
	externalClear.editor.getText() === "" && externalClearResult.action === "handled",
	JSON.stringify(externalClear.editor.getText()),
);

const sameTextSet = harness(commands);
sameTextSet.editor.setText("x /missing");
sameTextSet.editor.handleInput("\t");
sameTextSet.editor.handleInput("\r");
const sameTextReading = sameTextSet.runInput(sameTextSet.submits.at(-1));
sameTextSet.editor.setText(sameTextSet.editor.getText());
const sameTextSetResult = await sameTextReading;
check(
	"same-text external setText does not resurrect draft",
	sameTextSet.editor.getText() === "" && sameTextSetResult.action === "handled",
	JSON.stringify(sameTextSet.editor.getText()),
);

const opaquePending = harness(commands);
opaquePending.editor.setText("x /missing");
opaquePending.editor.handleInput("\t");
opaquePending.editor.handleInput("\r");
const opaqueReading = opaquePending.runInput(opaquePending.submits.at(-1));
const undoKey = ["\x1a", "\x1f", "\x1b[45;5u"].find((candidate) => opaquePending.kb.matches(candidate, "tui.editor.undo"));
if (undoKey) opaquePending.editor.handleInput(undoKey);
opaquePending.kb.setUserBindings({ "tui.editor.historyPrevious": "ctrl+p" });
if (opaquePending.kb.matches("\x10", "tui.editor.historyPrevious")) opaquePending.editor.handleInput("\x10");
const opaqueResult = await opaqueReading;
check(
	"opaque same-text during read does not resurrect draft",
	Boolean(undoKey) && opaquePending.editor.getText() === "" && opaqueResult.action === "handled",
	JSON.stringify({ undoKey: Boolean(undoKey), text: opaquePending.editor.getText(), result: opaqueResult }),
);

const arbitraryClear = harness(commands);
let arbitraryCleared = false;
arbitraryClear.editor.onAction("app.clear", () => {
	arbitraryClear.editor.setText("temp");
	arbitraryClear.editor.setText("");
	arbitraryCleared = true;
});
arbitraryClear.editor.setText("x /missing");
arbitraryClear.editor.handleInput("\t");
arbitraryClear.editor.handleInput("\r");
const arbitraryReading = arbitraryClear.runInput(arbitraryClear.submits.at(-1));
arbitraryClear.editor.handleInput("\x03");
const arbitraryResult = await arbitraryReading;
check(
	"arbitrary app clear does not resurrect draft",
	arbitraryCleared && arbitraryClear.editor.getText() === "" && arbitraryResult.action === "handled",
	JSON.stringify({ cleared: arbitraryCleared, text: arbitraryClear.editor.getText(), result: arbitraryResult }),
);

const followFail = harness(commands);
followFail.editor.onAction("app.message.followUp", () => {
	followFail.submits.push(followFail.editor.getExpandedText().trim());
	followFail.editor.setText("");
});
followFail.editor.setText("x /missing");
followFail.editor.handleInput("\t");
followFail.editor.handleInput("\x1b\r");
const followFailResult = await followFail.runInput(followFail.submits.at(-1));
check(
	"follow-up read failure restores draft",
	followFailResult.action === "handled" && followFail.editor.getText() === "x /skill:missing ",
	JSON.stringify({ text: followFail.editor.getText(), result: followFailResult }),
);

const nativeRestore = harness(commands);
nativeRestore.setRestoreOnSubmit(true);
nativeRestore.editor.setText("x /how");
nativeRestore.editor.handleInput("\t");
nativeRestore.editor.handleInput("\r");
const restoredLater = await nativeRestore.runInput("later message");
check(
	"native submit restore does not block later input",
	nativeRestore.editor.getText() === "x /skill:how" && restoredLater.action === "continue",
	JSON.stringify({ text: nativeRestore.editor.getText(), result: restoredLater }),
);

const pendingNative = harness(commands);
let releasePending = () => {};
pendingNative.editor.setAutocompleteProvider({
	getSuggestions: async (lines) => {
		if (lines.join("\n") === "native @file") {
			return new Promise((resolve) => {
				releasePending = () => resolve(null);
			});
		}
		return { prefix: "@fil", items: [{ value: "native-file", label: "NATIVE-PENDING" }] };
	},
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
});
pendingNative.editor.handleInput("native @");
pendingNative.editor.handleInput("f");
await new Promise((resolve) => setTimeout(resolve, 30));
pendingNative.editor.handleInput("i");
pendingNative.editor.handleInput("l");
await new Promise((resolve) => setTimeout(resolve, 30));
pendingNative.editor.handleInput("e");
await new Promise((resolve) => setTimeout(resolve, 30));
pendingNative.editor.handleInput(" /how");
check("inline token cancels pending native popup", !pendingNative.editor.isShowingAutocomplete(), JSON.stringify(pendingNative.editor.render(80)));
pendingNative.editor.handleInput("\t");
check("tab accepts after native popup canceled", pendingNative.editor.getText() === "native @file /skill:how ", JSON.stringify(pendingNative.editor.getText()));
releasePending();
await new Promise((resolve) => setTimeout(resolve, 10));

const nativeCommand = harness(commands);
nativeCommand.editor.setText("/model provider /how");
check("leading command arguments remain native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));
nativeCommand.editor.setText("/unknown /how");
check("unknown leading command arguments remain native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));
nativeCommand.editor.setText("/skill:not-installed /how");
check("unknown leading native skill arguments remain native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));
nativeCommand.editor.setText(" /skill:how /how");
check("leading-whitespace native skill remains native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));
nativeCommand.editor.setText("/skill:how\n/how");
check("newline directly after native skill remains native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));
nativeCommand.editor.setText("/skill:how\u00a0/how");
const nonSpaceNativeText = nativeCommand.editor.getText();
const nonSpaceNativeLines = nativeCommand.editor.render(80);
check(
	"non-space whitespace after native skill does not permit inline suggestions",
	nonSpaceNativeText === "/skill:how\u00a0/how" && !nonSpaceNativeLines.some((line) => line.includes("how fixture")),
	JSON.stringify({ text: nonSpaceNativeText, lines: nonSpaceNativeLines }),
);
nativeCommand.editor.setText("!printf /how");
check("bash command arguments remain native", !nativeCommand.editor.render(80).some((line) => line.includes("how fixture")));

const customSelection = harness(commands);
customSelection.kb.setUserBindings({ "tui.select.down": "ctrl+n" });
customSelection.editor.setText("use /");
customSelection.editor.handleInput("\x0e");
customSelection.editor.handleInput("\t");
check("custom list navigation follows keybindings", customSelection.editor.getText() === "use /skill:missing ", JSON.stringify(customSelection.editor.getText()));

writeFileSync(join(EVIDENCE, "contract-tests.json"), JSON.stringify({ failures, ranAt: new Date().toISOString() }, null, 2));
if (failures.length > 0) {
	console.error(`FAILED ${failures.length}`);
	process.exit(1);
}
console.log(`PASSED all checks`);
