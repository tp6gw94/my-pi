import type {
  Api,
  Model,
  ModelThinkingLevel,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CATALOG_URL = "https://models.dev/api.json";
const ZEN_BASE = "https://opencode.ai/zen/v1";
const GO_BASE = "https://opencode.ai/zen/go/v1";
const ZEN_API_KEY = "OPENCODE_ZEN_API_KEY";
const GO_API_KEY = "OPENCODE_GO_API_KEY";
const TITLE_HEADERS = { "X-Title": "pi-agent" };
const VERIFIED_GO_GLM = "glm-5.3-flash";

type ZenApi = "openai-responses" | "anthropic-messages" | "openai-completions" | "google-generative-ai";
type Acquired<T> = { kind: "available"; value: T } | { kind: "unavailable" };
type Controls = { effort: boolean; toggle: boolean; budget: boolean; off: boolean };
type ControlEvidence = {
  controls: Controls;
  effortValues: Set<string>;
  budgetField?: string;
  effortOff: boolean;
  toggleOff: boolean;
};
type Declared =
  | { kind: "inherit" }
  | { kind: "withhold" }
  | { kind: "axes"; effort: string[]; toggle: boolean; budget: boolean };
type ResolvedModel = {
  model: Model<Api>;
  nativeOutput: boolean;
  controls: Controls;
  effort: Set<string>;
  budgetField?: string;
};
type GuardPolicy = {
  readonly api: ZenApi;
  readonly controls: Readonly<Controls>;
  readonly effort: ReadonlySet<string>;
  readonly allowedBudgetField: string | undefined;
  readonly knownBudgetFields: ReadonlySet<string>;
  readonly format: string | undefined;
};

const LEVELS: ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const BASIC_LEVELS = new Set(["minimal", "low", "medium", "high"]);
const NATIVE_RANK: Record<string, number> = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
const NO_CONTROLS: Controls = { effort: false, toggle: false, budget: false, off: false };
const GLM_GO_LEVELS: Record<ModelThinkingLevel, string | null> = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalized(value: string): string {
  return value.toLowerCase();
}

async function fetchJson(url: string, timeoutMs: number): Promise<Acquired<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { kind: "unavailable" };

    return { kind: "available", value: await response.json() };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function catalogSection(catalog: Acquired<unknown>, providerId: string): Acquired<Map<string, Record<string, unknown>>> {
  if (catalog.kind === "unavailable") return catalog;

  const root = asRecord(catalog.value);
  const section = root ? asRecord(root[providerId]) : undefined;
  const models = section ? asRecord(section.models) : undefined;
  if (!models) return { kind: "unavailable" };

  const value = new Map<string, Record<string, unknown>>();
  for (const [id, raw] of Object.entries(models)) {
    const record = asRecord(raw);
    if (!record) return { kind: "unavailable" };
    if (record.id !== id) return { kind: "unavailable" };

    value.set(id, record);
  }

  return { kind: "available", value };
}

function discoveryIds(discovered: Acquired<unknown>): Acquired<Set<string>> {
  if (discovered.kind === "unavailable") return discovered;

  const root = asRecord(discovered.value);
  if (!root || !Array.isArray(root.data)) return { kind: "unavailable" };

  const value = new Set<string>();
  for (const entry of root.data) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "string" || record.id.length === 0) {
      return { kind: "unavailable" };
    }

    value.add(record.id);
  }

  return { kind: "available", value };
}

