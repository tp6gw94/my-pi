import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXECUTION_TOOLS, normalizeTools } from "./coordination.mjs";

export const WEB_APPROVED_ENV = "RPC_SUBAGENTS_WEB_TOOLS";

export function webConfigPath(env = process.env, home = homedir()) {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, "web-search.json");
  const legacy = join(home, ".pi", "web-search.json");
  if (env.XDG_CONFIG_HOME) {
    const xdg = join(env.XDG_CONFIG_HOME, "pi", "web-search.json");
    return existsSync(xdg) ? xdg : existsSync(legacy) ? legacy : xdg;
  }
  const agent = join(home, ".pi", "agent", "web-search.json");
  return existsSync(agent) ? agent : existsSync(legacy) ? legacy : agent;
}

export function resolveWebTools(config, requested = []) {
  const defaults = { webSearch: "web_search", sourceCheck: "source_check", fetchContent: "fetch_content", getSearchContent: "get_search_content" };
  const mode = config.toolActivation ?? "auto";
  if (!["auto", "dynamic", "eager"].includes(mode)) throw new Error("Invalid pi-web-access toolActivation");
  if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) throw new Error("Invalid pi-web-access toolNames");
  const names = [];
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = config.toolNames?.[key] === undefined ? fallback : config.toolNames[key];
    if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.trim())) throw new Error(`Invalid pi-web-access toolNames.${key}`);
    const enabled = typeof config.tools?.[key]?.enabled === "boolean" ? config.tools[key].enabled
      : !["webSearch", "sourceCheck"].includes(key) || config.webSearch?.enabled !== false;
    if (enabled) {
      if (raw.trim() === "web_enable") throw new Error("Web tool uses reserved loader name");
      names.push(raw.trim());
    }
  }
  if (!names.length) throw new Error("Web access requested but all installed web tools are disabled");
  if (mode !== "eager") names.push("web_enable");
  assertWebTools(names, requested);
  return names;
}

export function assertWebTools(names, requested = []) {
  normalizeTools(names);
  if (names.length > 16) throw new Error("Web tool inventory exceeds limit");
  const reserved = new Set([...DEFAULT_EXECUTION_TOOLS, "grep", "find", "ls", ...requested]);
  if (names.some((name) => reserved.has(name))) throw new Error("Web tool collision with requested or reserved tools");
}

export function configuredWebTools(requested) {
  const path = webConfigPath();
  let config = {};
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Cannot parse installed pi-web-access configuration"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid pi-web-access configuration root");
  }
  return resolveWebTools(config, requested);
}
