// Run: node check.ts
// Guards the compat mapping that keeps opencode thinking-mode models from
// 400ing with "reasoning_content ... must be passed back to the API".
import assert from "node:assert/strict";
import register from "./index.ts";

type Registered = { models: { id: string; compat?: { requiresReasoningContentOnAssistantMessages?: boolean } }[] };

const providers = new Map<string, Registered>();
const api = {
  registerProvider: (name: string, config: Registered) => void providers.set(name, config),
};

await register(api as never);

const compatOf = (provider: string, id: string) => providers.get(provider)?.models.find((m) => m.id === id)?.compat;

const cases: [string, string, boolean][] = [
  ["opencode-go", "deepseek-v4.1-flash", true],
  ["opencode-go", "glm-5.2", true],
  ["opencode-go", "kimi-k2.6", true],
  ["opencode-go", "qwen3.8-max", false],
  ["opencode-go", "minimax-m3", false],
  ["opencode-go", "hy3", false],
  ["opencode", "gpt-5.1", false],
];

let checked = 0;
let unavailable = 0;
for (const [provider, id, expected] of cases) {
  const compat = compatOf(provider, id);
  if (!compat) {
    unavailable++;
    continue;
  }
  checked++;
  assert.equal(
    !!compat.requiresReasoningContentOnAssistantMessages,
    expected,
    `${provider}/${id} requiresReasoningContentOnAssistantMessages`,
  );
}

assert.ok(checked > 0, "catalog was unreachable: nothing could be checked");
console.log(`opencode-provider compat: ${checked} checked, ${unavailable} unavailable`);
