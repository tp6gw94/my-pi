import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Plan = Readonly<{ slug: string; source: string; content: string; entries: readonly string[] }>;

const STALE_MS = 24 * 60 * 60 * 1000;

function isValidName(name: string): boolean {
	return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function toSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 64)
		.replace(/^-+|-+$/g, "");
}

function frontmatterName(content: string): unknown {
	try {
		return parseFrontmatter<{ name?: unknown }>(content).frontmatter.name;
	} catch {
		return undefined;
	}
}

function renameSkill(content: string, slug: string): string | undefined {
	const text = content.replace(/\r\n?/g, "\n");
	const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
	if (end === -1) return undefined;
	const renamed = text.slice(0, end).replace(/^name:.*$/m, `name: ${slug}`) + text.slice(end);
	return frontmatterName(renamed) === slug ? renamed : undefined;
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function collectPlans(sourceDirs: readonly string[]): Promise<Plan[]> {
	const plans: Plan[] = [];
	const seen = new Set<string>();
	const slugs = new Set<string>();
	for (const dir of sourceDirs) {
		const names = await readdir(dir).catch((): string[] => []);
		for (const name of names.sort()) {
			if (name.startsWith(".")) continue;
			const source = await realpath(join(dir, name)).catch(() => undefined);
			if (!source || seen.has(source)) continue;
			const content = await readFile(join(source, "SKILL.md"), "utf8").catch(() => undefined);
			if (content === undefined) continue;
			seen.add(source);
			const declared = frontmatterName(content);
			if (typeof declared !== "string" || declared === "" || isValidName(declared)) continue;
			const slug = isValidName(name) ? name : toSlug(declared);
			if (!slug || slugs.has(slug)) continue;
			const renamed = renameSkill(content, slug);
			if (!renamed) continue;
			slugs.add(slug);
			const entries = (await readdir(source)).filter((entry) => entry !== "SKILL.md").sort();
			plans.push({ slug, source, content: renamed, entries });
		}
	}
	return plans;
}

async function prune(root: string, keep: string | undefined, now: number): Promise<void> {
	for (const entry of await readdir(root).catch((): string[] => [])) {
		if (entry === keep) continue;
		const path = join(root, entry);
		const info = await stat(path).catch(() => undefined);
		if (info && now - info.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
	}
}

async function materialize(root: string, plans: readonly Plan[]): Promise<string> {
	const digest = createHash("sha256").update(JSON.stringify(plans)).digest("hex").slice(0, 16);
	const target = join(root, digest);
	await mkdir(root, { recursive: true });
	if (!(await exists(target))) {
		const staging = join(root, `.staging-${randomUUID()}`);
		for (const plan of plans) {
			const dir = join(staging, plan.slug);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "SKILL.md"), plan.content);
			for (const entry of plan.entries) await symlink(join(plan.source, entry), join(dir, entry));
		}
		await rename(staging, target).catch(async (error: unknown) => {
			await rm(staging, { recursive: true, force: true });
			if (!(await exists(target))) throw error;
		});
	}
	const now = new Date();
	await utimes(target, now, now);
	await prune(root, digest, now.getTime());
	return target;
}

export default function skillNameNormalizer(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		const agentDir = getAgentDir();
		const plans = await collectPlans([join(agentDir, "skills"), join(homedir(), ".agents", "skills")]);
		const root = join(agentDir, "normalized-skills");
		if (plans.length > 0) return { skillPaths: [await materialize(root, plans)] };
		await prune(root, undefined, Date.now());
		await rmdir(root).catch(() => undefined);
		return {};
	});
}
