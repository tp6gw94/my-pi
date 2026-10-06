import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import register from "./index.ts";

const CATALOG_URL = "https://models.dev/api.json";
const ZEN_BASE = "https://opencode.ai/zen/v1";
const GO_BASE = "https://opencode.ai/zen/go/v1";
const ZEN_MODELS_URL = `${ZEN_BASE}/models`;
const GO_MODELS_URL = `${GO_BASE}/models`;
const EXPECTED_URLS = [CATALOG_URL, GO_MODELS_URL, ZEN_MODELS_URL];

const MUSE_12 = "muse-spark-1.2-contributor";
const MUSE_13 = "muse-spark-1.3-contributor";
const MUSE_SIMILAR = "muse-spark-1.4-contributor";
const DEEPSEEK = "deepseek-v4.1-flash";
const GLM = "glm-5.2";
const KIMI = "kimi-k2.6";
const QWEN_GO = "qwen3.8-max";
const MINIMAX = "minimax-m3";
const HY3 = "hy3";
const UNKNOWN_GO = "unknown-go-model";
const GPT = "gpt-5.1";
const CLAUDE = "claude-sonnet-4";
const QWEN_ZEN = "qwen3-coder";
const GROK = "grok-4.5";
const RETIRED_GO = "retired-go-model";
const RETIRED_ZEN = "retired-zen-model";
const SPARSE = "sparse-effort-model";
const OTHER_DS = "deepseek-other";
const DS_FLASH_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const GO_LIVE = [MUSE_12, MUSE_13, MUSE_SIMILAR, DEEPSEEK, GLM, KIMI, QWEN_GO, MINIMAX, HY3, UNKNOWN_GO];
const ZEN_LIVE = [GPT, CLAUDE, QWEN_ZEN, GROK];
const GO_COMPLETIONS_IDS = [DEEPSEEK, GLM, KIMI, QWEN_GO, MINIMAX, HY3, UNKNOWN_GO, MUSE_SIMILAR];

type Compat = Pick<NonNullable<Model<"openai-completions">["compat"]>,
  "supportsDeveloperRole" | "thinkingFormat" | "requiresReasoningContentOnAssistantMessages" | "supportsReasoningEffort"
>;

type ModelConfig = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: {
    off?: string | null;
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
  };
  compat?: Compat;
};

type ProviderConfig = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: ModelConfig[];
};

type CatalogModel = {
  id: string;
  name: string;
  interleaved?: { field: string };
  reasoning?: boolean;
  reasoning_options?: unknown;
};

type FetchFixture = Record<string, unknown>;

function liveBody(ids: string[]) {
  return { data: ids.map((id) => ({ id })) };
}

function goCatalogModels(): Record<string, CatalogModel> {
  return {
    [MUSE_12]: { id: MUSE_12, name: MUSE_12 },
    [MUSE_13]: { id: MUSE_13, name: MUSE_13 },
    [MUSE_SIMILAR]: { id: MUSE_SIMILAR, name: MUSE_SIMILAR },
    [DEEPSEEK]: { id: DEEPSEEK, name: DEEPSEEK, interleaved: { field: "reasoning_content" } },
    [GLM]: { id: GLM, name: GLM, interleaved: { field: "reasoning_content" } },
    [KIMI]: { id: KIMI, name: KIMI, interleaved: { field: "reasoning_content" } },
    [QWEN_GO]: { id: QWEN_GO, name: QWEN_GO },
    [MINIMAX]: { id: MINIMAX, name: MINIMAX },
    [HY3]: { id: HY3, name: HY3 },
    [UNKNOWN_GO]: { id: UNKNOWN_GO, name: UNKNOWN_GO },
  };
}

function zenCatalogModels(): Record<string, CatalogModel> {
  return {
    [GPT]: { id: GPT, name: GPT },
    [CLAUDE]: { id: CLAUDE, name: CLAUDE },
    [QWEN_ZEN]: { id: QWEN_ZEN, name: QWEN_ZEN },
    [GROK]: { id: GROK, name: GROK },
  };
}