function declaredControls(raw: Record<string, unknown> | undefined): Declared {
  if (!raw) return { kind: "inherit" };
  if (raw.reasoning === false) return { kind: "withhold" };
  if (!Object.hasOwn(raw, "reasoning_options")) return { kind: "inherit" };

  const options = raw.reasoning_options;
  if (!Array.isArray(options)) return { kind: "inherit" };
  if (options.length === 0) return { kind: "withhold" };

  const effort: string[] = [];
  let hasEffort = false;
  let toggle = false;
  let budget = false;

  for (const option of options) {
    const record = asRecord(option);
    if (!record) return { kind: "withhold" };

    switch (record.type) {
      case "effort": {
        hasEffort = true;
        if (!Array.isArray(record.values)) return { kind: "withhold" };

        for (const value of record.values) {
          if (value === "none") effort.push("none");
          else if (typeof value === "string" && Object.hasOwn(NATIVE_RANK, normalized(value))) {
            effort.push(normalized(value));
          }
        }

        continue;
      }
      case "toggle":
        toggle = true;
        continue;
      case "budget_tokens":
        budget = true;
        continue;
      default:
        return { kind: "withhold" };
    }
  }

  if (!hasEffort && !toggle && !budget) return { kind: "withhold" };

  return { kind: "axes", effort: [...new Set(effort)], toggle, budget };
}

function compatOf(model: Model<Api>): Record<string, unknown> {
  return (model.compat ?? {}) as Record<string, unknown>;
}

function withCompat(model: Model<Api>, compat: Record<string, unknown>): Model<Api> {
  return { ...model, compat: compat as Model<Api>["compat"] };
}

