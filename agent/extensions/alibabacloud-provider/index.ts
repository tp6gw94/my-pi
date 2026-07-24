import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Alibaba Cloud Model Studio — Token Plan (Team Edition), OpenAI-compatible mode.
// Region is fixed by the plan; the key is the dedicated sk-sp- Token Plan key
// (not interchangeable with pay-as-you-go / Coding Plan keys).
const BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const API_KEY_ENV = "ALIBABA_CLOUD_API_KEY";
const PROVIDER = "alibabacloud";

interface ModelSpec {
	id: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

const THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

function isQwen(id: string) {
	return /^qwen/i.test(id);
}

// /models returns only ids; Alibaba publishes specs in docs, not the API.
const KNOWN_MODELS: Record<string, Omit<ModelSpec, "id">> = {
	"qwen3.8-max-preview": { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 },
	"qwen3.7-max":         { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 65_536 },
	"qwen3.7-plus":        { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 65_536 },
	"qwen3.6-flash":       { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 65_536 },
	"glm-5.2":             { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 },
	"deepseek-v4-pro":     { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 393_216 },
};

function resolveSpec(id: string): ModelSpec | undefined {
	const known = KNOWN_MODELS[id];
	if (known) return { id, ...known };
	// ponytail: conservative fallback for models added to Token Plan later
	const lower = id.toLowerCase();
	if (/^wan|image|video|audio|tts|ocr/i.test(lower)) return undefined;
	const reasoning = /qwen3|qwq|deepseek|kimi|glm|qwen-max|qwen-plus/i.test(lower);
	const vision = /vl|vision|multimodal|omni/i.test(lower);
	return { id, reasoning, input: vision ? ["text", "image"] : ["text"], contextWindow: 131_072, maxTokens: 8_192 };
}

function toConfig(spec: ModelSpec): ProviderModelConfig {
	const isReasoning = spec.reasoning;
	const compat: ProviderModelConfig["compat"] = { supportsDeveloperRole: false };
	if (isReasoning) {
		compat.supportsReasoningEffort = true;
		// pi injects enable_thinking from the thinking level via the qwen format.
		if (isQwen(spec.id)) compat.thinkingFormat = "qwen";
	}
	return {
		id: spec.id,
		name: spec.id,
		reasoning: isReasoning,
		input: spec.input,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat,
		thinkingLevelMap: isReasoning ? { ...THINKING_LEVEL_MAP } : undefined,
	};
}

// Model list is sourced live from the Token Plan endpoint; Alibaba does not
// publish a static catalog for it.
async function fetchModels(apiKey: string | undefined): Promise<ModelSpec[]> {
	if (!apiKey) return [];
	try {
		const res = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
		if (!res.ok) {
			console.error("[alibabacloud-provider] /models returned %d", res.status);
			return [];
		}
		const data = (await res.json()) as { data?: { id: string }[] };
		return (data.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.map(resolveSpec)
			.filter((s): s is ModelSpec => s !== undefined);
	} catch (err) {
		console.error("[alibabacloud-provider] failed to fetch models:", err);
		return [];
	}
}

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env[API_KEY_ENV];
	const specs = await fetchModels(apiKey);

	pi.registerProvider(PROVIDER, {
		name: "Alibaba Cloud Model Studio (Token Plan)",
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		authHeader: true,
		headers: { "X-Title": "pi-agent" },
		models: specs.map(toConfig),
	});
}
