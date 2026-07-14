import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai"
import { loginBrowser, loginDeviceCode, refreshAccessToken, XAI_BASE_URL, type OAuthResult } from "./xai-oauth"

const USER_AGENT = "pi-supergrok-extension/0.2.0"

interface XaiLanguageModel {
  id: string
  aliases?: string[]
  created?: number
  input_modalities?: string[]
  output_modalities?: string[]
  prompt_text_token_price?: number
  prompt_image_token_price?: number
  cached_prompt_text_token_price?: number
  cached_prompt_text_token_price_long_context?: number
  completion_text_token_price?: number
  completion_text_token_price_long_context?: number
  long_context_threshold?: number
  context_length?: number
  max_output_tokens?: number
  owned_by?: string
  version?: string
  fingerprint?: string
}

// openai-responses always sends reasoning.effort when model.reasoning + thinking level are set.
// xAI only accepts effort on a few models; others (e.g. grok-build) reject it with 400.
// All-null map → no effort payload; server still does always-on reasoning.
const NO_EFFORT_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
} as const

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>

function reasoningMeta(id: string): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  if (id.includes("non-reasoning")) return { reasoning: false }

  // https://docs.x.ai/developers/model-capabilities/text/reasoning
  if (id.startsWith("grok-4.5")) {
    return { reasoning: true, thinkingLevelMap: { off: null, minimal: null } } // low|medium|high
  }
  if (id.includes("multi-agent")) {
    return { reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" } }
  }

  // Always-on reasoning, effort not configurable (grok-build, 4.20-reasoning, 4.3, ...)
  return { reasoning: true, thinkingLevelMap: { ...NO_EFFORT_MAP } }
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
  { id: "grok-4.5", name: "Grok 4.5", ...reasoningMeta("grok-4.5"), input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, contextWindow: 500_000, maxTokens: 30_000 },
  { id: "grok-4.3", name: "Grok 4.3", ...reasoningMeta("grok-4.3"), input: ["text", "image"], cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 30_000 },
  { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", ...reasoningMeta("grok-4.20-0309-reasoning"), input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 30_000 },
  { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 Non-Reasoning", ...reasoningMeta("grok-4.20-0309-non-reasoning"), input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 30_000 },
  { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 Multi-Agent", ...reasoningMeta("grok-4.20-multi-agent-0309"), input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 30_000 },
  { id: "grok-build-0.1", name: "Grok Build", ...reasoningMeta("grok-build-0.1"), input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 30_000 },
]

function xaiPriceToDollars(centsPer100M: number): number {
  if (!centsPer100M) return 0
  return Number((centsPer100M / 100 / 100_000_000).toFixed(6))
}

function xaiModalityToInput(m: string): "text" | "image" | undefined {
  if (m === "text" || m === "image") return m
  return undefined
}

function isChatModel(m: XaiLanguageModel): boolean {
  if (!m.id.startsWith("grok")) return false
  const lower = m.id.toLowerCase()
  return !lower.includes("imagine") && !lower.includes("embedding") && !lower.includes("tts")
}

function contextWindowForModel(m: XaiLanguageModel): number {
  if (m.context_length) return m.context_length
  if (m.id.startsWith("grok-4.20")) return 2_000_000
  if (m.id.startsWith("grok-4.5")) return 500_000
  if (m.id.startsWith("grok-4.3")) return 1_000_000
  if (m.id.startsWith("grok-build")) return 256_000
  return 1_000_000
}

function defaultCostForModel(m: XaiLanguageModel): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  if (m.id.startsWith("grok-4.5")) return { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }
  if (m.id.startsWith("grok-4.3")) return { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 }
  if (m.id.startsWith("grok-build")) return { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 }
  return { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 }
}

function toProviderModel(m: XaiLanguageModel): ProviderModelConfig {
  const input = (m.input_modalities ?? [])
    .map(xaiModalityToInput)
    .filter((x): x is "text" | "image" => x !== undefined)
  const fallbackCost = defaultCostForModel(m)
  const { reasoning, thinkingLevelMap } = reasoningMeta(m.id)

  return {
    id: m.id,
    name: m.id,
    reasoning,
    thinkingLevelMap,
    input: input.length ? input : ["text", "image"],
    cost: {
      input: xaiPriceToDollars(m.prompt_text_token_price ?? fallbackCost.input * 100_000_000),
      output: xaiPriceToDollars(m.completion_text_token_price ?? fallbackCost.output * 100_000_000),
      cacheRead: xaiPriceToDollars(m.cached_prompt_text_token_price ?? fallbackCost.cacheRead * 100_000_000),
      cacheWrite: fallbackCost.cacheWrite,
    },
    contextWindow: contextWindowForModel(m),
    maxTokens: m.max_output_tokens ?? 30_000,
  }
}

async function fetchXaiLanguageModels(accessToken: string): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${XAI_BASE_URL}/language-models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI /language-models failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const payload = (await response.json()) as { models?: XaiLanguageModel[] }
  const models = payload.models ?? []
  return models.filter(isChatModel).map(toProviderModel)
}

function toCredentials(tokens: OAuthResult) {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
}

let discoveredModels: ProviderModelConfig[] | null = null
let discoveryInFlight: Promise<void> | null = null

function triggerDiscovery(accessToken: string): void {
  if (discoveryInFlight || discoveredModels) return
  discoveryInFlight = fetchXaiLanguageModels(accessToken)
    .then((models) => {
      if (models.length > 0) discoveredModels = models
    })
    .catch((err) => {
      console.warn("[supergrok] discovery failed:", err)
    })
    .finally(() => {
      discoveryInFlight = null
    })
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("supergrok", {
    name: "Super Grok (xAI OAuth)",
    baseUrl: XAI_BASE_URL,
    api: "openai-responses",
    authHeader: true,
    headers: { "User-Agent": USER_AGENT },
    models: FALLBACK_MODELS,
    oauth: {
      name: "xAI Super Grok",

      async login(callbacks) {
        const method = await callbacks.onSelect?.({
          message: "Connect Super Grok:",
          options: [
            { id: "browser", label: "Browser OAuth (default)" },
            { id: "device", label: "Device code (headless/VPS/SSH)" },
          ],
        })
        if (!method) throw new Error("Login cancelled")

        const tokens =
          method === "device"
            ? await loginDeviceCode(callbacks.onDeviceCode)
            : await loginBrowser(callbacks.onAuth)

        return toCredentials(tokens)
      },

      async refreshToken(credentials) {
        const tokens = await refreshAccessToken(credentials.refresh)
        return {
          access: tokens.access_token,
          refresh: tokens.refresh_token || credentials.refresh,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        }
      },

      getApiKey(credentials) {
        return credentials.access
      },

      modifyModels(models, credentials) {
        const typed = models as Model<Api>[]
        const others = typed.filter((m) => m.provider !== "supergrok")
        const template = typed.find((m) => m.provider === "supergrok")

        if (credentials.access) triggerDiscovery(credentials.access)

        const source = discoveredModels ?? FALLBACK_MODELS
        const ours = source.map((m) => ({
          ...(template ?? {}),
          ...m,
          provider: "supergrok",
          api: (template?.api as Api) ?? "openai-responses",
          baseUrl: template?.baseUrl ?? XAI_BASE_URL,
        })) as Model<Api>[]

        return [...others, ...ours]
      },
    },
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      // Belt: force correct thinkingLevelMap even if discovery/template dropped it.
      const meta = reasoningMeta(model.id)
      const patched = {
        ...model,
        reasoning: meta.reasoning,
        thinkingLevelMap: meta.thinkingLevelMap ?? model.thinkingLevelMap,
      } as Model<Api>
      return streamSimpleOpenAIResponses(patched as any, context, {
        ...options,
        headers: { ...options?.headers, "User-Agent": USER_AGENT },
      })
    },
  })
}
