import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// OpenCode Zen (pay-as-you-go) and OpenCode Go ($10/mo) share one upstream
// catalog: Models.dev. OpenCode builds its own model list from it, so we pull
// the full metadata (context window, cost, modalities, reasoning) straight
// from the public catalog instead of maintaining a hand-written copy here.
const ZEN_BASE = "https://opencode.ai/zen/v1";
const GO_BASE = "https://opencode.ai/zen/go/v1";
const CATALOG_URL = "https://models.dev/api.json";
const DS_FLASH_ID = "deepseek-v4.1-flash";
const GO_AUTOMATIC_THINKING_IDS = new Set(["glm-5.3-flash"]);
const NATIVE_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};
const TOGGLE_FORMATS = new Set(["deepseek", "zai", "qwen", "together", "qwen-chat-template"]);

type RawModel = {
  id: string;
  name: string;
  reasoning?: boolean;
  reasoning_options?: unknown;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  // Models.dev marks models that expect the reasoning trace echoed back on
  // every assistant message: `{ "field": "reasoning_content" }` (or the field
  // name as a bare string / the boolean form when no field name is known).
  interleaved?: boolean | string | { field?: string };
};

type ZenApi = "openai-responses" | "anthropic-messages" | "openai-completions";
type ProtocolModelConfig = Extract<ProviderModelConfig, { type?: "chat" }> & { api: ZenApi };
type CompletionsCompat = NonNullable<Model<"openai-completions">["compat"]>;
type OffKind = "unverified" | "none" | "toggle";
type ParsedThinking =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "empty" }
  | { kind: "unsupported" }
  | { kind: "effort"; natives: string[]; off: OffKind }
  | { kind: "toggle"; off: OffKind }
  | { kind: "budget" };
type ThinkingFormat = NonNullable<GoThinkingConfig["compat"]["thinkingFormat"]>;
type GoThinkingInput = {
  id: string;
  reasoning?: boolean;
  reasoning_options?: unknown;
};
type GoThinkingConfig = {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
  compat: Pick<
    CompletionsCompat,
    "supportsReasoningEffort" | "thinkingFormat"
  >;
};

const GO_RESPONSES_IDS = new Set(["muse-spark-1.2-contributor", "muse-spark-1.3-contributor"]);
const builtinGo = new Map<string, Model<Api>>();
for (const model of getBuiltinModels("opencode-go")) builtinGo.set(model.id, model);

function goApiFor(id: string): ZenApi {
  return GO_RESPONSES_IDS.has(id) ? "openai-responses" : "openai-completions";
}

// OpenCode Zen exposes three different API styles depending on model family.
// This mirrors the proven routing in the old curated lists; Models.dev's own
// `provider.npm` does NOT match it (e.g. grok-4.5 is @ai-sdk/openai upstream
// but must hit /chat/completions through Zen).
function zenApiFor(id: string): ZenApi {
  if (id.startsWith("gpt")) return "openai-responses";
  if (id.startsWith("claude") || id.startsWith("qwen")) return "anthropic-messages";
  return "openai-completions";
}

const DEFAULT_THINK = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };

// Models that advertise a "max" reasoning effort get xhigh -> "max"; pi
// clamps anything a model doesn't support, so the default "high" is safe.
function thinkMap(m: RawModel) {
  const supportsMax =
    Array.isArray(m.reasoning_options) &&
    m.reasoning_options.some(
      (option) =>
        option &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        Array.isArray((option as { values?: unknown }).values) &&
        ((option as { values: unknown[] }).values.includes("max")),
    );
  return supportsMax ? { ...DEFAULT_THINK, xhigh: "max" } : { ...DEFAULT_THINK };
}

function uniqueNatives(values: string[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (value !== "none" && Object.hasOwn(NATIVE_RANK, value)) found.add(value);
  }
  return [...found].sort((a, b) => NATIVE_RANK[a] - NATIVE_RANK[b]);
}

