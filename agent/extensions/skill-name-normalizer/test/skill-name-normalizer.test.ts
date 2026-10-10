import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

type Box = Readonly<{ home: string; work: string; skills: string; generated: string }>;

const EXTENSION_DIR = resolve(import.meta.dirname, "..");
const PI_BIN = process.env.PI_BIN ?? "pi";
const INVALID_SKILL = "---\nname: Poteto Mode\ndescription: Invalid name.\ndisable-model-invocation: true\n---\n\n# Body\n\nRead playbooks/a.md.\n";
const roots: string[] = [];

test.after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeBox(): Box {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "skill-name-normalizer-"));
	roots.push(root);
	const home = join(root, "home");
	const work = join(root, "work");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(work);
	symlinkSync(EXTENSION_DIR, join(agentDir, "extensions", "skill-name-normalizer"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/poteto-mode"] }));
	return { home, work, skills: join(home, ".agents", "skills"), generated: join(agentDir, "normalized-skills") };
}

function writeSkill(box: Box, dir: string, content: string): void {
	mkdirSync(join(box.skills, dir), { recursive: true });
	writeFileSync(join(box.skills, dir, "SKILL.md"), content);
}

function addInvalidSkill(box: Box): void {
	writeSkill(box, "poteto-mode", INVALID_SKILL);
	mkdirSync(join(box.skills, "poteto-mode", "playbooks"));
	writeFileSync(join(box.skills, "poteto-mode", "playbooks", "a.md"), "playbook\n");
}

function skillCommands(box: Box): Promise<Map<string, string>> {
	const env = { ...process.env, HOME: box.home };
	delete env.PI_CODING_AGENT_DIR;
	return new Promise((resolvePromise, reject) => {
		const child = spawn(PI_BIN, ["--mode", "rpc", "--no-session"], { cwd: box.work, env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", () => {
			const response = stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.find((record) => record.type === "response" && record.command === "get_commands");
			if (!response?.success) return reject(new Error(`get_commands failed\n${stdout}\n${stderr}`));
			const commands: { name: string; source: string; sourceInfo: { path: string } }[] = response.data.commands;
			resolvePromise(
				new Map(commands.filter((c) => c.source === "skill").map((c) => [c.name, c.sourceInfo.path])),
			);
		});
		child.stdin.end(`${JSON.stringify({ type: "get_commands" })}\n`);
	});
}

test("an invalid skill name is exposed under its directory name with its files reachable", async () => {
	const box = makeBox();
	addInvalidSkill(box);

	const commands = await skillCommands(box);

	assert.equal(commands.has("skill:Poteto Mode"), false);
	const path = commands.get("skill:poteto-mode");
	assert.ok(path?.startsWith(`${box.generated}/`));
	assert.equal(readFileSync(path, "utf8"), INVALID_SKILL.replace("name: Poteto Mode", "name: poteto-mode"));
	assert.equal(readFileSync(join(dirname(path), "playbooks", "a.md"), "utf8"), "playbook\n");
});

test("valid skills load from their original location", async () => {
	const box = makeBox();
	writeSkill(box, "good-skill", "---\nname: good-skill\ndescription: Valid name.\n---\n\nBody\n");

	const commands = await skillCommands(box);

	assert.equal(commands.get("skill:good-skill"), join(box.skills, "good-skill", "SKILL.md"));
	assert.deepEqual(readdirSync(join(box.home, ".pi", "agent")).includes("normalized-skills"), false);
});

test("concurrent sessions share one generated skill set", async () => {
	const box = makeBox();
	addInvalidSkill(box);

	const results = await Promise.all([skillCommands(box), skillCommands(box), skillCommands(box)]);

	const paths = new Set(results.map((commands) => commands.get("skill:poteto-mode")));
	assert.equal(paths.size, 1);
	assert.equal(readdirSync(box.generated).length, 1);
});

test("an updated skill is regenerated and stale generations are removed", async () => {
	const box = makeBox();
	addInvalidSkill(box);
	const first = (await skillCommands(box)).get("skill:poteto-mode")!;
	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	utimesSync(dirname(dirname(first)), old, old);
	writeSkill(box, "poteto-mode", INVALID_SKILL.replace("Invalid name.", "Updated."));

	const second = (await skillCommands(box)).get("skill:poteto-mode")!;

	assert.notEqual(second, first);
	assert.match(readFileSync(second, "utf8"), /description: Updated\./);
	assert.deepEqual(readdirSync(box.generated), [dirname(dirname(second)).slice(box.generated.length + 1)]);
});

test("generated files are removed once every invalid skill has been gone for a day", async () => {
	const box = makeBox();
	addInvalidSkill(box);
	const path = (await skillCommands(box)).get("skill:poteto-mode")!;
	rmSync(join(box.skills, "poteto-mode"), { recursive: true });

	assert.equal((await skillCommands(box)).has("skill:poteto-mode"), false);
	assert.equal(existsSync(path), true);

	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	utimesSync(dirname(dirname(path)), old, old);
	await skillCommands(box);

	assert.equal(existsSync(box.generated), false);
});
