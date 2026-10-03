import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
if (!packageDir) throw new Error("Set RPC_SUBAGENTS_PI_PACKAGE to the current installed @earendil-works/pi-coding-agent package directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configFile = join(root, `.typecheck-${randomUUID()}.json`);
const dependencies = join(packageDir, "node_modules");
try {
  await writeFile(configFile, JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true,
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true,
      types: ["node"], typeRoots: [join(dependencies, "@types")],
      paths: {
        "@earendil-works/pi-coding-agent": [join(packageDir, "dist", "index.d.ts")],
        "@earendil-works/pi-tui": [join(dependencies, "@earendil-works", "pi-tui", "dist", "index.d.ts")],
        typebox: [join(dependencies, "typebox", "build", "index.d.mts")],
      },
    },
    files: [join(root, "index.ts"), join(root, "ui.ts"), join(root, "child.ts"), join(root, "web.ts")],
  }));
  execFileSync(process.env.RPC_SUBAGENTS_TSC ?? "tsc", ["--project", configFile], { stdio: "inherit" });
} finally { await rm(configFile, { force: true }); }