function parseGoThinking(options: unknown, present: boolean): ParsedThinking {
  if (!present) return { kind: "absent" };
  if (!Array.isArray(options)) return { kind: "malformed" };
  if (options.length === 0) return { kind: "empty" };
  const natives: string[] = [];
  let off: OffKind = "unverified";
  let toggle = false;
  let budget = false;
  let emptyEffort = false;
  let unsupported = false;
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const rec = option as { type?: unknown; values?: unknown };
    if (rec.type === "effort") {
      if (!Array.isArray(rec.values)) continue;
      if (rec.values.length === 0) {
        emptyEffort = true;
        continue;
      }
      if (!rec.values.every((value) => value === null || typeof value === "string")) continue;
      for (const value of rec.values) {
        if (value === null) {
          if (off === "unverified") off = "toggle";
        } else if (value === "none") off = "none";
        else if (Object.hasOwn(NATIVE_RANK, value)) natives.push(value);
        else unsupported = true;
      }
    } else if (rec.type === "toggle") {
      toggle = true;
    } else if (rec.type === "budget_tokens") {
      budget = true;
    } else if (typeof rec.type === "string" && rec.type.length > 0) {
      unsupported = true;
    }
  }
  if (natives.length || off !== "unverified") {
    return { kind: "effort", natives: uniqueNatives(natives), off: toggle && off === "unverified" ? "toggle" : off };
  }
  if (toggle) return { kind: "toggle", off: "toggle" };
  if (budget) return { kind: "budget" };
  if (emptyEffort) return { kind: "empty" };
  if (unsupported) return { kind: "unsupported" };
  return { kind: "malformed" };
}

function thinkingFromBuiltin(model: Model<Api>): ParsedThinking {
  if (!model.reasoning) return { kind: "unsupported" };
  const map = model.thinkingLevelMap;
  if (!map) return { kind: "absent" };
  const values: string[] = [];
  let off: OffKind = "unverified";
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string") continue;
    if (key === "off" || value === "none") {
      off = "none";
      continue;
    }
    values.push(value);
  }
  const natives = uniqueNatives(values);
  if (!natives.length) return off === "none" ? { kind: "toggle", off } : { kind: "absent" };
  return { kind: "effort", natives, off };
}

function aliasMap(
  natives: readonly string[],
  off: OffKind,
  id: string,
  format: ThinkingFormat | undefined,
): Record<ModelThinkingLevel, string | null> {
  const pick = (rank: number) => {
    for (const value of natives) {
      if (NATIVE_RANK[value] >= rank) return value;
    }
    return null;
  };
  return {
    off: id === DS_FLASH_ID || off === "none" || (off === "toggle" && format) ? "none" : null,
    minimal: pick(1),
    low: pick(2),
    medium: pick(3),
    high: pick(4),
    xhigh: pick(5),
    max: pick(6),
  };
}

function toggleFormat(id: string, api: ZenApi): ThinkingFormat | undefined {
  if (api !== "openai-completions") return undefined;
  if (id.startsWith("deepseek")) return "deepseek";
  const builtin = builtinGo.get(id);
  if (!builtin || builtin.api !== api || !builtin.compat) return undefined;
  const format = "thinkingFormat" in builtin.compat ? builtin.compat.thinkingFormat : undefined;
  return typeof format === "string" && TOGGLE_FORMATS.has(format) ? (format as ThinkingFormat) : undefined;
}