function withheld(model: Model<Api>): Model<Api> {
  return withCompat(
    { ...model, reasoning: false, thinkingLevelMap: undefined },
    { ...model.compat, supportsReasoningEffort: false },
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function overlayMetadata(model: Model<Api>, raw: Record<string, unknown> | undefined): Model<Api> {
  if (!raw) return model;

  const next = { ...model } as unknown as Record<string, unknown>;
  if (typeof raw.name === "string" && raw.name.length > 0) next.name = raw.name;

  const limit = asRecord(raw.limit);
  const contextWindow = positiveNumber(limit?.context);
  if (contextWindow !== undefined) next.contextWindow = contextWindow;

  const maxTokens = positiveNumber(limit?.output);
  if (maxTokens !== undefined) next.maxTokens = maxTokens;

  const cost = asRecord(raw.cost);
  if (cost) {
    const merged: Record<string, unknown> = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      ...(model.cost as unknown as Record<string, unknown>),
    };

    for (const [target, source] of [
      ["input", "input"],
      ["output", "output"],
      ["cacheRead", "cache_read"],
      ["cacheWrite", "cache_write"],
    ] as const) {
      const value = nonNegativeNumber(cost[source]);
      if (value !== undefined) merged[target] = value;
    }

    next.cost = merged;
  }

  const modalities = asRecord(raw.modalities);
  if (Array.isArray(modalities?.input)) {
    const input = modalities.input.filter((value): value is "text" | "image" => value === "text" || value === "image");
    if (input.length > 0) next.input = input;
  }

  const interleaved = asRecord(raw.interleaved);
  if (interleaved?.field === "reasoning_content") {
    next.compat = { ...model.compat, requiresReasoningContentOnAssistantMessages: true };
  }

  return next as unknown as Model<Api>;
}

function verifiedGoGlm(model: Model<Api>): Model<Api> {
  const compat: Record<string, unknown> = { ...model.compat, supportsReasoningEffort: true };
  delete compat.thinkingFormat;
  return {
    ...withCompat(model, compat),
    reasoning: true,
    thinkingLevelMap: { ...GLM_GO_LEVELS },
  };
}

function modelEffortValues(model: Model<Api>, allowDefaults: boolean): Set<string> {
  const values = new Set<string>();

  for (const level of LEVELS) {
    const value = model.thinkingLevelMap?.[level];
    if (typeof value === "string") values.add(normalized(value));
    else if (allowDefaults && value === undefined && BASIC_LEVELS.has(level)) values.add(level);
  }

  return values;
}

function budgetField(model: Model<Api>): string | undefined {
  const compat = compatOf(model);

  if (typeof compat.thinkingTokenBudgetField === "string") return compat.thinkingTokenBudgetField;
  return compat.supportsThinkingTokenBudget === true ? "thinking_token_budget" : undefined;
}

function toggleFormat(model: Model<Api>): boolean {
  const compat = compatOf(model);
  const format = compat.thinkingFormat;
  const namedFormats = ["zai", "qwen", "qwen-chat-template", "deepseek", "together"];
  if (namedFormats.includes(String(format))) return true;

  if (format === "chat-template" || format === "baseten") {
    const source = format === "chat-template" ? compat.chatTemplateKwargs : compat.chatTemplateArgs;
    const values = asRecord(source);
    const toggleKeys = ["enable_thinking", "thinking", "preserve_thinking"];
    return values !== undefined && toggleKeys.some((key) => Object.hasOwn(values, key));
  }

  return false;
}

function builtinEvidence(model: Model<Api>): ControlEvidence {
  const compat = compatOf(model);
  const mapped = modelEffortValues(model, false);
  const hasMappedEffort = mapped.size > 0;

  let effort = false;
  let toggle = false;
  let budget = false;
  let budgetFieldName: string | undefined;

  switch (model.api) {
    case "openai-completions": {
      effort = compat.supportsReasoningEffort !== false &&
        (compat.supportsReasoningEffort === true || hasMappedEffort);
      toggle = toggleFormat(model);
      budgetFieldName = budgetField(model);
      budget = budgetFieldName !== undefined;
      break;
    }
    case "openai-responses":
      effort = compat.supportsReasoningEffort !== false && hasMappedEffort;
      break;
    case "anthropic-messages": {
      const adaptive = compat.forceAdaptiveThinking === true || compat.supportsMidConvoEffort === true;
      effort = adaptive && (hasMappedEffort || compat.forceAdaptiveThinking === true || compat.supportsMidConvoEffort === true);
      toggle = model.reasoning;
      budget = model.reasoning && !adaptive;
      break;
    }
    case "google-generative-ai":
      effort = hasMappedEffort;
      toggle = model.reasoning;
      break;
  }

  const effortValues = modelEffortValues(model, effort);
  const publishedOff = model.thinkingLevelMap?.off;
  const effortOff = effort && typeof publishedOff === "string";
  const toggleOff = toggle && publishedOff !== null;
  const off = effortOff || toggleOff;
  if (off && effortOff) effortValues.add(normalized(publishedOff));

  return { controls: { effort, toggle, budget, off }, effortValues, budgetField: budgetFieldName, effortOff, toggleOff };
}

function restrictEvidence(model: Model<Api>, evidence: ControlEvidence, declared: Declared): ControlEvidence {
  if (declared.kind === "inherit") return evidence;
  if (declared.kind === "withhold") {
    return { controls: NO_CONTROLS, effortValues: new Set(), budgetField: evidence.budgetField, effortOff: false, toggleOff: false };
  }

  const publishedOff = model.thinkingLevelMap?.off;
  const publishedOffName = normalized(String(publishedOff));
  const effortValues = new Set(
    [...evidence.effortValues].filter((value) =>
      declared.effort.includes(value) && value !== normalized(publishedOff ?? ""),
    ),
  );
  const offFromEffort = evidence.effortOff && declared.effort.includes(publishedOffName);
  const toggle = evidence.controls.toggle && declared.toggle;

  const compat = compatOf(model);
  const adaptiveDependency = model.api === "anthropic-messages" &&
    (compat.forceAdaptiveThinking === true || compat.supportsMidConvoEffort === true) &&
    evidence.controls.effort && effortValues.size > 0;
  const formatDependency = model.api === "openai-completions" && evidence.controls.toggle &&
    evidence.controls.effort && effortValues.size > 0 &&
    ["deepseek", "qwen", "zai", "together"].includes(String(compat.thinkingFormat));
  const budgetDependency = model.api === "anthropic-messages" && evidence.controls.budget && declared.budget;
  const effectiveToggle = toggle || adaptiveDependency || formatDependency || budgetDependency;

  const budget = evidence.controls.budget &&
    (declared.budget || (declared.toggle && model.api === "anthropic-messages"));
  const off = (offFromEffort || (toggle && evidence.toggleOff)) && publishedOff !== null;
  if (off && evidence.effortOff) effortValues.add(publishedOffName);

  const remainingEffort = [...effortValues].some((value) => value !== publishedOffName);
  const hasEffort = evidence.controls.effort && effortValues.size > 0 && remainingEffort;

  return {
    controls: { effort: hasEffort, toggle: effectiveToggle, budget, off },
    effortValues,
    budgetField: evidence.budgetField,
    effortOff: offFromEffort,
    toggleOff: toggle && evidence.toggleOff,
  };
}

function projectControls(model: Model<Api>, evidence: ControlEvidence): Model<Api> {
  const { effort, toggle, budget, off } = evidence.controls;
  if (!effort && !toggle && !budget && !off) return withheld(model);

  const thinkingLevelMap: Record<string, string | null> = {};
  const publishedOff = model.thinkingLevelMap?.off;
  if (off) {
    if (typeof publishedOff === "string") thinkingLevelMap.off = publishedOff;
  } else {
    thinkingLevelMap.off = null;
  }

  for (const level of LEVELS) {
    if (!effort) {
      const highStaysUnmapped = level === "high" && (toggle || budget);
      if (highStaysUnmapped) continue;

      thinkingLevelMap[level] = null;
      continue;
    }

    const published = model.thinkingLevelMap?.[level];
    let mapped: string | undefined;
    if (typeof published === "string") mapped = normalized(published);
    else if (published === undefined && BASIC_LEVELS.has(level)) mapped = level;

    if (mapped !== undefined && evidence.effortValues.has(mapped)) {
      thinkingLevelMap[level] = typeof published === "string" ? published : level;
      continue;
    }

    thinkingLevelMap[level] = null;
  }

  const compat: Record<string, unknown> = { ...model.compat };
  if (model.api === "openai-completions") compat.supportsReasoningEffort = effort;

  const projected = { ...model, reasoning: true, thinkingLevelMap: thinkingLevelMap as Model<Api>["thinkingLevelMap"] };
  return withCompat(projected, compat);
}

function resolveModel(
  providerId: string,
  builtin: Model<Api>,
  raw: Record<string, unknown> | undefined,
): ResolvedModel {
  const verified = isVerifiedGoGlm(providerId, builtin) ? verifiedGoGlm(builtin) : { ...builtin };
  const metadata = overlayMetadata(verified, raw);
  const evidence = restrictEvidence(verified, builtinEvidence(verified), declaredControls(raw));

  const model = { ...projectControls(metadata, evidence), provider: providerId } as Model<Api>;

  const effort = new Set<string>();
  if (evidence.controls.effort) {
    for (const value of evidence.effortValues) effort.add(normalized(value));
  }

  if (evidence.controls.off && evidence.effortOff) {
    const publishedOff = verified.thinkingLevelMap?.off;
    if (typeof publishedOff === "string") effort.add(normalized(publishedOff));
  }

  return {
    model,
    nativeOutput: builtin.reasoning,
    controls: evidence.controls,
    effort,
    budgetField: evidence.budgetField,
  };
}

function resolveGroup(
  providerId: string,
  builtins: Model<Api>[],
  section: Acquired<Map<string, Record<string, unknown>>>,
  discovered: Acquired<Set<string>>,
): ResolvedModel[] {
  const resolved: ResolvedModel[] = [];

  for (const builtin of builtins) {
    const publishedIds = section.kind === "available" ? section.value : undefined;
    if (publishedIds && !publishedIds.has(builtin.id)) continue;

    const discoveredIds = discovered.kind === "available" ? discovered.value : undefined;
    if (discoveredIds && !discoveredIds.has(builtin.id)) continue;

    const raw = section.kind === "available" ? section.value.get(builtin.id) : undefined;
    resolved.push(resolveModel(providerId, builtin, raw));
  }

  return resolved;
}

function hasHeader(headers: Record<string, string | null> | undefined, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

function withTitleHeader<T extends StreamOptions | SimpleStreamOptions>(model: Model<Api>, options: T): T {
  if (hasHeader(model.headers, "x-title") || hasHeader(options.headers, "x-title")) return options;
  return { ...options, headers: { ...options.headers, ...TITLE_HEADERS } } as T;
}

function privateRequestModel(model: Model<Api>, record: ResolvedModel): Model<Api> {
  const publishedCompat = compatOf(record.model);
  const requestCompat: Record<string, unknown> = { ...record.model.compat, ...model.compat };
  const publishedCompatKeys = [
    "thinkingFormat",
    "forceAdaptiveThinking",
    "supportsMidConvoEffort",
    "thinkingTokenBudgetField",
    "supportsThinkingTokenBudget",
    "requiresReasoningContentOnAssistantMessages",
  ];

  for (const key of publishedCompatKeys) {
    if (Object.hasOwn(publishedCompat, key)) requestCompat[key] = publishedCompat[key];
    else delete requestCompat[key];
  }

  const publishedOff = record.model.thinkingLevelMap?.off;
  const nativeEffortOff =
    record.controls.off &&
    typeof publishedOff === "string" &&
    record.effort.has(normalized(publishedOff));
  requestCompat.supportsReasoningEffort = record.controls.effort || nativeEffortOff;

  if (model.api === "anthropic-messages" && !record.controls.effort) delete requestCompat.supportsMidConvoEffort;
  if (model.api === "openai-completions" && !record.controls.budget) {
    delete requestCompat.thinkingTokenBudgetField;
    requestCompat.supportsThinkingTokenBudget = false;
  }

  return {
    ...model,
    reasoning: record.nativeOutput,
    thinkingLevelMap: record.model.thinkingLevelMap,
    compat: requestCompat as Model<Api>["compat"],
  };
}

function enforceEffortValue(record: Record<string, unknown>, key: string, allowed: ReadonlySet<string>, allowOff: boolean): void {
  const value = record[key];
  if (typeof value !== "string") {
    delete record[key];
    return;
  }
  const canonical = normalized(value);
  if (!allowed.has(canonical) || (canonical === "none" && !allowOff)) delete record[key];
}

function enforceEffortField(record: Record<string, unknown>, key: string, policy: GuardPolicy): void {
  if (policy.controls.effort) {
    enforceEffortValue(record, key, policy.effort, policy.controls.off);
    return;
  }

  const value = record[key];
  const isNativeOffValue = policy.controls.off && typeof value === "string" && normalized(value) === "none";
  if (!isNativeOffValue) {
    delete record[key];
    return;
  }

  enforceEffortValue(record, key, policy.effort, policy.controls.off);
}

function validBudget(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function enforceTemplateControls(value: unknown, policy: GuardPolicy): void {
  const template = asRecord(value);
  if (!template) return;

  const templateFormat = policy.format === "chat-template" || policy.format === "qwen-chat-template" || policy.format === "baseten";
  if (!policy.controls.toggle || !templateFormat) {
    delete template.enable_thinking;
    delete template.preserve_thinking;
    delete template.thinking;
  } else {
    if (typeof template.enable_thinking !== "boolean") delete template.enable_thinking;
    else if (!template.enable_thinking && !policy.controls.off) delete template.enable_thinking;
    if (typeof template.preserve_thinking !== "boolean") delete template.preserve_thinking;
  }

  if (!policy.controls.effort || !templateFormat) delete template.reasoning_effort;
  else enforceEffortValue(template, "reasoning_effort", policy.effort, policy.controls.off);

  for (const field of ["budget_tokens", "thinking_token_budget", ...policy.knownBudgetFields]) {
    if (!policy.controls.budget || !templateFormat || !validBudget(template[field])) delete template[field];
  }
}

function enforceControls(payload: unknown, policy: GuardPolicy): unknown {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) return payload;

  switch (policy.api) {
    case "openai-completions":
      return enforceCompletionsPayload(payloadRecord, policy);
    case "openai-responses":
      return enforceResponsesPayload(payloadRecord, policy);
    case "anthropic-messages":
      return enforceAnthropicPayload(payloadRecord, policy);
    case "google-generative-ai":
      return enforceGooglePayload(payloadRecord, policy);
  }
}

function enforceCompletionsPayload(payloadRecord: Record<string, unknown>, policy: GuardPolicy): Record<string, unknown> {
  const guarded = { ...payloadRecord };
  enforceEffortField(guarded, "reasoning_effort", policy);

  const reasoning = asRecord(guarded.reasoning);
  if (reasoning && ["openrouter", "ant-ling", "together"].includes(String(policy.format))) {
    enforceEffortField(reasoning, "effort", policy);
    if (!policy.controls.toggle || typeof reasoning.enabled !== "boolean" || (!reasoning.enabled && !policy.controls.off)) delete reasoning.enabled;
    if (Object.keys(reasoning).length === 0) delete guarded.reasoning;
  } else {
    delete guarded.reasoning;
  }

  if (typeof guarded.thinking === "string" && policy.format === "string-thinking") {
    enforceEffortField(guarded, "thinking", policy);
  } else {
    const thinking = asRecord(guarded.thinking);
    const type = thinking?.type;
    const allowedType = policy.controls.toggle && ["deepseek", "zai"].includes(String(policy.format)) &&
      (type === "enabled" || (type === "disabled" && policy.controls.off));
    if (thinking && allowedType) {
      const sanitized: Record<string, unknown> = { type };
      if (policy.format === "zai" && typeof thinking.clear_thinking === "boolean") {
        sanitized.clear_thinking = thinking.clear_thinking;
      }
      guarded.thinking = sanitized;
    } else {
      delete guarded.thinking;
    }
  }

  if (policy.format !== "qwen" || !policy.controls.toggle) delete guarded.enable_thinking;
  else if (typeof guarded.enable_thinking !== "boolean" || (!guarded.enable_thinking && !policy.controls.off)) delete guarded.enable_thinking;

  enforceTemplateControls(guarded.chat_template_kwargs, policy);
  enforceTemplateControls(guarded.chat_template_args, policy);

  const budgetFields = new Set(["budget_tokens", "thinking_token_budget", ...policy.knownBudgetFields]);
  for (const field of budgetFields) {
    if (!policy.controls.budget || field !== policy.allowedBudgetField || !validBudget(guarded[field])) delete guarded[field];
  }

  return guarded;
}

function enforceResponsesPayload(payloadRecord: Record<string, unknown>, policy: GuardPolicy): Record<string, unknown> {
  const guarded = { ...payloadRecord };

  const reasoning = asRecord(guarded.reasoning);
  if (reasoning) {
    enforceEffortField(reasoning, "effort", policy);
    if (!policy.controls.toggle) delete reasoning.enabled;
    if (Object.keys(reasoning).length === 0) delete guarded.reasoning;
  }

  return guarded;
}

function enforceAnthropicPayload(payloadRecord: Record<string, unknown>, policy: GuardPolicy): Record<string, unknown> {
  const guarded = { ...payloadRecord };

  const outputConfig = asRecord(guarded.output_config);
  if (outputConfig) {
    enforceEffortField(outputConfig, "effort", policy);
    if (Object.keys(outputConfig).length === 0) delete guarded.output_config;
  }

  const thinking = asRecord(guarded.thinking);
  if (thinking) {
    const type = thinking.type;
    let allowedType = false;
    switch (type) {
      case "disabled":
        allowedType = policy.controls.off;
        break;
      case "adaptive":
        allowedType = policy.format === "adaptive" && (policy.controls.effort || policy.controls.toggle);
        break;
      case "enabled":
        allowedType = policy.format === "budget" && (policy.controls.toggle || policy.controls.budget);
        break;
    }

    if (!allowedType) {
      delete guarded.thinking;
    } else if (type === "enabled") {
      const budgetTokens = thinking.budget_tokens;
      const outputCap = positiveNumber(guarded.max_tokens);
      const budgetPermitted = policy.controls.budget && validBudget(budgetTokens);
      const budgetFits = budgetPermitted && Number(budgetTokens) >= 1024 && (outputCap === undefined || Number(budgetTokens) < outputCap);
      if (!budgetFits) delete guarded.thinking;
    } else {
      delete thinking.budget_tokens;
      if (type === "disabled" && Object.keys(thinking).some((key) => key !== "type")) delete guarded.thinking;
    }
  }

  for (const field of ["budget_tokens", "thinking_token_budget", ...policy.knownBudgetFields]) delete guarded[field];

  return guarded;
}

function enforceGooglePayload(payloadRecord: Record<string, unknown>, policy: GuardPolicy): Record<string, unknown> {
  const guarded = { ...payloadRecord };

  const config = asRecord(guarded.config);
  const thinking = config ? asRecord(config.thinkingConfig) : undefined;
  if (thinking) {
    enforceEffortField(thinking, "thinkingLevel", policy);
    if (typeof thinking.thinkingLevel === "string") thinking.thinkingLevel = thinking.thinkingLevel.toUpperCase();
    if (!policy.controls.budget || !validBudget(thinking.thinkingBudget)) delete thinking.thinkingBudget;
    if (typeof thinking.includeThoughts !== "boolean") delete thinking.includeThoughts;
    if (Object.keys(thinking).length === 0) delete config?.thinkingConfig;
  }

  return guarded;
}

function publishedThinkingFormat(api: ZenApi, publishedCompat: Record<string, unknown>): string | undefined {
  if (api === "anthropic-messages") {
    if (publishedCompat.forceAdaptiveThinking === true || publishedCompat.supportsMidConvoEffort === true) return "adaptive";
    return "budget";
  }

  if (typeof publishedCompat.thinkingFormat === "string") return publishedCompat.thinkingFormat;
  return undefined;
}

function guardedStreams(
  stock: ProviderStreams,
  records: Map<string, ResolvedModel>,
  providerId: string,
  api: ZenApi,
): ProviderStreams {
  const resolveRoute = (model: Model<Api>) => {
    const found = records.get(model.id);
    if (!found) throw new Error(`Unverified OpenCode route: ${model.provider}/${model.id}/${model.api}`);

    const record = found;
    const routeMatches =
      model.provider === providerId &&
      record.model.provider === providerId &&
      model.api === api &&
      record.model.api === api;
    if (!routeMatches) throw new Error(`Unverified OpenCode route: ${model.provider}/${model.id}/${model.api}`);

    return { record, request: privateRequestModel(model, record) };
  };

  const guardOptions = <T extends StreamOptions | SimpleStreamOptions>(model: Model<Api>, options: T | undefined): T => {
    const { record } = resolveRoute(model);

    const knownBudgetFields = new Set<string>();
    if (record.budgetField) knownBudgetFields.add(record.budgetField);
    const callerBudgetField = budgetField(model);
    if (callerBudgetField) knownBudgetFields.add(callerBudgetField);

    const onPayload = options?.onPayload;
    const publishedCompat = compatOf(record.model);
    const policy: GuardPolicy = {
      api,
      controls: record.controls,
      effort: record.effort,
      allowedBudgetField: record.controls.budget ? record.budgetField : undefined,
      knownBudgetFields,
      format: publishedThinkingFormat(api, publishedCompat),
    };

    const withHeaders = withTitleHeader(model, (options ?? {}) as T);

    return {
      ...withHeaders,
      onPayload: async (payload: unknown) => {
        const replacement = onPayload ? await onPayload(payload, model) : undefined;
        return enforceControls(replacement === undefined ? payload : replacement, policy);
      },
    } as T;
  };

  return {
    stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
      const { request } = resolveRoute(model);
      return stock.stream(request, context, guardOptions(model, options ?? { headers: undefined }));
    },
    streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
      const { record, request } = resolveRoute(model);

      const clampedLevel = options?.reasoning ? clampThinkingLevel(record.model, options.reasoning) : undefined;
      const clampedOptions = {
        ...options,
        reasoning: clampedLevel === "off" ? undefined : clampedLevel,
      };

      return stock.streamSimple(request, context, guardOptions(model, clampedOptions));
    },
  };
}

