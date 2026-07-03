import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.deepinfra.com/v1/openai";

interface DeepInfraModelMetadata {
	description?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
	};
	tags?: string[];
	context_length?: number;
	max_tokens?: number;
	input_modalities?: string[];
	output_modalities?: string[];
}

interface DeepInfraModel {
	id: string;
	name?: string;
	created?: number;
	owned_by?: string;
	object?: string;
	metadata?: DeepInfraModelMetadata;
}

async function fetchModels(apiKey: string | undefined): Promise<DeepInfraModel[]> {
	if (!apiKey) return [];

	const res = await fetch("https://api.deepinfra.com/v1/models", {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		throw new Error(`DeepInfra /v1/models failed: ${res.status} ${await res.text()}`);
	}

	const data = (await res.json()) as { data?: DeepInfraModel[] };
	return data.data ?? [];
}

function guessModelCapabilities(id: string): { reasoning: boolean; supportsReasoningEffort: boolean; input: ("text" | "image")[] } {
	const lower = id.toLowerCase();
	const supportsImages = /vl|vision|multimodal|llava|qwen2-vl|gemini/i.test(lower);
	const isReasoning = /reason|thinking|r1|deepseek|qwq|o1|o3|coder|v4|flash|kimi-k2|nemotron/i.test(lower);
	return {
		reasoning: isReasoning,
		supportsReasoningEffort: isReasoning, // fallback assumption
		input: supportsImages ? ["text", "image"] : ["text"],
	};
}

function toProviderModel(model: DeepInfraModel): ProviderModelConfig {
	const fallback = guessModelCapabilities(model.id);
	const metadata = model.metadata ?? {};
	const modalities = metadata.input_modalities ?? [];
	const pricing = metadata.pricing;
	const tags = metadata.tags ?? [];

	const input: ("text" | "image")[] =
		modalities.includes("image") ? ["text", "image"] : fallback.input;

	// Use API tags for reasoning support (more accurate than regex)
	const hasReasoningTag = tags.includes("reasoning");
	const hasReasoningEffortTag = tags.includes("reasoning_effort");
	const isReasoning = hasReasoningTag || hasReasoningEffortTag;
	const supportsReasoningEffort = hasReasoningEffortTag || hasReasoningTag;

	return {
		id: model.id,
		name: model.name || model.id.split("/").pop() || model.id,
		reasoning: isReasoning,
		input,
		contextWindow: metadata.context_length ?? 128000,
		maxTokens: metadata.max_tokens ?? 16384,
		cost: pricing ? {
			input: parseFloat(pricing.prompt ?? "0"),
			output: parseFloat(pricing.completion ?? "0"),
			cacheRead: parseFloat(pricing.input_cache_read ?? "0"),
			cacheWrite: 0,
		} : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: supportsReasoningEffort,
		},
		thinkingLevelMap: {
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
		},
	};
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
		name: "Qwen3 Coder 480B",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 16384,
		cost: { input: 0.30, output: 1.00, cacheRead: 0.10, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "deepseek-ai/DeepSeek-V4-Flash",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text"],
		contextWindow: 1048576,
		maxTokens: 16384,
		cost: { input: 0.09, output: 0.18, cacheRead: 0.018, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "deepseek-ai/DeepSeek-V3.2",
		name: "DeepSeek V3.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 16384,
		cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "meta-llama/Llama-4-Maverick-17B-128E",
		name: "Llama 4 Maverick 17B",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 16384,
		cost: { input: 0.15, output: 0.60, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
];

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env.DEEPINFRA_API_KEY;

	let models: ProviderModelConfig[];
	try {
		const deepinfraModels = await fetchModels(apiKey);
		models = deepinfraModels.length > 0 ? deepinfraModels.map(toProviderModel) : FALLBACK_MODELS;
	} catch (err) {
		console.error("[deepinfra-provider] Failed to fetch models, using fallback:", err);
		models = FALLBACK_MODELS;
	}

	pi.registerProvider("deepinfra", {
		name: "DeepInfra",
		baseUrl: BASE_URL,
		apiKey: "$DEEPINFRA_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models,
	});
}