function goThinkingFor(model: GoThinkingInput, api: ZenApi): GoThinkingConfig {
  const closed: GoThinkingConfig = { reasoning: false, compat: { supportsReasoningEffort: false } };
  if (GO_AUTOMATIC_THINKING_IDS.has(model.id)) return closed;
  if (Object.hasOwn(model, "reasoning") && model.reasoning === false) {
    return { reasoning: false, compat: {} };
  }
  let parsed = parseGoThinking(model.reasoning_options, Object.hasOwn(model, "reasoning_options"));
  if (parsed.kind === "absent" || parsed.kind === "malformed") {
    const builtin = builtinGo.get(model.id);
    if (builtin && builtin.api === api) parsed = thinkingFromBuiltin(builtin);
  }
  if (parsed.kind === "effort") {
    const toggle = parsed.off === "toggle" ? toggleFormat(model.id, api) : undefined;
    const format = toggle === "qwen-chat-template" ? undefined : toggle;
    const compat: GoThinkingConfig["compat"] = { supportsReasoningEffort: true };
    if (format) compat.thinkingFormat = format;
    const thinkingLevelMap = aliasMap(parsed.natives, parsed.off, model.id, format);
    if (!Object.values(thinkingLevelMap).some((value) => value !== null)) return closed;
    return { reasoning: true, thinkingLevelMap, compat };
  }
  if (parsed.kind === "toggle") {
    const format = toggleFormat(model.id, api);
    if (!format) return closed;
    return {
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
      compat: { supportsReasoningEffort: false, thinkingFormat: format },
    };
  }
  return closed;
}

function applyGoThinking(cfg: ProtocolModelConfig, model: GoThinkingInput): ProtocolModelConfig {
  const thinking = goThinkingFor(model, cfg.api);
  cfg.reasoning = thinking.reasoning;
  if (thinking.thinkingLevelMap) cfg.thinkingLevelMap = thinking.thinkingLevelMap;
  else delete cfg.thinkingLevelMap;
  cfg.compat = { ...cfg.compat, ...thinking.compat };
  return cfg;
}

function interleavedField(m: Pick<RawModel, "interleaved">): string | undefined {
  const raw = m.interleaved;
  if (typeof raw === "string") return raw;
  return typeof raw === "object" ? raw?.field : undefined;
}

function compatFor(m: Pick<RawModel, "id" | "interleaved">, api: ZenApi): CompletionsCompat {
  const compat: CompletionsCompat = { supportsDeveloperRole: api === "openai-responses" };
  if (m.id.startsWith("deepseek")) compat.thinkingFormat = "deepseek";
  // Thinking-mode upstreams (DeepSeek, GLM, Kimi, MiMo, LongCat, ...) 400 with
  // "The `reasoning_content` in the thinking mode must be passed back to the
  // API" when an assistant message in the history omits reasoning_content.
  // pi only auto-detects that from provider/baseUrl deepseek.com, which
  // opencode.ai never matches, so we take the signal from the catalog instead
  // (deepseek by id as a fallback when the catalog is unreachable).
  if (
    api === "openai-completions" &&
    (interleavedField(m) === "reasoning_content" || m.id.startsWith("deepseek"))
  ) {
    compat.requiresReasoningContentOnAssistantMessages = true;
  }
  return compat;
}

function toConfig(m: RawModel, api: ZenApi): ProtocolModelConfig {
  const input = (m.modalities?.input ?? ["text"]).filter(
    (x): x is "text" | "image" => x === "text" || x === "image",
  );
  const cost = m.cost ?? {};
  const cfg: ProtocolModelConfig = {
    id: m.id,
    name: m.name,
    api,
    reasoning: !!m.reasoning,
    input: input.length ? input : ["text"],
    contextWindow: m.limit?.context ?? 200000,
    maxTokens: m.limit?.output ?? 32768,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cache_read ?? 0,
      cacheWrite: cost.cache_write ?? 0,
    },
    compat: compatFor(m, api),
  };
  if (cfg.reasoning) cfg.thinkingLevelMap = thinkMap(m);
  return cfg;
}