function nativeProvider(
  id: string,
  name: string,
  baseUrl: string,
  apiKeyEnv: string,
  stock: ProviderStreams,
  models: ResolvedModel[],
  apis: ZenApi[],
): Provider<Api> {
  const records = new Map(models.map((entry) => [entry.model.id, entry]));
  const api: Partial<Record<Api, ProviderStreams>> = {};
  for (const entry of apis) api[entry] = guardedStreams(stock, records, id, entry);

  return createProvider<Api>({
    id,
    name,
    baseUrl,
    headers: { ...TITLE_HEADERS },
    auth: { apiKey: envApiKeyAuth(`${name} API key`, [apiKeyEnv]) },
    models: models.map((entry) => entry.model),
    api,
  });
}

function splitByApi(models: Model<Api>[], api: ZenApi): Model<Api>[] {
  return models.filter((model) => model.api === api);
}

function isVerifiedGoGlm(providerId: string, model: Model<Api>): boolean {
  return providerId === "opencode-go" && model.id === VERIFIED_GO_GLM;
}

export default async function (pi: ExtensionAPI) {
  const [catalog, zenDiscovered, goDiscovered] = await Promise.all([
    fetchJson(CATALOG_URL, 20000),
    fetchJson(`${ZEN_BASE}/models`, 10000),
    fetchJson(`${GO_BASE}/models`, 10000),
  ]);

  const zenSection = catalogSection(catalog, "opencode");
  const goSection = catalogSection(catalog, "opencode-go");
  const zenIds = discoveryIds(zenDiscovered);
  const goIds = discoveryIds(goDiscovered);

  const zenBuiltins = getBuiltinModels("opencode") as Model<Api>[];
  const goBuiltins = getBuiltinModels("opencode-go") as Model<Api>[];
  const mainBuiltins = zenBuiltins.filter(
    (model) => model.api === "openai-responses" || model.api === "google-generative-ai",
  );

  const main = resolveGroup("opencode", mainBuiltins, zenSection, zenIds);
  const anthropicAlias = resolveGroup(
    "opencode-zen-anthropic",
    splitByApi(zenBuiltins, "anthropic-messages"),
    zenSection,
    zenIds,
  );
  const completionsAlias = resolveGroup(
    "opencode-zen-compat",
    splitByApi(zenBuiltins, "openai-completions"),
    zenSection,
    zenIds,
  );
  const go = resolveGroup("opencode-go", goBuiltins, goSection, goIds);

  const zenStock = opencodeProvider();
  const goStock = opencodeGoProvider();

  pi.registerProvider(
    nativeProvider("opencode", "OpenCode Zen", ZEN_BASE, ZEN_API_KEY, zenStock, main, [
      "openai-responses",
      "google-generative-ai",
    ]),
  );
  pi.registerProvider(
    nativeProvider(
      "opencode-zen-anthropic",
      "OpenCode Zen (Anthropic)",
      ZEN_BASE,
      ZEN_API_KEY,
      zenStock,
      anthropicAlias,
      ["anthropic-messages"],
    ),
  );
  pi.registerProvider(
    nativeProvider(
      "opencode-zen-compat",
      "OpenCode Zen (Compat)",
      ZEN_BASE,
      ZEN_API_KEY,
      zenStock,
      completionsAlias,
      ["openai-completions"],
    ),
  );
  pi.registerProvider(
    nativeProvider("opencode-go", "OpenCode Go", GO_BASE, GO_API_KEY, goStock, go, [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]),
  );
}
