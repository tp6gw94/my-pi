import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { WEB_INVENTORY_EVENT, WEB_SOURCE_ENV } from "./runtime.mjs";
import { assertWebTools, WEB_APPROVED_ENV } from "./web-policy.mjs";

export async function registerWebFactory(pi: ExtensionAPI, factory: unknown, approved?: string[]) {
  if (typeof factory !== "function") throw new Error("Installed pi-web-access has no extension factory");
  const names: string[] = [];
  const captured = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        assertWebTools([...names, tool.name]);
        if (approved && !approved.includes(tool.name)) throw new Error("Web factory registered an unapproved tool");
        names.push(tool.name);
        target.registerTool(tool);
      };
      return Reflect.get(target, property);
    },
  });
  await factory(captured);
  if (approved && (names.length !== approved.length || approved.some((name) => !names.includes(name)))) throw new Error("Web factory inventory disagrees with configured tools");
  if (!names.length) throw new Error("Web access requested but all installed web tools are disabled");
  if (!names.includes("web_enable")) pi.on("session_start", () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  });
  pi.events.on(WEB_INVENTORY_EVENT, (value: unknown) => {
    (value as { webTools?: string[] }).webTools = [...names];
  });
}

export default async function registerWeb(pi: ExtensionAPI) {
  const source = process.env[WEB_SOURCE_ENV];
  if (!source) throw new Error("Missing controlled web access source");
  const module = await import(pathToFileURL(source).href);
  const approved = JSON.parse(process.env[WEB_APPROVED_ENV] ?? "null");
  if (!Array.isArray(approved)) throw new Error("Missing approved web tool family");
  await registerWebFactory(pi, module.default, approved);
}