// Degraded entry when the catalog is unreachable: keep the model usable with
// default metadata rather than dropping it entirely.
function defaultConfig(id: string, api: ZenApi): ProtocolModelConfig {
  return {
    id,
    name: id,
    api,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: compatFor({ id }, api),
    thinkingLevelMap: { ...DEFAULT_THINK },
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// OpenCode's own /models only lists ids (no metadata), so we use it purely to
// drop models that are disabled/removed for the authenticated workspace.
async function liveIds(base: string): Promise<Set<string>> {
  const json = await fetchJson(`${base}/models`, 10000);
  if (!json || typeof json !== "object") return new Set();
  const data = (json as { data?: { id: string }[] }).data ?? [];
  return new Set(data.map((m) => m.id));
}

function splitZen(models: RawModel[]) {
  return {
    responses: models.filter((m) => zenApiFor(m.id) === "openai-responses").map((m) => toConfig(m, "openai-responses")),
    messages: models.filter((m) => zenApiFor(m.id) === "anthropic-messages").map((m) => toConfig(m, "anthropic-messages")),
    completions: models.filter((m) => zenApiFor(m.id) === "openai-completions").map((m) => toConfig(m, "openai-completions")),
  };
}

export default async function (pi: ExtensionAPI) {
  const [catalog, zenLive, goLive] = await Promise.all([
    fetchJson(CATALOG_URL, 20000),
    liveIds(ZEN_BASE),
    liveIds(GO_BASE),
  ]);

  const raw = catalog && typeof catalog === "object" ? (catalog as Record<string, { models?: Record<string, RawModel> }>) : null;
  const zenRaw = raw?.opencode?.models ? Object.values(raw.opencode.models) : null;
  const goRaw = raw?.["opencode-go"]?.models ? Object.values(raw["opencode-go"].models) : null;

  let zen: ReturnType<typeof splitZen>;
  let go: ProtocolModelConfig[];

  if (zenRaw && goRaw) {
    const keep = (ids: Set<string>) => (m: RawModel) => ids.size === 0 || ids.has(m.id);
    zen = splitZen(zenRaw.filter(keep(zenLive)));
    go = goRaw.filter(keep(goLive)).map((m) => applyGoThinking(toConfig(m, goApiFor(m.id)), m));
  } else {
    // Catalog unreachable: fall back to OpenCode's live id list with defaults.
    const idsTo = (ids: Set<string>, api: ZenApi) => [...ids].map((id) => defaultConfig(id, api));
    zen = {
      responses: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "openai-responses")), "openai-responses"),
      messages: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "anthropic-messages")), "anthropic-messages"),
      completions: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "openai-completions")), "openai-completions"),
    };
    go = [...goLive].map((id) => applyGoThinking(defaultConfig(id, goApiFor(id)), { id }));
  }

  // ── OpenCode Zen (pay-as-you-go) ──
  pi.registerProvider("opencode", {
    name: "OpenCode Zen",
    baseUrl: ZEN_BASE,
    apiKey: "$OPENCODE_ZEN_API_KEY",
    api: "openai-responses",
    headers: { "X-Title": "pi-agent" },
    models: zen.responses,
  });

  pi.registerProvider("opencode-zen-anthropic", {
    name: "OpenCode Zen (Anthropic)",
    baseUrl: ZEN_BASE,
    apiKey: "$OPENCODE_ZEN_API_KEY",
    api: "anthropic-messages",
    headers: { "X-Title": "pi-agent" },
    models: zen.messages,
  });

  pi.registerProvider("opencode-zen-compat", {
    name: "OpenCode Zen (Compat)",
    baseUrl: ZEN_BASE,
    apiKey: "$OPENCODE_ZEN_API_KEY",
    api: "openai-completions",
    headers: { "X-Title": "pi-agent" },
    models: zen.completions,
  });

  // ── OpenCode Go ($10/mo subscription) ──
  pi.registerProvider("opencode-go", {
    name: "OpenCode Go",
    baseUrl: GO_BASE,
    apiKey: "$OPENCODE_GO_API_KEY",
    api: "openai-completions",
    headers: { "X-Title": "pi-agent" },
    models: go,
  });
}
