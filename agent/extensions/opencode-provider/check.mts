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

const GO_LIVE = [MUSE_12, MUSE_13, MUSE_SIMILAR, DEEPSEEK, GLM, KIMI, QWEN_GO, MINIMAX, HY3, UNKNOWN_GO];
const ZEN_LIVE = [GPT, CLAUDE, QWEN_ZEN, GROK];
const GO_COMPLETIONS_IDS = [DEEPSEEK, GLM, KIMI, QWEN_GO, MINIMAX, HY3, UNKNOWN_GO, MUSE_SIMILAR];

type Compat = {
  supportsDeveloperRole?: boolean;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
};

type ModelConfig = {
  id: string;
  name?: string;
  api?: string;
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
});
