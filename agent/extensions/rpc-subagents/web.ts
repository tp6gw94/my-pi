import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { WEB_INVENTORY_EVENT, WEB_SOURCE_ENV } from "./runtime.mjs";
import { WEB_APPROVED_ENV } from "./web-policy.mjs";
import { WEB_LOADER_TOOL_NAME } from "./coordination.mjs";

export type WebSelection = {
  functional: { key: string; name: string; label: string }[];
  family: string[];
  loader: boolean;
};

const storedContentKeys = new Set(["webSearch", "sourceCheck", "fetchContent"]);

function withParameterDescription(tool: RegisteredTool, field: string, description: string): RegisteredTool {
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> } | undefined;
  const property = parameters?.properties?.[field];
  if (property) property.description = description;
  return tool;
}

function adaptFunctional(tool: RegisteredTool, selection: WebSelection): RegisteredTool {
  const entry = selection.functional.find((item) => item.name === tool.name);
  if (!entry) return tool;

  if (entry.key === "getSearchContent") {
    const storedProducers = selection.functional.filter((item) => storedContentKeys.has(item.key));
    const producerNames = storedProducers.map((item) => item.name).join(", ");
    const adapted = {
      ...tool,
      description: storedProducers.length > 0
        ? `Retrieve bounded pages of full stored search results or fetched content, or find matching passages, from a previous ${producerNames} call.`
        : "Retrieve bounded pages of previously stored search results or fetched content, or find matching passages.",
      promptSnippet: storedProducers.length > 0
        ? `Use after ${producerNames} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`
        : "Use to retrieve previously stored content via responseId. Use findText to locate passages without paging through the full content.",
    };
    const withResponseId = withParameterDescription(adapted, "responseId", storedProducers.length > 0
      ? `The responseId from ${producerNames}`
      : "The responseId from a previous stored search or fetch");
    return storedProducers.some((item) => item.key === "webSearch")
      ? withResponseId
      : withParameterDescription(withResponseId, "query", "Get content for a stored search query");
  }

  if (entry.key === "fetchContent") {
    const hasRetrievalTool = selection.functional.some((item) => item.key === "getSearchContent");
    if (!hasRetrievalTool && typeof tool.description === "string") {
      return { ...tool, description: tool.description.replace(/Full original content is stored for retrieval with [^.]+\./,
        "Full original content is stored internally, but the retrieval tool is not registered.") };
    }
  }

  return tool;
}

function enforceReachable(pi: ExtensionAPI, selection: WebSelection, approvedNames: Set<string>) {
  const active = new Set(pi.getActiveTools());
  for (const entry of selection.family) if (!approvedNames.has(entry)) active.delete(entry);

  if (selection.functional.every((entry) => active.has(entry.name))) return;
  if (selection.loader) active.add(WEB_LOADER_TOOL_NAME);
  else for (const entry of selection.functional) active.add(entry.name);
  pi.setActiveTools([...active]);
}

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function parseSelection(value: unknown): WebSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing structured web tool selection");
  const selection = value as { functional?: unknown; family?: unknown; loader?: unknown };
  if (!Array.isArray(selection.family) || selection.family.some((name) => typeof name !== "string")) throw new Error("Invalid web tool family");
  if (!Array.isArray(selection.functional) || selection.functional.some((entry) => !entry || typeof entry !== "object"
    || typeof (entry as { key?: unknown }).key !== "string" || typeof (entry as { name?: unknown }).name !== "string"
    || typeof (entry as { label?: unknown }).label !== "string")) {
    throw new Error("Invalid selected web tools");
  }
  if (typeof selection.loader !== "boolean") throw new Error("Invalid web loader flag");

  const functional = selection.functional as WebSelection["functional"];
  const family = selection.family as string[];
  if (new Set(functional.map((entry) => entry.name)).size !== functional.length) throw new Error("Selected web tools contain duplicates");
  if (functional.some((entry) => !family.includes(entry.name))) throw new Error("Selected web tools must belong to the configured family");
  if (functional.length === 0 && !selection.loader) throw new Error("Web selection requires at least one functional tool");
  return { functional, family, loader: selection.loader };
}

