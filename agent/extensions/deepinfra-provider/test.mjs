import assert from "node:assert/strict";
import test from "node:test";
import extension, { withDeepInfraPriority } from "./index.ts";

test("adds priority service tier to DeepSeek V4.1 Flash requests", () => {
	const payload = {
		model: "deepseek-ai/DeepSeek-V4.1-Flash",
		messages: [{ role: "user", content: "Hello" }],
		service_tier: "flex",
	};

	assert.deepEqual(withDeepInfraPriority(payload), {
		...payload,
		service_tier: "priority",
	});
});

test("leaves other model requests unchanged", () => {
	const payload = {
		model: "deepseek-ai/DeepSeek-V4-Flash",
		messages: [{ role: "user", content: "Hello" }],
	};

	assert.strictEqual(withDeepInfraPriority(payload), payload);
});

test("limits the request rewrite to DeepInfra's V4.1 model", async () => {
	const handlers = new Map();
	let providerConfig;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerProvider(name, config) {
			providerConfig = { name, config };
		},
	};
	const apiKey = process.env.DEEPINFRA_API_KEY;
	delete process.env.DEEPINFRA_API_KEY;
	try {
		await extension(pi);
	} finally {
		if (apiKey === undefined) delete process.env.DEEPINFRA_API_KEY;
		else process.env.DEEPINFRA_API_KEY = apiKey;
	}

	const handler = handlers.get("before_provider_request");
	const targetPayload = {
		model: "deepseek-ai/DeepSeek-V4.1-Flash",
		messages: [],
	};
	const targetContext = {
		model: { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4.1-Flash" },
	};
	assert.deepEqual(await handler({ payload: targetPayload }, targetContext), {
		...targetPayload,
		service_tier: "priority",
	});
	assert.equal(
		await handler(
			{ payload: targetPayload },
			{ model: { provider: "other-provider", id: targetContext.model.id } },
		),
		undefined,
	);
	assert.equal(
		await handler(
			{ payload: { model: "deepseek-ai/DeepSeek-V4-Flash", messages: [] } },
			{ model: { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4-Flash" } },
		),
		undefined,
	);
	assert.equal(
		await handler(
			{ payload: { model: "deepseek-ai/DeepSeek-V4-Flash-0731", messages: [] } },
			{ model: { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4-Flash-0731" } },
		),
		undefined,
	);
	assert.equal(providerConfig.name, "deepinfra");
	assert.ok(providerConfig.config.models.some(({ id }) => id === "deepseek-ai/DeepSeek-V4-Flash"));
	assert.ok(!providerConfig.config.models.some(({ id }) => id === "deepseek-ai/DeepSeek-V4.1-Flash"));
});
