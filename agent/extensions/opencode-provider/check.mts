import { normalizeContext, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import register from "./index.ts";

const CATALOG_URL = "https://models.dev/api.json";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

const GPT = "gpt-5.1";
const GEMINI = "gemini-3-flash";
const CLAUDE = "claude-sonnet-4";
const GROK = "grok-4.5";
const ZEN_DEEPSEEK = "deepseek-v4.1-flash";
const KIMI = "kimi-k2.6";
const ZEN_UNKNOWN = "zen-unknown";

const GO_GLM = "glm-5.3-flash";
const GO_DEEPSEEK = "deepseek-v4.1-flash";
const GO_MINIMAX = "minimax-m3";
const GO_GPT = "gpt-5.6-luna";
const GO_UNKNOWN = "go-unknown";

const GLM_GO_LEVELS = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

type CapturedRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Fixture = { catalog: unknown | "fail"; zen: unknown | "fail"; go: unknown | "fail" };

function liveBody(ids: string[]) {
  return { data: ids.map((id) => ({ id })) };
}

function completeCatalog() {
  return {
    opencode: {
      models: Object.fromEntries([GPT, GEMINI, CLAUDE, GROK, ZEN_DEEPSEEK, KIMI, ZEN_UNKNOWN].map((id) => [id, { id }])),
    },
    "opencode-go": {
      models: Object.fromEntries([GO_GLM, GO_DEEPSEEK, GO_MINIMAX, GO_GPT, GO_UNKNOWN].map((id) => [id, { id }])),
    },
  };
}

function jsonResponse(value: unknown): Response {
  if (value === "fail") return new Response(null, { status: 503 });
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function sse(events: unknown[]): Response {
  const body = events
    .map((data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseTyped(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const COMPLETIONS_EVENTS = [
  { id: "c1", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
  { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  "[DONE]",
];

const RESPONSES_EVENTS = [
  { type: "response.created", response: { id: "r1", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "i1", type: "message", status: "in_progress", role: "assistant", content: [] },
  },
  {
    type: "response.content_part.added",
    item_id: "i1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "OK" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "i1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    },
  },
  {
    type: "response.completed",
    response: {
      id: "r1",
      status: "completed",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  },
];

const ANTHROPIC_EVENTS: Record<string, unknown>[] = [
  {
    type: "message_start",
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      model: CLAUDE,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "thought", signature: "anthropic-signature" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " thought" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-continued" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const GOOGLE_CHUNK = {
  responseId: "g1",
  candidates: [{ content: { role: "model", parts: [
    { text: "thought", thought: true, thoughtSignature: "Z29vZ2xlLXNpZ25hdHVyZQ==" },
    { text: "OK", thoughtSignature: "Z29vZ2xlLXNpZ25hdHVyZQ==" },
  ] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokens: 2 },
};

function responseFor(url: string): Response {
  if (url.includes("/chat/completions")) return sse(COMPLETIONS_EVENTS);
  if (url.includes("/responses")) return sse(RESPONSES_EVENTS);
  if (url.includes("/messages")) return sseTyped(ANTHROPIC_EVENTS);
  if (url.includes(":streamGenerateContent")) return sse([GOOGLE_CHUNK]);
  return new Response(`unexpected transport url ${url}`, { status: 500 });
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (!headers) return undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (String(key).toLowerCase() === name.toLowerCase()) return String(value);
  }
  return undefined;
}

function capture(url: string, init: unknown): CapturedRequest {
  const request = (init ?? {}) as { headers?: unknown; body?: unknown };
  const headers: Record<string, string> = {};
  const raw = request.headers;
  const entries = raw instanceof Headers ? [...raw.entries()] : Array.isArray(raw) ? raw : Object.entries((raw ?? {}) as Record<string, unknown>);
  for (const [key, value] of entries) headers[String(key).toLowerCase()] = String(value);
  return {
    url,
    headers,
    body: typeof request.body === "string" ? (JSON.parse(request.body) as Record<string, unknown>) : {},
  };
}

async function harness(fixture: Partial<Fixture> = {}) {
  const config: Fixture = {
    catalog: completeCatalog(),
    zen: liveBody([GPT, GEMINI, CLAUDE, GROK, ZEN_DEEPSEEK, KIMI]),
    go: liveBody([GO_GLM, GO_DEEPSEEK, GO_MINIMAX, GO_GPT]),
    ...fixture,
  };
  const transportRequests: CapturedRequest[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (url === CATALOG_URL) return jsonResponse(config.catalog);
    if (url === ZEN_MODELS_URL) return jsonResponse(config.zen);
    if (url === GO_MODELS_URL) return jsonResponse(config.go);
    transportRequests.push(capture(url, init));
    return responseFor(url);
  }) as typeof fetch;
  const providers = new Map<string, any>();
  await register({
    registerProvider: (provider: { id: string }) => void providers.set(provider.id, provider),
  } as never);
  return {
    providers,
    transportRequests,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

function providerOf(providers: Map<string, any>, id: string) {
  const provider = providers.get(id);
  assert.ok(provider, `provider ${id} registered`);
  return provider;
}

type TestModel = Omit<Model<any>, "compat"> & { compat?: any };

function modelOf(providers: Map<string, any>, providerId: string, modelId: string): TestModel {
  const found = providerOf(providers, providerId)
    .getModels()
    .filter((model: Model<any>) => model.id === modelId);
  assert.equal(found.length, 1, `${providerId}/${modelId} registered exactly once`);
  return found[0] as TestModel;
}

function modelIds(providers: Map<string, any>, providerId: string): string[] {
  return providerOf(providers, providerId)
    .getModels()
    .map((model: Model<any>) => model.id)
    .sort();
}

async function runSimple(provider: any, model: Model<any>, context: Context, options: Record<string, unknown>): Promise<AssistantMessage> {
  const stream = provider.streamSimple(model, normalizeContext(context), { apiKey: "test-key", maxTokens: 64, ...options });
  return (await stream.result()) as AssistantMessage;
}

async function runRaw(provider: any, model: Model<any>, options: Record<string, unknown>): Promise<AssistantMessage> {
  const stream = provider.stream(model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }), {
    apiKey: "test-key",
    ...options,
  });
  return (await stream.result()) as AssistantMessage;
}

function assertText(result: AssistantMessage, text: string) {
  assert.equal(result.stopReason, "stop", result.errorMessage ?? "stream failed");
  assert.deepEqual(
    result.content.filter((block) => block.type === "text").map((block) => block.text),
    [text],
  );
}

function assistantHistory(model: string, provider: string, thinking?: string): Context["messages"] {
  return [
    { role: "user", content: "previous", timestamp: 0 },
    {
      role: "assistant",
      content: [
        ...(thinking === undefined ? [] : [{ type: "thinking" as const, thinking, thinkingSignature: "reasoning" }]),
        { type: "text", text: "previous answer" },
      ],
      api: "openai-completions",
      provider,
      model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    },
    { role: "user", content: "next", timestamp: 2 },
  ];
}

function lastRequest(requests: CapturedRequest[], suffix: string): CapturedRequest {
  const found = requests.filter((request) => request.url.includes(suffix));
  assert.ok(found.length > 0, `captured a request for ${suffix}`);
  return found[found.length - 1];
}

describe("opencode-provider native registration", { concurrency: false }, () => {
  test("four native providers keep their identity and env keys", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      assert.deepEqual(
        [...providers.keys()].sort(),
        ["opencode", "opencode-go", "opencode-zen-anthropic", "opencode-zen-compat"],
      );
      const expected = [
        ["opencode", "OpenCode Zen", "https://opencode.ai/zen/v1", "OPENCODE_ZEN_API_KEY"],
        ["opencode-zen-anthropic", "OpenCode Zen (Anthropic)", "https://opencode.ai/zen/v1", "OPENCODE_ZEN_API_KEY"],
        ["opencode-zen-compat", "OpenCode Zen (Compat)", "https://opencode.ai/zen/v1", "OPENCODE_ZEN_API_KEY"],
        ["opencode-go", "OpenCode Go", "https://opencode.ai/zen/go/v1", "OPENCODE_GO_API_KEY"],
      ];
      for (const [id, name, baseUrl, env] of expected) {
        const provider = providerOf(providers, id);
        assert.equal(provider.name, name);
        assert.equal(provider.baseUrl, baseUrl);
        assert.deepEqual(provider.headers, { "X-Title": "pi-agent" });
        const auth = provider.auth.apiKey;
        assert.equal(auth.name, `${name} API key`);
        const signal = new AbortController().signal;
        const resolved = await auth.resolve({
          ctx: { env: async (key: string) => (key === env ? `${env}-value` : undefined) },
          signal,
        } as never);
        assert.equal(resolved?.source, env);
        assert.deepEqual(resolved?.auth, { apiKey: `${env}-value` });
        const foreign = await auth.resolve({
          ctx: { env: async (key: string) => (key === "OPENCODE_API_KEY" ? "wrong" : undefined) },
          signal,
        } as never);
        assert.equal(foreign, undefined);
      }
      assert.equal(transportRequests.length, 0);
    } finally {
      restore();
    }
  });

  test("builtin routes decide every API and model baseUrl", async () => {
    const { providers, restore } = await harness();
    try {
      const routes: [string, string, string, string][] = [
        ["opencode", GPT, "openai-responses", "https://opencode.ai/zen/v1"],
        ["opencode", GEMINI, "google-generative-ai", "https://opencode.ai/zen/v1"],
        ["opencode", GROK, "openai-responses", "https://opencode.ai/zen/v1"],
        ["opencode-zen-anthropic", CLAUDE, "anthropic-messages", "https://opencode.ai/zen"],
        ["opencode-zen-compat", ZEN_DEEPSEEK, "openai-completions", "https://opencode.ai/zen/v1"],
        ["opencode-zen-compat", KIMI, "openai-completions", "https://opencode.ai/zen/v1"],
        ["opencode-go", GO_MINIMAX, "anthropic-messages", "https://opencode.ai/zen/go"],
        ["opencode-go", GO_GLM, "openai-completions", "https://opencode.ai/zen/go/v1"],
        ["opencode-go", GO_DEEPSEEK, "openai-completions", "https://opencode.ai/zen/go/v1"],
        ["opencode-go", GO_GPT, "openai-responses", "https://opencode.ai/zen/go/v1"],
      ];
      for (const [providerId, modelId, api, baseUrl] of routes) {
        const model = modelOf(providers, providerId, modelId);
        assert.equal(model.api, api, `${providerId}/${modelId} api`);
        assert.equal(model.baseUrl, baseUrl, `${providerId}/${modelId} baseUrl`);
        assert.equal(model.provider, providerId, `${providerId}/${modelId} provider`);
      }
      assert.deepEqual(modelIds(providers, "opencode"), [GEMINI, GPT, GROK]);
      assert.deepEqual(modelIds(providers, "opencode-zen-anthropic"), [CLAUDE]);
      assert.deepEqual(modelIds(providers, "opencode-zen-compat"), [ZEN_DEEPSEEK, KIMI]);
      assert.deepEqual(modelIds(providers, "opencode-go"), [GO_DEEPSEEK, GO_GLM, GO_GPT, GO_MINIMAX]);
    } finally {
      restore();
    }
  });

  test("metadata, limits, cost and verified compat survive projection", async () => {
    const { providers, restore } = await harness();
    try {
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assert.equal(deepseek.contextWindow, 1000000);
      assert.equal(deepseek.maxTokens, 384000);
      assert.deepEqual(deepseek.input, ["text", "image"]);
      assert.deepEqual(deepseek.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
      assert.equal(deepseek.compat?.requiresReasoningContentOnAssistantMessages, true);
      assert.equal(deepseek.compat?.thinkingFormat, "deepseek");
      assert.equal(deepseek.compat?.maxTokensField, "max_tokens");
      const kimi = modelOf(providers, "opencode-zen-compat", KIMI);
      assert.equal(kimi.contextWindow, 262144);
      assert.equal(kimi.maxTokens, 65536);
      assert.deepEqual(kimi.input, ["text", "image"]);
      assert.equal(kimi.compat?.thinkingFormat, "deepseek");
      assert.equal(kimi.compat?.supportsReasoningEffort, false);
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assert.equal(claude.contextWindow, 200000);
      assert.equal(claude.maxTokens, 64000);
      assert.deepEqual(claude.input, ["text", "image"]);
      assert.deepEqual(claude.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    } finally {
      restore();
    }
  });

  test("unknown catalog and discovery ids stay excluded", async () => {
    const { providers, restore } = await harness();
    try {
      assert.deepEqual(modelIds(providers, "opencode"), [GEMINI, GPT, GROK]);
      assert.deepEqual(modelIds(providers, "opencode-go"), [GO_DEEPSEEK, GO_GLM, GO_GPT, GO_MINIMAX]);
    } finally {
      restore();
    }
  });

  test("catalog and discovery failures stay independent", async () => {
    const catalogFailed = await harness({ catalog: "fail" });
    try {
      assert.deepEqual(modelIds(catalogFailed.providers, "opencode"), [GEMINI, GPT, GROK]);
      assert.deepEqual(modelIds(catalogFailed.providers, "opencode-go"), [GO_DEEPSEEK, GO_GLM, GO_GPT, GO_MINIMAX]);
    } finally {
      catalogFailed.restore();
    }

    const zenFailed = await harness({ zen: "fail", go: liveBody([]) });
    try {
      assert.deepEqual(modelIds(zenFailed.providers, "opencode"), [GEMINI, GPT, GROK]);
      assert.deepEqual(modelIds(zenFailed.providers, "opencode-zen-anthropic"), [CLAUDE]);
      assert.deepEqual(modelIds(zenFailed.providers, "opencode-go"), []);
    } finally {
      zenFailed.restore();
    }

    const emptySections = await harness({ catalog: { opencode: { models: {} }, "opencode-go": { models: {} } } });
    try {
      assert.deepEqual(modelIds(emptySections.providers, "opencode"), []);
      assert.deepEqual(modelIds(emptySections.providers, "opencode-zen-compat"), []);
      assert.deepEqual(modelIds(emptySections.providers, "opencode-go"), []);
    } finally {
      emptySections.restore();
    }

    const malformedSection = await harness({ catalog: { opencode: { models: 7 }, "opencode-go": { models: {} } } });
    try {
      assert.deepEqual(modelIds(malformedSection.providers, "opencode"), [GEMINI, GPT, GROK]);
      assert.deepEqual(modelIds(malformedSection.providers, "opencode-go"), []);
    } finally {
      malformedSection.restore();
    }
  });

  test("catalog sections narrow membership independently of discovery", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, unknown> }>;
    delete catalog.opencode.models[GEMINI];
    const { providers, restore } = await harness({ catalog });
    try {
      assert.deepEqual(modelIds(providers, "opencode"), [GPT, GROK]);
      assert.deepEqual(modelIds(providers, "opencode-go"), [GO_DEEPSEEK, GO_GLM, GO_GPT, GO_MINIMAX]);
    } finally {
      restore();
    }
  });

  test("catalog reasoning_options narrow controls without inventing wire formats", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_DEEPSEEK].reasoning = false;
    catalog.opencode.models[CLAUDE].reasoning_options = { not: "an array" };
    const { providers, restore } = await harness({ catalog });
    try {
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assert.equal(deepseek.reasoning, false);
      assert.equal(deepseek.thinkingLevelMap, undefined);
      assert.equal(deepseek.compat?.supportsReasoningEffort, false);
      assert.equal(deepseek.compat?.thinkingFormat, "deepseek");
      assert.equal(deepseek.compat?.requiresReasoningContentOnAssistantMessages, true);
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assert.equal(claude.reasoning, true);
      assert.deepEqual(getSupportedThinkingLevels(claude), ["off", "high"]);
    } finally {
      restore();
    }
  });

  test("verified GLM Go aliases replace the builtin map", async () => {
    const { providers, restore } = await harness();
    try {
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      assert.equal(glm.reasoning, true);
      assert.deepEqual(glm.thinkingLevelMap, GLM_GO_LEVELS);
      assert.equal(glm.compat?.supportsReasoningEffort, true);
      assert.equal(glm.compat?.thinkingFormat, undefined);
      assert.deepEqual(getSupportedThinkingLevels(glm), ["minimal", "low", "medium", "high", "xhigh", "max"]);
    } finally {
      restore();
    }
  });

  test("streamSimple sends mapped GLM effort and never a thinking field", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      assertText(await runSimple(provider, glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const high = lastRequest(transportRequests, "/chat/completions");
      assert.equal(high.url, "https://opencode.ai/zen/go/v1/chat/completions");
      assert.equal(high.body.model, GO_GLM);
      assert.equal(high.body.reasoning_effort, "high");
      assert.equal(high.body.thinking, undefined);
      assertText(await runSimple(provider, glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "medium" }), "OK");
      assert.equal(lastRequest(transportRequests, "/chat/completions").body.reasoning_effort, "high");
      assertText(await runSimple(provider, glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}), "OK");
      const off = lastRequest(transportRequests, "/chat/completions");
      assert.equal(off.body.reasoning_effort, undefined);
      assert.equal(off.body.thinking, undefined);
      assert.equal(off.body.reasoning, undefined);
    } finally {
      restore();
    }
  });

  test("onPayload replacement cannot re-enable denied controls", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      assertText(
        await runSimple(provider, glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          reasoning: "high",
          onPayload: (payload: Record<string, unknown>) => ({ ...payload, thinking: { type: "enabled" }, reasoning: { effort: "high" }, budget_tokens: 99 }),
        }),
        "OK",
      );
      const replaced = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(replaced.thinking, undefined);
      assert.equal(replaced.reasoning, undefined);
      assert.equal(replaced.reasoning_effort, "high");
      assertText(
        await runSimple(provider, glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          reasoning: "high",
          onPayload: (payload: Record<string, unknown>) => ({ ...payload, reasoning_effort: "medium" }),
        }),
        "OK",
      );
      assert.equal(lastRequest(transportRequests, "/chat/completions").body.reasoning_effort, undefined);
    } finally {
      restore();
    }
  });

  test("catalog-denied reasoning strips injected effort before dispatch", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_DEEPSEEK].reasoning = false;
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const provider = providerOf(providers, "opencode-go");
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assertText(
        await runSimple(provider, deepseek, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          reasoning: "high",
          onPayload: (payload: Record<string, unknown>) => ({ ...payload, reasoning_effort: "max", thinking: { type: "enabled" } }),
        }),
        "OK",
      );
      const body = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking, undefined);
    } finally {
      restore();
    }
  });

  test("Completions carries the session header, explicit override and reasoning replay", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      const history = assistantHistory(GO_DEEPSEEK, "opencode-go", "previous reasoning");
      assertText(await runSimple(provider, deepseek, { messages: history }, { reasoning: "max", sessionId: "sess-abc" }), "OK");
      const request = lastRequest(transportRequests, "/chat/completions");
      assert.equal(request.url, "https://opencode.ai/zen/go/v1/chat/completions");
      assert.equal(request.headers["x-opencode-session"], "sess-abc");
      assert.equal(request.body.reasoning_effort, "max");
      assert.deepEqual(request.body.thinking, { type: "enabled" });
      const messages = request.body.messages as { role: string; reasoning_content?: string; content?: string }[];
      const assistant = messages.find((message) => message.role === "assistant");
      assert.equal(assistant?.reasoning_content, "previous reasoning");
      assert.equal(assistant?.content, "previous answer");

      assertText(
        await runSimple(provider, deepseek, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          sessionId: "sess-abc",
          headers: { "X-Opencode-Session": "explicit" },
        }),
        "OK",
      );
      assert.equal(lastRequest(transportRequests, "/chat/completions").headers["x-opencode-session"], "explicit");
    } finally {
      restore();
    }
  });

  test("tool calls and tool results replay unchanged", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      const messages: Context["messages"] = [
        { role: "user", content: "use the tool", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a.txt" } },
          ],
          api: "openai-completions",
          provider: "opencode-go",
          model: GO_DEEPSEEK,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text" as const, text: "file body" }],
          isError: false,
          timestamp: 2,
        },
        { role: "user", content: "continue", timestamp: 3 },
      ];
      assertText(await runSimple(provider, deepseek, { messages }, { reasoning: "low" }), "OK");
      const sent = lastRequest(transportRequests, "/chat/completions").body.messages as Record<string, unknown>[];
      const assistant = sent.find((message) => message.role === "assistant");
      const toolCalls = assistant?.tool_calls as { id: string; function: { name: string; arguments: string } }[];
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0].id, "call-1");
      assert.equal(toolCalls[0].function.name, "read");
      assert.equal(toolCalls[0].function.arguments, '{"path":"a.txt"}');
      const result = sent.find((message) => message.role === "tool");
      assert.equal(result?.tool_call_id, "call-1");
      assert.equal(result?.content, "file body");
    } finally {
      restore();
    }
  });

  test("reasoning replay emits an empty required reasoning_content field", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assertText(await runSimple(provider, deepseek, { messages: assistantHistory(GO_DEEPSEEK, "opencode-go") }, { reasoning: "low" }), "OK");
      const sent = lastRequest(transportRequests, "/chat/completions").body.messages as Record<string, unknown>[];
      const assistant = sent.find((message) => message.role === "assistant");
      assert.equal(assistant?.reasoning_content, "");
    } finally {
      restore();
    }
  });

  test("raw stream dispatch routes the Zen Anthropic alias to its model baseUrl", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-zen-anthropic");
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      const result = await runRaw(provider, claude, { sessionId: "sess-raw" });
      assertText(result, "OK");
      const thought = result.content.find((block) => block.type === "thinking");
      assert.ok(thought && thought.type === "thinking");
      assert.equal(thought.thinkingSignature, "anthropic-signature-continued");
      const request = lastRequest(transportRequests, "/messages");
      assert.equal(request.url, "https://opencode.ai/zen/v1/messages?beta=true");
      assert.equal(request.headers["x-opencode-session"], "sess-raw");
      assert.equal(request.headers["x-title"], "pi-agent");
      assert.equal(request.body.model, CLAUDE);
      await runSimple(provider, claude, { messages: [
        { role: "user", content: "first", timestamp: 0 },
        result,
        { role: "user", content: "continue", timestamp: 2 },
      ] }, {});
      const replay = lastRequest(transportRequests, "/messages").body.messages as { content: { type: string; signature?: string }[] }[];
      const replayedThinking = replay.flatMap((message) => message.content).find((block) => block.type === "thinking");
      assert.equal(replayedThinking?.signature, "anthropic-signature-continued");
    } finally {
      restore();
    }
  });

  test("Responses requests reach the routed URL with the mapped effort", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode");
      const gpt = modelOf(providers, "opencode", GPT);
      assertText(await runSimple(provider, gpt, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high", sessionId: "sess-r" }), "OK");
      const request = lastRequest(transportRequests, "/responses");
      assert.equal(request.url, "https://opencode.ai/zen/v1/responses");
      assert.equal(request.body.model, GPT);
      assert.deepEqual(request.body.reasoning, { effort: "high", summary: "auto" });
      assert.equal(request.headers["x-opencode-session"], "sess-r");
    } finally {
      restore();
    }
  });

  test("Anthropic requests keep thinking config on Zen models", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const anthropic = providerOf(providers, "opencode-zen-anthropic");
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assertText(await runSimple(anthropic, claude, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const request = lastRequest(transportRequests, "/messages");
      assert.equal(request.url, "https://opencode.ai/zen/v1/messages?beta=true");
      const thinking = request.body.thinking as { type: string; budget_tokens: unknown; display: string };
      assert.equal(thinking.type, "enabled");
      assert.equal(thinking.display, "summarized");
      assert.equal(typeof thinking.budget_tokens, "number");
      assert.ok((thinking.budget_tokens as number) > 0);
    } finally {
      restore();
    }
  });

  test("Google requests reach the Zen Google route with thinkingConfig", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode");
      const gemini = modelOf(providers, "opencode", GEMINI);
      const result = await runSimple(provider, gemini, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "medium" });
      assertText(result, "OK");
      const thought = result.content.find((block) => block.type === "thinking");
      assert.ok(thought && thought.type === "thinking");
      assert.equal(thought.thinkingSignature, "Z29vZ2xlLXNpZ25hdHVyZQ==");
      const request = lastRequest(transportRequests, "alt=sse");
      assert.equal(request.url, `https://opencode.ai/zen/v1/models/${GEMINI}:streamGenerateContent?alt=sse`);
      const config = request.body.generationConfig as Record<string, unknown>;
      assert.equal(config.maxOutputTokens, 64);
      assert.deepEqual(config.thinkingConfig, { includeThoughts: true, thinkingLevel: "MEDIUM" });
      await runSimple(provider, gemini, { messages: [
        { role: "user", content: "first", timestamp: 0 },
        result,
        { role: "user", content: "continue", timestamp: 2 },
      ] }, { reasoning: "medium" });
      const replay = lastRequest(transportRequests, "alt=sse").body.contents as { parts: { thoughtSignature?: string }[] }[];
      assert.ok(replay.some((content) => content.parts.some((part) => part.thoughtSignature === "Z29vZ2xlLXNpZ25hdHVyZQ==")));
    } finally {
      restore();
    }
  });

  test("verified GLM aliases stay on the exact probe-verified model only", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, unknown> }>;
    catalog["opencode-go"].models["glm-5.3"] = { id: "glm-5.3" };
    const { providers, restore } = await harness({
      catalog,
      go: liveBody([GO_GLM, GO_DEEPSEEK, GO_MINIMAX, GO_GPT, "glm-5.3"]),
    });
    try {
      assert.deepEqual(modelOf(providers, "opencode-go", GO_GLM).thinkingLevelMap, GLM_GO_LEVELS);
      const other = modelOf(providers, "opencode-go", "glm-5.3");
      assert.equal(other.reasoning, true);
      assert.deepEqual(getSupportedThinkingLevels(other), ["low", "high", "max"]);
      assert.equal(other.thinkingLevelMap?.minimal, null);
      assert.equal(other.thinkingLevelMap?.medium, null);
      assert.equal(other.thinkingLevelMap?.xhigh, null);
    } finally {
      restore();
    }
  });

  test("catalog effort narrows verified Go completion values", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_DEEPSEEK].reasoning_options = [{ type: "effort", values: ["high"] }];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assert.deepEqual(deepseek.thinkingLevelMap, {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      });
      assert.equal(deepseek.compat?.supportsReasoningEffort, true);
      const provider = providerOf(providers, "opencode-go");
      assertText(await runSimple(provider, deepseek, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "max" }), "OK");
      const body = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(body.reasoning_effort, "high");
      assert.deepEqual(body.thinking, { type: "enabled" });
    } finally {
      restore();
    }
  });

  test("catalog budget keeps the verified Anthropic budget path", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models[CLAUDE].reasoning_options = [{ type: "budget_tokens", min: 1024 }];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assert.equal(claude.reasoning, true);
      assert.equal(claude.compat?.supportsReasoningEffort, undefined);
      const provider = providerOf(providers, "opencode-zen-anthropic");
      assertText(await runSimple(provider, claude, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const thinking = lastRequest(transportRequests, "/messages").body.thinking as { type: string; budget_tokens: number };
      assert.equal(thinking.type, "enabled");
      assert.ok(thinking.budget_tokens > 0);
    } finally {
      restore();
    }
  });

  test("Anthropic guard removes only the denied effort field", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-zen-anthropic");
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assertText(
        await runSimple(provider, claude, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          reasoning: "high",
          onPayload: (payload: Record<string, unknown>) => ({
            ...payload,
            output_config: { effort: "high", format: { type: "json_schema" } },
          }),
        }),
        "OK",
      );
      const outputConfig = lastRequest(transportRequests, "/messages").body.output_config as Record<string, unknown>;
      assert.deepEqual(outputConfig, { format: { type: "json_schema" } });
    } finally {
      restore();
    }
  });

  test("effective registry overrides reach the guarded dispatch", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-go");
      const registered = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      const overridden = { ...registered, name: "Overridden", maxTokens: 123, headers: { "X-Custom": "yes" } };
      const stream = provider.streamSimple(
        overridden,
        normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
        { apiKey: "test-key", reasoning: "low" },
      );
      assertText((await stream.result()) as AssistantMessage, "OK");
      const request = lastRequest(transportRequests, "/chat/completions");
      assert.equal(request.body.max_tokens, 123);
      assert.equal(request.headers["x-custom"], "yes");
    } finally {
      restore();
    }
  });

  test("raw and simple dispatch reject unverified ids and API routes", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const provider = providerOf(providers, "opencode-zen-compat");
      const registered = modelOf(providers, "opencode-zen-compat", KIMI);
      const goProvider = providerOf(providers, "opencode-go");
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
      assert.throws(() => provider.streamSimple({ ...registered, id: "unregistered-kimi" }, context, { apiKey: "test-key" }), /Unverified OpenCode route/);
      assert.throws(() => goProvider.streamSimple({ ...glm, id: "unregistered-glm" }, context, { apiKey: "test-key" }), /Unverified OpenCode route/);
      assert.throws(() => goProvider.stream({ ...glm, api: "openai-responses" }, context, { apiKey: "test-key" }), /Unverified OpenCode route/);
      const overridden = { ...registered, baseUrl: "https://custom.example/v1" };
      const stream = provider.streamSimple(overridden, context, {
        apiKey: "test-key",
        onPayload: (payload: Record<string, unknown>) => ({ ...payload, reasoning_effort: "max" }),
      });
      assertText((await stream.result()) as AssistantMessage, "OK");
      const request = lastRequest(transportRequests, "/chat/completions");
      assert.equal(request.url, "https://custom.example/v1/chat/completions");
      assert.equal(request.body.reasoning_effort, undefined);
    } finally {
      restore();
    }
  });

  test("catalog effort independently narrows Responses and adaptive Anthropic", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models[GPT].reasoning_options = [{ type: "effort", values: ["high"] }];
    catalog.opencode.models["claude-opus-4-6"] = {
      id: "claude-opus-4-6",
      reasoning_options: [{ type: "effort", values: ["low"] }],
    };
    const { providers, transportRequests, restore } = await harness({ catalog, zen: liveBody([GPT, "claude-opus-4-6"]) });
    try {
      const gpt = modelOf(providers, "opencode", GPT);
      assert.deepEqual(getSupportedThinkingLevels(gpt), ["high"]);
      assertText(await runSimple(providerOf(providers, "opencode"), gpt, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "low" }), "OK");
      assert.equal((lastRequest(transportRequests, "/responses").body.reasoning as Record<string, unknown>).effort, "high");
      const claude = modelOf(providers, "opencode-zen-anthropic", "claude-opus-4-6");
      assert.ok(!getSupportedThinkingLevels(claude).includes("high"));
      assertText(await runSimple(providerOf(providers, "opencode-zen-anthropic"), claude, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      assert.equal((lastRequest(transportRequests, "/messages").body.output_config as Record<string, unknown>).effort, "low");
    } finally {
      restore();
    }
  });

  test("verified GLM effort aliases still obey catalog restrictions", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_GLM].reasoning_options = [{ type: "effort", values: ["high"] }];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      assert.deepEqual(getSupportedThinkingLevels(glm), ["medium", "high"]);
      assertText(await runSimple(providerOf(providers, "opencode-go"), glm, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "low" }), "OK");
      const body = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(body.reasoning_effort, "high");
      assert.equal(body.thinking, undefined);
    } finally {
      restore();
    }
  });

  test("unverified toggle format stays automatic without sending effort", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models["longcat-2.0"] = { id: "longcat-2.0", reasoning_options: [{ type: "toggle" }] };
    const { providers, transportRequests, restore } = await harness({ catalog, go: liveBody(["longcat-2.0"]) });
    try {
      const model = modelOf(providers, "opencode-go", "longcat-2.0");
      assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
      assertText(await runSimple(providerOf(providers, "opencode-go"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const body = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(body.model, "longcat-2.0");
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking, undefined);
    } finally {
      restore();
    }
  });

  test("GLM catalog reasoning replay survives missing thought history", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_GLM].interleaved = { field: "reasoning_content" };
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const model = modelOf(providers, "opencode-go", GO_GLM);
      assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true);
      assertText(await runSimple(providerOf(providers, "opencode-go"), model, { messages: assistantHistory(GO_GLM, "opencode-go") }, { reasoning: "high" }), "OK");
      const body = lastRequest(transportRequests, "/chat/completions").body;
      const messages = body.messages as Record<string, unknown>[];
      assert.equal(messages.find(message => message.role === "assistant")?.reasoning_content, "");
      assert.equal(body.reasoning_effort, "high");
    } finally {
      restore();
    }
  });

  test("payload replacements cannot inject wrong effort or budget fields", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const registered = modelOf(providers, "opencode-go", GO_GLM);
      const model = { ...registered, compat: { ...registered.compat, thinkingTokenBudgetField: "custom_budget" } };
      assertText(await runSimple(providerOf(providers, "opencode-go"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
        reasoning: "high",
        onPayload: async (payload: Record<string, unknown>) => ({
          ...payload,
          reasoning_effort: 123,
          budget_tokens: 99,
          thinking_token_budget: 99,
          custom_budget: 99,
          chat_template_kwargs: { reasoning_effort: "max", budget_tokens: 99, preserve_thinking: true, custom_setting: "keep" },
        }),
      }), "OK");
      const body = lastRequest(transportRequests, "/chat/completions").body;
      assert.equal(body.model, GO_GLM);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.budget_tokens, undefined);
      assert.equal(body.thinking_token_budget, undefined);
      assert.equal(body.custom_budget, undefined);
      assert.deepEqual(body.chat_template_kwargs, { custom_setting: "keep" });
    } finally {
      restore();
    }
  });

  test("malformed acquisition does not become a successful empty workspace", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, unknown> }>;
    catalog.opencode.models[GPT] = null;
    const { providers, restore } = await harness({ catalog, zen: { data: [null, { id: 7 }] } });
    try {
      assert.equal(modelOf(providers, "opencode", GPT).api, "openai-responses");
      assert.equal(modelOf(providers, "opencode-zen-anthropic", CLAUDE).api, "anthropic-messages");
      assert.equal(modelOf(providers, "opencode-go", GO_GLM).api, "openai-completions");
    } finally {
      restore();
    }
  });

  test("catalog cannot invent off while verified native none survives", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_DEEPSEEK].reasoning_options = [{ type: "effort", values: ["none", "high", "max"] }];
    catalog["opencode-go"].models.hy3 = { id: "hy3", reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] };
    const { providers, transportRequests, restore } = await harness({ catalog, go: liveBody([GO_DEEPSEEK, "hy3"]) });
    try {
      const provider = providerOf(providers, "opencode-go");
      const deepseek = modelOf(providers, "opencode-go", GO_DEEPSEEK);
      assert.ok(!getSupportedThinkingLevels(deepseek).includes("off"));
      assert.equal(deepseek.thinkingLevelMap?.off, null);
      const hy3 = modelOf(providers, "opencode-go", "hy3");
      assert.deepEqual(getSupportedThinkingLevels(hy3), ["off", "low", "high"]);
      assertText(await runSimple(provider, hy3, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}), "OK");
      assert.equal(lastRequest(transportRequests, "/chat/completions").body.reasoning_effort, "none");
    } finally {
      restore();
    }
  });

  test("withheld Responses controls preserve summary and encrypted replay", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models[GPT].reasoning_options = [];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const provider = providerOf(providers, "opencode");
      const model = modelOf(providers, "opencode", GPT);
      assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
      assertText(await runRaw(provider, model, { reasoningSummary: "auto" }), "OK");
      const body = lastRequest(transportRequests, "/responses").body;
      assert.deepEqual(body.reasoning, { summary: "auto" });
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      const reasoningItem = { id: "rs_test", type: "reasoning", encrypted_content: "opaque-encrypted-content", summary: [{ type: "summary_text", text: "Prior thought" }] };
      const assistant = assistantHistory(GPT, "opencode").find(message => message.role === "assistant");
      assert.ok(assistant && assistant.role === "assistant");
      const prior: AssistantMessage = {
        ...assistant,
        api: "openai-responses",
        content: [{ type: "thinking", thinking: "Prior thought", thinkingSignature: JSON.stringify(reasoningItem) }, { type: "text", text: "Prior answer" }],
      };
      assertText(await runSimple(provider, model, { messages: [{ role: "user", content: "prior", timestamp: 0 }, prior, { role: "user", content: "continue", timestamp: 2 }] }, {}), "OK");
      const input = lastRequest(transportRequests, "/responses").body.input as Record<string, unknown>[];
      assert.ok(input.some(item => item.type === "reasoning" && item.encrypted_content === "opaque-encrypted-content"));
    } finally {
      restore();
    }
  });

  test("toggle-only Anthropic retains its required budget dependency", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models[GO_MINIMAX].reasoning_options = [{ type: "toggle" }];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const model = modelOf(providers, "opencode-go", GO_MINIMAX);
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
      assertText(await runSimple(providerOf(providers, "opencode-go"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const thinking = lastRequest(transportRequests, "/messages").body.thinking as Record<string, unknown>;
      assert.equal(thinking.type, "enabled");
      assert.equal(typeof thinking.budget_tokens, "number");
      assert.ok(Number.isSafeInteger(thinking.budget_tokens) && Number(thinking.budget_tokens) >= 1024);
    } finally {
      restore();
    }
  });

  test("Google effort narrowing preserves output-only thought configuration", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models[GEMINI].reasoning_options = [{ type: "effort", values: ["low"] }];
    const { providers, transportRequests, restore } = await harness({ catalog });
    try {
      const model = modelOf(providers, "opencode", GEMINI);
      assert.deepEqual(getSupportedThinkingLevels(model), ["low"]);
      assertText(await runSimple(providerOf(providers, "opencode"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const config = lastRequest(transportRequests, "alt=sse").body.generationConfig as Record<string, unknown>;
      assert.deepEqual(config.thinkingConfig, { includeThoughts: true, thinkingLevel: "LOW" });
    } finally {
      restore();
    }
  });

  test("adaptive toggle-only models emit adaptive thinking without effort", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models["claude-opus-4-6"] = { id: "claude-opus-4-6", reasoning_options: [{ type: "toggle" }] };
    const { providers, transportRequests, restore } = await harness({ catalog, zen: liveBody(["claude-opus-4-6"]) });
    try {
      const model = modelOf(providers, "opencode-zen-anthropic", "claude-opus-4-6");
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
      assertText(await runSimple(providerOf(providers, "opencode-zen-anthropic"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { reasoning: "high" }), "OK");
      const body = lastRequest(transportRequests, "/messages").body;
      assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
      assert.equal(body.output_config, undefined);
    } finally {
      restore();
    }
  });

  test("Completions permits only the verified control namespace", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models.hy3 = { id: "hy3", reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] };
    const { providers, transportRequests, restore } = await harness({ catalog, go: liveBody([GO_DEEPSEEK, GO_GLM, "hy3"]) });
    try {
      const provider = providerOf(providers, "opencode-go");
      for (const id of [GO_DEEPSEEK, GO_GLM, "hy3"]) {
        const model = modelOf(providers, "opencode-go", id);
        assertText(await runSimple(provider, model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          reasoning: "high",
          onPayload: (payload: Record<string, unknown>) => ({
            ...payload,
            thinking: { type: id === "hy3" ? "disabled" : "enabled", budget_tokens: 99 },
            reasoning: id === GO_GLM ? 123 : true,
            enable_thinking: true,
          }),
        }), "OK");
        const body = lastRequest(transportRequests, "/chat/completions").body;
        assert.equal(body.model, id);
        assert.equal(body.reasoning, undefined);
        assert.equal(body.enable_thinking, undefined);
        assert.deepEqual(body.thinking, id === GO_DEEPSEEK ? { type: "enabled" } : undefined);
      }
    } finally {
      restore();
    }
  });

  test("raw Anthropic budget cannot exceed its output cap", async () => {
    const { providers, transportRequests, restore } = await harness();
    try {
      const model = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assertText(await runRaw(providerOf(providers, "opencode-zen-anthropic"), model, { thinkingEnabled: true, thinkingBudgetTokens: 1024, maxTokens: 64 }), "OK");
      const body = lastRequest(transportRequests, "/messages").body;
      assert.equal(body.max_tokens, 64);
      assert.equal(body.thinking, undefined);
    } finally {
      restore();
    }
  });

  test("native off-only evidence never exposes an invented on level", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog["opencode-go"].models.hy3 = { id: "hy3", reasoning_options: [{ type: "effort", values: ["none"] }] };
    const { providers, transportRequests, restore } = await harness({ catalog, go: liveBody(["hy3"]) });
    try {
      const model = modelOf(providers, "opencode-go", "hy3");
      assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
      assertText(await runSimple(providerOf(providers, "opencode-go"), model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}), "OK");
      assert.equal(lastRequest(transportRequests, "/chat/completions").body.reasoning_effort, "none");
    } finally {
      restore();
    }
  });

  test("catalog metadata overlays only validated values", async () => {
    const catalog = completeCatalog() as Record<string, { models: Record<string, Record<string, unknown>> }>;
    catalog.opencode.models[CLAUDE] = {
      id: CLAUDE,
      name: "Claude Sonnet 4 (Zen)",
      limit: { context: 123000, output: 45000 },
      cost: { input: 1.5, output: 7.5, cache_read: 0.15, cache_write: 1.5 },
      modalities: { input: ["text"] },
    };
    catalog["opencode-go"].models[GO_GLM] = {
      id: GO_GLM,
      name: "",
      limit: { context: "huge", output: -5 },
      cost: { input: "free" },
      modalities: { input: ["audio"] },
    };
    const { providers, restore } = await harness({ catalog });
    try {
      const claude = modelOf(providers, "opencode-zen-anthropic", CLAUDE);
      assert.equal(claude.name, "Claude Sonnet 4 (Zen)");
      assert.equal(claude.contextWindow, 123000);
      assert.equal(claude.maxTokens, 45000);
      assert.deepEqual(claude.cost, { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 });
      assert.deepEqual(claude.input, ["text"]);
      const glm = modelOf(providers, "opencode-go", GO_GLM);
      assert.equal(glm.name, "GLM-5.3-Flash");
      assert.equal(glm.contextWindow, 1000000);
      assert.equal(glm.maxTokens, 131072);
      assert.deepEqual(glm.input, ["text", "image"]);
      assert.deepEqual(glm.cost, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
    } finally {
      restore();
    }
  });
});