function completeCatalog() {
  return {
    opencode: { models: zenCatalogModels() },
    "opencode-go": { models: goCatalogModels() },
  };
}

function completeFixture(): FetchFixture {
  return {
    [CATALOG_URL]: completeCatalog(),
    [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
    [GO_MODELS_URL]: liveBody(GO_LIVE),
  };
}

async function registerWith(fixture: FetchFixture) {
  const requested = new Set<string>();
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.add(url);
    if (!Object.hasOwn(fixture, url)) throw new Error(`unexpected fetch ${url}`);
    const body = fixture[url];
    if (body === "fail") return new Response(null, { status: 503 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const providers = new Map<string, ProviderConfig>();
    await register({
      registerProvider: (name: string, config: ProviderConfig) => void providers.set(name, config),
    } as never);
    return { providers, requested };
  } finally {
    globalThis.fetch = previous;
  }
}

function modelsNamed(providers: Map<string, ProviderConfig>, provider: string, id: string) {
  return (providers.get(provider)?.models ?? []).filter((model) => model.id === id);
}

function modelOf(providers: Map<string, ProviderConfig>, provider: string, id: string) {
  const found = modelsNamed(providers, provider, id);
  assert.equal(found.length, 1, `${provider}/${id}`);
  return found[0];
}

function reasoningFlag(model: ModelConfig) {
  return !!model.compat?.requiresReasoningContentOnAssistantMessages;
}

function assertFetchedKnownUrls(requested: Set<string>) {
  assert.deepEqual([...requested].sort(), [...EXPECTED_URLS].sort());
}

function assertProviderInvariants(providers: Map<string, ProviderConfig>) {
  assert.deepEqual([...providers.keys()], [
    "opencode",
    "opencode-zen-anthropic",
    "opencode-zen-compat",
    "opencode-go",
  ]);
  const headers = { "X-Title": "pi-agent" };
  const zen = providers.get("opencode");
  assert.equal(zen?.name, "OpenCode Zen");
  assert.equal(zen?.baseUrl, ZEN_BASE);
  assert.equal(zen?.apiKey, "$OPENCODE_ZEN_API_KEY");
  assert.equal(zen?.api, "openai-responses");
  assert.deepEqual(zen?.headers, headers);
  const zenAnthropic = providers.get("opencode-zen-anthropic");
  assert.equal(zenAnthropic?.name, "OpenCode Zen (Anthropic)");
  assert.equal(zenAnthropic?.baseUrl, ZEN_BASE);
  assert.equal(zenAnthropic?.apiKey, "$OPENCODE_ZEN_API_KEY");
  assert.equal(zenAnthropic?.api, "anthropic-messages");
  assert.deepEqual(zenAnthropic?.headers, headers);
  const zenCompat = providers.get("opencode-zen-compat");
  assert.equal(zenCompat?.name, "OpenCode Zen (Compat)");
  assert.equal(zenCompat?.baseUrl, ZEN_BASE);
  assert.equal(zenCompat?.apiKey, "$OPENCODE_ZEN_API_KEY");
  assert.equal(zenCompat?.api, "openai-completions");
  assert.deepEqual(zenCompat?.headers, headers);
  const go = providers.get("opencode-go");
  assert.equal(go?.name, "OpenCode Go");
  assert.equal(go?.baseUrl, GO_BASE);
  assert.equal(go?.apiKey, "$OPENCODE_GO_API_KEY");
  assert.equal(go?.api, "openai-completions");
  assert.deepEqual(go?.headers, headers);
}

function assertMuseResponses(providers: Map<string, ProviderConfig>) {
  for (const id of [MUSE_12, MUSE_13]) {
    const model = modelOf(providers, "opencode-go", id);
    assert.equal(model.api, "openai-responses");
    assert.equal(model.compat?.supportsDeveloperRole, true);
  }
}

function assertGoCompletions(providers: Map<string, ProviderConfig>, ids = GO_COMPLETIONS_IDS) {
  for (const id of ids) {
    const model = modelOf(providers, "opencode-go", id);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.compat?.supportsDeveloperRole, false);
  }
}

function assertCatalogCompat(providers: Map<string, ProviderConfig>) {
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", DEEPSEEK)), true);
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", GLM)), true);
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", KIMI)), true);
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", QWEN_GO)), false);
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", MINIMAX)), false);
  assert.equal(reasoningFlag(modelOf(providers, "opencode-go", HY3)), false);
  assert.equal(reasoningFlag(modelOf(providers, "opencode", GPT)), false);
  assert.equal(modelOf(providers, "opencode-go", DEEPSEEK).compat?.thinkingFormat, "deepseek");
}

function asGoCompletionsModel(model: ModelConfig): Model<"openai-completions"> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: "opencode-go",
    baseUrl: GO_BASE,
    reasoning: !!model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32768,
    compat: model.compat,
  };
}

