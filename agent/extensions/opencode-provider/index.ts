import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// OpenCode Zen (pay-as-you-go) and OpenCode Go ($10/mo) share one upstream
// catalog: Models.dev. OpenCode builds its own model list from it, so we pull
// the full metadata (context window, cost, modalities, reasoning) straight
// from the public catalog instead of maintaining a hand-written copy here.
const ZEN_BASE = "https://opencode.ai/zen/v1";
const GO_BASE = "https://opencode.ai/zen/go/v1";
const CATALOG_URL = "https://models.dev/api.json";

type RawModel = {
  id: string;
  name: string;
  reasoning?: boolean;
  reasoning_options?: { values?: string[] }[];
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

type ZenApi = "openai-responses" | "anthropic-messages" | "openai-completions";

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
  const supportsMax = m.reasoning_options?.some((o) => o.values?.includes("max")) ?? false;
  return supportsMax ? { ...DEFAULT_THINK, xhigh: "max" } : { ...DEFAULT_THINK };
}

function compatFor(id: string, api: ZenApi): ProviderModelConfig["compat"] {
  const compat: ProviderModelConfig["compat"] = { supportsDeveloperRole: api === "openai-responses" };
  if (id.startsWith("deepseek")) compat.thinkingFormat = "deepseek";
  return compat;
}

function toConfig(m: RawModel, api: ZenApi): ProviderModelConfig {
  const input = (m.modalities?.input ?? ["text"]).filter(
    (x): x is "text" | "image" => x === "text" || x === "image",
  );
  const cost = m.cost ?? {};
  const cfg: ProviderModelConfig = {
    id: m.id,
    name: m.name,
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
    compat: compatFor(m.id, api),
  };
  if (cfg.reasoning) cfg.thinkingLevelMap = thinkMap(m);
  return cfg;
}

// Degraded entry when the catalog is unreachable: keep the model usable with
// default metadata rather than dropping it entirely.
function defaultConfig(id: string, api: ZenApi): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: compatFor(id, api),
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
  let go: ProviderModelConfig[];

  if (zenRaw && goRaw) {
    const keep = (ids: Set<string>) => (m: RawModel) => ids.size === 0 || ids.has(m.id);
    zen = splitZen(zenRaw.filter(keep(zenLive)));
    go = goRaw.filter(keep(goLive)).map((m) => toConfig(m, "openai-completions"));
  } else {
    // Catalog unreachable: fall back to OpenCode's live id list with defaults.
    const idsTo = (ids: Set<string>, api: ZenApi) => [...ids].map((id) => defaultConfig(id, api));
    zen = {
      responses: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "openai-responses")), "openai-responses"),
      messages: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "anthropic-messages")), "anthropic-messages"),
      completions: idsTo(new Set([...zenLive].filter((id) => zenApiFor(id) === "openai-completions")), "openai-completions"),
    };
    go = [...goLive].map((id) => defaultConfig(id, "openai-completions"));
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