function adaptLoader(pi: ExtensionAPI, tool: RegisteredTool, selection: WebSelection): RegisteredTool {
  const functionalNames = selection.functional.map((entry) => entry.name);
  const capabilityLabels = selection.functional.map((entry) => entry.label).join(", ");
  const execute: RegisteredTool["execute"] = async () => {
    const registered = new Set(pi.getAllTools().map((entry) => entry.name));
    const unavailable = functionalNames.filter((name) => !registered.has(name));
    if (unavailable.length > 0) {
      return { isError: true, content: [{ type: "text", text: `Cannot enable unavailable tools: ${unavailable.join(", ")}.` }], details: { unavailable } };
    }

    try {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...functionalNames])]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: `Activation failed: ${message}.` }], details: { error: message } };
    }

    const active = new Set(pi.getActiveTools());
    const missing = functionalNames.filter((name) => !active.has(name));
    return missing.length > 0
      ? { isError: true, content: [{ type: "text", text: `Tools still inactive after activation: ${missing.join(", ")}.` }], details: { missing } }
      : { content: [{ type: "text", text: `Enabled: ${functionalNames.join(", ")}.` }], details: { enabled: functionalNames } };
  };
  return {
    ...tool,
    promptSnippet: `If tools for ${capabilityLabels} are not already available, call ${WEB_LOADER_TOOL_NAME} first whenever current, external, or linked information could help; the tools appear on the next model request.`,
    execute,
  };
}

export async function registerWebFactory(pi: ExtensionAPI, factory: unknown, selection: WebSelection) {
  if (typeof factory !== "function") throw new Error("Installed pi-web-access has no extension factory");
  if (!Array.isArray(selection.family) || typeof selection.loader !== "boolean") throw new Error("Invalid web tool selection");
  const functionalNames = selection.functional.map((entry) => entry.name);
  const approved = new Set([...functionalNames, ...(selection.loader ? [WEB_LOADER_TOOL_NAME] : [])]);
  const family = new Set(selection.family);
  const attemptedNames: string[] = [];

  const captured = new Proxy(pi, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "registerTool") {
        return (tool: RegisteredTool) => {
          if (!family.has(tool.name) && tool.name !== WEB_LOADER_TOOL_NAME) throw new Error(`Web factory registered an unconfigured tool: ${tool.name}`);
          attemptedNames.push(tool.name);
          if (tool.name === WEB_LOADER_TOOL_NAME) target.registerTool(adaptLoader(target, tool, selection));
          else if (functionalNames.includes(tool.name)) target.registerTool(adaptFunctional(tool, selection));
        };
      }
      if (property === "setActiveTools") {
        return (names: string[]) => target.setActiveTools([...new Set(names)].filter((name) => !family.has(name) || approved.has(name)));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await (factory as (api: ExtensionAPI) => unknown)(captured as ExtensionAPI);
  const expectedNames = [...selection.family, ...(selection.loader ? [WEB_LOADER_TOOL_NAME] : [])];
  if (attemptedNames.length !== expectedNames.length || expectedNames.some((name) => !attemptedNames.includes(name))) {
    throw new Error("Web factory inventory disagrees with configured tools");
  }

  pi.events.on(WEB_INVENTORY_EVENT, (value: unknown) => {
    (value as { webTools?: string[] }).webTools = [...functionalNames, ...(selection.loader ? [WEB_LOADER_TOOL_NAME] : [])];
  });

  const guard = () => enforceReachable(pi, selection, approved);
  pi.on("session_start", guard);
  pi.on("session_tree", guard);
}

export default async function registerWeb(pi: ExtensionAPI) {
  const source = process.env[WEB_SOURCE_ENV];
  if (!source) throw new Error("Missing controlled web access source");
  let raw: unknown;
  try { raw = JSON.parse(process.env[WEB_APPROVED_ENV] ?? "null"); }
  catch { throw new Error("Invalid structured web tool selection"); }
  const selection = parseSelection(raw);
  const module = await import(pathToFileURL(source).href);
  await registerWebFactory(pi, module.default, selection);
}