function priorConversation(model: string, thinking?: string): Context["messages"] {
  return [
    { role: "user", content: "Previous question", timestamp: 0 },
    {
      role: "assistant",
      content: [
        ...(thinking === undefined ? [] : [{ type: "thinking" as const, thinking, thinkingSignature: "reasoning" }]),
        { type: "text", text: "Previous answer" },
      ],
      api: "openai-completions",
      provider: "opencode-go",
      model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    },
    { role: "user", content: "Next question", timestamp: 2 },
  ];
}

async function completionsPayload(
  model: ModelConfig,
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  messages: Context["messages"] = [{ role: "user", content: "OK", timestamp: 0 }],
) {
  let payload: Record<string, unknown> | undefined;
  const stream = streamSimple(asGoCompletionsModel(model), normalizeContext({
    messages,
  }), {
    apiKey: "test",
    reasoning,
    maxTokens: 16,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage ?? "expected a completed stream");
  assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
  return payload;
}

function assertZenRoutes(providers: Map<string, ProviderConfig>) {
  assert.equal(modelOf(providers, "opencode", GPT).api, "openai-responses");
  assert.equal(modelOf(providers, "opencode-zen-anthropic", CLAUDE).api, "anthropic-messages");
  assert.equal(modelOf(providers, "opencode-zen-anthropic", QWEN_ZEN).api, "anthropic-messages");
  assert.equal(modelOf(providers, "opencode-zen-compat", GROK).api, "openai-completions");
  assert.equal(modelsNamed(providers, "opencode-zen-anthropic", GPT).length, 0);
  assert.equal(modelsNamed(providers, "opencode-zen-compat", GPT).length, 0);
  assert.equal(modelsNamed(providers, "opencode", CLAUDE).length, 0);
  assert.equal(modelsNamed(providers, "opencode-zen-compat", CLAUDE).length, 0);
  assert.equal(modelsNamed(providers, "opencode", GROK).length, 0);
  assert.equal(modelsNamed(providers, "opencode-zen-anthropic", GROK).length, 0);
}

describe("opencode-provider registerProvider contract", { concurrency: false }, () => {
  test("catalog maps both Muse IDs to responses and preserves completions plus compat", async () => {
    const { providers, requested } = await registerWith(completeFixture());
    assertFetchedKnownUrls(requested);
    assertProviderInvariants(providers);
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertCatalogCompat(providers);
    assertZenRoutes(providers);
  });

  test("catalog failure keeps Muse responses and DeepSeek reasoning without inventing GLM echo", async () => {
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: "fail",
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    assertFetchedKnownUrls(requested);
    assertProviderInvariants(providers);
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assert.equal(modelOf(providers, "opencode-go", DEEPSEEK).api, "openai-completions");
    assert.equal(reasoningFlag(modelOf(providers, "opencode-go", DEEPSEEK)), true);
    assert.equal(modelOf(providers, "opencode-go", DEEPSEEK).compat?.thinkingFormat, "deepseek");
    assert.equal(reasoningFlag(modelOf(providers, "opencode-go", GLM)), false);
    assertZenRoutes(providers);
  });

  test("missing zen catalog section falls back and keeps Muse responses", async () => {
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: { "opencode-go": { models: goCatalogModels() } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    assertFetchedKnownUrls(requested);
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertZenRoutes(providers);
  });

  test("missing go catalog section falls back and keeps Muse responses", async () => {
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zenCatalogModels() } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    assertFetchedKnownUrls(requested);
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertZenRoutes(providers);
  });

  test("nonempty live set removes unavailable catalog models", async () => {
    const zen = zenCatalogModels();
    const go = goCatalogModels();
    zen[RETIRED_ZEN] = { id: RETIRED_ZEN, name: RETIRED_ZEN };
    go[RETIRED_GO] = { id: RETIRED_GO, name: RETIRED_GO };
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zen }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    assertFetchedKnownUrls(requested);
    assert.equal(modelsNamed(providers, "opencode-go", RETIRED_GO).length, 0);
    assert.equal(modelsNamed(providers, "opencode-zen-compat", RETIRED_ZEN).length, 0);
    assert.equal(modelsNamed(providers, "opencode", RETIRED_ZEN).length, 0);
    assert.equal(modelsNamed(providers, "opencode-zen-anthropic", RETIRED_ZEN).length, 0);
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertZenRoutes(providers);
  });

  test("empty live set keeps catalog models", async () => {
    const zen = zenCatalogModels();
    const go = goCatalogModels();
    zen[RETIRED_ZEN] = { id: RETIRED_ZEN, name: RETIRED_ZEN };
    go[RETIRED_GO] = { id: RETIRED_GO, name: RETIRED_GO };
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zen }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: liveBody([]),
      [GO_MODELS_URL]: liveBody([]),
    });
    assertFetchedKnownUrls(requested);
    assert.equal(modelOf(providers, "opencode-go", RETIRED_GO).api, "openai-completions");
    assert.equal(modelOf(providers, "opencode-zen-compat", RETIRED_ZEN).api, "openai-completions");
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertZenRoutes(providers);
  });

  test("failed live list keeps catalog models", async () => {
    const zen = zenCatalogModels();
    const go = goCatalogModels();
    zen[RETIRED_ZEN] = { id: RETIRED_ZEN, name: RETIRED_ZEN };
    go[RETIRED_GO] = { id: RETIRED_GO, name: RETIRED_GO };
    const { providers, requested } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zen }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: "fail",
      [GO_MODELS_URL]: "fail",
    });
    assertFetchedKnownUrls(requested);
    assert.equal(modelOf(providers, "opencode-go", RETIRED_GO).api, "openai-completions");
    assert.equal(modelOf(providers, "opencode-zen-compat", RETIRED_ZEN).api, "openai-completions");
    assertMuseResponses(providers);
    assertGoCompletions(providers);
    assertZenRoutes(providers);
  });

  test("catalog DeepSeek effort options register Go aliases and reasoning", async () => {
    const go = goCatalogModels();
    go[DEEPSEEK].reasoning = true;
    go[DEEPSEEK].reasoning_options = [{ type: "effort", values: ["low", "high", "max"] }];
    const { providers } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    const model = modelOf(providers, "opencode-go", DEEPSEEK);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, DS_FLASH_MAP);
    assert.deepEqual(getSupportedThinkingLevels(asGoCompletionsModel(model)), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("sparse Go effort omits max and does not invent off",
    async () => {
      const go = goCatalogModels();
      go[SPARSE] = {
        id: SPARSE,
        name: SPARSE,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      };
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody([...GO_LIVE, SPARSE]),
      });
      const model = modelOf(providers, "opencode-go", SPARSE);
      assert.equal(model.reasoning, true);
      assert.deepEqual(model.thinkingLevelMap, {
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: null,
        max: null,
      });
      assert.deepEqual(getSupportedThinkingLevels(asGoCompletionsModel(model)), [
        "minimal",
        "low",
        "medium",
        "high",
      ]);
    });

  test("explicit false and empty skip builtin fallback",
    async () => {
      const go = goCatalogModels();
      go[DEEPSEEK].reasoning = false;
      go[DEEPSEEK].reasoning_options = [{ type: "effort", values: ["low", "high", "max"] }];
      const falseResult = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const denied = modelOf(falseResult.providers, "opencode-go", DEEPSEEK);
      assert.equal(denied.reasoning, false);
      assert.equal(denied.thinkingLevelMap, undefined);
      assert.equal(denied.compat?.thinkingFormat, "deepseek");
      assert.equal(reasoningFlag(denied), true);

      go[DEEPSEEK].reasoning = true;
      go[DEEPSEEK].reasoning_options = [];
      const emptyResult = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const emptied = modelOf(emptyResult.providers, "opencode-go", DEEPSEEK);
      assert.equal(emptied.reasoning, false);
      assert.equal(emptied.thinkingLevelMap, undefined);
      assert.equal(emptied.compat?.thinkingFormat, "deepseek");
    });

  test("missing and malformed Go metadata use exact builtin fallback",
    async () => {
      const missing = await registerWith(completeFixture());
      const fallback = modelOf(missing.providers, "opencode-go", DEEPSEEK);
      assert.equal(fallback.reasoning, true);
      assert.deepEqual(fallback.thinkingLevelMap, DS_FLASH_MAP);

      const go = goCatalogModels();
      go[DEEPSEEK].reasoning_options = { not: "array" };
      const malformed = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const recovered = modelOf(malformed.providers, "opencode-go", DEEPSEEK);
      assert.equal(recovered.reasoning, true);
      assert.deepEqual(recovered.thinkingLevelMap, DS_FLASH_MAP);

      const unknown = modelOf(missing.providers, "opencode-go", UNKNOWN_GO);
      assert.equal(unknown.reasoning, false);
      assert.equal(unknown.thinkingLevelMap, undefined);
    });

  test("verified off stays on exact DeepSeek Flash id",
    async () => {
      const go = goCatalogModels();
      go[OTHER_DS] = {
        id: OTHER_DS,
        name: OTHER_DS,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      };
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody([...GO_LIVE, OTHER_DS]),
      });
      const other = modelOf(providers, "opencode-go", OTHER_DS);
      assert.equal(other.reasoning, true);
      assert.equal(other.thinkingLevelMap?.off, null);
      assert.deepEqual(
        {
          minimal: other.thinkingLevelMap?.minimal,
          low: other.thinkingLevelMap?.low,
          medium: other.thinkingLevelMap?.medium,
          high: other.thinkingLevelMap?.high,
          xhigh: other.thinkingLevelMap?.xhigh,
          max: other.thinkingLevelMap?.max,
        },
        {
          minimal: "low",
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "max",
          max: "max",
        },
      );
      assert.equal(other.compat?.thinkingFormat, "deepseek");
    });

  test("catalog failure still uses safe Go builtin thinking and keeps Zen",
    async () => {
      const { providers } = await registerWith({
        [CATALOG_URL]: "fail",
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      assert.deepEqual(modelOf(providers, "opencode-go", DEEPSEEK).thinkingLevelMap, DS_FLASH_MAP);
      assert.equal(modelOf(providers, "opencode-go", UNKNOWN_GO).reasoning, false);
      assert.equal(modelOf(providers, "opencode-go", UNKNOWN_GO).thinkingLevelMap, undefined);
      assert.equal(reasoningFlag(modelOf(providers, "opencode-go", GLM)), false);
      assertZenRoutes(providers);
    });

  test("Zen keeps legacy think map when catalog advertises max",
    async () => {
      const zen = zenCatalogModels();
      zen[GROK].reasoning = true;
      zen[GROK].reasoning_options = [{ type: "effort", values: ["low", "high", "max"] }];
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zen }, "opencode-go": { models: goCatalogModels() } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const grok = modelOf(providers, "opencode-zen-compat", GROK);
      assert.equal(grok.reasoning, true);
      assert.equal(grok.thinkingLevelMap?.medium, "medium");
      assert.equal(grok.thinkingLevelMap?.xhigh, "max");
      assert.equal(grok.thinkingLevelMap?.max, undefined);
      assert.equal(grok.thinkingLevelMap?.off, "none");
    });

  test("toggle and budget stay conservative without inventing effort",
    async () => {
      const go = goCatalogModels();
      go[DEEPSEEK].reasoning = true;
      go[DEEPSEEK].reasoning_options = [{ type: "toggle" }];
      go[UNKNOWN_GO].reasoning = true;
      go[UNKNOWN_GO].reasoning_options = [{ type: "budget_tokens", min: 128, max: 4096 }];
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const toggled = modelOf(providers, "opencode-go", DEEPSEEK);
      assert.equal(toggled.reasoning, true);
      assert.equal(toggled.thinkingLevelMap?.off, "none");
      assert.equal(toggled.thinkingLevelMap?.low, null);
      assert.deepEqual(getSupportedThinkingLevels(asGoCompletionsModel(toggled)), ["off", "high"]);
      const togglePayload = await completionsPayload(toggled, "high");
      assert.deepEqual(togglePayload?.thinking, { type: "enabled" });
      assert.equal(togglePayload?.reasoning_effort, undefined);
      assert.equal(toggled.compat?.supportsReasoningEffort, false);
      assert.equal(toggled.compat?.thinkingFormat, "deepseek");
      const budget = modelOf(providers, "opencode-go", UNKNOWN_GO);
      assert.equal(budget.reasoning, false);
      assert.equal(budget.thinkingLevelMap, undefined);
    });

  test("streamSimple sends DeepSeek Flash max and off payloads",
    async () => {
      const go = goCatalogModels();
      go[DEEPSEEK].reasoning = true;
      go[DEEPSEEK].reasoning_options = [{ type: "effort", values: ["low", "high", "max"] }];
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const model = modelOf(providers, "opencode-go", DEEPSEEK);
      const maxPayload = await completionsPayload(model, "max");
      assert.equal(maxPayload?.model, DEEPSEEK);
      assert.deepEqual(maxPayload?.thinking, { type: "enabled" });
      assert.equal(maxPayload?.reasoning_effort, "max");
      const mediumPayload = await completionsPayload(model, "medium");
      assert.equal(mediumPayload?.reasoning_effort, "high");
      const xhighPayload = await completionsPayload(model, "xhigh");
      assert.equal(xhighPayload?.reasoning_effort, "max");
      const offPayload = await completionsPayload(model);
      assert.deepEqual(offPayload?.thinking, { type: "disabled" });
      assert.equal(offPayload?.reasoning_effort, undefined);
    });

  test("Go GLM Flash preserves automatic reasoning without rejected controls", async () => {
    const go = goCatalogModels();
    go["glm-5.3-flash"] = {
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      interleaved: { field: "reasoning_content" },
    };
    const { providers } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody([...GO_LIVE, "glm-5.3-flash"]),
    });
    const model = modelOf(providers, "opencode-go", "glm-5.3-flash");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.reasoning, false);
    assert.deepEqual(getSupportedThinkingLevels(asGoCompletionsModel(model)), ["off"]);
    assert.equal(reasoningFlag(model), true);
    const payload = await completionsPayload(model);
    assert.equal(payload?.thinking, undefined);
    assert.equal(payload?.reasoning_effort, undefined);
    assert.equal(payload?.reasoning, undefined);
    const replay = await completionsPayload(model, undefined, priorConversation("glm-5.3-flash", "previous reasoning"));
    const messages = replay?.messages as { role: string; reasoning_content?: string }[];
    assert.equal(messages.find((message) => message.role === "assistant")?.reasoning_content, "previous reasoning");
  });

  test("Go reasoning history reaches the DeepSeek wire field", async () => {
    const { providers } = await registerWith(completeFixture());
    const model = modelOf(providers, "opencode-go", DEEPSEEK);
    const payload = await completionsPayload(model, "max", priorConversation(DEEPSEEK, "previous reasoning"));
    const messages = payload?.messages as { role: string; content: string; reasoning_content?: string }[];
    const assistant = messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.content, "Previous answer");
    assert.equal(assistant?.reasoning_content, "previous reasoning");
  });

  test("Go null effort never invents a native none value", async () => {
    const go = goCatalogModels();
    go[UNKNOWN_GO].reasoning = true;
    go[UNKNOWN_GO].reasoning_options = [{ type: "effort", values: [null, "high"] }];
    const { providers } = await registerWith({
      [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
      [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
      [GO_MODELS_URL]: liveBody(GO_LIVE),
    });
    const model = modelOf(providers, "opencode-go", UNKNOWN_GO);
    assert.equal(model.thinkingLevelMap?.off, null);
    const payload = await completionsPayload(model);
    assert.equal(payload?.reasoning_effort, undefined);
    assert.equal(payload?.thinking, undefined);
  });

  test("Go metadata boundaries preserve legal controls and safe defaults", async () => {
    const cases = [
      { id: UNKNOWN_GO, options: [{ type: "effort", values: ["constructor", "toString"] }], reasoning: false, levels: ["off"] },
      { id: DEEPSEEK, options: [{ type: "effort", values: "high" }], reasoning: true, levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { id: DEEPSEEK, options: [{ type: "budget_tokens", max: 4096 }], reasoning: false, levels: ["off"] },
      { id: DEEPSEEK, options: [{ type: "future_control", values: ["high"] }], reasoning: false, levels: ["off"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: [null] }], reasoning: false, levels: ["off"] },
      { id: DEEPSEEK, options: [{ type: "effort", values: [] }], reasoning: false, levels: ["off"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: ["none"] }], reasoning: true, levels: ["off"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: [null, "high"] }], reasoning: true, levels: ["minimal", "low", "medium", "high"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: ["low", "high"] }, { type: "toggle" }], reasoning: true, levels: ["minimal", "low", "medium", "high"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: ["high"] }, { type: "feature", values: ["max"] }], reasoning: true, levels: ["minimal", "low", "medium", "high"] },
      { id: UNKNOWN_GO, options: [{ type: "effort", values: ["max"] }], reasoning: true, levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    ];
    for (const entry of cases) {
      const go = goCatalogModels();
      go[entry.id].reasoning = true;
      go[entry.id].reasoning_options = entry.options;
      const { providers } = await registerWith({
        [CATALOG_URL]: { opencode: { models: zenCatalogModels() }, "opencode-go": { models: go } },
        [ZEN_MODELS_URL]: liveBody(ZEN_LIVE),
        [GO_MODELS_URL]: liveBody(GO_LIVE),
      });
      const model = modelOf(providers, "opencode-go", entry.id);
      const label = JSON.stringify(entry.options);
      assert.equal(model.reasoning, entry.reasoning, label);
      assert.deepEqual(getSupportedThinkingLevels(asGoCompletionsModel(model)), entry.levels, label);
      if (!entry.reasoning) {
        const payload = await completionsPayload(model);
        assert.equal(payload?.thinking, undefined, label);
        assert.equal(payload?.reasoning_effort, undefined, label);
      }
    }
  });
});
