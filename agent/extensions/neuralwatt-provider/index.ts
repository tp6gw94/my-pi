import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.neuralwatt.com/v1";

interface NeuralWattModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	max_model_len?: number;
	metadata?: {
		display_name?: string;
		capabilities?: {
			vision?: boolean;
			reasoning?: boolean;
		};
		limits?: {
			max_context_length?: number;
			max_output_tokens?: number | null;
		};
		pricing?: {
			input_per_million?: number;
			output_per_million?: number;
			cached_input_per_million?: number;
		};
	};
}

async function fetchModels(apiKey: string | undefined): Promise<NeuralWattModel[]> {
	if (!apiKey) return [];

	const res = await fetch(`${BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		throw new Error(`NeuralWatt /models failed: ${res.status} ${await res.text()}`);
	}

	const data = (await res.json()) as { data?: NeuralWattModel[] };
	return data.data ?? [];
}

function guessModelCapabilities(id: string): { reasoning: boolean; input: ("text" | "image")[] } {
	const lower = id.toLowerCase();
	const supportsImages = /vision|vl|multimodal|pixtral|llava|qwen2-vl|gemini/i.test(lower);
	const isReasoning = /reason|thinking|r1|deepseek|qwq|o1|o3/i.test(lower);
	return {
		reasoning: isReasoning,
		input: supportsImages ? ["text", "image"] : ["text"],
	};
}

function toProviderModel(model: NeuralWattModel): ProviderModelConfig {
	const fallback = guessModelCapabilities(model.id);
	const capabilities = model.metadata?.capabilities;
	const limits = model.metadata?.limits;
	const pricing = model.metadata?.pricing;

	const reasoning = capabilities?.reasoning ?? fallback.reasoning;
	const input: ("text" | "image")[] =
		capabilities?.vision === true ? ["text", "image"] :
		capabilities?.vision === false ? ["text"] :
		fallback.input;

	return {
		id: model.id,
		name: model.id.split("/").pop() ?? model.id,
		reasoning,
		input,
		contextWindow: limits?.max_context_length ?? model.max_model_len ?? 128000,
		maxTokens: limits?.max_output_tokens ?? 32768,
		cost: pricing ? {
			input: pricing.input_per_million ?? 0,
			output: pricing.output_per_million ?? 0,
			cacheRead: pricing.cached_input_per_million ?? 0,
			cacheWrite: 0,
		} : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false },
	};
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
		name: "Qwen3 Coder 480B",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false },
	},
];

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env.NEURALWATT_API_KEY;

	let models: ProviderModelConfig[];
	try {
		const neuralwattModels = await fetchModels(apiKey);
		models = neuralwattModels.length > 0 ? neuralwattModels.map(toProviderModel) : FALLBACK_MODELS;
	} catch (err) {
		console.error("[neuralwatt-provider] Failed to fetch models, using fallback:", err);
		models = FALLBACK_MODELS;
	}

	pi.registerProvider("neuralwatt", {
		name: "NeuralWatt",
		baseUrl: BASE_URL,
		apiKey: "$NEURALWATT_API_KEY",
		api: "openai-completions",
		authHeader: true,
		headers: {
			Referer: "https://pi.dev",
			"X-Title": "neuralwatt-provider",
		},
		models,
	});
}
